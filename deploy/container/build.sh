#!/bin/sh
# Baut das Image localhost/<Node-Typ>:<Version> für Nodes ohne eigene Zusatzsoftware (Binary + GStreamer-Plugins + MXL-Laufzeit).
# Vorher: `cd nodes && cargo build --release -p <Node-Typ>`. Optional: deploy/<Node-Typ>/prepare.sh <Kontextordner> legt Zusatzdateien ab.
#   sh deploy/container/build.sh omp-ograf
set -eu
NODE="${1:?Node-Typ angeben, z. B. omp-ograf}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
BIN="nodes/target/release/$NODE"
MXL="third_party/mxl/build/Linux-GCC-Release/lib"
for f in "$BIN" "$MXL/libmxl.so.1.1" "deploy/$NODE/Containerfile"; do [ -e "$f" ] || { echo "fehlt: $f" >&2; exit 1; }; done

CTX="deploy/$NODE/ctx"; rm -rf "$CTX"; mkdir -p "$CTX/node" "$CTX/mxl" "$CTX/licenses"
cp "$BIN" "$CTX/node/"
cp -a "$MXL"/libmxl.so* "$CTX/mxl/"
[ -d "deploy/$NODE/licenses" ] && cp -a "deploy/$NODE/licenses/." "$CTX/licenses/"
cp LICENSE "$CTX/licenses/OpenMediaPlatform-Apache-2.0" 2>/dev/null || true
cp THIRD-PARTY-NOTICES.md "$CTX/licenses/" 2>/dev/null || true
[ -x "deploy/$NODE/prepare.sh" ] || [ ! -f "deploy/$NODE/prepare.sh" ] || chmod +x "deploy/$NODE/prepare.sh"
[ ! -f "deploy/$NODE/prepare.sh" ] || sh "deploy/$NODE/prepare.sh" "$CTX"
podman build -f "deploy/$NODE/Containerfile" --build-arg VERSION="$VERSION" -t "localhost/$NODE:$VERSION" "$CTX"
rm -rf "$CTX"
echo "Image: localhost/$NODE:$VERSION ($(podman image inspect --format '{{.Size}}' "localhost/$NODE:$VERSION" | awk '{printf "%.0f MB", $1/1048576}'))"
echo "Importieren: sh deploy/container/import.sh $NODE"
