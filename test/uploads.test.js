import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaTypeOf, readUpload, saveUpload, uploadPath, uploadsDir } from '../src/uploads.js'

function home() {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-agents-uploads-'))
  return process.env.DSH_HOME
}

test('saveUpload stores bytes under the harness home and readUpload returns them', () => {
  const dir = home()
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3])
  const id = saveUpload('image/png', bytes)
  assert.match(id, /^[0-9a-f-]{36}\.png$/)
  assert.equal(uploadPath(id), join(dir, 'agent-cli', 'uploads', id))
  const stored = readUpload(id)
  assert.equal(stored.mediaType, 'image/png')
  assert.deepEqual(stored.bytes, bytes)
  assert.deepEqual(readFileSync(stored.path), bytes)
  assert.equal(mediaTypeOf('x.jpg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.webp'), 'image/webp')
  assert.equal(mediaTypeOf('x.gif'), 'image/gif')
})

test('saveUpload refuses unsupported types and out-of-range sizes', () => {
  home()
  assert.throws(() => saveUpload('image/svg+xml', Buffer.from('<svg/>')), /unsupported image type/)
  assert.throws(() => saveUpload('text/plain', Buffer.from('x')), /unsupported image type/)
  assert.throws(() => saveUpload('image/png', Buffer.alloc(0)), /size out of range/)
  assert.throws(() => saveUpload('image/png', Buffer.alloc(20 * 1024 * 1024 + 1)), /size out of range/)
  assert.equal(existsSync(uploadsDir()), false)
})

test('uploadPath rejects anything but a stored id and readUpload reports unknown attachments', () => {
  home()
  for (const bad of ['../secret.png', '/etc/passwd', 'abc.png', `${'a'.repeat(36)}.exe`, `${'a'.repeat(36)}.PNG`, '', 'x.png']) {
    assert.equal(uploadPath(bad), null, bad)
  }
  assert.throws(() => readUpload('../secret.png'), /unknown attachment/)
  assert.throws(() => readUpload(`${'a'.repeat(36)}.png`), /unknown attachment/)
})

test('saveUpload prunes uploads older than a day and keeps fresh ones', () => {
  home()
  const fresh = saveUpload('image/png', Buffer.from('fresh'))
  const stale = saveUpload('image/gif', Buffer.from('stale'))
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000
  utimesSync(uploadPath(stale), old, old)
  writeFileSync(join(uploadsDir(), 'notes.txt'), 'keep me')
  const next = saveUpload('image/jpeg', Buffer.from('next'))
  assert.deepEqual(readdirSync(uploadsDir()).sort(), [fresh, next, 'notes.txt'].sort())
})
