#!/bin/sh
# Legt die Grafikvorlagen in den Build-Kontext (Ordner templates/). Die Vorlagen liegen nicht im Repository; ohne sie startet das Image nur mit der eingebauten Untertitel-Vorlage.
set -eu
SRC="${OMP_OGRAF_TEMPLATES:-data/ograf-templates}"
mkdir -p "$1/templates"
[ -d "$SRC" ] && cp -a "$SRC/." "$1/templates/" || echo "Hinweis: keine Vorlagen in $SRC — Image enthält nur die eingebaute Untertitel-Vorlage" >&2
