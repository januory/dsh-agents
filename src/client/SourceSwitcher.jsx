import { useState } from 'react'
import { Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SourceIcon } from './SourceIcon.jsx'
import { SOURCES } from './controller.js'
import css from './SourceSwitcher.module.css'

/**
 * Wraps the shipped New-session button. While a foreign source is selected the
 * button starts a session of that CLI instead of a dsh one; in the rail (or
 * when the header dropdown has no seat) it also carries the workspace switch.
 */
export function SourceSwitcher({ wide, children, t, useAgentView, useAgentChrome, setSource, open: openSession }) {
  const source = useAgentView(s => s.source)
  const headerFailed = useAgentChrome(s => s.headerFailed)
  const [menuOpen, setMenuOpen] = useState(false)
  const intercept = event => {
    if (source === 'dsh') return
    event.preventDefault()
    event.stopPropagation()
    openSession(source, null)
  }
  const button = <span className={css.intercept} onClickCapture={intercept}>{children}</span>
  if (wide && !headerFailed) return button
  const items = SOURCES.map(value => ({ id: value, label: t(`workspace.${value}`), icon: <SourceIcon source={value} size={14} /> }))
  const current = t(`workspace.${source}`)
  return (
    <>
      {button}
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        selectedId={source}
        align="end"
        side="bottom"
        portal
        className={css.menuRoot}
        listClassName={css.menu}
        onSelect={id => {
          setMenuOpen(false)
          setSource(id)
        }}
        anchor={(
          <Tooltip label={t('source.cycle', { name: current })} delayMs={500} side={wide ? 'bottom' : 'right'} portal disabled={menuOpen}>
            <button
              type="button"
              className={cx(css.trigger, wide && css.wide, source !== 'dsh' && css.active)}
              aria-label={t('workspace.switch')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(v => !v)}
            >
              <SourceIcon source={source} size={wide ? 14 : 18} />
              {wide && <span className={css.label}>{current}</span>}
            </button>
          </Tooltip>
        )}
      />
    </>
  )
}
