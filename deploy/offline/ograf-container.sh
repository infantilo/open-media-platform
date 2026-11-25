#!/usr/bin/env bash
# OGraf als Container-Paket für Rechner OHNE WPE-Plugin (Rocky/RHEL): der Web-Renderer (wpesrc) steckt im Debian-Image,
# der native Katalogeintrag "omp-ograf" kann dort nicht laufen ("Failed to find element factory 'wpesrc'").
# Das Paket erscheint im Katalog als Typ "omp-ograf-pkg" ("OGraf Graphics (Container)").
#
#   Build-Rechner (mit Internet, Podman, gebaute Nodes):
#     deploy/offline/ograf-container.sh export [VERZ]      baut das Image neu (deploy/container/build.sh) und legt
#                                                          VERZ/omp-ograf-image.tar (+ .sha256) ab; Standard VERZ=dist
#   Zielrechner (Rocky, ohne Netz):
#     deploy/offline/ograf-container.sh import DATEI.tar   lädt das Image (podman load) und trägt es im LAUFENDEN
#                                                          Orchestrator ein (OMP_URL, OMP_USER, OMP_PASSWORD wie import-node-packages.sh)
#   Danach in der Oberfläche eine Instanz vom Typ "OGraf Graphics (Container)" anlegen.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "FEHLER: $*" >&2; exit 1; }
command -v podman >/dev/null || die "podman fehlt"
cmd="${1:-}"; shift || true
case "$cmd" in
  export)
    OUT="${1:-$ROOT/dist}"; mkdir -p "$OUT"
    sh "$ROOT/deploy/container/build.sh" omp-ograf
    img="$(podman images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' --filter 'reference=localhost/omp-ograf:*' | sort -r | head -1 | cut -d'|' -f2)"
    [ -n "$img" ] || die "kein Image localhost/omp-ograf:*"
    podman run --rm --entrypoint sh "$img" -c 'ls /usr/lib/*/gstreamer-1.0/libgstwpe.so >/dev/null' || die "$img enthält libgstwpe.so nicht"
    podman save -o "$OUT/omp-ograf-image.tar" "$img"
    printf '%s\n' "$img" > "$OUT/omp-ograf-image.name"
    (cd "$OUT" && sha256sum omp-ograf-image.tar > omp-ograf-image.tar.sha256)
    echo "Fertig: $OUT/omp-ograf-image.tar ($(du -sh "$OUT/omp-ograf-image.tar" | cut -f1)), Image $img"
    echo "Auf den Zielrechner kopieren (zusammen mit omp-ograf-image.tar.sha256) und dort: $0 import omp-ograf-image.tar"
    ;;
  import)
    TAR="${1:?Pfad zu omp-ograf-image.tar angeben}"; [ -f "$TAR" ] || die "$TAR fehlt"
    [ ! -f "$TAR.sha256" ] || (cd "$(dirname "$TAR")" && sha256sum -c "$(basename "$TAR").sha256") || die "Prüfsumme stimmt nicht"
    out="$(podman load -i "$TAR")"; echo "$out"
    img="$(printf '%s\n' "$out" | sed -n 's/^Loaded image[^:]*: *//p' | head -1)"
    [ -n "$img" ] || die "Image-Name nach dem Laden nicht erkannt"
    ver="${img##*:}"
    for t in curl python3; do command -v "$t" >/dev/null || die "'$t' fehlt"; done
    URL="${OMP_URL:-http://localhost:8000}"
    TOKEN="$(curl -fsS -X POST "$URL/api/v1/auth/login" -H 'Content-Type: application/json' \
      -d "{\"username\":\"${OMP_USER:-admin}\",\"password\":\"${OMP_PASSWORD:-adminpass123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')" \
      || die "Anmeldung am Orchestrator ($URL) fehlgeschlagen — läuft er (make start)? OMP_USER/OMP_PASSWORD (Admin) setzen"
    TMP="$(mktemp)"; trap 'rm -f "$TMP" /tmp/omp-ograf-import.out' EXIT
    python3 - "$ROOT/deploy/omp-ograf/catalog-entry.json" "$ver" "$img" > "$TMP" <<'PY'
import json, sys
e = json.load(open(sys.argv[1])); e["version"] = sys.argv[2]; e["image"] = sys.argv[3]
e["type"] = "omp-ograf-pkg"; e["label"] += " (Container)"
for l in e.get("i18n", {}).values():
    if "label" in l: l["label"] += " (container)"
print(json.dumps(e))
PY
    code="$(curl -sS -o /tmp/omp-ograf-import.out -w '%{http_code}' -X POST "$URL/api/v1/catalog" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @"$TMP")"
    case "$code" in
      200|201) echo "omp-ograf-pkg importiert (Image $img)" ;;
      409) echo "omp-ograf-pkg ist schon im Katalog (Image $img geladen; eine neue Version ggf. über Update/Entfernen+Import)" ;;
      *) die "Katalog-Import HTTP $code — $(head -c 300 /tmp/omp-ograf-import.out)" ;;
    esac
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
