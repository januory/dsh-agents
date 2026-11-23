import { saveUpload } from '../uploads.js'

const MAX_OUTPUT = 64 * 1024
const MAX_STRUCTURED = 32 * 1024

function ts(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function cap(text, limit = MAX_OUTPUT) {
  if (typeof text !== 'string') return ''
  return text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text
}

export function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  return content.map(block => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'image') return '[image]'
    return `[${block.type ?? 'block'}]`
  }).join('\n')
}

// Tool results (e.g. Read on an image) carry base64 blocks; store them so the
// transcript can offer a clickable preview instead of a "[image]" placeholder.
export function toolImagesOf(content) {
  if (!Array.isArray(content)) return undefined
  const images = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const source = block.source ?? {}
    if (source.type !== 'base64' || typeof source.data !== 'string') continue
    const mediaType = source.media_type ?? 'image/png'
    try { images.push({ id: saveUpload(mediaType, Buffer.from(source.data, 'base64')), mediaType }) } catch {}
  }
  return images.length > 0 ? images : undefined
}

function structuredOf(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const json = JSON.stringify(value)
  if (json.length > MAX_STRUCTURED) return undefined
  return value
}

export function userTextOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

// Claude flags synthetic companions (image-source notes, caveats, reminders) isMeta; nobody typed them.
function isHumanUser(record) {
  if (record.type !== 'user' || record.isSidechain === true || record.isMeta === true) return false
  const content = record.message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
  if (text.includes('<command-name>') || text.includes('<local-command-stdout>')) return false
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some(block => block.type === 'text')
}

/**
 * Fold Claude Code JSONL records into normalized transcript items. Each
 * assistant record carries one content block; tool results arrive as user
 * records and merge into the tool item by tool_use id.
 * @param {object[]} records
 * @returns {import('../registry.js').TurnEvent[]}
 */
export function parseClaudeRecords(records) {
  const events = []
  const index = new Map()
  const put = item => {
    const at = index.get(item.id)
    if (at === undefined) {
      index.set(item.id, events.length)
      events.push(item)
    } else events[at] = { ...events[at], ...item }
  }
  for (const record of records) {
    if (record.isSidechain === true) continue
    const time = ts(record.timestamp)
    if (record.type === 'user') {
      const content = record.message?.content
      if (record.isMeta !== true && (typeof content === 'string' || Array.isArray(content))) {
        const text = typeof content === 'string' ? content : userTextOf(record.message)
        // Slash-command plumbing records; the compact boundary row carries the visible outcome.
        if (text.includes('<command-name>') || text.includes('<local-command-stdout>')) continue
        const imageCount = Array.isArray(content) ? content.filter(b => b.type === 'image').length : 0
        // The CLI feeds completion notifications to the model as user text; the task panel owns that display.
        if (taskNotificationOf(text) === undefined && (text.trim() !== '' || imageCount > 0)) put({ id: record.uuid, type: 'user', ts: time, text, ...(imageCount > 0 ? { imageCount } : {}) })
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const images = toolImagesOf(block.content)
          put({
            id: block.tool_use_id,
            type: 'tool',
            ts: time,
            output: cap(resultText(block.content)),
            isError: block.is_error === true,
            status: block.is_error === true ? 'error' : 'done',
            structured: structuredOf(record.toolUseResult),
            ...(images ? { images } : {}),
          })
        }
      }
      continue
    }
    if (record.type === 'assistant') {
      const blocks = Array.isArray(record.message?.content) ? record.message.content : []
      for (const block of blocks) {
        if (block.type === 'text') put({ id: record.uuid, type: 'assistant', ts: time, text: block.text ?? '', done: true })
        else if (block.type === 'thinking') put({ id: record.uuid, type: 'thinking', ts: time, text: block.thinking ?? '', done: true })
        else if (block.type === 'tool_use') {
          put({ id: block.id, type: 'tool', ts: time, name: block.name, input: block.input ?? {}, status: 'running' })
        }
      }
      continue
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      put({ id: record.uuid, type: 'turn', ts: time, phase: 'end', reason: 'compact' })
    }
    if (record.type === 'system' && record.subtype === 'local_command' && String(record.content ?? '').includes('<local-command-stdout>')) {
      const text = String(record.content).replace(/<\/?local-command-stdout>/g, '').trim()
      if (text !== '') put({ id: record.uuid, type: 'assistant', ts: time, text, done: true })
    }
  }
  return events
}

/**
 * Session summary from the head and tail of a transcript file. Title records
 * are rewritten after every turn, so the last one in the tail is current.
 * @param {{ path: string, id: string, head: object[], tail: object[], size: number, mtimeMs: number, customTitle?: string, live?: object }} input
 * @returns {import('../registry.js').SessionSummary}
 */
export function summarizeClaude({ path, id, head, tail, size, mtimeMs, customTitle, live }) {
  const all = [...head, ...tail]
  let cwd, gitBranch, model, createdAt, lastTs, firstUser = ''
  let aiTitle = ''
  let fileTitle = ''
  let messages = 0
  for (const record of all) {
    if (typeof record.cwd === 'string' && cwd === undefined) cwd = record.cwd
    if (typeof record.gitBranch === 'string' && record.gitBranch !== '' && gitBranch === undefined) gitBranch = record.gitBranch
    const time = ts(record.timestamp)
    if (record.timestamp !== undefined) {
      createdAt ??= time
      lastTs = time
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') aiTitle = record.aiTitle
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') fileTitle = record.customTitle
    if (record.type === 'assistant' && record.isSidechain !== true) {
      messages += 1
      if (typeof record.message?.model === 'string') model = record.message.model
    }
    if (isHumanUser(record)) {
      messages += 1
      if (firstUser === '') firstUser = userTextOf(record.message).trim()
    }
  }
  const title = (customTitle ?? fileTitle) || aiTitle || firstUser.split('\n')[0].slice(0, 80)
  const liveName = live && typeof live.name === 'string' && live.nameSource !== 'auto' ? live.name : ''
  return {
    provider: 'claude',
    id,
    title: liveName || title,
    cwd,
    gitBranch,
    model,
    createdAt: createdAt ?? mtimeMs,
    updatedAt: Math.max(lastTs ?? 0, mtimeMs),
    messageCount: messages,
    path,
    size,
    live: live ? { pid: live.pid, status: live.status, waitingFor: live.waitingFor, entrypoint: live.entrypoint, kind: live.kind } : undefined,
  }
}

function tagOf(text, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match === null ? undefined : match[1].trim()
}

/**
 * The CLI persists a background task's completion as a queued
 * `<task-notification>` message; the same XML the model later receives.
 */
export function taskNotificationOf(content) {
  if (typeof content !== 'string' || !content.includes('<task-notification>')) return undefined
  const taskId = tagOf(content, 'task-id')
  const toolUseId = tagOf(content, 'tool-use-id')
  if (taskId === undefined && toolUseId === undefined) return undefined
  const usage = tagOf(content, 'usage')
  return {
    taskId,
    toolUseId,
    status: tagOf(content, 'status') ?? 'completed',
    summary: tagOf(content, 'summary'),
    result: tagOf(content, 'result'),
    outputFile: tagOf(content, 'output-file'),
    tokens: usage === undefined ? undefined : Number(tagOf(usage, 'subagent_tokens') ?? 0),
    toolUses: usage === undefined ? undefined : Number(tagOf(usage, 'tool_uses') ?? 0),
    durationMs: usage === undefined ? undefined : Number(tagOf(usage, 'duration_ms') ?? 0),
  }
}

function applyNotification(tasks, notification, at) {
  let task = notification.toolUseId === undefined ? undefined : tasks.get(notification.toolUseId)
  if (task === undefined && notification.taskId !== undefined) {
    for (const existing of tasks.values()) if (existing.id === notification.taskId) { task = existing; break }
  }
  if (task === undefined) {
    task = { id: notification.taskId ?? notification.toolUseId, toolUseId: notification.toolUseId, kind: 'task', label: notification.summary ?? '', background: true, startedAt: at, tokens: 0, toolUses: 0, durationMs: 0 }
    tasks.set(task.toolUseId ?? task.id, task)
  }
  task.status = notification.status
  task.finishedAt = at
  if (notification.taskId !== undefined) task.taskId = notification.taskId
  if (notification.summary !== undefined) task.detail = notification.summary
  if (notification.result !== undefined) task.result = notification.result
  if (notification.outputFile !== undefined) task.outputFile = notification.outputFile
  if (notification.tokens !== undefined) task.tokens = notification.tokens
  if (notification.toolUses !== undefined) task.toolUses = notification.toolUses
  if (notification.durationMs !== undefined) task.durationMs = notification.durationMs
}

/**
 * Background tasks and subagents reconstructed from a transcript: the launch
 * tool call opens a task, its result or a queued task notification settles it.
 * @param {object[]} records
 * @returns {object[]}
 */
export function tasksFromRecords(records) {
  const tasks = new Map()
  for (const record of records) {
    if (record.isSidechain === true) continue
    const time = ts(record.timestamp)
    if (record.type === 'assistant') {
      for (const block of record.message?.content ?? []) {
        if (block.type !== 'tool_use') continue
        const input = block.input ?? {}
        const agent = block.name === 'Agent' || block.name === 'Task'
        if (!agent && !(block.name === 'Bash' && input.run_in_background === true)) continue
        if (tasks.has(block.id)) continue
        tasks.set(block.id, {
          id: block.id,
          toolUseId: block.id,
          kind: agent ? 'agent' : 'bash',
          label: input.description ?? (agent ? '' : input.command ?? ''),
          subagentType: input.subagent_type ?? '',
          background: !agent || input.run_in_background === true,
          status: 'running',
          startedAt: time,
          tokens: 0,
          toolUses: 0,
          durationMs: 0,
        })
      }
      continue
    }
    if (record.type === 'user') {
      for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
        if (block.type !== 'tool_result') continue
        const task = tasks.get(block.tool_use_id)
        if (task === undefined) continue
        const text = resultText(block.content)
        const written = /Output is being written to: (\S+)/.exec(text)
        if (written !== null && task.outputFile === undefined) task.outputFile = written[1].replace(/\.$/, '')
        if (task.kind !== 'agent' || task.background || task.status !== 'running') continue
        task.status = block.is_error === true ? 'failed' : 'completed'
        task.finishedAt = time
        task.result = text
      }
      continue
    }
    if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      const notification = taskNotificationOf(record.content)
      if (notification !== undefined) applyNotification(tasks, notification, time)
      continue
    }
    if (record.type === 'system' && record.subtype === 'task_notification') {
      applyNotification(tasks, {
        taskId: record.task_id,
        toolUseId: record.tool_use_id ?? record.task_id,
        status: record.status ?? 'completed',
        summary: record.summary,
        result: record.result === undefined ? undefined : resultText(record.result.content),
        outputFile: record.output_file,
        tokens: record.usage?.total_tokens,
        toolUses: record.usage?.tool_uses,
        durationMs: record.usage?.duration_ms,
      }, time)
    }
  }
  return [...tasks.values()]
}

/**
 * Session token totals and context occupancy from the transcript's own usage
 * blocks; the last assistant usage is what still sits in the model's context.
 * @param {object[]} records
 * @param {number|undefined} capacity
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, contextTokens: number, capacity: number|null, turns: number, steps: number}}
 */
export function claudeUsageOf(records, capacity) {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let contextTokens = 0
  let turns = 0
  let steps = 0
  for (const record of records) {
    if (record.isSidechain === true) continue
    if (record.type === 'user' && record.isMeta !== true) {
      const content = record.message?.content
      if (typeof content === 'string' || (Array.isArray(content) && content.some(block => block.type === 'text'))) turns += 1
    }
    if (record.type !== 'assistant') continue
    steps += 1
    const usage = record.message?.usage
    if (usage === undefined) continue
    inputTokens += usage.input_tokens ?? 0
    outputTokens += usage.output_tokens ?? 0
    cacheReadTokens += usage.cache_read_input_tokens ?? 0
    cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
    contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, contextTokens, capacity: capacity ?? null, turns, steps }
}

/** Disk-derived tasks merged with the live child's view; live counters win. */
export function mergeTasks(disk, live) {
  const merged = []
  const seen = new Set()
  for (const task of disk) {
    const own = live.find(entry => entry.toolUseId !== undefined && entry.toolUseId === task.toolUseId)
    if (own === undefined) { merged.push({ ...task }); continue }
    seen.add(own.id)
    merged.push({ ...task, ...own, result: own.result ?? task.result, detail: own.detail ?? task.detail, outputFile: own.outputFile ?? task.outputFile })
  }
  for (const task of live) if (!seen.has(task.id)) merged.push({ ...task })
  return merged
}

/**
 * Live stream-json decoder: turns partial stream events, completed assistant
 * frames, tool results and permission requests into normalized items, keeping
 * one id per item so updates replace rather than duplicate.
 */
export class ClaudeLive {
  constructor(sink, { turnKey }) {
    this.sink = sink
    this.turnKey = turnKey
    this.messageId = undefined
    this.pending = new Map()
    this.finalized = new Set()
    this.toolIds = new Set()
    this.result = undefined
    this.sessionId = undefined
    this.steerCount = 0
  }

  start(text, images) {
    this.sink.emit({ id: `${this.turnKey}:user`, type: 'user', ts: Date.now(), text, ...(images?.length ? { images } : {}) })
  }

  steer(text, images) {
    this.steerCount += 1
    this.sink.emit({ id: `${this.turnKey}:steer:${this.steerCount}:user`, type: 'user', ts: Date.now(), text, ...(images?.length ? { images } : {}) })
  }

  onFrame(frame) {
    const time = Date.now()
    switch (frame.type) {
      case 'system':
        if (frame.subtype === 'init') {
          this.sessionId = frame.session_id
          this.sink.setSession(frame.session_id)
          this.sink.emit({ id: `${this.turnKey}:meta`, type: 'meta', ts: time, model: frame.model, cwd: frame.cwd, version: frame.claude_code_version, permissionMode: frame.permissionMode })
        }
        return
      case 'stream_event':
        if (frame.parent_tool_use_id) return
        this.#stream(frame.event, time)
        return
      case 'assistant':
        if (frame.parent_tool_use_id) return
        this.#assistant(frame, time)
        return
      case 'user':
        if (frame.parent_tool_use_id) return
        this.#user(frame, time)
        return
      case 'result':
        this.result = frame
        return
      default:
        return
    }
  }

  #emit(item) {
    this.sink.emit(item)
  }

  #stream(event, time) {
    switch (event.type) {
      case 'message_start':
        this.messageId = event.message?.id
        this.pending = new Map()
        this.finalized = new Set()
        return
      case 'content_block_start': {
        const block = event.content_block ?? {}
        const key = `${this.messageId}:${event.index}`
        if (block.type === 'text') {
          const item = { id: `s:${key}`, type: 'assistant', ts: time, text: block.text ?? '', done: false }
          this.pending.set(event.index, item)
          this.#emit(item)
        } else if (block.type === 'thinking') {
          const item = { id: `s:${key}`, type: 'thinking', ts: time, text: block.thinking ?? '', done: false }
          this.pending.set(event.index, item)
          this.#emit(item)
        } else if (block.type === 'tool_use') {
          const item = { id: block.id, type: 'tool', ts: time, name: block.name, input: {}, inputText: '', status: 'running' }
          this.pending.set(event.index, item)
          this.toolIds.add(block.id)
          this.#emit(item)
        }
        return
      }
      case 'content_block_delta': {
        const item = this.pending.get(event.index)
        if (item === undefined) return
        const delta = event.delta ?? {}
        let next
        if (delta.type === 'text_delta') next = { ...item, text: item.text + (delta.text ?? '') }
        else if (delta.type === 'thinking_delta') next = { ...item, text: item.text + (delta.thinking ?? '') }
        else if (delta.type === 'input_json_delta') next = { ...item, inputText: item.inputText + (delta.partial_json ?? '') }
        else return
        this.pending.set(event.index, next)
        this.#emit(next)
        return
      }
      case 'content_block_stop': {
        const item = this.pending.get(event.index)
        if (item === undefined) return
        if (item.type === 'tool') {
          let input = {}
          try { input = item.inputText === '' ? {} : JSON.parse(item.inputText) } catch { input = { raw: item.inputText } }
          this.#emit({ ...item, input, inputText: undefined })
        } else this.#emit({ ...item, done: true })
        return
      }
      default:
        return
    }
  }

  #takePending(type, predicate) {
    for (const [index, item] of this.pending) {
      if (item.type !== type || this.finalized.has(index)) continue
      if (predicate !== undefined && !predicate(item)) continue
      this.finalized.add(index)
      return item
    }
    return undefined
  }

  #assistant(frame, time) {
    const blocks = Array.isArray(frame.message?.content) ? frame.message.content : []
    for (const block of blocks) {
      if (block.type === 'text') {
        const pending = this.#takePending('assistant')
        this.#emit({ id: pending?.id ?? frame.uuid, type: 'assistant', ts: time, text: block.text ?? '', done: true })
      } else if (block.type === 'thinking') {
        const pending = this.#takePending('thinking')
        this.#emit({ id: pending?.id ?? frame.uuid, type: 'thinking', ts: time, text: block.thinking ?? '', done: true })
      } else if (block.type === 'tool_use') {
        this.#takePending('tool', item => item.id === block.id)
        this.toolIds.add(block.id)
        this.#emit({ id: block.id, type: 'tool', ts: time, name: block.name, input: block.input ?? {}, inputText: undefined, status: 'running' })
      }
    }
    if (frame.error) this.sink.emit({ id: `${this.turnKey}:err:${frame.uuid}`, type: 'error', ts: time, message: String(frame.error) })
  }

  #user(frame, time) {
    const content = frame.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const images = toolImagesOf(block.content)
      this.#emit({
        id: block.tool_use_id,
        type: 'tool',
        ts: time,
        output: cap(resultText(block.content)),
        isError: block.is_error === true,
        status: block.is_error === true ? 'error' : 'done',
        structured: structuredOf(frame.tool_use_result),
        ...(images ? { images } : {}),
      })
    }
  }
}
