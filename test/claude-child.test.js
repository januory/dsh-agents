import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClaudeProvider } from '../src/providers/claude.js'
import { TurnManager } from '../src/turns.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
chmodSync(fixture, 0o755)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-claude-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const log = join(dir, 'spawns.log')
  writeFileSync(log, '')
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, log: process.env.FAKE_SPAWN_LOG }
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.FAKE_SPAWN_LOG = log
  const provider = createClaudeProvider({ command: fixture, home })
  const turns = new TurnManager({ retentionMs: 60_000 })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return {
    dir, home, cwd, provider, turns,
    spawns: () => lines().filter(l => l.startsWith('spawn')).length,
    exits: () => lines().filter(l => l.startsWith('exit')).length,
    cleanup() {
      turns.dispose()
      provider.dispose()
      if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.config
      if (saved.log === undefined) delete process.env.FAKE_SPAWN_LOG; else process.env.FAKE_SPAWN_LOG = saved.log
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
  throw new Error(`turn ${turnId} never reached ${statuses.join('|')}: ${JSON.stringify(turns.poll(turnId, 0).status)}`)
}

async function waitTask(provider, sessionId, taskId, status, timeout = 5000, ready = () => true) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const task = provider.tasks(sessionId).find(t => t.id === taskId || t.toolUseId === taskId)
    if (task !== undefined && task.status === status && ready(task)) return task
    await sleep(20)
  }
  throw new Error(`task ${taskId} never reached ${status}: ${JSON.stringify(provider.tasks(sessionId))}`)
}

test('one child serves successive turns; a background task outlives the turn and leaves a record', async () => {
  const s = setup()
  try {
    const first = await s.turns.start(s.provider, { cwd: s.cwd, text: 'BG' })
    const done = await waitStatus(s.turns, first.turnId, ['done'])
    const sessionId = done.sessionId
    assert.equal(s.spawns(), 1)
    assert.equal(s.exits(), 0)
    const running = await waitTask(s.provider, sessionId, 'toolu_bg', 'running')
    assert.equal(running.kind, 'bash')
    assert.equal(running.toolUseId, 'toolu_bg')
    const settled = await waitTask(s.provider, sessionId, 'toolu_bg', 'completed', 5000, t => t.detail !== undefined)
    assert.equal(s.provider.tasks(sessionId).length, 1)
    assert.match(settled.detail, /exit code 0/)
    assert.ok(settled.finishedAt > 1e11)
    assert.ok(settled.finishedAt >= settled.startedAt)
    assert.equal(s.exits(), 0)
    const output = s.provider.taskOutput(sessionId, 'toolu_bg')
    assert.equal(output.text, 'BG_DONE\n')
    const disk = s.provider.readTranscript ? await s.provider.readTranscript(sessionId) : undefined
    assert.equal(disk.tasks.find(t => t.toolUseId === 'toolu_bg').status, 'completed')
    const second = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'again' })
    const secondDone = await waitStatus(s.turns, second.turnId, ['done'])
    assert.ok(secondDone.events.some(e => e.type === 'assistant' && e.text === 'echo:again'))
    assert.ok(secondDone.events.some(e => e.type === 'meta' && e.model === 'fake-model'))
    assert.equal(s.spawns(), 1)
    s.provider.dispose()
    const until = Date.now() + 3000
    while (s.exits() === 0 && Date.now() < until) await sleep(20)
    assert.equal(s.exits(), 1)
  } finally {
    s.cleanup()
  }
})

test('subagent progress and completion reach the task view with counters', async () => {
  const s = setup()
  try {
    const { turnId } = await s.turns.start(s.provider, { cwd: s.cwd, text: 'AGENT' })
    const { sessionId } = await waitStatus(s.turns, turnId, ['done'])
    const task = await waitTask(s.provider, sessionId, 'toolu_ag', 'completed', 5000, t => t.detail !== undefined)
    assert.equal(s.provider.tasks(sessionId).length, 1)
    assert.equal(task.kind, 'agent')
    assert.equal(task.subagentType, 'Explore')
    assert.equal(task.label, 'list files')
    assert.equal(task.tokens, 1500)
    assert.equal(task.toolUses, 4)
    assert.equal(task.durationMs, 900)
    assert.equal(task.result, '3 files')
    assert.equal(task.lastTool, 'Glob')
    assert.ok(task.finishedAt > 1e11)
    assert.ok(task.finishedAt >= task.startedAt)
  } finally {
    s.cleanup()
  }
})

test('changed launch options restart the child; approvals and interrupt still work', async () => {
  const s = setup()
  try {
    const a = await s.turns.start(s.provider, { cwd: s.cwd, text: 'ASK', options: { model: 'fake-model' } })
    const awaiting = await waitStatus(s.turns, a.turnId, ['awaiting'])
    const approval = awaiting.events.find(e => e.type === 'approval')
    s.turns.answer(a.turnId, approval.requestId, 'allow')
    const { sessionId } = await waitStatus(s.turns, a.turnId, ['done'])
    assert.equal(s.spawns(), 1)
    const b = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'HANG', options: { model: 'fake-model' } })
    await waitStatus(s.turns, b.turnId, ['running'])
    s.turns.cancel(b.turnId)
    assert.equal(s.turns.poll(b.turnId, 0).status, 'cancelled')
    await sleep(150)
    const c = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'after stop', options: { model: 'fake-model' } })
    const cDone = await waitStatus(s.turns, c.turnId, ['done'])
    assert.ok(cDone.events.some(e => e.type === 'assistant' && e.text === 'echo:after stop'))
    assert.equal(s.spawns(), 1)
    const d = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'other model', options: { model: 'other' } })
    await waitStatus(s.turns, d.turnId, ['done'])
    assert.equal(s.spawns(), 2)
    assert.equal(s.exits(), 1)
  } finally {
    s.cleanup()
  }
})

test('approval on a reused child is delivered to the same process', async () => {
  const s = setup()
  try {
    const a = await s.turns.start(s.provider, { cwd: s.cwd, text: 'first' })
    const { sessionId } = await waitStatus(s.turns, a.turnId, ['done'])
    const b = await s.turns.start(s.provider, { cwd: s.cwd, sessionId, text: 'ASK' })
    const awaiting = await waitStatus(s.turns, b.turnId, ['awaiting'])
    const approval = awaiting.events.find(e => e.type === 'approval')
    s.turns.answer(b.turnId, approval.requestId, 'allow')
    const done = await waitStatus(s.turns, b.turnId, ['done'])
    assert.ok(done.events.some(e => e.type === 'assistant' && e.text === 'APPROVED'))
    assert.equal(s.spawns(), 1)
  } finally {
    s.cleanup()
  }
})
