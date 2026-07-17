#!/usr/bin/env bash
# Startet die komplette Dev-Umgebung: NATS + NMOS-Registry (Podman, make up),
# baut die UI und den Orchestrator, startet ihn als Hintergrundprozess und
# wartet auf /healthz. Gegenstück: stop-omp.sh (bzw. `make stop`).
#
# Node-Contract-Nodes (Mock, omp-source/-viewer/-switcher, ...) werden
# bewusst NICHT hier gestartet — das übernimmt der Instanz-Launcher aus der
# GUI (UMSETZUNG.md C8), sobald der Orchestrator läuft.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/orchestrator.pid"
LOG_FILE="$RUN_DIR/orchestrator.log"
BIN="$ROOT_DIR/bin/omp-orchestrator"

mkdir -p "$RUN_DIR" "$ROOT_DIR/bin"

# /dev/shm ist tmpfs und überlebt einen Neustart/eine Bereinigung nicht
# (docs/decisions.md, 2026-07-17) — ohne dieses Verzeichnis schlägt jeder
# MXL-Node-Start mit "Domain path is not a directory" fehl, bis jemand es
# von Hand anlegt.
mkdir -p "${OMP_MXL_DOMAIN:-/dev/shm/omp-mxl}"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Orchestrator läuft bereits (PID $(cat "$PID_FILE"))." >&2
  echo "Erst stoppen: make stop" >&2
  exit 1
fi

# Port-Check statt nur PID-Datei: ein per Hand oder in einer früheren
# Sitzung gestarteter, vom PID-File nicht mehr erfasster Prozess auf
# Port 8000 würde sonst dazu führen, dass der /healthz-Check unten gegen
# den FREMDEN Prozess "erfolgreich" ist, während der neu gestartete
# eigentlich mit "address already in use" sofort wieder beendet wurde.
if curl -fs http://localhost:8000/healthz > /dev/null 2>&1; then
  echo "Auf Port 8000 antwortet bereits ein Prozess, der nicht über" >&2
  echo "start-omp.sh/PID-Datei bekannt ist (verwaister Prozess?)." >&2
  echo "Prüfen mit: ss -ltnp | grep 8000  — dann gezielt beenden." >&2
  exit 1
fi

echo "==> NATS + NMOS-Registry (Podman, make up)"
make -C "$ROOT_DIR" up

echo "==> UI-Bundle bauen"
make -C "$ROOT_DIR" ui

echo "==> Orchestrator-Binary bauen"
( cd "$ROOT_DIR/orchestrator" && go build -o "$BIN" . )

echo "==> Orchestrator starten"
# Absolute Pfade statt cd+relativer Defaults (orchestrator/internal/config/
# config.go: OMP_UI_DIR=../ui etc. sind relativ zum cwd gedacht) — so kann
# der Prozess ohne umschließende "cd && ..."-Subshell gestartet werden.
# Wichtig für eine korrekte PID: ein backgroundetes "cd X && CMD &" backgroundet
# die GANZE "&&"-Kette in einer eigenen Subshell, wodurch $! auf deren
# Wrapper-PID zeigt statt auf den tatsächlichen Prozess — genau der Fehler,
# der `make stop` vorher den falschen Prozess killen ließ (Log/PID-Datei
# stimmten dann nicht mit dem tatsächlichen Port-Owner überein).
export OMP_UI_DIR="$ROOT_DIR/ui"
export OMP_CATALOG_PATH="$ROOT_DIR/deploy/catalog.json"
# mTLS (UMSETZUNG.md D3) ist per Default aus (OMP_MTLS_ENABLED unten nur
# gesetzt, falls schon in der aufrufenden Shell exportiert) — die
# Pfad-Variablen selbst müssen trotzdem immer absolut sein, aus demselben
# Grund wie oben (relative Defaults gelten für orchestrator/ als cwd).
export OMP_MTLS_CERT_FILE="${OMP_MTLS_CERT_FILE:-$ROOT_DIR/.run/mtls/orchestrator.crt}"
export OMP_MTLS_KEY_FILE="${OMP_MTLS_KEY_FILE:-$ROOT_DIR/.run/mtls/orchestrator.key}"
export OMP_MTLS_CA_FILE="${OMP_MTLS_CA_FILE:-$ROOT_DIR/.run/mtls/root_ca.crt}"
nohup "$BIN" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

printf "==> Warte auf /healthz "
for _ in $(seq 1 30); do
  if curl -fs http://localhost:8000/healthz > /dev/null 2>&1; then
    echo "OK"
    echo ""
    echo "Orchestrator läuft: http://localhost:8000"
    echo "Log:  $LOG_FILE"
    echo "PID:  $(cat "$PID_FILE")"
    echo "Stoppen mit: make stop"
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "Orchestrator wurde nach 30s nicht healthy — siehe $LOG_FILE" >&2
exit 1
