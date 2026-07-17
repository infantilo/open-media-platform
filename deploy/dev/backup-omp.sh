#!/usr/bin/env bash
# Sichert die Postgres-Datenbank des Orchestrators (S9, docs/REVIEW-
# 2026-07-17-SKALIERUNG-24-7.md: "ein nie getesteter Restore ist
# keiner" — Gegenstück restore-omp.sh, live gegeneinander verifiziert,
# s. docs/decisions.md). `pg_dump` läuft über `podman exec` im
# omp-postgres-Container selbst (kein lokal installiertes
# postgresql-client-Paket vorausgesetzt, gleiches "ein Tool-Container
# statt Host-Installation"-Muster wie mtls-issue-cert.sh) — Ausgabe
# lokal mit gzip komprimiert nach .backups/<timestamp>.sql.gz.
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

if ! podman container exists omp-postgres; then
  echo "omp-postgres-Container existiert nicht — erst 'make up' starten." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/omp-$TIMESTAMP.sql.gz"
TMP_FILE="$OUT_FILE.tmp"

echo "==> Dump aus omp-postgres (Datenbank 'omp')"
# Erst in eine .tmp-Datei schreiben und danach umbenennen — ein
# abgebrochener Dump (Ctrl-C, volle Platte) darf keine unvollständige
# Datei unter dem finalen Namen hinterlassen, die restore-omp.sh später
# unbemerkt einspielen würde.
podman exec omp-postgres pg_dump -U omp --clean --if-exists omp | gzip > "$TMP_FILE"
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
