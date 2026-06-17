# OpenClaw v2 — Bare-metal Deployment

## Kien truc

```
Internet
  │
  ▼
┌─────────────────────────────────┐
│  Caddy (systemd)                │  Port 80/443
│  - Reverse proxy                │  Let's Encrypt auto SSL
│  - /login, /api/auth/* → :9998  │
│  - /* → :18789                  │
└──────────┬──────────────────────┘
           │
     ┌─────┴─────────────────────┐
     ▼                           ▼
┌────────────────┐    ┌──────────────────────┐
│ OpenClaw       │    │ Management API       │
│ (systemd)      │    │ (systemd)            │
│ Port 18789     │    │ Port 9998            │
│ Gateway +      │    │ REST API quan ly     │
│ Control UI     │    │ Device auto-approve  │
└────────────────┘    └──────────────────────┘
```

**Khong su dung Docker.** Tat ca chay truc tiep tren OS, quan ly bang systemd.

## Thanh phan

| Thanh phan | Binary | Service | Port | Muc dich |
|------------|--------|---------|------|----------|
| OpenClaw | `openclaw` (npm global) | `openclaw.service` | 18789 | AI Gateway + Control UI |
| Caddy | `caddy` (apt) | `caddy.service` | 80, 443 | Reverse proxy + SSL |
| Management API | `node server.js` | `openclaw-mgmt.service` | 9998 | REST API quan ly tu xa |

## Duong dan quan trong

```
/opt/openclaw/                     # Thu muc chinh
├── .env                           # Tat ca config (tokens, keys, domain)
├── .openclaw -> config/           # Symlink — OpenClaw doc config tu day
├── Caddyfile                      # Caddy config (dung env vars tu .env)
├── config/
│   ├── openclaw.json              # Config chinh (model, provider, gateway)
│   ├── devices/
│   │   ├── pending.json           # Devices dang cho approve
│   │   └── paired.json            # Devices da pair
│   └── agents/                    # Multi-agent data
│       └── <agentId>/agent/
│           └── auth-profiles.json # API keys cua agent
└── data/                          # Du lieu OpenClaw

/opt/openclaw-mgmt/
└── server.js                      # Management API source

/etc/openclaw/config/              # Template configs (khong sua truc tiep)
├── anthropic.json
├── openai.json
├── deepseek.json
└── ...                            # 20+ providers

/etc/systemd/system/
├── openclaw.service               # OpenClaw service
├── openclaw-mgmt.service          # Management API service
└── caddy.service.d/
    └── override.conf              # Caddy override (doc .env + Caddyfile)
```

## Cai dat moi

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/install.sh | \
  bash -s -- --domain <DOMAIN> [--mgmt-key <KEY>]
```

Qua trinh cai dat:
1. Cap nhat OS, cai `jq`, `ufw`, `fail2ban`
2. Cai Node.js 24, `npm install -g openclaw@latest`
3. Cai Caddy qua apt
4. Sinh tokens, tao `.env`
5. Tao systemd services, start
6. Auto-approve devices
7. Cai Management API

Sau khi xong, output tra ve:
- **Dashboard URL** (pair URL): `http://<IP>:9998/pair?token=<TOKEN>`
- **MGMT API Key**: dung de goi Management API

## Van hanh hang ngay

### Kiem tra trang thai

```bash
# Trang thai services
systemctl status openclaw
systemctl status caddy
systemctl status openclaw-mgmt

# Hoac qua API
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status
```

### Xem logs

```bash
# OpenClaw logs
journalctl -u openclaw -f                    # Realtime
journalctl -u openclaw --no-pager -n 100     # 100 dong gan nhat

# Caddy logs
journalctl -u caddy -f

# Management API logs
journalctl -u openclaw-mgmt -f

# Hoac qua API
curl -H "Authorization: Bearer $MGMT_KEY" "http://localhost:9998/api/logs?lines=100"
curl -H "Authorization: Bearer $MGMT_KEY" "http://localhost:9998/api/logs?service=caddy&lines=50"
```

### Restart / Stop / Start

```bash
# Truc tiep
systemctl restart openclaw
systemctl stop openclaw
systemctl start openclaw

# Qua API
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/restart
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/stop
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/start
```

### Cap nhat OpenClaw

```bash
npm install -g openclaw@latest && openclaw doctor --fix && systemctl restart openclaw

# Hoac qua API (npm install + doctor --fix + restart)
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/upgrade
```

### Cap nhat Management API

```bash
# Tu dong (tai server.js + config templates moi tu GitHub)
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/self-update

# Thu cong
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/management-api/server.js \
  -o /opt/openclaw-mgmt/server.js
systemctl restart openclaw-mgmt
```

### Doi domain

```bash
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"domain":"new.example.com"}' \
  http://localhost:9998/api/domain
```
Caddy tu dong xin SSL Let's Encrypt. Neu DNS chua tro dung, se dung self-signed truoc.

### Doi model / provider

```bash
# Doi provider + model
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","model":"deepseek/deepseek-chat"}' \
  http://localhost:9998/api/config/provider

# Set API key
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/api-key
```

### Reset (xoa data, tao lai tu dau)

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"confirm":"RESET"}' \
  http://localhost:9998/api/reset
```

## Xu ly su co

### OpenClaw khong start

```bash
# Kiem tra log
journalctl -u openclaw --no-pager -n 50

# Kiem tra config hop le
cat /opt/openclaw/config/openclaw.json | jq .

# Kiem tra port
ss -tlnp | grep 18789

# Thu start thu cong
HOME=/opt/openclaw openclaw gateway --port 18789 --allow-unconfigured
```

### Caddy loi SSL

```bash
# Kiem tra log
journalctl -u caddy --no-pager -n 50

# Kiem tra DNS
dig +short <DOMAIN>   # Phai tra ve IP cua VPS

# Kiem tra Caddyfile
cat /opt/openclaw/Caddyfile

# Kiem tra env
grep DOMAIN /opt/openclaw/.env
grep CADDY_TLS /opt/openclaw/.env

# Restart caddy
systemctl restart caddy
```

### Management API khong chay

```bash
journalctl -u openclaw-mgmt --no-pager -n 50

# Kiem tra port
ss -tlnp | grep 9998

# Thu chay thu cong
node /opt/openclaw-mgmt/server.js
```

### Device pairing khong hoat dong

Flow pairing:
1. User mo pair URL → Management API bat poll 60s
2. Poll doc `pending.json` moi 2s
3. Khi co pending device → ghi vao `paired.json` + xoa khoi `pending.json`
4. Gateway doc `paired.json` → accept device

```bash
# Kiem tra pending
cat /opt/openclaw/config/devices/pending.json | jq .

# Kiem tra paired
cat /opt/openclaw/config/devices/paired.json | jq 'keys'

# Xoa tat ca devices (force re-pair)
echo '{}' > /opt/openclaw/config/devices/paired.json
echo '{}' > /opt/openclaw/config/devices/pending.json
systemctl restart openclaw
```

### Kiem tra RAM / CPU

```bash
free -h
ps aux --sort=-%mem | head -10
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/system
```

## Management API — Danh sach endpoints

### Public (khong can auth)

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/pair?token=xxx` | Bat device auto-approve + redirect toi gateway |
| `GET` | `/login` | Trang login |
| `GET` | `/terminal` | Terminal web UI |

### Protected (can `Authorization: Bearer <MGMT_KEY>`)

**Thong tin & trang thai**

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/info` | Domain, IP, token, status, version |
| `GET` | `/api/status` | Trang thai openclaw + caddy |
| `GET` | `/api/version` | OpenClaw version |
| `GET` | `/api/system` | RAM, CPU, disk, versions |
| `GET` | `/api/logs` | Logs (query: `?lines=100&service=openclaw`) |
| `GET` | `/api/domain` | Domain + SSL info |

**Dieu khien service**

| Method | Path | Mo ta |
|--------|------|-------|
| `POST` | `/api/restart` | Restart OpenClaw |
| `POST` | `/api/stop` | Stop OpenClaw |
| `POST` | `/api/start` | Start OpenClaw |
| `POST` | `/api/rebuild` | Restart openclaw + caddy |
| `POST` | `/api/reset` | Xoa data, tao lai (can `{"confirm":"RESET"}`) |
| `POST` | `/api/upgrade` | `npm install -g openclaw@latest` + `doctor --fix` + restart (`{restart?}`) |
| `POST` | `/api/self-update` | Cap nhat Management API tu GitHub |
| `PUT` | `/api/domain` | Doi domain (Caddy tu xin SSL) |

**Config & Provider**

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/config` | Xem config (model, provider, keys masked) |
| `GET` | `/api/providers` | List 20+ built-in providers |
| `PUT` | `/api/config/provider` | Doi provider + model |
| `PUT` | `/api/config/api-key` | Set API key |
| `POST` | `/api/config/test-key` | Test API key |
| `POST` | `/api/config/custom-provider` | Tao custom provider |
| `GET` | `/api/config/custom-providers` | List custom providers |
| `PUT` | `/api/config/custom-provider/:p` | Update custom provider |
| `DELETE` | `/api/config/custom-provider/:p` | Xoa custom provider |

**ChatGPT OAuth (Codex) — provider `openai`, default model `openai/gpt-5.5`**

Tren VPS khong co browser → dung **device-code flow** (khong can copy-paste).

| Method | Path | Mo ta |
|--------|------|-------|
| `POST` | `/api/config/chatgpt-oauth/device/start` | **(Khuyen nghi VPS)** Bat dau device-code. Tra ve `{sessionId, verificationUrl, userCode}` — user mo URL, nhap code tren dien thoai. Server tu poll nen. Body: `{agentId?, model?, switchProvider?}` |
| `GET` | `/api/config/chatgpt-oauth/device/status?sessionId=...` | Poll ket qua: `status` = `pending`/`ready`/`error`/`expired` |
| `POST` | `/api/config/chatgpt-oauth/start` | (Fallback) PKCE browser flow — tra `oauthUrl`, can copy-paste redirect URL |
| `POST` | `/api/config/chatgpt-oauth/complete` | Hoan thanh PKCE: `{sessionId, redirectUrl, model?}` |
| `POST` | `/api/config/chatgpt-oauth/refresh` | Refresh token thu cong (`{agentId?}`) |
| `GET` | `/api/config/chatgpt-oauth/status` | Trang thai token hien tai (expires, accountId) + `accounts[]` (da tai khoan). Doc gop JSON + SQLite |
| `POST` | `/api/config/chatgpt-oauth/disconnect` | Ngat ket noi. Body `{agentId?, profileKey?}` — profileKey xoa 1 tai khoan, bo trong = xoa tat ca. Xoa khoi JSON + SQLite roi restart |

Device-code flow (verified OpenClaw 2026.6.8): `POST auth.openai.com/api/accounts/deviceauth/usercode` → hien `auth.openai.com/codex/device` + user_code → server poll `/api/accounts/deviceauth/token` → exchange `/oauth/token`. Header bat buoc: `originator: openclaw`.

**Quan trong — Auth store la SQLite:** OpenClaw 2026.6.x doc credential tu `agents/main/agent/openclaw-agent.sqlite`, KHONG doc `auth-profiles.json` luc runtime. Management API ghi token vao `auth-profiles.json` (key `openai:<email>`, format `{version:1,profiles}`) ROI chay `openclaw doctor --fix --yes --non-interactive` de nap vao SQLite, sau do restart. Tat ca endpoint set credential (OAuth + API key) deu tu dong lam buoc nay (`finalizeAuth`). Sau khi doctor consume `auth-profiles.json` (file thanh rong), trang thai that nam o SQLite — vi vay `getOAuthProfile`/`/status` doc GOP JSON + SQLite (`readSqliteProfiles`/`readAllProfiles`), neu khong badge se bao "chua ket noi" du token van usable.

**Diagnostics**

| Method | Path | Mo ta |
|--------|------|-------|
| `POST` | `/api/doctor` | Chay `openclaw doctor --fix` (migrate auth profile cu `openai-codex`→`openai`, sua config). Body: `{restart?}` |
| `GET` | `/api/models/status` | `openclaw models status` (them `?probe=1` de probe credential) |

**Multi-Agent**

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Tao agent (`{"id","name","model"}`) |
| `GET` | `/api/agents/:id` | Chi tiet agent |
| `PUT` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Xoa agent |
| `PUT` | `/api/agents/:id/default` | Set default agent |
| `GET` | `/api/agents/:id/api-key` | Xem API keys (masked) |
| `PUT` | `/api/agents/:id/api-key` | Set API key cho agent |

**Routing Bindings**

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/bindings` | List bindings |
| `POST` | `/api/bindings` | Tao binding (`{"agentId","match":{"channel":"telegram"}}`) |
| `PUT` | `/api/bindings/:index` | Update binding |
| `DELETE` | `/api/bindings/:index` | Xoa binding |

**Authentication (Login)**

| Method | Path | Mo ta |
|--------|------|-------|
| `POST` | `/api/auth/login` | Login (public) |
| `POST` | `/api/auth/create-user` | Tao user (`{"username","password"}`) |
| `GET` | `/api/auth/user` | Xem user hien tai |
| `PUT` | `/api/auth/change-password` | Doi password |
| `DELETE` | `/api/auth/user` | Xoa user |

**Channels & Environment**

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/channels` | List messaging channels |
| `PUT` | `/api/channels/:ch` | Them/sua channel |
| `DELETE` | `/api/channels/:ch` | Xoa channel |
| `GET` | `/api/env` | Xem env vars |
| `PUT` | `/api/env/:key` | Set env var |
| `DELETE` | `/api/env/:key` | Xoa env var |
| `GET` | `/api/devices` | List devices |
| `POST` | `/api/cli` | Chay CLI (`{"command":"models scan"}`) |

## Bao mat

- **Gateway token**: 64-char hex, luu trong `.env` — dung de truy cap Control UI
- **MGMT API key**: 64-char hex — dung de goi Management API
- **UFW**: Chi mo port 80, 443, 9998, SSH
- **fail2ban**: Chong brute-force SSH
- **Caddy**: Tu dong SSL (Let's Encrypt hoac self-signed)
- **Device pairing**: Moi thiet bi truy cap can duoc approve

## Quy uoc

- Tokens: `openssl rand -hex 32`
- Config templates: `/etc/openclaw/config/` (khong sua)
- Config hien tai: `/opt/openclaw/config/openclaw.json`
- Khong luu API key/token trong git
- Branch `v2` cho bare-metal, `main` cho Docker (legacy)
