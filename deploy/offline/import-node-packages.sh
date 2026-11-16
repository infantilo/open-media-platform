#!/usr/bin/env bash
# Registriert die mitgelieferten Node-Pakete (z. B. Auto-Untertitel samt Modellen) im Katalog des LAUFENDEN Orchestrators.
# Die Images sind schon geladen (install-offline.sh: podman load); hier wird nur der Katalogeintrag angelegt
# (POST /api/v1/catalog, Admin). Kein Netz außer localhost nötig.
#
#   OMP_URL=http://localhost:8000 OMP_USER=admin OMP_PASSWORD=… deploy/offline/import-node-packages.sh [--wait SEKUNDEN]
#
# Aufgerufen von install-offline.sh --start; sonst nach `make start` einmal von Hand. Mehrfaches Ausführen ist harmlos
# (vorhandener Eintrag: HTTP 409 gilt als "schon da").
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIST="$ROOT/deploy/offline/node-packages.json"
URL="${OMP_URL:-http://localhost:8000}"; WAIT=120
[ "${1:-}" = --wait ] && WAIT="${2:-120}"
[ -f "$LIST" ] || { echo "keine Node-Pakete im Paket ($LIST fehlt) — nichts zu tun"; exit 0; }
for t in curl python3; do command -v "$t" >/dev/null || { echo "FEHLER: '$t' fehlt" >&2; exit 1; }; done

echo "warte auf den Orchestrator ($URL) …"
for _ in $(seq 1 "$WAIT"); do curl -sS -o /dev/null "$URL/" 2>/dev/null && break; sleep 1; done
curl -sS -o /dev/null "$URL/" || { echo "FEHLER: Orchestrator nicht erreichbar ($URL) — erst 'make start'" >&2; exit 1; }
TOKEN="$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')" \
  || { echo "FEHLER: Anmeldung fehlgeschlagen — OMP_USER/OMP_PASSWORD (Admin) setzen und erneut starten" >&2; exit 1; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
n=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$LIST")
rc=0
for i in $(seq 0 $((n-1))); do
  python3 - "$LIST" "$i" "$ROOT" > "$TMP" <<'PY'
import json, sys
lst = json.load(open(sys.argv[1])); p = lst[int(sys.argv[2])]; root = sys.argv[3]
if not p.get("entry"):
    print(""); sys.exit(0)          # Paket ohne Katalogeintrag (z. B. Sandbox-Image): nur das Image wird gebraucht
e = json.load(open(root + "/" + p["entry"])); e["version"] = p["version"]; e["image"] = p["image"]
print(json.dumps(e))
PY
  [ -s "$TMP" ] && [ "$(wc -c < "$TMP")" -gt 2 ] || { echo "  $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[int(sys.argv[2])]["type"])' "$LIST" "$i"): nur Image, kein Katalogeintrag"; continue; }
  code=$(curl -sS -o /tmp/omp-import.out -w '%{http_code}' -X POST "$URL/api/v1/catalog" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @"$TMP")
  typ=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["type"])' "$TMP")
  case "$code" in
    200|201) echo "  $typ: importiert" ;;
    409) echo "  $typ: schon im Katalog" ;;
    *) echo "  $typ: FEHLER HTTP $code — $(head -c 300 /tmp/omp-import.out)" >&2; rc=1 ;;
  esac
done
rm -f /tmp/omp-import.out
exit $rc
