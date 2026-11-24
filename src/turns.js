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

  constructor({ retentionMs, logger }) {
    this.retentionMs = retentionMs
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
    const hasImages = Array.isArray(request?.images) && request.images.length > 0
    if (typeof request?.text !== 'string' || (request.text.trim() === '' && !hasImages)) throw new Error('agent-cli: message is empty')
    if (typeof request.cwd !== 'string' || request.cwd === '') throw new Error('agent-cli: a working directory is required')
    return this.#begin(provider, request, (req, sink) => provider.startTurn(req, sink))
  }

  async compact(provider, sessionId) {
    if (typeof provider.compact !== 'function') throw new Error(`agent-cli: ${provider.id} does not support compaction`)
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('agent-cli: a session is required')
    return this.#begin(provider, { sessionId }, (req, sink) => provider.compact(req.sessionId, sink))
  }

  async goalSet(provider, sessionId, objective) {
    if (typeof provider.setGoal !== 'function') throw new Error(`agent-cli: ${provider.id} does not support goals`)
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('agent-cli: a session is required')
    return this.#begin(provider, { sessionId }, (req, sink) => provider.setGoal(req.sessionId, objective, sink))
  }

  async #begin(provider, request, launch) {
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
      // Keyed by event id: streaming partials re-emit the same id with growing
      // text, so keeping every emission would grow a long turn quadratically.
      items: new Map(),
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
      // Same id carries complementary fields across emissions (a tool_use's
      // name/input then its tool_result's output; streaming text grows), so
      // merge rather than replace or a reattach loses the earlier fields.
      const previous = turn.items.get(normalized.id)
      turn.items.set(normalized.id, previous === undefined ? normalized : { ...previous, ...normalized })
      const blocking = e => (e.type === 'approval' || e.type === 'question') && e.status === 'running'
      if (blocking(normalized)) turn.status = 'awaiting'
      else if (turn.status === 'awaiting' && ![...turn.items.values()].some(blocking)) turn.status = 'running'
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
      turn.handle = await launch(request, sink)
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
      events: [...turn.items.values()].filter(event => event.seq > after).sort((a, b) => a.seq - b.seq),
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

  /** Feed a message into the running turn instead of starting a second one. */
  async steer(turnId, request) {
    const turn = this.#turns.get(turnId)
    if (turn === undefined || !LIVE_STATES.has(turn.status) || turn.handle?.steer === undefined) {
      const error = new Error('agent-cli: turn is not running')
      error.code = 'not-live'
      throw error
    }
    const hasImages = Array.isArray(request?.images) && request.images.length > 0
    if (typeof request?.text !== 'string' || (request.text.trim() === '' && !hasImages)) throw new Error('agent-cli: message is empty')
    await turn.handle.steer(request)
    turn.lastPoll = Date.now()
    return { turnId, sessionId: turn.sessionId }
  }

  /**
   * @param {string} turnId
   * @param {string} requestId
   * @param {string} decision
   */
  answer(turnId, requestId, decision) {
    const turn = this.#require(turnId)
    const approval = [...turn.items.values()].find(event => event.type === 'approval' && event.requestId === requestId)
    if (approval === undefined) throw new Error('agent-cli: unknown approval request')
    if (approval.status !== 'running') return { ok: true }
    turn.handle?.answer(requestId, decision)
    approval.status = 'done'
    approval.decision = decision
    turn.push({ ...approval, status: 'done', decision })
    return { ok: true }
  }

  /**
   * @param {string} turnId
   * @param {string} requestId
   * @param {string[][]} answers - selected labels / custom text per question
   */
  answerQuestion(turnId, requestId, answers) {
    const turn = this.#require(turnId)
    const question = [...turn.items.values()].find(event => event.type === 'question' && event.requestId === requestId)
    if (question === undefined) throw new Error('agent-cli: unknown question request')
    if (question.status !== 'running') return { ok: true }
    turn.handle?.answerQuestion?.(requestId, answers)
    question.status = 'done'
    question.answers = answers
    turn.push({ ...question, status: 'done', answers })
    return { ok: true }
  }

  /** Running turns for a session, so a reopened page can reattach. */
  activeFor(providerId, sessionId) {
    return [...this.#turns.values()]
      .filter(turn => turn.providerId === providerId && turn.sessionId === sessionId && LIVE_STATES.has(turn.status))
      .map(turn => ({ turnId: turn.id, seq: turn.seq, startedAt: turn.startedAt }))
  }

  /** Live turns across every session of a provider, for the sidebar status dots. */
  activeByProvider(providerId) {
    return [...this.#turns.values()]
      .filter(turn => turn.providerId === providerId && turn.sessionId !== undefined && LIVE_STATES.has(turn.status))
      .map(turn => ({ sessionId: turn.sessionId, turnId: turn.id, status: turn.status, startedAt: turn.startedAt }))
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
      // A live turn keeps running even when its reader goes away (mobile
      // background / offline); cancelling it here would interrupt the user's
      // work. Only finished turns are cleaned up after the retention window.
      if (LIVE_STATES.has(turn.status)) continue
      if (now - turn.lastPoll > this.retentionMs) {
        turn.handle?.dispose()
        this.#turns.delete(id)
      }
    }
  }
}
