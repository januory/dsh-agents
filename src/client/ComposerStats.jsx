import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { tokenCount } from './labels.js'
import { UsageMeter } from './UsageMeter.jsx'
import css from './ComposerStats.module.css'

const exact = value => value.toLocaleString()

function Pill({ stat, icon, label, text, title, titleValue, rows }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect !== undefined) setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    const onDown = event => {
      if (rootRef.current?.contains(event.target) === true || panelRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const body = <>{icon}<span className={css.label}>{label}</span></>
  return (
    <span ref={rootRef} className={css.anchor} data-composer-stat={stat}>
      <Tooltip label={text} side="top" portal delayMs={200} onlyWhenClipped disabled={open}>
        {rows === undefined
          ? <span className={css.pill}>{body}</span>
          : <button type="button" className={css.pill} aria-haspopup="dialog" aria-expanded={open} aria-label={text} onClick={() => setOpen(v => !v)}>{body}</button>}
      </Tooltip>
      {open && rows !== undefined && pos !== null && createPortal(
        <div ref={panelRef} className={css.panel} role="dialog" aria-label={title} style={{ left: pos.left, bottom: pos.bottom }}>
          <div className={css.panelTitle}>{icon}{title}{titleValue !== undefined && <span className={css.panelValue}>{titleValue}</span>}</div>
          <dl className={css.details}>
            {rows.map(([key, value]) => <div key={key} className={css.row}><dt>{key}</dt><dd>{value}</dd></div>)}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * dsh's composer dock: centered activity and usage pills beside the context
 * meter. Readings rest in the tertiary tone; only pills with dialog rows are
 * buttons, and each dialog closes on Escape or an outside press.
 */
export function ComposerStats({ usage, t }) {
  const billed = usage == null ? 0 : (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const total = billed + (usage?.outputTokens ?? 0)
  const cacheHit = billed > 0 ? Math.round((usage.cacheReadTokens ?? 0) / billed * 100) : null
  const counts = usage != null && usage.turns > 0 ? t('stats.counts', { turns: usage.turns, steps: usage.steps ?? 0 }) : null
  const usageText = usage != null && total > 0
    ? [t('message.turnUsage.count', { count: tokenCount(total) }), cacheHit === null ? null : t('stats.cacheHit', { percent: cacheHit })].filter(Boolean).join(' · ')
    : null
  return (
    <div className={css.dock} data-usage="">
      {counts !== null && <Pill stat="activity" icon={<IconGaugeOutlineRegular />} label={counts} text={counts} />}
      {usageText !== null && (
        <Pill
          stat="usage"
          icon={<IconDatabaseOutlineRegular />}
          label={usageText}
          text={usageText}
          title={t('stats.dialog.usageTitle')}
          titleValue={exact(total)}
          rows={[
            ...(cacheHit === null ? [] : [[t('message.turnUsage.cacheHit'), `${cacheHit}%`]]),
            [t('message.turnUsage.input'), exact(usage.inputTokens ?? 0)],
            [t('message.turnUsage.cacheRead'), exact(usage.cacheReadTokens ?? 0)],
            ...((usage.cacheWriteTokens ?? 0) === 0 ? [] : [[t('message.turnUsage.cacheWrite'), exact(usage.cacheWriteTokens)]]),
            [t('message.turnUsage.output'), exact(usage.outputTokens ?? 0)],
          ]}
        />
      )}
      <UsageMeter usage={usage} t={t} />
    </div>
  )
}
