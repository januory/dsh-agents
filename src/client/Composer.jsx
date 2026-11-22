import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconDataOutlineRegular, IconThinkOutlineMedium, Menu, MenuItemButton,
  PermissionIconAutoReviewMedium, PermissionIconFullAccessMedium, PermissionIconReadOnlyMedium, PermissionIconWorkspaceWriteMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { effortLabel, modeLabel } from './labels.js'
import { WorkspaceSelect } from './WorkspaceSelect.jsx'
import css from './Composer.module.css'

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
export function Composer({ t, name, provider, session, isNew, hero, busy, sending, disabledReason, launch, models, workspaces, initialCwd, newNonce, onSend, onStop, onLaunch, pickDirectory, addWorkspace }) {
  const [text, setText] = useState('')
  const [cwd, setCwd] = useState(initialCwd ?? '')
  const [modeOpen, setModeOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const composing = useRef(false)
  const area = useRef(null)
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
  const canSend = text.trim() !== '' && !busy && !blocked && !needsWorkspace
  const filtered = modelQuery.trim() === '' ? modelList : modelList.filter(m => m.id.toLowerCase().includes(modelQuery.trim().toLowerCase()) || m.label.toLowerCase().includes(modelQuery.trim().toLowerCase()))
  const exact = modelList.some(m => m.id === modelQuery.trim())

  const submit = () => {
    if (!canSend) return
    onSend({ text: text.trim(), cwd: isNew ? cwd : undefined, options: { permissionMode, model } })
    setText('')
  }
  const pickModel = id => {
    onLaunch({ model: id })
    setModelOpen(false)
    setModelQuery('')
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
              pickDirectory={pickDirectory}
              addWorkspace={addWorkspace}
              providerId={provider?.id}
              disabled={blocked}
            />
          </div>
        )}
        {disabledReason !== undefined && <div className={css.blocked}>{disabledReason}</div>}
        <div className={css.box} onClick={needsWorkspace && !blocked ? () => setWorkspaceOpen(true) : undefined}>
          <textarea
            ref={area}
            className={css.textarea}
            rows={1}
            value={text}
            placeholder={needsWorkspace ? t('workspace.choose') : isNew ? t('composer.placeholderNew', { name, cwd }) : t('composer.placeholder', { name })}
            aria-label={t('composer.placeholder', { name })}
            disabled={blocked || needsWorkspace}
            onChange={event => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing) return
              event.preventDefault()
              submit()
            }}
          />
          <div className={css.row} onClick={event => event.stopPropagation()}>
            <div className={css.modes}>
              <Menu
                open={modeOpen}
                onClose={() => setModeOpen(false)}
                items={modes.map(mode => ({ id: mode === '' ? '__default' : mode, label: modeLabel(mode, t), icon: (() => { const Glyph = MODE_GLYPHS[mode] ?? PermissionIconWorkspaceWriteMedium; return <Glyph size={16} /> })() }))}
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
              {efforts.length > 0 && (
                <Menu
                  open={effortOpen}
                  onClose={() => setEffortOpen(false)}
                  items={[{ id: '__default', label: t('effort.default') }, ...efforts.map(level => ({ id: level, label: effortLabel(level, t) }))]}
                  selectedId={effort === '' ? '__default' : effort}
                  align="start"
                  side="top"
                  portal
                  listClassName={css.menu}
                  onSelect={id => {
                    onLaunch({ effort: id === '__default' ? '' : id })
                    setEffortOpen(false)
                  }}
                  anchor={(
                    <button type="button" className={css.chip} aria-label={t('effort.label')} aria-haspopup="menu" aria-expanded={effortOpen} disabled={blocked} onClick={() => setEffortOpen(v => !v)}>
                      <span className={css.chipIcon} aria-hidden><IconThinkOutlineMedium size={16} /></span>
                      <span className={css.chipLabel}>{effortLabel(effort, t)}</span>
                      <IconChevronDownOutlineRegular size={14} className={cx(css.chevron, effortOpen && css.chevronOpen)} />
                    </button>
                  )}
                />
              )}
            </div>
            <div className={css.trailing}>
              <Menu
                open={modelOpen}
                onClose={() => { setModelOpen(false); setModelQuery('') }}
                items={[
                  { id: '__default', label: t('model.default') },
                  ...filtered.map(m => ({ id: m.id, label: m.label })),
                ]}
                selectedId={model === '' ? '__default' : model}
                align="end"
                side="top"
                portal
                dense
                maxVisibleRows={10}
                listClassName={css.modelMenu}
                search={{ label: t('model.search'), clearLabel: t('search.clear'), value: modelQuery, onChange: setModelQuery, emptyMessage: models?.loading ? t('model.loading') : t('model.empty') }}
                onSelect={id => pickModel(id === '__default' ? '' : id)}
                anchor={(
                  <button type="button" className={css.chip} aria-label={t('page.model')} aria-haspopup="menu" aria-expanded={modelOpen} disabled={blocked} title={modelLabel} onClick={() => setModelOpen(v => !v)}>
                    <IconDataOutlineRegular size={16} className={css.modelIcon} />
                    <span className={css.chipLabel}>{modelLabel}</span>
                    <IconChevronDownOutlineRegular size={14} className={cx(css.chevron, modelOpen && css.chevronOpen)} />
                  </button>
                )}
              >
                {modelQuery.trim() !== '' && !exact && (
                  <MenuItemButton onSelect={() => pickModel(modelQuery.trim())}>{t('model.use', { id: modelQuery.trim() })}</MenuItemButton>
                )}
              </Menu>
              <Tooltip label={busy ? t('composer.stop') : t('composer.send')} side="top" delayMs={500} portal disabled={blocked && !busy}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={busy ? t('composer.stop') : t('composer.send')}
                  aria-busy={sending}
                  data-sending={sending ? '' : undefined}
                  disabled={busy ? false : !canSend}
                  onMouseDown={event => event.preventDefault()}
                  onClick={busy ? onStop : submit}
                >
                  <SendGlyph kind={busy ? 'stop' : sending ? 'sending' : 'send'} />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
        <div className={css.hint}>{t('composer.hint')}</div>
      </div>
    </div>
  )
}
