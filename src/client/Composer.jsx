import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconCloseFillRegular, IconDataOutlineRegular, IconPlusOutlineMedium, IconRefreshOutlineRegular, IconThinkOutlineMedium, ImageLightbox, Menu,
  PermissionIconAutoReviewMedium, PermissionIconFullAccessMedium, PermissionIconReadOnlyMedium, PermissionIconWorkspaceWriteMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { holdAttachments, readDraft, takeAttachments, writeDraft } from './drafts.js'
import { effortLabel, goalStatusLabel, modeDesc, modeLabel } from './labels.js'
import { applyToken, commandRows, detectSlash, filterRows, goalClaim, goalPrefix, hitKey } from './commands.js'
import { CommandPalette } from './CommandPalette.jsx'
import { ComposerStats } from './ComposerStats.jsx'
import { IMAGE_TYPES, MAX_IMAGE_BYTES, uploadImage } from './uploads.js'
import { WorkspaceSelect } from './WorkspaceSelect.jsx'
import { AgentChips } from './Tasks.jsx'
import css from './Composer.module.css'

let nextAttachmentKey = 0

function hasFiles(event) {
  return event.dataTransfer !== null && [...event.dataTransfer.types].includes('Files')
}

const MODE_GLYPHS = {
  '': PermissionIconWorkspaceWriteMedium,
  acceptEdits: PermissionIconWorkspaceWriteMedium,
  manual: PermissionIconWorkspaceWriteMedium,
  auto: PermissionIconAutoReviewMedium,
  plan: PermissionIconReadOnlyMedium,
  dontAsk: PermissionIconReadOnlyMedium,
  bypassPermissions: PermissionIconFullAccessMedium,
  untrusted: PermissionIconWorkspaceWriteMedium,
  'on-request': PermissionIconWorkspaceWriteMedium,
  never: PermissionIconAutoReviewMedium,
}

function autoGrow(el) {
  if (el === null) return
  el.style.height = '0px'
  el.style.height = `${Math.min(el.scrollHeight, 336)}px`
}

function SendGlyph({ kind }) {
  if (kind === 'stop') {
    return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg>
  }
  if (kind === 'sending') {
    return (
      <svg className={css.sendingSpinner} viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

/**
 * Message composer for a foreign CLI session, laid out like the dsh composer:
 * a new session carries the workspace chip above the card, the mode chip sits
 * left and the model chip plus the round send button right. Both chips carry
 * the CLI's own options; empty means the CLI's own default.
 */
export function Composer({ t, name, provider, session, isNew, hero, busy, sending, disabledReason, launch, tasks, usage, models, workspaces, initialCwd, newNonce, draftKey, onSend, onStop, onLaunch, onCompact, onGoal, directoryFlowOccupant, useDirectoryFlow, addWorkspace }) {
  const [text, setText] = useState(() => readDraft(draftKey))
  const [cwd, setCwd] = useState(initialCwd ?? '')
  const [modeOpen, setModeOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [attachments, setAttachments] = useState(() => takeAttachments(draftKey))
  const [notice, setNotice] = useState(null)
  const notify = (text, error = true) => setNotice({ text, error })
  const [hit, setHit] = useState(null)
  const [highlight, setHighlight] = useState(0)
  const dismissed = useRef(null)
  const launched = useRef(false)
  const pendingCaret = useRef(null)
  const fileInput = useRef(null)
  const [preview, setPreview] = useState(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const composing = useRef(false)
  const area = useRef(null)
  const held = useRef(attachments)
  held.current = attachments
  const release = item => URL.revokeObjectURL(item.url)
  const clearAttachments = () => {
    for (const item of held.current) release(item)
    setAttachments([])
  }
  const patchAttachment = (key, patch) => setAttachments(list => list.map(item => item.key === key ? { ...item, ...patch } : item))
  const startUpload = item => {
    patchAttachment(item.key, { status: 'uploading', error: null })
    uploadImage(item.file)
      .then(id => patchAttachment(item.key, { status: 'ready', id }))
      .catch(error => patchAttachment(item.key, { status: 'error', error: error instanceof Error ? error.message : String(error) }))
  }
  const addFiles = files => {
    const picked = [...files].filter(file => file.size > 0)
    if (blocked || picked.length === 0) return
    if (picked.some(file => !IMAGE_TYPES.has(file.type))) { notify(t('image.unsupportedType')); return }
    if (picked.some(file => file.size > MAX_IMAGE_BYTES)) { notify(t('image.fileTooLarge', { size: '20 MB' })); return }
    setNotice(null)
    const items = picked.map(file => ({ key: ++nextAttachmentKey, file, url: URL.createObjectURL(file), status: 'uploading', id: null, error: null }))
    setAttachments(list => [...list, ...items])
    for (const item of items) startUpload(item)
  }
  const removeAttachment = key => {
    const item = held.current.find(entry => entry.key === key)
    if (item !== undefined) release(item)
    setAttachments(list => list.filter(entry => entry.key !== key))
  }
  // The composer is keyed per session, so leaving hands settled attachments back
  // to the draft store (object URLs cannot survive a reload); in-flight uploads
  // are dropped because their tracker is going away.
  useEffect(() => () => {
    const keep = held.current.filter(item => item.status !== 'uploading')
    for (const item of held.current) if (item.status === 'uploading') release(item)
    holdAttachments(draftKey, keep)
  }, [draftKey])
  useEffect(() => {
    if (preview !== null && !attachments.some(item => item.key === preview.key)) setPreview(null)
  }, [attachments, preview])
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (isNew) setCwd(initialCwd ?? workspaces[0]?.path ?? '')
  }, [newNonce])
  useEffect(() => {
    if (isNew && cwd === '' && workspaces.length > 0) setCwd(workspaces[0].path)
  }, [isNew, cwd, workspaces])
  useEffect(() => { autoGrow(area.current) }, [text])
  const modes = useMemo(() => ['', ...(provider?.permissionModes ?? [])], [provider?.permissionModes])
  const permissionMode = launch?.permissionMode ?? ''
  const model = launch?.model ?? ''
  const modelList = models?.list ?? []
  const modelLabel = model === '' ? t('model.default') : (modelList.find(m => m.id === model)?.label ?? model)
  const ModeGlyph = MODE_GLYPHS[permissionMode] ?? PermissionIconWorkspaceWriteMedium
  const effort = launch?.effort ?? ''
  const activeModel = modelList.find(m => m.id === model) ?? modelList[0]
  const efforts = activeModel?.efforts?.length ? activeModel.efforts : (provider?.reasoningEfforts ?? [])
  const blocked = disabledReason !== undefined || provider?.available === false
  const needsWorkspace = isNew && cwd === ''
  const readyImages = attachments.filter(item => item.status === 'ready')
  const uploadsSettled = attachments.every(item => item.status === 'ready')
  const hasDraft = text.trim() !== '' || readyImages.length > 0
  const canSend = hasDraft && uploadsSettled && !sending && !blocked && !needsWorkspace
  // Like dsh: a running turn keeps Stop only while the draft is empty; typing
  // turns the button back into Send, which steers the running turn.
  const showStop = busy && !sending && !hasDraft
  const rows = useMemo(() => commandRows({ provider, hasSession: session != null, t }), [provider, session, t])
  const visible = hit === null ? [] : filterRows(rows, hit.query)
  const open = hit !== null && visible.length > 0
  const claim = provider?.commands?.includes('goal') === true ? goalClaim(text) : null

  const track = (value, caret) => {
    if (composing.current) return
    // A launcher-opened menu survives the one empty re-track its focus gesture causes.
    const wasLaunched = launched.current
    launched.current = false
    const next = detectSlash(value, caret)
    if (next === null) {
      if (wasLaunched) return
      dismissed.current = null
      setHit(null)
      return
    }
    if (hitKey(next) === dismissed.current) {
      setHit(null)
      return
    }
    setHit(next)
    setHighlight(h => (hit === null ? 0 : Math.min(h, filterRows(rows, next.query).length - 1)))
  }
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const el = area.current
    if (el !== null) {
      el.selectionStart = pendingCaret.current
      el.selectionEnd = pendingCaret.current
    }
    pendingCaret.current = null
  }, [text])

  const sendText = value => {
    const images = readyImages.map(item => ({ id: item.id, mediaType: item.file.type }))
    const answer = onSend({ text: value, cwd: isNew ? cwd : undefined, options: { permissionMode, model, effort }, ...(images.length > 0 ? { images } : {}) })
    setText('')
    writeDraft(draftKey, '')
    // Keep the thumbnails if the send failed so the same images can go again.
    void Promise.resolve(answer).then(result => { if (result?.ok !== false) clearAttachments() })
    return answer
  }
  const runGoal = async claim => {
    // Codex owns goal RPCs; Claude only interprets the literal command text.
    if (provider?.goal !== true) {
      sendText(text.trim())
      return
    }
    const answer = await onGoal(claim.op, claim.objective)
    if (answer?.ok === false) {
      notify(t('goal.failed', { error: answer.error ?? '' }))
      return
    }
    setText('')
    writeDraft(draftKey, '')
    if (claim.op === 'set') notify(t('goal.set', { objective: claim.objective }), false)
    else if (claim.op === 'clear') notify(answer?.cleared === false ? t('goal.nothingToClear') : t('goal.cleared'), false)
    else notify(answer?.goal == null ? t('goal.none') : t('goal.current', { status: goalStatusLabel(answer.goal.status, t), objective: answer.goal.objective }), false)
  }
  const submit = () => {
    if (!canSend) return
    if (claim !== null) {
      void runGoal(claim)
      return
    }
    sendText(text.trim())
  }
  const actions = {
    file: () => { fileInput.current?.click() },
    goal: () => {},
    plan: () => {
      if (busy) { notify(t('error.busy')); return }
      sendText('/plan')
    },
    compact: () => {
      if (busy) { notify(t('error.busy')); return }
      if (provider?.compact === true) onCompact()
      else sendText('/compact')
    },
  }
  const pick = index => {
    const row = visible[index]
    if (row === undefined || hit === null) return
    let next
    let caret
    if (row.name === 'goal') {
      const prefix = goalPrefix(t)
      next = text.slice(0, hit.start) + prefix + text.slice(hit.end)
      caret = hit.start + prefix.length
    } else {
      const applied = applyToken(text, hit)
      next = applied.text
      caret = applied.caret
    }
    setText(next)
    writeDraft(draftKey, next)
    pendingCaret.current = caret
    setHit(null)
    dismissed.current = null
    launched.current = false
    setHighlight(0)
    actions[row.name]()
  }
  const pickModel = id => {
    onLaunch({ model: id })
    setModelOpen(false)
  }

  return (
    <div className={cx(css.root, hero && css.hero)}>
      <div className={css.stack}>
        {isNew && (
          <div className={css.workspaceRow}>
            <WorkspaceSelect
              t={t}
              workspaces={workspaces}
              value={cwd}
              onChange={setCwd}
              open={workspaceOpen}
              onOpenChange={setWorkspaceOpen}
              directoryFlowOccupant={directoryFlowOccupant}
              useDirectoryFlow={useDirectoryFlow}
              addWorkspace={addWorkspace}
              providerId={provider?.id}
              disabled={blocked}
            />
          </div>
        )}
        {disabledReason !== undefined && <div className={css.blocked}>{disabledReason}</div>}
        <div
          className={cx(css.box, dragging && css.boxDrag)}
          data-composer-card
          onClick={needsWorkspace && !blocked ? () => setWorkspaceOpen(true) : undefined}
          onDragEnter={event => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragging(true) }}
          onDragOver={event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = blocked ? 'none' : 'copy' }}
          onDragLeave={event => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false) }}
          onDrop={event => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(event.dataTransfer.files) }}
        >
          <div className={css.overlayAnchor} data-composer-overlay>
            {open && (
              <CommandPalette
                t={t}
                rows={visible}
                highlight={highlight}
                onHover={setHighlight}
                onPick={pick}
                onDismiss={() => setHit(null)}
                signal={`${text}|${visible.length}`}
              />
            )}
          </div>
          {attachments.length > 0 && (
            <div className={css.attachments} onClick={event => event.stopPropagation()}>
              {attachments.map(item => {
                const label = item.file.name || t('image.pending')
                return (
                  <div key={item.key} className={css.imageItem} data-status={item.status}>
                    {item.status === 'error' ? (
                      <Tooltip label={item.error ?? t('image.retry')} side="top" delayMs={300} portal>
                        <button type="button" className={cx(css.thumbnail, css.thumbnailFailed)} aria-label={t('image.retry')} onClick={() => startUpload(item)}>
                          <img src={item.url} alt="" />
                          <span className={css.failureGlyph} aria-hidden><IconRefreshOutlineRegular size={16} /></span>
                        </button>
                      </Tooltip>
                    ) : (
                      <button type="button" className={css.thumbnail} title={t('image.openOriginal')} aria-label={t('image.openOriginal')} aria-busy={item.status === 'uploading'} onClick={() => setPreview(item)}>
                        <img src={item.url} alt={label} />
                      </button>
                    )}
                    {item.status === 'uploading' && <span className={css.progressTrack} aria-hidden><span className={css.progressBar} /></span>}
                    <button type="button" className={css.remove} aria-label={t('image.remove', { name: label })} onClick={() => removeAttachment(item.key)}>
                      <IconCloseFillRegular size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <textarea
            ref={area}
            className={css.textarea}
            rows={1}
            value={text}
            placeholder={needsWorkspace ? t('workspace.choose') : claim !== null ? t('goal.placeholder') : isNew ? t('composer.placeholderNew', { name, cwd }) : t('composer.placeholder', { name })}
            aria-label={t('composer.placeholder', { name })}
            disabled={blocked || needsWorkspace}
            onChange={event => { setText(event.target.value); writeDraft(draftKey, event.target.value); track(event.target.value, event.target.selectionStart) }}
            onSelect={event => {
              const el = event.target
              if (el.selectionStart === el.selectionEnd) track(el.value, el.selectionStart)
            }}
            onPaste={event => {
              const files = event.clipboardData?.files ?? []
              if (files.length === 0) return
              event.preventDefault()
              addFiles(files)
            }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false; track(text, area.current?.selectionStart ?? text.length) }}
            onKeyDown={event => {
              if (composing.current || event.nativeEvent.isComposing) return
              if (open) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const n = visible.length
                  setHighlight(h => (h + (event.key === 'ArrowDown' ? 1 : -1) + n) % n)
                  return
                }
                if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
                  event.preventDefault()
                  dismissed.current = hitKey(hit)
                  setHit(null)
                  return
                }
                if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                  event.preventDefault()
                  pick(highlight)
                  return
                }
              }
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              submit()
            }}
          />
          <div className={css.row} onClick={event => event.stopPropagation()}>
            <div className={css.modes}>
              <Tooltip label={t('palette.open')} side="top" delayMs={500} portal>
                <button
                  type="button"
                  className={css.add}
                  aria-label={t('palette.open')}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  disabled={blocked || needsWorkspace}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    if (open) {
                      setHit(null)
                      return
                    }
                    dismissed.current = null
                    launched.current = true
                    area.current?.focus()
                    const caret = area.current?.selectionStart ?? text.length
                    setHit({ start: caret, end: caret, query: '' })
                    setHighlight(0)
                  }}
                >
                  <IconPlusOutlineMedium size={16} />
                </button>
              </Tooltip>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={event => {
                  addFiles(event.target.files)
                  event.target.value = ''
                  area.current?.focus()
                }}
              />
              <Menu
                open={modeOpen}
                onClose={() => setModeOpen(false)}
                items={modes.map(mode => ({
                  id: mode === '' ? '__default' : mode,
                  label: (
                    <span className={css.modeItem}>
                      <span className={css.modeItemName}>{modeLabel(mode, t)}</span>
                      {modeDesc(mode, t) !== '' && <span className={css.modeItemDesc}>{modeDesc(mode, t)}</span>}
                    </span>
                  ),
                  icon: (() => { const Glyph = MODE_GLYPHS[mode] ?? PermissionIconWorkspaceWriteMedium; return <Glyph size={16} /> })(),
                }))}
                selectedId={permissionMode === '' ? '__default' : permissionMode}
                align="start"
                side="top"
                portal
                listClassName={css.menu}
                onSelect={id => {
                  onLaunch({ permissionMode: id === '__default' ? '' : id })
                  setModeOpen(false)
                }}
                anchor={(
                  <button type="button" className={css.chip} aria-label={t('mode.label')} aria-haspopup="menu" aria-expanded={modeOpen} disabled={blocked} onClick={() => setModeOpen(v => !v)}>
                    <span className={css.chipIcon} aria-hidden><ModeGlyph size={16} /></span>
                    <span className={css.chipLabel}>{modeLabel(permissionMode, t)}</span>
                    <IconChevronDownOutlineRegular size={14} className={cx(css.chevron, modeOpen && css.chevronOpen)} />
                  </button>
                )}
              />
              <AgentChips tasks={tasks ?? []} t={t} />
            </div>
            <div className={css.trailing}>
              <Menu
                open={modelOpen}
                onClose={() => setModelOpen(false)}
                items={[
                  {
                    id: '__model_pane',
                    label: modelLabel,
                    icon: <IconDataOutlineRegular size={16} />,
                    submenu: [
                      { type: 'label', id: 'models-head', text: name },
                      { id: '__model_default', label: t('model.default') },
                      ...modelList.map(m => ({ id: m.id, label: m.label })),
                    ],
                  },
                  ...(efforts.length > 0 ? [{
                    id: '__effort_pane',
                    label: effortLabel(effort, t),
                    icon: <IconThinkOutlineMedium size={16} />,
                    submenu: [
                      { id: '__effort_default', label: t('effort.default') },
                      ...efforts.map(level => ({ id: level, label: effortLabel(level, t) })),
                    ],
                  }] : []),
                ]}
                selectedIds={[model === '' ? '__model_default' : model, effort === '' ? '__effort_default' : effort]}
                align="end"
                side="top"
                portal
                dense
                maxVisibleRows={10}
                submenuBackLabel={t('menu.back')}
                listClassName={css.modelMenu}
                onSelect={id => {
                  if (id === '__model_default') pickModel('')
                  else if (id === '__effort_default') onLaunch({ effort: '' })
                  else if (efforts.includes(id)) onLaunch({ effort: id })
                  else pickModel(id)
                  setModelOpen(false)
                }}
                anchor={(
                  <button type="button" className={css.chip} aria-label={t('page.model')} aria-haspopup="menu" aria-expanded={modelOpen} disabled={blocked} title={efforts.length > 0 ? `${modelLabel} · ${effortLabel(effort, t)}` : modelLabel} onClick={() => setModelOpen(v => !v)}>
                    <IconDataOutlineRegular size={16} className={css.modelIcon} />
                    <span className={css.chipLabel}>{efforts.length > 0 ? `${modelLabel} · ${effortLabel(effort, t)}` : modelLabel}</span>
                    <IconChevronDownOutlineRegular size={14} className={cx(css.chevron, modelOpen && css.chevronOpen)} />
                  </button>
                )}
              />
              <Tooltip label={showStop ? t('composer.stop') : t('composer.send')} side="top" delayMs={500} portal disabled={blocked && !busy}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={showStop ? t('composer.stop') : t('composer.send')}
                  aria-busy={sending}
                  data-sending={sending ? '' : undefined}
                  disabled={showStop ? false : !canSend}
                  onMouseDown={event => event.preventDefault()}
                  onClick={showStop ? onStop : submit}
                >
                  <SendGlyph kind={showStop ? 'stop' : sending ? 'sending' : 'send'} />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
        {notice !== null
          ? <div className={cx(css.hint, notice.error && css.hintError)} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>
          : <ComposerStats usage={usage} t={t} />}
      </div>
      {preview !== null && (
        <ImageLightbox
          src={preview.url}
          alt={preview.file.name || t('image.original')}
          labels={{ dialog: t('image.preview'), close: t('image.closePreview') }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
