#!/bin/sh
# Wiederherstellung auf einen Zeitpunkt (PostgreSQL "Continuous Archiving and Point-in-Time Recovery", Version 16).
# Läuft im Patroni-Container; Ablage: $OMP_PG_ARCHIVE (Standard /archive), am besten auf einem anderen Rechner.
#
#   pitr.sh archive <%p> <%f>       als archive_command
#   pitr.sh backup                  Basissicherung anlegen, alte aufräumen (OMP_PG_BASE_KEEP, Standard 7)
#   pitr.sh list                    vorhandene Basissicherungen
#   pitr.sh restore <Zeit> <Datei>  Stand zum Zeitpunkt (z. B. "2026-11-28 14:05:00+01") als .sql.gz ausgeben
#
# restore fasst den laufenden Cluster nicht an: es baut in einem Wegwerfverzeichnis einen eigenen Postgres auf und
# schreibt einen Dump, der sich wie jede Sicherung zurückspielen lässt (make restore ARGS=<Datei>).
set -eu

ARCHIVE="${OMP_PG_ARCHIVE:-/archive}"
WAL="$ARCHIVE/wal"
BASE="$ARCHIVE/base"

die() { echo "pitr: $*" >&2; exit 1; }

# Als root gestartet (podman exec): zum Postgres-Benutzer wechseln, pg_ctl verweigert root.
as_postgres() {
  if [ "$(id -u)" = 0 ]; then exec su-exec postgres "$0" "$@"; fi
}

cmd="${1:-}"
[ $# -gt 0 ] && shift

case "$cmd" in
archive)
  [ $# = 2 ] || die "archive <Pfad> <Dateiname>"
  mkdir -p "$WAL"
  # Vorhandene Segmente nie überschreiben; dieselbe Datei erneut ist Erfolg (Wiederholung nach Absturz).
  if [ -f "$WAL/$2" ]; then cmp -s "$1" "$WAL/$2" && exit 0; die "$2 liegt bereits mit anderem Inhalt im Archiv"; fi
  tmp="$WAL/.$2.$$"
  trap 'rm -f "$tmp"' EXIT
  cp "$1" "$tmp"
  sync "$tmp"
  mv "$tmp" "$WAL/$2"
  sync "$WAL"
  ;;
backup)
  as_postgres backup
  keep="${OMP_PG_BASE_KEEP:-7}"
  [ "$keep" -ge 1 ] || die "OMP_PG_BASE_KEEP muss mindestens 1 sein"
  mkdir -p "$BASE" "$WAL"
  name="$(date -u +%Y%m%dT%H%M%SZ)"
  PGPASSWORD="${PATRONI_SUPERUSER_PASSWORD:?PATRONI_SUPERUSER_PASSWORD fehlt}" pg_basebackup \
    -h 127.0.0.1 -p "${OMP_PG_PORT:-5432}" -U "${PATRONI_SUPERUSER_USERNAME:-postgres}" \
    -D "$BASE/.$name" -Ft -z -X stream --checkpoint=fast
  # Erstes dafür nötige WAL-Segment merken (steht in backup_label), daran hängt das Aufräumen.
  start="$(tar -xzOf "$BASE/.$name/base.tar.gz" backup_label | sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]*\))$/\1/p')"
  [ -n "$start" ] || die "Startsegment der Sicherung nicht ermittelt"
  echo "$start" > "$BASE/.$name/start-wal"
  mv "$BASE/.$name" "$BASE/$name"
  echo "Basissicherung $BASE/$name (ab $start)"
  # Alte Basissicherungen und die dafür nicht mehr nötigen Segmente löschen.
  ls -1 "$BASE" | sort -r | tail -n +"$((keep + 1))" | while read -r old; do rm -rf "${BASE:?}/$old"; echo "entfernt: $old"; done
  oldest="$(ls -1 "$BASE" | sort | head -n 1)"
  pg_archivecleanup "$WAL" "$(cat "$BASE/$oldest/start-wal")"
  ;;
list)
  ls -1 "$BASE" 2>/dev/null | sort
  ;;
restore)
  as_postgres restore "$@"
  [ $# = 2 ] || die 'restore "<Zeitpunkt mit Zeitzone>" <Ausgabe.sql.gz>'
  target="$1"; out="$2"
  case "$target" in *"'"*) die "Zeitpunkt darf kein ' enthalten" ;; esac
  # Jüngste Basissicherung, die vor dem Zeitpunkt fertig war.
  want="$(date -u -d "$(echo "$target" | sed 's/[+-][0-9:]*$//')" +%s 2>/dev/null)" || die "Zeitpunkt nicht lesbar: $target"
  offset="$(echo "$target" | sed -n 's/.*\([+-]\)\([0-9][0-9]\):\{0,1\}\([0-9][0-9]\)\{0,1\}$/\1 \2 \3/p')"
  [ -n "$offset" ] || die "Zeitzone fehlt (z. B. +01 oder +00:00)"
  set -- $offset
  secs=$(( (1${2} - 100) * 3600 + (1${3:-00} - 100) * 60 ))
  if [ "$1" = + ]; then want=$((want - secs)); else want=$((want + secs)); fi
  limit="$(date -u -d "@$want" +%Y%m%dT%H%M%SZ)"
  chosen=""
  for b in $(ls -1 "$BASE" | sort); do
    # Der Name ist der Beginn der Sicherung; backup_manifest wird an ihrem Ende geschrieben.
    done_at="$(date -u -r "$BASE/$b/backup_manifest" +%Y%m%dT%H%M%SZ)"
    [ "$(printf '%s\n%s\n' "$done_at" "$limit" | sort | head -n 1)" = "$done_at" ] && chosen="$b"
  done
  [ -n "$chosen" ] || die "keine Basissicherung vor $target (vorhanden: $(ls -1 "$BASE" | tr '\n' ' '))"
  work="$(mktemp -d /tmp/pitr.XXXXXX)"
  data="$work/data"
  trap 'pg_ctl -D "$data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
  mkdir -m 700 "$data"
  tar -xzf "$BASE/$chosen/base.tar.gz" -C "$data"
  tar -xzf "$BASE/$chosen/pg_wal.tar.gz" -C "$data/pg_wal"
  rm -f "$data/standby.signal" "$data/postmaster.pid"
  : > "$data/recovery.signal"
  echo "local all all trust" > "$work/pg_hba.conf"
  cat >> "$data/postgresql.auto.conf" <<EOF
restore_command = 'cp "$WAL/%f" "%p"'
recovery_target_time = '$target'
recovery_target_action = 'promote'
recovery_target_timeline = 'latest'
EOF
  echo "Stelle $chosen bis $target wieder her ..." >&2
  # Eigener Port und Socket, kein Netz, nichts archivieren.
  if ! pg_ctl -D "$data" -w -t "${OMP_PITR_TIMEOUT:-1800}" -l "$work/log" start -o "-p 5499 -c listen_addresses= -c unix_socket_directories=$work -c hba_file=$work/pg_hba.conf -c archive_mode=off -c primary_conninfo= -c primary_slot_name=" >/dev/null; then
    tail -n 20 "$work/log" >&2
    die "Wiederherstellung fehlgeschlagen (liegt der Zeitpunkt nach dem letzten archivierten Segment?)"
  fi
  i=0
  while [ "$(psql -h "$work" -p 5499 -U "${PATRONI_SUPERUSER_USERNAME:-postgres}" -d postgres -tAc 'select pg_is_in_recovery()' 2>/dev/null)" != f ]; do
    pg_ctl -D "$data" status >/dev/null 2>&1 || { tail -n 20 "$work/log" >&2; die "Wiederherstellung abgebrochen (Zeitpunkt nicht erreicht?)"; }
    i=$((i + 1)); [ "$i" -lt "${OMP_PITR_TIMEOUT:-1800}" ] || die "Zeitüberschreitung"
    sleep 1
  done
  pg_dump -h "$work" -p 5499 -U omp --clean --if-exists omp > "$work/dump.sql"
  gzip -c "$work/dump.sql" > "$out"
  echo "Stand $target liegt in $out" >&2
  ;;
*)
  die "Aufruf: pitr.sh archive|backup|list|restore"
  ;;
esac
