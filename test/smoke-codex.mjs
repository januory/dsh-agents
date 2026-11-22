import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexProvider } from '../src/providers/codex.js'
import { TurnManager } from '../src/turns.js'
import { saveUpload } from '../src/uploads.js'
import { solidPng } from './png.mjs'

const provider = createCodexProvider({ command: process.env.CODEX_BIN ?? 'codex', home: process.env.CODEX_HOME_TEST ?? '' })
console.log('detect', await provider.detect())
try {
  const sessions = await provider.listSessions()
  console.log('sessions', sessions.length)
  for (const s of sessions.slice(0, 5)) console.log(' ', s.id, JSON.stringify({ title: s.title, cwd: s.cwd, updatedAt: new Date(s.updatedAt).toISOString(), model: s.model, historyMode: s.historyMode, source: s.source, live: s.live }))
  if (sessions[0]) {
    const t = await provider.readTranscript(sessions[0].id)
    console.log('transcript', sessions[0].id, 'events', t.events.length)
    for (const e of t.events.slice(0, 12)) console.log('  ', e.type, e.name ?? '', e.status ?? '', JSON.stringify(e.text ?? e.output ?? e.input ?? '').slice(0, 100))
  }
} catch (error) {
  console.log('list/read failed:', error.message)
}

if (process.argv.includes('--turn')) {
  const cwd = join(process.cwd(), 'tmp', 'smoke-codex')
  mkdirSync(cwd, { recursive: true })
  const turns = new TurnManager({ retentionMs: 60_000, abandonTimeoutMs: 120_000, logger: console })
  const seen = new Map()
  try {
    let images
    if (process.argv.includes('--image')) {
      process.env.DSH_HOME ??= join(process.cwd(), 'tmp', 'home')
      const png = solidPng(160, 120, [220, 40, 40])
      writeFileSync(join(process.cwd(), 'tmp', 'probe-image.png'), png)
      images = [{ id: saveUpload('image/png', png), mediaType: 'image/png' }]
    }
    const text = images === undefined ? 'Reply with exactly: OK' : 'What color is this image? Answer with one word.'
    const { turnId } = await turns.start(provider, { cwd, text, images })
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 250))
      const poll = turns.poll(turnId, 0)
      for (const e of poll.events) seen.set(e.id, e)
      if (!['starting', 'running', 'awaiting'].includes(poll.status)) {
        console.log('status', poll.status, 'error', poll.error, 'sessionId', poll.sessionId)
        break
      }
    }
    for (const e of seen.values()) console.log(' ', e.type, e.id.slice(0, 20), JSON.stringify(e.text ?? e.message ?? e.model ?? '').slice(0, 120))
    if (seen.size > 0) {
      const sessionId = [...seen.values()].length && turns.poll(turnId, 0).sessionId
      if (sessionId) {
        const t = await provider.readTranscript(sessionId)
        console.log('disk transcript', t.events.map(e => `${e.type}:${(e.text ?? '').slice(0, 30)}`).join(' | '))
      }
    }
  } catch (error) {
    console.log('turn failed:', error.message)
  }
  turns.dispose()
}
provider.dispose()
