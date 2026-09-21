#!/usr/bin/env bash
# Handy-Test für omp-webrtc-gateway (Nachtrag 240–244): startet Kamera-Node
# (9440) und Monitor-Node (9442), Caddy-HTTPS (9441/9443) und verbindet per
# IS-05 die Kamera mit dem Monitor.
#
#   OMP_PUBLIC_HOST=<IP/Name des Rechners im WLAN> deploy/dev/start-webrtc-phone.sh [start|wire|stop]
#
# Voraussetzung: `make start` (NATS, NMOS-Registry) läuft, Nodes gebaut
# (`cargo build [--release] -p omp-webrtc-gateway` in nodes/).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/.run/webrtc"
BIN="${OMP_WEBRTC_BIN:-$ROOT/nodes/target/release/omp-webrtc-gateway}"
[ -x "$BIN" ] || BIN="$ROOT/nodes/target/debug/omp-webrtc-gateway"
HOST="${OMP_PUBLIC_HOST:-$(hostname -I | awk '{print $1}')}"
mkdir -p "$RUN"

port_pid() { { ss -ltnp 2>/dev/null | grep ":$1 " | sed 's/.*pid=\([0-9]*\).*/\1/' | head -1; } || true; }
stop_nodes() {
  for p in 9440 9442; do pid="$(port_pid $p)"; [ -n "$pid" ] && kill "$pid" || true; done
  for _ in $(seq 1 20); do { ss -ltn | grep -qE ":(9440|9442) "; } || break; sleep 0.5; done
}
wait_http() { for _ in $(seq 1 40); do curl -sf "$1" >/dev/null && return 0; sleep 0.5; done; return 1; }

wire() {
  local S V A R1 R2
  S="$(curl -s "http://localhost:8010/x-nmos/query/v1.3/senders?paging.limit=100")"
  V="$(echo "$S" | python3 -c "import json,sys;print([x['id'] for x in json.load(sys.stdin) if x['label']=='Handy-Kamera Sender 1'][0])")"
  A="$(echo "$S" | python3 -c "import json,sys;print([x['id'] for x in json.load(sys.stdin) if x['label']=='Handy-Kamera Sender 2'][0])")"
  read -r R1 R2 <<<"$(curl -s localhost:9442/x-nmos/connection/v1.1/single/receivers/ | python3 -c "import json,sys;print(' '.join(x.strip('/') for x in json.load(sys.stdin)))")"
  for pair in "$R1 $V" "$R2 $A"; do
    set -- $pair
    curl -s -o /dev/null -w "IS-05 PATCH Receiver %{http_code}\n" -XPATCH "localhost:9442/x-nmos/connection/v1.1/single/receivers/$1/staged" \
      -H 'content-type: application/json' -d "{\"sender_id\":\"$2\",\"master_enable\":true,\"activation\":{\"mode\":\"activate_immediate\"}}"
  done
}

case "${1:-start}" in
  stop) stop_nodes; echo "Nodes gestoppt (Caddy läuft weiter: make proxy-down)"; exit 0 ;;
  wire) wire; exit 0 ;;
  start) ;;
  *) echo "Aufruf: $0 [start|wire|stop]"; exit 1 ;;
esac

# shellcheck disable=SC1091
source "$ROOT/deploy/dev/mxl.env"
stop_nodes
rm -rf /dev/shm/omp-mxl/* 2>/dev/null || true
OMP_LABEL="Handy-Kamera" OMP_HOST=127.0.0.1 OMP_PORT=9440 setsid "$BIN" > "$RUN/camera.log" 2>&1 < /dev/null &
OMP_WEBRTC_GATEWAY_DIRECTION=monitor OMP_LABEL="Handy-Monitor" OMP_HOST=127.0.0.1 OMP_PORT=9442 setsid "$BIN" > "$RUN/monitor.log" 2>&1 < /dev/null &
wait_http http://127.0.0.1:9440/clock && wait_http http://127.0.0.1:9442/clock
for _ in $(seq 1 40); do curl -s "http://localhost:8010/x-nmos/query/v1.3/senders?paging.limit=100" | grep -q "Handy-Kamera Sender 2" && break; sleep 0.5; done
wire

# Caddy: der Hostname/die IP ist beim Anlegen des Containers festgelegt (SAN
# des internen Zertifikats) — bei anderer OMP_PUBLIC_HOST neu anlegen.
if podman container exists omp-caddy; then
  cur="$(podman inspect omp-caddy --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^OMP_PUBLIC_HOST=//p')"
  if [ "$cur" != "$HOST" ]; then podman rm -f omp-caddy >/dev/null; fi
fi
OMP_PUBLIC_HOST="$HOST" make -C "$ROOT" proxy-up >/dev/null
podman restart omp-caddy >/dev/null   # lädt die Caddyfile neu, erneuert Zertifikate
cat <<MSG

Bereit. Auf dem Handy (gleiches WLAN) öffnen:
  Kamera  (Handy -> OMP):  https://$HOST:9441
  Monitor (OMP -> Handy):  https://$HOST:9443
Root-CA für das Handy (einmal installieren, sonst Zertifikatswarnung bestätigen):
  $ROOT/.run/caddy/caddy/pki/authorities/local/root.crt
Logs: $RUN/camera.log, $RUN/monitor.log   Stoppen: $0 stop
MSG
