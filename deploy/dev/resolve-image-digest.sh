#!/usr/bin/env bash
# Löst "registry/repo:tag" über die Registry-HTTP-API in den Digest des Manifests (bzw. der Manifestliste) auf — ohne den Image
# zu ziehen. Ausgabe: sha256:<hex>. Benutzt von deploy/dev/update-image-pins.sh.
set -euo pipefail
# bis zu 3 Versuche (Registries antworten gelegentlich vorübergehend mit 401/5xx)
if [ -z "${OMP_RESOLVE_TRY:-}" ]; then
  for i in 1 2 3; do
    OMP_RESOLVE_TRY=$i "$0" "$@" && exit 0
    sleep 2
  done
  exit 1
fi
ref="${1:?Aufruf: resolve-image-digest.sh <registry/repo:tag>}"
reg="${ref%%/*}"; rest="${ref#*/}"; repo="${rest%:*}"; tag="${rest##*:}"
case "$reg" in docker.io) host="registry-1.docker.io" ;; *) host="$reg" ;; esac
accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
url="https://$host/v2/$repo/manifests/$tag"
hdr="$(curl -sSI -m 20 -H "Accept: $accept" "$url")"
if echo "$hdr" | head -1 | grep -q ' 401'; then
  chal="$(echo "$hdr" | tr -d '\r' | sed -n 's/^[Ww]ww-[Aa]uthenticate: *[Bb]earer *//p')"
  realm="$(echo "$chal" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
  service="$(echo "$chal" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
  scope="$(echo "$chal" | sed -n 's/.*scope="\([^"]*\)".*/\1/p')"
  token="$(curl -sS -m 20 "$realm?service=$service&scope=$scope" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || { echo "kein Token von $realm" >&2; exit 1; }
  hdr="$(curl -sSI -m 20 -H "Accept: $accept" -H "Authorization: Bearer $token" "$url")"
fi
digest="$(echo "$hdr" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -1)"
[ -n "$digest" ] || { echo "kein Digest für $ref (Antwort: $(echo "$hdr" | head -1))" >&2; exit 1; }
echo "$digest"
