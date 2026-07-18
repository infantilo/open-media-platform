#!/usr/bin/env bash
# S8-Soak-Grundlage (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "make
# soak: Skript startet den Stack + 2 Nodes und sammelt /metrics alle
# 60 s in eine CSV"). Kein jq/python3 (Minimal-Dependency-Regel §0
# Punkt 5, dieselbe Haltung wie /metrics selbst — reines
# grep/awk/sed auf dem eigenen, bereits handgeschriebenen
# Prometheus-Textformat, s. orchestrator/internal/httpapi/metrics.go).
#
# Abbruchkriterium (nicht im Skript automatisiert, s. docs/HANDBUCH.md
# Abschnitt 6: "Soak-Analyse"): steigen omp_go_heap_alloc_bytes oder
# omp_go_goroutines über die gesamte aufgezeichnete Laufzeit ohne
# erkennbares Plateau monoton an, ist das ein Leck-Befund — ein
# gelegentliches Sägezahnmuster (GC-Zyklen) ist dagegen erwartetes,
# gesundes Verhalten. Diese Bewertung macht bewusst ein Mensch anhand
# der CSV, kein automatischer Trend-Test im Skript (eine robuste
# "monoton wachsend trotz Rauschen"-Erkennung über wenige Messpunkte
# hinweg wäre selbst fehleranfällig).
#
# Usage: soak-omp.sh [duration_seconds] [interval_seconds]
#   Default: 3600s (1h) Dauer, 60s Intervall (S8 wörtlich). Strg+C
#   bricht früher ab, die bis dahin gesammelte CSV bleibt gültig.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${OMP_BASE_URL:-http://localhost:8000}"
DURATION_SECONDS="${1:-3600}"
INTERVAL_SECONDS="${2:-60}"

OUT_DIR="$ROOT_DIR/.run/soak"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/soak-$(date -u +%Y%m%dT%H%M%SZ).csv"

if ! curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
  echo "==> Orchestrator nicht erreichbar, starte Stack (make start)"
  (cd "$ROOT_DIR" && make start)
fi

# Login nur, wenn nötig (Bootstrap-Modus ohne angelegte Nutzer kommt ohne
# Token aus, s. docs/HANDBUCH.md Abschnitt 3) — ein Login-Fehlschlag ist
# daher kein Abbruchgrund, nur "kein Token verfügbar".
LOGIN_USER="${OMP_USER:-admin}"
LOGIN_PASSWORD="${OMP_PASSWORD:-adminpass123}"
login_resp=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$LOGIN_USER\",\"password\":\"$LOGIN_PASSWORD\"}" || true)
TOKEN=$(echo "$login_resp" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

AUTH_HEADER=()
if [ -n "${TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $TOKEN")
  echo "==> Angemeldet als $LOGIN_USER"
else
  echo "==> Kein Token (Bootstrap-Modus oder falsche Zugangsdaten) — Instanz-Start ohne Auth versucht"
fi

echo "==> Starte 2 Test-Nodes (omp-source) als Grundlast"
NODE_IDS=()
for i in 1 2; do
  resp=$(curl -sS -X POST "$BASE_URL/api/v1/instances" "${AUTH_HEADER[@]}" \
    -H 'Content-Type: application/json' -d '{"type":"omp-source"}')
  id=$(echo "$resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$id" ]; then
    echo "  Node $i: Start fehlgeschlagen: $resp" >&2
  else
    NODE_IDS+=("$id")
    echo "  Node $i: $id"
  fi
done

cleanup() {
  echo "==> Räume Test-Nodes auf"
  for id in "${NODE_IDS[@]:-}"; do
    [ -n "$id" ] && curl -sS -X DELETE "$BASE_URL/api/v1/instances/$id" "${AUTH_HEADER[@]}" >/dev/null || true
  done
}
trap cleanup EXIT

extract() {
  # $1 = /metrics-Textkörper, $2 = Metrikname ohne Labels.
  echo "$1" | grep "^$2 " | awk '{print $2}'
}
extract_labeled() {
  # $1 = /metrics-Textkörper, $2 = Metrikname, $3 = Label-Ausdruck (z. B. status="2xx").
  echo "$1" | grep "^$2{$3}" | awk '{print $2}'
}

echo "timestamp,goroutines,heap_alloc_bytes,heap_sys_bytes,gc_runs_total,gc_pause_seconds_total,registry_nodes,registry_nodes_online,registry_poll_duration_seconds,sse_clients,sse_dropped_events_total,launcher_instances,launcher_restarts_total,http_2xx,http_3xx,http_4xx,http_5xx" > "$OUT_FILE"

echo "==> Soak läuft: Dauer ${DURATION_SECONDS}s, Intervall ${INTERVAL_SECONDS}s, Ausgabe $OUT_FILE"
echo "==> Abbruchkriterium: s. Kopfkommentar dieses Skripts / docs/HANDBUCH.md — Strg+C bricht vorzeitig ab"

END=$((SECONDS + DURATION_SECONDS))
while [ "$SECONDS" -lt "$END" ]; do
  metrics=$(curl -sS "$BASE_URL/metrics")
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  row="$ts,$(extract "$metrics" omp_go_goroutines),$(extract "$metrics" omp_go_heap_alloc_bytes),$(extract "$metrics" omp_go_heap_sys_bytes),$(extract "$metrics" omp_go_gc_runs_total),$(extract "$metrics" omp_go_gc_pause_seconds_total),$(extract "$metrics" omp_registry_nodes),$(extract "$metrics" omp_registry_nodes_online),$(extract "$metrics" omp_registry_poll_duration_seconds),$(extract "$metrics" omp_sse_clients),$(extract "$metrics" omp_sse_dropped_events_total),$(extract "$metrics" omp_launcher_instances),$(extract "$metrics" omp_launcher_restarts_total),$(extract_labeled "$metrics" omp_http_requests_total 'status="2xx"'),$(extract_labeled "$metrics" omp_http_requests_total 'status="3xx"'),$(extract_labeled "$metrics" omp_http_requests_total 'status="4xx"'),$(extract_labeled "$metrics" omp_http_requests_total 'status="5xx"')"
  echo "$row" >> "$OUT_FILE"
  echo "  $row"
  sleep "$INTERVAL_SECONDS"
done

echo "==> Soak beendet, Ergebnis: $OUT_FILE"
