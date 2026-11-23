import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { IconCompactOutlineRegular, IconGoalOutlineRegular, IconPaperclipOutlineRegular, IconPlanOutlineRegular, MenuSurface, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import css from './CommandPalette.module.css'

const GLYPHS = {
  paperclip: IconPaperclipOutlineRegular,
  goal: IconGoalOutlineRegular,
  plan: IconPlanOutlineRegular,
  compact: IconCompactOutlineRegular,
}

const optionId = index => `dag-command-option-${index}`

/**
 * dsh's trigger menu: one shared highlight for keyboard and pointer, rows pick
 * on mousedown so the input keeps focus, sections render only where they change.
 */
export function CommandPalette({ t, rows, highlight, onHover, onPick, onDismiss, signal }) {
  const listRef = useRef(null)
  const viewportRef = useRef(null)
  const [overflow, setOverflow] = useState(false)
  const maxHeight = useAnchoredMaxHeight(listRef, 400, signal, 84)
  useLayoutEffect(() => {
    const el = viewportRef.current?.querySelector(`#${optionId(highlight)}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  useLayoutEffect(() => {
    const fit = () => {
      const el = viewportRef.current
      if (el !== null && el !== undefined) setOverflow(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [rows, maxHeight])
  useLayoutEffect(() => {
    const onDown = event => {
      const list = listRef.current
      if (list === null) return
      if (list.contains(event.target)) return
      if (list.closest('[data-composer-card]')?.contains(event.target) === true) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [onDismiss])
  return (
    <MenuSurface ref={listRef} className={css.menu} style={{ maxHeight }} data-trigger-menu="" data-overflow-below={overflow ? '' : undefined}>
      <div
        ref={viewportRef}
        className={css.viewport}
        role="listbox"
        aria-label={t('palette.aria')}
        aria-activedescendant={optionId(highlight)}
        onScroll={() => {
          const el = viewportRef.current
          setOverflow(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
        }}
      >
        {rows.map((row, index) => {
          const active = index === highlight
          const Glyph = GLYPHS[row.icon]
          return (
            <Fragment key={row.name}>
              {row.section !== rows[index - 1]?.section && <div role="presentation" className={css.sectionTitle}>{row.section}</div>}
              <button
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={active}
                className={cx(css.item, active && css.active)}
                onMouseDown={event => {
                  event.preventDefault()
                  onPick(index)
                }}
                onMouseMove={active ? undefined : () => onHover(index)}
              >
                <span className={css.itemIcon} aria-hidden><Glyph size={14} /></span>
                <span className={css.itemName}>{row.label}</span>
                {row.label.toLowerCase() !== row.name.toLowerCase() && <span className={css.itemAlias}>{row.name}</span>}
                <span className={css.itemDescription}>{row.description}</span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </MenuSurface>
  )
}
