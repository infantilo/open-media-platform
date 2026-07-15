#!/usr/bin/env bash
# Erzeugt eine kurze, lizenzfreie MP4-Testdatei (H.264/AAC, 640x480@25,
# SMPTE-Farbbalken + 440-Hz-Ton) unter OMP_MEDIA_DIR — Testmittel für
# K2-Teil-1 (Datei-Playback in omp-player, UMSETZUNG.md §6a), keine
# Asset-Beschaffung nötig (docs/END-GOAL-FEATURES.md §2.4: "MP4 zuerst,
# weil ... selbst erzeugbar"). MXF-Testdateien (K2-Teil-2) sind hier
# bewusst nicht enthalten, s. dortige Doku, sobald der Schritt beginnt.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEDIA_DIR="${OMP_MEDIA_DIR:-$ROOT_DIR/data/media}"
DURATION_SECONDS="${1:-5}"
OUT="$MEDIA_DIR/test-smpte-${DURATION_SECONDS}s.mp4"

mkdir -p "$MEDIA_DIR"

VIDEO_BUFFERS=$((DURATION_SECONDS * 25))
AUDIO_BUFFERS=$(( (DURATION_SECONDS * 48000 + 2223) / 2224 ))

gst-launch-1.0 -e \
  videotestsrc pattern=smpte num-buffers="$VIDEO_BUFFERS" ! \
    video/x-raw,width=640,height=480,framerate=25/1 ! videoconvert ! \
    x264enc tune=zerolatency ! h264parse ! mux. \
  audiotestsrc wave=sine freq=440 num-buffers="$AUDIO_BUFFERS" ! \
    audio/x-raw,rate=48000,channels=2 ! audioconvert ! avenc_aac ! aacparse ! mux. \
  mp4mux name=mux ! filesink location="$OUT"

echo "Geschrieben: $OUT"
