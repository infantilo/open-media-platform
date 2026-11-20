# Vertrag „TAMS“ (zeitadressierter Medienspeicher: Aufnahme, Wiedergabe, Zeitverschiebung)

Stand: 2026-11-20 (Kapitel 105). Dieser Vertrag beschreibt, **was Bedienung, Automation und andere Nodes von der Aufnahme in einen
TAMS-Speicher und der Wiedergabe daraus erwarten**. Implementierung: `omp-tams` (Client-Bausteine), `omp-tams-writer` (Aufnahme),
`omp-tams-reader` (Wiedergabe). OMP ist **nur Client** eines fremden Speichers (Entscheidung D-T2); einen eigenen Speicher gibt es nicht.

**Norm-Lage (Regel 10):** TAMS-API **Version 8.2** (Repository `github.com/bbc/tams`, Commit `16c1db08`, Apache 2.0). Gelesen: die
Schnittstellenbeschreibung (Service, Flows, Storage, Segmente), die Schemas für Zeit, Flow, Segment und Storage, AppNotes 0002 (Zeit in
MPEG-TS), 0005 (Segmentierung), 0006, 0008 (Zeit), 0010 (Dauerläufer), 0012, 0016 (Rechte), 0024 und ADR-0028 (Zugang). Eine andere
**Hauptversion** wird abgelehnt (D-T4). **Nicht gelesen:** AppNotes 0013, 0019, 0021, 0048; 0001 (Mehrkanal-Essenz) nur für die Trennung in
je einen Flow je Essenz herangezogen. **An einem echten Speicher noch nicht geprüft** (nur Testserver, der die Regeln durchsetzt, und
der Mock-Server der Spezifikation).

## 1. Zeit
Flow-Zeit = TAI/MXL-Zeit der Aufnahme (Timestamp `Sekunden:Nanosekunden`). Der Schreiber legt Segmentanfang und -ende auf das Raster der Bild-/Abtastrate;
Segmente eines Flows überlappen nie, Lücken bleiben Lücken. MPEG-TS: `Flow-Zeit = ts_offset + Container-Zeit` (PTS 90 kHz, 33 Bit,
Überlauf nach ~26,5 h wird vom Leser aufgelöst). **Abweichung von AppNote 0002:** Beim PTS-Überlauf addieren wir 2^33 Ticks (der Beispielcode der
AppNote addiert (2^33−1)/90000 s, das wäre um 11 µs falsch).

## 2. Aufnahme (`omp-tams-writer`)
- Zwei IS-05-Receiver (Video, Audio). Je Essenz **ein Flow** (Flow-ID = MXL-Flow-ID), Container `video/mp2t` (H.264/AAC), Segment beginnt mit Schlüsselbild, Standardlänge 2 s.
- Methoden `tams.start`, `tams.stop`. Kennzahlen `tams.status|connected|service|queueSegments|queueBytes|registered|rejected|droppedOverflow|segmentsWritten|errors|lagMs|lastError`.
- Die Live-Kette wird **nie blockiert**: Ausfall des Speichers füllt eine Warteschlange auf der Platte (Standard bis 2 GB, überlebt Neustart); ist sie voll, werden die **ältesten** Segmente verworfen (Lücke, nie Überlappung; Alarm).
- Unklarer Ausgang einer Registrierung wird beim Speicher **nachgefragt**, nicht blind wiederholt.

## 3. Wiedergabe (`omp-tams-reader`)
- Zwei IS-04-Sender (Video, Audio), Format des Videos = Konfiguration (`OMP_WIDTH/HEIGHT/FRAMERATE_NUM/DEN`, Standard 1280×720@25); abweichende Aufnahmen werden skaliert/angepasst.

| Methode | Argumente | Wirkung |
|---|---|---|
| `tams.play` | `videoFlow`, `audioFlow` (UUID, mindestens einer), `start` (+ `end`) als Zeitstempel **oder** `agoSeconds` (+ `durationSeconds`) | Zeitbereich abspielen; Anfang erscheint nach dem Vorlauf (`OMP_TAMS_LEAD_MS`, Standard 2000) am Ausgang. Ohne `end`/`durationSeconds` bei `agoSeconds`: bis „jetzt“; bei `start` ohne `end`: läuft in die Gegenwart weiter |
| `tams.follow` | `videoFlow`, `audioFlow`, `delayMs` (1000…86400000) | Aufnahme zeitverschoben wiedergeben: Ausgabe liegt genau `delayMs` hinter der Aufnahme. Muss mindestens Segmentlänge plus Aufnahmeverzug betragen |
| `tams.stop` | — | Wiedergabe beenden |

- Kennzahlen `tams.status` (`idle|playing|following|error`), `tams.segmentsFetched|framesOut|blocksOut|gapsFilled|lateDropped|errors|lastError`.
- **Lücken:** letztes Bild wiederholen (`OMP_TAMS_GAP=hold`, Standard) oder Schwarz (`black`), Ton Stille; über 60 s wird gesprungen. Bild und Ton teilen **einen** Zeitversatz (synchron).
- Bilder, die mehr als 1 s zu spät wären, werden verworfen und gezählt (`lateDropped`).
- **Folge-Modus fragt den Speicher ab** (alle 400 ms); ein Webhook ist nicht gebaut.
- Eine Wiedergabe läuft je Instanz; zweites `tams.play` ohne `tams.stop` wird abgelehnt.

## 4. Zugang und Schutz (Entscheidung D-T3)
`OMP_TAMS_URL` (inkl. Versionspfad), `OMP_TAMS_AUTH` (`none|bearer|basic|url_token`), `OMP_TAMS_USER`; Geheimnis **nur** aus `OMP_TAMS_TOKEN_FILE` (Rechte höchstens 0600) oder
`OMP_TAMS_TOKEN`, nie aus Parametern, Datenbank oder Log. TLS ist Pflicht außer Loopback. Keine Weiterleitungen; Zugangsdaten gehen nur an den Ursprung der API-Adresse, nie an
fremde Objekt-Adressen; ein `Link` auf fremden Ursprung ist ein Fehler. Ohne gültige Einrichtung läuft der Node trotzdem und nennt den Grund in `tams.lastError`.

## 4a. Metadaten-Kopie und geplante Aufnahme
`tams.copyRange(videoFlow, audioFlow, start, end, label)` (Schreiber) legt je angegebenem Flow einen **neuen Flow mit neuer Source** an, dessen Segmente auf dieselben Objects zeigen (kein Kopieren von Medien); der Bereich wird auf **ganze Segmente erweitert**. Läuft im Hintergrund: `tams.copyStatus` (`idle|running|done|error`), Ergebnis als JSON in `tams.lastCopy` (je Essenz `sourceFlow`, `flowId`, `sourceId`, `segments`, `from`, `to`). Der Aufnahme-Zeitplan (Kapitel 42) kennt das Profil-Ziel `tams`: der Auftrag startet den Schreiber, und nach dem Stopp entsteht die Kopie des Aufnahmebereichs samt **Verweis-Asset** (Darstellungen Anbieter `tams`, URI `tams://<Flow>?timerange=…`). Schlägt die Kopie fehl, bleibt die Aufnahme im Speicher; der Auftrag steht auf `failed` (Stufe `finalize`).

## 4c. Clip-Export
`tams.export(videoFlow, audioFlow, start, end, name, exact)` (Wiedergabe-Node) schreibt einen Zeitbereich in eine Datei unter `OMP_TAMS_EXPORT_DIR` (Name: nur `[A-Za-z0-9._-]`, Endung mp4/mkv/ts/mov, Standard mp4). Standard ist Stream-Copy: der Bereich wird auf **ganze Segmente** des Videos erweitert, der Ton auf dasselbe Fenster zugeschnitten. `exact=true` kodiert neu (H.264/AAC) und schneidet bildgenau. Lücken in der Aufnahme werden nicht gefüllt. Status `tams.exportStatus` (`idle|running|done|error`), Ergebnis als JSON in `tams.lastExport` (`path`, `from`, `to`, `segments`, `gaps`). Benötigt ffmpeg auf dem Rechner des Nodes (`OMP_FFMPEG`).

## 4b. Aufbewahrung (AppNote 0019)
`OMP_TAMS_RETENTION_HOURS` (Schreiber, Standard 0 = unbegrenzt): die vom Schreiber angelegten Flows tragen das Tag `segment_retention_offset`; ein Löschlauf räumt alle 60 s mit `DELETE /flows/{id}/segments?timerange=_<jetzt − Offset>)` auf. Nur eigene Flows, nie fremde; der Dienst löscht nur vollständig abgedeckte Segmente und Objects erst nach dem letzten Verweis (Metadaten-Kopien bleiben also erhalten). Der Schreiber braucht dafür Löschrecht am Flow (AppNote 0016). Ebenso `OMP_TAMS_FLOW_RETENTION_HOURS` (Tag `flow_retention_offset`; ein eigener Flow wird gelöscht, wenn das Spätere von `metadata_updated` und `segments_updated` plus Offset erreicht ist) und `OMP_TAMS_EMPTY_FLOW_HOURS` (eigene Flows ohne Segmente und ohne Änderung seit so langer Zeit). Am Aufnahmeprofil `tams` (Zeitplan) gibt es dafür `retentionHours`, `flowRetentionHours`, `emptyFlowHours`; der Löschlauf im Schreiber läuft nur, solange die Instanz lebt — dauerhaft räumt der Node `omp-tams-janitor` auf: er findet Flows über die Tags (`GET /flows?tag_exists.<tag>=true`), richtet sich nach dem Offset **jedes** Flows, löscht Segmente und abgelaufene Flows (leere Flows nur mit Tag und nur mit `OMP_TAMS_EMPTY_FLOW_HOURS`) und fasst Flows ohne Tag nie an. Er braucht Löschrecht (AppNote 0016).

## 5. Bedienfelder
Beide Nodes liefern `/ui/manifest.json` und `/ui/bundle.js` (Web-Komponenten `omp-tams-writer-panel`, `omp-tams-reader-panel`, Muster wie `omp-ptz`, eigene de/en-Texte im Bundle). Die Felder nutzen nur die Parameter und Methoden dieses Vertrags.

## 6. Grenzen
CMAF/fragmentiertes MP4 (braucht `cmafmux`), Webhook, Rechte nach AppNote 0016 im OMP, Aufbewahrung/Löschen, Metadaten-Kopie je Sendung, Mehrkanal-Sammel-Flow: **offen** (Kapitel 105.3b, 105.6).
