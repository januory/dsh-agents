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

function isHumanUser(record) {
  if (record.type !== 'user' || record.isSidechain === true) return false
  const content = record.message?.content
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
      if (typeof content === 'string' || (Array.isArray(content) && content.some(b => b.type === 'text'))) {
        const text = userTextOf(record.message)
        if (text.trim() !== '') put({ id: record.uuid, type: 'user', ts: time, text })
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          put({
            id: block.tool_use_id,
            type: 'tool',
            ts: time,
            output: cap(resultText(block.content)),
            isError: block.is_error === true,
            status: block.is_error === true ? 'error' : 'done',
            structured: structuredOf(record.toolUseResult),
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
  }

  start(text) {
    this.sink.emit({ id: `${this.turnKey}:user`, type: 'user', ts: Date.now(), text })
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
      this.#emit({
        id: block.tool_use_id,
        type: 'tool',
        ts: time,
        output: cap(resultText(block.content)),
        isError: block.is_error === true,
        status: block.is_error === true ? 'error' : 'done',
        structured: structuredOf(frame.tool_use_result),
      })
    }
  }
}
