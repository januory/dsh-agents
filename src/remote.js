export const PACKAGE = '@januory/dsh-agents'
export const NAMESPACE = 'agentCli'
export const REGISTRY_KEY = 'agentCliProviders'

const JSON_SCHEMA = Object.freeze({
  parse: value => value,
})

// The Typert registry validates strict codecs through schema.parse(), while
// the browser $mount face only accepts the `schema` form; `create` covers the
// 0.1.x factory spelling.
const JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  schema: JSON_SCHEMA,
  create: () => JSON_SCHEMA,
})

function jsonParameter(name, { optional = false } = {}) {
  const parameter = { name, wire: name, source: 'json', codec: JSON_CODEC }
  if (optional) parameter.acceptsUndefined = true
  return parameter
}

function invocation(method, parameters = []) {
  return {
    id: `${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: JSON_CODEC,
  }
}

export const INVOCATIONS = [
  invocation('providers', [jsonParameter('force', { optional: true })]),
  invocation('sessions', [jsonParameter('provider')]),
  invocation('models', [jsonParameter('provider')]),
  invocation('transcript', [jsonParameter('provider'), jsonParameter('sessionId')]),
  invocation('startTurn', [jsonParameter('provider'), jsonParameter('request')]),
  invocation('steerTurn', [jsonParameter('turnId'), jsonParameter('request')]),
  invocation('pollTurn', [jsonParameter('turnId'), jsonParameter('afterSeq')]),
  invocation('cancelTurn', [jsonParameter('turnId')]),
  invocation('answerApproval', [jsonParameter('turnId'), jsonParameter('requestId'), jsonParameter('decision')]),
  invocation('renameSession', [jsonParameter('provider'), jsonParameter('sessionId'), jsonParameter('title')]),
  invocation('hideSession', [jsonParameter('provider'), jsonParameter('sessionId'), jsonParameter('hidden')]),
  invocation('addWorkspace', [jsonParameter('provider'), jsonParameter('path')]),
  invocation('removeWorkspace', [jsonParameter('provider'), jsonParameter('path')]),
  invocation('settings'),
  invocation('saveSettings', [jsonParameter('settings')]),
]

/**
 * Unwrap a Remote answer into the plugin's own `{ ok, ... }` payload.
 * @param {unknown} answer - the gateway result.
 * @returns {{ ok: boolean, [key: string]: unknown }}
 */
export function unwrap(answer) {
  if (answer === undefined || answer === null) return { ok: false, error: 'no response' }
  if (answer.ok === false) {
    const error = answer.error
    return { ok: false, error: error && error.message ? error.message : String(error ?? 'call failed') }
  }
  const value = answer.value
  return value && typeof value === 'object' ? value : { ok: false, error: 'empty result' }
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function failure(error) {
  return { ok: false, error: messageOf(error) }
}
