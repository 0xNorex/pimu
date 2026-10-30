# Pimu

Not another agent harness. Just Pi, everywhere.

Pimu is a thin Go server plus a mobile-first PWA around the unmodified
[`pi`](https://github.com/earendil-works/pi) CLI. It runs `pi --mode rpc` per
session and streams its events to the browser. Models, tools, MCP, sessions
and auth all stay in pi. Design: [docs/DESIGN.md](docs/DESIGN.md). Status: [NOW.md](NOW.md).

## Requirements

- Go ≥ 1.26, Node ≥ 22 (build only)
- `npm i -g @earendil-works/pi-coding-agent` (tested with 1.4.0), then run `pi` once
  in a terminal and `/login` (or configure `~/.pi/agent/models.json`)

## Build

```bash
make build            # (cd web && npm ci && npm run build) && go build -o bin/pimu ./cmd/pimu
make check            # gofmt + go vet + tsc
make install-guard    # copy extensions/pimu-guard.ts to ~/.pi/agent/extensions/
```

`bin/pimu` is a single file with the UI embedded. Without `make`, run the two
commands from the comment above.

## Run

```bash
export PIMU_TOKEN=$(openssl rand -hex 32)   # ≥ 32 chars; this is your login password
./bin/pimu serve                            # http://127.0.0.1:7777
```

Open the URL, paste the token. On iPhone: Safari → Share → Add to Home Screen.

| env | default | |
|---|---|---|
| `PIMU_ADDR` | `127.0.0.1:7777` | keep loopback; expose via a tunnel |
| `PIMU_TOKEN` | – | required |
| `PIMU_PUBLIC_URL` | – | e.g. `https://pimu.example.com`; enables Origin check + Secure cookie |
| `PIMU_WORKDIRS` | `$HOME` | `:`-separated dirs where sessions may be created |
| `PIMU_PI_BIN` / `PIMU_PI_ARGS` | `pi` / – | extra args passed to every `pi --mode rpc` |
| `PIMU_IDLE_TIMEOUT` | `10m` | idle pi processes are stopped |
| `PIMU_MAX_PROCS` | `3` | concurrent pi processes |
| `PIMU_LOG_LEVEL` | `info` | `debug` also logs pi stderr |

## Terminal and Pimu on the same session

Pimu holds `~/.pi/agent/locks/<id>.lock` while its pi runs a session. With the
guard extension installed, a terminal `pi --session <id>` refuses to open a
session Pimu holds. Hand it over with `pimu release <id>` (or 交给终端 in the
UI menu); while the terminal holds it, Pimu shows the session read-only and
prompts return 409.

## Deploy (systemd + cloudflared)

```bash
make install install-guard
mkdir -p ~/.config/pimu && printf 'PIMU_TOKEN=%s\nPIMU_PUBLIC_URL=https://pimu.example.com\n' "$(openssl rand -hex 32)" > ~/.config/pimu/env
chmod 600 ~/.config/pimu/env
cp deploy/pimu.service ~/.config/systemd/user/ && systemctl --user enable --now pimu
loginctl enable-linger "$USER"
```

cloudflared: `cloudflared tunnel create pimu`, ingress `pimu.example.com →
http://127.0.0.1:7777`, and a Zero Trust Access app on that hostname allowing
only your email.
