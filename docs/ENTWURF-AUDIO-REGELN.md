# Entwurf: Dynamische Audio-Zuordnung und Regel-Engine

Status: **freigegeben** (2026-10-05, Umsetzung nach Abschnitt 7). A1 erledigt (Crate `omp-audio-rules`, 22 Tests), A2 erledigt (`GET/PUT /api/v1/audio-rules`, `GET /api/v1/audio-rules/default`), A5 erledigt (Editor Admin → Audio-Ausgabe, Event-Reiter Audio, Tabellenspalte; das Testwerkzeug „Quelle simulieren“ fehlt noch), A3 erledigt für `omp-channel-player` (live gegen echte MXF-Datei und MXL-Flows geprüft; Beispielwerkzeug `mxl_audio_levels`). Ersetzt langfristig
die fest einkompilierten Programmgruppen/Shuffle-Presets von `omp-mxf-player` und
`omp-channel-player` und erweitert die Audio-Absicht (`AudioIntent`, P5) der
Playout-Automation auf **alle** Eventtypen (Datei, Live, Standbild).

## 1. Ziel

Nichts Audio-Spezifisches ist im Code festgelegt:

- Welche **Ausgabegruppen** am Ende entstehen (z. B. Programmton, Hörfilm/AD, Originalton,
  Dolby E, 5.1), wie viele Kanäle sie haben und wie sie **getaggt** sind, ist Konfiguration.
- Welche **Spuren die Quelle** hat (heute 8 MXF-Spuren, später z. B. 16 bei XAVC-300)
  und was sie bedeuten, ist Konfiguration bzw. Metadaten, kein Code.
- Pro **Event** wird festgelegt, welche Quellspuren in welche Gruppe gehen.
- Eine **Regel-Engine** entscheidet bei fehlenden Spuren, was stattdessen passiert
  (Ersatzspur, Up-/Downmix, Verarbeitung wie „Klare Sprache“, Stille + Warnung).
- Neue Anforderungen (andere Gruppen, mehr Spuren, neue Verarbeitung) brauchen
  **keine Programmänderung**, nur neue Einträge im Editor.

## 2. Begriffe und Datenmodell

Alle Dokumente sind JSON, im Orchestrator als Node-Typ-Einstellungen gespeichert (wie
heute die mxf-player-Presets, Migration 0013), mit Schema-Validierung beim Speichern.

**Ausgabeprofil** (`outputProfile`): geordnete Liste von **Zielgruppen**.

```json
{ "id": "pt", "label": "Programmton", "layout": "stereo",
  "channels": ["L","R"], "tags": ["role:pt","lang:de"] }
```

`layout`: `mono`, `stereo`, `5.1`, `7.1` oder `custom` (Kanalnamen frei). Tags sind frei
wählbar (`key:value`); jede Zielgruppe wird ein eigener MXL-Audio-Flow mit diesen Tags
(NMOS-Tag `urn:x-omp:tags`), sodass der Mixer sie per Tag-Auswahl finden kann.

**Spurschema** (`trackSchema`): beschreibt, was die Spuren einer Quellklasse bedeuten.

```json
{ "id": "orf-mxf-8", "match": { "format": "mxf", "tracks": 8 },
  "tracks": [ {"n":1,"layout":"mono","tags":["pos:1"]}, … ] }
```

`match` wählt das Schema automatisch (Format, Spurzahl, Dateimuster, Asset-Klasse); pro
Event überschreibbar. Live-Quellen liefern ihr Schema aus ihren Capabilities
(`AudioCapability`, bereits vorhanden).

**Zuordnungsvorlage** (`mapping`, heute „Shuffle-Preset“): je Zielgruppe eine
**Quellvorgabe**. Die 13 ORF-Presets werden als mitgelieferte Vorlagen importiert.

```json
{ "id": "stereo-dolbye-hoerfilm", "label": "Stereo + Dolby E + Hörfilm",
  "groups": { "pt": { "tracks": [1,2] }, "ad": { "select": "role:ad" } } }
```

Eine Quellvorgabe ist entweder **explizite Spurliste** (`tracks`, 1-basiert, auch
pro Zielkanal), **Tag-Auswahl** (`select`, z. B. `role:pt AND layout:5.1`) oder
`inherit` (aus Profilvorgabe).

**Regelsatz** (`ruleSet`): geordnete Regeln je Zielgruppe (Abschnitt 4).

**Event-Audioplan**: im Event steht nur noch `mapping` (Vorlage oder eigene Zuordnung)
plus optionale Regel-Überschreibungen. Ersetzt/erweitert das heutige `audio`-Feld.

## 3. Ablauf (Resolve beim Cue)

1. Quelle des Events bestimmen (Datei: Probe der Spuren; Live: Capabilities).
2. Spurschema wählen (Match oder Event-Vorgabe) → Quellspuren mit Tags.
3. Pro Zielgruppe die Quellvorgabe auswerten.
4. Fehlt etwas: Regelsatz der Zielgruppe anwenden (Abschnitt 4).
5. Ergebnis ist ein **aufgelöster Plan** je Zielgruppe: Matrix (Quellspur→Zielkanal,
   Koeffizienten) plus optionale **Verarbeitungskette**, dazu **Warnungen**.
6. Plan wird dem Ausspielnode gegeben, in der UI vor dem Take angezeigt
   („Vorschau Audio“) und im As-Run protokolliert (welche Regel gegriffen hat).

Die Auflösung ist reine Logik in einem eigenen Crate (`omp-audio-rules`, ohne GStreamer)
und damit vollständig testbar. Sie ersetzt/verallgemeinert `omp_resolver::audio::
resolve_audio_intent`; `AudioIntent`-Events bleiben lesbar (Migration).

## 4. Regel-Engine

Regeln sind Daten, geordnet, erste passende gewinnt (mit optionalem „weiter prüfen“):

```json
{ "group": "surround51",
  "when": { "missing": "role:pt AND layout:5.1" },
  "then": [ { "use": { "select": "role:pt AND layout:stereo", "via": "upmix51" } },
            { "silence": true, "warn": "Kein 5.1-Programmton, Stille" } ] }
```

- **Bedingungen:** `has`, `missing` (Tag-Ausdrücke mit AND/OR/NOT), Kanalzahl,
  Quelltyp (Datei/Live), Event-Typ, Eigenschaft des Assets.
- **Aktionen** in einer Fallback-Kette: `use` (Spuren per Tag/Liste), `via`
  (**Prozessor**, s. u.), `silence`, `fail` (Event nicht auf Sendung, Alarm), `warn`.
- **Prozessoren** (Registry, erweiterbar): `matrix` (Reine Auswahl/Summierung,
  bit-exakt wo nur Auswahl), `upmix51` (Stereo→5.1), `downmix` (5.1/7.1→Stereo,
  ITU-Koeffizienten), `mono-to-stereo`, `gain`, `delay`, `loudness` (EBU R128) und
  **`dialog-enhance`** („Klare Sprache“) als Verarbeitungskette. Neue Prozessoren
  sind Einträge in der Registry mit Parametern; der Editor bietet sie per Auswahl an.
- **Schutzregeln:** Eine Zielgruppe mit Tag `bitexact` (z. B. Dolby E) erlaubt nur reine
  1:1-Auswahl; Regeln, die summieren oder verarbeiten würden, werden beim Speichern
  abgelehnt (heute nur dokumentiert, künftig erzwungen).

Mitgeliefert wird ein **Standard-Regelsatz** (Ersatzketten für 5.1, AD, OT, Mono→Stereo),
der im Editor sichtbar und änderbar ist.

## 5. Ausführung in den Playern

- Der Ausspielnode (`omp-channel-player`, später auch `omp-mxf-player`) baut die
  **Zielgruppen aus dem Ausgabeprofil** dynamisch: je Gruppe ein MXL-Audio-Sender.
  Gruppenzahl/-struktur ändern wirken wie bisher nach einem Neustart der Instanz
  (neue NMOS-Sender nur beim Start).
- Je Gruppe: `audiomixmatrix` mit den Koeffizienten des aufgelösten Plans, dahinter
  die Verarbeitungskette (leere Kette = Durchgriff). Matrix/Kette wechseln beim
  Cue/Load des nächsten Events (A/B-Slot), nicht während der Sendung.
- Ein gemeinsames Crate stellt Plan → GStreamer-Elemente her; `omp-mxf-player` und
  `omp-channel-player` nutzen denselben Code (heute dupliziert).

## 6. Bedienung („super leicht zu konfigurieren“)

- **Editor „Audio-Ausgabe“** (eine Seite): Tabelle der Zielgruppen (Name, Layout,
  Tags) per „+“; Spurschemata als Tabelle (Spur, Layout, Tags); Vorlagen als Matrix
  (Zeilen = Quellspuren, Spalten = Zielkanäle, Klick setzt Zuordnung).
- **Regel-Baukasten:** Zeilen „Wenn … fehlt → nimm … → über …“ mit Auswahllisten statt
  Freitext; Tag-Auswahl mit Vorschlägen aus bekannten Tags.
- **Testwerkzeug:** Quelle simulieren (Spurliste/Schema wählen) → Ergebnis-Plan und
  Warnungen sofort sichtbar, ohne Medien.
- **Im Event:** Reiter „Audio“: Vorlage wählen, bei Bedarf pro Zielgruppe überschreiben;
  Ampel „Plan vollständig / Ersatz aktiv (Regel …) / Stille“.
- **Playlist-Tabelle:** Spalte „Audio“ zeigt die Vorlage und den Ampelstatus.

## 7. Umsetzung in Schritten (je Schritt live verifiziert, committed, dokumentiert)

| Schritt | Inhalt |
|---|---|
| A1 ✓ | Crate `omp-audio-rules`: Datenmodell, Tag-Ausdrücke, Resolver, Standard-Regelsatz, Tests (kein GStreamer) |
| A2 ✓ | Orchestrator: Speicherung/Validierung (`outputProfile`, `trackSchema`, `mapping`, `ruleSet`), Import der 13 ORF-Presets und 5 Gruppen als Standard |
| A3 ✓ | Gemeinsames Ausspiel-Crate: dynamische Zielgruppen, Matrix, Plan→GStreamer; `omp-channel-player` darauf umstellen |
| A4 ✓ | Automation: Event-Audioplan, Resolve beim Cue, Warnungen/As-Run, API |
| A5 ✓ (ohne Testwerkzeug) | UI: Editor „Audio-Ausgabe“ (Gruppen, Schemata, Vorlagen-Matrix, Regel-Baukasten, Testwerkzeug), Event-Reiter, Tabellenspalte |
| A6 ✓ | Prozessoren: Up-/Downmix und Mono↔Stereo als Matrizen (A1), `gain` und `delay` als Kette im Kanal-Player; `loudness` zurückgestellt (kein R128-Element im System) |
| A7 | `dialog-enhance` („Klare Sprache“) — **auf später verschoben** (Nutzerentscheidung 2026-10-05) |
| A8 | `omp-mxf-player` auf dieselbe Engine migrieren, hartkodierte Presets entfernen |

Handbuch, Node-Tabelle und Katalogbeschreibung werden in jedem Schritt mitgeführt.

## 8. Offene Entscheidungen

1. **Reihenfolge:** Reicht A1–A5 als erster Block (Gruppen, Zuordnung, Ersatzspuren
   per Auswahl/Matrix), mit Up-/Downmix und „Klare Sprache“ danach?
2. **Ausspielnode:** Soll `omp-channel-player` die Zielgruppen als eigene Sender
   bekommen (empfohlen, wie `omp-mxf-player` heute), oder bleibt er beim einen
   Stereo-Ausgang und ein separater Audio-Node erzeugt die Gruppen?
3. **Live-Quellen:** Sollen deren Capabilities ebenfalls als „Spuren mit Tags“
   behandelt werden (empfohlen: eine Engine für alle)?
4. **„Klare Sprache“:** Welches Verfahren ist gewünscht (Mittenkanal-Anhebung mit
   Kompression/EQ, oder ein Sprachtrenner)? Das bestimmt die Abhängigkeiten.
