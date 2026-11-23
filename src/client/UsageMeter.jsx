import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { tokenCount } from './labels.js'
import css from './UsageMeter.module.css'

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const READING_SLOT = '\u0000'

/**
 * dsh's composer context meter: a 14px ring plus percentage below the card,
 * opening the occupancy headline, figures and bar. Renders nothing until the
 * provider reports both occupancy and a route capacity.
 */
export function UsageMeter({ usage, t }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const capacity = usage?.capacity
  const percent = usage == null || capacity == null || capacity <= 0 || usage.contextTokens == null
    ? null
    : Math.min(100, Math.round(usage.contextTokens / capacity * 100))
  // Clamp the panel into the viewport so a right-edge meter on a narrow phone
  // screen opens leftward instead of running off-screen, as dsh's anchor does.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const rect = rootRef.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (rect === undefined || panel == null) return
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12))
    setPos({ left, bottom: window.innerHeight - rect.top + 8 })
  }, [open])
  useEffect(() => {
    if (!open) return
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
  useEffect(() => {
    if (percent === null && open) setOpen(false)
  }, [percent, open])
  if (percent === null) return null
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT }).split(READING_SLOT).map(part => part.trim())
  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('context.aria', { percent: reading })} side="top" delayMs={200} disabled={open} portal>
        <button type="button" className={css.trigger} aria-label={t('context.aria', { percent: reading })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle className={css.fill} cx="7" cy="7" r={RADIUS} strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div ref={panelRef} className={css.panel} role="dialog" aria-label={t('context.used')} style={{ left: pos?.left ?? 0, bottom: pos?.bottom ?? 0, visibility: pos === null ? 'hidden' : undefined }}>
          <div className={css.header}>
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>{`~${tokenCount(usage.contextTokens)} / ${tokenCount(capacity)}`}</span>
          </div>
          <div className={css.bar}>{percent > 0 && <div className={css.segment} style={{ width: `${percent}%` }} />}</div>
        </div>,
        document.body,
      )}
    </span>
  )
}
