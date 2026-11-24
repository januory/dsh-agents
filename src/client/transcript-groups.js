/**
 * Segment a transcript into turns, each an ordered list of runs: a maximal run
 * of process rows (thinking/tools) folds as a group, an assistant reply flushes
 * that group and stands in its own place. Replies keep their chronological
 * position instead of clumping after all the process rows.
 * @param {object[]} events
 * @returns {{ id: string, user: object | undefined, segments: { kind: 'process' | 'response', events: object[] }[] }[]}
 */
export function groupTurns(events) {
  const turns = []
  let current = { id: 'lead', user: undefined, segments: [] }
  turns.push(current)
  for (const event of events) {
    if (event.type === 'user') {
      current = { id: event.id, user: event, segments: [] }
      turns.push(current)
      continue
    }
    if (event.type === 'turn' && event.reason !== 'compact') continue
    const kind = event.type === 'assistant' ? 'response' : 'process'
    const last = current.segments[current.segments.length - 1]
    if (last !== undefined && last.kind === kind) last.events.push(event)
    else current.segments.push({ kind, events: [event] })
  }
  return turns.filter(turn => turn.user !== undefined || turn.segments.length > 0)
}