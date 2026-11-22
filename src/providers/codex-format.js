const MAX_OUTPUT = 64 * 1024

function cap(text) {
  if (typeof text !== 'string') return ''
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [${text.length - MAX_OUTPUT} more characters]` : text
}

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.map(part => {
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text ?? ''
    if (part.type === 'image' || part.type === 'input_image' || part.type === 'localImage') return '[image]'
    return ''
  }).filter(Boolean).join('\n')
}

function toolStatus(status) {
  switch (status) {
    case 'inProgress': case 'in_progress': case 'running': return 'running'
    case 'failed': case 'declined': case 'error': return 'error'
    default: return 'done'
  }
}

function mcpOutput(result, error) {
  if (error) return cap(typeof error === 'string' ? error : error.message ?? JSON.stringify(error))
  if (result === undefined || result === null) return ''
  if (Array.isArray(result.content)) return cap(textOf(result.content))
  return cap(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

/**
 * Map one Codex app-server ThreadItem to a normalized transcript item.
 * @param {object} item
 * @param {number} ts
 * @param {boolean} done - the item reached item/completed
 * @returns {import('../registry.js').TurnEvent | undefined}
 */
export function codexItemToEvent(item, ts, done) {
  const id = item.id ?? `${item.type}:${ts}`
  switch (item.type) {
    case 'userMessage': {
      const text = textOf(item.content)
      return text.trim() === '' ? undefined : { id, type: 'user', ts, text }
    }
    case 'agentMessage':
      return { id, type: 'assistant', ts, text: item.text ?? '', done, commentary: item.phase === 'commentary' }
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n\n')
      return { id, type: 'thinking', ts, text, done }
    }
    case 'commandExecution':
      return {
        id,
        type: 'tool',
        ts,
        name: 'Bash',
        input: { command: item.command, cwd: item.cwd },
        output: cap(item.aggregatedOutput ?? ''),
        exitCode: item.exitCode ?? undefined,
        durationMs: item.durationMs ?? undefined,
        status: done ? toolStatus(item.status) : 'running',
        isError: item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
      }
    case 'fileChange':
      return {
        id,
        type: 'tool',
        ts,
        name: 'Edit',
        input: { changes: (item.changes ?? []).map(change => ({ path: change.path, kind: change.kind })) },
        structured: { changes: item.changes ?? [] },
        output: (item.changes ?? []).map(change => `${change.kind} ${change.path}`).join('\n'),
        status: done ? toolStatus(item.status) : 'running',
        isError: item.status === 'failed' || item.status === 'declined',
      }
    case 'mcpToolCall':
      return {
        id,
        type: 'tool',
        ts,
        name: `${item.server}/${item.tool}`,
        input: item.arguments ?? {},
        output: mcpOutput(item.result, item.error),
        durationMs: item.durationMs ?? undefined,
        status: done ? toolStatus(item.status) : 'running',
        isError: item.error !== undefined && item.error !== null,
      }
    case 'dynamicToolCall':
      return {
        id,
        type: 'tool',
        ts,
        name: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        input: item.arguments ?? {},
        output: cap(textOf(item.contentItems ?? [])),
        status: done ? toolStatus(item.status) : 'running',
        isError: item.success === false,
      }
    case 'functionCallOutput':
      return { id, type: 'tool', ts, name: item.name, output: cap(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')), status: 'done' }
    case 'webSearch':
      return { id, type: 'tool', ts, name: 'WebSearch', input: { query: item.query ?? '' }, output: cap(item.action ? JSON.stringify(item.action) : ''), status: done ? 'done' : 'running' }
    case 'imageView':
      return { id, type: 'tool', ts, name: 'ViewImage', input: { path: item.path }, status: 'done' }
    case 'plan':
      return { id, type: 'assistant', ts, text: item.text ?? '', done }
    case 'contextCompaction':
      return { id, type: 'turn', ts, phase: 'end', reason: 'compact' }
    case 'collabAgentToolCall':
      return { id, type: 'tool', ts, name: item.tool ?? 'agent', input: { prompt: item.prompt, receivers: item.receiverThreadIds }, status: done ? toolStatus(item.status) : 'running' }
    case 'subAgentActivity':
    case 'hookPrompt':
    case 'sleep':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return undefined
    default:
      return { id, type: 'tool', ts, name: String(item.type ?? 'item'), input: item, status: done ? 'done' : 'running' }
  }
}

/**
 * @param {object} thread - app-server Thread
 * @returns {import('../registry.js').SessionSummary}
 */
export function codexThreadSummary(thread) {
  const title = (typeof thread.name === 'string' && thread.name !== '' ? thread.name : '') || thread.preview || ''
  const active = thread.status?.type === 'active'
  return {
    provider: 'codex',
    id: thread.id,
    title: title.split('\n')[0].slice(0, 80),
    cwd: thread.cwd,
    gitBranch: thread.gitInfo?.branch ?? undefined,
    model: thread.model ?? undefined,
    createdAt: (thread.createdAt ?? 0) * 1000,
    updatedAt: (thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
    messageCount: 0,
    path: thread.path ?? undefined,
    historyMode: thread.historyMode,
    source: typeof thread.source === 'string' ? thread.source : thread.source?.custom ?? 'unknown',
    live: active ? { status: 'active', flags: thread.status.activeFlags ?? [] } : undefined,
  }
}
