#!/usr/bin/env bash
# Stream-Deck-Zugriff für den Browser (WebHID) unter Linux: udev-Regel, die dem angemeldeten
# Benutzer Zugriff auf die HID-Geräte des Herstellers (USB-Vendor 0fd9) gibt.
#
# WICHTIG: Die Regel gehört auf den Rechner, an dem das Gerät steckt und der Browser läuft
# (Bedienplatz) — nicht zwingend auf den OMP-Server. WebHID läuft im Browser.
#
#   deploy/dev/streamdeck-udev.sh             Regel installieren (sudo) und udev neu laden
#   deploy/dev/streamdeck-udev.sh --remove    Regel wieder entfernen
#   deploy/dev/streamdeck-udev.sh --dry-run   nur anzeigen, was getan würde
#
# Danach das Gerät einmal abziehen und wieder anstecken (bzw. neu anmelden), falls es nicht sofort geht.
# Die Herstellersoftware muss geschlossen sein (sie hält das Gerät exklusiv).
set -euo pipefail

RULE_DIR="${OMP_UDEV_DIR:-/etc/udev/rules.d}"
RULE_FILE="$RULE_DIR/70-omp-streamdeck.rules"
DRY=0; REMOVE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done

RULE='# OpenMediaPlatform: Stream Deck per WebHID (Browser) — Zugriff für den angemeldeten Benutzer
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", TAG+="uaccess", MODE="0660"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess", MODE="0660"'

SUDO=""
if [ "$(id -u)" -ne 0 ] && [ -z "${OMP_UDEV_DIR:-}" ]; then SUDO="sudo"; fi

run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

if [ "$REMOVE" = 1 ]; then
  echo "Entferne $RULE_FILE"
  run $SUDO rm -f "$RULE_FILE"
else
  echo "Schreibe $RULE_FILE:"
  echo "$RULE" | sed 's/^/    /'
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $SUDO tee $RULE_FILE"
  else
    $SUDO mkdir -p "$RULE_DIR"
    echo "$RULE" | $SUDO tee "$RULE_FILE" >/dev/null
  fi
fi

if [ -z "${OMP_UDEV_DIR:-}" ] && command -v udevadm >/dev/null 2>&1; then
  run $SUDO udevadm control --reload-rules
  run $SUDO udevadm trigger --subsystem-match=hidraw --attr-match=idVendor=0fd9 || true
  run $SUDO udevadm trigger --subsystem-match=usb --attr-match=idVendor=0fd9 || true
fi
echo "Fertig. Gerät einmal abziehen und wieder anstecken, falls der Browser es noch nicht sieht."
