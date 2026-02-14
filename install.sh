#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw - Script cai dat all-in-one (Docker Compose)
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
# Usage: install.sh [--mgmt-key <key>] [--domain <domain>]
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
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== Bat dau cai dat OpenClaw (Docker Compose) ==="

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

# Giai phong lock files + xoa dpkg updates corrupt
rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
rm -f /var/lib/dpkg/updates/* 2>/dev/null || true
dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true

is_apt_locked() {
    # Dung lsof neu co, fallback sang thu apt-get
    if command -v lsof &>/dev/null; then
        lsof /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null | grep -q .
        return $?
    fi
    # Fallback: thu chay apt-get, neu lock thi exit code != 0
    if apt-get check -qq 2>&1 | grep -q "Could not get lock"; then
        return 0  # locked
    fi
    return 1  # not locked
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
# 1b. Doi DNS domain resolve dung IP cua VPS (neu co truyen --domain)
# =============================================================================
if [ -n "${DOMAIN_ARG}" ]; then
    DROPLET_IP=$(hostname -I | awk '{print $1}')
    DNS_MAX_WAIT=300
    DNS_WAITED=0
    log "Doi DNS ${DOMAIN_ARG} resolve ve ${DROPLET_IP}..."

    while [ $DNS_WAITED -lt $DNS_MAX_WAIT ]; do
        # Query DNS qua Cloudflare DoH (curl luon co san)
        RESOLVED=$(curl -sf "https://1.1.1.1/dns-query?name=${DOMAIN_ARG}&type=A" -H "accept: application/dns-json" 2>/dev/null \
            | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')

        if [ "${RESOLVED}" = "${DROPLET_IP}" ]; then
            log "DNS OK: ${DOMAIN_ARG} -> ${DROPLET_IP}"
            break
        fi

        log "DNS chua san sang: ${DOMAIN_ARG} -> ${RESOLVED:-<empty>} (doi ${DROPLET_IP}). Doi 10 giay... (${DNS_WAITED}s/${DNS_MAX_WAIT}s)"
        sleep 10
        DNS_WAITED=$((DNS_WAITED + 10))
    done

    if [ $DNS_WAITED -ge $DNS_MAX_WAIT ]; then
        log "Canh bao: DNS ${DOMAIN_ARG} chua resolve sau ${DNS_MAX_WAIT}s. Tiep tuc cai dat voi IP, se cau hinh domain sau."
        DOMAIN_ARG=""
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
# 3. Cai dat Docker Engine
# =============================================================================
log "Cai dat Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | bash
fi
systemctl enable docker
systemctl start docker

# =============================================================================
# 4. Cai dat Node.js 22 (cho Management API)
# =============================================================================
log "Cai dat Node.js 22..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

# =============================================================================
# 5. Cau hinh tuong lua (UFW)
# =============================================================================
log "Cau hinh tuong lua..."
ufw allow 80
ufw allow 443
ufw allow ${MGMT_API_PORT}/tcp comment 'OpenClaw Management API'
ufw limit ssh/tcp
ufw --force enable

# =============================================================================
# 6. Tao thu muc cai dat
# =============================================================================
log "Tao thu muc cai dat..."
mkdir -p ${INSTALL_DIR}/config
mkdir -p ${INSTALL_DIR}/data
mkdir -p ${MGMT_API_DIR}

# =============================================================================
# 7. Sinh tokens
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
# 8. Tao file .env
# =============================================================================
log "Tao file .env..."
DROPLET_IP=$(hostname -I | awk '{print $1}')

cat > ${INSTALL_DIR}/.env << EOF
# OpenClaw Environment Configuration
# Sau khi thay doi, restart: docker compose restart openclaw

# Version
OPENCLAW_VERSION=${APP_VERSION}

# Gateway
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# Management API
OPENCLAW_MGMT_API_KEY=${MGMT_API_KEY}

# AI Provider API Keys (uncomment va dien)
# ANTHROPIC_API_KEY=your_key_here
# OPENAI_API_KEY=your_key_here
# GEMINI_API_KEY=your_key_here

# Messaging Channels (uncomment va dien)
# TELEGRAM_BOT_TOKEN=your_token_here
# DISCORD_BOT_TOKEN=your_token_here
# SLACK_BOT_TOKEN=your_token_here
# ZALO_BOT_TOKEN=your_token_here
EOF

# =============================================================================
# 9. Download docker-compose.yml
# =============================================================================
log "Download docker-compose.yml..."
curl -fsSL "${REPO_RAW}/docker-compose.yml" -o ${INSTALL_DIR}/docker-compose.yml

# =============================================================================
# 10. Tao Caddyfile
# =============================================================================
if [ -n "${DOMAIN_ARG}" ]; then
    log "Tao Caddyfile voi domain ${DOMAIN_ARG} + Let's Encrypt SSL..."
    cat > ${INSTALL_DIR}/Caddyfile << EOF
${DOMAIN_ARG} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    reverse_proxy openclaw:18789
}
EOF
else
    log "Tao Caddyfile voi IP + self-signed cert..."
    cat > ${INSTALL_DIR}/Caddyfile << EOF
${DROPLET_IP} {
    tls internal
    reverse_proxy openclaw:18789
}
EOF
fi

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
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
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
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
CONFIGEOF

# --- gemini.json ---
cat > /etc/openclaw/config/gemini.json << 'CONFIGEOF'
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
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    }
  },
  "browser": {
    "headless": true,
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
CONFIGEOF

# Copy default config (Anthropic) va inject gateway token
cp /etc/openclaw/config/anthropic.json ${INSTALL_DIR}/config/openclaw.json
# Thay the placeholder token bang token thuc, them plugins mac dinh (zalo)
jq --arg token "${GATEWAY_TOKEN}" '
  .gateway.auth.token = $token |
  .plugins = { "entries": { "zalo": { "enabled": true } } }
' ${INSTALL_DIR}/config/openclaw.json > ${INSTALL_DIR}/config/openclaw.json.tmp
mv ${INSTALL_DIR}/config/openclaw.json.tmp ${INSTALL_DIR}/config/openclaw.json

# Tao thu muc auth-profiles (de Management API co the ghi API keys)
mkdir -p ${INSTALL_DIR}/config/agents/main/agent

# =============================================================================
# 12. Pull images va start containers
# =============================================================================
log "Pull Docker images..."
cd ${INSTALL_DIR}
docker compose pull

log "Start Docker containers..."
docker compose up -d

# Doi container san sang
log "Doi container san sang..."
sleep 5

if docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null | grep -q "running"; then
    log "OpenClaw container dang chay."
else
    log "Canh bao: OpenClaw container chua san sang. Kiem tra: docker compose logs openclaw"
fi

# =============================================================================
# 13. Cai dat Management API
# =============================================================================
log "Cai dat Management API..."
curl -fsSL "${REPO_RAW}/management-api/server.js" -o ${MGMT_API_DIR}/server.js || {
    log "Canh bao: Khong tai duoc Management API server.js"
}

# Tao systemd service
cat > /etc/systemd/system/openclaw-mgmt.service << EOF
[Unit]
Description=OpenClaw Management API
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

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
# 14. Cau hinh fail2ban
# =============================================================================
log "Cau hinh fail2ban..."
systemctl enable fail2ban
systemctl restart fail2ban

# =============================================================================
# 15. Don dep
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
log "  Dashboard: https://${DASHBOARD_HOST}?token=${GATEWAY_TOKEN}"
log "  Gateway Token: ${GATEWAY_TOKEN}"
log ""
log "  Management API: http://${DROPLET_IP}:${MGMT_API_PORT}"
log "  MGMT API Key:   ${MGMT_API_KEY}"
log "=========================================="
log ""
log "Quan ly:"
log "  docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f"
log "  docker compose -f ${INSTALL_DIR}/docker-compose.yml restart"
log "  docker compose -f ${INSTALL_DIR}/docker-compose.yml down"
