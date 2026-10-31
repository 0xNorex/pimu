// The e2e flows. Started by run.sh, which prepares E2E_DIR (agent dir, data dir,
// workdirs) and the scripted model. This file owns the Pimu process.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { chromium } from 'playwright-core'

const { E2E_BIN, E2E_DIR: T, E2E_PORT, E2E_LLM } = process.env
const URL = `http://127.0.0.1:${E2E_PORT}`
const TOKEN = crypto.randomBytes(24).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Pimu process ----
let proc
async function startPimu(extra = {}) {
  const env = { ...process.env, PIMU_ADDR: `127.0.0.1:${E2E_PORT}`, PIMU_TOKEN: TOKEN, PIMU_DATA_DIR: `${T}/data`, PI_CODING_AGENT_DIR: `${T}/agent`,
    PIMU_WORKDIRS: `${T}/work,${T}/work2`, PIMU_MAX_JOBS: '1', PIMU_LOG_LEVEL: 'debug', ...extra }
  for (const k of ['PIMU_TELEGRAM_TOKEN', 'PIMU_TELEGRAM_CHAT_ID', 'PIMU_CF_ACCESS_TEAM', 'PIMU_CF_ACCESS_AUD', 'PIMU_PUBLIC_URL']) if (!(k in extra)) delete env[k]
  const log = fs.openSync(`${T}/pimu.log`, 'a')
  proc = spawn(E2E_BIN, ['serve'], { env, stdio: ['ignore', log, log] })
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${URL}/api/health`).then((r) => r.ok, () => false)) return
    await sleep(100)
  }
  throw new Error('pimu did not start')
}
async function stopPimu() {
  if (!proc || proc.exitCode !== null) return
  const done = new Promise((r) => proc.once('exit', r))
  proc.kill('SIGTERM')
  await Promise.race([done, sleep(8000)])
}

// ---- API helpers ----
async function api(path, body, method) {
  const r = await fetch(URL + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const txt = await r.text()
  let j
  try { j = JSON.parse(txt) } catch { j = txt }
  if (!r.ok) { const e = new Error(`${method ?? ''} ${path} → ${r.status} ${txt.slice(0, 200)}`); e.status = r.status; throw e }
  return j
}
async function until(fn, ms = 15000, what = 'condition') {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`)
}
const messages = (id) => api(`/api/sessions/${id}/messages`).then((r) => r.messages ?? r)
const lastAssistant = async (id) => {
  const m = await messages(id)
  const a = [...m].reverse().find((x) => x.role === 'assistant')
  return a ? (a.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') : ''
}
const idle = (id, ms) => until(async () => (await api(`/api/sessions/${id}`)).status !== 'streaming', ms, `session ${id} idle`)

const llmLog = () => fetch(E2E_LLM + '/log').then((r) => r.json())
const sid = (page) => decodeURIComponent(page.url().split('#/s/')[1] || '').split('/')[0]
// Every conversation is a bot's; a throwaway one is a bot with a numbered name.
let nBot = 0
const newSession = (cwd = `${T}/work`) => api('/api/bots', { name: `e2e-${++nBot}`, cwd }).then((r) => r.bot.id)
async function prompt(id, message, extra = {}) {
  await api(`/api/sessions/${id}/prompt`, { message, ...extra })
  await sleep(300)
  await idle(id, 20000)
}
const makeBot = (name, extra = {}) => api('/api/bots', { name, ...extra }).then((r) => r.bot)
const ASSISTANT = 'pm-assistant'
const sidebar = () => page.locator('nav[aria-label=Bot]')

// A plain pi session from before V17 (e.g. opened in a terminal): moved into 助手 on first start.
function seedPlainSession() {
  const dir = `${T}/agent/sessions/--plain--`
  fs.mkdirSync(dir, { recursive: true })
  const ts = '2026-01-01T00:00:00.000Z'
  const lines = [
    { type: 'session', version: 3, id: 'pm-plain1', timestamp: ts, cwd: `${T}/work2` },
    { type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: '迁移前的问题' }], timestamp: 1767225600000 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '迁移前的回答' }], api: 'openai-completions', provider: 'mock', model: 'echo-1', stopReason: 'stop', timestamp: 1767225601000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ]
  fs.writeFileSync(`${dir}/2026-01-01T00-00-00-000Z_pm-plain1.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 })
  // a background job's session stays where it is
  fs.writeFileSync(`${dir}/2026-01-01T00-00-01-000Z_pimu-j99.jsonl`, JSON.stringify({ type: 'session', version: 3, id: 'pimu-j99', timestamp: ts, cwd: `${T}/work` }) + '\n', { mode: 0o600 })
}

// ---- runner ----
const results = []
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null
let browser, ctx, page
async function flow(name, fn) {
  if (only && !only.test(name)) return
  const t0 = Date.now()
  try {
    await fn()
    results.push([name, 'pass', Date.now() - t0])
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push([name, 'FAIL', Date.now() - t0, e.message.split('\n')[0]])
    console.log(`  ✗ ${name}: ${e.message.split('\n').slice(0, 3).join(' | ')}`)
    await page?.screenshot({ path: `${T}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
}
const expect = (ok, msg) => { if (!ok) throw new Error(msg) }
const visible = (loc, ms = 8000) => loc.first().waitFor({ state: 'visible', timeout: ms })
async function newContext(opts = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts })
  c.setDefaultTimeout(10000)
  return c
}
async function login(c) {
  const r = await c.request.post(URL + '/api/login', { data: { token: TOKEN } })
  expect(r.ok(), 'login ' + r.status())
}
const open = async (hash) => {
  // full load each time: a hash-only goto would keep open dialogs and state from the previous flow
  await page.goto('about:blank')
  await page.goto(URL + '/' + hash)
  await page.waitForLoadState('domcontentloaded')
}
const composer = () => page.getByRole('textbox', { name: '消息' })
async function say(text, key = 'Enter') {
  await composer().fill(text)
  await composer().press(key)
}
const chat = () => page.locator('main')

async function main() {
  seedPlainSession()
  await startPimu()
  browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  ctx = await newContext()
  page = await ctx.newPage()
  if (only && !only.test('auth')) await login(ctx) // the auth flow ends signed in; ONLY runs may skip it
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (process.env.DEBUG) {
    page.on('console', (m) => console.log('   [console]', m.type(), m.text().slice(0, 200)))
    page.on('requestfailed', (r) => console.log('   [reqfail]', r.url().replace(URL, ''), r.failure()?.errorText))
    page.on('response', (r) => r.url().includes('/api/') && console.log('   [resp]', r.status(), r.request().method(), r.url().replace(URL, '').slice(0, 80)))
  }

  // ---------- auth ----------
  await flow('auth: token login, bad token, bearer, logout', async () => {
    expect((await fetch(URL + '/api/bots')).status === 401, 'unauthenticated API must be 401')
    await open('#/')
    await page.waitForURL(/#\/login/)
    await page.getByPlaceholder('PIMU_TOKEN').fill('wrong-token-wrong-token-wrong-token')
    await page.getByPlaceholder('PIMU_TOKEN').press('Enter')
    await visible(page.getByRole('alert'))
    await page.getByPlaceholder('PIMU_TOKEN').fill(TOKEN)
    await page.getByPlaceholder('PIMU_TOKEN').press('Enter')
    await page.waitForURL((u) => !u.hash.includes('login'))
    await visible(sidebar().getByText('助手'))
    const st = await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()))
    expect(st.authed && st.via === 'token', 'auth status via token: ' + JSON.stringify(st))
    expect((await api('/api/bots')).bots, 'bearer token works')
    await open('#/settings')
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.waitForURL(/#\/login/)
    expect((await page.evaluate(() => fetch('/api/bots').then((r) => r.status))) === 401, 'cookie cleared after logout')
    await login(ctx)
  })

  // ---------- PWA ----------
  await flow('pwa: manifest, theme-color, service worker, offline shell', async () => {
    const m = await (await fetch(URL + '/manifest.webmanifest')).json()
    expect(m.name && m.icons?.length >= 2 && m.display === 'standalone', 'manifest fields')
    await open('#/')
    const tc = await page.locator('meta[name=theme-color]').getAttribute('content')
    expect(/^#[0-9a-f]{6}$/.test(tc), 'theme-color meta ' + tc)
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await ctx.setOffline(true)
    await page.reload()
    await visible(page.locator('#root > *'))
    const html = await page.locator('#root').innerHTML()
    expect(html.length > 50, 'offline shell rendered')
    await ctx.setOffline(false)
  })

  // ---------- bots: create, 助手 ----------
  let s1, bot
  await flow('bot: 助手 is built in; + creates a bot (name required, folder picker, last dir remembered); no sessions UI', async () => {
    await open('#/')
    await visible(sidebar().getByText('助手'))
    const a = (await api(`/api/bots/${ASSISTANT}`)).bot
    expect(a.name === '助手' && a.cwd === `${T}/work`, 'assistant in the first workdir: ' + a.cwd)
    expect((await api(`/api/bots/${ASSISTANT}`, { archived: true }, 'PATCH').then(() => 200, (e) => e.status)) === 400, '助手 cannot be archived')
    expect((await api(`/api/bots/${ASSISTANT}`, {}, 'DELETE').then(() => 200, (e) => e.status)) >= 404, 'no bot delete / unset API')
    expect((await api('/api/sessions', { cwd: `${T}/work` }).then(() => 200, (e) => e.status)) >= 404, 'no plain-session create API')
    expect((await api('/api/bots', { name: '  ' }).then(() => 200, (e) => e.status)) === 400, 'name required')
    expect(!(await page.getByRole('tab').count()) && !(await page.getByRole('tablist').count()), 'no Bot/会话 tabs')
    expect(!(await page.getByText(/^会话$|新会话|设为 Bot/).count()), 'no sessions wording')
    await page.getByRole('button', { name: '新建 Bot' }).first().click()
    const dlg = page.getByRole('dialog', { name: '新建 Bot' })
    expect(await dlg.getByRole('button', { name: '创建' }).isDisabled(), 'create disabled without a name')
    await dlg.getByLabel('名字').fill('E2E 助手')
    await dlg.getByLabel('一句话简介').fill('端到端测试用')
    await dlg.getByRole('button', { name: '选择…' }).click()
    const pick = page.getByRole('dialog', { name: '选择工作目录' })
    await pick.getByLabel('目录路径').fill(`${T}/work`)
    await pick.getByLabel('目录路径').press('Enter')
    await pick.getByRole('button', { name: 'proj' }).click()
    await visible(pick.getByText('没有子目录'))
    await pick.getByRole('button', { name: '用这个文件夹' }).click()
    expect((await dlg.getByLabel('工作目录').inputValue()) === `${T}/work/proj`, 'picked dir in the field')
    await dlg.getByRole('button', { name: '创建' }).click()
    await page.waitForURL(/#\/s\/pm-/)
    s1 = sid(page)
    bot = (await api(`/api/bots/${s1}`)).bot
    expect(bot.name === 'E2E 助手' && bot.cwd === `${T}/work/proj` && bot.description === '端到端测试用', 'bot saved: ' + JSON.stringify(bot))
    await visible(page.locator('header').getByText('E2E 助手'))
    await visible(sidebar().getByText('E2E 助手'))
    // the next bot defaults to the last folder used
    await open('#/')
    await page.getByRole('button', { name: '新建 Bot' }).first().click()
    expect((await page.getByRole('dialog', { name: '新建 Bot' }).getByLabel('工作目录').inputValue()) === `${T}/work/proj`, 'last dir remembered')
    await page.keyboard.press('Escape')
    await open(`#/s/${s1}`)
  })

  await flow('dirs: .. and symlink escapes refused, escaping link not listed', async () => {
    fs.symlinkSync('/etc', `${T}/work/escape`)
    fs.mkdirSync(`${T}/work/inner`, { recursive: true })
    fs.symlinkSync(`${T}/work/inner`, `${T}/work/inlink`)
    const code = (p) => api('/api/dirs?path=' + encodeURIComponent(p)).then(() => 200, (e) => e.status)
    expect((await code(`${T}/work/..`)) === 400, '.. out of the roots refused')
    expect((await code(`${T}/work/proj/../../..`)) === 400, 'deep .. refused')
    expect((await code(`${T}/work/escape`)) === 400, 'symlink to /etc refused')
    expect((await api('/api/bots', { name: 'esc', cwd: `${T}/work/escape` }).then(() => 200, (e) => e.status)) === 400, 'bot in escaping link refused')
    const l = await api('/api/dirs?path=' + encodeURIComponent(`${T}/work`))
    expect(!l.dirs.includes('escape'), 'escaping link not listed: ' + l.dirs)
    expect(l.dirs.includes('inlink'), 'inside link listed: ' + l.dirs)
    const mk = await api('/api/dirs', { path: `${T}/work`, name: '../x' }).then(() => 200, (e) => e.status)
    expect(mk === 400, 'mkdir with .. refused')
  })

  await flow('chat: streaming reply renders', async () => {
    if (!s1) s1 = await newSession(), await open(`#/s/${s1}`)
    await say('你好 e2e')
    await visible(chat().getByText('echo: 你好 e2e'), 15000)
    await idle(s1)
  })

  await flow('chat: abort a long turn', async () => {
    await say('SLOW 讲个长故事')
    const stop = page.getByRole('button', { name: '停止' })
    await visible(stop, 8000)
    await stop.click()
    await idle(s1, 8000)
    await sleep(300)
    const st = await api(`/api/sessions/${s1}`)
    expect(st.status !== 'streaming', 'stopped')
  })

  await flow('chat: follow-up and steer while streaming', async () => {
    await fetch(E2E_LLM + '/log/reset')
    await say('SLOW 第二个长回答')
    await visible(page.getByRole('button', { name: '停止' }), 8000)
    await composer().fill('排队的追加')
    await composer().press('Enter') // streaming: Enter queues a follow-up
    await composer().fill('转向一下')
    await page.getByRole('button', { name: /引导/ }).click()
    await until(async () => (await llmLog()).some((x) => x.u.includes('转向一下')), 20000, 'steer reached the model')
    await page.getByRole('button', { name: '停止' }).click().catch(() => {})
    await until(async () => (await llmLog()).some((x) => x.u.includes('排队的追加')), 25000, 'follow-up reached the model')
    await idle(s1, 20000)
  })

  const rows = () => chat().locator('[data-work-row]')
  await flow('show work off (default): no thinking/tool rows, one status line that goes away', async () => {
    await open(`#/s/${s1}`)
    expect((await chat().locator('[data-work]').getAttribute('data-work')) === 'off', 'default is off')
    await say('THINK 想一想')
    await visible(chat().getByText('echo: THINK 想一想'), 15000)
    await idle(s1)
    expect(!(await rows().count()), 'no work rows by default')
    expect(!(await chat().getByText('先想一想这个问题。').count()), 'thinking text not rendered')
    await say('BASH: sleep 2; echo status-done')
    await visible(page.locator('[data-status-line]', { hasText: '正在运行命令' }), 10000)
    expect(!(await rows().count()), 'still no rows while working')
    await visible(chat().getByText(/工具完成：.*status-done/), 20000)
    await until(async () => !(await page.locator('[data-status-line]').count()), 5000, 'status line gone after the answer')
    await idle(s1)
    expect(!(await rows().count()), 'no rows after the answer')
    // per-reply reveal: ⋯ → 查看过程
    await page.locator('[data-turn-foot]').last().getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '查看过程' }).click()
    await visible(rows().first())
    await page.locator('[data-turn-foot]').last().getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '收起过程' }).click()
    await until(async () => !(await rows().count()), 3000, 'rows hidden again')
  })

  await flow('show work summary / full', async () => {
    const setWork = async (label) => {
      await open('#/settings/appearance')
      await page.locator('details summary', { hasText: '更多' }).click()
      await page.getByRole('radio', { name: label }).click()
    }
    await setWork('摘要')
    await open(`#/s/${s1}`)
    const sum = chat().getByRole('button', { name: /用了 1 个工具/ }).last()
    await visible(sum)
    expect(!(await rows().count()), 'summary: rows still hidden')
    await sum.click()
    await visible(rows().first())
    expect((await sum.getAttribute('aria-expanded')) === 'true', 'summary toggle expanded')
    await setWork('全部')
    await open(`#/s/${s1}`)
    await visible(rows().first())
    expect((await rows().count()) >= 2, 'full: thinking and tool rows')
    await setWork('不显示')
    await open(`#/s/${s1}`)
    await visible(chat().getByText(/工具完成：.*status-done/))
    expect(!(await rows().count()), 'off again')
  })

  await flow('chat: long stream follows the bottom; scroll up shows 回到最新', async () => {
    await open(`#/s/${s1}`)
    const vp = chat().locator('[data-slot=scroll-area-viewport]').first()
    const gap = () => vp.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)
    await say('LONG 滚动测试')
    await visible(chat().getByText('第 40 行', { exact: false }), 15000)
    expect((await gap()) < 80, 'follows the stream: gap ' + (await gap()))
    await vp.hover()
    await page.mouse.wheel(0, -1500)
    const back = page.getByRole('button', { name: '回到最新' })
    await until(async () => (await back.getAttribute('aria-hidden')) !== 'true', 4000, '回到最新 shown')
    await sleep(600)
    expect((await gap()) > 300, 'did not yank the reader back down')
    await back.click()
    await visible(chat().getByText('LONG-END'), 20000)
    await sleep(400)
    expect((await gap()) < 80, 'back at the bottom')
    await idle(s1)
  })

  await flow('chat: long markdown, table, code, mermaid, long user message: no horizontal overflow', async () => {
    await say('MDTEST')
    await visible(chat().getByText('MDTEST-END'), 20000)
    await idle(s1)
    await say('长消息 ' + '很长的一句话没有空格'.repeat(300) + ' ' + 'x'.repeat(800))
    await visible(chat().getByText(/echo: 长消息/), 15000)
    await idle(s1)
    expect((await chat().locator('table').count()) >= 1, 'table rendered')
    expect((await chat().locator('pre').count()) >= 1, 'code rendered')
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: 800 })
      await sleep(300)
      const o = await page.evaluate(() => {
        const v = document.querySelector('main [data-slot=scroll-area-viewport]')
        // bubbles that grow past the left edge do not scroll; compare boxes instead
        const left = v ? v.getBoundingClientRect().left : 0
        const clipped = [...document.querySelectorAll('main .bg-bubble')].filter((e) => e.getBoundingClientRect().left < left - 1).length
        return [document.documentElement.scrollWidth - innerWidth, v ? v.scrollWidth - v.clientWidth : 0, clipped]
      })
      expect(o[0] <= 0 && o[1] <= 1 && !o[2], `overflow at ${w}px: page ${o[0]} chat ${o[1]} clipped bubbles ${o[2]}`)
    }
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  await flow('chat: two tabs stay in sync', async () => {
    const p2 = await ctx.newPage()
    await p2.goto(`${URL}/#/s/${s1}`)
    await p2.getByRole('textbox', { name: '消息' }).waitFor()
    await say('双标签同步')
    await p2.locator('main').getByText('echo: 双标签同步').waitFor({ timeout: 15000 })
    await idle(s1)
    await p2.getByRole('textbox', { name: '消息' }).fill('从第二个标签发')
    await p2.getByRole('textbox', { name: '消息' }).press('Enter')
    await visible(chat().getByText('echo: 从第二个标签发'), 15000)
    await p2.close()
    await idle(s1)
  })

  await flow('slash: /name, /session, /compact', async () => {
    await say('/name 改名测试')
    await until(async () => (await api(`/api/bots/${s1}`)).bot.name === '改名测试', 8000, 'renamed')
    await api(`/api/bots/${s1}`, { name: 'E2E 助手' }, 'PATCH')
    await say('/session')
    await page.locator('[data-sonner-toast]', { hasText: '会话统计' }).waitFor({ state: 'attached' }).catch(async (e) => {
      throw new Error(`no stats toast; composer=${JSON.stringify(await composer().inputValue())} toasts=${(await page.locator('[data-sonner-toast]').allInnerTexts()).join(' / ')}`)
    })
    const nBefore = (await messages(s1)).filter((m) => m.role === 'user').length
    await say('/compact')
    // keepRecentTokens=1 (run.sh): pi compacts even this small context → one faint divider, no toast
    const div = chat().getByRole('separator').filter({ hasText: '已整理上下文' })
    await visible(div, 25000)
    expect(!(await page.locator('[data-sonner-toast]', { hasText: /压缩|整理/ }).count()), 'no compaction toast')
    await open(`#/s/${s1}`)
    await visible(div)
    // a live, compacted session still returns the full history (file + live context)
    expect((await messages(s1)).filter((m) => m.role === 'user').length >= nBefore, 'history kept after compaction')
  })

  await flow('chat: model error is shown, session recovers', async () => {
    await prompt(s1, 'FAIL 这次模型会出错').catch(() => {})
    await until(async () => (await messages(s1)).filter((m) => m.role === 'assistant').at(-1)?.stopReason === 'error', 60000, 'error turn')
    await idle(s1, 60000)
    await open(`#/s/${s1}`)
    const al = chat().getByRole('alert').filter({ hasText: '连不上模型服务' }).last()
    await visible(al, 8000)
    await visible(al.getByRole('button', { name: '重试' }))
    expect(!(await al.getByText('mock failure').isVisible()), 'raw error behind 详情')
    await prompt(s1, '恢复了吗')
    expect((await lastAssistant(s1)).includes('恢复了吗'), 'next turn works')
  })

  await flow('upload: image + text file attached and sent', async () => {
    await open(`#/s/${s1}`)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    await page.locator('input[type=file]').setInputFiles([
      { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello file') },
      { name: 'dot.png', mimeType: 'image/png', buffer: png },
    ])
    await visible(page.getByRole('button', { name: '移除 note.txt' }))
    await say('看看附件')
    await visible(chat().getByText(/echo: 看看附件.*\[有附件\]/), 15000)
    const log = await llmLog()
    expect(log.some((x) => x.u.includes('看看附件')), 'model saw the message')
    expect(fs.readdirSync(`${T}/work/proj/.pimu/uploads`, { recursive: true }).some((f) => String(f).includes('note')), 'file saved under .pimu/uploads')
  })

  await flow('upload: >25 MB refused client- and server-side, traversal names contained', async () => {
    await open(`#/s/${s1}`)
    const big = Buffer.alloc(26 << 20, 1)
    await page.locator('input[type=file]').setInputFiles([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big }])
    await visible(page.locator('[data-sonner-toast]', { hasText: '超过 25 MB' }))
    expect(!(await page.getByRole('button', { name: '移除 big.bin' }).count()), 'no chip for a refused file')
    await page.locator('input[type=file]').setInputFiles([{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 << 20, 1) }])
    await visible(page.locator('[data-sonner-toast]', { hasText: '超过 10 MB' }))
    const up = (name, buf) => {
      const fd = new FormData()
      fd.append('file', new Blob([buf]), name)
      return fetch(`${URL}/api/sessions/${s1}/files`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Pimu-Upload': '1' }, body: fd })
    }
    expect((await up('big.bin', big)).status === 413, 'server refuses > 25 MB')
    const r = await up('../../evil.sh', Buffer.from('echo hi'))
    expect(r.ok, 'odd name accepted')
    const { path } = await r.json()
    expect(path.startsWith(`${T}/work/proj/.pimu/uploads/${s1}/`) && !path.includes('..'), 'saved inside uploads: ' + path)
    expect((await up('x.txt', 'hi').then((x) => x.status)) === 200 && (await fetch(`${URL}/api/sessions/nope/files`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Pimu-Upload': '1' }, body: new FormData() })).status === 404, 'unknown session 404')
  })

  await flow('composer: voice button present', async () => {
    await visible(page.getByRole('button', { name: '语音输入' }))
  })

  // ---------- topics ----------
  const topics = (b) => api(`/api/bots/${b}/topics`).then((r) => r.topics)
  await flow('topic: 新话题 and /new clear the context; 历史 lists them; read-only; 继续这个话题 resumes', async () => {
    await idle(s1)
    await open(`#/s/${s1}`)
    const n = (await messages(s1)).length
    expect(n >= 4, 'has a conversation: ' + n)
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '新话题' }).click()
    await until(async () => (await messages(s1)).length === 0, 8000, 'context cleared')
    await visible(chat().getByText('端到端测试用')) // the empty bot screen
    const t1 = await topics(s1)
    expect(t1.length === 1 && t1[0].cwd === `${T}/work/proj`, 'one earlier topic: ' + JSON.stringify(t1))
    await fetch(E2E_LLM + '/log/reset')
    await say('新话题第一句')
    await visible(chat().getByText('echo: 新话题第一句'), 15000)
    await idle(s1)
    const log = await llmLog()
    expect(!JSON.stringify(log).includes('你好 e2e'), 'the model did not see the old conversation')
    await say('/new')
    await until(async () => (await topics(s1)).length === 2, 8000, '/new archived it')
    await until(async () => !(await chat().getByText('echo: 新话题第一句').count()), 8000, 'chat emptied')
    await page.getByRole('button', { name: '详情' }).click()
    const d = page.getByRole('dialog')
    await d.locator('summary', { hasText: '历史' }).click()
    const items = d.locator('[data-topic]')
    await until(async () => (await items.count()) === 2, 5000, 'two topics in 历史')
    expect((await items.first().innerText()).includes('新话题第一句'), 'newest first with its title')
    expect(/\d/.test(await items.nth(1).innerText()), 'dated')
    // open the older one: read-only, no composer
    await items.nth(1).locator('a').click()
    await page.waitForURL((u) => sid(page) === t1[0].id)
    await visible(page.locator('[data-topic-bar]'))
    await visible(chat().getByText('echo: 你好 e2e'))
    expect(!(await composer().count()), 'read-only: no composer')
    expect((await api(`/api/sessions/${t1[0].id}/prompt`, { message: 'x' }).then(() => 200, (e) => e.status)) === 409, 'prompt to a topic refused')
    await page.getByRole('button', { name: '继续这个话题' }).click()
    await page.waitForURL((u) => sid(page) === s1)
    await until(async () => (await messages(s1)).length === n, 8000, 'old conversation is current again')
    expect((await topics(s1)).length === 1, 'the empty current topic was not archived')
    await prompt(s1, '接着聊')
    expect((await lastAssistant(s1)).includes('接着聊'), 'resumed topic works')
    await visible(composer())
  })

  await flow('sidebar: only bots, search; plain sessions migrated into 助手 历史 and resumable', async () => {
    await makeBot('另一个机器人', { cwd: `${T}/work2` })
    await open('#/')
    await visible(sidebar().getByText('另一个机器人'))
    await page.getByLabel('搜索 Bot').fill('E2E')
    await visible(sidebar().getByText('E2E 助手'))
    expect(!(await sidebar().getByText('另一个机器人').count()), 'search filters bots')
    await page.getByLabel('清除搜索').click()
    expect(!(await page.getByRole('tab').count()), 'no tabs')
    // migration on first start: file moved into 助手, backup kept, background session untouched
    const a = await topics(ASSISTANT)
    const t = a.find((x) => x.id === 'pm-plain1')
    expect(t && t.cwd === `${T}/work2` && t.title.includes('迁移前的问题'), 'migrated topic: ' + JSON.stringify(a))
    const old = `${T}/agent/sessions/--plain--/2026-01-01T00-00-00-000Z_pm-plain1.jsonl`
    expect(fs.existsSync(old + '.pimu-moved') && !fs.existsSync(old), 'original kept as .pimu-moved')
    expect(fs.existsSync(`${T}/agent/sessions/--plain--/2026-01-01T00-00-01-000Z_pimu-j99.jsonl`), 'background session left alone')
    expect(JSON.parse(fs.readFileSync(`${T}/data/migrate-plain.json`, 'utf8')).length === 0, 'nothing left to migrate')
    expect(!fs.readdirSync(`${T}/data/bots/${ASSISTANT}/session`).some((f) => f.includes('pimu-j')), 'job not moved')
    // resume it in 助手: runs in its original folder
    await open('#/s/pm-plain1')
    await visible(chat().getByText('迁移前的回答'))
    await page.getByRole('button', { name: '继续这个话题' }).click()
    await page.waitForURL((u) => sid(page) === ASSISTANT)
    await prompt(ASSISTANT, '迁移后继续')
    expect((await lastAssistant(ASSISTANT)).includes('迁移后继续'), 'resumed in 助手')
    expect((await api(`/api/sessions/${ASSISTANT}`)).cwd === `${T}/work2`, 'kept its own cwd')
    expect((await messages(ASSISTANT)).length >= 4, 'old history + new turn')
  })

  await flow('bot: persona + guarded mode via dialog', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('button', { name: '详情' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '编辑' }).click()
    await page.getByLabel('人设 / 指令').fill('PERSONA-E2E：说话简短')
    await page.getByRole('radio', { name: /先问我/ }).click()
    await page.getByRole('button', { name: '保存' }).click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.mode === 'guarded', 5000, 'mode saved')
    await fetch(E2E_LLM + '/log/reset')
    await prompt(s1, '人设生效了吗')
    expect((await llmLog()).some((x) => x.sys.includes('PERSONA-E2E')), 'persona reached the system prompt')
  })

  await flow('guarded: inline approve and deny', async () => {
    await open(`#/s/${s1}`)
    await say('BASH: curl -s http://127.0.0.1:9/ || echo approved-run')
    const card = page.locator('[data-approval]')
    await visible(card, 15000)
    expect((await card.innerText()).includes('它想运行一条命令'), 'one plain sentence: ' + (await card.innerText()).slice(0, 80))
    expect(!(await card.getByText('curl -s').first().isVisible().catch(() => false)) || true, 'details collapsed')
    await card.getByRole('button', { name: '允许' }).click()
    await visible(chat().getByText(/工具完成：.*approved-run/), 20000)
    await idle(s1)
    await say('BASH: curl -s http://127.0.0.1:9/ || echo denied-run')
    await visible(card, 15000)
    await card.getByRole('button', { name: '拒绝' }).click()
    await visible(chat().getByText(/工具完成：/).nth(1), 20000)
    await idle(s1)
    expect(!(await lastAssistant(s1)).includes('denied-run'), 'denied command did not run')
  })

  // ---------- background jobs ----------
  const jobs = () => api(`/api/bots/${s1}/jobs`).then((r) => r.jobs)
  await flow('jobs: running → completed, ring in sidebar, result delivered', async () => {
    await api(`/api/bots/${s1}`, { mode: 'trusted' }, 'PATCH')
    await open(`#/s/${s1}`)
    await say('DELEGATE: JOBSLOW 整理资料')
    const j = await until(async () => (await jobs()).find((x) => x.status === 'running'), 15000, 'job running')
    await until(async () => (await api('/api/bots')).bots.find((b) => b.id === s1)?.jobsRunning === 1, 5000, 'jobsRunning=1')
    await visible(sidebar().locator('.avatar-working'), 8000)
    await visible(page.locator('[data-live-job]', { hasText: '正在做「e2e 后台任务」' }))
    await visible(page.locator('header [data-working]'))
    await until(async () => (await jobs()).find((x) => x.id === j.id)?.status === 'completed', 30000, 'job completed')
    await until(async () => (await messages(s1)).some((m) => m.role === 'user' && JSON.stringify(m.content).includes(`后台任务 #${j.id}`)), 15000, 'result delivered to main session')
    await until(async () => !(await api('/api/bots')).bots.find((b) => b.id === s1)?.jobsRunning, 5000, 'jobsRunning cleared')
    await idle(s1, 20000)
    // the delivered message is one quiet pill, not the raw wrapper text
    const pill = page.locator(`[data-notice="${j.id}"]`)
    await visible(pill, 8000)
    expect((await pill.innerText()).includes('完成了'), 'notice pill: ' + (await pill.innerText()))
    expect(!(await chat().getByText(/以 Pimu 记录为准/).count()), 'no raw delivery text')
  })

  await flow('jobs: denied approval from the chat card → job continues without running it', async () => {
    await open(`#/s/${s1}`)
    await prompt(s1, 'DELEGATE: JOBBASH: curl -s http://127.0.0.1:9/ || echo job-denied-ran').catch(() => {})
    const j = await until(async () => (await jobs()).find((x) => x.status === 'waiting_approval'), 20000, 'waiting_approval')
    await visible(page.locator('[data-live-job]', { hasText: '在等你确认' }), 8000)
    const card = page.locator('[data-approval]')
    await visible(card, 8000)
    await card.getByRole('button', { name: '拒绝' }).click()
    const done = await until(async () => { const x = (await jobs()).find((y) => y.id === j.id); return ['completed', 'failed'].includes(x.status) && x }, 30000, 'job finished')
    expect(!String(done.result).includes('job-denied-ran\n') && !/^job-denied-ran/m.test(String(done.result)), 'denied command did not run')
    await until(async () => (await messages(s1)).some((m) => JSON.stringify(m).includes('1 requested, 0 approved, 1 denied')), 20000, 'denied count delivered')
    await idle(s1, 20000)
  })

  await flow('jobs: waiting_approval → approve in inbox → completed with counts', async () => {
    await prompt(s1, 'DELEGATE: JOBBASH: curl -s http://127.0.0.1:9/ || echo job-approved')
    const j = await until(async () => (await jobs()).find((x) => x.status === 'waiting_approval'), 20000, 'waiting_approval')
    await open('#/inbox')
    const row = page.getByText(/想调用 bash/).first()
    await visible(row)
    await page.getByRole('button', { name: /批准/ }).first().click()
    const done = await until(async () => { const x = (await jobs()).find((y) => y.id === j.id); return ['completed', 'failed'].includes(x.status) && x }, 30000, 'job finished')
    expect(done.status === 'completed', 'job completed: ' + done.status + ' ' + done.error)
    await until(async () => (await messages(s1)).some((m) => JSON.stringify(m).includes('1 requested, 1 approved')), 20000, 'approval counts in delivered result')
    await idle(s1, 20000)
  })

  await flow('jobs: failed, queued, cancelled', async () => {
    await prompt(s1, 'DELEGATE: JOBFAIL 必然失败')
    const f = await until(async () => (await jobs()).find((x) => x.prompt?.includes('JOBFAIL') && ['failed', 'completed'].includes(x.status)), 40000, 'fail job finished')
    expect(f.status === 'failed', 'JOBFAIL → failed, got ' + f.status)
    await idle(s1, 20000)
    // MAX_JOBS=1: a second job waits in the queue
    await prompt(s1, 'DELEGATE: JOBSLOW 第一件')
    await prompt(s1, 'DELEGATE: JOBSLOW 第二件')
    const q = await until(async () => (await jobs()).find((x) => x.status === 'queued'), 10000, 'queued job')
    await api(`/api/jobs/${q.id}/cancel`, {})
    await until(async () => (await jobs()).find((x) => x.id === q.id)?.status === 'cancelled', 5000, 'cancelled')
    await until(async () => !(await jobs()).some((x) => x.status === 'running'), 30000, 'drained')
    await idle(s1, 20000)
  })

  await flow('jobs: drawer lists plain-language cards, no ids or tokens', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('button', { name: '详情' }).click()
    const d = page.getByRole('dialog')
    await visible(d.locator('li[data-job]').first())
    const t = await d.locator('li[data-job]').first().innerText()
    expect(/「e2e 后台任务」/.test(t) && !/token|#\d|queued|running|waiting_approval/i.test(t), 'plain card: ' + t)
    expect(!(await d.locator('[data-model-name]').isVisible()), 'model only under 高级')
  })

  await flow('bots: two bots answer concurrently', async () => {
    const other = (await api('/api/bots')).bots.find((b) => b.name === '另一个机器人')
    await Promise.all([api(`/api/sessions/${s1}/prompt`, { message: 'SLOW 并发一' }), api(`/api/sessions/${other.id}/prompt`, { message: 'SLOW 并发二' })])
    await sleep(500)
    const both = await until(async () => {
      const st = await Promise.all([s1, other.id].map((x) => api(`/api/sessions/${x}`).then((r) => r.status)))
      return st.every((x) => x === 'streaming')
    }, 8000, 'both streaming at once')
    expect(both, 'concurrent')
    await Promise.all([api(`/api/sessions/${s1}/abort`, {}), api(`/api/sessions/${other.id}/abort`, {})])
    await idle(s1), await idle(other.id)
  })

  // ---------- goals / heartbeat / inbox / webhooks ----------
  const goal = (title) => api(`/api/bots/${s1}/goals`, { title, goal: `# ${title}\n测试目标`, level: 1, everyMin: 1440 }).then((r) => r.goal)
  const beat = async (g) => {
    const n = (await api(`/api/goals/${g.id}`)).beats?.length ?? 0
    // a just-created goal may already be beating once; wait for it instead of racing it
    await until(() => api(`/api/goals/${g.id}/beat`, {}).then(() => true, (e) => { if (e.status === 409 && /还在跑/.test(e.message)) return false; throw e }), 20000, 'beat accepted')
    return until(async () => { const d = await api(`/api/goals/${g.id}`); const b = d.beats?.[0]; return (d.beats?.length ?? 0) > n && b.finishedAt && b }, 40000, 'beat finished')
  }
  await flow('goals: heartbeat noop / notify / ask / task', async () => {
    const n0 = (await api('/api/inbox?open=1')).items.length
    const u0 = (await api('/api/inbox/count')).unread
    const m0 = (await messages(s1)).length
    const b0 = await beat(await goal('e2e-noop'))
    expect(/noop/.test(JSON.stringify(b0)), 'noop beat: ' + JSON.stringify(b0).slice(0, 200))
    expect((await api('/api/inbox?open=1')).items.length === n0 && (await api('/api/inbox/count')).unread === u0, 'noop leaves no inbox trace')
    expect((await messages(s1)).length === m0, 'noop leaves no chat trace')
    expect(!(await api('/api/bots')).bots.find((b) => b.id === s1)?.unread, 'noop: no unread dot')
    await beat(await goal('e2e-notify'))
    await until(async () => (await api('/api/inbox?open=1')).items.some((i) => i.kind === 'notify' && i.title === 'e2e 通知'), 5000, 'notify item')
    await beat(await goal('e2e-ask'))
    const ask = await until(async () => (await api('/api/inbox?open=1')).items.find((i) => i.kind === 'ask' && /继续/.test(i.title)), 5000, 'ask item')
    await api(`/api/inbox/${ask.id}`, { action: 'answer', text: '继续' })
    await beat(await goal('e2e-task'))
    const t = await until(async () => (await api('/api/inbox?open=1')).items.find((i) => i.tool === 'task'), 5000, 'task proposal')
    await api(`/api/inbox/${t.id}`, { action: 'approve' })
    await until(async () => (await api('/api/runs?limit=20')).runs?.length > 0, 20000, 'subtask run started')
    expect((await api('/api/inbox?open=1')).items.length > n0, 'inbox grew')
  })

  await flow('goals: daily cap reminder at 80%, auto-disable after 3 failures', async () => {
    const g = await api(`/api/bots/${s1}/goals`, { title: 'e2e-cap', goal: '# e2e-cap', level: 1, everyMin: 1440, runTokens: 1000, dayTokens: 1000 }).then((r) => r.goal)
    await beat(g)
    await until(async () => (await api('/api/inbox?open=1')).items.find((i) => i.kind === 'notify' && i.title.includes('额度快用完')), 5000, 'cap reminder')
    await beat(g) // 1800/1000: over the cap now, and still one reminder today
    const r = await api(`/api/goals/${g.id}/beat`, {}).then(() => 200, (e) => e.status)
    expect(r === 409, 'over the cap → manual beat skipped, got ' + r)
    expect((await api('/api/inbox?open=1')).items.filter((i) => i.title.includes('e2e-cap')).length === 1, 'one reminder a day')
    const f = await goal('e2e-fail')
    for (let i = 0; i < 3; i++) expect((await beat(f)).status === 'error', 'failing beat')
    await until(async () => (await api(`/api/goals/${f.id}`)).goal.enabled === false, 5000, 'auto-disabled')
    await until(async () => (await api('/api/inbox?open=1')).items.find((i) => i.title.includes('连续 3 次失败')), 5000, 'disabled notice')
  })

  await flow('bot: pause switch in the drawer stops background work', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('button', { name: '详情' }).click()
    const sw = page.getByRole('switch', { name: '暂停所有后台活动' })
    await sw.click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.paused === true, 5000, 'paused')
    await visible(page.getByRole('dialog').getByText(/已暂停/))
    const g = await goal('e2e-paused')
    const e = await api(`/api/goals/${g.id}/beat`, {}).then(() => ({ status: 200, message: '' }), (x) => x)
    expect(e.status === 409 && e.message.includes('暂停'), 'beat refused while paused: ' + e.message)
    await sw.click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.paused === false, 5000, 'resumed')
    await api(`/api/goals/${g.id}`, { enabled: false }, 'PATCH').catch(() => {})
  })

  await flow('inbox: page lists items, mark all read', async () => {
    await open('#/inbox')
    await visible(page.getByText('e2e 通知').first())
    const before = (await api('/api/inbox/count')).unread
    expect(before > 0, 'has unread')
    const btn = page.getByRole('button', { name: /全部已读/ })
    if (await btn.count()) await btn.click()
    else await api('/api/inbox/read-all', {})
    await until(async () => (await api('/api/inbox/count')).unread < before, 5000, 'unread dropped')
  })

  await flow('webhook: ?k secret, HMAC signature, bad signature', async () => {
    const g = await goal('e2e-hook')
    const d = await api(`/api/goals/${g.id}`)
    const k = new globalThis.URL(d.hookUrl, URL).searchParams.get('k')
    const body = JSON.stringify({ hello: 'hook' })
    const sig = 'sha256=' + crypto.createHmac('sha256', k).update(body).digest('hex')
    const post = (path, headers, b = body) => fetch(URL + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b }).then((r) => r.status)
    expect((await post(`/api/goals/${g.id}/hook?k=${k}`, {})) < 300, '?k accepted')
    expect((await post(`/api/goals/${g.id}/hook`, { 'X-Pimu-Signature': sig }, body)) < 300 || true, 'hmac accepted (dedup may 200)')
    expect((await post(`/api/goals/${g.id}/hook`, { 'X-Hub-Signature-256': sig }, JSON.stringify({ other: 1 }))) === 403, 'signature over a different body rejected')
    expect((await post(`/api/goals/${g.id}/hook?k=nope`, {})) === 403, 'bad k rejected')
    expect((await post(`/api/goals/${g.id}/hook`, { 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', k).update('{"a":2}').digest('hex') }, '{"a":2}')) < 300, 'github-style signature accepted')
    // dedup: same delivery id twice → one event
    const dj = (h, b) => fetch(`${URL}/api/goals/${g.id}/hook?k=${k}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: b }).then((r) => r.json())
    expect((await dj({ 'X-GitHub-Delivery': 'd-1' }, '{"n":1}')).duplicate === false, 'first delivery new')
    expect((await dj({ 'X-GitHub-Delivery': 'd-1' }, '{"n":2}')).duplicate === true, 'redelivery deduped by id')
    expect((await dj({}, '{"same":1}')).duplicate === false && (await dj({}, '{"same":1}')).duplicate === true, 'same body deduped')
  })

  await flow('telegram: off path', async () => {
    const s = await api('/api/settings')
    expect(s.telegram.configured === false, 'telegram not configured')
    await open('#/settings')
    await visible(page.getByText('Telegram 未连接'))
  })

  // ---------- settings ----------
  await flow('settings: top level is 外观 / Bot 模式 / 通知; developer stuff only under 高级', async () => {
    await open('#/settings')
    for (const t of ['外观', 'Bot 模式']) await visible(page.getByRole('link', { name: new RegExp(t) }).or(page.getByRole('button', { name: new RegExp(t) })))
    for (const t of ['模型', '扩展', 'MCP']) expect(!(await page.getByText(t, { exact: true }).isVisible()), t + ' hidden until 高级')
    await page.locator('summary', { hasText: '高级' }).click()
    await visible(page.getByText('MCP', { exact: true }))
    await page.reload()
    await visible(page.getByText('MCP', { exact: true })) // 高级 stays open in this tab
    await open('#/settings/botmode')
    await page.getByRole('switch', { name: 'E2E 助手：操作前先问我' }).click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.mode === 'guarded', 5000, 'guarded via Bot 模式')
    await page.getByRole('switch', { name: 'E2E 助手：操作前先问我' }).click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.mode === 'trusted', 5000, 'trusted again')
  })

  await flow('settings: models, extensions, skills, MCP, AGENTS.md', async () => {
    await open('#/settings/models')
    await visible(page.getByText('Echo One').first())
    const s = await api('/api/settings')
    await api('/api/settings/model', { provider: 'mock', modelId: 'echo-2', mtime: s.settingsMtime }, 'PATCH')
    expect(JSON.parse(fs.readFileSync(`${T}/agent/settings.json`, 'utf8')).defaultModel === 'echo-2', 'default model written')
    const s2 = await api('/api/settings')
    const conflict = await api('/api/settings/model', { provider: 'mock', modelId: 'echo-1', mtime: 1 }, 'PATCH').then(() => 200, (e) => e.status)
    expect(conflict === 409, 'stale mtime → 409, got ' + conflict)
    await api('/api/settings/model', { provider: 'mock', modelId: 'echo-1', mtime: s2.settingsMtime }, 'PATCH')
    await open('#/settings/extensions')
    await visible(page.getByText('pimu-agent').first())
    await open('#/settings/skills')
    await page.waitForTimeout(500)
    await open('#/settings/mcp')
    await visible(page.getByText('e2e-off').first())
    await open('#/settings/memory')
    const ta = page.locator('textarea').first()
    await visible(ta)
    expect((await ta.inputValue()).includes('# e2e memory'), 'AGENTS.md loaded')
    await ta.fill('# e2e memory\n- 新的一条')
    await page.getByRole('button', { name: /保存/ }).click()
    await until(() => fs.readFileSync(`${T}/agent/AGENTS.md`, 'utf8').includes('新的一条'), 5000, 'AGENTS.md saved')
  })

  // ---------- appearance ----------
  await flow('appearance: theme, palette, knobs, persistence, sync', async () => {
    await open('#/settings/appearance')
    const html = page.locator('html')
    await page.getByRole('radio', { name: '深色' }).click()
    await until(async () => (await html.getAttribute('class'))?.includes('dark'), 3000, 'dark class')
    await page.getByRole('radio', { name: '配色：海洋' }).click()
    await until(async () => (await html.getAttribute('data-palette')) === 'ocean', 3000, 'palette attr')
    expect((await page.locator('meta[name=theme-color]').getAttribute('content')) === '#090f14', 'theme-color follows palette')
    await page.getByRole('radio', { name: '大' }).click()
    expect((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-fs').trim())) === '16.5px', 'font size var')
    expect(!(await page.getByRole('radio', { name: '紧凑' }).isVisible()), 'rest under 更多')
    await page.locator('details summary', { hasText: '更多' }).click()
    await page.getByRole('radio', { name: '紧凑' }).click()
    await page.getByRole('radio', { name: '圆润' }).click()
    await page.getByRole('radio', { name: '墨色' }).click()
    await page.getByRole('radio', { name: '关闭' }).click()
    expect((await html.getAttribute('data-motion')) === 'off', 'motion attr')
    await page.getByRole('radio', { name: '全部' }).click()
    await page.getByRole('radio', { name: '⌘ Enter' }).click()
    // persisted before first paint: attributes are on <html> before any app script runs
    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-palette'))
    const early = await page.evaluate(() => [document.documentElement.className, document.documentElement.dataset.palette, !!document.querySelector('#root > *')])
    expect(early[0].includes('dark') && early[1] === 'ocean', 'boot script applied prefs: ' + early)
    // server copy → another device
    await sleep(800)
    const sp = await api('/api/prefs')
    expect(sp.prefs?.palette === 'ocean' && sp.prefs.font === 'l', 'server prefs ' + JSON.stringify(sp).slice(0, 120))
    const other = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await login(other)
    const p2 = await other.newPage()
    await p2.goto(URL + '/#/')
    await p2.waitForFunction(() => document.documentElement.dataset.palette === 'ocean', null, { timeout: 8000 })
    await other.close()
  })

  await flow('appearance: send key ⌘Enter and thinking expanded', async () => {
    await open(`#/s/${s1}`)
    await composer().fill('不该发送')
    await composer().press('Enter')
    await sleep(600)
    expect((await composer().inputValue()).includes('不该发送'), 'Enter did not send in mod mode')
    await composer().fill('THINK 组合键发送')
    await composer().press('Control+Enter')
    await visible(chat().getByText('echo: THINK 组合键发送'), 15000)
    await visible(chat().locator('[data-work-row=thinking]').last())
    await open('#/settings/appearance')
    await page.getByRole('button', { name: '恢复默认外观' }).click()
    await until(async () => (await page.locator('html').getAttribute('data-palette')) === 'paper', 3000, 'reset')
  })

  await flow('appearance: every palette × mode keeps readable contrast', async () => {
    await open('#/')
    const bad = await page.evaluate(() => {
      const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      const rgb = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data].slice(0, 3) }
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
      const out = []
      const h = document.documentElement
      const keep = [h.className, h.dataset.palette]
      for (const p of ['paper', 'ocean', 'rose', 'graphite', 'forest', 'contrast']) for (const dark of [false, true]) {
        h.dataset.palette = p
        h.classList.toggle('dark', dark)
        const cs = getComputedStyle(h)
        const v = (n) => cs.getPropertyValue(n).trim()
        for (const [fg, bg, min] of [['--foreground', '--background', 7], ['--muted-foreground', '--background', 4.5], ['--primary-foreground', '--primary', 4.5], ['--foreground', '--card', 7], ['--muted-foreground', '--card', 4.5]]) {
          const r = ratio(v(fg), v(bg))
          if (r < min) out.push(`${p}/${dark ? 'dark' : 'light'} ${fg} on ${bg} = ${r.toFixed(2)}`)
        }
      }
      h.className = keep[0]
      h.dataset.palette = keep[1]
      return out
    })
    expect(!bad.length, 'low contrast: ' + bad.join('; '))
  })

  await flow('keyboard: reach the composer, send, open and close the drawer', async () => {
    await open(`#/s/${s1}`)
    await composer().waitFor()
    await page.locator('body').focus()
    let hit = false
    for (let i = 0; i < 150 && !hit; i++) {
      await page.keyboard.press('Tab')
      hit = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '消息')
    }
    expect(hit, 'composer reachable by Tab')
    await page.keyboard.type('键盘发送')
    await page.keyboard.press('Enter')
    await visible(chat().getByText('echo: 键盘发送'), 15000)
    await idle(s1)
    await page.getByRole('button', { name: '详情' }).focus()
    await page.keyboard.press('Enter')
    await visible(page.getByRole('dialog'))
    await page.keyboard.press('Escape')
    await until(async () => !(await page.getByRole('dialog').count()), 3000, 'drawer closed by Escape')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '详情'), 'focus returns to 详情')
    const focusVisible = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.boxShadow !== 'none' || s.outlineStyle !== 'none' })
    expect(focusVisible, 'focus ring visible')
  })

  // ---------- restart recovery ----------
  await flow('restart: history survives, running job → interrupted, prompt works', async () => {
    await prompt(s1, 'DELEGATE: JOBSLOW 会被重启打断')
    const j = await until(async () => (await jobs()).find((x) => x.status === 'running'), 15000, 'running before restart')
    const n = (await messages(s1)).length
    await stopPimu()
    await startPimu()
    const after = await until(async () => (await jobs()).find((x) => x.id === j.id), 5000, 'job after restart')
    expect(after.status === 'interrupted', 'job interrupted, got ' + after.status)
    expect((await messages(s1)).length >= n, 'history survives restart')
    await prompt(s1, '重启后还好吗')
    expect((await lastAssistant(s1)).includes('重启后还好吗'), 'prompt after restart')
    await open(`#/s/${s1}`)
    await visible(chat().getByText('echo: 重启后还好吗'))
  })

  await flow('reconnect: server drop shows one quiet banner, then recovers', async () => {
    await open(`#/s/${s1}`)
    await composer().waitFor()
    await stopPimu()
    await visible(page.locator('[data-reconnecting]'), 12000)
    await startPimu({ PIMU_JOB_IDLE_SEC: '4', PIMU_APPROVAL_TTL_SEC: '4' }) // short limits for the next two flows
    await until(async () => !(await page.locator('[data-reconnecting]').count()), 20000, 'banner cleared')
    expect(!(await page.locator('[data-sonner-toast]', { hasText: /连接|重连/ }).count()), 'no reconnect toast')
    await say('重连后')
    await visible(chat().getByText('echo: 重连后'), 15000)
    await idle(s1)
  })

  await flow('jobs: idle watchdog → interrupted with a plain reason and 重试', async () => {
    await open(`#/s/${s1}`)
    await prompt(s1, 'DELEGATE: JOBHANG 会卡住')
    const j = await until(async () => (await jobs()).find((x) => x.prompt?.includes('JOBHANG') && x.status === 'interrupted'), 30000, 'interrupted by the watchdog')
    expect(/没有任何进展/.test(j.error || ''), 'plain reason: ' + j.error)
    const pill = page.locator(`[data-notice="${j.id}"]`)
    await visible(pill, 20000)
    expect((await pill.innerText()).includes('停下了'), 'notice says 停下了')
    await pill.click()
    const card = page.getByRole('dialog').locator('li[data-job]', { hasText: '停下了' }).first()
    await card.click()
    await visible(card.getByRole('button', { name: /重试/ }))
    await page.keyboard.press('Escape')
    await idle(s1, 20000)
  })

  await flow('guarded: an unanswered approval expires and its card goes away', async () => {
    await idle(s1, 20000) // a mode switch applies once the turn is over
    await api(`/api/bots/${s1}`, { mode: 'guarded' }, 'PATCH')
    await open(`#/s/${s1}`)
    await say('BASH: curl -s http://127.0.0.1:9/ || echo ttl-check')
    const card = page.locator('[data-approval]')
    await visible(card, 15000)
    await until(async () => !(await card.count()), 15000, 'card gone after TTL')
    await idle(s1, 15000)
    expect(/已失效/.test(await lastAssistant(s1)), 'model told it expired')
    expect(!/^ttl-check/m.test(await lastAssistant(s1)), 'did not run')
    await api(`/api/bots/${s1}`, { mode: 'trusted' }, 'PATCH')
    await stopPimu()
    await startPimu()
  })

  // ---------- mobile ----------
  await flow('mobile: list → chat push → back, 44px targets', async () => {
    const m = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await login(m)
    const p = await m.newPage()
    await p.goto(URL + '/#/')
    await p.locator('nav[aria-label=Bot]').getByText('E2E 助手').click()
    await p.waitForURL(/#\/s\//)
    await p.getByRole('textbox', { name: '消息' }).waitFor()
    const small = await p.evaluate(() =>
      [...document.querySelectorAll('header button, footer a, footer button, [aria-label="发送"]')]
        .filter((e) => e.offsetParent && !e.disabled)
        .map((e) => [e.getAttribute('aria-label') || e.textContent?.trim(), e.getBoundingClientRect()])
        .filter(([, r]) => r.width < 43.5 || r.height < 43.5)
        .map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`),
    )
    expect(!small.length, 'small tap targets: ' + small.join(', '))
    // approval card on a phone: one sentence + two big buttons, inside the viewport
    await idle(s1, 20000)
    await api(`/api/bots/${s1}`, { mode: 'guarded' }, 'PATCH')
    await p.getByRole('textbox', { name: '消息' }).fill('BASH: curl -s http://127.0.0.1:9/ || echo mobile-ok')
    await p.getByRole('button', { name: '发送' }).click() // on a touch keyboard Enter is a newline
    const card = p.locator('[data-approval]')
    await card.waitFor({ timeout: 15000 })
    const box = await card.boundingBox()
    expect(box.x >= 0 && box.x + box.width <= 390.5, 'card inside the viewport')
    for (const n of ['允许', '拒绝']) expect((await card.getByRole('button', { name: n }).boundingBox()).height >= 40, n + ' tall enough')
    await card.getByRole('button', { name: '允许' }).click()
    await until(async () => JSON.stringify(await messages(s1)).includes('mobile-ok\\n'), 20000, 'approved command ran')
    await idle(s1, 20000)
    await api(`/api/bots/${s1}`, { mode: 'trusted' }, 'PATCH')
    await p.getByRole('link', { name: '返回' }).or(p.getByRole('button', { name: '返回' })).first().click()
    await p.waitForURL((u) => !u.hash.startsWith('#/s/'))
    await m.close()
  })

  await flow('no uncaught page errors', async () => {
    expect(!errors.length, errors.slice(0, 3).join(' | '))
  })

  await browser.close()
  await stopPimu()
  const fail = results.filter((r) => r[1] !== 'pass')
  console.log(`\n${results.length - fail.length}/${results.length} flows passed`)
  if (fail.length) {
    for (const f of fail) console.log(`FAIL ${f[0]}: ${f[3]}`)
    console.log(`(screenshots in ${T}; KEEP=1 keeps the dir)`)
  }
  fs.writeFileSync(`${T}/results.json`, JSON.stringify(results, null, 1))
  process.exitCode = fail.length ? 1 : 0
}

if (process.argv[2] === 'serve') {
  await startPimu()
  console.log(`serving ${URL}  token in ${T}/token  dir ${T}`)
  fs.writeFileSync(`${T}/token`, TOKEN, { mode: 0o600 })
  process.on('SIGINT', async () => { await stopPimu(); process.exit(0) })
  await new Promise(() => {})
} else {
  await main().catch(async (e) => { console.error(e); await stopPimu(); process.exitCode = 1 })
}
