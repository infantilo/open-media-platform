#!/bin/sh
# Importiert das Image eines Container-Pakets als Node-Typ in den Katalog (POST /api/v1/catalog mit Aufnahmeprüfung; Admin).
#   OMP_URL=http://localhost:8000 OMP_USER=admin OMP_PASSWORD=… sh deploy/container/import.sh <Node-Typ>     z. B. omp-ograf
# Gibt es den Typ schon als statischen Katalogeintrag (nativer Node), lehnt der Import ihn ab (HTTP 409). Dann unter eigenem
# Typnamen importieren, der Container läuft neben dem nativen Node:  OMP_IMPORT_TYPE=omp-ograf-pkg sh deploy/container/import.sh omp-ograf
set -eu
NODE="${1:?Node-Typ angeben, z. B. omp-ograf}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OMP_URL:-http://localhost:8000}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)}"
TOKEN=$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
python3 - "$ROOT/deploy/$NODE/catalog-entry.json" "$VERSION" "$NODE" "${OMP_IMPORT_TYPE:-}" > "$TMP" <<'PY'
import json,sys
e=json.load(open(sys.argv[1])); e["version"]=sys.argv[2]; e["image"]="localhost/%s:%s"%(sys.argv[3],sys.argv[2])
if sys.argv[4]:
    e["type"]=sys.argv[4]; e["label"]+=" (Container)"
    for l in e.get("i18n",{}).values():
        if "label" in l: l["label"]+=" (container)"
print(json.dumps(e))
PY
curl -sS -X POST "$URL/api/v1/catalog" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @"$TMP" -w '\nHTTP %{http_code}\n'
