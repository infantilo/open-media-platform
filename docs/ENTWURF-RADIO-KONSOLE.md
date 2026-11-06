# Entwurf: Radio-Konsole (Bedienfeld der Radio-Automation)

Stand: 2026-11-06 (Kapitel 89). Anlass: Nutzer-Vorlage `radioui.gif` (klassische Sendeoberfläche: Bibliothek, Hauptplaylist mit Blöcken und
Uhrzeiten, Hotkey-Wand, Recorder, Uhr, Mixer). **Nicht das Design übernehmen**, aber die Funktionen, die ein Radio-Sendeplatz braucht, und das
im Rahmen der OMP-Konsole (Kacheln, Rechte je Rolle, i18n, Dialog statt `confirm`). Das Bedienfeld ist `omp-radio-automation-panel`.

## 1. Zonen

| Zone | Inhalt | Stand |
|---|---|---|
| **Jetzt** (Kopf) | Läuft gerade (Titel, Restzeit, Fortschritt), nächstes Element, Uhr, Zustand | Scheibe 1 |
| **Playlist** (Editor) | Elemente per Drag&Drop sortieren, Einfügen/Duplizieren/Löschen, Name/Art/Datei/Marken, harte Marken (Uhrzeit), Blöcke (Werbeblock mit Soll-Länge), Zeitplan je Zeile (Startzeit, läuft/vorbei) | Scheibe 1 |
| **Werbung** | Block aus Spots mit Soll-Länge: Summe, Differenz, Füllvorschlag; harte Startmarke des Blocks | Scheibe 1 (Block im Editor), Scheibe 3 (Planung/Streaming-Marker) |
| **Hotkeys** | Wand aus Tasten (Name, Farbe, Datei, Pegel); Klick spielt sofort über den Segue-Player, zweiter Klick blendet aus | Scheibe 1 |
| **Bibliothek** | Suche im Asset-Bestand (Titel, Interpret, Kategorie), per Drag&Drop in Playlist oder auf eine Hotkey-Taste | Scheibe 2 (Asset → Datei/Dauer/Marken/Lautheit klären) |
| **Mischer/Studio** | Kanalzüge, Rotlicht, Cough, Übergabe (`omp-studio-logic`-Panel) | eigenes Panel, getrennt |
| **Recorder** | Aufnahme aus dem Sendeweg | vorhanden (`omp-recorder`), keine Kachel hier |

## 2. Datenmodell (Erweiterung des Log-Formats, abwärtskompatibel)

`LogItem` bekommt optionale Felder, der Planer (`omp-playout-core::segue`) ignoriert sie:
- `title` — Anzeigename (z. B. „Interpret – Titel“), `id` bleibt die technische Kennung;
- `block` — Name des Blocks, zu dem das Element gehört (aufeinanderfolgende Elemente mit gleichem Namen bilden einen Block).
`Log` bekommt `blocks: [{name, targetMs}]` — Soll-Länge je Block. Die Summe der Dauern wird im Bedienfeld gegen `targetMs` gehalten;
der **Längenausgleich** (Füller/Jingle einfügen) ist Vorschlag im Bedienfeld, die automatische Wahl bleibt Backtiming (RB5, harte Marken).

**Hotkeys (Carts):** `carts: [{label, color, file, durationMs, gainDb}]` im Node (`/state`), Methoden `setCarts`, `fireCart(index)`, `stopCart(index, fadeMs)`.
`fireCart` sendet ein `play` ohne `startAt` an den Segue-Player (eigene `voiceId` `cart-<n>-<TAI-ms>`), die laufende Playlist bleibt unberührt;
der Segue-Player summiert. Ducking des Programms unter dem Cart ist **nicht** Teil dieser Scheibe.

## 3. Scheiben

1. **Konsole + Editor + Werbeblock + Hotkeys** (dieser Schritt).
2. **Bibliothek:** Suche (`GET /api/v1/assets/search`), Zuordnung Asset → Datei (Representation), Dauer, Marken, Lautheit (QC); Drag&Drop.
   Offen: woher Interpret/Kategorie/Marken kommen (Metadatenfelder `asset-fields`).
3. **Werbesystem:** Spotblock-Planung (Kunden/Kampagnen, Rotation, Konkurrenzausschluss), Längenausgleich automatisch, Streaming-Marker
   (`EXT-X-DATERANGE`/SCTE-35, RD), Nachweis (As-Run je Spot für die Abrechnung). Braucht Entscheidungen des Nutzers (siehe unten).
4. **Hotkeys vertiefen:** Seiten, Ducking, Tastenkürzel, Stream-Deck-Belegung, Wellenform/Marker-Editor.

## 4. Offene Entscheidungen (Nutzer)

- Werbesystem: nur **Block im Ablauf** (Importiert aus der Fremdplanung, Entscheidung 3 vom 2026-11-05: „zuerst nur Import“) oder **eigene Spotverwaltung** mit Kampagnen und Rotation?
- Bibliothek: ist der Asset-Bestand (Domäne `asset`) die Musikdatenbank, oder kommt eine Musikliste von außen (Planungssystem)?
