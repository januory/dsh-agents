import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexProvider } from '../src/providers/codex.js'
import { TurnManager } from '../src/turns.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const windows = process.platform === 'win32'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// The provider is given a bare name, so the test also covers PATH/PATHEXT resolution.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-codex-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const shim = join(dir, windows ? 'fake-codex.cmd' : 'fake-codex')
  writeFileSync(shim, windows ? `@"${process.execPath}" "${fixture}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(shim, 0o755)
  const log = join(dir, 'spawns.log')
  writeFileSync(log, '')
  const saved = { path: process.env.PATH, log: process.env.FAKE_CODEX_LOG }
  process.env.PATH = `${dir}${delimiter}${saved.path}`
  process.env.FAKE_CODEX_LOG = log
  const provider = createCodexProvider({ command: 'fake-codex', home })
  const turns = new TurnManager({ retentionMs: 60_000 })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return {
    dir, home, cwd, provider, turns,
    servers: () => lines().filter(l => l.startsWith('spawn') && l.endsWith(' app-server')).length,
    exits: () => windows
      ? lines().filter(l => l.startsWith('spawn') && l.endsWith(' app-server')).filter(l => !alive(Number(l.split(' ')[1]))).length
      : lines().filter(l => l.startsWith('exit')).length,
    cleanup() {
      turns.dispose()
      provider.dispose()
      process.env.PATH = saved.path
      if (saved.log === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = saved.log
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

async function waitStatus(turns, turnId, statuses, timeout = 5000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const poll = turns.poll(turnId, 0)
    if (statuses.includes(poll.status)) return poll
    await sleep(20)
  }
  throw new Error(`turn ${turnId} never reached ${statuses.join('|')}: ${JSON.stringify(turns.poll(turnId, 0))}`)
}

test('codex resolves by name, detects, and serves turns through one app-server', async () => {
  const s = setup()
  try {
    const detected = await s.provider.detect()
    assert.equal(detected.available, true, detected.error)
    assert.equal(detected.command, join(s.dir, windows ? 'fake-codex.cmd' : 'fake-codex'))
    assert.equal(detected.version, 'codex-cli 0.0.0-fake')
    assert.equal(detected.authenticated, true)
    assert.deepEqual(await s.provider.listModels(), [{ id: 'fake-codex', label: 'Fake Codex', description: undefined, efforts: ['low', 'medium'], defaultEffort: 'medium' }])
    assert.equal(s.servers(), 1)

    const first = await s.turns.start(s.provider, { cwd: s.cwd, text: 'hello' })
    const done = await waitStatus(s.turns, first.turnId, ['done'])
    assert.ok(done.events.some(e => e.type === 'assistant' && e.text === 'echo:hello' && e.done))
    assert.deepEqual(done.usage, { inputTokens: 20, outputTokens: 7 })
    const sessionId = done.sessionId
    assert.ok(sessionId)

    const second = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'again' })
    const again = await waitStatus(s.turns, second.turnId, ['done'])
    assert.ok(again.events.some(e => e.type === 'assistant' && e.text === 'echo:again'))
    assert.equal(s.servers(), 1)

    const sessions = await s.provider.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, sessionId)
    assert.equal(sessions[0].title, 'hello')
    const transcript = await s.provider.readTranscript(sessionId)
    assert.deepEqual(transcript.events.filter(e => e.type === 'user' || e.type === 'assistant').map(e => e.text), ['hello', 'echo:hello', 'again', 'echo:again'])
    assert.equal(transcript.usage.contextTokens, 27)
    assert.equal(transcript.usage.capacity, 128_000)

    s.provider.dispose()
    const until = Date.now() + 5000
    while (s.exits() === 0 && Date.now() < until) await sleep(20)
    assert.equal(s.exits(), 1)
  } finally {
    s.cleanup()
  }
})

test('a missing codex command is reported, not thrown', async () => {
  const provider = createCodexProvider({ command: 'definitely-not-installed-codex', home: '' })
  try {
    const detected = await provider.detect()
    assert.equal(detected.available, false)
    assert.match(detected.error, /was not found on PATH/)
  } finally {
    provider.dispose()
  }
})
