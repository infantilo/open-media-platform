# Review-Ton im echten Browser (Kapitel 43)

Prüft `ui/modules/review/audio.ts` in Chromium (headless) ohne Orchestrator: ein Analysator vor dem Ausgang misst, was die Engine tatsächlich abspielt —
Stille vor dem Toneinsatz, Ton danach, Stopp, Rückwärts, Scrub-Stück, Spurwahl, Blockwechsel.

```
H=$(mktemp -d); cp tools/review-e2e/audio-browser/{index.html,run.cjs} $H; mkdir -p $H/a/0 $H/a/1
# Testblöcke (10 s WAV je Block): Spur 0 = 1 s Stille dann 1 kHz, Spur 1 = 300 Hz dauernd; siehe gen.py
python3 tools/review-e2e/audio-browser/gen.py $H
deno bundle ui/modules/review/audio.ts -o $H/audio.bundle.js
(cd $H && python3 -m http.server 18765 --bind 127.0.0.1 &) ; PUPPETEER_CORE=… node $H/run.cjs
```
Erwartung: `fwd_silent`/`after_stop`/`grain_after`/`grain_silence` = 0, alle Ton-Werte > 0,05.
