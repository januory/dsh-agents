import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnManager } from '../src/turns.js'
import { AgentCliRegistry } from '../src/registry.js'
import { applyOverlay, providerSettings, readState, writeState } from '../src/store.js'
import { headTail, tailRecords } from '../src/providers/files.js'

function fakeProvider(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake',
    async detect() { return { available: true, command: 'fake' } },
    async listSessions() { return [] },
    async readTranscript() { return { session: {}, events: [] } },
    async startTurn(request, sink) {
      sink.setSession(request.sessionId ?? 'new-session')
      sink.emit({ id: 'u', type: 'user', ts: 1, text: request.text })
      return {
        cancel: () => sink.finish({ status: 'cancelled' }),
        answer: () => {},
        dispose: () => {},
        sink,
      }
    },
    ...overrides,
  }
}

test('turn manager numbers events, gates approvals and guards one turn per session', async () => {
  const turns = new TurnManager({ retentionMs: 60_000, abandonTimeoutMs: 60_000 })
  let handle
  const provider = fakeProvider({
    async startTurn(request, sink) {
      sink.setSession('s1')
      sink.emit({ id: 'u', type: 'user', text: request.text })
      handle = { cancel: () => sink.finish({ status: 'cancelled' }), answer: () => {}, dispose: () => {}, sink }
      return handle
    },
  })
  const { turnId, sessionId } = await turns.start(provider, { cwd: '/p', text: 'hi' })
  assert.equal(sessionId, 's1')
  let poll = turns.poll(turnId, 0)
  assert.equal(poll.status, 'running')
  assert.equal(poll.events.length, 1)
  assert.equal(poll.events[0].seq, 1)
  assert.equal(turns.poll(turnId, 1).events.length, 0)
  await assert.rejects(() => turns.start(provider, { cwd: '/p', text: 'again', sessionId: 's1' }), /already has a running turn/)
  handle.sink.emit({ id: 'ap', type: 'approval', requestId: 'r1', name: 'Bash', options: ['allow', 'deny'], status: 'running' })
  assert.equal(turns.poll(turnId, 0).status, 'awaiting')
  turns.answer(turnId, 'r1', 'allow')
  poll = turns.poll(turnId, 0)
  assert.equal(poll.status, 'running')
  assert.equal(poll.events.at(-1).decision, 'allow')
  assert.equal(poll.events.at(-1).status, 'done')
  const active = turns.activeFor('fake', 's1')
  assert.equal(active.length, 1)
  assert.equal(active[0].turnId, turnId)
  assert.equal(active[0].seq, poll.seq)
  assert.equal(typeof active[0].startedAt, 'number')
  turns.cancel(turnId)
  assert.equal(turns.poll(turnId, 0).status, 'cancelled')
  assert.deepEqual(turns.activeFor('fake', 's1'), [])
  turns.dispose()
})

test('turn manager reports start failures and empty input', async () => {
  const turns = new TurnManager({ retentionMs: 60_000, abandonTimeoutMs: 60_000 })
  await assert.rejects(() => turns.start(fakeProvider(), { cwd: '/p', text: '  ' }), /empty/)
  await assert.rejects(() => turns.start(fakeProvider(), { cwd: '/p', text: '', images: [] }), /empty/)
  await assert.rejects(() => turns.start(fakeProvider(), { cwd: '', text: 'x' }), /working directory/)
  const imageOnly = await turns.start(fakeProvider(), { cwd: '/p', text: '', images: [{ id: 'a.png', mediaType: 'image/png' }] })
  assert.equal(turns.poll(imageOnly.turnId, 0).status, 'running')
  turns.cancel(imageOnly.turnId)
  const { turnId } = await turns.start(fakeProvider({ async startTurn() { throw new Error('boom') } }), { cwd: '/p', text: 'x' })
  const poll = turns.poll(turnId, 0)
  assert.equal(poll.status, 'error')
  assert.equal(poll.error, 'boom')
  turns.dispose()
})

test('registry validates providers and disposes', () => {
  const registry = new AgentCliRegistry()
  assert.throws(() => registry.register({ id: 'x', label: 'X' }), /lacks detect/)
  const dispose = registry.register(fakeProvider())
  assert.equal(registry.list().length, 1)
  assert.throws(() => registry.register(fakeProvider()), /already registered/)
  assert.throws(() => registry.get('nope'), /unknown provider/)
  dispose()
  assert.equal(registry.list().length, 0)
})

test('store overlays titles and hidden flags without touching native data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-store-'))
  const path = join(dir, 'state.json')
  try {
    assert.deepEqual(readState(path), { settings: { providers: {} }, sessions: {}, workspaces: {} })
    const state = readState(path)
    state.sessions['claude:s1'] = { title: 'mine', hidden: true }
    state.settings.providers.claude = { permissionMode: 'plan', model: 'opus' }
    writeState(state, path)
    const loaded = readState(path)
    const summary = applyOverlay({ provider: 'claude', id: 's1', title: 'native' }, loaded)
    assert.equal(summary.title, 'mine')
    assert.equal(summary.hidden, true)
    assert.equal(summary.renamed, true)
    assert.deepEqual(providerSettings(loaded, 'claude'), { permissionMode: 'plan', model: 'opus' })
    assert.deepEqual(providerSettings(loaded, 'codex'), { permissionMode: '', model: '' })
    assert.equal(applyOverlay({ provider: 'claude', id: 's2', title: 'native' }, loaded).title, 'native')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('jsonl readers bound large files and skip torn lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-jsonl-'))
  const path = join(dir, 'x.jsonl')
  try {
    const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, pad: 'x'.repeat(100) }))
    writeFileSync(path, `${lines.join('\n')}\n{"type":"assistant","uuid":"torn"`)
    const { head, tail } = headTail(path, { headBytes: 1024, tailBytes: 2048 })
    assert.equal(head[0].uuid, 'u0')
    assert.ok(head.every(r => typeof r.uuid === 'string'))
    assert.ok(tail.length > 0)
    assert.ok(tail.every(r => r.uuid !== 'torn'))
    const bounded = tailRecords(path, 4096)
    assert.equal(bounded.hasEarlier, true)
    assert.ok(bounded.records.length < 2000)
    assert.ok(bounded.records.every(r => r.type === 'user'))
    writeFileSync(path, '{"type":"user","uuid":"only"}\n')
    assert.equal(tailRecords(path, 4096).hasEarlier, false)
    assert.equal(headTail(path).head.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
