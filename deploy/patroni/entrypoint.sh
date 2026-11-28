#!/bin/sh
# `initdb` weigert sich, als root zu laufen (live gefunden, 2026-08-18:
# "initdb: error: cannot be run as root") — das offizielle
# postgres:16-alpine-Image löst das über sein eigenes docker-entrypoint.sh
# (chown + su-exec postgres), das wir hier NICHT nutzen (ENTRYPOINT zeigt
# direkt auf `patroni`, kein Postgres-eigener Serverstart). Derselbe
# Chown-dann-Privilegien-abgeben-Schritt, nachgebaut mit dem im Basis-Image
# bereits vorhandenen su-exec.
set -e
mkdir -p /home/postgres/pgdata
chown -R postgres:postgres /home/postgres
# Postgres verlangt exakt 0700/0750 auf dem Datenverzeichnis. `initdb`
# setzt das für einen frischen Bootstrap-Knoten selbst — ein per
# pg_basebackup neu angelegter Replica-Knoten dagegen übernimmt nur die
# Berechtigungen des bereits vom Bind-Mount vorgegebenen Verzeichnisses
# (hier 0755 von `mkdir -p` auf dem Host) und startet sonst mit "invalid
# permissions" nicht (live gefunden, 2026-08-18, s. docs/decisions.md
# D15) — deshalb hier für BEIDE Fälle explizit erzwungen statt sich auf
# `initdb`/`pg_basebackup` zu verlassen.
chmod 700 /home/postgres/pgdata
# TLS-Material (Produktion): schreibgeschützt nach /etc/omp-certs gemountet, die Schlüssel bleiben auf dem Host
# 0600. Patroni läuft als postgres, deshalb eine Kopie mit passendem Besitzer.
if [ -d /etc/omp-certs ]; then
  rm -rf /home/postgres/certs
  mkdir -m 700 /home/postgres/certs
  cp /etc/omp-certs/* /home/postgres/certs/
  chmod 600 /home/postgres/certs/*
  chown -R postgres:postgres /home/postgres/certs
fi
# WAL-Archiv (omp-pitr), falls eingehängt. Auf Netzlaufwerken kann chown scheitern — dann dort passend freigeben.
if [ -d /archive ]; then chown postgres:postgres /archive 2>/dev/null || true; fi
exec su-exec postgres patroni "$@"
