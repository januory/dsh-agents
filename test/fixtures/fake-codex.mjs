#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.FAKE_CODEX_LOG
const out = frame => process.stdout.write(`${JSON.stringify(frame)}\n`)
const notify = (method, params) => out({ jsonrpc: '2.0', method, params })
let goal = null

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.method === undefined) return
  if (log) appendFileSync(log, `${JSON.stringify({ method: frame.method, params: frame.params })}\n`)
  const reply = result => out({ jsonrpc: '2.0', id: frame.id, result })
  const threadId = frame.params?.threadId
  switch (frame.method) {
    case 'initialize':
      reply({})
      return
    case 'thread/resume':
      reply({ thread: { id: threadId, cwd: '/tmp', model: 'fake' } })
      return
    case 'thread/goal/get':
      reply({ goal })
      return
    case 'thread/goal/clear':
      goal = null
      reply({ cleared: true })
      return
    case 'thread/goal/set':
      goal = { threadId, objective: frame.params.objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
      reply({ goal })
      setTimeout(() => {
        notify('turn/started', { threadId, turn: { id: 't-goal', status: 'inProgress' } })
        notify('item/completed', { threadId, item: { type: 'agentMessage', id: 'g1', text: 'GOAL_OK' } })
        notify('turn/completed', { threadId, turn: { id: 't-goal', status: 'completed' } })
      }, 50)
      return
    case 'thread/compact/start':
      reply({})
      setTimeout(() => {
        notify('turn/started', { threadId, turn: { id: 't-compact', status: 'inProgress' } })
        notify('item/completed', { threadId, item: { type: 'contextCompaction', id: 'c1' } })
        notify('turn/completed', { threadId, turn: { id: 't-compact', status: 'completed' } })
      }, 50)
      return
    default:
      reply({})
  }
})
