import { randomUUID } from 'node:crypto'
import { messageOf } from './remote.js'

const LIVE_STATES = new Set(['starting', 'running', 'awaiting'])

/**
 * Owns every running CLI turn: normalizes emitted events into a seq-numbered
 * buffer the browser polls, and reaps turns whose browser went away.
 */
export class TurnManager {
  #turns = new Map()
  #timer

  constructor({ retentionMs, abandonTimeoutMs, logger }) {
    this.retentionMs = retentionMs
    this.abandonTimeoutMs = abandonTimeoutMs
    this.logger = logger
    this.#timer = setInterval(() => this.#reap(), Math.min(retentionMs, 10_000))
    this.#timer.unref?.()
  }

  /**
   * @param {import('./registry.js').AgentCliProvider} provider
   * @param {import('./registry.js').TurnRequest} request
   * @returns {Promise<{ turnId: string, sessionId: string | undefined }>}
   */
  async start(provider, request) {
    if (typeof request?.text !== 'string' || request.text.trim() === '') throw new Error('agent-cli: message is empty')
    if (typeof request.cwd !== 'string' || request.cwd === '') throw new Error('agent-cli: a working directory is required')
    for (const turn of this.#turns.values()) {
      if (turn.providerId === provider.id && turn.sessionId !== undefined && turn.sessionId === request.sessionId && LIVE_STATES.has(turn.status)) {
        throw new Error('agent-cli: this session already has a running turn')
      }
    }
    const id = randomUUID()
    const turn = {
      id,
      providerId: provider.id,
      sessionId: request.sessionId,
      status: 'starting',
      events: [],
      seq: 0,
      error: undefined,
      usage: undefined,
      handle: undefined,
      startedAt: Date.now(),
      lastPoll: Date.now(),
      finishedAt: undefined,
    }
    this.#turns.set(id, turn)
    const push = event => {
      turn.seq += 1
      const normalized = { ...event, seq: turn.seq, id: event.id ?? `${id}:${turn.seq}`, ts: event.ts ?? Date.now() }
      turn.events.push(normalized)
      if (normalized.type === 'approval' && normalized.status === 'running') turn.status = 'awaiting'
      else if (turn.status === 'awaiting' && !turn.events.some(e => e.type === 'approval' && e.status === 'running')) turn.status = 'running'
      return normalized
    }
    turn.push = push
    const sink = {
      emit: event => {
        if (!LIVE_STATES.has(turn.status)) return
        push(event)
      },
      setSession: sessionId => { turn.sessionId = sessionId },
      finish: result => {
        if (!LIVE_STATES.has(turn.status)) return
        turn.status = result.status
        turn.error = result.error
        turn.usage = result.usage
        turn.finishedAt = Date.now()
      },
    }
    try {
      turn.handle = await provider.startTurn(request, sink)
      if (LIVE_STATES.has(turn.status)) turn.status = turn.status === 'starting' ? 'running' : turn.status
    } catch (error) {
      sink.finish({ status: 'error', error: messageOf(error) })
      this.logger?.warn(`agent-cli: ${provider.id} turn failed to start: ${messageOf(error)}`)
    }
    return { turnId: id, sessionId: turn.sessionId }
  }

  /**
   * @param {string} turnId
   * @param {number} afterSeq
   */
  poll(turnId, afterSeq) {
    const turn = this.#require(turnId)
    turn.lastPoll = Date.now()
    const after = Number.isFinite(afterSeq) ? afterSeq : 0
    return {
      events: turn.events.filter(event => event.seq > after),
      status: turn.status,
      sessionId: turn.sessionId,
      error: turn.error,
      usage: turn.usage,
      seq: turn.seq,
    }
  }

  cancel(turnId) {
    const turn = this.#require(turnId)
    if (LIVE_STATES.has(turn.status)) {
      turn.handle?.cancel()
      turn.status = 'cancelled'
      turn.finishedAt = Date.now()
    }
    return { ok: true }
  }

  /**
   * @param {string} turnId
   * @param {string} requestId
   * @param {string} decision
   */
  answer(turnId, requestId, decision) {
    const turn = this.#require(turnId)
    const approval = turn.events.find(event => event.type === 'approval' && event.requestId === requestId)
    if (approval === undefined) throw new Error('agent-cli: unknown approval request')
    if (approval.status !== 'running') return { ok: true }
    turn.handle?.answer(requestId, decision)
    approval.status = 'done'
    approval.decision = decision
    turn.push({ ...approval, status: 'done', decision })
    return { ok: true }
  }

  /** Running turns for a session, so a reopened page can reattach. */
  activeFor(providerId, sessionId) {
    return [...this.#turns.values()]
      .filter(turn => turn.providerId === providerId && turn.sessionId === sessionId && LIVE_STATES.has(turn.status))
      .map(turn => ({ turnId: turn.id, seq: turn.seq, startedAt: turn.startedAt }))
  }

  dispose() {
    clearInterval(this.#timer)
    for (const turn of this.#turns.values()) turn.handle?.dispose()
    this.#turns.clear()
  }

  #require(turnId) {
    const turn = this.#turns.get(turnId)
    if (turn === undefined) throw new Error('agent-cli: turn no longer exists')
    return turn
  }

  #reap() {
    const now = Date.now()
    for (const [id, turn] of this.#turns) {
      const idle = now - turn.lastPoll
      if (LIVE_STATES.has(turn.status)) {
        if (idle > this.abandonTimeoutMs) {
          this.logger?.info(`agent-cli: cancelling ${turn.providerId} turn ${id} after ${idle}ms without a reader`)
          turn.handle?.cancel()
          turn.handle?.dispose()
          this.#turns.delete(id)
        }
        continue
      }
      if (idle > this.retentionMs) {
        turn.handle?.dispose()
        this.#turns.delete(id)
      }
    }
  }
}
