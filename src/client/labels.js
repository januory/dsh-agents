import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { ZH } from './locales.js'

export function markdownLabels(t) {
  return { code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') }, footnotes: t('markdown.footnotes') }
}

export function terminalLabels(t) {
  return {
    commandLine: n => t('tool.commandLine', { n }),
    signal: signal => t('tool.signal', { signal }),
    exitCode: code => t('tool.exitCode', { code }),
    noExitCode: t('tool.noExitCode'),
    running: t('tool.running'),
    failed: t('tool.error'),
    done: t('tool.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('tool.noOutput'),
    collapseAria: t('tool.collapseAria'),
    collapse: t('tool.collapse'),
    expandAria: n => t('tool.expandAria', { n }),
    expand: n => t('tool.expand', { n }),
  }
}

export function jsonLabels(t) {
  return {
    copyValue: t('json.copyValue'),
    copyJson: t('json.copyJson'),
    copyPath: t('json.copyPath'),
    copyPrettyJson: t('json.copyPrettyJson'),
    copyCompactJson: t('json.copyCompactJson'),
    copied: t('json.copied'),
    copyFailed: t('json.copyFailed'),
    collapseNode: t('json.collapseNode'),
    expandNode: t('json.expandNode'),
    copyButtonTitle: action => t('json.copyButtonTitle', { action }),
  }
}

export function timeLabel(at, now, t) {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

export function createdLabel(at, t) {
  const d = new Date(at)
  const pad = v => String(v).padStart(2, '0')
  const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hover.created', { time: `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` })
}

export function basename(path) {
  if (typeof path !== 'string' || path === '') return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export function modeLabel(mode, t) {
  if (mode === '') return t('options.default')
  return Object.hasOwn(ZH, `mode.${mode}`) ? t(`mode.${mode}`) : mode
}

export function modeDesc(mode, t) {
  const key = mode === '' ? 'mode.desc.default' : `mode.desc.${mode}`
  return Object.hasOwn(ZH, key) ? t(key) : ''
}

export function effortLabel(effort, t) {
  if (effort === '') return t('effort.default')
  return Object.hasOwn(ZH, `effort.${effort}`) ? t(`effort.${effort}`) : effort
}

export function tokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// The VSCode extension's counter clock: hidden under a second, then 45s / 2m 5s / 1h 5m.
export function taskDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total < 1) return ''
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function taskCounters(task, now, t) {
  const parts = []
  if (task.tokens > 0) parts.push(t('task.tokens', { n: tokenCount(task.tokens) }))
  if (task.toolUses > 0) parts.push(t(task.toolUses === 1 ? 'task.tool' : 'task.tools', { n: task.toolUses }))
  const duration = taskDuration((task.status === 'running' ? now : (task.finishedAt ?? now)) - (task.startedAt ?? now))
  if (duration !== '') parts.push(duration)
  return parts.join(' · ')
}

export function taskDotState(task) {
  if (task.status === 'running') return 'ongoing'
  if (task.status === 'completed') return 'done'
  if (task.status === 'failed') return 'error'
  if (task.status === 'killed' || task.status === 'blocked' || task.status === 'interrupted') return 'warning'
  return 'idle'
}

export function taskStatusLabel(task, t) {
  return Object.hasOwn(ZH, `task.status.${task.status}`) ? t(`task.status.${task.status}`) : task.status
}

export function runDuration(ms, t) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  let out = ''
  if (hours > 0) out += `${hours}${t('duration.hour')}`
  if (minutes > 0) out += `${minutes}${t('duration.minute')}`
  return out + `${seconds}${t('duration.second')}`
}
