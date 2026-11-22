import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerWorkspaces, readState, writeState } from '../src/store.js'

test('readState tolerates a state file without workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-store-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ settings: { providers: { claude: { model: 'x' } } }, sessions: {} }))
  const state = readState(file)
  assert.deepEqual(state.workspaces, {})
  assert.deepEqual(providerWorkspaces(state, 'claude'), [])
  assert.equal(state.settings.providers.claude.model, 'x')
})

test('providerWorkspaces keeps order, drops duplicates and malformed entries', () => {
  const state = { workspaces: { claude: [
    { path: '/a', addedAt: 2 },
    { path: '/b', addedAt: 1 },
    { path: '/a', addedAt: 9 },
    { path: '' },
    null,
    { path: '/c' },
  ] } }
  assert.deepEqual(providerWorkspaces(state, 'claude'), [{ path: '/a', addedAt: 2 }, { path: '/b', addedAt: 1 }, { path: '/c', addedAt: 0 }])
  assert.deepEqual(providerWorkspaces(state, 'codex'), [])
})

test('writeState round-trips pinned workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-store-'))
  const file = join(dir, 'nested', 'state.json')
  const state = readState(file)
  state.workspaces.codex = [{ path: '/tmp/project', addedAt: 5 }]
  writeState(state, file)
  assert.deepEqual(providerWorkspaces(readState(file), 'codex'), [{ path: '/tmp/project', addedAt: 5 }])
})
