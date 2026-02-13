#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw - Script cai dat all-in-one (Docker Compose)
# HostBill hook: curl -fsSL <url>/install.sh | bash
# =============================================================================

APP_VERSION="latest"
REPO_RAW="https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main"
INSTALL_DIR="/opt/openclaw"
MGMT_API_DIR="/opt/openclaw-mgmt"
MGMT_API_PORT=9998
LOG_FILE="/var/log/openclaw-install.log"

# --- Logging ---
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== Bat dau cai dat OpenClaw (Docker Compose) ==="

# =============================================================================
# 1. Doi apt lock
# =============================================================================
log "Doi apt lock..."
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    log "apt dang chay. Doi 5 giay..."
    sleep 5
done
while pgrep -x apt >/dev/null 2>&1; do
    log "apt process dang chay. Doi 5 giay..."
    sleep 5
done

# =============================================================================
# 2. Cap nhat he thong + cai dat packages
# =============================================================================
log "Cap nhat he thong..."
export DEBIAN_FRONTEND=noninteractive
apt-get -qqy update
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install \
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
MGMT_API_KEY=$(openssl rand -hex 32)

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
# GOOGLE_API_KEY=your_key_here

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
# 10. Tao Caddyfile (default: IP + self-signed)
# =============================================================================
log "Tao Caddyfile..."
cat > ${INSTALL_DIR}/Caddyfile << EOF
${DROPLET_IP} {
    tls internal
    reverse_proxy openclaw:18789
}
EOF

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
    "bind": "0.0.0.0",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]
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
    "bind": "0.0.0.0",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]
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
    "bind": "0.0.0.0",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]
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
# Thay the placeholder token bang token thuc
jq --arg token "${GATEWAY_TOKEN}" '.gateway.auth.token = $token' \
    ${INSTALL_DIR}/config/openclaw.json > ${INSTALL_DIR}/config/openclaw.json.tmp
mv ${INSTALL_DIR}/config/openclaw.json.tmp ${INSTALL_DIR}/config/openclaw.json

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
log "  Dashboard: https://${DROPLET_IP}?token=${GATEWAY_TOKEN}"
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
