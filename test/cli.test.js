import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { capture, resolveCommand, spawnLines } from '../src/providers/cli.js'

const windows = process.platform === 'win32'
const exe = name => windows ? `${name}.exe` : name
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const remove = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-cli-'))
  const saved = { path: process.env.PATH, pathext: process.env.PATHEXT }
  process.env.PATH = dir
  return {
    dir,
    file(name, content = '#!/bin/sh\n') {
      const path = join(dir, name)
      writeFileSync(path, content)
      chmodSync(path, 0o755)
      return path
    },
    cleanup() {
      process.env.PATH = saved.path
      if (saved.pathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = saved.pathext
      remove(dir)
    },
  }
}

test('a bare name resolves through PATH; an unknown name does not', () => {
  const s = sandbox()
  try {
    const target = s.file(exe('tool'))
    assert.equal(resolveCommand('tool'), target)
    assert.equal(resolveCommand(exe('tool')), target)
    assert.equal(resolveCommand('missing'), undefined)
  } finally {
    s.cleanup()
  }
})

test('a path is accepted with either separator, and without an extension on Windows', () => {
  const s = sandbox()
  try {
    const target = s.file(exe('tool'))
    assert.equal(resolveCommand(target), target)
    assert.equal(resolveCommand(target.split(sep).join('/')), target)
    if (windows) assert.equal(resolveCommand(join(s.dir, 'tool')), target)
    assert.equal(resolveCommand(join(s.dir, 'absent')), undefined)
  } finally {
    s.cleanup()
  }
})

test('a directory on PATH is not a command', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.dir, 'tool'), { recursive: true })
    mkdirSync(join(s.dir, exe('tool')), { recursive: true })
    assert.equal(resolveCommand('tool'), undefined)
    assert.equal(resolveCommand(exe('tool')), undefined)
  } finally {
    s.cleanup()
  }
})

test('~ expands to the home directory', () => {
  const dir = mkdtempSync(join(homedir(), 'dsh-agents-cli-'))
  try {
    const target = join(dir, exe('tool'))
    writeFileSync(target, '')
    chmodSync(target, 0o755)
    assert.equal(resolveCommand(`~/${basename(dir)}/tool`), target)
    if (windows) assert.equal(resolveCommand(`~\\${basename(dir)}\\tool`), target)
  } finally {
    remove(dir)
  }
})

test('a relative path resolves against the working directory', () => {
  const s = sandbox()
  const cwd = process.cwd()
  try {
    mkdirSync(join(s.dir, 'bin'))
    const file = join(s.dir, 'bin', exe('tool'))
    writeFileSync(file, '')
    chmodSync(file, 0o755)
    process.chdir(s.dir)
    // macOS tmpdir is a symlink; the cwd the resolver sees is the real path.
    const target = join(process.cwd(), 'bin', exe('tool'))
    assert.equal(resolveCommand('./bin/tool'), target)
    if (windows) assert.equal(resolveCommand('.\\bin\\tool'), target)
  } finally {
    process.chdir(cwd)
    s.cleanup()
  }
})

test('Windows tries PATHEXT in order and never the extensionless npm sh shim', { skip: !windows }, () => {
  const s = sandbox()
  try {
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    s.file('shim')
    assert.equal(resolveCommand('shim'), undefined)
    const cmd = s.file('shim.cmd', '@echo off\r\n')
    assert.equal(resolveCommand('shim'), cmd)
    assert.equal(resolveCommand('shim.cmd'), cmd)
    const executable = s.file('shim.exe')
    assert.equal(resolveCommand('shim'), executable)
    process.env.PATHEXT = '.CMD;.EXE'
    assert.equal(resolveCommand('shim'), cmd)
  } finally {
    s.cleanup()
  }
})

test('a .cmd shim runs through cmd.exe with its arguments intact', { skip: !windows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-cmd-'))
  try {
    writeFileSync(join(dir, 'echo.mjs'), `process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')\n`)
    const shim = join(dir, 'echo.cmd')
    writeFileSync(shim, `@"${process.execPath}" "%~dp0echo.mjs" %*\r\n`)
    const args = ['a b', 'x&y', 'he said "hi"', 'C:\\Program Files\\nodejs\\', '--model=claude-opus-4-5', '100%done']
    assert.equal(resolveCommand(join(dir, 'echo')), shim)
    assert.deepEqual(JSON.parse(await capture(shim, args)), args)
  } finally {
    remove(dir)
  }
})

test('killing a .cmd child takes down the CLI it wraps', { skip: !windows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-cmd-'))
  writeFileSync(join(dir, 'hang.mjs'), `process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000)\n`)
  writeFileSync(join(dir, 'hang.cmd'), `@"${process.execPath}" "%~dp0hang.mjs" %*\r\n`)
  let pid
  let failed
  const handle = spawnLines({
    command: join(dir, 'hang.cmd'),
    args: [],
    cwd: dir,
    onLine: line => { pid = Number(line) },
    onExit: () => {},
    onError: error => { failed = error },
  })
  try {
    const started = Date.now() + 5000
    while (pid === undefined && Date.now() < started) await sleep(20)
    assert.equal(failed, undefined)
    assert.ok(pid > 0, 'wrapped CLI never reported its pid')
    assert.ok(alive(pid))
    handle.kill()
    const stopped = Date.now() + 5000
    while (alive(pid) && Date.now() < stopped) await sleep(20)
    assert.equal(alive(pid), false)
  } finally {
    handle.kill()
    remove(dir)
  }
})
