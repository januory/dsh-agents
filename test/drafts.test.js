import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdAttachments, readDraft, takeAttachments, writeDraft } from '../src/client/drafts.js'

function stubStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
  }
  return map
}

test('text drafts persist per session key and clear on empty', () => {
  const map = stubStorage()
  assert.equal(readDraft('claude:a'), '')
  writeDraft('claude:a', 'hello')
  writeDraft('claude:b', 'other')
  assert.equal(readDraft('claude:a'), 'hello')
  assert.equal(readDraft('claude:b'), 'other')
  assert.equal(map.size, 2)
  writeDraft('claude:a', '')
  assert.equal(readDraft('claude:a'), '')
  assert.equal(map.size, 1)
})

test('attachments transfer to the composer and back on switch', () => {
  stubStorage()
  const items = [{ key: 1, status: 'ready', id: 'x.png' }]
  holdAttachments('claude:a', items)
  assert.deepEqual(takeAttachments('claude:a'), items)
  assert.deepEqual(takeAttachments('claude:a'), [])
  holdAttachments('claude:a', [])
  assert.deepEqual(takeAttachments('claude:a'), [])
})

test('unavailable storage is tolerated', () => {
  globalThis.localStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(readDraft('claude:a'), '')
  writeDraft('claude:a', 'x')
})
