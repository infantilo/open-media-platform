# Entwurf: Mehrere PIPs, 2D-Transformation, Klick-Fokus im Videomixer M/E

Nutzerwunsch 2026-11-05. Stand: **nur Entwurf, kein Code.** Betrifft `nodes/omp-video-mixer-me` (`pipeline.rs`, `main.rs`, `ui/bundle.js`).

## 1. Wunsch (Originalwortlaut sinngemäß)

1. Im DME/PIP-Teil des Videomixers M/E **optional mehrere PIPs, dynamische Anzahl**.
2. PIP **in 2D**: Trapez, Rotation, **z-Index**.
3. Sind z. B. drei PIPs (aus einem Preset) auf Sendung und der Operator **klickt im PGM-Bild auf eines**, fährt dieses auf eine **vordefinierte Position** (z. B. fast Vollbild); **erneuter Klick** fährt zurück.

## 2. Bestand (geprüft 2026-11-05)

- Je Ebene **genau ein** PIP: `isel_pip` (input-selector, ein Pad je Eingang + Schwarz) → `comp_pip_pad` (`comp.sink_3`, `zorder=4`, `alpha` 0/1). Geometrie nur `xpos/ypos/width/height` (`DveBox`, `apply_dve_box`).
- `PipPreset` (`main.rs`): Name, Quelle, Halte-Box, optional Start-/End-Box, `in_ms`/`out_ms`; `pip.applyPreset` ruft `pip.setSource`/`dve.setBox`/`pip.setEnabled` bzw. `PipAnimate` (Ease in/out per Thread, `STEP_MS` = 40 ms).
- **Harte Regel der Pipeline** (Moduldoku): zur Laufzeit nichts tun, was Caps neu verhandelt (Crop/Scale umparametrieren, Relink) — das war die Ursache des PGM-Einfrierens (2026-09-29). Compositor-Pad-Properties (`xpos/ypos/width/height/alpha/zorder`) sind dagegen sicher.
- GStreamer 1.22.0 auf dem Entwicklungsrechner. Vorhanden: `compositor`, `perspective` (CPU, 3×3-Matrix, Property `matrix`, Formate u. a. AYUV/ARGB/RGBA), `rotate`, `gltransformation`, `glvideomixer`. `perspective.matrix` ist ein `GValueArray` aus 9 `gdouble` — mit `gst-launch` nicht setzbar, nur aus Code (`gst::Array`); ein Prototyp muss deshalb in Rust oder per kleinem Testprogramm laufen.

## 3. Entwurf

### 3.1 Mehrere PIPs: feste Slot-Reserve statt Laufzeit-Umbau

- Pro Ebene **N PIP-Slots** (Node-Option `OMP_PIP_SLOTS`, Standard 4, 1–8; im Workflow-Editor als Rollenfeld wie „Mischerebenen“). Jeder Slot hat eigenen `isel_pip[s]` und eigenes Compositor-Pad (Reihenfolge der Pads fest, `zorder` über Property).
- „Dynamische Anzahl“ heißt für den Operator: beliebig viele der N Slots einschalten; ungenutzte Slots stehen auf `alpha=0`. **Kein** Pad-Anfordern/Freigeben im Betrieb (gleiche Klasse von Rennen wie die dokumentierten Tee-/Pad-Fehler).
- Kosten: jeder Slot braucht pro Eingang einen weiteren Tap (heute 3 pro Eingang: fg/bg/pip). Bei N = 4 → 6 Taps. Das ist der Grund für Standard 4 statt 8 und für die Option.
- `pip.*` wird um einen Slot-Index erweitert (`pip.setEnabled{slot}`, `pip.setSource{slot}`, …). **Ohne Slot-Angabe = Slot 0** → bestehende Steuerungen, Stream Deck, Konsolen und Presets bleiben unverändert gültig.

### 3.2 Szene statt Einzel-PIP-Preset

Das heutige `PipPreset` wird zur **PIP-Szene**: Liste von Slot-Einträgen, je Eintrag
`{ slot, quelle, pose, start?, end?, in_ms, out_ms, z, fokus? }`. Eine Szene aktivieren = alle Einträge gleichzeitig einfahren; deaktivieren = alle ausfahren. Alte Presets werden beim Laden zu Szenen mit einem Eintrag (Slot 0) migriert.

### 3.3 2D: Pose als Viereck, ein Element, eine Matrix

- Pose = **vier Eckpunkte** (Vierecks-Warp) + `z` + `alpha`. Rotation, Skalierung, Trapez und Perspektive sind alle dieselbe Homographie — eine Datenform, ein Editor (Ecken ziehen, Drehgriff als Komfort), eine Animation (Ecken interpolieren).
- **Achsparallele Pose ohne Verzerrung** (Normalfall, heutiges Verhalten) bleibt **reiner Compositor-Pad-Pfad** (`xpos/ypos/width/height`) — keine Mehrkosten, kein neues Element.
- **Echte 2D-Pose** braucht ein Transform-Element im Slot: Empfehlung `perspective` (CPU, Matrix zur Laufzeit als Property, **keine Caps-Änderung**). Weil Einfügen/Entfernen zur Laufzeit ein Relink wäre (verboten), ist es **fest in Slots eingebaut, die als „2D“ markiert sind** (`OMP_PIP_2D_SLOTS`, Standard: alle Slots aus → keine Mehrkosten, bis jemand 2D braucht). Der Slot rechnet dann auf Bildgröße (Eingang → Vollbild-AYUV mit Alpha → Matrix → Compositor-Pad Vollbild), 2D-Slots sind also ein CPU-Posten je Bild.
- Alternative bei zu hoher CPU: `gltransformation` (GPU) — nur nach Prüfung des GL-Kontexts im Zielbetrieb; Hardware-Pfad wird nicht ungeprüft angenommen.
- **Randfrage Kantenglättung/Außenpixel:** `off-edge-pixels` muss transparent liefern (AYUV-Alpha 0); ist das nicht der Fall, bräuchte es eine Alpha-Maske. Das klärt der Prototyp (87.1).

### 3.4 z-Index

`zorder` je Slot-Pad, Wertebereich oberhalb des Keyers (Keyer 3, heutiges PIP 4 → Slots ab 4, im Bereich 4–11). Änderung zur Laufzeit ist eine Pad-Property (sicher). Der **Fokus-Slot** wird für die Fahrt temporär nach ganz oben gesetzt und danach wieder auf den Szenenwert.

### 3.5 Klick-Fokus (Kern des Wunsches 3)

- **Trefferprüfung im UI**: Klick im PGM-Bild → Koordinaten auf Mischerauflösung umrechnen → von oben (höchstes `z`) nach unten Punkt-im-Viereck gegen die **aktuellen Posen** der eingeschalteten Slots. Treffer → `pip.toggleFocus{slot}`. Kein Treffer → nichts (Klick aufs Hintergrundbild soll nichts auslösen).
- **Server**: `pip.toggleFocus` fährt den Slot von seiner Haltepose in die **Fokuspose** (im Szenen-Eintrag definiert, Standard: 94 % Vollbild zentriert, 16:9) und merkt „fokussiert“; erneut → zurück zur Haltepose. Fährt ein anderer Slot an, während einer fokussiert ist: Auswahl `exklusiv` (Standard: erst zurück, dann der neue) oder `ersetzend` (Eintrag, kein Zwang im ersten Wurf).
- Fahrt = die bestehende Animation, erweitert auf Vierecke (Ecken-Lerp, `z` springt zu Beginn nach oben, bei Rückfahrt am Ende zurück). Dauer aus dem Szenen-Eintrag.
- **Zuverlässigkeit**: Zustand (`fokussiert: Option<Slot>`) lebt im Server, das UI zeigt ihn nur an; zweiter Bediener/Stream Deck sieht dasselbe. Zusätzlich Methode `pip.focus{slot}` / `pip.unfocus` für Stream Deck und Automation.
- **Offene Frage, wo der Klick gilt:** nur in der Vorschau/PGM-Kachel der Mixer-Oberfläche oder auch auf der Operator-Konsole (Kachel des PGM). Empfehlung: erst die Mixer-Oberfläche, Konsole als Folgeschritt, weil dort die Hit-Test-Geometrie (Kachelgröße, Letterbox) dazukommt.

### 3.6 Zustand und Oberfläche

- Neue Parameter je Slot (`pip.slots`, `pip.focused`), `pip.scenes` ersetzt `pip.presets` (alter Name bleibt als Alias lesbar).
- UI: Szenen-Karten wie heute; der Editor bekommt Slot-Liste (Quelle, z, Ein/Aus, 2D-Ecken, Fokuspose) auf der bestehenden Editor-Leinwand; im PGM-Bild Rahmen der Slot-Vierecke beim Überfahren mit der Maus (Hinweis, was ein Klick trifft).
- Texte nur über `t()` in `de.ts`/`en.ts` bzw. dem Bundle-Wörterbuch; Dialoge nur `omp-confirm`/`omp-prompt`/`omp-toast`; Handbuch (BENUTZERHANDBUCH, HANDBUCH §9) und Katalogbeschreibung im selben Arbeitsgang.

## 4. Schritte (je Sitzung einer)

- **87.1 Prototyp 2D (nur messen).** Kleines Rust-Beispiel (`examples/`): Quelle → AYUV → `perspective` mit Matrix aus 4 Ecken → `compositor`-Pad. Prüfen: (a) Matrix-Konvention (vorwärts/invers), (b) transparente Außenpixel, (c) Matrixwechsel zur Laufzeit ohne Caps-Ereignis (Probe auf `CAPS`/`RECONFIGURE`), (d) CPU bei 720p/1080p ein und zwei Slots (**klein halten**, ~10 s, `nice`). Ergebnis hier eintragen; Entscheidung `perspective` vs. `gltransformation`.
- **87.2 Mehrere Slots (achsparallel, z-Index).** `isel_pip[]`/`comp_pip_pad[]`, `OMP_PIP_SLOTS`, `pip.*` mit Slot-Index (Standard Slot 0), `pip.setZ`, Zustandsereignisse; Tests (Rust, Slot-Logik rein, ohne GStreamer wo möglich); live: 3 Slots, 3 verschiedene Quellen, PGM zeigt alle, **jeden Kanal/jeden Zweig prüfen, 15× Neustart** (Dynamik-Lektion aus den Tee-/Selector-Rennen).
- **87.3 Szenen.** `PipPreset` → Szene mit Slot-Einträgen, Migration, `pip.applyScene`/`pip.setEnabled` für die ganze Szene, Ein-/Ausfahrten parallel; Tests der Migration und der Fahrten.
- **87.4 Klick-Fokus.** `pip.toggleFocus/focus/unfocus`, Server-Zustand, Fokuspose je Eintrag, Hit-Test (reine Funktion + Deno-Tests), Klick im PGM-Bild; Browser-Klicktest mit **echtem** `page.mouse` (nicht synthetische Events); Hin- und Rückfahrt, schnelles Doppelklicken, Klick während Fahrt.
- **87.5 2D-Pose.** Nach Ergebnis von 87.1: 2D-Slots, Eckpunkt-Animation, Editor (Ecken ziehen, Drehgriff), Trapez/Rotation in Szene und Fokuspose; Hit-Test auf Vierecken.
- **87.6 Konsole + Stream Deck + Doku.** Klick auf der Operator-Konsole, Stream-Deck-Aktionen `pip.focus`, Handbuch, Katalog, Abschluss mit Befunden.

## 5. Risiken

- **PGM-Einfrieren** durch Caps-Verhandlung: darum feste Slots, kein Relink, `perspective` fest eingebaut; jede Stufe wird mit dem 15×-Neustart und Kanalprüfung verifiziert.
- **CPU**: Slots × Eingänge × Taps; 2D-Slots rechnen auf Vollbild. Standardwerte klein (4 Slots, 0 2D-Slots), Messwerte in 87.1.
- **Matrix-Konvention/Außenpixel** sind bis 87.1 Annahmen — nicht im Handbuch versprechen, bevor gemessen.
- **Hit-Test-Genauigkeit**: Vorschaubild ist ein Polling-Bild (Latenz); der Treffer wird gegen die Server-Posen gerechnet, nicht gegen Pixel — dadurch unabhängig von der Bildverzögerung.
- Keine Herstellernamen in UI/Doku (Projektregel).
