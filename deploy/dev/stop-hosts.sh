#!/usr/bin/env bash
# Stoppt die per start-hosts.sh gestarteten simulierten Host-Agents.
# Bewusst NICHT Teil von stop-omp.sh/`make stop` (Multi-Host ist
# Opt-in) — nur explizit aufgerufen oder über `make stop ARGS=--all`,
# gleiche Einordnung wie stop-supervisor.sh dort. Lässt `.run/host<N>/
# state.json` unangetastet (Host-Identität bleibt für den nächsten
# start-hosts.sh-Aufruf erhalten).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for dir in host1 host2; do
  PID_FILE="$ROOT_DIR/.run/$dir/pid"
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$PID" 2>/dev/null; then
        echo "PID $PID ($dir) reagiert nicht auf SIGTERM, sende SIGKILL." >&2
        kill -9 "$PID" 2>/dev/null || true
      fi
      echo "Host-Agent $dir (PID $PID) gestoppt."
    else
      echo "Host-Agent $dir lief laut PID-Datei nicht mehr (PID $PID)."
    fi
    rm -f "$PID_FILE"
  else
    echo "Kein PID-File für $dir — Host-Agent vermutlich nicht gestartet."
  fi
done
