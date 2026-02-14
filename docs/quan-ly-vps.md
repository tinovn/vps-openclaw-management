# Quản lý VPS & Docker

## Mục lục

- [1. Lệnh Docker thường dùng](#1-lệnh-docker-thường-dùng)
- [2. Cấu hình Domain + SSL](#2-cấu-hình-domain--ssl)
- [3. Nâng cấp phiên bản](#3-nâng-cấp-phiên-bản)
- [4. Xem thông tin hệ thống](#4-xem-thông-tin-hệ-thống)
- [5. Reset về mặc định](#5-reset-về-mặc-định)
- [6. Troubleshooting](#6-troubleshooting)

---

## 1. Lệnh Docker thường dùng

SSH vào VPS và chạy các lệnh sau:

```bash
cd /opt/openclaw
```

### Xem logs

```bash
# Xem logs OpenClaw (follow mode)
docker compose logs -f openclaw

# Xem logs Caddy (reverse proxy)
docker compose logs -f caddy

# Xem 200 dòng cuối
docker compose logs --tail=200 openclaw
```

Hoặc qua API:

```bash
curl -H "Authorization: Bearer $MGMT_KEY" \
  "http://$VPS_IP:9998/api/logs?lines=200&service=openclaw"
```

### Restart

```bash
docker compose restart openclaw
```

Hoặc qua API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/restart
```

### Stop / Start

```bash
# Dừng
docker compose stop openclaw

# Khởi động lại
docker compose start openclaw
```

Hoặc qua API:

```bash
# Dừng
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/stop

# Khởi động
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/start
```

### Rebuild (tạo lại container)

```bash
docker compose down && docker compose up -d
```

Hoặc qua API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/rebuild
```

### Xem trạng thái

```bash
docker compose ps
```

Hoặc qua API:

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/status
```

### Chạy lệnh CLI trong container

```bash
docker compose exec openclaw node dist/index.js models scan
docker compose exec openclaw node dist/index.js config get
```

Hoặc qua API:

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "models scan"}' \
  http://$VPS_IP:9998/api/cli
```

---

## 2. Cấu hình Domain + SSL

### Xem domain hiện tại

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/domain
```

### Đổi domain (tự động cấu hình SSL Let's Encrypt)

**Yêu cầu:** Domain đã trỏ DNS (A record) về IP của VPS.

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "openclaw.example.com"}' \
  http://$VPS_IP:9998/api/domain
```

Tùy chọn thêm email cho Let's Encrypt:

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "openclaw.example.com", "email": "admin@example.com"}' \
  http://$VPS_IP:9998/api/domain
```

> **Lưu ý:**
> - Domain phải viết thường, không có `https://`
> - DNS phải đã resolve đúng IP của VPS, nếu không API sẽ báo lỗi
> - Nếu Caddy không khởi động được với domain mới, hệ thống tự động rollback về cấu hình IP

### Cấu hình thủ công trên VPS

Sửa file `/opt/openclaw/Caddyfile`:

**Với domain:**
```
openclaw.example.com {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    reverse_proxy openclaw:18789
}
```

**Với IP (self-signed):**
```
180.93.138.155 {
    tls internal
    reverse_proxy openclaw:18789
}
```

Sau khi sửa, restart Caddy:

```bash
docker compose restart caddy
```

---

## 3. Nâng cấp phiên bản

### Qua SSH

```bash
cd /opt/openclaw
docker compose pull && docker compose up -d
```

### Qua API

```bash
curl -X POST -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/upgrade
```

> API trả về ngay `202 Accepted`, quá trình pull image chạy ngầm. Kiểm tra trạng thái bằng `/api/status`.

### Xem version hiện tại

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/version
```

---

## 4. Xem thông tin hệ thống

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/system
```

Kết quả mẫu:

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

---

## 5. Reset về mặc định

> **CẢNH BÁO:** Thao tác này sẽ **XÓA TẤT CẢ dữ liệu** và cấu hình, trả về trạng thái ban đầu.

```bash
curl -X POST \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "RESET"}' \
  http://$VPS_IP:9998/api/reset
```

Hệ thống sẽ:
1. Dừng tất cả container
2. Xóa dữ liệu và volumes
3. Khôi phục cấu hình mặc định (Anthropic)
4. Khởi động lại

> Phải gửi `{"confirm": "RESET"}` để xác nhận. Nếu không sẽ báo lỗi.

---

## 6. Troubleshooting

### OpenClaw không khởi động

```bash
# Kiểm tra trạng thái
docker compose ps

# Xem logs lỗi
docker compose logs --tail=50 openclaw

# Thử restart
docker compose restart openclaw

# Nếu vẫn lỗi, rebuild
docker compose down && docker compose up -d
```

### Không truy cập được Dashboard

1. **Kiểm tra container đang chạy:**
   ```bash
   docker compose ps
   ```

2. **Kiểm tra firewall:**
   ```bash
   ufw status
   # Port 80 và 443 phải được allow
   ```

3. **Kiểm tra Caddy:**
   ```bash
   docker compose logs caddy
   ```

4. **Kiểm tra DNS** (nếu dùng domain):
   ```bash
   dig openclaw.example.com
   # Phải trả về IP của VPS
   ```

### API key không hoạt động

1. **Kiểm tra key hợp lệ:**
   ```bash
   curl -X POST -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx"}' \
     http://$VPS_IP:9998/api/config/test-key
   ```

2. **Kiểm tra auth-profiles.json:**
   ```bash
   cat /opt/openclaw/config/agents/main/agent/auth-profiles.json
   ```

3. **Cập nhật lại key:**
   ```bash
   curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"provider": "anthropic", "apiKey": "sk-ant-xxx-new"}' \
     http://$VPS_IP:9998/api/config/api-key
   ```

### SSL không hoạt động

1. **Kiểm tra DNS đã trỏ đúng:**
   ```bash
   dig +short your-domain.com
   # Phải trả về IP của VPS
   ```

2. **Kiểm tra Caddy logs:**
   ```bash
   docker compose logs caddy | grep -i "tls\|acme\|certificate"
   ```

3. **Thử đổi domain lại:**
   ```bash
   curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
     -H "Content-Type: application/json" \
     -d '{"domain": "your-domain.com"}' \
     http://$VPS_IP:9998/api/domain
   ```

### Management API không phản hồi

```bash
# Kiểm tra service
systemctl status openclaw-mgmt

# Restart service
systemctl restart openclaw-mgmt

# Xem logs
journalctl -u openclaw-mgmt -f
```

### Biến môi trường quan trọng — Không được xóa

Các biến sau trong `/opt/openclaw/.env` **KHÔNG ĐƯỢC XÓA**, nếu mất sẽ không truy cập được hệ thống:

| Biến | Mô tả |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | Token truy cập Dashboard |
| `OPENCLAW_MGMT_API_KEY` | Key quản lý API (do tino.vn cấp, không tự đổi được) |
| `OPENCLAW_VERSION` | Phiên bản OpenClaw |
| `OPENCLAW_GATEWAY_PORT` | Port gateway nội bộ |
