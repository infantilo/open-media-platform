#!/bin/sh
# Deinstalliert den Node vollständig: laufende Instanzen beenden, Katalogeintrag entfernen und das Image (mit Engine und Modellen) löschen.
#   OMP_URL=… OMP_USER=… OMP_PASSWORD=… sh deploy/subtitle-asr/uninstall.sh [Version]
set -eu
URL="${OMP_URL:-http://localhost:8000}"
TOKEN=$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
H="Authorization: Bearer $TOKEN"
VERSION="${1:-$(curl -fsS "$URL/api/v1/catalog" -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("entries",d);print(next((e.get("version","") for e in d if e["type"]=="omp-subtitle-asr"),""))')}"
echo "== Instanzen beenden"
curl -fsS "$URL/api/v1/instances" -H "$H" | python3 -c '
import sys,json
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("instances",d)
for i in d:
    if i.get("type")=="omp-subtitle-asr" and i.get("version","")==sys.argv[1]: print(i["id"])' "$VERSION" | while read -r id; do curl -fsS -X DELETE "$URL/api/v1/instances/$id" -H "$H" >/dev/null && echo "  $id beendet"; done
echo "== Katalogeintrag und Image entfernen (Version '${VERSION}')"
curl -sS -X DELETE "$URL/api/v1/catalog/omp-subtitle-asr?version=$VERSION" -H "$H" -w '\nHTTP %{http_code}\n'
