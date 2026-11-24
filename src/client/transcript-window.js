/**
 * Choose which disk records an opened session shows while a turn is live, and
 * where polling resumes. The live turn's own records are streamed by the poll,
 * so records at/after its start are normally left to it.
 * @param {object[]} events - records read from disk (possibly a byte-tail window)
 * @param {{ turnId?: string, seq?: number, startedAt?: number } | undefined} active
 * @returns {{ events: object[], fromSeq: number }}
 */
export function selectOpenWindow(events, active) {
  if (active === undefined) return { events, fromSeq: 0 }
  if (Number.isFinite(active.startedAt)) {
    const before = events.filter(event => event.ts < active.startedAt)
    if (before.length > 0) return { events: before, fromSeq: 0 }
  }
  // The stored window lies entirely inside the live turn (a long session whose
  // byte-tail no longer reaches the turn's start, or an active entry without a
  // start): show what disk has and resume at the turn's current seq so its
  // records are not replayed on top of themselves.
  return { events, fromSeq: Number.isFinite(active.seq) ? active.seq : 0 }
}