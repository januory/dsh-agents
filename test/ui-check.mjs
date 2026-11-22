import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { solidPng } from './png.mjs'

const require = createRequire('/Volumes/Data/Projects/GitHub/deepseek-harness/package.json')
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? '/Volumes/Data/Projects/GitHub/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright')
const root = join(import.meta.dirname, '..')
const out = join(root, 'tmp')
mkdirSync(out, { recursive: true })
const log = readFileSync(join(out, 'web.log'), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
if (url === undefined) throw new Error('no startup URL in tmp/web.log')
const executablePath = join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const skipTurns = process.env.SKIP_TURNS === '1'

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
// A view persisted before the launch options existed must still hydrate.
await page.addInitScript(() => {
  localStorage.setItem('dsh.agents.view.v1', JSON.stringify({ source: 'dsh', selected: {}, query: '', expanded: {}, showHidden: false, groupBy: 'project' }))
})
const errors = []
let expectUploadFailure = false
page.on('console', msg => {
  if (msg.type() !== 'error' && msg.type() !== 'warning') return
  if (expectUploadFailure && /agent-cli\.upload|Failed to load resource/.test(`${msg.text()} ${msg.location()?.url ?? ''}`)) return
  errors.push(`[console.${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', error => errors.push(`[pageerror] ${error.message}`))
const shot = name => page.screenshot({ path: join(out, `${name}.png`), fullPage: false })
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok', name)
  } catch (error) {
    await shot(`fail-${name}`)
    console.log('FAIL', name, error.message.split('\n')[0])
    throw error
  }
}
const cardBox = selector => page.evaluate(sel => {
  const el = document.querySelector(sel)
  if (el === null) return null
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return { w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, padTop: s.paddingTop }
}, selector)
let dshCard = null
const switcher = () => page.locator('button[aria-label="切换工作区"], button[aria-label="Switch workspace"]').first()
const pickWorkspace = async label => {
  await switcher().click()
  await page.getByText(new RegExp(`^(${label})$`)).first().click()
  await page.waitForTimeout(600)
}

await step('load', async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await switcher().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  if (await notice.count() > 0) {
    await notice.first().click()
    await page.waitForTimeout(600)
  }
  for (let i = 0; i < 3; i++) {
    if (await page.locator('[role="dialog"]').count() === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  const state = await page.evaluate(() => {
    const header = document.querySelector('[data-slot="sidebar.workspaces"] [class*="_sectionHeader"]')
    const label = header?.querySelector('[class*="_sectionLabel"]')
    return { headerText: header?.textContent ?? '', labelDisplay: label ? getComputedStyle(label).display : 'missing', firstChildOwned: header?.firstElementChild?.hasAttribute('data-dsh-agents-source') ?? false }
  })
  console.log('  header:', JSON.stringify(state))
  if (!/DSH/.test(state.headerText) || state.labelDisplay !== 'none' || !state.firstChildOwned) throw new Error('dropdown not placed in the shipped section header')
  dshCard = await cardBox('[data-slot="conversation.composer.bar"] [class*="card"]')
  await shot('ui-01-dsh')
})

await step('switch-claude', async () => {
  await pickWorkspace('Claude 工作区|Claude workspace')
  await page.locator('[data-row-key^="agent:claude:"]').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await shot('ui-02-claude-list')
  console.log('  claude rows visible:', await page.locator('[data-row-key^="agent:claude:"]').count())
})

await step('open-transcript', async () => {
  await page.locator('[data-row-key^="agent:claude:"]').nth(1).click()
  await page.locator('[class*="dag-transcript"]').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1200)
  const dy = await page.evaluate(() => {
    const row = document.querySelector('[data-disclosure-row]')
    if (row === null) return 0
    const lead = row.querySelector('[class*="leading"]').getBoundingClientRect()
    const title = row.querySelector('[class*="title"]').getBoundingClientRect()
    return Math.abs((lead.top + lead.bottom) / 2 - (title.top + title.bottom) / 2)
  })
  if (dy > 1) throw new Error(`disclosure icon/title misaligned by ${dy}px`)
  await shot('ui-03-claude-transcript')
  console.log('  transcript items rendered:', await page.locator('[class*="dag-transcript"] > *').count())
})

await step('expand-tool', async () => {
  const tool = page.locator('[class*="dag-toolRow"]').first()
  if (await tool.count() > 0) {
    await tool.click()
    await page.waitForTimeout(600)
    await shot('ui-03b-tool-open')
  }
})

await step('top-new-session', async () => {
  if (await page.locator('[class*="dag-blank"]').count() !== 0) throw new Error('the blank new-session row is still rendered')
  await page.locator('[data-slot="sidebar.session.action"] button[aria-label="新建会话"], [data-slot="sidebar.session.action"] button[aria-label="New session"]').first().click()
  await page.waitForTimeout(600)
  const hero = await page.locator('[class*="dag-heroTitle"]').first().textContent()
  if (!/新的 Claude Code 会话|New Claude Code session/.test(hero ?? '')) throw new Error(`top button did not open a Claude session: ${hero}`)
  if (await page.locator('[data-slot="main.conversation"] [class*="dag-page"]').count() !== 0) throw new Error('a dsh conversation was created instead')
  const ours = await cardBox('[class*="dag-box-Composer"]')
  if (dshCard !== null && ours !== null && (Math.abs(ours.w - dshCard.w) > 2 || Math.abs(ours.h - dshCard.h) > 4 || ours.radius !== dshCard.radius || ours.padTop !== dshCard.padTop)) {
    throw new Error(`composer card differs from dsh: ${JSON.stringify(ours)} vs ${JSON.stringify(dshCard)}`)
  }
  await shot('ui-03c-top-new')
})

await step('model-menu', async () => {
  await page.locator('button[aria-label="模型"], button[aria-label="Model"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button').length > 2, { timeout: 30_000 })
  await page.waitForTimeout(400)
  await shot('ui-04-models')
  const items = await page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').allTextContents()
  console.log('  model items:', items.slice(0, 8).join(' | '))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
})

await step('mode-menu', async () => {
  await page.locator('button[aria-label="模式"], button[aria-label="Mode"]').click()
  await page.waitForTimeout(400)
  await shot('ui-04b-modes')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
})

await step('effort-menu', async () => {
  await page.locator('button[aria-label="思考强度"], button[aria-label="Reasoning effort"]').click()
  await page.locator('[role="menu"]').waitFor({ timeout: 5000 })
  const items = await page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').allTextContents()
  if (!items.some(x => /^(低|Low)$/.test(x)) || !items.some(x => /^(高|High)$/.test(x))) throw new Error(`effort levels missing: ${JSON.stringify(items)}`)
  await page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').filter({ hasText: /^(高|High)$/ }).first().click()
  await page.waitForTimeout(300)
  const chip = await page.locator('button[aria-label="思考强度"], button[aria-label="Reasoning effort"]').textContent()
  if (!/^(高|High)$/.test(chip.trim())) throw new Error(`effort chip did not update: ${chip}`)
  await page.locator('button[aria-label="思考强度"], button[aria-label="Reasoning effort"]').click()
  await page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').filter({ hasText: /^(默认强度|Default effort)$/ }).first().click()
  await page.waitForTimeout(300)
})

await step('workspace-new-session', async () => {
  const row = page.locator('[class*="dag-projectRow"]').filter({ has: page.locator('button[aria-label*="新建会话"], button[aria-label*="New session in"]') }).first()
  const label = (await row.locator('[class*="dag-title"]').textContent()).trim()
  await row.hover()
  await page.waitForTimeout(300)
  await shot('ui-04d-workspace-hover')
  await row.locator('button[aria-label*="新建会话"], button[aria-label*="New session in"]').click()
  await page.waitForTimeout(600)
  const chip = (await page.locator('button[aria-label="选择工作区"], button[aria-label="Choose workspace"]').textContent()).trim()
  if (chip !== label) throw new Error(`workspace + did not preset the directory: ${chip} vs ${label}`)
  await shot('ui-04e-workspace-new')
})

await step('workspace-menu', async () => {
  await page.locator('button[aria-label="选择工作区"], button[aria-label="Choose workspace"]').click()
  await page.locator('[role="menu"]').waitFor({ timeout: 5000 })
  await page.locator('[role="menu"] input, input[placeholder="搜索工作区"], input[placeholder="Search workspaces"]').first().waitFor({ timeout: 5000 })
  const text = await page.locator('[role="menu"]').textContent()
  if (!/添加工作区…|Add workspace…/.test(text ?? '')) throw new Error('the add-workspace entry is missing from the picker')
  await shot('ui-04g-workspace-menu')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
})

await step('rename-dialog', async () => {
  const row = page.locator('[data-row-key^="agent:claude:"]').first()
  await row.hover()
  await row.locator('button[aria-haspopup="menu"]').click()
  await page.getByText(/^(重命名|Rename)$/).first().click()
  const input = page.locator('input[aria-label="会话名称"], input[aria-label="Session name"]')
  await input.waitFor({ timeout: 5000 })
  await page.waitForTimeout(400)
  const fit = await page.evaluate(() => {
    const field = document.querySelector('input[aria-label="会话名称"], input[aria-label="Session name"]')
    const dialog = field.closest('[role="dialog"]') ?? field.closest('[class*="modal"], [class*="Modal"]') ?? field.parentElement.parentElement
    const a = field.getBoundingClientRect()
    const b = dialog.getBoundingClientRect()
    return { inside: a.left >= b.left && a.right <= b.right + 1, field: Math.round(a.width), dialog: Math.round(b.width) }
  })
  if (!fit.inside) throw new Error(`rename input overflows the dialog: ${JSON.stringify(fit)}`)
  const confirm = page.getByRole('button', { name: /^(重命名|Rename)$/ }).last()
  if (await confirm.isDisabled()) throw new Error('confirm should be enabled with the current title prefilled')
  await input.fill('')
  if (!(await confirm.isDisabled())) throw new Error('confirm should be disabled for an empty title')
  await shot('ui-04h-rename')
  await page.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await page.waitForTimeout(300)
})

await step('workspace-pin', async () => {
  const dir = join(root, 'tmp', 'workspace-pin')
  mkdirSync(dir, { recursive: true })
  // The header + opens the OS folder chooser, which a headless run cannot
  // drive; seed the pin through the plugin store and let the list refresh
  // render it, then remove it through the row menu (host round-trip).
  const stateFile = join(out, 'home', 'agent-cli', 'state.json')
  mkdirSync(join(out, 'home', 'agent-cli'), { recursive: true })
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { settings: { providers: {} }, sessions: {}, workspaces: {} }
  state.workspaces ??= {}
  state.workspaces.claude = [...(state.workspaces.claude ?? []).filter(w => w.path !== dir), { path: dir, addedAt: Date.now() }]
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const pinned = page.locator('[class*="dag-projectRow"]').filter({ hasText: 'workspace-pin' })
  await pinned.waitFor({ timeout: 20_000 })
  await pinned.hover()
  await page.waitForTimeout(300)
  await shot('ui-04f-workspace-pinned')
  await pinned.locator('button[aria-haspopup="menu"]').click()
  await page.getByText(/^(移除工作区|Remove workspace)$/).first().click()
  await page.waitForTimeout(800)
  if (await page.locator('[class*="dag-projectRow"]').filter({ hasText: 'workspace-pin' }).count() !== 0) throw new Error('pinned workspace was not removed')
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  if ((after.workspaces?.claude ?? []).some(w => w.path === dir)) throw new Error('remove did not reach the host store')
})

await step('workspace-pick-guard', async () => {
  const add = page.locator('[data-slot="sidebar.workspaces"] button[aria-label="新建工作区"], [data-slot="sidebar.workspaces"] button[aria-label="New workspace"]')
  await add.click()
  await page.waitForTimeout(500)
  const busy = await add.getAttribute('aria-busy')
  const disabled = await add.isDisabled()
  if (busy !== 'true' || !disabled) throw new Error(`picker button not guarded while a pick is in flight (busy=${busy}, disabled=${disabled})`)
  await page.evaluate(() => { const b = document.querySelector('[data-slot="sidebar.workspaces"] button[aria-label="新建工作区"], [data-slot="sidebar.workspaces"] button[aria-label="New workspace"]'); b.click(); b.click() })
  await page.waitForTimeout(400)
  if (await page.locator('[role="dialog"]').count() > 1) throw new Error('more than one picker dialog opened')
})

if (!skipTurns) await step('new-session-turn', async () => {
  await page.locator('button[aria-label="选择工作区"], button[aria-label="Choose workspace"]').click()
  await page.locator('[role="menu"]').waitFor({ timeout: 5000 })
  await page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').filter({ hasText: 'smoke-claude' }).first().click()
  await page.waitForTimeout(400)
  await shot('ui-04c-new-session')
  await page.locator('[class*="dag-textarea"]').fill('Reply with exactly: OK')
  await page.locator('button[aria-label="Send"], button[aria-label="发送"]').click()
  await page.locator('[class*="dag-statusLive"]').waitFor({ timeout: 30_000 })
  const status = await page.evaluate(() => {
    const el = document.querySelector('[class*="dag-statusLive"]')
    const row = el.closest('[class*="statusRow"]')
    return { color: getComputedStyle(el).color, border: getComputedStyle(row).borderTopWidth, text: el.textContent }
  })
  if (status.color !== 'rgb(217, 119, 87)' || status.border === '0px' || !/用时|elapsed/.test(status.text)) throw new Error(`live status wrong: ${JSON.stringify(status)}`)
  await page.locator('[class*="dag-assistantRow"]').filter({ hasText: 'OK' }).first().waitFor({ timeout: 90_000 })
  await page.waitForTimeout(1500)
  await shot('ui-05-turn-done')
})

if (!skipTurns) await step('resume-turn', async () => {
  await page.locator('[class*="dag-textarea"]').fill('What did you just reply? Answer in one word.')
  await page.locator('button[aria-label="Send"], button[aria-label="发送"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[class*="dag-assistantRow"]').length >= 2, { timeout: 90_000 })
  await page.waitForTimeout(2500)
  await shot('ui-06-resumed')
})

if (!skipTurns) await step('approval-turn', async () => {
  await page.locator('button[aria-label="模式"], button[aria-label="Mode"]').click()
  await page.waitForTimeout(300)
  await page.getByText(/^(每次询问|Ask every time)$/).first().click()
  await page.waitForTimeout(300)
  await page.locator('[class*="dag-textarea"]').fill('Use the Bash tool to run `touch ui-probe.txt` in the current directory, then reply done.')
  await page.locator('button[aria-label="Send"], button[aria-label="发送"]').click()
  await page.locator('[class*="dag-approval"]').first().waitFor({ timeout: 90_000 })
  await page.waitForTimeout(400)
  const allowStyle = await page.evaluate(() => {
    const card = document.querySelector('[class*="dag-approval"]')
    const button = [...card.querySelectorAll('button')].find(b => /^(允许|Allow)$/.test(b.textContent.trim()))
    const s = getComputedStyle(button)
    return { color: s.color, bg: s.backgroundColor }
  })
  if (allowStyle.color === allowStyle.bg) throw new Error(`allow button text equals its background: ${JSON.stringify(allowStyle)}`)
  await shot('ui-06b-approval')
  await page.getByRole('button', { name: /^(Allow|允许)$/ }).first().click()
  await page.locator('[class*="dag-toolRow"]').first().waitFor({ timeout: 90_000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('[class*="dag-status"]')
    return document.querySelectorAll('[class*="dag-assistantRow"]').length >= 3 && (el === null || el.textContent.trim() === '')
  }, { timeout: 90_000 })
  await page.waitForTimeout(1500)
  await shot('ui-06c-tool-done')
})

if (!skipTurns) await step('image-paste', async () => {
  const png = solidPng(160, 120, [220, 40, 40]).toString('base64')
  writeFileSync(join(out, 'probe-image.png'), Buffer.from(png, 'base64'))
  const paste = (name, type, b64) => page.evaluate(({ name, type, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type }))
    const area = document.querySelector('[class*="dag-textarea"]')
    area.focus()
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { name, type, b64 })
  const items = page.locator('[class*="dag-imageItem"]')
  const send = page.locator('button[aria-label="Send"], button[aria-label="发送"]')
  expectUploadFailure = true
  await page.route('**/api/agent-cli.upload**', route => route.abort())
  await paste('probe.png', 'image/png', png)
  await page.locator('[class*="dag-imageItem"][data-status="error"]').waitFor({ timeout: 15_000 })
  if (!(await send.isDisabled())) throw new Error('send stayed enabled while an upload had failed')
  await shot('ui-06d-image-upload-error')
  await page.unroute('**/api/agent-cli.upload**')
  await items.first().locator('button[aria-label="上传失败，点击重试"], button[aria-label="Upload failed; click to retry"]').click()
  await page.locator('[class*="dag-imageItem"][data-status="ready"]').waitFor({ timeout: 15_000 })
  expectUploadFailure = false
  await paste('notes.txt', 'text/plain', Buffer.from('hello').toString('base64'))
  await page.waitForTimeout(300)
  if (await items.count() !== 1) throw new Error('an unsupported paste entered the rail')
  const hint = await page.locator('[class*="dag-hintError"]').textContent()
  if (!/仅支持|Only PNG/.test(hint ?? '')) throw new Error(`no unsupported-type notice: ${hint}`)
  await paste('second.png', 'image/png', png)
  await page.waitForFunction(() => document.querySelectorAll('[class*="dag-imageItem"][data-status="ready"]').length === 2, { timeout: 15_000 })
  await items.nth(1).hover()
  await items.nth(1).locator('button[aria-label^="移除图片"], button[aria-label^="Remove image"]').click()
  await page.waitForTimeout(200)
  if (await items.count() !== 1) throw new Error('remove did not drop the thumbnail')
  await shot('ui-06e-image-pasted')
  await items.first().locator('button[aria-label="查看原图"], button[aria-label="View original"]').click()
  await page.locator('[role="dialog"][aria-label="原图预览"], [role="dialog"][aria-label="Original image preview"]').waitFor({ timeout: 5000 })
  await shot('ui-06f-image-lightbox')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.locator('[class*="dag-textarea"]').fill('What color is this image? Answer with one word.')
  await send.click()
  await page.locator('[class*="dag-userImages"] img').first().waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => { const img = document.querySelector('[class*="dag-userImages"] img'); return img !== null && img.complete && img.naturalWidth > 0 }, { timeout: 15_000 })
  const fit = await page.evaluate(() => { const r = document.querySelector('[class*="dag-userImages"] button').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
  if (fit.w > 240 || fit.h > 240 || fit.w < 100) throw new Error(`lone image not bounded to 240px: ${JSON.stringify(fit)}`)
  if (await items.count() !== 0) throw new Error('composer kept its thumbnails after a successful send')
  await page.locator('[class*="dag-assistantRow"]').filter({ hasText: /red/i }).first().waitFor({ timeout: 90_000 })
  await page.waitForTimeout(1500)
  await shot('ui-06g-image-turn')
  const current = await page.locator('[data-row-key^="agent:claude:"][aria-selected="true"]').getAttribute('data-row-key')
  await page.locator(`[data-row-key="${current}"]`).click()
  await page.waitForFunction(() => /1 张图片|1 images/.test(document.querySelector('[class*="dag-transcript"]')?.textContent ?? ''), { timeout: 30_000 })
  await shot('ui-06h-image-history')
})

await step('switch-codex', async () => {
  await pickWorkspace('Codex 工作区|Codex workspace')
  await page.waitForTimeout(2500)
  await shot('ui-07-codex')
})

await step('switch-back-dsh', async () => {
  await pickWorkspace('DSH 工作区|DSH workspace')
  await page.waitForTimeout(1200)
  const shipped = await page.locator('[data-row-key^="session:"]').count()
  const foreign = await page.locator('[data-row-key^="agent:"]').count()
  const labelHidden = await page.evaluate(() => {
    const label = document.querySelector('[data-slot="sidebar.workspaces"] [class*="_sectionLabel"]')
    return label ? getComputedStyle(label).display === 'none' : false
  })
  console.log('  shipped rows:', shipped, 'foreign rows:', foreign, 'label hidden:', labelHidden)
  if (foreign !== 0 || !labelHidden) throw new Error('dsh region not restored cleanly')
  await shot('ui-08-back-dsh')
})

await step('rail-fallback', async () => {
  const toggle = page.locator('button[aria-label="收起侧边栏"], button[aria-label="打开侧边栏"], button[aria-label="Collapse sidebar"], button[aria-label="Open sidebar"]').first()
  await toggle.click()
  await page.waitForTimeout(1200)
  await page.locator('[data-slot="sidebar.session.action"] button[aria-label="切换工作区"], [data-slot="sidebar.session.action"] button[aria-label="Switch workspace"]').first().waitFor({ timeout: 5000 })
  if (await page.locator('[data-dsh-agents-source]').count() !== 0) throw new Error('header dropdown still mounted in the rail')
  await shot('ui-08b-rail')
  await toggle.click()
  await page.waitForTimeout(1500)
  await page.locator('[data-dsh-agents-source] button[aria-label="切换工作区"], [data-dsh-agents-source] button[aria-label="Switch workspace"]').first().waitFor({ timeout: 5000 })
})

await step('settings', async () => {
  const candidates = page.getByText(/^(更多|More)$/)
  let lowest = null
  let lowestY = -1
  for (let i = 0; i < await candidates.count(); i++) {
    const box = await candidates.nth(i).boundingBox()
    if (box !== null && box.y > lowestY) { lowestY = box.y; lowest = candidates.nth(i) }
  }
  await lowest.click()
  await page.waitForTimeout(600)
  await page.getByText(/^(设置|Settings)$/).first().click()
  await page.waitForTimeout(1000)
  await page.getByText(/^(Agent CLI sessions|Agent CLI 会话)$/).first().click()
  await page.waitForTimeout(800)
  await shot('ui-09-settings')
})

console.log('console errors/warnings:', errors.length)
for (const e of errors.slice(0, 30)) console.log(' ', e.slice(0, 300))
await browser.close()
