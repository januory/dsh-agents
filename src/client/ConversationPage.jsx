import { useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronLeftOutlineMedium, IconFlatListOutlineRegular, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SourceIcon } from './SourceIcon.jsx'
import { Composer } from './Composer.jsx'
import { Transcript, TurnStatus } from './Transcript.jsx'
import { TasksPanel } from './Tasks.jsx'
import { isLive, workspaceOptions } from './controller.js'
import css from './ConversationPage.module.css'

function useStickToBottom(dep) {
  const ref = useRef(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48 }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

/**
 * The centre-column page for a foreign CLI session: transcript on top, the
 * composer below. It is a root main panel, so it carries no dsh session.
 */
export function ConversationPage(props) {
  const { t, useAgentView, useAgentTranscript, useAgentProviders, useAgentSessions, useAgentSettings, useAgentModels, usePickerDirectoryFlow, send, cancel, answer, answerQuestion, loadTaskOutput, clearTasks, stopTask, showEarlier, setSource, setLaunch, addWorkspace, directoryFlowOccupant } = props
  const source = useAgentView(s => s.source)
  const transcript = useAgentTranscript(s => s)
  const providers = useAgentProviders(s => s.list)
  const bucket = useAgentSessions(s => s.byProvider[source])
  const defaults = useAgentSettings(s => s.providers[source])
  const models = useAgentModels(s => s.byProvider[source])
  const chosen = useAgentView(s => s.launch[source])
  const launch = { permissionMode: chosen?.permissionMode ?? defaults?.permissionMode ?? '', model: chosen?.model ?? defaults?.model ?? '', effort: chosen?.effort ?? defaults?.effort ?? '' }
  const provider = providers.find(p => p.id === source)
  const name = provider?.label ?? source
  const session = transcript.session
  const isNew = session === null && !transcript.loading
  const busy = transcript.sending || (transcript.turn !== null && isLive(transcript.turn.status))
  const workspaces = useMemo(() => workspaceOptions(bucket), [bucket?.list, bucket?.workspaces])
  const last = transcript.events[transcript.events.length - 1]
  const scrollRef = useStickToBottom(`${transcript.key}:${transcript.events.length}:${last?.text?.length ?? 0}:${last?.output?.length ?? 0}`)
  const [overlay, setOverlay] = useState(null)
  const frameRef = useRef(null)
  const seatRef = useRef(null)
  const panelRef = useRef(null)
  const toggleRef = useRef(null)
  const tasks = transcript.tasks ?? []
  const runningTasks = tasks.filter(task => task.status === 'running').length
  const blank = isNew && transcript.events.length === 0 && !transcript.sending && transcript.error === null
  const sessionKey = `${source}:${session?.id ?? 'new'}`
  const panelShown = tasks.length > 0 && overlay === sessionKey
  const togglePanel = () => setOverlay(current => current === sessionKey ? null : sessionKey)

  useEffect(() => {
    const frame = frameRef.current
    const seat = seatRef.current
    if (frame === null || seat === null) return
    const measure = () => {
      frame.style.setProperty('--dag-composer-height', `${seat.getBoundingClientRect().height}px`)
      const toggle = toggleRef.current
      if (toggle === null) return
      const left = toggle.getBoundingClientRect().left - frame.getBoundingClientRect().left
      frame.style.setProperty('--dag-panel-left', `${Math.max(8, Math.min(left, frame.clientWidth - 368))}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    observer.observe(seat)
    return () => observer.disconnect()
  }, [blank, source, overlay, transcript.key])

  useEffect(() => {
    if (overlay === null) return
    const onPointerDown = event => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (panelRef.current?.contains(target) === true || toggleRef.current?.contains(target) === true || target.closest('[role="menu"]') !== null) return
      setOverlay(null)
    }
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"]') !== null) return
      setOverlay(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overlay])

  if (source === 'dsh') return null

  let disabledReason
  if (provider !== undefined && !provider.available) disabledReason = t('list.unavailable', { name, error: provider.error ?? '' })
  else if (provider?.authenticated === false) disabledReason = t('auth.login', { command: provider.id })
  else if (session?.live !== undefined && !busy) {
    disabledReason = session.live.pid !== undefined ? t('composer.elsewhere', { name, pid: session.live.pid }) : t('composer.elsewhereNoPid', { name })
  }
  const sendError = transcript.error === null ? undefined
    : transcript.error === 'no-cwd' ? t('error.noCwd')
      : transcript.error === 'busy' ? t('error.busy')
        : t('error.send', { error: transcript.error })

  const title = session === null ? t('page.new', { name }) : (session.title || t('row.untitled'))
  const draftKey = `${source}:${session?.id ?? 'new'}`
  const composer = (
    <Composer
      key={draftKey}
      draftKey={draftKey}
      t={t}
      name={name}
      provider={provider}
      session={session}
      isNew={isNew}
      hero={blank}
      busy={busy}
      sending={transcript.sending}
      disabledReason={disabledReason}
      launch={launch}
      tasks={transcript.tasks ?? []}
      usage={transcript.usage ?? null}
      models={models}
      workspaces={workspaces}
      initialCwd={transcript.cwd}
      newNonce={transcript.newNonce}
      directoryFlowOccupant={directoryFlowOccupant}
      useDirectoryFlow={usePickerDirectoryFlow}
      addWorkspace={addWorkspace}
      onLaunch={patch => setLaunch(source, patch)}
      onStop={() => { void cancel() }}
      onSend={request => send(source, { sessionId: session?.id, ...request })}
    />
  )
  if (blank) {
    return (
      <div className={css.page}>
        <header className={css.header}>
          <Tooltip label={t('page.back')} side="bottom" delayMs={400}>
            <button type="button" className={css.back} aria-label={t('page.back')} onClick={() => setSource('dsh')}>
              <IconChevronLeftOutlineMedium size={14} />
            </button>
          </Tooltip>
          <SourceIcon source={source} size={16} className={css.mark} />
          <div className={css.heading}><div className={css.title} title={title}>{title}</div></div>
        </header>
        <div className={css.body}>
          <div className={css.hero}>
            <SourceIcon source={source} size={28} />
            <div className={css.heroTitle}>{t('page.new', { name })}</div>
            <div className={css.heroComposer}>{composer}</div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={css.page}>
      <header className={css.header}>
        <Tooltip label={t('page.back')} side="bottom" delayMs={400}>
          <button type="button" className={css.back} aria-label={t('page.back')} onClick={() => setSource('dsh')}>
            <IconChevronLeftOutlineMedium size={14} />
          </button>
        </Tooltip>
        <SourceIcon source={source} size={16} className={css.mark} />
        <div className={css.heading}>
          <div className={css.title} title={title}>{title}</div>
          {session?.live !== undefined && (
            <div className={css.meta}>
              <Tag tone="warning">{session.live.pid !== undefined ? t('composer.elsewhere', { name, pid: session.live.pid }) : t('row.elsewhere')}</Tag>
            </div>
          )}
        </div>
        {tasks.length > 0 && (
          <Tooltip label={t(panelShown ? 'task.hidePanel' : 'task.showPanel')} side="bottom" delayMs={400}>
            <button type="button" ref={toggleRef} className={css.headerJobs} aria-expanded={panelShown} aria-label={t('task.headerCount', { n: tasks.length })} onClick={togglePanel}>
              {runningTasks > 0
                ? (
                  <svg className={css.jobsSpinner} viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
                    <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )
                : <IconFlatListOutlineRegular size={12} />}
              <span>{t('task.headerCount', { n: tasks.length })}</span>
            </button>
          </Tooltip>
        )}
      </header>
      <div className={css.frame} ref={frameRef}>
        <div className={css.body} ref={scrollRef}>
          <div className={css.view}>
            {transcript.loading ? <div className={css.center}>{t('page.loading')}</div>
              : transcript.error !== null && transcript.events.length === 0 ? <div className={cx(css.center, css.error)}>{t('page.error', { error: transcript.error })}</div>
                : transcript.events.length === 0 ? (
                  <div className={css.hero}>
                    <SourceIcon source={source} size={28} />
                    <div className={css.heroTitle}>{t('row.untitled')}</div>
                  </div>
                ) : (
                  <>
                    {session?.hasEarlier && <div className={css.truncated}>{t('page.truncated')}</div>}
                    <Transcript events={transcript.events} limit={transcript.historyLimit} t={t} tasks={transcript.tasks ?? []} onAnswer={answer} onQuestion={answerQuestion} onEarlier={showEarlier} />
                  </>
                )}
            {transcript.turn !== null && transcript.turn.status !== 'done' && (
              <div className={css.statusRow}><TurnStatus turn={transcript.turn} name={name} source={source} t={t} /></div>
            )}
          </div>
          <div className={css.composerSeat} ref={seatRef}>
            {sendError !== undefined && !transcript.loading && <div className={css.sendError} role="alert">{sendError}</div>}
            {composer}
          </div>
        </div>
        {panelShown && (
          <aside className={css.panel} ref={panelRef} aria-label={t('task.title')}>
            <TasksPanel key={sessionKey} tasks={tasks} t={t} loadOutput={loadTaskOutput} onClear={clearTasks} stopTask={stopTask} />
          </aside>
        )}
      </div>
    </div>
  )
}
