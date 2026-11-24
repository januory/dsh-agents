/**
 * Choose which disk records an opened session shows while a turn is live. The
 * live turn's own records (including text still streaming and not yet written
 * to disk) are replayed by the poll from seq 0, so only the history before the
 * turn's start comes from disk. An active entry the host cannot stream (no
 * turnId) has no poll to fill the gap, so its disk window is shown.
 * @param {object[]} events - records read from disk (possibly a byte-tail window)
 * @param {{ turnId?: string, seq?: number, startedAt?: number } | undefined} active
 * @returns {{ events: object[], fromSeq: number }}
 */
export function selectOpenWindow(events, active) {
  if (active?.turnId === undefined) return { events, fromSeq: 0 }
  return { events: Number.isFinite(active.startedAt) ? events.filter(event => event.ts < active.startedAt) : [], fromSeq: 0 }
}