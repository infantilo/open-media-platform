#!/usr/bin/env bash
# Stoppt den per start-omp.sh gestarteten Orchestrator-Prozess.
# `./stop-omp.sh --all` stoppt zusätzlich NATS + NMOS-Registry (make down).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="$ROOT_DIR/.run/orchestrator.pid"

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
    echo "Orchestrator (PID $PID) gestoppt."
  else
    echo "Orchestrator lief laut PID-Datei nicht mehr (PID $PID)."
  fi
  rm -f "$PID_FILE"
else
  echo "Kein PID-File — Orchestrator vermutlich nicht über start-omp.sh gestartet."
fi

# Verifikation statt blindem Vertrauen auf die PID-Datei: falls trotzdem
# noch etwas auf Port 8000 lauscht (z. B. ein verwaister Prozess aus einer
# fehlgeschlagenen früheren Sitzung, siehe start-omp.sh-Kommentar zur
# PID-Subshell-Falle), das explizit melden statt es zu verschweigen.
if curl -fs http://localhost:8000/healthz > /dev/null 2>&1; then
  echo "" >&2
  echo "Achtung: Port 8000 antwortet weiterhin — vermutlich ein Prozess," >&2
  echo "der nicht über die PID-Datei bekannt war. Manuell prüfen:" >&2
  echo "  ss -ltnp | grep 8000" >&2
fi

if [ "${1:-}" = "--all" ]; then
  echo "==> NATS + NMOS-Registry stoppen"
  make -C "$ROOT_DIR" down
fi
