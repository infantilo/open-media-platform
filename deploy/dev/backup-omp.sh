#!/usr/bin/env bash
# Sichert die Postgres-Datenbank des Orchestrators (S9, docs/REVIEW-
# 2026-07-17-SKALIERUNG-24-7.md: "ein nie getesteter Restore ist
# keiner" — Gegenstück restore-omp.sh, live gegeneinander verifiziert,
# s. docs/decisions.md). `pg_dump` läuft über `podman exec` im gerade
# aktuellen Patroni-Primary-Container (kein lokal installiertes
# postgresql-client-Paket vorausgesetzt, gleiches "ein Tool-Container
# statt Host-Installation"-Muster wie mtls-issue-cert.sh) — Ausgabe
# lokal mit gzip komprimiert nach .backups/<timestamp>.sql.gz.
#
# Seit D15 (ARCHITECTURE.md §19.3, Postgres-HA via Patroni) gibt es
# keinen festen "omp-postgres"-Container mehr — welcher der drei Knoten
# (omp-patroni-1/2/3, Makefile postgres-up) gerade Primary ist, wechselt
# bei jedem Failover. resolve_primary() unten fragt deshalb bei jedem
# Lauf neu über Patronis eigene REST-API (`GET .../cluster`, liefert
# Name/Rolle/Port aller Mitglieder) nach, statt einen Knoten fest
# anzunehmen — dieselbe Logik wie orchestrator/internal/backup.go und
# supervisor/main.go (dort in Go, hier in Bash dupliziert, gleiches
# "eigenständiges Werkzeug, keine gemeinsame Bibliothek nötig"-Muster
# wie die übrigen Duplikationen in diesem Projekt).
#
# --clean --if-exists: der Dump enthält DROP-Anweisungen vor jedem
# CREATE, damit restore-omp.sh ihn gegen eine bereits befüllte
# Datenbank abspielen kann (vollständiger Ersatz des Inhalts statt
# eines Fehlschlags wegen bereits existierender Tabellen/Primärschlüssel-
# Konflikten) — keine separate dropdb/createdb-Runde nötig.
#
# Rotation: die letzten BACKUP_KEEP=14 Sicherungen bleiben erhalten,
# ältere werden nach einem erfolgreichen neuen Dump gelöscht (nicht
# vorher — ein fehlgeschlagener Dump darf nie die letzte funktionierende
# Sicherung kosten).
#
# Usage: backup-omp.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="$ROOT_DIR/.backups"
BACKUP_KEEP=14
PATRONI_REST_URLS="http://127.0.0.1:8008 http://127.0.0.1:8018 http://127.0.0.1:8028"

# resolve_primary fragt jede REST-API nacheinander nach der vollen
# Cluster-Topologie (`/cluster`) und gibt "container port" des ersten
# gefundenen "leader"-Mitglieds aus — reicht bereits eine erreichbare
# REST-API, die anderen Knoten müssen dafür selbst nicht erreichbar sein.
resolve_primary() {
  for url in $PATRONI_REST_URLS; do
    result="$(curl -fs "$url/cluster" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for m in d.get("members", []):
    if m.get("role") == "leader":
        print(m["name"], m["port"])
        sys.exit(0)
sys.exit(1)
' 2>/dev/null)" || continue
    if [ -n "$result" ]; then
      echo "$result"
      return 0
    fi
  done
  return 1
}

PRIMARY_INFO="$(resolve_primary)" || {
  echo "Kein Patroni-Primary erreichbar — erst 'make up' starten." >&2
  exit 1
}
PRIMARY_CONTAINER="$(echo "$PRIMARY_INFO" | cut -d' ' -f1)"
PRIMARY_PORT="$(echo "$PRIMARY_INFO" | cut -d' ' -f2)"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/omp-$TIMESTAMP.sql.gz"
TMP_FILE="$OUT_FILE.tmp"

echo "==> Dump aus $PRIMARY_CONTAINER:$PRIMARY_PORT (Datenbank 'omp', aktueller Primary)"
# Erst in eine .tmp-Datei schreiben und danach umbenennen — ein
# abgebrochener Dump (Ctrl-C, volle Platte) darf keine unvollständige
# Datei unter dem finalen Namen hinterlassen, die restore-omp.sh später
# unbemerkt einspielen würde.
podman exec "$PRIMARY_CONTAINER" pg_dump -h 127.0.0.1 -p "$PRIMARY_PORT" -U omp --clean --if-exists omp | gzip > "$TMP_FILE"
mv "$TMP_FILE" "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "==> Backup geschrieben: $OUT_FILE ($SIZE)"

echo "==> Rotation (behalte die letzten $BACKUP_KEEP)"
# ls -1t: neueste zuerst; tail -n +N+1 überspringt die ersten N
# (aktuellsten) und listet den Rest zum Löschen.
mapfile -t OLD_BACKUPS < <(ls -1t "$BACKUP_DIR"/omp-*.sql.gz 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))")
if [ "${#OLD_BACKUPS[@]}" -gt 0 ]; then
  printf '    entferne %s\n' "${OLD_BACKUPS[@]}"
  rm -f -- "${OLD_BACKUPS[@]}"
else
  echo "    nichts zu entfernen ($(ls -1 "$BACKUP_DIR"/omp-*.sql.gz 2>/dev/null | wc -l) Sicherung(en) vorhanden)"
fi
