import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capture, resolveCommand } from './cli.js'
import { JsonRpcClient } from './jsonrpc.js'
import { codexItemToEvent, codexThreadSummary } from './codex-format.js'
import { messageOf } from '../remote.js'

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
 * the same way. No instructions, config or personality overrides are sent.
 * @param {{ command: string, home: string }} config
 * @returns {import('../registry.js').AgentCliProvider}
 */
export function createCodexProvider(config) {
  const commandName = config.command || 'codex'
  const home = config.home ? expandHome(config.home) : undefined
  let client
  let starting
  const routers = new Map()
  const processItems = new Map()

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
      rpc.onRequest('item/tool/requestUserInput', async () => ({ answers: {} }))
      rpc.onRequest('mcpServer/elicitation/request', async () => ({ action: 'decline', content: null, _meta: null }))
      rpc.onExit(reason => {
        for (const router of routers.values()) router.fail(reason)
        routers.clear()
        processItems.clear()
        if (client === rpc) client = undefined
      })
      try {
        await rpc.request('initialize', { clientInfo: { name: 'dsh-agents', title: 'dsh agents', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } })
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

  return {
    id: 'codex',
    label: 'Codex',
    permissionModes: PERMISSION_MODES,

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
      return threads.filter(thread => thread.parentThreadId === null || thread.parentThreadId === undefined).map(codexThreadSummary)
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
      return { session: codexThreadSummary(thread), events }
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
      sink.setSession(threadId)
      const turnKey = randomUUID().slice(0, 8)
      sink.emit({ id: `${turnKey}:meta`, type: 'meta', ts: Date.now(), model: thread.model ?? undefined, cwd: thread.cwd })

      const items = new Map()
      const approvals = new Map()
      let turnId
      let usage
      let settled = false
      const emit = item => sink.emit(item)
      const put = (item, done, ts) => {
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
              const last = params.tokenUsage?.last ?? params.tokenUsage?.total
              if (last) usage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens }
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
      try {
        const response = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: request.text, text_elements: [] }], clientUserMessageId: `${turnKey}:user`, effort: request.options?.effort || null }, { timeoutMs: 60_000 })
        turnId = response.turn?.id
      } catch (error) {
        finish({ status: 'error', error: messageOf(error) })
        throw error
      }
      return {
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
        dispose: () => {
          finish({ status: 'cancelled' })
        },
      }
    },

    dispose() {
      for (const router of routers.values()) router.fail('codex: provider unloaded')
      routers.clear()
      client?.close()
      client = undefined
    },
  }
}
