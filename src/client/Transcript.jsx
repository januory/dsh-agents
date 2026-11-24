import { memo, useEffect, useRef, useState } from 'react'
import {
  Button, CodeBlock, DisclosureRow, IconCheckOutlineMedium, IconChevronDownOutlineRegular, IconCloseOutlineMedium, IconCodeOutlineMedium, IconEditOutlineMedium, IconFilesDiffOutlineMedium,
  IconGlobeOutlineMedium, IconSearchOutlineMedium, IconThinkOutlineMedium, IconWarningOutlineMedium, ImageLightbox, JsonTree, MarkdownText, StateDot, Tag, TerminalBlock, TextShimmer, UserMessageBubble,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SourceIcon, sourceColor } from './SourceIcon.jsx'
import { basename, jsonLabels, markdownLabels, runDuration, taskStatusLabel, terminalLabels } from './labels.js'
import { attachmentUrl } from './uploads.js'
import { groupTurns } from './transcript-groups.js'
import css from './Transcript.module.css'

const TOOL_ICONS = {
  bash: IconCodeOutlineMedium,
  read: IconFilesDiffOutlineMedium,
  edit: IconEditOutlineMedium,
  search: IconSearchOutlineMedium,
  web: IconGlobeOutlineMedium,
}

function toolKind(name) {
  const n = (name ?? '').toLowerCase()
  if (n === 'bash' || n.includes('shell') || n.includes('exec') || n === 'powershell') return 'bash'
  if (n === 'read' || n === 'viewimage' || n.includes('read')) return 'read'
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n.includes('patch') || n.includes('notebook')) return 'edit'
  if (n === 'grep' || n === 'glob' || n.includes('search') && !n.includes('web')) return 'search'
  if (n.includes('web') || n.includes('fetch') || n.includes('browser')) return 'web'
  return 'other'
}

function langOf(path) {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? ''
  const map = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp', sh: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte', sql: 'sql', lua: 'lua', php: 'php', xml: 'xml', ini: 'ini', txt: 'text' }
  return map[ext] ?? (ext || undefined)
}

function toolSummary(event) {
  const input = event.input ?? {}
  const kind = toolKind(event.name)
  if (kind === 'bash') return typeof input.command === 'string' ? input.command : event.name
  if (kind === 'read' || kind === 'edit') return basename(input.file_path ?? input.path ?? input.filePath ?? '') || event.name
  if (kind === 'search') return String(input.pattern ?? input.query ?? input.path ?? event.name)
  if (kind === 'web') return String(input.url ?? input.query ?? event.name)
  if (event.name === 'TodoWrite') return 'Todo'
  if (event.name === 'Agent' || event.name === 'Task') return String(input.description ?? input.subagent_type ?? event.name)
  return event.name ?? ''
}

function patchToDiff(patch, path) {
  const lines = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of patch) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines ?? []) lines.push(line)
  }
  return lines.join('\n')
}

function diffTextOf(event) {
  const input = event.input ?? {}
  const structured = event.structured ?? {}
  const path = input.file_path ?? structured.filePath ?? ''
  if (Array.isArray(structured.structuredPatch) && structured.structuredPatch.length > 0) return patchToDiff(structured.structuredPatch, path)
  if (Array.isArray(structured.changes)) {
    return structured.changes.map(change => {
      const diff = change.diff ?? ''
      return diff.startsWith('---') ? diff : `--- a/${change.path}\n+++ b/${change.path}\n${diff}`
    }).join('\n')
  }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [`--- a/${path}`, `+++ b/${path}`, ...input.old_string.split('\n').map(l => `-${l}`), ...input.new_string.split('\n').map(l => `+${l}`)].join('\n')
  }
  if (typeof input.content === 'string') return input.content
  return ''
}

// dsh's lone-image rule: long edge 240px, aspect clamped to [0.25, 4], never upscaled.
function singleFit({ width, height }) {
  const natural = width / height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, width / box.width, height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

function UserImage({ id, single, t }) {
  const src = attachmentUrl(id)
  const [size, setSize] = useState(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const fit = single ? (size === null ? { width: 240, height: 240, objectPosition: 'center' } : singleFit(size)) : null
  return (
    <>
      <button
        type="button"
        className={css.imageFrame}
        style={fit === null ? undefined : { width: fit.width, height: fit.height }}
        title={t('image.openOriginal')}
        aria-label={t('image.openOriginal')}
        disabled={failed}
        onClick={() => setOpen(true)}
      >
        {failed ? <span className={css.imageFailed}>{t('image.loadFailed')}</span>
          : <img src={src} alt={t('image.label')} style={fit === null ? undefined : { objectPosition: fit.objectPosition }} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />}
      </button>
      {open && <ImageLightbox src={src} alt={t('image.original')} labels={{ dialog: t('image.preview'), close: t('image.closePreview') }} onClose={() => setOpen(false)} />}
    </>
  )
}

const UserItem = memo(function UserItem({ event, t }) {
  const images = event.images ?? []
  return (
    <div className={css.userRow}>
      <div className={css.userStack}>
        {images.length > 0 && (
          <div className={css.userImages}>
            {images.map(image => <UserImage key={image.id} id={image.id} single={images.length === 1} t={t} />)}
          </div>
        )}
        {event.imageCount > 0 && <div className={css.userImages}><Tag tone="quiet">{t('image.count', { n: event.imageCount })}</Tag></div>}
        {(event.text ?? '') !== '' && <UserMessageBubble className={css.userBubble}>{event.text}</UserMessageBubble>}
      </div>
    </div>
  )
})

const AssistantItem = memo(function AssistantItem({ event, t }) {
  return (
    <div className={cx(css.assistantRow, event.commentary && css.commentary)}>
      <MarkdownText text={event.text ?? ''} streaming={event.done === false} labels={markdownLabels(t)} />
    </div>
  )
})

const ThinkingItem = memo(function ThinkingItem({ event, t }) {
  const running = event.done === false
  const [manual, setManual] = useState(null)
  const block = useRef(event.id)
  if (block.current !== event.id) {
    block.current = event.id
    setManual(null)
  }
  // Streams open so the thinking reads live; a manual toggle wins until the
  // next block, and finished blocks rest collapsed.
  const open = manual ?? running
  return (
    <DisclosureRow
      icon={<IconThinkOutlineMedium size={14} />}
      title={running ? t('thinking.running') : t('thinking.title')}
      open={open}
      expandable
      expandOnRowClick
      running={running}
      onToggle={() => setManual(!open)}
      className={css.disclosure}
    >
      <div className={css.disclosureContent}>
        <MarkdownText text={event.text ?? ''} streaming={event.done === false} variant="compact" labels={markdownLabels(t)} />
      </div>
    </DisclosureRow>
  )
})

const ToolItem = memo(function ToolItem({ event, t, task }) {
  const [manual, setManual] = useState(null)
  const kind = toolKind(event.name)
  const Icon = TOOL_ICONS[kind] ?? IconCodeOutlineMedium
  const running = event.status === 'running'
  const failed = event.status === 'error' || event.isError === true
  const summary = toolSummary(event)
  const input = event.input ?? {}
  const background = kind === 'bash' && (task?.background === true || input.run_in_background === true)
  const output = event.output ?? (typeof event.inputText === 'string' ? event.inputText : '')
  const diff = kind === 'edit' ? diffTextOf(event) : ''
  const images = event.images ?? []
  // Image reads open so the preview is visible; a manual toggle wins.
  const open = manual ?? images.length > 0
  const thumbs = images.length > 0 ? (
    <div className={css.toolImages}>
      {images.map(image => <UserImage key={image.id} id={image.id} single={images.length === 1} t={t} />)}
    </div>
  ) : null
  let body
  if (kind === 'bash') {
    body = <TerminalBlock command={String(input.command ?? '')} cwd={typeof input.cwd === 'string' ? input.cwd : undefined} output={output} exitCode={event.exitCode} running={running} background={background} labels={terminalLabels(t)} maxLines={12} />
  } else if (diff !== '') {
    body = <CodeBlock code={diff} lang={kind === 'edit' && typeof input.content === 'string' && !event.structured ? langOf(input.file_path) : 'diff'} diff={!(typeof input.content === 'string' && !event.structured)} copyLabel={t('copy')} copiedLabel={t('copied')} />
  } else if (kind === 'read' && output !== '' && images.length === 0) {
    body = <CodeBlock code={output} lang={langOf(input.file_path ?? input.path)} lineNumbers copyLabel={t('copy')} copiedLabel={t('copied')} />
  } else {
    body = (
      <div className={css.genericTool}>
        {input !== null && typeof input === 'object' && Object.keys(input).length > 0 && <JsonTree data={input} label={t('tool.input')} labels={jsonLabels(t)} collapsedStringLines={4} />}
        {output !== '' && images.length === 0 && <CodeBlock code={output} copyLabel={t('copy')} copiedLabel={t('copied')} />}
        {output === '' && images.length === 0 && !running && <div className={css.muted}>{t('tool.noOutput')}</div>}
      </div>
    )
  }
  return (
    <DisclosureRow
      icon={<Icon size={14} />}
      title={summary}
      open={open}
      expandable
      expandOnRowClick
      running={running}
      onToggle={() => setManual(!open)}
      className={cx(css.disclosure, failed && css.failed)}
      rowClassName={css.toolRow}
      titleClassName={kind === 'bash' ? css.mono : undefined}
      headerAccessory={task !== undefined ? <Tag tone={task.status === 'failed' ? 'danger' : task.status === 'running' || task.status === 'completed' ? 'quiet' : 'warning'}>{taskStatusLabel(task, t)}</Tag>
        : failed ? <Tag tone="danger">{t('tool.error')}</Tag> : event.exitCode !== undefined && event.exitCode !== 0 ? <Tag tone="warning">{t('tool.exitCode', { code: event.exitCode })}</Tag> : undefined}
    >
      <div className={css.disclosureContent}>{thumbs}{body}</div>
    </DisclosureRow>
  )
})

const ApprovalItem = memo(function ApprovalItem({ event, t, onAnswer }) {
  const pending = event.status === 'running'
  const input = event.input ?? {}
  const preview = typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)
  const decisionLabel = event.decision === 'deny' ? t('approval.denied') : event.decision === 'allow_session' ? t('approval.approvedSession') : t('approval.approved')
  return (
    <div className={cx(css.approval, !pending && css.approvalResolved)} role={pending ? 'alertdialog' : undefined} aria-label={t('approval.title', { name: event.name ?? '' })}>
      <div className={css.approvalHead}>
        <IconWarningOutlineMedium size={14} />
        <span className={css.approvalTitle}>{t('approval.title', { name: event.name ?? '' })}</span>
        {!pending && <Tag tone={event.decision === 'deny' ? 'danger' : 'success'}>{decisionLabel}</Tag>}
      </div>
      {event.message && <div className={css.approvalReason}>{event.message}</div>}
      <pre className={css.approvalPreview}>{preview}</pre>
      {pending && (
        <div className={css.approvalActions}>
          <Button variant="primary" size="sm" icon={<IconCheckOutlineMedium size={14} />} onClick={() => onAnswer(event.requestId, 'allow')}>{t('approval.allow')}</Button>
          {(event.options ?? []).includes('allow_session') && <Button variant="outline" size="sm" onClick={() => onAnswer(event.requestId, 'allow_session')}>{t('approval.allowSession')}</Button>}
          <Button variant="outline" size="sm" className={css.danger} icon={<IconCloseOutlineMedium size={14} />} onClick={() => onAnswer(event.requestId, 'deny')}>{t('approval.deny')}</Button>
        </div>
      )}
    </div>
  )
})

function ErrorItem({ event }) {
  return (
    <div className={css.errorRow}>
      <IconWarningOutlineMedium size={14} />
      <span>{event.message}</span>
    </div>
  )
}

function CompactItem({ t }) {
  return <div className={css.compactRow}>{t('turn.compact')}</div>
}

const QuestionItem = memo(function QuestionItem({ event, t, onQuestion }) {
  const questions = event.questions ?? []
  const pending = event.status === 'running'
  const [selected, setSelected] = useState(() => questions.map(() => []))
  const [custom, setCustom] = useState(() => questions.map(() => ''))
  const answersFor = i => {
    const text = custom[i].trim()
    if (text !== '') return questions[i].multiSelect ? [...selected[i], text] : [text]
    return selected[i]
  }
  const complete = questions.every((q, i) => answersFor(i).length > 0)
  const toggle = (i, label) => {
    setSelected(prev => prev.map((list, j) => {
      if (j !== i) return list
      if (questions[i].multiSelect) return list.includes(label) ? list.filter(x => x !== label) : [...list, label]
      return list.includes(label) ? [] : [label]
    }))
    if (!questions[i].multiSelect) setCustom(prev => prev.map((c, j) => (j === i ? '' : c)))
  }
  const submit = answers => { if (pending) onQuestion(event.requestId, answers) }
  return (
    <div className={cx(css.question, !pending && css.questionResolved)} role={pending ? 'alertdialog' : undefined} aria-label={t('question.title')}>
      {questions.map((q, i) => (
        <div key={q.key ?? i} className={css.questionBlock}>
          {q.header && <div className={css.questionEyebrow}>{q.header}</div>}
          <div className={css.questionTitle}>{q.question}</div>
          <div className={css.questionOptions}>
            {(q.options ?? []).map((opt, oi) => {
              const on = selected[i].includes(opt.label)
              return (
                <div key={opt.label} className={cx(css.questionOptionRow, on && css.questionOptionSelected)}>
                  <button type="button" className={css.questionOption} disabled={!pending} onClick={() => toggle(i, opt.label)}>
                    {q.multiSelect
                      ? <span className={cx(css.questionCheckbox, on && css.questionCheckboxChecked)} aria-hidden>{on && <IconCheckOutlineMedium size={12} />}</span>
                      : <span className={css.questionNumber} aria-hidden>{oi + 1}</span>}
                    <span className={css.questionCopy}>
                      <span className={css.questionLabel}>{opt.label}</span>
                      {opt.description && <span className={css.questionDesc}>{opt.description}</span>}
                    </span>
                  </button>
                </div>
              )
            })}
            <div className={cx(css.questionOptionRow, css.questionCustomRow, custom[i].trim() !== '' && css.questionOptionSelected)}>
              <span className={cx(css.questionCheckbox, custom[i].trim() !== '' && css.questionCheckboxChecked)} aria-hidden>{custom[i].trim() !== '' && <IconCheckOutlineMedium size={12} />}</span>
              <input
                className={css.questionCustom}
                value={custom[i]}
                disabled={!pending}
                placeholder={t('question.other')}
                aria-label={t('question.other')}
                onChange={e => {
                  const v = e.target.value
                  setCustom(prev => prev.map((c, j) => (j === i ? v : c)))
                  if (!questions[i].multiSelect && v.trim() !== '') setSelected(prev => prev.map((list, j) => (j === i ? [] : list)))
                }}
              />
            </div>
          </div>
        </div>
      ))}
      {pending ? (
        <div className={css.questionFooter}>
          <Button variant="primary" size="sm" disabled={!complete} onClick={() => submit(questions.map((q, i) => answersFor(i)))}>{t('question.submit')}</Button>
          <Button variant="outline" size="sm" onClick={() => submit(questions.map(() => []))}>{t('question.skip')}</Button>
        </div>
      ) : (
        <div className={css.questionAnswered}>
          {(event.answers ?? []).map((list, i) => (list ?? []).length > 0 && <Tag key={i} tone="quiet">{list.join(', ')}</Tag>)}
          {(event.answers ?? []).every(list => (list ?? []).length === 0) && <span className={css.muted}>{t('question.skipped')}</span>}
        </div>
      )}
    </div>
  )
})

export function TranscriptItem({ event, t, task, onAnswer, onQuestion }) {
  switch (event.type) {
    case 'user': return <UserItem event={event} t={t} />
    case 'assistant': return <AssistantItem event={event} t={t} />
    case 'thinking': return <ThinkingItem event={event} t={t} />
    case 'tool': return <ToolItem event={event} t={t} task={task} />
    case 'approval': return <ApprovalItem event={event} t={t} onAnswer={onAnswer} />
    case 'question': return <QuestionItem event={event} t={t} onQuestion={onQuestion} />
    case 'error': return <ErrorItem event={event} />
    case 'turn': return event.reason === 'compact' ? <CompactItem t={t} /> : null
    default: return null
  }
}

function flowKind(event) {
  if (event.type === 'turn') return 'compact'
  return event.type
}

// dsh walks a Turn in order: a run of process rows (thinking/tools) folds as a
// group, an assistant reply flushes that group and stands in its own place, so
// replies keep their chronological position instead of clumping at the end.
function TurnProcessHeader({ open, duration, t, onToggle }) {
  return (
    <button type="button" className={css.turnProcess} data-open={open || undefined} aria-expanded={open} onClick={onToggle}>
      <span className={css.turnProcessLabel}>{t('turn.took', { duration })}</span>
      <IconChevronDownOutlineRegular className={css.turnProcessChevron} />
    </button>
  )
}

export function Transcript({ events, limit, t, tasks, live, onAnswer, onQuestion, onEarlier }) {
  const start = Math.max(0, events.length - limit)
  const shown = events.slice(start)
  const byTool = new Map()
  for (const task of tasks ?? []) if (task.toolUseId !== undefined) byTool.set(task.toolUseId, task)
  const [manual, setManual] = useState({})
  const turns = groupTurns(shown)
  const rows = []
  const item = event => <div key={event.id} className={css.flowItem} data-dag-flow={flowKind(event)}><TranscriptItem event={event} t={t} task={byTool.get(event.id)} onAnswer={onAnswer} onQuestion={onQuestion} /></div>
  turns.forEach((turn, i) => {
    const isLast = i === turns.length - 1
    const turnLive = isLast && live === true
    if (turn.user !== undefined) rows.push(item(turn.user))
    turn.segments.forEach((segment, si) => {
      if (segment.kind === 'response') {
        for (const event of segment.events) rows.push(item(event))
        return
      }
      // dsh: the latest turn stays open until the next input; older turns fold.
      // A live turn never folds and shows no header.
      const key = `${turn.id}:${si}`
      const open = turnLive || (manual[key] ?? isLast)
      if (!turnLive) {
        const times = segment.events.map(e => e.ts)
        const duration = runDuration(Math.max(1000, Math.max(...times) - Math.min(...times)), t)
        rows.push(
          <div key={key} className={css.flowItem} data-dag-flow="turnprocess">
            <TurnProcessHeader open={open} duration={duration} t={t} onToggle={() => setManual(prev => ({ ...prev, [key]: !open }))} />
          </div>,
        )
      }
      if (open || turnLive) for (const event of segment.events) rows.push(item(event))
    })
  })
  return (
    <div className={css.transcript}>
      {start > 0 && <button type="button" className={css.earlier} onClick={onEarlier}>{t('page.earlier', { n: Math.min(start, 300) })}</button>}
      {rows}
    </div>
  )
}

export function TurnStatus({ turn, name, source, t }) {
  const live = turn !== null && (turn.status === 'running' || turn.status === 'starting')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, turn?.startedAt])
  if (turn === null) return null
  if (live) {
    const duration = runDuration(Math.max(1000, now - (turn.startedAt ?? now)), t)
    return (
      <div className={cx(css.status, css.statusLive)} style={{ '--dag-status-color': sourceColor(source) }}>
        <SourceIcon source={source} size={14} />
        <TextShimmer active className={css.statusText}>{t('status.workingFor', { name, duration })}</TextShimmer>
      </div>
    )
  }
  if (turn.status === 'awaiting') return <div className={css.status}><StateDot state="warning" /><span>{t('row.awaiting')}</span></div>
  if (turn.status === 'error') return <div className={cx(css.status, css.statusError)}><StateDot state="error" /><span>{turn.error ?? t('turn.error')}</span></div>
  if (turn.status === 'cancelled') return <div className={css.status}><StateDot state="idle" /><span>{t('turn.cancelled')}</span></div>
  return null
}
