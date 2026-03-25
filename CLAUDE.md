# CLAUDE.md - OpenClaw Bare-metal Deployment (v2)

## Tong quan du an

He thong cai dat va quan ly **OpenClaw** tren VPS chay truc tiep (bare-metal, khong Docker). Bao gom:
- **install.sh** — Script cai dat all-in-one (HostBill hook goi qua SSH)
- **Management API** — REST API de quan ly tu xa (doi model, API key, domain, restart, rebuild, logs...)

## Cong nghe

- **Node.js 24** — OpenClaw + Management API runtime
- **OpenClaw** — Cai qua `npm install -g openclaw@latest`
- **Caddy** — Reverse proxy + TLS tu dong (cai qua apt)
- **systemd** — Quan ly OpenClaw, Caddy, Management API services
- **UFW / fail2ban** — Tuong lua + chong brute-force

## Cau truc thu muc

```
OpenClaw/
├── install.sh                  # Script cai dat all-in-one (bare-metal)
├── Caddyfile                   # Template Caddy config
├── management-api/
│   └── server.js               # Management API server (port 9998)
├── config/                       # Template configs cho 18+ providers
│   ├── anthropic.json openai.json gemini.json
│   ├── deepseek.json groq.json together.json mistral.json xai.json
│   ├── cerebras.json sambanova.json fireworks.json cohere.json
│   ├── yi.json baichuan.json stepfun.json siliconflow.json
│   └── novita.json openrouter.json minimax.json moonshot.json zhipu.json
├── version.json                # Version tracking
└── CLAUDE.md
```

## Cai dat

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/v2/install.sh | bash
```

## Tren VPS sau khi cai dat

```
/opt/openclaw/                  # Thu muc chinh
├── .env                        # Environment vars (tokens, API keys)
├── .openclaw -> config/        # Symlink (OpenClaw reads HOME/.openclaw)
├── Caddyfile
├── config/
│   ├── openclaw.json           # Config hien tai
│   └── agents/                 # Per-agent auth data
│       └── <agentId>/agent/
│           └── auth-profiles.json
└── data/                       # Persistent data

/opt/openclaw-mgmt/
└── server.js                   # Management API

/etc/openclaw/config/           # Template configs (khong sua)
├── anthropic.json
├── openai.json
├── ...
└── zhipu.json

# Systemd services:
# openclaw.service      — OpenClaw Gateway (port 18789)
# caddy.service         — Caddy reverse proxy (port 80/443)
# openclaw-mgmt.service — Management API (port 9998)
```

## Management API

**Port**: 9998 | **Auth**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Endpoints

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/pair` | Bat device auto-approve + redirect toi gateway (public) |
| `GET` | `/api/info` | Thong tin service (domain, IP, token, status) |
| `GET` | `/api/status` | Trang thai services |
| `GET` | `/api/domain` | Xem domain config |
| `PUT` | `/api/domain` | Doi domain + SSL |
| `GET` | `/api/version` | Version info |
| `POST` | `/api/upgrade` | Update openclaw (npm) + restart |
| `POST` | `/api/restart` | Restart service |
| `POST` | `/api/stop` | Stop service |
| `POST` | `/api/start` | Start service |
| `POST` | `/api/rebuild` | Restart openclaw + caddy |
| `POST` | `/api/reset` | Xoa data, tao lai tu dau |
| `GET` | `/api/logs` | Service logs (journalctl) |
| `GET` | `/api/providers` | List tat ca providers (built-in + custom) |
| `GET` | `/api/config` | Xem config (model, provider, keys masked) |
| `PUT` | `/api/config/provider` | Doi provider + model (built-in) |
| `PUT` | `/api/config/api-key` | Doi API key |
| `POST` | `/api/config/test-key` | Test API key |
| `POST` | `/api/config/custom-provider` | Tao custom provider moi |
| `GET` | `/api/config/custom-providers` | List custom providers |
| `PUT` | `/api/config/custom-provider/:provider` | Update custom provider |
| `DELETE` | `/api/config/custom-provider/:provider` | Xoa custom provider |
| `GET` | `/api/channels` | List kenh nhan tin |
| `PUT` | `/api/channels/:ch` | Them/sua kenh |
| `DELETE` | `/api/channels/:ch` | Xoa kenh |
| `GET` | `/api/env` | Xem env vars |
| `PUT` | `/api/env/:key` | Set env var |
| `DELETE` | `/api/env/:key` | Xoa env var |
| `GET` | `/api/system` | System info |
| `POST` | `/api/cli` | Chay CLI commands truc tiep |
| `POST` | `/api/self-update` | Cap nhat Management API + config templates tu GitHub |

#### Multi-Agent Management

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/agents` | List tat ca agents (kem API key count) |
| `POST` | `/api/agents` | Tao agent moi |
| `GET` | `/api/agents/:id` | Chi tiet agent (kem masked API keys) |
| `PUT` | `/api/agents/:id` | Update agent (name, model, workspace) |
| `DELETE` | `/api/agents/:id` | Xoa agent (khong cho xoa default hoac agent cuoi cung) |
| `PUT` | `/api/agents/:id/default` | Set agent lam default |
| `GET` | `/api/agents/:id/api-key` | Xem masked API keys cua agent |
| `PUT` | `/api/agents/:id/api-key` | Set API key cho agent |

#### User Login / Authentication

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/login` | Serve login page (public, no auth) |
| `POST` | `/api/auth/login` | Login (public) — tra ve gateway token |
| `POST` | `/api/auth/create-user` | Tao login user (protected) — luu vao .env |
| `GET` | `/api/auth/user` | Xem login user hien tai (protected) |
| `PUT` | `/api/auth/change-password` | Doi password (protected) |
| `DELETE` | `/api/auth/user` | Xoa login credentials (protected) |

#### Routing Bindings

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/bindings` | List tat ca routing bindings |
| `POST` | `/api/bindings` | Tao binding (agentId + match rules) |
| `PUT` | `/api/bindings/:index` | Update binding |
| `DELETE` | `/api/bindings/:index` | Xoa binding |

### Vi du su dung

```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)

# Xem status
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status

# Doi model
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"anthropic/claude-sonnet-4-20250514"}' \
  http://localhost:9998/api/config/provider

# Rebuild
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/rebuild

# CLI
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' http://localhost:9998/api/cli
```

## Quy uoc

- OpenClaw binary: `openclaw` (npm global)
- Gateway port: 18789 (Caddy proxy ra 80/443)
- Management API port: 9998 (systemd)
- Tokens: 64-char hex, sinh bang `openssl rand -hex 32`
- Config templates luu tai `/etc/openclaw/config/` (khong sua)
- Config hien tai tai `/opt/openclaw/config/openclaw.json`
- Khong commit API key hoac token that

## Lenh thuong dung (tren VPS)

```bash
systemctl status openclaw           # Trang thai
journalctl -u openclaw -f           # Xem logs
systemctl restart openclaw          # Restart
systemctl stop openclaw             # Stop
npm update -g openclaw && systemctl restart openclaw  # Upgrade
openclaw models scan                # CLI truc tiep
```
