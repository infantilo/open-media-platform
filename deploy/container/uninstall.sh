#!/bin/sh
# Deinstalliert ein Container-Paket vollständig: Instanzen beenden, Katalogeintrag entfernen; der Orchestrator löscht dabei Image und Datenvolumen.
#   OMP_URL=… OMP_USER=… OMP_PASSWORD=… sh deploy/container/uninstall.sh <Node-Typ> [Version]
set -eu
NODE="${1:?Node-Typ angeben, z. B. omp-ograf}"
URL="${OMP_URL:-http://localhost:8000}"
TOKEN=$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
H="Authorization: Bearer $TOKEN"
VERSION="${2:-$(curl -fsS "$URL/api/v1/catalog" -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("entries",d);print(next((e.get("version","") for e in d if e["type"]==sys.argv[1] and e.get("image")),""))' "$NODE")}"
echo "== Instanzen beenden"
curl -fsS "$URL/api/v1/instances" -H "$H" | python3 -c '
import sys,json
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("instances",d)
for i in d:
    if i.get("type")==sys.argv[1] and i.get("version","")==sys.argv[2]: print(i["id"])' "$NODE" "$VERSION" | while read -r id; do curl -fsS -X DELETE "$URL/api/v1/instances/$id" -H "$H" >/dev/null && echo "  $id beendet"; done
echo "== Katalogeintrag, Image und Datenvolumen entfernen (Version '${VERSION}')"
curl -sS -X DELETE "$URL/api/v1/catalog/$NODE?version=$VERSION" -H "$H" -w '\nHTTP %{http_code}\n'
