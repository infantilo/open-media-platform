#!/usr/bin/env bash
# Regression test for preflight.sh: checks the behavior at the points where a
# first installation actually fails (missing tools, occupied port, options,
# JSON output) — without installing anything or touching the running stack.
# Usage: ./deploy/dev/preflight_test.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PF="$ROOT_DIR/deploy/dev/preflight.sh"
FAILS=0
check() { # name, condition as a command
  local name="$1"; shift
  if "$@"; then echo "  ok   $name"; else echo "  FAIL $name"; FAILS=$((FAILS+1)); fi
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [ -n "${LISTENER:-}" ] && kill "$LISTENER" 2>/dev/null' EXIT

# 1) Options
"$PF" --help >/dev/null 2>&1;            check "--help exits with 0" [ $? -eq 0 ]
"$PF" --bogus >/dev/null 2>&1;           check "unknown option exits with 2" [ $? -eq 2 ]
"$PF" --for=quatsch >/dev/null 2>&1;     check "invalid --for value exits with 2" [ $? -eq 2 ]

# 2) Missing tools: PATH with basic tools only (without go/deno/podman/make/openssl/git)
BIN="$TMP/bin"; mkdir -p "$BIN"
for t in bash sh sed awk grep ls head tail tr sort df nproc uname id printf cat date mkdir wc cut dirname basename ss curl apt-get find readlink env test true false; do
  p="$(type -P "$t")" && ln -sf "$p" "$BIN/$t"
done
OUT="$(PATH="$BIN" NO_COLOR=1 PREFLIGHT_PORTS="" "$PF" --for=start 2>&1)"; RC=$?
check "missing tools → exit 1" [ "$RC" -eq 1 ]
check "reports missing Go"     grep -q "Go not found" <<<"$OUT"
check "reports missing Deno"   grep -q "Deno not found" <<<"$OUT"
check "reports missing Podman" grep -q "podman not found" <<<"$OUT"
check "prints summary with error count" grep -Eq "[0-9]+ error" <<<"$OUT"
if [ -x "$BIN/apt-get" ]; then
  check "prints install command (apt)" grep -q "sudo apt-get install -y podman" <<<"$OUT"
fi

# 3) Port occupied by a foreign process
if command -v python3 >/dev/null 2>&1 && command -v ss >/dev/null 2>&1; then
  python3 -c "
import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',0)); print(s.getsockname()[1],flush=True); s.listen(); time.sleep(20)" >"$TMP/port" &
  LISTENER=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/port" ] && break; sleep 0.2; done
  PORT="$(cat "$TMP/port")"
  OUT="$(PREFLIGHT_PORTS="$PORT:Testdienst" NO_COLOR=1 "$PF" --for=start --quiet 2>&1)"; RC=$?
  check "occupied port → exit 1" [ "$RC" -eq 1 ]
  check "occupied port is reported by name" grep -q "Port $PORT (Testdienst) is in use" <<<"$OUT"
  kill "$LISTENER" 2>/dev/null; wait "$LISTENER" 2>/dev/null; LISTENER=""
  OUT="$(PREFLIGHT_PORTS="$PORT:Testdienst" NO_COLOR=1 "$PF" --for=start --quiet 2>&1)"
  check "released port is no longer an error" bash -c '! grep -q "is in use" <<<"$0"' "$OUT"
fi

# 4) JSON output is valid
if command -v python3 >/dev/null 2>&1; then
  PREFLIGHT_PORTS="" "$PF" --for=start --json 2>/dev/null | python3 -c "
import sys,json
lines=[json.loads(l) for l in sys.stdin if l.strip()]
assert lines and 'summary' in lines[-1]
assert all('level' in l for l in lines[:-1])"
  check "--json yields valid JSON with a summary" [ $? -eq 0 ]
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "preflight_test: all checks passed"; else echo "preflight_test: $FAILS check(s) failed"; exit 1; fi
