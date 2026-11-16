#!/usr/bin/env bash
# Sichert ALLE Container-Images für das Offline-Paket in ein Verzeichnis (laufen muss das auf einem Rechner MIT Internet und Podman):
#
#   images.tar / images.list        Plattform-Images (NATS, NMOS-Registry, etcd, Patroni/Postgres, optional Caddy/step-ca/S3)
#   node-images.tar / node-images.list
#                                   Node-Pakete als Container-Images, die ihre Zusatzdaten (Modelle!) MITBRINGEN
#   node-packages.json              je Node-Paket: Typ, Version, Image, Katalogeintrag, mitgelieferte Modelle
#
# Warum Images? Sie sind unabhängig von der Distribution des Zielrechners (Debian-Basis im Image), brauchen dort kein
# Internet und tragen ihre Modelle selbst: Auto-Untertitel = Node + whisper.cpp-Engine + Modelle (small, base) +
# Sprechererkennung (sherpa-onnx + Modelle). Fehlt ein Modell im Image, bricht dieses Skript ab (kein Paket "ohne Ton").
#
#   deploy/offline/save-images.sh --out VERZ [--no-images] [--no-node-images] [--build-node-images] [--node-package TYP]...
#     --out VERZ              Zielverzeichnis (wird angelegt)
#     --no-images             Plattform-Images weglassen
#     --no-node-images        Node-Pakete weglassen (NICHT empfohlen: dann fehlen Untertitel-Engine und Modelle)
#     --build-node-images     fehlende Node-Pakete mit deploy/<Typ>/build.sh bauen (braucht gebaute Nodes + data/asr-engine)
#     --node-package TYP      weiteres Node-Paket aufnehmen (omp-ograf | omp-intercom | omp-ffmpeg-sandbox); Standard: omp-subtitle-asr
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
OUT=""; IMAGES=1; NODE_IMAGES=1; BUILD=0; NODE_PKGS=(omp-subtitle-asr)
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out braucht ein Verzeichnis}"; shift 2 ;;
    --no-images) IMAGES=0; shift ;;
    --no-node-images) NODE_IMAGES=0; shift ;;
    --build-node-images) BUILD=1; shift ;;
    --node-package) NODE_PKGS+=("${2:?--node-package braucht einen Typ}"); shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "FEHLER: --out fehlt" >&2; exit 2; }
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "FEHLER: $*" >&2; exit 1; }
have podman || die "podman fehlt"
mkdir -p "$OUT"

# ---- Plattform-Images ---------------------------------------------------------------------------------------------
# Name -> Pflicht? (1 = für den Betrieb nötig). Referenzen (mit Digest) aus deploy/images.env.
# shellcheck disable=SC1091
. "$ROOT_DIR/deploy/images.env"
IMAGES_LIST=(
  "$NATS_IMAGE|1"
  "$NMOS_REGISTRY_IMAGE|1"
  "$ETCD_IMAGE|1"
  "localhost/omp-patroni:latest|1"
  "$CADDY_IMAGE|0"
  "$STEP_CA_IMAGE|0"
  "$SEAWEEDFS_IMAGE|0"
)
if [ "$IMAGES" = 1 ]; then
  say "Plattform-Images (podman pull/build/save)"
  imgs=()
  for e in "${IMAGES_LIST[@]}"; do
    pinned="${e%|*}"; need="${e#*|}"
    img="${pinned%%@*}"                    # gespeichert und geladen wird unter dem Tag-Namen (der Digest bleibt beim Laden nicht erhalten)
    if ! podman image exists "$pinned"; then
      case "$pinned" in
        *@sha256:*) podman pull "$pinned" || { [ "$need" = 1 ] && die "Pflicht-Image $pinned nicht ladbar" || { echo "    $pinned nicht ladbar — übersprungen" >&2; continue; }; } ;;
      esac
    fi
    case "$pinned" in *@sha256:*) podman tag "$pinned" "$img" ;; esac
    if ! podman image exists "$img"; then
      case "$img" in
        localhost/omp-patroni:latest) podman build -t "$img" -f "$ROOT_DIR/deploy/patroni/Dockerfile" "$ROOT_DIR/deploy/patroni" ;;
        localhost/*) echo "    $img fehlt lokal — übersprungen" >&2; continue ;;
        *) podman pull "$img" || { [ "$need" = 1 ] && die "Pflicht-Image $img nicht ladbar" || { echo "    $img nicht ladbar — übersprungen" >&2; continue; }; } ;;
      esac
    fi
    imgs+=("$img")
  done
  printf '%s\n' "${imgs[@]}" > "$OUT/images.list"
  podman save --multi-image-archive -o "$OUT/images.tar" "${imgs[@]}"
  echo "    ${#imgs[@]} Images, $(du -sh "$OUT/images.tar" | cut -f1)"
fi

# ---- Node-Pakete (Image samt Modellen) ----------------------------------------------------------------------------
# Typ -> Prüfpfade im Image: was drin sein MUSS (sonst läuft der Node ohne Netz nicht).
needs_for() {
  case "$1" in
    omp-subtitle-asr) echo "/opt/asr-engine/bin/whisper-server /opt/asr-engine/models/ggml-base.bin /opt/asr-engine/models/ggml-small.bin /opt/asr-engine/diarization/models/segmentation.onnx /opt/asr-engine/diarization/models/embedding.onnx /opt/asr-engine/diarization/bin/sherpa-onnx-offline-speaker-diarization" ;;
    *) echo "" ;;
  esac
}
# neuestes lokales Image eines Typs (nach Erstellzeit)
newest_image() { podman images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' --filter "reference=localhost/$1:*" 2>/dev/null | sort -r | head -1 | cut -d'|' -f2; }

if [ "$NODE_IMAGES" = 1 ]; then
  say "Node-Pakete (Image samt Modellen)"
  nimgs=(); entries=()
  for t in "${NODE_PKGS[@]}"; do
    [ -f "$ROOT_DIR/deploy/${t#omp-}/catalog-entry.json" ] || [ -f "$ROOT_DIR/deploy/$t/catalog-entry.json" ] || [ "$t" = omp-ffmpeg-sandbox ] || die "unbekanntes Node-Paket $t (kein catalog-entry.json)"
    img="$(newest_image "$t")"
    if [ -z "$img" ] && [ "$BUILD" = 1 ]; then
      b="$ROOT_DIR/deploy/${t#omp-}/build.sh"; [ -x "$b" ] || b="$ROOT_DIR/deploy/$t/build.sh"; [ -f "$b" ] || b="$ROOT_DIR/deploy/container/build.sh"
      echo "    kein Image $t — baue ($b)"
      if [ "$(basename "$b")" = build.sh ] && [ "$(basename "$(dirname "$b")")" = container ]; then sh "$b" "$t"; else sh "$b"; fi
      img="$(newest_image "$t")"
    fi
    [ -n "$img" ] || die "Image localhost/$t:* fehlt. Erst bauen (--build-node-images bzw. sh deploy/${t#omp-}/build.sh) — ohne dieses Image fehlen Engine und Modelle auf dem Zielrechner."
    ver="${img##*:}"
    echo "    $t -> $img"
    # Modelle/Programme MÜSSEN im Image liegen
    for p in $(needs_for "$t"); do
      podman run --rm --entrypoint sh "$img" -c "[ -s '$p' ]" || die "$img: '$p' fehlt oder ist leer — Image unvollständig (sh deploy/${t#omp-}/build.sh nach tools/asr-engine/install.sh [+ install-diarization.sh])"
    done
    models=""
    [ "$t" = omp-subtitle-asr ] && models='["ggml-base","ggml-small","sherpa-onnx segmentation","sherpa-onnx embedding"]'
    ef="deploy/${t#omp-}/catalog-entry.json"; [ -f "$ROOT_DIR/$ef" ] || ef="deploy/$t/catalog-entry.json"
    [ "$t" = omp-ffmpeg-sandbox ] && ef=""
    entries+=("{\"type\":\"$t\",\"version\":\"$ver\",\"image\":\"$img\",\"entry\":\"$ef\",\"models\":${models:-[]}}")
    nimgs+=("$img")
  done
  printf '%s\n' "${nimgs[@]}" > "$OUT/node-images.list"
  podman save --multi-image-archive -o "$OUT/node-images.tar" "${nimgs[@]}"
  printf '[%s]\n' "$(IFS=,; echo "${entries[*]}")" > "$OUT/node-packages.json"
  echo "    ${#nimgs[@]} Node-Pakete, $(du -sh "$OUT/node-images.tar" | cut -f1)"
fi
echo; echo "Fertig: $OUT"
