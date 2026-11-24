#!/usr/bin/env bash
# Installer / updater / uninstaller scenario tests.
#
# Everything runs inside throw-away sandboxes (DASHBOARD_AGENT_TEST_ROOT) with
# stub systemctl/journalctl/npm/flock/docker on PATH and a loopback-only
# network guard for the agent. The agent itself is the real code from this
# checkout; the hub URL points at a closed loopback port. No real host paths,
# services, credentials or network endpoints are used.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$(cd "$HERE/../.." && pwd)"
STUBS="$HERE/stubs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/installer-test.XXXXXX")"
FAILS=0; PASSES=0
trap 'for r in "$WORK"/sb-*; do [[ -d "$r" ]] && DASHBOARD_AGENT_TEST_ROOT="$r" "$STUBS/systemctl" stop dashboard-agent >/dev/null 2>&1; done; rm -rf "$WORK"' EXIT

ok()   { PASSES=$((PASSES + 1)); echo "ok - $1"; }
bad()  { FAILS=$((FAILS + 1)); echo "not ok - $1"; [[ -n "${2:-}" ]] && sed 's/^/    | /' <<<"$2" | tail -n 25; }
check() { if eval "$1"; then ok "$2"; else bad "$2" "${3:-}"; fi; }

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
GUARD="$(winpath "$AGENT/test/helpers/no-network.js" | tr '\\' '/')"
FAKE_DOCKER="$(winpath "$AGENT/test/fixtures/fake-docker.js")"
NODE_BIN="$(command -v node)"

# A source tree = exactly the files a release ships, with fresh SHA256SUMS.
make_src() {
  local d="$WORK/$1"; mkdir -p "$d/tools"
  for f in check.js install-host.sh link.js package-lock.json package.json server.js transfer-agent.js tunnel.js uninstall-host.sh update-host.sh; do cp "$AGENT/$f" "$d/$f"; done
  cp "$AGENT/tools/make-sums.js" "$d/tools/"; cp "$AGENT/.gitattributes" "$d/"
  (cd "$d" && node tools/make-sums.js >/dev/null)
  echo "$d"
}

new_sandbox() {
  local r="$WORK/sb-$1"; mkdir -p "$r/run/systemd/system" "$r/home" "$r/docker"
  touch "$r/.dashboard-agent-test-root"
  echo "$r"
}

port=$((40000 + RANDOM % 20000))
run_install() { # sandbox src [extra env...] -- [args]
  local r="$1" src="$2"; shift 2
  env DASHBOARD_AGENT_TEST_ROOT="$r" PATH="$STUBS:$PATH" HOME="$r/home" \
      HUB_URL="${TEST_HUB_URL-ws://127.0.0.1:9/agent}" AGENT_SOURCE_DIR="$src" AGENT_HEALTH_TIMEOUT_SEC=25 \
      AGENT_LOCAL_PORT="$port" AGENT_DOCKER_BIN="\"$NODE_BIN\" \"$FAKE_DOCKER\"" FAKE_DOCKER_STATE="$(winpath "$r/docker")" \
      NODE_OPTIONS="--require \"$GUARD\"" STATS_SAMPLE_MS=3600000 FAKE_NPM_MODULES="$(winpath "$AGENT/node_modules")" \
      "$@" bash "$src/install-host.sh" ${INSTALL_ARGS:-} 2>&1
}
healthy() { local r="$1" pid; pid=$(DASHBOARD_AGENT_TEST_ROOT="$r" "$STUBS/systemctl" show -p MainPID --value dashboard-agent); [[ "$pid" != 0 ]] && grep -q "\"pid\":$pid," "$r/var/lib/dashboard-agent/status.json" 2>/dev/null && grep -q '"localApi":"up"' "$r/var/lib/dashboard-agent/status.json"; }
rev() { cat "$1/opt/dashboard-agent/.installed-rev" 2>/dev/null; }
tmpcount() { ls -d "${TMPDIR:-/tmp}"/dashboard-agent-install.* 2>/dev/null | wc -l; }

echo "# installer tests in $WORK"
SRC="$(make_src src)"
SB="$(new_sandbox main)"

# 1. Fresh install ------------------------------------------------------------
t0=$(tmpcount)
out=$(run_install "$SB" "$SRC"); code=$?
check '[[ $code -eq 0 ]]' "fresh install succeeds" "$out"
check '[[ -f "$SB/etc/systemd/system/dashboard-agent.service" ]]' "systemd unit written"
check 'grep -q "^EnvironmentFile=$SB/etc/dashboard-agent/agent.env" "$SB/etc/systemd/system/dashboard-agent.service"' "unit reads settings from an EnvironmentFile"
check 'grep -q "^ExecStart=\"" "$SB/etc/systemd/system/dashboard-agent.service"' "ExecStart paths are quoted"
check 'grep -q "^HUB_URL=.ws://127.0.0.1:9/agent.$" "$SB/etc/dashboard-agent/agent.env"' "settings recorded"
check '[[ -x "$SB/usr/local/bin/dashboard-link" ]]' "dashboard-link installed"
check 'healthy "$SB"' "agent is running and its local API is up"
check '[[ $(tmpcount) -eq $t0 ]]' "temporary installer files removed"
check '! grep -qiE "secret|token=" <<<"$out"' "no credentials in installer output"
REV1=$(rev "$SB")

# 2. Re-install is idempotent and keeps settings ------------------------------
echo "EXTRA_SETTING='kept'" >> "$SB/etc/dashboard-agent/agent.env"
out=$(TEST_HUB_URL= run_install "$SB" "$SRC" env -u HUB_URL); code=$?
check '[[ $code -eq 0 ]]' "re-install succeeds" "$out"
check 'grep -q "^HUB_URL=.ws://127.0.0.1:9/agent.$" "$SB/etc/dashboard-agent/agent.env"' "existing HUB_URL preserved when not given"
check 'grep -q "^EXTRA_SETTING=.kept.$" "$SB/etc/dashboard-agent/agent.env"' "operator-added settings preserved"
check '[[ $(ls "$SB/etc/systemd/system" | grep -c dashboard-agent) -eq 1 ]]' "still exactly one service unit"
check '[[ -d "$SB/opt/dashboard-agent.prev" ]]' "previous release kept for rollback"
check 'healthy "$SB"' "agent healthy after re-install"
echo '{"secret":"keep-me"}' > "$SB/var/lib/dashboard-agent/agent.json"

# 3. Tampered file is refused; running install untouched ----------------------
TAMPER="$(make_src tamper)"; echo "// injected" >> "$TAMPER/server.js"
before=$(rev "$SB")
out=$(run_install "$SB" "$TAMPER"); code=$?
check '[[ $code -ne 0 ]] && grep -q "do not match SHA256SUMS" <<<"$out"' "tampered file detected and install refused" "$out"
check '[[ "$(rev "$SB")" == "$before" ]] && healthy "$SB"' "existing install still in place and running"
check '[[ ! -d "$SB/opt/dashboard-agent.new" ]]' "no half-staged release left behind"

# 4. Missing checksum manifest is refused ---------------------------------------
NOSUMS="$(make_src nosums)"; rm "$NOSUMS/SHA256SUMS"
out=$(run_install "$SB" "$NOSUMS"); code=$?
check '[[ $code -ne 0 ]] && grep -q "SHA256SUMS is missing" <<<"$out"' "unverifiable sources refused" "$out"

# 5. A release that does not come up healthy is rolled back -------------------
BROKEN="$(make_src broken)"
printf 'process.exit(3);\n' | cat - "$BROKEN/server.js" > "$BROKEN/server.tmp" && mv "$BROKEN/server.tmp" "$BROKEN/server.js"
(cd "$BROKEN" && node tools/make-sums.js >/dev/null)
before=$(rev "$SB")
out=$(run_install "$SB" "$BROKEN"); code=$?
check '[[ $code -ne 0 ]] && grep -q "did not become healthy" <<<"$out"' "unhealthy release detected" "$out"
check '[[ "$(rev "$SB")" == "$before" ]]' "previous release restored automatically"
sleep 4
check 'healthy "$SB"' "restored release is running again" "$(tail -n 20 "$SB/var/log/dashboard-agent.log" 2>/dev/null)"
check 'grep -q keep-me "$SB/var/lib/dashboard-agent/agent.json"' "credentials untouched by a failed upgrade"

# 6. Pinned commit from a git repository (local file:// repo, no network) ------
REPO="$WORK/repo"; cp -r "$SRC" "$REPO"
(cd "$REPO" && git init -q && git -c user.email=t@example.test -c user.name=test add -A && git -c user.email=t@example.test -c user.name=test commit -qm release)
SHA=$(git -C "$REPO" rev-parse HEAD)
LONE="$WORK/lone"; mkdir -p "$LONE"; cp "$REPO/install-host.sh" "$LONE/"
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$STUBS:$PATH" HOME="$SB/home" HUB_URL=ws://127.0.0.1:9/agent AGENT_HEALTH_TIMEOUT_SEC=25 \
      AGENT_LOCAL_PORT="$port" AGENT_DOCKER_BIN="\"$NODE_BIN\" \"$FAKE_DOCKER\"" FAKE_DOCKER_STATE="$(winpath "$SB/docker")" \
      NODE_OPTIONS="--require \"$GUARD\"" STATS_SAMPLE_MS=3600000 FAKE_NPM_MODULES="$(winpath "$AGENT/node_modules")" \
      REPO_URL="file://$REPO" AGENT_COMMIT="$SHA" bash "$LONE/install-host.sh" 2>&1 </dev/null); code=$?
check '[[ $code -eq 0 && "$(rev "$SB")" == "$SHA" ]]' "install pinned to an exact commit" "$out"
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$STUBS:$PATH" HOME="$SB/home" REPO_URL="file://$REPO" AGENT_COMMIT="$(printf '%040d' 1)" \
      bash "$LONE/install-host.sh" 2>&1); code=$?
check '[[ $code -ne 0 && "$(rev "$SB")" == "$SHA" ]]' "unknown commit refused, install unchanged" "$out"
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$STUBS:$PATH" AGENT_COMMIT="main" bash "$LONE/install-host.sh" 2>&1); code=$?
check '[[ $code -ne 0 ]] && grep -q "full 40-character" <<<"$out"' "AGENT_COMMIT must be a full commit id" "$out"

# 7. Manual rollback ------------------------------------------------------------
out=$(INSTALL_ARGS=--rollback run_install "$SB" "$SRC"); code=$?
check '[[ $code -eq 0 && "$(rev "$SB")" != "$SHA" ]] && healthy "$SB"' "--rollback switches to the previous release" "$out"

# 8. Unsafe settings are refused ---------------------------------------------
out=$(TEST_HUB_URL=ws://dashboard.example.com/agent run_install "$SB" "$SRC"); code=$?
check '[[ $code -ne 0 ]] && grep -q "unencrypted" <<<"$out"' "plain ws:// to a public host refused" "$out"
out=$(run_install "$SB" "$SRC" SERVER_ROOT="/srv/x'; touch $WORK/pwned; '"); code=$?
check '[[ $code -ne 0 && ! -e "$WORK/pwned" ]]' "shell metacharacters in settings refused (no injection)" "$out"

# 9. Missing Node.js gives a clear error --------------------------------------
NONODE_PATH="$STUBS:/usr/bin:/bin:/mingw64/bin"
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$NONODE_PATH" NODE_INSTALL=skip HUB_URL=ws://127.0.0.1:9/agent AGENT_SOURCE_DIR="$SRC" bash "$SRC/install-host.sh" 2>&1); code=$?
check '[[ $code -ne 0 ]] && grep -q "Node.js 22+ is required" <<<"$out"' "missing Node.js reported clearly" "$out"

# 10. A failed fresh install leaves nothing behind ------------------------------
SB2="$(new_sandbox fresh-fail)"
out=$(run_install "$SB2" "$SRC" FAKE_NPM_FAIL=1); code=$?
check '[[ $code -ne 0 ]] && grep -q "npm ci failed" <<<"$out"' "dependency installation failure detected" "$out"
check '[[ ! -e "$SB2/opt/dashboard-agent" && ! -e "$SB2/opt/dashboard-agent.new" && ! -e "$SB2/etc/systemd/system/dashboard-agent.service" ]]' "no partial install or service left"

# 11. Uninstall keeps credentials; --purge removes them ------------------------
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$STUBS:$PATH" bash "$SRC/uninstall-host.sh" 2>&1); code=$?
check '[[ $code -eq 0 && ! -e "$SB/opt/dashboard-agent" && ! -e "$SB/etc/systemd/system/dashboard-agent.service" ]]' "uninstall removes the program and service" "$out"
check '! healthy "$SB" && [[ ! -s "$SB/run/dashboard-agent.pid" ]]' "agent process stopped"
check 'grep -q keep-me "$SB/var/lib/dashboard-agent/agent.json" && [[ -f "$SB/etc/dashboard-agent/agent.env" ]]' "credentials and settings kept by default"
mkdir -p "$SB/srv/unrelated-app"; echo data > "$SB/srv/unrelated-app/file"
rm -f "$SB/var/lib/dashboard-agent/agent.json"   # no hub to revoke against in this sandbox
out=$(env DASHBOARD_AGENT_TEST_ROOT="$SB" PATH="$STUBS:$PATH" bash "$SRC/uninstall-host.sh" --purge 2>&1); code=$?
check '[[ $code -eq 0 && ! -e "$SB/var/lib/dashboard-agent" && ! -e "$SB/etc/dashboard-agent" ]]' "--purge removes credentials and settings" "$out"
check '[[ -f "$SB/srv/unrelated-app/file" ]]' "unrelated data on the host is untouched"

# 12. The sandbox switch cannot be pointed at an arbitrary directory --------
out=$(DASHBOARD_AGENT_TEST_ROOT="$WORK" bash "$SRC/install-host.sh" 2>&1); code=$?
check '[[ $code -ne 0 ]] && grep -q "not a prepared test sandbox" <<<"$out"' "test root requires the sandbox marker" "$out"

echo "# pass $PASSES fail $FAILS"
[[ $FAILS -eq 0 ]]
