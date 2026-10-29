# Automatische Untertitelung (omp-subtitle-asr)

Der Node **Auto-Untertitel** liest einen MXL-Audiostream, erkennt die Sprache abschnittsweise und liefert den Text

* **live** in die Untertitel-Ebene eines Grafik-Nodes (Vorlage `subtitle`, Ebene `subtitle` — dieselbe Ebene, die die Datei-Untertitel-Engine des Grafik-Nodes nutzt) und
* als **SRT-Spur** (`data/subtitles/<Name>.srt`, Zeiten = echte Sprechzeiten ab „Spur starten“) für Nachbearbeitung, Wiederholung und das Untertitel-Kind-Event der Playout-Automation (`SUBTITLE`, `params.track`).

## Aufbau

```
MXL-Audio ─ Pipeline (mono, 16 kHz) ─ Segmentierer (Sprechpausen) ─ Engine (whisper.cpp-Server) ─ Text
                                                                                                   ├─ Live: OGraf-Ebene „subtitle“
                                                                                                   └─ Spur: SRT-Datei
```

* **Segmentierer** (`src/segment.rs`): Pegel je 20 ms gegen mitlaufendes Grundrauschen; Abschnitt endet nach 600 ms Stille oder spätestens nach 8 s (`OMP_ASR_END_SILENCE_MS`, `OMP_ASR_MAX_SEGMENT_MS`). Klicks unter 250 ms werden verworfen.
* **Engine** (`src/engine.rs`): `whisper` (lokaler `whisper-server`, HTTP `POST /inference`) oder `mock` (Ersatz ohne Modell für Tests). Der Node enthält kein Modell und keine Cloud-Anbindung; alles bleibt auf dem Host.
* **Aufbereitung** (`src/output.rs`): Zeilen ≤ 42 Zeichen, ≤ 2 Zeilen je Einheit, Anzeigedauer nach Lesegeschwindigkeit (15 Zeichen/s, 1,2–7 s).
* Liegt die Engine hinter dem Echtzeitbedarf zurück, werden Segmente verworfen (Zähler `dropped`) statt den Rückstand wachsen zu lassen.

## Zeitverhalten

Erkennung läuft **nach** dem Sprechen: Verzug = Rest des Abschnitts + Rechenzeit (gemessen mit Modell `base`, 3 Threads: ≈ 0,4 × Echtzeit, also ~3 s für 8 s Audio). Live erscheint der Text deshalb mit einigen Sekunden Verzug; die SRT-Spur trägt dagegen die tatsächlichen Sprechzeiten. Für Sendebetrieb mit festen Sprechzeiten die Spur aufnehmen und danach als Datei-Untertitel abspielen.

## Engine einrichten (whisper.cpp)

```
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j4
sh models/download-ggml-model.sh small        # oder base (Test), medium (genauer, langsamer)
```

Im Node (Instanz-Einstellungen): `OMP_ASR_BIN` = `…/build/bin/whisper-server`, `OMP_ASR_MODEL` = `…/models/ggml-small.bin`. Der Node startet die Engine dann selbst, wenn unter `OMP_ASR_URL` (Standard `http://127.0.0.1:8178`) keine antwortet, und beendet sie mit sich. Die Bibliotheken liegen neben dem Programm (`build/bin`): ist `LD_LIBRARY_PATH` nicht gesetzt, den Pfad dorthin aufnehmen. Alternativ läuft der Server als eigener Dienst; dann nur `OMP_ASR_URL` setzen.

Richtwerte: `base` ≈ 140 MB, schnell, für Tests; `small` ≈ 470 MB, brauchbare Genauigkeit für Deutsch; größere Modelle brauchen deutlich mehr Rechenzeit — die Erkennung muss schneller als Echtzeit bleiben. Ohne GPU belastet die Engine mehrere Kerne (`OMP_ASR_THREADS`, `OMP_CPU_AFFINITY` zum Abgrenzen vom Sendepfad).

## Bedienung

Kachel **Auto-Untertitel**: Audioquelle wählen, Sprache, optional Grafik-Node und Bildmischer für die Live-Anzeige (der Node schaltet den Keyer selbst), optional Spur mitschreiben. Parameter: `status`, `engineStatus`, `lastText`, `cues`, `stats` (Segmente, verworfen, Fehler, letzte Erkennung ms, Samples, Spitzenpegel); Methoden `selectSource`, `track.start`, `track.stop`, `clear`.

## Wo sieht man die Untertitel, wie kommen sie an die Gateways

Die Live-Untertitel sind eine **Grafik** (OGraf-Ebene `subtitle`), keine Datenspur. Sie wandern deshalb wie jede Grafik durch den Signalweg:

```
Auto-Untertitel ─▶ Grafik-Node (Ebene „subtitle“, Fill+Key) ─▶ Keyer des Bildmischers ─▶ PGM ─┬▶ Viewer / Multiviewer (sehen)
                                                                                                ├▶ SRT-Gateway (Uplink)
                                                                                                ├▶ ST-2110-Gateway (Ausgang) / SDI-Ausgabe (DeckLink)
                                                                                                └▶ WebRTC-Gateway (Handy/Browser)
```

* **Ansehen:** im Viewer oder Multiviewer das **PGM des Bildmischers** zeigen — dort ist der Untertitel eingebrannt, sobald der Keyer aktiv ist. Den Grafik-Node allein (Fill/Key) kann man ebenfalls im Viewer ansehen. In der Kachel des Auto-Untertitel-Nodes stehen außerdem der zuletzt erkannte Text und die Liste der Einheiten.
* **Keyer:** Der Node legt den Fill des Grafik-Nodes selbst in den Keyer des Mischers und schaltet ihn ein, wenn im Panel (oder per `OMP_ASR_MIXER_LABEL`) der **Bildmischer** gewählt ist. Datei-Untertitel (Kind-Event `SUBTITLE` der Playout-Automation) tun das jetzt ebenfalls, wie die Grafik-Kinder.
* **Übergabe an Gateways:** Alles, was am PGM hängt, trägt den eingebrannten Untertitel — SRT-Gateway (Uplink), ST-2110-Gateway, DeckLink/SDI, WebRTC. Dafür ist nichts weiter einzustellen. Soll ein Ausgang **ohne** Untertitel laufen, den Gateway nicht an PGM, sondern an einen Mischer-Ausgang ohne Keyer hängen (Clean Feed).
* **Nicht möglich:** Untertitel als eigene Datenspur (CEA-608/708, Teletext/DVB-Subtitles, TTML/IMSC, ST-2110-40-ANC). Dafür bräuchte es einen Inserter im Gateway; das gibt es bisher nicht (der ANC-Aufbau in `omp-scte35` trägt nur SCTE-104). Die SRT-Spur ist die Vorstufe dafür: aus ihr lassen sich solche Formate später ableiten.

## Grenzen

* Nur Text; keine Sprecherkennung, keine Positions-/Farbangaben, keine Einbettung in CEA-608/708 oder Teletext (der Text läuft als Grafik).
* Mehrkanal-Quellen werden gleichmäßig auf mono gemischt; eine Quelle mit Sprache nur auf einem Kanal verliert dadurch Pegel (die Schwelle folgt dem Grundrauschen).
* Der Spitzenpegel in `stats.peakDb` zeigt, ob überhaupt Ton ankommt (≈ −90 dB = Stille).
* Getestet: Segmentierer und Aufbereitung (Unit-Tests), echte Sprache durch Segmentierer + whisper-Server (`cargo test -p omp-subtitle-asr -- --ignored`, Satz korrekt erkannt), MXL-Audiopfad mit Testton, Live-Anzeige in einen echten Grafik-Node und SRT-Datei mit dem Ersatz-Engine. **Nicht** getestet: echte Sprache über einen MXL-Flow im Gesamtsystem, Dauerbetrieb, Sprachen außer Englisch.
