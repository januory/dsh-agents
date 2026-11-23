import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClaudeProvider } from '../src/providers/claude.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
chmodSync(fixture, 0o755)
const windows = process.platform === 'win32'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-mcp-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const command = windows ? join(dir, 'fake-claude.cmd') : fixture
  if (windows) writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`)
  const log = join(dir, 'spawns.log')
  const mcpLog = join(dir, 'mcp.log')
  writeFileSync(log, '')
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, log: process.env.FAKE_SPAWN_LOG, mcp: process.env.FAKE_MCP_LOG }
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.FAKE_SPAWN_LOG = log
  process.env.FAKE_MCP_LOG = mcpLog
  const provider = createClaudeProvider({ command, home })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return {
    dir, home, cwd, provider, command, mcpLog,
    spawns: () => lines().filter(l => l.startsWith('spawn')).length,
    exits: () => windows
      ? lines().filter(l => l.startsWith('spawn')).filter(l => !alive(Number(l.split(' ')[1]))).length
      : lines().filter(l => l.startsWith('exit')).length,
    mcpSets: () => { try { return readFileSync(mcpLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } },
    cleanup() {
      provider.dispose()
      if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.config
      if (saved.log === undefined) delete process.env.FAKE_SPAWN_LOG; else process.env.FAKE_SPAWN_LOG = saved.log
      if (saved.mcp === undefined) delete process.env.FAKE_MCP_LOG; else process.env.FAKE_MCP_LOG = saved.mcp
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

async function waitExits(s, count, timeout = 5000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (s.exits() >= count) return
    await sleep(20)
  }
  throw new Error(`expected ${count} exited children, saw ${s.exits()}`)
}

test('mcpStatus normalizes servers and tool annotations, then reaps the query child', async () => {
  const s = setup()
  try {
    const { servers } = await s.provider.mcpStatus('mcp-session', s.cwd)
    assert.equal(servers.length, 2)
    const alpha = servers.find(server => server.name === 'alpha')
    assert.equal(alpha.status, 'connected')
    assert.equal(alpha.source, 'user')
    assert.deepEqual(alpha.tools, [{ name: 'read_file', readOnly: true }, { name: 'write_file', readOnly: false }])
    const beta = servers.find(server => server.name === 'beta')
    assert.equal(beta.status, 'failed')
    assert.equal(beta.error, 'connection refused')
    assert.deepEqual(beta.tools, [])
    assert.equal(s.spawns(), 1)
    await waitExits(s, 1)
  } finally {
    s.cleanup()
  }
})

test('mcpReconnect and mcpToggle settle from a successful control_response', async () => {
  const s = setup()
  try {
    assert.deepEqual(await s.provider.mcpReconnect('mcp-session', s.cwd, 'beta'), {})
    assert.deepEqual(await s.provider.mcpToggle('mcp-session', s.cwd, 'alpha', false), {})
    await waitExits(s, 2)
  } finally {
    s.cleanup()
  }
})

test('mcpAdd sends the current scope set plus the new server and persists it', async () => {
  const s = setup()
  try {
    await s.provider.mcpStatus('mcp-session', s.cwd)
    const result = await s.provider.mcpAdd('mcp-session', s.cwd, 'gamma', { type: 'stdio', command: 'echo', args: ['yo'] }, 'user')
    assert.deepEqual(result.added, ['gamma'])
    assert.deepEqual(result.removed, [])
    const set = s.mcpSets().at(-1)
    assert.equal(set.hint, 'user')
    assert.deepEqual(Object.keys(set.servers).sort(), ['alpha', 'beta', 'gamma'])
    const { servers } = await s.provider.mcpStatus('mcp-session', s.cwd)
    assert.ok(servers.some(server => server.name === 'gamma'))
    await waitExits(s, 3)
  } finally {
    s.cleanup()
  }
})

test('mcpRemove drops the name from the scope set without touching the rest', async () => {
  const s = setup()
  try {
    await s.provider.mcpStatus('mcp-session', s.cwd)
    const result = await s.provider.mcpRemove('mcp-session', s.cwd, 'beta', 'user')
    assert.deepEqual(result.removed, ['beta'])
    const set = s.mcpSets().at(-1)
    assert.deepEqual(Object.keys(set.servers).sort(), ['alpha'])
    const { servers } = await s.provider.mcpStatus('mcp-session', s.cwd)
    assert.ok(!servers.some(server => server.name === 'beta'))
    await waitExits(s, 3)
  } finally {
    s.cleanup()
  }
})
