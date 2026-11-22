import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { unwrap } from '../remote.js'

const TURN_POLL_MS = 250
const APPROVAL_POLL_MS = 600
const LIST_REFRESH_MS = 8_000
const MAX_RENDERED_EVENTS = 300

export const SOURCES = ['dsh', 'claude', 'codex']

const VIEW_DEFAULTS = { source: 'dsh', selected: {}, query: '', expanded: {}, showHidden: false, groupBy: 'project', launch: {} }

function emptyBucket() {
  return { list: [], workspaces: [], loaded: false, loading: false, error: null, at: 0 }
}

function transcriptKey(provider, sessionId) {
  return `${provider}:${sessionId}`
}

/**
 * Browser-side owner of the foreign session data: provider status, per-source
 * session lists, the open transcript, and the live turn polled from the host.
 * View state (source, selection, search) lives here too so the switcher, the
 * list and the page read one snapshot.
 */
export class AgentCliController {
  constructor(call) {
    this.call = call
    this.view = createSnapshotStore(structuredClone(VIEW_DEFAULTS), { persist: { name: 'dsh.agents.view.v1' } })
    // Rehydration replaces the state wholesale, so a view persisted by an
    // older version can lack keys added since; fill them before anything reads.
    this.view.update(d => {
      for (const key of Object.keys(VIEW_DEFAULTS)) if (d[key] === undefined) d[key] = structuredClone(VIEW_DEFAULTS[key])
      if (!SOURCES.includes(d.source)) d.source = 'dsh'
    })
    this.providers = createSnapshotStore({ list: [], loaded: false, error: null })
    this.sessions = createSnapshotStore({ byProvider: {} })
    this.models = createSnapshotStore({ byProvider: {} })
    this.chrome = createSnapshotStore({ headerMounted: false, headerFailed: false })
    this.transcript = createSnapshotStore({
      key: null,
      provider: null,
      session: null,
      events: [],
      index: {},
      loading: false,
      error: null,
      turn: null,
      sending: false,
      historyLimit: MAX_RENDERED_EVENTS,
      cwd: null,
      newNonce: 0,
    })
    this.settings = createSnapshotStore({ providers: {}, loaded: false, error: null })
    this.sourceChanged = () => {}
    this.pollTimer = undefined
    this.listTimer = undefined
    this.pollSeq = 0
    this.turnId = undefined
    this.disposed = false
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && this.view.getSnapshot().source !== 'dsh') void this.refreshSessions()
    }
  }

  async init() {
    document.addEventListener('visibilitychange', this.onVisibility)
    await Promise.all([this.loadProviders(), this.loadSettings()])
    const source = this.view.getSnapshot().source
    if (source !== 'dsh') this.setSource(source)
  }

  dispose() {
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.#stopPolling()
    this.#stopListWatcher()
  }

  bucket(provider) {
    return this.sessions.getSnapshot().byProvider[provider] ?? emptyBucket()
  }

  async loadProviders(force) {
    const answer = await this.call('providers', force === true ? true : undefined)
    this.providers.update(d => {
      d.loaded = true
      if (answer.ok) {
        d.list = answer.providers
        d.error = null
      } else d.error = answer.error
    })
  }

  async loadSettings() {
    const answer = await this.call('settings')
    this.settings.update(d => {
      d.loaded = true
      if (answer.ok) {
        d.providers = answer.providers
        d.error = null
      } else d.error = answer.error
    })
  }

  async saveSettings(providers) {
    const answer = await this.call('saveSettings', { providers })
    if (answer.ok) await this.loadSettings()
    return answer
  }

  async loadModels(provider, force) {
    const bucket = this.models.getSnapshot().byProvider[provider]
    if (bucket !== undefined && bucket.loaded && force !== true) return
    this.models.update(d => { d.byProvider[provider] ??= { list: [], loaded: false, loading: false } })
    this.models.update(d => { d.byProvider[provider].loading = true })
    const answer = await this.call('models', provider)
    if (this.disposed) return
    this.models.update(d => {
      const entry = d.byProvider[provider]
      entry.loading = false
      entry.loaded = true
      if (answer.ok) entry.list = answer.models
    })
  }

  setLaunch(provider, patch) {
    this.view.update(d => { d.launch[provider] = { ...(d.launch[provider] ?? {}), ...patch } })
  }

  setChrome(patch) {
    const current = this.chrome.getSnapshot()
    if (Object.keys(patch).every(key => current[key] === patch[key])) return
    this.chrome.set({ ...current, ...patch })
  }

  async refreshSessions(provider = this.view.getSnapshot().source) {
    if (provider === 'dsh') return
    this.sessions.update(d => {
      d.byProvider[provider] ??= emptyBucket()
      d.byProvider[provider].loading = true
    })
    const answer = await this.call('sessions', provider)
    if (this.disposed) return
    this.sessions.update(d => {
      const bucket = d.byProvider[provider] ??= emptyBucket()
      bucket.loading = false
      bucket.loaded = true
      bucket.at = Date.now()
      if (answer.ok) {
        bucket.list = answer.sessions
        bucket.workspaces = answer.workspaces ?? []
        bucket.error = null
      } else bucket.error = answer.error
    })
    if (answer.ok) {
      this.transcript.update(d => {
        if (d.provider !== provider || d.session === null) return
        const row = answer.sessions.find(item => item.id === d.session.id)
        if (row !== undefined) d.session = { ...d.session, ...row }
      })
    }
  }

  setSource(source) {
    if (!SOURCES.includes(source)) return
    this.view.update(d => {
      d.source = source
      d.query = ''
    })
    if (source === 'dsh') {
      this.#stopListWatcher()
    } else {
      if (!this.bucket(source).loaded) void this.refreshSessions(source)
      void this.loadModels(source)
      this.#startListWatcher()
      const selected = this.view.getSnapshot().selected[source] ?? null
      const current = this.transcript.getSnapshot()
      if (current.provider !== source || current.key !== transcriptKey(source, selected ?? '')) void this.open(source, selected)
    }
    this.sourceChanged(source)
  }

  setQuery(query) {
    this.view.update(d => { d.query = query })
  }

  toggleGroup(key) {
    this.view.update(d => { d.expanded[key] = !(d.expanded[key] ?? true) })
  }

  setGroupBy(groupBy) {
    this.view.update(d => { d.groupBy = groupBy })
  }

  setShowHidden(showHidden) {
    this.view.update(d => { d.showHidden = showHidden })
  }

  showEarlier() {
    this.transcript.update(d => { d.historyLimit += MAX_RENDERED_EVENTS })
  }

  /**
   * Open a foreign session; `null` selects the blank "new session" view,
   * optionally with a working directory preset (`options.cwd`).
   */
  async open(provider, sessionId, options) {
    const newNonce = this.transcript.getSnapshot().newNonce + 1
    this.view.update(d => { d.selected[provider] = sessionId ?? undefined })
    if (sessionId === null || sessionId === undefined) {
      this.#stopPolling()
      this.transcript.set({
        key: transcriptKey(provider, ''),
        provider,
        session: null,
        events: [],
        index: {},
        loading: false,
        error: null,
        turn: null,
        sending: false,
        historyLimit: MAX_RENDERED_EVENTS,
        cwd: options?.cwd ?? null,
        newNonce,
      })
      return
    }
    const key = transcriptKey(provider, sessionId)
    this.#stopPolling()
    this.transcript.set({
      key,
      provider,
      session: null,
      events: [],
      index: {},
      loading: true,
      error: null,
      turn: null,
      sending: false,
      historyLimit: MAX_RENDERED_EVENTS,
      cwd: null,
      newNonce,
    })
    const answer = await this.call('transcript', provider, sessionId)
    if (this.disposed || this.transcript.getSnapshot().key !== key) return
    if (!answer.ok) {
      this.transcript.update(d => {
        d.loading = false
        d.error = answer.error
      })
      return
    }
    const active = Array.isArray(answer.activeTurns) ? answer.activeTurns[0] : undefined
    const events = active === undefined ? answer.events : answer.events.filter(event => event.ts < active.startedAt)
    this.transcript.update(d => {
      d.loading = false
      d.session = answer.session
      d.events = events
      d.index = Object.fromEntries(events.map((event, i) => [event.id, i]))
    })
    if (active !== undefined) this.#attach(active.turnId, 0, active.startedAt)
  }

  /**
   * Send a message. `sessionId` undefined starts a new CLI session in `cwd`.
   */
  async send(provider, { sessionId, cwd, text, options }) {
    const state = this.transcript.getSnapshot()
    if (state.sending || (state.turn !== null && isLive(state.turn.status))) return { ok: false, error: 'busy' }
    const workingDir = cwd ?? state.session?.cwd
    if (!workingDir) return { ok: false, error: 'no-cwd' }
    this.transcript.update(d => {
      d.sending = true
      d.error = null
    })
    const answer = await this.call('startTurn', provider, { sessionId, cwd: workingDir, text, options })
    if (this.disposed) return answer
    this.transcript.update(d => { d.sending = false })
    if (!answer.ok) {
      this.transcript.update(d => { d.error = answer.error })
      return answer
    }
    this.pendingCwd = workingDir
    if (answer.sessionId !== undefined) this.#adoptSession(provider, answer.sessionId, workingDir)
    this.#attach(answer.turnId, 0)
    return answer
  }

  async cancel() {
    if (this.turnId === undefined) return
    await this.call('cancelTurn', this.turnId)
  }

  async answer(requestId, decision) {
    if (this.turnId === undefined) return
    await this.call('answerApproval', this.turnId, requestId, decision)
  }

  async addWorkspace(provider, path) {
    const answer = await this.call('addWorkspace', provider, path)
    if (answer.ok && !this.disposed) this.sessions.update(d => { (d.byProvider[provider] ??= emptyBucket()).workspaces = answer.workspaces })
    return answer
  }

  async removeWorkspace(provider, path) {
    const answer = await this.call('removeWorkspace', provider, path)
    if (answer.ok && !this.disposed) this.sessions.update(d => { (d.byProvider[provider] ??= emptyBucket()).workspaces = answer.workspaces })
    return answer
  }

  async rename(provider, sessionId, title) {
    const answer = await this.call('renameSession', provider, sessionId, title)
    if (answer.ok) {
      this.sessions.update(d => {
        const row = d.byProvider[provider]?.list.find(item => item.id === sessionId)
        if (row !== undefined) {
          row.title = title
          row.renamed = title !== ''
        }
      })
      this.transcript.update(d => {
        if (d.session?.id === sessionId && d.provider === provider) d.session.title = title
      })
    }
    return answer
  }

  async hide(provider, sessionId, hidden) {
    const answer = await this.call('hideSession', provider, sessionId, hidden)
    if (answer.ok) {
      this.sessions.update(d => {
        const row = d.byProvider[provider]?.list.find(item => item.id === sessionId)
        if (row !== undefined) row.hidden = hidden
      })
    }
    return answer
  }

  #adoptSession(provider, sessionId, cwd) {
    this.view.update(d => { d.selected[provider] = sessionId })
    this.transcript.update(d => {
      d.key = transcriptKey(provider, sessionId)
      d.provider = provider
      d.session = { ...(d.session ?? {}), provider, id: sessionId, cwd: cwd ?? d.session?.cwd, title: d.session?.title ?? '' }
    })
  }

  #attach(turnId, fromSeq, startedAt) {
    this.#stopPolling()
    this.turnId = turnId
    this.pollSeq = fromSeq
    this.transcript.update(d => { d.turn = { id: turnId, status: 'running', error: null, startedAt: startedAt ?? Date.now() } })
    void this.#poll()
  }

  async #poll() {
    const turnId = this.turnId
    if (turnId === undefined || this.disposed) return
    const key = this.transcript.getSnapshot().key
    const answer = await this.call('pollTurn', turnId, this.pollSeq)
    if (this.disposed || this.turnId !== turnId) return
    if (!answer.ok) {
      this.transcript.update(d => { d.turn = { id: turnId, status: 'error', error: answer.error } })
      this.turnId = undefined
      return
    }
    this.pollSeq = answer.seq
    const current = this.transcript.getSnapshot()
    if (current.key === key || answer.sessionId !== undefined) {
      this.transcript.update(d => {
        for (const event of answer.events) {
          const at = d.index[event.id]
          if (at === undefined) {
            d.index[event.id] = d.events.length
            d.events.push(event)
          } else d.events[at] = { ...d.events[at], ...event }
        }
        d.turn = { id: turnId, status: answer.status, error: answer.error ?? null, startedAt: d.turn?.startedAt }
      })
      if (answer.sessionId !== undefined && current.session?.id !== answer.sessionId) {
        this.#adoptSession(current.provider ?? this.view.getSnapshot().source, answer.sessionId, this.pendingCwd ?? current.session?.cwd)
      }
    }
    if (isLive(answer.status)) {
      this.pollTimer = setTimeout(() => { void this.#poll() }, answer.status === 'awaiting' ? APPROVAL_POLL_MS : TURN_POLL_MS)
      return
    }
    this.turnId = undefined
    void this.refreshSessions(current.provider ?? this.view.getSnapshot().source)
  }

  #stopPolling() {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.turnId = undefined
  }

  #startListWatcher() {
    if (this.listTimer !== undefined) return
    this.listTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.refreshSessions()
    }, LIST_REFRESH_MS)
  }

  #stopListWatcher() {
    if (this.listTimer !== undefined) clearInterval(this.listTimer)
    this.listTimer = undefined
  }
}

export function isLive(status) {
  return status === 'starting' || status === 'running' || status === 'awaiting'
}

/**
 * Directories offered by the new-session workspace picker: pinned workspaces
 * plus every directory the CLI has sessions in, most recent first.
 * @returns {{ path: string, at: number }[]}
 */
export function workspaceOptions(bucket) {
  const byPath = new Map()
  for (const row of bucket?.list ?? []) {
    if (typeof row.cwd !== 'string' || row.cwd === '') continue
    const at = byPath.get(row.cwd) ?? 0
    if (row.updatedAt > at) byPath.set(row.cwd, row.updatedAt)
  }
  for (const workspace of bucket?.workspaces ?? []) {
    if (!byPath.has(workspace.path) || workspace.addedAt > byPath.get(workspace.path)) byPath.set(workspace.path, workspace.addedAt)
  }
  return [...byPath.entries()].map(([path, at]) => ({ path, at })).sort((a, b) => b.at - a.at)
}
