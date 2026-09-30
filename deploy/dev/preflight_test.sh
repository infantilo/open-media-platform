#!/usr/bin/env bash
# Regressionstest für preflight.sh: prüft das Verhalten an den Stellen, an
# denen eine Erstinstallation tatsächlich scheitert (fehlende Werkzeuge,
# belegter Port, Optionen, JSON-Ausgabe) — ohne etwas zu installieren oder
# den laufenden Stack anzufassen. Aufruf: ./deploy/dev/preflight_test.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PF="$ROOT_DIR/deploy/dev/preflight.sh"
FAILS=0
check() { # name, Bedingung als Kommando
  local name="$1"; shift
  if "$@"; then echo "  ok   $name"; else echo "  FAIL $name"; FAILS=$((FAILS+1)); fi
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [ -n "${LISTENER:-}" ] && kill "$LISTENER" 2>/dev/null' EXIT

# 1) Optionen
"$PF" --help >/dev/null 2>&1;            check "--help beendet mit 0" [ $? -eq 0 ]
"$PF" --bogus >/dev/null 2>&1;           check "unbekannte Option beendet mit 2" [ $? -eq 2 ]
"$PF" --for=quatsch >/dev/null 2>&1;     check "ungültiger --for-Wert beendet mit 2" [ $? -eq 2 ]

# 2) Fehlende Werkzeuge: PATH nur mit Grundwerkzeugen (ohne go/deno/podman/make/openssl/git)
BIN="$TMP/bin"; mkdir -p "$BIN"
for t in bash sh sed awk grep ls head tail tr sort df nproc uname id printf cat date mkdir wc cut dirname basename ss curl apt-get find readlink env test true false; do
  p="$(type -P "$t")" && ln -sf "$p" "$BIN/$t"
done
OUT="$(PATH="$BIN" NO_COLOR=1 PREFLIGHT_PORTS="" "$PF" --for=start 2>&1)"; RC=$?
check "fehlende Werkzeuge → Exit 1" [ "$RC" -eq 1 ]
check "meldet fehlendes Go"     grep -q "Go nicht gefunden" <<<"$OUT"
check "meldet fehlendes Deno"   grep -q "Deno nicht gefunden" <<<"$OUT"
check "meldet fehlendes Podman" grep -q "podman nicht gefunden" <<<"$OUT"
check "nennt Zusammenfassung mit Fehlerzahl" grep -Eq "[0-9]+ Fehler" <<<"$OUT"
if [ -x "$BIN/apt-get" ]; then
  check "nennt Installationsbefehl (apt)" grep -q "sudo apt-get install -y podman" <<<"$OUT"
fi

# 3) Belegter Port eines fremden Prozesses
if command -v python3 >/dev/null 2>&1 && command -v ss >/dev/null 2>&1; then
  python3 -c "
import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',0)); print(s.getsockname()[1],flush=True); s.listen(); time.sleep(20)" >"$TMP/port" &
  LISTENER=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/port" ] && break; sleep 0.2; done
  PORT="$(cat "$TMP/port")"
  OUT="$(PREFLIGHT_PORTS="$PORT:Testdienst" NO_COLOR=1 "$PF" --for=start --quiet 2>&1)"; RC=$?
  check "belegter Port → Exit 1" [ "$RC" -eq 1 ]
  check "belegter Port wird mit Namen gemeldet" grep -q "Port $PORT (Testdienst) ist belegt" <<<"$OUT"
  kill "$LISTENER" 2>/dev/null; wait "$LISTENER" 2>/dev/null; LISTENER=""
  OUT="$(PREFLIGHT_PORTS="$PORT:Testdienst" NO_COLOR=1 "$PF" --for=start --quiet 2>&1)"
  check "freigegebener Port ist kein Fehler mehr" bash -c '! grep -q "ist belegt" <<<"$0"' "$OUT"
fi

# 4) JSON-Ausgabe ist gültig
if command -v python3 >/dev/null 2>&1; then
  PREFLIGHT_PORTS="" "$PF" --for=start --json 2>/dev/null | python3 -c "
import sys,json
lines=[json.loads(l) for l in sys.stdin if l.strip()]
assert lines and 'summary' in lines[-1]
assert all('level' in l for l in lines[:-1])"
  check "--json liefert gültiges JSON mit Zusammenfassung" [ $? -eq 0 ]
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "preflight_test: alle Prüfungen bestanden"; else echo "preflight_test: $FAILS Prüfung(en) fehlgeschlagen"; exit 1; fi
