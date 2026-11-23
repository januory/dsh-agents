export const SIDEBAR_MIN = 300
export const SIDEBAR_MAX_RATIO = 0.7
export const SIDEBAR_DEFAULT_RATIO = 0.45
export const SIDEBAR_KEY_STEP = 20

export const TAB_TYPES = [
  { kind: 'guide', titleKey: 'sidebar.tab.guide', icon: 'compass' },
]

export function clampWidth(px, viewport) {
  const max = Math.max(SIDEBAR_MIN, Math.round(viewport * SIDEBAR_MAX_RATIO))
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(px)))
}

export function defaultWidth(viewport) {
  return Math.max(SIDEBAR_MIN, Math.round(viewport * SIDEBAR_DEFAULT_RATIO))
}

const newId = () => `t-${crypto.randomUUID().slice(0, 8)}`
const guideTab = () => ({ id: newId(), kind: 'guide' })

export function seedSession(viewport) {
  const tab = guideTab()
  return { expanded: false, mode: 'push', width: defaultWidth(viewport), tabs: [tab], activeTab: tab.id }
}

export function sanitizeSession(value) {
  if (value === null || typeof value !== 'object') return undefined
  const tabs = Array.isArray(value.tabs)
    ? value.tabs.filter(t => t !== null && typeof t === 'object' && typeof t.id === 'string' && typeof t.kind === 'string').map(t => ({ id: t.id, kind: t.kind }))
    : []
  if (tabs.length === 0) return undefined
  return {
    expanded: value.expanded === true,
    mode: value.mode === 'fullscreen' ? 'fullscreen' : 'push',
    width: typeof value.width === 'number' && Number.isFinite(value.width) ? value.width : defaultWidth(1280),
    tabs,
    activeTab: tabs.some(t => t.id === value.activeTab) ? value.activeTab : tabs[0].id,
  }
}

function withSession(state, key, viewport) {
  if (state.bySession[key] !== undefined) return state
  return { ...state, bySession: { ...state.bySession, [key]: seedSession(viewport) } }
}

function patch(state, key, fn) {
  const current = state.bySession[key]
  if (current === undefined) return state
  return { ...state, bySession: { ...state.bySession, [key]: fn(current) } }
}

export function openSession(state, key, viewport) {
  return withSession(state, key, viewport)
}

export function setExpanded(state, key, value, viewport) {
  return patch(withSession(state, key, viewport), key, s => ({ ...s, expanded: value }))
}

export function toggleExpanded(state, key, viewport) {
  return patch(withSession(state, key, viewport), key, s => ({ ...s, expanded: !s.expanded }))
}

export function setMode(state, key, mode) {
  return patch(state, key, s => ({ ...s, mode }))
}

export function toggleFullscreen(state, key) {
  return patch(state, key, s => ({ ...s, mode: s.mode === 'fullscreen' ? 'push' : 'fullscreen' }))
}

export function setWidth(state, key, px, viewport) {
  return patch(state, key, s => ({ ...s, width: clampWidth(px, viewport) }))
}

export function focusTab(state, key, id) {
  return patch(state, key, s => s.tabs.some(t => t.id === id) ? { ...s, activeTab: id } : s)
}

export function addTab(state, key, kind = 'guide') {
  return patch(state, key, s => {
    const tab = { id: newId(), kind }
    return { ...s, tabs: [...s.tabs, tab], activeTab: tab.id }
  })
}

export function closeTab(state, key, id) {
  return patch(state, key, s => {
    const index = s.tabs.findIndex(t => t.id === id)
    if (index === -1) return s
    let tabs = s.tabs.filter(t => t.id !== id)
    if (tabs.length === 0) tabs = [guideTab()]
    const activeTab = s.activeTab === id ? tabs[Math.min(index, tabs.length - 1)].id : s.activeTab
    return { ...s, tabs, activeTab }
  })
}

