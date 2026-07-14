# END-GOAL-FEATURES — Design-Dokument für die Endziel-Anforderungen

Stand: 2026-07-14 (erweitert um K7–K9 in derselben Sitzungsfolge, nach
Review durch den Projektinhaber). Status: **Entwurf zur Review durch den
Projektinhaber, noch nicht priorisiert, noch nicht Teil der
`UMSETZUNG.md`-Schrittliste.**

Dieses Dokument ist das Ergebnis mehrerer Recherche-Sitzungen über beide
Codebasen (OMP und `/home/infantilo/PIPELINE CONTROLLER`) zu den
Endziel-Anforderungen des Projektinhabers (Original-Wortlaut jeweils am
Kapitelanfang, Kapitel 1–6 aus der ersten Runde, Kapitel 7–9 aus einer
Review-Nachforderung). Es ist bewusst **kein** Phasenplan-Eintrag — die
strukturierte Schritt-Verwaltung bleibt bei `UMSETZUNG.md` (§7
Status-Checkliste). Zweck: eine spätere Implementierungs-Sitzung soll pro
Kapitel einen klar geschnittenen „Teil 1" herausnehmen und nach den
Arbeitsregeln aus `UMSETZUNG.md` §0 umsetzen können, ohne die Recherche zu
wiederholen.

Regeln, die überall gelten (nicht pro Kapitel wiederholt):

- **PIPELINE CONTROLLER ist Referenz, nicht Quelle.** Anderer Stack
  (Node.js/gst-kit/eine monolithische SPA), keine gemeinsame Git-Historie
  (`CLAUDE.md`). Übernommen werden **Muster und erarbeitete Erkenntnisse**
  (z. B. der mxfdemux-Workaround, das Pre-Cue-Timing der Grafik-Engine),
  nie Code. Einzige echte 1:1-Wiederverwendung: die ~45 OGraf-Templates
  (`templates/grafik/`), weil OGraf-Templates per EBU-Spec portables
  HTML/JS sind (`ARCHITECTURE.md` §11.2).
- **Nichts darf das Node-Contract-/Selbstbeschreibungs-Modell verletzen**
  (`ARCHITECTURE.md` §5, §11.1): der Orchestrator lernt keinen einzigen
  neuen Node-Typ kennen; alles Neue ist Descriptor-Parameter/-Methoden +
  UI-Bundle des jeweiligen Nodes bzw. generische Shell-Infrastruktur.
- **UI bleibt vanilla TS + Custom Elements + `deno bundle`** — kein
  Framework, kein npm-Build (`UMSETZUNG.md` §0 Punkt 5). „Modern" wird
  über ein Design-System (Kapitel 1) erreicht, nicht über einen
  Framework-Wechsel.
- **Software-Testmittel-Linie** (`UMSETZUNG.md` §0 Punkt 7) bleibt: alles
  hier ist auf der Single-Host-Dev-Maschine ohne Broadcast-Hardware
  verifizierbar (Testdateien, Headless-Rendering, MXL-Loopback,
  `omp-viewer`).

---

## 0. Querschnitt: Abhängigkeiten und empfohlene Reihenfolge

Die neun Anforderungen sind nicht unabhängig:

```
K1 Design-System/Tokens ──────────┬──► K3 Mischer-Pult-Panel (nutzt Tokens/Kit)
   (ui/design-tokens.css, ui/kit) ├──► K4 Audio-Konsole (Fader/Knob aus ui/kit)
                                  ├──► K5/K6 Operator-UIs (gleiche Optik)
                                  └──► K8 Stream-Deck-Rendering (Tokens als Tastenfarben)

K2 Datei-Playback im omp-player ─────► K6 Automation (EOS-Advance, echte Clips
                                        statt durationMs-Timer)

K5 omp-ograf ────────────────────────► K6 Automation (Grafik-Child-Events)
             └───────────────────────► K3 Mixer-DSK bekommt echte Key/Fill-Quelle

K3 Mischer-Pult-Panel (Methoden) ────► K8 Stream Deck (physisches Pult ruft
                                        dieselben crosspoint.*-Methoden auf)

D6 Teil 3 Placement-Engine (offen, ──► K7 Teil 4 Hot-Standby (braucht Host-Wahl
UMSETZUNG.md, außerhalb dieses          + Claim/Release für die Standby-Instanz)
Dokuments) ───────────────────────┐
D7 Workflow-Objekt (erledigt) ────┴─► K7 (automatischer Cross-Host-Failover
                                        braucht Rollen-Modell + Placement)

K9 Multiviewer-Streaming-Transport ──► K2/K5/K1 (generalisiert später auf
(omp-mediaio::preview, additiv)         Player-/OGraf-/Kachel-Vorschauen)
```

Empfohlene Groblinie (jeweils nur die „Teil 1"-Scheiben, Details in den
Kapiteln): **K1-Teil-1 zuerst** (Verbindungsanzeige + Tokens — kleinster
Aufwand, größter Präsentations-Hebel, entblockt K3/K4-Optik), dann
**K2-Teil-1** (Datei-Playback, entblockt K6), dann **K3/K4-Teil-1**
(reine UI-Bundles, parallelisierbar), dann **K5** (größter Brocken,
eigener Render-Spike zuerst), dann **K6** in Scheiben entlang der
freigeschalteten Abhängigkeiten. **K7-Teil-1** (Prozess-Auto-Restart) ist
von alldem unabhängig und kann jederzeit parallel laufen — kleinster
Aufwand der ganzen Nachforderung, kein Abhängigkeitskonflikt mit K1–K6.
**K8** sinnvollerweise nach **K3-Teil-1** (das physische Pult braucht
die Methoden, die K3s Bildschirm-Pult bereits aufruft). **K9-Teil-0**
ist ebenfalls unabhängig und sofort startbar; K9-Teil-2 (WebRTC) ist der
mit Abstand größte Infrastruktur-Neuzugang des gesamten Dokuments (siehe
9.4) und sollte erst nach einem eigenen Spike priorisiert werden.

---

## 1. UI-Modernisierung: Settings, Auto-Reconnect, Disconnected-Anzeige, Design-System

> „das gesamte userinterface muss moderner und vollkommen ausgereift für
> eine etwaige präsentation sein (menüs für settings, auto reconnect,
> anzeige wenn disconnected/server down, ..)"

### 1.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Keinerlei Verbindungs-Affordance.** Der SSE-Stream reconnectet zwar
  bereits mit exponentiellem Backoff
  (`ui/graph/flow-canvas.ts:303–322`: `#connectEvents`/
  `#scheduleReconnect`, Initial-/Max-Delay-Konstanten), aber **ohne jede
  sichtbare Anzeige** — fällt der Orchestrator aus, friert der Graph
  kommentarlos ein. Die Poll-Panels schlucken Fehler ausdrücklich still:
  `ui/shell/hosts-view.ts:44–53` und `ui/shell/workflows-view.ts:94–103`
  (`catch { /* nächster Poll holt es auf */ }`, `if (!res.ok) return;`).
  `shell.ts:41–43` fällt bei nicht erreichbarem Orchestrator sogar
  stillschweigend auf die Engineering-Ansicht zurück.
- **Kein Settings-Menü.** Es gibt genau drei Chrome-Elemente: zwei
  fix positionierte Toggle-Buttons unten links („Hosts", „Workflows",
  `ui/shell/shell.ts:57–102`) und das User-Widget aus `auth.ts`. Keine
  Navigation, kein Einstellungs-Dialog, keine Versions-/About-Anzeige
  (obwohl `GET /api/v1/info` seit A4 existiert).
- **Null Styling-Infrastruktur.** Jede Komponente baut ihre Optik als
  Inline-`style.cssText`-Strings (`flow-canvas.ts` allein ~25 Stellen,
  z. B. Zeilen 397–423, 1653–1745; `hosts-view.ts:32–34`;
  `workflows-view.ts:60–63`) bzw. als eigenes `<style>` pro
  Node-UI-Bundle (C7/C10/C11/C12/C14 — jedes mit leicht anderen Grautönen
  und Grüntönen). Es gibt keine CSS-Datei im Projekt außer dem
  12-Zeilen-Reset in `ui/index.html`.
- **Konzeptionell ist das meiste schon entschieden:** `ARCHITECTURE.md`
  §22 (2026-07-13) spezifiziert Navigations-Struktur (§22.1),
  Design-Tokens `ui/design-tokens.css` + optionale Bausteinbibliothek
  `ui/kit/` mit `<omp-button>`, `<omp-fader>`, `<omp-tally-badge>`,
  `<omp-panel>`, `<omp-catalog-search>` (§22.2), Theming inkl.
  „Studio-Dark", persönliche Einstellungen in Postgres, Workflow-Katalog
  als Kachel-Grid (§22.3). **Nichts davon ist gebaut.** Dieses Kapitel
  konkretisiert §22 zur Umsetzbarkeit — es ersetzt §22 nicht.

### 1.2 Referenz PIPELINE CONTROLLER

- Durchgängige SSE-getriebene SPA (`ui.html`, 13 800 Zeilen) mit
  Settings-Dialog (Pfade, Layout-Optionen, Sprache DE/EN, Light/Dark),
  Rollen-abhängiger Sichtbarkeit (`ui.html:2390–2415`) und einheitlicher
  Button-Sprache (`.mx-btn`-Karten mit Icon/Label/Dauer/On-Air-Zustand,
  Fortschrittsbalken — ein sehr brauchbares Vorbild für „Hardware-Look"
  in K3/K5). Übernehmenswert als **Muster**: ein zentraler SSE-Handler,
  aus dem sich alle Panels speisen; Settings als ein Dialog mit
  Sektionen; i18n als flaches Key-Map (`ui.html:10323 ff.`).
- Nicht übernehmen: die Monolith-Struktur (eine 13k-Zeilen-Datei,
  globale Funktionen, `innerHTML`-Templating überall) — OMPs
  Custom-Element-Zerlegung ist bereits die bessere Grundlage.

### 1.3 Ziel-Design

**a) Verbindungs-Schicht (neues Modul `ui/shell/connection.ts`).**
Ein einziges, geteiltes Zustandsobjekt `ConnectionMonitor` mit Zuständen
`connected | degraded | disconnected`:

- Primärsignal ist der **bestehende** SSE-Stream (er ist de facto der
  Heartbeat zum Orchestrator): `es.onopen` → `connected`, `es.onerror` →
  `disconnected` + Countdown bis zum nächsten Reconnect-Versuch. Der
  Backoff-Code wandert aus `flow-canvas.ts` hierher (eine SSE-Verbindung
  pro Shell statt pro Komponente; `flow-canvas`, künftige Panels und
  Views abonnieren den Monitor per `EventTarget`-API).
- Sekundärsignal: ein dünner `fetch`-Wrapper (`apiFetch()`), den
  `hosts-view`/`workflows-view`/`flow-canvas` statt rohem `fetch`
  benutzen — Fehler melden an den Monitor (`degraded`, wenn SSE lebt,
  aber einzelne Requests scheitern) statt sie still zu schlucken. Die
  bestehende „nächster Poll holt es auf"-Semantik bleibt, nur nicht mehr
  unsichtbar.
- **Anzeige:** ein Status-Pill fest in der neuen App-Bar (siehe b):
  grün „Verbunden" (dezent), bei `disconnected` ein rot pulsierender
  Vollbreite-Banner unter der App-Bar: „Verbindung zum Orchestrator
  getrennt — nächster Versuch in _n_ s ・ [Jetzt verbinden]". Alle
  interaktiven Flächen bekommen währenddessen `aria-disabled`/eine
  halbtransparente Sperr-Optik (kein „Klick ins Leere" während der
  Präsentation). Nach Reconnect lädt die Shell Graph/Panels einmal neu
  (der `#init()`-Pfad existiert schon).

**b) App-Chrome / Navigation (Umbau `ui/shell/shell.ts`).**
Ersetzt die zwei Floating-Buttons durch eine schmale, dunkle **Top-Bar**
(48 px): links Produktname/Logo + Bereichs-Tabs
**Flow-Editor ・ Workflows ・ Hosts** (die bestehenden
`<omp-workflows-view>`/`<omp-hosts-view>` werden von Floating-Panels zu
vollwertigen Ansichten im `#shell-root`), rechts Verbindungs-Pill,
Zahnrad (Settings, siehe c) und das bestehende User-Widget.
Rollen-Sichtbarkeit exakt nach §22.1: `operate`-only-Nutzer sehen die
Bar gar nicht (Console-Ansicht bleibt unverändert Vollfläche, C13).
Der spätere Workflow-**Katalog** (§22.3 Kachel-Grid, Thumbnails, Suche)
ist bewusst **nicht** Teil dieses Kapitels — er hängt an D7 Teil 2 und
bleibt dort verortet; die Tab-Struktur lässt den Platz dafür frei.

**c) Settings-Menü (neues `ui/shell/settings-view.ts`).**
Ein von rechts einfahrendes Panel (kein Modal — Operator soll den Graph
weiter sehen) mit Sektionen:

1. **Darstellung:** Theme (Studio-Dark ・ Dark ・ Light — Studio-Dark als
   Default, §22.2), UI-Dichte (kompakt/normal), Sprache (DE/EN,
   vorbereitet — die Strings sind heute gemischt deutsch).
2. **Verbindung:** SSE-/Poll-Status read-only (letztes Event, Latenz),
   Reconnect-Knopf, Poll-Intervalle (Anzeige, vorerst nicht editierbar).
3. **System (read-only):** Orchestrator-Version/Name aus `/api/v1/info`,
   Registry-/NATS-Status sofern die API das hergibt — „About"-Ersatz für
   Präsentationen.
4. **Nutzerverwaltung:** nur Link/Einbettung der D3-Teil-2-Verwaltung für
   `admin`.

Persistenz: Teil 1 `localStorage` (sofort lauffähig), Teil 2 pro Nutzer
in Postgres (§22.2 verlangt das; braucht einen kleinen
`GET/PUT /api/v1/me/preferences`-Endpunkt — additiv, kein
Node-Contract-Thema).

**d) Design-System (die eigentliche „modern"-Antwort).**
Neu: `ui/design-tokens.css`, von `index.html` **und** als
`<link>`/`adoptedStyleSheets` in jedes Shadow-DOM der ui/kit-Bausteine
geladen; Custom Properties durchdringen Shadow-DOM by design (§22.2).
Konkreter Token-Satz (Vorschlag, damit die Umsetzung nicht bei Null
anfängt):

- Flächen: `--omp-bg` #101214, `--omp-surface` #1a1d21,
  `--omp-surface-raised` #22262b, `--omp-border` #2e3338.
- Text: `--omp-text` #e8eaed, `--omp-text-dim` #9aa0a6,
  `--omp-text-disabled` #5f6368.
- Signalfarben (Broadcast-Semantik, überall identisch verwenden):
  `--omp-onair` #e53935 (Programm/Tally), `--omp-preset` #43a047
  (Preset/OK), `--omp-cue` #fb8c00 (gecued/Warnung), `--omp-info`
  #4285f4, `--omp-error` #ef5350.
- Typo: `--omp-font` system-ui-Stack, `--omp-font-mono` für
  Timecode/IDs; Größenstufen 11/12/13/15 px.
- Radius/Spacing: `--omp-radius` 6px, 4er-Spacing-Raster.
- Zustände als fertige Schatten-Tokens: `--omp-glow-onair`
  (`0 0 6px 1px` Rot — der „beleuchtete Knopf"-Effekt für K3/K4).

`ui/kit/` startet mit genau den Bausteinen, die K3/K4 wirklich brauchen
(kein Vorrats-Framework): `<omp-button>` (Varianten `default`,
`take`, `toggle`, Zustände `onair`/`preset`/`cue` — deckt heutige
`.on-air`/`.preset-active`/`.toggle-on`-Klassen der Bundles ab),
`<omp-fader>` (vertikal, Pointer-Drag, dB-Skala, Wert-Event),
`<omp-knob>` (Rotary, Vertikal-Drag, Doppelklick = Reset),
`<omp-meter>` (vertikale Pegelanzeige, Peak-Hold),
`<omp-tally-badge>`, `<omp-panel>` (Karten-Rahmen + Titelzeile).
Node-Bundles **dürfen** sie nutzen (Shell exportiert `ui/kit` unter
stabiler URL `/kit/…`), müssen aber nicht (§4.5-Kompatibilität —
Community-Nodes ohne Kit bleiben gültig; Fallback ist wie heute eigenes
`<style>`).

### 1.4 Phasenplan

- **Teil 1 (eine Sitzung, höchster Präsentations-Hebel):**
  `connection.ts` + Status-Pill/Banner + `apiFetch`-Umstellung der drei
  bestehenden Views; `design-tokens.css` anlegen und die **Shell-eigenen**
  Flächen (App-Bar, hosts/workflows-View, Toasts, Parameter-Panel) darauf
  umziehen; App-Bar mit Tabs statt Floating-Buttons. Verifikation: CDP-
  Browsertest (Pflicht laut Memory: `deno bundle` kann Registrierungen
  stillschweigend verlieren) — Orchestrator stoppen → Banner erscheint,
  Countdown läuft, starten → Banner verschwindet, Graph lädt neu.
- **Teil 2:** `ui/kit`-Bausteine (`omp-button`, `omp-panel`,
  `omp-tally-badge` zuerst; `omp-fader`/`omp-knob`/`omp-meter` können mit
  K4-Teil-1 zusammenfallen) + Migration der fünf bestehenden Node-Bundles
  auf Tokens/Kit (rein optisch, keine Funktionsänderung — pro Bundle
  einzeln verifizierbar).
- **Teil 3:** Settings-Panel (localStorage) inkl. Theme-Umschaltung über
  Tokens; `GET /api/v1/info`-Anzeige.
- **Teil 4:** Nutzer-Präferenzen in Postgres (`/api/v1/me/preferences`),
  Sprache/i18n-Grundgerüst.

### 1.5 Offene Fragen an den Projektinhaber

1. Studio-Dark als einziges initiales Theme (weniger Arbeit, konsistente
   Präsentation) oder von Anfang an Light/Dark-Umschaltung (§22.2 nennt
   beide)?
2. Sprachpolitik der UI: aktuell deutsch — für „Präsentation" DE belassen
   oder EN-first mit DE-Umschaltung (PIPELINE CONTROLLER ist zweisprachig)?
3. Sollen die Floating-Panels (Hosts/Workflows) wirklich Vollansichten
   werden, oder als andockbare Panels erhalten bleiben (Operator-Gewohnheit)?

---

## 2. `omp-player`: echte Videodateien (MXF) abspielen

> „die video player nodes müssen reale videos (mxf) abspielen können"

### 2.1 Ist-Zustand in OMP

`nodes/omp-player/src/pipeline.rs` spielt **ausschließlich Testquellen**:
Items sind `{pattern, tone_freq}` (`pipeline.rs:65–69`), jeder Slot-Zweig
ist `videotestsrc`/`audiotestsrc` (`build_video_branch`/
`build_audio_branch`, `pipeline.rs:150–229`), ausdrücklich als
Software-Testmittel deklariert (`pipeline.rs:19–28`). `durationMs` ist
reine Anzeige-Metadatik, es gibt **kein EOS-Konzept** (Items laufen
endlos). Die Architektur ist aber bereits die richtige für Datei-Playback:
zwei feste A/B-Slots am `input-selector`, `cue()` ersetzt nur den Zweig
hinter dem nicht-on-air-Pad (`replace_slot`, `pipeline.rs:263–279`),
`take()` schaltet nur `active-pad` um. Ausgang: MXL v210 640×480@25 +
48 kHz Stereo (`pipeline.rs:43–48`). Methoden
`append/load/remove/cue/take` mit `{pattern, toneFrequency, durationMs}`
(`main.rs:135 ff.`).

### 2.2 Referenz PIPELINE CONTROLLER (das eigentliche MXF-Know-how)

`PlayerPipeline.js` (Root-Version) ist die erprobte Vorlage:

- **Decode:** `uridecodebin name=db uri="…" expose-all-streams=false`,
  getrennte Video-/Audio-Branches (`PlayerPipeline.js:9–25, 242–356`).
- **Der MXF-Fallstrick schlechthin** (`PlayerPipeline.js:38–41,
  391–395, 448, 545`): `mxfdemux` wirft beim ersten State-Change im
  Pull-Mode „Internal data stream error"; erkannt an `src=mxfdemux*`,
  behoben durch ein **zweites `play()`** — bekannter GStreamer-Bug, den
  wir nicht neu entdecken müssen. Genau die Art Erkenntnis, für die die
  „erst PIPELINE CONTROLLER konsultieren"-Regel existiert.
- **URI-Encoding pro Pfadsegment** (`PlayerPipeline.js:109–113`) —
  Leerzeichen/Umlaute in Dateinamen.
- **MXF-Audio-Realität:** 2/4/8/16 **Mono**-Tracks statt eines
  Stereo-Tracks (`PlayerPipeline.js:117–123`); dort per
  `audiomixmatrix`-Routing gelöst. Metadaten kommen aus einer
  MediaLibrary/MediaAnalyzer-Vorabanalyse.
- **SOM/EOM** (Timecode-In/Out) als erstklassige Cue-Parameter
  (`load(item)` mit `som`/`eom`, `lib/Timecode.js` für TC↔Sekunden).
- **Clocking:** Player-Pipelines laufen `sync=false` gegen Shared-Memory-
  Sinks, der Master taktet (`PlayerPipeline.js:32–36`) — entspricht
  konzeptionell OMPs MXL-Schreibpfad, keine Übernahme nötig.

### 2.3 Ziel-Design

**Datenmodell:** `Item` wird zur Enum (additiv, bestehende Testmuster
bleiben — sie sind weiterhin das CI-Testmittel):

```
ItemSource::TestPattern { pattern, tone_freq }        // heutiger Stand
ItemSource::File { uri, som_ms: Option<u64>, eom_ms: Option<u64> }
```

Descriptor-seitig: `append`/`load` bekommen optional `file` (Pfad relativ
zu `OMP_MEDIA_DIR`) statt `pattern`; neue readonly-Params
`mediaLibrary` (Dateiliste aus `OMP_MEDIA_DIR`, mit `durationMs` sobald
geprobt) und pro Item `durationMs` **aus der Datei** statt Handeingabe.
Kein neues Orchestrator-Wissen — alles generischer Descriptor.

**Pipeline pro Datei-Slot-Zweig** (ersetzt `build_video_branch` für
File-Items): `uridecodebin3 (expose-all-streams=false)` → Video:
`videoconvert ! videoscale ! videorate ! capsfilter(640×480@25)` ans
bestehende isel-Pad — die Konform-Kette existiert dort schon wörtlich;
Audio: `audioconvert ! audioresample ! capsfilter(F32/48k/2ch)` ans
Audio-isel-Pad. Dynamische Pads von `uridecodebin` verlinken per
`pad-added` (neu für dieses Crate, Standard-GStreamer-Muster).
MXF-Workaround aus 2.2 im Bus-Watch nachbauen (Fehlerquelle
`mxfdemux*` → einmaliger Replay statt Fehler-Event).

**EOS wird erstklassig:** EOS des On-Air-Zweigs → `Event::ItemEnded` →
NATS `omp.player.<id>.itemEnded {itemId}` + readonly-Param
`playheadPosition`/`itemEnded`. Verhalten am Clip-Ende lokal: auf
Schwarz/Stille halten (der leere Slot-Default existiert), **kein**
Auto-Advance im Player selbst — Advance bleibt Automations-Scope (K6,
konsumiert das Event). SOM/EOM: nach Preroll `seek` auf `som_ms`,
`eom_ms` über `gst::SeekFlags::SEGMENT`-Stop bzw. Positions-Watch.

**Dauer-Probing:** beim `append` eines File-Items einmalig
`gst_pbutils::Discoverer` (Teil von gst-plugins-base, keine neue
System-Dependency; `gstreamer-pbutils`-Crate als begründete Ergänzung in
`docs/decisions.md`) — füllt `durationMs`, Video-/Audio-Track-Zahl.

**UI (`ui/bundle-video.js`):** Clip-Browser (Dateiliste aus
`mediaLibrary` mit Dauer), Items zeigen Dateiname + TC-Dauer +
Fortschrittsbalken on-air; Gestaltung nach K1-Kit. Sichtprüfung wie
immer über `omp-viewer`/Multiviewer.

**Ehrliche Grenzen (v1):** kein Scrub/Jog, kein Vorschaubild pro Clip
(Thumbnail-Pfad existiert erst mit `omp-mediaio::preview` am Player —
später), Wiedergabe konformt immer auf die feste Ausgangs-Raster
640×480@25 (das Demo-Raster der ganzen Trias — HD-Raster ist eine
separate, alle Nodes betreffende Entscheidung, hier nicht verstecken).

### 2.4 Phasenplan

- **Teil 1 — Datei-Playback MP4/MOV:** `ItemSource::File`, uridecodebin-
  Zweig, Discoverer-Dauer, `mediaLibrary`-Param, EOS-Event. MP4 zuerst,
  weil ohne mxfdemux-Sonderweg verifizierbar (Testdatei per
  `gst-launch … ! mp4mux` selbst erzeugbar — kein Asset-Beschaffungs-
  Blocker). Verifikation: Datei cuen/taken, Bild im Viewer, EOS-Event
  auf NATS beobachtet.
- **Teil 2 — MXF:** mxfdemux-Retry-Workaround, Multi-Mono-Track-Downmix
  (erste Stufe: erste zwei Tracks → Stereo; `audiomixmatrix` erst bei
  Bedarf), SOM/EOM-Trim. Test-MXF per `ffmpeg -f lavfi … out.mxf`
  (OP1a, MPEG-2 oder H.264) lokal erzeugen — dokumentieren in
  `deploy/dev/`.
- **Teil 3 — Bibliothek/Komfort:** persistenter Metadaten-Cache,
  Clip-Browser-UI, Player-Preview via `omp-mediaio::preview`.

### 2.5 Offene Fragen

1. **Codec-Umfang:** MXF ist nur Container — welche Essenzen müssen
   sicher laufen (XDCAM/MPEG-2? AVC-Intra? DNxHD via `gst-libav`)?
   Bestimmt, ob `gstreamer1.0-libav` als Pflicht-Systemdependency in
   `deploy/` dokumentiert wird (Lizenz-Hinweis wie im PIPELINE-
   CONTROLLER-README §Codecs übernehmen).
2. Medienverzeichnis-Konvention: ein globales `OMP_MEDIA_DIR` pro Host
   (Katalog-`env`) oder pro Instanz konfigurierbar (beschreibbarer
   Parameter wie `targetPlayerLabel` in C14)?
3. Soll `omp-player` bei EOS künftig optional selbst auf das gecuete Item
   weiterschalten (Player-lokal, ohne Automation) — oder bleibt Advance
   ausschließlich K6-Scope? (Empfehlung: K6-Scope, eine Wahrheit.)

---

## 3. `omp-video-mixer-me`: Operator-Panel mit Hardware-Mischer-Look

> „der video Mixer (M/E) muss im userinterface für den operator das look
> and feel eines echten hardware mischer haben (schöne ‚hardware' like
> buttons, ..)"

### 3.1 Ist-Zustand in OMP

- **Funktional** kann der Node mehr, als sein Panel zeigt:
  Preset/Program-Busse mit Compositor-Überblendung, `crosspoint.select/
  cut/autoTrans` (echte Alpha-Rampe über ~Bildperioden,
  `pipeline.rs:25–28, 533–555`, mit `fading`-Sperre), Keyer-DSK-Fläche
  (`pipeline.rs:439–455`), DVE-Box (`dve.setBox/reset`), Tally-Event bei
  Transitionsbeginn (`pipeline.rs:123`).
- **Das UI-Bundle** (`ui/bundle.js`, 156 Zeilen) ist dagegen eine
  generische Button-Liste: eine einzige „Preset (Auswahl)"-Reihe (Klick =
  select), „Cut"/„Auto Trans", zwei Toggle-Buttons Keyer/DVE; 2-s-Poll.
  Kein getrenntes PGM/PST-Bus-Layout, keine Transition-Rate, kein T-Bar,
  Standard-Browser-Buttons mit Flat-Farben.

### 3.2 Referenz PIPELINE CONTROLLER

Dort gibt es keinen M/E-Mischer (Master-Pipeline schaltet Slots), aber
zwei direkt verwertbare Vorbilder: die `.mx-btn`-Kartensprache
(Icon + Label + Zusatzinfo + On-Air-Zustand + Fortschrittsbalken,
`ui.html` Hotkey-/Asset-Panels — bewährte „beleuchtete Taste" im Web)
und **`streamdeck.js` (1150 Zeilen): Stream-Deck-Anbindung per WebHID
direkt aus dem Browser** — dynamische Seiten für Quellen-Umschaltung,
Take, Grafik. Das ist der Weg, „Hardware-Look" später zu echter Hardware
zu machen, ohne Treiber.

### 3.3 Ziel-Design

**Layout (klassische Mischer-Topologie, eine M/E-Bank):**

```
┌──────────────────────────────────────────────┬──────────────┐
│ PGM ▸ [ BLK ][ SRC1 ][ SRC2 ][ SRC3 ] …      │  TRANSITION  │
│       (rot beleuchtet = on air)              │  ┌────────┐  │
│                                              │  │ T-BAR  │  │
│ PST ▸ [ BLK ][ SRC1 ][ SRC2 ][ SRC3 ] …      │  │ (vert.)│  │
│       (grün beleuchtet = preset)             │  └────────┘  │
├──────────────────────────────────────────────┤ [CUT] [AUTO] │
│ KEY/DVE: [DSK 1 ●] [PIP ●]   RATE: [12f ▾]  │  MIX ・ WIPE  │
└──────────────────────────────────────────────┴──────────────┘
```

- **Zwei getrennte Bus-Reihen** (heute eine): PGM-Reihe zeigt
  `programInput` (Klick = Direktschnitt? nein — v1: PGM-Reihe ist
  Anzeige + Hot-Cut per Doppelklick, um Fehlbedienung zu vermeiden),
  PST-Reihe ruft `crosspoint.select`. Quellen-Buttons quadratisch
  (~64 px), abgerundet, mit zweizeiligem „Scribble"-Label
  (Quellen-Label + Nummer), Zustands-Glow über K1-Tokens
  (`--omp-glow-onair` rot / preset grün). 3D-Haptik rein per CSS:
  Flächen-Gradient (oben heller), `box-shadow` außen + `inset`-Kante,
  `:active` versetzt 1 px nach unten — kein Bild-Asset.
- **Transition-Sektion rechts:** großer CUT- und AUTO-Button
  (`<omp-button variant="take">`), **T-Bar** als vertikaler Slider:
  Während `autoTrans` animiert die Bar server-getrieben (Fortschritt als
  neuer readonly-Param `crosspoint.transitionPosition` 0..1); manuelles
  Ziehen erfordert eine neue Methode
  `crosspoint.setTransitionPosition(pos)` im Node (Compositor-Alpha
  direkt setzen — die Alpha-Mechanik existiert in
  `pipeline.rs:533–555`, es fehlt nur der von außen gehaltene Zustand
  inkl. Abschluss-Kommit bei pos≥1.0). Ehrlich: manueller T-Bar ist
  Node-Arbeit, nicht nur UI — deshalb eigener Teil.
- **Rate-Wahl** (Frames: 6/12/25/50) als neuer beschreibbarer Param
  `crosspoint.transRate`; MIX/WIPE-Umschalter erst, wenn der Node Wipes
  kann (heute nur Mix — Wipe-Muster im Compositor wäre neue
  Pipeline-Arbeit, ausdrücklich Community-/P4-Scope laut §13.1;
  Button ausgegraut mit Tooltip statt weggelassen, das gehört zur
  „echtes Pult"-Anmutung).
- **Keyer/DVE als beleuchtete Toggles** mit kleinem Detail-Flyout
  (DVE: Box-Position/Größe als vier `<omp-knob>`; Keyer: vorbereitet
  für K5-DSK-Quelle).
- **Reaktionszeit:** 2-s-Poll ist für ein Pult zu träge. Der Mixer
  publiziert Tally bereits auf NATS → Panel abonniert zusätzlich den
  Shell-SSE-Stream (`/api/v1/events`, Tally-Events tragen die Node-ID)
  und refresht sofort; Poll bleibt als Fallback. Kein neuer Endpunkt.

### 3.4 Phasenplan

- **Teil 1 (reines UI-Bundle, keine Node-Änderung):** PGM/PST-Doppelreihe,
  CUT/AUTO, Keyer/DVE-Toggles im Hardware-Look auf K1-Tokens; SSE-Refresh.
  T-Bar rein visuell (animiert nur während autoTrans anhand eines
  Poll-Ticks — noch ohne Positions-Param).
- **Teil 2 (Node + UI):** `transitionPosition` (readonly) +
  `transRate` (rw) + `setTransitionPosition()` für den manuellen T-Bar;
  Rate-Buttons.
- **Teil 3 (optional, jetzt eigenes Kapitel):** physische
  Stream-Deck-Anbindung — **siehe Kapitel 8 (K8)**, dort vollständig
  ausgearbeitet (WebHID, kein Treiber, `streamdeck.js`-Referenz aus
  PIPELINE CONTROLLER). K8s erste hand-getunte Seite ist ausdrücklich
  dieser Mixer: physische Tasten rufen dieselben `crosspoint.select/
  cut/autoTrans`-Methoden wie das Bildschirm-Panel oben auf (ein
  Zustand, zwei Renderer — Bildschirm-Glow und Tasten-LED aus denselben
  K1-Tokens). Diese Zeile bleibt hier nur als Verweis stehen, Details
  nicht dupliziert.

### 3.5 Offene Fragen

1. Direktschnitt auf der PGM-Reihe (echte Pulte erlauben Hot-Cut):
   Doppelklick, Modifier, oder ganz weglassen?
2. Wie viele Quellen muss die Bank optisch tragen (Button-Größe vs.
   Discovery-getriebene, unbegrenzte Quellenzahl — ab wann zweizeilig/
   scrollend)?
3. Stream-Deck-Priorisierung: siehe Kapitel 8, offene Frage 8.5 Punkt 2
   (dort zusammengeführt statt hier dupliziert).

---

## 4. `omp-audio-mixer`: echtes digitales Mischpult (Fader, Potis) + Aux/Groups/mehrere Summen/Compressor/Limiter

> „audiomischer muss aussehen wie ein echtes digitales mischpult (fader,
> potis) und aux groups, groups und mehrere summen, compressor und
> limiter haben"

### 4.1 Ist-Zustand in OMP

- **DSP:** pro Kanal `audiotestsrc`-Testton **oder** externer
  MXL-Audio-Eingang (C11-Nachtrag), `equalizer-3bands`, `audiomixer` mit
  Pad-`volume`/`mute` (`pipeline.rs:191–214, 279, 383–395`); **eine**
  Stereo-Summe als MXL-Flow. Kein Aux, keine Gruppen, keine Dynamik,
  **kein Metering**. Audio-Follow-Video über den Tally-Bus existiert.
- **UI** (`ui/bundle.js`, 299 Zeilen): Zahlenfelder + „EQ setzen"-Button
  pro Kanal — funktional, optisch ein Formular. Immerhin bereits
  flackerfrei inkrementell gerendert (Kommentar Zeilen 9–14) — dieses
  Muster (Element einmal bauen, nur Werte aktualisieren) bleibt die
  Grundlage, sonst sind draggende Fader unbedienbar.
- `ARCHITECTURE.md` §13.2 hat das Zielmodell bereits als NcBlock-Skizze:
  `ChannelStrip ×N`, `AuxBus ×N`, `Group/VCA ×N`, `AudioFollowVideo`;
  Compressor/Limiter dort als „Community-Vertiefung" markiert — **diese
  Anforderung holt sie explizit in den eigenen Scope zurück** (bewusste
  Scope-Änderung gegenüber §13.2/C11, im Commit dokumentieren).

### 4.2 Referenz PIPELINE CONTROLLER

Dort ist Audio **Routing-zentriert**, nicht Fader-zentriert
(`audio_config.json`-Gruppen/Presets, `AudioRouter`-Matrizen, R128-
Normalisierung, Silence-Fallback) — es gibt **kein** Fader-Konsolen-UI.
Direkt übernehmenswerte Muster trotzdem:

- **Pegel-Streaming:** SSE-Event `audio-level` mit `{rms, peak}` pro
  Gruppe → VU-Meter-Rendering (`ui.html:129, 489–492, 11983 ff.`,
  `README.md` API-Beispiel). Antwort auf „wie kommen 25 Hz Pegeldaten in
  den Browser".
- **EBU-R128-Loudness pro Gruppe** als späterer Ausbaupunkt.
- Mehrfach-Summen-Denke (Gruppen sind dort eigenständige Ausgänge).

Der Konsolen-**Look** (Fader/Potis) ist also Neuentwurf — Referenz ist
die Gattung „digitales Kompaktpult", nicht PIPELINE CONTROLLER.

### 4.3 Ziel-Design

**a) DSP-Ausbau (GStreamer, verifizierbar ohne neue System-Deps):**

- **Kanalzug-Kette:** `Quelle → audioconvert → equalizer-3bands →
  audiodynamic (Compressor: mode=compressor, threshold/ratio) →
  Fader-Gain (volume) → Pan (audiopanorama) → tee` mit Abgriffen:
  Post-Fader → zugewiesene **Gruppe** oder Master; Pre/Post-Fader-Abgriff
  → **Aux-Sends** (Send-Level = `volume`-Element pro Send).
- **Gruppen (N):** je ein `audiomixer` + Gruppen-Fader + eigene Dynamik,
  Ausgang in den Master-Mixer. VCA-artige Fader-Gruppierung (nur
  Steuer-Verkopplung, kein Audio-Pfad) ist die billigere Alternative —
  v1 baut **Audio-Subgruppen** (hörbar, demo-tauglich), VCA später.
- **Aux-Busse (N):** je `audiomixer` → **eigener MXL-Audio-Flow**
  (`MxlAudioOutput` existiert seit C11) → „mehrere Summen" ist damit
  wörtlich erfüllt: Master + jede Aux/Gruppe optional als eigener
  IS-04-Sender (Mix-Minus/Monitor-Wege im Flow-Editor verkabelbar).
- **Limiter (Master, immer letzte Stufe):** `audiodynamic` mit
  `characteristics=hard-knee, ratio→∞-Näherung` als v1-Limiter;
  ehrlich dokumentieren, dass das ein einfacher Kompressor-Limiter ohne
  Look-ahead ist. Echte Alternativen (`webrtcdsp`, LADSPA/LV2-Plugins)
  nur nach Minimal-Dependency-Abwägung in `docs/decisions.md`.
  Verhalten vor Festschreiben mit `gst-inspect-1.0 audiodynamic`
  verifizieren (Memory-Regel: Enum-Properties sind Runtime-only —
  `set_property_from_str` + Live-Test, nicht nur `cargo build`).
- **Metering:** `level`-Element (post-fader) pro Kanal/Gruppe/Master
  (`interval` 50 ms) → Bus-Messages → **node-lokaler SSE-Endpunkt**
  `GET /levels` auf dem bestehenden Descriptor-HTTP-Server (Präzedenz:
  MJPEG-Preview-Port, C6) statt NATS-Flutung über den zentralen Bus;
  zusätzlich 1-Hz-Aggregat auf NATS für Engineering-Monitoring.

**b) Descriptor-Modell (Erweiterung, §13.2-konform):** pro Kanal
zusätzlich `fader` (dB, −60…+10), `pan`, `comp.enabled/threshold/ratio/
makeup`, `auxSend.<aux>.level/preFader`, `group` (Zuweisung); am Block
`addAux()/removeAux(id)`, `addGroup()/removeGroup(id)`,
`master.fader`, `limiter.enabled/ceiling`. Alles über den generischen
Proxy — B6-Panel bleibt als Fallback automatisch bedienbar.

**c) Konsolen-UI (`ui/bundle.js`, komplett neu auf K1-Kit):**

- **Kanalzüge vertikal nebeneinander**, je ~72 px breit, dunkle
  Pult-Fläche (`--omp-surface`), von oben nach unten: Quellen-Label
  (Scribble-Strip, editierbar), Gain-**Poti**, EQ-Sektion (3
  `<omp-knob>` LO/MID/HI mit Mittenrastung), COMP (Threshold-Knob +
  4-LED-Gain-Reduction-Kette), 2× AUX-Send-Knob, PAN-Knob,
  AFV/MUTE-Tasten (beleuchtet: MUTE rot, AFV amber), daneben
  **`<omp-meter>`** (grün/gelb/rot-Segmente, Peak-Hold-Strich) parallel
  zum **`<omp-fader>`** (vertikale Bahn ~160 px, dB-Skala-Ticks,
  Doppelklick = 0 dB, Shift = Feinmodus).
- **Master-Sektion rechts**, abgesetzt: Gruppen-Fader (schmaler),
  Aux-Master, Stereo-Master-Fader mit großem Meter, LIMITER-Taste mit
  GR-Anzeige, „+ Kanal / + Gruppe / + Aux"-Buttons.
- **Interaktion:** Pointer-Capture-Drag; lokaler Wert gewinnt während
  des Drags (das bestehende „fokussiertes Element nicht überschreiben"-
  Muster, `bundle.js:210–226`, auf „aktiv gedraggtes" erweitert), PATCH
  gedrosselt (~10 Hz), Server-Wert bleibt Wahrheit nach Drag-Ende.
- Meter-Daten über den `/levels`-SSE des Nodes (href steht im Panel
  über den bestehenden Discovery-Weg zur Verfügung; CORS/Proxy-Frage
  siehe 4.5).

### 4.4 Phasenplan

- **Teil 1 — Konsolen-Optik + Metering (kein neues Routing):**
  `<omp-fader>/<omp-knob>/<omp-meter>` (mit K1-Teil-2 koordiniert),
  UI-Neuaufbau für die **bestehenden** Params (Gain→Fader, EQ→Knobs,
  Mute/AFV-Tasten); `level`-Elemente + `/levels`-SSE im Node.
  Bereits das erfüllt „sieht aus wie ein Pult" für die Präsentation.
- **Teil 2 — Dynamik:** `audiodynamic`-Compressor pro Kanal +
  Master-Limiter inkl. GR-Metering, Descriptor + UI-Sektionen.
- **Teil 3 — Busse:** Subgruppen + Aux-Sends + zusätzliche
  MXL-Summen-Ausgänge (mehrere IS-04-Sender pro Node — SDK kann das
  seit C5/C11), Master-Sektion komplett.
- **Teil 4 — Vertiefung:** R128-Messung/Normalisierung am Master
  (PIPELINE-CONTROLLER-Muster), VCA-Gruppen, Solo-Bus.

### 4.5 Offene Fragen

1. Pegel-Streaming vom Node-eigenen HTTP-Server direkt an den Browser
   funktioniert nur, solange Browser die Node-Ports erreichen (heute
   Single-Host ok). Soll der Orchestrator dafür einen generischen
   Stream-Proxy bekommen (`/api/v1/nodes/<id>/stream/<name>`) — auch
   für MJPEG-Preview relevant (bekanntes C12-Problemfeld)?
2. Wie viele Aux/Gruppen als Default-Bestückung (Vorschlag: 2 Aux,
   2 Gruppen, dynamisch erweiterbar)?
3. Reicht der `audiodynamic`-Limiter (ohne Look-ahead) für das Zielbild,
   oder ist ein LV2-Limiter (`x42`/Calf — neue System-Dependency) die
   Qualität, die gemeint war?
4. Solo/PFL: braucht die Präsentation einen Abhörweg (impliziert
   Monitor-Summe + lokale Wiedergabe), oder reicht Metering?

---

## 5. OGraf-Grafik-Microservice `omp-ograf`

> „es fehlt noch immer das ograf microservice (dieses muss alle
> funktionen und das UI (also den editor) vom pipeline controller
> projekt haben)"

### 5.1 Ist-Zustand in OMP

**Es existiert kein Grafik-Node** (kein Crate unter `nodes/`). Aber das
Konzept ist das am gründlichsten vorbereitete des ganzen Projekts:
`ARCHITECTURE.md` §11.2 enthält bereits NcBlock-Modell
(`TemplateLibrary` + `GraphicsChannel` mit `show/update/continue/hide`),
die Render-Entscheidung (**`wpesrc`/WPE WebKit, Headless-Chromium als
dokumentierter Fallback**), den MXL-Alpha-Vorabbefund (`video/v210a` in
`third_party/mxl/lib/tests/data/v210a_flow.json`), die DSK-Einordnung
(OGraf liefert Fill+Key an den Mixer-Keyer, kein Insert-Loop) und die
**offene Demo-3-Scope-Frage** (OGraf in den Regieplatz-Block aufnehmen
oder Demo 4 — `docs/decisions.md` 2026-07-11, bis heute unbeantwortet).

### 5.2 Referenz PIPELINE CONTROLLER (Funktions-Inventar = Ziel-Checkliste)

`lib/GrafixEngine.js` (2300 Zeilen), `server.js:3654–3790`, UI-Teile in
`ui.html` (Sektion „oGraf", `10953 ff.`, Children-Editor `8857 ff.`,
Hotkeys), `grafik_hotkeys.json`, `templates/grafik/` (~45 Templates +
eingebaute Defaults lowerThird/clock/fullscreen/ticker):

- **Template-Modell:** `*.ograf.json`-Manifest (EBU-OGraf v1): `main` =
  ES-Modul/Custom-Element, `schema` = JSON-Schema der Daten (GDD-Typen
  wie `color-rrggbb`), `stepCount`, `renderRequirements`.
- **Lifecycle:** `load()` → `playAction()`, `updateAction({data})`,
  `stopAction()`, Continue = `playAction({goto: step+1})`; UI blendet
  Continue bei `stepCount === 1` aus (`ui.html:11181–11184`).
- **Engine-Funktionen:** mehrere gleichzeitige Instanzen (grafixId-Map),
  Layer `overlay`/`full` (+ Backdrop-Logik), `showImage` (Standbilder),
  **Pre-Cue** (unsichtbar ~2,5 s vorladen — dynamische `import()`s sind
  langsam), **adaptive Render-Rate** (volle fps nur bei Animation, ~1 fps
  statisch, ~0,2 fps leer), Latenz-Kompensation (`grafikLatencyMs`),
  eigener Preview-HTTP-Stream, Green-Zone-/DVE-Zonen-Erkennung,
  Playlist-**Variablen-Auflösung** `{{next[class(movie)]:title|fmt}}`
  (`_resolveVars`, `GrafixEngine.js:989 ff.`), Child-Event-Scheduling
  (`scheduleChildEvents`, delay/duration/persist/endOffset framegenau).
- **API-Muster:** `POST /api/grafik/{show|hide|update|continue}`,
  `GET /api/grafik/status` (Templates + aktive Instanzen), Hotkey-CRUD +
  `/fire`.
- **UI („der Editor"):** Template-Dropdown (★ = echtes OGraf),
  **aus dem Template-Schema generierte Eingabemaske**
  (`_buildFieldInput`), Take/Out/Continue, On-Air-Strip, in rechtes
  Panel expandierbar, **Hotkey-Grid** (mx-btn-Karten, on-air-Zustand,
  Edit/Delete), `{{…}}`-Variablen-Builder, Grafik-Children-Editor im
  Playlist-Event.
- **Wichtig für die Erwartungshaltung:** Es gibt in PIPELINE CONTROLLER
  **keinen WYSIWYG-Template-Designer** — Templates sind Dateien; „der
  Editor" im Sprachgebrauch des Projekts ist die Kombination aus
  Manuell-Steuerung (Schema-Formulare), Hotkey-Editor und
  Children-Editor. Genau dieser Umfang wird hier als Ziel angesetzt
  (siehe offene Frage 3, falls doch ein Template-Designer gemeint war).

### 5.3 Ziel-Design für OMP

**Neues Crate `nodes/omp-ograf`** auf `omp-node-sdk`-Basis,
Katalog-Kategorie `graphics` (§13.5).

- **Render-Pfad (Entscheid §11.2 respektieren, aber zuerst Spike):**
  Variante A `wpesrc` (gst-plugins-bad/WPE) direkt in der Pipeline —
  Alpha nativ, ein Prozess. Variante B (Fallback, dem PIPELINE-
  CONTROLLER-Muster näher): Headless-Chromium als Kindprozess, Frames
  per CDP-Screencast/Screenshot → `appsrc` (BGRA). Risiko ehrlich:
  `wpesrc` ist auf Debian/Crostini oft nicht paketiert, und Chromium
  crasht in der Claude-Sandbox (decisions B2) — deshalb ist **Teil 0
  ein Render-Spike** mit Go/No-Go pro Variante gegen 5 repräsentative
  der 45 Templates, bevor irgendein Node-Code entsteht.
- **Host-Seite:** lokale statische HTML-Seite (vom Node ausgeliefert),
  die Templates per `import()` lädt und die OGraf-Lifecycle-Methoden
  aufruft; Steuerung Node→Seite über die jeweilige Engine-Schnittstelle
  (wpesrc: `run-javascript`/Messaging; Chromium: CDP). Pre-Cue und
  adaptive Render-Rate von Anfang an übernehmen (erspartes Neuland,
  §11.2).
- **Ausgang:** `appsrc/wpesrc → videoconvert → capsfilter → 
  MxlVideoOutput` als **ein Flow mit Alpha** (`video/v210a` — gegen den
  aktuellen MXL-Spec-Stand verifizieren, §11.2-Auflage; Fallback:
  getrennte Fill+Key-Flows, zwei Sender). Empfänger: DSK-Worker des
  `omp-video-mixer-me` bekommt statt der heutigen Test-Farbfläche
  (`pipeline.rs:441`) einen echten MXL-Receiver mit Alpha-Compositing —
  **kleine, separate Mixer-Erweiterung**, im Flow-Editor als normale
  Kante sichtbar.
- **Descriptor** (nach §11.2-Skizze): readonly `templates[]`
  (Scan `OMP_OGRAF_TEMPLATES`, je `{id, label, stepCount, schema}`),
  readonly `activeGraphics[]`; Methoden `show(template, data, layer)`,
  `update(id, data)`, `continue(id)`, `hide(id)`, `hideAll()`;
  Hotkeys als CRUD-Methoden + readonly-Liste (persistiert node-lokal
  als JSON, Muster `grafik_hotkeys.json`). `data` wird gegen das
  Template-Schema validiert (SDK-Method-Dispatch mit Argumenten
  existiert seit C4-prep).
- **UI-Bundle (Grafiker-Konsole):** dreispaltig — links Template-Browser
  (Suchfeld, ★-Kennzeichnung), Mitte **generisch aus dem
  Template-JSON-Schema generiertes Formular** (bewusst dieselbe
  Denkfigur wie B6/`ui/graph/controls.ts`, aber eigener Generator im
  Bundle, da JSON-Schema ≠ Descriptor-Format) + TAKE/CONTINUE/TAKE-OUT
  als große beleuchtete Tasten (K1-Kit), rechts On-Air-Stack (aktive
  Instanzen mit Layer/Step, Einzel-Out) und darunter das **Hotkey-Grid**
  im mx-btn-Stil. Vorschau: `omp-mediaio::preview`-MJPEG des eigenen
  Ausgangs im Panel-Kopf (Checkerboard-Hintergrund für Alpha).
- **Templates übernehmen:** `templates/grafik/**/*.ograf.json` +
  Assets 1:1 in ein neues Repo-Verzeichnis (`nodes/omp-ograf/templates/`
  oder `deploy/ograf-templates/`) — die einzige erlaubte
  Direktübernahme (portables Format, Begründung oben). Lizenzlage der
  Templates vorher klären (offene Frage 4).
- **Playout-Integration** (Child-Events, Variablen-Auflösung) ist
  ausdrücklich **K6-Scope** — dieselben `show/…`-Methoden, keine zweite
  API (§11.2/§13.1-Prinzip).

### 5.4 Phasenplan

- **Teil 0 — Render-Spike (eigene Sitzung, Ergebnis in
  `docs/decisions.md`):** wpesrc-Verfügbarkeit auf dem Dev-System
  prüfen; beide Varianten gegen 5 Templates; Alpha-Pfad bis in einen
  MXL-Flow + `omp-viewer`-Sichtprobe. Go/No-Go + Variantenwahl.
- **Teil 1 — Kern-Node:** Template-Scan, `show`/`hide` **eines**
  Templates auf Layer `overlay`, Alpha-MXL-Ausgang, Contract-Check
  grün. Verifikation: Bauchbinde über `omp-source`-Bild via
  Mixer-DSK (falls Mixer-Erweiterung noch fehlt: Sichtprobe des
  Grafik-Flows allein im Viewer).
- **Teil 2 — Mixer-DSK-Anschluss:** MXL-Alpha-Receiver im
  `omp-video-mixer-me`-Keyer-Worker (ersetzt Test-Farbfläche).
- **Teil 3 — volle Engine-Funktionen:** update/continue/hideAll,
  mehrere Instanzen, Layer `full`, Pre-Cue, adaptive Rate, showImage.
- **Teil 4 — Grafiker-UI komplett:** Schema-Formulare, On-Air-Stack,
  Hotkey-Grid + CRUD, Preview. (Operator-Console/C13 macht das Panel
  automatisch zum „Grafiker-Arbeitsplatz" — keine Extraarbeit.)
- **Teil 5 — später, mit K6:** Child-Events + Variablen-Auflösung.

### 5.5 Offene Fragen

1. **Demo-Scope-Frage aus §11.2 endlich entscheiden:** OGraf in den
   Regieplatz-Demo-Umfang aufnehmen (Empfehlung: ja — der Mixer-Keyer
   hat sonst weiter nur eine Testfarbfläche) oder als Demo 4 führen?
2. Render-Variante: falls der Spike beide Varianten „grün" zeigt —
   wpesrc (ein Prozess, §11.2-Entscheid) trotz Paketierungs-Risiko, oder
   Chromium/CDP (robuster verfügbar, PIPELINE-CONTROLLER-erprobt, aber
   Zusatzprozess)?
3. Bedeutet „Editor" ausschließlich den PIPELINE-CONTROLLER-Umfang
   (Schema-Formulare/Hotkeys/Children — so hier angesetzt), oder ist
   zusätzlich ein Template-**Authoring**-Werkzeug gewünscht (wäre ein
   eigenes, großes Projekt — Empfehlung: nein, Templates bleiben
   Dateien nach EBU-Spec)?
4. Dürfen die ~45 Templates lizenzrechtlich unverändert in dieses Repo
   übernommen werden (PIPELINE CONTROLLER hat eine eigene LICENSE)?

---

## 6. `omp-playout-automation`: Funktionsumfang und Operator-Interface des PIPELINE CONTROLLER

> „die playout automatisation muss alle funktionen des pipeline
> controller projekts haben und ein ähnliches interface für den operator"

### 6.1 Ist-Zustand in OMP

`nodes/omp-playout-automation` (C14/C15, `docs/decisions.md`
2026-07-13): dünner Sequenzer **ohne eigene Pipeline** — steuert einen
`omp-player` (append/load/remove/cue/take) und einen
`omp-video-mixer-me` (crosspoint.select/cut) über deren eigene
IS-12/14-Methoden fern (`src/remote.rs`, direkte Node-HTTP; Ziel-Wahl
über beschreibbare Parameter `targetPlayerLabel`/`targetMixerLabel`).
Playlist = geordnete Item-IDs (`src/playlist.rs`, 318 Zeilen),
Auto-Advance über einen 200-ms-Timer gegen `durationMs`
(`main.rs:53–56`), weil der Player kein EOS kennt. Modi `auto`/`hold`.
UI (`ui/bundle.js`, 258 Zeilen): Ziel-Labels, Verbunden-Badge,
Item-Liste mit Cue/Take, Fortschrittsbalken. Items sind Testmuster
(`pattern`/`toneFrequency`/`durationMs`).

Diese Architektur ist die **richtige** Basis für die Parität: PIPELINE
CONTROLLERs `PlaylistEngine` ist ebenfalls ein Sequenzer über fremden
Playern/Mastern — der Unterschied ist Funktionsumfang, nicht Struktur.

### 6.2 Referenz PIPELINE CONTROLLER — Funktions-Inventar (`lib/PlaylistEngine.js`, `ui.html`)

Sequenzer-Kern: Event-States `pending → playing → done | skipped`;
`startType` `sequence`/`fixtime` mit **parallel registrierten
Wall-Clock-Timern** (ms-genau, 30-s-Grace-Fenster, DST-sicher,
`PlaylistEngine.js:1–12, 73–86, 1468 ff.`); Pre-Cue 5 s
(`PRE_CUE_MS`); Transitions pro Event `cut / v-fade / cut-fade /
fade-cut / xfade` inkl. **Xfade-Look-ahead** (Folge-Event verkürzt die
effektive Dauer, `:515–528`); `jump()`/Interrupt/`nextLive`; Idle-Source
nach Listenende; Loop; Meta-Events `block_start`/`block_end`;
Klassifikation (`commercial`/`promo` → SCTE-35). Dazu im Umfeld:
**Child-Events** pro Playlist-Eintrag (Grafik/Bild/Voiceover/Record/
Trigger mit delay/duration relativ zu Clip-Start **oder** -Ende,
`ui.html:8857 ff.`), **Asset-Panel** (Unterbrecher mit Auto-Return:
interrupt/break/live), **Counter-Strip** (alle zeitkritischen Events der
Stunde), Event-Editor (SOM/EOM-Modi manuell/vollständig/Segment,
Klassifikation, Start-Typ, Transition, Children —
`ui.html:993–1171`), As-Run-Log (täglich, `asrun/`), Marina-Sync,
ChannelBus-Cross-Channel-Trigger, Voiceover-Engine, Record-Engine,
SCTE-35, Plugin-System.

### 6.3 Ehrliche Scope-Übersetzung („alle Funktionen" nach Schichten)

Volle wörtliche Parität schließt Subsysteme ein, die in OMP als
**eigene Nodes** existieren müssten (Voiceover = Audio-Zuspieler,
Record = Aufzeichnungs-Node, SCTE-35 = Daten-Node) — sie in den
Automation-Controller zu ziehen, würde die „Controller ohne eigene
Pipeline"-Entscheidung (C14) und das Ein-Funktion-pro-Node-Prinzip
brechen. Übersetzung:

| PIPELINE-CONTROLLER-Funktion | OMP-Verortung |
|---|---|
| Sequenz/Fixtime/Jump/Skip/Hold/Loop/Idle | **hier**, Kern-Scope |
| Transitions pro Event (cut/fade/xfade) | **hier** — als Aufruf-Choreografie von Mixer (`autoTrans`/`transRate`, K3-Teil-2) + Player-A/B-Slots |
| Echte Clips, EOS-Advance, SOM/EOM | **K2** (`omp-player`); Automation konsumiert `itemEnded` |
| Grafik-Child-Events, Variablen | **hier**, sobald **K5** existiert |
| Asset-/Break-Panel mit Auto-Return | **hier** (reine Sequenzer-Logik) |
| Counter-Strip, Event-Editor, Rundown-UI | **hier**, UI-Bundle |
| As-Run-Log | **hier** publizieren (NATS `omp.asrun.<id>`), Persistenz im Orchestrator/Postgres (kleiner additiver Endpunkt) |
| Voiceover/Record/SCTE-35/Marina/ChannelBus/Plugins | **nicht hier** — je eigener Node/Trigger-Child-Typ, ausdrücklich späterer, separater Scope (Community-/P4-Linie) |

### 6.4 Ziel-Design

**Datenmodell (Item-Metadaten erweitern, `main.rs`-`ItemMeta` →
Event):** `{id, label, source (K2: file/pattern), somMs/eomMs,
durationMs (aus Probe), startType: sequence|fixtime, startTime
("HH:MM:SS:FF"), transition: cut|mix, transitionRateFrames,
children: [{type: "graphics", template, data, delayMs, durationMs,
relativeTo: start|end}], state: pending|cued|onair|done|skipped}` —
alles Descriptor-/Methoden-Ebene, Persistenz der Playlist als
speicher-/ladbare Objekte (Vorschlag: Orchestrator-API
`GET/PUT /api/v1/playlists/<name>` analog Layouts/D1-Postgres — die
Automation lädt/sichert über den generischen Proxy; Alternative
node-lokale Datei, siehe offene Frage 2).

**Scheduler:** neben dem bestehenden Advance-Tick ein
Wall-Clock-Zweig nach PIPELINE-CONTROLLER-Muster: beim Start/Ändern der
Liste für jedes `fixtime`-Event einen absoluten Timer registrieren
(tokio `sleep_until`), Grace-Fenster konfigurierbar (Default 30 s),
verpasste Zeiten → `skipped` + Alarm-Event. Fixtime feuert unabhängig
vom Sequenz-Fortschritt (harter Unterbrecher mit Pre-Cue davor).

**Take-Choreografie mit Transitions:** heute `select`+`cut`; neu pro
Event: `cut` → wie heute; `mix` → `select`+`autoTrans` mit vorher per
PATCH gesetzter `transRate` (K3-Teil-2). Echtes Audio/Video-Xfade
zwischen zwei **Clips desselben Players** kann der A/B-Slot-Player
nicht darstellen (ein Ausgang, harte `active-pad`-Umschaltung) —
ehrliche v1-Grenze: Xfade nur zwischen **zwei Player-Instanzen** über
den Mixer (Workflow mit Player A + Player B als getrennte Quellen,
Automation alterniert die Ziele). Als spätere Vertiefung im Player
(Compositor statt input-selector) notiert, nicht versprochen.

**Operator-UI (Rundown, „ähnliches Interface"):** vollflächiges Panel
im K1-Look —

- **Kopfzeile:** Uhr (Mono-Font, groß), ON-AIR-Badge, Countdown zum
  nächsten Fixtime-Event, Mode-Schalter AUTO/HOLD als beleuchtete
  Taste, großer NEXT/TAKE-Button; darunter der **Counter-Strip**
  (horizontale Leiste der nächsten zeitgebundenen Events mit
  Live-Countdowns).
- **Rundown-Tabelle** (statt heutiger Item-Kärtchen): Spalten
  `# ・ Start (geplant/errechnet) ・ Titel ・ Dauer ・ Rest ・ Trans ・
  Children-Badges (🎨 Grafik) ・ Status`; On-Air-Zeile rot hinterlegt
  mit laufendem Fortschrittsbalken in der Zeile, gecuete Zeile amber
  (Farb-Semantik = K1-Tokens, identisch zu K3/K4); Drag-Reorder;
  Kontextmenü Cue/Skip/Delete/Jump.
- **Event-Editor** als Seitendrawer (Klick auf Zeile): Quelle
  (Clip-Browser aus K2-`mediaLibrary`), SOM/EOM, Start-Typ + Zeitfeld,
  Transition + Rate, Children-Liste (Teil „Grafik": Template +
  Schema-Formular aus K5, delay/duration relativ Start/Ende — direkte
  Entsprechung des `ui.html:8857`-Children-Editors).
- **Break/Asset-Leiste:** benannte Unterbrecher-Buttons (mx-btn-Stil):
  Klick cued den Break-Clip, TAKE unterbricht, nach Break-Ende
  automatischer Return zum unterbrochenen Event (Restdauer-Rechnung im
  Sequenzer).

### 6.5 Phasenplan

- **Teil 1 — Rundown-Fundament:** erweitertes Event-Modell (Label,
  Reorder/`move`, Zustände, `skip`, `jump`), Rundown-Tabelle + Kopfzeile
  im K1-Look. Kein neuer Scheduler. (Unabhängig von K2 machbar —
  Testmuster-Items behalten `durationMs`.)
- **Teil 2 — echte Clips + EOS:** Umstellung auf K2-Player-Events
  (`itemEnded` statt reinem Timer; Timer bleibt Fallback für
  Pattern-Items), Clip-Browser im Event-Editor, As-Run-Publikation.
- **Teil 3 — Fixtime-Scheduler + Counter-Strip:** Wall-Clock-Timer,
  Grace-Regel, Countdown-UI, Alarm bei verpasster Zeit.
- **Teil 4 — Transitions + Break/Auto-Return:** Mix-Take über
  K3-Teil-2-Params; Break-Leiste mit Return-Logik.
- **Teil 5 — Grafik-Children (nach K5):** Children-Editor,
  Scheduling relativ Start/Ende, Variablen-Auflösung
  (`{{next:title}}`-Teilmenge) aus dem Playlist-Kontext.

### 6.6 Offene Fragen

1. Abgrenzung zu D7-Teil-2-Zeitsteuerung klarhalten: Workflow-Zeitplan
   (§6.2: Regieplatz startet/stoppt) vs. Playlist-Fixtime (Event in
   laufender Sendung) — beides „Scheduler", bewusst getrennte Systeme.
   Einverstanden, oder soll ein gemeinsamer Zeitdienst entstehen?
2. Playlist-Persistenz: Orchestrator/Postgres (`/api/v1/playlists`,
   überlebt Node-Neustarts, zentral sicherbar) oder node-lokal (weniger
   API, aber gegen die D1-Linie)? Empfehlung: Orchestrator/Postgres.
3. Welche PIPELINE-CONTROLLER-Subsysteme aus der „nicht hier"-Zeile
   (6.3) haben reale Priorität für das Zielbild — Record? SCTE-35?
   (Bestimmt, ob dafür eigene Node-Konzepte in `ARCHITECTURE.md` §13
   ergänzt werden müssen.)
4. Multi-Kanal (PIPELINE CONTROLLER `supervisor.js`): in OMP ist „ein
   Kanal" = ein Workflow mit eigener Automation-Instanz — das deckt
   Multi-Kanal strukturell bereits ab. Reicht das als Antwort, oder ist
   ein kanalübergreifendes Dashboard (ChannelBus-Äquivalent) Teil des
   Zielbilds?

---

## 7. Hochverfügbarkeit / Redundanz-Konzept

> Nachforderung des Projektinhabers (keine wörtliche deutsche Ausgangs-
> formulierung wie bei K1–K6; sinngemäß): ein konkretes HA-/
> Redundanzkonzept statt nur der Bestätigung, dass das Thema
> zurückgestellt ist — verankert in `ARCHITECTURE.md` §6.3 (reaktives
> Failover) und §21 (Ausfallsicherheits-Gesamtkonzept inkl. Standort-
> redundanz), sowie in der offenen Redundanz-/Failover-Frage aus dem
> Projekt-Memory.

### 7.1 Ist-Zustand (Konzept vollständig, Umsetzung fast vollständig offen)

`ARCHITECTURE.md` hat dieses Thema bereits gründlicher durchdacht als
jedes andere in diesem Dokument — §6.3 (vier Stufen: Crash-Erkennung,
Restart-in-place, Degradation, Hot-Standby), §19 (Orchestrator-
Active-Passive über Postgres-Advisory-Lock), §20.1 (Genlock-Äquivalenz-
Frage, mit Fable-Recherche zu AMPPs öffentlicher Resilienz-Story: primär
schnelles Sekunden-Respawn + optionales 1+1-Hot-Backup pro Kanal, **kein**
öffentlicher Beleg für echtes frame-unsichtbares Lockstep-Failover) und
§21 (konsolidierende Tabelle über alle Ebenen + neue Standort-/
Regions-Redundanz-Ebene, §21.2). **Aber:** praktisch die gesamte
Umsetzung ist noch offen — `UMSETZUNG.md` hat für §6.3/§19/§21 bis heute
**keinen einzigen** C/D-Schritt (bewusst, siehe §6.3/§19-Testbarkeits-
Absätze: „kein Schritt vor Bedarf").

**Was am Code tatsächlich schon existiert, per Lesen verifiziert (nicht
im Konzept-Text sichtbar):**

- **Crash-Erkennung existiert, Auto-Restart nicht.**
  `orchestrator/internal/launcher/launcher.go:101–112` markiert eine
  Instanz nach unerwartetem Prozessende als `Crashed` (inkl.
  `CrashMessage` aus den letzten 5 stderr-Zeilen, `crashStderrLines`,
  Zeile 45) und broadcastet ein `instance.crashed`-NATS-Event
  (verifiziert per `launcher_test.go:225–262`,
  `TestLauncherMarksUnexpectedExitAsCrashedAndBroadcasts`). Die
  gecrashte Instanz bleibt danach aber einfach als „crashed" stehen —
  **kein** Restart-Timer, **keine** erneute Anwendung des
  Workflow-Verbindungs-Templates. §6.3 Stufe 2 („Restart-in-place …
  Orchestrator muss den Neustart nur beobachten … und das
  Verbindungs-Template automatisch wieder anwenden") ist damit zur
  Hälfte gebaut: die Beobachtung (Erkennung) ja, die Reaktion nein.
- **Der `node.added`-Wiederverkabelungs-Mechanismus existiert bereits**
  (D7 Teil 1, `docs/decisions.md` 2026-07-14): beim Workflow-Start löst
  der Orchestrator das Rolle→Rolle-Verbindungs-Template auf echte
  IS-05-Connections auf, sobald die erwartete Node-Registrierung
  erscheint. Dieser Mechanismus ist heute nur an den Workflow-**Start**
  gebunden, nicht an ein erneutes Erscheinen derselben Rolle nach einem
  Absturz — genau die Lücke, die §6.3 Stufe 2 mit „derselbe
  `node.added`-Glue wie beim Workflow-Start" bereits als Wiederver-
  wendung vorgesehen hatte.
- **Ursprungs-Zeitstempel-Erhalt ist bereits gebaut** (Memory-Update
  2026-07-12, `omp-mediaio::mxl`, `GstReferenceTimestampMeta`): eine
  von zwei in der Fable-Recherche genannten Voraussetzungen für Option
  (b) (Genlock-Äquivalenz) ist damit tatsächlich erledigter Code, nicht
  nur Empfehlung — Zustands-Synchronität/Rebind-Zeit (die zweite
  Voraussetzung) bleiben offen.
- **Placement-Engine (§6.1) ist weiterhin nicht gebaut** — Status-
  Checkliste `UMSETZUNG.md` §7: „D6 Teil 3 (Placement-Engine, §6.1) |
  offen". Automatischer **Cross-Host**-Failover (Ziel-Host wählen,
  Karten-/Ressourcen-Claims prüfen) braucht diese Engine zwingend —
  **Failover auf demselben Host braucht sie nicht** (kein Host-Wechsel,
  keine Placement-Entscheidung).
- **Workflow-Objekt (D7 Teil 1) ist gebaut**, D7 Teil 2 (Zeitsteuerung +
  Ressourcen-Vorprüfung) offen. Das Rollenmodell aus D7 Teil 1 ist
  bereits die richtige Grundlage, um „dieselbe Rolle, anderswo
  gestartet" zu definieren — Hot-Standby (§6.3 Stufe 4) braucht davon
  im Kern nur eine zusätzliche `standby: bool`/`replicas`-Angabe pro
  Rolle, keine neue Modellierung.
- **MXL ist strukturell lokal, das begrenzt Cross-Host-Redundanz
  fundamental** (`ARCHITECTURE.md` §2/§6): MXLs Zero-Copy-Shared-Memory
  existiert nur innerhalb eines Hosts (`/dev/shm/omp-mxl`,
  `docs/decisions.md`/Memory „OMP dev environment gotchas"). Ein Node,
  der über MXL an andere Nodes angebunden ist, kann bei einem
  Host-Ausfall **nicht** einfach als identische Instanz auf einem
  anderen Host weiterlaufen und automatisch wieder verkabelt werden —
  seine MXL-Eingänge/-Ausgänge existieren auf dem toten Host nicht
  mehr. Cross-Host-Redundanz für MXL-gebundene Rollen braucht also
  zwingend einen **ST-2110/SRT-Übergang** als Redundanz-Grenze (§6, D4
  `omp-mediaio::st2110` + `omp-srt-gateway` bereits vorhanden) — nicht
  MXL selbst. Das ist keine neue Erkenntnis (§6.1 „Migrations-Grenze"
  sagt strukturell dasselbe für I/O-Karten), aber bisher nicht explizit
  für MXL-Redundanz ausgesprochen.

### 7.2 Referenz PIPELINE CONTROLLER

PIPELINE CONTROLLER ist Single-Box-„Channel-in-a-Box" — es gibt dort
**keine** Mehr-Host-Redundanz, kein Hot-Standby-Konzept. Der einzige
direkt einschlägige Baustein ist `supervisor.js`s Prozess-Überwachung
für den Multi-Channel-Betrieb (mehrere `server.js`-Prozesse, ein
Supervisor):

- **Auto-Restart-mit-Backoff bereits fertig implementiert** — genau die
  Lücke aus 7.1: `on('exit', (code, sig) => { … status = 'restarting';
  restarts++; _restartTimer = setTimeout(() => this.start(),
  RESTART_MS); })` (`supervisor.js:183–192`). Jeder Kanal führt einen
  Restart-Zähler (`this.restarts`), der im Dashboard sichtbar ist
  (`supervisor.js:412`); ein manueller Restart hat eine
  Sicherheitsabfrage („Really restart channel … Playout will be briefly
  interrupted.", `supervisor.js:336`) — dasselbe Bestätigungs-Muster,
  das OMPs §6.2 Punkt 2 (`confirm_stop`) bereits für Workflow-Stop kennt.
- **Kein State-Handoff:** ein neu gestarteter Kanal-Prozess fängt von
  Neuem an (Playlist-Resume-Punkt kommt aus der Konfigurationsdatei,
  nicht aus einem übernommenen Live-Zustand) — bestätigt, dass „billig,
  aber sichtbare Unterbrechung" (§6.3 Stufe 2) auch dort der reale,
  akzeptierte Normalfall ist, kein Sonderfall von OMP.
- Direkt übernehmenswertes Muster (nicht Code): **Restart-Zähler +
  sichtbarer Status im UI** — für OMPs `instance.crashed`/künftiges
  `instance.restarted`-Event dasselbe Prinzip: nicht nur intern
  behandeln, sondern im Hosts-/Workflows-Panel (K1) sichtbar machen,
  damit ein Operator ein flatterndes/wiederholt abstürzendes Modul
  erkennt (ein Prozess, der alle 5 Sekunden neu startet, ist ein
  eigener Alarm-würdiger Zustand, kein „ist ja wieder online").

### 7.3 Ziel-Design: HA pro Schicht

**a) Node-/Pipeline-Prozess-Ebene (billigste, am weitesten vorbereitete
Schicht — §6.3 Stufen 1–3):**

- **Auto-Restart-in-place im Launcher** (schließt die 7.1-Lücke): neues
  Feld je Katalog-Eintrag/Workflow-Rolle `restartPolicy {maxRestarts,
  backoffMs, window}` (PIPELINE-CONTROLLER-Muster: fester Delay +
  Zähler; Verbesserung gegenüber dem Vorbild: ein Umlauf-Fenster, nach
  dem der Zähler zurückgesetzt wird, plus eine harte Obergrenze, ab der
  **nicht** mehr automatisch neu gestartet wird, sondern eskaliert wird
  — PIPELINE CONTROLLER retryt unbegrenzt, für einen 24/7-Kontext ist
  eine Crash-Loop-Bremse sicherer, siehe offene Frage 7.5 Punkt 2).
  Neues NATS-Event `instance.restarted` (zusätzlich zum bestehenden
  `instance.crashed`).
- **Wiederverkabelung nach Neustart:** der bestehende D7-`node.added`-
  Glue wird generalisiert — nicht nur „Workflow gerade gestartet",
  sondern „eine erwartete Rolle dieses laufenden Workflows ist wieder
  registriert" (Korrelation über den bestehenden `urn:x-omp:instance`-
  Tag, C8/D7) löst dieselbe Template-Anwendung erneut aus. Das ist
  §6.3 Stufe 2, jetzt konkret geplant statt nur konzeptionell benannt.
- **Degradation (§6.3 Stufe 3):** bereits gelebtes Muster
  (`omp-switcher`s Schwarzbild-Fallback, C7) — als SDK-Leitlinie in
  `docs/NODE-TUTORIAL.md` (D5) verankern, falls dort noch nicht
  geschehen (kurze Prüfung als Teil der Umsetzung, kein neuer Code).

**b) Medientransport-Ebene (unterscheidet sich fundamental nach
Transport, wie in 7.1 hergeleitet):**

- **MXL (lokal):** keine Cross-Host-Redundanz möglich — die einzige
  „Redundanz" auf dieser Ebene ist Prozess-Restart auf **demselben**
  Host (Schicht a). Ehrlich als Grenze kommunizieren, nicht als Lücke
  kaschieren.
- **Netzwerktransport (ST 2110/SRT, D4 bereits vorhanden):** ST 2022-7
  (Dual-Path-Redundanz **einer** bitidentischen Quelle) ist die
  günstigste „echte" Netzwerk-HA-Stufe und bisher **nicht** als
  `omp-mediaio::st2110`-Fähigkeit umgesetzt (D4 hat den Grundtransport
  gebaut, nicht die 2022-7-Redundanz) — konkreter, sauber
  abgegrenzter Ausbauschritt auf bereits vorhandenem Code.
  Cross-Host-Node-Redundanz für MXL-gespeiste Rollen bedeutet also in
  der Praxis: die redundante zweite Instanz sitzt hinter einem
  ST-2110/SRT-Übergang, nicht als zweiter MXL-Teilnehmer im selben
  Domain (der laut Definition auf demselben Host läge).

**c) Orchestrator selbst (§19, Konzept bereits vollständig — hier keine
neue Design-Arbeit nötig):** Active-Passive über Postgres-Advisory-Lock
+ schlanker VIP/Health-Proxy. Bleibt wie in §19 beschrieben; dieses
Kapitel ergänzt nur die Einordnung in die Gesamt-Phasierung (7.4).

**d) Zusammenspiel mit Placement-Engine (§6.1/D6 Teil 3) und
Workflow-Objekt (D7):** automatischer **Cross-Host**-Failover (§6.3
Stufe 4, Hot-Standby) braucht zwingend beides — die Placement-Engine,
um überhaupt einen Ziel-Host mit freier Kapazität/passenden
I/O-Karten-Claims zu finden (§6.1), und das Workflow-Rollenmodell (D7),
um zu wissen, was „dieselbe Rolle, auf einem anderen Host" bedeutet und
das Verbindungs-Template dorthin umzuziehen. **Deshalb ist Hot-Standby
in diesem Dokument explizit auf „nach D6 Teil 3" sequenziert** — Schicht
a (Prozess-Restart auf demselben Host) braucht dagegen **keine** der
beiden und kann sofort beginnen.

**e) Eskalationsstufen wiederverwenden statt neu erfinden:** §6.1s
bereits bestehende Eskalationsstufen `advisory`/`auto-confirm-window`/
`auto` (dort für Placement-Migration unter Ressourcen-Trend definiert,
mit der ausdrücklichen Notiz „Bottleneck-Trigger und Crash-Trigger …
teilen sich ab jetzt dieselbe Eskalationsstufen-Konfiguration") gelten
unverändert auch für den Failover-Trigger dieses Kapitels — keine
zweite Konfigurationsebene einführen.

### 7.4 Phasenplan

- **Teil 1 — Prozess-Auto-Restart (unabhängig von allem anderen in
  diesem Dokument, sofort startbar):** `restartPolicy` im Launcher,
  `instance.restarted`-Event, generalisierte Wiederverkabelung nach
  Neustart, Crash-Loop-Bremse (harte Obergrenze). Sichtbarkeit im K1-
  Hosts-/Workflows-Panel (Restart-Zähler analog `supervisor.js:412`).
  Verifikation: `kill -9` eines Workflow-Rollen-Prozesses → Neustart
  innerhalb der Backoff-Zeit, IS-05-Verbindung automatisch wieder
  hergestellt, UI zeigt den Restart-Zähler hoch.
- **Teil 2 — Degradation-Leitlinie verankern:** Prüfen/Ergänzen in
  `docs/NODE-TUTORIAL.md`, kein Code.
- **Teil 3 — ST 2022-7 Dual-Path:** als neue, pro Workflow-Rolle
  opt-in konfigurierbare Fähigkeit in `omp-mediaio::st2110` (D4-Basis).
  Kleinster Schritt mit „echtem" Broadcast-Redundanz-Anspruch (0 Frames
  Verlust auf dem Netzpfad).
- **Teil 4 — Hot-Standby (§6.3 Stufe 4), sequenziert nach D6 Teil 3:**
  Workflow-Rollenfeld `standby`, Claim einer zweiten Instanz über die
  dann existierende Placement-Engine, Command-Mirroring **nicht**
  vorausgesetzt (break-before-make wie in §6.3 spezifiziert — die
  „warm, unabonniert"-Zwischenstufe aus dem Memory-Update 2026-07-12
  ist hier der günstigste konkrete Startpunkt: Standby-Prozess läuft,
  aber ohne aktiven MXL-Reader/Render-Load, bis Übernahme).
- **Teil 5 — Orchestrator Active-Passive (§19):** nur bei echtem
  24/7-Bedarf, wie in §19 selbst bereits terminiert — kein neuer
  Designschritt, reine Umsetzung des bestehenden Konzepts.
- **Teil 6 (aspirational, ausdrücklich nicht Teil dieses Plans):**
  Genlock-Äquivalenz/Seamless-Switch (§20.1 Option b) — bleibt an die
  offene (a)/(b)/(c)-Entscheidung aus dem Projekt-Memory gebunden
  (7.5 Punkt 1); die dort bereits empfohlene Fundament-Reihenfolge
  (Grain-Index-Kommandos → sichtbarer Cut → PTP → Command-Mirroring →
  Determinismus-Härtung) bleibt unverändert gültig, falls der
  Projektinhaber sich dafür entscheidet.

### 7.5 Offene Fragen

1. **Die (a)/(b)/(c)-Entscheidung aus dem Projekt-Memory ist weiterhin
   offen** (Empfehlung dort: (c) als pragmatischer Standardweg, §21.3).
   Wichtig für die Priorisierung hier: **Teil 1–3 dieses Kapitels sind
   unter jeder der drei Optionen sinnvoll** — sie sind keine
   Vorentscheidung für (b), sondern die ohnehin fällige Grundlage.
   Muss die (a)/(b)/(c)-Frage vor Teil 1 geklärt werden, oder kann
   Teil 1 unabhängig davon sofort starten (Empfehlung: sofort starten)?
2. Crash-Loop-Bremse: nach wie vielen Restarts innerhalb welchen
   Zeitfensters soll der Launcher aufgeben und eskalieren statt weiter
   automatisch neu zu starten (PIPELINE CONTROLLER retryt unbegrenzt —
   für einen 24/7-Sendekontext ist das vermutlich nicht das gewünschte
   Verhalten)?
3. Soll ST 2022-7 (Teil 3) als generisches, pro Workflow-Rolle
   konfigurierbares Merkmal modelliert werden (§21.1-Prinzip „keine
   globale Plattform-Einstellung") — Bestätigung, keine neue Frage.
4. Reihenfolge-Präferenz zwischen K7-Teil-4 (Hot-Standby) und D6 Teil 3
   (Placement-Engine) selbst: soll die Placement-Engine jetzt gezielt
   priorisiert werden, **weil** K7 daran hängt, oder bleibt sie
   unabhängig eingeplant und K7-Teil-4 wartet einfach, bis sie an der
   Reihe ist?

---

## 8. Elgato Stream Deck ohne Hersteller-Treiber (Hardware-Bedienoberfläche)

> Nachforderung des Projektinhabers: Stream-Deck-Integration ohne
> Elgato-Software-Stack (direktes USB-HID), „das gibt es schon im
> PIPELINE-CONTROLLER-Projekt und funktioniert" — als Bedienoberfläche
> „zum Beispiel für [Bild-/Video-]mischer".

### 8.1 Ist-Zustand in OMP

**Nichts vorhanden.** Kein Hardware-Bedienoberflächen-Konzept in
`ARCHITECTURE.md` (per Volltextsuche verifiziert — weder „Stream Deck"
noch „HID" noch „Bedienpult"/„Control Surface" tauchen dort auf). Der
einzige verwandte, bereits entschiedene Punkt ist §9 („Marktkompatibilität"):
für Fremdgeräte ohne IS-12/14 braucht es „pragmatisch Adapter-Nodes
(proprietäre Vendor-API → unser IS-12/14-Modell)" — und ein bereits
recherchierter, dann aus `ARCHITECTURE.md` wieder entfernter Befund
(`docs/decisions.md` 2026-07-11, „Architektur-Review: acht
Nutzerfragen", Punkt 7; die Vendor-Referenz selbst wurde später auf
Nutzerwunsch aus `ARCHITECTURE.md` entfernt, §20.7): die **Engine-seitige**
Steuerebene eines proprietären Hersteller-Bedienpults ist typischerweise
geschlossenes Protokoll — aber „die IS-12/14-Methoden des Videomixers
bleiben generisch genug, dass jeder künftige Adapter-Node sie wie ein
UI-Bundle-Klick aufrufen kann". Genau dieser Befund ist der Grund, warum
ein Stream Deck der **einfache** Fall dieses Problems ist: es ist kein
Broadcast-Panel mit eigenem proprietärem Steuerprotokoll, sondern ein
generisches USB-HID-Gerät ohne jede Broadcast-Logik — das „Protokoll"
sind rohe HID-Reports, vollständig client-seitig programmierbar, keine
Herstellerfreigabe nötig.

### 8.2 Referenz PIPELINE CONTROLLER (`streamdeck.js`, 1150 Zeilen — vollständig gelesen)

Komplett browserseitige Implementierung, **kein natives Hilfsprogramm,
kein Elgato-Treiber** — im Gegenteil, die offizielle Elgato-Software muss
laut Kommentar (`streamdeck.js:5–6`) geschlossen sein, weil sie das
HID-Gerät exklusiv hält:

- **Verbindung:** `navigator.hid.requestDevice({filters:
  [{vendorId: 0x0fd9}]})` (WebHID-API, Chrome/Edge ≥ 89 Desktop —
  Firefox/Safari nicht unterstützt, HANDBUCH.html:2473); Auto-Reconnect
  über `navigator.hid`s `connect`/`disconnect`-Events beim Wieder-
  Einstecken (`streamdeck.js:136–144`), sofern das Gerät dem Browser
  vorher einmal manuell freigegeben wurde.
- **Geräte-Modell-Tabelle** (`streamdeck.js:29–38`): pro Produkt-ID
  Raster (Spalten×Zeilen), Bildgröße, Bildformat (JPEG bei MK.2/XL/
  Plus/Neo, rohes BMP bei Mini/MK.1), Protokoll-Variante
  (`mk2`/`mini`/`mk1`), Spiegelung/Rotation/Flip-Eigenheiten pro Modell
  — reines Hardware-Faktenwissen, direkt als Daten übernehmbar.
- **Linux-Berechtigung:** braucht eine udev-Regel für Nicht-Root-
  HID-Zugriff (`HANDBUCH.html:2481–2489`:
  `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", MODE="0660",
  GROUP="plugdev"` + entsprechende `usb`-Zeile), Nutzer in Gruppe
  `plugdev`, Session-Neustart nötig — Standard-Linux-USB-Wissen, keine
  App-eigene Erfindung.
- **Seitenmodell** (`SD.registerPage({id, name, icon, color, condition,
  getLayout(ctx)})`, `streamdeck.js:63–66`): jede Seite liefert aus
  einer Kontext-Funktion `{cols, contentRows, sub, nav, nextSub,
  prevSub}` ein Zeilen-Array von Button-Definitionen
  (`{icon, label, sublabel, bg, textColor, ind, action}`). Raster in
  drei Zonen: oberste Reihe = Seiten-Navigation (`_menuRow`), mittlere
  Reihen = Seiteninhalt, unterste Reihe = **fest immer sichtbare**
  Playlist-Transport-Zeile (Prev/Play-Stop/Next/Next-Live,
  `_playlistRow`, `streamdeck.js:284–345`) — bei OMP wird diese feste
  Zeile zum natürlichen Andockpunkt für K6 (Playout-Automation).
- **Render-Engine:** debounced (100 ms, `_schedule`,
  `streamdeck.js:216–222`), pro Taste ein Fingerprint-Vergleich
  (`_fp`, Zeile 887–889) verhindert redundantes Neusenden unveränderter
  Tasten-Bilder; Tasten-Bild wird per `<canvas>` gerendert (Hintergrund-
  farbe, optionales Hintergrundbild mit Vignette, Indikator-Balken oben
  5 px nach Zustand `onair`/`cued`/`live`/`play` eingefärbt, Icon/
  Label/Sublabel-Text) und modellabhängig als JPEG oder rohes BMP
  (inkl. 90°-Rotation+Flip fürs Mini) encodiert.
- **HID-Bildübertragung:** modellspezifisches Chunking über
  `sendReport(0x02, …)` in ~1016–1023-Byte-Paketen mit
  Header (Tasten-Index, Segment-Nummer, Länge, Letztes-Segment-Flag) —
  `_sendImgMK2`/`_sendImgMini` (Zeilen 1042–1092); Helligkeit über
  `sendFeatureReport` (Zeilen 1108–1122).
- **Eingabe:** ein `inputreport`-Listener liest pro Poll das
  Tastenzustands-Byte-Array und ruft die registrierte `action()` der
  gedrückten physischen Taste auf (`_onInput`, Zeilen 148–157).
- **Plugin-Erweiterbarkeit:** jedes Plugin/Skript kann per
  `StreamDeck.registerPage(...)` eine eigene Seite anmelden
  (`HANDBUCH.html:2558 ff.`) — dieselbe Erweiterbarkeits-Idee wie OMPs
  eigenes Node-Contract-Prinzip, nur auf UI-Ebene.
- **Kein Server-Bezug:** die gesamte Datei ruft ausschließlich bereits
  im Browser vorhandenen Zustand/Funktionen auf (`window.S`,
  `window.api(...)`) — es gibt keinen eigenen Backend-Endpunkt für den
  Stream Deck. Direkte Blaupause für den OMP-Ansatz unten.

### 8.3 Ziel-Design für OMP

**Wo lebt das?** Ausschließlich im Browser, exakt wie im Vorbild — kein
neuer nativer Helper-Prozess, keine neue System-Dependency (WebHID ist
eine Browser-API, keine npm-Bibliothek nötig, passt ohne Reibung zur
No-Framework/No-npm-Linie). Neues Modul `ui/shell/streamdeck.ts` +
`ui/shell/streamdeck-transport.ts` (Modell-Tabelle + HID-Low-Level,
direkter Muster-Port von `streamdeck.js`s Transport-Schicht).

**Wo im Node-Contract-/NMOS-Modell?** Ein Stream Deck ist **kein**
Media-Node — er registriert sich nicht bei NMOS, produziert/konsumiert
keine Flows, ist reines UI-Zubehör. Er gehört vollständig in die Shell,
nicht in einen neuen Service/Node-Typ. Genau wie im Vorbild ruft er
**direkt die bereits bestehende generische Node-Proxy-API** auf
(`/api/v1/nodes/<id>/methods/<name>`, `/api/v1/nodes/<id>/params/<name>`
— dieselben Endpunkte, die B6s Parameter-Panel und jedes Node-UI-Bundle
längst benutzen). Kein neuer Orchestrator-Endpunkt, kein neuer Prozess
— das physische Stream Deck wird schlicht ein **dritter Aufrufer**
derselben generischen Proxy-Fläche, neben dem Parameter-Panel und dem
jeweiligen Node-UI-Bundle.

**Seitenmodell — deskriptor-getrieben statt handgeschrieben, wo
möglich:** PIPELINE CONTROLLER schreibt eine Seite pro Subsystem von
Hand (`window.S`, `window._grafikActiveMap`, … — kein generisches
Datenmodell verfügbar). OMP hat mit dem Descriptor (A8/§11.1) bereits
genau die Selbstbeschreibung, die eine **automatische** Fallback-Seite
für jeden beliebigen Node ermöglicht: ein generisches Raster aus den
schreibbaren Parametern/Methoden eines gewählten Nodes (analog B6s
Descriptor→Control-Mapping, nur auf die physischen Tasten statt ein
HTML-Formular projiziert). Für eine wirklich gute **physische** Anordnung
reicht das allein nicht (deshalb tunt PIPELINE CONTROLLER jede Seite von
Hand) — Mittelweg: ein optionales, additives Descriptor-Feld
`uiHints.streamdeck` pro Parameter/Methode (z. B.
`{"row":0,"col":2,"icon":"🔴","indicator":"onair"}`), das ein Node
**optional** mitliefern darf (gleiches additive-Feld-Muster wie
`category`/§13.5, `iconUrl`/§22.4 — kein Node-Contract-Bruch, Nodes ohne
Hinweis fallen auf das naive Auto-Raster zurück, nie ein harter Fehler).
- **K3-Bezug (wörtlich vom Projektinhaber genannt):** die erste
  handgetunte Seite ist der Bildmischer — physische Tasten für die
  PST-Bus-Reihe + CUT + AUTO, exakt dieselben `crosspoint.select/cut/
  autoTrans`-Aufrufe wie K3s Bildschirm-Panel. Zustand (on-air/preset)
  treibt gleichzeitig den Bildschirm-Glow (K1-Tokens) **und** die
  physische Tasten-Hintergrundfarbe — ein Zustand, zwei Renderer.
- Generalisiert unmittelbar auf **K5** (OGraf Take/Takeout/Continue —
  nahezu 1:1-Übertragung von PIPELINE CONTROLLERs eigener
  `ograf`-Seite) und **K6** (Playout Play/Stop/Next/Next-Live — nahezu
  1:1-Übertragung der festen `_playlistRow`).
- **Rendering:** dieselbe Debounce-/Fingerprint-Technik übernommen
  (Muster, nicht Code); Tasten-Hintergrundfarben kommen aus den
  K1-Design-Tokens (`--omp-onair`/`--omp-preset`/`--omp-cue`/…) statt
  wie im Vorbild aus fest verdrahteten Hex-Werten — der Punkt, an dem
  K1 sich für K8 direkt auszahlt.
- **Geräte-Tabelle** wird 1:1 als Fakten-Daten übernommen
  (`ui/shell/streamdeck-models.ts`) — Hardware-Beschreibung, keine
  Anwendungslogik, unproblematisch als Direktübernahme.
- **Mehrbenutzer-Aspekt (neu, im Vorbild nicht relevant):** WebHID-
  Geräte-Zugriff ist exklusiv pro Browser-Tab/-Origin-Session — zwei
  Operator:innen können nicht gleichzeitig von zwei Tabs dasselbe
  physische Gerät steuern. Bewusst nur dokumentiert, nicht „gelöst" —
  passt zur bereits bestehenden §14-Kiosk-Route-Logik („ein Bildschirm
  = eine Bedienposition"): ein Stream Deck = eine Operator-
  Browser-Session.

### 8.4 Phasenplan

- **Teil 0 — Transport-Port:** Modell-Tabelle + Low-Level-HID
  (Öffnen/Reset/Helligkeit/Bild-Senden je Protokollvariante) als
  eigenständiges Modul, reiner Muster-Port, noch ohne OMP-Logik.
  Verifikation: physisches Gerät verbinden, einfarbiges/Testraster
  erscheint.
- **Teil 1 — Generische Fallback-Seite + Seiten-/Render-Rahmen:**
  `registerPage`-Äquivalent, Debounce-/Fingerprint-Render-Loop,
  naives Auto-Raster aus Parametern/Methoden eines gewählten Nodes.
  Verifikation: gegen einen Mock-Node zeigen, Tastendruck löst
  nachweisbar (per `curl` auf die Proxy-API beobachtbar) denselben
  Aufruf aus wie ein Klick im Parameter-Panel.
- **Teil 2 — K3-Seite handgetunt:** PGM/PST/CUT/AUTO, nach K3-Teil-1
  sequenziert.
- **Teil 3 — `uiHints.streamdeck`-Descriptor-Feld + K5-/K6-Seiten**,
  sobald diese Nodes existieren.
- **Teil 4 — K1-Token-Integration + udev-Regel-Doku/-Tooling.**

### 8.5 Offene Fragen

1. Welches Stream-Deck-Modell besitzt/plant der Projektinhaber für die
   Präsentation (bestimmt, welche Protokollvariante zuerst verifiziert
   wird — MK.2 ist im Vorbild selbst als „Empfohlen" markiert,
   `HANDBUCH.html:2504`)?
2. Umfang jetzt: reicht die generische Fallback-Seite (Teil 1) für die
   Präsentation, oder ist die handgetunte K3-Seite (Teil 2) Pflicht?
3. Soll die Linux-udev-Regel automatisiert eingerichtet werden (z. B.
   `make streamdeck-udev`) oder bleibt es wie im Vorbild reine
   Dokumentation?
4. Mehrere physische Stream Decks gleichzeitig (ein Gerät pro
   Bedienposition) — WebHID erlaubt das technisch (mehrere Geräte-
   Freigaben pro Origin), im Vorbild aber nie gebraucht/getestet.
   Jetzt schon mitdenken oder Ein-Geräte-Annahme für v1 akzeptieren?

---

## 9. Multiviewer: extrem niedrig-latenter Web-Stream für Regieplatz-Monitore

> „um Signale später im Regieplatz auf einen Monitor zu bringen nutzt
> Grass Valley AMPP das: Das Multiviewer-Microservice-Videosignal wird
> in einen hochoptimierten, extrem niedrig-latenten Web-Stream (unter
> Verwendung moderner WebRTC- oder SRT/JPEG-XS-Protokolle) verpackt. So
> etwas brauchen wir auch." (Projektinhaber, wörtlich; im Folgenden nach
> `ARCHITECTURE.md` §20.7-Konvention als „vergleichbare
> Cloud-Produktionsplattform" statt beim Herstellernamen referenziert.)

### 9.1 Ist-Zustand in OMP

`nodes/omp-mediaio/src/preview.rs` (220 Zeilen, vollständig gelesen,
seit dem C-Nachtrag 2026-07-12 gemeinsam von `omp-viewer` und
`omp-multiviewer` genutzt) ist die einzige heute existierende
Vorschau-Mechanik: ein `Broadcaster` verteilt JPEG-Frames von **einer**
Encode-Pipeline an beliebig viele HTTP-Clients
(`multipart/x-mixed-replace; boundary=frame`, ein `tiny_http`-Thread pro
Verbindung, `preview.rs:95–135`). Konkrete Parameter, per Code
verifiziert:

- `omp-viewer`: 640×360, **5 fps**, JPEG-Qualität 70
  (`omp-viewer/src/pipeline.rs:29–32`).
- `omp-multiviewer`: Kachel 320×180 pro Quelle, Canvas
  `cols×TILE_WIDTH` × `rows×TILE_HEIGHT`, ebenfalls **5 fps**/Qualität
  70 (`omp-multiviewer/src/pipeline.rs:27–30`).

**Latenz-/Bandbreitencharakter ehrlich eingeordnet:** die Encode-Kosten
sind O(1) (eine Pipeline speist beliebig viele Clients), aber die
Bandbreite ist O(Clients) bei vollem, unkomprimiertem Intra-JPEG pro
Frame (kein Inter-Frame-Delta, keine Bitraten-Regelung außer der festen
`jpegenc quality`). Die **Latenz-Untergrenze** liegt strukturell bei
mindestens einem vollen Bildintervall (bei 5 fps: 200 ms) plus
Encode-/HTTP-Overhead — für die kleine Inline-Vorschau-Kachel im
Flow-Editor (K1, seit dem C-Nachtrag 2026-07-12 automatisch auf jeder
Kachel mit `previewUrl` sichtbar) völlig ausreichend, für einen
„Signal auf einen echten Regieplatz-Monitor bringen"-Anspruch spürbar zu
langsam und zu grobkörnig.

### 9.2 Referenz PIPELINE CONTROLLER

**Ehrlicher Befund, anders als bei K2/K5/K6:** PIPELINE CONTROLLER hat
hier **kein** fortgeschritteneres Vorbild zu bieten — im Gegenteil, sein
eigenes `lib/PreviewPipeline.js` (`videoscale 640×360 ! videorate 5/1 !
jpegenc quality=70 ! appsink`, ausgeliefert über `server.js`s
`/preview`-Route mit `multipart/x-mixed-replace`) ist exakt das Muster,
das OMPs `preview.rs` bereits **von dort übernommen hat** (C6-
Entscheidung, `docs/decisions.md` 2026-07-09/-10 zitiert
`PreviewPipeline.js` ausdrücklich als Vorlage). PIPELINE CONTROLLER hat
zwar SRT im Programm — aber ausschließlich als zusätzlicher
**Broadcast-Ausgang** (`lib/OutputEngine.js:124`, README „Additional
outputs (RTMP/SRT/UDP/file)"), nicht als browserfähiger Monitor-Stream
(`MasterPipeline.js:53` liest SRT nur als **Eingang** über
`srtsrc ! decodebin`, für Live-Quellen, nicht für die Ausgabe an einen
Browser). Weder WebRTC noch JPEG-XS kommen im gesamten PIPELINE-
CONTROLLER-Repository vor (per Volltextsuche verifiziert). Diese
Anforderung ist damit für **beide** Projekte Neuland — motiviert durch
den Vergleich mit kommerziellen Cloud-Produktionsplattformen, nicht
durch übertragbares PIPELINE-CONTROLLER-Wissen.

### 9.3 Zwei benannte Pfade, ehrlich bewertet

**Pfad A — WebRTC:** GStreamer-seitig ausgereift (`webrtcbin`,
gst-plugins-bad, plus die `gstreamer-webrtc`-Rust-Bindings im
gstreamer-rs-Ökosystem — anfügbar nach demselben Muster wie die
`mxl-sys`/`mxl`-Pfadabhängigkeit, C4). Browser-seitig nativ
(`RTCPeerConnection`, `<video>` + `srcObject`, keine Bibliothek nötig).
**Der ehrliche Haken:** WebRTC braucht zwingend einen
Signalisierungskanal (SDP-Offer/-Answer + ICE-Candidate-Austausch) —
**den gibt es im Projekt heute nirgends** (SSE, A6/§4.5a, ist
Server→Client-only, für WebRTC-Signalisierung ungeeignet). Das wäre
echte, neue Infrastruktur-Klasse: entweder ein WebSocket-Endpunkt am
Orchestrator oder ein eigener kleiner Signalisierungs-Dienst. Eine
spürbare Erleichterung gegenüber dem öffentlichen Internet-Fall: OMPs
Deployment-Modell ist internes, mTLS-abgesichertes Netz ohne öffentliche
Legs (§4.6) — ICE kann sich in diesem Rahmen auf reine Host-Candidates
beschränken, **kein STUN/TURN nötig**, was den sonst größten
WebRTC-Betriebsaufwand entfallen lässt. Realistisches Latenzziel im LAN:
sub-200 ms Glass-to-Glass.

**Pfad B — SRT (+ optional JPEG-XS):** SRT selbst ist **nicht**
browserseitig abspielbar (kein `<video>`/MSE-Pfad versteht rohes
SRT/MPEG-TS-über-SRT nativ) — „SRT bis in den Browser" braucht immer
einen Zwischenschritt (Server-seitiges Remuxing SRT→fMP4-Fragmente über
WebSocket/Chunked-HTTP in Media Source Extensions, selbst neue
Infrastruktur). **Ehrlichere, billigere Lesart des Pfads:** SRT für den
tatsächlichen **Studio-Monitor** einsetzen, nicht für einen Browser-Tab
— ein dediziertes Decoder-Gerät/eine kleine native Player-Instanz
(`gst-launch-1.0 srtsrc ! … ! autovideosink` oder ein schlanker
Kiosk-Player) direkt am Monitor, kein Chrome-Tab dazwischen. Das
entspricht sogar eher der Praxis realer Sendezentren (Monitorwände
laufen an dedizierter Decoder-Hardware/-Software, nicht im
Browser-Tab) und **braucht nahezu keinen neuen Code** — die
Multiviewer-Kachel-Komposition ist bereits ein normaler MXL-Flow, den
`omp-srt-gateway` (D4) schon heute unverändert nach SRT bridgen kann
(zu verifizieren: reicht ein zusätzlicher MXL-Sender am Multiviewer-
Compositor-Ausgang, damit D4s Gateway ihn ohne jede Multiviewer-
Code-Änderung aufgreift?). **JPEG-XS** wäre auf diesem Pfad eine
Bandbreiten-/Qualitäts-Verbesserung gegenüber Roh-/H.264-Video —
aber GStreamer-Elemente dafür (`svtjpegxs`/vergleichbare Plugins) sind
Stand dieser Recherche neu und in Standard-Debian/Ubuntu-Paketquellen
mit hoher Wahrscheinlichkeit **nicht** vorhanden (ehrlich als
Vermutung markiert, nicht verifiziert — vor jeder Festlegung mit
`gst-inspect-1.0` auf dem Zielsystem prüfen). Hohes Risiko für einen
harten v1-Abhängigkeits-Fehlschlag, deshalb als optionale
Spät-Ausbaustufe eingeplant, nicht als Fundament.

**Pfad C (nicht vom Projektinhaber genannt, aber die ehrliche
„kleinste sicher schiffbare Erhöhung" nach Haus-Stil):** MJPEGs reale
Schwäche ist **Bandbreite**, nicht zwingend **Latenz** — bei 5 fps liegt
die Latenz-Untergrenze bei 200 ms strukturell allein durchs Bildintervall,
nicht durch das Protokoll selbst. Eine Anhebung auf z. B. 15–25 fps für
den Multiviewer-Ausgang (Flow-Editor-Kachel-Vorschauen bleiben bei 5 fps
— dort zählt „passiert gerade etwas", nicht exakte Bildrate) plus
expliziter Nagle-Deaktivierung senkt die MJPEG-Latenz strukturell auf
„ein Bildintervall + Encode + HTTP" — bei 25 fps klar unter 100 ms
theoretisch, in der Praxis eher 100–200 ms je nach Encode-/Netz-Overhead.
Für **eine Hand voll** gleichzeitiger Monitor-Betrachter auf LAN ist das
unter Umständen bereits „extrem niedrig-latent genug" ohne jede neue
Protokoll-Infrastruktur — der eigentliche Grund, warum Cloud-Plattformen
zu WebRTC/JPEG-XS greifen, ist **Skalierung** (viele gleichzeitige
Betrachter, Standard-Hardware-Decode), nicht dass MJPEG bei höherer
Framerate grundsätzlich hoch-latent wäre.

### 9.4 Ziel-Design

**Modul-Platzierung:** die gewählten neuen Transporte landen als
**zusätzliche, opt-in** Fähigkeiten in `omp-mediaio::preview` (neue
Funktionen `build_webrtc_branch`/`build_srt_branch`, gleiche Signatur-
Idee wie das bestehende `build_mjpeg_branch`), **nicht** als Ersatz für
MJPEG — die kleine Inline-Kachel-Vorschau im Flow-Editor (K1) profitiert
gerade von MJPEGs Signalisierungsfreiheit (ein `<img src>` reicht,
keine PeerConnection pro Graph-Kachel). Descriptor-seitig additiv:
`previewTransports: ["mjpeg", "srt", "webrtc"]` statt nur der
heutigen einzelnen `previewUrl` (Rückwärtskompatibel: `previewUrl`
bleibt für MJPEG bestehen).

**Neue Vollbild-„Monitor"-Ansicht:** eine dedizierte Kiosk-Route
`/monitor/<nodeId>` (gleiches Muster wie §14s bereits bestehende
`/console/<workflowId>/<nodeRoleId>`-Route) statt eines neuen
Navigationskonzepts — auf einem echten Regieplatz-Monitor/eigenen
Browser-Fenster geöffnet, zeigt genau eine Node-Vorschau vollflächig
über den gewählten niedrig-latenten Transport. Unterscheidet sich damit
klar von der kleinen Inline-Flow-Editor-Kachel (bleibt MJPEG,
Übersichts-Zweck) — zwei verschiedene Zwecke, zwei verschiedene
Transport-Defaults, eine gemeinsame Datenquelle (`omp-mediaio::preview`).

**Generalisierung über den Multiviewer hinaus:** derselbe Ausbau kommt
`omp-viewer` (K1-Vorschau), einem künftigen `omp-player`-Preview (K2)
und `omp-ograf`s Grafiker-Vorschau (K5) kostenlos zugute, sobald er in
`omp-mediaio::preview` liegt — exakt dieselbe Wiederverwendungs-Logik,
die schon MJPEG von `omp-viewer` zu `omp-multiviewer` getragen hat
(C-Nachtrag 2026-07-12).

### 9.5 Phasenplan

- **Teil 0 — MJPEG-Aufwertung + Monitor-Route (fast keine neue
  Infrastruktur):** `PREVIEW_FPS` für den Multiviewer-Ausgang anheben
  (Flow-Editor-Kacheln unverändert bei 5 fps), `/monitor/<nodeId>`-
  Kiosk-Route auf Basis des bestehenden (aufgewerteten) MJPEG-Streams.
  Verifikation: subjektiver Latenzvergleich (On-Screen-Timecode der
  Quelle gegen Monitor-Anzeige) + Bandbreitenmessung bei neuer fps.
- **Teil 1 — SRT/nativer Monitor-Pfad (günstigste „echte" Stufe,
  nutzt D4 vollständig wieder):** prüfen, ob ein zusätzlicher
  MXL-Sender am Multiviewer-Compositor-Ausgang ausreicht, damit
  `omp-srt-gateway` (D4, unverändert) ihn bridgen kann; dokumentierter
  nativer Player als empfohlener Monitor-Client statt Browser-Tab.
- **Teil 2 — WebRTC (größter Infrastruktur-Zugang des ganzen
  Dokuments):** eigener Spike zuerst (Signalisierungs-Weg entscheiden,
  `webrtcbin`-Machbarkeit auf dem Zielsystem prüfen, Go/No-Go —
  gleiche Disziplin wie K5s Render-Spike), danach
  `build_webrtc_branch` in `omp-mediaio::preview`, `<video>`-Wiedergabe
  in der neuen Monitor-Route, ICE auf Host-Candidates beschränkt (kein
  STUN/TURN im internen mTLS-Netz).
- **Teil 3 (aspirational, ausdrücklich risikobehaftet):** JPEG-XS-
  Elementverfügbarkeit prüfen (`gst-inspect-1.0` auf dem Zielsystem,
  vor jeder weiteren Planung) als Bandbreiten-/Qualitäts-Ausbaustufe
  des SRT-Pfads — nicht blockierend für Teil 1/2.
- **Teil 4 — Generalisierung:** gewählte(r) Transport(e) auf
  `omp-viewer`/K2-Player-Preview/K5-OGraf-Preview als Opt-in ausrollen.

### 9.6 Offene Fragen

1. **Ziel ist ein Browser-Tab oder ein dedizierter Monitor?** Das
   entscheidet, ob Pfad A (WebRTC) für den „Monitor im Regieplatz"-
   Anwendungsfall überhaupt nötig ist, oder ob Pfad B (SRT + nativer
   Player) genau das bereits liefert, was gemeint ist — WebRTC wäre
   dann eher für **entfernte/Laptop-Browser-Betrachtung** relevant, ein
   anderer Anwendungsfall als „Signal auf einen Regieplatz-Monitor".
2. Wie viele gleichzeitige Monitor-Betrachter muss die Präsentation
   tragen (ein Hauptmonitor vs. mehrere Operator-Tabs) — bestimmt, ob
   sich WebRTCs Fan-out-Vorteil (SFU) überhaupt lohnt oder der
   einfachere SRT-/aufgewertete-MJPEG-Pfad für den Demo-Zweck reicht.
3. JPEG-XS jetzt einplanen (Teil 3) oder komplett aus dem v1-Scope
   streichen, bis GStreamer-Paketierung ausgereift ist (sicherer
   Default: streichen, später neu bewerten)?
4. Bedeutet „extrem niedrig-latent" für die Präsentation konkret
   sub-100 ms (WebRTC-Territorium) oder reicht „spürbar besser als
   heutige 5-fps-MJPEG, z. B. deutlich unter 300 ms" (bereits über
   Teil 0/1 allein erreichbar)?

---

## 10. Konsolidierte Entscheidungsliste für den Projektinhaber

Vor Implementierungsbeginn zu entscheiden (Kurzform, Details in den
Kapiteln):

1. **Reihenfolge/Priorität** aller neun Kapitel bestätigen oder ändern
   (Vorschlag in Kapitel 0; K7-Teil-1/K9-Teil-0 sind unabhängig
   sofort startbar).
2. **K1:** Studio-Dark-only zuerst? Sprache DE/EN? Panels vs.
   Vollansichten? (1.5)
3. **K2:** MXF-Essenz-/Codec-Umfang (bestimmt `gst-libav`-Pflicht);
   Medienverzeichnis-Konvention. (2.5)
4. **K3:** Hot-Cut auf PGM-Reihe? (3.5; Stream-Deck-Frage jetzt in K8)
5. **K4:** Limiter-Qualität (`audiodynamic` vs. LV2-Dependency);
   Solo/PFL ja/nein; Node-Stream-Proxy im Orchestrator. (4.5)
6. **K5:** Demo-Scope-Entscheidung aus §11.2 (offen seit 2026-07-11!);
   Render-Variante nach Spike; „Editor"-Bedeutung bestätigen;
   Template-Lizenz. (5.5)
7. **K6:** Playlist-Persistenz-Ort; Priorität der ausgelagerten
   Subsysteme (Record/SCTE-35/…); Scheduler-Abgrenzung zu D7 Teil 2.
   (6.6)
8. **K7 (HA/Redundanz):** (a)/(b)/(c)-Genlock-Frage aus dem Memory
   weiterhin offen, blockiert aber Teil 1–3 nicht; Crash-Loop-Bremse;
   Priorisierung von D6 Teil 3 (Placement-Engine) wegen K7-Teil-4. (7.5)
9. **K8 (Stream Deck):** vorhandenes Modell; Umfang jetzt (generisch
   vs. handgetunt); udev-Automatisierung; Mehrgeräte-Fall. (8.5)
10. **K9 (Multiviewer-Streaming):** Browser-Tab vs. dedizierter Monitor
    (entscheidet WebRTC-Notwendigkeit); Betrachterzahl; JPEG-XS jetzt
    oder streichen; konkretes Latenzziel. (9.6)

Nach diesen Entscheidungen sollten die gewählten „Teil 1"-Scheiben als
reguläre Schritte in `UMSETZUNG.md` aufgenommen werden (eigene Sitzung,
eigene Verifikation, Status-Checkliste) — dieses Dokument bleibt die
Design-Referenz dahinter und wird bei Scope-Änderungen fortgeschrieben.
