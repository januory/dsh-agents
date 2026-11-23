#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const log = process.env.FAKE_CODEX_LOG
if (log) appendFileSync(log, `spawn ${process.pid} ${process.argv[2] ?? ''}\n`)
const bye = () => {
  if (log) appendFileSync(log, `exit ${process.pid}\n`)
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-fake\n')
  process.exit(0)
}

const threads = new Map()
let goal = null
const out = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => out({ id, result })
const notify = (method, params) => out({ method, params })
const now = () => Math.floor(Date.now() / 1000)
const textOf = input => (input ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  const { id, method, params = {} } = frame
  if (method === undefined) return
  if (log) appendFileSync(log, `${JSON.stringify({ method, params })}\n`)
  switch (method) {
    case 'initialize':
      reply(id, { userAgent: 'fake-codex/0.0.0' })
      return
    case 'initialized':
      return
    case 'account/read':
      reply(id, { account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' }, requiresOpenaiAuth: false })
      return
    case 'model/list':
      reply(id, { data: [{ model: 'fake-codex', displayName: 'Fake Codex', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null })
      return
    case 'thread/list':
      reply(id, { data: [...threads.values()], nextCursor: null })
      return
    case 'thread/start':
    case 'thread/resume': {
      const thread = threads.get(params.threadId) ?? { id: `fake-${randomUUID().slice(0, 8)}`, createdAt: now(), preview: '', status: { type: 'idle' }, source: 'cli', historyMode: 'native', items: [] }
      Object.assign(thread, { cwd: params.cwd ?? thread.cwd, model: params.model ?? thread.model ?? 'fake-codex', updatedAt: now() })
      threads.set(thread.id, thread)
      reply(id, { thread })
      return
    }
    case 'turn/start': {
      const thread = threads.get(params.threadId)
      const text = textOf(params.input)
      const answer = `echo:${text}`
      const turnId = `turn-${randomUUID().slice(0, 8)}`
      const itemId = `msg-${randomUUID().slice(0, 8)}`
      thread.items.push({ type: 'userMessage', id: `${itemId}-u`, content: params.input }, { type: 'agentMessage', id: itemId, text: answer })
      thread.preview = thread.preview || text
      thread.updatedAt = now()
      reply(id, { turn: { id: turnId, status: 'inProgress' } })
      setTimeout(() => {
        notify('turn/started', { threadId: thread.id, turn: { id: turnId } })
        notify('item/started', { threadId: thread.id, item: { type: 'agentMessage', id: itemId, text: '' } })
        notify('item/agentMessage/delta', { threadId: thread.id, itemId, delta: answer })
        notify('item/completed', { threadId: thread.id, item: { type: 'agentMessage', id: itemId, text: answer } })
        notify('thread/tokenUsage/updated', { threadId: thread.id, tokenUsage: { total: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 7, cacheWriteInputTokens: 0 }, last: { inputTokens: 20, outputTokens: 7, totalTokens: 27 }, modelContextWindow: 128_000 } })
        notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
      }, 20)
      return
    }
    case 'thread/goal/get':
      reply(id, { goal })
      return
    case 'thread/goal/clear':
      goal = null
      reply(id, { cleared: true })
      return
    case 'thread/goal/set':
      goal = { threadId: params.threadId, objective: params.objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
      reply(id, { goal })
      setTimeout(() => {
        notify('turn/started', { threadId: params.threadId, turn: { id: 't-goal', status: 'inProgress' } })
        notify('item/completed', { threadId: params.threadId, item: { type: 'agentMessage', id: 'g1', text: 'GOAL_OK' } })
        notify('turn/completed', { threadId: params.threadId, turn: { id: 't-goal', status: 'completed' } })
      }, 50)
      return
    case 'thread/compact/start':
      reply(id, {})
      setTimeout(() => {
        notify('turn/started', { threadId: params.threadId, turn: { id: 't-compact', status: 'inProgress' } })
        notify('item/completed', { threadId: params.threadId, item: { type: 'contextCompaction', id: 'c1' } })
        notify('turn/completed', { threadId: params.threadId, turn: { id: 't-compact', status: 'completed' } })
      }, 50)
      return
    case 'thread/unsubscribe':
      reply(id, {})
      return
    case 'thread/read':
      reply(id, { thread: threads.get(params.threadId) })
      return
    case 'thread/turns/list':
      reply(id, { data: [{ items: threads.get(params.threadId)?.items ?? [] }], nextCursor: null })
      return
    default:
      if (id !== undefined) out({ id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})
rl.on('close', bye)
