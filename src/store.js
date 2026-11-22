import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const STORE_DIR = 'agent-cli'

export function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  const selected = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(join(homedir(), selected.slice(2)))
  return resolve(selected)
}

export function statePath() {
  return join(harnessHome(), STORE_DIR, 'state.json')
}

const EMPTY = { settings: { providers: {} }, sessions: {}, workspaces: {} }

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function readState(path = statePath()) {
  if (!existsSync(path)) return structuredClone(EMPTY)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const root = record(parsed)
  return {
    settings: { providers: record(record(root.settings).providers) },
    sessions: record(root.sessions),
    workspaces: record(root.workspaces),
  }
}

export function writeState(next, path = statePath()) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

export function overlayKey(provider, sessionId) {
  return `${provider}:${sessionId}`
}

/**
 * Plugin-owned title/hidden overlay. The CLI's own files are never edited.
 * @param {import('./registry.js').SessionSummary} summary
 * @param {object} state
 */
export function applyOverlay(summary, state) {
  const overlay = record(state.sessions[overlayKey(summary.provider, summary.id)])
  const title = typeof overlay.title === 'string' && overlay.title !== '' ? overlay.title : summary.title
  return { ...summary, title, hidden: overlay.hidden === true, renamed: typeof overlay.title === 'string' && overlay.title !== '' }
}

/**
 * Directories pinned as workspaces for a provider, in the order they were
 * added. Sessions grouped under the same directory are unaffected by this list.
 * @returns {{ path: string, addedAt: number }[]}
 */
export function providerWorkspaces(state, provider) {
  const list = state.workspaces[provider]
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push({ path, addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0 })
  }
  return out
}

export function providerSettings(state, provider) {
  const value = record(state.settings.providers[provider])
  return {
    permissionMode: typeof value.permissionMode === 'string' ? value.permissionMode : '',
    model: typeof value.model === 'string' ? value.model : '',
  }
}
