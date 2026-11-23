import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EN, ZH } from '../src/client/locales.js'

test('zh and en dictionaries stay in parity with matching placeholders', () => {
  const zh = Object.keys(ZH)
  const en = Object.keys(EN)
  assert.deepEqual(zh.filter(key => !(key in EN)), [])
  assert.deepEqual(en.filter(key => !(key in ZH)), [])
  const placeholders = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  for (const key of zh) {
    assert.notEqual(ZH[key], '', key)
    assert.notEqual(EN[key], '', key)
    assert.deepEqual(placeholders(ZH[key]), placeholders(EN[key]), key)
  }
})
