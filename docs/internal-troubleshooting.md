# Tài liệu nội bộ — Xử lý lỗi & Troubleshooting

> Tài liệu dành cho đội kỹ thuật tino.vn. Không chia sẻ với khách hàng.

## Mục lục

- [1. Kiến trúc xử lý lỗi](#1-kiến-trúc-xử-lý-lỗi)
- [2. Mã lỗi HTTP và ý nghĩa](#2-mã-lỗi-http-và-ý-nghĩa)
- [3. Timeout cho từng loại thao tác](#3-timeout-cho-từng-loại-thao-tác)
- [4. Xử lý lỗi Authentication](#4-xử-lý-lỗi-authentication)
- [5. Xử lý lỗi Docker](#5-xử-lý-lỗi-docker)
- [6. Xử lý lỗi file I/O](#6-xử-lý-lỗi-file-io)
- [7. Xử lý lỗi DNS & Domain](#7-xử-lý-lỗi-dns--domain)
- [8. Xử lý lỗi API Key Test](#8-xử-lý-lỗi-api-key-test)
- [9. Bảo mật — Shell Injection Prevention](#9-bảo-mật--shell-injection-prevention)
- [10. Biến môi trường được bảo vệ](#10-biến-môi-trường-được-bảo-vệ)
- [11. Các lỗi thường gặp và cách xử lý](#11-các-lỗi-thường-gặp-và-cách-xử-lý)
- [12. Lưu ý về race condition](#12-lưu-ý-về-race-condition)
- [13. Lệnh debug trên VPS](#13-lệnh-debug-trên-vps)

---

## 1. Kiến trúc xử lý lỗi

Management API (`server.js`) sử dụng mô hình xử lý lỗi:

```
Request → Auth check → Rate limit check → Route handler → try/catch → Response
```

- **Mỗi route** đều được bọc trong `try-catch`. Nếu có exception, trả về `500` kèm `e.message`.
- **Shell commands** dùng `execSync()` — tự throw khi exit code khác 0 hoặc timeout.
- **File operations** dùng `readFileSync()` / `writeFileSync()` — throw khi file không tồn tại hoặc lỗi ghi.

Format response lỗi thống nhất:

```json
{"ok": false, "error": "Mô tả lỗi"}
```

---

## 2. Mã lỗi HTTP và ý nghĩa

| HTTP Code | Khi nào xảy ra | Hành động |
|---|---|---|
| `200` | Thành công (sync) | — |
| `202` | Thành công, đang xử lý ngầm (upgrade) | Client poll `/api/status` |
| `400` | Dữ liệu gửi lên không hợp lệ | Kiểm tra request body |
| `401` | Thiếu/sai Bearer token | Kiểm tra `OPENCLAW_MGMT_API_KEY` trong `.env` |
| `403` | Cố sửa/xóa biến được bảo vệ | Biến đó không cho phép thay đổi |
| `429` | IP bị chặn (quá 10 lần auth sai) | Đợi 15 phút hoặc restart mgmt service |
| `500` | Lỗi server (shell timeout, file I/O, Docker fail) | Xem logs: `journalctl -u openclaw-mgmt` |

---

## 3. Timeout cho từng loại thao tác

| Thao tác | Timeout | Ghi chú |
|---|---|---|
| Shell command mặc định | 30s | Hàm `shell()` |
| Docker compose (general) | 60s | restart, stop, start |
| Docker compose down | 60s | Graceful shutdown |
| Docker compose up | 120s | Rebuild/start |
| Docker pull + recreate | 300s (5 phút) | `/api/upgrade` — chạy ngầm |
| Docker exec (CLI proxy) | 60s | `/api/cli` |
| DNS lookup (dig/host) | 10s | Validate domain |
| API key test (curl) | 15s | Test provider endpoints |
| Caddy restart (domain change) | 30s | Sau khi ghi Caddyfile |
| Caddy rollback restart | 15s | Khi Caddy fail với domain mới |

---

## 4. Xử lý lỗi Authentication

### Cơ chế

- Bearer token so sánh bằng `crypto.timingSafeEqual()` — chống timing attack.
- API key đọc từ `.env` mỗi request (không cache).
- Rate limiting theo IP: **10 lần sai → chặn 15 phút**.

### Các failure modes

| Lỗi | Nguyên nhân | Response |
|---|---|---|
| Missing `Authorization` header | Client không gửi header | 401 |
| Sai format (không có `Bearer `) | Header không match regex `/^Bearer\s+(.+)$/` | 401 |
| Token sai giá trị | Key không khớp `.env` | 401 + tăng fail count |
| Token sai độ dài | `Buffer.from()` length mismatch | 401 |
| `.env` không có `OPENCLAW_MGMT_API_KEY` | Key trả về empty string | 401 (luôn fail) |
| IP bị chặn | Quá 10 lần sai | 429 |

### Lưu ý

- Rate limit lưu **in-memory** — restart service sẽ reset.
- Cleanup chỉ xảy ra khi IP bị chặn truy cập lại sau khi hết 15 phút.
- **Không có persistent storage** cho rate limiting → memory leak nhẹ nếu nhiều IP khác nhau tấn công.

### Khắc phục IP bị chặn

```bash
# Cách nhanh nhất: restart management API
systemctl restart openclaw-mgmt
```

---

## 5. Xử lý lỗi Docker

### Container not found

- `docker inspect` throw exception → catch trả về `status: "not_found"`.
- Không phải lỗi 500, trả về bình thường trong response body.

### Restart fail

- `docker compose restart openclaw` throw → catch ở route level → 500.
- Nguyên nhân thường: image bị corrupt, disk full, OOM.

### Caddy rollback khi domain fail

Luồng xử lý khi đổi domain:

```
1. Ghi Caddyfile mới (domain + Let's Encrypt)
2. Restart Caddy (30s timeout)
3. Sleep 3s
4. Check Caddy status
   ├── running → 200 OK
   └── not running → ROLLBACK:
       ├── Ghi Caddyfile IP + tls internal
       ├── Restart Caddy (15s timeout)
       └── Trả về 500 "Caddy failed to start..."
```

**Hạn chế:** Nếu rollback restart cũng fail → lỗi bị nuốt (silent catch). Caddy ở trạng thái stopped, cần xử lý thủ công.

### Rebuild fail

```
docker compose down (60s) → docker compose up -d (120s)
```

- Nếu `down` timeout → `up` KHÔNG được gọi → container ở trạng thái không xác định.
- Nếu `up` fail → container ở trạng thái stopped.

### Kiểm tra sau restart/rebuild

API sleep 2-3 giây rồi check status. Nếu container chưa ready sau sleep → status có thể chưa chính xác. Không có retry loop.

---

## 6. Xử lý lỗi file I/O

### Các file quan trọng

| File | Hậu quả nếu corrupt/mất |
|---|---|
| `/opt/openclaw/.env` | Auth fail (không đọc được MGMT key), mất tokens |
| `/opt/openclaw/config/openclaw.json` | 500 trên tất cả config endpoint |
| `auth-profiles.json` | AI keys mất, nhưng fallback sang env vars |
| `/opt/openclaw/Caddyfile` | Caddy không start, mất SSL |
| `/etc/openclaw/config/*.json` | Không đổi được provider |

### Auth-profiles.json — Graceful fallback

```javascript
// Nếu file không tồn tại hoặc JSON lỗi → trả về { profiles: {} }
// KHÔNG throw 500
```

### openclaw.json — KHÔNG có graceful fallback

```javascript
// JSON.parse() throw → 500 error
// Cần sửa thủ công hoặc copy từ template
```

### Ghi file KHÔNG atomic

- `writeFileSync()` ghi đè trực tiếp, không tạo backup.
- Nếu process crash giữa chừng → file có thể bị trống hoặc corrupt.
- **Không có file locking** — concurrent write có thể corrupt.

### Khôi phục config corrupt

```bash
# Copy template config mặc định
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json

# Inject gateway token
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN /opt/openclaw/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' \
  /opt/openclaw/config/openclaw.json > /tmp/oc.json && \
  mv /tmp/oc.json /opt/openclaw/config/openclaw.json

# Restart
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

---

## 7. Xử lý lỗi DNS & Domain

### Luồng validate DNS

```
1. Nhận domain từ request
2. Lowercase + regex validate format
3. dig +short A domain (10s timeout)
   ├── Có kết quả → filter IP format
   └── Không có → fallback:
       host domain (10s timeout)
       ├── Có "has address X.X.X.X" → parse IP
       └── Không có → lỗi
4. So sánh resolved IPs với server IP
   ├── Match → OK
   └── Mismatch → 400 error
```

### Các lỗi DNS

| Lỗi | Message | Nguyên nhân |
|---|---|---|
| Không resolve được | `"Cannot resolve DNS for {domain}. Point A record to {ip}."` | DNS chưa trỏ hoặc chưa propagate |
| IP không khớp | `"DNS for {domain} resolves to {ips} — does not match server IP ({ip})."` | DNS trỏ sai IP |
| Format domain sai | `"Invalid domain format"` | Có ký tự đặc biệt, uppercase, trailing dot... |

### Hạn chế

- **Chỉ hỗ trợ IPv4** (A record). Không check AAAA (IPv6).
- Cả `dig` và `host` đều có 10s timeout. Nếu DNS server chậm → lỗi false negative.
- DNS propagation có thể mất đến 48h. Client gọi API sớm quá sẽ bị reject.

---

## 8. Xử lý lỗi API Key Test

### Cách test từng provider

| Provider | Method | URL | Tiêu chí |
|---|---|---|---|
| Anthropic | POST `/v1/messages` | `api.anthropic.com` | HTTP 200 |
| OpenAI | GET `/v1/models` | `api.openai.com` | HTTP 200 |
| Gemini | GET `/v1beta/models` | `generativelanguage.googleapis.com` | HTTP 200 |

### Failure modes

| Tình huống | HTTP code từ provider | Kết quả test |
|---|---|---|
| Key hợp lệ | 200 | `ok: true` |
| Key sai/hết hạn | 401 | `ok: false` |
| Hết quota | 429 | `ok: false` |
| Provider down | 503 | `ok: false` |
| Timeout (>15s) | — | Exception → `ok: false` |

### Lưu ý

- Test endpoint KHÔNG lưu key. Chỉ kiểm tra rồi trả kết quả.
- API key được escape single quotes trước khi đưa vào curl command: `'` → `'\''`.
- Nếu provider API trả về code khác 200 (kể cả 201, 204) → vẫn coi là fail.

---

## 9. Bảo mật — Shell Injection Prevention

### CLI Proxy (`/api/cli`)

**Ký tự bị chặn:** `;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `{`, `}`

```javascript
if (/[;&|`$(){}]/.test(command)) {
  return 400 "Command contains disallowed characters"
}
```

Lệnh được thực thi:
```bash
docker compose exec -T openclaw node dist/index.js <command>
```

### Lỗ hổng đã biết

- **Redirect `>`, `<`** KHÔNG bị chặn. Ví dụ: `models scan > /tmp/file` vẫn chạy được.
- Tuy nhiên lệnh chạy trong container (không phải host), nên rủi ro hạn chế.

### Các điểm khác

| Điểm | Bảo mật |
|---|---|
| Domain trong dig/host | Regex validate trước khi đưa vào shell |
| API key trong curl test | Escape single quote |
| Docker commands | Hardcoded, không chứa user input |
| Env var key | Regex `/^[A-Z][A-Z0-9_]*$/` |

---

## 10. Biến môi trường được bảo vệ

### Không cho sửa qua `PUT /api/env/:key`

| Biến | Lý do |
|---|---|
| `OPENCLAW_MGMT_API_KEY` | Do HostBill/tino.vn sinh. Nếu sửa → panel mất kết nối VPS |

→ Trả về `403 Forbidden`.

### Không cho xóa qua `DELETE /api/env/:key`

| Biến | Lý do |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | Mất → không truy cập Dashboard |
| `OPENCLAW_MGMT_API_KEY` | Mất → panel mất kết nối |
| `OPENCLAW_VERSION` | Cần cho Docker image tag |
| `OPENCLAW_GATEWAY_PORT` | Cần cho gateway binding |

→ Trả về `403 Forbidden`.

---

## 11. Các lỗi thường gặp và cách xử lý

### 11.1 — 429: IP bị chặn sau nhiều lần auth sai

**Triệu chứng:** Tất cả API call trả về 429.

**Nguyên nhân:** Client gửi sai key >= 10 lần.

**Xử lý:**
```bash
# Đợi 15 phút, hoặc:
systemctl restart openclaw-mgmt
```

### 11.2 — 401: Auth luôn fail dù key đúng

**Triệu chứng:** Key đúng nhưng luôn 401.

**Nguyên nhân:** `OPENCLAW_MGMT_API_KEY` trong `.env` bị trống hoặc sai.

**Xử lý:**
```bash
# Kiểm tra key
grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env

# Nếu trống, lấy key từ HostBill và set lại
# (Liên hệ HostBill admin để lấy key gốc)
```

### 11.3 — 500: Config JSON corrupt

**Triệu chứng:** Mọi thao tác config trả về 500.

**Kiểm tra:**
```bash
cat /opt/openclaw/config/openclaw.json | jq .
# Nếu jq báo lỗi parse → file corrupt
```

**Xử lý:**
```bash
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN /opt/openclaw/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' \
  /opt/openclaw/config/openclaw.json > /tmp/oc.json && \
  mv /tmp/oc.json /opt/openclaw/config/openclaw.json
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

### 11.4 — Caddy không start sau đổi domain

**Triệu chứng:** API trả 500 "Caddy failed to start". Dashboard không truy cập được.

**Kiểm tra:**
```bash
docker compose -f /opt/openclaw/docker-compose.yml logs caddy
cat /opt/openclaw/Caddyfile
```

**Nguyên nhân thường gặp:**
- DNS chưa propagate → Let's Encrypt challenge fail
- Rate limit Let's Encrypt (5 cert/domain/tuần)
- Port 80/443 bị chặn bởi firewall khác

**Xử lý:** API đã tự rollback về IP config. Nếu vẫn lỗi:
```bash
# Reset Caddyfile thủ công
IP=$(hostname -I | awk '{print $1}')
cat > /opt/openclaw/Caddyfile << EOF
${IP} {
    tls internal
    reverse_proxy openclaw:18789
}
EOF
docker compose -f /opt/openclaw/docker-compose.yml restart caddy
```

### 11.5 — Upgrade không hoàn thành

**Triệu chứng:** Gọi `/api/upgrade` trả 202 nhưng container không cập nhật.

**Kiểm tra:**
```bash
journalctl -u openclaw-mgmt --since "10 minutes ago" | grep -i upgrade
docker compose -f /opt/openclaw/docker-compose.yml ps
```

**Xử lý thủ công:**
```bash
cd /opt/openclaw
docker compose pull openclaw
docker compose up -d openclaw
```

### 11.6 — Container restart liên tục (crash loop)

**Triệu chứng:** Status luôn `exited` hoặc `restarting`.

**Kiểm tra:**
```bash
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=50 openclaw
```

**Nguyên nhân thường gặp:**
- Config JSON sai format
- API key không hợp lệ (model provider reject)
- Disk full
- OOM (hết RAM)

**Xử lý:**
```bash
# Kiểm tra disk
df -h /

# Kiểm tra RAM
free -m

# Reset config nếu cần
cp /etc/openclaw/config/anthropic.json /opt/openclaw/config/openclaw.json
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw
```

### 11.7 — Management API không phản hồi

**Triệu chứng:** Không kết nối được port 9998.

**Kiểm tra:**
```bash
systemctl status openclaw-mgmt
journalctl -u openclaw-mgmt -f
ufw status | grep 9998
ss -tlnp | grep 9998
```

**Xử lý:**
```bash
systemctl restart openclaw-mgmt

# Nếu vẫn lỗi, kiểm tra Node.js
node --version
cat /opt/openclaw-mgmt/server.js | head -5
```

### 11.8 — auth-profiles.json mất/corrupt

**Triệu chứng:** AI key mất, bot không trả lời.

**Lưu ý:** auth-profiles.json corrupt KHÔNG gây 500 — hệ thống fallback sang env vars.

**Kiểm tra:**
```bash
cat /opt/openclaw/config/agents/main/agent/auth-profiles.json | jq .
```

**Xử lý:** Cập nhật key lại qua API:
```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)
curl -X PUT -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "apiKey": "sk-ant-new-key"}' \
  http://localhost:9998/api/config/api-key
```

---

## 12. Lưu ý về race condition

Management API **KHÔNG có file locking**. Các thao tác đọc-sửa-ghi (read-modify-write) không atomic:

| File | Thao tác ảnh hưởng |
|---|---|
| `.env` | `PUT /api/env`, `PUT /api/config/api-key`, `PUT /api/channels/:ch` |
| `openclaw.json` | `PUT /api/config/provider`, `PUT /api/channels/:ch`, `DELETE /api/channels/:ch` |
| `auth-profiles.json` | `PUT /api/config/api-key`, `PUT /api/config/provider` |

**Rủi ro:** Nếu 2 request đồng thời sửa cùng file → request sau ghi đè request trước.

**Giảm thiểu:** Panel HostBill nên serialize các API call (không gọi song song).

---

## 13. Lệnh debug trên VPS

### Kiểm tra nhanh toàn bộ hệ thống

```bash
# Trạng thái tất cả services
docker compose -f /opt/openclaw/docker-compose.yml ps
systemctl status openclaw-mgmt

# Logs OpenClaw
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=30 openclaw

# Logs Caddy
docker compose -f /opt/openclaw/docker-compose.yml logs --tail=30 caddy

# Logs Management API
journalctl -u openclaw-mgmt --since "30 minutes ago" --no-pager

# Config hiện tại
cat /opt/openclaw/config/openclaw.json | jq .

# API keys
cat /opt/openclaw/config/agents/main/agent/auth-profiles.json 2>/dev/null | jq .

# Env vars
grep -v '^#' /opt/openclaw/.env | grep -v '^$'

# Firewall
ufw status

# Disk + RAM
df -h / && free -m

# Caddyfile
cat /opt/openclaw/Caddyfile
```

### Test Management API từ VPS

```bash
MGMT_KEY=$(grep OPENCLAW_MGMT_API_KEY /opt/openclaw/.env | cut -d= -f2)

# Health check
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/status | jq .

# Xem config
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/config | jq .

# Xem system info
curl -s -H "Authorization: Bearer $MGMT_KEY" http://localhost:9998/api/system | jq .
```

### Khôi phục toàn bộ (worst case)

```bash
cd /opt/openclaw

# Stop everything
docker compose down

# Reset config
cp /etc/openclaw/config/anthropic.json config/openclaw.json
TOKEN=$(grep OPENCLAW_GATEWAY_TOKEN .env | cut -d= -f2)
jq --arg t "$TOKEN" '.gateway.auth.token = $t' config/openclaw.json > /tmp/oc.json
mv /tmp/oc.json config/openclaw.json

# Restart
docker compose up -d
systemctl restart openclaw-mgmt

# Verify
docker compose ps
curl -s -H "Authorization: Bearer $(grep OPENCLAW_MGMT_API_KEY .env | cut -d= -f2)" \
  http://localhost:9998/api/status | jq .
```
