# Cấu hình chi tiết

## Mục lục

- [1. Đổi model AI](#1-đổi-model-ai)
- [2. Quản lý API Keys](#2-quản-lý-api-keys)
- [3. Cấu hình Gateway](#3-cấu-hình-gateway)
- [4. Cấu hình Browser](#4-cấu-hình-browser)
- [5. File .env — Biến môi trường](#5-file-env--biến-môi-trường)
- [6. Xem cấu hình hiện tại](#6-xem-cấu-hình-hiện-tại)

---

## 1. Đổi model AI

### Các nhà cung cấp được hỗ trợ

| Nhà cung cấp | Provider ID | Model mặc định |
|---|---|---|
| Anthropic (Claude) | `anthropic` | `anthropic/claude-opus-4-5` |
| OpenAI (GPT) | `openai` | `openai/gpt-5.2` |
| Google (Gemini) | `gemini` | `google/gemini-2.5-pro` |

### Danh sách model phổ biến

**Anthropic:**
| Model | ID |
|---|---|
| Claude Opus 4.5 | `anthropic/claude-opus-4-5` |
| Claude Sonnet 4 | `anthropic/claude-sonnet-4-20250514` |
| Claude Haiku 3.5 | `anthropic/claude-haiku-3-5-20241022` |

**OpenAI:**
| Model | ID |
|---|---|
| GPT-5.2 | `openai/gpt-5.2` |
| GPT-4o | `openai/gpt-4o` |
| GPT-4o Mini | `openai/gpt-4o-mini` |

**Google Gemini:**
| Model | ID |
|---|---|
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |

### Đổi model qua API

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "model": "anthropic/claude-sonnet-4-20250514"}' \
  http://$VPS_IP:9998/api/config/provider
```

> **Lưu ý:** Khi đổi provider, cần có API key tương ứng. Ví dụ đổi sang `openai` thì cần có OpenAI API key.

---

## 2. Quản lý API Keys

### Thứ tự ưu tiên đọc API key

1. **auth-profiles.json** (ưu tiên cao nhất)
2. **Biến môi trường** trong `.env` (fallback)

### Cập nhật API key qua API

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/api-key
```

API sẽ tự động lưu key vào cả `auth-profiles.json` và `.env`, sau đó restart OpenClaw.

### Kiểm tra API key hợp lệ

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx..."}' \
  http://$VPS_IP:9998/api/config/test-key
```

Kết quả:
- `{"ok": true}` — Key hợp lệ
- `{"ok": false, "error": "API key invalid or expired"}` — Key không hợp lệ

### Provider mapping

| Provider | Biến môi trường | Profile provider |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic` |
| `openai` | `OPENAI_API_KEY` | `openai` |
| `gemini` | `GEMINI_API_KEY` | `google` |

### Format auth-profiles.json

File: `/opt/openclaw/config/agents/main/agent/auth-profiles.json`

```json
{
  "profiles": {
    "anthropic:manual": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-xxx..."
    },
    "google:manual": {
      "type": "api_key",
      "provider": "google",
      "key": "AIzaSy..."
    }
  }
}
```

> **Quan trọng:**
> - `type` phải là `"api_key"` (gạch dưới, KHÔNG phải `"api-key"`)
> - Trường chứa key là `"key"` (KHÔNG phải `"apiKey"`)
> - Provider của Gemini trong profiles là `"google"` (KHÔNG phải `"gemini"`)

---

## 3. Cấu hình Gateway

File cấu hình: `/opt/openclaw/config/openclaw.json`

```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "<gateway-token>"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    }
  }
}
```

| Tham số | Mô tả | Giá trị mặc định |
|---|---|---|
| `mode` | Chế độ gateway | `"local"` |
| `bind` | Interface binding | `"lan"` |
| `auth.token` | Token xác thực Dashboard | Sinh tự động (64-char hex) |
| `trustedProxies` | Dải IP được tin cậy (Caddy proxy) | Docker + private networks |
| `controlUi.enabled` | Bật/tắt giao diện web | `true` |
| `controlUi.allowInsecureAuth` | Bỏ qua device pairing | `true` |

---

## 4. Cấu hình Browser

```json
{
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
```

| Tham số | Mô tả | Giá trị mặc định |
|---|---|---|
| `headless` | Chế độ headless (không UI) | `true` |
| `defaultProfile` | Tên browser profile | `"openclaw"` |
| `noSandbox` | Tắt sandbox (cần cho Docker) | `true` |

---

## 5. File .env — Biến môi trường

File: `/opt/openclaw/.env`

```bash
# Version
OPENCLAW_VERSION=latest

# Gateway
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=<gateway-token>

# Management API (do tino.vn sinh ra — KHÔNG ĐƯỢC XÓA/SỬA)
OPENCLAW_MGMT_API_KEY=<mgmt-api-key>

# AI Provider API Keys (bỏ comment và điền)
# ANTHROPIC_API_KEY=sk-ant-xxx
# OPENAI_API_KEY=sk-xxx
# GEMINI_API_KEY=AIzaSy...

# Messaging Channels (bỏ comment và điền)
# TELEGRAM_BOT_TOKEN=123456789:ABCdef...
# DISCORD_BOT_TOKEN=xxx
# SLACK_BOT_TOKEN=xoxb-xxx
# ZALO_BOT_TOKEN=xxx
```

### Quản lý env qua API

**Xem tất cả biến** (giá trị nhạy cảm được ẩn):

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/env
```

**Thêm/sửa biến:**

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "your-value"}' \
  http://$VPS_IP:9998/api/env/CUSTOM_VAR
```

**Xóa biến:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/env/CUSTOM_VAR
```

> **Biến được bảo vệ** (không thể xóa): `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_MGMT_API_KEY`, `OPENCLAW_VERSION`, `OPENCLAW_GATEWAY_PORT`

---

## 6. Xem cấu hình hiện tại

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/config
```

Trả về cấu hình đầy đủ bao gồm:
- Provider và model đang dùng
- API keys (đã ẩn bớt)
- Cấu hình channels, gateway, browser, plugins
