// Mirror of the host's upload limits so a refusal surfaces before the bytes leave.
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export async function uploadImage(file) {
  const response = await fetch(`/api/agent-cli.upload?mediaType=${encodeURIComponent(file.type)}`, { method: 'POST', body: file, credentials: 'same-origin' })
  const answer = await response.json().catch(() => null)
  if (!response.ok || answer?.ok !== true) throw new Error(answer?.error ?? `upload failed (${response.status})`)
  return answer.id
}

export function attachmentUrl(id) {
  return `/api/agent-cli.attachment?id=${encodeURIComponent(id)}`
}
