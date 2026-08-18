#!/bin/sh
# Läuft genau einmal, nur auf dem bootstrappenden Knoten, direkt nach
# initdb (Patroni bootstrap.post_init, s. bootstrap.yml) — legt die
# Anwendungsdatenbank "omp" an. `initdb` selbst erzeugt nur postgres/
# template0/template1; das entspricht dem, was vorher POSTGRES_DB=omp
# im Einzelknoten-Container automatisch übernahm (UMSETZUNG.md D1).
# Patroni ruft dieses Skript mit der Superuser-Verbindungs-URL als $1 auf
# (PGPASSWORD ist bereits exportiert).
set -e
psql "$1" -c "CREATE ROLE omp WITH LOGIN CREATEDB CREATEROLE PASSWORD 'omp'"
psql "$1" -c "CREATE DATABASE omp OWNER omp"
