#!/bin/sh
# Legt die Spracherkennungs-Engine (whisper.cpp) für den Node omp-subtitle-asr ab: Programm in <home>/bin, Modelle in <home>/models.
# <home> = $OMP_ASR_HOME (Standard data/asr-engine). Der Node findet die Engine dort selbst, startet sie mit und beendet sie mit.
#
#   sh tools/asr-engine/install.sh [Modell …]        Standard: small   (Modelle: tiny base small medium large-v3 …)
#
# Eine vorhandene whisper.cpp-Übersetzung kann mit WHISPER_SRC=<Pfad> wiederverwendet werden (sonst wird geklont und gebaut).
set -eu
HOME_DIR="${OMP_ASR_HOME:-data/asr-engine}"
SRC="${WHISPER_SRC:-$HOME_DIR/src/whisper.cpp}"
[ "$#" -gt 0 ] || set -- small
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/models"

if [ ! -x "$SRC/build/bin/whisper-server" ]; then
  echo "== whisper.cpp bauen ($SRC)"
  [ -d "$SRC" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$SRC"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
  nice cmake --build "$SRC/build" -j"${JOBS:-3}"
fi
echo "== Programm nach $HOME_DIR/bin"
cp -a "$SRC/build/bin/whisper-server" "$HOME_DIR/bin/"
cp -a "$SRC"/build/bin/*.so* "$HOME_DIR/bin/" 2>/dev/null || true

for m in "$@"; do
  f="$HOME_DIR/models/ggml-$m.bin"
  if [ -s "$f" ]; then echo "== Modell $m schon vorhanden"; continue; fi
  echo "== Modell $m laden"
  curl -fL --retry 3 -o "$f.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$m.bin"
  mv "$f.part" "$f"
done
echo "fertig: $(ls "$HOME_DIR/models")"
