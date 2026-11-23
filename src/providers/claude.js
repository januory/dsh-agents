import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capture, parseJsonLine, resolveCommand, spawnLines } from './cli.js'
import { headTail, tailRecords, tailText } from './files.js'
import { ClaudeLive, claudeUsageOf, mergeTasks, parseClaudeRecords, resultText, summarizeClaude, tasksFromRecords } from './claude-format.js'
import { messageOf } from '../remote.js'
import { readUpload } from '../uploads.js'

const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'manual', 'bypassPermissions']
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const MAX_TASK_OUTPUT_BYTES = 128 * 1024
// The CLI owns its background shells: closing stdin or killing the process
// group at turn end would kill them before they write a completion record.
const IDLE_CHILD_MS = 30 * 60_000

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function pidAlive(pid) {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// task_updated patch timestamps are epoch seconds; every other task clock is milliseconds.
function epochMs(value) {
  return value < 1e11 ? value * 1000 : value
}

function localCommandOf(frame) {
  const content = frame.message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
  return text.includes('<local-command-stdout>') ? text : undefined
}

function optionKey(options) {
  return `${options?.permissionMode ?? ''}|${options?.model ?? ''}|${options?.effort ?? ''}`
}

function taskKindOf(toolName, input) {
  if (toolName === 'Agent' || toolName === 'Task') return 'agent'
  if (toolName === 'Bash' && input?.run_in_background === true) return 'bash'
  return undefined
}

// The same task can surface under its tool_use id (launch call) and its CLI
// task id (progress/notification frames); fold them into one row, settled wins.
function collapseTasks(tasks) {
  const out = []
  const same = (a, b) => (a.toolUseId !== undefined && a.toolUseId === b.toolUseId)
    || (a.taskId !== undefined && a.taskId === b.taskId)
    || a.id === b.id
    || (a.toolUseId !== undefined && a.toolUseId === b.id)
    || (b.toolUseId !== undefined && b.toolUseId === a.id)
  for (const task of tasks) {
    const own = out.find(entry => same(entry, task))
    if (own === undefined) { out.push({ ...task }); continue }
    const base = own.status !== 'running' ? own : task.status !== 'running' ? task : task
    const other = base === own ? task : own
    Object.assign(own, other, base)
  }
  return out
}

function frameKind(frame) {
  if (typeof frame.subagent_type === 'string' && frame.subagent_type !== '') return 'agent'
  const type = String(frame.task_type ?? '')
  if (type.includes('agent') || type.includes('subagent')) return 'agent'
  if (type.includes('bash') || type.includes('shell') || type.includes('command')) return 'bash'
  return 'task'
}

/**
 * Claude Code provider: lists transcripts under ~/.claude/projects and drives
 * `claude -p --resume` over stream-json stdio. No settings, prompts or tools
 * are altered; the only flags passed are the transport, the resume target and
 * the launch options the user chose.
 * @param {{ command: string, home: string }} config
 * @returns {import('../registry.js').AgentCliProvider}
 */
export function createClaudeProvider(config) {
  const home = expandHome(config.home || join(homedir(), '.claude'))
  const projectsDir = join(home, 'projects')
  const commandName = config.command || 'claude'
  const summaryCache = new Map()
  const tasksCache = new Map()
  const pathIndex = new Map()
  const ownPids = new Set()
  const children = new Map()
  // Context capacity is only known from the CLI's own result report; guessing it misreads custom models.
  // Keyed by model so every session on that model shares the reported window; the host persists reports
  // so reopened sessions keep their meter across harness restarts.
  const modelCapacity = new Map(Object.entries(config.capacity ?? {}))
  // The CLI compacts against CLAUDE_CODE_MAX_CONTEXT_TOKENS when set, while its result report falls back
  // to a catalog default for models it does not know; the configured window is the trustworthy capacity.
  const configuredWindow = (() => {
    const fromEnv = Number(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
    try {
      const value = Number(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch { return undefined }
  })()
  let pendingEntry

  function transcriptFiles() {
    if (!existsSync(projectsDir)) return []
    const files = []
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(projectsDir, entry.name)
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(dir, file)
        const id = file.slice(0, -'.jsonl'.length)
        files.push({ path, id })
        pathIndex.set(id, path)
      }
    }
    return files
  }

  function liveSessions() {
    const dir = join(home, 'sessions')
    const live = new Map()
    if (!existsSync(dir)) return live
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const info = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        if (typeof info.sessionId !== 'string' || ownPids.has(info.pid) || !pidAlive(info.pid)) continue
        const previous = live.get(info.sessionId)
        if (previous === undefined || (info.updatedAt ?? 0) > (previous.updatedAt ?? 0)) live.set(info.sessionId, info)
      } catch {
        // A lock file being rewritten is not a live session fact.
      }
    }
    return live
  }

  function customTitleOf(id) {
    const path = pathIndex.get(id)
    if (path === undefined) return undefined
    const file = join(path.slice(0, -'.jsonl'.length), 'custom-title.json')
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      return typeof value.customTitle === 'string' && value.customTitle !== '' ? value.customTitle : undefined
    } catch {
      return undefined
    }
  }

  function summarizeFile({ path, id }, live) {
    const stat = statSync(path)
    const key = `${stat.mtimeMs}:${stat.size}`
    const cached = summaryCache.get(path)
    if (cached !== undefined && cached.key === key) return { ...cached.summary, live: live?.live }
    const { head, tail, size } = headTail(path)
    const summary = summarizeClaude({ path, id, head, tail, size, mtimeMs: stat.mtimeMs, customTitle: customTitleOf(id), live: live?.live })
    summaryCache.set(path, { key, summary })
    return summary
  }

  let modelsCache
  async function probeModels() {
    if (modelsCache !== undefined && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.promise
    const command = resolveCommand(commandName)
    if (command === undefined) return []
    const promise = new Promise(resolve => {
      let done = false
      const finish = models => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(models)
      }
      // Initialize-only handshake: the CLI answers with its model catalog and
      // exits on closed stdin without a model call; persistence is off so no
      // transcript is written for the probe.
      const child = spawnLines({
        command,
        args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--no-session-persistence'],
        cwd: homedir(),
        onLine: line => {
          const frame = parseJsonLine(line)
          if (frame?.type !== 'control_response') return
          const models = frame.response?.response?.models
          finish(Array.isArray(models) ? models.filter(m => typeof m.value === 'string' && m.value !== 'default').map(m => ({ id: m.value, label: m.displayName ?? m.value, description: m.description })) : [])
          child.endInput()
        },
        onExit: () => finish([]),
        onError: () => finish([]),
      })
      const timer = setTimeout(() => {
        child.kill()
        finish([])
      }, 20_000)
      timer.unref?.()
      child.write(`${JSON.stringify({ type: 'control_request', request_id: 'dsh-models', request: { subtype: 'initialize', hooks: {} } })}\n`)
    })
    modelsCache = { at: Date.now(), promise }
    return promise
  }

  function findPath(id) {
    const known = pathIndex.get(id)
    if (known !== undefined && existsSync(known)) return known
    transcriptFiles()
    const path = pathIndex.get(id)
    if (path === undefined) throw new Error(`claude: session ${id} not found under ${projectsDir}`)
    return path
  }

  function diskTasks(id) {
    const path = findPath(id)
    const stat = statSync(path)
    const key = `${stat.mtimeMs}:${stat.size}`
    const cached = tasksCache.get(path)
    if (cached !== undefined && cached.key === key) return cached.tasks
    const tasks = tasksFromRecords(tailRecords(path, MAX_TRANSCRIPT_BYTES).records)
    tasksCache.set(path, { key, tasks })
    return tasks
  }

  function entryFor(sessionId) {
    if (sessionId === undefined) return undefined
    const entry = children.get(sessionId)
    return entry !== undefined && !entry.dead ? entry : undefined
  }

  function tasksOf(id) {
    const entry = entryFor(id)
    const live = entry === undefined ? [] : [...entry.tasks.values()]
    let disk
    try { disk = diskTasks(id) } catch { disk = [] }
    const merged = collapseTasks(mergeTasks(disk, live))
    if (entry === undefined && liveSessions().get(id) === undefined) {
      for (const task of merged) if (task.status === 'running') task.status = 'interrupted'
    }
    for (const task of merged) if (task.status === 'running') settleFromOutput(task)
    return merged.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  // A killed shell can leave an exit marker in its output file without ever emitting a notification.
  function settleFromOutput(task) {
    if (task.outputFile === undefined || !existsSync(task.outputFile)) return
    let tail
    try { tail = tailText(task.outputFile, 256).text.trimEnd() } catch { return }
    const exit = /\[exited with code (\d+)\]$/.exec(tail)
    const killed = /\[killed\]$/.exec(tail) ?? /\[exited with signal [^\]]+\]$/.exec(tail)
    if (exit === null && killed === null) return
    task.status = killed !== null ? 'killed' : (Number(exit[1]) === 0 ? 'completed' : 'failed')
    try { task.finishedAt = statSync(task.outputFile).mtimeMs } catch { task.finishedAt = Date.now() }
  }

  function dropEntry(entry) {
    entry.dead = true
    clearTimeout(entry.idleTimer)
    if (entry.sessionId !== undefined && children.get(entry.sessionId) === entry) children.delete(entry.sessionId)
    if (pendingEntry === entry) pendingEntry = undefined
    if (entry.child?.pid !== undefined) ownPids.delete(entry.child.pid)
  }

  function armIdle(entry) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      for (const task of entry.tasks.values()) if (task.status === 'running') { armIdle(entry); return }
      entry.child.endInput()
      entry.child.kill()
    }, IDLE_CHILD_MS)
    entry.idleTimer.unref?.()
  }

  function settleTurn(entry, result) {
    const turn = entry.current
    if (turn === undefined || turn.settled) return
    turn.settled = true
    clearTimeout(turn.killTimer)
    entry.current = undefined
    turn.sink.finish(result)
    armIdle(entry)
  }

  function findTask(entry, id, toolUseId) {
    const own = entry.tasks.get(id)
    if (own !== undefined) return own
    for (const task of entry.tasks.values()) {
      if (toolUseId !== undefined && task.toolUseId === toolUseId) return task
      // task_updated frames carry only the CLI task id; alias it to the launch task instead of opening a phantom row.
      if (task.taskId === id) return task
    }
    return undefined
  }

  function upsertTask(entry, patch) {
    let task = findTask(entry, patch.id, patch.toolUseId)
    if (task === undefined) {
      task = { tokens: 0, toolUses: 0, durationMs: 0, ...patch }
      entry.tasks.set(task.id, task)
    } else {
      const clean = {}
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) clean[key] = value
      if (clean.label === '') clean.label = task.label
      Object.assign(task, clean, { id: task.id, startedAt: task.startedAt ?? clean.startedAt })
    }
    return task
  }

  function notifyTask(entry, { taskId, toolUseId, status, summary, result, outputFile, usage, at }) {
    const patch = { status, detail: summary, finishedAt: at, taskId }
    if (result !== undefined && result !== '') patch.result = result
    if (outputFile) patch.outputFile = outputFile
    if (usage !== undefined) {
      patch.tokens = usage.total_tokens ?? usage.subagent_tokens ?? 0
      patch.toolUses = usage.tool_uses ?? 0
      patch.durationMs = usage.duration_ms ?? 0
    }
    if (taskId !== undefined && entry.tasks.has(taskId)) upsertTask(entry, { id: taskId, ...patch })
    else if (toolUseId !== undefined) upsertTask(entry, { id: taskId ?? toolUseId, toolUseId, ...patch })
  }

  function onTaskFrame(entry, frame) {
    const at = Date.now()
    const base = { id: frame.task_id, taskId: frame.task_id, toolUseId: frame.tool_use_id }
    // Agent frames carry a live placeholder description ("Running …"); the launch description is the stable name.
    const label = findTask(entry, frame.task_id, frame.tool_use_id)?.label || frame.description || ''
    if (frame.subtype === 'task_started') {
      upsertTask(entry, {
        ...base,
        kind: frameKind(frame),
        label,
        subagentType: frame.subagent_type ?? '',
        background: frame.is_backgrounded === true || frame.awaited !== true,
        parentTaskId: frame.parent_task_id,
        status: 'running',
        startedAt: at,
      })
      return
    }
    if (frame.subtype === 'task_progress') {
      const usage = frame.usage ?? {}
      upsertTask(entry, {
        ...base,
        label,
        subagentType: frame.subagent_type ?? '',
        lastTool: frame.last_tool_name,
        progress: frame.summary,
        hasProgress: true,
        tokens: usage.total_tokens ?? 0,
        toolUses: usage.tool_uses ?? 0,
        durationMs: usage.duration_ms ?? 0,
      })
      return
    }
    if (frame.subtype === 'task_updated') {
      const patch = frame.patch ?? {}
      const update = { id: frame.task_id }
      if (patch.status !== undefined) update.status = patch.status
      if (patch.description !== undefined) update.label = patch.description
      if (patch.end_time !== undefined) update.finishedAt = epochMs(patch.end_time)
      if (patch.error !== undefined) update.detail = String(patch.error)
      upsertTask(entry, update)
      return
    }
    if (frame.subtype === 'task_notification') {
      notifyTask(entry, {
        taskId: frame.task_id,
        toolUseId: frame.tool_use_id,
        status: frame.status ?? 'completed',
        summary: frame.summary ?? frame.reason,
        result: frame.result === undefined ? undefined : resultText(frame.result.content),
        outputFile: frame.output_file,
        usage: frame.usage,
        at,
      })
    }
  }

  function onToolUse(entry, block, at) {
    const kind = taskKindOf(block.name, block.input)
    if (kind === undefined) return
    const input = block.input ?? {}
    upsertTask(entry, {
      id: block.id,
      toolUseId: block.id,
      kind,
      label: input.description ?? (kind === 'bash' ? input.command ?? '' : ''),
      subagentType: input.subagent_type ?? '',
      background: kind === 'bash' || input.run_in_background === true,
      status: 'running',
      startedAt: at,
    })
  }

  function onToolResult(entry, block, at) {
    const text = resultText(block.content)
    for (const task of entry.tasks.values()) {
      if (task.toolUseId !== block.tool_use_id) continue
      const written = /Output is being written to: (\S+)/.exec(text)
      if (written !== null && task.outputFile === undefined) task.outputFile = written[1].replace(/\.$/, '')
      if (task.kind !== 'agent' || task.background || task.status !== 'running') continue
      task.status = block.is_error === true ? 'failed' : 'completed'
      task.finishedAt = at
      task.result = text
    }
  }

  function spawnEntry(request, command, args, key) {
    const entry = { child: undefined, key, meta: undefined, sessionId: request.sessionId, current: undefined, tasks: new Map(), stops: new Map(), idleTimer: undefined, draining: false, dead: false }
    const respond = (requestId, response) => {
      entry.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`)
    }
    const onControlRequest = frame => {
      const req = frame.request ?? {}
      const turn = entry.current
      if (req.subtype === 'can_use_tool' && turn === undefined) {
        respond(frame.request_id, { behavior: 'deny', message: 'dsh: no active turn to approve this tool use.' })
        return
      }
      if (req.subtype === 'can_use_tool' && req.tool_name === 'AskUserQuestion') {
        turn.questions.set(frame.request_id, req.input ?? {})
        turn.sink.emit({
          id: `question:${frame.request_id}`,
          type: 'question',
          ts: Date.now(),
          requestId: frame.request_id,
          questions: (req.input?.questions ?? []).map(q => ({
            key: q.question,
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect === true,
            options: q.options ?? [],
          })),
          status: 'running',
        })
        return
      }
      if (req.subtype === 'can_use_tool') {
        const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []
        turn.approvals.set(frame.request_id, { input: req.input, suggestions })
        turn.sink.emit({
          id: `approval:${frame.request_id}`,
          type: 'approval',
          ts: Date.now(),
          requestId: frame.request_id,
          name: req.tool_name,
          input: req.input,
          title: req.title ?? req.display_name,
          message: req.description,
          options: suggestions.length > 0 ? ['allow', 'allow_session', 'deny'] : ['allow', 'deny'],
          status: 'running',
        })
        return
      }
      if (req.subtype === 'request_user_dialog') {
        respond(frame.request_id, { behavior: 'cancelled' })
        return
      }
      entry.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: `dsh does not host ${req.subtype}` } })}\n`)
    }
    entry.respond = respond
    entry.child = spawnLines({
      command,
      args,
      cwd: request.cwd,
      onLine: line => {
        const frame = parseJsonLine(line)
        if (frame === undefined) return
        if (frame.type === 'control_request') {
          onControlRequest(frame)
          return
        }
        if (frame.type === 'control_response') {
          const stop = entry.stops.get(frame.response?.request_id)
          if (stop !== undefined) {
            entry.stops.delete(frame.response.request_id)
            stop(frame.response?.subtype === 'success' ? undefined : String(frame.response?.error ?? 'stop failed'))
          }
          return
        }
        if (frame.type === 'system') {
          if (frame.subtype === 'init') {
            entry.sessionId = frame.session_id
            entry.meta = { model: frame.model, cwd: frame.cwd, version: frame.claude_code_version, permissionMode: frame.permissionMode }
            if (pendingEntry === entry) pendingEntry = undefined
            children.set(frame.session_id, entry)
          } else if (frame.subtype === 'task_started' || frame.subtype === 'task_progress' || frame.subtype === 'task_updated' || frame.subtype === 'task_notification') {
            onTaskFrame(entry, frame)
          }
        }
        // Older CLIs send no task_progress; count the subagent's own frames instead.
        if (frame.type === 'assistant' && frame.parent_tool_use_id) {
          for (const task of entry.tasks.values()) {
            if (task.toolUseId !== frame.parent_tool_use_id || task.hasProgress) continue
            const usage = frame.message?.usage ?? {}
            task.tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
            for (const block of frame.message?.content ?? []) if (block.type === 'tool_use') { task.toolUses += 1; task.lastTool = block.name }
          }
        }
        if (frame.type === 'result' && frame.modelUsage !== undefined) {
          const model = entry.meta?.model ?? Object.keys(frame.modelUsage)[0]
          const info = frame.modelUsage[model]
          if (model !== undefined && info?.contextWindow > 0 && modelCapacity.get(model) !== info.contextWindow) {
            modelCapacity.set(model, info.contextWindow)
            config.onCapacity?.(model, info.contextWindow)
          }
        }
        const turn = entry.current
        // An interrupt's trailing frames belong to the aborted turn, even if
        // the user already started the next one on the same child.
        if (entry.draining) {
          if (frame.type === 'result') {
            entry.draining = false
            if (turn !== undefined && turn.cancelled) settleTurn(entry, { status: 'cancelled' })
          }
          return
        }
        if (turn === undefined) return
        if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
          for (const block of frame.message?.content ?? []) if (block.type === 'tool_use') onToolUse(entry, block, Date.now())
        }
        if (frame.type === 'user' && !frame.parent_tool_use_id) {
          const content = frame.message?.content
          // Command replays (/goal) arrive as string content; they still consume the written message.
          const hasText = typeof content === 'string' ? content.trim() !== '' : Array.isArray(content) && content.some(block => block.type === 'text' || block.type === 'image')
          if (frame.isMeta !== true && hasText) turn.queued.shift()
          if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_result') onToolResult(entry, block, Date.now())
        }
        turn.live.onFrame(frame)
        // Local slash commands (/compact) settle through a stdout record; the CLI sends no result frame for them.
        if (frame.type === 'user' && !frame.parent_tool_use_id && localCommandOf(frame) !== undefined) {
          turn.sink.emit({ id: randomUUID(), type: 'turn', ts: Date.now(), phase: 'end', reason: 'compact' })
          settleTurn(entry, { status: 'done', usage: { ...turn.usage } })
          return
        }
        if (frame.type === 'result') {
          const frameUsage = frame.usage ?? {}
          turn.usage.inputTokens += frameUsage.input_tokens ?? 0
          turn.usage.outputTokens += frameUsage.output_tokens ?? 0
          turn.usage.costUsd += frame.total_cost_usd ?? 0
          turn.usage.durationMs += frame.duration_ms ?? 0
          if (frame.is_error === true || turn.queued.length === 0) {
            settleTurn(entry, {
              status: frame.is_error === true ? 'error' : 'done',
              error: frame.is_error === true ? String(frame.result ?? frame.subtype ?? 'error') : undefined,
              usage: { ...turn.usage },
            })
          }
        }
      },
      onExit: ({ code, signal }) => {
        dropEntry(entry)
        const turn = entry.current
        if (turn === undefined || turn.settled) return
        if (turn.live.result !== undefined && turn.queued.length === 0) {
          settleTurn(entry, { status: 'done', usage: { ...turn.usage } })
          return
        }
        const stderr = entry.child.stderr().trim()
        settleTurn(entry, { status: 'error', error: stderr !== '' ? stderr.slice(-2000) : `claude exited with ${signal ?? code} before completing the turn` })
      },
      onError: error => settleTurn(entry, { status: 'error', error: messageOf(error) }),
    })
    if (entry.child.pid !== undefined) ownPids.add(entry.child.pid)
    return entry
  }

  function writeUser(entry, sessionId, message) {
    const content = message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]
    for (const image of message.images ?? []) {
      const stored = readUpload(image.id)
      content.push({ type: 'image', source: { type: 'base64', media_type: stored.mediaType, data: stored.bytes.toString('base64') } })
    }
    entry.current.queued.push(content)
    entry.child.write(`${JSON.stringify({ type: 'user', session_id: sessionId ?? '', message: { role: 'user', content }, parent_tool_use_id: null })}\n`)
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    permissionModes: PERMISSION_MODES,
    // Proven against the CLI: /goal and /compact parse from stream-json input; /plan reports unavailable in print mode.
    commands: ['goal', 'compact'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],

    async detect() {
      const command = resolveCommand(commandName)
      if (command === undefined) return { available: false, command: commandName, error: `"${commandName}" was not found on PATH` }
      try {
        const version = await capture(command, ['--version'])
        return { available: true, command, version }
      } catch (error) {
        return { available: false, command, error: messageOf(error) }
      }
    },

    async listSessions() {
      const live = liveSessions()
      const summaries = []
      for (const file of transcriptFiles()) {
        try {
          const info = live.get(file.id)
          const summary = summarizeFile(file, info === undefined ? undefined : { live: { ...info, status: info.status, waitingFor: info.waitingFor, entrypoint: info.entrypoint, kind: info.kind } })
          if (summary.messageCount === 0 && summary.title === '') continue
          summaries.push(summary)
        } catch {
          // An unreadable transcript is skipped; the rest of the list still loads.
        }
      }
      return summaries
    },

    listModels: probeModels,

    async readTranscript(id) {
      const path = findPath(id)
      const live = liveSessions().get(id)
      const summary = summarizeFile({ path, id }, live === undefined ? undefined : { live })
      const { records, hasEarlier } = tailRecords(path, MAX_TRANSCRIPT_BYTES)
      return { session: { ...summary, hasEarlier }, events: parseClaudeRecords(records), tasks: tasksOf(id), usage: claudeUsageOf(records, configuredWindow ?? modelCapacity.get(summary.model)) }
    },

    tasks(id) {
      return tasksOf(id)
    },

    taskOutput(id, taskId) {
      const task = tasksOf(id).find(entry => entry.id === taskId)
      if (task === undefined) throw new Error(`claude: unknown task ${taskId}`)
      if (!task.outputFile || !existsSync(task.outputFile)) return { text: '', size: 0, hasEarlier: false, status: task.status }
      const { text, size, hasEarlier } = tailText(task.outputFile, MAX_TASK_OUTPUT_BYTES)
      return { text, size, hasEarlier, status: task.status }
    },

    stopTask(id, taskId) {
      const entry = entryFor(id)
      if (entry === undefined) { const error = new Error('claude: session has no live child'); error.code = 'not-live'; throw error }
      const task = findTask(entry, taskId, taskId)
      const cliId = task?.taskId ?? (task?.id !== task?.toolUseId ? task?.id : undefined)
      if (cliId === undefined) { const error = new Error(`claude: task ${taskId} has no CLI id yet`); error.code = 'not-ready'; throw error }
      return new Promise(resolve => {
        const requestId = `dsh-stop-${randomUUID()}`
        const timer = setTimeout(() => { entry.stops.delete(requestId); resolve('stop timed out') }, 10_000)
        timer.unref?.()
        entry.stops.set(requestId, error => { clearTimeout(timer); resolve(error) })
        entry.child.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: cliId } })}\n`)
      })
    },

    async startTurn(request, sink) {
      const command = resolveCommand(commandName)
      if (command === undefined) throw new Error(`claude: "${commandName}" was not found on PATH`)
      if (!existsSync(request.cwd)) throw new Error(`claude: working directory does not exist: ${request.cwd}`)
      if (request.sessionId !== undefined) {
        const live = liveSessions().get(request.sessionId)
        if (live !== undefined) throw new Error(`claude: session is open in another Claude process (pid ${live.pid}); close it there before continuing here`)
        findPath(request.sessionId)
      }
      const key = optionKey(request.options)
      let entry = entryFor(request.sessionId)
      if (entry !== undefined && entry.key !== key) {
        entry.child.endInput()
        entry.child.kill()
        dropEntry(entry)
        entry = undefined
      }
      const turnKey = randomUUID().slice(0, 8)
      const turn = {
        sink,
        live: new ClaudeLive(sink, { turnKey }),
        approvals: new Map(),
        questions: new Map(),
        // Messages written but not yet replayed by the CLI: a result arriving
        // while one is still queued means the CLI will run it as another turn.
        queued: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
        settled: false,
        killTimer: undefined,
      }
      if (entry === undefined) {
        const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']
        if (request.sessionId !== undefined) args.push(`--resume=${request.sessionId}`)
        const mode = request.options?.permissionMode
        if (mode) {
          args.push('--permission-mode', mode)
          if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
        }
        if (request.options?.model) args.push('--model', request.options.model)
        if (request.options?.effort) args.push('--effort', request.options.effort)
        entry = spawnEntry(request, command, args, key)
        if (request.sessionId === undefined) pendingEntry = entry
        else children.set(request.sessionId, entry)
        entry.current = turn
        // Declaring the affordance makes interrupt spare background tasks; each task gets its own stop_task control.
        entry.child.write(`${JSON.stringify({ type: 'control_request', request_id: `dsh-init-${turnKey}`, request: { subtype: 'initialize', hooks: {}, capabilities: { perTaskStopAffordance: true } } })}\n`)
      } else {
        clearTimeout(entry.idleTimer)
        entry.current = turn
        if (entry.meta !== undefined) sink.emit({ id: `${turnKey}:meta`, type: 'meta', ts: Date.now(), ...entry.meta })
      }
      turn.live.start(request.text, request.images)
      writeUser(entry, request.sessionId, request)

      return {
        steer: message => {
          if (turn.settled) { const error = new Error('claude: turn is not running'); error.code = 'not-live'; throw error }
          turn.live.steer(message.text, message.images)
          writeUser(entry, entry.sessionId, message)
        },
        cancel: () => {
          if (turn.settled) return
          turn.cancelled = true
          entry.draining = true
          entry.child.write(`${JSON.stringify({ type: 'control_request', request_id: `dsh-interrupt-${turnKey}`, request: { subtype: 'interrupt', spare_background_tasks: true } })}\n`)
          turn.killTimer ??= setTimeout(() => entry.child.kill(), 5_000)
          turn.killTimer.unref?.()
        },
        answer: (requestId, decision) => {
          const pending = turn.approvals.get(requestId)
          if (pending === undefined) return
          turn.approvals.delete(requestId)
          if (decision === 'deny') entry.respond(requestId, { behavior: 'deny', message: 'The user denied this tool use.' })
          else if (decision === 'allow_session') entry.respond(requestId, { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions })
          else entry.respond(requestId, { behavior: 'allow', updatedInput: pending.input })
        },
        answerQuestion: (requestId, answers) => {
          const input = turn.questions.get(requestId)
          if (input === undefined) return
          turn.questions.delete(requestId)
          const map = {}
          for (const [i, q] of (input.questions ?? []).entries()) {
            const list = answers[i] ?? []
            map[q.question] = q.multiSelect === true ? list : (list[0] ?? '')
          }
          entry.respond(requestId, { behavior: 'allow', updatedInput: { ...input, answers: map } })
        },
        dispose: () => {
          clearTimeout(turn.killTimer)
          if (entry.current === turn) {
            if (!turn.settled) settleTurn(entry, { status: 'cancelled' })
            else entry.current = undefined
          }
        },
      }
    },

    dispose() {
      for (const entry of [...children.values(), ...(pendingEntry === undefined ? [] : [pendingEntry])]) {
        entry.child.endInput()
        entry.child.kill()
        dropEntry(entry)
      }
      children.clear()
      pendingEntry = undefined
    },
  }
}
