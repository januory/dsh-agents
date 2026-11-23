import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

const windows = process.platform === 'win32'

const FALLBACK_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  ...(windows ? [join(homedir(), 'AppData', 'Roaming', 'npm'), join(homedir(), 'AppData', 'Local', 'pnpm')] : ['/opt/homebrew/bin', '/usr/local/bin']),
]

const live = new Set()
process.on('exit', () => {
  for (const child of live) killTree(child, 'SIGKILL')
})

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || (windows && path.startsWith('~\\'))) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve a CLI command to an executable path. A GUI-launched host may carry a
 * minimal PATH, so common user install directories are searched as a fallback.
 * Accepts a bare name or a path (absolute, `~`-prefixed or relative) with either
 * separator; on Windows PATHEXT extensions are tried the way cmd.exe tries them.
 * @param {string} command
 * @returns {string | undefined}
 */
export function resolveCommand(command) {
  const expanded = expandHome(command)
  if (isAbsolute(expanded) || expanded.includes('/') || (windows && expanded.includes('\\'))) {
    for (const candidate of candidates(resolve(expanded))) if (executable(candidate)) return candidate
    return undefined
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...FALLBACK_DIRS]
  for (const dir of dirs) {
    for (const candidate of candidates(join(dir, expanded))) if (executable(candidate)) return candidate
  }
  return undefined
}

// npm on Windows writes an extensionless sh shim beside the .cmd; it is not
// spawnable, so a bare name is only tried when it already carries an extension.
function candidates(name) {
  if (!windows) return [name]
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase()).filter(ext => ext.startsWith('.'))
  const ext = extname(name).toLowerCase()
  if (ext === '') return exts.map(suffix => name + suffix)
  return exts.includes(ext) ? [name] : [name, ...exts.map(suffix => name + suffix)]
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function killTree(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (!windows) process.kill(-child.pid, signal)
    else {
      // Windows signals are an unconditional TerminateProcess of the one process,
      // which would orphan the CLI behind a .cmd wrapper and any shells it spawned.
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
      if (result.status !== 0) child.kill(signal)
    }
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

// Node >= 22 refuses to spawn .cmd/.bat directly (CVE-2024-27980), so cmd.exe runs
// them; it re-parses the line, hence ^ escapes on top of the C-runtime quoting.
function cmdLaunch(command, args) {
  const quote = arg => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(/([()%!^"<>&|])/g, '^$1')
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`] }
}

/**
 * Spawn a CLI and deliver stdout line by line.
 * @param {{ command: string, args: string[], cwd: string, env?: Record<string,string>, onLine: (line: string) => void, onStderr?: (text: string) => void, onExit: (info: { code: number | null, signal: string | null }) => void, onError: (error: Error) => void }} spec
 * @returns {{ write: (text: string) => void, endInput: () => void, kill: () => void, pid: number | undefined, stderr: () => string }}
 */
export function spawnLines(spec) {
  const wrapped = windows && /\.(cmd|bat)$/i.test(spec.command) ? cmdLaunch(spec.command, spec.args) : undefined
  const child = spawn(wrapped?.command ?? spec.command, wrapped?.args ?? spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
    windowsVerbatimArguments: wrapped !== undefined,
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
