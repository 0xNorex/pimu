// pimu-guard: stops a terminal `pi` from writing a session that Pimu is
// running (pi core has no session lock, see earendil-works/pi#8300).
// Install: make install-guard  (copies to ~/.pi/agent/extensions/)
// Lock format is shared with Pimu's internal/lock/lock.go.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
const lockPath = (id: string) => path.join(agentDir, "locks", `${id}.lock`)

type Lock = { pid: number; owner: string; host: string; at: string }

function live(l: Lock): boolean {
  if (l.host && l.host !== os.hostname()) return Date.now() - Date.parse(l.at) < 24 * 3600 * 1000
  try {
    process.kill(l.pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function holder(id: string): Lock | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockPath(id), "utf8")) as Lock
    return l.pid > 0 && live(l) ? l : null
  } catch {
    return null
  }
}

// Returns true if this process now holds the lock.
function acquire(id: string): boolean {
  fs.mkdirSync(path.dirname(lockPath(id)), { recursive: true })
  const body = JSON.stringify({ pid: process.pid, owner: "pi-cli", host: os.hostname(), at: new Date().toISOString() })
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lockPath(id), body, { flag: "wx", mode: 0o600 })
      return true
    } catch {
      if (holder(id)) return false
      fs.rmSync(lockPath(id), { force: true }) // stale
    }
  }
  return false
}

export default function (pi: ExtensionAPI) {
  let held: string | null = null
  const release = () => {
    if (held && holder(held)?.pid === process.pid) fs.rmSync(lockPath(held), { force: true })
    held = null
  }

  pi.on("session_start", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId()
    if (process.env.PIMU_LOCK_OWNER === id) return // started by Pimu, which holds the lock
    if (!ctx.sessionManager.getSessionFile()) return // --no-session
    if (acquire(id)) {
      held = id
      return
    }
    const msg = `该会话正被 Pimu 使用：先运行 pimu release ${id}（或在 Pimu 里点“交给终端”）再重试，或用 --fork`
    if (!ctx.hasUI) {
      // print/json mode has no shutdown handler: exit before the prompt is written
      process.stderr.write(msg + "\n")
      process.exit(1)
    }
    ctx.ui.notify(msg, "error")
    ctx.shutdown() // interactive: exits while idle, before any input
  })

  pi.on("session_before_switch", async (event, ctx) => {
    const target = event.targetSessionFile
    if (!target) return
    const id = path.basename(target, ".jsonl").split("_").pop() ?? ""
    const l = holder(id)
    if (l && l.pid !== process.pid) {
      ctx.ui.notify("目标会话正被 Pimu 使用，已取消切换", "error")
      return { cancel: true }
    }
  })

  pi.on("session_shutdown", async () => release())
}
