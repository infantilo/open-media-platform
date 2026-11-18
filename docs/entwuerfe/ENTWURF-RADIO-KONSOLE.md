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

## 1a. Grundsatz: Sendungen vorbereiten, nicht nur live fahren (Nutzer 2026-11-06)

Alles, was zu einer Sendung gehört — Ablauf, Moderationskarten (Texte), Hotkeys, Notizen — gehört **der Sendung**, nicht dem Platz. Moderatorinnen
und Moderatoren bereiten sie Tage vorher vor (Status „in Vorbereitung“), die Redaktion gibt frei, zur Sendezeit wird die Sendung in die
Automation geladen („auf Sendung“) und danach abgeschlossen. Wiederkehrende Formate sind **Vorlagen**. Dafür gibt es das Orchestrator-Modul
`radio` (Tabellen `radio_shows`, `radio_show_versions`, Rechte `radio.show.*`); das Dokument ist offen (`content` mit `log`, `carts`, `cards`, `notes`,
unbekannte Schlüssel bleiben erhalten), damit neue Funktionen ohne Modulumbau dazukommen. Leitlinie für alles Weitere: **dynamisch** (je Sendung
konfigurierbar, keine festen Belegungen im Code) und Funktionsumfang wie moderne Sendeplatz-Produkte.

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

- ~~Werbesystem~~: **entschieden 2026-11-06: beides** — Blöcke aus der Fremdplanung (Import) **und** eigene Spotverwaltung mit Kampagnen/Rotation.
- Bibliothek/Datenquellen: **Entscheidung in der Woche ab 2026-11-09**; der Nutzer nennt die vorhandenen Systeme und woher die Daten kommen, dann werden sie eingebunden (bis dahin nichts annehmen).
