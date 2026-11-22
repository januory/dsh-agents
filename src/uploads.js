import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { harnessHome } from './store.js'

const MAX_BYTES = 20 * 1024 * 1024
const RETENTION_MS = 24 * 60 * 60 * 1000
const TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])
const ID_PATTERN = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/

export function uploadsDir() {
  return join(harnessHome(), 'agent-cli', 'uploads')
}

export function uploadPath(id) {
  return ID_PATTERN.test(id) ? join(uploadsDir(), id) : null
}

export function mediaTypeOf(id) {
  for (const [type, ext] of TYPES) if (id.endsWith(ext)) return type
  return 'application/octet-stream'
}

/** Store one pasted image; prunes uploads nobody sent within a day. */
export function saveUpload(mediaType, bytes) {
  const ext = TYPES.get(mediaType)
  if (ext === undefined) throw new Error(`unsupported image type: ${mediaType}`)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error(`image size out of range: ${bytes.byteLength}`)
  const dir = uploadsDir()
  mkdirSync(dir, { recursive: true })
  const cutoff = Date.now() - RETENTION_MS
  for (const name of readdirSync(dir)) {
    if (!ID_PATTERN.test(name)) continue
    const file = join(dir, name)
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
    } catch {}
  }
  const id = `${randomUUID()}${ext}`
  writeFileSync(join(dir, id), bytes)
  return id
}

export function readUpload(id) {
  const file = uploadPath(id)
  if (file === null || !existsSync(file)) throw new Error(`unknown attachment: ${id}`)
  return { path: file, mediaType: mediaTypeOf(id), bytes: readFileSync(file) }
}
