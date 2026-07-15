#!/usr/bin/env bash
# Installiert das GStreamer-WPE-WebKit-Plugin (`wpesrc`) für omp-ograf
# (K5-Teil-1, Variante A — Go-Entscheidung K5-Teil-0, docs/decisions.md
# 2026-07-15: Paketierung war entgegen der ursprünglichen Sorge in
# docs/END-GOAL-FEATURES.md §5.3 kein Problem, nur nicht vorinstalliert).
# Idempotent (apt install auf ein bereits installiertes Paket ist ein
# No-Op).
set -euo pipefail

sudo apt-get update
sudo apt-get install -y gstreamer1.0-wpe libwpebackend-fdo-1.0-1

gst-inspect-1.0 wpesrc > /dev/null
echo "wpesrc registriert."
