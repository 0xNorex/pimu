// Test harness for pimu-agent.ts (driven by gate_test.go): loads the extension
// with a fake pi, feeds it tool_call events from stdin, prints the verdicts.
import * as fs from "node:fs"

const capFile = process.env.PIMU_CAP_FILE
const mod = await import(process.argv[2])
const handlers = []
const tools = []
const pi = {
  on: (ev, fn) => ev === "tool_call" && handlers.push(fn),
  registerTool: (t) => tools.push(t.name),
  getAllTools: () => [
    { name: "codemode", reachesTools: true },
    { name: "mcp_read", annotations: { readOnlyHint: true } },
    { name: "mcp_write" },
  ],
}
mod.default(pi)
const cases = JSON.parse(fs.readFileSync(0, "utf8"))
const out = []
for (const c of cases) {
  let r
  for (const h of handlers) {
    try {
      r = await h({ toolName: c.tool, input: c.input, toolCallId: c.id || "call" }, { cwd: c.cwd })
    } catch (e) {
      r = { block: true, reason: "handler threw (pi blocks the call): " + e.message } // pi fails closed
    }
    if (r?.block) break
  }
  out.push(r?.block ? "block: " + r.reason : "allow")
}
console.log(JSON.stringify({ out, tools, capEnv: process.env.PIMU_CAP_FILE ?? null, capLeft: !!capFile && fs.existsSync(capFile) }))
