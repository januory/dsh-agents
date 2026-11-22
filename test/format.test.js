import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeLive, parseClaudeRecords, summarizeClaude } from '../src/providers/claude-format.js'
import { codexItemToEvent, codexThreadSummary } from '../src/providers/codex-format.js'

const iso = ms => new Date(ms).toISOString()

test('claude records fold text, thinking, tool calls and results', () => {
  const records = [
    { type: 'user', uuid: 'u1', timestamp: iso(1000), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: iso(2000), message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: iso(2100), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'u2', timestamp: iso(2200), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] }, toolUseResult: { stdout: 'ok' } },
    { type: 'assistant', uuid: 'a3', timestamp: iso(2300), message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'assistant', uuid: 's1', isSidechain: true, timestamp: iso(2400), message: { content: [{ type: 'text', text: 'subagent' }] } },
  ]
  const events = parseClaudeRecords(records)
  assert.deepEqual(events.map(e => e.type), ['user', 'thinking', 'tool', 'assistant'])
  assert.equal(events[2].name, 'Bash')
  assert.equal(events[2].status, 'done')
  assert.equal(events[2].output, 'ok')
  assert.deepEqual(events[2].structured, { stdout: 'ok' })
  assert.equal(events[3].text, 'done')
})

test('claude summary prefers custom title over ai title and first prompt', () => {
  const head = [
    { type: 'user', uuid: 'u1', timestamp: iso(1000), cwd: '/p', gitBranch: 'main', message: { content: 'first prompt' } },
    { type: 'ai-title', aiTitle: 'generated' },
  ]
  const tail = [{ type: 'custom-title', customTitle: 'renamed' }, { type: 'assistant', timestamp: iso(5000), message: { model: 'm', content: [] } }]
  const summary = summarizeClaude({ path: '/p/x.jsonl', id: 'x', head, tail, size: 10, mtimeMs: 6000 })
  assert.equal(summary.title, 'renamed')
  assert.equal(summary.cwd, '/p')
  assert.equal(summary.gitBranch, 'main')
  assert.equal(summary.model, 'm')
  assert.equal(summary.updatedAt, 6000)
  assert.equal(summarizeClaude({ path: '/p/x.jsonl', id: 'x', head, tail: [], size: 10, mtimeMs: 6000 }).title, 'generated')
  assert.equal(summarizeClaude({ path: '/p/x.jsonl', id: 'x', head: [head[0]], tail: [], size: 10, mtimeMs: 6000 }).title, 'first prompt')
})

test('claude live stream keeps one id per block and merges results', () => {
  const emitted = new Map()
  const sink = { emit: e => emitted.set(e.id, { ...emitted.get(e.id), ...e }), setSession: () => {}, finish: () => {} }
  const live = new ClaudeLive(sink, { turnKey: 'k' })
  live.start('hello')
  live.onFrame({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/p', claude_code_version: 'v', permissionMode: 'default' })
  live.onFrame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  live.onFrame({ type: 'assistant', uuid: 'a1', message: { id: 'msg1', content: [{ type: 'text', text: 'hello' }] } })
  live.onFrame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg2' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool1', name: 'Bash', input: {} } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  live.onFrame({ type: 'assistant', uuid: 'a2', message: { id: 'msg2', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'ls' } }] } })
  live.onFrame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'file', is_error: false }] } })
  live.onFrame({ type: 'result', subtype: 'success', is_error: false, result: 'hello', usage: {} })
  const items = [...emitted.values()]
  assert.equal(items.filter(e => e.type === 'assistant').length, 1)
  assert.equal(items.find(e => e.type === 'assistant').text, 'hello')
  assert.equal(items.find(e => e.type === 'assistant').done, true)
  const tool = emitted.get('tool1')
  assert.deepEqual(tool.input, { command: 'ls' })
  assert.equal(tool.output, 'file')
  assert.equal(tool.status, 'done')
  assert.equal(live.result.subtype, 'success')
  assert.equal(emitted.get('k:user').text, 'hello')
})

test('claude thinking streams live under one id and finalizes done', () => {
  const seen = []
  const sink = { emit: e => seen.push(e), setSession: () => {}, finish: () => {} }
  const live = new ClaudeLive(sink, { turnKey: 'k' })
  live.onFrame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } })
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ', yes' } } })
  const mid = seen.filter(e => e.type === 'thinking')
  assert.equal(mid.length, 3)
  assert.deepEqual(mid.map(e => e.text), ['', 'hmm', 'hmm, yes'])
  assert.ok(mid.every(e => e.done === false))
  assert.equal(new Set(mid.map(e => e.id)).size, 1)
  live.onFrame({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  live.onFrame({ type: 'assistant', uuid: 'a1', message: { id: 'msg1', content: [{ type: 'thinking', thinking: 'hmm, yes' }] } })
  const last = seen[seen.length - 1]
  assert.equal(last.id, mid[0].id)
  assert.equal(last.text, 'hmm, yes')
  assert.equal(last.done, true)
})

test('codex items map to the normalized model', () => {
  assert.deepEqual(codexItemToEvent({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'hi' }] }, 1, true), { id: 'u', type: 'user', ts: 1, text: 'hi' })
  assert.equal(codexItemToEvent({ type: 'agentMessage', id: 'a', text: 'yo', phase: null }, 1, false).done, false)
  assert.equal(codexItemToEvent({ type: 'reasoning', id: 'r', summary: ['s'], content: ['c'] }, 1, true).text, 's\n\nc')
  const cmd = codexItemToEvent({ type: 'commandExecution', id: 'c', command: 'ls', cwd: '/p', status: 'completed', aggregatedOutput: 'x', exitCode: 0, durationMs: 5 }, 1, true)
  assert.equal(cmd.name, 'Bash')
  assert.equal(cmd.status, 'done')
  assert.equal(cmd.exitCode, 0)
  const running = codexItemToEvent({ type: 'commandExecution', id: 'c', command: 'ls', status: 'inProgress' }, 1, false)
  assert.equal(running.status, 'running')
  const edit = codexItemToEvent({ type: 'fileChange', id: 'f', changes: [{ path: '/p/a', kind: 'update', diff: '@@' }], status: 'completed' }, 1, true)
  assert.equal(edit.name, 'Edit')
  assert.deepEqual(edit.structured.changes[0], { path: '/p/a', kind: 'update', diff: '@@' })
  const mcp = codexItemToEvent({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'failed', arguments: { a: 1 }, result: null, error: { message: 'bad' } }, 1, true)
  assert.equal(mcp.name, 's/t')
  assert.equal(mcp.status, 'error')
  assert.equal(mcp.output, 'bad')
  assert.equal(codexItemToEvent({ type: 'sleep', id: 'x' }, 1, true), undefined)
  assert.equal(codexItemToEvent({ type: 'futureThing', id: 'x' }, 1, true).name, 'futureThing')
})

test('codex thread summary uses name then preview and seconds timestamps', () => {
  const thread = { id: 't', name: '', preview: 'first\nsecond', cwd: '/p', createdAt: 10, updatedAt: 20, model: 'm', gitInfo: { branch: 'b' }, status: { type: 'active', activeFlags: ['waitingOnApproval'] }, historyMode: 'legacy', source: 'cli', path: '/x' }
  const summary = codexThreadSummary(thread)
  assert.equal(summary.title, 'first')
  assert.equal(summary.createdAt, 10_000)
  assert.equal(summary.updatedAt, 20_000)
  assert.deepEqual(summary.live, { status: 'active', flags: ['waitingOnApproval'] })
  assert.equal(codexThreadSummary({ ...thread, name: 'named' }).title, 'named')
})
