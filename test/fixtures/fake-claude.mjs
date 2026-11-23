#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const home = process.env.CLAUDE_CONFIG_DIR
const cwd = process.cwd()
const resume = process.argv.find(a => a.startsWith('--resume='))?.slice('--resume='.length)
const modelAt = process.argv.indexOf('--model')
const model = modelAt === -1 ? 'fake-model' : process.argv[modelAt + 1]
const sessionId = resume ?? `fake-${randomUUID().slice(0, 8)}`
const dir = join(home, 'projects', cwd.replace(/[/.]/g, '-'))
mkdirSync(dir, { recursive: true })
const transcript = join(dir, `${sessionId}.jsonl`)
const log = process.env.FAKE_SPAWN_LOG
if (log) appendFileSync(log, `spawn ${process.pid} ${resume ?? 'new'} ${model}\n`)
const bye = () => { if (log) appendFileSync(log, `exit ${process.pid}\n`); process.exit(0) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)

const out = frame => process.stdout.write(`${JSON.stringify(frame)}\n`)
const record = r => appendFileSync(transcript, `${JSON.stringify({ sessionId, cwd, version: '0.0.0-fake', timestamp: new Date().toISOString(), ...r })}\n`)
const textOf = content => content.filter(b => b.type === 'text').map(b => b.text).join('\n')
let pendingApproval
let hanging = false

function assistant(content) {
  const uuid = randomUUID()
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
  record({ type: 'assistant', uuid, message: { role: 'assistant', model, content, usage } })
  out({ type: 'assistant', session_id: sessionId, uuid, message: { role: 'assistant', model, content, usage } })
}
function toolResult(id, text) {
  const content = [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }]
  record({ type: 'user', uuid: randomUUID(), message: { role: 'user', content } })
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content } })
}
function result(text, isError = false) {
  out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text, duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [model]: { contextWindow: 200000 } }, session_id: sessionId })
}
function notificationXml({ taskId, toolUseId, status, summary, outputFile, result: text, usage }) {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${outputFile ?? ''}</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>${text === undefined ? '' : `\n<result>${text}</result>`}${usage === undefined ? '' : `\n<usage>\n<subagent_tokens>${usage.total_tokens}</subagent_tokens>\n<tool_uses>${usage.tool_uses}</tool_uses>\n<duration_ms>${usage.duration_ms}</duration_ms>\n</usage>`}\n</task-notification>`
}

const pendingTasks = new Map()

function settleTask(taskId, status) {
  const pending = pendingTasks.get(taskId)
  if (pending === undefined) return
  clearTimeout(pending.timer)
  pendingTasks.delete(taskId)
  const summary = `Background task ${taskId} ${status}`
  record({ type: 'queue-operation', operation: 'enqueue', content: notificationXml({ taskId, toolUseId: pending.toolId, status, summary, outputFile: pending.outputFile }) })
  out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: pending.toolId, status, summary, output_file: pending.outputFile })
}

function background(text) {
  const agent = text === 'AGENT'
  const slow = text === 'SLOW'
  const toolId = agent ? 'toolu_ag' : slow ? 'toolu_slow' : 'toolu_bg'
  const taskId = agent ? 'taskag' : slow ? 'taskslow' : 'taskbg'
  const input = agent ? { description: 'list files', subagent_type: 'Explore', prompt: 'count files', run_in_background: true } : { command: slow ? 'sleep 30' : 'sleep 1; echo BG_DONE', description: slow ? 'slow probe' : 'bg probe', run_in_background: true }
  const outputFile = join(dir, `${taskId}.output`)
  assistant([{ type: 'tool_use', id: toolId, name: agent ? 'Agent' : 'Bash', input }])
  toolResult(toolId, `Background task started with ID: ${taskId}. Output is being written to: ${outputFile}.`)
  result(agent ? 'AGENT_STARTED' : 'STARTED')
  setTimeout(() => out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolId, description: agent ? 'Running …' : input.description, subagent_type: agent ? 'Explore' : undefined, task_type: agent ? 'agent' : 'bash', is_backgrounded: true }), 100)
  setTimeout(() => out({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolId, description: agent ? 'Running …' : input.description, subagent_type: agent ? 'Explore' : undefined, usage: { total_tokens: agent ? 1234 : 0, tool_uses: agent ? 3 : 1, duration_ms: 300 }, last_tool_name: agent ? 'Glob' : 'Bash' }), 250)
  const timer = setTimeout(() => {
    pendingTasks.delete(taskId)
    writeFileSync(outputFile, agent ? '3 files\n' : 'BG_DONE\n')
    const usage = agent ? { total_tokens: 1500, tool_uses: 4, duration_ms: 900 } : undefined
    const summary = agent ? 'Agent "list files" finished' : `Background command "${input.description}" completed (exit code 0)`
    const frame = { type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolId, status: 'completed', summary, output_file: outputFile, ...(agent ? { result: { content: [{ type: 'text', text: '3 files' }] }, usage } : {}) }
    record({ type: 'queue-operation', operation: 'enqueue', content: notificationXml({ taskId, toolUseId: toolId, status: 'completed', summary, outputFile, result: agent ? '3 files' : undefined, usage }) })
    out({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: Math.floor(Date.now() / 1000) } })
    out(frame)
  }, slow ? 5000 : 500)
  pendingTasks.set(taskId, { timer, toolId, outputFile })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.type === 'control_request') {
    const req = frame.request ?? {}
    if (req.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [{ value: 'fake-model', displayName: 'Fake' }] } } })
      out({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd, claude_code_version: '0.0.0-fake', permissionMode: 'default' })
    } else if (req.subtype === 'interrupt') {
      hanging = false
      if (req.spare_background_tasks !== true) for (const taskId of [...pendingTasks.keys()]) settleTask(taskId, 'killed')
      result('Interrupted by user', true)
    } else if (req.subtype === 'stop_task') {
      if (!pendingTasks.has(req.task_id)) {
        out({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'unknown task' } })
        return
      }
      settleTask(req.task_id, 'killed')
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'unsupported' } })
    }
    return
  }
  if (frame.type === 'control_response') {
    if (pendingApproval !== undefined) {
      const allowed = frame.response?.response?.behavior === 'allow'
      pendingApproval = undefined
      assistant([{ type: 'text', text: allowed ? 'APPROVED' : 'DENIED' }])
      result(allowed ? 'APPROVED' : 'DENIED')
    }
    return
  }
  if (frame.type !== 'user') return
  const content = frame.message?.content ?? []
  const text = textOf(content)
  record({ type: 'user', uuid: randomUUID(), message: { role: 'user', content } })
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content }, isReplay: true })
  if (text === 'BG' || text === 'AGENT' || text === 'SLOW') { background(text); return }
  if (text === 'ASK') {
    pendingApproval = 'r1'
    out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, permission_suggestions: [] } })
    return
  }
  if (text === 'HANG') { hanging = true; assistant([{ type: 'text', text: 'working' }]); return }
  if (hanging) return
  assistant([{ type: 'text', text: `echo:${text}` }])
  result(`echo:${text}`)
})
rl.on('close', bye)
