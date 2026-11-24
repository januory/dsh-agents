import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TurnManager } from '../src/turns.js'

function streamingProvider() {
  let sink
  const provider = {
    id: 'fake',
    startTurn(request, turnSink) {
      sink = turnSink
      turnSink.emit({ id: 'u1', type: 'user', text: request.text })
      for (let i = 1; i <= 1000; i++) turnSink.emit({ id: 's:1', type: 'assistant', text: 'x'.repeat(i), done: false })
      turnSink.emit({ id: 's:1', type: 'assistant', text: 'final', done: true })
      return { dispose() {}, cancel() {}, steer() {} }
    },
  }
  return { provider, sink: () => sink }
}

test('a streaming turn keeps one buffered entry per id and replays only the latest', async () => {
  const turns = new TurnManager({ retentionMs: 60_000 })
  const { provider, sink } = streamingProvider()
  try {
    const { turnId } = await turns.start(provider, { cwd: '/tmp', text: 'hi' })
    const replay = turns.poll(turnId, 0)
    assert.equal(replay.events.length, 2)
    const assistant = replay.events.find(event => event.id === 's:1')
    assert.equal(assistant.text, 'final')
    assert.ok(replay.seq >= 1002)

    const before = replay.seq
    sink().emit({ id: 's:1', type: 'assistant', text: 'final plus more', done: false })
    const update = turns.poll(turnId, before)
    assert.equal(update.events.length, 1)
    assert.equal(update.events[0].id, 's:1')
    assert.equal(update.events[0].text, 'final plus more')
    assert.ok(update.events[0].seq > before)

    assert.equal(turns.poll(turnId, update.seq).events.length, 0)
  } finally {
    turns.dispose()
  }
})

test('a tool_use and its tool_result merge into one entry keeping name/input/output', async () => {
  const turns = new TurnManager({ retentionMs: 60_000 })
  try {
    const { turnId } = await turns.start({
      id: 'fake3',
      startTurn(request, sink) {
        sink.emit({ id: 'toolu_1', type: 'tool', name: 'Edit', input: { file_path: '/a.c', old_string: 'x', new_string: 'y' }, status: 'running' })
        sink.emit({ id: 'toolu_1', type: 'tool', output: 'The file /a.c has been updated successfully.', status: 'done' })
        return { dispose() {}, cancel() {} }
      },
    }, { cwd: '/tmp', text: 'hi' })
    const events = turns.poll(turnId, 0).events
    const tool = events.filter(event => event.id === 'toolu_1')
    assert.equal(tool.length, 1)
    assert.equal(tool[0].name, 'Edit')
    assert.equal(tool[0].input.file_path, '/a.c')
    assert.equal(tool[0].output, 'The file /a.c has been updated successfully.')
    assert.equal(tool[0].status, 'done')
  } finally {
    turns.dispose()
  }
})

test('approval status still tracks the latest buffered event', async () => {
  const turns = new TurnManager({ retentionMs: 60_000 })
  try {
    const { turnId } = await turns.start({
      id: 'fake2',
      startTurn(request, sink) {
        sink.emit({ id: 'a1', type: 'approval', status: 'running', requestId: 'r1', name: 'Bash' })
        return { dispose() {}, cancel() {}, answer() { sink.emit({ id: 'a1', type: 'approval', status: 'done', requestId: 'r1', name: 'Bash' }) } }
      },
    }, { cwd: '/tmp', text: 'hi' })
    assert.equal(turns.poll(turnId, 0).status, 'awaiting')
    turns.answer(turnId, 'r1', 'allow')
    assert.equal(turns.poll(turnId, 0).status, 'running')
    const events = turns.poll(turnId, 0).events
    assert.equal(events.filter(event => event.id === 'a1').length, 1)
    assert.equal(events.find(event => event.id === 'a1').status, 'done')
  } finally {
    turns.dispose()
  }
})