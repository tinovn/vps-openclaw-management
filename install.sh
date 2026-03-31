#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw - Script cai dat all-in-one (Bare-metal, no Docker)
#
# Usage:
#   curl -fsSL <url>/install.sh | bash -s -- --mgmt-key <KEY> --domain <DOMAIN>
#   bash install.sh --mgmt-key <KEY> --domain <DOMAIN>
#
# --mgmt-key  MGMT API key tu HostBill (neu khong truyen se tu sinh)
# --domain    Ten mien da tro DNS ve VPS (neu co se cau hinh SSL Let's Encrypt)
# =============================================================================

APP_VERSION="latest"
REPO_RAW="https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main"
INSTALL_DIR="/opt/openclaw"
MGMT_API_DIR="/opt/openclaw-mgmt"
MGMT_API_PORT=9998
LOG_FILE="/var/log/openclaw-install.log"

# --- Parse arguments ---
MGMT_API_KEY_ARG=""
DOMAIN_ARG=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --mgmt-key) MGMT_API_KEY_ARG="$2"; shift 2 ;;
        --domain) DOMAIN_ARG="$2"; shift 2 ;;
        *) shift ;;
    esac
done

# --- Logging ---
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== Bat dau cai dat OpenClaw (Bare-metal) ==="

# =============================================================================
# 1. Tat unattended-upgrades + doi apt lock
# =============================================================================
log "Tat unattended-upgrades va apt-daily..."
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl disable unattended-upgrades 2>/dev/null || true
systemctl stop apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl kill --kill-who=all apt-daily.service apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true
killall -9 unattended-upgr apt apt-get dpkg 2>/dev/null || true
sleep 3

rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
rm -f /var/lib/dpkg/updates/* 2>/dev/null || true
dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true

is_apt_locked() {
    if command -v lsof &>/dev/null; then
        lsof /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null | grep -q .
        return $?
    fi
    if apt-get check -qq 2>&1 | grep -q "Could not get lock"; then
        return 0
    fi
    return 1
}

wait_for_apt() {
    local max_wait=120
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if is_apt_locked; then
            log "apt/dpkg van dang chay. Doi 5 giay... (${waited}s/${max_wait}s)"
            sleep 5
            waited=$((waited + 5))
        else
            return 0
        fi
    done
    log "Canh bao: apt lock van con sau ${max_wait}s, thu giai phong..."
    killall -9 apt apt-get dpkg unattended-upgr 2>/dev/null || true
    rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
    dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true
    sleep 2
}

log "Doi apt lock..."
wait_for_apt

# =============================================================================
# 1b. Kiem tra DNS domain
# =============================================================================
DNS_READY=false
if [ -n "${DOMAIN_ARG}" ]; then
    DROPLET_IP=$(hostname -I | awk '{print $1}')
    DNS_MAX_WAIT=30
    DNS_WAITED=0
    log "Kiem tra DNS ${DOMAIN_ARG} (doi toi da ${DNS_MAX_WAIT}s)..."

    while [ $DNS_WAITED -lt $DNS_MAX_WAIT ]; do
        RESOLVED=$(curl -sf "https://1.1.1.1/dns-query?name=${DOMAIN_ARG}&type=A" -H "accept: application/dns-json" 2>/dev/null \
            | grep -oE '"data":[ ]*"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+') || true

        if [ "${RESOLVED}" = "${DROPLET_IP}" ]; then
            DNS_READY=true
            log "DNS OK: ${DOMAIN_ARG} -> ${DROPLET_IP}. Se dung Let's Encrypt SSL."
            break
        fi

        log "DNS chua san sang: ${DOMAIN_ARG} -> ${RESOLVED:-<empty>} (can ${DROPLET_IP}). Doi 5 giay... (${DNS_WAITED}s/${DNS_MAX_WAIT}s)"
        sleep 5
        DNS_WAITED=$((DNS_WAITED + 5))
    done

    if [ "${DNS_READY}" = "false" ]; then
        log "DNS ${DOMAIN_ARG} chua resolve sau ${DNS_MAX_WAIT}s. Dung self-signed cert truoc."
    fi
fi

# =============================================================================
# 2. Cap nhat he thong + cai dat packages
# =============================================================================
log "Cap nhat he thong..."
export DEBIAN_FRONTEND=noninteractive

apt_retry() {
    local retries=3
    local i=0
    while [ $i -lt $retries ]; do
        wait_for_apt
        if "$@"; then
            return 0
        fi
        i=$((i + 1))
        log "apt command failed, retry ${i}/${retries}..."
        killall -9 apt apt-get dpkg 2>/dev/null || true
        rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
        rm -f /var/lib/dpkg/updates/* 2>/dev/null || true
        dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true
        sleep 5
    done
    log "LOI: apt command that bai sau ${retries} lan thu."
    return 1
}

apt_retry dpkg --force-confdef --force-confold --configure -a
apt_retry apt-get -qqy update
apt_retry apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade
apt_retry apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install \
    curl ca-certificates gnupg ufw fail2ban jq dnsutils

# =============================================================================
# 3. Cai dat Node.js 24 (cho OpenClaw + Management API)
# =============================================================================
log "Cai dat Node.js 24..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v24* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
fi
log "Node.js version: $(node -v)"

# =============================================================================
# 4. Cai dat OpenClaw (npm global)
# =============================================================================
log "Cai dat OpenClaw..."
npm install -g openclaw@latest
log "OpenClaw version: $(openclaw --version 2>/dev/null || echo 'unknown')"

# =============================================================================
# 5. Cai dat Google Chrome (headless browser cho OpenClaw)
# =============================================================================
log "Cai dat Google Chrome..."
if ! command -v google-chrome &>/dev/null; then
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
    apt-get install -y /tmp/chrome.deb
    rm -f /tmp/chrome.deb
fi
log "Chrome version: $(google-chrome --version 2>/dev/null || echo 'not installed')"

# =============================================================================
# 6. Cai dat Caddy (apt)
# =============================================================================
log "Cai dat Caddy..."
if ! command -v caddy &>/dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi
log "Caddy version: $(caddy version 2>/dev/null || echo 'unknown')"

# =============================================================================
# 6. Cau hinh tuong lua (UFW)
# =============================================================================
log "Cau hinh tuong lua..."
ufw allow 80
ufw allow 443
ufw allow ${MGMT_API_PORT}/tcp comment 'OpenClaw Management API'
ufw limit ssh/tcp
ufw --force enable

# =============================================================================
# 7. Tao thu muc cai dat
# =============================================================================
log "Tao thu muc cai dat..."
mkdir -p ${INSTALL_DIR}/config
mkdir -p ${INSTALL_DIR}/data
mkdir -p ${INSTALL_DIR}/.openclaw
mkdir -p ${MGMT_API_DIR}

# Symlink config -> .openclaw (OpenClaw reads from HOME/.openclaw)
if [ ! -L "${INSTALL_DIR}/.openclaw" ] || [ "$(readlink -f ${INSTALL_DIR}/.openclaw)" != "${INSTALL_DIR}/config" ]; then
    rm -rf ${INSTALL_DIR}/.openclaw
    ln -sf ${INSTALL_DIR}/config ${INSTALL_DIR}/.openclaw
fi

# =============================================================================
# 8. Sinh tokens
# =============================================================================
log "Sinh gateway token va management API key..."
GATEWAY_TOKEN=$(openssl rand -hex 32)
if [ -n "${MGMT_API_KEY_ARG}" ]; then
    MGMT_API_KEY="${MGMT_API_KEY_ARG}"
    log "Su dung MGMT API key tu HostBill."
else
    MGMT_API_KEY=$(openssl rand -hex 32)
    log "Tu sinh MGMT API key."
fi

# =============================================================================
# 9. Tao file .env
# =============================================================================
log "Tao file .env..."
DROPLET_IP=$(hostname -I | awk '{print $1}')

if [ -n "${DOMAIN_ARG}" ] && [ "${DNS_READY}" = "true" ]; then
    CADDY_DOMAIN="${DOMAIN_ARG}"
    CADDY_TLS_VALUE=""
elif [ -n "${DOMAIN_ARG}" ]; then
    CADDY_DOMAIN="${DOMAIN_ARG}"
    CADDY_TLS_VALUE="tls internal"
else
    CADDY_DOMAIN="http://${DROPLET_IP}"
    CADDY_TLS_VALUE=""
fi

cat > ${INSTALL_DIR}/.env << EOF
# OpenClaw Environment Configuration
# Sau khi thay doi, restart: systemctl restart openclaw

# Version
OPENCLAW_VERSION=${APP_VERSION}

# Gateway
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# Domain & TLS (Caddy)
DOMAIN=${CADDY_DOMAIN}
CADDY_TLS=${CADDY_TLS_VALUE}

# Management API
OPENCLAW_MGMT_API_KEY=${MGMT_API_KEY}

# Node.js Memory (80% of system RAM)
NODE_OPTIONS=--max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 80 / 100 ))

# AI Provider API Keys (uncomment va dien)
# ANTHROPIC_API_KEY=your_key_here
# OPENAI_API_KEY=your_key_here
# GEMINI_API_KEY=your_key_here
# DEEPSEEK_API_KEY=your_key_here
# GROQ_API_KEY=your_key_here
# TOGETHER_API_KEY=your_key_here
# MISTRAL_API_KEY=your_key_here
# XAI_API_KEY=your_key_here
# CEREBRAS_API_KEY=your_key_here
# SAMBANOVA_API_KEY=your_key_here
# FIREWORKS_API_KEY=your_key_here
# COHERE_API_KEY=your_key_here
# YI_API_KEY=your_key_here
# BAICHUAN_API_KEY=your_key_here
# STEPFUN_API_KEY=your_key_here
# SILICONFLOW_API_KEY=your_key_here
# NOVITA_API_KEY=your_key_here
# OPENROUTER_API_KEY=your_key_here
# MINIMAX_API_KEY=your_key_here
# MOONSHOT_API_KEY=your_key_here
# ZHIPU_API_KEY=your_key_here

# Messaging Channels (uncomment va dien)
# TELEGRAM_BOT_TOKEN=your_token_here
# DISCORD_BOT_TOKEN=your_token_here
# SLACK_BOT_TOKEN=your_token_here
# ZALO_BOT_TOKEN=your_token_here
EOF

# =============================================================================
# 10. Download Caddyfile template
# =============================================================================
log "Tao Caddyfile..."
cat > ${INSTALL_DIR}/Caddyfile << 'CADDYEOF'
{$DOMAIN:localhost} {
    {$CADDY_TLS:tls internal}

    # Login page + auth API -> Management API on host
    handle /login {
        reverse_proxy 127.0.0.1:9998
    }
    handle /api/auth/* {
        reverse_proxy 127.0.0.1:9998
    }

    reverse_proxy 127.0.0.1:18789 {
        header_up Host "localhost:18789"
        header_up -X-Forwarded-For
        header_up -X-Forwarded-Host
        header_up -X-Forwarded-Proto
        header_up -X-Real-IP
    }
}
CADDYEOF

# =============================================================================
# 11. Tao config templates + default config
# =============================================================================
log "Tao config templates..."
mkdir -p /etc/openclaw/config

# --- anthropic.json ---
cat > /etc/openclaw/config/anthropic.json << 'CONFIGEOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": false
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
CONFIGEOF

# --- openai.json ---
cat > /etc/openclaw/config/openai.json << 'CONFIGEOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": false
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
CONFIGEOF

# --- google.json ---
cat > /etc/openclaw/config/google.json << 'CONFIGEOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "google/gemini-2.5-pro"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": false
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
CONFIGEOF

# --- Download config templates cho cac provider khac tu GitHub ---
for provider in deepseek groq together mistral xai cerebras sambanova fireworks cohere yi baichuan stepfun siliconflow novita openrouter minimax moonshot zhipu; do
    curl -fsSL "${REPO_RAW}/config/${provider}.json" -o /etc/openclaw/config/${provider}.json 2>/dev/null || \
        log "Canh bao: Khong tai duoc config template ${provider}.json"
done

# Copy default config (Anthropic) va inject gateway token
cp /etc/openclaw/config/anthropic.json ${INSTALL_DIR}/config/openclaw.json
if [ -n "${DOMAIN_ARG}" ]; then
    ORIGINS_FILTER='.gateway.controlUi.allowedOrigins = ["https://\($domain)", "http://\($domain)", "http://localhost", "http://127.0.0.1"]'
else
    ORIGINS_FILTER='.gateway.controlUi.allowedOrigins = ["http://localhost", "http://127.0.0.1"]'
fi
jq --arg token "${GATEWAY_TOKEN}" --arg domain "${DOMAIN_ARG}" '
  .gateway.auth.token = $token |
  .gateway.controlUi.allowedOrigins = (
    if $domain != "" then ["https://\($domain)", "http://\($domain)", "http://localhost", "http://127.0.0.1"]
    else ["http://localhost", "http://127.0.0.1"]
    end
  ) |
  .plugins = { "entries": { "zalo": { "enabled": true } } }
' ${INSTALL_DIR}/config/openclaw.json > ${INSTALL_DIR}/config/openclaw.json.tmp
mv ${INSTALL_DIR}/config/openclaw.json.tmp ${INSTALL_DIR}/config/openclaw.json

# Tao thu muc auth-profiles
mkdir -p ${INSTALL_DIR}/config/agents/main/agent
mkdir -p ${INSTALL_DIR}/config/agents/main/sessions

# =============================================================================
# 12. Tao systemd services
# =============================================================================
log "Tao systemd service cho OpenClaw..."
cat > /etc/systemd/system/openclaw.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=HOME=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=OPENCLAW_GATEWAY_BIND=lan
ExecStart=$(which openclaw) gateway --port 18789 --allow-unconfigured
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Caddy systemd override (dung Caddyfile va .env cua OpenClaw)
log "Cau hinh Caddy systemd override..."
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf << EOF
[Service]
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=
ExecStart=$(which caddy) run --environ --config ${INSTALL_DIR}/Caddyfile --adapter caddyfile
EOF

systemctl daemon-reload

# Start OpenClaw
log "Start OpenClaw..."
systemctl enable openclaw
systemctl start openclaw

# Start Caddy
log "Start Caddy..."
systemctl enable caddy
systemctl restart caddy

# Doi OpenClaw san sang
log "Doi OpenClaw san sang..."
for i in $(seq 1 24); do
    if curl -sf http://localhost:18789/healthz >/dev/null 2>&1; then
        log "OpenClaw san sang sau ${i}x5s."
        break
    fi
    sleep 5
done

# =============================================================================
# 13. Cai dat Management API
# =============================================================================
log "Cai dat Management API..."
for i in 1 2 3; do
    curl -fsSL --retry 2 "${REPO_RAW}/management-api/server.js" -o ${MGMT_API_DIR}/server.js && break
    log "Canh bao: Lan $i - Khong tai duoc server.js, thu lai..."
    sleep 3
done
if [ ! -f ${MGMT_API_DIR}/server.js ]; then
    log "LOI: Khong tai duoc Management API server.js sau 3 lan"
fi

cat > /etc/systemd/system/openclaw-mgmt.service << EOF
[Unit]
Description=OpenClaw Management API
After=network-online.target openclaw.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${MGMT_API_DIR}
ExecStart=/usr/bin/node ${MGMT_API_DIR}/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable openclaw-mgmt
systemctl start openclaw-mgmt

# =============================================================================
# 15. Cau hinh fail2ban
# =============================================================================
log "Cau hinh fail2ban..."
systemctl enable fail2ban
systemctl restart fail2ban

# =============================================================================
# 16. Don dep
# =============================================================================
log "Don dep..."
apt-get -qqy autoremove
apt-get -qqy autoclean

# =============================================================================
# Hoan tat
# =============================================================================
log "=== Cai dat OpenClaw hoan tat! ==="
log ""
log "=========================================="
DASHBOARD_HOST="${DOMAIN_ARG:-${DROPLET_IP}}"
if [ -n "${DOMAIN_ARG}" ]; then
    DASHBOARD_SCHEME="https"
else
    DASHBOARD_SCHEME="http"
fi
log "  Dashboard: http://${DROPLET_IP}:${MGMT_API_PORT}/pair?token=${GATEWAY_TOKEN}"
log "  Gateway Token: ${GATEWAY_TOKEN}"
log ""
log "  Management API: http://${DROPLET_IP}:${MGMT_API_PORT}"
log "  MGMT API Key:   ${MGMT_API_KEY}"
log "=========================================="
log ""
log "Quan ly:"
log "  systemctl status openclaw        # Trang thai"
log "  journalctl -u openclaw -f        # Xem logs"
log "  systemctl restart openclaw       # Restart"
log "  systemctl stop openclaw          # Stop"
