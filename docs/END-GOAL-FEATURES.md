# END-GOAL-FEATURES — Design-Dokument für die Endziel-Anforderungen

Stand: 2026-07-15 (Erstfassung 2026-07-14, erweitert um K7–K9 in
derselben Sitzungsfolge, nach Review durch den Projektinhaber; Kapitel
10 am selben Tag vollständig entschieden, s. dort; **am 2026-07-15 um
die Kapitel 11–14 erweitert** — UI-/Betriebs-Nachforderung des
Projektinhabers: Settings-/User-/Rollenverwaltung, Workflow als
Regieplatz, Multi-Host-Darstellung im Flow-Editor, Ressourcen-Historie).
Status: **Alle zehn Entscheidungen aus Kapitel 10 getroffen. Noch nicht
Teil der `UMSETZUNG.md`-Schrittliste** — die gewählten „Teil 1"-Scheiben
werden als eigene Schritte dort aufgenommen, sobald die Umsetzung
beginnt. Die offenen Fragen der neuen Kapitel (11.5/12.5/13.5/14.5)
sind noch **nicht** entschieden.

Dieses Dokument ist das Ergebnis mehrerer Recherche-Sitzungen über beide
Codebasen (OMP und `/home/infantilo/PIPELINE CONTROLLER`) zu den
Endziel-Anforderungen des Projektinhabers (Original-Wortlaut jeweils am
Kapitelanfang, Kapitel 1–6 aus der ersten Runde, Kapitel 7–9 aus einer
Review-Nachforderung, Kapitel 11–14 aus der UI-/Betriebs-Nachforderung
vom 2026-07-15 — „im ui fehlt noch einiges … praxisnahe denken"). Es ist bewusst **kein** Phasenplan-Eintrag — die
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

**Erweiterung 2026-07-15 — Einordnung der Kapitel 11–14
(Control-Plane-Strang).** K11–K14 sind ein zweiter, zum
K1–K9-Medien-Strang weitgehend paralleler Strang: sie leben fast
vollständig in Orchestrator + Shell (Go/TS), nicht in den
Rust-Nodes/Pipelines — die beiden Stränge teilen sich außer der Shell
keine Dateien und blockieren einander nicht. Abhängigkeiten:

```
K1-Teil-1 App-Bar (erledigt) ────────► K11 Teil 1 (Admin-Tab hängt an der Tab-Struktur)
                                  └──► K13 (Host-Zonen bauen im bestehenden Flow-Canvas)

D7 Teil 1 Workflow-Objekt (erledigt) ─► K12 (jeder Teil erweitert dieses Objekt)
D7 Teil 2 Zeitsteuerung + Ressourcen- ─► K12 ab Teil 3 („Start nach Vorprüfung" kommt
Vorprüfung (offen, UMSETZUNG.md §7)      aus D7 Teil 2 und wird in K12 nicht dupliziert)
                                    ◄──── K14 Teil 3 (Typ-Verbrauchsprofile machen die
                                          Vorprüfung erst treffsicher — Momentwert reicht
                                          als erste D7-Teil-2-Stufe, Profile verfeinern)

K11 Teil 1 (Verwaltungs-UI) ─────────► K12 Teil 4 (Workflow-Scope erweitert genau das
                                        Bindungsmodell, das K11s UI verwaltet)
K12 Teil 4 (Workflow-Scope, §12 P. 2) ► K12 Teil 5 (Operator-Einstieg pro Workflow)

K14 Teil 1 (Host-Historie) ──────────► K13 Zonen-Kopf-Sparkline (optionale Aufwertung)
                            └────────► §16 Kapazitäts-Kalender (spätere Stufe)
```

Empfohlene Groblinie für den neuen Strang: **K12-Teil-1 zuerst**
(port-genaues Verbindungs-Template — ohne das ist der wörtlich
gewünschte 3-Kameras-Regieplatz gar nicht verkabelbar, siehe 12.1),
**K14-Teil-1**, **K13-Teil-1** und **K11-Teil-1** sind unabhängig
voneinander und jederzeit einschiebbar (jeweils eine Sitzung, hoher
Präsentations-Hebel). Danach **D7 Teil 2 als regulärer
UMSETZUNG.md-Schritt** (empfohlen vor K12-Teil-3, damit „Start" ab dann
durchgängig die Vorprüfung hat), dann K12-Teil-2/3, dann
K12-Teil-4/5 nach K11-Teil-1. Kein Konflikt mit der
K1→K2→K3/K4→K5→K6-Reihenfolge aus Kapitel 10 Punkt 1 — beide Stränge
können sitzungsweise verzahnt werden.

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

### 1.6 Nachtrag (2026-07-17) — Property-Panel ist die Operator-Konsole, nur zu schmal; Ein-Klick-Wechsel Admin→Operator-Ansicht fehlt

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 2): „im UI fehlen generell
> immer noch die ganzen Settings [siehe 1.1–1.5, unverändert offen].
> Für den Admin (Flow-Editor-Rechte) muss es die Möglichkeit geben, mit
> einem Button in exakt die Operator-Ansicht zu wechseln — derzeit
> sieht er nur das schmale Property-Panel, in dem z. B. der Bildmischer
> die Buttons vertikal statt horizontal anordnet."

**Ist-Zustand, per Code-Lesen verifiziert (nicht angenommen) — die
Befürchtung „zwei unterschiedliche/inkonsistente UI-Pfade" trifft
nicht zu:**

- `ui/graph/flow-canvas.ts`s `#openParameterPanel()` und
  `ui/shell/console-view.ts`s `#activate()` rufen **dieselbe**
  `mountUIBundle()`-Funktion (`ui/shell/ui-bundle.ts:22`) mit demselben
  Node — der Bildmischer lädt in beiden Fällen exakt dasselbe
  `/ui/bundle.js`. `console-view.ts` kommentiert das selbst treffend:
  „Technisch dieselbe Bundle-Lade-Logik wie das Engineering-Panel, nur
  vollflächig statt im Parameter-Panel."
- Der einzige Unterschied ist der **Container**: das Parameter-Panel in
  `flow-canvas.ts` hat eine fest verdrahtete Breite von **280px**
  (`data-role="parameter-panel"`), während `console-view.ts`s Panel
  `flex:1` in einem `100%×100%`-Host ist. Bei 280px bricht das
  Bildmischer-Bundle seine an sich horizontale Crosspoint-Button-Reihe
  um — kein Bug im Bundle, ein zu enger Container.
- `ui/graph/controls.ts` (generischer Deskriptor→Steuerelement-
  Fallback) ist hier **nicht** beteiligt — der Bildmischer hat ein
  eigenes UI-Bundle, erreicht diesen Fallback-Pfad also nie.
- Die Konsolen-Route existiert bereits und ist direkt verlinkbar:
  `ui/shell/shell.ts`s `KIOSK_ROUTE`
  (`/console/<workflowId>/<nodeRoleId>`) mountet eine vollflächige
  `<omp-console-view>`. `workflowId` ist heute immer der Stub
  `"default"` (`orchestrator/internal/consoles/resolve.go`,
  `StubWorkflowID` — echte Workflow-IDs erst mit D7/§6.2 durchgängig),
  `nodeRoleId` ist die stabile Instanz-ID aus dem Launcher (oder die
  rohe Node-ID, falls nicht über den Launcher gestartet).

**Ziel-Design (klein, zwei unabhängige Teile):**

a) **Property-Panel-Breite:** `flow-canvas.ts`s Panel-Container von
   fest 280px auf eine größere, idealerweise **resizable** Breite
   umstellen (Pointer-Drag am linken Rand, Breite in
   `localStorage`/später `/api/v1/me/preferences`, §1.3c) — löst das
   Symptom für jedes aktuelle und künftige Node-Bundle generisch,
   nicht nur für den Bildmischer.
b) **„Als Operator ansehen"-Button** im Parameter-Panel-Header (neben
   dem bestehenden Schließen-Button): öffnet
   `/console/default/<nodeRoleId>` in einem neuen Tab. Voraussetzung:
   `flow-canvas.ts`s Graph-Knoten müssen die Instanz-ID mitführen, die
   heute (Stand dieser Recherche) nicht sicher neben der reinen
   `nodeId` im `/api/v1/graph`-Response mitgeführt wird — vor der
   Umsetzung kurz prüfen, ob `nodeId` bereits die launcher-stabile ID
   ist oder ob sie explizit mitgegeben werden muss.

**Priorität:** hoch — klein, klar umrissen, kein Design-Rätsel mehr
(beide Teile durch Code-Lesen vollständig geklärt), und direkt
UI-Qualitäts-wirksam (Nutzer-Vorgabe „achte auf ein schönes UI").
Empfehlung: **noch vor** den größeren §1.4-Teilen 2–4 einschieben, weil
unabhängig von diesen und sofort umsetzbar.

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

1. **Codec-Umfang — geklärt (2026-07-14, reine Recherche, kein Code):**
   `PIPELINE CONTROLLER/lib/PlayerPipeline.js` behandelt **MXF mit
   MPEG-2-Video (`mpeg2video`)** als den tatsächlich erprobten Fall —
   nicht nur beiläufig erwähnt, sondern codec-spezifisch verzweigt
   (`PlayerPipeline.js:244–245`: `if (!/mpeg2video/.test(codec)) return
   null;`, Kontext: NVDEC-Hardware-Decode-Pfad, Zeile 133/139) und im
   README (`README.md` „⚠️ Note on Codecs") als lizenzrelevant explizit
   genannt (H.264/MPEG-2/AC-3/DTS aus `gst-plugins-bad`/`-ugly`). Für
   K2 Teil 2 (MXF) heißt das: **MPEG-2 ist die Pflicht-Essenz**, AVC-
   Intra/DNxHD sind nicht durch einen erprobten Referenzpfad gedeckt und
   bleiben „falls später gebraucht". `gstreamer1.0-libav`/`-ugly` als
   Pflicht-Systemdependency in `deploy/` dokumentieren, inkl. desselben
   Lizenz-Hinweises wie im PIPELINE-CONTROLLER-README. (Für K2 Teil 1
   selbst ohne Bedeutung — das ist MP4/H.264 testdatei-generiert, ohne
   MXF-Sonderweg.)
2. ~~Medienverzeichnis-Konvention~~ — entschieden (Kapitel 10, Punkt 3):
   pro Instanz konfigurierbar.
3. ~~Soll `omp-player` bei EOS selbst weiterschalten?~~ — entschieden
   (Kapitel 10, Punkt 3): bleibt K6-Scope.

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

### 4.6 Nachtrag (2026-07-17) — vier konkrete Lücken, per Code-Lesen bestätigt

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 4): EQ braucht Gain/Güte/
> Frequenz(/Typ), Compressor/Limiter fehlen (auch Master), Aux-Wege
> fehlen (z. B. N-1 für den Sprecher), Audio-Follow-Video braucht einen
> definierbaren An/Aus-Pegel, Mixer-Settings müssen speicher-/ladbar
> sein (Presets).

Deckt sich zum größten Teil mit dem bereits bestehenden Plan oben
(Teil 2 „Dynamik", Teil 3 „Busse/Aux/Groups" — beide **noch nicht
umgesetzt**, nur K3/K4-Teil-1 „Teil 1" ist fertig). Vier Punkte gehen
über den bisherigen Text hinaus:

1. **EQ-Parametrisierung.** Die heutige Kette nutzt fest
   `equalizer-3bands` (`pipeline.rs`, drei feste Shelf/Peak-Bänder ohne
   Frequenz-/Güte-Regler) — §4.3 hatte bisher nirgends den Wechsel auf
   ein parametrisches EQ vorgesehen. `equalizer-nbands` ist bereits im
   Dev-Environment installiert (`gst-inspect-1.0` verifiziert,
   gst-plugins-good), erlaubt 1–64 Bänder mit je eigenem
   `freq`/`bandwidth`/`gain`-Kindobjekt — der richtige Ersatz für
   „Gain/Güte/Frequenz". Bandtyp (Peak/Shelf/Notch) hängt vom
   GStreamer-Element ab, muss vor der Umsetzung an einem echten Signal
   geprüft werden (nicht raten, s. `docs/decisions.md` 2026-07-09
   Arbeitsregel).
2. **`audiodynamic`-Realitätscheck, präziser als bisher.** §4.5 Frage 3
   nannte bereits „kein Look-ahead" als Einschränkung — per
   `gst-inspect-1.0` jetzt zusätzlich bestätigt: **keine Attack-/
   Release-Zeitkonstanten, keine Makeup-Gain-Eigenschaft** (nur
   `mode`/`characteristics`/`threshold`/`ratio`). Makeup-Gain lässt
   sich mit einem nachgeschalteten `volume`-Element kompensieren
   (Rust-seitig steuerbar), Attack/Release fehlen dagegen strukturell —
   verschärft §4.5 Frage 3, sollte bei der Entscheidung „reicht
   `audiodynamic`" explizit mitgewogen werden.
3. **Audio-Follow-Video-Pegel.** Heute nur `mute`/`unmute`
   (`main.rs`, `off`/`cut`/`crossfade` schalten ausschließlich den
   Mute-Zustand) — kein definierbarer Pegel für den „Aus"-Zustand
   (z. B. -20dB statt Vollstille, für einen hörbaren, aber leisen
   Off-Air-Zustand). Deskriptor-Erweiterung `afv.offLevelDb` (Default
   `-inf`/Mute, konfigurierbar), Crossfade interpoliert dann zwischen
   `offLevelDb` und reguläremFader-Pegel statt zwischen Mute und Fader.
   ✅ **Erledigt 2026-07-19** (`docs/decisions.md` Nachtrag 35) — statt
   eines `-inf`-Sentinels (JSON kennt keine Unendlichkeit, `serde_json`
   würde sie stillschweigend zu `null` machen) zwei immer JSON-taugliche
   Felder: `followUseMute` (Default `true`, bitgenau unverändertes
   Verhalten) + `followOffLevelDb`. Bei `false` rampt/springt `cut`/
   `crossfade` auf den konfigurierten Pegel statt auf Mute/-60dB, `mute`
   bleibt dabei durchgehend `false`. Live gegen einen echten
   `omp-audio-mixer`-Prozess mit einem echten `nats pub
   omp.tally.<id> '{"on":false}'` verifiziert: der reale
   `/levels`-SSE-Master-Pegel zeigte eine glatte Rampe auf exakt
   `0.3 × 10^(-18/20)` (rechnerisch der konfigurierte -18dB-Zielpegel),
   `followUseMute:true` bitgenau rückwärtskompatibel geprüft (Pegel →
   praktisch Null, `mute:true`), UI-Bundle-Steuerung per echtem
   Chromium-Klick bestätigt.
   ✅ **Erweitert 2026-07-19** (`docs/decisions.md` Nachtrag 36, gleicher
   Tag) — Nutzer-Feedback: „An"-Pegel soll ebenfalls eigenständig
   einstellbar sein (nicht länger implizit der Kanal-Fader), dazu eine
   konfigurierbare Transition-Zeit statt der festen 500ms. Aus
   `setFollowOffLevel` wurde `setFollowLevels(useMute, onLevelDb,
   offLevelDb, transitionMs)` — bei `followUseMute == false` übernimmt
   AFV Gain jetzt vollständig eigenständig (Fader wird ignoriert), bei
   `true` bleibt der alte Mute+Fader-Pfad bitgenau unverändert. Live
   beide Rampenrichtungen + `cut`-Sofortsprung mit `transitionMs=1000`
   gegen echte `/levels`-Messwerte verifiziert (exakte dB-Mathematik in
   beide Richtungen bestätigt), UI-Bundle um „An-Pegel"/„Transition
   ms"-Felder erweitert, per Chromium-Klick verifiziert.
4. **Mixer-Presets.** ✅ **Erledigt 2026-07-19** (`docs/decisions.md`
   Nachtrag 40). Der ursprüngliche Plan hier („denselben Erfassungs-/
   Anwendungs-Code wiederverwenden", Snapshot mit `nodeIds: [self]`)
   ging von PATCH-fähigen Parametern aus — live entdeckter Blocker:
   `omp-audio-mixer`/`omp-video-mixer-me` erklären ausnahmslos alle
   Parameter `readonly:true` (Mutation nur über eigene `invoke()`-
   Methoden), der generische Parameter-Proxy hätte nichts erfasst.
   Gelöst durch eine Node-Contract-Erweiterung: optionale `GET`/`POST
   /state`-Route (opakes, node-eigenes JSON, über den vorhandenen
   `extra_route`-Erweiterungspunkt, kein Descriptor-Schema-Update
   nötig) — der Snapshot-Service versucht sie zuerst, fällt bei 404 auf
   die bisherige Parameter-Enumeration zurück. `omp-audio-mixer` hat
   dazu ein UI-Presets-Panel bekommen (Speichern/Anwenden-Chips);
   `omp-video-mixer-me` hat inzwischen (gleicher Tag, Nachtrag)
   dasselbe UI-Panel bekommen — beide §13-Referenzknoten damit
   vollständig, live per Chromium/CDP-Klick verifiziert (Keyer + DVE-Box
   korrekt gespeichert/wiederhergestellt).

**Priorität:** Teil 2 (Dynamik/EQ) und Presets (Punkt 4, inkl.
`omp-video-mixer-me`-UI) sind erledigt (s. o.).

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
2. ~~Render-Variante~~ **entschieden (K5-Teil-0, 2026-07-15, s.
   `docs/decisions.md`): Variante A (`wpesrc`).** Paketierungsrisiko
   bestand nicht (`apt install gstreamer1.0-wpe`), Chromium-Sandbox-
   Crash aus B2 (2026-07-07) seither überholt. 5 echte Templates
   (`digital-clock-top-left`, `breaking-news`, `flat-design-lower-third`,
   `scorebug`, `ticker`) pixelidentisch zur Chromium-Kontrollprobe
   gerendert, Alpha-Kanal pixelgenau verifiziert, MXL `video/v210a`
   bereits in der installierten Bibliothek unterstützt.
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

### 7.6 Nachtrag (2026-07-17) — Operator-UI muss der Übernahme unmerklich folgen

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 5): „wie definiere/
> erstelle ich ein redundantes Service (z. B. für den Bildmischer)?
> Falls es aktiv wird, muss das UI des Operators unmerklich dann
> folgen."

Erster Teil der Frage ist bereits vollständig beantwortet: „ein
redundantes Service definieren" = eine Workflow-Rolle mit
`restartPolicy` (§7.3a, Teil 1) bzw. später `standby: true` (§7.3d,
Teil 4) versehen — **kein neues Konzept nötig**, K7-Teil-1 ist dafür
bereits fertig entworfen und laut Entscheidungsliste (Kapitel 10,
Punkt 8) „startet sofort", aber bis heute **nicht begonnen** (kein
K7-Eintrag in `UMSETZUNG.md` §7-Checkliste). Das ist damit der
konkrete nächste Schritt für dieses Kapitel.

**Neuer Aspekt, den §7.3 bisher nicht behandelt:** §7.3a/b beschreiben
die *Medien*-Wiederverkabelung (IS-05-Verbindungen, `node.added`-Glue)
nach einem Neustart/Umschalten — nicht, was mit der **Operator-Browser-
Sitzung** passiert, die auf dem alten Prozess/Node hing. Ein Operator,
der die Konsolen-Route eines Bildmischers offen hat
(`/console/<workflowId>/<nodeRoleId>`, §1.6), verliert bei einem
Prozess-Restart schlimmstenfalls die WebSocket/SSE-Verbindung zum
UI-Bundle, oder — bei einem künftigen Hot-Standby-Failover mit
Rollen-Wechsel auf eine **andere** Instanz-ID — zeigt weiter die tote
Instanz an, ohne automatisch auf die neue zu wechseln.

**Ziel-Design-Ergänzung:** `nodeRoleId` in der Konsolen-Route bleibt
über einen Restart/Failover hinweg **stabil**, sofern sie die
Workflow-Rollen-ID ist (nicht die launcher-instanzspezifische ID) —
das ist bereits die richtige Zielrichtung aus §7.3a/d
(„dieselbe Rolle, anderswo/neu gestartet"). Die Konsole selbst braucht
dafür serverseitig eine Rollen→aktuelle-Instanz-Auflösung (statt einer
zum Start fest aufgelösten Instanz-ID), plus denselben
`ConnectionMonitor`-Reconnect-Mechanismus aus §1.3a, aber mit einem
zusätzlichen Zustand „Rolle neu aufgelöst, UI-Bundle neu laden" statt
nur „Verbindung wiederhergestellt" — der Unterschied zu einem
normalen Reconnect ist, dass sich die zugrundeliegende Instanz-ID
geändert haben kann. Ohne diese Ergänzung würde ein Operator nach
einem echten Failover auf ein leeres/totes UI schauen, obwohl der
Redundanz-Mechanismus selbst korrekt funktioniert hat — genau das
„unmerklich" aus der Nutzerfrage verlangt das Gegenteil.

**Priorität:** K7-Teil-1 (Prozess-Auto-Restart) ist reif und
unabhängig sofort umsetzbar — höchste Priorität unter den in diesem
Kapitel noch offenen Teilen. Die Konsolen-Rollen-Auflösung oben ist
klein genug, um **direkt mit K7-Teil-1** mitgenommen zu werden (beide
brauchen dieselbe Grundlage: eine Rolle, die über einen Prozesswechsel
hinweg stabil bleibt), statt auf Hot-Standby (Teil 4) zu warten.

✅ **Konsolen-Rollen-Auflösung erledigt 2026-07-19** (`docs/decisions.md`
Nachtrag 34) — Backend war bereits korrekt (`consoles.NodeRoleID` ist
die stabile Instanz-ID, `GET /api/v1/me/consoles` löst live auf); die
Lücke lag rein im Client (`shell.ts` fetchte Konsolen nur einmal beim
Seitenaufbau, `console-view.ts` remountete bei unveränderter
`nodeRoleId` nie neu, selbst wenn deren `uiBundleUrl` auf eine neue
Node-ID zeigte). Fix: `shell.ts` löst `/api/v1/me/consoles` jetzt
SSE-first mit 30s-Poll-Fallback erneut auf, `console-view.ts` erkennt
eine geänderte `uiBundleUrl` für die aktive Rolle und remountet gezielt
(reine Entscheidungslogik in `console-logic.ts`, `deno test`-geprüft).
Live per CDP mit einem echten `nodes/mock`-Prozess verifiziert:
`kill -9` → K7-Teil-1-Neustart mit neuer NMOS-Node-ID → die bereits
offene Kiosk-Konsole zeigte per Netzwerk-Trace beweisbar das neue
Bundle, ganz ohne Seiten-Reload (`Page.getNavigationHistory` blieb bei
einem Eintrag). Damit ist §7.6 vollständig; ein echtes Hot-Standby-
Failover auf eine **andere** Instanz-ID (§7.3d Teil 4) bräuchte
weiterhin eine eigene, noch nicht gebaute serverseitige Auflösung.

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

**Status 2026-07-14: alle zehn Punkte entschieden** (Sitzung im
Anschluss an D6 Teil 3). Entscheidungen unten, Begründungen/Kontext im
Detail in `docs/decisions.md` (Eintrag „Entscheidungssitzung
END-GOAL-FEATURES Kapitel 10"). Die einzelnen Kapitel-Unterabschnitte
(1.5, 2.5, …) bleiben als Herleitung stehen und wurden nicht
nachträglich umgeschrieben — diese Liste hier ist die verbindliche
Kurzfassung.

1. **Reihenfolge:** empfohlene Reihenfolge aus Kapitel 0 übernommen
   (K1-Teil-1 → K2-Teil-1 → K3/K4-Teil-1 → K5 → K6, K7-Teil-1 und
   K9-Teil-0 unabhängig/parallel startbar).
2. **K1:** Studio-Dark **only**. Sprache: **Englisch als
   Primärsprache mit DE-Umschaltung** (Abweichung von der
   Dokument-Empfehlung „DE belassen" — zweisprachig wie PIPELINE
   CONTROLLER). Floating-Panels werden zu **Vollansichten mit Tabs**
   ausgebaut (App-Bar „Flow-Editor · Workflows · Hosts", §1.3b) —
   ebnet den Weg für den späteren Workflow-Katalog (§22.3).
3. **K2:** Codec-Scope = **derselbe Codec, den PIPELINE CONTROLLER
   bereits nachweislich abspielt** (dort erproben, nicht neu
   herleiten, welcher genau das ist). Medienverzeichnis: **pro
   Instanz konfigurierbar** (beschreibbarer Parameter, nicht global
   über Katalog-`env`) — Abweichung von der Dokument-Empfehlung, mehr
   Parameter-Fläche akzeptiert für die Flexibilität. EOS-Advance
   bleibt **K6-Scope** (Dokument-Empfehlung bestätigt).
4. **K3:** Hot-Cut auf PGM **nur mit Modifier-Taste** (Shift+Klick).
   Bank-Größe: **überschaubare feste Anzahl (8–12)**, kein
   Discovery-getriebenes Unbegrenzt-Layout in v1.
5. **K4:** Generischer **Node-Stream-Proxy im Orchestrator wird
   gebaut** (`/api/v1/nodes/<id>/stream/<name>`) — löst Audio-Pegel
   **und** die bekannte MJPEG-Vorschau-Problematik (C12) in einem
   Aufwasch. **2 Aux + 2 Gruppen** Default (Dokument-Vorschlag).
   Limiter: **`audiodynamic`** (kein LV2/neue Systemdependency).
   **Solo/PFL-Abhörweg wird gebaut** (Monitor-Summe + lokale
   Wiedergabe) — Abweichung von der Dokument-Empfehlung „Metering
   reicht".
6. **K5:** OGraf **in den Regieplatz-Demo-Umfang aufgenommen**
   (schließt die seit 2026-07-11 offene §11.2-Frage). Render-Variante:
   **erst der Spike entscheidet** (keine Vorfestlegung wpesrc vs.
   Chromium/CDP). Editor-Bedeutung: **nur PIPELINE-CONTROLLER-Umfang**
   (Formulare/Hotkeys/Children, kein Authoring-Tool). Template-Lizenz:
   **die ~45 Templates dürfen unverändert übernommen werden**
   (Bestätigung durch den Projektinhaber).
7. **K6:** Scheduler bleibt **getrennt** von D7 Teil 2 (Workflow-
   Zeitplan vs. Playlist-Fixtime, zwei Zwecke). Playlist-Persistenz:
   **Orchestrator/Postgres** (Dokument-Empfehlung, konsistent mit D1).
   Ausgelagerte Subsysteme (Record/SCTE-35): **keins davon jetzt**,
   kein neues Node-Konzept in `ARCHITECTURE.md` §13 nötig. Multi-Kanal:
   **Workflow-Struktur reicht** als Antwort auf `supervisor.js`, kein
   eigenes ChannelBus-Dashboard.
8. **K7 (HA/Redundanz):** **(c) als Zwischenschritt — Standby läuft
   parallel mit, Downstream hält bei Umschaltung das letzte Bild —
   mit (b) (echte Genlock-äquivalente, unsichtbare Übernahme) als
   späteres Endziel**, nicht als Alternative. Damit ist die seit
   2026-07-12 offene Projekt-Memory-Frage entschieden — der zuvor
   dokumentierte (b)-Fahrplan (`ARCHITECTURE.md` §20.1, fünf Stufen:
   Grain-Index-Struktur → schneller sichtbarer Cut → echte PTP-Basis →
   Command-Mirroring/`omp-seamless-switch` → Determinismus-Härtung)
   bleibt die Zielrichtung, (c) wird als eigene, frühere Stufe davor
   eingeschoben. K7-Teil-1 (Prozess-Auto-Restart) **startet sofort**,
   unabhängig von dieser Grundsatzfrage. Crash-Loop-Bremse:
   **5 Restarts / 60 Sekunden**, danach Alarm statt Endlosschleife.
   ST 2022-7 als **pro Workflow-Rolle konfigurierbares Merkmal**
   bestätigt (§21.1-Prinzip). K7-Teil-4-Priorisierungsfrage zur
   Placement-Engine ist **gegenstandslos** — D6 Teil 3 wurde am
   2026-07-14 fertiggestellt (`UMSETZUNG.md`), K7-Teil-4 kann jetzt
   direkt darauf aufsetzen.
9. **K8 (Stream Deck):** Modell = **Stream Deck MK.2**. Umfang jetzt:
   **generische Fallback-Seite (Teil 1) reicht**, keine handgetunte
   K3-Seite als Pflicht. udev-Regel: **automatisiert**
   (`make streamdeck-udev`), keine reine Dokumentation wie im Vorbild.
   Mehrgeräte-Fall: **jetzt mitdenken**, nicht erst später nachrüsten
   — Abweichung von der impliziten Ein-Geräte-Annahme des Dokuments.
10. **K9 (Multiviewer-Streaming):** Zielgerät = **beides** (dedizierter
    Regieplatz-Monitor **und** entfernte/Laptop-Browser-Betrachtung) —
    damit ist Pfad A (WebRTC) tatsächlich gebraucht, nicht nur für den
    Monitor-Fall optional. Betrachterzahl: **mehrere gleichzeitige
    Operator-Tabs** — WebRTCs Fan-out-Vorteil (SFU) lohnt sich damit.
    JPEG-XS: **gestrichen** aus dem v1-Scope (Dokument-Empfehlung).
    Latenzziel: **deutlich unter 300 ms**, nicht sub-100 ms — bewusst
    kein Widerspruch zum WebRTC-Bedarf oben: WebRTC wird primär wegen
    Fan-out/Remote-Zugriff gebraucht, nicht weil Pfad B (SRT + nativer
    Player, bereits über Teil 0/1 auf <300ms) das Latenzziel allein
    verfehlen würde.

Nächster Schritt: die gewählten „Teil 1"-Scheiben (K1-Teil-1 zuerst
laut Reihenfolge-Entscheidung) als reguläre Schritte in
`UMSETZUNG.md` aufnehmen (eigene Sitzung, eigene Verifikation,
Status-Checkliste) — dieses Dokument bleibt die Design-Referenz
dahinter und wird bei weiteren Scope-Änderungen fortgeschrieben.

---

## 11. Settings-, User- und Rollenverwaltung in der Shell (+ Export/Import)

> „es gibt keine möglichkeit, die settings unseres projekts zu
> bearbeiten (userverwaltung, rollen, latenz,...ein user kann mehrere
> rollen haben). diese müssen auch exportiert/importiert werden können."

### 11.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Das Backend existiert zu großen Teilen bereits** (D3 Teil 2,
  2026-07-14): Nutzer und Rollenbindungen liegen in Postgres — `users`
  (bcrypt-Hash, `0002_auth.sql:18`), `role_bindings`
  (subject/node_id/verb, `0002_auth.sql:25`), `audit_log`
  (`0002_auth.sql:38`). Bindungs-Semantik: Tripel (Subject, NodeID,
  Verb) mit Verb-Rangfolge view < operate < configure < admin
  (`orchestrator/internal/authz/authz.go:21–42`), `NodeID="*"` für
  „alle Nodes" (`authz.go:55`).
- **„Ein User kann mehrere Rollen haben" ist im Datenmodell bereits
  erfüllt** — eine Bindung ist eine Zeile, ein Subject darf beliebig
  viele haben (`authz.go:47–52`; `internal/consoles/resolve.go:105–132`
  iteriert genau so über mehrere Bindungen pro Nutzer). Der Gap ist
  nicht das Modell, sondern Verwaltbarkeit + Export.
- **Endpunkte:** `POST /api/v1/auth/users` (admin-only,
  `internal/httpapi/server.go:148`), `GET/POST/DELETE
  /api/v1/admin/role-bindings` (`server.go:172–174`),
  `GET /api/v1/admin/audit-log` (`server.go:175`). Es fehlen:
  Nutzer-**Liste** (`GET`), Nutzer löschen, Passwort-Reset.
- **Bewusste Scope-Grenze:** „kein Workflow-Scope in dieser Runde"
  (`authz.go:9–15`) — `ARCHITECTURE.md` §12 Punkt 2 nennt als
  Wirkungsbereich „ein Workflow (§6.2) **oder** eine einzelne
  Node-Rolle darin"; umgesetzt ist nur der Node-Rollen-Teil. Die
  Vervollständigung (Workflow-Scope) ist **K12-Teil-4-Scope** (dort,
  nicht hier — ein Bindungsmodell, eine Erweiterung, keine zwei
  Rechtesysteme).
- **UI: nichts.** `ui/shell/auth.ts` ist ein reines Login-Widget; die
  App-Bar (K1-Teil-1) hat rechts nur den Verbindungs-Pill
  (`ui/shell/app-shell.ts:103–109`), Tabs sind Flow/Workflows/Hosts
  (`app-shell.ts:23–27`). Rollenbindungen sind heute ausschließlich
  per `curl` pflegbar. Das Kapitel-1-Settings-Panel (§1.3c, §1.4
  Teil 3) ist **lokale UI-Präferenz** (Theme, localStorage) — bewusst
  etwas anderes; §1.3c Punkt 4 sah dort bereits „Nutzerverwaltung: nur
  Link/Einbettung … für `admin`" vor. Genau diese referenzierte
  Verwaltung existiert nicht — dieses Kapitel baut sie.
- **Export/Import: nirgends vorhanden** (kein Export-Endpunkt im
  gesamten `internal/httpapi`). Projekt-interne
  Serialisierungs-Vorbilder: Snapshots als vollständige JSON-Objekte
  (`internal/snapshots/types.go:29–35`) und opake Layout-Blobs
  (`internal/layouts/store.go`).
- **„Settings" im weiteren Sinn:** alle globalen Werte sind heute
  Umgebungsvariablen beim Prozessstart (`internal/config/config.go:
  89–109` — u. a. die vier Placement-Schwellwerte `OMP_PLACEMENT_*`,
  Zeilen 106–109), zur Laufzeit unveränderbar, ohne UI. Eine
  „Latenz"-Einstellung existiert **nirgends** im Code (per
  Volltextsuche verifiziert): §15 (Latenz-Budget pro Workflow) ist
  reines Konzept; laufzeitnahe Kandidaten wären Preview-FPS (hart
  kodiert, z. B. `omp-viewer/src/pipeline.rs:29–32`),
  UI-Poll-Intervalle (`ui/shell/hosts-view.ts:45` u. a.) und
  Registrierungs-/Health-Timeouts (`internal/workflows/service.go:27`).

### 11.2 Referenz

Kein tragfähiges Referenzmuster in PIPELINE CONTROLLER: dessen
Nutzermodell (users.json, **globale** Rollen ohne Wirkungsbereich) ist
in `ARCHITECTURE.md` §12 („Know-how-Transfer") bereits verarbeitet und
als für Mehr-Regieplatz-Betrieb unzureichend eingeordnet; eine
Verwaltungs-UI oder Export/Import existieren dort nicht. Referenz ist
hier `ARCHITECTURE.md` selbst: §12 (Semantik inkl. der offenen
AD/LDAP-Grundsatzfrage, `docs/decisions.md` 2026-07-10) und §22.1, das
„**Rollen/Nutzer (§12) — nur für `admin`**" bereits als eigenen
Navigationspunkt der Shell festlegt — die Verortung ist also
entschieden, nicht neu zu erfinden.

### 11.3 Ziel-Design

**a) Verortung:** neuer App-Bar-Tab **„Administration"**, nur für
Nutzer mit `admin`-Verb gerendert (exakt die §22.1-Regel
„Navigationspunkte ohne passende Rolle werden nicht gerendert"). Das
K1-Settings-Panel (Teil 3) bleibt persönliche Präferenzen und verlinkt
von seiner Sektion 4 hierher — kein Vermischen von „meine Darstellung"
(jeder Nutzer) und „System verwalten" (`admin`).

**b) Nutzer-/Bindungs-Verwaltung:** Nutzerliste (neuer
`GET /api/v1/auth/users`), pro Nutzer die Bindungen gruppiert
dargestellt (mehrere Bindungen = mehrere Rollen, das bestehende
Modell wird sichtbar statt umgebaut). Bindung anlegen: Node-Auswahl
über Registry + Instanzen mit **Label** statt roher ID (die
`NodeRoleID`-Konvention aus `consoles/resolve.go:84–89` — stabile
Instanz-ID — bleibt unverändert die gespeicherte Referenz), Verb-
Auswahl, „*" für alle Nodes. Neue kleine Endpunkte:
`GET /api/v1/auth/users`, `DELETE /api/v1/auth/users/{name}`,
Passwort-Reset — alle admin-only, alle auditiert (D3-Teil-2-Linie).
**Selbstschutz:** der letzte verbleibende admin kann sich nicht selbst
löschen/entrechten (Prüfung im Handler — sonst sperrt man sich aus).

**c) Globale Settings-Registry:** neue Postgres-Tabelle `settings`
(key → JSONB) + `GET/PUT /api/v1/admin/settings`. Vorrangregel beim
Boot: env > DB > Default (env bleibt für deploy/dev funktionsfähig
und gewinnt, wenn gesetzt — dokumentiert, kein stilles Überstimmen).
Erste echte Einträge (nur Werte, die heute existieren und deren
Laufzeit-Änderung sinnvoll ist): die Placement-Schwellwerte
(`config.go:106–109`), später der `confirm_stop`-Default (D7 Teil 2)
und Warnschwellen aus K14. **„Latenz" wird hier bewusst nicht als
globaler Regler erfunden:** eine globale Latenz-Zahl gibt es im
heutigen Code nicht, und der architektonisch richtige Ort ist das
Latenz-Budget **pro Workflow** (§15 → K12-Workflow-Objekt) bzw.
Preview-FPS **pro Node** (Descriptor-Parameter, K9-Nachbarschaft) —
siehe offene Frage 2, bevor hier etwas gebaut wird.

**d) Export/Import:** `GET /api/v1/admin/export` liefert ein
JSON-Dokument `{version, exportedAt, users[], roleBindings[],
settings{}}` (Download im Admin-Tab);
`POST /api/v1/admin/import` mit `{mode: "merge"|"replace",
dryRun: bool}` — der Dry-Run liefert einen Diff-Bericht
(anzulegen/zu überschreiben/zu löschen), bevor irgendetwas
geschrieben wird (dasselbe Bestätigungs-Denken wie `confirm_stop`,
§6.2 Punkt 2). **Workflow-Definitionen sind bewusst nicht Teil dieses
Exports** — sie haben in K12 Teil 3 einen eigenen Export pro Workflow
(ein Regieplatz soll einzeln zwischen Systemen wandern, ohne
Nutzerdaten mitzuschleppen); ein späterer „Alles"-Export kann beide
kombinieren, ist aber kein v1-Ziel.

### 11.4 Phasenplan

- **Teil 1 (eine Sitzung):** Admin-Tab + Nutzerliste
  (`GET /api/v1/auth/users` neu) + Rollenbindungs-CRUD-UI auf den
  bestehenden Endpunkten + Audit-Log-Ansicht (Endpunkt existiert).
  Verifikation per CDP-Klick-Test (Memory-Regel: UI-Formulare klicken,
  nicht nur API testen): als admin eine `operate`-Bindung auf eine
  laufende Mixer-Instanz für einen Testnutzer anlegen → Login als
  Testnutzer landet in der Console-Ansicht genau dieses Nodes
  (C13-Pfad), `PATCH` auf einen fremden Node liefert 403; das
  Audit-Log zeigt die Anlage.
  ✅ **Erledigt 2026-07-17** (`UMSETZUNG.md`, `docs/decisions.md`
  Nachtrag 8). Neue Endpunkte `GET /api/v1/auth/users`,
  `DELETE /api/v1/auth/users/{name}`,
  `PUT /api/v1/auth/users/{name}/password` (Passwort-Reset), alle
  admin-only + auditiert, plus `isAdmin` in `GET /api/v1/auth/whoami`
  (true bei admin-Verb ODER Bootstrap-Modus) als Signal für die Shell.
  Selbstschutz umgesetzt und live gegen den echten Server verifiziert
  (409, „cannot delete the last remaining admin") — greift sowohl beim
  Nutzer-Löschen als auch beim Entfernen der eigenen `*`-admin-Bindung
  über `DELETE /api/v1/admin/role-bindings/{id}`. Neuer App-Bar-Tab
  „Administration" (`ui/shell/admin-view.ts`), nachträglich per
  `whoami().isAdmin` angehängt (`app-shell.ts`) statt Teil der
  statischen Tab-Liste — genau der noch fehlende Weg, um überhaupt den
  ersten Nutzer anzulegen: das Formular „+ Neuer Nutzer" ist im
  Bootstrap-Fall zugleich das Bootstrap-Formular (derselbe Endpunkt,
  derselbe Bootstrap-Bypass wie bisher). Dabei eine reale Lücke beim
  Entwerfen gefunden und geschlossen, bevor sie im Live-Test aufgefallen
  wäre: ohne automatischen Login direkt nach dem Anlegen des allerersten
  Nutzers wäre die gerade noch token-lose Bootstrap-Sitzung nach der
  Erstanlage bei jedem weiteren Admin-Aufruf mit 401 hängengeblieben
  (`UserCount()` ist ab dann > 0, der Bypass greift nicht mehr) —
  `admin-view.ts` loggt sich deshalb automatisch ein und lädt neu, wenn
  nach dem Anlegen noch kein Token im Speicher lag. Vollständig per CDP
  gegen den echten laufenden Stack verifiziert (nicht nur `curl`):
  Bootstrap-Anlage → Auto-Login, `operate`-Bindung für einen Testnutzer
  auf eine echte laufende `omp-audio-mixer`-Instanz angelegt, Login als
  dieser Nutzer landet direkt in dessen Console-Ansicht ohne App-Bar
  (C13-Pfad bestätigt), `PATCH` auf eine zweite, nicht gebundene Instanz
  liefert 403, Audit-Log zeigt den `POST /api/v1/admin/role-bindings`
  mit Status 201. Teil 2/3/4 bleiben wie geplant offen.
- **Teil 2 — Export/Import:** Endpunkte + Dry-Run-Diff + UI-Buttons
  (Datei-Download/-Upload). Verifikation: Export → Bindung löschen →
  Import (merge) → Bindung wieder da und wirksam (403-Test);
  Import (replace, dryRun) meldet den korrekten Diff, ohne zu
  schreiben.
- **Teil 3 — Settings-Registry:** Tabelle, API, UI-Sektion im
  Admin-Tab; Placement-Schwellwerte als erste Migration von env.
  Verifikation: Schwellwert per UI unter die aktuelle Last senken →
  Placement-Advice-Banner (D6 Teil 3) erscheint ohne
  Orchestrator-Neustart.
- **Teil 4 (später, nach K12 Teil 4):** Bindungs-UI um die
  Workflow-Scope-Spalte erweitern; Passwort-Selbstservice
  (`PUT /api/v1/me/password`); AD/LDAP gemäß §12 Punkt 1 — die
  Grundsatzentscheidung (`docs/decisions.md` 2026-07-10) bleibt offen
  und wird hier nicht nebenbei getroffen.

### 11.5 Offene Fragen an den Projektinhaber

1. **Export inkl. bcrypt-Passwort-Hashes?** Mit Hashes ist ein
   1:1-Systemumzug möglich, aber die Datei ist sensibel; ohne Hashes
   müssen nach dem Import alle Passworte neu gesetzt werden. Welche
   Variante (oder beide, per Checkbox beim Export)?
2. **Was ist mit „latenz" konkret gemeint?** (a) Latenz-Budget pro
   Workflow (§15 — würde als Feld am K12-Workflow-Objekt landen),
   (b) Vorschau-/UI-Latenz (Preview-FPS, Poll-Intervalle),
   (c) etwas anderes? Bestimmt, wo der Regler wohnt — im heutigen Code
   existiert keiner.
3. Reicht das Tripel-Modell (mehrere Bindungen = mehrere Rollen) oder
   sind zusätzlich **benannte Rollen-Vorlagen** gewünscht
   („Bildmeister" als wiederverwendbares Bündel, das man Nutzern
   zuweist)? Empfehlung: Vorlagen erst bei realem Nutzermengen-Bedarf —
   das Tripel bleibt darunter unverändert.
4. AD/LDAP-Anbindung (§12 Punkt 1): weiterhin zurückgestellt, oder
   bekommt sie durch die Präsentations-Perspektive jetzt Priorität?

---

## 12. Workflow = Regieplatz: Gruppieren im Flow-Editor, Lifecycle inkl. Pause, Export/Import, rollenbasierter Bedien-Zugriff

> „die workflow definition ist noch nicht wie gewünscht. es muss möglich
> sein, sich zum beispiel einen kleinen regieplatz bestehend aus 3
> kameras (livequellen), einem bildmischer, einem audio mischer (audio
> follow video vielleicht) und zwei video playern zu bauen (mit einem
> flow editor, oder direkt im flow editor und dann ähnlich wie
> gruppieren (oder eh gleich gruppieren) als einen workflow (eben
> regieplatz 1) zu definieren. dem workflow können dann user zugewiesen
> werden, die diesen bearbeiten oder eben nur bedienen können. dann muss
> es möglich sein, dem bildmeister die rechte so zu geben, dass er in
> seiner rolle als bildmeister nur den bildmischer sehen/bedienen kann.
> praxisnahe denken. den workflow muss man speichern,
> importieren/exportieren, starten (nach vorprüfung der ressourcen),
> pausieren (läuft nicht, braucht keine ressourcen, ist aber im
> floweditor zu sehen), starten und stoppen. wenn ein user (zum beispiel
> der bildmeister) einsteigt darf er ja nichts bearbeiten sondern nur
> bedienen, muss daher beim einsteigen nur die workflows zur auswahl
> bekommen, denen er zugewiesen ist und nach auswahl nur sein UI aller
> zu bedienenden elemente sehen. (eine lösung, wenn er mehrere ui's
> bedienen kann (bildmischer, ograf,..) im floweditor würden dann im
> endausbau mehrere gruppen/workflows gleichzeitig laufen/existieren
> (regieplatz 1, regieplatz 2, remote regieplatz, control room, playout,
> edit,..)"

### 12.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Workflow-Objekt existiert** (D7 Teil 1, erledigt 2026-07-14,
  `orchestrator/internal/workflows`):
  - Zustände: nur `stopped/starting/started/stopping/failed`
    (`types.go:21–27`) — **kein `paused`**.
  - Definition = Rollen (`{name, nodeType, hostId?}`, `types.go:35–39`)
    + Rolle→Rolle-Kanten (`types.go:49–52`).
  - **Verkabelungs-Grenze, für den Regieplatz-Fall hart:** aufgelöst
    wird immer auf den jeweils **ersten** Sender/Receiver einer Rolle
    (`service.go:225`: `fromNode.Senders[0].ID,
    toNode.Receivers[0].ID`; als „dokumentierte Folgearbeit" markiert,
    `types.go:44–48`). Drei Kamera-Rollen auf einen Bildmischer würden
    heute alle auf **denselben** Mixer-Receiver gepatcht — der wörtlich
    gewünschte Regieplatz (3 Kameras + Bildmischer) ist mit dem
    heutigen Template **nicht verkabelbar**. Das ist der erste zu
    schließende Gap, noch vor jedem UI-Komfort.
  - API: `POST/GET/DELETE /api/v1/workflows`,
    `POST …/{id}/start|stop` (`server.go:193–198`) — **kein
    PUT/Update** (obwohl `ARCHITECTURE.md` §22.3 Punkt 2
    `PUT /api/v1/workflows/<id>` bereits als Soll nennt). Start/Stop
    verlangen heute global `admin`, Anlegen `configure`.
  - UI: `<omp-workflows-view>` ist ein Listen-+Formular-Panel
    (Name + Rollen-Dropdowns + Verbindungs-Dropdowns,
    `ui/shell/workflows-view.ts:109–121`) — kein grafisches Entwerfen.
- **Gruppen (B5) sind ein rein visuelles Konzept:** Baum +
  Port-Promotion in `ui/graph/groups.ts` (`GroupNode`, Zeilen 8–14;
  `promotedPorts`, Zeilen 164–192), opak im Layout-Blob persistiert
  (`ui/graph/flow-canvas.ts:80–89`; `internal/layouts/store.go:1–6`:
  „Der Orchestrator kennt die Struktur des Blobs weiterhin nicht").
  Eine Gruppe referenziert **laufende Node-IDs**, ein Workflow
  **Rollen/Typen** — strukturell nah (beides „benannte Menge mit
  Außenkanten"), aber heute zwei getrennte Welten ohne Brücke. Genau
  diese Brücke ist der Kern der Anfrage („ähnlich wie gruppieren, oder
  eh gleich gruppieren").
- **Operator-Einstieg (C13/§14) ist zu ~2/3 gebaut:**
  `GET /api/v1/me/consoles` löst `operate`-Bindungen zu
  Konsolen-Einträgen auf — aber gegen einen **Stub-Workflow**
  („default", `internal/consoles/resolve.go:14–17`; der Kommentar dort
  verweist selbst auf „sobald §6.2 echte Workflows einführt").
  `ConsoleEntry` trägt das `workflowId`-Feld bereits
  (`resolve.go:37–43`), die Console-Ansicht kann mehrere Bundles als
  Tab-Leiste (`ui/shell/console-view.ts:1–8`), die Kiosk-Route
  `/console/<workflowId>/<nodeRoleId>` existiert (§14). Es fehlt die
  echte Workflow-Dimension: Auswahl nur zugewiesener Workflows,
  Konsolen-Liste pro gewähltem Workflow.
- **AuthZ ohne Workflow-Scope** (`authz.go:9–15`, bewusste
  D3-Teil-2-Grenze). `ARCHITECTURE.md` §12 Punkt 2 spezifiziert den
  Zielzustand bereits wörtlich: „Wirkungsbereich ist ein Workflow
  (§6.2) **oder eine einzelne Node-Rolle darin** … Beispiel: Gruppe
  ‚Bildmischer Regie 1' → Verb `operate` auf Node-Rolle ‚Videomixer'
  im Workflow ‚Regie 1'" — exakt der Bildmeister-Fall der Anfrage.
  Dieses Kapitel erfindet also **kein neues Rechtemodell**, sondern
  vervollständigt §12 Punkt 2.
- **„starten (nach vorprüfung der ressourcen)" ist bereits als D7
  Teil 2 spezifiziert und eingeplant** (§6.2 Erweiterung 2026-07-10,
  Punkte 1–3: Zeitsteuerung, `confirm_stop`,
  Ressourcen-Vorprüfung-als-Start-Vorbedingung) — der einzige noch
  offene reguläre D-Schritt (`UMSETZUNG.md` §7). Wird hier
  **vorausgesetzt und nicht dupliziert**; K14 liefert später die
  bessere Datengrundlage dafür (Typ-Verbrauchsprofile statt
  Momentwert, siehe 14.3d).
- **§22.3 (Workflow-Katalog) hat die Bedien-Vision bereits
  entschieden:** Designer als Rollen-Variante des bestehenden
  Graph-Editors („Kacheln sind ‚Rolle: Videomixer' statt ‚Node
  xyz-123'"), Speichern/Laden = `PUT`/`GET` auf Postgres-Objekten,
  Katalog-Kachel-Grid mit Thumbnail/Suche. Dieses Kapitel ist die
  Umsetzungskonkretisierung von §22.3 **plus** die vier dort nicht
  abgedeckten Punkte: Pause-Zustand, Datei-Export/-Import,
  Operator-Workflow-Einstieg, Mehrere-Workflows-gleichzeitig im
  Editor.
- **Export/Import: nicht vorhanden.** Snapshot (B7) ist das
  Serialisierungs-Vorbild (`internal/snapshots/types.go:29–35`,
  Edges + Params als ein JSON-Objekt) und zugleich der designierte
  Träger des Parameterzustands — §6.2 wörtlich: „ein Snapshot kann
  anschließend den initialen Parameterzustand darüberlegen".

### 12.2 Referenz

PIPELINE CONTROLLER ist hier keine Quelle: Single-Box-System mit genau
einem impliziten „Workflow", ohne Multi-User-/Regieplatz-Dimension.
Referenz sind die eigenen Architektur-Abschnitte §6.2, §12, §14 und
§22.3 — der Beitrag dieses Kapitels ist deren Verzahnung zu einem
durchgängigen Bedien-Fluss plus die in 12.1 benannten Lücken.

### 12.3 Ziel-Design

**a) Port-genaues Verbindungs-Template (Fundament-Fix).**
`Connection` wird um optionale Endpunkt-Angaben erweitert:
`{fromRole, fromSender?, toRole, toReceiver?}` — Referenz per
stabilem Sender-/Receiver-**Label** (aus IS-04/Descriptor; Node-IDs
sind pro Prozessstart neu und scheiden aus) oder Index. Ohne Angabe
gilt das bisherige Verhalten (erster Port) als
Kompatibilitäts-Fallback — kein Bruch bestehender Workflows. Die
Auflösung in `runStart` ersetzt `Senders[0]/Receivers[0]` durch den
Label-Lookup; das Anlege-Formular (`workflows-view.ts`) bekommt pro
Verbindung eine Sender-/Receiver-Auswahl.

**b) Gruppieren = Regieplatz definieren (die Brücke
Editor ↔ Workflow).** Neue Flow-Editor-Aktion an einer Gruppe: **„Als
Workflow speichern"** — leitet aus den Gruppenmitgliedern die Rollen
ab (`graph.instanceId` → Instanz-Typ über `/api/v1/instances`; Nodes
ohne Launcher-Instanz sind nicht ableitbar → verständliche
Fehlermeldung statt stillem Auslassen) und aus den gruppeninternen
Kanten das port-genaue Template (a). Umgekehrt rendert der Editor
laufende Workflows als **benannten Rahmen** um die Kacheln ihrer
Runtime-Nodes (Zuordnung über `wf.Runtime[role].NodeID`, liegt im
Workflow-Objekt bereits vor). Damit existieren „Regieplatz 1",
„Regieplatz 2", „Playout" … **gleichzeitig sichtbar auf einer
Canvas** — der Endausbau-Wunsch aus der Anfrage. B5-Gruppen bleiben
daneben als leichtgewichtiges, rein visuelles Werkzeug bestehen (zwei
Konzepte, klar unterscheidbar beschriftet; ob sie langfristig
verschmelzen: offene Frage 4).

**c) Lifecycle inkl. Pause.** Neuer Status `paused` in der
Zustandsmaschine. Semantik: wie `stopped` **keine Prozesse, keine
Ressourcen** (Anfrage wörtlich) — aber der Editor rendert die Rollen
als **Platzhalter-Kacheln** (Rollenname + Typ, gestrichelter Rahmen,
Template-Kanten als gestrichelte Linien) im Workflow-Rahmen weiter.
Ehrlich benannt: technisch stoppt `pause` dieselben Prozesse wie
`stop` — der Unterschied ist Sichtbarkeit und Absicht („kommt
wieder", bleibt im Editor-Layout verankert; `stopped` verschwindet
von der Canvas und lebt nur in Workflows-Tab/Katalog). Resume =
normaler Start (inkl. D7-Teil-2-Vorprüfung, sobald vorhanden).
Parameterzustand über die Pause hinweg: optional automatischer
Snapshot (B7) beim Pausieren, Wiederanwenden nach dem Resume — nutzt
ausschließlich Bestehendes. Außerdem gehört hierher
`PUT /api/v1/workflows/{id}` (Update, nur in `stopped`/`paused` —
§22.3 Punkt 2 einlösen).

**d) Export/Import pro Workflow.**
`GET /api/v1/workflows/{id}/export` → `{version, name, definition
(port-genau), layoutFragment (Positionen der Rollen-Platzhalter),
parameterSnapshot?}`; `POST /api/v1/workflows/import` mit Validierung:
unbekannter `nodeType` gegen den Katalog = verständliche Ablehnung
(kein Import-Torso), Namenskollision → Suffix oder Fehler. Bewusst
getrennt vom K11-Systemexport (Nutzer/Rollen): ein Regieplatz wandert
als Datei zwischen Systemen, ohne Nutzerdaten mitzuschleppen.

**e) Workflow-Scope-AuthZ (§12 Punkt 2 vervollständigen).**
`Binding` wird um ein optionales `workflowId` erweitert: leer = wie
heute (global bzw. Node-gescoped); gesetzt + `NodeID="*"` = „darf den
ganzen Workflow bedienen"; gesetzt + konkrete Node-Rolle = exakt der
Bildmeister-Fall („nur den Bildmischer in Regieplatz 1").
Durchsetzung an den bestehenden zwei Stellen: `requireVerbOnNode`
prüft zusätzlich, ob der Ziel-Node gerade eine Rolle im gebundenen
Workflow erfüllt (Runtime-Lookup über das Workflow-Objekt);
`consoles.Resolve` löst echte Workflow-IDs/-Labels statt des Stubs
auf. Ob Workflow-`operate` auch Start/Stop erlaubt (heute global
`admin`, `server.go:197–198`): offene Frage 3 — praxisnah gibt es
beide Betriebsmodelle.

**f) Operator-Einstieg.** Nutzer mit ausschließlich
`operate`-Bindungen landen nach dem Login auf einer
**Workflow-Auswahl** (nur gebundene Workflows, als Kachel-Liste — die
schmale Vorstufe des §22.3-Katalog-Grids), nach Auswahl auf
`/console/<workflowId>`: **alle** `operate`-Rollen dieses Nutzers in
diesem Workflow als Tab-Leiste bzw. nebeneinander (die Console-Ansicht
kann Tabs bereits — „mehrere UIs bedienen (bildmischer, ograf, ..)" =
mehrere Einträge derselben Liste). Kein Graph, keine fremden Nodes —
Filterung in der Shell, Durchsetzung wie immer im Orchestrator (§12
Punkt 3). Die bestehende Kiosk-Route bleibt für
Ein-Rollen-Arbeitsplätze unverändert.

**Visueller Maßstab (Referenz-Vergleich 2026-07-15):** der
Projektinhaber hat ein Beispiel-Bedienpanel eines kommerziellen PTZ-/
Vision-Mixer-Systems gezeigt ("Bildmeister"-Layout: Tab-Leiste oben je
Gerät, gruppierte Sektionen mit betonter Kopfzeile + Trennlinie, z. B.
"AUDIO MIXER"/"TRANSITION"/"POSITION", Flächen-Gradient + Glow auf den
Tasten, PROGRAM/PREVIEW-Reihen rot/grün beleuchtet, Live-Vorschau direkt
neben den Reglern) als Zielbild für den Bildmeister/Operator-Arbeitsplatz
— **deckt sich mit dem in §3.3 bereits festgelegten Look** (Flächen-
Gradient, `box-shadow`/`inset`, K1-Zustands-Glow; K3/K4-Teil-1 liefert
das für Video-/Audiomischer bereits, s. `UMSETZUNG.md`), bestätigt also
die Richtung statt sie zu ändern. Zwei bisher nicht explizit benannte
Präzisierungen für (f), wenn mehrere Geräte-UIs auf einem Screen
zusammenlaufen:

1. **Gruppierte Sektionen statt loser Bausteine:** jedes eingebettete
   Node-UI-Bundle bekommt in der Konsolen-Ansicht einen sichtbaren
   Rahmen mit Kopfzeile (Node-Label), analog der Sektions-Optik im
   Referenzbild — bereits teilweise vorhanden (Panel-Titel), hier nur
   als bewusste Anforderung für den Mehr-Geräte-Fall festgehalten, nicht
   nur den Ein-Geräte-Fall.
2. **Zwei Tab-Ebenen sauber trennen:** die bestehende Konsolen-Tab-
   Leiste wechselt zwischen **Geräten** (Bildmischer, Audiomischer,
   OGraf, …); ein einzelnes Geräte-Bundle kann zusätzlich **eigene**
   Unterseiten haben (im Referenzbild "AT Setup · Camera · PIP · Luma ·
   Audio" für ein Gerät) — das ist Bundle-interne Navigation, keine
   neue Orchestrator-/Konsolen-Funktion, nur eine Klarstellung, damit
   künftige Bundles mit vielen Parametern (z. B. ein DVE-Detail-Flyout,
   §3.3) nicht versuchen, dafür die Konsolen-Ebene zu missbrauchen.

Kein neuer Scope-Punkt, keine offene Frage — Präzisierung von (f) für
den wörtlichen Fall "der Bildmeister sieht alle seine Geräte/Nodes/
Microservices gleichzeitig auf einem Screen".

**g) Designer auf Rollen-Ebene (§22.3 Punkt 1) bleibt Endausbau:**
Workflows ohne laufende Prozesse grafisch entwerfen (Rollen-Kacheln
aus dem Katalog ziehen, Template-Kanten zeichnen — dieselbe Canvas,
andere Datenquelle). Nach b) + c) ist der Abstand dorthin klein: das
Platzhalter-Rendering pausierter Workflows ist bereits 80 % der
Rollen-Kachel-Darstellung.

### 12.4 Phasenplan

- **Teil 1 — port-genaues Template + Update (Backend-Fundament):**
  `Connection`-Erweiterung, Label-Auflösung in `runStart`,
  `PUT /api/v1/workflows/{id}`, Sender-/Receiver-Auswahl im
  bestehenden Formular. Verifikation: Workflow „Regieplatz 1" mit drei
  `omp-source`-Rollen + einem Switcher/Mixer: Start → drei Kanten an
  drei **verschiedenen** Receivern (per `GET /api/v1/graph`
  nachgewiesen), Bildwechsel im Viewer sichtbar.
- **Teil 2 — Editor-Brücke:** „Gruppe als Workflow speichern" +
  Workflow-Rahmen um laufende Runtime-Nodes. Verifikation per CDP:
  Trias im Editor gruppieren → speichern → Workflow stoppen → starten
  → benannter Rahmen erscheint, Kanten wie im Template.
- **Teil 3 — Pause + Export/Import:** `paused`-Zustand +
  Platzhalter-Rendering + optionaler Pause-Snapshot; Datei-Export/
  -Import. Verifikation: Pause → keine Prozesse mehr (`ps`),
  Platzhalter sichtbar; Export → Delete → Import → Start → identisches
  Verhalten.
- **Teil 4 — Workflow-Scope:** `workflowId` am Binding, Durchsetzung
  im Node-Proxy, echte Workflow-IDs in `consoles`, K11-Admin-UI um die
  Scope-Spalte erweitert. Verifikation: Bildmeister-Testnutzer
  (`operate` auf Rolle „Videomischer" in „Regieplatz 1") kann
  Mixer-PATCHen, bekommt 403 auf dem Audio-Node **desselben**
  Workflows und auf dem Mixer von „Regieplatz 2".
- **Teil 5 — Operator-Einstieg:** Workflow-Auswahl nach Login +
  `/console/<workflowId>`-Mehr-Rollen-Ansicht. Verifikation per CDP:
  Login als Bildmeister → sieht genau seine Workflows → nach Auswahl
  genau seine Bedien-UIs, nie einen Graph.
- **Teil 6 (Endausbau, deckungsgleich mit §22.3):** Rollen-Designer +
  Katalog-Kachel-Grid mit Thumbnail/Suche (Mechanik in §22.3
  Punkte 5–8 bereits vollständig spezifiziert, hier nicht wiederholt).
- **D7 Teil 2** (Zeitsteuerung + Ressourcen-Vorprüfung +
  `confirm_stop`) läuft als eigener, bereits geplanter
  `UMSETZUNG.md`-Schritt — empfohlen **zwischen Teil 2 und Teil 3**,
  damit „Start" ab Teil 3 durchgängig die Vorprüfung hat.

### 12.5 Offene Fragen an den Projektinhaber

1. **Pause vs. Stop:** reicht die vorgeschlagene Unterscheidung
   (identische Ressourcen-Wirkung, unterschiedliche
   Editor-Sichtbarkeit + Snapshot-Komfort), oder soll `paused`
   zusätzlich Zustand konservieren, der bei `stopped` verfallen darf
   (z. B. Zeitpläne ausgesetzt statt gelöscht)?
2. **Export-Umfang:** Definition + Layout + Parameter-Snapshot
   (Vorschlag — ein importierter Regieplatz sieht sofort aus wie das
   Original) oder Definition pur (portabler, Empfänger startet mit
   Default-Parametern)?
3. **Darf `operate`-auf-Workflow den Workflow starten/stoppen** (die
   Regie fährt ihren Platz selbst hoch/runter), oder bleibt der
   Lifecycle bei `configure`/`admin` und Operatoren bedienen nur, was
   läuft? Heute verlangt Start/Stop global `admin`
   (`server.go:197–198`).
4. Sollen B5-Gruppen langfristig ganz im Workflow-Konzept aufgehen
   (eine Mechanik weniger), oder behalten rein visuelle Ad-hoc-Gruppen
   ohne Orchestrator-Objekt ihren eigenen Wert?
5. Operator-Einstieg bei mehreren zugewiesenen Workflows:
   Kachel-Auswahl nach jedem Login (Vorschlag) oder automatisch der
   zuletzt benutzte Workflow mit Umschalter?

---

## 13. Multi-Host-Darstellung im Flow-Editor (Host-Kacheln/-Zonen auf einer Canvas)

> „im flow editor müsste es kacheln/grid geben für die einzelnen hosts.
> alles auf einer seite. denn es könnte ja sein, dass ein node eines
> hosts mit dem node eines anderen hosts verbunden wird."
> (Der im Original folgende Verweis auf eine vergleichbare
> Cloud-Produktionsplattform wird nach `ARCHITECTURE.md`
> §20.7-Konvention nicht namentlich zitiert.)

### 13.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- Hosts sind heute eine **separate** Ansicht: App-Bar-Tab „Hosts"
  (`ui/shell/hosts-view.ts` — Tabelle mit Label/Hostname/CPU/RAM-
  Momentwert, Zeilen 96–141). Der Flow-Editor selbst weiß nichts von
  Hosts: `GraphNode` hat `instanceId`, aber **kein** Host-Feld
  (`ui/graph/flow-canvas.ts:57–66`); ein Host-Label erscheint nur in
  den Instanz-Zeilen der Palette (`flow-canvas.ts:1647–1651`), nicht
  an den Graph-Kacheln.
- **Die Zuordnung existiert serverseitig vollständig:**
  `Instance.HostID` (`internal/launcher/launcher.go:96–100`, leer =
  lokal), und der Canvas lädt Katalog + Instanzen + Hosts bereits
  parallel (`flow-canvas.ts:1564–1571`). Der Join
  `graph.instanceId → instances.hostId → hosts.label` ist reine
  Client-Arbeit — **für Teil 1 ist kein neuer Endpunkt nötig**.
- **Hostübergreifendes Verbinden geht IS-05-seitig heute schon**
  (Connections sind ortsunabhängig) — aber **medienseitig nicht
  gleichwertig:** MXL ist host-lokal (Shared Memory
  `/dev/shm/omp-mxl`, §2/§6; Kapitel 7.1 hat das für Redundanz bereits
  explizit ausgesprochen). Eine MXL-Kante zwischen zwei Hosts würde
  heute kommentarlos ins Leere laufen. Die Host-Darstellung ist also
  nicht nur Optik: sie ist die Voraussetzung, diesen Fall überhaupt
  sichtbar und warnbar zu machen — legitime Hostgrenzen-Transporte
  sind ST 2110/SRT (D4, `omp-mediaio::st2110`/`omp-srt-gateway`).
- Layout: freie Positionen + Gruppenbaum im opaken Layout-Blob
  (`flow-canvas.ts:80–89`) — keinerlei Zonen-Semantik.

### 13.2 Referenz

Kein Referenzmuster im Projekt oder in PIPELINE CONTROLLER
(Single-Host-System, dort stellt sich die Frage nicht). Vorbild ist
die Gattung „Multi-Host-Fabric-Ansicht" vergleichbarer
Cloud-Produktionsplattformen (§20.7-Konvention: kein Herstellername im
Dokument).

### 13.3 Ziel-Design

- **Host-Zonen als Hintergrund-Ebene derselben Canvas** — kein
  zweiter Editor, kein Frame-Grid: pro registriertem Host ein
  Zonen-Rechteck mit Kopfzeile (Label, Online-Punkt, CPU/RAM live —
  dieselbe Datenquelle wie `hosts-view`; nach K14 Teil 1 zusätzlich
  eine kleine Verlaufs-Sparkline). Dazu eine Zone
  „<Orchestrator-Host> (lokal)" für Instanzen ohne `hostId` und eine
  Sammelzone „Unzugeordnet" für manuell (ohne Launcher) gestartete
  Nodes ohne `instanceId` — jede Kachel liegt immer in genau einer
  Zone, nichts verschwindet.
- **Umschaltbar:** Toolbar-Toggle „Host-Ansicht". Default zunächst
  aus, bestehende Layouts bleiben unverändert gültig (Positionen
  werden beim Einschalten innerhalb der Zone des jeweiligen Hosts
  angeordnet und separat gemerkt — Ausschalten stellt das freie
  Layout wieder her). Ob die Host-Ansicht ab > 1 registriertem Host
  Default wird: offene Frage 2.
- **Kanten über Zonengrenzen** sind normal ziehbar — das ist der Kern
  des Wunsches, und funktional geht es bereits; neu ist die
  **Kanten-Klassifizierung:** eine Kante zwischen Kacheln
  verschiedener Zonen, deren Ports MXL-Format tragen, wird im
  Warn-Stil gerendert (gestrichelt, `--omp-error`, Tooltip: „MXL ist
  host-lokal — für Hostgrenzen ST-2110/SRT-Gateway (D4) einsetzen");
  ST-2110-/SRT-Kanten bleiben normal. Advisory, kein Blockieren
  (harte Durchsetzung wäre Graph-API-Arbeit und bewusst spätere
  Stufe).
- **Zusammenspiel mit K12:** Workflow-Rahmen (12.3b) und Host-Zonen
  sind orthogonale Ebenen — ein Regieplatz kann über zwei Hosts
  liegen; der Rahmen zeichnet über Zonengrenzen hinweg. Visuelle
  Schichtung: Zone = Hintergrund, Workflow-Rahmen = Overlay, Kacheln
  zuoberst.
- **Später (Teil 3):** Drag einer Kachel in eine andere Zone =
  begleiteter Umzug (Stop + Start auf dem Ziel-Host über den
  vorhandenen Remote-Launcher, mit Bestätigungsdialog;
  Placement-Advice aus D6 Teil 3 als Vorschlagsquelle) — bewusst
  nicht v1, ein versehentlicher Drag darf keinen laufenden Node
  umziehen.

### 13.4 Phasenplan

- **Teil 1 — Zonen-Rendering (eine Sitzung, kein Backend):** Zonen +
  Zuordnung + Kopfzeile mit Live-Metriken + Toolbar-Toggle.
  Verifikation: zweiten Host-Agent als Dev-Prozess mit eigener
  Host-ID registrieren (D6-Muster), Remote-Instanz starten → Kachel
  liegt in dessen Zone, CPU/RAM im Zonen-Kopf; CDP-Klick-Test:
  Toggle an/aus, freies Layout bleibt erhalten.
- **Teil 2 — Kanten-Klassifizierung + Zonen-Kollaps:**
  Transport-Erkennung aus Port-Format/IS-04-Transport, MXL-Warnstil
  über Zonengrenzen; Zone einklappbar (analog B5-Gruppe).
- **Teil 3 — Drag = begleiteter Umzug:** Bestätigungsdialog,
  Advisory-Integration (K14/D6 Teil 3), Neu-Verkabelung über den
  bestehenden Workflow-/Graph-Pfad.

### 13.5 Offene Fragen an den Projektinhaber

1. **Zonen-Anordnung:** feste vertikale Lanes nebeneinander
   (übersichtlich, ordnet sich selbst) oder frei verschieb-/
   skalierbare Rechtecke (flexibler, aber mehr Layout-Pflege)?
2. Soll die Host-Ansicht automatisch Default werden, sobald mehr als
   ein Host registriert ist?
3. Ist der begleitete Umzug per Drag (Teil 3) Teil des Zielbilds, oder
   reicht „Start auf Host X" über die Palette (existiert seit D6
   Teil 2)?
4. Bleibt der Hosts-Tab nach Teil 1 bestehen (Empfehlung: ja — als
   Detail-/Verwaltungssicht, ab K14 mit Historie), oder soll er ganz
   im Flow-Editor aufgehen?

---

## 14. Host- und Microservice-Ressourcen-Historie (Min/Ø/Max) + Start-Vorprüfung/Warnung

> „man braucht die metrics der hosts (auch bei nur einem host) damit man
> sieht ob es noch möglich ist, nodes/microservices zu starten. optimaler
> weise merkt sich der orchestrator den minimal, durchschnitt und
> maximal verbrauch laufender microservices (per host) und kann das
> beim/vor dem starten neuer microservices
> anzeigen/alarmieren/warnen/berücksichtigen."

> **Nachtrag (2026-07-17)**, direkte Antwort auf `frage an fabel.txt`
> Punkt 6 („ist unser System auf optimale Ressourcen-Sharing,
> Performance und Stabilität maximiert?"): **ehrlicher Zwischenstand,
> keine neue Frage** — die Grundlage existiert teilweise, die
> eigentliche Optimierung ist noch nicht gebaut. D6 Teil 3
> (Placement-Engine, `UMSETZUNG.md`) ist fertig, aber bewusst nur
> **advisory** (schlägt einen Ausweich-Host vor, greift nicht
> automatisch ein) — noch keine automatische Ressourcen-Optimierung,
> nur eine Empfehlung an den Menschen. Die in diesem Kapitel geplante
> Verbrauchs-Historie/Vorprüfung (unten) ist die zweite fehlende
> Hälfte: ohne sie weiß der Orchestrator vor dem Start eines neuen
> Microservice gar nicht, wie viel es typischerweise braucht.
> Stabilität hat mit dem MXL-Read-Livelock-Fix (`docs/decisions.md`,
> 2026-07-17) und dem Registry-Geist-OOM-Fix (2026-07-16) gerade zwei
> ihrer bis dahin größten bekannten Schwachstellen verloren — aber
> ohne die hier und in Kapitel 7 (Redundanz) geplanten Bausteine ist
> „maximiert" noch nicht erreicht. **Kurz: Fundament vorhanden
> (Placement-Engine, Health-Checks, Discovery), die eigentlichen
> Optimierungs-/Vorwarn-Bausteine aus diesem und dem Redundanz-Kapitel
> sind die konkrete, noch offene Antwort** — kein neuer
> Recherche-Bedarf, nur Umsetzung der bereits entworfenen Teile.

### 14.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Telemetrie ist ein Momentwert:** `Sample {cpuPercent,
  memUsedBytes, memTotalBytes}`
  (`host-agent/internal/telemetry/telemetry.go:19–23`), alle 5 s auf
  `omp.host.<id>.metrics` (`host-agent/main.go:55,131`). Der
  Orchestrator hält **nur den letzten** Wert (`hosts.Tracker` — „die
  zuletzt über NATS empfangene Telemetrie",
  `internal/hosts/tracker.go:13–16`, `Get`:41–46). **Keine Historie,
  nirgends.**
- **Pro-Instanz-Verbrauch wird nicht gemessen** — aber beide
  Startpfade kennen die PID jeder verwalteten Instanz (lokal:
  `internal/launcher/launcher.go:222`; remote:
  `host-agent/internal/commands/commands.go:108`). Eine
  `/proc/<pid>`-Messung ist damit ohne neue Infrastruktur
  anschließbar.
- **Placement-Engine (D6 Teil 3) rechnet mit Momentwerten:** bewertet
  alle 5 s (`internal/placement/placement.go:43`) den letzten Sample
  gegen statische Schwellwerte (`placement.go:77–94`) und schlägt
  Ausweichhosts vor (`Advice`, `placement.go:102–112`). Sie
  beantwortet „ist ein Host überlastet?", nicht die Frage der
  Anfrage: „passt ein weiterer Mixer noch drauf?" — dafür braucht es
  den erwarteten **Bedarf** des zu startenden Typs, den heute niemand
  kennt.
- UI: `hosts-view` zeigt den Momentwert als Tabellenzeile
  (`hosts-view.ts:100–108`).
- **D7 Teil 2** (Ressourcen-Vorprüfung vor dem Workflow-Start, §6.2
  Punkt 3) ist offen und hätte heute nur den Momentwert als
  Datengrundlage; §16 (Kapazitätsplanung über die Zeit) setzt noch
  eine Stufe später auf. Dieses Kapitel ist die Datengrundlage für
  beide — Erweiterung von D6, kein Neubau.

### 14.2 Referenz

Kein Vorbild in PIPELINE CONTROLLER (keine Host-/Prozess-Metriken im
gesamten Projekt). Projekt-intern ist der D6-Telemetrie-Pfad
(Agent → NATS → Tracker → Engine/UI) das Fundament, das hier in zwei
Richtungen verfeinert wird: Zeitachse (Historie) und Auflösung
(pro Instanz statt pro Host).

### 14.3 Ziel-Design

**a) Host-Historie im Orchestrator:** Ringpuffer pro Host neben dem
bestehenden Tracker — Rohwerte ~1 h @ 5 s, dazu 1-Minuten-Aggregate
(min/avg/max) für ~24 h. Bewusst **in-memory zuerst**: Verlust beim
Orchestrator-Neustart ist für eine Auslastungs-Sicht akzeptabel und
wird dokumentiert (Postgres-Persistenz als spätere Option, offene
Frage 2). Neue API `GET /api/v1/hosts/{id}/metrics/history?window=…`.
UI: Sparkline + Min/Ø/Max-Spalten in `hosts-view`; der
K13-Zonen-Kopf abonniert später dieselbe Quelle.

**b) Pro-Instanz-Messung (additiv im selben Payload):** Host-Agent —
und der lokale Launcher für lokal gestartete Instanzen — misst pro
verwalteter PID `/proc/<pid>/stat` (utime+stime-Delta → CPU %,
normalisiert auf Kernzahl) und `/proc/<pid>/status` (VmRSS) und hängt
`instances: [{instanceId, cpuPercent, rssBytes}]` an das bestehende
Metrics-JSON an (rein additiv — `Tracker.Touch` parst per
`json.Unmarshal`, unbekannte Felder stören heute schon nicht).
Ehrliche Grenzen von Anfang an benennen: nur Launcher-/
Agent-gestartete Prozesse (manuell gestartete Nodes haben keine
bekannte PID → tauchen in der Instanz-Sicht nicht auf, kein stilles
Raten); Kindprozesse werden nicht mitgezählt (heutige Nodes sind
Ein-Prozess-GStreamer — falls sich das ändert, ist cgroup-Messung die
saubere Folgearbeit, nicht jetzt).

**c) Verbrauchsprofile pro Node-Typ — das „merkt sich der
Orchestrator":** Aggregation der Pro-Instanz-Samples zu Profilen
`(nodeType, hostId) → {cpu: min/avg/max/p95, rss: min/avg/max,
sampleCount, updatedAt}`, persistiert in Postgres (klein — ein Upsert
pro Aggregationsintervall), damit Profile Orchestrator-Neustarts
überleben. Zusätzlich ein Typ-Fallback über alle Hosts: ein neuer
Host ohne eigene Messhistorie erbt das Typ-Profil, im UI klar als
Schätzung gekennzeichnet.

**d) Start-Vorprüfung/Warnung (advisory):** beim Instanz-Start
(Palette, `POST /api/v1/instances`) und beim Workflow-Start zeigt die
UI **vor** der Aktion die Rechnung: freie Kapazität des Ziel-Hosts
(Momentwert + Historien-Kontext, z. B. Peak der letzten Stunde) minus
erwarteter Bedarf (Profil avg…max) → Ampel ok/knapp/überbucht mit
konkreten Zahlen („omp-video-mixer-me braucht auf host-a typisch
12–18 % CPU, frei: 34 %"). Existiert noch kein Profil: ehrlich
„Bedarf unbekannt (erster Start dieses Typs)", **nie** ein stiller
Block. **Hartes Ablehnen bleibt D7-Teil-2-Scope** (§6.2 Punkt 3) —
dieses Kapitel liefert Warnstufe und Datengrundlage; sobald D7 Teil 2
existiert, rechnet dessen Vorprüfung mit denselben Profilen statt nur
mit Momentwerten (ein Rechenweg, zwei Härtegrade — dieselbe
Advisory-zuerst-Staffelung wie §6.1).

### 14.4 Phasenplan

- **Teil 1 — Host-Gesamt-Historie (kleinste präsentationswirksame
  Scheibe, eine Sitzung):** Ringpuffer + history-API +
  Sparkline/Min-Ø-Max in `hosts-view`. Verifikation: künstliche Last
  (Dev-Werkzeug oder fingierte Agent-Telemetrie wie in den D6-Tests)
  → Verlauf und Min/Ø/Max ändern sich nachvollziehbar;
  Orchestrator-Neustart leert die Kurve (dokumentiertes Verhalten,
  kein Bug).
  ✅ **Erledigt 2026-07-19** (`docs/decisions.md` Nachtrag 31) —
  zweistufiger Ringpuffer (`hosts.History`: Rohsamples ~1h, 1-Minuten-
  Aggregate ~24h), `GET /api/v1/hosts/{id}/metrics/history?window=…`,
  Sparkline + Min/Ø/Max-Spalte in `hosts-view.ts`. Live gegen einen
  echten `omp-host-agent`-Prozess verifiziert (Roh-Fenster nach ~45s,
  ein abgeschlossener Aggregat-Bucket nach realem Warten über die
  Minutengrenze hinaus) plus CDP-Browser-Check der gerenderten
  Sparkline. Teile 2–4 (Pro-Instanz-Telemetrie, Typ-Profile,
  Anbindung) bleiben offen.
- **Teil 2 — Pro-Instanz-Telemetrie:** PID-Messung in Agent +
  lokalem Launcher, additives Payload-Feld, Anzeige pro Instanz
  (hosts-view-Detail bzw. Palette-Instanzzeile).
  ✅ **Erledigt 2026-07-19** (`docs/decisions.md` Nachtrag 32) —
  `host-agent/internal/telemetry.ProcessSampler` (utime+stime-Delta aus
  `/proc/<pid>/stat`, VmRSS aus `/proc/<pid>/status`) für entfernte
  Instanzen, `launcher.Launcher.sampleLocalResources()` (identische
  Logik, eigenständiges Go-Modul) für lokale; Anzeige einheitlich in der
  Katalog-Palette (`flow-canvas.ts`, "CPU x% · RAM y MB"), nicht separat
  in `hosts-view.ts` (bewusst nur eine der beiden in §14.3b genannten
  Alternativ-Stellen). Live gegen einen echten Host-Agent-Prozess plus
  eine lokale Instanz verifiziert (CDP-Browser-Check beider
  Palette-Zeilen). Teil 3 (Typ-Profile + Start-Warnung) und Teil 4
  (Anbindung) bleiben offen.
- **Teil 3 — Typ-Profile + Start-Warnung:** Postgres-Profile,
  Ampel-Anzeige in Palette und am Workflow-Start-Knopf (advisory).
  Verifikation: zwei Mixer nacheinander starten → der zweite Start
  zeigt eine profilbasierte Schätzung statt „unbekannt", und die
  Zahlen passen zur beobachteten Last des ersten.
- **Teil 4 — Anbindung:** D7-Teil-2-Vorprüfung rechnet mit Profilen
  (harte Stufe); §16-Kapazitäts-Zeitstrahl als spätere Erweiterung
  auf derselben Datengrundlage.

### 14.5 Offene Fragen an den Projektinhaber

1. **Bestätigung der Teil-1-Schnittlinie:** Host-Gesamt-Historie
   zuerst (einfach, sofort sichtbar), pro-Microservice ab Teil 2 —
   oder ist der pro-Service-Verbrauch so zentral, dass Teil 1 + 2
   zusammen eine (größere) erste Etappe sein sollen?
2. **Historien-Tiefe/Persistenz:** reichen in-memory ~24 h
   (Empfehlung für jetzt), oder sollen die Minuten-Aggregate von
   Anfang an nach Postgres (7/30 Tage — dann braucht es eine
   Aufbewahrungs-/Aufräumregel)?
3. **Profile pro (Typ × Host) mit Typ-Fallback** (Vorschlag,
   berücksichtigt heterogene Hosts) oder nur global pro Typ
   (einfacher, ungenauer)?
4. **Warnschwellen der Ampel:** feste Defaults (Vorschlag: „knapp" ab
   erwarteter Auslastung über der Healthy-Schwelle aus D6 Teil 3,
   „überbucht" ab über der Alarm-Schwelle) — einstellbar über die
   K11-Settings-Registry?

---

## 15. Multi-Resolution-Streams (Highres + Lowres/Preview) + Workflow-Auflösungs-Settings

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 1): „MXL-Kameras (aber
> auch andere Quellen/Nodes) erzeugen in der Regel mehrere Streams,
> einen Highres, einen Lowres (als Preview) etc. Sollten das nicht auch
> unsere Nodes machen (Bildmischer, OGraf, Testquelle, Multiviewer)?
> Sollte der Bildmischer nicht für die Preview und die Vorschau auf den
> einzelnen Quell-Buttons selbst nicht die Lowres-Streams der Quellen
> nutzen (sofern verfügbar) und nur auf Programm die Highres schalten?
> Generell müssen wir pro Workflow Settings haben, welche Auflösung
> dieser haben soll."

### 15.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Jeder Node registriert genau einen MXL-Flow pro logischem
  Ausgang, in genau einer Auflösung.** `omp-mediaio::mxl::
  MxlVideoOutput::new` (`nodes/omp-mediaio/src/mxl.rs`) nimmt ein
  festes `width, height` entgegen und legt einen einzelnen
  `video_flow_def`-Flow an — nichts im Code registriert heute mehrere
  Auflösungen desselben Signals.
- **„Lowres-Preview" existiert bereits — aber als Transcode-on-Demand,
  nicht als eigener Lowres-Flow.** `omp-mediaio::preview::
  build_mjpeg_branch` (`preview.rs:156–205`) zapft die **highres**-
  GStreamer-Pipeline nach dem Decoder an
  (`videoscale ! videorate ! capsfilter ! jpegenc ! appsink`) und
  liefert MJPEG-über-HTTP. Das nutzen heute `omp-multiviewer`
  (`pipeline.rs:222`) und implizit jede UI-Kachel-Vorschau.
- **Kritisch: `omp-video-mixer-me` und `omp-multiviewer` öffnen für
  jeden Crosspoint-Eingang bzw. jede Kachel einen vollen
  Highres-`MxlVideoInput`** (`omp-video-mixer-me/src/pipeline.rs:298,
  330`; `omp-multiviewer/src/pipeline.rs:157`) — das heutige
  Downscaling passiert also **nach** vollem Empfang/Decode. Kein
  Bandbreiten- oder CPU-Vorteil auf der Empfangsseite, genau die vom
  Nutzer vermutete Lücke.
- **Kein Per-Workflow-Settings-Feld existiert.** Das `Workflow`-Struct
  (`orchestrator/internal/workflows/types.go:71–80`, D7 Teil 1) hat
  `ID, Name, Definition, Status, Error, Runtime, CreatedAt, UpdatedAt`
  — kein Konfigurations-/Settings-Feld für z. B. eine
  Ziel-Auflösung.

### 15.2 Referenz PIPELINE CONTROLLER

PIPELINE CONTROLLER ist Single-Channel-Playout ohne Mehrfach-
Auflösungs-Konzept — kein direkt übertragbares Muster hier. Das
Broadcast-Standardmuster (nicht PIPELINE-CONTROLLER-spezifisch, aber
branchenüblich und namensgebend für die Nutzerfrage) ist NMOS/IS-04
„mehrere Flows pro Source" — eine Kamera meldet z. B. einen 1080p50-
und einen 270p-Flow als zwei eigenständige, unabhängig abonnierbare
IS-04-Flows derselben Source. `ARCHITECTURE.md` §5 (Node-Contract)
kennt das Konzept „Sender" bereits als Liste — ein zweiter Sender pro
Node für die Lowres-Variante ist strukturell kein Bruch, nur bisher
nirgends genutzt.

### 15.3 Ziel-Design

**a) Zweiter, echter MXL-Flow statt Transcode-on-Demand.** Nodes, die
Video ausgeben (`omp-source`, `omp-video-mixer-me`s PGM-Ausgang,
`omp-ograf`s Fill+Key, `omp-player`), bekommen optional einen zweiten
`MxlVideoOutput` in fester, kleiner Auflösung (Vorschlag: 320×180 oder
konfigurierbar), gespeist vom selben GStreamer-Zweig wie der
bestehende MJPEG-Preview-Branch (`preview.rs`s `videoscale`-Tap wird
zur Quelle für einen zweiten MXL-Sender statt/zusätzlich zu MJPEG) —
kein zweiter Encode-Pfad, nur ein zweiter Sender-Ausgang derselben
bereits vorhandenen herunterskalierten Daten.
**b) Bildmischer/Multiviewer lesen bevorzugt lowres.** Crosspoint-
Button-Vorschauen und Multiviewer-Kacheln öffnen — falls der Quell-Node
einen Lowres-Sender meldet (per IS-04-Flow-Discovery erkennbar,
`urn:x-nmos:tag:grouphint` o. ä. als Kennzeichnung „gehört zu
Highres-Flow X, ist die Lowres-Variante") — einen `MxlVideoInput` auf
den Lowres-Flow statt auf Highres; nur der tatsächlich auf **Programm**
geschaltete Eingang öffnet zusätzlich (oder nur dann) den Highres-Flow.
Rückfall: Quelle ohne Lowres-Sender → wie heute Highres + Downscale.
**c) Workflow-Auflösungs-Setting.** `Workflow`-Struct bekommt ein
`Settings`-Feld (JSON/Postgres-`jsonb`, additiv, kein Node-Contract-
Thema) mit mindestens `programResolution` (die „eingestellte"
Auflösung aus der Nutzerfrage, heute implizit 640×480 fest in mehreren
Nodes verdrahtet) und `previewResolution`. Node-Start-Parameter für
Auflösung werden beim Workflow-Start aus diesem Setting befüllt statt
wie heute pro Node-Typ hartkodiert.

### 15.4 Phasenplan

- **Teil 1 — Workflow-Auflösungs-Setting:** `Settings`-Feld am
  Workflow-Objekt, UI-Eingabe beim Workflow-Anlegen, Node-Start
  übernimmt `programResolution` statt fester Werte. Kleinster,
  unabhängig verifizierbarer Schritt (heutige feste 640×480-Nodes
  laufen unverändert weiter, nur jetzt aus Settings gespeist).
  ✅ **Orchestrator/UI-Infrastruktur + `omp-source` erledigt
  2026-07-17** (`UMSETZUNG.md`, `docs/decisions.md` Nachtrag 7) —
  `Definition.Settings{ProgramWidth,ProgramHeight}`,
  `launcher.Launcher.Start` bekommt ein `extraEnv`-Argument (nur lokal
  wirksam, s. dortige Doku zur Remote-Sicherheitsgrenze),
  `workflows.Service.runStart` speist `OMP_WIDTH`/`OMP_HEIGHT` daraus,
  Workflow-Anlegen-Formular hat neue Auflösungs-Felder. **Größer als
  ursprünglich als „kleinster Schritt" eingeschätzt:** `WIDTH`/`HEIGHT`
  sind in jedem betroffenen Node ein `pub const`, das direkt in
  Caps-Konstruktion und MXL-Flow-Registrierung einfließt (bei
  `omp-video-mixer-me` zusätzlich in laufzeit-gesetzten Pad-
  Properties) — kein reiner Konfigurationswert, sondern ein
  Refactoring pro Node. Deshalb bewusst **nur `omp-source`** (die vom
  Nutzer selbst genannte „Testquelle") vollständig umgesetzt und
  live bis zur tatsächlichen IS-04-Flow-Registrierung verifiziert
  (960×540 statt 640×480 bestätigt); `omp-switcher`, `omp-player`,
  `omp-video-mixer-me` brauchen denselben, jetzt etablierten
  Handgriff (env lesen → `Config`-Feld → Konstante an den
  entsprechenden Stellen ersetzen) als direkte Folgearbeit, kein
  stiller Gap. `omp-ograf` bewusst ausgenommen: seine 1280×720 sind an
  die OGraf-Template-Gestaltung gebunden, keine generische
  Testauflösung — eine Workflow-Auflösung würde dort Templates verzerren,
  nicht nur reskalieren.
  ✅ **`omp-switcher`, `omp-player`, `omp-video-mixer-me` nachgezogen
  2026-07-18** (`docs/decisions.md` Nachtrag 30) — derselbe Handgriff,
  bei `omp-video-mixer-me` zusätzlich die dort laufzeit-abgeleiteten
  Keyer-Pad-Properties (vorher `const KEYER_WIDTH`/`HEIGHT`) und
  `DveBox::full_frame()` umgestellt; live per NMOS-Query (alle vier
  Video-Flows bei `OMP_WIDTH=800`/`OMP_HEIGHT=600` korrekt registriert)
  und `GET /params/dve.box` verifiziert. **Teil 1 damit vollständig.**
- **Teil 2 — Zweiter MXL-Sender in `omp-mediaio::mxl`:** optionaler
  Lowres-`MxlVideoOutput`, gespeist vom bestehenden Downscale-Zweig,
  als IS-04-Flow der Highres-Quelle zugeordnet (Grouphint-Tag).
  Verifikation: `mxl-info -g` zeigt zwei Flows pro Quelle, beide mit
  Daten.
  ✅ **Erledigt 2026-07-19** (`docs/decisions.md` Nachtrag 37, in
  `omp-source` als Pilot-Node wie schon Teil 1) — Nutzerentscheidung:
  feste 320×180 statt konfigurierbar, **nur bei aktivem Vorschau-Bedarf
  zugeschaltet** statt immer mitlaufend (aufwendigere der beiden §15.5-
  Optionen). `urn:x-nmos:tag:grouphint/v1.0` gegen die echte AMWA-
  Registry verifiziert (Sender-Tag, nicht Flow/Source, abweichend von
  der ungenauen Doku-Formulierung hier). Referenzgezählte
  `activateLowresPreview`/`releaseLowresPreview`-Methoden schalten den
  bereits vorhandenen `MxlVideoOutput`-Valve — der Sender ist ab
  Node-Start immer IS-04-sichtbar (SDK kennt keine nachträgliche
  Registrierung), aber ohne Aktivierung werden nachweislich keine
  Grains geschrieben (`Head index` blieb über 2s bei 0). Live
  verifiziert: Aktivierung/Freigabe/Referenzzählung/Unterlauf-Schutz,
  Highres-Flow lief währenddessen ununterbrochen weiter.
- **Teil 3 — Bildmischer/Multiviewer lesen lowres.** Crosspoint-/
  Kachel-Vorschau-Reader wählen bevorzugt den Lowres-Flow; PGM-Pfad
  bleibt highres. Verifikation: RSS/CPU-Vergleich Vorher/Nachher bei
  N gleichzeitigen Vorschau-Kacheln (erwartete, messbare Senkung).
  ✅ **Teilweise erledigt 2026-07-19** (`docs/decisions.md` Nachtrag
  38) — `omp-multiviewer` als Pilot (reiner Monitor, kein PGM-/
  Preview-Unterschied wie beim Mischer, daher einfacherer erster
  Fall): Discovery baut eine Grouphint-Gruppen-Map, aktiviert/gibt den
  Lowres-Sender der jeweiligen Quelle über einen direkten Node-zu-
  Node-HTTP-Aufruf frei (`omp-node-sdk::peer::PeerClient`, neu ins SDK
  gehoben — Präzedenzfall bereits in `omp-playout-automation`
  gefunden, nicht erfunden), `MxlVideoInput` öffnet den Lowres- statt
  Highres-Flow. Live verifiziert: `mxl-info` zeigte aktives Lesen des
  Lowres- statt des Highres-Flows, der MJPEG-Vorschau-Stream lieferte
  echte, visuell bestätigte Frames. `omp-video-mixer-me`/
  `omp-switcher` (PGM-Pfad muss highres bleiben, komplexer) bleiben
  offen, ebenso ein Graceful-Release beim Multiviewer-Shutdown
  (dokumentierte, bewusste Lücke).
- **Teil 4 — `omp-ograf`/`omp-player` als weitere Lowres-Quellen**
  (Analogie zu Teil 2, pro Node einzeln nachziehbar).
  ✅ **`omp-player` erledigt 2026-07-19** (`docs/decisions.md`
  Nachtrag 39) — neuer `tee` zwischen `video_isel` und dem bisherigen
  `MxlVideoOutput` (anders als `omp-source`, das schon einen `tee`
  hatte), sonst identisches Muster; im Jingle-Profil (kein
  Video-Ausgang) bleibt der Lowres-Sender korrekt ganz weg. Live
  verifiziert, inkl. eines Generalisierungs-Bonus: eine echte
  `omp-multiviewer`-Instanz (Teil 3) entdeckte und nutzte den neuen
  Player-Lowres-Sender automatisch, ganz ohne player-spezifischen Code
  in `omp-multiviewer` — bestätigt, dass die Grouphint-Discovery aus
  Teil 3 tatsächlich producer-agnostisch ist. `omp-ograf` bleibt offen
  (Design-Frage: Lowres-Fill allein oder auch Lowres-Key? nicht im
  Dokument entschieden, nicht geraten).

### 15.5 Offene Fragen an den Projektinhaber

1. ✅ **Entschieden 2026-07-19:** feste Lowres-Zielauflösung, 320×180
   (Empfehlung übernommen) — s. `docs/decisions.md` Nachtrag 37.
2. ✅ **Entschieden 2026-07-19:** nur bei aktivem Vorschau-Bedarf
   zugeschaltet (nicht die empfohlene "immer mitlaufen"-Option) —
   referenzgezählte `activate`/`release`-Methoden umgesetzt und live
   verifiziert, s. `docs/decisions.md` Nachtrag 37.
3. Reihenfolge relativ zu Kapitel 16 (Inter-Host-Fabrics): unabhängig,
   kann parallel/davor laufen — Bestätigung, keine echte Abhängigkeit
   gefunden.

---

## 16. Inter-Host-Medientransport jenseits ST 2110/SRT — MXL-native Fabrics (Remote Memory Access)

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 3): „wir haben derzeit
> 2110 über SRT als Inter-Host-Connection. Das ist gut und soll als
> Option erhalten bleiben. Aber Ziel muss es sein, Remote Memory Access
> zwischen den Hosts zu nutzen — erstens wegen der Latency, und damit
> wir alle Quellen/Senken/Nodes aller Hosts z. B. in einem Regieplatz/
> Bildmischer nutzen können. Klar können wir das jetzt nicht am
> Chromebook testen, aber es muss vollständig implementiert sein. (Oder
> kann man es eventuell doch irgendwie testen?)"

### 16.1 Ist-Zustand — zwei unreconciled Pläne, eine wichtige Neuigkeit

**`ARCHITECTURE.md` §6.6 plant bereits ein RDMA/RoCEv2-Modul** — ein
eigenes, von MXL unabhängiges `omp-mediaio`-Transportmodul auf Basis
von `rdma-core`/`libibverbs`, mit eigenem `transportHint`/
`rdmaFabricId`-Platzierungs-Claim. Dieser Plan setzt **echte
RDMA-Hardware (RoCEv2-NICs) für jeden echten Test voraus** — exakt der
Punkt, an dem die Nutzerfrage „kann man das am Chromebook testen"
ansetzt, und den §6.6 bisher mit „nur simuliert über Tags" beantwortet.

**Neue, bisher nirgends dokumentierte Erkenntnis: MXL selbst bringt
bereits eine fertige, alternative Lösung mit — vendored, aber
unbenutzt.** `third_party/mxl/lib/fabrics/ofi/` ist eine eigenständige
Bibliothek `mxl-fabrics`, die **libfabric** (die OFI-Standard-
Abstraktion für RDMA-fähige Transporte, kein MXL-Eigenbau) kapselt.
`tools/mxl-fabrics-demo/demo.cpp` ist ein vollständiges (kein Stub!)
Initiator/Target-Werkzeug: ein Initiator schreibt per **echtem
One-Sided-RDMA-Write** die Shared-Memory-Regionen eines Flow-Readers
(`mxlFabricsRegionsForFlowReader`/`mxlFabricsInitiatorSetup`) direkt in
die passenden Regionen eines Targets auf einem **anderen Host** — also
echter Zero-Copy-Remote-Memory-Zugriff über Hostgrenzen hinweg, genau
das vom Nutzer gewünschte Ziel, nicht nur RDMA dem Namen nach.

**Direkte Antwort auf „kann man es testen":** Ja. `mxl/fabrics.h:50–57`
definiert `mxlFabricsProvider` mit `MXL_SHARING_PROVIDER_TCP` neben
`VERBS`/`EFA`/`SHM` — libfabrics `tcp`-Provider ist eine reine
Software-Implementierung, **keine RDMA-NIC nötig**. `mxl-fabrics-demo
--provider tcp` läuft über normales Ethernet/Loopback, also auch auf
dem Chromebook/in Crostini — funktional vollständig testbar, nur ohne
die Hardware-DMA-Beschleunigung/niedrigste Latenz echter RDMA-NICs.

**Aktueller Baustatus:** `CMakeLists.txt:17`:
`option(MXL_ENABLE_FABRICS_OFI "..." OFF)` — standardmäßig **aus**,
`deploy/dev/install-mxl.sh` überschreibt das nicht, also ist
`mxl-fabrics`/`mxl-fabrics-demo` in diesem Repo aktuell **nicht**
gebaut. Nötig: `-DMXL_ENABLE_FABRICS_OFI=ON` + `libfabric-dev`
(`apt-cache policy` bestätigt: direkt aus dem bereits konfigurierten
Debian-Bookworm-Repo verfügbar, Kandidat 1.17.0-3, keine
Vcpkg-/Custom-Build-Hürde) — nicht installiert, aber ein einzeiliger
`apt install`.

### 16.2 Referenz PIPELINE CONTROLLER

Nicht einschlägig — Single-Box, kein Mehr-Host-Konzept.

### 16.3 Ziel-Design — Empfehlung: MXL-native Fabrics statt eigenem RDMA-Modul

**Empfehlung (vom Projektinhaber zu bestätigen, s. 16.5):** §6.6s
eigenständiges `rdma-core`-Modul **nicht** parallel weiterverfolgen,
sondern **MXLs eigene Fabrics-Bibliothek als Inter-Host-Transport
integrieren**. Begründung:

- Weniger Code/Wartung: kein eigener RDMA-Stack, sondern eine bereits
  vendorte, vom MXL-Projekt selbst gepflegte Bibliothek nutzen —
  gleiche Begründung wie „MXL statt eigenem Zero-Copy-Transport" aus
  C4 (`docs/decisions.md` 2026-07-09).
- **Sofort testbar** ohne Sonder-Hardware (TCP-Provider) — löst genau
  den vom Nutzer benannten Chromebook-Einwand, den §6.6 bisher offen
  ließ.
- Gleicher Ziel-Nutzen: „alle Quellen/Senken aller Hosts in einem
  Regieplatz nutzen" — Fabrics arbeitet auf Flow-Ebene (dieselbe
  Abstraktion wie die heutigen `MxlVideoInput`/`Output`), lässt sich
  also als dritte `omp-mediaio`-Transport-Variante neben RTP/ST2110
  einreihen, mit demselben `Output`-Trait.
- Migrationspfad zu echter RDMA-Hardware bleibt erhalten: derselbe
  Code, späterer Wechsel `--provider tcp` → `--provider verbs`
  (RoCEv2) ist eine Konfigurationsfrage, kein Architektur-Wechsel —
  §6.6s Hardware-Beschleunigungsziel bleibt damit erreichbar, nur über
  einen anderen Unterbau.

**Konkretes Design:** neues `omp-mediaio::fabrics`-Modul (Feature-Flag
`fabrics`, analog zum bestehenden `mxl`-Feature), das pro Flow einen
`FabricsInitiator`/`FabricsTarget` analog zu `MxlVideoInput`/`Output`
anbietet. Placement-Claim: neues `transportHint: "fabrics"` +
`fabricsProvider: tcp|verbs|efa` pro Workflow-Rolle (wiederverwendet
§6.1s bestehendes Claim-Schema, keine neue Modellierung). ST-2110/SRT
(D4) bleibt als Fallback/Standard-Option unverändert bestehen — die
Nutzerfrage sagt explizit „soll als Option erhalten bleiben."

### 16.4 Phasenplan

- **Teil 0 — Build aktivieren + Spike.** ✅ **Erledigt 2026-07-19**
  (`docs/decisions.md` Nachtrag 41-43). Größer als der ursprünglich
  veranschlagte „eine Sitzung, wie K5-Teil-0": Debian Bookworms
  `libfabric-dev` (1.17.0) ist zu alt für MXLs vendorten Fabrics-Code
  (braucht die libfabric-2.x-API) — libfabric 2.6.0 aus Quellcode
  vendort (`third_party/libfabric`, analog zu MXL selbst). Zweiter,
  tieferer Fund: MXLs eigene Fabrics-C-API war im gepinnten Tag
  `v1.0.1` eine reine Stub-Implementierung; MXL projektweit auf
  `v1.1.0-beta-1` angehoben (Nutzerentscheidung, mit vollem
  Regressionstest gegen bestehende MXL-Pfade, nicht nur den
  Fabrics-Teil). `mxl-fabrics-demo` über `--provider tcp` zwischen zwei
  Prozessen auf demselben Host (zwei MXL-Domains) verifiziert: echter
  One-Sided-RDMA-Transfer eines SMPTE-Testbild-Flows, Head-Index in der
  Zieldomain kontinuierlich wachsend, keine RDMA-Hardware nötig.
- **Teil 1 — `omp-mediaio::fabrics`-Grundmodul:** ein Flow, ein Host-
  Paar, TCP-Provider, `Output`-Trait-Implementierung analog C4.
  Verifikation: zwei `MxlContext`-Domains auf verschiedenen TCP-Ports/
  Netzwerk-Namespaces (Software-Simulation von „zwei Hosts" auf einer
  Maschine, wie in Teil 0) — Frame kommt über Fabrics an.
- **Teil 2 — Placement-Integration:** `transportHint`/
  `fabricsProvider`-Claim, Orchestrator wählt Fabrics vs. ST2110/SRT
  pro Rolle.
- **Teil 3 — echte Mehr-Host-Verifikation:** sobald zwei physische
  Hosts verfügbar sind (auch ohne RDMA-NIC, TCP-Provider reicht für
  Funktionsnachweis) — Latenzvergleich gegen den bestehenden SRT-Pfad.
- **Teil 4 (fest eingeplant, nicht optional — s. 16.5.3):**
  `verbs`/`efa`-Provider mit echter RoCEv2-Hardware; Hardware-
  Beschaffung für Regelbetrieb ist bereits entschieden, dieser Teil
  folgt sobald sie verfügbar ist — reine Konfigurationsänderung laut
  16.3, kein Architekturwechsel.

### 16.5 Offene Fragen an den Projektinhaber

1. **Grundsatzentscheidung — ENTSCHIEDEN (2026-07-17, s.
   `docs/decisions.md` Nachtrag 9):** MXL-native Fabrics (Empfehlung
   oben) statt des in `ARCHITECTURE.md` §6.6 skizzierten
   eigenständigen `rdma-core`-Moduls. `ARCHITECTURE.md` §6.6 wurde
   entsprechend umgeschrieben. Umsetzung: Teil 0 ✅ erledigt
   2026-07-19 (s. 16.4), Teil 1 ist der nächste Schritt.
2. Priorität relativ zu Kapitel 15 (Multi-Res) und den übrigen
   `frage an fabel.txt`-Punkten — s. Kapitel 18 (konsolidierte
   Priorisierung), dort als niedrigere Priorität eingeordnet
   (Begründung dort).
3. **Hardware-Ausblick — ENTSCHIEDEN (2026-07-17):** echte
   RoCEv2-Hardware ist für den Regelbetrieb fest eingeplant, der
   TCP-Software-Provider ist ausdrücklich nur Übergangslösung für
   Demo-/Testphasen. Kapitel 16.4 Teil 4 (`verbs`/`efa`-Provider) ist
   damit fester, nicht optionaler Phasenplan-Punkt, kein „falls
   Hardware verfügbar".

---

## 17. Node-/Microservice-Katalog: Beschreibungen, Ressourcen-Sicht, Alarm-View, Import fremder Microservices

> Nutzer-Feedback (`frage an fabel.txt`, Punkt 6, zweiter „6)"): „die
> Microservice/Node-Katalog ist im UI noch nicht schön. Es fehlen noch
> Beschreibungen, die vermuteten Ressourcen, unterschiedliche Tabs oder
> so, wo man sieht was alles gerade läuft (und Metrics/Alarme),
> generell ein Alarm-View, zum Launchen und das Importieren/
> Versionieren/Löschen von Microservices (wenn ein Drittanbieter/die
> Community — aber auch wir selbst — ein Microservice liefert, möchte
> ich das importieren können)."

### 17.1 Ist-Zustand in OMP (Code gelesen, nicht angenommen)

- **Katalog heute minimal.** `ui/shell/workflows-view.ts:13–16`s
  `CatalogEntry` kennt nur `type`/`label`. Backend
  `orchestrator/internal/launcher/catalog.go:20–27` lädt eine statische
  `deploy/catalog.json` mit `Type, Label, Runner, Command, Env` — kein
  Beschreibungsfeld, kein Ressourcen-Feld.
- **Kein „was läuft gerade + Metrics/Alarme"-Tab** getrennt vom
  Workflow-Editor; kein genereller Alarm-View.
- **Nur ein Runner: lokaler Prozess.** `catalog.go:14–16` kommentiert
  das Runner-Feld bereits als „bewusst offen" für einen künftigen
  `"podman"`-Runner — **nicht gebaut**. Jeder Node ist heute ein
  Cargo-Workspace-Mitglied unter `nodes/`, `deploy/catalog.json`
  verweist auf lokal vorgebaute Binärpfade.
- **Ressourcen-Anzeige ist bereits vollständig als Kapitel 14 geplant**
  (Ringpuffer-Historie, Pro-Instanz-Telemetrie, Typ-Profile,
  Start-Ampel) — **nicht** neu zu entwerfen, siehe dort. Was Kapitel 14
  **nicht** abdeckt: Beschreibungstext, ein eigener „laufende
  Instanzen"-Tab mit Metrics/Alarmen zusammen, ein genereller
  Alarm-View, Import/Versionierung/Löschen.
- **Kein Beschreibungsfeld im Descriptor.** `omp-node-sdk/src/
  descriptor.rs` (A8, Self-Describe) ist ein **Laufzeit**-Deskriptor
  (nach dem Start abgefragt) ohne Beschreibungsfeld — ungeeignet für
  eine Katalog-**Vorschau** vor dem Start; dafür braucht es ein
  separates, statisches Katalog-Metadatenfeld (Beschreibung gehört
  logisch zum Katalog-Eintrag, nicht zur Laufzeit-Instanz).

### 17.2 Referenz

Nicht direkt PIPELINE-CONTROLLER-Terrain (dort kein Microservice-
Katalog, Single-Binary). Branchenübliches Vorbild für „Beschreibung +
Ressourcenschätzung + Versionierung + Import" ist eher ein
Paketmanager-/App-Store-Muster (z. B. Kubernetes-Helm-Charts, Docker-
Hub-Images mit README+Tags) als ein Broadcast-spezifisches Vorbild —
hier gibt es kein „nicht neu erfinden"-Vorbild im Projektumfeld, das
Design muss eigenständig entworfen werden.

### 17.3 Ziel-Design

**a) Statische Katalog-Metadaten (klein, sofort machbar).**
`deploy/catalog.json`-Einträge bekommen `description` (Freitext) und
optional `expectedResources` (grober Vorab-Schätzwert, bevor Kapitel
14s Typ-Profile genug Messwerte gesammelt haben — „vermutete
Ressourcen" aus der Nutzerfrage wörtlich). UI: Katalog-Kacheln zeigen
Beschreibung + Icon/Kategorie statt nur `label`.

**b) „Laufende Instanzen"-Tab mit Metrics/Alarmen (baut auf Kapitel
14).** Neue Ansicht (dritter Tab neben Flow-Editor/Workflows/Hosts aus
§1.3b, oder Unterreiter von Hosts) — pro laufender Instanz: Status,
Kapitel-14-Ressourcenwerte, Crash-/Restart-Zähler (Kapitel 7 §7.3a).
**c) Genereller Alarm-View.** Sammelt alle bereits existierenden
Fehler-/Warn-Signale an einer Stelle statt verteilt: `instance.crashed`
(bereits vorhanden), Kapitel-14-Ressourcen-Ampel, künftig
`instance.restarted`/Crash-Loop (Kapitel 7). Kein neuer
Alarm-**Erzeuger** nötig — nur ein neuer, zentraler **Konsument** der
bereits über NATS laufenden Events.
**d) Import/Versionierung/Löschen fremder Microservices — bewusst als
eigene, größere Ausbaustufe markiert.** Das ist architektonisch die
größte der sechs Fragen: braucht (i) einen Runner jenseits `"process"`
(Container-Image, `catalog.go`s bereits vorgesehener `"podman"`-Runner
— am wenigsten neue Infrastruktur, da Podman/Quadlets bereits
Kern-Baustein der Plattform sind, A2/A3), (ii) eine
Katalog-**Schreib**-API (`POST /api/v1/catalog` statt der heutigen
statischen Datei), (iii) eine Versions-/Vertrauensfrage (Signatur?
Nur-lokal-Import ohne Signaturprüfung als v1-Kompromiss?), (iv) eine
Löschen-Semantik (nur wenn keine laufende Instanz mehr referenziert).
**Empfehlung:** v1 klein halten — Import = lokaler Podman-Image-Pfad/
Tag in der Katalog-Schreib-API eintragen, keine Signaturprüfung, keine
Remote-Registry-Anbindung; das deckt „ich möchte importieren können"
bereits ab, ohne eine vollständige Trust-/Registry-Architektur vorweg
zu bauen.

### 17.4 Phasenplan

- **Teil 1 — Beschreibung + vermutete Ressourcen im Katalog (klein,
  sofort):** `catalog.json`-Schema erweitern, UI zeigt es an.
- **Teil 2 — Laufende-Instanzen-Tab:** baut direkt auf Kapitel-14-
  Datenmodell, keine neue Backend-Logik.
  ✅ **Erledigt 2026-07-19** (`docs/decisions.md` Nachtrag 33) — fünfter
  App-Bar-Tab „Instanzen" (`ui/shell/instances-view.ts`), reiner
  Konsument von `GET /api/v1/instances` (inkl. Kapitel-14-Teil-2-Feldern)
  + `GET /api/v1/hosts` (Host-Label-Auflösung); 5s-Poll statt der
  sonstigen 30s-SSE-Fallback-Kadenz, da CPU%/RSS keinen eigenen
  SSE-Event-Trigger haben. Live per CDP verifiziert, inkl. eines echten
  Crash→Auto-Restart-Zyklus (`kill -9`), der ohne Reload in der Tabelle
  ankam.
- **Teil 3 — Alarm-View:** zentraler NATS-Event-Konsument + UI-Liste,
  baut auf bereits existierenden Events.
- **Teil 4 — Podman-Runner + Katalog-Schreib-API (Import/Löschen):**
  größter Teil, eigene Sitzung(en), da neue Ausführungs-/
  Sicherheits-Fläche.
- **Teil 5 — Versionierung:** mehrere Versionen desselben Typs
  parallel im Katalog, Instanz merkt sich ihre Version — nur relevant,
  sobald Teil 4 existiert.

### 17.5 Offene Fragen an den Projektinhaber

1. Ist der Podman-Runner (Teil 4) tatsächlich gewünschter Umfang für
   „importieren", oder reicht vorerst nur ein weiterer lokal gebauter
   Binärpfad (kein Containerisierungs-Sprung, deutlich kleinerer
   Aufwand, aber kein echter Fremd-Microservice-Import ohne
   gemeinsame Build-Toolchain)?
2. Vertrauensmodell für importierte Microservices: gar keine Prüfung
   (v1-Vorschlag, Risiko liegt beim Bediener) oder von Anfang an eine
   Mindestprüfung (z. B. Node-Contract-Konformitätstest aus C9 als
   Aufnahme-Voraussetzung)?
3. Reihenfolge relativ zu Kapitel 14 — Bestätigung: Teil 1–3 hier
   können vor, während oder nach Kapitel 14 laufen (Datenmodell-
   Abhängigkeit nur für Teil 2), keine harte Blockade in beide
   Richtungen.

---

## 18. Konsolidierte Priorisierung — `frage an fabel.txt` (2026-07-17)

Alle sechs (tatsächlich sieben, da Punkt 6 im Original doppelt
nummeriert war) Punkte aus `frage an fabel.txt` sind jetzt in Kapitel
1.6, 4.6, 7.6, 14 (Nachtrag), 15, 16, 17 ausgearbeitet. Diese Liste ist
die vom Projektinhaber angeforderte Priorisierung („ordne nach deiner
Priorität") mit kurzer Begründung — Details in den jeweiligen
Kapiteln, nicht hier wiederholt.

1. **§1.6 — Property-Panel-Breite + „Als Operator ansehen"-Button.**
   ✅ Erledigt 2026-07-17 (`UMSETZUNG.md`). Kleinster Aufwand, beide
   Design-Fragen bereits vollständig durch Code-Lesen geklärt (kein
   offener Rechercheposten mehr), direkter Treffer auf die
   Nutzer-Vorgabe „achte auf ein schönes UI" — sofort umsetzbar, keine
   Abhängigkeiten.
2. **§7.6/K7-Teil-1 — Prozess-Auto-Restart + stabile Konsolen-Rolle.**
   ✅ K7-Teil-1 (Prozess-Auto-Restart, Crash-Loop-Bremse, automatische
   IS-05-Wiederverkabelung, Restart-Zähler im UI) erledigt 2026-07-17
   (`UMSETZUNG.md`, `docs/decisions.md` Nachtrag 3) — live per
   `kill -9` gegen einen echten Workflow verifiziert, dabei einen
   echten Bug bei noch nicht abgelaufenen alten NMOS-Registrierungen
   gefunden und gefixt. Die „stabile Konsolen-Rolle" aus §7.6 (die
   Operator-Konsolen-Route selbst über einen Prozesswechsel hinweg
   stabil auflösen) ✅ **erledigt 2026-07-19** (`docs/decisions.md`
   Nachtrag 34) — Client löst `/api/v1/me/consoles` jetzt SSE-first mit
   Poll-Fallback live neu auf und remountet eine bereits offene Konsole
   automatisch, wenn sich die dahinterliegende Node-ID ändert (Restart);
   live mit `kill -9` gegen einen echten `nodes/mock`-Prozess per
   CDP-Netzwerk-Trace ohne Seiten-Reload bestätigt. §7.6 damit
   vollständig.
3. **§17 Teil 1–3 — Katalog-Beschreibungen + Laufende-Instanzen-Tab +
   Alarm-View.** Sichtbarer UI-Qualitätssprung, baut überwiegend auf
   bereits vorhandenen Daten/Events, kein Architektur-Risiko. Teil 4/5
   (Import) bewusst zurückgestellt (siehe dort).
   ✅ **Teil 1 (Beschreibungen + vermutete Ressourcen) erledigt
   2026-07-17** (`UMSETZUNG.md`, `docs/decisions.md` Nachtrag 4) —
   `CatalogEntry.Description`/`ExpectedResources` (Freitext, additiv,
   optional), `deploy/catalog.json` für alle zehn Einträge befüllt,
   Katalog-Palette zeigt beides sichtbar unter jedem Eintrag statt nur
   im Tooltip.
   ✅ **Teil 2 (Laufende-Instanzen-Tab) erledigt 2026-07-19**
   (`docs/decisions.md` Nachtrag 33, direkt im Anschluss an Kapitel 14
   Teil 1+2 in derselben Sitzung) — fünfter App-Bar-Tab „Instanzen",
   reiner Konsument von `GET /api/v1/instances`/`GET /api/v1/hosts`,
   kein neuer Backend-Code. Live per CDP inkl. eines echten
   `kill -9`-Crash/Auto-Restart-Zyklus verifiziert.
   ✅ **Teil 3 (Alarm-View) erledigt 2026-07-17** (`UMSETZUNG.md`,
   `docs/decisions.md` Nachtrag 5) — neuer vierter App-Bar-Tab
   „Alarme" (`ui/shell/alarm-view.ts`), zentraler Konsument dreier
   bereits bestehender Endpunkte (`/api/v1/instances`
   crashed/restartCount, `/api/v1/placement/advice`,
   `/api/v1/workflows` status „failed") — kein neuer Alarm-Erzeuger,
   wie im Ziel-Design gefordert. Bewusst **additiv statt ersetzend**:
   `hosts-view.ts`s Placement-Advice-Banner bleibt zusätzlich bestehen
   (kontextuell sinnvoll dort), Abwägung dokumentiert. Mit Teil 1-3 jetzt
   alle drei kleinen Teile dieses Punkts erledigt, nur Teil 4/5 (Import)
   bleiben wie geplant zurückgestellt.
4. **§4.6 — Audio-Mixer EQ-Parametrisierung + Dynamik (Kapitel-4-
   Teil-2, jetzt inkl. EQ-Upgrade).** Klar umrissene Node-
   Vervollständigung auf bestehendem Plan, kein neues Konzept.
   ✅ **EQ-Parametrisierung + Kompressor (Kanal) + Limiter (Master)
   erledigt 2026-07-17** (`UMSETZUNG.md`, `docs/decisions.md` Nachtrag
   6) — `equalizer-3bands` → `equalizer-nbands` (Frequenz+Bandbreite
   je Band, per Live-Introspektion verifiziert), `audiodynamic` pro
   Kanal + auf dem Master-Bus, je mit eigenem Makeup-Gain-`volume`-
   Element (kompensiert die fehlende Makeup-Eigenschaft von
   `audiodynamic`, §4.6-Realitätscheck).
   ✅ **Audio-Follow-Video-Pegel erledigt 2026-07-19**
   (`docs/decisions.md` Nachtrag 35) — konfigurierbarer, hörbarer
   „Aus"-Pegel statt nur Mute/Unmute, live mit einem echten NATS-
   Tally-Event + realer `/levels`-Messung verifiziert. **Noch offen aus
   §4.6:** Mixer-Presets (Snapshot-Wiederverwendung) — nicht Teil
   dieses Schritts, bewusst zurückgestellt, kein stiller Gap.
5. **Kapitel 15 — Multi-Resolution-Streams.** Hoher Nutzwert (Bandbreite/
   CPU bei realen Mehrquellen-Setups), aber cross-cutting (mehrere
   Nodes + Workflow-Objekt) — nach den kleineren, unabhängigen Punkten
   oben eingeordnet, nicht weil weniger wichtig, sondern weil größer.
   Teil 1 ✅ 2026-07-17/18, Teil 2 ✅ 2026-07-19
   (`docs/decisions.md` Nachtrag 37) — referenzgezählter Lowres-
   MXL-Sender in `omp-source`, live verifiziert. Teil 3 ✅ teilweise
   2026-07-19 (Nachtrag 38) — `omp-multiviewer` liest bevorzugt
   lowres, live verifiziert; `omp-video-mixer-me`/`omp-switcher` noch
   offen. Teil 4 ✅ teilweise 2026-07-19 (Nachtrag 39) — `omp-player`
   erledigt (inkl. Generalisierungs-Bonus: `omp-multiviewer` nutzte den
   neuen Lowres-Sender ohne jede Anpassung); `omp-ograf` offen
   (Fill/Key-Design-Frage).
6. **Kapitel 16 — Inter-Host-Fabrics (RDMA/Remote-Memory).** Höchster
   potenzieller Zukunftswert (Latenz, Multi-Host-Regieplatz).
   ✅ **Teil 0 erledigt 2026-07-19** (`docs/decisions.md` Nachtrag
   41-43) — deutlich größer als der ursprünglich veranschlagte
   „eine Sitzung": libfabric musste aus Quellcode vendort werden
   (Debian-Paket zu alt), MXL musste projektweit auf `v1.1.0-beta-1`
   angehoben werden (die gepinnte `v1.0.1` hatte eine reine
   Stub-Fabrics-API), beides live mit vollem Regressionstest gegen die
   bestehenden MXL-Pfade verifiziert, danach ein echter Zwei-Domain-
   RDMA-Transfer über den TCP-Provider nachgewiesen. Teil 1
   (`omp-mediaio::fabrics`-Grundmodul) ist der nächste, jetzt
   entsperrte Schritt.
7. **§17 Teil 4/5 — Import/Versionierung fremder Microservices.**
   Architektonisch am größten (Podman-Runner, Katalog-Schreib-API,
   Vertrauensmodell), am wenigsten dringend für den aktuellen
   Ein-Entwickler-/Demo-Stand des Projekts — bewusst ans Ende gestellt.

**Empfohlener nächster konkreter Schritt** (nicht Teil dieser
Priorisierung selbst, sondern die unmittelbare Konsequenz): Punkt 1
oben (`§1.6`) als nächsten `UMSETZUNG.md`-Schritt aufnehmen und
umsetzen — klein, unabhängig, sofort sichtbar.
