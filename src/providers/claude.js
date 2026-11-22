import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capture, parseJsonLine, resolveCommand, spawnLines } from './cli.js'
import { headTail, tailRecords } from './files.js'
import { ClaudeLive, parseClaudeRecords, summarizeClaude } from './claude-format.js'
import { messageOf } from '../remote.js'
import { readUpload } from '../uploads.js'

const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'manual', 'bypassPermissions']
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024

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
  const pathIndex = new Map()
  const ownPids = new Set()

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

  return {
    id: 'claude',
    label: 'Claude Code',
    permissionModes: PERMISSION_MODES,
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
      return { session: { ...summary, hasEarlier }, events: parseClaudeRecords(records) }
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
      const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']
      if (request.sessionId !== undefined) args.push(`--resume=${request.sessionId}`)
      const mode = request.options?.permissionMode
      if (mode) {
        args.push('--permission-mode', mode)
        if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
      }
      if (request.options?.model) args.push('--model', request.options.model)
      if (request.options?.effort) args.push('--effort', request.options.effort)

      const turnKey = randomUUID().slice(0, 8)
      const live = new ClaudeLive(sink, { turnKey })
      live.start(request.text, request.images)
      const approvals = new Map()
      // Messages written but not yet replayed by the CLI: a result arriving
      // while one is still queued means the CLI will run it as another turn.
      const queued = []
      const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }
      let settled = false
      let child
      const finish = result => {
        if (settled) return
        settled = true
        sink.finish(result)
      }
      const respond = (requestId, response) => {
        child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`)
      }
      const onControlRequest = frame => {
        const req = frame.request ?? {}
        if (req.subtype === 'can_use_tool') {
          const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []
          approvals.set(frame.request_id, { input: req.input, suggestions })
          sink.emit({
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
        child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: `dsh does not host ${req.subtype}` } })}\n`)
      }

      child = spawnLines({
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
          if (frame.type === 'control_response') return
          if (frame.type === 'user' && !frame.parent_tool_use_id && frame.isMeta !== true) {
            const content = frame.message?.content
            if (Array.isArray(content) && content.some(block => block.type === 'text' || block.type === 'image')) queued.shift()
          }
          live.onFrame(frame)
          if (frame.type === 'result') {
            const frameUsage = frame.usage ?? {}
            usage.inputTokens += frameUsage.input_tokens ?? 0
            usage.outputTokens += frameUsage.output_tokens ?? 0
            usage.costUsd += frame.total_cost_usd ?? 0
            usage.durationMs += frame.duration_ms ?? 0
            if (frame.is_error === true || queued.length === 0) {
              finish({
                status: frame.is_error === true ? 'error' : 'done',
                error: frame.is_error === true ? String(frame.result ?? frame.subtype ?? 'error') : undefined,
                usage: { ...usage },
              })
              child.endInput()
              const exitTimer = setTimeout(() => child.kill(), 5_000)
              exitTimer.unref?.()
            }
          }
        },
        onExit: ({ code, signal }) => {
          ownPids.delete(child.pid)
          if (settled) return
          const stderr = child.stderr().trim()
          if (live.result !== undefined && queued.length === 0) return
          finish({ status: 'error', error: stderr !== '' ? stderr.slice(-2000) : `claude exited with ${signal ?? code} before completing the turn` })
        },
        onError: error => finish({ status: 'error', error: messageOf(error) }),
      })
      if (child.pid !== undefined) ownPids.add(child.pid)
      child.write(`${JSON.stringify({ type: 'control_request', request_id: `dsh-init-${turnKey}`, request: { subtype: 'initialize', hooks: {} } })}\n`)
      const writeUser = message => {
        const content = message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]
        for (const image of message.images ?? []) {
          const stored = readUpload(image.id)
          content.push({ type: 'image', source: { type: 'base64', media_type: stored.mediaType, data: stored.bytes.toString('base64') } })
        }
        queued.push(content)
        child.write(`${JSON.stringify({ type: 'user', session_id: request.sessionId ?? '', message: { role: 'user', content }, parent_tool_use_id: null })}\n`)
      }
      writeUser(request)

      let killTimer
      return {
        steer: message => {
          if (settled) { const error = new Error('claude: turn is not running'); error.code = 'not-live'; throw error }
          live.steer(message.text, message.images)
          writeUser(message)
        },
        cancel: () => {
          if (settled) return
          child.write(`${JSON.stringify({ type: 'control_request', request_id: `dsh-interrupt-${turnKey}`, request: { subtype: 'interrupt' } })}\n`)
          killTimer ??= setTimeout(() => child.kill(), 2_000)
          killTimer.unref?.()
        },
        answer: (requestId, decision) => {
          const pending = approvals.get(requestId)
          if (pending === undefined) return
          approvals.delete(requestId)
          if (decision === 'deny') respond(requestId, { behavior: 'deny', message: 'The user denied this tool use.' })
          else if (decision === 'allow_session') respond(requestId, { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions })
          else respond(requestId, { behavior: 'allow', updatedInput: pending.input })
        },
        dispose: () => {
          if (killTimer !== undefined) clearTimeout(killTimer)
          child.kill()
        },
      }
    },
  }
}
