import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexProvider } from '../src/providers/codex.js'
import { TurnManager } from '../src/turns.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
chmodSync(fixture, 0o755)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-codex-'))
  const log = join(dir, 'requests.log')
  writeFileSync(log, '')
  const saved = process.env.FAKE_CODEX_LOG
  process.env.FAKE_CODEX_LOG = log
  const provider = createCodexProvider({ command: fixture, home: join(dir, 'codex') })
  const turns = new TurnManager({ retentionMs: 60_000 })
  return {
    dir, provider, turns,
    requests: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    cleanup() {
      turns.dispose()
      provider.dispose()
      if (saved === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = saved
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

async function waitDone(turns, turnId, timeout = 5000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const poll = turns.poll(turnId, 0)
    if (poll.status === 'done') return poll
    if (poll.status === 'error') throw new Error(poll.error)
    await sleep(20)
  }
  throw new Error('turn never completed')
}

test('compact resumes without overrides and renders the compaction item', async () => {
  const s = setup()
  try {
    const { turnId } = await s.turns.compact(s.provider, 'th1')
    const poll = await waitDone(s.turns, turnId)
    assert.ok(poll.events.some(e => e.type === 'turn' && e.reason === 'compact'))
    const requests = s.requests()
    const resume = requests.findIndex(r => r.method === 'thread/resume')
    const compact = requests.findIndex(r => r.method === 'thread/compact/start')
    assert.ok(resume !== -1 && compact !== -1 && resume < compact)
    assert.deepEqual(Object.keys(requests[resume].params).sort(), ['excludeTurns', 'threadId'])
    assert.ok(requests.some(r => r.method === 'thread/unsubscribe'))
  } finally {
    s.cleanup()
  }
})

test('goal set runs as a turn with user origin; get and clear are direct reads', async () => {
  const s = setup()
  try {
    const { turnId } = await s.turns.goalSet(s.provider, 'th1', 'ship it')
    const poll = await waitDone(s.turns, turnId)
    assert.ok(poll.events.some(e => e.type === 'assistant' && e.text === 'GOAL_OK'))
    const set = s.requests().find(r => r.method === 'thread/goal/set')
    assert.equal(set.params.objective, 'ship it')
    assert.equal(set.params.origin, 'user')
    assert.equal((await s.provider.getGoal('th1')).goal.objective, 'ship it')
    assert.equal((await s.provider.clearGoal('th1')).cleared, true)
    assert.equal((await s.provider.getGoal('th1')).goal, null)
    const clear = s.requests().find(r => r.method === 'thread/goal/clear')
    assert.equal(clear.params.origin, 'user')
  } finally {
    s.cleanup()
  }
})
