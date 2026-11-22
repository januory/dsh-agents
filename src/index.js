import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { INVOCATIONS, NAMESPACE, PACKAGE, REGISTRY_KEY, failure } from './remote.js'
import { mediaTypeOf, readUpload, saveUpload, uploadPath } from './uploads.js'
import { AgentCliRegistry } from './registry.js'
import { TurnManager } from './turns.js'
import { applyOverlay, overlayKey, providerSettings, providerWorkspaces, readState, writeState } from './store.js'
import { createClaudeProvider } from './providers/claude.js'
import { createCodexProvider } from './providers/codex.js'

export const name = 'dsh-agents'

const ProviderConfig = z.object({
  enabled: z.boolean().default(true),
  command: z.string().default(''),
  home: z.string().default(''),
})

export const Config = z.object({
  claude: ProviderConfig,
  codex: ProviderConfig,
  turnRetentionMs: z.number().step(1).min(1_000).default(10 * 60_000),
  abandonTimeoutMs: z.number().step(1).min(10_000).default(5 * 60_000),
})

const DETECT_TTL_MS = 60_000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  const registry = new AgentCliRegistry()
  ctx.provide(REGISTRY_KEY, registry)
  const turns = new TurnManager({
    retentionMs: config.turnRetentionMs,
    abandonTimeoutMs: config.abandonTimeoutMs,
    logger: ctx.logger,
  })
  ctx.effect(() => () => turns.dispose(), 'agent-cli: running turns')

  const mount = provider => ctx.effect(() => {
    const unregister = registry.register(provider)
    return () => {
      unregister()
      provider.dispose?.()
    }
  }, `agent-cli: ${provider.id} provider`)
  if (config.claude.enabled) mount(createClaudeProvider(config.claude))
  if (config.codex.enabled) mount(createCodexProvider(config.codex))

  const detected = new Map()
  async function detect(provider) {
    const cached = detected.get(provider.id)
    if (cached !== undefined && Date.now() - cached.at < DETECT_TTL_MS) return cached.value
    const value = await provider.detect().catch(error => ({ available: false, command: '', error: failure(error).error }))
    detected.set(provider.id, { at: Date.now(), value })
    return value
  }

  function launchOptions(provider, requested) {
    const stored = providerSettings(readState(), provider.id)
    const options = { ...stored, ...(requested ?? {}) }
    const modes = provider.permissionModes ?? []
    if (options.permissionMode !== '' && !modes.includes(options.permissionMode)) {
      throw new Error(`agent-cli: ${provider.id} does not support permission mode "${options.permissionMode}"`)
    }
    return options
  }

  const service = {
    async providers(force) {
      try {
        if (force === true) detected.clear()
        const providers = []
        for (const provider of registry.list()) {
          const status = await detect(provider)
          providers.push({ id: provider.id, label: provider.label, permissionModes: provider.permissionModes ?? [], reasoningEfforts: provider.reasoningEfforts ?? [], ...status })
        }
        return { ok: true, providers }
      } catch (error) {
        return failure(error)
      }
    },
    async sessions(providerId) {
      try {
        const provider = registry.get(providerId)
        const state = readState()
        const sessions = (await provider.listSessions()).map(summary => applyOverlay(summary, state))
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        return { ok: true, sessions, workspaces: providerWorkspaces(state, providerId) }
      } catch (error) {
        return failure(error)
      }
    },
    async models(providerId) {
      try {
        const provider = registry.get(providerId)
        const models = provider.listModels === undefined ? [] : await provider.listModels()
        return { ok: true, models }
      } catch (error) {
        return failure(error)
      }
    },
    async transcript(providerId, sessionId) {
      try {
        const provider = registry.get(providerId)
        const result = await provider.readTranscript(sessionId)
        return {
          ok: true,
          session: applyOverlay(result.session, readState()),
          events: result.events,
          activeTurns: turns.activeFor(providerId, sessionId),
        }
      } catch (error) {
        return failure(error)
      }
    },
    async startTurn(providerId, request) {
      try {
        const provider = registry.get(providerId)
        const status = await detect(provider)
        if (!status.available) throw new Error(status.error ?? `${provider.label} is not available`)
        const options = launchOptions(provider, request?.options)
        const images = (request?.images ?? []).map(image => {
          const stored = readUpload(image?.id)
          return { id: image.id, mediaType: stored.mediaType }
        })
        const started = await turns.start(provider, { ...request, images, options })
        return { ok: true, ...started }
      } catch (error) {
        return failure(error)
      }
    },
    pollTurn(turnId, afterSeq) {
      try {
        return { ok: true, ...turns.poll(turnId, afterSeq) }
      } catch (error) {
        return failure(error)
      }
    },
    cancelTurn(turnId) {
      try {
        return turns.cancel(turnId)
      } catch (error) {
        return failure(error)
      }
    },
    answerApproval(turnId, requestId, decision) {
      try {
        return turns.answer(turnId, requestId, decision)
      } catch (error) {
        return failure(error)
      }
    },
    renameSession(providerId, sessionId, title) {
      try {
        registry.get(providerId)
        if (typeof title !== 'string') throw new Error('agent-cli: title must be a string')
        const state = readState()
        const key = overlayKey(providerId, sessionId)
        const entry = { ...(state.sessions[key] ?? {}) }
        if (title.trim() === '') delete entry.title
        else entry.title = title.trim()
        state.sessions[key] = entry
        writeState(state)
        return { ok: true }
      } catch (error) {
        return failure(error)
      }
    },
    hideSession(providerId, sessionId, hidden) {
      try {
        registry.get(providerId)
        const state = readState()
        const key = overlayKey(providerId, sessionId)
        const entry = { ...(state.sessions[key] ?? {}) }
        if (hidden === true) entry.hidden = true
        else delete entry.hidden
        state.sessions[key] = entry
        writeState(state)
        return { ok: true }
      } catch (error) {
        return failure(error)
      }
    },
    addWorkspace(providerId, path) {
      try {
        registry.get(providerId)
        if (typeof path !== 'string' || path.trim() === '') throw new Error('agent-cli: workspace path must be a non-empty string')
        const dir = resolve(path.trim())
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`agent-cli: not a directory: ${dir}`)
        const state = readState()
        const workspaces = providerWorkspaces(state, providerId)
        if (!workspaces.some(entry => entry.path === dir)) workspaces.push({ path: dir, addedAt: Date.now() })
        state.workspaces[providerId] = workspaces
        writeState(state)
        return { ok: true, workspaces }
      } catch (error) {
        return failure(error)
      }
    },
    removeWorkspace(providerId, path) {
      try {
        registry.get(providerId)
        const dir = resolve(String(path ?? ''))
        const state = readState()
        const workspaces = providerWorkspaces(state, providerId).filter(entry => entry.path !== dir)
        state.workspaces[providerId] = workspaces
        writeState(state)
        return { ok: true, workspaces }
      } catch (error) {
        return failure(error)
      }
    },
    settings() {
      try {
        const state = readState()
        const providers = {}
        for (const provider of registry.list()) providers[provider.id] = providerSettings(state, provider.id)
        return { ok: true, providers }
      } catch (error) {
        return failure(error)
      }
    },
    saveSettings(settings) {
      try {
        const state = readState()
        const incoming = settings?.providers ?? {}
        for (const provider of registry.list()) {
          const value = incoming[provider.id]
          if (value === undefined) continue
          const modes = provider.permissionModes ?? []
          const permissionMode = typeof value.permissionMode === 'string' ? value.permissionMode : ''
          if (permissionMode !== '' && !modes.includes(permissionMode)) throw new Error(`agent-cli: ${provider.id} does not support permission mode "${permissionMode}"`)
          state.settings.providers[provider.id] = {
            permissionMode,
            model: typeof value.model === 'string' ? value.model.trim() : '',
          }
        }
        writeState(state)
        return { ok: true }
      } catch (error) {
        return failure(error)
      }
    },
  }
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE }),
  })
  ctx.provide(NAMESPACE, service)

  // Pasted images ride the connection's HTTP carrier: the Remote JSON uplink
  // is capped at 256 KiB, far below a screenshot.
  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.get('connection')
    if (connection === undefined) return
    const json = (body, status = 200) => Response.json(body, { status })
    const disposers = [
      connection.fetch.register({
        path: '/api/agent-cli.upload',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          try {
            const mediaType = new URL(request.url).searchParams.get('mediaType') ?? ''
            const bytes = new Uint8Array(await request.arrayBuffer())
            return json({ ok: true, id: saveUpload(mediaType, bytes), mediaType, size: bytes.byteLength })
          } catch (error) {
            return json(failure(error), 400)
          }
        },
      }),
      connection.fetch.register({
        path: '/api/agent-cli.attachment',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async request => {
          const id = new URL(request.url).searchParams.get('id') ?? ''
          const file = uploadPath(id)
          if (file === null || !existsSync(file)) return json({ ok: false, error: 'unknown attachment' }, 404)
          const bytes = readFileSync(file)
          const headers = { 'Content-Type': mediaTypeOf(id), 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, max-age=86400' }
          if (request.method === 'HEAD') return new Response(null, { headers })
          return new Response(bytes, { headers })
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  ctx.inject(['typert'], typertCtx => {
    const typert = typertCtx.get('typert')
    if (typert === undefined) return
    return typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: INVOCATIONS,
    })
  })
}
