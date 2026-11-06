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

## 7. Offene Fragen (vor RB7.1 klären)

1. **Wohin mit den Marken?** Am Asset (setzt die Bibliothek-/MAM-Entscheidung voraus, die für die Woche ab 2026-11-09 erwartet wird) oder
   zunächst nur im Log? Empfehlung: Log zuerst, Asset-Marken später ergänzen — der Editor ändert dann nur den Speicherort.
2. **Wo läuft der Editor?** Als Kachel im Radio-Modul, im Log-Panel von `omp-radio-automation`, oder beides?
3. **Automatik („intelligent“)?** Vorschlag der Marken aus der Datei (Stille am Ende, Lautstärkeverlauf, Beat-Raster) — erst als Vorschlag zum
   Übernehmen, nie stillschweigend. Soll das in Scheibe 1 mit, oder später (Erkennung = eigene Arbeit, Normen-/Verfahrenswahl vorher lesen)?
4. **Mehr als zwei Stimmen?** Moderation über Intro + Jingle gleichzeitig: Editor zuerst nur A→B, dritte Ebene (Sprecher/Jingle) als Spur darunter?
5. **Beiträge (Gesprochenes):** gleiche Marken wie bei Titeln oder eigene („Einstieg“, „Ausstieg“, „Hook“)?
