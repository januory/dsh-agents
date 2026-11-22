import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const FALLBACK_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

const live = new Set()
process.on('exit', () => {
  for (const child of live) killTree(child, 'SIGKILL')
})

/**
 * Resolve a CLI command to an executable path. A GUI-launched host may carry a
 * minimal PATH, so common user install directories are searched as a fallback.
 * @param {string} command
 * @returns {string | undefined}
 */
export function resolveCommand(command) {
  if (command.includes('/')) {
    const expanded = command.startsWith('~/') ? join(homedir(), command.slice(2)) : command
    return isAbsolute(expanded) && executable(expanded) ? expanded : undefined
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...FALLBACK_DIRS]
  for (const dir of dirs) {
    const candidate = join(dir, command)
    if (executable(candidate)) return candidate
  }
  return undefined
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function killTree(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * Spawn a CLI and deliver stdout line by line.
 * @param {{ command: string, args: string[], cwd: string, env?: Record<string,string>, onLine: (line: string) => void, onStderr?: (text: string) => void, onExit: (info: { code: number | null, signal: string | null }) => void, onError: (error: Error) => void }} spec
 * @returns {{ write: (text: string) => void, endInput: () => void, kill: () => void, pid: number | undefined, stderr: () => string }}
 */
export function spawnLines(spec) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  live.add(child)
  let stdoutRest = ''
  let stderrText = ''
  let exited = false
  const settle = info => {
    if (exited) return
    exited = true
    live.delete(child)
    if (stdoutRest !== '') {
      spec.onLine(stdoutRest)
      stdoutRest = ''
    }
    spec.onExit(info)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdoutRest += chunk
    let index
    while ((index = stdoutRest.indexOf('\n')) !== -1) {
      const line = stdoutRest.slice(0, index)
      stdoutRest = stdoutRest.slice(index + 1)
      if (line.trim() !== '') spec.onLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderrText = (stderrText + chunk).slice(-16_384)
    spec.onStderr?.(chunk)
  })
  child.on('error', error => {
    live.delete(child)
    spec.onError(error)
    settle({ code: null, signal: null })
  })
  child.on('close', (code, signal) => settle({ code, signal }))
  child.stdin.on('error', () => { /* the CLI may close stdin before we finish writing */ })
  let killTimer
  return {
    pid: child.pid,
    write: text => { if (!exited && child.stdin.writable) child.stdin.write(text) },
    endInput: () => { if (!exited && child.stdin.writable) child.stdin.end() },
    stderr: () => stderrText,
    kill: () => {
      if (exited) return
      killTree(child, 'SIGTERM')
      killTimer ??= setTimeout(() => killTree(child, 'SIGKILL'), 3_000)
      killTimer.unref?.()
    },
  }
}

/**
 * Run a command to completion and capture stdout (for `--version` probes).
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export function capture(command, args, timeoutMs = 8_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = ''
    const handle = spawnLines({
      command,
      args,
      cwd: homedir(),
      onLine: line => { out += `${line}\n` },
      onStderr: () => {},
      onExit: ({ code }) => {
        clearTimeout(timer)
        if (code === 0) resolvePromise(out.trim())
        else rejectPromise(new Error(`${command} ${args.join(' ')} exited with ${code}`))
      },
      onError: error => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    })
    const timer = setTimeout(() => {
      handle.kill()
      rejectPromise(new Error(`${command} ${args.join(' ')} timed out`))
    }, timeoutMs)
    handle.endInput()
  })
}

export function parseJsonLine(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
