import { spawnLines, parseJsonLine } from './cli.js'

/**
 * Newline-delimited JSON-RPC 2.0 client over a child process's stdio, with
 * server-initiated requests (Codex app-server asks the client for approvals).
 */
export class JsonRpcClient {
  #nextId = 1
  #pending = new Map()
  #notificationHandlers = new Set()
  #requestHandlers = new Map()
  #closed = false
  #exitHandlers = new Set()

  constructor({ command, args, cwd, env, requestTimeoutMs = 30_000 }) {
    this.requestTimeoutMs = requestTimeoutMs
    this.child = spawnLines({
      command,
      args,
      cwd,
      env,
      onLine: line => this.#handleLine(line),
      onExit: info => this.#handleExit(info),
      onError: error => this.#handleExit({ code: null, signal: null, error }),
    })
  }

  get closed() {
    return this.#closed
  }

  onNotification(handler) {
    this.#notificationHandlers.add(handler)
    return () => { this.#notificationHandlers.delete(handler) }
  }

  onRequest(method, handler) {
    this.#requestHandlers.set(method, handler)
    return () => { this.#requestHandlers.delete(method) }
  }

  onExit(handler) {
    this.#exitHandlers.add(handler)
    return () => { this.#exitHandlers.delete(handler) }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.#closed) return Promise.reject(new Error('codex: app-server is not running'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`codex: ${method} timed out`))
      }, timeoutMs) : undefined
      timer?.unref?.()
      this.#pending.set(id, { resolve, reject, timer, method })
      this.child.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method, params) {
    if (this.#closed) return
    this.child.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  stderr() {
    return this.child.stderr()
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.child.endInput()
    this.child.kill()
    this.#handleExit({ code: null, signal: 'SIGTERM' })
  }

  #respond(id, result, error) {
    const frame = error === undefined
      ? { jsonrpc: '2.0', id, result }
      : { jsonrpc: '2.0', id, error: { code: -32603, message: error } }
    this.child.write(`${JSON.stringify(frame)}\n`)
  }

  #handleLine(line) {
    const frame = parseJsonLine(line)
    if (frame === undefined) return
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.#pending.get(frame.id)
      if (pending === undefined) return
      this.#pending.delete(frame.id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (frame.error) pending.reject(new Error(`${pending.method}: ${frame.error.message ?? JSON.stringify(frame.error)} (code ${frame.error.code})`))
      else pending.resolve(frame.result)
      return
    }
    if (frame.method !== undefined && frame.id !== undefined) {
      const handler = this.#requestHandlers.get(frame.method)
      if (handler === undefined) {
        this.#respond(frame.id, undefined, `dsh does not handle ${frame.method}`)
        return
      }
      Promise.resolve()
        .then(() => handler(frame.params ?? {}))
        .then(result => this.#respond(frame.id, result ?? {}), error => this.#respond(frame.id, undefined, error instanceof Error ? error.message : String(error)))
      return
    }
    if (frame.method !== undefined) {
      for (const handler of this.#notificationHandlers) {
        try {
          handler(frame.method, frame.params ?? {})
        } catch (error) {
          console.warn(`[dsh-agents] notification handler failed for ${frame.method}:`, error)
        }
      }
    }
  }

  #handleExit(info) {
    const wasClosed = this.#closed
    this.#closed = true
    const reason = info.error?.message ?? (this.child.stderr().trim().slice(-800) || `codex app-server exited (${info.signal ?? info.code})`)
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.#pending.clear()
    if (!wasClosed) for (const handler of this.#exitHandlers) handler(reason)
  }
}
