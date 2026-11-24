import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTurns } from '../src/client/transcript-groups.js'

const ev = (id, type) => ({ id, type, ts: Number(id.replace(/\D/g, '')) || 0 })

test('a reply keeps its place between process runs, not clumped at the end', () => {
  const turns = groupTurns([
    ev('u1', 'user'),
    ev('t2', 'thinking'),
    ev('a3', 'assistant'),
    ev('t4', 'tool'),
    ev('t5', 'thinking'),
    ev('a6', 'assistant'),
  ])
  assert.equal(turns.length, 1)
  const segments = turns[0].segments
  assert.deepEqual(segments.map(s => s.kind), ['process', 'response', 'process', 'response'])
  assert.deepEqual(segments[0].events.map(e => e.id), ['t2'])
  assert.deepEqual(segments[1].events.map(e => e.id), ['a3'])
  assert.deepEqual(segments[2].events.map(e => e.id), ['t4', 't5'])
  assert.deepEqual(segments[3].events.map(e => e.id), ['a6'])
})

test('consecutive same-kind rows share one run; user starts a new turn', () => {
  const turns = groupTurns([
    ev('u1', 'user'),
    ev('t2', 'thinking'),
    ev('t3', 'tool'),
    ev('a4', 'assistant'),
    ev('a5', 'assistant'),
    ev('u6', 'user'),
    ev('a7', 'assistant'),
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].segments.map(s => s.kind), ['process', 'response'])
  assert.deepEqual(turns[0].segments[1].events.map(e => e.id), ['a4', 'a5'])
  assert.deepEqual(turns[1].segments.map(s => s.kind), ['response'])
})

test('non-compact turn markers are dropped, compact stays a process row', () => {
  const turns = groupTurns([
    ev('u1', 'user'),
    { id: 'x2', type: 'turn', reason: 'end', ts: 2 },
    { id: 'x3', type: 'turn', reason: 'compact', ts: 3 },
    ev('a4', 'assistant'),
  ])
  assert.deepEqual(turns[0].segments.map(s => s.kind), ['process', 'response'])
  assert.deepEqual(turns[0].segments[0].events.map(e => e.id), ['x3'])
})