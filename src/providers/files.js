import { closeSync, openSync, readSync, statSync } from 'node:fs'

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const records = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn tail line from a concurrent writer is not a record.
    }
  }
  return records
}

function readRange(path, start, length) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * First and last records of a JSONL file without loading the whole file.
 * @param {string} path
 * @param {{ headBytes?: number, tailBytes?: number }} [limits]
 */
export function headTail(path, { headBytes = 16 * 1024, tailBytes = 64 * 1024 } = {}) {
  const size = statSync(path).size
  if (size <= headBytes + tailBytes) {
    const records = parseLines(readRange(path, 0, size))
    return { head: records, tail: [], size }
  }
  const head = parseLines(readRange(path, 0, headBytes), { dropLast: true })
  const tail = parseLines(readRange(path, size - tailBytes, tailBytes), { dropFirst: true })
  return { head, tail, size }
}

/**
 * Last records of a JSONL file, bounded by bytes.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {{ records: object[], size: number, hasEarlier: boolean }}
 */
export function tailRecords(path, maxBytes) {
  const size = statSync(path).size
  if (size <= maxBytes) return { records: parseLines(readRange(path, 0, size)), size, hasEarlier: false }
  return { records: parseLines(readRange(path, size - maxBytes, maxBytes), { dropFirst: true }), size, hasEarlier: true }
}
