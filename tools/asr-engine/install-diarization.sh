#!/bin/sh
# Legt die Sprechererkennung (sherpa-onnx, Apache-2.0) und die Modelle für den Node omp-subtitle-asr ab:
#   <home>/diarization/bin/sherpa-onnx-offline-speaker-diarization (+ Bibliotheken in ../lib)
#   <home>/diarization/models/segmentation.onnx   (pyannote segmentation 3.0, ONNX)
#   <home>/diarization/models/embedding.onnx      (Sprecher-Einbettung, Standard 3D-Speaker CAM++ zh/en)
# <home> = $OMP_ASR_HOME (Standard data/asr-engine). Nichts davon liegt im Repository: Programm und Modelle werden hier geladen.
#
# LIZENZEN — vor Weitergabe/Einsatz selbst prüfen: sherpa-onnx steht unter Apache-2.0. Für die beiden Modelle gilt jeweils die Lizenz
# ihres Herstellers (pyannote segmentation 3.0: pyannote; 3D-Speaker/NeMo/WeSpeaker-Einbettungen: je Modellkarte); die Veröffentlichung der
# ONNX-Dateien nennt sie nicht einheitlich. Das Paket „Auto-Untertitel“ enthält sie deshalb nur, wenn Sie dieses Skript vor dem
# Bauen des Images laufen lassen und damit die Verantwortung für die Weitergabe übernehmen.
#
#   sh tools/asr-engine/install-diarization.sh                 Standardmodelle
#   EMBEDDING=nemo_en_titanet_small.onnx sh …                  anderes Einbettungsmodell aus dem sherpa-onnx-Release „speaker-recongition-models“
set -eu
HOME_DIR="${OMP_ASR_HOME:-data/asr-engine}"
D="$HOME_DIR/diarization"
VERSION="${SHERPA_VERSION:-v2.0.1}"
EMBEDDING="${EMBEDDING:-3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx}"
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"
mkdir -p "$D/bin" "$D/lib" "$D/models"
if [ ! -x "$D/bin/sherpa-onnx-offline-speaker-diarization" ]; then
  echo "== sherpa-onnx $VERSION laden"
  T="$(mktemp -d)"
  curl -fL --retry 3 -o "$T/s.tar.bz2" "$BASE/$VERSION/sherpa-onnx-$VERSION-linux-x64-shared-no-tts.tar.bz2"
  tar -xjf "$T/s.tar.bz2" -C "$T"
  S="$(ls -d "$T"/sherpa-onnx-*/ | head -1)"
  cp -a "$S"bin/sherpa-onnx-offline-speaker-diarization "$D/bin/"
  cp -a "$S"lib/*.so* "$D/lib/" 2>/dev/null || true
  [ -f "$S/LICENSE" ] && cp "$S/LICENSE" "$D/LICENSE.sherpa-onnx"
  rm -rf "$T"
fi
if [ ! -s "$D/models/segmentation.onnx" ]; then
  echo "== Segmentierungsmodell laden"
  T="$(mktemp -d)"
  curl -fL --retry 3 -o "$T/seg.tar.bz2" "$BASE/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  tar -xjf "$T/seg.tar.bz2" -C "$T"
  cp "$T"/sherpa-onnx-pyannote-segmentation-3-0/model.onnx "$D/models/segmentation.onnx"
  [ -f "$T/sherpa-onnx-pyannote-segmentation-3-0/LICENSE" ] && cp "$T/sherpa-onnx-pyannote-segmentation-3-0/LICENSE" "$D/LICENSE.segmentation"
  rm -rf "$T"
fi
if [ ! -s "$D/models/embedding.onnx" ]; then
  echo "== Einbettungsmodell $EMBEDDING laden"
  curl -fL --retry 3 -o "$D/models/embedding.onnx.part" "$BASE/speaker-recongition-models/$EMBEDDING"
  mv "$D/models/embedding.onnx.part" "$D/models/embedding.onnx"
fi
echo "fertig: $(ls "$D/models") — Programm: $D/bin"
