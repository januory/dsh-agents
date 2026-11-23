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
  invocation('activeTurns', [jsonParameter('provider')]),
  invocation('models', [jsonParameter('provider')]),
  invocation('transcript', [jsonParameter('provider'), jsonParameter('sessionId')]),
  invocation('tasks', [jsonParameter('provider'), jsonParameter('sessionId')]),
  invocation('taskOutput', [jsonParameter('provider'), jsonParameter('sessionId'), jsonParameter('taskId')]),
  invocation('stopTask', [jsonParameter('provider'), jsonParameter('sessionId'), jsonParameter('taskId')]),
  invocation('compactSession', [jsonParameter('provider'), jsonParameter('sessionId')]),
  invocation('goalSession', [jsonParameter('provider'), jsonParameter('sessionId'), jsonParameter('op'), jsonParameter('objective', { optional: true })]),
  invocation('startTurn', [jsonParameter('provider'), jsonParameter('request')]),
  invocation('steerTurn', [jsonParameter('turnId'), jsonParameter('request')]),
  invocation('pollTurn', [jsonParameter('turnId'), jsonParameter('afterSeq')]),
  invocation('cancelTurn', [jsonParameter('turnId')]),
  invocation('answerApproval', [jsonParameter('turnId'), jsonParameter('requestId'), jsonParameter('decision')]),
  invocation('answerQuestion', [jsonParameter('turnId'), jsonParameter('requestId'), jsonParameter('answers')]),
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
  if (answer === undefined || answer === null) return { ok: false, transport: true, error: 'no response' }
  // ok:false is the gateway's own failure branch (carrier offline / transport
  // fault); a host error travels inside the ok:true value as { ok:false }.
  if (answer.ok === false) {
    const error = answer.error
    return { ok: false, transport: true, error: error && error.message ? error.message : String(error ?? 'call failed') }
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
