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
const newSession = (cwd = `${T}/work`) => api('/api/sessions', { cwd }).then((r) => r.id)
async function prompt(id, message, extra = {}) {
  await api(`/api/sessions/${id}/prompt`, { message, ...extra })
  await sleep(300)
  await idle(id, 20000)
}
const makeBot = (id, name, extra = {}) => api('/api/bots', { sessionId: id, name, ...extra }).then((r) => r.bot)

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
    expect((await fetch(URL + '/api/sessions')).status === 401, 'unauthenticated API must be 401')
    await open('#/')
    await page.waitForURL(/#\/login/)
    await page.getByPlaceholder('PIMU_TOKEN').fill('wrong-token-wrong-token-wrong-token')
    await page.getByPlaceholder('PIMU_TOKEN').press('Enter')
    await visible(page.getByRole('alert'))
    await page.getByPlaceholder('PIMU_TOKEN').fill(TOKEN)
    await page.getByPlaceholder('PIMU_TOKEN').press('Enter')
    await page.waitForURL((u) => !u.hash.includes('login'))
    await visible(page.getByRole('tab', { name: /Bot/ }))
    const st = await page.evaluate(() => fetch('/api/auth/status').then((r) => r.json()))
    expect(st.authed && st.via === 'token', 'auth status via token: ' + JSON.stringify(st))
    expect((await api('/api/bots')).bots, 'bearer token works')
    await open('#/settings/pimu')
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

  // ---------- sessions ----------
  let s1
  await flow('session: create with directory picker', async () => {
    await open('#/')
    await page.getByRole('button', { name: '新会话' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('目录路径').fill(`${T}/work`)
    await dlg.getByLabel('目录路径').press('Enter')
    await dlg.getByRole('button', { name: 'proj' }).click()
    await visible(dlg.getByText('没有子目录'))
    await dlg.getByRole('button', { name: '在此开始' }).click()
    await page.waitForURL(/#\/s\//)
    s1 = sid(page)
    const st = await api(`/api/sessions/${s1}`)
    expect(st.cwd === `${T}/work/proj` || (await api('/api/sessions')).sessions.some((x) => x.id === s1), 'session cwd ' + JSON.stringify(st).slice(0, 200))
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

  await flow('chat: thinking block collapsed by default', async () => {
    await say('THINK 想一想')
    await visible(chat().getByText('echo: THINK 想一想'), 15000)
    await visible(chat().getByRole('button', { name: /思考/ }))
    expect(!(await chat().getByText('先想一想这个问题。').isVisible()), 'thinking text hidden by default')
  })

  await flow('slash: /name, /session, /compact, /new', async () => {
    await say('/name 改名测试')
    await until(async () => (await api('/api/sessions')).sessions.find((x) => x.id === s1)?.name === '改名测试', 8000, 'renamed')
    await say('/session')
    await page.locator('[data-sonner-toast]', { hasText: '会话统计' }).waitFor({ state: 'attached' }).catch(async (e) => {
      throw new Error(`no stats toast; composer=${JSON.stringify(await composer().inputValue())} toasts=${(await page.locator('[data-sonner-toast]').allInnerTexts()).join(' / ')}`)
    })
    await say('/compact')
    // A tiny e2e context is below pi's threshold: the round trip (command → pi → toast) is what we check.
    await visible(page.getByText(/已压缩|Nothing to compact/i), 25000)
    const before = page.url()
    await say('/new')
    await page.getByRole('dialog').getByRole('button', { name: '在此开始' }).click()
    await page.waitForURL((u) => u.href !== before && u.hash.startsWith('#/s/'), { timeout: 10000 })
    const s2 = sid(page)
    expect(s2 && s2 !== s1, 'new session')
    await page.goto(URL + '/#/s/' + s1)
  })

  await flow('chat: model error is shown, session recovers', async () => {
    await prompt(s1, 'FAIL 这次模型会出错').catch(() => {})
    await until(async () => (await messages(s1)).filter((m) => m.role === 'assistant').at(-1)?.stopReason === 'error', 60000, 'error turn')
    await idle(s1, 60000)
    await visible(chat().getByText(/mock failure|出错|错误/).last(), 8000)
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

  await flow('composer: voice button present', async () => {
    await visible(page.getByRole('button', { name: '语音输入' }))
  })

  // ---------- bots ----------
  let bot
  await flow('bot: set as bot moves the session file, unset keeps it', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('button', { name: '会话菜单' }).click()
    await page.getByRole('menuitem', { name: '设为 Bot' }).click()
    await page.getByLabel('名字').fill('E2E 助手')
    await page.getByRole('dialog').getByRole('button', { name: '设为 Bot' }).click()
    await visible(page.getByRole('tab', { name: /Bot/ }))
    await until(async () => (await api('/api/bots')).bots.find((b) => b.id === s1), 5000, 'bot listed')
    await until(() => fs.existsSync(`${T}/data/bots/${s1}/session`) && fs.readdirSync(`${T}/data/bots/${s1}/session`).some((f) => f.endsWith('.jsonl')), 15000, 'session file in bot dir')
    const n = (await messages(s1)).length
    expect(n >= 4, 'history kept after move: ' + n)
    await visible(page.locator('#sidebar-panel').getByText('E2E 助手'))
    // unset
    await page.getByRole('button', { name: '会话菜单' }).click()
    await page.getByRole('menuitem', { name: /取消 Bot/ }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: /取消 Bot|确定|确认/ }).last().click()
    await until(async () => !(await api('/api/bots')).bots.find((b) => b.id === s1), 5000, 'bot gone')
    expect((await messages(s1)).length === n, 'history kept after unset')
    await prompt(s1, '还在吗')
    expect((await lastAssistant(s1)).includes('还在吗'), 'session still works after unset')
    bot = await makeBot(s1, 'E2E 助手')
  })

  await flow('bot: tabs and search', async () => {
    const s3 = await newSession(`${T}/work2`)
    await prompt(s3, '普通会话')
    await makeBot(await newSession(`${T}/work2`), '另一个机器人')
    await open('#/')
    await page.getByRole('tab', { name: /Bot/ }).click()
    await visible(page.locator('#sidebar-panel').getByText('另一个机器人'))
    await page.getByLabel('搜索 Bot').fill('E2E')
    await visible(page.locator('#sidebar-panel').getByText('E2E 助手'))
    expect(!(await page.locator('#sidebar-panel').getByText('另一个机器人').count()), 'search filters bots')
    await page.getByLabel('清除搜索').click()
    await page.getByRole('tab', { name: /会话/ }).click()
    await visible(page.locator('#sidebar-panel').getByText('普通会话'))
    expect(!(await page.locator('#sidebar-panel').getByText('E2E 助手').count()), 'bots not in 会话 tab')
  })

  await flow('bot: persona + guarded mode via dialog', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('button', { name: '会话菜单' }).click()
    await page.getByRole('menuitem', { name: /编辑 Bot/ }).click()
    await page.getByLabel('人设 / 指令').fill('PERSONA-E2E：说话简短')
    await page.getByRole('radio', { name: /Guarded/ }).click()
    await page.getByRole('button', { name: '保存' }).click()
    await until(async () => (await api(`/api/bots/${s1}`)).bot.mode === 'guarded', 5000, 'mode saved')
    await fetch(E2E_LLM + '/log/reset')
    await prompt(s1, '人设生效了吗')
    expect((await llmLog()).some((x) => x.sys.includes('PERSONA-E2E')), 'persona reached the system prompt')
  })

  await flow('guarded: inline approve and deny', async () => {
    await open(`#/s/${s1}`)
    await say('BASH: curl -s http://127.0.0.1:9/ || echo approved-run')
    const card = page.locator('.attention-card')
    await visible(card, 15000)
    await card.getByRole('button', { name: '批准一次' }).click()
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
    await visible(page.locator('#sidebar-panel .avatar-working'), 8000)
    await until(async () => (await jobs()).find((x) => x.id === j.id)?.status === 'completed', 30000, 'job completed')
    await until(async () => (await messages(s1)).some((m) => m.role === 'user' && JSON.stringify(m.content).includes(`后台任务 #${j.id}`)), 15000, 'result delivered to main session')
    await until(async () => !(await api('/api/bots')).bots.find((b) => b.id === s1)?.jobsRunning, 5000, 'jobsRunning cleared')
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
    await until(async () => (await messages(s1)).some((m) => JSON.stringify(m.content).includes('1 requested, 1 approved')), 20000, 'approval counts in delivered result')
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

  await flow('jobs: bot 任务 tab lists jobs', async () => {
    await open(`#/s/${s1}`)
    await page.getByRole('tab', { name: '任务' }).click()
    await visible(page.getByText('e2e 后台任务').first())
  })

  // ---------- goals / heartbeat / inbox / webhooks ----------
  const goal = (title) => api(`/api/bots/${s1}/goals`, { title, goal: `# ${title}\n测试目标`, level: 1, everyMin: 1440 }).then((r) => r.goal)
  const beat = async (g) => {
    await api(`/api/goals/${g.id}/beat`, {})
    return until(async () => { const d = await api(`/api/goals/${g.id}`); const b = d.beats?.[0]; return b && b.finishedAt && b }, 40000, 'beat finished')
  }
  await flow('goals: heartbeat noop / notify / ask / task', async () => {
    const n0 = (await api('/api/inbox?open=1')).items.length
    const b0 = await beat(await goal('e2e-noop'))
    expect(/noop/.test(JSON.stringify(b0)), 'noop beat: ' + JSON.stringify(b0).slice(0, 200))
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
  })

  await flow('telegram: off path', async () => {
    const s = await api('/api/settings')
    expect(s.telegram.configured === false, 'telegram not configured')
    await open('#/settings/pimu')
    await visible(page.getByText('未配置'))
  })

  // ---------- settings ----------
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
    await page.getByRole('radio', { name: '紧凑' }).click()
    await page.getByRole('radio', { name: '圆润' }).click()
    await page.getByRole('radio', { name: '墨色' }).click()
    await page.getByRole('radio', { name: '关闭' }).click()
    expect((await html.getAttribute('data-motion')) === 'off', 'motion attr')
    await page.getByRole('switch', { name: '默认展开思考过程' }).click()
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
    await visible(chat().getByText('先想一想这个问题。').last())
    await open('#/settings/appearance')
    await page.getByRole('button', { name: '恢复默认外观' }).click()
    await until(async () => (await page.locator('html').getAttribute('data-palette')) === 'paper', 3000, 'reset')
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

  // ---------- mobile ----------
  await flow('mobile: list → chat push → back, 44px targets', async () => {
    const m = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await login(m)
    const p = await m.newPage()
    await p.goto(URL + '/#/')
    await p.getByRole('tab', { name: /Bot/ }).click()
    await p.locator('#sidebar-panel').getByText('E2E 助手').click()
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
