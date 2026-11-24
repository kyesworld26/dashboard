#!/usr/bin/env bash
# Remove the dashboard-agent service and its program files.
#
#   sudo bash uninstall-host.sh            keep credentials + settings (a reinstall reconnects)
#   sudo bash uninstall-host.sh --purge    ALSO revoke this server's credentials on the
#                                          dashboard and delete them locally
#
# Only the agent's own files are removed: /opt/dashboard-agent*, the systemd
# unit, /usr/local/bin/dashboard-link, and (with --purge) /etc/dashboard-agent
# and /var/lib/dashboard-agent. Docker, containers, compose files, service
# folders and every other application on this host are left untouched.

set -Eeuo pipefail

main() {
  local purge=0
  [[ "${1:-}" == "--purge" ]] && purge=1
  # Automated tests only (see install-host.sh).
  local R="${DASHBOARD_AGENT_TEST_ROOT:-}"
  if [[ -n "$R" && ! -f "$R/.dashboard-agent-test-root" ]]; then echo "error: not a prepared test sandbox." >&2; exit 1; fi
  [[ -n "$R" || $EUID -eq 0 ]] || { echo "error: must run as root (sudo)." >&2; exit 1; }

  local install_dir="$R/opt/dashboard-agent" data_dir="$R/var/lib/dashboard-agent" conf="$R/etc/dashboard-agent"
  local unit="$R/etc/systemd/system/dashboard-agent.service"

  if [[ $purge -eq 1 && -s "$data_dir/agent.json" && -f "$install_dir/tunnel.js" ]]; then
    echo "==> Revoking this server's credentials on the dashboard..."
    local node_bin; node_bin=$(command -v node || true)
    if [[ -n "$node_bin" ]] && ( set -a; [[ -r "$conf/agent.env" ]] && . "$conf/agent.env"; set +a; "$node_bin" "$install_dir/tunnel.js" --revoke-all ); then
      echo "    revoked."
    else
      echo "warning: could not revoke every credential at the hub (offline?). Unlink this server in the dashboard (Servers → unlink) to revoke it there." >&2
    fi
  fi

  if [[ -f "$unit" ]] || systemctl list-unit-files 2>/dev/null | grep -q '^dashboard-agent\.service'; then
    echo "==> Stopping and removing the systemd service..."
    systemctl disable --now dashboard-agent >/dev/null 2>&1 || true
    rm -f "$unit"
    rm -rf "$unit.d"
    systemctl daemon-reload
  fi

  echo "==> Removing program files..."
  rm -rf "$install_dir" "$install_dir.new" "$install_dir.prev" "$install_dir.bak" "$install_dir.rollback-tmp"
  rm -f "$R/usr/local/bin/dashboard-link" "$R/run/dashboard-agent-install.lock"

  if [[ $purge -eq 1 ]]; then
    rm -rf "$data_dir" "$conf"
    echo "Removed the agent, its settings and its credentials."
  else
    echo "Removed the agent. Credentials ($data_dir) and settings ($conf) were kept; use --purge to revoke and delete them."
  fi
}

main "$@"
