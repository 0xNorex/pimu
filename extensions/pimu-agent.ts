// pimu-agent: Pimu's bot runtime inside pi (docs/AUTONOMY.md).
// Install: make install-agent  (copies to ~/.pi/agent/extensions/)
//
// Inert unless Pimu started this pi with PIMU_BOT_DIR:
// - every bot session: injects <bot_memory> from $PIMU_BOT_DIR/MEMORY.md
//   (≤200 lines / 8 KB) into the system prompt.
// - heartbeats and goal subtasks (PIMU_LEVEL=1|2): a tool_call gate.
//   L1 observe: read-only tools, writes inside PIMU_BOT_DIR; everything else blocked.
//   L2 act-with-approval: + whitelisted read-only bash (curl GET, git status/log…)
//   and writes inside cwd; other bash, non-read-only MCP/browser tools need approval.
//   Approval is deny-and-defer: the call is blocked, Pimu files an inbox item keyed
//   by sha256(goal|tool|canonical args); once approved, the identical call is
//   allowed exactly once, then marked used (a repeat is blocked: "已执行过").
//   Any gate error blocks the call (fail closed).
//   In a background job (PIMU_JOB) the gate instead waits for the decision, so
//   the job pauses as waiting_approval and continues once the user answers.
// - a bot's main session (PIMU_BOT_ID, no gate): the pimu_task tool, which hands
//   work to a background job; its result comes back into this session later.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const BOT = process.env.PIMU_BOT_DIR
const LEVEL = Number(process.env.PIMU_LEVEL || 0)
const GOAL = process.env.PIMU_GOAL || ""
const JOB = process.env.PIMU_JOB || ""
const BOT_ID = process.env.PIMU_BOT_ID || ""
const API = process.env.PIMU_API || ""
const TOKEN = process.env.PIMU_INTERNAL_TOKEN || ""

const READ_ONLY = new Set(["read", "grep", "find", "ls"])
// Never let a background run read credentials (the model must not see them).
const SECRET_PATH = /(\/\.ssh\/|\/\.gnupg\/|\/\.config\/pimu\/|\/\.pi\/agent\/(auth|models|mcp)\.json|\/\.pi\/agent\/locks\/|\.env(\.|$)|pimu\.token|\/proc\/\d+\/environ|\/proc\/self\/environ)/i
const DANGER = /(\brm\s+-[a-z]*r[a-z]*f|\bsudo\b|\bmkfs|\bdd\s+if=|chmod\s+(-R\s+)?777|:\(\)\s*\{|\|\s*(ba|z)?sh\b|git\s+push\b.*(-f\b|--force)|>\s*\/dev\/sd|\bshutdown\b|\breboot\b)/
const SAFE_CMD = /^(curl|jq|cat|ls|head|tail|grep|rg|wc|date|echo|pwd|sort|uniq|git\s+(status|log|diff|show))(\s|$)/
const CURL_WRITE = /(\s-X\s*(?!GET\b)\S|\s--request\s+(?!GET\b)\S|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload|\s-o\b|\s--output|\s-K\b|\s--config)/

function abs(p: unknown, cwd: string): string {
  let s = String(p ?? "").replace(/^@/, "")
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1))
  return path.resolve(cwd, s)
}
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/")

function safeBash(cmd: string): boolean {
  if (/[;&`<>\n]|\$\(/.test(cmd)) return false
  return cmd.split("|").every((seg) => {
    const s = seg.trim()
    return SAFE_CMD.test(s) && !(s.startsWith("curl") && CURL_WRITE.test(" " + s))
  })
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]))
  }
  return v
}

async function post(p: string, body: unknown): Promise<{ id?: number; status?: string; ok?: boolean }> {
  const res = await fetch(API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pimu-Internal": TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`pimu ${res.status}`)
  return res.json()
}

type Verdict = "allow" | "approve" | { block: string }

export default function (pi: ExtensionAPI) {
  if (!BOT) return

  pi.on("before_agent_start", async (event) => {
    let mem = ""
    try {
      mem = fs.readFileSync(path.join(BOT, "MEMORY.md"), "utf8")
    } catch {
      return
    }
    mem = mem.split("\n").slice(0, 200).join("\n").slice(0, 8 << 10).trim()
    if (mem) event.systemPromptOptions.sections.bot_memory = `这是你（这个 Bot）的长期记忆，由用户维护：\n${mem}`
  })

  if (BOT_ID && API && LEVEL === 0) {
    pi.registerTool({
      name: "pimu_task",
      label: "后台任务",
      description:
        "把一件耗时的事交给后台的独立 pi 会话去做（同样的模型、MCP 和扩展），立刻返回，不阻塞对话。" +
        "完成后结果会作为一条消息自动送回这个会话。适合：调研、跑长命令、批量改文件、写报告等需要几分钟以上的事。" +
        "prompt 要写完整（后台会话看不到当前对话），包括目标、相关路径和期望的输出形式。",
      promptSnippet: "pimu_task: delegate long work to a background session; result returns here later",
      promptGuidelines: ["派出 pimu_task 后，简短告诉用户已在后台进行，然后继续回应用户，不要等待或轮询结果。"],
      parameters: Type.Object({
        title: Type.String({ description: "简短标题（≤20 字）" }),
        prompt: Type.String({ description: "给后台会话的完整指示" }),
      }),
      async execute(_id, params) {
        const r = (await post("/api/internal/jobs", { bot: BOT_ID, title: params.title, prompt: params.prompt })) as { id?: number; ahead?: number }
        const where = r.ahead ? `排在第 ${r.ahead + 1} 位` : "已开始"
        return {
          content: [{ type: "text", text: `已派出后台任务 #${r.id}（${where}）。完成后结果会自动送回这个对话；现在继续回应用户，不要等它。` }],
          details: { id: r.id },
        }
      },
    })
  }

  if (LEVEL !== 1 && LEVEL !== 2) return
  const approved = new Map<string, number>() // toolCallId -> inbox id

  const classify = (name: string, input: Record<string, unknown>, cwd: string): Verdict => {
    const L1 = LEVEL === 1
    if (READ_ONLY.has(name)) {
      return SECRET_PATH.test(abs(input.path ?? ".", cwd) + "/") ? { block: "不允许读取凭据类文件" } : "allow"
    }
    if (name === "write" || name === "edit") {
      const p = abs(input.path, cwd)
      if (/\/GOAL\.md$/.test(p)) return { block: "GOAL.md 由用户维护；进度请写进 ```pimu state" }
      if (SECRET_PATH.test(p)) return { block: "不允许写凭据类文件" }
      if (inside(p, BOT)) return "allow"
      if (!L1 && inside(p, cwd)) return "allow"
      return L1 ? { block: "L1 只能写 Bot 自己的目录；需要改别处请输出 ask" } : "approve"
    }
    if (name === "bash") {
      const cmd = String(input.command ?? "").trim()
      if (DANGER.test(cmd)) return { block: "危险命令，后台任务一律禁止" }
      if (SECRET_PATH.test(cmd)) return { block: "不允许访问凭据类文件" }
      if (L1) return { block: "L1 不能运行命令；需要时请输出 ask 让用户决定" }
      return safeBash(cmd) ? "allow" : "approve"
    }
    const tool = pi.getAllTools().find((t) => t.name === name)
    if (tool?.reachesTools) return "allow" // codemode / tool_search: their nested calls hit this gate too
    if (tool?.annotations?.readOnlyHint === true) return "allow"
    return L1 ? { block: `L1 只能用只读工具；${name} 需要时请输出 ask` } : "approve"
  }

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>
    const v = classify(event.toolName, input, ctx.cwd)
    if (v === "allow") return
    if (typeof v === "object") return { block: true, reason: `[pimu L${LEVEL}] ${v.block}` }
    const owner = JOB ? `job:${JOB}` : GOAL
    const hash = createHash("sha256").update(`${owner}|${event.toolName}|${JSON.stringify(canonical(input))}`).digest("hex")
    const reason = event.toolName === "bash" ? String(input.command ?? "").slice(0, 120) : ""
    const who = JOB ? { job: Number(JOB) } : { goal: Number(GOAL) }
    let r = await post("/api/internal/approvals", { ...who, tool: event.toolName, argsHash: hash, args: input, reason })
    // A job waits (paused as waiting_approval) instead of deferring to the next heartbeat.
    while (JOB && (r.status === "new" || r.status === "read")) {
      if (ctx.signal?.aborted) return { block: true, reason: "[pimu] 已取消" }
      await new Promise((ok) => setTimeout(ok, 2000))
      r = await post(`/api/internal/approvals/${r.id}/status`, {})
    }
    switch (r.status) {
      case "approved":
        approved.set(event.toolCallId, r.id!)
        return
      case "used":
        return { block: true, reason: `[pimu] 已执行过（审批 #${r.id} 只允许一次）。不要重复；需要再做请换个说法重新申请。` }
      case "denied":
      case "expired":
        return { block: true, reason: `[pimu] 用户拒绝了这个操作（#${r.id}）。不要再试。` }
      default:
        return { block: true, reason: `[pimu] 已提交审批 #${r.id}，批准后下次心跳执行。先继续别的，或结束本次心跳。` }
    }
  })

  pi.on("tool_result", async (event) => {
    const id = approved.get(event.toolCallId)
    if (id === undefined) return
    approved.delete(event.toolCallId)
    await post(`/api/internal/approvals/${id}/used`, {}).catch(() => {})
  })
}
