#!/usr/bin/env bash
# HTTPS-Vorsatz für die Handy-Seite einer omp-webrtc-gateway-Instanz (Kamera/Monitor).
#
# Der Handy-Browser erlaubt Kamera/Mikrofon (getUserMedia) nur über HTTPS; die Seite
# camera.html liefert der Node aber als Klartext-HTTP auf seinem (dynamischen) Port.
# Dieses Skript startet je Node-Port einen kleinen Caddy-Container (Podman, --network=host),
# der mit einem selbst signierten (Caddy-internen) Zertifikat auf  <Port + 1000>  per HTTPS
# lauscht und an den Node weiterreicht. Im Einladungs-Panel der Instanz die Basis-URL dann auf
# https://<IP>:<Port+1000> setzen (Feld ist editierbar). Das Handy zeigt einmal eine
# Zertifikatswarnung (Caddy-Root-CA: .run/caddy-phone/caddy/pki/authorities/local/root.crt).
#
#   deploy/dev/phone-https.sh start <node-port> [öffentliche-IP]
#   deploy/dev/phone-https.sh stop  <node-port>
#   deploy/dev/phone-https.sh list
#
# Die Medien laufen weiter über UDP (OMP_WEBRTC_ICE_PORT/OMP_WEBRTC_PUBLIC_IP des Nodes) —
# diese Ports müssen im LAN/NAT erreichbar sein. Firewall: TCP <Port+1000> freigeben.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cmd="${1:-list}"; port="${2:-}"
ip_default="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
ip="${3:-${OMP_PUBLIC_HOST:-$ip_default}}"
name() { echo "omp-phone-https-$1"; }
case "$cmd" in
  start)
    [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 64535 ] || { echo "Aufruf: $0 start <node-port 1-64535> [IP]" >&2; exit 2; }
    curl -fs -m 3 -o /dev/null "http://127.0.0.1:$port/clock" || echo "Hinweis: Node auf 127.0.0.1:$port antwortet nicht (läuft die Instanz auf diesem Rechner?)" >&2
    https=$((port + 1000))
    mkdir -p "$ROOT/.run/caddy-phone"
    podman rm -f "$(name "$port")" >/dev/null 2>&1 || true
    podman run -d --name "$(name "$port")" --restart=always --network=host \
      -v "$ROOT/.run/caddy-phone:/data" \
      docker.io/library/caddy:latest \
      caddy reverse-proxy --from "https://$ip:$https" --to "127.0.0.1:$port" >/dev/null
    echo "Handy-Basis-URL: https://$ip:$https   (Node-Port $port, TCP $https freigeben)"
    ;;
  stop)
    [ -n "$port" ] || { echo "Aufruf: $0 stop <node-port>" >&2; exit 2; }
    podman rm -f "$(name "$port")" >/dev/null 2>&1 && echo "gestoppt: $port" || echo "nicht vorhanden: $port"
    ;;
  list)
    podman ps -a --filter name=omp-phone-https- --format '{{.Names}}  {{.Status}}'
    ;;
  *) echo "Aufruf: $0 start|stop|list" >&2; exit 2 ;;
esac
