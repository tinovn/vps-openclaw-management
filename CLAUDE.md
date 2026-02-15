# CLAUDE.md - OpenClaw Docker Compose Deployment

## Tong quan du an

He thong cai dat va quan ly **OpenClaw** tren VPS su dung Docker Compose. Bao gom:
- **install.sh** — Script cai dat all-in-one (HostBill hook goi qua SSH)
- **Management API** — REST API de quan ly tu xa (doi model, API key, domain, restart, rebuild, logs...)

## Cong nghe

- **Docker Compose** — Chay OpenClaw + Caddy trong containers
- **Node.js 22** — Management API runtime (chay tren host)
- **Caddy** — Reverse proxy + TLS tu dong (container)
- **UFW / fail2ban** — Tuong lua + chong brute-force
- **systemd** — Quan ly Management API service

## Cau truc thu muc

```
OpenClaw/
├── install.sh                  # Script cai dat all-in-one
├── docker-compose.yml          # Template Docker Compose (openclaw + caddy)
├── Caddyfile                   # Template Caddy config
├── management-api/
│   └── server.js               # Management API server (port 9998)
├── config/                       # Template configs cho 18 providers
│   ├── anthropic.json openai.json gemini.json
│   ├── deepseek.json groq.json together.json mistral.json xai.json
│   ├── cerebras.json sambanova.json fireworks.json cohere.json
│   ├── yi.json baichuan.json stepfun.json siliconflow.json
│   └── novita.json openrouter.json minimax.json moonshot.json zhipu.json
├── template.json               # Packer template (legacy)
└── CLAUDE.md
```

## Cai dat

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/install.sh | bash
```

## Tren VPS sau khi cai dat

```
/opt/openclaw/                  # Thu muc chinh
├── docker-compose.yml
├── .env                        # Environment vars (tokens, API keys)
├── Caddyfile
├── config/
│   └── openclaw.json           # Config hien tai
└── data/                       # Persistent data

/opt/openclaw-mgmt/
└── server.js                   # Management API

/etc/openclaw/config/           # Template configs (khong sua)
├── anthropic.json
├── openai.json
├── gemini.json
├── deepseek.json
├── groq.json
├── together.json
├── mistral.json
├── xai.json
├── cerebras.json
├── sambanova.json
├── fireworks.json
├── cohere.json
├── yi.json
├── baichuan.json
├── stepfun.json
├── siliconflow.json
├── novita.json
├── openrouter.json
├── minimax.json
├── moonshot.json
└── zhipu.json
```

## Management API

**Port**: 9998 | **Auth**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Endpoints

| Method | Path | Mo ta |
|--------|------|-------|
| `GET` | `/api/info` | Thong tin service (domain, IP, token, status) |
| `GET` | `/api/status` | Trang thai container |
| `GET` | `/api/domain` | Xem domain config |
| `PUT` | `/api/domain` | Doi domain + SSL |
| `GET` | `/api/version` | Version + image info |
| `POST` | `/api/upgrade` | Pull image moi + recreate |
| `POST` | `/api/restart` | Restart container |
| `POST` | `/api/stop` | Stop container |
| `POST` | `/api/start` | Start container |
| `POST` | `/api/rebuild` | Down + Up (recreate) |
| `POST` | `/api/reset` | Xoa data, tao lai tu dau |
| `GET` | `/api/logs` | Container logs |
| `GET` | `/api/config` | Xem config (model, provider, keys masked) |
| `PUT` | `/api/config/provider` | Doi provider + model |
| `PUT` | `/api/config/api-key` | Doi API key |
| `POST` | `/api/config/test-key` | Test API key |
| `GET` | `/api/channels` | List kenh nhan tin |
| `PUT` | `/api/channels/:ch` | Them/sua kenh |
| `DELETE` | `/api/channels/:ch` | Xoa kenh |
| `GET` | `/api/env` | Xem env vars |
| `PUT` | `/api/env/:key` | Set env var |
| `DELETE` | `/api/env/:key` | Xoa env var |
| `GET` | `/api/system` | System info |
| `POST` | `/api/cli` | Proxy CLI commands vao container |
| `POST` | `/api/self-update` | Cap nhat Management API + docker-compose + config templates tu GitHub |

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

# CLI proxy
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' http://localhost:9998/api/cli
```

## Quy uoc

- Docker image: `ghcr.io/openclaw/openclaw:latest`
- Gateway port: 18789 (trong Docker network, Caddy proxy ra 80/443)
- Management API port: 9998 (tren host, systemd)
- Tokens: 64-char hex, sinh bang `openssl rand -hex 32`
- Config templates luu tai `/etc/openclaw/config/` (khong sua)
- Config hien tai tai `/opt/openclaw/config/openclaw.json`
- Khong commit API key hoac token that

## Lenh Docker thuong dung (tren VPS)

```bash
cd /opt/openclaw
docker compose logs -f              # Xem logs
docker compose restart openclaw     # Restart
docker compose pull && docker compose up -d  # Upgrade
docker compose down                 # Stop tat ca
docker compose exec openclaw node dist/index.js <command>  # CLI
```
