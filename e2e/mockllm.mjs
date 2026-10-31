// A scripted OpenAI-compatible chat endpoint for the e2e suite: real pi, real
// Pimu, fake model. The last user message picks the behaviour:
//   SLOW          stream ~6 s of text (abort / steer / follow-up)
//   THINK         reasoning deltas, then text
//   FAIL          HTTP 500
//   BASH: <cmd>   call the bash tool with <cmd>, then report its output
//   DELEGATE: <p> call pimu_task with prompt <p>
//   heartbeat     (prompt has <goal>) reply with a ```pimu block chosen by the goal title:
//                 e2e-notify / e2e-ask / e2e-task, anything else noop
//                 e2e-fail → HTTP 500, e2e-cap → reports 900 tokens of usage
//   job prompts   JOBSLOW (4 s), JOBFAIL (500), JOBBASH: <cmd> (tool call),
//                 JOBHANG (headers, then silence: the idle watchdog's case)
//   MDTEST        a long markdown answer: headings, table, code, mermaid, long line
//   LONG          ~120 streamed lines (scroll follow)
// Everything else echoes "echo: <message>".
import http from 'node:http'

const port = +(process.argv[2] || 18999)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '')
const log = []

async function reply(res, body) {
  const msgs = body.messages || []
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const u = text(lastUser?.content)
  const last = msgs[msgs.length - 1]
  const all = msgs.map((m) => text(m.content)).join('\n')
  log.push({ u: u.slice(0, 300), sys: text(msgs.find((m) => m.role === 'system')?.content), last: last?.role })
  if ((/^FAIL/.test(u) && last.role === 'user') || (all.includes('<goal>') && /e2e-fail/.test(all))) {
    res.writeHead(500, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } }))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const id = 'cmpl-' + Date.now()
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  const big = all.includes('<goal>') && /e2e-cap/.test(all)
  const end = (finish) => {
    send({}, finish)
    const usage = big ? { prompt_tokens: 850, completion_tokens: 50, total_tokens: 900 } : { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }
  const say = async (s, step = 12, ms = 15) => {
    for (let i = 0; i < s.length; i += step) {
      if (res.destroyed) return
      send({ content: s.slice(i, i + step) })
      await sleep(ms)
    }
  }
  const tool = (name, args) => {
    send({ tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: '' } }] })
    send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
    end('tool_calls')
  }
  // After a tool ran: report what came back.
  if (last.role === 'tool') {
    await say('工具完成：' + text(last.content).slice(0, 80))
    return end('stop')
  }
  if (all.includes('<goal>')) {
    const title = (all.match(/<goal>\s*([^\n]*)/) || [])[1] || ''
    const act = /e2e-notify/.test(all) ? { do: 'notify', key: 'n1', title: 'e2e 通知', body: '心跳发现了一件事' }
      : /e2e-ask/.test(all) ? { do: 'ask', key: 'a1', question: 'e2e 要不要继续？' }
      : /e2e-task/.test(all) ? { do: 'task', key: 't1', prompt: 'e2e 子任务', timeout_sec: 60 }
      : { do: 'noop' }
    await say(`心跳 ${title}\n\n\`\`\`pimu\n${JSON.stringify([act, { do: 'state', md: 'e2e state' }])}\n\`\`\`\n`, 40, 5)
    return end('stop')
  }
  let m
  if ((m = u.match(/^DELEGATE: ([\s\S]+)/))) return tool('pimu_task', { title: 'e2e 后台任务', prompt: m[1] })
  if ((m = u.match(/(?:^BASH|JOBBASH): (.+)/m))) return tool('bash', { command: m[1].trim() })
  if (/JOBFAIL/.test(u)) {
    res.destroy() // mid-stream failure
    return
  }
  // A delivered background result: answer with the result only, like a real model would.
  if (/^\[Pimu 后台任务 #\d+/.test(u)) {
    await say('后台的结果到了。')
    return end('stop')
  }
  if (/JOBHANG/.test(u)) {
    await sleep(120000)
    return end('stop')
  }
  if (/^MDTEST/.test(u)) {
    const md = ['# 标题一', '', '一段**加粗**和`行内代码`，以及一个[链接](https://example.com)。', '', '| 列 A | 列 B | 列 C |', '|---|---|---|',
      ...Array.from({ length: 6 }, (_, i) => `| 行${i} | ${'很长的单元格内容'.repeat(3)} | ${i * 7} |`), '',
      '```js', 'const x = [1, 2, 3].map((n) => n * 2) // ' + 'x'.repeat(200), 'console.log(x)', '```', '',
      '```mermaid', 'graph TD', '  A[开始] --> B{判断}', '  B -->|是| C[结束]', '```', '',
      '- 列表一', '- 列表二', '  - 嵌套', '', '> 引用一段话', '', 'https://example.com/' + 'a'.repeat(300), '', 'MDTEST-END']
    await say(md.join('\n'), 60, 5)
    return end('stop')
  }
  if (/^LONG/.test(u)) {
    for (let i = 1; i <= 120; i++) await say(`第 ${i} 行：滚动跟随测试。\n\n`, 200, 25)
    await say('LONG-END')
    return end('stop')
  }
  if (/JOBSLOW/.test(u)) {
    await say('后台慢任务进行中……', 2, 400)
    await say(' 完成：job-ok')
    return end('stop')
  }
  if (/THINK/.test(u)) {
    for (const w of ['先想', '一想', '这个问题。']) {
      send({ reasoning_content: w })
      await sleep(30)
    }
  }
  if (/SLOW/.test(u)) {
    await say('慢慢地说，'.repeat(30), 5, 200)
    return end('stop')
  }
  await say('echo: ' + u.replace(/\n*附件（[\s\S]*$/, '').slice(0, 300) + (u.includes('附件（') ? ' [有附件]' : '') + (lastUser && Array.isArray(lastUser.content) && lastUser.content.some((p) => p.type === 'image_url') ? ' [有图片]' : ''))
  end('stop')
}

http
  .createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      if (req.url === '/log') return res.end(JSON.stringify(log))
      if (req.url === '/log/reset') return (log.length = 0), res.end('{}')
      if (!req.url.endsWith('/chat/completions')) return res.writeHead(404).end()
      reply(res, JSON.parse(b || '{}')).catch((e) => (console.error(e), res.destroy()))
    })
  })
  .listen(port, '127.0.0.1', () => console.log('mockllm on', port))
