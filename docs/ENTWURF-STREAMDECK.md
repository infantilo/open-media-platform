# Entwurf Kap. 40 — Stream Deck per WebHID (Schritt 40.1, 2026-10-13)

Stand 40.1 (2026-10-13): Recherche + Schnittstellenfestlegung. **Umgesetzt** in Kap. 40.2–40.11 — Endstand in §7. Plan: `UMSETZUNG.md` Kap. 40; Konzept: `END-GOAL-FEATURES.md` Kap. 8 (K8).

## 1. Protokoll (belegt aus der offiziellen HID-Beschreibung des Herstellers, öffentliche HID-Dokumentation, abgerufen 2026-10-13)

Allgemein: Vendor-ID `0x0FD9`. Mehrbyte-Felder **little-endian**. Input-Report max. 512 B, Output-Report max. 1024 B
(Host füllt mit 0 auf), Feature-Report max. 32 B. Die Seiten nennen **keine** feste Chunk-Größe; `1024 − 8` Byte Kopf = **1016 B Nutzdaten**
je Chunk (so auch in der Vorlage `streamdeck.js:1045`).

**WebHID-Offsets:** `inputreport`-Daten und `sendReport(id, data)` enthalten die Report-ID **nicht**. Die Offsets der Herstellertabellen
(inkl. ID-Byte) sind daher um 1 zu verringern.

| Modell | PID | Raster | Tastenbild | Drehung | Besonderes |
|---|---|---|---|---|---|
| XL | `0x006C` | 8×4 | 96×96 JPEG | 180° | |
| XL 2022 (v2) | `0x008F` | 8×4 | 96×96 JPEG | 180° | |
| 15-Tasten-Familie (2019 / MK.2 / MK.2 Scissor) | `0x006D` / `0x0080` / `0x00A5` | 5×3 | 72×72 JPEG | 180° | `0x0080`, `0x00A5` fehlen in der Vorlagentabelle |
| **+** | `0x0084` | 4×2 | 120×120 JPEG | **keine** | 4 Dials, Touch-Streifen 800×100 (LCD 800×480) |
| **+ XL** (Nachtrag 2026-10-13) | `0x00C6` | 9×4 | 112×112 JPEG | **90° gegen den Uhrzeigersinn** (Tasten und Streifen) | 6 Dials, Streifen 1200×100 (LCD 1280×800); Befehle/Offsets wie „+“ (Taste 0x07, Streifen teilweise 0x0C), Eingabe-Berichte identisch aufgebaut; Teilbild-Koordinaten logisch (ohne Drehung), das JPEG selbst ist gedreht |
| Neo / Mini / MK.1 | `0x009A` / `0x0063`,`0x0090` / `0x0060` | — | — | — | **nicht in v1**; Seiten `…/stream-deck-neo`, `…/mini` vor Aufnahme lesen |

Eingabe (Report-ID 1, im WebHID-Puffer: `d[0]`=Kommando, `d[1..2]`=Länge, Nutzdaten ab `d[3]`):
- Kommando `0x00` Tasten: `d[3+i]` = 0/1 je Taste (Zustand, nicht Flanke → Flanken im Transport bilden).
- **+** Kommando `0x03` Dials: `d[3]` Typ (`0x00` Druck: `d[4+i]` 0/1; `0x01` Drehung: `d[4+i]` als **INT8**, + = rechts).
- **+** Kommando `0x02` Touch: `d[3]` Typ (`1` Tap, `2` Press/lang, `3` Flick); Tap/Press: X `d[5..6]`, Y `d[7..8]`; Flick: Start X/Y `d[5..8]`,
  Ende X/Y `d[9..12]`. Ereignisse kommen **einmal nach Abschluss** (kein Down/Up).

Ausgabe (Report-ID 2, `buf[0]` = Kommando):
- Tastenbild `0x07`: `[0x07, taste, ist_letzter, len_lo, len_hi, chunk_lo, chunk_hi, daten…]` — wie `_sendImgMK2` der Vorlage.
- **+** Streifenbild ganz `0x0B` (800×100 JPEG): gleiche Struktur wie `0x08` (`buf[1]` reserviert, dann Flag, Länge, Chunk-Nr.).
- **+** Streifen teilweise `0x0C`: `[0x0C, x16, y16, breite16, höhe16, ist_letzter, chunk16, len16, 0x00, daten…]` (Kopf 16 B → 1008 B Nutzdaten).
  → Ein Dial = 200×100-Ausschnitt bei `x = 200·i`; nur geänderte Dials senden.
- Feature-Report 3: Helligkeit `[0x08, 0..100]`; „Logo zeigen“ `[0x02]`.

**Abweichungen zur Vorlage — am Gerät zu prüfen (nicht aus dem Gedächtnis entscheiden):**
1. Vorlage setzt für **+** `flip:true`; Herstellerseite sagt „keine Drehung“. → Testraster mit Pfeil/Ziffer, am Gerät klären.
2. Vorlage sendet zum „Reset“ einen leeren Output-Report; der Hersteller kennt **keinen Reset**, empfiehlt „Logo zeigen“ vor dem Schließen. → Beim Öffnen weglassen, wenn Bilder auch so ankommen; beim Trennen Logo zeigen.
3. Empfohlene Abfrage-/Poll-Zeit 50 ms betrifft native Treiber; WebHID liefert `inputreport` ereignisgetrieben — nichts zu pollen.

## 2. Architektur (Ergänzungen zum Plan)

Module in `ui/shell/streamdeck/` (bestehende Konvention: Logik in `*-logic.ts` mit Deno-Test, DOM/HID getrennt):
`models.ts` (Tabelle oben, reine Daten), `protocol.ts` (Chunking, Dekodierung — rein, testbar), `transport.ts` (WebHID + Mock-Gerät),
`render.ts` (Canvas→JPEG, Fingerprint, Debounce), `broker.ts` (Tabs, Fokus, Seitenkomposition), `sim.ts` (Simulator `/streamdeck-sim`).
`Transport`-Schnittstelle: `send(report)`, `onInput(cb)`, `model`; WebHID und Simulator implementieren sie.

**Gerät hält die Shell, ein Tab.** Zugriff über `navigator.hid` nur in sicherem Kontext (https/localhost) und Chromium; sonst Hinweis.

## 3. Adapter-Schnittstelle (festgelegt)

Gewählt: **das Custom Element des Node-UI-Bundles stellt eine Eigenschaft `streamDeck` bereit** (kein `registerPage`-Global, kein `postMessage`).
Grund: `mountUIBundle` hängt das Element ohnehin ins selbe Dokument; der Zustand (PGM/PRE, Kanäle) liegt im Element, ein Adapter daneben liest denselben Zustand
→ „ein Zustand, zwei Renderer“ ohne Doppelabruf.

Änderung in der Shell: `mountUIBundle` liefert zusätzlich das Element (z. B. `mountUIBundleEl(...) → HTMLElement | null`; bestehende `boolean`-Signatur bleibt als Hülle).
`console-board.ts` meldet beim Mounten/Entfernen einer Kachel `broker.attach(roleId, label, el)` / `broker.detach(roleId)`; Fokus/Vorholen der Kachel über Broker → Board.

```ts
interface StreamDeckAdapter {
  // Dimensionen kommen vom Modell; Adapter liefert nie feste Indizes, sondern Raster-Inhalt
  getLayout(ctx: { cols: number; rows: number; dials: number; page: number }): {
    keys: (KeyDef | null)[][];            // [zeile][spalte], rows = Platz ab Zeile 2
    dials?: DialDef[];                     // nur wenn Modell Dials hat; sonst Adapter nutzt Tasten
    pages?: number;                        // Blätterseiten / Unterseiten
  };
  onKey(row: number, col: number, down: boolean): void;
  onDial?(i: number, delta: number): void;      // gedrosselt/zusammengefasst vom Broker
  onDialPress?(i: number, down: boolean): void;
}
interface KeyDef { label?: string; sub?: string; icon?: string; state?: "onair"|"preset"|"cue"|"off"|"error"; dim?: boolean }
interface DialDef { label: string; value: string; fill?: number /*0..1*/ }
```
Änderungsmeldung: das Element feuert `CustomEvent("omp-streamdeck-relayout")` (bubbles) → Broker plant Render (Debounce). Farben aus den `--omp-*`-Tokens (`design-tokens.css`), nicht als Hex.
Nodes ohne `streamDeck`: Broker erzeugt ein **Auto-Raster** aus dem Descriptor (schreibbare bool-Parameter = Umschalter, Methoden ohne Argumente = Taster; Rest blätterbar).
Tastendruck ruft den **gleichen** Pfad wie der Mausklick (Adapter ruft die vorhandene Bundle-Funktion, die ihrerseits `/api/v1/nodes/<id>/methods|params/…` nutzt).

## 4. Layout-Komposition

Zeile 0: Taste 0 Home/Zurück, Tasten 1…n−2 Tabs (Titel, Katalogfarbe), letzte Taste „weiter“ wenn mehr Tabs als Plätze (Blättern in Seiten à `cols−2`). Ab Zeile 1: Adapter-Inhalt der aktiven Kachel.
Home = Übersicht aller Tabs. XL (8×4): 3 Inhaltszeilen. **+** (4×2): nur 1 Inhaltszeile → Dials (4) tragen Parameter, Streifen zeigt Namen/Wert je Dial; Video-Mixer auf **+** = PGM/PRE-Wechsel über Blättern.
Eingaben gehen nur an den aktiven Tab-Adapter.

## 5. Offene Punkte für 40.2

- Plus-Streifen-Touch (Tap = Dial-Auswahl, Flick = Seite blättern) — in 40.2 nur dekodieren, Belegung in 40.4.
- Mehrere Geräte gleichzeitig: v1 = ein Gerät (Transport-Liste aber als Array angelegt, damit XL + **+** später gemeinsam laufen können).
- Neo/Mini/MK.1 bewusst ausgelassen (nicht im Besitz, Protokoll nicht verifiziert).

## 6. Änderung beim Bau (40.5)

Die Adapter-Auflösung hat jetzt drei Stufen (`ui/shell/streamdeck/adapters/index.ts`): (1) das Element bringt selbst eine Eigenschaft `streamDeck` mit (§3, bleibt möglich);
(2) das Bundle bietet nur `deckApi` ({ `state()`, `call(method, body)` }) plus das Relayout-Ereignis, und die Shell hält eine **Fabrik nach Elementname** mit Layout/Eingabe;
(3) sonst Auto-Raster. Grund für (2): Bundle-Zustand liegt in Closures eines Rust-eingebetteten Skripts — die Layout-Logik gehört in die testbare Shell, das Bundle bleibt klein.

## 7. Endstand der Umsetzung (Kap. 40.2–40.11, 2026-10-13)

- **Modelle:** XL, XL 2022, 15-Tasten-Familie, „+“, „+ XL“ (`0x00C6`: 9×4, 112 px, 6 Dials, Streifen 1200×100, 90° gegen den Uhrzeigersinn; Quelle: Hersteller-HID-Seite).
  Die Drehung ist eine Modelleigenschaft (`rotation` 0/90/180) für Tastenbilder **und** Streifen-Teilbilder; Teilbild-Koordinaten bleiben logisch.
- **Adapter** (`ui/shell/streamdeck/adapters/`): Video-Mixer (`deckApi` im Bundle), Audio-Mixer (Mix-Seite, EQ/Dynamik/Pan; SELECT öffnet mit einem Druck;
  Kurven über Tasten/Streifen), **OGraf** (Presets, TAKE/TAKE OUT/CONTINUE/ALLE AUS, On-Air rot), X/Y-Panel; sonst Auto-Raster. Auflösung: §6.
- **Kopfzeile:** Home + Tabs; Home zeigt Tabs nicht doppelt (nur Überlauf darunter). **Text:** Umbruch und automatische Schriftgröße, „…“ nur im Notfall.
- **Takt:** `refresh()` des aktiven Tabs alle 1,5 s, nicht gestapelt, 8-s-Limit; Änderungen über `onChange`/`omp-streamdeck-relayout`.
- **Simulator** (`/streamdeck-sim`, im Konsolen-Panel) skaliert auf die Fensterbreite; Screenshots in `docs/screenshots/streamdeck-*.png`.
- **Offen am Gerät:** Drehung „+“/„+ XL“ (Pfeil im Testraster oben?), USB-Dauer, Wiederverbinden, Dial-Drehsinn, Reset/Logo, udev auf dem Bedienrechner.
- **Eigene Nodes:** Belegung per Descriptor (Auto-Raster) oder `streamDeck`-Eigenschaft — Anleitung samt KI-Prompt in `docs/NODE-TUTORIAL.md`.
