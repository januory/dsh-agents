const COMMANDS = [
  { name: 'file', section: 'add', icon: 'paperclip', labelKey: 'palette.file', descKey: 'palette.file.desc', available: () => true },
  { name: 'goal', section: 'add', icon: 'goal', labelKey: 'palette.goal', descKey: 'palette.goal.desc', available: ({ provider, hasSession }) => hasSession && provider?.commands?.includes('goal') === true },
  { name: 'plan', section: 'add', icon: 'plan', labelKey: 'palette.plan', descKey: 'palette.plan.desc', available: ({ provider, hasSession }) => hasSession && provider?.commands?.includes('plan') === true },
  { name: 'compact', section: 'commands', icon: 'compact', labelKey: 'palette.compact', descKey: 'palette.compact.desc', available: ({ provider, hasSession }) => hasSession && provider?.commands?.includes('compact') === true },
]

export function commandRows({ provider, hasSession, t }) {
  return COMMANDS.filter(entry => entry.available({ provider, hasSession })).map(entry => ({
    name: entry.name,
    section: t(`palette.section.${entry.section}`),
    label: t(entry.labelKey),
    description: t(entry.descKey),
    icon: entry.icon,
  }))
}

const WORD = /[\p{L}\p{N}_]/u

/** dsh's '/' trigger rule: live at draft start, after whitespace or punctuation; dead inside words and URLs. */
export function detectSlash(draft, caret) {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft[i]
    if (/\s/.test(ch)) return null
    if (ch !== '/') continue
    if (i === 0) return { start: i, end: caret, query: draft.slice(i + 1, caret) }
    const prev = draft[i - 1]
    if (/\s/.test(prev)) return { start: i, end: caret, query: draft.slice(i + 1, caret) }
    if (WORD.test(prev) || prev === '/') return null
    if (prev === ':' && i >= 2 && !/\s/.test(draft[i - 2])) return null
    return { start: i, end: caret, query: draft.slice(i + 1, caret) }
  }
  return null
}

export function hitKey(hit) {
  return `${hit.start}:${hit.end}:${hit.query}`
}

export function applyToken(draft, hit) {
  return { text: draft.slice(0, hit.start) + draft.slice(hit.end), caret: hit.start }
}

function subsequence(term, key) {
  let at = 0
  for (const ch of term) {
    at = key.indexOf(ch, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

function termScore(term, key) {
  if (key.startsWith(term)) return 4 + term.length / key.length
  if (key.includes(term)) return 3 + term.length / key.length
  if (subsequence(term, key)) return 2 + term.length / key.length
  return 0
}

/** Empty query keeps the sectioned registry order; a typed query ranks flat over name and label only. */
export function filterRows(rows, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return rows
  const scored = []
  rows.forEach((row, index) => {
    const keys = [row.name.toLowerCase(), row.label.toLowerCase()]
    let total = 0
    for (const term of terms) {
      const best = Math.max(...keys.map(key => termScore(term, key)))
      if (best === 0) return
      total += best
    }
    scored.push({ row, index, total })
  })
  scored.sort((a, b) => b.total - a.total || a.index - b.index)
  return scored.map(entry => entry.row)
}

/** The goal claim grammar: empty objective views, `clear` clears, anything else sets. */
export function goalClaim(text) {
  const match = /^\/(goal|目标)(?:[ \t]+([\s\S]*))?$/.exec(text)
  if (match === null) return null
  const objective = (match[2] ?? '').trim()
  if (objective === '') return { op: 'get', objective: '' }
  if (/^clear$/i.test(objective)) return { op: 'clear', objective: '' }
  return { op: 'set', objective }
}

export function goalPrefix(t) {
  return `/${t('goal.token')} `
}
