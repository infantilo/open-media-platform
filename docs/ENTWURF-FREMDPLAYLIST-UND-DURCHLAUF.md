# Entwurf: Fremdplaylist-Import, Havarie-Mitlauf, Freigabe-Durchlauf (Kap. 74)

Stand 2026-10-28. Nutzerauftrag: Playout-Automation weiterbringen — (1) Oberfläche intuitiver,
(2) Playlisten eines Fremdsystems importieren und (3) parallel dazu als Havarie-Playout mitlaufen,
(4) Voll-Durchlauf „neue Datei → Workflow → QC → manuelle Kontrolle/Segmente → Playlist → Sendung →
Secondary Record → Vergleich“.

Leitplanken: Das Fremdformat ist **kein** internes Format, nur Ein-/Ausgang (Adapter). Im Produkt
steht kein Herstellername (Projektregel); Bezeichnung: „Fremdplaylist“, Format-Kennung `mpl3`.
Echte Sendelisten liegen nur außerhalb des Repos; Test-Fixtures werden anonymisiert/verkleinert erzeugt.

## 1. Befund aus den zwei Beispieldateien (Format `marinaPlaylist version="3.1"`)

Beide Dateien (≈3,8 und 5,2 MB, 1057 bzw. 1470 Events) haben denselben Aufbau; eine ist ein Sicherungsstand
der laufenden Liste, die andere eine Kanal-Verwaltungsliste — **gleiches Schema**, ein Parser genügt.

- `properties/channel`: Kanalname, Zeitversatz (`timeOffsetValue`), `txTime`; `properties/status`: Listenzustand
  (`Primary Prepared|Primary Running|Primary OnAir`), Fokusindex; `properties/timecode/@houseTime`.
- `eventList/event` (Primary) mit **verschachtelten** `childEvents/event`. Event-Typen und Häufigkeit:
  `PrimaryVideo` (Datei), `Live` (logische Quelle, z. B. `RP21`, Rückfall `DMX21`), `Comment`, `PlaylistStart`/`PlaylistEnd`
  (Blockmarken), Kinder `LogoSD/HD/UHD/TV-Thek`, `VIZ` (Grafik), `AudioMixer-ALL` (Audio-Preset je Datei).
- Zeit: Format `YYYY-MM-DDThh:mm:ss:ff` (**Frames** als letztes Feld, kein Bruchteil!), plus Ticks `schedStartTick`
  usw. mit `fixed`/`committed`; `schedule/@startType` (`Sequential`, `+ParentStart`, fixed), `endType`
  (`Duration`, `Hold`, `-ParentEnd`), `startOffset`/`endOffset`.
- Medium: `properties/media/@mediaName` (Medienkennung, nicht Dateipfad), `mediaStream/@som` (Start-of-Material, Timecode),
  `segment type="Markup"/"Media"`, Redundanz `Main`/`Backup 1` mit Stream-Namen.
- Übergang: `switch/@transition` (`Cut`, `Fade Cut`, …), `switch/@rate`; Quelle/Ziel `Auto|Logical`.
- Merkmale (`features/feature@type`): `Loudness` (Preset), `VPS`, `Subtitle` (eigene Medienkennung), `AudioShuffle`, `AFD`.
- Metadaten: `event/@reconcileKey` (Schlüssel zum Planungssystem!), `@title`, Klassifikation, `auxData/payload/field` (ID-Felder).
- Laufzeitzustand: `state/@state` (`Done|Running|Initialised|…`) — beim Import nur lesen, nicht übernehmen.
- Neue Ereignisse von Validatoren erscheinen als `Comment`-Events („RulesEngine: …“).

Ohne `quick-xml`/`roxmltree` im Workspace: für den Parser ist eine XML-Dependency nötig (§0 Punkt 5 — Begründung:
Dateien mit mehreren MB, verschachtelt, Entitäten; Handparser wäre fehleranfällig). Vorschlag `roxmltree` (reine Rust-Lib, keine Unsafe-/Build-Abhängigkeit).

## 2. Die mitgelieferte Schnittstelle (API.zip, SOAP/WSDL)

- **Klassische API:** `getListEventChanges`, `getContiguousListEvents`, `getListEvent`, `getJob`, `heartbeat`, `getMediaMetadata`,
  `insertUpdateJob` …; **Notification-API:** `OnListChanged`, `OnJobStateChanged` (das Fremdsystem ruft UNS an).
- **API 2.0:** `appendPlaylist`, `replacePlaylist*`, `getPlaylistBlocks` (Gegenrichtung: Liste ins Fremdsystem schreiben).
- Für den Havarie-Mitlauf ist die **Notification-/Abfrage-Seite** wichtig: sie liefert „was ist jetzt on air, was kommt“, ohne Dateien
  abzufischen. Das ist robuster als Dateipolling, setzt aber SOAP-Server/-Client voraus (WSDL → handgeschriebene
  Minimal-Umsetzung statt Generator) und einen Nutzerentscheid (§4 Frage 2).

## 3. Abbildung Fremdevent → OMP-Item (Import, nur lesend)

| Fremd | OMP |
|---|---|
| `PrimaryVideo` | `CLIP`, `media` per Medienkennung → Asset-Suche (Kap. 21) → `asset`-Referenz; nicht gefunden = `MISSING` |
| `Live` (logische Quelle) | `LIVE` mit `LiveSelect` (Tag-Selektor `name=RP21`), Rückfall = `DMX21` als Fallback-Kandidat |
| `Comment` | Notiz am Vorgänger-Event (nie als Event) |
| `PlaylistStart/End` | Blockgrenzen (Listen-Markierung) |
| `schedStartTick` fixed | `Fixtime` mit `startAt` (UTC, aus Ortszeit + `timeOffsetValue`; **Frames → ms nach Listen-Framerate**) |
| `Sequential` | `Auto`-Folgestart |
| `switch/@transition` Cut/Fade Cut | `Cut`/`Mix` (Rate aus `switch/@rate`) |
| Kinder Logo*/VIZ | Child Events (Grafik) mit `target`/Parameter aus dem Quelltext; unbekannte Typen → Hinweis, nicht erfinden |
| `AudioMixer-ALL`, `Loudness`, `AudioShuffle` | `audio`-Absicht bzw. Notiz „nicht abgebildet“ (Importbericht) |
| `reconcileKey`, `auxData` | Item-Metadaten `foreign{…}` (für Rückabgleich und As-Run-Rückmeldung) |

Wichtig: Der Import erzeugt immer einen **Importbericht** (übernommen / angenähert / verworfen, mit Grund), damit nichts
stillschweigend verschwindet.

## 4. Offene Entscheidungen für den Nutzer

1. **Mitlauf-Quelle:** (a) Datei-Polling der Autosave-/Sicherungsdatei (einfach, minutenverzögert), (b) die Notification-API
   (SOAP, nahezu in Echtzeit), (c) beides. Empfehlung: erst (a) zum Beweis des Modells, dann (b).
2. **Mitlauf-Verhalten:** Schattenbetrieb = Automator rechnet die Fremdliste live mit (Position per Uhrzeit/`houseTime`, ohne die
   Player anzufassen), Übernahme per Knopf ab dem laufenden Event („Havarie ziehen“). Bestätigen?
3. **Freigabe-Flag:** Standard AUS (alte Listen verhalten sich unverändert); pro Event oder pro Channel einschaltbar:
   „nur senden, wenn QC grün **oder** manuell freigegeben“. Bei Verstoß greift die vorhandene Ausfallrichtlinie (HOLD/SKIP/FALLBACK …).
4. **Vergleich Original ↔ Secondary Record:** Welche Kriterien zählen als „bestanden“ (Dauer ± Frames, Framerate gleich,
   Auflösung/Codec egal?, Qualität = SSIM/PSNR-Schwelle oder QC-Befunde gleich)? Vorschlag: Dauer ±1 Frame, Framerate exakt,
   SSIM ≥ 0,98 auf Stichprobe, QC-Bericht der Aufnahme ohne neue Fehler.

## 5. Schritte (je eine Sitzung, §0 Punkt 2)

| Schritt | Inhalt | Verifikation |
|---|---|---|
| 74.1 | Parser `mpl3` (reine Rust-Logik im Node, Fixtures anonymisiert) + Importbericht + Methode `importForeign` ohne UI; Frame-Zeit exakt | Unit-Tests auf Fixtures, Import beider Echtdateien → Zählung stimmt (376/483 Primaries), Laufzeit < 1 s |
| 74.2 | Import-Dialog im Panel (Datei wählen/ablegen, Vorschau + Bericht, „Ersetzen/Anhängen ab Block“) | Browser-Klicktest |
| 74.3 | Freigabe-Flag + Verknüpfung Eingang (Kap. 43) → Asset/Item: `MISSING` → Datei kommt an → QC → grün/Freigabe → READY | Unit + Live: Item wartet, wird nach Freigabe gesendet |
| 74.4 | Voll-Durchlauf-Test: Workflow erkennt Datei, Auto-QC, Review mit Segmenten, Playlist-Sendung, Secondary Record (Kap. 42) | E2E-Skript `tools/playout-e2e/` |
| 74.5 | Vergleichsbericht Original ↔ Aufnahme (ffprobe + Qualitätsmaß), im Eingang sichtbar | Test mit absichtlich verschlechterter Aufnahme schlägt an |
| 74.6 | Havarie-Mitlauf (Schattenmodus + Übernahme), Quelle nach Entscheid §4.1 | Lauf gegen die Echtdatei als Wiedergabe der Zeit |
| 74.7 | UI-Pass „intuitiver“ (Child-Editor statt JSON, Audio-Wahl beim Anlegen, Zeitzone, Spaltenbreiten) — Stolpersteine vom Nutzer | Browser-Klicktest |

Reihenfolge-Empfehlung: 74.1 → 74.3 → 74.4 → 74.5 (der gewünschte Voll-Durchlauf zuerst, braucht keine Fremdformate),
74.2 und 74.6 danach, 74.7 mit Nutzerbeispielen.
