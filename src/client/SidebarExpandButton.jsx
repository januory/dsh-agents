import { IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SidebarExpandButton.module.css'

export function SidebarExpandButton({ expanded, onExpand, t }) {
  if (expanded) return null
  return (
    <Tooltip label={t('sidebar.expand')} shortcutKeys={['Control', 'Shift', 'B']} side="bottom" delayMs={500}>
      <button type="button" className={css.button} aria-label={t('sidebar.expandAria')} aria-keyshortcuts="Control+Shift+B" data-sidebar-right-expand data-dag-sidebar-expand onClick={onExpand}>
        <IconPanelLeftOutlineRegular size={15} className={css.icon} />
      </button>
    </Tooltip>
  )
}
