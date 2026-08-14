#!/usr/bin/env bash
# Startet die simulierten Host-Agents für die Multi-Host-Dev-Konfiguration
# (zwei omp-host-agent-Prozesse auf derselben Maschine, "Regie-Host-A"/
# "Regie-Host-B", docs/decisions.md 2026-08-13 ff., Nutzerfrage 2026-08-14
# "wie starte ich das nächste Mal in der aktuellen Multi-Host-
# Konfiguration"). Bewusst NICHT Teil von start-omp.sh/`make start` —
# Multi-Host ist Opt-in (nicht jede Sitzung braucht zwei simulierte
# Hosts), gleiche Einordnung wie start-supervisor.sh.
#
# Host-Identität bleibt über `.run/host<N>/state.json` über Neustarts
# hinweg stabil (host-agent/main.go persistiert Host-ID+Label dorthin
# und liest sie beim nächsten Start wieder ein) — ein zweiter Aufruf
# registriert wieder DIESELBEN zwei Hosts (gleiche Host-IDs, an die
# bestehende Zonen-Zuordnungen/Workflows anknüpfen), keine neuen.
# Idempotent wie start-omp.sh/start-supervisor.sh: bereits laufende
# Agents werden übersprungen, kein Fehler.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT_DIR/bin/omp-host-agent"
CATALOG="/tmp/host-catalog.json"

mkdir -p "$ROOT_DIR/bin"

# /tmp ist tmpfs und überlebt einen Neustart nicht (gleicher Grund wie
# OMP_MXL_DOMAIN in start-omp.sh) — deploy/catalog.json ist bereits die
# Quelle der Wahrheit für den Instanz-Launcher (make start setzt
# OMP_CATALOG_PATH darauf), hier nur eine Kopie für die Host-Agents
# (die ihren eigenen, host-lokalen Katalog-Pfad lesen, s. host-agent/
# main.go OMP_HOST_AGENT_CATALOG_PATH).
cp "$ROOT_DIR/deploy/catalog.json" "$CATALOG"

echo "==> Host-Agent-Binary bauen"
( cd "$ROOT_DIR/host-agent" && go build -o "$BIN" . )

# id:label je simuliertem Host — bei Bedarf hier erweitern (dritter Host
# etc.). Das Verzeichnis .run/<id> muss zum bereits persistierten
# state.json passen, sonst registriert sich ein NEUER Host statt des
# bekannten.
HOSTS=(
  "host1:Regie-Host-A"
  "host2:Regie-Host-B"
)

for entry in "${HOSTS[@]}"; do
  dir="${entry%%:*}"
  label="${entry#*:}"
  RUN_DIR="$ROOT_DIR/.run/$dir"
  PID_FILE="$RUN_DIR/pid"
  LOG_FILE="$RUN_DIR/agent.log"
  STATE_FILE="$RUN_DIR/state.json"
  mkdir -p "$RUN_DIR"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Host-Agent $label ($dir) läuft bereits (PID $(cat "$PID_FILE"))."
    continue
  fi

  echo "==> Host-Agent $label ($dir) starten"
  OMP_HOST_AGENT_STATE_FILE="$STATE_FILE" \
  OMP_HOST_AGENT_LABEL="$label" \
  OMP_HOST_AGENT_CATALOG_PATH="$CATALOG" \
  nohup "$BIN" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  # Nutzerfund (Live-Test 2026-08-14): bei bereits per state.json
  # bekannter Host-Identität loggt host-agent/main.go NICHT
  # "registered", sondern "already registered, resuming telemetry" —
  # "listening for commands" ist das einzige Signal, das in BEIDEN
  # Fällen (Erstregistrierung UND Wiederaufnahme) sicher erscheint.
  printf "    Warte auf Bereitschaft "
  ok=0
  for _ in $(seq 1 20); do
    if grep -qF '"msg":"listening for commands"' "$LOG_FILE" 2>/dev/null; then
      ok=1
      break
    fi
    printf "."
    sleep 0.5
  done
  if [ "$ok" = "1" ]; then
    echo "OK (PID $(cat "$PID_FILE"))"
  else
    echo ""
    echo "Host-Agent $label wurde nach 10s nicht registriert — siehe $LOG_FILE" >&2
    exit 1
  fi
done

echo ""
echo "Beide Host-Agents laufen. Logs: .run/host1/agent.log, .run/host2/agent.log"
echo "Stoppen mit: deploy/dev/stop-hosts.sh"
