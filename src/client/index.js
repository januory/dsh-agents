import { INVOCATIONS, NAMESPACE, PACKAGE, unwrap } from '../remote.js'
import { AgentCliController } from './controller.js'
import { EN, NS, ZH } from './locales.js'
import { SourceSwitcher } from './SourceSwitcher.jsx'
import { SessionList } from './SessionList.jsx'
import { ConversationPage } from './ConversationPage.jsx'
import { SettingsSection } from './SettingsSection.jsx'
import { SourceHeaderPortal } from './SourceHeaderPortal.jsx'

export const inject = ['slots', 'locale', 'remote', 'layout', 'uiWorkspace']

const PANEL_ID = 'agent-cli'

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-agents: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new AgentCliController(async (method, ...args) => {
    const namespace = ctx.get(`remote.${NAMESPACE}`)
    if (namespace === undefined) return { ok: false, transport: true, error: 'agent-cli remote is not mounted' }
    try {
      return unwrap(await namespace[method](...args))
    } catch (error) {
      return { ok: false, transport: true, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // dsh composes the directory flow (native chooser or in-browser browse) into
  // these holes; occupancy tells the add affordance whether a flow can answer.
  const flowSource = hole => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const hooks = {
    agentView: controller.view,
    agentProviders: controller.providers,
    agentSessions: controller.sessions,
    agentTranscript: controller.transcript,
    agentSettings: controller.settings,
    agentModels: controller.models,
    agentChrome: controller.chrome,
    agentSidebar: controller.sidebar,
    pickerDirectoryFlow: flowSource('workspace.picker.directoryFlow'),
    sidebarDirectoryFlow: flowSource('sidebar.workspaces.directoryFlow'),
  }
  // Stable identities: slot owners re-invoke inject on every render, and
  // effects downstream key on these callbacks.
  const callbacks = {
    setSource: source => controller.setSource(source),
    setLaunch: (provider, patch) => controller.setLaunch(provider, patch),
    setChrome: patch => controller.setChrome(patch),
    open: (provider, sessionId, options) => {
      void controller.open(provider, sessionId, options)
      ctx.layout.selectPanel(PANEL_ID)
    },
    setQuery: query => controller.setQuery(query),
    toggleGroup: key => controller.toggleGroup(key),
    setGroupBy: mode => controller.setGroupBy(mode),
    setShowHidden: value => controller.setShowHidden(value),
    refresh: provider => controller.refreshSessions(provider),
    refreshProviders: () => controller.loadProviders(true),
    rename: (provider, sessionId, title) => controller.rename(provider, sessionId, title),
    hide: (provider, sessionId, hidden) => controller.hide(provider, sessionId, hidden),
    addWorkspace: (provider, path) => controller.addWorkspace(provider, path),
    removeWorkspace: (provider, path) => controller.removeWorkspace(provider, path),
    showEarlier: () => controller.showEarlier(),
    send: (provider, request) => controller.send(provider, request),
    cancel: () => controller.cancel(),
    answer: (requestId, decision) => controller.answer(requestId, decision),
    answerQuestion: (requestId, answers) => controller.answerQuestion(requestId, answers),
    loadTaskOutput: taskId => controller.loadTaskOutput(taskId),
    stopTask: taskId => controller.stopTask(taskId),
    compact: (provider, sessionId) => controller.compact(provider, sessionId),
    goal: (provider, sessionId, op, objective) => controller.goal(provider, sessionId, op, objective),
    clearTasks: () => controller.clearSettledTasks(),
    sidebar: controller.sidebar.actions,
    saveSettings: providers => controller.saveSettings(providers),
    // dsh's picker packages own the flow holes; rendering their occupant with
    // our owner conversation keeps both backends dsh's without redeclaring a
    // hole the workspace plugin already declares.
    directoryFlowOccupant: () => {
      const entry = ctx.slots.entries('workspace.picker.directoryFlow')[0]
      return entry === undefined ? null : { Component: entry.component, face: entry.inject?.() ?? {} }
    },
  }
  const injected = () => ({ hooks, ...callbacks })

  const mounting = ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
  ctx.effect(() => async () => {
    const unmount = await mounting
    if (typeof unmount === 'function') await unmount()
  }, 'dsh-agents: remote namespace')

  ctx.inject([`remote.${NAMESPACE}`], () => {
    const disposers = [
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: injected }, ConversationPage)),
      ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({ name: 'sidebar.session.action', id: 'dsh-agents', order: 100, locale: NS, inject: injected }, SourceSwitcher)),
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-agents-source', locale: NS, inject: injected }, SourceHeaderPortal)),
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-agents',
        order: 40,
        locale: NS,
        label: () => t('settings.title'),
        inject: injected,
      }, SettingsSection)),
    ]

    // The foreign list shadows the shipped browsing region only while a
    // foreign source is selected; with dsh selected the shipped browser and
    // every other plugin's row contributions render untouched.
    disposers.push(ctx.slots.inject('sidebar.workspaces', () => {
      let shadow
      let last = 'dsh'
      const sync = () => {
        const source = controller.view.getSnapshot().source
        if (source === last) return
        last = source
        if (source === 'dsh') {
          shadow?.()
          shadow = undefined
        } else shadow ??= ctx.slots.register({ name: 'sidebar.workspaces', priority: -1, locale: NS, inject: injected }, SessionList)
      }
      const unsubscribe = controller.view.subscribe(sync)
      last = 'dsh'
      sync()
      return () => {
        unsubscribe()
        shadow?.()
        shadow = undefined
      }
    }))

    controller.sourceChanged = source => {
      ctx.layout.selectPanel(source === 'dsh' ? null : PANEL_ID)
    }
    let lastPanel = ctx.layout.panelInfo.getSnapshot().activePanelId
    let nullTimer
    const unsubscribePanel = ctx.layout.panelInfo.subscribe(() => {
      const panel = ctx.layout.panelInfo.getSnapshot().activePanelId
      clearTimeout(nullTimer)
      // A reconnect or re-registration can blank the active panel for a tick; only a lasting null means the reader left.
      if (panel === null && lastPanel !== null) {
        nullTimer = setTimeout(() => {
          if (ctx.layout.panelInfo.getSnapshot().activePanelId === null && controller.view.getSnapshot().source !== 'dsh') controller.setSource('dsh')
        }, 300)
      }
      lastPanel = panel
    })
    void controller.init()
    return () => {
      clearTimeout(nullTimer)
      unsubscribePanel()
      controller.sourceChanged = () => {}
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  })
}
