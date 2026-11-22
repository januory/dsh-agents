const KEY = 'dsh.agents.draft.v1'

// Text drafts persist per session like dsh's conversation store; attachments
// are runtime-only (object URLs) and survive session switches, not reloads.
export function readDraft(key) {
  try { return localStorage.getItem(`${KEY}.${key}`) ?? '' } catch { return '' }
}

export function writeDraft(key, text) {
  try {
    if (text === '') localStorage.removeItem(`${KEY}.${key}`)
    else localStorage.setItem(`${KEY}.${key}`, text)
  } catch {}
}

const held = new Map()

export function takeAttachments(key) {
  const items = held.get(key) ?? []
  held.delete(key)
  return items
}

export function holdAttachments(key, items) {
  if (items.length > 0) held.set(key, items)
  else held.delete(key)
}
