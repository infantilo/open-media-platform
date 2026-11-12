#!/bin/sh
# Baut das Image localhost/omp-ffmpeg-sandbox:<Version> (ffmpeg/ffprobe für Sandbox-Jobs des Host-Agents).
#   sh deploy/omp-ffmpeg-sandbox/build.sh            Version aus `git describe`
# In tools.json: "sandbox": {"image": "localhost/omp-ffmpeg-sandbox:<Version>"} und je Programm "sandbox": true.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
podman build -f deploy/omp-ffmpeg-sandbox/Containerfile --build-arg VERSION="$VERSION" -t "localhost/omp-ffmpeg-sandbox:$VERSION" deploy/omp-ffmpeg-sandbox
echo "Image: localhost/omp-ffmpeg-sandbox:$VERSION ($(podman image inspect --format '{{.Size}}' "localhost/omp-ffmpeg-sandbox:$VERSION" | awk '{printf "%.0f MB", $1/1048576}'))"
