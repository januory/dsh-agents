import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  addTab, closeTab, focusTab, openSession, sanitizeSession, setExpanded, setMode, setWidth, toggleExpanded, toggleFullscreen,
} from './sidebar.js'

export function createSidebarStore() {
  const store = createSnapshotStore({ bySession: {} }, { persist: { name: 'dsh.agents.sidebar.v1' } })
  store.update(d => {
    for (const key of Object.keys(d.bySession)) {
      const clean = sanitizeSession(d.bySession[key])
      if (clean === undefined) delete d.bySession[key]
      else d.bySession[key] = clean
    }
  })
  const apply = (fn, ...args) => store.update(d => { d.bySession = fn(d, ...args).bySession })
  store.actions = {
    open: (key, viewport) => apply(openSession, key, viewport),
    setExpanded: (key, value, viewport) => apply(setExpanded, key, value, viewport),
    toggleExpanded: (key, viewport) => apply(toggleExpanded, key, viewport),
    setMode: (key, mode) => apply(setMode, key, mode),
    toggleFullscreen: key => apply(toggleFullscreen, key),
    setWidth: (key, px, viewport) => apply(setWidth, key, px, viewport),
    focusTab: (key, id) => apply(focusTab, key, id),
    addTab: (key, kind) => apply(addTab, key, kind),
    closeTab: (key, id) => apply(closeTab, key, id),
  }
  return store
}
