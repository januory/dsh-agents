/**
 * @typedef {object} SessionSummary
 * @property {string} provider
 * @property {string} id
 * @property {string} title
 * @property {string} [cwd]
 * @property {string} [gitBranch]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} messageCount
 * @property {string} [model]
 * @property {string} [path] - native transcript file, when the CLI keeps one
 *
 * @typedef {object} TurnEvent - normalized, provider-independent transcript item.
 * @property {string} id - stable across streaming updates of the same item
 * @property {number} [seq] - assigned by the turn manager for live events
 * @property {number} ts
 * @property {'user'|'assistant'|'thinking'|'tool'|'turn'|'error'|'approval'|'meta'} type
 * @property {string} [text]
 * @property {boolean} [done]
 * @property {string} [name] - tool name
 * @property {unknown} [input] - tool input
 * @property {string} [output]
 * @property {'running'|'done'|'error'} [status]
 * @property {boolean} [isError]
 * @property {'start'|'end'} [phase]
 * @property {string} [reason]
 * @property {object} [usage]
 * @property {string} [requestId] - approval request identity
 * @property {string[]} [options] - approval decisions the CLI accepts
 * @property {string} [decision]
 * @property {string} [message]
 * @property {string} [model]
 * @property {string} [cwd]
 *
 * @typedef {object} TurnSink
 * @property {(event: TurnEvent) => void} emit
 * @property {(sessionId: string) => void} setSession
 * @property {(result: { status: 'done'|'error'|'cancelled', error?: string, usage?: object }) => void} finish
 *
 * @typedef {object} TurnHandle
 * @property {() => void} cancel
 * @property {(requestId: string, decision: string) => void} answer
 * @property {() => void} dispose
 *
 * @typedef {object} TurnRequest
 * @property {string} [sessionId] - omit to start a new session
 * @property {string} cwd
 * @property {string} text
 * @property {object} [options] - provider-native launch options chosen by the user
 *
 * @typedef {object} AgentCliProvider
 * @property {string} id
 * @property {string} label
 * @property {() => Promise<{ available: boolean, command: string, version?: string, error?: string }>} detect
 * @property {() => Promise<SessionSummary[]>} listSessions
 * @property {(sessionId: string) => Promise<{ session: SessionSummary, events: TurnEvent[] }>} readTranscript
 * @property {(request: TurnRequest, sink: TurnSink) => Promise<TurnHandle>} startTurn
 * @property {() => Promise<{ id: string, label: string, description?: string, efforts?: string[], defaultEffort?: string }[]>} [listModels]
 * @property {readonly string[]} [permissionModes]
 * @property {readonly string[]} [reasoningEfforts] - CLI-wide effort levels when models do not advertise their own
 */

const REQUIRED_METHODS = ['detect', 'listSessions', 'readTranscript', 'startTurn']

/**
 * Live registry of agent CLI providers. Built-in providers register here the
 * same way a future bundle would register another CLI.
 */
export class AgentCliRegistry {
  #providers = new Map()

  /**
   * @param {AgentCliProvider} provider
   * @returns {() => void} disposer
   */
  register(provider) {
    if (!provider || typeof provider.id !== 'string' || provider.id === '' || typeof provider.label !== 'string') {
      throw new Error('agent-cli: a provider needs a non-empty id and label')
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof provider[method] !== 'function') throw new Error(`agent-cli: provider "${provider.id}" lacks ${method}()`)
    }
    if (this.#providers.has(provider.id)) throw new Error(`agent-cli: provider "${provider.id}" is already registered`)
    this.#providers.set(provider.id, provider)
    return () => { this.#providers.delete(provider.id) }
  }

  /** @returns {AgentCliProvider[]} */
  list() {
    return [...this.#providers.values()]
  }

  /**
   * @param {string} id
   * @returns {AgentCliProvider}
   */
  get(id) {
    const provider = this.#providers.get(id)
    if (provider === undefined) throw new Error(`agent-cli: unknown provider "${id}"`)
    return provider
  }
}
