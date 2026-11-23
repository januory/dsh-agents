import { useEffect, useState } from 'react'
import { HoverCard, HoverCardGroup, IconChevronDownOutlineRegular, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { taskCounters, taskDotState, taskDuration, taskStatusLabel, terminalLabels, tokenCount } from './labels.js'
import css from './Tasks.module.css'

const FOLD_LIMIT = 5
const CHIP_LIMIT = 2

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

function activityOf(task) {
  return task.progress || task.lastTool || ''
}

function agentLabel(task, t) {
  const name = task.subagentType || t('task.agent')
  const activity = activityOf(task)
  const label = task.label || ''
  if (activity !== '' && activity !== label) return `${name}: ${activity}`
  return label === '' ? name : `${name}: ${label}`
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
  if (agents.length === 0) return null
  const shown = agents.slice(0, CHIP_LIMIT)
  const rest = agents.slice(CHIP_LIMIT)
  const restTokens = rest.reduce((sum, task) => sum + (task.tokens ?? 0), 0)
  return (
    <HoverCardGroup className={css.chips} as="div">
      <div className={css.chips} data-task-chips="">
        {shown.map(task => {
          const counters = taskCounters(task, now, t)
          return (
            <HoverCard
              key={task.id}
              grouped
              content={<TaskFacts task={task} now={now} t={t} />}
              anchor={(
                <span className={css.agentChip} data-task-chip={task.id}>
                  <span className={css.blinkDot} aria-hidden />
                  <span className={css.agentLabel}>{agentLabel(task, t)}</span>
                  {counters !== '' && <span className={css.agentCounters}>{counters}</span>}
                </span>
              )}
            />
          )
        })}
        {rest.length > 0 && (
          <HoverCard
            grouped
            content={(
              <div className={css.facts}>
                {rest.map(task => <div key={task.id} className={css.factLine}>{agentLabel(task, t)} · {taskCounters(task, now, t)}</div>)}
              </div>
            )}
            anchor={(
              <span className={css.agentChip} data-task-chip-overflow="">
                <span className={css.agentCounters}>{t('task.moreAgents', { n: rest.length })}{restTokens > 0 && ` · ${t('task.tokens', { n: tokenCount(restTokens) })}`}</span>
              </span>
            )}
          />
        )}
      </div>
    </HoverCardGroup>
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

function TaskRow({ task, now, t, expanded, onToggle, loadOutput }) {
  const live = isRunning(task)
  const duration = taskDuration((live ? now : (task.finishedAt ?? now)) - (task.startedAt ?? now))
  const counters = taskCounters(task, now, t)
  const detail = task.kind === 'agent' && (task.result ?? '') !== '' ? '' : (task.detail ?? '')
  return (
    <li className={css.item}>
      <HoverCard
        grouped
        disabled={expanded}
        content={<TaskFacts task={task} now={now} t={t} />}
        anchor={(
          <div className={cx(css.rowLine, css.rowInteractive)} data-task-row={task.id}>
            <button type="button" className={css.row} aria-expanded={expanded} aria-label={t(expanded ? 'task.collapseAria' : 'task.expandAria', { label: task.label })} onClick={onToggle}>
              <span className={css.glyph}><StateDot state={taskDotState(task)} /></span>
              <span className={css.label}>{task.label || kindLabel(task, t)}</span>
              {task.kind === 'agent' && counters !== '' && <span className={css.counters}>{counters}</span>}
              <span className={css.duration}>{duration}</span>
            </button>
            <span className={css.chevron} aria-hidden><IconChevronDownOutlineRegular size={14} className={expanded ? css.chevronOpen : undefined} /></span>
          </div>
        )}
      />
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
export function TasksPanel({ tasks, t, loadOutput, onClear }) {
  const [expanded, setExpanded] = useState({})
  const [settledOpen, setSettledOpen] = useState(false)
  const [liveFolded, setLiveFolded] = useState(true)
  const live = tasks.filter(isRunning)
  const settled = tasks.filter(task => !isRunning(task))
  const now = useNow(live.length > 0)
  if (tasks.length === 0) return null
  const liveFoldable = live.length > FOLD_LIMIT + 1
  const shownLive = liveFoldable && liveFolded ? live.slice(0, FOLD_LIMIT) : live
  const shownSettled = settledOpen ? settled : []
  const fold = (open, onToggle, count) => (
    <li className={css.fold}>
      <button type="button" className={css.foldButton} onClick={onToggle}>
        <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : css.foldChevron} />
        {open ? t('task.less') : t('task.more', { n: count })}
      </button>
    </li>
  )
  const row = task => (
    <TaskRow key={task.id} task={task} now={now} t={t} expanded={expanded[task.id] === true} onToggle={() => setExpanded(current => ({ ...current, [task.id]: !current[task.id] }))} loadOutput={loadOutput} />
  )
  return (
    <section className={css.section} data-tasks-panel="" aria-label={t('task.title')}>
      <div className={css.head}>
        <h2 className={css.title}>{t('task.title')}</h2>
        {live.length > 0 && <span className={css.running}><StateDot state="ongoing" size={10} />{t('task.running', { n: live.length })}</span>}
      </div>
      <HoverCardGroup className={css.listWrap} as="div">
        <ul className={css.list}>
          {shownLive.map(row)}
          {liveFoldable && fold(!liveFolded, () => setLiveFolded(v => !v), live.length - FOLD_LIMIT)}
          {settled.length > 0 && (
            <li className={css.sectionHeader}>
              <button type="button" className={css.sectionToggle} aria-expanded={settledOpen} onClick={() => setSettledOpen(v => !v)}>
                {t('task.settledCount', { n: settled.length })}
                <IconChevronDownOutlineRegular size={14} className={settledOpen ? css.chevronOpen : css.foldChevron} />
              </button>
              <button type="button" className={css.sectionClear} onClick={onClear}>{t('task.clear')}</button>
            </li>
          )}
          {shownSettled.map(row)}
        </ul>
      </HoverCardGroup>
    </section>
  )
}
