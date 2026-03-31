# OpenClaw v2 — Quản lý VPS (Bare-metal)

Triển khai và quản lý [OpenClaw](https://github.com/openclaw/openclaw) trên VPS **không cần Docker**. Cài đặt trực tiếp qua npm, reverse proxy bằng Caddy, quản lý bằng systemd và REST Management API.

## Tính năng

- **Cài đặt một lệnh** — Tự động cài Node.js 24, OpenClaw, Caddy, tường lửa và fail2ban
- **Không Docker** — Chạy trực tiếp trên OS, tiết kiệm 200-500MB RAM
- **Management API** — REST API (cổng 9998) để quản lý từ xa
- **22+ nhà cung cấp AI** — Anthropic, OpenAI, Gemini, DeepSeek, ... + custom provider
- **ChatGPT OAuth** — Tích hợp OpenAI Codex qua OAuth2 PKCE, tự động refresh token
- **Đa agent** — Nhiều agent với model và API key độc lập, routing theo kênh
- **Kênh nhắn tin** — Telegram, Discord, Slack, Zalo OA
- **Tự động SSL** — Let's Encrypt qua Caddy, hoặc self-signed cho IP
- **Device pairing** — Auto-approve qua file I/O (gần instant)

## Bắt đầu nhanh

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/install.sh | \
  bash -s -- --domain <TEN_MIEN> [--mgmt-key <KEY>]
```

| Tuỳ chọn | Mô tả |
|----------|-------|
| `--domain` | Tên miền đã trỏ DNS về VPS (bật Let's Encrypt SSL) |
| `--mgmt-key` | API key cho Management API (tự sinh nếu không truyền) |

### Sau khi cài đặt

```
Dashboard: http://<IP>:9998/pair?token=<GATEWAY_TOKEN>
Management API: http://<IP>:9998
MGMT API Key: <MGMT_KEY>
```

## Kiến trúc

```
Internet
  │
  ├── :80/:443 ──► Caddy (systemd — reverse proxy + SSL)
  │                  │
  │                  ├── /login, /api/auth/* ──► Management API (:9998)
  │                  └── /* ──► OpenClaw Gateway (:18789)
  │
  └── :9998 ────► Management API (systemd — Node.js)
```

Tất cả chạy trực tiếp trên OS, quản lý bằng **systemd**:

| Service | Binary | Port | Mô tả |
|---------|--------|------|-------|
| `openclaw.service` | `openclaw` (npm) | 18789 | AI Gateway + Control UI |
| `caddy.service` | `caddy` (apt) | 80, 443 | Reverse proxy + SSL |
| `openclaw-mgmt.service` | `node server.js` | 9998 | REST API quản lý |

### Cấu trúc thư mục trên VPS

```
/opt/openclaw/                     # Thư mục chính
├── .env                           # Token, API key, domain config
├── .openclaw -> config/           # Symlink (OpenClaw đọc config từ đây)
├── Caddyfile                      # Cấu hình Caddy (dùng env vars)
├── config/
│   ├── openclaw.json              # Cấu hình đang sử dụng
│   ├── devices/
│   │   ├── pending.json           # Devices đang chờ approve
│   │   └── paired.json            # Devices đã pair
│   └── agents/<agentId>/agent/
│       └── auth-profiles.json     # API key + OAuth token
└── data/                          # Dữ liệu lưu trữ

/opt/openclaw-mgmt/server.js       # Management API
/etc/openclaw/config/              # Template configs (chỉ đọc)
```

## Vận hành

### Kiểm tra trạng thái

```bash
systemctl status openclaw caddy openclaw-mgmt

# Qua API
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)
curl -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status
```

### Xem logs

```bash
journalctl -u openclaw -f                    # OpenClaw realtime
journalctl -u caddy -f                       # Caddy realtime
journalctl -u openclaw-mgmt -f               # Management API
journalctl -u openclaw --no-pager -n 100     # 100 dòng gần nhất
```

### Restart / Stop / Start

```bash
systemctl restart openclaw       # Hoặc: curl -X POST ... /api/restart
systemctl stop openclaw          # Hoặc: curl -X POST ... /api/stop
systemctl start openclaw         # Hoặc: curl -X POST ... /api/start
```

### Cập nhật OpenClaw

```bash
npm update -g openclaw@latest && systemctl restart openclaw

# Hoặc qua API
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/upgrade
```

### Cập nhật Management API

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/self-update
```

### Chạy lệnh CLI

```bash
HOME=/opt/openclaw openclaw <command>

# Hoặc qua API
curl -X POST -H "Authorization: Bearer $MGMT_KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' http://localhost:9998/api/cli
```

## Management API

**Địa chỉ**: `http://<IP>:9998`
**Xác thực**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Public (không cần auth)

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/pair?token=xxx` | Bật device auto-approve + redirect tới gateway |
| `GET` | `/login` | Trang đăng nhập |
| `GET` | `/terminal` | Terminal web UI |

### Thông tin & trạng thái

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/info` | Domain, IP, token, status, version |
| `GET` | `/api/status` | Trạng thái OpenClaw + Caddy |
| `GET` | `/api/version` | Version OpenClaw |
| `GET` | `/api/system` | CPU, RAM, disk, versions |
| `GET` | `/api/logs` | Logs (`?lines=100&service=openclaw`) |
| `GET` | `/api/domain` | Domain + SSL info |

### Điều khiển service

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/restart` | Restart OpenClaw |
| `POST` | `/api/stop` | Stop OpenClaw |
| `POST` | `/api/start` | Start OpenClaw |
| `POST` | `/api/rebuild` | Restart OpenClaw + Caddy |
| `POST` | `/api/upgrade` | `npm update -g openclaw` + restart |
| `POST` | `/api/reset` | Khôi phục cài đặt gốc (`{"confirm":"RESET"}`) |
| `POST` | `/api/self-update` | Cập nhật Management API từ GitHub |
| `PUT` | `/api/domain` | Đổi domain (Caddy tự xin SSL) |

### Nhà cung cấp AI & Model

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/providers` | Danh sách 22+ providers + models |
| `GET` | `/api/config` | Config hiện tại (model, provider, key masked) |
| `PUT` | `/api/config/provider` | Đổi provider + model |
| `PUT` | `/api/config/api-key` | Đặt API key |
| `POST` | `/api/config/test-key` | Test API key |

```bash
# Đổi sang DeepSeek
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","model":"deepseek/deepseek-chat"}' \
  http://localhost:9998/api/config/provider

# Set API key
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/api-key
```

22 providers có sẵn: `anthropic`, `openai`, `openai-codex`, `google`, `deepseek`, `groq`, `together`, `mistral`, `xai`, `cerebras`, `sambanova`, `fireworks`, `cohere`, `yi`, `baichuan`, `stepfun`, `siliconflow`, `novita`, `openrouter`, `minimax`, `moonshot`, `zhipu`

### Custom Provider

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/config/custom-provider` | Tạo custom provider (OpenAI-compatible) |
| `GET` | `/api/config/custom-providers` | Danh sách custom providers |
| `PUT` | `/api/config/custom-provider/:p` | Cập nhật (thêm model, đổi endpoint/key) |
| `DELETE` | `/api/config/custom-provider/:p` | Xoá custom provider |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.example.com/v1","model":"myprovider/my-model","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/custom-provider
```

### ChatGPT OAuth (OpenAI Codex)

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/config/chatgpt-oauth/start` | Khởi tạo flow — trả OAuth URL |
| `POST` | `/api/config/chatgpt-oauth/complete` | Hoàn thành bằng redirect URL |
| `POST` | `/api/config/chatgpt-oauth/refresh` | Refresh token thủ công |
| `GET` | `/api/config/chatgpt-oauth/status` | Trạng thái token |

Token tự động refresh mỗi 5 phút khi còn dưới 10 phút.

### Đa Agent

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/agents` | Danh sách agents |
| `POST` | `/api/agents` | Tạo agent (`{"id","name","model"}`) |
| `GET` | `/api/agents/:id` | Chi tiết agent |
| `PUT` | `/api/agents/:id` | Cập nhật agent |
| `DELETE` | `/api/agents/:id` | Xoá agent |
| `PUT` | `/api/agents/:id/default` | Đặt default |
| `GET` | `/api/agents/:id/api-key` | Xem API keys (masked) |
| `PUT` | `/api/agents/:id/api-key` | Đặt API key cho agent |

### Routing Bindings

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/bindings` | Danh sách bindings |
| `POST` | `/api/bindings` | Tạo binding (`{"agentId":"work","match":{"channel":"telegram"}}`) |
| `PUT` | `/api/bindings/:index` | Cập nhật |
| `DELETE` | `/api/bindings/:index` | Xoá |

### Kênh nhắn tin

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/channels` | Danh sách kênh |
| `PUT` | `/api/channels/:name` | Thêm/cập nhật kênh |
| `DELETE` | `/api/channels/:name` | Xoá kênh |

Hỗ trợ: `telegram`, `discord`, `slack`, `zalo`

### Đăng nhập người dùng

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/login` | Trang đăng nhập (public) |
| `POST` | `/api/auth/login` | Đăng nhập → gateway token (public) |
| `POST` | `/api/auth/create-user` | Tạo tài khoản |
| `GET` | `/api/auth/user` | Xem tài khoản |
| `PUT` | `/api/auth/change-password` | Đổi mật khẩu |
| `DELETE` | `/api/auth/user` | Xoá tài khoản |

### Biến môi trường & Devices

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/env` | Liệt kê env vars (masked) |
| `PUT` | `/api/env/:key` | Đặt giá trị |
| `DELETE` | `/api/env/:key` | Xoá |
| `GET` | `/api/devices` | Danh sách devices |
| `POST` | `/api/cli` | Chạy lệnh CLI (`{"command":"..."}`) |

## Xử lý sự cố

### Service không chạy

```bash
journalctl -u openclaw --no-pager -n 50      # Xem lỗi
systemctl restart openclaw                     # Thử restart
HOME=/opt/openclaw openclaw gateway --port 18789 --allow-unconfigured  # Chạy thủ công
```

### SSL không hoạt động

```bash
journalctl -u caddy --no-pager -n 50          # Xem lỗi Caddy
dig +short <DOMAIN>                            # Kiểm tra DNS
grep DOMAIN /opt/openclaw/.env                 # Kiểm tra config
systemctl restart caddy                        # Restart Caddy
```

### Device pairing chậm/không hoạt động

```bash
cat /opt/openclaw/config/devices/pending.json  # Có pending không?
cat /opt/openclaw/config/devices/paired.json   # Đã pair chưa?

# Reset pairing
echo '{}' > /opt/openclaw/config/devices/paired.json
echo '{}' > /opt/openclaw/config/devices/pending.json
systemctl restart openclaw
```

## Bảo mật

- Gateway token + MGMT API key: hex 64 ký tự (`openssl rand -hex 32`)
- UFW: chỉ mở port 80, 443, 9998, SSH
- fail2ban: chống brute-force
- Rate limit: 10 lần thất bại = khoá 15 phút
- API key được masked trong tất cả response GET
- Device pairing: mỗi thiết bị cần được approve

## Giấy phép

Kho lưu trữ riêng tư. Chỉ sử dụng nội bộ.
