#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${NC_TEST_PORT:-8801}"
MARIONETTE_PORT="${NC_TEST_MARIONETTE_PORT:-2841}"
FIREFOX_BIN="${FIREFOX_BIN:-firefox}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SCRATCH_ROOT="${NC_TEST_TMP:-${RUNNER_TEMP:-/home/opencode/tmp/nextcloud-bookmarks}/integration}"
mkdir -p "$(dirname "$SCRATCH_ROOT")"
SCRATCH="$(mktemp -d "$SCRATCH_ROOT.XXXXXX")"

MOCK_PID=""
FIREFOX_PID=""

cleanup() {
  if [[ -n "$FIREFOX_PID" ]] && kill -0 "$FIREFOX_PID" 2>/dev/null; then
    kill "$FIREFOX_PID" 2>/dev/null || true
    wait "$FIREFOX_PID" 2>/dev/null || true
  fi
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  if [[ -n "${NC_TEST_KEEP:-}" ]]; then
    echo "kept: $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

require_port_free() {
  local port="$1"
  local label="$2"
  if "$PYTHON_BIN" - "$port" <<'PY'
import socket
import sys
sock = socket.socket()
sock.settimeout(0.2)
sys.exit(0 if sock.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0 else 1)
PY
  then
    echo "refusing to use $label port $port: already in use" >&2
    exit 1
  fi
}

mkdir -p "$SCRATCH_ROOT"

require_port_free "$PORT" "mock server"
require_port_free "$MARIONETTE_PORT" "Marionette"

PORT="$PORT" node "$ROOT/test/integration/mock-server.mjs" >"$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/__state" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/__state" >/dev/null

node "$ROOT/test/integration/build-test-extension.mjs" --out "$SCRATCH/extension" >/dev/null
(cd "$SCRATCH/extension" && zip -qr "$SCRATCH/extension.xpi" .)

mkdir -p "$SCRATCH/profile"
cat >"$SCRATCH/profile/user.js" <<EOF
user_pref("marionette.port", $MARIONETTE_PORT);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 0);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("extensions.webextensions.restrictedDomains", "");
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
EOF

MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 "$FIREFOX_BIN" --headless --marionette --remote-allow-system-access --profile "$SCRATCH/profile" --no-remote about:blank >"$SCRATCH/firefox.log" 2>&1 &
FIREFOX_PID=$!

EXT_XPI="$SCRATCH/extension.xpi" \
MARIONETTE_PORT="$MARIONETTE_PORT" \
BASE_URL="http://127.0.0.1:$PORT" \
"$PYTHON_BIN" "$ROOT/test/integration/run.py"

echo "integration workspace: $SCRATCH"
