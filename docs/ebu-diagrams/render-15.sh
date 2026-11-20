#!/bin/sh
# PNG (1920x1080) und PDF (eine Seite 1920x1080 px) der Grafik 15 mit Chromium (headless) erzeugen.
cd "$(dirname "$0")" || exit 1
for v in "" dark/; do
  svg="${v}15-tams-implemented.svg"
  html="${v}15-tams-implemented.print.html"
  printf '<!doctype html><meta charset="utf-8"><style>@page{size:1920px 1080px;margin:0}html,body{margin:0;padding:0}img{display:block;width:1920px;height:1080px}</style><img src="15-tams-implemented.svg">' > "$html"
  chromium --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1920,1080 --screenshot="${v}15-tams-implemented.png" "file://$PWD/$svg" >/dev/null 2>&1
  chromium --headless --no-sandbox --disable-gpu --no-pdf-header-footer --print-to-pdf="${v}15-tams-implemented.pdf" "file://$PWD/$html" >/dev/null 2>&1
  rm -f "$html"
done
