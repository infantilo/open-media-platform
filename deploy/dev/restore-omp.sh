#!/usr/bin/env bash
# Spielt eine Sicherung von backup-omp.sh zurück (S9, docs/REVIEW-
# 2026-07-17-SKALIERUNG-24-7.md). ÜBERSCHREIBT den kompletten aktuellen
# Inhalt der Datenbank 'omp' — verlangt deshalb:
#   1. eine interaktive Sicherheitsabfrage (exakt "yes" eingeben), und
#   2. dass der Orchestrator gestoppt ist (offene Verbindungen/parallele
#      Schreibzugriffe während eines Restores wären undefiniertes
#      Verhalten — der Dump enthält DROP-Anweisungen, ein noch laufender
#      Orchestrator würde mitten im Restore gegen bereits gelöschte
#      Tabellen laufen).
#
# Usage: restore-omp.sh <backup-datei.sql.gz>
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup-datei.sql.gz>" >&2
  echo "Verfügbare Sicherungen in $ROOT_DIR/.backups:" >&2
  ls -1t "$ROOT_DIR/.backups"/omp-*.sql.gz 2>/dev/null >&2 || echo "  (keine gefunden)" >&2
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Datei nicht gefunden: $BACKUP_FILE" >&2
  exit 1
fi

if ! podman container exists omp-postgres; then
  echo "omp-postgres-Container existiert nicht — erst 'make up' starten." >&2
  exit 1
fi

# Port-Check statt nur der PID-Datei — gleiches Muster wie start-omp.sh:
# ein per Hand oder in einer anderen Sitzung gestarteter Orchestrator,
# der der PID-Datei nicht bekannt ist, muss trotzdem erkannt werden.
if curl -fs http://localhost:8000/healthz > /dev/null 2>&1; then
  echo "Der Orchestrator läuft noch (Port 8000 antwortet)." >&2
  echo "Erst stoppen: make stop" >&2
  exit 1
fi

echo "ACHTUNG: Dies überschreibt ALLE aktuellen Daten in der Datenbank 'omp'" >&2
echo "(Nutzer, Rollenbindungen, Audit-Log, Layouts, Snapshots, Workflows, Hosts)" >&2
echo "mit dem Stand aus: $BACKUP_FILE" >&2
echo "" >&2
read -r -p "Zum Bestätigen exakt \"yes\" eingeben: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Abgebrochen — keine Änderung vorgenommen." >&2
  exit 1
fi

echo "==> Restore nach omp-postgres (Datenbank 'omp')"
gunzip -c "$BACKUP_FILE" | podman exec -i omp-postgres psql -U omp -v ON_ERROR_STOP=1 -q omp

echo "==> Restore abgeschlossen aus: $BACKUP_FILE"
