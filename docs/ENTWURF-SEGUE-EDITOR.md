# Entwurf: Segue-Editor (Übergangs-Editor, RB7)

Stand: 2026-11-06 · Status: **Entwurf, nichts gebaut** · Auftrag: Nutzerwunsch („intelligenter Übergangs-Editor: exaktes Vorhören und
visuelles Verschieben von Übergängen — Überblendungen, Intros, Outros — zwischen zwei Titeln oder Beiträgen, ohne die Spuren
destruktiv zu verändern").

## 1. Ziel

Eine Person hört einen Übergang A → B genau so vor, wie ihn `omp-radio-automation` später sendet, und verschiebt ihn mit der Maus:
den Segue-Punkt von A, den Einstieg von B, die Länge und Form der Blende, das Intro-Ende von B (Moderation darüber). Das Ergebnis
sind **nur Zahlen** (Marken und Kurven); die Audiodateien werden nie verändert (vgl. RE4: nicht-destruktive EDL).

## 2. Was schon da ist

* `omp-playout-core::segue::plan()` berechnet aus `Item` (SOM, Intro, Outro/Segue-Punkt, Gain) und `Config` (Blendlänge, Kurve,
  Jingle-Regeln) je Stimme `Placed` (Start, Offset, Ein-/Ausblendung mit Kurve, Stopp). Das ist die **einzige** Wahrheit für die Sendung.
* Marken je Log-Element (`somMs`, `introMs`, `outroMs`) im Panel von `omp-radio-automation` (Tabelle, Zahleneingabe).
* Wellenform-Darstellung samt Zoom im Review-Player (`ui/modules/review/waveform.ts`, `timeline-zoom.ts`, Spitzenwerte vom Server).
* `omp-segue-player` spielt `voice.load{markers}` / `startAt` sample-genau.

Es fehlt: Marken **sehen und ziehen**, den Übergang **hören**, und ein Ort, an dem **Abweichungen je Paar** gespeichert werden.

## 3. Modell (nicht-destruktiv)

* **Marken je Datei** (Eigenschaft des Materials, gelten überall): SOM, Intro-Ende, Segue-Punkt, später Hook. Heute im Log je Element;
  Ziel: am Asset (MAM/Bibliothek — Entscheidung steht aus, siehe §7) und im Log nur als Überschreibung.
* **Übergang je Paar (A→B)**: optional `transition { overlapMs, curveOut, curveIn, bOffsetMs, introOverride }`. Fehlt es, rechnet
  `plan()` wie bisher mit den Standardwerten. Gespeichert im Log-Element von B (Feld `transition`), damit es mit dem Log wandert
  und ins As-Run übernommen wird.
* `plan()` bekommt `transition` als Eingabe; ohne Wert bleibt jedes bestehende Verhalten (Regressionstests unverändert).

## 4. Oberfläche (Panel-Element `omp-segue-editor`)

* Zwei Wellenformen untereinander auf **gemeinsamer Zeitachse** (A oben, B unten, B an der geplanten Startposition), Zoom bis Sample-Nähe.
* Ziehbare Marken (Segue-Punkt A, Start B/SOM, Intro-Ende B, Blendanfang/-ende), Einrasten auf Taktraster optional aus; Zahlenfelder daneben.
* Blendkurven als Linien über den Wellenformen (Cosinus, linear, Exponential …), Kurvenform wählbar.
* **Vorhören:** Taste „Übergang“ spielt ab `Segue − Vorlauf` bis `Ende der Blende + Nachlauf`; Tasten „nur A“, „nur B“, Schleife,
  Vorlauf/Nachlauf einstellbar. Änderungen wirken sofort im laufenden Vorhören.
* Speichern ausdrücklich (nicht bei jedem Klick), Verwerfen, Rückgängig/Wiederholen im Editor; Berührungsschutz und Dialoge wie im Rest der UI.

## 5. Vorhören — gleiche Rechnung wie die Sendung

Der Editor darf nie etwas anderes zeigen/hören, als gesendet wird. Zwei Wege:

1. **Plan vom Node:** `POST /segue/plan` (Node `omp-radio-automation`) ruft `segue::plan()` auf und liefert `Placed`; der Browser rendert die
   Blende mit WebAudio nach diesen Zahlen (Gain, Kurve, Offset). *Vorteil:* eine Rechenstelle. *Grenze:* WebAudio-Kurven ≠ Player-Kurven
   bis auf Rundung → Kurven im Browser aus denselben Formeln erzeugen (kleine Tabelle aus dem Node mitliefern).
2. **Render im Node:** Node mischt die Blende (ffmpeg-/GStreamer-Offline) zu einer WAV, Browser spielt sie. *Vorteil:* bit-nah an der Sendung.
   *Nachteil:* Latenz bei jeder Änderung.

Empfehlung: Weg 1 für das Ziehen (sofort hörbar), Weg 2 als „Sendequalität prüfen“-Taste. Messung: Onset der Blende im Browser-Vorhören
gegen `Placed` ≤ 1 ms; Sendeweg gegen Plan weiter wie RB4 (`lateMs`).

## 6. Scheiben

| Scheibe | Inhalt | Prüfung |
|---|---|---|
| RB7.1 | `transition` im Log-Modell + in `segue::plan()` (Standardverhalten unverändert) | Unit-Tests: ohne Feld identisch zu heute, mit Feld verschobene Blende; Persistenz/Import |
| RB7.2 | `POST /segue/plan` + Zugriff auf Spitzenwerte der Dateien | Plan gleich `plan()`; Spitzenwerte stimmen mit Testton |
| RB7.3 | Editor-Element: Wellenformen, Marken ziehen, Zahlenfelder, Speichern | CDP-Klicktest: Marke ziehen ändert Zahl, Speichern/Verwerfen |
| RB7.4 | Vorhören (WebAudio nach Plan), Schleife, A/B-Einzeln | Headless mit Testton: Onset gegen Plan ≤ 1 ms |
| RB7.5 | „Sendequalität prüfen“ (Render) + Einbindung ins Radio-Log-Panel (Doppelklick auf Übergang) | Vergleich Render ↔ Sendeweg |

## 7. Entscheidungen (Nutzer, 2026-11-06)

1. **Marken zuerst im Log** (Asset-Marken später, nur anderer Speicherort).
2. **Editor an beiden Orten:** Kachel im Radio-Modul **und** im Log-Panel der Radio-Automation (ein Element, zwei Einbettungen).
3. **Markervorschläge: alle drei Quellen, dynamisch** — Stille am Ende, Lautstärkeverlauf, Beat-Raster; jeweils als Vorschlag zum
   Übernehmen (nie stillschweigend), die Erkennung richtet sich nach dem Material (Parameter sichtbar und einstellbar).
4. Offen geblieben: dritte Spur (Moderation/Jingle) — zunächst nur A→B.

## 8. Umsetzungsstand

* **RB7.1 erledigt (2026-11-06):** `segue::Transition` (`fadeOutMs`, `fadeInMs`, `curveOut`, `curveIn`, `startShiftMs`) am Element des
  *Nachfolgers*; `plan()` wertet sie für Titel→Titel, Titel→Jingle/Gesprochenes und Jingle→Titel aus (Blende vom Ausklang begrenzt,
  Einsatz nie vor dem Vorgänger). Ohne Wert unverändert (Test), leerer Übergang wird nicht geschrieben. `LogItem.transition` im Radio-Log;
  das Bedienfeld lässt das Feld beim Speichern stehen.

* **RB7.2 erledigt (2026-11-06):** Node `omp-radio-automation`: `POST /segue/plan` (`{items, startMs, config}` → `placed[]`, gleiche
  `segue::plan()` wie die Sendung, höchstens 64 Elemente) und `GET /segue/peaks?file=&durationMs=&bins=&fromMs=&toMs=` (ffmpeg-Dekodierung →
  Spitzenwerte 0…255, Skala wie im Review-Player; nur Dateien unterhalb `OMP_MEDIA_MOUNTS`/`data/media`, sonst 403). Live am Release-Binary mit
  der Demo-Datei geprüft: Demo-Übergang ergibt Einsatz 52 381 ms (Segue 52 881 − 500), Ausklang in den Spitzen sichtbar abfallend. 19 Tests grün.
  **Offen:** Zugriff aus dem Browser über den Orchestrator-Proxy (Regel für `POST /segue/plan`/`GET /segue/peaks` prüfen, Isolations-Typ) — vor RB7.3.

* **RB7.3 weitgehend erledigt (2026-11-06):** Element `omp-segue-editor` (`ui/modules/segue-editor/`: `logic.ts` mit 6 Tests, `element.ts`):
  zwei Wellenformen auf gemeinsamer Zeitachse, Griffe für Segue-Punkt A, Einsatz B, Intro B, SOM B und beide Blendenden (je eigene Höhe, damit
  gleichzeitige Marken einzeln greifbar sind), Blendkurven als Linien, Zahlenfelder, Zoom (Mausrad), Verschieben (Umschalt + Ziehen), Übernehmen/
  Abbrechen/Standardblende. Planung und Spitzenwerte vom Node. Im Panel der Radio-Automation: Knopf „⇄“ je Zeile (ab Zeile 2) öffnet den Editor als
  Dialog, Übernehmen schreibt Marken + `transition` in beide Zeilen (Speichern des Logs bleibt ausdrücklich). Bau: `make ui` kopiert das Bundle nach
  `nodes/omp-radio-automation/ui/segue-editor.js` (`include_str!`); neue Proxy-Route `GET /api/v1/nodes/{id}/ui/segue-editor.js`.
  **Geprüft:** Klicktest mit echter Maus (`tools/segue-editor-e2e/editor.mjs`, Headless-Chromium gegen eigene Node-Instanz): Einsatz B ziehen →
  `startShiftMs` −1040 ms, Marke folgt nach neuer Planung, Zahlenfeld gleich, Übernehmen liefert beide Elemente, Dateien unverändert.
  **Nicht geprüft:** der Dialog im echten Panel hinter dem Orchestrator-Proxy (Import des Elements über `ui/segue-editor.js` im isolierten Ursprung);
  Radio-Automation-Node + Orchestrator neu starten nötig. Kachel im Radio-Modul folgt mit RB7.5.

* **RB7.4 erledigt (2026-11-06):** Vorhören im Editor. Node: `GET /segue/audio?file&fromMs&toMs` (ffmpeg → rohes PCM 48 kHz/Stereo/s16le, höchstens 120 s,
  nur Medienverzeichnisse; Proxy-Route `GET /api/v1/nodes/{id}/segue/audio`). Browser: Tasten „▶ Übergang“, „▶ nur A“, „▶ nur B“, „■“, Schleife, Vorlauf/
  Nachlauf; jede Stimme als `AudioBuffer` mit Verstärkungsverlauf nach der Planung des Nodes (Einblenden × Ausblenden mit den Kurven des Segue-Players,
  1-ms-Raster, Pegelkorrektur `gainDb`), Wiedergabekopf im Bild; Änderungen während des Hörens starten an der aktuellen Stelle neu. `renderPreview()` rechnet
  dieselbe Mischung offline (Tests, später „Sendequalität prüfen“). **Gemessen** (Headless, Offline-Mischung gegen Plan, `tools/segue-editor-e2e/editor.mjs`):
  Einsatz von B 0,40 ms nach Plan (Ziel ≤ 1 ms); A in der Mitte der linearen 2-s-Blende 0,54 des Pegels davor, am Ende 0,03, danach 0; B vor dem Einsatz
  exakt still. **Nicht geprüft:** echtes Hören über Lautsprecher (Headless), Verhalten bei sehr langen Dateien (Ausschnitte nur ≈ 30 s, aber nicht gemessen).
  Logik-Tests: 7 (`deno test ui/modules/segue-editor`).

* **RB7.5 erledigt (2026-11-06):**
  * **Sendequalität prüfen:** `POST /segue/render` (`{items:[a,b], t0Ms, t1Ms}`) mischt die beiden Elemente im Fenster mit dem **unveränderten Mischer des Segue-Players**
    (`omp-segue-player/src/mix.rs` per `#[path]` eingebunden, kein zweiter Code) und liefert s16le-Stereo; der Editor spielt das Ergebnis und vergleicht es mit der
    Browser-Vorschau. Gemessen: Abweichung −91,2 dB, Spitze 0,0000 (Ziel < −40 dB). Rust-Test: Mischung gegen Planwerte (0,8/0,4-Konstanten → 0,6 in der Blendmitte)
    und Fenster mitten in der Blende = Ausschnitt der vollen Mischung.
  * **Reiter „Übergänge“** im Radio-Panel (neben Playlist): alle Titelpaare mit Kurzfassung des Übergangs (aus/ein/Einsatz/Kurven) und „Bearbeiten“.
  * **Doppelklick** auf die Zeitzelle einer Playlist-Zeile öffnet den Editor für den Übergang von der Vorzeile.
  * Proxy: `POST …/segue/render` neu; alle fünf Routen (`plan`, `peaks`, `audio`, `render`, `ui/segue-editor.js`) über den echten Orchestrator geprüft (ohne Anmeldung 401).
  * Panel-Klicktest `tools/segue-editor-e2e/panel.mjs` (Panel-Bundle gegen den Node, Aufrufe wie vom Proxy umgeleitet): Demo-Log importieren, Doppelklick → Editor mit
    Nachtfahrt → Strandgut, Änderung übernehmen, Reiter zeigt „aus 1.0 s · Einsatz −0.5 s“, Knopf öffnet den Editor.
  * **Im echten Shell geprüft (2026-11-06 abends):** Headless-Chromium, Anmeldung am Orchestrator, Test-Instanz `omp-radio-automation` per API gestartet, Panel per Doppelklick geöffnet, Demo-Log importiert, Doppelklick auf die Zeit → Editor „Nachtfahrt → Strandgut“ mit Wellenformen, Marken und Zahlenfeldern über den Proxy. Test-Instanz wieder gelöscht. **Nicht geprüft:** Vorhören mit echtem Ton am Gerät; die Instanz im Radio-Workflow (stand gestoppt) startet beim nächsten Start mit dem neuen Stand.
  * **Kachel im Radio-Modul:** Das Radio-Modul hat keine eigene Oberfläche außer diesem Panel; der Reiter „Übergänge“ ist die Kachel dazu.

## 9. Frühere offene Fragen (Rest)

1. **Wohin mit den Marken?** Am Asset (setzt die Bibliothek-/MAM-Entscheidung voraus, die für die Woche ab 2026-11-09 erwartet wird) oder
   zunächst nur im Log? Empfehlung: Log zuerst, Asset-Marken später ergänzen — der Editor ändert dann nur den Speicherort.
2. **Wo läuft der Editor?** Als Kachel im Radio-Modul, im Log-Panel von `omp-radio-automation`, oder beides?
3. **Automatik („intelligent“)?** Vorschlag der Marken aus der Datei (Stille am Ende, Lautstärkeverlauf, Beat-Raster) — erst als Vorschlag zum
   Übernehmen, nie stillschweigend. Soll das in Scheibe 1 mit, oder später (Erkennung = eigene Arbeit, Normen-/Verfahrenswahl vorher lesen)?
4. **Mehr als zwei Stimmen?** Moderation über Intro + Jingle gleichzeitig: Editor zuerst nur A→B, dritte Ebene (Sprecher/Jingle) als Spur darunter?
5. **Beiträge (Gesprochenes):** gleiche Marken wie bei Titeln oder eigene („Einstieg“, „Ausstieg“, „Hook“)?
