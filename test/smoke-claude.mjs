import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeProvider } from '../src/providers/claude.js'
import { TurnManager } from '../src/turns.js'

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

async function runTurn(turns, request) {
  const seen = new Map()
  const answered = new Set()
  const { turnId } = await turns.start(provider, request)
  console.log('turn', turnId, 'resume', request.sessionId ?? '(new)')
  let sessionId
  for (let i = 0; i < 480; i++) {
    await new Promise(r => setTimeout(r, 250))
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

if (process.argv.includes('--turn') || process.argv.includes('--tool') || process.argv.includes('--ask')) {
  const cwd = join(process.cwd(), 'tmp', 'smoke-claude')
  mkdirSync(cwd, { recursive: true })
  const turns = new TurnManager({ retentionMs: 60_000, abandonTimeoutMs: 120_000, logger: console })
  const text = process.argv.includes('--ask') ? 'Use the Bash tool to run `touch probe.txt` in the current directory, then reply done.'
    : process.argv.includes('--tool') ? 'Use the Bash tool to run `echo hello` and report its output.' : 'Reply with exactly: OK'
  const options = process.argv.includes('--manual') ? { permissionMode: 'manual' } : undefined
  const sessionId = await runTurn(turns, { cwd, text, options })
  if (process.argv.includes('--tool') && sessionId) {
    const t = await provider.readTranscript(sessionId)
    console.log('disk transcript after turn', t.events.map(e => `${e.type}${e.name ? ':' + e.name : ''}${e.status ? ':' + e.status : ''}`).join(', '))
    await runTurn(turns, { cwd, sessionId, text: 'What command did you just run? Answer in one short sentence.' })
  }
  turns.dispose()
}
