// pimu-agent: Pimu's bot runtime inside pi (docs/AUTONOMY.md, docs/V9.md).
// Install: make install-agent  (copies to ~/.pi/agent/extensions/)
//
// Inert unless Pimu started this pi with PIMU_BOT_DIR:
// - every bot session: injects <bot_memory> from $PIMU_BOT_DIR/MEMORY.md
//   (≤200 lines / 8 KB) into the system prompt.
// - credentials: Pimu hands this process a capability token through a 0600
//   file named by PIMU_CAP_FILE; it is read and deleted here at load, so it is
//   in no environment a tool inherits. The token is scoped by Pimu to this
//   session's own bot / goal / job.
// - a bot's main session (L0, no PIMU_LEVEL): the pimu_task tool, plus a
//   best-effort block on reading credentials (the user drives this session).
// - heartbeats and goal subtasks (PIMU_LEVEL=1|2) and background jobs (2):
//   a tool_call gate; any gate error blocks the call (pi fails closed).
//   L1 observe: read-only tools inside cwd / the bot dir; writes only in the bot dir.
//   L2 act-with-approval: + a narrow set of read-only bash commands and writes
//   inside cwd (not .git/ or .pi/); anything else needs the user's approval.
//   Pimu keys each approval by (bot, goal|job, tool, canonical args), computed
//   server-side; an approval lets exactly that call run once (claimed before
//   it runs), and an identical later call files a new request.
//   Heartbeats defer (the call is blocked, the next beat may retry once it is
//   approved); a job waits (paused as waiting_approval) for the decision.
//   Nested calls (codemode, tool_search) pass through this same handler.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const BOT = process.env.PIMU_BOT_DIR || ""
const LEVEL = Number(process.env.PIMU_LEVEL || 0)
const JOB = process.env.PIMU_JOB || ""
const BOT_ID = process.env.PIMU_BOT_ID || ""
const API = process.env.PIMU_API || ""

let CAP = ""
const capFile = process.env.PIMU_CAP_FILE
delete process.env.PIMU_CAP_FILE
if (capFile) {
  try {
    CAP = fs.readFileSync(capFile, "utf8").trim()
  } catch {}
  try {
    fs.unlinkSync(capFile)
  } catch {}
}

const READ_ONLY = new Set(["read", "grep", "find", "ls"])
const SECRET_PATH = /(\/\.ssh\/|\/\.gnupg\/|\/\.aws\/|\/\.config\/(pimu|gh)\/|\/\.netrc|\/\.git-credentials|\/\.pi\/agent\/(auth|models|mcp|settings)\.json|\/\.pi\/agent\/locks\/|\.env(\.|\/|$)|pimu\.token|pimu\.db|\/proc\/)/i
const DANGER = /(\brm\s+-[a-z]*r|\bsudo\b|\bmkfs|\bdd\s+if=|chmod\s+(-R\s+)?777|:\(\)\s*\{|\|\s*(ba|z|da)?sh\b|git\s+push\b.*(-f\b|--force)|>\s*\/dev\/sd|\bshutdown\b|\breboot\b)/

// Pimu's data dir (…/pimu/bots/<id> → …/pimu): only this bot's own dir is readable.
const DATA = BOT ? path.resolve(BOT, "..", "..") : ""

function abs(p: unknown, cwd: string): string {
  let s = String(p ?? "").replace(/^@/, "")
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1))
  return path.resolve(cwd, s || ".")
}
// real resolves symlinks (of the longest existing prefix), so a link inside
// cwd cannot point the gate at somewhere else.
function real(p: string): string {
  let head = p
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail)
    } catch {
      const up = path.dirname(head)
      if (up === head) return p
      tail.unshift(path.basename(head))
      head = up
    }
  }
}
const inside = (p: string, dir: string) => !!dir && (p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/"))
function secret(p: string): boolean {
  return SECRET_PATH.test(p + "/") || (inside(p, DATA) && !inside(p, BOT))
}
const where = (p: unknown, cwd: string) => real(abs(p, cwd))

// safeBash accepts only plain words (no quotes, $, globs, ~, redirects, ; & ( ) `),
// a few read-only commands, and file arguments that stay inside roots.
const SAFE = new Set(["cat", "head", "tail", "wc", "ls", "grep", "echo", "pwd", "date", "git", "curl"])
const CURL_FLAGS = new Set(["-s", "-S", "-f", "-L", "-I", "-sS", "-fsS", "-fsSL", "-sL", "-sSL", "--silent", "--fail", "--location", "--head", "--max-time"])
export function safeBash(cmd: string, cwd: string, roots: string[]): boolean {
  if (!cmd || /[^\w\s\-./:=,+%|@]/.test(cmd) || /\n/.test(cmd)) return false
  return cmd.split("|").every((seg) => {
    const [c, ...args] = seg.trim().split(/\s+/)
    if (!SAFE.has(c)) return false
    if (c === "echo" || c === "pwd") return true
    if (c === "date") return args.every((a) => a.startsWith("+"))
    if (c === "curl") {
      return args.length > 0 && args.every((a, i) => CURL_FLAGS.has(a) || /^https?:\/\/[\w.\-:]+(\/[\w.\-/%]*)?$/.test(a) || (args[i - 1] === "--max-time" && /^\d+$/.test(a)))
    }
    let rest = args
    if (c === "git") {
      if (!["status", "log", "diff", "show"].includes(args[0])) return false
      rest = args.slice(1)
    }
    return rest.every((a) => {
      if (a.startsWith("-")) return !/[/=]/.test(a) && !/^-[a-zA-Z]*R/.test(a) && !a.startsWith("--deref")
      const p = where(a, cwd)
      return !secret(p) && roots.some((r) => inside(p, r))
    })
  })
}

async function post(p: string, body: unknown): Promise<{ id?: number; verdict?: string; ahead?: number }> {
  if (!CAP) throw new Error("pimu: no capability (start this session from Pimu)")
  const res = await fetch(API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pimu-Cap": CAP },
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
        const r = await post("/api/internal/jobs", { title: params.title, prompt: params.prompt })
        const at = r.ahead ? `排在第 ${r.ahead + 1} 位` : "已开始"
        return {
          content: [{ type: "text", text: `已派出后台任务 #${r.id}（${at}）。完成后结果会自动送回这个对话；现在继续回应用户，不要等它。` }],
          details: { id: r.id },
        }
      },
    })
  }

  // L0 (a bot's main session): the user is in the loop, so only credentials are off limits.
  if (LEVEL !== 1 && LEVEL !== 2) {
    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>
      const bad =
        READ_ONLY.has(event.toolName) || event.toolName === "write" || event.toolName === "edit"
          ? secret(where(input.path ?? ".", ctx.cwd))
          : event.toolName === "bash" && SECRET_PATH.test(String(input.command ?? ""))
      if (bad) return { block: true, reason: "[pimu] 不允许读取或改动凭据类文件" }
    })
    return
  }

  const classify = (name: string, input: Record<string, unknown>, cwd: string): Verdict => {
    const L1 = LEVEL === 1
    const roots = [real(cwd), real(BOT)]
    if (READ_ONLY.has(name)) {
      const p = where(input.path ?? ".", cwd)
      if (secret(p)) return { block: "不允许读取凭据类文件" }
      if (roots.some((r) => inside(p, r))) return "allow"
      return L1 ? { block: "L1 只能读工作目录和 Bot 目录；需要请输出 ask" } : "approve"
    }
    if (name === "write" || name === "edit") {
      const p = where(input.path, cwd)
      if (/\/GOAL\.md$/.test(p)) return { block: "GOAL.md 由用户维护；进度请写进 ```pimu state" }
      if (secret(p)) return { block: "不允许写凭据类文件" }
      if (inside(p, real(BOT))) return "allow"
      if (L1) return { block: "L1 只能写 Bot 自己的目录；需要改别处请输出 ask" }
      if (inside(p, real(cwd)) && !/\/\.(git|pi)(\/|$)/.test(p)) return "allow"
      return "approve"
    }
    if (name === "bash") {
      const cmd = String(input.command ?? "").trim()
      if (DANGER.test(cmd)) return { block: "危险命令，后台任务一律禁止" }
      if (SECRET_PATH.test(cmd)) return { block: "不允许访问凭据类文件" }
      if (L1) return { block: "L1 不能运行命令；需要时请输出 ask 让用户决定" }
      return safeBash(cmd, cwd, roots) ? "allow" : "approve"
    }
    const tool = pi.getAllTools().find((t) => t.name === name)
    if (tool?.reachesTools) return "allow" // codemode / tool_search: each nested call comes back through this gate
    if (tool?.annotations?.readOnlyHint === true) return "allow"
    return L1 ? { block: `L1 只能用只读工具；${name} 需要时请输出 ask` } : "approve"
  }

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>
    const v = classify(event.toolName, input, ctx.cwd)
    if (v === "allow") return
    if (typeof v === "object") return { block: true, reason: `[pimu L${LEVEL}] ${v.block}` }
    const reason = event.toolName === "bash" ? String(input.command ?? "").slice(0, 120) : String(input.path ?? "").slice(0, 120)
    const ref = { toolCallId: event.toolCallId }
    let r = await post("/api/internal/approvals", { tool: event.toolName, args: input, reason, ...ref })
    // A job waits (paused as waiting_approval) instead of deferring to the next heartbeat.
    while (JOB && r.verdict === "pending") {
      if (ctx.signal?.aborted) return { block: true, reason: "[pimu] 已取消" }
      await new Promise((ok) => setTimeout(ok, 2000))
      r = await post(`/api/internal/approvals/${r.id}/status`, ref)
    }
    switch (r.verdict) {
      case "run":
        return // claimed: this exact call runs once
      case "denied":
        return { block: true, reason: `[pimu] 用户拒绝了这个操作（#${r.id}）。不要再试。` }
      case "pending":
        return { block: true, reason: `[pimu] 已提交审批 #${r.id}，批准后下次心跳执行。先继续别的，或结束本次心跳。` }
      default:
        return { block: true, reason: `[pimu] 审批 #${r.id} 已失效或已用过；需要的话会重新申请。` }
    }
  })
}
