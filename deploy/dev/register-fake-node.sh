#!/usr/bin/env bash
# Registriert eine minimale IS-04-Node/Device/Sender/Receiver-Resource an
# der Registration-API — Testwerkzeug für Schritt A5 (UMSETZUNG.md), damit
# GET /api/v1/nodes des Orchestrators ohne echte Media-Hardware getestet
# werden kann. Feldnamen/Pflichtfelder gegen AMWA-TV/is-04 (Branch
# v1.3.x, APIs/schemas/{node,device,sender,receiver_video}.json) geprüft.
set -euo pipefail

REGISTRY_URL="${OMP_REGISTRY_URL:-http://localhost:8010}"
API="$REGISTRY_URL/x-nmos/registration/v1.3"
LABEL="${1:-Fake Node}"

uuid() { cat /proc/sys/kernel/random/uuid; }
now_version() { echo "$(date +%s):$(date +%N)"; }

NODE_ID=$(uuid)
DEVICE_ID=$(uuid)
SENDER_ID=$(uuid)
RECEIVER_ID=$(uuid)
VERSION=$(now_version)

register() {
  local type="$1" data="$2"
  local code
  code=$(curl -sS -o /tmp/register-fake-node-response.json -w '%{http_code}' \
    -X POST "$API/resource" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"$type\",\"data\":$data}")
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    echo "Registrierung von '$type' fehlgeschlagen (HTTP $code):" >&2
    cat /tmp/register-fake-node-response.json >&2
    exit 1
  fi
  echo "$type registriert (HTTP $code)"
}

node_json=$(cat <<JSON
{
  "id": "$NODE_ID",
  "version": "$VERSION",
  "label": "$LABEL",
  "description": "",
  "tags": {},
  "href": "http://127.0.0.1:9000/",
  "caps": {},
  "api": {
    "versions": ["v1.3"],
    "endpoints": [{"host": "127.0.0.1", "port": 9000, "protocol": "http"}]
  },
  "services": [],
  "clocks": [],
  "interfaces": [{"chassis_id": null, "port_id": "00-00-00-00-00-01", "name": "eth0"}]
}
JSON
)

device_json=$(cat <<JSON
{
  "id": "$DEVICE_ID",
  "version": "$VERSION",
  "label": "$LABEL Device",
  "description": "",
  "tags": {},
  "type": "urn:x-nmos:device:generic",
  "node_id": "$NODE_ID",
  "senders": ["$SENDER_ID"],
  "receivers": ["$RECEIVER_ID"],
  "controls": []
}
JSON
)

sender_json=$(cat <<JSON
{
  "id": "$SENDER_ID",
  "version": "$VERSION",
  "label": "$LABEL Sender",
  "description": "",
  "tags": {},
  "flow_id": null,
  "transport": "urn:x-nmos:transport:rtp",
  "device_id": "$DEVICE_ID",
  "manifest_href": null,
  "interface_bindings": ["eth0"],
  "subscription": {"receiver_id": null, "active": false}
}
JSON
)

receiver_json=$(cat <<JSON
{
  "id": "$RECEIVER_ID",
  "version": "$VERSION",
  "label": "$LABEL Receiver",
  "description": "",
  "tags": {},
  "device_id": "$DEVICE_ID",
  "transport": "urn:x-nmos:transport:rtp",
  "interface_bindings": ["eth0"],
  "subscription": {"sender_id": null, "active": false},
  "format": "urn:x-nmos:format:video",
  "caps": {"media_types": ["video/raw"]}
}
JSON
)

register node "$node_json"
register device "$device_json"
register sender "$sender_json"
register receiver "$receiver_json"

# Heartbeat, damit die Node nicht vor registration_expiry_interval
# (siehe deploy/nmos/registry.json) sofort wieder aus der Registry fällt.
curl -sS -o /dev/null -X POST "$API/health/nodes/$NODE_ID"

echo "Fake-Node '$LABEL' registriert: node=$NODE_ID device=$DEVICE_ID sender=$SENDER_ID receiver=$RECEIVER_ID"
