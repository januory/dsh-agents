import { useMemo, useRef, useState } from 'react'
import {
  Button, HoverCard, IconChevronRightOutlineMedium, IconCloseOutlineMedium, IconEllipsisOutlineMedium, IconEyeOffOutlineMedium, IconEyeOutlineMedium,
  IconFolderCloseRegular, IconNewChatOutlineRegular, IconProjectAddOutlineRegular, IconRefreshOutlineMedium, IconSearchOutlineMedium, IconSlidersTwoOutlineMedium,
  MarqueeText, Menu, Modal, StateDot, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { SourceIcon } from './SourceIcon.jsx'
import { SourceHeaderSelect } from './SourceHeaderSelect.jsx'
import { basename, createdLabel, timeLabel } from './labels.js'
import { isLive } from './controller.js'
import css from './SessionList.module.css'

const PAGE = 5

function rowState(row, turn, active, t) {
  if (turn !== undefined && turn.sessionId === row.id && isLive(turn.status)) {
    if (turn.status === 'awaiting') return { state: 'warning', label: t('row.awaiting') }
    return { state: 'ongoing', label: t('row.running') }
  }
  // A live turn driven here but not currently open: keep its dot current too.
  const own = active?.[row.id]
  if (own !== undefined) {
    if (own === 'awaiting') return { state: 'warning', label: t('row.awaiting') }
    return { state: 'ongoing', label: t('row.running') }
  }
  if (row.live !== undefined) {
    if (row.provider === 'claude') {
      if (row.live.status === 'waiting') return { state: 'warning', label: t('row.elsewhereWaiting') }
      if (row.live.status === 'busy' || row.live.status === 'working') return { state: 'ongoing', label: t('row.elsewhere') }
      return { state: 'idle', label: t('row.elsewhere') }
    }
    if ((row.live.flags ?? []).includes('waitingOnApproval')) return { state: 'warning', label: t('row.awaiting') }
    return { state: 'ongoing', label: t('row.elsewhere') }
  }
  return { state: 'idle', label: undefined }
}

function matches(row, query) {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return row.title.toLowerCase().includes(q) || (row.cwd ?? '').toLowerCase().includes(q) || row.id.toLowerCase().includes(q)
}

function groupRows(rows, workspaces, query) {
  const groups = new Map()
  for (const row of rows) {
    const key = row.cwd ?? ''
    if (!groups.has(key)) groups.set(key, { key, label: basename(key), rows: [], pinned: false, addedAt: 0 })
    groups.get(key).rows.push(row)
  }
  const q = query.trim().toLowerCase()
  for (const workspace of workspaces) {
    const existing = groups.get(workspace.path)
    if (existing !== undefined) {
      existing.pinned = true
      existing.addedAt = workspace.addedAt
    } else if (q === '' || workspace.path.toLowerCase().includes(q)) {
      groups.set(workspace.path, { key: workspace.path, label: basename(workspace.path), rows: [], pinned: true, addedAt: workspace.addedAt })
    }
  }
  const recency = group => Math.max(group.rows[0]?.updatedAt ?? 0, group.addedAt)
  return [...groups.values()].sort((a, b) => recency(b) - recency(a))
}

function SessionRow({ row, selected, now, turn, active, t, onOpen, onMenu, menuOpen }) {
  const title = row.title || t('row.untitled')
  const status = rowState(row, turn, active, t)
  const titleRef = useRef(null)
  const body = (
    <div
      className={cx(css.sessionRow, selected && css.selected, menuOpen && css.menuOpen, row.hidden && css.hidden)}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      data-row-key={`agent:${row.provider}:${row.id}`}
      onClick={() => onOpen(row.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onOpen(row.id)
      }}
    >
      <span className={css.slot}>{status.state !== 'idle' && <StateDot state={status.state} />}</span>
      <MarqueeText ref={titleRef} className={css.title}>{title}</MarqueeText>
      <span className={css.rowResting}>
        <span className={css.time}>{status.label ?? timeLabel(row.updatedAt, now, t)}</span>
        {row.hidden && <IconEyeOffOutlineMedium size={12} />}
      </span>
      <span className={css.rowActions} onClick={event => event.stopPropagation()}>
        <Tooltip label={t('row.menu', { name: title })} delayMs={400} side="bottom">
          <button type="button" className={css.iconButton} aria-label={t('row.menu', { name: title })} aria-haspopup="menu" onClick={event => onMenu(row, event.currentTarget)}>
            <IconEllipsisOutlineMedium size={14} />
          </button>
        </Tooltip>
      </span>
    </div>
  )
  return (
    <HoverCard
      anchor={body}
      openDelayMs={800}
      grouped
      disabled={menuOpen}
      copyText={row.title || undefined}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
      content={(
        <div className={css.hoverContent}>
          <div className={css.hoverTitle}>{title}</div>
          {row.cwd && <div className={css.hoverPath}>{row.cwd}</div>}
          <div className={css.hoverMeta}>{createdLabel(row.createdAt, t)}</div>
          {row.gitBranch && <div className={css.hoverMeta}>{t('hover.branch', { branch: row.gitBranch })}</div>}
          {row.model && <div className={css.hoverMeta}>{t('hover.model', { model: row.model })}</div>}
          {status.label && <div className={css.hoverMeta}>{status.label}</div>}
        </div>
      )}
    />
  )
}

function Group({ group, expanded, visible, t, onToggle, onMore, onLess, onNew, onMenu, menuOpen, renderRow }) {
  const shown = group.rows.slice(0, visible)
  const rest = group.rows.length - shown.length
  const label = group.label || t('list.ungrouped')
  return (
    <div className={css.group} role="group">
      <div className={cx(css.projectRow, menuOpen && css.menuOpen)} role="treeitem" aria-expanded={expanded} tabIndex={0} onClick={onToggle} onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onToggle()
      }}>
        <span className={css.slot}>
          <IconFolderCloseRegular size={16} className={css.folder} />
          <IconChevronRightOutlineMedium size={12} className={cx(css.chevron, css.arrow, expanded && css.arrowOpen)} />
        </span>
        <span className={css.projectText}><span className={css.title}>{label}</span></span>
        <span className={css.rowResting}><span className={css.time}>{group.rows.length}</span></span>
        {group.key !== '' && (
          <span className={css.rowActions} onClick={event => event.stopPropagation()}>
            <Tooltip label={t('group.menu', { name: label })} delayMs={400} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('group.menu', { name: label })} aria-haspopup="menu" onClick={event => onMenu(group, event.currentTarget)}>
                <IconEllipsisOutlineMedium size={14} />
              </button>
            </Tooltip>
            <Tooltip label={t('group.new', { name: label })} delayMs={400} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('group.new', { name: label })} onClick={() => onNew(group)}>
                <IconNewChatOutlineRegular size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      </div>
      {expanded && (
        <div className={css.groupBody} style={{ '--dag-indent': '12px' }}>
          {shown.map(renderRow)}
          {rest > 0 && <button type="button" className={css.more} onClick={onMore}>{t('list.showMore', { n: rest })}</button>}
          {visible > PAGE && <button type="button" className={css.more} onClick={onLess}>{t('list.showLess')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * The sidebar browsing region for a foreign agent CLI: same row geometry as
 * the dsh session list, grouped by project, with search, hide and rename.
 * New sessions come from the shipped New-session button or a workspace row's
 * new-chat action; the header's add action pins a directory as a workspace.
 */
export function SessionList(props) {
  const { wide, expandSidebar, useSectionScroller, t } = props
  const { useAgentView, useAgentProviders, useAgentSessions, useAgentTranscript, open, setSource, setQuery, toggleGroup, setGroupBy, setShowHidden, refresh, rename, hide, addWorkspace, removeWorkspace, pickDirectory } = props
  const view = useAgentView(s => s)
  const source = view.source
  const providers = useAgentProviders(s => s)
  const bucket = useAgentSessions(s => s.byProvider[source])
  const transcript = useAgentTranscript(s => ({ key: s.key, turn: s.turn, provider: s.provider }))
  const { bindScrollerRef } = useSectionScroller()
  const [searchOpen, setSearchOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [menu, setMenu] = useState(null)
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameText, setRenameText] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState(null)
  const renameComposing = useRef(false)
  const [visible, setVisible] = useState({})
  const [notice, setNotice] = useState(null)
  const [pickBusy, setPickBusy] = useState(false)
  const picking = useRef(false)
  const menuAnchorRef = useRef(null)
  const searchInput = useRef(null)
  const now = Date.now()
  const provider = providers.list.find(p => p.id === source)
  const rows = useMemo(() => (bucket?.list ?? []).filter(row => (view.showHidden || !row.hidden) && matches(row, view.query)), [bucket?.list, view.showHidden, view.query])
  const groups = useMemo(() => groupRows(rows, bucket?.workspaces ?? [], view.query), [rows, bucket?.workspaces, view.query])
  const selectedId = view.selected[source]
  const turn = transcript.provider === source && transcript.turn !== null ? { ...transcript.turn, sessionId: transcript.key?.slice(source.length + 1) } : undefined
  const name = provider?.label ?? source

  const renderRow = row => (
    <SessionRow
      key={row.id}
      row={row}
      now={now}
      turn={turn}
      active={bucket?.active}
      t={t}
      selected={row.id === selectedId}
      menuOpen={menu?.kind === 'session' && menu.row.id === row.id}
      onOpen={id => open(source, id)}
      onMenu={(target, anchor) => {
        menuAnchorRef.current = anchor
        setMenu({ kind: 'session', row: target })
      }}
    />
  )

  const openMenu = (target, anchor) => {
    menuAnchorRef.current = anchor
    setMenu(target)
  }

  const menuItems = menu === null ? [] : menu.kind === 'session' ? [
    { id: 'rename', label: t('row.rename') },
    { id: 'hide', label: menu.row.hidden ? t('row.unhide') : t('row.hide'), icon: menu.row.hidden ? <IconEyeOutlineMedium size={14} /> : <IconEyeOffOutlineMedium size={14} /> },
    { type: 'separator', id: 'sep' },
    { id: 'copyId', label: t('row.copyId') },
    ...(menu.row.cwd ? [{ id: 'copyPath', label: t('row.copyPath') }] : []),
  ] : [
    { id: 'copyPath', label: t('row.copyPath') },
    ...(menu.group.pinned && menu.group.rows.length === 0 ? [{ type: 'separator', id: 'sep' }, { id: 'removeWorkspace', label: t('group.remove'), icon: <IconCloseOutlineMedium size={14} /> }] : []),
  ]

  const optionItems = [
    { type: 'label', id: 'group', text: t('view.group') },
    { id: 'group:project', label: t('view.group.project') },
    { id: 'group:flat', label: t('view.group.flat') },
    { type: 'separator', id: 'sep' },
    { id: 'hidden', label: t('view.hidden') },
    { id: 'refresh', label: t('view.refresh'), icon: <IconRefreshOutlineMedium size={14} /> },
  ]

  const pickWorkspace = async () => {
    if (picking.current) return
    picking.current = true
    setPickBusy(true)
    setNotice(null)
    try {
      const path = await pickDirectory()
      if (typeof path !== 'string' || path === '') return
      const answer = await addWorkspace(source, path)
      if (!answer.ok) setNotice(t('error.workspace', { error: answer.error }))
    } catch (error) {
      setNotice(t('error.workspace', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      picking.current = false
      setPickBusy(false)
    }
  }

  const closeRename = () => {
    if (!renameBusy) setRenameTarget(null)
  }
  const confirmRename = () => {
    const trimmed = renameText.trim()
    if (renameBusy || trimmed === '' || renameTarget === null) return
    setRenameBusy(true)
    setRenameError(null)
    void rename(renameTarget.provider, renameTarget.id, trimmed).then(answer => {
      setRenameBusy(false)
      if (answer.ok) setRenameTarget(null)
      else setRenameError(answer.error)
    })
  }

  if (!wide) {
    return (
      <div className={cx(css.root, css.rail)}>
        <Tooltip label={t(`section.${source}`)} side="right" delayMs={400}>
          <button type="button" className={css.railButton} aria-label={t(`section.${source}`)} onClick={expandSidebar}>
            <SourceIcon source={source} size={18} />
          </button>
        </Tooltip>
      </div>
    )
  }

  const searching = searchOpen || view.query !== ''
  return (
    <div className={css.root}>
      <div className={css.sectionHeader}>
        {!searching && <SourceHeaderSelect t={t} useAgentView={useAgentView} setSource={setSource} />}
        <div className={cx(css.search, searching && css.searchExpanded)}>
          <button
            type="button"
            className={css.searchButton}
            aria-label={t('search.aria')}
            onClick={() => {
              setSearchOpen(true)
              requestAnimationFrame(() => searchInput.current?.focus())
            }}
          >
            <IconSearchOutlineMedium size={14} />
          </button>
          <input
            ref={searchInput}
            className={css.searchInput}
            value={view.query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.aria')}
            onChange={event => setQuery(event.target.value)}
            onBlur={() => { if (view.query === '') setSearchOpen(false) }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setQuery('')
                setSearchOpen(false)
                event.currentTarget.blur()
              }
            }}
          />
          {view.query !== '' && (
            <button type="button" className={css.clearButton} aria-label={t('search.clear')} onClick={() => setQuery('')}>
              <IconCloseOutlineMedium size={12} />
            </button>
          )}
        </div>
        {!searching && (
          <div className={css.headerActions}>
            <Menu
              open={optionsOpen}
              onClose={() => setOptionsOpen(false)}
              items={optionItems}
              selectedIds={view.groupBy === 'flat' ? ['group:flat', ...(view.showHidden ? ['hidden'] : [])] : ['group:project', ...(view.showHidden ? ['hidden'] : [])]}
              selection="check"
              align="end"
              side="bottom"
              portal
              dense
              listClassName={css.optionsMenu}
              onSelect={id => {
                if (id === 'refresh') {
                  setOptionsOpen(false)
                  refresh(source)
                  return
                }
                if (id === 'hidden') setShowHidden(!view.showHidden)
                else if (id.startsWith('group:')) setGroupBy(id.slice('group:'.length))
              }}
              anchor={(
                <Tooltip label={t('view.aria')} delayMs={400} side="bottom" portal>
                  <button type="button" className={css.iconButton} aria-label={t('view.aria')} aria-haspopup="menu" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(v => !v)}>
                    <IconSlidersTwoOutlineMedium size={16} />
                  </button>
                </Tooltip>
              )}
            />
            <Tooltip label={t('workspace.add')} delayMs={400} side="bottom">
              <button type="button" className={css.iconButton} aria-label={t('workspace.add')} aria-busy={pickBusy} disabled={pickBusy} onClick={() => { void pickWorkspace() }}>
                <IconProjectAddOutlineRegular size={16} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <div className={css.listArea} ref={bindScrollerRef}>
        <div className={css.treeBody} role="tree" aria-label={t(`section.${source}`)}>
          {notice !== null && (
            <div className={css.notice} role="alert">
              <div>{notice}</div>
              <button type="button" className={css.more} onClick={() => setNotice(null)}>{t('notice.dismiss')}</button>
            </div>
          )}
          {provider !== undefined && !provider.available && (
            <div className={css.notice}>
              <div>{t('list.unavailable', { name, error: provider.error ?? '' })}</div>
              <div className={css.noticeHint}>{t('list.install')}</div>
              <button type="button" className={css.more} onClick={() => refresh(source)}>{t('view.refresh')}</button>
            </div>
          )}
          {provider !== undefined && !provider.available ? null
            : bucket === undefined || (!bucket.loaded && bucket.loading) ? <div className={css.notice}>{t('list.loading')}</div>
              : bucket.error !== null ? <div className={css.notice}>{t('list.unavailable', { name, error: bucket.error })}</div>
              : rows.length === 0 && groups.length === 0 ? (
                <div className={css.notice}>
                  <div>{view.query !== '' ? t('list.noMatch') : t('list.empty', { name })}</div>
                  {view.query === '' && <div className={css.noticeHint}>{t('list.emptyHint')}</div>}
                </div>
              ) : view.query !== '' || view.groupBy === 'flat' ? rows.map(renderRow)
                : groups.map(group => (
                  <Group
                    key={group.key}
                    group={group}
                    t={t}
                    expanded={view.expanded[group.key] ?? true}
                    visible={visible[group.key] ?? PAGE}
                    menuOpen={menu?.kind === 'group' && menu.group.key === group.key}
                    onToggle={() => toggleGroup(group.key)}
                    onMore={() => setVisible(v => ({ ...v, [group.key]: (v[group.key] ?? PAGE) + PAGE }))}
                    onLess={() => setVisible(v => ({ ...v, [group.key]: PAGE }))}
                    onNew={target => open(source, null, { cwd: target.key })}
                    onMenu={(target, anchor) => openMenu({ kind: 'group', group: target }, anchor)}
                    renderRow={renderRow}
                  />
                ))}
        </div>
      </div>
      <Menu
        open={menu !== null}
        anchor={null}
        anchorRef={menuAnchorRef}
        portal
        items={menuItems}
        align="end"
        side="bottom"
        onSelect={id => {
          const target = menu
          setMenu(null)
          if (target.kind === 'group') {
            if (id === 'copyPath') void writeClipboard(target.group.key)
            else if (id === 'removeWorkspace') void removeWorkspace(source, target.group.key)
            return
          }
          const row = target.row
          if (id === 'rename') {
            setRenameTarget(row)
            setRenameText(row.title || '')
            setRenameError(null)
          } else if (id === 'hide') void hide(row.provider, row.id, !row.hidden)
          else if (id === 'copyId') void writeClipboard(row.id)
          else if (id === 'copyPath') void writeClipboard(row.cwd ?? '')
        }}
        onClose={() => setMenu(null)}
      />
      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        title={t('rename.title')}
        closeLabel={t('notice.dismiss')}
        footer={(
          <>
            <Button variant="outline" disabled={renameBusy} onClick={closeRename}>{t('rename.cancel')}</Button>
            <Button variant="primary" disabled={renameBusy || renameText.trim() === ''} onClick={confirmRename}>{t('rename.save')}</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={renameText}
          aria-label={t('rename.field')}
          data-modal-autofocus
          disabled={renameBusy}
          onFocus={event => event.target.select()}
          onChange={event => { setRenameText(event.target.value); setRenameError(null) }}
          onCompositionStart={() => { renameComposing.current = true }}
          onCompositionEnd={() => { renameComposing.current = false }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !renameComposing.current) {
              event.preventDefault()
              confirmRename()
            }
          }}
        />
        {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
      </Modal>
    </div>
  )
}
