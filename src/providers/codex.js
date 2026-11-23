import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capture, resolveCommand } from './cli.js'
import { tailText } from './files.js'
import { JsonRpcClient } from './jsonrpc.js'
import { codexItemToEvent, codexThreadSummary } from './codex-format.js'
import { messageOf } from '../remote.js'
import { readUpload } from '../uploads.js'

const PERMISSION_MODES = ['untrusted', 'on-request', 'never']
const LIST_PAGE = 200
const LIST_MAX_PAGES = 10
const ITEMS_PAGE = 500
const ITEMS_MAX_PAGES = 8
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer']

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function launchParams(options) {
  const params = {}
  if (options?.permissionMode) params.approvalPolicy = options.permissionMode
  if (options?.model) params.model = options.model
  return params
}

/**
 * Codex provider over one shared `codex app-server` (JSON-RPC stdio). Threads
 * are listed/read through the server's own API and turns run through
 * thread/resume + turn/start, so both legacy and paginated histories render
 * the same way. No instructions, config or personality overrides are sent;
 * turns request reasoning summaries so the thinking row can render.
 * @param {{ command: string, home: string }} config
 * @returns {import('../registry.js').AgentCliProvider}
 */
export function createCodexProvider(config) {
  const commandName = config.command || 'codex'
  const home = config.home ? expandHome(config.home) : undefined
  let client
  let starting
  const routers = new Map()
  const threadUsage = new Map()
  const processItems = new Map()
  const ownThreads = new Set()

  // Reopened threads have no live token report; the rollout's last token_count carries the same buckets.
  function diskUsage(id) {
    const root = join(home ?? join(homedir(), '.codex'), 'sessions')
    if (!existsSync(root)) return undefined
    let file
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) {
        file = join(entry.parentPath ?? entry.path, entry.name)
        break
      }
    }
    if (file === undefined) return undefined
    let info
    for (const line of tailText(file, 256 * 1024).text.split('\n')) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      const payload = record.type === 'event_msg' ? record.payload : record
      if (payload?.type === 'token_count' && payload.info !== undefined) info = payload.info
    }
    const total = info?.total_token_usage
    if (total === undefined) return undefined
    return {
      inputTokens: Math.max(0, (total.input_tokens ?? 0) - (total.cached_input_tokens ?? 0)),
      outputTokens: total.output_tokens ?? 0,
      cacheReadTokens: total.cached_input_tokens ?? 0,
      cacheWriteTokens: total.cache_write_input_tokens ?? 0,
      contextTokens: info.last_token_usage?.total_tokens ?? 0,
      capacity: info.model_context_window ?? null,
    }
  }

  // The app-server reports threads it holds loaded as active; for threads this
  // plugin drove that is our own turn, not another process holding the session.
  function summary(thread) {
    const row = codexThreadSummary(thread)
    return ownThreads.has(thread.id) ? { ...row, live: undefined } : row
  }

  function route(threadId) {
    return routers.get(threadId)
  }

  function onNotification(method, params) {
    const router = route(params.threadId)
    if (method === 'item/commandExecution/outputDelta') {
      const target = processItems.get(params.processId)
      if (target === undefined) return
      const owner = route(target.threadId)
      if (owner === undefined) return
      const text = Buffer.from(params.deltaBase64 ?? '', 'base64').toString('utf8')
      owner.appendOutput(target.itemId, text)
      return
    }
    if (router === undefined) return
    router.onNotification(method, params)
  }

  async function ensure() {
    if (client !== undefined && !client.closed) return client
    if (starting !== undefined) return starting
    const command = resolveCommand(commandName)
    if (command === undefined) throw new Error(`codex: "${commandName}" was not found on PATH`)
    starting = (async () => {
      const rpc = new JsonRpcClient({
        command,
        args: ['app-server', '--listen', 'stdio://'],
        cwd: homedir(),
        env: home === undefined ? {} : { CODEX_HOME: home },
      })
      rpc.onNotification(onNotification)
      rpc.onRequest('item/commandExecution/requestApproval', params => askApproval(params, 'command'))
      rpc.onRequest('item/fileChange/requestApproval', params => askApproval(params, 'file'))
      rpc.onRequest('item/permissions/requestApproval', async () => ({ permissions: {}, scope: 'turn' }))
      rpc.onRequest('item/tool/requestUserInput', params => askQuestion(params))
      rpc.onRequest('mcpServer/elicitation/request', async () => ({ action: 'decline', content: null, _meta: null }))
      rpc.onExit(reason => {
        for (const router of routers.values()) router.fail(reason)
        routers.clear()
        processItems.clear()
        if (client === rpc) client = undefined
      })
      try {
        await rpc.request('initialize', { clientInfo: { name: 'dsh-agents', title: 'dsh agents', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
        rpc.notify('initialized')
      } catch (error) {
        rpc.close()
        throw error
      }
      client = rpc
      return rpc
    })()
    try {
      return await starting
    } finally {
      starting = undefined
    }
  }

  function askApproval(params, kind) {
    const router = route(params.threadId)
    if (router === undefined) return Promise.resolve({ decision: 'cancel' })
    return router.askApproval(params, kind)
  }

  function askQuestion(params) {
    const router = route(params.threadId)
    if (router === undefined) return Promise.resolve({ answers: {} })
    return router.askQuestion(params)
  }

  async function listAllThreads(rpc) {
    const threads = []
    let cursor
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const response = await rpc.request('thread/list', { limit: LIST_PAGE, sortKey: 'recency_at', sortDirection: 'desc', sourceKinds: SOURCE_KINDS, archived: false, ...(cursor === undefined ? {} : { cursor }) })
      threads.push(...(response.data ?? []))
      if (!response.nextCursor) break
      cursor = response.nextCursor
    }
    return threads
  }

  async function readItems(rpc, threadId) {
    const items = []
    let cursor
    try {
      for (let page = 0; page < ITEMS_MAX_PAGES; page++) {
        const response = await rpc.request('thread/turns/list', { threadId, itemsView: 'full', limit: ITEMS_PAGE, sortDirection: 'asc', ...(cursor === undefined ? {} : { cursor }) })
        for (const turn of response.data ?? []) items.push(...(turn.items ?? []))
        if (!response.nextCursor) break
        cursor = response.nextCursor
      }
      return items
    } catch (error) {
      if (!/not supported|unknown method|-32601/i.test(messageOf(error))) throw error
      const { thread } = await rpc.request('thread/read', { threadId, includeTurns: true })
      return (thread.turns ?? []).flatMap(turn => turn.items ?? [])
    }
  }

  function usageFromReport(report) {
    const last = report?.last ?? report?.total
    return {
      inputTokens: Math.max(0, (report?.total?.inputTokens ?? 0) - (report?.total?.cachedInputTokens ?? 0)),
      outputTokens: report?.total?.outputTokens ?? 0,
      cacheReadTokens: report?.total?.cachedInputTokens ?? 0,
      cacheWriteTokens: report?.total?.cacheWriteInputTokens ?? 0,
      contextTokens: last?.totalTokens ?? 0,
      capacity: report?.modelContextWindow ?? null,
    }
  }

  async function ensureLoaded(rpc, threadId) {
    if (ownThreads.has(threadId)) return
    // No overrides: a command must not change the thread's model or approval policy.
    await rpc.request('thread/resume', { threadId, excludeTurns: true }, { timeoutMs: 60_000 })
    ownThreads.add(threadId)
  }

  // Compaction and goal-set run as server-side turns; track them like a turn but
  // without approvals or steering, which neither command accepts.
  async function commandTurn(threadId, sink, start) {
    const rpc = await ensure()
    // Turns unsubscribe on finish; compact/goal turns do not re-subscribe by themselves.
    await rpc.request('thread/resume', { threadId, excludeTurns: true }, { timeoutMs: 60_000 })
    ownThreads.add(threadId)
    sink.setSession(threadId)
    const turnKey = randomUUID().slice(0, 8)
    sink.emit({ id: `${turnKey}:meta`, type: 'meta', ts: Date.now() })
    const items = new Map()
    let turnId
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      routers.delete(threadId)
      sink.finish(result)
      void rpc.request('thread/unsubscribe', { threadId }).catch(() => {})
    }
    routers.set(threadId, {
      askApproval: async () => ({ decision: 'cancel' }),
      askQuestion: async () => ({ answers: {} }),
      appendOutput: () => {},
      fail: reason => finish({ status: 'error', error: reason }),
      onNotification(method, params) {
        if (params.threadId !== threadId) return
        switch (method) {
          case 'item/started':
          case 'item/completed': {
            const event = codexItemToEvent(params.item, Date.now(), method === 'item/completed')
            if (event === undefined) return
            const previous = items.get(event.id)
            const merged = previous === undefined ? event : { ...previous, ...event }
            items.set(event.id, merged)
            sink.emit(merged)
            return
          }
          case 'thread/tokenUsage/updated':
            threadUsage.set(threadId, usageFromReport(params.tokenUsage))
            return
          case 'turn/completed': {
            const status = params.turn?.status === 'completed' ? 'done' : params.turn?.status === 'interrupted' ? 'cancelled' : 'error'
            finish({ status, error: status === 'error' ? params.turn?.error?.message ?? 'turn failed' : undefined })
            return
          }
          case 'error':
            if (params.willRetry === false) finish({ status: 'error', error: params.error?.message ?? 'error' })
            return
          default:
            return
        }
      },
    })
    try {
      const response = await start(rpc)
      turnId = response?.turn?.id
    } catch (error) {
      finish({ status: 'error', error: messageOf(error) })
      throw error
    }
    return {
      cancel: () => {
        if (!settled && turnId !== undefined) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      },
      answer: () => {},
      dispose: () => finish({ status: 'cancelled' }),
    }
  }

  return {
    id: 'codex',
    label: 'Codex',
    permissionModes: PERMISSION_MODES,
    commands: ['goal', 'compact'],

    async detect() {
      const command = resolveCommand(commandName)
      if (command === undefined) return { available: false, command: commandName, error: `"${commandName}" was not found on PATH` }
      try {
        const version = await capture(command, ['--version'])
        let authenticated
        try {
          const rpc = await ensure()
          const account = await rpc.request('account/read', {})
          authenticated = account.account !== null && account.account !== undefined
        } catch {
          authenticated = undefined
        }
        return { available: true, command, version, authenticated }
      } catch (error) {
        return { available: false, command, error: messageOf(error) }
      }
    },

    async listModels() {
      const rpc = await ensure()
      const response = await rpc.request('model/list', { limit: 100 })
      return (response.data ?? []).filter(m => m.hidden !== true).map(m => ({
        id: m.model ?? m.id,
        label: m.displayName ?? m.model ?? m.id,
        description: m.description ?? undefined,
        efforts: (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort ?? undefined,
      }))
    },

    async listSessions() {
      const rpc = await ensure()
      const threads = await listAllThreads(rpc)
      return threads.filter(thread => thread.parentThreadId === null || thread.parentThreadId === undefined).map(summary)
    },

    async readTranscript(id) {
      const rpc = await ensure()
      const { thread } = await rpc.request('thread/read', { threadId: id })
      const entries = await readItems(rpc, id)
      const base = (thread.createdAt ?? 0) * 1000
      const events = []
      for (const item of entries) {
        const event = codexItemToEvent(item, base, true)
        if (event !== undefined) events.push(event)
      }
      const counted = threadUsage.get(id) ?? diskUsage(id)
      const usage = counted === undefined ? null : { ...counted, turns: entries.filter(item => item.type === 'userMessage').length, steps: entries.filter(item => item.type === 'agentMessage').length }
      return { session: summary(thread), events, usage }
    },

    async startTurn(request, sink) {
      const rpc = await ensure()
      if (!existsSync(request.cwd)) throw new Error(`codex: working directory does not exist: ${request.cwd}`)
      const overrides = launchParams(request.options)
      let thread
      if (request.sessionId !== undefined) {
        const response = await rpc.request('thread/resume', { threadId: request.sessionId, excludeTurns: true, ...overrides }, { timeoutMs: 60_000 })
        thread = response.thread
      } else {
        const response = await rpc.request('thread/start', { cwd: request.cwd, ...overrides }, { timeoutMs: 60_000 })
        thread = response.thread
      }
      const threadId = thread.id
      ownThreads.add(threadId)
      sink.setSession(threadId)
      const turnKey = randomUUID().slice(0, 8)
      sink.emit({ id: `${turnKey}:meta`, type: 'meta', ts: Date.now(), model: thread.model ?? undefined, cwd: thread.cwd })
      sink.emit({ id: `${turnKey}:user`, type: 'user', ts: Date.now(), text: request.text, ...(request.images?.length ? { images: request.images } : {}) })

      const items = new Map()
      const approvals = new Map()
      const questions = new Map()
      let turnId
      let usage
      let settled = false
      const emit = item => sink.emit(item)
      const put = (item, done, ts) => {
        // The turn's own user echo carries the pasted images; the server's
        // userMessage item would duplicate it without them.
        if (item.type === 'userMessage') return
        const event = codexItemToEvent(item, ts, done)
        if (event === undefined) return
        const previous = items.get(event.id)
        const merged = previous === undefined ? event : { ...previous, ...event }
        items.set(event.id, merged)
        if (item.type === 'commandExecution' && item.processId) processItems.set(item.processId, { threadId, itemId: event.id })
        emit(merged)
      }
      const finish = result => {
        if (settled) return
        settled = true
        for (const pending of approvals.values()) pending.resolve({ decision: 'cancel' })
        approvals.clear()
        for (const pending of questions.values()) pending.resolve({ answers: {} })
        questions.clear()
        routers.delete(threadId)
        sink.finish(result)
        void rpc.request('thread/unsubscribe', { threadId }).catch(() => {})
      }
      const router = {
        askApproval(params, kind) {
          const requestId = randomUUID()
          return new Promise(resolve => {
            approvals.set(requestId, { resolve })
            emit({
              id: `approval:${requestId}`,
              type: 'approval',
              ts: Date.now(),
              requestId,
              name: kind === 'command' ? 'Bash' : 'Edit',
              input: kind === 'command' ? { command: params.command, cwd: params.cwd } : { grantRoot: params.grantRoot },
              message: params.reason ?? undefined,
              options: ['allow', 'allow_session', 'deny'],
              status: 'running',
            })
          })
        },
        askQuestion(params) {
          const requestId = randomUUID()
          return new Promise(resolve => {
            questions.set(requestId, { resolve, params })
            emit({
              id: `question:${requestId}`,
              type: 'question',
              ts: Date.now(),
              requestId,
              questions: (params.questions ?? []).map(q => ({
                key: q.id,
                question: q.question,
                header: q.header,
                multiSelect: false,
                options: q.options ?? [],
              })),
              status: 'running',
            })
          })
        },
        appendOutput(itemId, text) {
          const previous = items.get(itemId)
          if (previous === undefined) return
          const merged = { ...previous, output: (previous.output ?? '') + text }
          items.set(itemId, merged)
          emit(merged)
        },
        fail(reason) {
          finish({ status: 'error', error: reason })
        },
        onNotification(method, params) {
          const ts = params.startedAtMs ?? params.completedAtMs ?? Date.now()
          switch (method) {
            case 'turn/started':
              turnId ??= params.turn?.id
              return
            case 'item/started':
              put(params.item, false, ts)
              return
            case 'item/completed':
              put(params.item, true, ts)
              return
            case 'item/agentMessage/delta': {
              const previous = items.get(params.itemId) ?? { id: params.itemId, type: 'assistant', ts, text: '', done: false }
              const merged = { ...previous, text: (previous.text ?? '') + (params.delta ?? '') }
              items.set(params.itemId, merged)
              emit(merged)
              return
            }
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta': {
              const previous = items.get(params.itemId) ?? { id: params.itemId, type: 'thinking', ts, text: '', done: false }
              const merged = { ...previous, text: (previous.text ?? '') + (params.delta ?? '') }
              items.set(params.itemId, merged)
              emit(merged)
              return
            }
            case 'turn/completed': {
              const turn = params.turn ?? {}
              const status = turn.status === 'completed' ? 'done' : turn.status === 'interrupted' ? 'cancelled' : 'error'
              finish({ status, error: status === 'error' ? turn.error?.message ?? 'turn failed' : undefined, usage })
              return
            }
            case 'thread/tokenUsage/updated': {
              const report = params.tokenUsage
              const last = report?.last ?? report?.total
              if (last) usage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens }
              if (report !== undefined) threadUsage.set(params.threadId ?? threadId, usageFromReport(report))
              return
            }
            case 'error':
              emit({ id: `${turnKey}:err:${ts}`, type: 'error', ts, message: params.error?.message ?? 'error' })
              if (params.willRetry === false) finish({ status: 'error', error: params.error?.message ?? 'error' })
              return
            case 'thread/status/changed':
              if (params.status?.type === 'systemError') emit({ id: `${turnKey}:syserr`, type: 'error', ts, message: 'Codex reported a system error for this thread (check its login and logs)' })
              return
            default:
              return
          }
        },
      }
      routers.set(threadId, router)
      const userInput = message => {
        const input = message.text.trim() === '' ? [] : [{ type: 'text', text: message.text, text_elements: [] }]
        for (const image of message.images ?? []) input.push({ type: 'localImage', path: readUpload(image.id).path })
        return input
      }
      let steerCount = 0
      try {
        // app-server streams no reasoning summaries unless a turn asks; display-only override.
        const response = await rpc.request('turn/start', { threadId, input: userInput(request), clientUserMessageId: `${turnKey}:user`, effort: request.options?.effort || null, summary: 'auto' }, { timeoutMs: 60_000 })
        turnId = response.turn?.id
      } catch (error) {
        finish({ status: 'error', error: messageOf(error) })
        throw error
      }
      return {
        steer: async message => {
          const notLive = reason => { const error = new Error(reason); error.code = 'not-live'; return error }
          if (settled || turnId === undefined) throw notLive('codex: turn is not running')
          steerCount += 1
          const messageId = `${turnKey}:steer:${steerCount}:user`
          try {
            await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: userInput(message), clientUserMessageId: messageId }, { timeoutMs: 60_000 })
          } catch (error) {
            throw notLive(messageOf(error))
          }
          sink.emit({ id: messageId, type: 'user', ts: Date.now(), text: message.text, ...(message.images?.length ? { images: message.images } : {}) })
        },
        cancel: () => {
          if (settled || turnId === undefined) return
          void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
        },
        answer: (requestId, decision) => {
          const pending = approvals.get(requestId)
          if (pending === undefined) return
          approvals.delete(requestId)
          pending.resolve({ decision: decision === 'deny' ? 'decline' : decision === 'allow_session' ? 'acceptForSession' : 'accept' })
        },
        answerQuestion: (requestId, answers) => {
          const pending = questions.get(requestId)
          if (pending === undefined) return
          questions.delete(requestId)
          pending.resolve({
            answers: Object.fromEntries((pending.params.questions ?? []).map((q, i) => [q.id, { answers: answers[i] ?? [] }])),
          })
        },
        dispose: () => {
          finish({ status: 'cancelled' })
        },
      }
    },

    compact(sessionId, sink) {
      return commandTurn(sessionId, sink, rpc => rpc.request('thread/compact/start', { threadId: sessionId }, { timeoutMs: 60_000 }))
    },

    setGoal(sessionId, objective, sink) {
      return commandTurn(sessionId, sink, rpc => rpc.request('thread/goal/set', { threadId: sessionId, objective, origin: 'user' }, { timeoutMs: 60_000 }))
    },

    async getGoal(sessionId) {
      const rpc = await ensure()
      await ensureLoaded(rpc, sessionId)
      return rpc.request('thread/goal/get', { threadId: sessionId })
    },

    async clearGoal(sessionId) {
      const rpc = await ensure()
      await ensureLoaded(rpc, sessionId)
      return rpc.request('thread/goal/clear', { threadId: sessionId, origin: 'user' })
    },

    dispose() {
      for (const router of routers.values()) router.fail('codex: provider unloaded')
      routers.clear()
      ownThreads.clear()
      client?.close()
      client = undefined
    },
  }
}
