import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDEBAR_MIN, addTab, clampWidth, closeTab, defaultWidth, focusTab, openSession,
  sanitizeSession, seedSession, setExpanded, setMode, setWidth, toggleExpanded, toggleFullscreen,
} from '../src/client/sidebar.js'

const empty = { bySession: {} }

test('width clamps to the dsh band and seeds at 45% of the viewport', () => {
  assert.equal(clampWidth(100, 1000), SIDEBAR_MIN)
  assert.equal(clampWidth(900, 1000), 700)
  assert.equal(clampWidth(420.4, 1000), 420)
  assert.equal(clampWidth(900, 300), SIDEBAR_MIN)
  assert.equal(defaultWidth(1000), 450)
  assert.equal(defaultWidth(500), SIDEBAR_MIN)
})

test('a seeded session is collapsed, push, with one active guide tab', () => {
  const s = seedSession(1000)
  assert.equal(s.expanded, false)
  assert.equal(s.mode, 'push')
  assert.equal(s.width, 450)
  assert.equal(s.tabs.length, 1)
  assert.equal(s.tabs[0].kind, 'guide')
  assert.equal(s.activeTab, s.tabs[0].id)
})

test('sanitize drops malformed sessions and normalizes the rest', () => {
  assert.equal(sanitizeSession(null), undefined)
  assert.equal(sanitizeSession({ tabs: [] }), undefined)
  assert.equal(sanitizeSession({ tabs: [{ id: 1, kind: 'guide' }] }), undefined)
  const clean = sanitizeSession({ expanded: 'yes', mode: 'weird', width: NaN, tabs: [{ id: 'a', kind: 'guide', extra: 1 }, null], activeTab: 'gone' })
  assert.deepEqual(clean, { expanded: false, mode: 'push', width: defaultWidth(1280), tabs: [{ id: 'a', kind: 'guide' }], activeTab: 'a' })
  assert.equal(sanitizeSession({ expanded: true, mode: 'fullscreen', width: 360, tabs: [{ id: 'a', kind: 'guide' }], activeTab: 'a' }).mode, 'fullscreen')
})

test('open seeds once; expanded and width are per session', () => {
  let state = openSession(empty, 'claude:a', 1000)
  const seeded = state.bySession['claude:a']
  state = openSession(state, 'claude:a', 1000)
  assert.equal(state.bySession['claude:a'], seeded)
  state = setExpanded(state, 'claude:a', true, 1000)
  state = setWidth(state, 'claude:a', 900, 1000)
  state = toggleExpanded(state, 'claude:b', 1000)
  assert.equal(state.bySession['claude:a'].expanded, true)
  assert.equal(state.bySession['claude:a'].width, 700)
  assert.equal(state.bySession['claude:b'].expanded, true)
  assert.equal(state.bySession['claude:b'].width, 450)
})

test('tabs focus, add, and close without ever leaving an empty pane', () => {
  let state = openSession(empty, 'k', 1000)
  const first = state.bySession.k.tabs[0].id
  state = addTab(state, 'k', 'guide')
  const second = state.bySession.k.activeTab
  assert.equal(state.bySession.k.tabs.length, 2)
  assert.notEqual(second, first)
  state = focusTab(state, 'k', first)
  assert.equal(state.bySession.k.activeTab, first)
  state = focusTab(state, 'k', 'missing')
  assert.equal(state.bySession.k.activeTab, first)
  state = closeTab(state, 'k', first)
  assert.equal(state.bySession.k.activeTab, second)
  state = closeTab(state, 'k', second)
  assert.equal(state.bySession.k.tabs.length, 1)
  assert.equal(state.bySession.k.tabs[0].kind, 'guide')
  assert.equal(state.bySession.k.activeTab, state.bySession.k.tabs[0].id)
})

test('fullscreen toggles between push and fullscreen', () => {
  let state = openSession(empty, 'k', 1000)
  state = toggleFullscreen(state, 'k')
  assert.equal(state.bySession.k.mode, 'fullscreen')
  state = setMode(state, 'k', 'push')
  assert.equal(state.bySession.k.mode, 'push')
})
