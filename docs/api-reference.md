# Tham chiếu API — Management API

## Mục lục

- [Thông tin chung](#thông-tin-chung)
- [Xác thực](#xác-thực)
- [Giới hạn tốc độ](#giới-hạn-tốc-độ)
- [Thông tin dịch vụ](#thông-tin-dịch-vụ)
  - [GET /api/info](#get-apiinfo)
  - [GET /api/status](#get-apistatus)
  - [GET /api/system](#get-apisystem)
- [Domain & SSL](#domain--ssl)
  - [GET /api/domain](#get-apidomain)
  - [PUT /api/domain](#put-apidomain)
- [Phiên bản](#phiên-bản)
  - [GET /api/version](#get-apiversion)
  - [POST /api/upgrade](#post-apiupgrade)
- [Điều khiển dịch vụ](#điều-khiển-dịch-vụ)
  - [POST /api/restart](#post-apirestart)
  - [POST /api/stop](#post-apistop)
  - [POST /api/start](#post-apistart)
  - [POST /api/rebuild](#post-apirebuild)
  - [POST /api/reset](#post-apireset)
- [Logs](#logs)
  - [GET /api/logs](#get-apilogs)
- [Cấu hình](#cấu-hình)
  - [GET /api/config](#get-apiconfig)
  - [PUT /api/config/provider](#put-apiconfigprovider)
  - [PUT /api/config/api-key](#put-apiconfigapi-key)
  - [POST /api/config/test-key](#post-apiconfigtest-key)
- [Kênh nhắn tin](#kênh-nhắn-tin)
  - [GET /api/channels](#get-apichannels)
  - [PUT /api/channels/:channel](#put-apichannelschannel)
  - [DELETE /api/channels/:channel](#delete-apichannelschannel)
- [Biến môi trường](#biến-môi-trường)
  - [GET /api/env](#get-apienv)
  - [PUT /api/env/:key](#put-apienvkey)
  - [DELETE /api/env/:key](#delete-apienvkey)
- [CLI Proxy](#cli-proxy)
  - [POST /api/cli](#post-apicli)
- [Mã lỗi chung](#mã-lỗi-chung)

---

## Thông tin chung

| Thuộc tính | Giá trị |
|---|---|
| **Base URL** | `http://<VPS_IP>:9998` |
| **Port** | 9998 |
| **Protocol** | HTTP |
| **Content-Type** | `application/json` |
| **Body size limit** | 100KB |

---

## Xác thực

Tất cả API đều yêu cầu xác thực bằng **Bearer Token**:

```
Authorization: Bearer <OPENCLAW_MGMT_API_KEY>
```

Management API Key do hệ thống tino.vn sinh ra khi tạo dịch vụ. Bạn có thể xem key trong panel quản lý tại tino.vn.

> **Quan trọng:** Không tự thay đổi `OPENCLAW_MGMT_API_KEY` trong file `.env`. Nếu đổi, panel tino.vn sẽ không kết nối được.

---

## Giới hạn tốc độ

- **10 lần** xác thực thất bại → IP bị chặn **15 phút**
- Response khi bị chặn: `429 Too Many Requests`

---

## Thông tin dịch vụ

### GET /api/info

Thông tin tổng quan dịch vụ.

**Response:**

```json
{
  "ok": true,
  "domain": "openclaw.example.com",
  "ip": "180.93.138.155",
  "dashboardUrl": "https://openclaw.example.com?token=abc...",
  "gatewayToken": "abc123...",
  "mgmtApiKey": "def456...7890",
  "status": "running",
  "version": "latest"
}
```

| Trường | Kiểu | Mô tả |
|---|---|---|
| `domain` | string/null | Domain đang dùng (null nếu dùng IP) |
| `ip` | string | IP của VPS |
| `dashboardUrl` | string | URL truy cập Dashboard (có token) |
| `gatewayToken` | string | Token truy cập Dashboard |
| `mgmtApiKey` | string | Management API Key (hiển thị 8 ký tự đầu + 4 cuối) |
| `status` | string | `running` / `stopped` / `exited` / `not_found` |
| `version` | string | Phiên bản OpenClaw |

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/info
```

---

### GET /api/status

Trạng thái chi tiết các container.

**Response:**

```json
{
  "ok": true,
  "openclaw": {
    "status": "running",
    "startedAt": "2026-02-14T10:00:00Z"
  },
  "caddy": {
    "status": "running"
  },
  "version": "latest",
  "gatewayPort": "18789"
}
```

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status
```

---

### GET /api/system

Thông tin hệ thống (CPU, RAM, ổ đĩa, OS).

**Response:**

```json
{
  "ok": true,
  "hostname": "openclaw1",
  "ip": "180.93.138.155",
  "os": "Ubuntu 24.04 LTS",
  "uptime": 86400,
  "loadAvg": [0.5, 0.3, 0.2],
  "memory": {
    "total": "4096MB",
    "free": "2048MB",
    "used": "2048MB"
  },
  "disk": {
    "total": "80G",
    "used": "15G",
    "available": "65G",
    "usagePercent": "19%"
  },
  "nodeVersion": "v22.0.0",
  "dockerVersion": "Docker version 27.0.0"
}
```

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/system
```

---

## Domain & SSL

### GET /api/domain

Xem domain và trạng thái SSL hiện tại.

**Response:**

```json
{
  "ok": true,
  "domain": "openclaw.example.com",
  "ip": "180.93.138.155",
  "ssl": true,
  "selfSignedSSL": false,
  "caddyfile": "openclaw.example.com {\n    tls {\n        issuer acme {...}\n    }\n    reverse_proxy openclaw:18789\n}"
}
```

| Trường | Mô tả |
|---|---|
| `ssl` | `true` nếu có Let's Encrypt SSL |
| `selfSignedSSL` | `true` nếu dùng cert tự ký (IP) |

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/domain
```

---

### PUT /api/domain

Đổi domain và tự động cấu hình SSL Let's Encrypt.

**Request body:**

```json
{
  "domain": "openclaw.example.com",
  "email": "admin@example.com"
}
```

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `domain` | Có | FQDN viết thường (đã trỏ DNS về VPS) |
| `email` | Không | Email cho Let's Encrypt |

**Response thành công:**

```json
{
  "ok": true,
  "domain": "openclaw.example.com"
}
```

**Response lỗi:**

```json
{
  "ok": false,
  "error": "DNS for openclaw.example.com resolves to 1.2.3.4 — does not match server IP (180.93.138.155)."
}
```

> Nếu Caddy không khởi động được với domain mới, hệ thống tự động rollback về cấu hình IP.

**Ví dụ:**

```bash
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "openclaw.example.com"}' \
  http://$VPS_IP:9998/api/domain
```

---

## Phiên bản

### GET /api/version

Xem phiên bản Docker image đang dùng.

**Response:**

```json
{
  "ok": true,
  "version": "latest",
  "image": "ghcr.io/openclaw/openclaw:latest",
  "digest": "sha256:abc123..."
}
```

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/version
```

---

### POST /api/upgrade

Pull image mới nhất và tạo lại container (chạy ngầm).

**Request body:** Không

**Response:** `202 Accepted`

```json
{
  "ok": true,
  "message": "Upgrade started. Check /api/status for progress."
}
```

> Quá trình upgrade chạy ngầm. Dùng `/api/status` để kiểm tra khi nào container `running` trở lại.

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/upgrade
```

---

## Điều khiển dịch vụ

### POST /api/restart

Restart container OpenClaw.

**Response:**

```json
{
  "ok": true,
  "status": "running"
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/restart
```

---

### POST /api/stop

Dừng container OpenClaw.

**Response:**

```json
{
  "ok": true,
  "message": "OpenClaw stopped."
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/stop
```

---

### POST /api/start

Khởi động container OpenClaw.

**Response:**

```json
{
  "ok": true,
  "status": "running"
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/start
```

---

### POST /api/rebuild

Tạo lại container (docker compose down + up).

**Response:**

```json
{
  "ok": true,
  "status": "running"
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/rebuild
```

---

### POST /api/reset

Xóa toàn bộ dữ liệu và khôi phục cấu hình mặc định.

**Request body:**

```json
{
  "confirm": "RESET"
}
```

> **Bắt buộc** gửi `{"confirm": "RESET"}` để xác nhận. Thao tác này **KHÔNG THỂ HOÀN TÁC**.

**Response:**

```json
{
  "ok": true,
  "status": "running",
  "message": "Reset complete. Config reverted to defaults."
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "RESET"}' \
  http://$VPS_IP:9998/api/reset
```

---

## Logs

### GET /api/logs

Xem logs container.

**Query parameters:**

| Tham số | Mặc định | Mô tả |
|---|---|---|
| `lines` | 100 | Số dòng (1–1000) |
| `service` | `openclaw` | Service: `openclaw` hoặc `caddy` |

**Response:**

```json
{
  "ok": true,
  "service": "openclaw",
  "lines": 100,
  "logs": "2026-02-14 10:00:00 Server started on port 18789\n..."
}
```

**Ví dụ:**

```bash
# Logs OpenClaw, 200 dòng
curl -H "Authorization: Bearer $MGMT_KEY" \
  "http://$VPS_IP:9998/api/logs?lines=200&service=openclaw"

# Logs Caddy
curl -H "Authorization: Bearer $MGMT_KEY" \
  "http://$VPS_IP:9998/api/logs?service=caddy"
```

---

## Cấu hình

### GET /api/config

Xem cấu hình hiện tại (giá trị nhạy cảm đã ẩn).

**Response:**

```json
{
  "ok": true,
  "provider": "anthropic",
  "model": "anthropic/claude-opus-4-5",
  "apiKeys": {
    "anthropic": "sk-ant-xx...xxxx",
    "openai": null,
    "gemini": null
  },
  "config": {
    "agents": { "..." },
    "gateway": { "..." },
    "browser": { "..." },
    "channels": { "..." },
    "plugins": { "..." }
  }
}
```

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/config
```

---

### PUT /api/config/provider

Đổi nhà cung cấp AI và model.

**Request body:**

```json
{
  "provider": "anthropic",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

| Trường | Bắt buộc | Giá trị hợp lệ |
|---|---|---|
| `provider` | Có | `anthropic`, `openai`, `gemini` |
| `model` | Có | ID model đầy đủ (ví dụ: `anthropic/claude-sonnet-4-20250514`) |

**Response:**

```json
{
  "ok": true,
  "provider": "anthropic",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

> Khi đổi provider, hệ thống sẽ load template cấu hình tương ứng nhưng giữ nguyên các cài đặt khác (channels, plugins). OpenClaw sẽ tự động restart.

**Ví dụ:**

```bash
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "openai", "model": "openai/gpt-4o"}' \
  http://$VPS_IP:9998/api/config/provider
```

---

### PUT /api/config/api-key

Cập nhật API key cho nhà cung cấp AI.

**Request body:**

```json
{
  "provider": "anthropic",
  "apiKey": "sk-ant-xxx..."
}
```

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `provider` | Có | `anthropic`, `openai`, `gemini` |
| `apiKey` | Có | API key |

**Response:**

```json
{
  "ok": true,
  "provider": "anthropic",
  "apiKey": "sk-ant-xx...xxxx"
}
```

> Key được lưu vào `auth-profiles.json` (ưu tiên) và `.env` (fallback). OpenClaw tự động restart.

**Ví dụ:**

```bash
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "gemini", "apiKey": "AIzaSy..."}' \
  http://$VPS_IP:9998/api/config/api-key
```

---

### POST /api/config/test-key

Kiểm tra API key có hợp lệ không (không lưu).

**Request body:**

```json
{
  "provider": "anthropic",
  "apiKey": "sk-ant-xxx..."
}
```

**Response thành công:**

```json
{
  "ok": true,
  "error": null
}
```

**Response key không hợp lệ:**

```json
{
  "ok": false,
  "error": "API key invalid or expired"
}
```

**Ví dụ:**

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "openai", "apiKey": "sk-xxx..."}' \
  http://$VPS_IP:9998/api/config/test-key
```

---

## Kênh nhắn tin

### GET /api/channels

Liệt kê tất cả kênh nhắn tin và trạng thái.

**Response:**

```json
{
  "ok": true,
  "channels": {
    "telegram": {
      "configured": true,
      "enabled": true,
      "token": "12345678...wxYZ"
    },
    "discord": {
      "configured": false,
      "enabled": false,
      "token": null
    },
    "slack": {
      "configured": false,
      "enabled": false,
      "token": null
    },
    "zalo": {
      "configured": false,
      "enabled": false,
      "token": null
    }
  }
}
```

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/channels
```

---

### PUT /api/channels/:channel

Thêm hoặc cập nhật kênh nhắn tin.

**Path parameter:** `channel` = `telegram` | `discord` | `slack` | `zalo`

**Request body:**

```json
{
  "token": "bot-token-here",
  "appToken": "xapp-...",
  "dmPolicy": "open",
  "allowFrom": ["*"]
}
```

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `token` | Có | Bot token |
| `appToken` | Không (chỉ Slack) | App-Level Token cho Slack |
| `dmPolicy` | Không | `"open"` = ai cũng nhắn được (mặc định) |
| `allowFrom` | Không | Danh sách user/group: `["*"]` = tất cả (mặc định) |

**Response:**

```json
{
  "ok": true,
  "channel": "telegram",
  "token": "12345678...wxYZ"
}
```

> Discord, Slack, Zalo sẽ tự động bật plugin tương ứng.

**Ví dụ:**

```bash
# Telegram
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "123456789:ABCdef..."}' \
  http://$VPS_IP:9998/api/channels/telegram

# Slack (cần cả appToken)
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "xoxb-...", "appToken": "xapp-..."}' \
  http://$VPS_IP:9998/api/channels/slack
```

---

### DELETE /api/channels/:channel

Xóa kênh nhắn tin.

**Path parameter:** `channel` = `telegram` | `discord` | `slack` | `zalo`

**Response:**

```json
{
  "ok": true,
  "channel": "telegram",
  "removed": true
}
```

**Ví dụ:**

```bash
curl -X DELETE -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/channels/discord
```

---

## Biến môi trường

### GET /api/env

Xem tất cả biến môi trường (giá trị nhạy cảm đã ẩn).

**Response:**

```json
{
  "ok": true,
  "env": {
    "OPENCLAW_VERSION": "latest",
    "OPENCLAW_GATEWAY_PORT": "18789",
    "OPENCLAW_GATEWAY_TOKEN": "abc1...7890",
    "OPENCLAW_MGMT_API_KEY": "def4...1234"
  }
}
```

> Các giá trị chứa `TOKEN`, `KEY`, `SECRET`, `PASSWORD` sẽ được ẩn bớt.

**Ví dụ:**

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/env
```

---

### PUT /api/env/:key

Thêm hoặc sửa biến môi trường.

**Path parameter:** `key` = tên biến (UPPER_SNAKE_CASE)

**Request body:**

```json
{
  "value": "your-value"
}
```

**Response:**

```json
{
  "ok": true,
  "key": "CUSTOM_VAR",
  "applied": true,
  "note": "Restart service for changes to take effect"
}
```

> **Lưu ý:**
> - Tên biến phải viết HOA, dùng gạch dưới: `CUSTOM_VAR`
> - Không thể sửa `OPENCLAW_MGMT_API_KEY` qua endpoint này
> - Cần restart để biến có hiệu lực

**Ví dụ:**

```bash
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "my-value"}' \
  http://$VPS_IP:9998/api/env/MY_CUSTOM_VAR
```

---

### DELETE /api/env/:key

Xóa biến môi trường.

**Path parameter:** `key` = tên biến

**Response:**

```json
{
  "ok": true,
  "key": "MY_CUSTOM_VAR",
  "removed": true
}
```

> **Biến được bảo vệ** (không thể xóa): `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_MGMT_API_KEY`, `OPENCLAW_VERSION`, `OPENCLAW_GATEWAY_PORT`

**Ví dụ:**

```bash
curl -X DELETE -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/env/MY_CUSTOM_VAR
```

---

## CLI Proxy

### POST /api/cli

Chạy lệnh OpenClaw CLI trong container.

**Request body:**

```json
{
  "command": "models scan"
}
```

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `command` | Có | Lệnh CLI (không chứa ký tự đặc biệt: `;`, `&`, `\|`, `` ` ``, `$`, `(`, `)`, `{`, `}`) |

**Response thành công:**

```json
{
  "ok": true,
  "output": "Found 5 models:\n..."
}
```

**Response lỗi:**

```json
{
  "ok": false,
  "output": "Error: command not found"
}
```

**Ví dụ:**

```bash
# Quét model
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "models scan"}' \
  http://$VPS_IP:9998/api/cli

# Xem config
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "config"}' \
  http://$VPS_IP:9998/api/cli

# Xem version
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "version"}' \
  http://$VPS_IP:9998/api/cli
```

---

## Mã lỗi chung

| HTTP Code | Mô tả | Response |
|---|---|---|
| `200` | Thành công | `{"ok": true, ...}` |
| `202` | Đã nhận, đang xử lý (upgrade) | `{"ok": true, "message": "..."}` |
| `400` | Dữ liệu không hợp lệ | `{"ok": false, "error": "..."}` |
| `401` | Thiếu hoặc sai API key | `{"ok": false, "error": "Invalid or missing API key"}` |
| `403` | Không có quyền | `{"ok": false, "error": "Cannot modify..."}` |
| `404` | Endpoint không tồn tại | `{"ok": false, "error": "Not found"}` |
| `429` | Bị chặn do quá nhiều lần thất bại | `{"ok": false, "error": "Too many failed attempts..."}` |
| `500` | Lỗi server | `{"ok": false, "error": "..."}` |
