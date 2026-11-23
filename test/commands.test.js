import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyToken, commandRows, detectSlash, filterRows, goalClaim, goalPrefix, hitKey } from '../src/client/commands.js'

const LABELS = { 'palette.file': '文件', 'palette.goal': '目标', 'palette.plan': '计划', 'palette.compact': '压缩' }
const t = key => LABELS[key] ?? key

test('detectSlash follows dsh boundary rules', () => {
  assert.deepEqual(detectSlash('/', 1), { start: 0, end: 1, query: '' })
  assert.deepEqual(detectSlash('hi /comp', 8), { start: 3, end: 8, query: 'comp' })
  assert.deepEqual(detectSlash('hi\n/comp', 8), { start: 3, end: 8, query: 'comp' })
  assert.deepEqual(detectSlash('(/plan', 6), { start: 1, end: 6, query: 'plan' })
  assert.equal(detectSlash('word/comp', 9), null)
  assert.equal(detectSlash('//comp', 6), null)
  assert.equal(detectSlash('https:/x', 8), null)
  assert.equal(detectSlash('http://x', 8), null)
  assert.equal(detectSlash('/comp ', 6), null)
  assert.equal(detectSlash('plain', 5), null)
  assert.deepEqual(detectSlash('/comp', 3), { start: 0, end: 3, query: 'co' })
})

test('hitKey and applyToken remove exactly the trigger span', () => {
  const hit = detectSlash('hi /comp', 8)
  assert.equal(hitKey(hit), '3:8:comp')
  assert.deepEqual(applyToken('hi /comp', hit), { text: 'hi ', caret: 3 })
})

test('commandRows gates rows by session and provider capability', () => {
  const claude = { id: 'claude', commands: ['goal', 'compact'] }
  const codex = { id: 'codex', commands: ['goal', 'compact'] }
  assert.deepEqual(commandRows({ provider: claude, hasSession: false, t }).map(r => r.name), ['file'])
  assert.deepEqual(commandRows({ provider: claude, hasSession: true, t }).map(r => r.name), ['file', 'goal', 'compact'])
  assert.deepEqual(commandRows({ provider: codex, hasSession: true, t }).map(r => r.name), ['file', 'goal', 'compact'])
  assert.deepEqual(commandRows({ provider: { id: 'x', commands: [] }, hasSession: true, t }).map(r => r.name), ['file'])
  const rows = commandRows({ provider: claude, hasSession: true, t })
  assert.deepEqual(rows.map(r => r.section), ['palette.section.add', 'palette.section.add', 'palette.section.commands'])
})

test('filterRows keeps sections for empty query and ranks name/label only', () => {
  const rows = commandRows({ provider: { commands: ['goal', 'compact'] }, hasSession: true, t })
  assert.equal(filterRows(rows, ''), rows)
  assert.deepEqual(filterRows(rows, 'cpt').map(r => r.name), ['compact'])
  assert.deepEqual(filterRows(rows, 'go').map(r => r.name), ['goal'])
  assert.deepEqual(filterRows(rows, '文件').map(r => r.name), ['file'])
  assert.deepEqual(filterRows(rows, 'PNG'), [])
  assert.deepEqual(filterRows(rows, 'zzz'), [])
})

test('goalClaim mirrors the show/clear/set grammar', () => {
  assert.deepEqual(goalClaim('/goal'), { op: 'get', objective: '' })
  assert.deepEqual(goalClaim('/goal   '), { op: 'get', objective: '' })
  assert.deepEqual(goalClaim('/目标'), { op: 'get', objective: '' })
  assert.deepEqual(goalClaim('/goal clear'), { op: 'clear', objective: '' })
  assert.deepEqual(goalClaim('/goal CLEAR'), { op: 'clear', objective: '' })
  assert.deepEqual(goalClaim('/goal clearance'), { op: 'set', objective: 'clearance' })
  assert.deepEqual(goalClaim('/goal ship it\nnow'), { op: 'set', objective: 'ship it\nnow' })
  assert.equal(goalClaim('before /goal x'), null)
  assert.equal(goalClaim('/goalie x'), null)
  assert.equal(goalPrefix(key => (key === 'goal.token' ? '目标' : key)), '/目标 ')
})
