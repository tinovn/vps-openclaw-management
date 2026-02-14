# Bắt đầu nhanh với OpenClaw

## Mục lục

- [1. Truy cập Dashboard](#1-truy-cập-dashboard)
- [2. Thêm API Key AI](#2-thêm-api-key-ai)
- [3. Gửi tin nhắn đầu tiên](#3-gửi-tin-nhắn-đầu-tiên)
- [4. Đổi model AI](#4-đổi-model-ai)
- [5. Cấu trúc thư mục trên VPS](#5-cấu-trúc-thư-mục-trên-vps)
- [6. Các lệnh quản lý cơ bản](#6-các-lệnh-quản-lý-cơ-bản)

---

## 1. Truy cập Dashboard

Sau khi VPS được cài đặt xong, bạn truy cập Dashboard qua trình duyệt:

```
https://<domain-hoặc-ip>?token=<gateway-token>
```

**Ví dụ:**
- Có domain: `https://openclaw.example.com?token=abc123...`
- Chỉ có IP: `https://180.93.138.155?token=abc123...`

> **Lưu ý:** Nếu dùng IP (không có domain), trình duyệt sẽ cảnh báo chứng chỉ SSL tự ký — bấm **"Advanced"** → **"Proceed"** để tiếp tục.

**Thông tin đăng nhập** được cung cấp trong panel quản lý tại tino.vn:
- **Gateway Token** — dùng để truy cập Dashboard
- **Management API Key** — do hệ thống tino.vn sinh ra và quản lý, dùng để kết nối panel với VPS

> **Quan trọng:** Không tự thay đổi hoặc xóa `OPENCLAW_MGMT_API_KEY` trong file `.env` trên VPS. Nếu thay đổi, panel tino.vn sẽ không kết nối được với VPS.

---

## 2. Thêm API Key AI

OpenClaw cần API key của nhà cung cấp AI để hoạt động. Hỗ trợ 3 nhà cung cấp:

| Nhà cung cấp | Lấy API key tại |
|---|---|
| Anthropic (Claude) | https://console.anthropic.com/settings/keys |
| OpenAI (GPT) | https://platform.openai.com/api-keys |
| Google (Gemini) | https://aistudio.google.com/apikey |

### Thêm API key qua panel tino.vn

Panel tino.vn sẽ gọi Management API để cập nhật key:

```bash
MGMT_KEY="<management-api-key>"
VPS_IP="<ip-vps>"

curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/api-key
```

**Kiểm tra key hợp lệ trước khi lưu:**

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/test-key
```

Kết quả: `{"ok": true}` nếu key hợp lệ.

---

## 3. Gửi tin nhắn đầu tiên

1. Truy cập Dashboard bằng URL ở bước 1
2. Đảm bảo đã thêm API key ở bước 2
3. Gõ tin nhắn vào ô chat và nhấn Enter
4. OpenClaw sẽ trả lời bằng AI model đang được cấu hình

---

## 4. Đổi model AI

Mặc định OpenClaw sử dụng `anthropic/claude-opus-4-5`. Để đổi model:

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "model": "anthropic/claude-sonnet-4-20250514"}' \
  http://$VPS_IP:9998/api/config/provider
```

> Xem thêm danh sách model tại [Cấu hình chi tiết](cau-hinh.md).

---

## 5. Cấu trúc thư mục trên VPS

```
/opt/openclaw/                          # Thư mục chính
├── docker-compose.yml                  # Cấu hình Docker services
├── Caddyfile                           # Cấu hình reverse proxy + SSL
├── .env                                # Biến môi trường (tokens, API keys)
├── config/
│   ├── openclaw.json                   # Cấu hình hiện tại (model, gateway, browser)
│   └── agents/main/agent/
│       └── auth-profiles.json          # API keys (format chuẩn OpenClaw)
└── data/                               # Dữ liệu lưu trữ

/opt/openclaw-mgmt/
└── server.js                           # Management API (port 9998)

/etc/openclaw/config/                   # Template cấu hình (không sửa)
├── anthropic.json
├── openai.json
└── gemini.json
```

---

## 6. Các lệnh quản lý cơ bản

SSH vào VPS và chạy:

```bash
cd /opt/openclaw

# Xem logs
docker compose logs -f openclaw

# Restart
docker compose restart openclaw

# Cập nhật phiên bản mới
docker compose pull && docker compose up -d

# Dừng tất cả
docker compose down
```

> Xem thêm tại [Quản lý VPS & Docker](quan-ly-vps.md).

---

## Bước tiếp theo

- [Cấu hình chi tiết](cau-hinh.md) — Đổi model, cấu hình gateway, browser
- [Kết nối kênh nhắn tin](kenh-nhan-tin.md) — Telegram, Discord, Zalo, Slack
- [Quản lý VPS & Docker](quan-ly-vps.md) — Domain, SSL, Docker commands
- [Tham chiếu API](api-reference.md) — Danh sách đầy đủ API endpoints
