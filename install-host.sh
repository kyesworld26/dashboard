#!/usr/bin/env bash
# Install (or upgrade / repair) the dashboard agent NATIVELY on this host as a
# systemd service. Idempotent: re-running upgrades in place, keeps existing
# configuration and dashboard links, and never creates a second service.
#
# RECOMMENDED — verifiable install pinned to an immutable commit:
#
#   COMMIT=<40-character commit id from the release notes>
#   curl -fsSL -o install-host.sh "https://raw.githubusercontent.com/kyesworld26/dashboard/$COMMIT/install-host.sh"
#   echo "<sha256 from the release notes>  install-host.sh" | sha256sum -c -
#   sudo AGENT_COMMIT="$COMMIT" bash install-host.sh
#
#   (Optionally add AGENT_VERIFY_SIGNATURE=1 to require a valid GPG signature
#   on that commit from a key in root's keyring.)
#
# Convenience one-liner (trusts whatever is on the main branch right now):
#   curl -fsSL https://raw.githubusercontent.com/kyesworld26/dashboard/main/install-host.sh | sudo bash
#
# From a local clone:
#   git clone https://github.com/kyesworld26/dashboard.git && sudo bash dashboard/install-host.sh
#
# Settings (environment; values are remembered in /etc/dashboard-agent/agent.env):
#   HUB_URL             wss://… hub endpoint (default wss://dashboard.kyesworld.com/agent)
#   SERVER_ROOT         directory holding this host's main docker-compose.yml (empty = auto-detect)
#   PUBLIC_BASE_DOMAIN  apex domain for generated Caddy blocks (empty = bare service name)
#   AGENT_REF           branch or tag to install (default main)
#   AGENT_COMMIT        exact commit to install; verified after download (recommended)
#   INSTALL_DOCKER=0    do not install Docker when it is missing (SKIP_DOCKER_INSTALL=1 also works)
#   ALLOW_INSECURE_HUB=1  permit a ws:// hub URL (private networks only)
#
# Other modes:
#   sudo bash install-host.sh --rollback     switch back to the previously installed version
#
# Everything below runs inside main(): if the download is cut short, bash
# reaches end-of-input before the final `main "$@"` line and executes nothing.

set -Eeuo pipefail

main() {
  # Automated tests only: redirect every system path into a prepared sandbox
  # (it must contain the marker file below) and skip the root/OS checks, so
  # the installer logic can be exercised without touching a real host.
  local R="${DASHBOARD_AGENT_TEST_ROOT:-}"
  if [[ -n "$R" && ! -f "$R/.dashboard-agent-test-root" ]]; then
    echo "error: DASHBOARD_AGENT_TEST_ROOT is not a prepared test sandbox." >&2; exit 1
  fi
  readonly TEST_ROOT="$R"
  readonly REPO_URL="${REPO_URL:-https://github.com/kyesworld26/dashboard.git}"
  readonly INSTALL_DIR="$R/opt/dashboard-agent"
  readonly STAGE_DIR="$R/opt/dashboard-agent.new"
  readonly PREV_DIR="$R/opt/dashboard-agent.prev"
  readonly DATA_DIR="$R/var/lib/dashboard-agent"
  readonly CONF_DIR="$R/etc/dashboard-agent"
  readonly CONF_FILE="$R/etc/dashboard-agent/agent.env"
  readonly UNIT_FILE="$R/etc/systemd/system/dashboard-agent.service"
  readonly LINK_BIN="$R/usr/local/bin/dashboard-link"
  readonly SERVICE=dashboard-agent
  readonly NODE_MAJOR_MIN=22
  readonly DEFAULT_HUB_URL=wss://dashboard.kyesworld.com/agent
  readonly HEALTH_TIMEOUT="${AGENT_HEALTH_TIMEOUT_SEC:-45}"
  if [[ -n "$TEST_ROOT" ]]; then OWNER=(); else OWNER=(-o root -g root); fi

  local mode=install
  [[ "${1:-}" == "--rollback" ]] && mode=rollback

  if [[ -z "$TEST_ROOT" ]]; then
    [[ $EUID -eq 0 ]] || die "this installer must run as root (use sudo)."
    [[ "$(uname -s)" == Linux ]] || die "only Linux hosts are supported."
  fi
  command -v systemctl >/dev/null 2>&1 && [[ -d "$TEST_ROOT/run/systemd/system" ]] \
    || die "systemd is required (this host does not appear to run systemd)."

  # One installer at a time.
  exec 9>"$TEST_ROOT/run/dashboard-agent-install.lock"
  flock -n 9 || die "another dashboard-agent install/update is already running."

  WORK=$(mktemp -d /tmp/dashboard-agent-install.XXXXXXXX)
  INSTALL_OK=0
  SWAPPED=0
  trap on_exit EXIT
  trap 'warn "failed at line $LINENO: $BASH_COMMAND"' ERR

  if [[ $mode == rollback ]]; then do_rollback; INSTALL_OK=1; return; fi

  detect_platform
  load_config
  fetch_sources
  verify_sources
  ensure_node
  ensure_docker
  stage_release
  write_config
  write_unit
  write_link_wrapper
  swap_and_start
  INSTALL_OK=1
  print_summary
}

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ─── Cleanup / failure handling ─────────────────────────────────────────────
on_exit() {
  local code=$?
  trap - ERR
  [[ -n "${WORK:-}" ]] && rm -rf "$WORK" 2>/dev/null
  if [[ "${INSTALL_OK:-0}" -ne 1 ]]; then
    rm -rf "${STAGE_DIR:-/nonexistent}" 2>/dev/null || true
    if [[ "${SWAPPED:-0}" -eq 1 ]]; then
      if [[ -d "$PREV_DIR" ]]; then
        warn "the new version did not come up — restoring the previous version."
        rm -rf "$INSTALL_DIR"; mv "$PREV_DIR" "$INSTALL_DIR"
        systemctl daemon-reload || true
        systemctl restart "$SERVICE" || true
      else
        warn "the fresh install did not come up — removing it so nothing half-configured keeps running."
        systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
        rm -f "$UNIT_FILE" "$LINK_BIN"; systemctl daemon-reload || true
        rm -rf "$INSTALL_DIR"
      fi
      echo "---- last agent log lines ----" >&2
      journalctl -u "$SERVICE" --no-pager -n 30 >&2 2>/dev/null || true
    fi
    [[ $code -eq 0 ]] && code=1
    echo "Installation did NOT complete. Existing configuration and dashboard links (${DATA_DIR:-/var/lib/dashboard-agent}) are untouched." >&2
  fi
  exit $code
}

# ─── Platform ────────────────────────────────────────────────────────────────
detect_platform() {
  log "Detecting platform..."
  OS_ID=unknown; OS_LIKE=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    OS_ID=$(. /etc/os-release && echo "${ID:-unknown}")
    # shellcheck disable=SC1091
    OS_LIKE=$(. /etc/os-release && echo "${ID_LIKE:-}")
  fi
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|aarch64|arm64) ;;
    armv7l) warn "armv7 is not covered by every Node.js 22 channel; install Node.js 22+ yourself if the automatic install fails." ;;
    *) die "unsupported CPU architecture: $ARCH" ;;
  esac
  if   command -v apt-get >/dev/null 2>&1; then PKG=apt
  elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
  elif command -v yum     >/dev/null 2>&1; then PKG=yum
  elif command -v pacman  >/dev/null 2>&1; then PKG=pacman
  else PKG=none; fi
  info "OS: $OS_ID${OS_LIKE:+ ($OS_LIKE)}  arch: $ARCH  packages: $PKG"
  command -v curl >/dev/null 2>&1 || pkg_install curl
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum (coreutils) is required."
}

pkg_install() {
  case "$PKG" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf)    dnf install -y -q "$@" ;;
    yum)    yum install -y -q "$@" ;;
    pacman) pacman -Sy --needed --noconfirm "$@" ;;
    *)      die "please install: $* (no supported package manager found)" ;;
  esac
}

# ─── Configuration (preserved across upgrades) ──────────────────────────────
conf_get() { # KEY FILE → value from KEY='v' / KEY="v" / KEY=v
  [[ -r "$2" ]] || return 0
  sed -n "s/^$1=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}\$/\1/p" "$2" | tail -n1
}

load_config() {
  log "Loading configuration..."
  local src="$CONF_FILE"
  # Installs before 1.1 kept settings as Environment= lines in the unit file.
  if [[ ! -r "$CONF_FILE" && -r "$UNIT_FILE" ]]; then
    src="$WORK/legacy.env"
    sed -n 's/^Environment=//p' "$UNIT_FILE" | tr -d '"' > "$src"
  fi
  HUB_URL="${HUB_URL:-$(conf_get HUB_URL "$src")}"
  HUB_URL="${HUB_URL:-$DEFAULT_HUB_URL}"
  SERVER_ROOT="${SERVER_ROOT:-$(conf_get SERVER_ROOT "$src")}"
  PUBLIC_BASE_DOMAIN="${PUBLIC_BASE_DOMAIN:-$(conf_get PUBLIC_BASE_DOMAIN "$src")}"

  # These values go into a systemd EnvironmentFile and a shell wrapper, so
  # they must be plain single-line strings without quotes.
  local safe='^[A-Za-z0-9._:/@%+=~-]*$'
  [[ "$HUB_URL" =~ $safe && "$SERVER_ROOT" =~ $safe && "$PUBLIC_BASE_DOMAIN" =~ $safe ]] \
    || die "HUB_URL, SERVER_ROOT and PUBLIC_BASE_DOMAIN may only contain letters, digits and . _ : / @ % + = ~ -"
  # Same policy as tunnel.js: TLS required, except to loopback or a private
  # single-label hostname (e.g. the compose network's "hub").
  INSECURE_HUB=0
  case "$HUB_URL" in
    wss://*) ;;
    ws://*)
      local hub_host="${HUB_URL#ws://}"; hub_host="${hub_host%%[:/]*}"
      if [[ "$hub_host" == localhost || "$hub_host" == 127.* || "$hub_host" != *.* ]]; then :
      elif [[ "${ALLOW_INSECURE_HUB:-0}" == 1 ]]; then INSECURE_HUB=1
      else die "HUB_URL uses unencrypted ws:// to $hub_host. Use wss://, or set ALLOW_INSECURE_HUB=1 on a trusted private network."
      fi ;;
    *) die "HUB_URL must start with wss://" ;;
  esac
  [[ -z "$SERVER_ROOT" || "$SERVER_ROOT" == /* ]] || die "SERVER_ROOT must be an absolute path."
  [[ -z "$PUBLIC_BASE_DOMAIN" || "$PUBLIC_BASE_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "PUBLIC_BASE_DOMAIN must be a hostname."
  info "hub: $HUB_URL"
  info "server root: ${SERVER_ROOT:-(auto-detect)}"
}

# ─── Sources ─────────────────────────────────────────────────────────────────
fetch_sources() {
  local here=""
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  fi
  if [[ -n "${AGENT_SOURCE_DIR:-}" ]]; then
    SRC="$AGENT_SOURCE_DIR"
    log "Using agent sources in $SRC"
  elif [[ -n "$here" && -f "$here/SHA256SUMS" && -f "$here/tunnel.js" ]]; then
    SRC="$here"
    log "Using agent sources next to this script ($SRC)"
  else
    command -v git >/dev/null 2>&1 || { log "Installing git..."; pkg_install git; }
    SRC="$WORK/src"
    if [[ -n "${AGENT_COMMIT:-}" ]]; then
      [[ "$AGENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "AGENT_COMMIT must be a full 40-character commit id."
      log "Fetching agent commit $AGENT_COMMIT from $REPO_URL..."
      git init -q "$SRC"
      git -C "$SRC" remote add origin "$REPO_URL"
      git -C "$SRC" fetch -q --depth 1 origin "$AGENT_COMMIT" || die "could not fetch commit $AGENT_COMMIT from $REPO_URL"
      git -C "$SRC" checkout -q FETCH_HEAD
    else
      local ref="${AGENT_REF:-${REPO_REF:-main}}"
      [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid AGENT_REF"
      log "Fetching agent sources from $REPO_URL ($ref)..."
      git clone -q --depth 1 --branch "$ref" "$REPO_URL" "$SRC" || die "could not clone $REPO_URL ($ref)"
    fi
  fi
  if [[ -d "$SRC/.git" ]]; then
    REV=$(git -C "$SRC" rev-parse HEAD)
    if [[ -n "${AGENT_COMMIT:-}" && "$REV" != "$AGENT_COMMIT" ]]; then
      die "fetched commit $REV does not match AGENT_COMMIT $AGENT_COMMIT"
    fi
    if [[ "${AGENT_VERIFY_SIGNATURE:-0}" == 1 ]]; then
      git -C "$SRC" verify-commit HEAD >/dev/null 2>&1 \
        || die "commit $REV has no valid signature from a key in root's GPG keyring."
      info "signature on $REV verified"
    fi
  else
    REV="local-$(date +%Y%m%d%H%M%S)"
  fi
  info "revision: $REV"
}

verify_sources() {
  log "Verifying file integrity (SHA256SUMS)..."
  [[ -f "$SRC/SHA256SUMS" ]] || die "SHA256SUMS is missing from the agent sources; refusing to install unverified files."
  ( cd "$SRC" && sha256sum --check --strict --quiet SHA256SUMS ) \
    || die "one or more agent files do not match SHA256SUMS (corrupted or tampered download)."
  mapfile -t FILES < <(awk '{print $2}' "$SRC/SHA256SUMS" | sed 's/^\*//')
  local f
  for f in "${FILES[@]}"; do
    [[ "$f" =~ ^[A-Za-z0-9._-]+$ ]] || die "unexpected path in SHA256SUMS: $f"
  done
  for f in tunnel.js server.js link.js transfer-agent.js check.js package.json package-lock.json; do
    printf '%s\n' "${FILES[@]}" | grep -qx "$f" || die "SHA256SUMS does not cover required file $f"
  done
  info "${#FILES[@]} files verified"
}

# ─── Dependencies ────────────────────────────────────────────────────────────
# Vendor setup scripts are downloaded to a file and sanity-checked first, never
# piped straight into a root shell (a truncated or error-page download would
# otherwise be executed).
fetch_vendor_script() { # URL OUT MARKER
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --max-time 120 -o "$2" "$1" || die "download failed: $1"
  head -n1 "$2" | grep -q '^#!' || die "unexpected content from $1 (not a script)"
  grep -qF "$3" "$2" || die "unexpected content from $1 (expected marker not found)"
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  log "Checking Node.js (need >= $NODE_MAJOR_MIN)..."
  if command -v node >/dev/null 2>&1 && [[ $(node_major) -ge $NODE_MAJOR_MIN ]] && command -v npm >/dev/null 2>&1; then
    info "Node $(node --version)"; return
  fi
  [[ "${NODE_INSTALL:-auto}" == skip ]] && die "Node.js $NODE_MAJOR_MIN+ is required (NODE_INSTALL=skip was set)."
  case "$PKG" in
    apt)
      fetch_vendor_script "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" "$WORK/nodesource.sh" "NODE_VERSION=\"${NODE_MAJOR_MIN}.x\""
      bash "$WORK/nodesource.sh" >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs ;;
    dnf|yum)
      fetch_vendor_script "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" "$WORK/nodesource.sh" "NODE_VERSION=\"${NODE_MAJOR_MIN}.x\""
      bash "$WORK/nodesource.sh" >/dev/null
      # `install` considers an existing Node 20 package satisfied even after
      # the NodeSource 22 repository has been configured. Upgrade it explicitly.
      if command -v node >/dev/null 2>&1; then
        "$PKG" upgrade -y -q nodejs
      else
        "$PKG" install -y -q nodejs
      fi ;;
    pacman)
      pacman -Sy --needed --noconfirm nodejs npm ;;
    *)
      die "install Node.js $NODE_MAJOR_MIN+ and npm manually, then re-run this installer." ;;
  esac
  [[ $(node_major) -ge $NODE_MAJOR_MIN ]] || die "Node.js install did not produce version $NODE_MAJOR_MIN+ (got $(node --version 2>/dev/null || echo none))."
  info "Node $(node --version)"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    info "Docker: $(docker --version)"
  elif [[ "${INSTALL_DOCKER:-1}" == 0 || "${SKIP_DOCKER_INSTALL:-0}" == 1 ]]; then
    warn "Docker is not installed (skipped by request); service actions are unavailable until it is."
    return 0
  else
    log "Installing Docker (engine + compose plugin) via get.docker.com..."
    case " $OS_ID $OS_LIKE " in
      *" arch "*) die "get.docker.com does not support this distribution; install Docker with your package manager (or set INSTALL_DOCKER=0)." ;;
    esac
    fetch_vendor_script https://get.docker.com "$WORK/get-docker.sh" 'SCRIPT_COMMIT_SHA='
    sh "$WORK/get-docker.sh" >/dev/null || die "Docker installation failed (set INSTALL_DOCKER=0 to install without it)."
    info "Docker: $(docker --version)"
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || warn "Docker is installed but its daemon could not be started; start it manually."
  fi
  return 0
}

# ─── Release staging ─────────────────────────────────────────────────────────
stage_release() {
  log "Preparing new release..."
  rm -rf "$STAGE_DIR"
  install -d -m 0755 "$STAGE_DIR"
  local f
  for f in "${FILES[@]}"; do install -m 0644 "$SRC/$f" "$STAGE_DIR/$f"; done
  printf '%s\n' "$REV" > "$STAGE_DIR/.installed-rev"
  log "Installing npm dependencies (exact versions from package-lock.json)..."
  ( cd "$STAGE_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ) || die "npm ci failed."
  log "Self-check of the new release..."
  ( cd "$STAGE_DIR" && node check.js ) || die "the new release failed its self-check."
}

write_config() {
  log "Writing $CONF_FILE..."
  install -d -m 0755 "$CONF_DIR"
  local tmp; tmp=$(mktemp "$CONF_DIR/.agent.env.XXXXXX")
  {
    echo "# dashboard-agent settings (kept across upgrades). Restart after editing:"
    echo "#   sudo systemctl restart dashboard-agent"
    echo "HUB_URL='$HUB_URL'"
    echo "SERVER_ROOT='$SERVER_ROOT'"
    echo "PUBLIC_BASE_DOMAIN='$PUBLIC_BASE_DOMAIN'"
    echo "AGENT_DATA_DIR='$DATA_DIR'"
    if [[ "$INSECURE_HUB" == 1 ]]; then echo "AGENT_ALLOW_INSECURE_HUB='true'"; fi
    # Keep any extra KEY=value settings the operator added by hand.
    if [[ -r "$CONF_FILE" ]]; then
      grep -vE '^(#|HUB_URL=|SERVER_ROOT=|PUBLIC_BASE_DOMAIN=|AGENT_DATA_DIR=|AGENT_ALLOW_INSECURE_HUB=)' "$CONF_FILE" | grep -E '^[A-Z_][A-Z0-9_]*=' || true
    fi
  } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$CONF_FILE"

  # Credentials live here: owner-only. (Sandboxes on filesystems without
  # POSIX permissions — test runs only — may not support chmod.)
  if [[ -n "$TEST_ROOT" ]]; then mkdir -p "$DATA_DIR"
  elif [[ ! -d "$DATA_DIR" ]]; then install -d -m 0700 "${OWNER[@]}" "$DATA_DIR"; fi
  chmod 0700 "$DATA_DIR" || [[ -n "$TEST_ROOT" ]] || die "could not restrict permissions of $DATA_DIR"
  local f
  for f in agent.json pairing.txt status.json; do
    if [[ -e "$DATA_DIR/$f" ]]; then chmod 0600 "$DATA_DIR/$f" || [[ -n "$TEST_ROOT" ]] || die "could not restrict $DATA_DIR/$f"; fi
  done
  return 0
}

write_unit() {
  log "Writing systemd unit..."
  local node_bin tmp
  node_bin=$(command -v node)
  tmp=$(mktemp "$WORK/unit.XXXXXX")
  cat > "$tmp" <<EOF
# Managed by install-host.sh — local changes are overwritten on upgrade.
# Put settings in $CONF_FILE, or overrides in 'systemctl edit $SERVICE'.
[Unit]
Description=Dashboard agent (outbound tunnel to hub + local management API)
After=network-online.target docker.service
Wants=network-online.target docker.service
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
# Root is required: the web terminal is a host shell and the agent manages
# Docker. The local API only accepts requests from the tunnel process.
User=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$CONF_FILE
ExecStart="$node_bin" "$INSTALL_DIR/tunnel.js"
Restart=always
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  cmp -s "$tmp" "$UNIT_FILE" 2>/dev/null || install -D -m 0644 "$tmp" "$UNIT_FILE"
}

write_link_wrapper() {
  log "Installing 'dashboard-link'..."
  local node_bin tmp
  node_bin=$(command -v node)
  tmp=$(mktemp "$WORK/link.XXXXXX")
  cat > "$tmp" <<EOF
#!/usr/bin/env bash
# Managed by install-host.sh. Links this server to a dashboard account using
# the same settings as the systemd service.
set -euo pipefail
[[ \$EUID -eq 0 ]] || exec sudo "\$0" "\$@"
set -a; . "$CONF_FILE"; set +a
exec "$node_bin" "$INSTALL_DIR/link.js" "\$@"
EOF
  install -D -m 0755 "$tmp" "$LINK_BIN"
}

# ─── Switch-over with a real health check ────────────────────────────────────
# "systemctl is-active" alone is not enough: tunnel.js stays active even when
# its local API child crash-loops. The agent writes status.json once the local
# API has actually started listening.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) main_pid
  while (( SECONDS < deadline )); do
    main_pid=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)
    if [[ "$main_pid" != 0 && -r "$DATA_DIR/status.json" ]] \
       && grep -q "\"pid\": *$main_pid[,}]" "$DATA_DIR/status.json" \
       && grep -q '"localApi": *"up"' "$DATA_DIR/status.json"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

swap_and_start() {
  log "Activating release $REV..."
  rm -rf "$PREV_DIR"
  if [[ -d "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$PREV_DIR"; fi
  mv "$STAGE_DIR" "$INSTALL_DIR"
  SWAPPED=1
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  log "Waiting for the agent to report healthy..."
  wait_healthy || die "the agent did not become healthy within $HEALTH_TIMEOUT seconds."
  rm -rf "$TEST_ROOT/opt/dashboard-agent.bak"   # left behind by the pre-1.1 update script
  info "agent is up"
}

do_rollback() {
  [[ -d "$PREV_DIR" ]] || die "there is no previous version to roll back to."
  log "Rolling back to $(cat "$PREV_DIR/.installed-rev" 2>/dev/null || echo 'the previous version')..."
  local cur="$TEST_ROOT/opt/dashboard-agent.rollback-tmp"
  rm -rf "$cur"
  mv "$INSTALL_DIR" "$cur"
  mv "$PREV_DIR" "$INSTALL_DIR"
  mv "$cur" "$PREV_DIR"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  if wait_healthy; then info "rolled back (run --rollback again to switch forward)"
  else warn "the restored version did not report healthy; check: journalctl -u $SERVICE"; fi
}

print_summary() {
  echo ""
  echo "============================================================"
  echo "dashboard-agent $(cat "$INSTALL_DIR/.installed-rev") is installed and running."
  echo ""
  if [[ ! -s "$DATA_DIR/agent.json" ]]; then
    echo "  Link this server to your dashboard account:"
    echo "    sudo dashboard-link"
    echo ""
  fi
  echo "  Settings:   $CONF_FILE   (then: sudo systemctl restart $SERVICE)"
  echo "  Logs:       sudo journalctl -u $SERVICE -f"
  echo "  Upgrade:    re-run this installer (settings and links are kept)"
  echo "  Roll back:  sudo bash install-host.sh --rollback"
  echo "  Uninstall:  sudo bash uninstall-host.sh [--purge]"
  echo "============================================================"
}

main "$@"
