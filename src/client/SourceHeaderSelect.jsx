import { useState } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SourceIcon } from './SourceIcon.jsx'
import { SOURCES } from './controller.js'
import css from './SourceHeaderSelect.module.css'

/**
 * Workspace-source dropdown styled as the browsing region's section label:
 * "DSH 工作区 / Claude 工作区 / Codex 工作区".
 */
export function SourceHeaderSelect({ t, useAgentView, setSource, className }) {
  const source = useAgentView(s => s.source)
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={SOURCES.map(value => ({ id: value, label: t(`workspace.${value}`), icon: <SourceIcon source={value} size={14} /> }))}
      selectedId={source}
      align="start"
      side="bottom"
      portal
      className={cx(css.root, className)}
      listClassName={css.menu}
      onSelect={id => {
        setOpen(false)
        if (id !== source) setSource(id)
      }}
      anchor={(
        <button
          type="button"
          className={css.trigger}
          aria-label={t('workspace.switch')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('workspace.switch')}
          onClick={() => setOpen(v => !v)}
        >
          <span className={css.label}>{t(`workspace.${source}`)}</span>
          <IconChevronDownOutlineRegular size={12} className={cx(css.chevron, open && css.chevronOpen)} />
        </button>
      )}
    />
  )
}
