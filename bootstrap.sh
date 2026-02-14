#!/bin/bash
# =============================================================================
# OpenClaw Bootstrap — Doi cloud-init xong, reboot, roi chay install.sh
#
# Usage (goi tu SSH):
#   curl -fsSL <url>/bootstrap.sh | bash -s -- --mgmt-key <KEY> [--domain <DOMAIN>]
#
# Flow:
#   1. Doi cloud-init hoan tat
#   2. Tai install.sh ve /tmp
#   3. Tao systemd one-shot service de chay install.sh sau reboot
#   4. Reboot VPS
#   5. Sau reboot, systemd chay install.sh, xong thi tu disable service
#
# Kiem tra tien trinh: tail -f /var/log/openclaw-install.log
# =============================================================================

REPO_RAW="https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main"
INSTALL_SCRIPT="/tmp/openclaw-install.sh"
INSTALL_ARGS="/tmp/openclaw-install.args"
LOG_FILE="/var/log/openclaw-install.log"
SERVICE_NAME="openclaw-install"

# Luu arguments vao file de systemd doc lai sau reboot
echo "$*" > "$INSTALL_ARGS"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: $*" | tee -a "$LOG_FILE"; }

log "Bat dau bootstrap..."

# =============================================================================
# 1. Doi cloud-init hoan tat
# =============================================================================
log "Doi cloud-init hoan tat..."
if command -v cloud-init &>/dev/null; then
    cloud-init status --wait 2>&1 | while IFS= read -r line; do
        log "cloud-init: $line"
    done
    log "cloud-init da hoan tat."
else
    log "cloud-init khong co, bo qua."
fi

# =============================================================================
# 2. Tai install.sh
# =============================================================================
log "Dang tai install.sh..."
if ! curl -fsSL "${REPO_RAW}/install.sh" -o "$INSTALL_SCRIPT"; then
    log "LOI - Khong tai duoc install.sh"
    exit 1
fi
chmod +x "$INSTALL_SCRIPT"
log "Da tai install.sh thanh cong."

# =============================================================================
# 3. Tao systemd one-shot service chay install.sh sau reboot
# =============================================================================
log "Luu arguments: $(cat "$INSTALL_ARGS")"
log "Tao systemd service ${SERVICE_NAME} de chay sau reboot..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SERVICEEOF'
[Unit]
Description=OpenClaw Post-Reboot Installer
After=network-online.target
Wants=network-online.target
ConditionPathExists=/tmp/openclaw-install.sh

[Service]
Type=oneshot
Environment=DEBIAN_FRONTEND=noninteractive
ExecStart=/bin/bash -c '/tmp/openclaw-install.sh $(cat /tmp/openclaw-install.args) >> /var/log/openclaw-install.log 2>&1; systemctl disable openclaw-install.service; rm -f /etc/systemd/system/openclaw-install.service /tmp/openclaw-install.args; systemctl daemon-reload'
RemainAfterExit=false
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
log "Service ${SERVICE_NAME} da duoc enable."

# =============================================================================
# 4. Reboot
# =============================================================================
log "Reboot VPS trong 5 giay..."
log "Sau reboot, install se tu dong chay. Theo doi: tail -f ${LOG_FILE}"

# Dung nohup + sleep de SSH co thoi gian return truoc khi reboot
nohup bash -c "sleep 5 && reboot" &>/dev/null &

log "Bootstrap hoan tat. VPS se reboot ngay bay gio."
