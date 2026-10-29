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

## Engine (gehört zum Node)

Die Spracherkennungs-Engine (whisper.cpp-Server) läuft **im Node**: Beim Start des Nodes startet sie mit, auf einem eigenen freien lokalen Port (mehrere Untertitel-Nodes stören sich nicht), wird überwacht (stürzt sie ab, startet sie neu) und endet mit dem Node — auch bei hartem Abbruch. Wird ein Untertitel-Node durch einen anderen ersetzt, ist damit auch seine Engine ersetzt.

**Einrichten (einmal je Rechner):** `sh tools/asr-engine/install.sh [Modell …]` legt Programm und Modelle unter `data/asr-engine/` ab (`bin/whisper-server`, `models/ggml-<Name>.bin`; Standard-Modell `small`, weitere z. B. `base`, `medium`). Vorhandene whisper.cpp-Übersetzung mit `WHISPER_SRC=<Pfad>` wiederverwenden, sonst wird geklont und gebaut (cmake, g++ nötig). Ordner abweichend: Option `OMP_ASR_HOME`. Ist nichts eingerichtet, meldet der Node den Befehl dazu.

**Modell wechseln:** im Panel unter „Modell“ (Methode `engine.setModel`). Die Engine lädt das neue Modell einige Sekunden (Status „Engine lädt …“, laufende Abschnitte in der Zeit entfallen); die Wahl bleibt gemerkt. Größere Modelle erkennen genauer, brauchen aber mehr Rechenzeit — die Erkennung muss schneller als Echtzeit laufen, sonst werden Abschnitte verworfen (`stats.dropped`). **Geschwindigkeit (gemessen auf einem mit Medien-Nodes ausgelasteten 8-Kern-Rechner, Last 11–14):** Whisper rechnet standardmäßig immer ein festes 30-s-Fenster, auch für einen 4-s-Abschnitt — der Encoder braucht bei `small` dann ca. 10 s, unabhängig von der Abschnittslänge, und mehr Threads helfen nicht (6–8 Threads waren bei dieser Last sogar viel langsamer). Der Node startet die Engine deshalb mit einem **zum längsten Abschnitt passenden Audio-Kontext** (`-ac`, bei 8 s Abschnitten 512 = 10-s-Fenster; Option `OMP_ASR_AUDIO_CTX`, `0` = volles Fenster). Ergebnis je 8-s-Abschnitt: `small` 11 s → **2,4–3,5 s**, `base` 3,6 s → 0,8 s, bei identischem Text im Test (englischer Satz). Kürzere Abschnitte allein bringen dagegen nichts. Abschnitte, die länger als das Fenster sind, würden abgeschnitten: `OMP_ASR_MAX_SEGMENT_MS` und Kontext bleiben deshalb gekoppelt (automatisch). Die Genauigkeit mit kleinem Fenster ist nur an einem Satz geprüft — bei Qualitätsproblemen `OMP_ASR_AUDIO_CTX=0` testen.

**Externe Engine (Ausnahme):** mit `OMP_ASR_URL` nutzt der Node eine bereits laufende Engine, dann ohne Modellwahl im Panel. `OMP_ASR_ENGINE=mock` ersetzt die Erkennung für Tests.

Ohne GPU belastet die Engine mehrere Kerne (`OMP_ASR_THREADS`, `OMP_CPU_AFFINITY` zum Abgrenzen vom Sendepfad).

## Bedienung

Kachel **Auto-Untertitel**: Audioquelle wählen, Sprache, optional Grafik-Node und Bildmischer für die Live-Anzeige (der Node schaltet den Keyer selbst), optional Spur mitschreiben. Parameter: `status`, `engineStatus`, `lastText`, `cues`, `stats` (Segmente, verworfen, Fehler, letzte Erkennung ms, Samples, Spitzenpegel); Methoden `selectSource`, `track.start`, `track.stop`, `clear`.

## Wo sieht man die Untertitel, wie kommen sie an die Gateways

Der Node hat drei Ausgänge:

| Ausgang | Was | Wofür |
|---|---|---|
| **Untertitel-Text** (MXL-Datenflow) | je Bild der aktuell anzuzeigende Text in einem privaten ANC-Paket (DID 0x5E/SDID 0x01) | Aux-Eingang „Untertitel“ von Viewer und Multiviewer (HTML-Overlay) |
| **CEA-608 (ANC)** (MXL-Datenflow) | CEA-608-Pop-on (CC1) im Caption Distribution Packet (DID 0x61/SDID 0x01), ein CDP je Bild | Datenspur für Gateways, die ANC einbetten können (SDI, ST 2110-40) |
| **Live-Grafik** (Aufruf an den Grafik-Node) | Text in die OGraf-Ebene `subtitle` | eingebrannt über den Keyer des Mischers in PGM |

Beide Datenflows sind normale NMOS-Sender (Format `data`) und im Flow-Editor verdrahtbar. Die Bildrate stellt `OMP_ASR_FPS` ein (Standard 25/1; CEA-608 kennt 24, 25, 29,97, 30, 50, 59,94, 60). **CEA-608 hat 32 Zeichen je Zeile, höchstens 2 Zeilen**; Umlaute und ß gehen über die erweiterten Zeichen, übrige Akzente werden ohne Akzent gesendet. Gemessen: ca. 25 CDPs je Sekunde, gültige Prüfsumme, lückenlose Zählung.

### Viewer und Multiviewer: Aux-Eingang „Untertitel“

* **Viewer** und **Multiviewer** (automatisch und frei) haben einen zusätzlichen Eingang „… Untertitel“ (Format `data`). Den Text-Strom des Untertitel-Nodes dort verdrahten: der Text erscheint als **HTML-Overlay** über der Vorschau (Panel des Viewers, Kacheln im Flow-Editor, Operator-Konsole) — er wird nicht ins Bild gerendert und kostet keine Rechenzeit im Node.
* **Einbrennen (nur frei konfigurierbarer Multiviewer, optional):** Der Multiviewer hat einen echten PGM-Ausgang. Mit `burnSubtitle` (Panel-Schalter „Untertitel ins PGM-Bild einbrennen“, Umgebung `OMP_MULTIVIEWER_SUBTITLE_BURN`) rendert er den Text zusätzlich in diesen Ausgang. **Standard aus**: dann läuft kein Text-Element mit, und die Browser-Vorschau bleibt in jedem Fall sauber (dort gilt das HTML-Overlay). Beim Umschalten baut sich die Pipeline kurz neu auf. Der einfache Multiviewer hat nur die Browser-Vorschau, also nur das Overlay.
* Der CEA-608-Strom ist für Gateways gedacht; Viewer und Multiviewer lesen nur den Text-Strom.

Die Live-Grafik ist eine **Grafik** (OGraf-Ebene `subtitle`) und wandert wie jede Grafik durch den Signalweg:

```
Auto-Untertitel ─▶ Grafik-Node (Ebene „subtitle“, Fill+Key) ─▶ Keyer des Bildmischers ─▶ PGM ─┬▶ Viewer / Multiviewer (sehen)
                                                                                                ├▶ SRT-Gateway (Uplink)
                                                                                                ├▶ ST-2110-Gateway (Ausgang) / SDI-Ausgabe (DeckLink)
                                                                                                └▶ WebRTC-Gateway (Handy/Browser)
```

* **Ansehen:** im Viewer oder Multiviewer das **PGM des Bildmischers** zeigen — dort ist der Untertitel eingebrannt, sobald der Keyer aktiv ist. Den Grafik-Node allein (Fill/Key) kann man ebenfalls im Viewer ansehen. In der Kachel des Auto-Untertitel-Nodes stehen außerdem der zuletzt erkannte Text und die Liste der Einheiten.
* **Keyer:** Der Node legt den Fill des Grafik-Nodes selbst in den Keyer des Mischers und schaltet ihn ein, wenn im Panel (oder per `OMP_ASR_MIXER_LABEL`) der **Bildmischer** gewählt ist. Datei-Untertitel (Kind-Event `SUBTITLE` der Playout-Automation) tun das jetzt ebenfalls, wie die Grafik-Kinder.
* **Übergabe an Gateways:** Alles, was am PGM hängt, trägt den eingebrannten Untertitel — SRT-Gateway (Uplink), ST-2110-Gateway, DeckLink/SDI, WebRTC. Dafür ist nichts weiter einzustellen. Soll ein Ausgang **ohne** Untertitel laufen, den Gateway nicht an PGM, sondern an einen Mischer-Ausgang ohne Keyer hängen (Clean Feed).
* **Datenspur (CEA-608):** Der Node liefert sie als ANC-Datenflow. Die Gateways (ST 2110, DeckLink/SDI) **betten ANC aber noch nicht ein** — das ist der nächste Schritt (ein Daten-Eingang im Gateway). Nicht vorhanden sind außerdem CEA-708-Dienste, Teletext/DVB-Subtitles und TTML/IMSC.

## Grenzen

* Nur Text; keine Sprecherkennung, keine Positions-/Farbangaben, keine Einbettung in CEA-608/708 oder Teletext (der Text läuft als Grafik).
* Mehrkanal-Quellen werden gleichmäßig auf mono gemischt; eine Quelle mit Sprache nur auf einem Kanal verliert dadurch Pegel (die Schwelle folgt dem Grundrauschen).
* Der Spitzenpegel in `stats.peakDb` zeigt, ob überhaupt Ton ankommt (≈ −90 dB = Stille).
* Getestet: Segmentierer und Aufbereitung (Unit-Tests), echte Sprache durch Segmentierer + whisper-Server (`cargo test -p omp-subtitle-asr -- --ignored`, Satz korrekt erkannt), MXL-Audiopfad mit Testton, Live-Anzeige in einen echten Grafik-Node und SRT-Datei mit dem Ersatz-Engine. **Nicht** getestet: echte Sprache über einen MXL-Flow im Gesamtsystem, Dauerbetrieb, Sprachen außer Englisch.
