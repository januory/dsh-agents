import { useEffect, useRef, useState } from 'react'
import { IconCloseOutlineRegular, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SIDEBAR_AUTO_FULLSCREEN, SIDEBAR_KEY_STEP, TAB_TYPES, clampWidth } from './sidebar.js'
import { McpPanel } from './McpPanel.jsx'
import css from './RightSidebar.module.css'

function CompassGlyph({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" stroke="currentColor" />
      <path d="M10.6101 5.39014L8.99014 8.99014L5.39014 10.6101L7.01014 7.01014L10.6101 5.39014Z" fill="currentColor" />
    </svg>
  )
}

function FullscreenGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
    </svg>
  )
}

function ExitFullscreenGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
      <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
    </svg>
  )
}

function McpGlyph({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M6 2v3M10 2v3" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M8 11v3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

const TAB_ICONS = { compass: CompassGlyph, mcp: McpGlyph }

export function RightSidebar({ sessionKey, useSidebar, actions, t, provider, sessionId, cwd, mcp }) {
  const surface = useSidebar(s => s.bySession[sessionKey])
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const drag = useRef(null)
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  if (surface === undefined) return null
  const { expanded, mode, tabs, activeTab } = surface
  const width = clampWidth(surface.width, viewport)
  const autoFullscreen = viewport < SIDEBAR_AUTO_FULLSCREEN
  const fullscreen = autoFullscreen || mode === 'fullscreen'
  const active = tabs.find(tab => tab.id === activeTab) ?? tabs[0]

  const startResize = event => {
    event.preventDefault()
    const target = event.currentTarget
    const base = width
    const startX = event.clientX
    target.setPointerCapture(event.pointerId)
    drag.current = { base, startX }
    const move = e => { if (drag.current !== null) actions.setWidth(sessionKey, drag.current.base - (e.clientX - drag.current.startX), window.innerWidth) }
    const up = e => {
      drag.current = null
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  const onHandleKey = event => {
    if (event.key === 'ArrowLeft') { actions.setWidth(sessionKey, width + SIDEBAR_KEY_STEP, viewport); event.preventDefault() }
    else if (event.key === 'ArrowRight') { actions.setWidth(sessionKey, width - SIDEBAR_KEY_STEP, viewport); event.preventDefault() }
  }

  return (
    <div
      className={css.panel}
      style={{ '--dag-sidebar-width': fullscreen ? '100vw' : `${width}px` }}
      data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
      data-sidebar-right-open={expanded || undefined}
      data-sidebar-right-session={sessionKey}
      data-dag-sidebar-right
      aria-hidden={!expanded || undefined}
    >
      {expanded && !fullscreen && (
        <div className={css.handle} role="separator" aria-orientation="vertical" aria-label={t('sidebar.resizeAria')} tabIndex={0} onPointerDown={startResize} onKeyDown={onHandleKey} />
      )}
      <div className={css.panelBody}>
        <div className={css.tabHost}>
          <div className={css.tabStrip}>
            <div className={css.stripTabs} role="tablist" aria-label={t('sidebar.expandAria')}>
              {tabs.map(tab => {
                const type = TAB_TYPES.find(candidate => candidate.kind === tab.kind)
                const Icon = TAB_ICONS[type?.icon] ?? CompassGlyph
                const isActive = tab.id === active.id
                const closable = !(tab.kind === 'guide' && tabs.length === 1)
                return (
                  <div
                    key={tab.id}
                    className={cx(css.tab, isActive && css.tabActive, closable && css.closable)}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    data-sidebar-right-tab={tab.id}
                    onClick={() => actions.focusTab(sessionKey, tab.id)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { actions.focusTab(sessionKey, tab.id); event.preventDefault() } }}
                  >
                    <span className={css.tabTitle}><Icon size={16} className={css.tabIcon} />{t(type?.titleKey ?? 'sidebar.tab.guide')}</span>
                    {closable && (
                      <button type="button" className={css.tabClose} aria-label={t('sidebar.closeTab')} onClick={event => { event.stopPropagation(); actions.closeTab(sessionKey, tab.id) }}>
                        <IconCloseOutlineRegular size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className={css.stripFill} />
            <div className={css.stripChrome}>
              <Tooltip label={t(fullscreen ? 'sidebar.exitFullscreen' : 'sidebar.toFullscreen')} side="bottom" delayMs={500}>
                <button type="button" className={css.iconButton} aria-label={t(fullscreen ? 'sidebar.exitFullscreen' : 'sidebar.toFullscreen')} data-sidebar-right-mode={fullscreen ? 'push' : 'fullscreen'} onClick={() => actions.toggleFullscreen(sessionKey)}>
                  {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
                </button>
              </Tooltip>
              <Tooltip label={t('sidebar.collapse')} shortcutKeys={['Control', 'Shift', 'B']} side="bottom" delayMs={500}>
                <button type="button" className={css.iconButton} aria-label={t('sidebar.collapseAria')} aria-keyshortcuts="Control+Shift+B" data-sidebar-right-toggle onClick={() => actions.setExpanded(sessionKey, false, viewport)}>
                  <IconPanelLeftOutlineRegular size={15} className={css.collapseGlyph} />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className={css.tabBody} role="tabpanel">
            {active.kind === 'guide'
              ? (
                <div className={css.guide} data-sidebar-guide>
                  <span className={css.hero} aria-hidden="true"><CompassGlyph size={56} /></span>
                  {TAB_TYPES.filter(type => type.kind !== 'guide').map(type => {
                    const Icon = TAB_ICONS[type.icon] ?? CompassGlyph
                    return (
                      <div key={type.kind} className={css.entryCell}>
                        <button type="button" className={css.entry} data-sidebar-guide-entry={type.kind} onClick={() => actions.openKind(sessionKey, type.kind)}>
                          <span className={css.entryIcon}><Icon size={26} /></span>
                          <span className={css.entryText}>
                            <span className={css.entryTitle}>{t(type.titleKey)}</span>
                            {type.descriptionKey !== undefined && <span className={css.entryDescription}>{t(type.descriptionKey)}</span>}
                          </span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
              : active.kind === 'mcp'
                ? <McpPanel key={sessionKey} provider={provider} sessionId={sessionId} cwd={cwd} mcp={mcp} t={t} />
                : <p className={css.unavailable} data-sidebar-right-unavailable>{t('sidebar.tab.unavailable')}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
