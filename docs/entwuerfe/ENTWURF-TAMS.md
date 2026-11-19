# Entwurf: TAMS — zeitadressierter Medienspeicher (Kapitel 105)

Stand 2026-11-19. **Nur Entwurf, nichts gebaut.** Er hält fest, was die Spezifikation verlangt
(Originaltext gelesen, Version genannt, Regel 10 in `UMSETZUNG.md` §0) und wie OMP sie umsetzen soll.

## 1. Normlage

| Was | Stand |
|---|---|
| Spezifikation | Time-addressable Media Store (TAMS) API **Version 8.2**, Repository `github.com/bbc/tams`, Commit `16c1db08` vom 2026-10-16, Lizenz Apache 2.0 |
| Gelesen (Originaltext) | `api/TimeAddressableMediaStore.yaml` (Service, Storage, Segmente), Schemas `timestamp`, `timerange`, `flow-common`, `flow-technical`, `flow-video`, `flow-audio`, `flow-segment(-post)`, `flow-storage(-post)`, `service`, `storage-backend`, `webhook`, `container-mapping`, `source`; AppNotes **0002, 0005, 0006, 0008, 0010, 0012, 0016, 0024**, ADR-0028 |
| **Noch nicht gelesen** | AppNote **0001** (Multi-Mono-Essence, 935 Zeilen, nur Gliederung gesehen — vor 105.3 lesen), **0013** (Bitraten), **0019** (Retention), **0021** (Integrität), **0048** (Prüfsummen, im Storage-Schema genannt), die übrigen ADRs. Vor dem jeweiligen Schritt lesen, nicht aus diesem Entwurf ableiten |
| Zugehörig | NMOS-Format-URNs (`urn:x-nmos:format:video/audio/data`), RFC 6838 (MIME-Typen), PTP-Zeitmodell auf TAI |
| EBU-Bezug | Die EBU-Gruppe „Open Live Production Cloud“ plant TAMS für Aufnahme, Replay und Schnitt. Welche TAMS-Version sie festlegt, ist nicht veröffentlicht |

## 2. Was die Spezifikation verlangt (Kurzfassung für die Umsetzung)

**Modell.** *Source* (abstrakter Inhalt) → *Flow* (ein Strom, z. B. Video oder Audio) → *Flow Segment* (Zeitabschnitt, verweist auf ein *Object*). Objects sind unveränderlich und referenzgezählt. Mehrere Flows dürfen dasselbe Object verwenden (Kopie nur der Metadaten). Mehrere Essenzen: je Flow ein eigener Strom, gebündelt über `flow_collection` (AppNote 0006).

**Zeit.** Timestamp `{vorzeichen?}{sekunden}:{nanosekunden}` (ohne führende Nullen, Nanosekunden ≤ 999999999), Basis TAI/PTP-Epoche. TimeRange `[a_b)`, `(a_`, `_` (ewig), `()` (leer), `[a]` (ein Punkt). Ein Punkt ist `<flow_id, timestamp>`. Zeitstempel müssen linear sein; Segmente eines Flows dürfen sich **nicht überlappen**. Zeitverschieben = neuer Flow und neue Source, **ohne** Objects zu kopieren (AppNote 0008).

**Schreiben.** `PUT /flows/{id}` → `POST /flows/{id}/storage` (Upload-URLs, Stapel, `limit`) → Object per HTTP PUT hochladen → `POST /flows/{id}/segments` (einzeln oder als Feld; 201 oder 200 mit Fehlerliste). Nicht registrierte Objects werden nach `min_object_timeout` vom Dienst verworfen. Wichtige Segment-Felder: `object_id`, `timerange`, `ts_offset` (= Segmentzeit − Objektzeit), `object_timerange`, `last_duration`, `sample_offset`, `sample_count`, `key_frame_count`, `init_object_id`.

**Lesen.** `GET /flows/{id}/segments?timerange=…` (Seitenweise: `Link`/`X-Paging-NextKey`; Filter `accept_get_urls`, `presigned`, …) → Objects laden → zusammenfügen → Grains außerhalb des gewünschten Bereichs am Anfang und Ende verwerfen.

**Löschen.** `DELETE /flows/{id}/segments?timerange=…` (nur vollständig abgedeckte Segmente; bei Dauer `202` mit `/flow-delete-requests/{id}`). Der Dienst löscht Objects erst, wenn keine Segmente mehr darauf zeigen.

**Dienst.** `GET /service` (`api_version`, `min_object_timeout`, `event_stream_mechanisms`), `GET /service/storage-backends` (Typ `http_object_store`), Webhooks `POST /service/webhooks` (Ereignisse `flows/created|updated|deleted|segments_added|segments_deleted`, `sources/…`; Filter nach Flow/Source).

**Zugang.** Der Client **soll** Bearer-Token, Token in der URL und HTTP-Basic können (ADR-0028); TLS wird vorausgesetzt. Autorisierung ist Sache des Dienstes; AppNote 0016 empfiehlt die Bereiche `tams-api/admin|read|write|delete` je Endpunkt.

**MPEG-TS-Zeit (AppNote 0002).** PTS/DTS sind nur die unteren 33 Bit eines absoluten Zählers (90 kHz) und laufen etwa alle 26,5 Stunden über. Der Schreiber legt deshalb je Segment `ts_offset` so fest, dass `Objektzeit + ts_offset = Flow-Zeit` gilt; der Leser rechnet die absolute Zeit als `ts_offset + PTS/90000` und erkennt einen Überlauf mitten im Segment (PTS wird kleiner, vorheriger PTS > 2^33 − 2^31 → eine Überlaufperiode, (2^33−1)/90000 s, addieren). Pflicht-Test in 105.1/105.3/105.4.

**Segmentierung.** Objects sollen **unabhängig dekodierbar** sein (AppNote 0005: GOP-Grenze, Segment beginnt mit Schlüsselbild) und eher mehrere MB groß; die Ziel-Dauer steht im Flow (`segment_duration`). Medien mit Init-Segment (CMAF) nutzen `init_object_id` (AppNote 0024).

**Dauerläufer.** Ein Aufnahmeport darf **ein langlebiger Flow** sein; redaktionell sinnvolle Abschnitte (Sendung, Buchung) werden als **Metadaten-Kopie** (neue Source/Flow, gleiche Objects) angelegt. Aufbewahrung je Flow über Löschen nach Zeitbereich (AppNote 0010).

## 3. Abbildung auf OMP

| TAMS | OMP |
|---|---|
| Timestamp | MXL-Grain-Index auf TAI: `ts = index · (rate_den / rate_num)` in ns (128-Bit-Rechnung, auf Bildgrenzen regularisiert, AppNote 0008). `omp-mediaio::timebase` rechnet bereits so |
| Flow-ID | die MXL-/IS-04-Flow-ID (UUID) des aufgenommenen Flows; Source-ID abgeleitet (UUIDv5 aus Node und Flow) |
| Video-Flow | `urn:x-nmos:format:video`, `video/h264`, Container `video/mp2t`; Auflösung, Bildrate, Halbbild, Farbraum aus den MXL-Flow-Daten (schon vorhanden: `colorimetry.rs`, `framerate.rs`) |
| Audio-Flow | `urn:x-nmos:format:audio`, `audio/aac` oder PCM; Kanäle aus dem Audio-Kanalplan (Kap. 45) |
| Mehrspur | je Essenz ein Flow plus ein sammelnder Flow (`flow_collection`); Zeitbezug über die gemeinsame TAI-Zeit, nicht über Muxen |
| Aufnahmeport | langlebiger Flow (AppNote 0010); Sendungs-Abschnitt = Metadaten-Kopie, angelegt von der geplanten Aufnahme (Kap. 42) |
| Rechte | OMP-Rollen → TAMS-Bereiche `read/write/delete/admin` (nur für den eigenen Speicher, Stufe 3) |

## 4. Bausteine

1. **Crate `omp-tams`** (rein, ohne GStreamer): Timestamp/TimeRange, Index-Umrechnung, Typen der Nutzlasten, HTTP-Client (`ureq` ist schon im Baum), Seitenabruf, Wiederholungen, Auth.
2. **`omp-tams-writer`** (Aufnahme): MXL-Eingang → H.264/AAC → GOP-genaue Segmente (`splitmuxsink` mit `mpegtsmux`) → Hochladen → Registrieren. **Nie die Live-Kette blockieren:** bei Speicherausfall Warteschlange auf der Platte, danach nachregistrieren.
3. **`omp-tams-reader`** (Wiedergabe): Zeitbereich oder „vor N Sekunden“ → Segmente laden → dekodieren → als MXL-Flow ausgeben, Takt aus TAI plus Versatz (Zeitverschiebung, Instant Replay).
4. ~~Eigener Speicher~~ (entfällt, D-T2; Beschreibung nur zur Erinnerung): Go-Dienst, Postgres für Metadaten (Zeiten als `NUMERIC` in Nanosekunden, AppNote 0008), Objects im Dateisystem hinter HTTP (die Spezifikation nennt das ausdrücklich als zulässig), Vorab-Signatur per HMAC mit Ablaufzeit. Kein Fremdspeicher nötig, passt zum Offline-Paket.

## 5. Entscheidungen (Nutzer, 2026-11-19)

- **D-T1 Container: beides.** MPEG-TS (`video/mp2t`, H.264 + AAC, kein Init-Segment) **und** CMAF/fragmentiertes MP4 (`video/mp4`, mit `init_object_id`, AppNote 0024), als Parameter `container` an Writer und Reader. AppNote 0002 gelesen (siehe §2). **Stand der Werkzeuge auf diesem Rechner:** `mpegtsmux`, `tsdemux`, `splitmuxsink`, `qtdemux`, `x264enc`, `avenc_aac` vorhanden; **`cmafmux`/`isofmp4mux` fehlen** (Rust-Plugin `gst-plugin-fmp4`). Folge: MPEG-TS wird zuerst gebaut (105.3), CMAF folgt als 105.3b, sobald das Plugin als Abhängigkeit freigegeben und im Installer/Offline-Paket enthalten ist (Minimal-Dependency-Regel, Rückfrage vor dem Aufnehmen). Der CMAF-Leser (`qtdemux` auf Init + Medien-Segment) braucht das Plugin nicht.
- **D-T2 Nur Client.** Kein eigener Speicher; 105.5 entfällt. Geprüft wird gegen den Testserver (105.2), den Mock-Server der Spezifikation und, sobald ein Partner Zugang gibt, eine fremde Installation.
- **D-T3 Zugangsdaten (Entscheidung Claude, auf Wunsch des Nutzers).** Das Token steht **nie** in Node-Parametern, Datenbank, Workflow-Export oder Logs. Quellen in dieser Reihenfolge: Datei, auf die `OMP_TAMS_TOKEN_FILE` zeigt (Rechte höchstens 0600, sonst Ablehnung), sonst `OMP_TAMS_TOKEN`. Als gewöhnliche Parameter bleiben nur Adresse, Art der Anmeldung (`bearer`, `basic`, `url_token`, `none`) und Benutzername; die UI zeigt „gesetzt/nicht gesetzt“, nie den Wert. Begründung: gleiche Linie wie ARCHITECTURE §27.6 (Verweis auf Datei/Umgebung statt Klartext in der Datenbank) und wie `OMP_NODE_API_TOKEN`. Bei der URL-Variante wird das Token nie protokolliert (URL im Log maskiert). TLS ist Pflicht außer bei `localhost` (Test).
- **D-T4 Version: ja.** Gegen API 8.2 bauen, Version in Contract und Handbuch nennen. Beim Start `GET /service` lesen: andere **Hauptversion** → Node meldet Fehler und nimmt nicht auf; höhere **Nebenversion** → läuft, Warnung im Status.

## 6. Risiken

- Die EOLPC kann eine andere Version oder zusätzliche Profile festlegen. Folge: Schicht `omp-tams` dünn halten.
- Latenz: Ein Segment ist erst nach dem Schließen sichtbar. Bei 2 s Segmenten liegt der Replay-Zugriff mindestens ~2–3 s hinter live. Für Instant Replay reicht das, für Wiedergabe in Echtzeit nicht.
- GOP-Länge bestimmt die Segmentlänge (AppNote 0005). Der Encoder muss alle N Bilder einen IDR liefern.
- Last: Hochladen und Dekodieren auf demselben Host wie die Sendekette. Die CPU-Regel aus dem Projekt gilt (kurze, kleine Tests).
