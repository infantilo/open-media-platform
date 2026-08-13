#!/usr/bin/env bash
# Stoppt den per start-supervisor.sh gestarteten omp-supervisor.
# Bewusst NICHT Teil von `make stop`/stop-omp.sh (der Supervisor soll
# einen normalen Orchestrator-Neustart überleben) — nur explizit
# aufgerufen oder über `make stop ARGS=--all`, gleiche Einordnung wie
# NATS/NMOS-Registry/Postgres dort.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="$ROOT_DIR/.run/supervisor.pid"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    for _ in $(seq 1 10); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "PID $PID reagiert nicht auf SIGTERM, sende SIGKILL." >&2
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Supervisor (PID $PID) gestoppt."
  else
    echo "Supervisor lief laut PID-Datei nicht mehr (PID $PID)."
  fi
  rm -f "$PID_FILE"
else
  echo "Kein PID-File — Supervisor vermutlich nicht gestartet."
fi
