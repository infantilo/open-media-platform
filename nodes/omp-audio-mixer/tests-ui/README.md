# UI- und Stabilitätstests des Audiomischers (Kapitel 26)

Die Konsolen-UI (`../ui/*.js`) wird ohne Orchestrator gegen eine **eigene Test-Instanz**
des Nodes geprüft — nichts davon berührt einen laufenden Stack.

1. Node auf eigenem Port/eigener MXL-Domain starten (Stub-Registry/-Orchestrator liefert
   `stubreg.py` auf Port 18010):
   `OMP_PORT=9791 OMP_MXL_DOMAIN=/dev/shm/claude-mxltest OMP_REGISTRY_URL=http://127.0.0.1:18010 \
    OMP_ORCHESTRATOR_URL=http://127.0.0.1:18010 OMP_INSTANCE_ID=t OMP_LAUNCH_SECRET=s \
    OMP_NATS_URL=nats://127.0.0.1:1 target/debug/omp-audio-mixer`
2. `python3 harness.py` — serviert die UI und proxied `/api/v1/nodes/test/...` auf den Node.
3. `python3 seed.py 8` — realistischer Mix (Gruppen, AutoMix, Ducking, Aux/N-1, Szenen …).
4. Headless Chromium mit `--remote-debugging-port=9333`, dann (Node-Modul `ws` nötig):
   - `node interact.mjs` — Maus/Tastatur: Mute, Fader, EQ-Handles, Slider, Gruppen, Szenen,
     „Layoutwechsel ändert den Audio-State nicht“, Fader ausgeblendet = Wert bleibt
   - `node touch.mjs` — echte Touch-Events: Zielgrößen, horizontaler/vertikaler Wisch,
     Scroll vs. Fader, Long-Press
   - `node shots.mjs '[["name",breite,hoehe,mobile,"setup-js"]]'` — Screenshots (Testmatrix)
5. `bash stress.sh 30` — Neustart-Stresstest: nach jedem Start prüft `levels.py`, dass JEDER
   Kanal und der Master Pegel melden (fing drei zufällige GStreamer-Races, s. Memory
   „three intermittent races“).
