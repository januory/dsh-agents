import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeCodexTasks, tasksFromCodexItems } from '../src/providers/codex-format.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { TurnManager } from '../src/turns.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
chmodSync(fixture, 0o755)
const windows = process.platform === 'win32'
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('codex tasks map persistent shells and subagents, not settled foreground commands', () => {
  const items = [
    { type: 'commandExecution', id: 'c1', command: 'sleep 30', source: 'unifiedExecStartup', status: 'inProgress', durationMs: 0 },
    { type: 'commandExecution', id: 'c2', command: 'ls', source: 'agent', status: 'completed', durationMs: 5 },
    { type: 'commandExecution', id: 'c3', command: 'grep x', source: 'agent', status: 'inProgress' },
    { type: 'collabAgentToolCall', id: 'a1', tool: 'Explore', prompt: 'count files', status: 'inProgress' },
    { type: 'collabAgentToolCall', id: 'a2', tool: 'Plan', prompt: 'design', status: 'completed' },
    { type: 'subAgentActivity', id: 's1', agentThreadId: 'th-child', agentPath: 'reviewer', kind: 'started' },
  ]
  const tasks = tasksFromCodexItems(items, 1_000_000)
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]))
  assert.equal(byId.c1.kind, 'bash')
  assert.equal(byId.c1.status, 'running')
  assert.equal(byId.c2, undefined)
  assert.equal(byId.c3.status, 'running')
  assert.equal(byId.a1.kind, 'agent')
  assert.equal(byId.a1.subagentType, 'Explore')
  assert.equal(byId.a1.status, 'running')
  assert.equal(byId.a2.status, 'completed')
  assert.equal(byId['th-child'].kind, 'agent')
  assert.equal(byId['th-child'].status, 'running')
  assert.ok(tasks.every(task => task.background === true))
})

test('codex subagent activity settles and interrupts', () => {
  const tasks = tasksFromCodexItems([
    { type: 'subAgentActivity', id: 's1', agentThreadId: 'th1', kind: 'completed' },
    { type: 'subAgentActivity', id: 's2', agentThreadId: 'th2', kind: 'interrupted' },
  ], 1_000_000)
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]))
  assert.equal(byId.th1.status, 'completed')
  assert.equal(byId.th2.status, 'interrupted')
})

test('merged subagent keeps a stable start so the timer grows, and settles once', () => {
  const running = tasksFromCodexItems([{ type: 'collabAgentToolCall', id: 'a1', tool: 'Explore', status: 'inProgress' }])
  let tasks = mergeCodexTasks([], running, 1000)
  assert.equal(tasks[0].startedAt, 1000)
  tasks = mergeCodexTasks(tasks, running, 9000)
  assert.equal(tasks[0].startedAt, 1000)
  assert.equal(tasks[0].finishedAt, undefined)
  const done = tasksFromCodexItems([{ type: 'collabAgentToolCall', id: 'a1', tool: 'Explore', status: 'completed' }])
  tasks = mergeCodexTasks(tasks, done, 12000)
  assert.equal(tasks[0].status, 'completed')
  assert.equal(tasks[0].startedAt, 1000)
  assert.equal(tasks[0].finishedAt, 12000)
  const shell = tasksFromCodexItems([{ type: 'commandExecution', id: 'c1', command: 'sleep', source: 'unifiedExecStartup', status: 'completed', durationMs: 5000 }])
  const merged = mergeCodexTasks([], shell, 20000)
  assert.equal(merged[0].finishedAt - merged[0].startedAt, 5000)
})

test('codex provider surfaces running subagents and shells, then settles them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-codex-tasks-'))
  const command = windows ? join(dir, 'fake-codex.cmd') : fixture
  if (windows) writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`)
  const provider = createCodexProvider({ command, home: join(dir, 'codex') })
  const turns = new TurnManager({ retentionMs: 60_000 })
  try {
    const { turnId } = await turns.start(provider, { cwd: dir, text: 'TASKS' })
    let sessionId
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const poll = turns.poll(turnId, 0)
      sessionId = poll.sessionId
      if (sessionId !== undefined && provider.activeBackground().some(turn => turn.sessionId === sessionId)) break
      await sleep(20)
    }
    assert.ok(sessionId !== undefined, 'turn never reported a session')
    const running = await provider.tasks(sessionId)
    assert.ok(running.some(task => task.kind === 'agent' && task.status === 'running'))
    assert.ok(running.some(task => task.kind === 'bash' && task.status === 'running'))
    assert.ok(provider.activeBackground().some(turn => turn.sessionId === sessionId))
    const settledUntil = Date.now() + 5000
    while (Date.now() < settledUntil) {
      const tasks = await provider.tasks(sessionId)
      if (tasks.every(task => task.status !== 'running')) break
      await sleep(20)
    }
    const settled = await provider.tasks(sessionId)
    assert.ok(settled.every(task => task.status !== 'running'))
    assert.ok(!provider.activeBackground().some(turn => turn.sessionId === sessionId))
  } finally {
    turns.dispose()
    provider.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
