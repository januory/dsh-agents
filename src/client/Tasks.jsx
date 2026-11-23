import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutlineRegular, IconStopFillRegular, MarqueeText, StateDot, TerminalBlock, Tooltip, useHoverMarquee } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { taskCounters, taskDotState, taskDuration, taskStatusLabel, terminalLabels } from './labels.js'
import css from './Tasks.module.css'

const FOLD_LIMIT = 5
const KILL_ARM_MS = 3_000
const KILL_FAILED_MS = 4_000

function useNow(active) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function isRunning(task) {
  return task.status === 'running'
}

function kindLabel(task, t) {
  if (task.kind === 'agent') return task.subagentType || t('task.agent')
  if (task.kind === 'bash') return t('task.shell')
  return t('task.task')
}

function TaskFacts({ task, now, t }) {
  const counters = taskCounters(task, now, t)
  return (
    <div className={css.facts}>
      <div className={css.factTitle}>{task.label || kindLabel(task, t)}</div>
      <div className={css.factLine}>{kindLabel(task, t)} · {t(task.background ? 'task.background' : 'task.foreground')}</div>
      <div className={css.factLine}><StateDot state={taskDotState(task)} size={10} />{taskStatusLabel(task, t)}{counters !== '' && ` · ${counters}`}</div>
      {task.detail !== undefined && task.detail !== '' && <div className={css.factLine}>{task.detail}</div>}
    </div>
  )
}

/**
 * Running subagents beside the launch options, in the VSCode extension's
 * focus-row shape: a blinking dot, a pulsing label and live counters.
 */
export function AgentChips({ tasks, t }) {
  const agents = tasks.filter(task => task.kind === 'agent' && isRunning(task))
  const now = useNow(agents.length > 0)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
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
    const onKey = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(() => { if (agents.length === 0 && open) setOpen(false) }, [agents.length, open])
  if (agents.length === 0) return null
  return (
    <span ref={rootRef} className={css.chips} data-task-chips="">
      <button type="button" className={css.agentChip} data-task-chip="" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className={css.blinkDot} aria-hidden />
        <span className={css.agentLabel}>{t('task.agentCount', { n: agents.length })}</span>
        <IconChevronDownOutlineRegular size={14} className={cx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open && createPortal(
        <div ref={panelRef} className={css.agentPanel} role="dialog" aria-label={t('task.agentCount', { n: agents.length })} style={{ left: pos?.left ?? 0, bottom: pos?.bottom ?? 0, visibility: pos === null ? 'hidden' : undefined }}>
          {agents.map(task => <TaskFacts key={task.id} task={task} now={now} t={t} />)}
        </div>,
        document.body,
      )}
    </span>
  )
}

function TaskOutput({ task, t, loadOutput }) {
  const [view, setView] = useState({ text: '', gap: false, error: null })
  const live = isRunning(task)
  const bash = task.kind === 'bash'
  useEffect(() => {
    // An agent's output file is its raw JSONL transcript; its reply arrives in the notification result.
    if (!bash) return
    let alive = true
    const pull = async () => {
      const answer = await loadOutput(task.id)
      if (!alive) return
      if (answer.ok) setView({ text: answer.text ?? '', gap: answer.hasEarlier === true, error: null })
      else setView(current => ({ ...current, error: answer.error }))
    }
    void pull()
    if (!live) return () => { alive = false }
    const timer = setInterval(() => { void pull() }, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [task.id, live, loadOutput, bash])
  const text = bash ? view.text : (task.result ?? '')
  return (
    <div className={css.output}>
      {view.gap && <div className={css.notice}>{t('task.output.gap')}</div>}
      {view.error !== null && <div className={cx(css.notice, css.noticeError)}>{t('task.output.error', { error: view.error })}</div>}
      {bash
        ? <TerminalBlock command={task.label} output={view.text} running={live} runStateDot={false} maxLines={Number.POSITIVE_INFINITY} copyText={task.label} labels={terminalLabels(t)} />
        : text !== '' ? <pre className={css.result}>{text}</pre> : <div className={css.notice}>{t('task.output.empty')}</div>}
    </div>
  )
}

function TaskRow({ task, now, t, expanded, onToggle, loadOutput, kill, onPressKill }) {
  const live = isRunning(task)
  const duration = taskDuration((live ? now : (task.finishedAt ?? now)) - (task.startedAt ?? now))
  const counters = taskCounters(task, now, t)
  const detail = task.kind === 'agent' && (task.result ?? '') !== '' ? '' : (task.detail ?? '')
  const stoppable = live && (task.taskId !== undefined || task.id !== task.toolUseId)
  const killTitle = kill?.state === 'armed' ? t('task.killConfirm') : kill?.state === 'failed' ? t('task.killFailed') : t('task.kill')
  const killName = kill?.state === 'armed' || kill?.state === 'failed' ? killTitle : t('task.killAria', { label: task.label })
  const labelRef = useRef(null)
  const marquee = useHoverMarquee(labelRef)
  const summaryId = useId()
  return (
    <li className={css.item}>
      <div className={cx(css.rowLine, css.rowInteractive)} data-task-row={task.id} {...marquee}>
            <button type="button" className={css.row} aria-expanded={expanded} aria-label={t(expanded ? 'task.collapseAria' : 'task.expandAria', { label: task.label })} aria-describedby={summaryId} onClick={onToggle}>
              <span className={css.glyph}><StateDot state={taskDotState(task)} /></span>
              <MarqueeText ref={labelRef} className={css.label} data-task-label="">{task.label || kindLabel(task, t)}</MarqueeText>
              <span id={summaryId} className={css.visuallyHidden}>{`${kindLabel(task, t)} · ${taskStatusLabel(task, t)}`}</span>
              <span className={css.duration}>{duration}</span>
            </button>
            <span className={css.chevron} aria-hidden><IconChevronDownOutlineRegular size={14} className={expanded ? css.chevronOpen : undefined} /></span>
            {stoppable && kill !== undefined && (
              <Tooltip label={killTitle} side="bottom" align="end" delayMs={500} portal>
                <button
                  type="button"
                  className={cx(css.stop, kill.state === 'armed' && css.stopArmed, kill.state === 'failed' && css.stopFailed)}
                  data-kill-state={kill.state}
                  disabled={kill.state === 'pending'}
                  aria-label={killName}
                  onClick={onPressKill}
                >
                  <IconStopFillRegular size={12} />
                  {kill.state === 'armed' && <span className={css.stopLabel}>{t('task.killConfirmAction')}</span>}
                </button>
              </Tooltip>
            )}
      </div>
      {expanded && (
        <div className={css.panel}>
          <div className={css.meta}>{kindLabel(task, t)} · {taskStatusLabel(task, t)}{counters !== '' && ` · ${counters}`}{detail !== '' && ` · ${detail}`}</div>
          <TaskOutput task={task} t={t} loadOutput={loadOutput} />
        </div>
      )}
    </li>
  )
}

/**
 * Background tasks in dsh's jobs-section shape: 28px rows with a state dot,
 * the command, a live clock and an expandable terminal; finished rows fold
 * into a counted group that can be cleared.
 */
export function TasksPanel({ tasks, t, loadOutput, onClear, stopTask }) {
  const [expanded, setExpanded] = useState({})
  const [settledChoice, setSettledChoice] = useState(null)
  const [liveFolded, setLiveFolded] = useState(true)
  const [settledFolded, setSettledFolded] = useState(true)
  const [kill, setKill] = useState(undefined)
  const ordered = [...tasks].sort((left, right) => {
    const liveLeft = isRunning(left)
    if (liveLeft !== isRunning(right)) return liveLeft ? -1 : 1
    if (liveLeft) return (right.startedAt ?? 0) - (left.startedAt ?? 0)
    const finished = (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0)
    return finished !== 0 ? finished : (left.startedAt ?? 0) - (right.startedAt ?? 0)
  })
  const live = ordered.filter(isRunning)
  const settled = ordered.filter(task => !isRunning(task))
  const now = useNow(live.length > 0)
  useEffect(() => {
    if (kill === undefined || kill.state === 'pending') return
    const timer = setTimeout(() => setKill(undefined), kill.state === 'armed' ? KILL_ARM_MS : KILL_FAILED_MS)
    return () => clearTimeout(timer)
  }, [kill])
  useEffect(() => {
    if (kill !== undefined && !tasks.some(task => task.id === kill.key && isRunning(task))) setKill(undefined)
  }, [tasks, kill])
  if (tasks.length === 0) return null
  const settledOpen = settledChoice ?? live.length === 0
  const liveFoldable = live.length > FOLD_LIMIT + 1
  const shownLive = liveFoldable && liveFolded ? live.slice(0, FOLD_LIMIT) : live
  const settledFoldable = settled.length > FOLD_LIMIT + 1
  const shownSettled = settledOpen ? (settledFoldable && settledFolded ? settled.slice(0, FOLD_LIMIT) : settled) : []
  const pressKill = task => {
    if (kill?.key !== task.id || kill.state !== 'armed') { setKill({ key: task.id, state: 'armed' }); return }
    setKill({ key: task.id, state: 'pending' })
    void stopTask(task.id).then(answer => {
      if (answer.ok && answer.error === undefined) return
      setKill(current => current?.key === task.id ? { key: task.id, state: 'failed' } : current)
    })
  }
  const fold = (open, onToggle, label) => (
    <li className={css.fold}>
      <button type="button" className={css.foldButton} onClick={onToggle}>
        <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : css.foldChevron} />
        {label}
      </button>
    </li>
  )
  const row = task => (
    <TaskRow
      key={task.id}
      task={task}
      now={now}
      t={t}
      expanded={expanded[task.id] === true}
      onToggle={() => setExpanded(current => ({ ...current, [task.id]: !current[task.id] }))}
      loadOutput={loadOutput}
      kill={isRunning(task) ? (kill?.key === task.id ? kill : { state: 'idle' }) : undefined}
      onPressKill={() => pressKill(task)}
    />
  )
  return (
    <section className={css.section} data-tasks-panel="" aria-label={t('task.title')}>
      <div className={css.head}>
        <h2 className={css.title}>{t('task.title')}</h2>
      </div>
      <div className={css.listWrap}>
        <ul className={css.list}>
          {shownLive.map(row)}
          {liveFoldable && fold(!liveFolded, () => setLiveFolded(v => !v), liveFolded ? t('task.liveMore', { n: live.length - FOLD_LIMIT }) : t('task.less'))}
          {settled.length > 0 && (
            <li className={css.sectionHeader}>
              <button type="button" className={css.sectionToggle} aria-expanded={settledOpen} onClick={() => setSettledChoice(!settledOpen)}>
                {t('task.settledCount', { n: settled.length })}
                <IconChevronDownOutlineRegular size={14} className={settledOpen ? css.chevronOpen : css.foldChevron} />
              </button>
              <button type="button" className={css.sectionClear} onClick={onClear}>{t('task.clear')}</button>
            </li>
          )}
          {shownSettled.map(row)}
          {settledOpen && settledFoldable && fold(!settledFolded, () => setSettledFolded(v => !v), settledFolded ? t('task.settledMore', { n: settled.length - FOLD_LIMIT }) : t('task.less'))}
        </ul>
      </div>
    </section>
  )
}
