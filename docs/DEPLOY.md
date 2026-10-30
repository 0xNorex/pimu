# Deploy: VPS + Cloudflare Tunnel + Access

A hardened setup for a small VPS (2 vCPU / 3 GB is enough): Pimu runs as an
unprivileged `pimu` user under systemd, listens on loopback only, and is reached
through a Cloudflare Tunnel guarded by Cloudflare Access. Pimu verifies the
Access JWT itself; a browser that passed Access goes straight in, no Pimu token
screen. `PIMU_TOKEN` is optional and only adds a second way in (scripts, `curl`,
`pimu release`).

Placeholders: `pimu.example.com` (your hostname), `myteam` (your Zero Trust team
name), `<AUD>` (the Access application's AUD tag).

## 1. Host

```bash
# SSH: keys only (set in /etc/ssh/sshd_config, then `sudo systemctl reload ssh`)
#   PasswordAuthentication no
#   KbdInteractiveAuthentication no
#   PermitRootLogin prohibit-password
sudo apt install -y ufw sqlite3
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw enable   # no port for Pimu: the tunnel dials out
```

## 2. User, Node 22, pi, Pimu

```bash
sudo useradd --create-home --shell /bin/bash pimu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs

sudo -iu pimu bash -c '
  npm config set prefix ~/.local
  npm i -g @earendil-works/pi-coding-agent
  mkdir -p ~/.local/share/pimu ~/work ~/.config/pimu ~/.pi/agent/extensions'
```

Build on your machine (`make build`, needs Go and Node) and copy the binary and
the two extensions over:

```bash
scp bin/pimu extensions/pimu-agent.ts extensions/pimu-guard.ts vps:/tmp/
ssh vps 'sudo install -m755 /tmp/pimu /usr/local/bin/pimu &&
  sudo install -o pimu -g pimu -m600 /tmp/pimu-*.ts /home/pimu/.pi/agent/extensions/'
```

pi config: put `settings.json`, `models.json`, `auth.json` (and `mcp.json` if
used) into `/home/pimu/.pi/agent/`, or log in once with `sudo -iu pimu pi`. Then:

```bash
sudo chown -R pimu:pimu /home/pimu/.pi
sudo chmod 700 /home/pimu/.pi /home/pimu/.pi/agent
sudo find /home/pimu/.pi/agent -maxdepth 1 -type f -exec chmod 600 {} +
```

## 3. Environment file

`/home/pimu/.config/pimu/env`, owner `pimu`, mode `600`:

```bash
#PIMU_TOKEN=<openssl rand -hex 32>       # optional: token login for scripts / curl
PIMU_PUBLIC_URL=https://pimu.example.com
PIMU_ADDR=127.0.0.1:7777
PIMU_WORKDIRS=/home/pimu/work
PIMU_MAX_PROCS=3
PIMU_MAX_JOBS=1
PIMU_CF_ACCESS_TEAM=myteam               # or myteam.cloudflareaccess.com
PIMU_CF_ACCESS_AUD=<AUD>
#PIMU_CF_ACCESS_EMAILS=you@example.com   # optional allowlist (email or service-token client ID)
#PIMU_TELEGRAM_TOKEN=...  PIMU_TELEGRAM_CHAT_ID=...
```

```bash
sudo chown pimu:pimu /home/pimu/.config/pimu/env && sudo chmod 600 /home/pimu/.config/pimu/env
```

Login is either/or: a request is in if it carries a valid Access JWT **or** the
Pimu token (cookie from the login screen, or `Authorization: Bearer`). Pimu
refuses to start with neither configured. `GET /api/auth/status` tells the web
app which one applies, so it skips the token screen behind Access.

With `PIMU_CF_ACCESS_TEAM` + `PIMU_CF_ACCESS_AUD` set (both or neither), the JWT
is read from the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization`
cookie) and checked: RS256, signed by a key from
`https://myteam.cloudflareaccess.com/cdn-cgi/access/certs` (cached, refetched on
an unknown `kid`, at most every 30 s), `iss` = team domain, `aud` contains
`<AUD>`, `exp`/`nbf` within 60 s. A rejected JWT logs a warning and the request
falls back to the token check (401 if that fails too). Unset = off, for local use.

`PIMU_WORKDIRS` defaults to `$HOME`; an empty cwd (the web app's default) means
its first entry, never the process's working directory. The 新会话 dialog lists
those roots plus recent cwds, browses subdirectories and can create one
(`GET/POST /api/dirs`, resolved with symlinks and kept inside the roots).

## 4. systemd

```bash
sudo install -m644 deploy/pimu.service /etc/systemd/system/pimu.service
sudo systemctl daemon-reload && sudo systemctl enable --now pimu
journalctl -u pimu -f            # expect: pimu listening ... cf_access=true token_login=false
```

[`deploy/pimu.service`](../deploy/pimu.service) runs as `pimu` with
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and write
access only to `~/.pi`, `~/.local/share/pimu`, `~/work`, `~/.cache`, `~/.npm`;
`PrivateTmp`, `MemoryMax=1500M` (pi children included), `Restart=on-failure`,
optional `CPUQuota`. The env file, the binaries and pi's install are read-only
for bots. Add your project dirs to both `PIMU_WORKDIRS` and `ReadWritePaths`.

## 5. Cloudflare Tunnel

```bash
# install cloudflared from Cloudflare's apt repo, then:
cloudflared tunnel login
cloudflared tunnel create pimu
cloudflared tunnel route dns pimu pimu.example.com
sudo mkdir -p /etc/cloudflared && sudo cp ~/.cloudflared/<TUNNEL-UUID>.json /etc/cloudflared/
sudo cp deploy/cloudflared.yml /etc/cloudflared/config.yml   # fill in UUID + hostname
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

[`deploy/cloudflared.yml`](../deploy/cloudflared.yml) routes the hostname to
`http://127.0.0.1:7777` and 404s everything else. SSE needs no tuning: Pimu sends
`text/event-stream` with `X-Accel-Buffering: no` and a `: ping` every 15 s,
which stays under the edge's 100 s idle limit. The tunnel needs outbound
TCP/UDP 7844.

## 6. Cloudflare Access

Zero Trust → Access → Applications → Add → Self-hosted:

1. Domain `pimu.example.com`, session duration **24 h**.
2. Login methods: GitHub (protect that account with a passkey) or another IdP
   you trust; turn off what you don't use.
3. Policy *Allow*: Include → Emails → only your own address.
4. Additional settings → copy the **Application Audience (AUD) tag** into
   `PIMU_CF_ACCESS_AUD`.

**Webhooks** (`/api/goals/{id}/hook`), pick one:

- **Service token** (recommended for your own scripts): Access → Service
  credentials → create a token; add a second policy *Service Auth* (Include →
  Service Token) to the **same** application, so the JWT has the same AUD. The
  caller sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` to the
  hook's `?k=` URL. If you set `PIMU_CF_ACCESS_EMAILS`, add the client ID there.
- **Bypass + HMAC** (for GitHub and other third parties): a second application
  on path `pimu.example.com/api/goals/*/hook` with a *Bypass* policy. The hook
  then accepts the `?k=` URL or, better (the key stays out of URLs and logs), a
  signature: header `X-Pimu-Signature` or GitHub's `X-Hub-Signature-256`, value
  `sha256=<hex HMAC-SHA256(secret, raw body)>`, where the secret is the `k` of
  the hook URL.

```bash
body='{"text":"deploy done"}'
sig=$(printf %s "$body" | openssl dgst -sha256 -hmac "$K" | sed 's/.* //')
curl -X POST https://pimu.example.com/api/goals/1/hook \
  -H "X-Pimu-Signature: sha256=$sig" -H 'Content-Type: application/json' -d "$body"
```

GitHub: Payload URL without `?k=`, content type `application/json`, Secret = `K`.

## 7. Cost limits

- `PIMU_MAX_JOBS=1`: one background job at a time, the rest queue.
- Each goal has a daily token cap (`dayTokens`, default 1,000,000) plus per-run
  caps; set them lower in the goal's settings.
- There is **no global daily cap** for chats and jobs: set a spending limit at
  your model provider as well.

## 8. Backup

```bash
sudo -u pimu sqlite3 /home/pimu/.local/share/pimu/pimu.db \
  ".backup /home/pimu/.local/share/pimu/backup.db"
sudo tar -C /home/pimu -czf /root/pimu-$(date +%F).tgz \
  .local/share/pimu/backup.db .local/share/pimu/bots .pi/agent/sessions .config/pimu
sudo chmod 600 /root/pimu-*.tgz
```

Run it daily from root's crontab and copy the archive off the box; it contains
secrets (`env`, hook secrets in the DB).

## 9. Update

```bash
make build && scp bin/pimu extensions/pimu-*.ts vps:/tmp/
ssh vps 'sudo install -m755 /tmp/pimu /usr/local/bin/pimu &&
  sudo install -o pimu -g pimu -m600 /tmp/pimu-*.ts /home/pimu/.pi/agent/extensions/ &&
  sudo systemctl restart pimu'
# pi itself:
ssh vps 'sudo -iu pimu npm i -g @earendil-works/pi-coding-agent && sudo systemctl restart pimu'
```

Back up first (§8). Restarting stops running pi processes; running jobs become "interrupted", queued ones stay queued.
