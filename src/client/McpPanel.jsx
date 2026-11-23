import { useCallback, useEffect, useState } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, StateDot, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.js'
import css from './McpPanel.module.css'

const STATUS_META = {
  connected: { tone: 'success', state: 'done' },
  failed: { tone: 'danger', state: 'error' },
  'needs-auth': { tone: 'warning', state: 'warning' },
  pending: { tone: 'neutral', state: 'ongoing' },
  disabled: { tone: 'quiet', state: 'idle' },
}

const SCOPE_ORDER = ['local', 'project', 'user']

function StatusBadge({ status, t }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending
  return (
    <span className={css.badge}>
      <StateDot state={meta.state} size={8} />
      <Tag tone={meta.tone}>{t(`mcp.status.${status}`)}</Tag>
    </span>
  )
}

const parseLines = text => text.split('\n').map(line => line.trim()).filter(line => line !== '')
const parsePairs = text => Object.fromEntries(parseLines(text).map(line => {
  const at = line.indexOf('=')
  return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : null
}).filter(Boolean))

function groupServers(servers) {
  const groups = new Map()
  for (const server of servers) {
    const key = server.source ?? 'other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(server)
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = SCOPE_ORDER.indexOf(a); const ib = SCOPE_ORDER.indexOf(b)
    return (ia === -1 ? SCOPE_ORDER.length : ia) - (ib === -1 ? SCOPE_ORDER.length : ib)
  })
  return keys.map(key => ({ key, servers: groups.get(key) }))
}

export function McpPanel({ provider, sessionId, cwd, mcp, t }) {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [view, setView] = useState('list')
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('')
  const [showTools, setShowTools] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', url: '', arguments: '', environment: '', scope: 'local' })
  const canManage = provider === 'claude'
  const ready = sessionId !== undefined && typeof mcp === 'function'

  const refresh = useCallback(async () => {
    if (!ready) return
    setLoading(true)
    setError(null)
    const answer = await mcp(provider, sessionId, cwd, 'status')
    setLoading(false)
    if (answer.ok) setServers(answer.servers ?? [])
    else setError(answer.error ?? 'error')
  }, [mcp, provider, sessionId, cwd, ready])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (op, payload) => {
    setBusy(true)
    setError(null)
    const answer = await mcp(provider, sessionId, cwd, op, payload)
    setBusy(false)
    if (!answer.ok) { setError(answer.error ?? 'error'); return false }
    await refresh()
    return true
  }

  if (!ready) return <p className={css.empty} data-mcp-empty>{t('mcp.noSession')}</p>

  const current = servers.find(server => server.name === selected)

  if (view === 'add') {
    const stdio = form.transport === 'stdio'
    const valid = form.name.trim() !== '' && (stdio ? form.command.trim() !== '' : form.url.trim() !== '')
    const submit = async () => {
      const cfg = stdio
        ? { type: 'stdio', command: form.command.trim(), args: parseLines(form.arguments), env: parsePairs(form.environment) }
        : { type: form.transport, url: form.url.trim(), headers: parsePairs(form.environment) }
      if (await run('add', { name: form.name.trim(), cfg, scope: form.scope })) {
        setForm({ name: '', transport: 'stdio', command: '', url: '', arguments: '', environment: '', scope: 'local' })
        setView('list')
      }
    }
    const field = (key, value) => setForm(current => ({ ...current, [key]: value }))
    return (
      <div className={css.root} data-mcp-view="add">
        <div className={css.head}>
          <button type="button" className={css.back} aria-label={t('mcp.back')} onClick={() => { setView('list'); setError(null) }}>
            <IconChevronLeftOutlineRegular size={16} />
          </button>
          <span className={css.headTitle}>{t('mcp.addServer')}</span>
        </div>
        <div className={css.form}>
          <label className={css.field}>
            <span className={css.label}>{t('mcp.name')}</span>
            <Input value={form.name} onChange={e => field('name', e.target.value)} placeholder={t('mcp.namePlaceholder')} data-mcp-field="name" />
          </label>
          <div className={css.field}>
            <span className={css.label}>{t('mcp.transport')}</span>
            <div className={css.segmented} role="group">
              {['stdio', 'http', 'sse'].map(value => (
                <button key={value} type="button" className={cx(css.segment, form.transport === value && css.segmentActive)} aria-pressed={form.transport === value} data-mcp-transport={value} onClick={() => field('transport', value)}>{t(`mcp.${value}`)}</button>
              ))}
            </div>
          </div>
          {stdio ? (
            <label className={css.field}>
              <span className={css.label}>{t('mcp.command')}</span>
              <Input value={form.command} onChange={e => field('command', e.target.value)} placeholder={t('mcp.commandPlaceholder')} data-mcp-field="command" />
            </label>
          ) : (
            <label className={css.field}>
              <span className={css.label}>{t('mcp.url')}</span>
              <Input value={form.url} onChange={e => field('url', e.target.value)} placeholder={t('mcp.urlPlaceholder')} data-mcp-field="url" />
            </label>
          )}
          {stdio && (
            <label className={css.field}>
              <span className={css.label}>{t('mcp.arguments')}</span>
              <textarea className={css.textarea} value={form.arguments} onChange={e => field('arguments', e.target.value)} placeholder={t('mcp.argumentsPlaceholder')} rows={3} data-mcp-field="arguments" />
            </label>
          )}
          <label className={css.field}>
            <span className={css.label}>{stdio ? t('mcp.env') : t('mcp.headers')}</span>
            <textarea className={css.textarea} value={form.environment} onChange={e => field('environment', e.target.value)} placeholder={t('mcp.envPlaceholder')} rows={3} data-mcp-field="environment" />
          </label>
          <div className={css.field}>
            <span className={css.label}>{t('mcp.scope')}</span>
            <div className={css.segmented} role="group">
              {['local', 'user', 'project'].map(value => (
                <button key={value} type="button" className={cx(css.segment, form.scope === value && css.segmentActive)} aria-pressed={form.scope === value} data-mcp-scope={value} onClick={() => field('scope', value)}>{t(`mcp.group.${value}`)}</button>
              ))}
            </div>
          </div>
          {error !== null && <p className={css.error} role="alert" data-mcp-error>{error}</p>}
          <div className={css.formActions}>
            <Button variant="primary" size="sm" disabled={!valid || busy} onClick={() => void submit()} data-mcp-submit>{t('mcp.add')}</Button>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'detail' && current !== undefined) {
    const disabled = current.status === 'disabled'
    return (
      <div className={css.root} data-mcp-view="detail">
        <div className={css.head}>
          <button type="button" className={css.back} aria-label={t('mcp.back')} onClick={() => { setView('list'); setError(null) }}>
            <IconChevronLeftOutlineRegular size={16} />
          </button>
          <span className={css.headTitle} data-mcp-detail-name>{current.name}</span>
          <StatusBadge status={current.status} t={t} />
        </div>
        {current.error !== undefined && <p className={css.error} data-mcp-error>{current.error}</p>}
        {canManage && (
          <div className={css.actions}>
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />} disabled={busy} onClick={() => void run('reconnect', { name: current.name })} data-mcp-reconnect>{t('mcp.reconnect')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run('toggle', { name: current.name, enabled: disabled })} data-mcp-toggle>{t(disabled ? 'mcp.enable' : 'mcp.disable')}</Button>
            <Button variant="outline" size="sm" className={css.danger} disabled={busy} onClick={async () => { if (await run('remove', { name: current.name, scope: current.source })) setView('list') }} data-mcp-remove>{t('mcp.remove')}</Button>
          </div>
        )}
        {error !== null && <p className={css.error} role="alert" data-mcp-error>{error}</p>}
        <div className={css.toolsHead}>
          <span className={css.label}>{t('mcp.tools', { n: current.tools.length })}</span>
          {current.tools.length > 0 && (
            <button type="button" className={css.link} onClick={() => setShowTools(v => !v)} data-mcp-toggle-tools>{t(showTools ? 'mcp.hideTools' : 'mcp.showTools')}</button>
          )}
        </div>
        {showTools && current.tools.length > 0 && (
          <ul className={css.tools} data-mcp-tools>
            {current.tools.map(tool => (
              <li key={tool.name} className={css.tool}>
                <span className={css.toolName}>{tool.name}</span>
                {tool.readOnly && <Tag tone="quiet">{t('mcp.readOnly')}</Tag>}
              </li>
            ))}
          </ul>
        )}
        {current.tools.length === 0 && <p className={css.empty}>{t('mcp.noTools')}</p>}
      </div>
    )
  }

  const needle = filter.trim().toLowerCase()
  const visible = needle === '' ? servers : servers.filter(server => server.name.toLowerCase().includes(needle))
  const groups = groupServers(visible)
  return (
    <div className={css.root} data-mcp-view="list">
      <div className={css.listHead}>
        <Input className={css.filter} value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('mcp.filter')} aria-label={t('mcp.filter')} data-mcp-filter />
        <Tooltip label={t('mcp.refresh')} side="bottom" delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={t('mcp.refresh')} disabled={loading} onClick={() => void refresh()} data-mcp-refresh>
            <IconRefreshOutlineRegular size={15} />
          </button>
        </Tooltip>
      </div>
      {error !== null && <p className={css.error} role="alert" data-mcp-error>{error}</p>}
      <div className={css.list}>
        {loading && servers.length === 0 ? <p className={css.empty} data-mcp-loading>{t('mcp.loading')}</p>
          : visible.length === 0 ? <p className={css.empty} data-mcp-empty>{t('mcp.empty')}</p>
            : groups.map(group => (
              <section key={group.key} className={css.group}>
                <div className={css.groupTitle}>{t(`mcp.group.${group.key}`)}</div>
                {group.servers.map(server => (
                  <button key={server.name} type="button" className={css.row} data-mcp-server={server.name} onClick={() => { setSelected(server.name); setShowTools(true); setView('detail'); setError(null) }}>
                    <span className={css.rowName}>{server.name}</span>
                    <StatusBadge status={server.status} t={t} />
                  </button>
                ))}
              </section>
            ))}
      </div>
      <div className={css.listFoot}>
        {canManage && (
          <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={14} />} onClick={() => { setView('add'); setError(null) }} data-mcp-add>{t('mcp.addServer')}</Button>
        )}
        <a className={css.learn} href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">{t('mcp.learnMore')}</a>
      </div>
    </div>
  )
}
