import { useEffect, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SourceIcon } from './SourceIcon.jsx'
import { modeLabel } from './labels.js'
import css from './SettingsSection.module.css'

function ProviderCard({ provider, defaults, count, t, onSave }) {
  const [permissionMode, setPermissionMode] = useState(defaults?.permissionMode ?? '')
  const [model, setModel] = useState(defaults?.model ?? '')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setPermissionMode(defaults?.permissionMode ?? '')
    setModel(defaults?.model ?? '')
  }, [defaults?.permissionMode, defaults?.model])
  const dirty = permissionMode !== (defaults?.permissionMode ?? '') || model.trim() !== (defaults?.model ?? '')
  return (
    <section className={css.card} aria-label={provider.label}>
      <div className={css.cardHead}>
        <SourceIcon source={provider.id} size={16} />
        <span className={css.cardTitle}>{provider.label}</span>
        {provider.available ? <Tag tone="success">{t('settings.available', { version: provider.version ?? '' })}</Tag> : <Tag tone="danger">{t('settings.missing', { command: provider.command })}</Tag>}
        {provider.authenticated === false && <Tag tone="warning">{t('settings.notAuthenticated')}</Tag>}
        {provider.authenticated === true && <Tag tone="neutral">{t('settings.authenticated')}</Tag>}
        <span className={css.count}>{t('settings.sessions', { n: count })}</span>
      </div>
      {!provider.available && provider.error && <div className={css.error}>{provider.error}</div>}
      <div className={css.defaults}>{t('settings.defaults')}</div>
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('page.permissionMode')}</span>
          <select className={css.select} value={permissionMode} onChange={event => setPermissionMode(event.target.value)} aria-label={t('page.permissionMode')}>
            {['', ...(provider.permissionModes ?? [])].map(mode => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('page.model')}</span>
          <Input value={model} placeholder={t('page.modelPlaceholder')} aria-label={t('page.model')} onChange={event => setModel(event.target.value)} />
        </label>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={() => {
          void onSave(provider.id, { permissionMode, model: model.trim() }).then(answer => {
            if (answer.ok) {
              setSaved(true)
              setTimeout(() => setSaved(false), 1500)
            }
          })
        }}>{saved ? t('settings.saved') : t('settings.save')}</Button>
      </div>
      <div className={css.hint}>{t('options.hint', { name: provider.label })}</div>
    </section>
  )
}

export function SettingsSection({ t, useAgentProviders, useAgentSettings, useAgentSessions, saveSettings, refreshProviders, refresh }) {
  const providers = useAgentProviders(s => s)
  const settings = useAgentSettings(s => s)
  const sessions = useAgentSessions(s => s.byProvider)
  return (
    <div className={css.section}>
      <h3 className={css.title}>{t('settings.title')}</h3>
      <p className={css.intro}>{t('settings.intro')}</p>
      {providers.error !== null && <p className={css.error}>{providers.error}</p>}
      {providers.list.map(provider => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          defaults={settings.providers[provider.id]}
          count={sessions[provider.id]?.list.length ?? 0}
          t={t}
          onSave={(id, value) => saveSettings({ ...settings.providers, [id]: value })}
        />
      ))}
      <div className={css.actions}>
        <Button variant="outline" size="sm" onClick={() => {
          void refreshProviders()
          for (const provider of providers.list) void refresh(provider.id)
        }}>{t('settings.refresh')}</Button>
      </div>
    </div>
  )
}
