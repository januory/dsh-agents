import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectOpenWindow } from '../src/client/transcript-window.js'

const at = ts => ({ id: `e${ts}`, type: 'assistant', ts, text: 'x', done: true })

test('no live turn shows the whole disk window', () => {
  const events = [at(1000), at(2000)]
  assert.deepEqual(selectOpenWindow(events, undefined), { events, fromSeq: 0 })
})

test('history before the live turn is kept and the turn replays from its start', () => {
  const history = [at(1000), at(1500)]
  const live = [at(2000), at(2500)]
  const window = selectOpenWindow([...history, ...live], { turnId: 't', seq: 2, startedAt: 2000 })
  assert.deepEqual(window.events, history)
  assert.equal(window.fromSeq, 0)
})

test('a tail window inside the live turn is left to the poll, which replays it live', () => {
  const tail = [at(2000), at(2500), at(3000)]
  const window = selectOpenWindow(tail, { turnId: 't', seq: 3, startedAt: 1000 })
  assert.deepEqual(window.events, [])
  assert.equal(window.fromSeq, 0)
})

test('an active entry the host cannot stream is shown from disk', () => {
  const events = [at(1000), at(2000)]
  const window = selectOpenWindow(events, { sessionId: 's', status: 'running' })
  assert.deepEqual(window.events, events)
  assert.equal(window.fromSeq, 0)
})

test('an empty disk window stays empty', () => {
  assert.deepEqual(selectOpenWindow([], { turnId: 't', seq: 0, startedAt: 1000 }), { events: [], fromSeq: 0 })
})