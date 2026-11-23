import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular, IconPlusOutlineRegular, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import { DirectoryFlow } from './DirectoryFlow.jsx'
import { basename } from './labels.js'
import css from './WorkspaceSelect.module.css'

const ADD = '::add-workspace'
const VISIBLE_ROWS = 6

/** Shortest trailing path segments that tell same-named directories apart. */
function suffixes(rows) {
  const parts = rows.map(row => ({ ...row, segments: row.path.split(/([\\/])/) }))
  const tail = (segments, count) => segments.slice(-(2 * count - 1)).join('')
  const out = new Map()
  for (const row of parts) {
    const peers = parts.filter(other => other !== row && other.label === row.label)
    if (peers.length === 0) continue
    let count = 1
    while (2 * count - 1 < row.segments.length && (tail(row.segments, count) === '' || peers.some(peer => tail(peer.segments, count) === tail(row.segments, count)))) count++
    out.set(row.path, tail(row.segments, count))
  }
  return out
}

/**
 * New-session workspace chip and picker, mirroring dsh's: a searchable list
 * of directories with the current one checked, a pinned "add workspace"
 * entry that opens the composed directory flow (native chooser or browse
 * dialog), one pick at a time, errors in a dialog with a retry. With no
 * directories listed the chip opens the flow directly; with no flow composed
 * the add entry is absent.
 */
export function WorkspaceSelect({ t, workspaces, value, onChange, open, onOpenChange, directoryFlowOccupant, useDirectoryFlow, addWorkspace, providerId, disabled }) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const buttonRef = useRef(null)
  const rows = useMemo(() => workspaces.map(workspace => ({ ...workspace, label: basename(workspace.path) })), [workspaces])
  const apart = useMemo(() => suffixes(rows), [rows])
  const q = query.trim().toLowerCase()
  const matching = q === '' ? rows : rows.filter(row => row.label.toLowerCase().includes(q) || row.path.toLowerCase().includes(q))
  const label = value === '' ? undefined : basename(value)
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  const flowBusy = flowOpen || adopting
  // An occupant that unloads mid-interaction leaves nobody to cancel.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])

  const openFlow = () => {
    if (flowBusy || !flowAvailable) return
    onOpenChange(false)
    setError(null)
    setFlowOpen(true)
  }
  const flowOwner = {
    open: flowOpen,
    busy: adopting,
    onPicked: path => {
      setAdopting(true)
      void addWorkspace(providerId, path).then(answer => {
        setFlowOpen(false)
        if (answer.ok) onChange(path)
        else setError(answer.error)
      }).catch(reason => {
        setFlowOpen(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => setAdopting(false))
    },
    onCancel: () => setFlowOpen(false),
    onError: message => {
      setFlowOpen(false)
      setError(message)
    },
  }

  const items = matching.map(row => {
    const suffix = apart.get(row.path)
    return {
      id: row.path,
      label: suffix === undefined ? row.label : (
        <span className={css.disambiguated} title={row.path}>
          <span className={css.itemTitle}>{row.label}</span>
          <span className={css.pathSuffix}>{suffix}</span>
        </span>
      ),
      icon: <IconFolderCloseRegular size={16} />,
      disabled: flowBusy,
    }
  })
  const addEntries = flowAvailable ? [{ id: ADD, label: t('workspace.addEntry'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }] : []

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={css.workspace}
        aria-label={t('workspace.choose')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={flowBusy}
        disabled={disabled}
        title={value === '' ? undefined : value}
        onClick={() => {
          if (rows.length === 0) openFlow()
          else onOpenChange(!open)
        }}
      >
        {label === undefined ? <IconFolderCloseRegular size={16} className={css.folder} /> : <IconFolderOpenRegular size={16} className={css.folder} />}
        <span className={css.workspaceLabel}>{label ?? t('workspace.choose')}</span>
        <IconChevronDownOutlineRegular size={12} className={cx(css.chevron, open && css.chevronOpen)} />
      </button>
      <Menu
        open={open && rows.length > 0}
        anchor={null}
        anchorRef={buttonRef}
        items={items}
        footer={addEntries}
        search={{ label: t('workspace.search'), clearLabel: t('search.clear'), value: query, onChange: setQuery, emptyMessage: t('workspace.noResults') }}
        maxVisibleRows={VISIBLE_ROWS}
        selectedId={value === '' ? undefined : value}
        onSelect={id => {
          if (id === ADD) {
            openFlow()
            return
          }
          onOpenChange(false)
          setQuery('')
          onChange(id)
        }}
        onClose={() => {
          onOpenChange(false)
          setQuery('')
        }}
        side="bottom"
        portal
        listClassName={css.menu}
      />
      <DirectoryFlow occupant={directoryFlowOccupant()} {...flowOwner} />
      <Modal
        open={error !== null}
        onClose={() => setError(null)}
        closeLabel={t('notice.dismiss')}
        title={t('workspace.errorTitle')}
        footer={(
          <>
            <Button variant="outline" onClick={() => setError(null)}>{t('notice.dismiss')}</Button>
            <Button variant="primary" disabled={!flowAvailable} onClick={openFlow}>{t('workspace.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{error}</div>
      </Modal>
    </>
  )
}
