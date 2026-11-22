import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeProvider } from '../src/providers/claude.js'
import { TurnManager } from '../src/turns.js'
import { saveUpload } from '../src/uploads.js'
import { solidPng } from './png.mjs'

const provider = createClaudeProvider({ command: '', home: '' })
console.log('detect', await provider.detect())
const sessions = await provider.listSessions()
console.log('sessions', sessions.length)
for (const s of sessions.slice(0, 3)) console.log(' ', s.id, JSON.stringify({ title: s.title, cwd: s.cwd, updatedAt: new Date(s.updatedAt).toISOString(), messages: s.messageCount, live: s.live }))
if (sessions[0]) {
  const t = await provider.readTranscript(sessions[0].id)
  const counts = {}
  for (const e of t.events) counts[e.type] = (counts[e.type] ?? 0) + 1
  console.log('transcript', sessions[0].id, 'events', t.events.length, counts, 'hasEarlier', t.session.hasEarlier)
}

async function runTurn(turns, request, steerText) {
  const seen = new Map()
  const answered = new Set()
  const { turnId } = await turns.start(provider, request)
  console.log('turn', turnId, 'resume', request.sessionId ?? '(new)')
  const startedAt = Date.now()
  let steered = steerText === undefined
  let sessionId
  for (let i = 0; i < (steerText === undefined ? 480 : 960); i++) {
    await new Promise(r => setTimeout(r, 250))
    if (!steered && Date.now() - startedAt > 3000) {
      steered = true
      try { console.log('steer', await turns.steer(turnId, { text: steerText })) } catch (error) { console.log('steer failed:', error.message) }
    }
    const poll = turns.poll(turnId, 0)
    sessionId = poll.sessionId
    for (const e of poll.events) {
      seen.set(e.id, e)
      if (e.type === 'approval' && e.status === 'running' && !answered.has(e.requestId)) {
        answered.add(e.requestId)
        console.log('  approval', e.name, JSON.stringify(e.input).slice(0, 100), '→ allow')
        turns.answer(turnId, e.requestId, 'allow')
      }
    }
    if (!['starting', 'running', 'awaiting'].includes(poll.status)) {
      console.log('status', poll.status, 'error', poll.error, 'usage', poll.usage, 'sessionId', poll.sessionId)
      break
    }
  }
  for (const e of seen.values()) console.log(' ', e.type, e.id.slice(0, 24), e.status ?? '', JSON.stringify(e.text ?? e.output ?? e.name ?? e.message ?? e.model ?? '').slice(0, 120))
  return sessionId
}

if (process.argv.includes('--turn') || process.argv.includes('--tool') || process.argv.includes('--ask') || process.argv.includes('--steer')) {
  const cwd = join(process.cwd(), 'tmp', 'smoke-claude')
  mkdirSync(cwd, { recursive: true })
  const turns = new TurnManager({ retentionMs: 60_000, abandonTimeoutMs: 120_000, logger: console })
  const text = process.argv.includes('--ask') ? 'Use the Bash tool to run `touch probe.txt` in the current directory, then reply done.'
    : process.argv.includes('--tool') ? 'Use the Bash tool to run `echo hello` and report its output.'
      : process.argv.includes('--steer') ? 'Think carefully and write a 150-word story about a lighthouse. End your reply with exactly FIRST.' : 'Reply with exactly: OK'
  const options = process.argv.includes('--manual') ? { permissionMode: 'manual' } : undefined
  let images
  if (process.argv.includes('--image')) {
    process.env.DSH_HOME ??= join(process.cwd(), 'tmp', 'home')
    const png = solidPng(160, 120, [220, 40, 40])
    writeFileSync(join(process.cwd(), 'tmp', 'probe-image.png'), png)
    images = [{ id: saveUpload('image/png', png), mediaType: 'image/png' }]
  }
  const prompt = images === undefined ? text : 'What color is this image? Answer with one word.'
  const sessionId = await runTurn(turns, { cwd, text: prompt, options, images }, process.argv.includes('--steer') ? 'Now reply with exactly SECOND.' : undefined)
  if (process.argv.includes('--tool') && sessionId) {
    const t = await provider.readTranscript(sessionId)
    console.log('disk transcript after turn', t.events.map(e => `${e.type}${e.name ? ':' + e.name : ''}${e.status ? ':' + e.status : ''}`).join(', '))
    await runTurn(turns, { cwd, sessionId, text: 'What command did you just run? Answer in one short sentence.' })
  }
  turns.dispose()
}
