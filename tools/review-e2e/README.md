# Review-E2E (Kapitel 43)

Browser-Test des Eingangs-Tabs gegen einen **laufenden Orchestrator** (Chromium headless, puppeteer-core): Import → QC → Liste → Bericht → Übernehmen → Player
(Bild-genaue Navigation, gemessen am tatsächlich dargestellten Bild) → Segment → Speichern → Einreichen → Freigeben.

Voraussetzung: Orchestrator auf `OMP_URL` (Standard `http://127.0.0.1:18000`) **ohne Benutzerverwaltung** (Bootstrap-Modus) und mit gebautem UI (`make ui`);
Einstellung `importDir` zeigt auf ein Verzeichnis mit `burn_demo.mxf`:

```
ffmpeg -y -f lavfi -i "color=c=black:s=640x360:r=25:d=6,format=yuv422p,$(node -e "console.log(Array.from({length:8},(_,k)=>\`drawbox=x=\${16+40*k}:y=16:w=32:h=32:color=white:t=fill:enable='gte(mod(floor(n/\${1<<k}),2),1)'\`).join(','))")" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:d=6,volume=-23dB" -f lavfi -i "sine=frequency=660:sample_rate=48000:d=6,volume=-23dB" \
  -map 0:v -map 1:a -map 2:a -t 4 -c:v mpeg2video -pix_fmt yuv422p -b:v 30M -g 12 -bf 0 -flags +ildct+ilme -top 1 -c:a pcm_s24le -timecode 01:00:00:00 -f mxf burn_demo.mxf
```

Die Fixture codiert die Frame-Nummer als 8 weiße/schwarze Kästchen; der Test liest sie aus dem `<video>` zurück. Start: `node e2e.cjs` (Variablen `PUPPETEER_CORE`, `CHROMIUM`, `REVIEW_E2E_OUT` für Screenshots).
Nicht Teil von `make check` (braucht Orchestrator, Postgres, NATS und Chromium).
