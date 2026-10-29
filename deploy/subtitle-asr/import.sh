#!/bin/sh
# Importiert das Image als Node-Typ „Auto-Untertitel“ in den Katalog (POST /api/v1/catalog mit Aufnahmeprüfung; Admin).
#   OMP_URL=http://localhost:8000 OMP_USER=admin OMP_PASSWORD=… sh deploy/subtitle-asr/import.sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OMP_URL:-http://localhost:8000}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)}"
TOKEN=$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
python3 - "$ROOT/deploy/subtitle-asr/catalog-entry.json" "$VERSION" > /tmp/omp-subtitle-asr-entry.json <<'PY'
import json,sys
e=json.load(open(sys.argv[1])); e["version"]=sys.argv[2]; e["image"]="localhost/omp-subtitle-asr:"+sys.argv[2]
print(json.dumps(e))
PY
curl -sS -X POST "$URL/api/v1/catalog" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/tmp/omp-subtitle-asr-entry.json -w '\nHTTP %{http_code}\n'
rm -f /tmp/omp-subtitle-asr-entry.json
