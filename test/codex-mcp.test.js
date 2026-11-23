import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexProvider } from '../src/providers/codex.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
chmodSync(fixture, 0o755)
const windows = process.platform === 'win32'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-codex-mcp-'))
  const command = windows ? join(dir, 'fake-codex.cmd') : fixture
  if (windows) writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`)
  const log = join(dir, 'requests.log')
  writeFileSync(log, '')
  const saved = process.env.FAKE_CODEX_LOG
  process.env.FAKE_CODEX_LOG = log
  const provider = createCodexProvider({ command, home: join(dir, 'codex') })
  return {
    dir, provider,
    requests: () => readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)),
    cleanup() {
      provider.dispose()
      if (saved === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = saved
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

test('mcpStatus maps connection state and read-only hints into the shared shape', async () => {
  const s = setup()
  try {
    const { servers } = await s.provider.mcpStatus('th1')
    assert.deepEqual(servers.map(server => [server.name, server.status]), [['alpha', 'connected'], ['beta', 'needs-auth'], ['gamma', 'disabled']])
    const alpha = servers[0]
    assert.deepEqual(alpha.tools, [{ name: 'read_file', readOnly: true }, { name: 'write_file', readOnly: false }])
    assert.deepEqual(servers[1].tools, [])
    const list = s.requests().find(r => r.method === 'mcpServerStatus/list')
    assert.equal(list.params.detail, 'full')
    assert.equal(list.params.threadId, 'th1')
  } finally {
    s.cleanup()
  }
})

test('codex MCP management is read-only and reports unsupported', async () => {
  const s = setup()
  try {
    for (const run of [
      () => s.provider.mcpReconnect('th1', '/work', 'alpha'),
      () => s.provider.mcpToggle('th1', '/work', 'alpha', false),
      () => s.provider.mcpAdd('th1', '/work', 'x', {}, 'user'),
      () => s.provider.mcpRemove('th1', '/work', 'alpha', 'user'),
    ]) {
      assert.throws(run, error => error.code === 'unsupported')
    }
  } finally {
    s.cleanup()
  }
})
