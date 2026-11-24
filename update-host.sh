#!/usr/bin/env bash
# Upgrade an existing dashboard-agent install. Credentials and links in
# /var/lib/dashboard-agent and settings in /etc/dashboard-agent are kept.
#
# This is a thin wrapper: it fetches the requested version and runs THAT
# version's install-host.sh, which verifies every file (SHA256SUMS), stages the
# new release, health-checks it and rolls back automatically on failure.
#
#   # Recommended: pin the exact commit from the release notes
#   sudo AGENT_COMMIT=<40-character commit id> bash update-host.sh
#
#   # Latest main branch:
#   curl -fsSL https://raw.githubusercontent.com/kyesworld26/dashboard/main/update-host.sh | sudo bash
#
#   # Return to the previously installed version:
#   sudo bash /opt/dashboard-agent/install-host.sh --rollback

set -Eeuo pipefail

main() {
  local repo="${REPO_URL:-https://github.com/kyesworld26/dashboard.git}"
  local ref="${AGENT_REF:-${REPO_REF:-main}}"
  [[ $EUID -eq 0 ]] || { echo "error: must run as root (sudo)." >&2; exit 1; }
  if [[ ! -f /etc/systemd/system/dashboard-agent.service && ! -d /opt/dashboard-agent ]]; then
    echo "error: dashboard-agent is not installed. Run install-host.sh first." >&2
    exit 1
  fi
  command -v git >/dev/null 2>&1 || { echo "error: git is required for updates." >&2; exit 1; }

  local tmp; tmp=$(mktemp -d /tmp/dashboard-agent-update.XXXXXXXX)
  trap 'rm -rf "$tmp"' EXIT
  if [[ -n "${AGENT_COMMIT:-}" ]]; then
    [[ "$AGENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "error: AGENT_COMMIT must be a full 40-character commit id." >&2; exit 1; }
    git init -q "$tmp"
    git -C "$tmp" remote add origin "$repo"
    git -C "$tmp" fetch -q --depth 1 origin "$AGENT_COMMIT"
    git -C "$tmp" checkout -q FETCH_HEAD
    [[ "$(git -C "$tmp" rev-parse HEAD)" == "$AGENT_COMMIT" ]] || { echo "error: fetched commit does not match AGENT_COMMIT." >&2; exit 1; }
  else
    [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "error: invalid AGENT_REF" >&2; exit 1; }
    git clone -q --depth 1 --branch "$ref" "$repo" "$tmp"
  fi
  local prev new
  prev=$(cat /opt/dashboard-agent/.installed-rev 2>/dev/null || echo unknown)
  new=$(git -C "$tmp" rev-parse HEAD)
  echo "==> Updating dashboard-agent: $prev -> $new"
  AGENT_SOURCE_DIR="$tmp" bash "$tmp/install-host.sh"
}

main "$@"
