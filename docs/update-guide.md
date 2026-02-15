# Hướng dẫn cập nhật OpenClaw

## Mục lục

- [1. Cập nhật qua Management API (khuyên dùng)](#1-cập-nhật-qua-management-api-khuyên-dùng)
- [2. Cập nhật thủ công qua SSH](#2-cập-nhật-thủ-công-qua-ssh)
- [3. Cập nhật Docker image OpenClaw](#3-cập-nhật-docker-image-openclaw)
- [4. Kiểm tra sau khi cập nhật](#4-kiểm-tra-sau-khi-cập-nhật)

---

## 1. Cập nhật qua Management API (khuyên dùng)

Gọi endpoint `/api/self-update` để tự động download phiên bản mới nhất từ GitHub và restart service.

```bash
MGMT_KEY="<your_mgmt_api_key>"
VPS_IP="<your_vps_ip>"

curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/self-update
```

**Response thành công:**

```json
{
  "ok": true,
  "message": "Update complete. Management API restarting...",
  "files": [
    { "file": "/opt/openclaw-mgmt/server.js", "ok": true },
    { "file": "/opt/openclaw/docker-compose.yml", "ok": true },
    { "file": "/etc/openclaw/config/anthropic.json", "ok": true },
    { "file": "/etc/openclaw/config/openai.json", "ok": true },
    { "file": "/etc/openclaw/config/gemini.json", "ok": true },
    { "file": "/etc/openclaw/config/chatgpt.json", "ok": true }
  ]
}
```

**Các file được cập nhật:**

| File | Đường dẫn trên VPS | Mô tả |
|------|-------------------|-------|
| server.js | `/opt/openclaw-mgmt/server.js` | Management API server |
| docker-compose.yml | `/opt/openclaw/docker-compose.yml` | Docker Compose config |
| anthropic.json | `/etc/openclaw/config/anthropic.json` | Template config Anthropic |
| openai.json | `/etc/openclaw/config/openai.json` | Template config OpenAI |
| gemini.json | `/etc/openclaw/config/gemini.json` | Template config Gemini |
| chatgpt.json | `/etc/openclaw/config/chatgpt.json` | Template config ChatGPT |

> **Lưu ý:** Management API tự restart sau khi cập nhật. Kết nối có thể mất 2-3 giây trong lúc restart.

---

## 2. Cập nhật thủ công qua SSH

Nếu Management API không hoạt động hoặc bạn muốn cập nhật thủ công:

```bash
ssh root@<VPS_IP>
```

### Bước 1: Download file mới từ GitHub

```bash
REPO_RAW="https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main"

# Management API
curl -fsSL "$REPO_RAW/management-api/server.js" -o /opt/openclaw-mgmt/server.js

# Docker Compose
curl -fsSL "$REPO_RAW/docker-compose.yml" -o /opt/openclaw/docker-compose.yml

# Config templates
curl -fsSL "$REPO_RAW/config/anthropic.json" -o /etc/openclaw/config/anthropic.json
curl -fsSL "$REPO_RAW/config/openai.json" -o /etc/openclaw/config/openai.json
curl -fsSL "$REPO_RAW/config/gemini.json" -o /etc/openclaw/config/gemini.json
curl -fsSL "$REPO_RAW/config/chatgpt.json" -o /etc/openclaw/config/chatgpt.json
```

### Bước 2: Restart Management API

```bash
systemctl restart openclaw-mgmt
systemctl status openclaw-mgmt
```

### Bước 3: Áp dụng thay đổi Docker Compose (nếu có service mới)

```bash
cd /opt/openclaw
docker compose up -d
```

Lệnh `docker compose up -d` sẽ tự tạo thêm container mới nếu `docker-compose.yml` có thêm service, mà không ảnh hưởng container đang chạy.

---

## 3. Cập nhật Docker image OpenClaw

Để cập nhật Docker image OpenClaw (không phải Management API), dùng endpoint `/api/upgrade`:

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/upgrade
```

Hoặc thủ công qua SSH:

```bash
cd /opt/openclaw
docker compose pull openclaw
docker compose up -d openclaw
```

---

## 4. Kiểm tra sau khi cập nhật

### Kiểm tra Management API

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status
```

### Kiểm tra container

```bash
# Qua API
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status

# Qua SSH
docker ps
```

### Kiểm tra logs nếu có lỗi

```bash
# Management API logs
journalctl -u openclaw-mgmt -f --no-pager -n 50

# OpenClaw container logs
cd /opt/openclaw && docker compose logs -f --tail=50
```
