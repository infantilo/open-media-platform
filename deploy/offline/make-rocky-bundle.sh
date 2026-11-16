#!/usr/bin/env bash
# Baut das OFFLINE-PAKET für Rocky Linux 9 — auf JEDEM Linux-Rechner mit Internet und rootless Podman (z. B. dieser Entwicklungsrechner).
# Gebaut wird in einem WEGWERF-Rocky-9-Container (glibc/GStreamer wie auf dem Zielrechner); danach wird ALLES wieder aufgeräumt:
# Container, Arbeits-Volume (Cargo/Go/vcpkg/Quellen/Build-Ausgaben), Zwischenverzeichnisse, das selbst gezogene Rocky-Image.
# Übrig bleiben nur  <out>/omp-offline-…-rocky9.tar.zst  und die .sha256-Datei. Vorher/nachher wird der freie Plattenplatz gezeigt.
#
#   deploy/offline/make-rocky-bundle.sh [Optionen]
#     --out VERZ              Ausgabe (Standard: ./offline-bundle)
#     --jobs N                parallele Compiler-Jobs (Standard 2; die Maschine bleibt bedienbar, alles läuft mit nice 19)
#     --rocky-image REF       Basis-Image (Standard quay.io/rockylinux/rockylinux:9)
#     --no-rpmfusion          OHNE RPM Fusion Free: dann fehlen x264/libav (H.264/HEVC/AAC über GStreamer), H.264 nur über openh264.
#                             Standard: MIT RPM Fusion (die Knoten nutzen x264enc/avdec_h264 …). Codec-Lizenzen: docs/LIZENZ-INVENTAR.md
#     --min-free-gb N         Mindestplatz auf dem Podman-Speicher (Standard 14)
#     --keep                  nichts aufräumen (Fehlersuche: Container "omp-rocky-build-*" + Volume bleiben)
#     --skip-images           keine Plattform-Images/Node-Pakete holen (nur zum Testen des Builds)
#
# Voraussetzungen auf dem Build-Rechner: podman, git, gebautes UI (ui/dist; sonst `make ui`), die Container-Images laut
# deploy/images.env und das Image localhost/omp-subtitle-asr:* MIT Modellen (sh deploy/subtitle-asr/build.sh),
# Internetzugang. Plattenplatz: Rust-Build + Container-Schichten brauchen ~14 GB zusätzlich, die danach wieder frei werden.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$PWD/offline-bundle"; JOBS=2; IMG="quay.io/rockylinux/rockylinux:9"; RPMFUSION=1; MINFREE=14; KEEP=0; SKIPIMG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    --jobs) JOBS="${2:?}"; shift 2 ;;
    --rocky-image) IMG="${2:?}"; shift 2 ;;
    --no-rpmfusion) RPMFUSION=0; shift ;;
    --min-free-gb) MINFREE="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --skip-images) SKIPIMG=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
done
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "FEHLER: $*" >&2; exit 1; }
command -v podman >/dev/null || die "podman fehlt"
command -v git >/dev/null || die "git fehlt"
[ -f "$ROOT/ui/dist/shell.js" ] || die "ui/dist fehlt — erst 'make ui' (das UI ist distributionsunabhängig und wird vom Host übernommen)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"

GRAPH="$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null || echo "$HOME")"
free_gb() { df -Pk "$1" | awk 'NR==2 {printf "%d", $4/1048576}'; }
say "Platz vorher: Podman-Speicher $(free_gb "$GRAPH") GB frei, Ausgabe $(free_gb "$OUT") GB frei"
[ "$(free_gb "$GRAPH")" -ge "$MINFREE" ] || die "Podman-Speicher ($GRAPH) hat nur $(free_gb "$GRAPH") GB frei, nötig sind $MINFREE GB (--min-free-gb zum Ändern). Platz schaffen, z. B. 'podman image prune' (eigene, nicht benötigte Images) oder den Cargo-Cache nodes/target löschen."

TAG="$$"; CT="omp-rocky-build-$TAG"; VOL="omp-rocky-build-$TAG"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omp-rocky-work.XXXXXX")"
PULLED=0; podman image exists "$IMG" || PULLED=1
cleanup() {
  rc=$?
  if [ "$KEEP" = 1 ]; then
    echo "(--keep) bleibt: Container $CT, Volume $VOL, Zwischenverzeichnis $WORK" >&2
  else
    say "Aufräumen"
    podman rm -f -v "$CT" >/dev/null 2>&1 || true
    podman volume rm -f "$VOL" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    [ "$PULLED" = 1 ] && { podman rmi -f "$IMG" >/dev/null 2>&1 && echo "    selbst gezogenes Image $IMG entfernt" || true; }
  fi
  say "Platz nachher: Podman-Speicher $(free_gb "$GRAPH") GB frei, Ausgabe $(free_gb "$OUT") GB frei"
  exit $rc
}
trap cleanup EXIT

if [ "$SKIPIMG" = 0 ]; then
  say "1/3 Plattform-Images und Node-Pakete (Untertitel mit Modellen) auf dem Host sichern"
  "$HERE/save-images.sh" --out "$WORK/images"
else
  mkdir -p "$WORK/images"
fi

say "2/3 Wegwerf-Container ($IMG) bauen — das dauert (Rust-Workspace + libmxl), läuft mit nice 19 und $JOBS Jobs"
podman volume create "$VOL" >/dev/null
podman run --name "$CT" --security-opt label=disable \
  -e OMP_BUILD_JOBS="$JOBS" -e OMP_RPMFUSION="$RPMFUSION" \
  -v "$VOL:/work" -v "$ROOT:/in/repo:ro" -v "$ROOT/ui/dist:/in/ui-dist:ro" -v "$WORK/images:/in/images:ro" -v "$OUT:/out" \
  "$IMG" bash /in/repo/deploy/offline/rocky-inside.sh

say "3/3 Ergebnis"
ls -1 "$OUT"/omp-offline-*rocky*.tar.* 2>/dev/null || ls -1 "$OUT"
