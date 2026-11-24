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
  local test_root="${DASHBOARD_AGENT_TEST_ROOT:-}"
  if [[ -n "$test_root" && ! -f "$test_root/.dashboard-agent-test-root" ]]; then
    echo "error: DASHBOARD_AGENT_TEST_ROOT is not a prepared test sandbox." >&2; exit 1
  fi
  [[ -n "$test_root" || $EUID -eq 0 ]] || { echo "error: must run as root (sudo)." >&2; exit 1; }
  if [[ ! -f "$test_root/etc/systemd/system/dashboard-agent.service" && ! -d "$test_root/opt/dashboard-agent" ]]; then
    echo "error: dashboard-agent is not installed. Run install-host.sh first." >&2
    exit 1
  fi
  command -v git >/dev/null 2>&1 || { echo "error: git is required for updates." >&2; exit 1; }

  # EXIT runs after main returns, when local variables are out of scope.
  # Keep the temporary path global so cleanup works on success and failure.
  UPDATE_TMP=$(mktemp -d /tmp/dashboard-agent-update.XXXXXXXX)
  trap 'rm -rf -- "$UPDATE_TMP"' EXIT
  if [[ -n "${AGENT_COMMIT:-}" ]]; then
    [[ "$AGENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "error: AGENT_COMMIT must be a full 40-character commit id." >&2; exit 1; }
    git init -q "$UPDATE_TMP"
    git -C "$UPDATE_TMP" remote add origin "$repo"
    git -C "$UPDATE_TMP" fetch -q --depth 1 origin "$AGENT_COMMIT"
    git -C "$UPDATE_TMP" checkout -q FETCH_HEAD
    [[ "$(git -C "$UPDATE_TMP" rev-parse HEAD)" == "$AGENT_COMMIT" ]] || { echo "error: fetched commit does not match AGENT_COMMIT." >&2; exit 1; }
  else
    [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "error: invalid AGENT_REF" >&2; exit 1; }
    git clone -q --depth 1 --branch "$ref" "$repo" "$UPDATE_TMP"
  fi
  local prev new
  prev=$(cat "$test_root/opt/dashboard-agent/.installed-rev" 2>/dev/null || echo unknown)
  new=$(git -C "$UPDATE_TMP" rev-parse HEAD)
  echo "==> Updating dashboard-agent: $prev -> $new"
  AGENT_SOURCE_DIR="$UPDATE_TMP" bash "$UPDATE_TMP/install-host.sh"
}

main "$@"
