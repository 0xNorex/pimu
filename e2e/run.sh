#!/usr/bin/env bash
# End-to-end suite: real Pimu + real pi + a scripted model (mockllm.mjs), driven
# by Playwright (flows.mjs). Everything lives in a temp dir; ~/.pi is untouched.
#   e2e/run.sh            build web + Go, run all flows
#   NOBUILD=1 e2e/run.sh  reuse bin/pimu
#   ONLY=chat e2e/run.sh  run flows whose name matches
#   e2e/run.sh serve      just start everything and wait (manual poking)
# Needs: pi on PATH, node, Chrome (PW_CHROME, default /usr/bin/google-chrome),
# playwright-core (installed into e2e/node_modules on first run).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [ -z "${NOBUILD:-}" ]; then
  (cd web && npm run build >/dev/null)
  go build -o bin/pimu ./cmd/pimu
fi
[ -d e2e/node_modules/playwright-core ] || (cd e2e && npm i --silent --no-audit --no-fund >/dev/null)

T=$(mktemp -d /tmp/pimu-e2e.XXXXXX)
LLM_PORT=${LLM_PORT:-18999} PORT=${PORT:-17788}
mkdir -p "$T/agent/extensions" "$T/work/proj" "$T/work2" "$T/data"
cp extensions/pimu-agent.ts extensions/pimu-guard.ts "$T/agent/extensions/"
echo "# e2e memory" > "$T/agent/AGENTS.md"
cat > "$T/agent/models.json" <<JSON
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:$LLM_PORT/v1","api":"openai-completions","apiKey":"e2e-dummy",
 "compat":{"supportsStore":false,"supportsDeveloperRole":false,"maxTokensField":"max_tokens","thinkingFormat":"deepseek"},
 "models":[{"id":"echo-1","name":"Echo One","reasoning":true,"input":["text","image"],"contextWindow":64000,"maxTokens":4096},
           {"id":"echo-2","name":"Echo Two","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":2048}]}}}
JSON
echo '{"defaultProvider":"mock","defaultModel":"echo-1"}' > "$T/agent/settings.json"
echo '{"mcpServers":{"e2e-off":{"command":"true","description":"e2e placeholder","enabled":false}}}' > "$T/agent/mcp.json"

cleanup() {
  [ -n "${LLM_PID:-}" ] && kill "$LLM_PID" 2>/dev/null || true
  [ -z "${KEEP:-}" ] && rm -rf "$T" || echo "kept $T"
}
trap cleanup EXIT
node e2e/mockllm.mjs "$LLM_PORT" > "$T/llm.log" 2>&1 & LLM_PID=$!
# flows.mjs starts (and restarts) Pimu itself with these.
export E2E_BIN=$ROOT/bin/pimu E2E_DIR=$T E2E_PORT=$PORT E2E_LLM=http://127.0.0.1:$LLM_PORT
node e2e/flows.mjs "$@"
