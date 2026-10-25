#!/usr/bin/env bash
# Liefert die Image-Referenz einer Variable aus deploy/images.env: mit Digest, bei Offline-Installationen (.run/images-unpinned)
# nur das Tag. Aufruf:  . deploy/dev/image-ref.sh; image_ref CADDY_IMAGE
_IMG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$_IMG_ROOT/deploy/images.env"
image_ref() {
  local v="${!1:?unbekannte Image-Variable $1}"
  if [ -e "$_IMG_ROOT/.run/images-unpinned" ]; then printf '%s\n' "${v%%@*}"; else printf '%s\n' "$v"; fi
}
