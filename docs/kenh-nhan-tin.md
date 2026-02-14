# Kết nối kênh nhắn tin

## Mục lục

- [Tổng quan](#tổng-quan)
- [1. Telegram Bot](#1-telegram-bot)
- [2. Discord Bot](#2-discord-bot)
- [3. Zalo OA](#3-zalo-oa)
- [4. Slack Bot](#4-slack-bot)
- [5. Xem trạng thái các kênh](#5-xem-trạng-thái-các-kênh)
- [6. Xóa kênh](#6-xóa-kênh)

---

## Tổng quan

OpenClaw hỗ trợ kết nối với 4 nền tảng nhắn tin:

| Kênh | Biến môi trường | Trạng thái |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` | Tích hợp sẵn |
| Discord | `DISCORD_BOT_TOKEN` | Qua plugin |
| Zalo OA | `ZALO_BOT_TOKEN` | Qua plugin |
| Slack | `SLACK_BOT_TOKEN` | Qua plugin |

Sau khi kết nối, người dùng có thể chat với AI trực tiếp qua các nền tảng này.

---

## 1. Telegram Bot

### Bước 1: Tạo Bot trên Telegram

1. Mở Telegram, tìm **@BotFather**
2. Gửi lệnh `/newbot`
3. Đặt tên cho bot (ví dụ: `My OpenClaw Bot`)
4. Đặt username cho bot (ví dụ: `my_openclaw_bot`)
5. BotFather sẽ trả về **Bot Token** dạng: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`

### Bước 2: Kết nối Bot với OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"}' \
  http://$VPS_IP:9998/api/channels/telegram
```

### Bước 3: Kiểm tra

Mở Telegram, tìm bot vừa tạo và gửi tin nhắn. Bot sẽ trả lời bằng AI.

### Tùy chọn nâng cao

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
    "dmPolicy": "open",
    "allowFrom": ["*"]
  }' \
  http://$VPS_IP:9998/api/channels/telegram
```

| Tham số | Mô tả | Mặc định |
|---|---|---|
| `dmPolicy` | Chính sách nhắn tin riêng: `"open"` (ai cũng nhắn được) | `"open"` |
| `allowFrom` | Danh sách user/group được phép: `["*"]` = tất cả | `["*"]` |

---

## 2. Discord Bot

### Bước 1: Tạo Bot trên Discord Developer Portal

1. Truy cập https://discord.com/developers/applications
2. Bấm **"New Application"** → đặt tên → **"Create"**
3. Vào tab **"Bot"** → bấm **"Add Bot"**
4. Bấm **"Reset Token"** để lấy Bot Token
5. Bật các **Privileged Gateway Intents**:
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT`

### Bước 2: Mời Bot vào Server

1. Vào tab **"OAuth2"** → **"URL Generator"**
2. Chọn scope: `bot`
3. Chọn permissions: `Send Messages`, `Read Message History`, `Read Messages/View Channels`
4. Copy URL và mở trong trình duyệt để mời bot vào server

### Bước 3: Kết nối Bot với OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "your-discord-bot-token"}' \
  http://$VPS_IP:9998/api/channels/discord
```

> Discord plugin sẽ được tự động bật khi kết nối.

---

## 3. Zalo OA

### Bước 1: Tạo Zalo OA

1. Truy cập https://oa.zalo.me
2. Tạo Official Account (hoặc dùng OA có sẵn)
3. Vào phần **"Quản lý"** → **"API"** để lấy token

### Bước 2: Kết nối với OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "your-zalo-oa-token"}' \
  http://$VPS_IP:9998/api/channels/zalo
```

> Zalo plugin sẽ được tự động bật khi kết nối.

---

## 4. Slack Bot

### Bước 1: Tạo Slack App

1. Truy cập https://api.slack.com/apps
2. Bấm **"Create New App"** → **"From scratch"**
3. Đặt tên và chọn workspace

### Bước 2: Cấu hình Bot

1. Vào **"OAuth & Permissions"** → thêm Bot Token Scopes:
   - `chat:write`
   - `channels:read`
   - `channels:history`
   - `im:read`
   - `im:history`
   - `im:write`
2. Bấm **"Install to Workspace"** → copy **Bot User OAuth Token** (`xoxb-...`)
3. Vào **"Socket Mode"** → bật Socket Mode → tạo **App-Level Token** (`xapp-...`)

### Bước 3: Kết nối với OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token"
  }' \
  http://$VPS_IP:9998/api/channels/slack
```

> **Lưu ý:** Slack cần cả `token` (Bot Token) và `appToken` (App-Level Token).

---

## 5. Xem trạng thái các kênh

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/channels
```

Kết quả mẫu:

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

- `configured: true` — Đã có token VÀ đang bật
- `enabled: true` — Đang bật trong cấu hình
- `token` — Hiển thị 8 ký tự đầu + 4 ký tự cuối (ẩn phần giữa)

---

## 6. Xóa kênh

```bash
curl -X DELETE \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/channels/telegram
```

Kết quả:

```json
{
  "ok": true,
  "channel": "telegram",
  "removed": true
}
```

API sẽ tự động:
- Xóa token khỏi `.env` và cấu hình
- Tắt plugin (nếu có)
- Restart OpenClaw
