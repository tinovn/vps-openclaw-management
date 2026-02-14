# OpenClaw - Quản lý VPS

Triển khai và quản lý [OpenClaw](https://github.com/openclaw/openclaw) trên bất kỳ VPS nào chỉ với một lệnh duy nhất. Bao gồm Docker Compose, tự động SSL qua Caddy, và REST Management API để điều khiển từ xa.

## Tính năng

- **Cài đặt một lệnh** — Tự động thiết lập Docker, OpenClaw, Caddy reverse proxy, tường lửa và fail2ban
- **Management API** — REST API (cổng 9998) để quản lý từ xa qua HostBill hoặc bất kỳ HTTP client nào
- **Đa nhà cung cấp AI** — Chuyển đổi giữa Anthropic, OpenAI và Google Gemini nhanh chóng
- **Kênh nhắn tin** — Tích hợp Telegram, Discord, Slack, Zalo OA
- **Tự động SSL** — Let's Encrypt qua Caddy, hoặc self-signed cho truy cập bằng IP
- **Bảo mật** — Tường lửa UFW, fail2ban, xác thực API key với giới hạn tốc độ

## Bắt đầu nhanh

### Cài đặt trên VPS

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/install.sh | bash
```

Với tuỳ chọn:

```bash
curl -fsSL https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/install.sh | \
  bash -s -- --mgmt-key <MGMT_KEY_CUA_BAN> --domain <TEN_MIEN_CUA_BAN>
```

| Tuỳ chọn | Mô tả |
|----------|-------|
| `--mgmt-key` | API key cho Management API (tự sinh nếu không truyền) |
| `--domain` | Tên miền đã trỏ DNS về VPS (bật Let's Encrypt SSL) |

### Sau khi cài đặt

Script cài đặt sẽ hiển thị thông tin đăng nhập:

```
Dashboard: https://<host>?token=<gateway_token>
Management API: http://<ip>:9998
MGMT API Key: <mgmt_key>
```

## Kiến trúc

```
Internet
  │
  ├── :80/:443 ──► Caddy (reverse proxy + TLS)
  │                  │
  │                  └──► OpenClaw (:18789)
  │                         ├── Gateway (WebSocket)
  │                         ├── Control UI (Bảng điều khiển)
  │                         └── Kênh nhắn tin (Telegram, Zalo, ...)
  │
  └── :9998 ────► Management API (Node.js trên host)
```

### Cấu trúc thư mục trên VPS

```
/opt/openclaw/                      # Thư mục chính
├── docker-compose.yml
├── .env                            # Token, API key
├── Caddyfile                       # Cấu hình Caddy
├── config/
│   ├── openclaw.json               # Cấu hình đang sử dụng
│   └── agents/main/agent/
│       └── auth-profiles.json      # Thông tin API key
└── data/                           # Dữ liệu lưu trữ

/opt/openclaw-mgmt/
└── server.js                       # Management API

/etc/openclaw/config/               # Template cấu hình (chỉ đọc)
├── anthropic.json
├── openai.json
└── gemini.json
```

## Management API

**Địa chỉ**: `http://<ip>:9998`
**Xác thực**: `Authorization: Bearer <OPENCLAW_MGMT_API_KEY>`

### Thông tin dịch vụ

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/info` | URL Dashboard, token, trạng thái |
| `GET` | `/api/status` | Trạng thái container (openclaw + caddy) |
| `GET` | `/api/system` | Thông tin CPU, bộ nhớ, ổ đĩa, hệ điều hành |
| `GET` | `/api/version` | Phiên bản image và digest |
| `GET` | `/api/logs?lines=100&service=openclaw` | Log của container |

### Quản lý Container

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/restart` | Khởi động lại container OpenClaw |
| `POST` | `/api/stop` | Dừng container OpenClaw |
| `POST` | `/api/start` | Chạy container OpenClaw |
| `POST` | `/api/rebuild` | Tạo lại hoàn toàn (down + up) |
| `POST` | `/api/upgrade` | Tải image mới nhất + tạo lại |
| `POST` | `/api/reset` | Khôi phục cài đặt gốc (yêu cầu `{"confirm":"RESET"}`) |

### Nhà cung cấp AI và Model

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/config` | Cấu hình hiện tại (model, provider, key đã ẩn) |
| `PUT` | `/api/config/provider` | Chuyển đổi nhà cung cấp và model |
| `PUT` | `/api/config/api-key` | Đặt API key cho nhà cung cấp |
| `POST` | `/api/config/test-key` | Kiểm tra API key có hợp lệ không |

**Chuyển đổi nhà cung cấp:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","model":"google/gemini-2.5-flash"}' \
  http://localhost:9998/api/config/provider
```

Các nhà cung cấp và model hỗ trợ:

| Nhà cung cấp | Model mẫu |
|---------------|-----------|
| `anthropic` | `anthropic/claude-opus-4-5`, `anthropic/claude-sonnet-4-20250514` |
| `openai` | `openai/gpt-5.2`, `openai/gpt-4.1-mini` |
| `gemini` | `google/gemini-2.5-pro`, `google/gemini-2.5-flash` |

**Đặt API key:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","apiKey":"AIzaSy..."}' \
  http://localhost:9998/api/config/api-key
```

API key được lưu ở cả `.env` (dự phòng) và `auth-profiles.json` (chính, được OpenClaw sử dụng).

### Tên miền và SSL

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/domain` | Xem cấu hình tên miền hiện tại |
| `PUT` | `/api/domain` | Đổi tên miền + tự động SSL |

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"domain":"chat.example.com","email":"admin@example.com"}' \
  http://localhost:9998/api/domain
```

DNS phải trỏ về IP của VPS trước khi gọi endpoint này. Caddy tự động lấy chứng chỉ Let's Encrypt. Tự động rollback nếu thất bại.

### Kênh nhắn tin

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/channels` | Liệt kê tất cả kênh và trạng thái |
| `PUT` | `/api/channels/:name` | Thêm/cập nhật kênh |
| `DELETE` | `/api/channels/:name` | Xoá kênh |

Các kênh hỗ trợ: `telegram`, `discord`, `slack`, `zalo`

**Thêm bot Telegram:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"token":"123456:ABC-xyz"}' \
  http://localhost:9998/api/channels/telegram
```

**Thêm Zalo OA:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"token":"your_zalo_oa_token"}' \
  http://localhost:9998/api/channels/zalo
```

API ghi cấu hình kênh trực tiếp vào `openclaw.json` với `enabled: true`, `dmPolicy: "open"`, và `allowFrom: ["*"]`. Plugin cho Zalo/Discord/Slack được tự động bật.

### Biến môi trường

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/env` | Liệt kê biến môi trường (giá trị nhạy cảm được ẩn) |
| `PUT` | `/api/env/:KEY` | Đặt giá trị biến môi trường |
| `DELETE` | `/api/env/:KEY` | Xoá biến môi trường |

### CLI Proxy

Thực thi lệnh CLI của OpenClaw bên trong container:

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"command":"models scan"}' \
  http://localhost:9998/api/cli
```

## Cấu hình

### Thứ tự ưu tiên API Key

OpenClaw tìm API key theo thứ tự sau:

1. `auth-profiles.json` — Chính (được Management API ghi vào)
2. Biến môi trường — Dự phòng (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`)

### Bảo toàn cấu hình khi chuyển provider

Khi chuyển nhà cung cấp qua `PUT /api/config/provider`, API bảo toàn tất cả các phần cấu hình hiện có:

- Kênh nhắn tin (Telegram, Zalo, v.v.)
- Plugin
- Cài đặt Gateway (trustedProxies, controlUi)
- Meta, messages, commands, wizard

Chỉ model được cập nhật.

### Gateway phía sau Caddy

Hệ thống sử dụng Caddy làm reverse proxy. OpenClaw được cấu hình với:

- `gateway.controlUi.allowInsecureAuth: true` — Bỏ qua ghép nối thiết bị khi truy cập qua proxy
- `gateway.trustedProxies` — Dải mạng Docker (`172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`)

## Lệnh Docker (trên VPS)

```bash
cd /opt/openclaw

# Xem log
docker compose logs -f

# Khởi động lại OpenClaw
docker compose restart openclaw

# Nâng cấp lên phiên bản mới nhất
docker compose pull && docker compose up -d

# Dừng tất cả
docker compose down

# Chạy lệnh CLI
docker compose exec openclaw node dist/index.js <command>
```

## Cấu trúc dự án

```
OpenClaw/
├── install.sh                  # Script cài đặt all-in-one
├── docker-compose.yml          # Container OpenClaw + Caddy
├── Caddyfile                   # Template cấu hình Caddy reverse proxy
├── management-api/
│   └── server.js               # Management API (cổng 9998)
├── config/
│   ├── anthropic.json          # Template cấu hình Anthropic
│   ├── openai.json             # Template cấu hình OpenAI
│   └── gemini.json             # Template cấu hình Gemini
├── postman_collection.json     # Bộ sưu tập Postman API
├── CLAUDE.md                   # Hướng dẫn cho AI assistant
└── README.md
```

## Lưu ý bảo mật

- Management API sử dụng xác thực Bearer token với giới hạn tốc độ (10 lần thất bại = khoá 15 phút)
- API key được ẩn trong tất cả các phản hồi GET
- Gateway token là chuỗi hex 64 ký tự, sinh bằng `openssl rand -hex 32`
- Tường lửa UFW chỉ mở cổng 80, 443, 9998, và SSH
- fail2ban bảo vệ chống tấn công brute-force
- Không commit API key hoặc token thật vào git

## Giấy phép

Kho lưu trữ riêng tư. Chỉ sử dụng nội bộ.
