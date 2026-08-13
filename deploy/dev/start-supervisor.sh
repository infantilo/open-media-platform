#!/usr/bin/env bash
# Startet omp-supervisor (Nutzerwunsch 2026-08-13: "generelles Backup/
# Restore über das Browser-UI") — der einzige Prozess, der den
# Orchestrator für einen Restore stoppen/starten darf, s. supervisor/
# main.go Kopfkommentar. Bewusst NICHT Teil von start-omp.sh/
# stop-omp.sh: der Supervisor muss den Orchestrator-Neustart
# UNABHÄNGIG überleben (genau dafür existiert er). Idempotent wie
# start-omp.sh — ein zweiter Aufruf bei bereits laufendem Supervisor
# ist kein Fehler.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/supervisor.pid"
LOG_FILE="$RUN_DIR/supervisor.log"
BIN="$ROOT_DIR/bin/omp-supervisor"
LISTEN="${OMP_SUPERVISOR_LISTEN:-127.0.0.1:8091}"

mkdir -p "$RUN_DIR" "$ROOT_DIR/bin"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Supervisor läuft bereits (PID $(cat "$PID_FILE"))."
  exit 0
fi

# Gleicher Grund wie start-omp.shs Port-Check: ein per Hand oder in
# einer früheren Sitzung gestarteter, vom PID-File nicht mehr erfasster
# Prozess auf diesem Port würde sonst unbemerkt weiterlaufen, während
# hier ein zweiter, konkurrierender Supervisor entsteht.
if curl -fs "http://$LISTEN/status" > /dev/null 2>&1; then
  echo "Auf $LISTEN antwortet bereits ein Prozess, der nicht über" >&2
  echo "start-supervisor.sh/PID-Datei bekannt ist (verwaister Prozess?)." >&2
  echo "Prüfen mit: ss -ltnp | grep ${LISTEN##*:}  — dann gezielt beenden." >&2
  exit 1
fi

echo "==> Supervisor-Binary bauen"
( cd "$ROOT_DIR/supervisor" && go build -o "$BIN" . )

echo "==> Supervisor starten"
export OMP_ROOT_DIR="$ROOT_DIR"
export OMP_BACKUP_DIR="$ROOT_DIR/.backups"
export OMP_SUPERVISOR_LISTEN="$LISTEN"
nohup "$BIN" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

printf "==> Warte auf Supervisor "
for _ in $(seq 1 20); do
  if curl -fs "http://$LISTEN/status" > /dev/null 2>&1; then
    echo "OK"
    echo "Supervisor läuft: http://$LISTEN (nur lokal erreichbar)"
    echo "Log:  $LOG_FILE"
    echo "PID:  $(cat "$PID_FILE")"
    exit 0
  fi
  printf "."
  sleep 0.5
done

echo ""
echo "Supervisor wurde nach 10s nicht erreichbar — siehe $LOG_FILE" >&2
exit 1
