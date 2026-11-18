# Entwurf: Dateiverwaltung (Explorer, Löschen, Upload) und „Datei fehlt“-Filter (Kapitel 86)

Stand 2026-11-04. **Umgesetzt (86.1–86.7, siehe `UMSETZUNG.md` Kapitel 86); Entscheidungen E1–E8 vom Nutzer am 2026-11-04 festgelegt (§3, §8). Abweichungen vom Entwurf stehen im Abschnitt „Umsetzung“ am Ende.** Auslöser: Nutzerfragen „Wie wird aus einer neuen MXF ein Asset, wie weise ich einem Asset eine Datei zu,
wie lösche ich Dateien — gibt es einen Datei-/Media-Explorer?“ und der Wunsch nach einem Filter für Assets, deren Dateien nicht mehr existieren.

## 1. Bestand (geprüft 2026-11-04)

| Thema | Stand |
|---|---|
| Datei → Asset | Nur über *File Eingangskontrolle → Datei importieren* (Liste aus `importDir`, `review/handlers.go: importList`, auf 500 Einträge und Medien-Endungen begrenzt, nur Orchestrator-Rechner) oder von Hand: Asset → Version (Entwurf) → „+ Representation“ mit Speicher + Pfad. |
| Representation | `StorageLocation{Provider, URI}` ist ein **Verweis**; es werden keine Bytes bewegt (BENUTZERHANDBUCH §5b.1). |
| Upload | `POST /api/v1/asset-versions/{id}/upload-url` (Presigned-URL, S3-Backends) existiert; **kein** UI-Knopf. |
| Löschen | Asset „Gelöscht“ → „Gelöschte aufräumen“ (`asset/purge.go`) entfernt DB-Zeilen, **nie Dateien**. `DELETE /api/v1/representations/{id}` nur an Entwürfen, nur der Verweis. |
| Existenzprüfung | `materialize.Check` (Preflight, Zustände READY/REMOTE_ONLY/MISSING …) und Host-Agent-Aktion `check-path` (Datei oder Verzeichnis auf einem Host) — aber nur je Playout-Eintrag, nicht als Bestandsübersicht. |
| Medienlisten | Jeder Player listet sein eigenes `OMP_MEDIA_DIR` (`read_dir`); ohne Löschen, ohne Bezug zu Assets. |
| Weitere Dateien | Review-Proxys (`OMP_REVIEW_DIR`), Untertitel (`SubtitleDir`), Aufnahmen des Rekorders (`OMP_MEDIA_DIR`), Konverter-Ausgaben (ffmpeg-Jobs). |

**Lücken:** (1) kein Überblick, welche Dateien es gibt und zu welchem Asset sie gehören; (2) keine Dateien löschen; (3) „verwaiste“ Dateien (ohne Asset) und
„tote“ Assets (Datei weg) sind unsichtbar; (4) kein Upload aus dem Browser; (5) Dateien liegen auf **mehreren Hosts**, der Orchestrator sieht nur den eigenen Rechner.

## 2. Ziele und Abgrenzung

1. **Datei-Explorer** (neuer Tab oder Unterreiter in *Assets*): Orte (Medienverzeichnis, Importverzeichnis, Proxys, Untertitel, Speicher-Backends) je Host durchsuchen,
   mit Größe, Änderungszeit, Zuordnung („gehört zu Asset X“ / „verwaist“) und Nutzung („in Playlist Y, Aufnahme Z“).
2. **Löschen** von Dateien mit Sicherheitsnetz (Verwendungsprüfung, Papierkorb, Rechte, Audit).
3. **Assets mit fehlender Datei finden:** Filter in der Asset-Liste + Sammelaktionen.
4. **Zuordnen:** Datei im Explorer → „Als Asset anlegen“ / „Zu Asset hinzufügen“ (Representation), auch mehrere auf einmal.
5. **Upload** aus dem Browser (Folgeschritt, braucht E2).

**Nicht Teil:** vollwertiger Dateimanager (Verschieben/Umbenennen beliebiger Systemdateien), Dateitransfer zwischen Hosts (das ist `materialize`, Kap. 27 P8),
Medienarchiv/Hierarchie-Speicher. Der Explorer zeigt **nur freigegebene Wurzeln**, nie das ganze Dateisystem.

## 3. Entscheidungen (vom Nutzer am 2026-11-04 festgelegt; Abweichungen von der ursprünglichen Empfehlung stehen jeweils dabei)

- **E1 Wo sieht der Explorer Dateien? — Empfehlung: Wurzeln je Host, abgefragt über den Host-Agent.**
  Ein Host-Agent-Befehl `list-dir` (Wurzel-Kennung + relativer Pfad, Seitenweise, nur Metadaten) und `stat-many` (Existenz/Größe für viele Pfade in einem Aufruf) ergänzen
  das vorhandene `check-path`. Der Orchestrator selbst ist ein Host unter vielen. Die Wurzeln legt ein Administrator fest (Einstellung `fileRoots`: Name, Host, Pfad,
  Rechte schreibgeschützt/löschbar); kein freier Pfad aus dem Browser (Pfad-Traversal, Symlink-Ausbruch: Auflösen + Präfixprüfung nach `EvalSymlinks`).
  Alternative: nur lokaler Orchestrator-Rechner — einfacher, aber falsch bei den Clustern .60/.61.
- **E2 Upload:** Empfehlung: Browser → Presigned-URL auf ein S3-Backend (vorhanden), danach `materialize` bei Bedarf in ein Medienverzeichnis. Direkter Upload in
  ein Host-Verzeichnis (Stream durch den Orchestrator zum Agent) erst, wenn gebraucht.
- **E3 Löschen: Papierkorb mit einstellbarer Dauer + Notfall-Leerung.** „Löschen“ verschiebt die Datei in `.trash/<Datum>/` derselben Wurzel (gleiche Platte, `rename`, kein Kopieren);
  Wiederherstellen ist ein Klick. **Aufbewahrung einstellbar** (global, je Wurzel überschreibbar; Standard 7 Tage, 0 = sofort endgültig). **Notfall bei knappem Speicher:** unterschreitet der freie Platz einer
  Wurzel die Schwelle (`trashEmergencyFreeGb` bzw. Prozent), leert der Aufräumlauf den Papierkorb **früher, älteste zuerst, nur bis die Schwelle wieder überschritten ist** (Wurzel-bezogen, weil Papierkorb und Original auf
  derselben Platte liegen). Er löscht dabei nie Dateien außerhalb des Papierkorbs, hält Dateien der letzten Minuten (Schutzfrist, Standard 10 min) zurück und meldet jede Notfall-Leerung
  per Alarm (E7) und Audit. Ist der Papierkorb leer und der Platz trotzdem knapp, gibt es nur den Alarm — nie automatisches Löschen aktiver Dateien.
- **E4 Verwendungsprüfung und dynamisches Sperrfenster.** Sperre ist **zeitlich dynamisch, vor und nach der Sendung**, nicht eine feste Zahl:
  *Sperrfenster = [Sendebeginn − `lockBefore`, Sendeende + `lockAfter`]* je Planungseintrag, **und solange die Datei in irgendeiner künftigen Planung steht** (Modus „bis nicht mehr verplant“ = `lockAfter` zählt erst ab der
  *letzten* Verplanung). Beide Werte einstellbar (global, je Wurzel und je Asset-Typ überschreibbar; Standard 24 h vor, 6 h nach, Modus „bis nicht mehr verplant“ an). Wiederholungen/Serienplanungen zählen als Planung.
  *Hart gesperrt (Löschen abgelehnt):* Datei wird von einer laufenden Aufnahme geschrieben, von laufender QC/Proxy-Erzeugung/ffmpeg-Job gelesen, läuft gerade, oder liegt im Sperrfenster.
  *Weich (Warnung mit Liste, ausdrückliche Bestätigung):* veröffentlichte/freigegebene Version, Eingang in Bearbeitung, Verweis in Sammlungen.
  **Administratoren** können eine harte Sperre nur mit „Erzwingen“ (eigenes Recht, Begründung Pflicht, Audit + Alarm) umgehen; **laufende Sendung/Aufnahme bleibt auch dann gesperrt** (nicht umgehbar).
  Verwendungsquellen: Representations (alle Versionen), Playout-Pläne/Playlists (inkl. Sendezeiten), Eingang (Proxys, Segmente), Aufnahme-Aufträge, ffmpeg-Jobs.
- **E5 Was passiert mit dem Asset, wenn die Datei gelöscht wird?** Empfehlung: nichts automatisch löschen. Die Representation bekommt den Zustand **„Datei fehlt“**
  (siehe 4), das Asset bleibt mit Metadaten erhalten (Katalogwert), Löschen des Assets ist ein getrennter, bewusster Schritt. Optional im Dialog:
  „Auch Verweise/Asset entfernen“ (nur bei Entwurf bzw. nach Status „Gelöscht“).
- **E6 Rechte.** Neue Funktionsrechte (Kap. 44-Muster): *Dateien ansehen*, *Dateien löschen*, *Dateien hochladen*, *Papierkorb leeren/Wurzeln verwalten* (Administrator). Jede Aktion im
  Domain-Audit (wer, Host, Wurzel, Pfad, Größe, Hash soweit bekannt, Ergebnis).

- **E7 Benachrichtigung bei fehlender Datei: alles.** Zustandswechsel `present → missing` (nach Zweiprüfung) und Notfall-Leerungen gehen über **alle** vorhandenen Wege: Alarm-Kanal (Kap. 72/Alarmbehandlung), E-Mail-Alarmierung (Kap. 83, Routen je Schwere),
  UI (⚠ in der Liste, Zähler, Hinweis im Asset und in der Playlist/Planung, die die Datei braucht), Domain-Audit, Ereignisbus (Webhook/Prozess-Trigger). **Schwere steigt mit der Nähe zur Sendung:** fehlende Datei, die im Sperrfenster
  (E4) verplant ist, ist *kritisch*, sonst *Warnung*. Entprellt (ein Alarm je Datei und Zustandswechsel, Wiederholung nur nach Frist).
- **E8 Alle Orte als Wurzeln, Zusammengehörigkeit sichtbar.** Medienverzeichnis, Importverzeichnis, Proxys (`OMP_REVIEW_DIR`, schreibgeschützt, da neu erzeugbar), Untertitel, Aufnahmen und Konverter-Ausgaben sind Wurzeln.
  **Dateifamilie:** der Explorer führt jede Datei mit **Rolle** und **Bezug** — *Master/Original · Review-Proxy · Playout-Kopie (materialisiert, Host) · Untertitel · Aufnahme · Konverter-Ausgabe · Verwaist* — und zeigt
  Familien **gruppiert unter dem Asset** (aufklappbar; „Asset X: Master (Host A), Proxy (Orchestrator), Untertitel .srt, Kopie auf Host B“) sowie eine Spalte „Gehört zu“ mit Link, auch in der flachen Ansicht. Ordnungsregeln: Representation → Asset;
  Proxy/Untertitel über Eingangs-Eintrag/Asset-Verknüpfung; Kopien über `materialize`-Zustand; Rest → verwaist. Umschalter „Nach Ort / Nach Asset“. **Löschen wirkt auf die Familie bewusst:**
  Dialog zeigt alle zugehörigen Dateien und bietet „abgeleitete Dateien (Proxy, Untertitel, Kopien) mitnehmen“ an; Master und Familie werden nie stillschweigend mitgelöscht.

## 4. „Datei fehlt“: Zustand und Filter

**Zustand je Representation** (abgeleitet, nicht Teil des Asset-Lebenszyklus, wie Entscheidung E4 in `materialize`): `present`, `missing`, `unreachable` (Host/Backend nicht
erreichbar → *nicht* als fehlend werten), `unknown` (nie geprüft / Verweis ohne prüfbaren Provider, z. B. `http`), plus `checkedAt`, `size`, `mtime`.

**Prüfung:**
- *Provider `filesystem`*: Host aus dem Pfad bzw. der Wurzel; Sammelabfrage `stat-many` je Host (mehrere hundert Pfade je Aufruf, Zeitlimit, Parallelität begrenzt).
- *Provider `s3`/Backend*: `HEAD` auf das Objekt (vorhandener `objectstore`), Fehler „nicht gefunden“ ≠ Netzfehler.
- *`http`*: nicht geprüft (`unknown`).
- **Wann:** (a) beim Öffnen eines Assets (nur dessen Representations, sofort), (b) periodischer Hintergrundlauf unter `runWhileLeader` (Standard alle 6 h, in kleinen Stapeln,
  niedrige Priorität, ändert nichts außer dem Zustand), (c) „Jetzt prüfen“ im Explorer/Filter, (d) nach Löschen/Wiederherstellen im Explorer sofort.
- **Ergebnis persistieren** (neue Spalten oder Tabelle `representation_health`: `representation_id`, `state`, `checked_at`, `size`, `mtime`, `detail`), damit der Filter eine
  Datenbankabfrage ist und nicht bei jedem Aufruf Hosts befragt. Ein Zustandswechsel `present → missing` erzeugt ein Ereignis (Alarm-Kanal, Kap. 83-Mail optional) und eine Audit-Zeile.
  **Flatterschutz:** `missing` erst nach zwei aufeinanderfolgenden Prüfungen (Netzlaufwerk kurz weg).

**Filter in der Asset-Liste:** neues Auswahlfeld **„Dateien“**: *Alle · Alle vorhanden · Datei fehlt · Teilweise fehlend (Proxy/Playout-Kopie fehlt, Master da) · Nicht erreichbar · Nie geprüft ·
Ohne Datei (keine Representation)*. Dazu: Zähler in der Liste („12 mit fehlender Datei“), Symbol ⚠ in der Zeile, Detail zeigt je Representation Zustand, Ort, Größe, Prüfzeit.
API: `GET /api/v1/assets?fileState=missing|partial|unreachable|unchecked|none` (und im Suchendpunkt `/assets/search`), kombinierbar mit Typ/Status.
**Sammelaktionen** auf dem gefilterten Ergebnis: „Erneut prüfen“, „Datei neu zuordnen …“ (Dialog sucht im Explorer nach gleichem Namen/Größe), „Verweis entfernen“,
„Als gelöscht markieren“, CSV-Export. Auch die Gegenrichtung als Filter im Explorer: **Verwaiste Dateien** (kein Asset verweist darauf), mit „Als Asset anlegen“.

**Zuordnung Datei ↔ Representation** muss Pfade normalisieren (Host + Wurzel + relativer Pfad; absolute Alt-Pfade werden gegen die Wurzeln aufgelöst). Das ist die
eigentliche Fleißarbeit und die Fehlerquelle für falsche „verwaist“-Meldungen: Treffer nur bei eindeutiger Auflösung, sonst „unbekannter Ort“.

## 5. Oberfläche (Skizze)

*Tab „Dateien“* (UI-Modul, i18n über `t()` de+en, Dialoge statt `confirm`):
- Links Wurzelbaum (Host → Wurzel → Ordner), oben Suche/Filter (Typ, Größe, Alter, **Verwaist / Zugeordnet / Wird verwendet**), Tabelle: Name, Größe, Geändert, Host, Zuordnung (Asset-Link),
  Verwendung (Anzahl), Zustand. Mehrfachauswahl.
- Aktionen: *Als Asset anlegen*, *Zu Asset hinzufügen*, *Herunterladen* (nur kleine Dateien/Untertitel; Medien nicht durch den Orchestrator streamen), *Löschen* (Dialog mit Verwendungsliste,
  Papierkorb-Hinweis), *Papierkorb* (Ansicht, Wiederherstellen, Leeren), *Ordner neu einlesen*.
- Speicherplatz je Wurzel (frei/belegt, Warnschwelle) — verknüpft mit den Platzwarnungen der Aufnahmeplanung (Kap. 42).
Im Assets-Tab: Filter „Dateien“ (4) und Asset-Detail → Representation → „Im Explorer zeigen“.

## 6. Risiken

- **Falsch-„fehlt“** bei kurz getrenntem Netzlaufwerk → Zustand `unreachable` ≠ `missing`, Zweiprüfung, Alarm erst nach Frist.
- **Löschen unter laufender Sendung** → Verwendungsprüfung (E4) *und* Papierkorb; Löschen nie über offene Dateien hinweg (Rekorder-Datei erkennt man am Aufnahme-Auftrag, nicht an `lsof`).
- **Pfad-Traversal/Symlinks** → Wurzeln, `EvalSymlinks`, Präfixtest, keine absoluten Pfade vom Browser, Tests mit `..`, Symlink aus der Wurzel hinaus, Unicode-Normalisierung.
- **Last:** Verzeichnisse mit 100 000 Dateien → Seitenweise Listing mit Cursor, kein Komplettbaum; Hintergrundprüfung gedrosselt.
- **Gleiche Datei auf zwei Hosts** (Kopie per `materialize`) → Zuordnung je (Host, Pfad); Löschen einer Kopie löscht die andere nie; Anzeige „Kopie auf Host B“.
- **Mehrere Orchestratoren (Cluster):** Prüflauf und Papierkorb-Aufräumen nur beim Leader.

## 7. Schritte (Umsetzungsreihenfolge, jeder mit Verifikation)

- **86.1 Dateizustand je Representation (nur lesen).** Migration `representation_health`; Prüfer für `filesystem` (lokal + `stat-many` im Host-Agent) und `s3`; Zweiprüfung; Hintergrundlauf unter Leader; Benachrichtigung über alle Wege (E7, Schwere nach Nähe zur Sendung);
  `GET /api/v1/assets?fileState=…`; Zähler. *Tests:* Fake-Agent (present/missing/unreachable/Zeitüberschreitung), Flatterschutz, Filterkombinationen, Leader-Wechsel. *Live:* Datei per Hand umbenennen → Asset erscheint unter „Datei fehlt“, zurückbenennen → „vorhanden“.
- **86.2 UI-Filter + Detailanzeige + Sammelaktionen** (Erneut prüfen, Verweis entfernen, Markieren, CSV). *Browserprüfung* mit echtem Klick-Durchlauf; Handbuch §5b ergänzen.
- **86.3 Wurzeln + `list-dir`/`stat-many` im Host-Agent + Orchestrator-API** (`GET /api/v1/files?root=&path=&cursor=`), Rechte, Pfadhärtung, Audit. *Tests:* Traversal/Symlink/Unicode, Seitenweise, Rechte.
- **86.4 Explorer-UI (nur ansehen)** mit Dateifamilien (Rolle/„Gehört zu“, Ansicht nach Ort/nach Asset, E8), Verwaist-Filter, „Als Asset anlegen“ / „Zu Asset hinzufügen“ (Sammelaktion, Pfadnormalisierung).
- **86.5 Löschen + Papierkorb + Verwendungsprüfung** (E3/E4/E8: Papierkorb-Dauer + Notfall-Leerung, dynamisches Sperrfenster, Familien-Löschdialog). *Tests:* hart/weich je Quelle (laufende Aufnahme, laufende/künftige Playlist, veröffentlichte Version), Wiederherstellen, Frist-Aufräumen, Rechte, Audit. *Live:* Löschen einer in der Playlist stehenden Datei wird abgelehnt.
- **86.6 Upload** (E2) über Presigned-URL + Fortschritt; später direkter Host-Upload.
- **86.7 Handbuch** (BENUTZERHANDBUCH §5b/§5c, HANDBUCH, Katalogtext), `FEHLERCODES.md`, Routen-Golden neu erzeugen.

## 8. Entscheidungen des Nutzers (2026-11-04)

1. **Host-Agenten** liefern die Dateisicht je Host (E1).
2. **Papierkorb:** ja, Dauer einstellbar, bei knappem Speicher früher leeren (E3).
3. **Sperrfenster:** dynamisch konfigurierbar, **vor und vor allem nach der Sendung / solange noch verplant** (E4).
4. **Fehlende Datei:** alle Benachrichtigungswege (E7).
5. **Proxys, Untertitel, Aufnahmen als Wurzeln:** ja, **Zusammengehörigkeit sichtbar** (E8).

**Annahme, die nicht ausdrücklich beantwortet wurde (bitte bestätigen):** Administratoren dürfen eine harte Sperre nur mit „Erzwingen“ (Begründung, Audit, Alarm) umgehen; laufende Sendung/Aufnahme bleibt immer gesperrt.

## 9. Umsetzung (Abweichungen und Ergänzungen gegenüber dem Entwurf)

- **Orte = benannte Speicherorte (Kap. 29 Nachtrag B).** Statt einer neuen Konfiguration sind die Explorer-Wurzeln die vorhandenen `storage_locations` (Name, Host, Pfad) plus Tabelle `file_roots`
  (Rolle, schreibgeschützt, Papierkorb-Tage, Notfallgrenze, Sperrfenster). Beim ersten Start legt das Modul Medien, Review-Proxys (schreibgeschützt) und Untertitel an (`files.seeded`).
- **Ein Host-Agent-Befehl `files`** (`jobwire.ActionFiles`, Operationen `stat/list/trash/trash-list/restore/purge/df`) statt mehrerer Aktionen; gleiche Implementierung im Agent und im Orchestrator (`jobwire/files.go`).
  Wurzel-relative Pfade, Symlink-Ausbruch und „..“ werden abgewiesen; „Löschen“ ist ein `rename` in `<Wurzel>/.trash/<Unix-ms>/<rel>`. Optionale Freigabe-Liste je Host: `OMP_FILE_ROOTS`.
- **API-Pfad des Filters:** statt `?fileState=` an `/api/v1/assets` liefert `GET /api/v1/files/asset-states[?state=]` den Zustand je Asset (Zähler inklusive); die Asset-Liste filtert damit.
  Weitere Routen: `/api/v1/files/{roots,config,list,orphans,trash,trash/restore,trash/purge,delete/preview,delete,upload,check,assets,assets/{id},assets/{id}/attach}`.
- **Sperrfenster** (E4): `lockBefore`/`lockAfter` global, je Ort und je Asset-Typ (`assetTypes` in der Konfiguration); `plannedIsHard` = „solange verplant, hart gesperrt“ (Standard an). Der Beginn einer Sendung wird aus dem Zustand des Playout-Kanals
  geschätzt (fester Startzeitpunkt, sonst Beginn des laufenden Eintrags plus Dauern; ohne Sendung der Zeitpunkt der letzten Zustandsänderung). Läuft ein Eintrag gerade, ist die Datei **absolut** gesperrt (auch mit „Erzwingen“).
- **Upload (E2)** nur direkt in Orte des Orchestrator-Rechners (`POST /api/v1/files/upload`, in `.part`, dann `rename`); Presigned-Upload in S3 und Host-Upload bleiben offen.
- **Alarmarten:** `file-missing`, `file-recovered`, `file-trash-emergency`, `file-force-delete` (Gruppe „files“, über die vorhandenen Webhook-/Mail-Routen).
- **Nicht umgesetzt:** Prüfung von `http`-Representations (Zustand „nicht prüfbar“), S3-Prüfung (Hook `ObjectHead` vorhanden, nicht an die Storage-Backends angebunden), Verwendungsprüfung gegen ffmpeg-Jobs
  nur über die Ein-/Ausgabepfade der Job-Spezifikation, Playlists außerhalb des Playout-Moduls (z. B. Fremdplaylist-Importe, die nicht im Kanalzustand stehen).

### 9.1 Nachtrag: gemeinsamer Speicher, hängende Mounts, Einstellungen in der Administration (Nutzerwunsch 2026-11-04)

- **Gemeinsamer Speicher** (`file_roots.shared`, `hosts_json`): ein Ort, mehrere bedienende Hosts in Vorzugsreihenfolge; `Module.rootOp` versucht sie der Reihe nach (nur Host-/Mount-Fehler führen zum nächsten Host, ungültige Anfragen nicht)
  und merkt sich den zuletzt erfolgreichen. Der Ort erscheint einmal im Explorer.
- **Hängende Mounts** (`jobwire/files_timeout.go`): Frist je Operation (lesend 3,5 s, unter der NATS-Frist von 5 s; ändernd 25 s, NATS 30 s); die Operation läuft in einer Goroutine, bei Fristablauf kommt sofort `ErrMountHung`;
  die Wurzel gilt als hängend, solange diese Goroutine nicht zurück ist (weitere Operationen werden sofort abgewiesen, höchstens ein hängender Strang je Wurzel; gleichzeitige Operationen innerhalb der Frist sind erlaubt).
  Gilt im Host-Agent und im Orchestrator. Zustand je Ort (`ok/hung/unreachable`) und Alarme `file-mount-hung`, `file-root-unreachable`, `file-mount-recovered` (zwei Fehlschläge in Folge, Takt-Test alle 30 s).
- **Einstellungen** wohnen in der Administration (Plattform → Betrieb → Dateien, Element `omp-files-settings`), nicht mehr im Reiter „Dateien“.

