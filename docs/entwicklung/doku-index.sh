#!/bin/sh
# Erzeugt docs/entwicklung/DOKU-INDEX.md: Ueberschriften von UMSETZUNG.md und
# ARCHITECTURE.md mit Zeilennummern, damit nur der benoetigte Abschnitt gelesen
# werden muss (Read mit offset/limit). Nach groesseren Doku-Aenderungen neu laufen lassen.
cd "$(dirname "$0")/../.." || exit 1
out=docs/entwicklung/DOKU-INDEX.md
{
  echo "# Doku-Index (generiert, Zeilennummern)"
  echo
  echo "Erzeugt mit \`sh docs/entwicklung/doku-index.sh\`. Abschnitt gezielt lesen: Read mit offset=Zeile, limit=Länge bis zur nächsten Zeile."
  for f in UMSETZUNG.md ARCHITECTURE.md; do
    echo
    echo "## $f"
    echo
    grep -n '^## ' "$f" | sed -E 's/^([0-9]+):## /\1 /; s/ \((Nutzer|Idee|Design|Plan|umgesetzt|geplant|Bestandsaufnahme|Audit).*$//; s/ \*\*.*$//' | cut -c1-110
  done
} > "$out"
