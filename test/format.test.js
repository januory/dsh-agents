import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeLive, mergeTasks, parseClaudeRecords, summarizeClaude, taskNotificationOf, tasksFromRecords } from '../src/providers/claude-format.js'
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

test('claude local-command output renders from its system record, not the plumbing', () => {
  const events = parseClaudeRecords([
    { type: 'user', uuid: 'c', isMeta: true, timestamp: iso(1000), message: { content: '<local-command-caveat>run directly</local-command-caveat>' } },
    { type: 'user', uuid: 'n', timestamp: iso(1100), message: { content: '<command-name>/rename</command-name>\n<command-args>x</command-args>' } },
    { type: 'system', subtype: 'local_command', uuid: 'echo', timestamp: iso(1200), content: '/rename', commandRun: {} },
    { type: 'system', subtype: 'local_command', uuid: 'out', timestamp: iso(1300), content: '<local-command-stdout>Session renamed to: x</local-command-stdout>', commandRun: { command: 'rename', args: 'x' } },
  ])
  assert.deepEqual(events.map(e => e.type), ['assistant'])
  assert.equal(events[0].id, 'out')
  assert.equal(events[0].text, 'Session renamed to: x')
})

test('claude images echo on the live user event and count in history', () => {
  const emitted = []
  const live = new ClaudeLive({ emit: e => emitted.push(e), setSession: () => {}, finish: () => {} }, { turnKey: 'k' })
  const images = [{ id: 'a.png', mediaType: 'image/png' }, { id: 'b.jpg', mediaType: 'image/jpeg' }]
  live.start('look', images)
  assert.deepEqual(emitted[0], { id: 'k:user', type: 'user', ts: emitted[0].ts, text: 'look', images })
  live.start('plain')
  assert.equal('images' in emitted[1], false)
  live.steer('more', images)
  live.steer('again')
  assert.deepEqual(emitted.slice(2).map(e => e.id), ['k:steer:1:user', 'k:steer:2:user'])
  assert.deepEqual(emitted[2].images, images)
  assert.equal('images' in emitted[3], false)
  const events = parseClaudeRecords([
    { type: 'user', uuid: 'u1', timestamp: iso(1000), message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64' } }, { type: 'image', source: { type: 'base64' } }] } },
    { type: 'user', uuid: 'u2', timestamp: iso(2000), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] } },
    { type: 'user', uuid: 'u3', isMeta: true, turnCompanion: true, timestamp: iso(2100), message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/1.png]' }] } },
  ])
  assert.deepEqual(events.map(e => ({ text: e.text, imageCount: e.imageCount })), [{ text: 'look', imageCount: 2 }, { text: '', imageCount: 1 }])
  const summary = summarizeClaude({ path: '/p', id: 's', head: [{ type: 'user', uuid: 'm', isMeta: true, timestamp: iso(1), message: { content: '<local-command-caveat>x</local-command-caveat>' } }, { type: 'user', uuid: 'h', timestamp: iso(2), message: { content: 'real prompt' } }], tail: [], size: 1, mtimeMs: 3 })
  assert.equal(summary.title, 'real prompt')
  assert.equal(summary.messageCount, 1)
})

test('codex user message counts image and localImage content', () => {
  assert.deepEqual(codexItemToEvent({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'hi' }, { type: 'localImage', path: '/a.png' }, { type: 'image', url: 'x' }] }, 1, true), { id: 'u', type: 'user', ts: 1, text: 'hi', imageCount: 2 })
  assert.equal(codexItemToEvent({ type: 'userMessage', id: 'u', content: [] }, 1, true), undefined)
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

test('background tasks and subagents are reconstructed from launch calls and queued notifications', () => {
  const xml = '<task-notification>\n<task-id>taskbg</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command "probe" completed (exit code 0)</summary>\n</task-notification>'
  const agentXml = '<task-notification>\n<task-id>taskag</task-id>\n<tool-use-id>toolu_ag</tool-use-id>\n<status>completed</status>\n<summary>Agent "count" finished</summary>\n<result>3 files</result>\n<usage>\n<subagent_tokens>1500</subagent_tokens>\n<tool_uses>4</tool_uses>\n<duration_ms>900</duration_ms>\n</usage>\n</task-notification>'
  const records = [
    { type: 'assistant', uuid: 'a1', timestamp: iso(1000), message: { content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1', description: 'probe', run_in_background: true } }] } },
    { type: 'user', uuid: 'u1', timestamp: iso(1100), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'started' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: iso(1200), message: { content: [{ type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { description: 'count', subagent_type: 'Explore', run_in_background: true } }] } },
    { type: 'user', uuid: 'u2', timestamp: iso(1300), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: 'launched' }] } },
    { type: 'assistant', uuid: 'a3', timestamp: iso(1400), message: { content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'foreground', subagent_type: 'Plan' } }] } },
    { type: 'user', uuid: 'u3', timestamp: iso(1500), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'plan ready' }] } },
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(2000), content: xml },
    { type: 'queue-operation', operation: 'remove', timestamp: iso(2100), content: xml },
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(2200), content: agentXml },
  ]
  const tasks = tasksFromRecords(records)
  const bg = tasks.find(t => t.toolUseId === 'toolu_bg')
  assert.equal(bg.status, 'completed')
  assert.equal(bg.kind, 'bash')
  assert.equal(bg.label, 'probe')
  assert.equal(bg.outputFile, '/tmp/x.output')
  assert.match(bg.detail, /exit code 0/)
  const ag = tasks.find(t => t.toolUseId === 'toolu_ag')
  assert.equal(ag.status, 'completed')
  assert.equal(ag.result, '3 files')
  assert.equal(ag.tokens, 1500)
  assert.equal(ag.toolUses, 4)
  const fg = tasks.find(t => t.toolUseId === 'toolu_fg')
  assert.equal(fg.status, 'completed')
  assert.equal(fg.background, false)
  assert.equal(fg.result, 'plan ready')
  assert.equal(taskNotificationOf('no xml here'), undefined)
  const live = [{ id: 'toolu_bg', toolUseId: 'toolu_bg', kind: 'bash', label: 'probe', status: 'running', tokens: 0, toolUses: 1, durationMs: 300, startedAt: 1000 }]
  const merged = mergeTasks(tasks, live)
  const mergedBg = merged.find(t => t.toolUseId === 'toolu_bg')
  assert.equal(mergedBg.status, 'running')
  assert.equal(mergedBg.toolUses, 1)
  assert.equal(mergedBg.detail, bg.detail)
  assert.equal(merged.length, tasks.length)
  assert.equal(mergeTasks([], live).length, 1)
})

test('transcript hides the CLI task-notification user feed', () => {
  const events = parseClaudeRecords([
    { type: 'user', uuid: 'u1', timestamp: iso(1000), message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' } },
    { type: 'user', uuid: 'u2', timestamp: iso(2000), message: { role: 'user', content: 'hello' } },
  ])
  assert.deepEqual(events.map(e => e.text), ['hello'])
})
