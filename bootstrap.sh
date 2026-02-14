#!/bin/bash
# =============================================================================
# OpenClaw Bootstrap — Tai install.sh ve va chay ngam (nohup)
#
# Usage (goi tu QemuAgentRunScript hoac SSH):
#   curl -fsSL <url>/bootstrap.sh | bash -s -- --mgmt-key <KEY> [--domain <DOMAIN>]
#
# Script nay return ngay lap tuc, install chay ngam trong background.
# Kiem tra tien trinh: tail -f /var/log/openclaw-install.log
# =============================================================================

REPO_RAW="https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main"
INSTALL_SCRIPT="/tmp/openclaw-install.sh"
LOG_FILE="/var/log/openclaw-install.log"

# Truyen tat ca arguments sang install.sh
ARGS="$@"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: Dang tai install.sh..." | tee "$LOG_FILE"

# Tai install.sh
if curl -fsSL "${REPO_RAW}/install.sh" -o "$INSTALL_SCRIPT"; then
    chmod +x "$INSTALL_SCRIPT"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: Da tai xong. Chay install ngam..." | tee -a "$LOG_FILE"

    # Chay ngam — return ngay cho QemuAgent
    # install.sh da tu ghi log qua tee, chi redirect stderr
    nohup bash "$INSTALL_SCRIPT" $ARGS 2>> "$LOG_FILE" &

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: Install PID=$! dang chay ngam." | tee -a "$LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: Theo doi: tail -f $LOG_FILE" | tee -a "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bootstrap: LOI - Khong tai duoc install.sh" | tee -a "$LOG_FILE"
    exit 1
fi
