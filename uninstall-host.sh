#!/usr/bin/env bash
# Remove the native dashboard-agent systemd service and its files. Keeps the
# data directory (credentials) by default; pass --purge to remove it too.

set -euo pipefail

INSTALL_DIR=/opt/dashboard-agent
DATA_DIR=/var/lib/dashboard-agent
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

if [[ $EUID -ne 0 ]]; then
  echo "error: must run as root (sudo)." >&2; exit 1
fi

if systemctl list-unit-files | grep -q '^dashboard-agent\.service'; then
  systemctl disable --now dashboard-agent || true
  rm -f /etc/systemd/system/dashboard-agent.service
  systemctl daemon-reload
fi

rm -rf "$INSTALL_DIR"
rm -f /usr/local/bin/dashboard-link

if [[ $PURGE -eq 1 ]]; then
  rm -rf "$DATA_DIR"
  echo "Removed agent and wiped credentials in $DATA_DIR."
else
  echo "Removed agent. Credentials in $DATA_DIR were kept (use --purge to delete)."
fi
