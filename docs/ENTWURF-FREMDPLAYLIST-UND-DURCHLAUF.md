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

## 2. Mitlauf-Quelle: Watchfolder (Entscheidung Nutzer 2026-10-28)

Die SOAP-Schnittstelle (API.zip) ist nach Aussage des Nutzers nicht 100 % zuverlässig; der heutige Havarie-Betrieb läuft
über die **Autorejoin-Dateien in einem Watchfolder**. OMP übernimmt genau dieses Verfahren — die API wird nicht in den
kritischen Pfad gelegt (höchstens später als Zusatzsignal; WSDL liegt außerhalb des Repos).

Beobachtungen an den Beispieldateien, auf die der Watcher aufbaut:
- Dateiname `Autosaved_<Kennung>_<hh-mm-ss-ff>_<dd-mm-yyyy>.mpl`; der Zeitstempel im Namen entspricht (auf wenige Frames)
  `properties/timecode/@houseTime` → Alter einer Datei ohne Parsen erkennbar. Die Kennung (5000/5002) trennt Kanäle.
- Dateien sind groß (4–5 MB, > 1000 Events) und werden vom Fremdsystem geschrieben → Watcher muss **unvollständige
  Dateien erkennen** (Größe stabil, Abschluss-Tag `</marinaPlaylist>` vorhanden, wohlgeformtes XML), sonst Datei verwerfen und die
  vorherige gültige behalten. Nie eine halbe Datei laden.
- Die Position „was ist jetzt on air“ steckt in der Datei selbst (`state/@state=Running`, `status/@focusIndex`,
  `listState`) plus `houseTime`; zwischen zwei Dateien wird nach Uhrzeit fortgeschrieben.
- Hängt der Eingang (neueste gültige Datei älter als Schwelle, Standard 120 s), meldet OMP das als Alarm — das ist der
  typische Havarie-Auslöser und muss sichtbar sein, bevor jemand übernimmt.
- Neue Datei = Abgleich (Diff) gegen die bisherige Mitlauf-Liste per `reconcileKey`/`uid`, nicht Komplettaustausch, damit
  Vorbereitungen (Preflight, QC-Status) erhalten bleiben.

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

## 4. Entscheidungen (Nutzer 2026-10-28)

1. **Mitlauf-Quelle:** Watchfolder auf die Autorejoin-Dateien (§2); keine SOAP-Abhängigkeit.
2. **Mitlauf-Verhalten:** Die Schattenliste zieht sich **automatisch synchron** mit jeder neuen gültigen Fremddatei (Diff, §2). Die Player
   werden im Schattenbetrieb nicht angefasst; die Übernahme („Havarie ziehen“) ist eine bewusste Bedienung ab dem laufenden Event.
3. **Freigabe-Flag:** ja. Standard AUS (Altlisten unverändert), je Channel und je Event einschaltbar: Sendung nur bei „QC grün **oder**
   manuell freigegeben“; bei Verstoß greift die vorhandene Ausfallrichtlinie (HOLD/SKIP/FALLBACK/…).
4. **Vergleichskriterien Original ↔ Secondary Record:** Dauer ±1 Frame, Framerate exakt gleich, SSIM ≥ 0,98 auf Stichprobe, keine neuen QC-Fehler.
5. **Architektur:** Fremdformate sind **Adapter-Plugins im `omp-playout-automation`-Node**, damit andere Sender andere Automationssysteme
   anbinden können (siehe §6). Keine Herstellernamen im Produkt.

## 6. Plugin-Architektur für Fremdformate

Trennung in zwei Schichten, damit ein neuer Adapter nur das Format kennen muss:

- **Adapter** (`trait ForeignFormat`, ein Modul je Format, Registrierung im Node beim Start): `id()` (z. B. `mpl3`), `label()`,
  `sniff(bytes) -> bool` (erkennt das Format am Inhalt), `parse(bytes, &ParseCtx) -> Result<ForeignList, ParseError>`,
  `is_complete(bytes) -> bool` (für den Watcher: Datei fertig geschrieben?). Ergebnis ist ein **neutrales Zwischenmodell**
  `ForeignList { channel, list_state, house_time, events: Vec<ForeignEvent>, report }` mit `ForeignEvent { uid, reconcile_key, kind
  (Clip|Live|Image|Hold|Marker|Comment), title, media_name, source_logical, fallback_logical, start (Fixed|Sequential|ParentStart),
  duration/end, som, transition, state, children, meta, warnings }`. Zeiten sind exakte Frames + Framerate (kein Gleitkomma).
- **Kern (formatunabhängig):** Zwischenmodell → OMP-Items (Abbildungstabelle §3), Watchfolder-Watcher (§2), Diff/Sync, Schattenliste,
  Übernahme, Importbericht, Alarm bei veraltetem Eingang, Freigabe-Flag. Dieser Teil wird einmal gebaut.
- **Als Plugin sichtbar:** Jeder Adapter ist im vorhandenen SDK-Plugin-Host (`PluginRegistry`) eingetragen (`foreign-<id>`, Standard AUS).
  Konfiguration (JSON): `watchDir`, `filePattern`, `channelKey` (z. B. Kennung 5000), `maxAgeSec` (120), `autoSync` (an), `mode` (`shadow`|`off`).
  Aktivieren/Konfigurieren läuft über die bestehenden Routen `/api/v1/nodes/<id>/plugins/<pluginId>`.
- **Grenze (ehrlich):** „Plugin“ heißt hier fest einkompiliertes, einzeln schaltbares Modul, nicht zur Laufzeit nachladbare Bibliothek
  (Rust, kein stabiles ABI). Ein neuer Adapter ist eine Datei + eine Registrierungszeile; ein späteres Nachladen (WASM/Prozess über
  Standard-Ein-/Ausgabe) bleibt möglich, weil die Schnittstelle bytes → neutrales JSON ist. Das Zwischenmodell ist serialisierbar angelegt.

## 5. Schritte (je eine Sitzung, §0 Punkt 2)

| Schritt | Inhalt | Verifikation |
|---|---|---|
| 74.1 | Parser `mpl3` (reine Rust-Logik im Node, Fixtures anonymisiert) + Importbericht + Methode `importForeign` ohne UI; Frame-Zeit exakt | Unit-Tests auf Fixtures, Import beider Echtdateien → Zählung stimmt (376/483 Primaries), Laufzeit < 1 s |
| 74.2 | Import-Dialog im Panel (Datei wählen/ablegen, Vorschau + Bericht, „Ersetzen/Anhängen ab Block“) | Browser-Klicktest |
| 74.3 | Freigabe-Flag + Verknüpfung Eingang (Kap. 43) → Asset/Item: `MISSING` → Datei kommt an → QC → grün/Freigabe → READY | Unit + Live: Item wartet, wird nach Freigabe gesendet |
| 74.4 | Voll-Durchlauf-Test: Workflow erkennt Datei, Auto-QC, Review mit Segmenten, Playlist-Sendung, Secondary Record (Kap. 42) | E2E-Skript `tools/playout-e2e/` |
| 74.5 | Vergleichsbericht Original ↔ Aufnahme (ffprobe + Qualitätsmaß), im Eingang sichtbar | Test mit absichtlich verschlechterter Aufnahme schlägt an |
| 74.6 | Havarie-Mitlauf: Watchfolder-Watcher (§2: Vollständigkeitsprüfung, Diff, Alter-Alarm), Schattenmodus + Übernahme | Lauf mit Echtdateien in zeitlicher Folge (Kopien nacheinander in einen Testordner, auch eine abgeschnittene Datei) |
| 74.7 | UI-Pass „intuitiver“ (Child-Editor statt JSON, Audio-Wahl beim Anlegen, Zeitzone, Spaltenbreiten) — Stolpersteine vom Nutzer | Browser-Klicktest |

Reihenfolge-Empfehlung: 74.1 → 74.3 → 74.4 → 74.5 (der gewünschte Voll-Durchlauf zuerst, braucht keine Fremdformate),
74.2 und 74.6 danach, 74.7 mit Nutzerbeispielen.
