#!/usr/bin/env bash
# Installiert das optionale GStreamer-Plugin "avvideofilter" (Bildratenwandlung "blend",
# docs/INSTALLATION.md §9). Ohne das Plugin laufen alle Nodes unverändert mit "videorate".
# Das Plugin ist ein Fremdprojekt von emcodem (https://github.com/emcodem/avvideofilter, LGPL-2.1+,
# s. THIRD-PARTY-NOTICES.md); es wird hier nur heruntergeladen/installiert, nicht verändert.
#
#   ./deploy/dev/install-avvideofilter.sh                 lädt die angepinnte Version aus dem Internet
#   ./deploy/dev/install-avvideofilter.sh --archive DATEI Archiv von Hand mitgebracht (kein Internet nötig)
#   ./deploy/dev/install-avvideofilter.sh --check         nur prüfen, ob das Plugin geladen wird
#   ./deploy/dev/install-avvideofilter.sh --dir VERZ      anderes Zielverzeichnis
#
# Ohne --archive wird zuerst in deploy/dev/vendor/ nach dem angepinnten Archiv gesucht (Offline-Weg).
# Das Archiv wird IMMER gegen den angepinnten SHA256 geprüft. Ziel (Standard):
# ${XDG_DATA_HOME:-~/.local/share}/gstreamer-1.0/plugins — dort sucht GStreamer ohne weitere Einstellung.
# Beendet sich mit 0 auch dann, wenn das Plugin nicht passt (optional) — Grund steht in der Ausgabe;
# Exit 1 nur bei --check ohne funktionierendes Plugin, Exit 2 bei falscher Bedienung/Prüfsumme.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=avvideofilter.version
. "$HERE/avvideofilter.version"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gstreamer-1.0/plugins"
ARCHIVE=""; CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="${2:-}"; shift 2 || exit 2 ;;
    --dir) DEST="${2:-}"; shift 2 || exit 2 ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
loads() { GST_PLUGIN_PATH="${1:-$DEST}${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}" gst-inspect-1.0 avvideofilter >/dev/null 2>&1; }

if [ "$CHECK" = 1 ]; then
  if have gst-inspect-1.0 && gst-inspect-1.0 avvideofilter >/dev/null 2>&1; then
    echo "avvideofilter: geladen (Standard-Pfade)"; exit 0
  fi
  if have gst-inspect-1.0 && loads; then echo "avvideofilter: geladen aus $DEST"; exit 0; fi
  echo "avvideofilter: nicht verfügbar — Nodes nutzen 'videorate'"; exit 1
fi

skip() { echo "avvideofilter übersprungen: $* — Nodes nutzen weiter 'videorate' (blend nicht verfügbar)."; exit 0; }

[ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || skip "Release gibt es nur für Linux x86_64"
have gst-inspect-1.0 || skip "GStreamer (gst-inspect-1.0) fehlt"
# glibc >= 2.35 und GStreamer >= 1.20 (Anforderung des Plugin-Builds)
glibc="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
gst="$(gst-inspect-1.0 --version 2>/dev/null | awk '/^GStreamer/ {print $2}')"
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
[ -n "$glibc" ] && ver_ge "$glibc" 2.35 || skip "glibc ${glibc:-unbekannt} < 2.35"
[ -n "$gst" ] && ver_ge "$gst" 1.20 || skip "GStreamer ${gst:-unbekannt} < 1.20"

if gst-inspect-1.0 avvideofilter >/dev/null 2>&1 || loads; then
  echo "avvideofilter bereits vorhanden — nichts zu tun."; exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ -z "$ARCHIVE" ]; then
  for c in "$HERE/vendor/$AVF_ASSET" "$HOME/$AVF_ASSET"; do [ -f "$c" ] && { ARCHIVE="$c"; echo "Archiv gefunden: $c"; break; }; done
fi
if [ -z "$ARCHIVE" ]; then
  have curl || skip "curl fehlt und kein Archiv angegeben (--archive DATEI)"
  url="https://github.com/emcodem/avvideofilter/releases/download/$AVF_VERSION/$AVF_ASSET"
  echo "Lade $url"
  curl -fsSL --retry 2 --connect-timeout 15 -o "$tmp/$AVF_ASSET" "$url" || skip "Download fehlgeschlagen (kein Internet? dann --archive DATEI, s. docs/INSTALLATION.md §9)"
  ARCHIVE="$tmp/$AVF_ASSET"
fi
[ -f "$ARCHIVE" ] || { echo "Archiv nicht gefunden: $ARCHIVE" >&2; exit 2; }
sum="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
if [ "$sum" != "$AVF_SHA256" ]; then
  echo "FEHLER: SHA256 stimmt nicht (erwartet $AVF_SHA256, gefunden $sum) — Archiv nicht installiert." >&2; exit 2
fi
mkdir -p "$tmp/x" "$DEST" || exit 2
tar -xzf "$ARCHIVE" -C "$tmp/x" --strip-components=1 || { echo "Entpacken fehlgeschlagen" >&2; exit 2; }
[ -f "$tmp/x/libgstavvideofilter.so" ] || { echo "Archiv enthält libgstavvideofilter.so nicht" >&2; exit 2; }
# vor dem Kopieren testen, damit ein unpassendes Plugin keine Spur hinterlässt
if ! loads "$tmp/x"; then skip "Plugin lässt sich auf diesem System nicht laden"; fi
rm -rf "$DEST/avvideofilter-ffmpeg" "$DEST/libgstavvideofilter.so"
cp -a "$tmp/x/." "$DEST/" || exit 2
if gst-inspect-1.0 avvideofilter >/dev/null 2>&1 || loads; then
  echo "avvideofilter $AVF_VERSION installiert nach $DEST"
else
  skip "nach dem Kopieren nicht ladbar"
fi
