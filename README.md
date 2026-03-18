# OpenClaw - Quản lý VPS

Triển khai và quản lý [OpenClaw](https://github.com/openclaw/openclaw) trên bất kỳ VPS nào chỉ với một lệnh duy nhất. Bao gồm Docker Compose, tự động SSL qua Caddy, và REST Management API để điều khiển từ xa.

## Tính năng

- **Cài đặt một lệnh** — Tự động thiết lập Docker, OpenClaw, Caddy reverse proxy, tường lửa và fail2ban
- **Management API** — REST API (cổng 9998) để quản lý từ xa qua HostBill hoặc bất kỳ HTTP client nào
- **Đa nhà cung cấp AI** — 22 nhà cung cấp có sẵn + hỗ trợ thêm custom provider (OpenAI-compatible)
- **ChatGPT OAuth** — Tích hợp OpenAI Codex (gpt-5.4) qua OAuth2 PKCE, tự động refresh token
- **Đa agent** — Quản lý nhiều agent với model và API key độc lập, routing tin nhắn theo kênh
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
│       └── auth-profiles.json      # API key + OAuth token
└── data/                           # Dữ liệu lưu trữ

/opt/openclaw-mgmt/
└── server.js                       # Management API

/etc/openclaw/config/               # Template cấu hình (chỉ đọc)
├── anthropic.json
├── openai.json
├── openai-codex.json
└── google.json  (và 18 provider khác)
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
| `POST` | `/api/self-update` | Cập nhật Management API + templates từ GitHub |

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
| `GET` | `/api/providers` | Danh sách tất cả providers (built-in + custom) kèm models |
| `GET` | `/api/config` | Cấu hình hiện tại (model, provider, key đã ẩn) |
| `PUT` | `/api/config/provider` | Chuyển đổi nhà cung cấp (built-in + custom) |
| `PUT` | `/api/config/api-key` | Đặt API key cho nhà cung cấp |
| `POST` | `/api/config/test-key` | Kiểm tra API key có hợp lệ không |
| `POST` | `/api/providers/:provider/models` | Thêm model vào provider |
| `DELETE` | `/api/providers/:provider/models/:modelId` | Xoá model khỏi provider |

**Chuyển đổi nhà cung cấp built-in:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","model":"google/gemini-2.5-flash"}' \
  http://localhost:9998/api/config/provider
```

22 nhà cung cấp có sẵn: `anthropic`, `openai`, `openai-codex`, `google`, `deepseek`, `groq`, `together`, `mistral`, `xai`, `cerebras`, `sambanova`, `fireworks`, `cohere`, `yi`, `baichuan`, `stepfun`, `siliconflow`, `novita`, `openrouter`, `minimax`, `moonshot`, `zhipu`

**Đặt API key:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"gemini","apiKey":"AIzaSy..."}' \
  http://localhost:9998/api/config/api-key
```

API key được lưu ở cả `.env` (dự phòng) và `auth-profiles.json` (chính, được OpenClaw sử dụng).

**Thêm model mới vào provider:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"claude-opus-4-6","name":"Claude Opus 4.6"}' \
  http://localhost:9998/api/providers/anthropic/models
```

**Xoá model:**

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/providers/anthropic/models/claude-opus-4-6
```

Hoạt động cho cả built-in và custom provider. Model do user thêm được lưu trong config, không mất khi restart.

### ChatGPT OAuth (OpenAI Codex)

Xác thực với ChatGPT qua OAuth2 PKCE. Không cần API key — dùng tài khoản ChatGPT trực tiếp. Hỗ trợ các model `openai-codex/gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, v.v.

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/config/chatgpt-oauth/start` | Khởi tạo flow — trả về OAuth URL + danh sách model |
| `POST` | `/api/config/chatgpt-oauth/complete` | Hoàn thành xác thực bằng redirect URL |
| `POST` | `/api/config/chatgpt-oauth/refresh` | Refresh token thủ công |
| `GET` | `/api/config/chatgpt-oauth/status` | Trạng thái token hiện tại |

**Bước 1 — Khởi tạo:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/config/chatgpt-oauth/start
```

```json
{
  "ok": true,
  "sessionId": "fdd8babd...",
  "oauthUrl": "https://auth.openai.com/oauth/authorize?...",
  "models": [
    { "id": "openai-codex/gpt-5.4", "name": "GPT-5.4", "default": true },
    { "id": "openai-codex/gpt-5.4-mini", "name": "GPT-5.4-Mini" },
    { "id": "openai-codex/gpt-5.3-codex", "name": "GPT-5.3-Codex" },
    { "id": "openai-codex/gpt-5.2-codex", "name": "GPT-5.2-Codex" },
    { "id": "openai-codex/gpt-5.2", "name": "GPT-5.2" },
    { "id": "openai-codex/gpt-5.1-codex-max", "name": "GPT-5.1-Codex-Max" },
    { "id": "openai-codex/gpt-5.1-codex-mini", "name": "GPT-5.1-Codex-Mini" }
  ],
  "defaultModel": "openai-codex/gpt-5.4",
  "sessionExpiresIn": 600
}
```

**Bước 2 — User mở `oauthUrl` trong trình duyệt, đăng nhập ChatGPT.**
Sau khi đăng nhập, trình duyệt redirect về `localhost:1455/auth/callback?code=...`. Copy toàn bộ URL đó.

**Bước 3 — Hoàn thành:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "sessionId": "fdd8babd...",
    "redirectUrl": "http://localhost:1455/auth/callback?code=ac_xxx&state=...",
    "model": "openai-codex/gpt-5.4"
  }' \
  http://localhost:9998/api/config/chatgpt-oauth/complete
```

```json
{
  "ok": true,
  "tokensStored": true,
  "profileKey": "openai-codex:default",
  "switchedProvider": true,
  "model": "openai-codex/gpt-5.4"
}
```

OpenClaw tự động restart và sẵn sàng sử dụng.

> Token được tự động refresh trước khi hết hạn (kiểm tra mỗi 5 phút, refresh khi còn dưới 10 phút).

**Xem trạng thái OAuth:**

```bash
curl -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/config/chatgpt-oauth/status
```

```json
{
  "ok": true,
  "hasOAuthToken": true,
  "profileKey": "openai-codex:default",
  "hasRefreshToken": true,
  "expiresIn": 863826,
  "expired": false
}
```

### Custom Provider

Thêm nhà cung cấp AI bất kỳ (OpenAI-compatible) ngoài danh sách có sẵn.

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `POST` | `/api/config/custom-provider` | Tạo custom provider mới |
| `GET` | `/api/config/custom-providers` | Danh sách custom providers |
| `PUT` | `/api/config/custom-provider/:provider` | Cập nhật (thêm model, đổi endpoint/key) |
| `DELETE` | `/api/config/custom-provider/:provider` | Xoá custom provider |

**Tạo custom provider:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.example.com/v1","model":"myprovider/my-model","modelName":"My Model","apiKey":"sk-xxx"}' \
  http://localhost:9998/api/config/custom-provider
```

| Trường | Bắt buộc | Mô tả |
|--------|----------|-------|
| `baseUrl` | Có | Endpoint API (OpenAI-compatible) |
| `model` | Có | Định dạng `provider/model-id` |
| `apiKey` | Có | API key |
| `modelName` | Không | Tên hiển thị (mặc định = model-id) |
| `api` | Không | Loại API (mặc định `openai-completions`) |

**Thêm model vào provider đã tạo:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"another-model","modelName":"Another Model"}' \
  http://localhost:9998/api/config/custom-provider/myprovider
```

**Xoá custom provider:**

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:9998/api/config/custom-provider/myprovider
```

Khi xoá, nếu model đang dùng thuộc provider bị xoá, hệ thống tự chuyển về `anthropic/claude-sonnet-4-20250514`.

### Đa Agent

Quản lý nhiều agent với cấu hình (model, API key) độc lập nhau.

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/agents` | Danh sách tất cả agents |
| `POST` | `/api/agents` | Tạo agent mới |
| `GET` | `/api/agents/:id` | Chi tiết agent |
| `PUT` | `/api/agents/:id` | Cập nhật agent (tên, model, workspace) |
| `DELETE` | `/api/agents/:id` | Xoá agent |
| `PUT` | `/api/agents/:id/default` | Đặt làm agent mặc định |
| `GET` | `/api/agents/:id/api-key` | Xem API key của agent (đã ẩn) |
| `PUT` | `/api/agents/:id/api-key` | Đặt API key cho agent |

**Tạo agent mới:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"work","name":"Work Agent","model":"anthropic/claude-sonnet-4-20250514"}' \
  http://localhost:9998/api/agents
```

**Đặt API key cho agent:**

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","apiKey":"sk-ant-xxx"}' \
  http://localhost:9998/api/agents/work/api-key
```

### Routing Bindings

Định tuyến tin nhắn từ kênh nhắn tin tới agent cụ thể.

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/api/bindings` | Danh sách tất cả routing bindings |
| `POST` | `/api/bindings` | Tạo binding mới |
| `PUT` | `/api/bindings/:index` | Cập nhật binding |
| `DELETE` | `/api/bindings/:index` | Xoá binding |

**Ví dụ — Route Telegram tới agent "work":**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"agentId":"work","match":{"channel":"telegram"}}' \
  http://localhost:9998/api/bindings
```

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

### Đăng nhập người dùng

| Phương thức | Endpoint | Mô tả |
|-------------|----------|-------|
| `GET` | `/login` | Trang đăng nhập (công khai) |
| `POST` | `/api/auth/login` | Đăng nhập (công khai) — trả về gateway token |
| `POST` | `/api/auth/create-user` | Tạo tài khoản đăng nhập (yêu cầu Bearer auth) |
| `GET` | `/api/auth/user` | Xem tài khoản hiện tại (yêu cầu Bearer auth) |
| `PUT` | `/api/auth/change-password` | Đổi mật khẩu (yêu cầu Bearer auth) |
| `DELETE` | `/api/auth/user` | Xoá tài khoản đăng nhập (yêu cầu Bearer auth) |

**Tạo tài khoản (chỉ admin):**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}' \
  http://localhost:9998/api/auth/create-user
```

Sau khi tạo, người dùng truy cập `https://domain/login` để đăng nhập. Hệ thống xác thực credentials rồi redirect vào OpenClaw với gateway token.

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
│   ├── anthropic.json          # Template Anthropic
│   ├── openai.json             # Template OpenAI (API key)
│   ├── openai-codex.json       # Template OpenAI Codex (OAuth)
│   ├── google.json             # Template Google Gemini
│   └── ...                     # 18 providers còn lại
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
