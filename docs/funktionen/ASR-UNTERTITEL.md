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

## Paket: Node, Engine und Modelle als ein Container-Image

Der Auto-Untertitel-Node ist ein **in sich geschlossenes, importierbares Paket**: ein Podman-Image mit dem Node, der Spracherkennungs-Engine (whisper.cpp) und den Modellen (`small`, `base`). Wer das Image bekommt, braucht sonst nichts — keine Installation von Engine oder Modellen auf dem Host. Es läuft wie jeder Container-Node des Systems (MXL-Verzeichnis eingehängt, Registry über `host.containers.internal`).

```
sh deploy/subtitle-asr/build.sh      # Image bauen (Node + Engine + Modelle aus data/asr-engine), Größe ca. 0,7 GB
sh deploy/subtitle-asr/import.sh     # als Node-Typ „Auto-Untertitel“ importieren (Admin; mit Aufnahmeprüfung)
sh deploy/subtitle-asr/uninstall.sh  # vollständig entfernen
```

Weitergeben: `podman save -o omp-subtitle-asr.tar localhost/omp-subtitle-asr:<Version>` und beim Empfänger `podman load -i …`, danach `import.sh` (oder `POST /api/v1/catalog` mit `deploy/subtitle-asr/catalog-entry.json`, Feld `image` anpassen).

**Deinstallieren** heißt: laufende Instanzen dieser Version beenden, Katalogeintrag entfernen (`DELETE /api/v1/catalog/omp-subtitle-asr?version=…`) **und das Image löschen**. Letzteres macht der Orchestrator beim Entfernen selbst (`podman rmi`, außer ein anderer Eintrag nutzt dasselbe Image); `uninstall.sh` fasst die drei Schritte zusammen. Es bleibt nichts zurück: Die Engine und die Modelle liegen nur im Image, die SRT-Spuren im (flüchtigen) Container. Wer die Spuren behalten will, lädt sie vorher über das Panel/`data/subtitles` des Containers herunter.

**Container und andere Nodes:** Aufrufe an andere Nodes (Grafik-Node, Bildmischer) laufen aus dem Container über den Host-Alias (`OMP_LOOPBACK_ALIAS`, gesetzt vom Launcher), weil `127.0.0.1` im Container der Container selbst ist.

## Engine im Node (auch ohne Container)

Die Spracherkennungs-Engine (whisper.cpp-Server) läuft **im Node**: Beim Start des Nodes startet sie mit, auf einem eigenen freien lokalen Port (mehrere Untertitel-Nodes stören sich nicht), wird überwacht (stürzt sie ab, startet sie neu) und endet mit dem Node — auch bei hartem Abbruch. Wird ein Untertitel-Node durch einen anderen ersetzt, ist damit auch seine Engine ersetzt.

**Nur für den Betrieb ohne Container (Entwicklung):** `sh tools/asr-engine/install.sh [Modell …]` legt Programm und Modelle unter `data/asr-engine/` ab (`bin/whisper-server`, `models/ggml-<Name>.bin`; Standard-Modell `small`, weitere z. B. `base`, `medium`). Vorhandene whisper.cpp-Übersetzung mit `WHISPER_SRC=<Pfad>` wiederverwenden, sonst wird geklont und gebaut (cmake, g++ nötig). Ordner abweichend: Option `OMP_ASR_HOME`. Ist nichts eingerichtet, meldet der Node den Befehl dazu.

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
* **Datenspur (CEA-608):** Der Node liefert sie als ANC-Datenflow. Der **ST-2110-Gateway (Ausgang)** sendet sie als **ST 2110-40** (RFC 8331, RTP/UDP) über seinen dritten Empfänger „ANC / Untertitel“ (Ziel `OMP_2110_GATEWAY_ANC_DEST_HOST`/`_PORT`, Standard 239.1.1.3:6004; SDP im Parameter `ancSdp`). **Nur im Rundlauf geprüft** (Paketieren → Lesen; Untertitel-Node → Gateway → UDP auf Loopback: 25 Pakete/s, Zeitstempelschritt 3600, keine Lücke in der Folge, DID/SDID 0x61/0x01) — **nicht mit echten ST-2110-40-Empfängern**; das SDP (`ancSdp`) enthält Absenderadresse, Quellenfilter, `ts-refclk` (PTP: `traceable`, sonst `localmac`) und die TTL; Payload-Type fest 100. **DeckLink/SDI:** der Ausgang hat ebenfalls den Empfänger „ANC / Untertitel“ und bettet die **CEA-708-CDPs** (DID 0x61/SDID 0x01) über `decklinkvideosink` (`cc-line` 9, `GstVideoCaptionMeta`) in die VANC-Zeile ein; Zähler im Parameter `ancStats`. **Andere ANC-Typen (SCTE-104, Zeitcode, private Pakete) kann dieser Weg nicht einbetten** — das bräuchte die ANC-Schnittstelle des DeckLink-SDK. Nicht an echter Hardware geprüft (Metadaten an den Puffern sind per Test belegt). Die Aufnahme von ANC aus SDI (Eingang) ist nicht umgesetzt: das GStreamer-Element dieser Version liefert keine Untertitel-Metadaten. Nicht vorhanden sind außerdem CEA-708-Dienste, Teletext/DVB-Subtitles und TTML/IMSC.

## SRT aus einer Datei erzeugen — mit Sprechererkennung (Kapitel 77)

Neben der Live-Erkennung kann derselbe Node eine **Mediendatei komplett transkribieren** (Methode `file.transcribe`) und eine SRT-Datei schreiben, auf Wunsch mit **Sprechernamen** („Alice: …“). Drei Zugänge:

* **Eingang → Datei → Reiter „Untertitel“:** Tonspur, Sprache, Sprecheranzahl (automatisch / 1 / 2 …), Namen (in der Reihenfolge des ersten Auftretens), Schreibweise (`Alice: …`, `[Alice] …`, `- Alice: …`). Aufträge mit Fortschritt, Abbrechen, Download und Löschen. API: `POST/GET /api/v1/review/items/{id}/subtitles`, `POST …/subtitles/{sid}/cancel`, `DELETE …/subtitles/{sid}`, `GET …/subtitles/{sid}/srt`.
* **Prozess-Schritt „Untertitel (SRT)“** (`subtitles`): Datei (Pfad) oder Asset-ID, dieselben Optionen; wartet, bis der Auftrag fertig ist. Ausgaben: `srt`, `playoutTrack`, `speakers`, `cues`, `durationS`.
* Das Ergebnis liegt (a) beim Asset (`<DataDir>/subtitles/<Asset>/<Name>.srt`, als Darstellung „subtitle“ an einer **neuen Asset-Version**, weil veröffentlichte Versionen unveränderlich sind) und (b) als Kopie in `data/subtitles` (`OMP_SUBTITLE_DIR`). Der Name dieser Kopie ist die **Spur** des Kind-Events `SUBTITLE` der Playout-Automation (`params.track`).

**Live pausiert bei SRT-Wiedergabe:** Spielt der Grafik-Node am Ausgang gerade eine Untertitel-Datei (`subtitle.running`), schreibt der Live-Teil des Auto-Untertitel-Nodes nichts mehr in die Ebene und löscht auch nichts; Status „live paused: subtitle file playing“, Parameter `liveSuppressed`. Endet die Datei, läuft die Live-Untertitelung von selbst weiter. Per Unit-Test belegt, **noch nicht im Live-Betrieb mit echtem Playout** geprüft.

### Dedizierter Datei-Node (Aufgabe „file“)

Dateiaufträge rechnen minutenlang auf mehreren Kernen. Damit sie die **Live-Untertitelung nie beeinträchtigen**, trennt die Option **Aufgabe** (`OMP_ASR_ROLE`) die Instanzen:

* `live` (Standard): Live-Untertitel aus einem Audiostream. Nimmt **keine** Dateiaufträge an (`file.transcribe` wird abgelehnt).
* `file`: dedizierter Datei-Node. Hat keine Live-Quelle, keine MXL-Ausgänge und keinen Live-Betrieb; nimmt `file.transcribe` an. Eingangskontrolle (Reiter „Untertitel“) und Prozess-Schritt „Untertitel (SRT)“ wählen **ausschließlich** Datei-Nodes (mit Sprechererkennung, wenn Namen gewünscht sind). Läuft keiner, meldet die Oberfläche das mit Hinweis auf die Option; ältere Nodes ohne den Parameter `role` zählen als `live`.

Für den Betrieb: eine Instanz „Auto-Untertitel“ mit Aufgabe `file` zusätzlich zur Live-Instanz starten (eigener Prozess bzw. Container, eigene Kerne; `OMP_ASR_THREADS` und `OMP_ASR_DIARIZE_THREADS` begrenzen die Last).

### Sprechererkennung einrichten

`sh tools/asr-engine/install-diarization.sh` lädt **sherpa-onnx** (Apache-2.0) und zwei ONNX-Modelle (Segmentierung: pyannote-segmentation-3-0, MIT; Sprecher-Einbettung: 3D-Speaker CAM++) nach `data/asr-engine/diarization/{bin,lib,models}`. Nichts davon liegt im Repo oder im Image. **Lizenz der Einbettungsmodelle nicht abschließend geprüft** — vor kommerzieller Nutzung klären (s. `THIRD-PARTY-NOTICES.md`). Ohne die Dateien erzeugt der Node SRT ohne Sprecher; die Oberfläche weist darauf hin.

WhisperX wird **nicht** verwendet (es bräuchte Python/PyTorch und das auf Hugging Face gesperrte pyannote-Modell); whisper.cpp + sherpa-onnx leisten dasselbe lokal und ohne Konto.

Umgebung: `OMP_ASR_HOME` (Engine-Verzeichnis), `OMP_FFMPEG`, `OMP_ASR_FILE_MAX_MINUTES` (180), `OMP_ASR_DIARIZE_THRESHOLD` (0,7; kleiner = mehr Sprecher), `OMP_ASR_DIARIZE_THREADS` (2).

### Wiedergabe im Takt des Bildes (Zeitcode, ST 12-2)

Der Kanal-Player gibt die Medienposition seines Clips als **Zeitcode-Strom** aus (Sender „Zeitcode (ANC)“, ATC_LTC nach SMPTE ST 12-2, ein Paket je Bild; 00:00:00:00 = Clipanfang). Verdrahtet man ihn auf den Empfänger **„Zeitcode“ des Grafik-Nodes**, folgt `subtitle.start` diesem Zeitcode statt einer freilaufenden Uhr: die SRT bleibt bei **Halt, Pause und Sprung** (Seek) bildgenau synchron, und bei Ausfall des Zeitcodes bleibt sie stehen, statt ohne Bild weiterzulaufen.

* `subtitle.start` (auch als Kind-Event `SUBTITLE`, `params`): `clock` = `auto` (Standard: Zeitcode, wenn einer anliegt, sonst freilaufend) | `timecode` (Fehler, wenn keiner anliegt) | `free`; `offsetMs` verschiebt die Spur; `fpsNum`/`fpsDen` = Bildrate des Zeitcodes (Standard 25/1). Der Parameter `subtitle` des Grafik-Nodes zeigt `clock` und den anliegenden Zeitcode.
* SRT-Dateien aus der Datei-Erzeugung sind **medienzeit-bezogen** (0 = Dateianfang) und passen damit zum Zeitcode des Kanal-Players ohne Versatz.
* Anzeige: Viewer (Overlay oben links, Empfänger „Zeitcode“) und Messgerät (ANC-Reiter: große Zeitcode-Anzeige, Sprungzähler, Gültigkeit). Geprüft: Kodierung gegen die Tabellen der Norm, Live-Lauf Kanal-Player → Messgerät/Viewer/Grafik-Node, SRT im Halt eingefroren (Position 120 ms über 3 s) und nach Freigabe mit dem Zeitcode synchron (erster Untertitel bei 7,5 s).
* Grenzen: nicht an echter ST-2110-/SDI-Hardware geprüft; die Halbbildmarke bei Raten über 30 Bilder/s wird nicht gesetzt (ST 12-2 §9.3 erlaubt das); der Zeitcode ist die Position in der Datei, nicht der Start-Zeitcode der MXF-Datei; Drop-Frame wird nur gelesen. Der Zeitcode wird aus der Position des Videozweigs abgeleitet — bis zu 2 Bilder Vorlauf gegenüber dem tatsächlich ausgegebenen Bild sind möglich (nicht gemessen).

## Grenzen

* Der Eingabepfad muss **auf dem Rechner des Nodes lesbar** sein. Im Container-Paket hängt der Launcher die Verzeichnisse aus `OMP_MEDIA_MOUNTS` (Umgebung des Orchestrators, absolute Pfade mit `:` getrennt) schreibgeschützt und mit gleichem Pfad ein (Katalogfeld `mediaRead`); ohne die Variable sieht der Container keine Medien. Das Image enthält ffmpeg und – falls beim Bauen `data/asr-engine/diarization` vorhanden war – die Sprechererkennung.
* Überlappendes Sprechen erscheint doppelt; kein Wort-genaues Alignment; die Sprecheranzahl bei „automatisch“ hängt von der Schwelle ab (im Test mit zwei Sprechern: 0,7 → 2, 0,5/0,6 → 3, 0,9 → 1).
* Gemessen: 34 s Zwei-Sprecher-Audio in ca. 20 s (Modell `base`). Geprüft mit dem sherpa-Beispiel (zwei Sprecher, Namen korrekt zugeordnet), **nicht** mit echtem Sendematerial und nicht im Container-Paket.

## Grenzen

* Live: nur Text, keine Sprecherkennung (die gibt es nur bei der Datei-Erzeugung, s. o.); keine Positions-/Farbangaben, keine Einbettung in CEA-608/708 oder Teletext (der Text läuft als Grafik).
* Mehrkanal-Quellen werden gleichmäßig auf mono gemischt; eine Quelle mit Sprache nur auf einem Kanal verliert dadurch Pegel (die Schwelle folgt dem Grundrauschen).
* Der Spitzenpegel in `stats.peakDb` zeigt, ob überhaupt Ton ankommt (≈ −90 dB = Stille).
* Getestet: Segmentierer und Aufbereitung (Unit-Tests), echte Sprache durch Segmentierer + whisper-Server (`cargo test -p omp-subtitle-asr -- --ignored`, Satz korrekt erkannt), MXL-Audiopfad mit Testton, Live-Anzeige in einen echten Grafik-Node und SRT-Datei mit dem Ersatz-Engine. **Nicht** getestet: echte Sprache über einen MXL-Flow im Gesamtsystem, Dauerbetrieb, Sprachen außer Englisch.
