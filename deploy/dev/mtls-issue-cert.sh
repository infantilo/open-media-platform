#!/usr/bin/env bash
# Stellt ein Leaf-Zertifikat für <label> über den laufenden step-ca-
# Dev-Container aus (UMSETZUNG.md D3, ARCHITECTURE.md §4.6) — braucht
# vorher `make mtls-up`. Läuft `step ca certificate` in einem
# Wegwerf-Container statt eine `step`-CLI-Installation auf dem Host
# vorauszusetzen (das offizielle step-ca-Image bringt die CLI bereits
# mit, verifiziert 2026-07-13 — gleiches "ein Tool-Container statt
# Host-Installation"-Muster wie das AMWA NMOS Testing Tool, D2).
#
# Gültigkeit = 23h, das per Default in step-ca konfigurierte Maximum
# (ca.json: authority.claims.maxTLSCertDuration = 24h — am echten
# Tool-Lauf verifiziert, nicht geraten: ein Versuch mit 2160h wurde von
# der CA mit "more than the authorized maximum certificate duration of
# 24h1m0s" abgelehnt). Eine echte Erneuerungs-Automatik (`step ca renew
# --daemon` o. Ä.) ist NICHT Teil dieses Schritts (docs/decisions.md D3,
# verbleibender Scope) — für eine Dev-/Verifikationssitzung reicht das
# knapp-24h-Zertifikat, ein Produktionsbetrieb bräuchte echte
# Renewal-Automatik oder eine angehobene maxTLSCertDuration.
#
# Usage: mtls-issue-cert.sh <label> <cert-out-path> <key-out-path> [extra SANs...]
#
# Für Server-Zertifikate (Nodes) MÜSSEN die extra-SANs alle Hostnamen
# enthalten, unter denen Clients tatsächlich verbinden (z. B. "localhost
# 127.0.0.1") — sonst schlägt die Server-Hostname-Verifikation auf
# Client-Seite fehl, auch wenn das Zertifikat selbst gültig/von der
# richtigen CA ist. Am echten curl-Testlauf gefunden (docs/decisions.md
# D3): ein Zertifikat nur mit dem Label als Subject/SAN wurde von jedem
# TLS-Client mit "SSL: no alternative certificate subject name matches
# target host name" abgelehnt. Für reine Client-Zertifikate
# (Orchestrator) sind keine extra-SANs nötig — dort verifiziert niemand
# einen "Hostnamen" des Orchestrators.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <label> <cert-out-path> <key-out-path> [extra SANs...]" >&2
  exit 1
fi

LABEL="$1"
CERT_OUT="$2"
KEY_OUT="$3"
shift 3
SAN_ARGS=()
for san in "$@"; do
  SAN_ARGS+=(--san "$san")
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STEP_CA_HOME="$ROOT_DIR/.run/step-ca"
ROOT_CA="$STEP_CA_HOME/certs/root_ca.crt"

if [ ! -f "$ROOT_CA" ]; then
  echo "step-ca nicht initialisiert (fehlt: $ROOT_CA) — zuerst 'make mtls-up' ausführen." >&2
  exit 1
fi

CERT_DIR="$(cd "$(dirname "$CERT_OUT")" 2>/dev/null && pwd || (mkdir -p "$(dirname "$CERT_OUT")" && cd "$(dirname "$CERT_OUT")" && pwd))"
KEY_DIR="$(cd "$(dirname "$KEY_OUT")" 2>/dev/null && pwd || (mkdir -p "$(dirname "$KEY_OUT")" && cd "$(dirname "$KEY_OUT")" && pwd))"
mkdir -p "$CERT_DIR" "$KEY_DIR"

echo "==> Zertifikat für '$LABEL' anfordern..."
podman run --rm --network host --userns=keep-id \
  -v "$STEP_CA_HOME":/home/step:ro \
  -v "$CERT_DIR":/cert-out \
  -v "$KEY_DIR":/key-out \
  --entrypoint step \
  docker.io/smallstep/step-ca:latest \
  ca certificate "$LABEL" "/cert-out/$(basename "$CERT_OUT")" "/key-out/$(basename "$KEY_OUT")" \
    --ca-url https://localhost:9000 \
    --root /home/step/certs/root_ca.crt \
    --provisioner-password-file /home/step/password.txt \
    --not-after 23h \
    --force \
    "${SAN_ARGS[@]}"

# Root-CA-Zertifikat direkt neben die Standard-Ablageorte kopieren
# (orchestrator/internal/config.go und nodes/mock/main.go erwarten es
# per Default unter .run/mtls/root_ca.crt) — einmalig, idempotent.
mkdir -p "$ROOT_DIR/.run/mtls"
cp "$ROOT_CA" "$ROOT_DIR/.run/mtls/root_ca.crt"

echo "==> Fertig: $CERT_OUT / $KEY_OUT (Root-CA: $ROOT_DIR/.run/mtls/root_ca.crt)"
