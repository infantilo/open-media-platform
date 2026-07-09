#!/bin/sh
# Erzeugt zwei kurze, visuell/akustisch unterscheidbare Testclips für die
# C4-Verifikation (UMSETZUNG.md) — keine Binärdateien im Repo, daher hier
# als Generator-Skript statt fertiger Dateien. H.264/Opus in Matroska,
# weil x264enc/opusenc/matroskamux auf dieser Maschine vorhanden sind und
# uridecodebin sie ohne Sonderfälle demuxt/dekodiert.
#
# num-buffers statt eines Wallclock-Timeouts: videotestsrc/audiotestsrc
# sind ohne is-live=true nicht in Echtzeit gebunden — ein erster Versuch
# mit "timeout 5s gst-launch ..." erzeugte Clips mit ~9-10s deklarierter
# Spieldauer (Encoder lief schneller als Echtzeit), nicht den
# beabsichtigten 5s (siehe docs/decisions.md, Schritt C4). Mit fester
# Framerate/Samplerate ergibt num-buffers eine exakte, deterministische
# Dauer unabhängig von der tatsächlichen Encoder-Geschwindigkeit.
#
# Nutzung: scripts/generate_test_clips.sh [zielverzeichnis]
# Default-Zielverzeichnis: ./test-clips (gitignored)

set -eu

OUT_DIR="${1:-$(dirname "$0")/../test-clips}"
mkdir -p "$OUT_DIR"

DURATION_SECONDS=5
VIDEO_FRAMERATE=25
AUDIO_RATE=48000
AUDIO_SAMPLES_PER_BUFFER=960 # 48000/960 = 50 Buffer/s
VIDEO_NUM_BUFFERS=$((DURATION_SECONDS * VIDEO_FRAMERATE))
AUDIO_NUM_BUFFERS=$((DURATION_SECONDS * AUDIO_RATE / AUDIO_SAMPLES_PER_BUFFER))

generate_clip() {
  pattern="$1"
  freq="$2"
  out="$3"
  gst-launch-1.0 -e \
    videotestsrc pattern="$pattern" num-buffers="$VIDEO_NUM_BUFFERS" \
      ! video/x-raw,width=640,height=480,framerate="$VIDEO_FRAMERATE"/1 \
      ! x264enc tune=zerolatency ! queue ! mux. \
    audiotestsrc wave=sine freq="$freq" samplesperbuffer="$AUDIO_SAMPLES_PER_BUFFER" num-buffers="$AUDIO_NUM_BUFFERS" \
      ! audio/x-raw,rate="$AUDIO_RATE" \
      ! audioconvert ! opusenc ! queue ! mux. \
    matroskamux name=mux ! filesink location="$out"
}

generate_clip smpte 440 "$OUT_DIR/clip_a.mkv"
generate_clip ball 880 "$OUT_DIR/clip_b.mkv"

echo "Generiert: $OUT_DIR/clip_a.mkv (SMPTE-Balken, 440 Hz), $OUT_DIR/clip_b.mkv (Ball, 880 Hz), je ${DURATION_SECONDS}s"
