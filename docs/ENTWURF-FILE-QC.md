# Eingang / Review: File-QC, Review-Player, Conform, Metadaten (Kapitel 43)

Stand 2026-10-19. Umgesetzt als Orchestrator-Modul `internal/modules/review` (Name `review`, abschaltbar mit `OMP_MODULES_DISABLE=review`)
und UI-Modul `ui/modules/review` (Tab „Eingang“). Auftragstext: `File QC.txt` (Nutzerauftrag 2026-10-19). Die Originaldatei bleibt in
jedem Schritt **unverändert**.

## 1. Bestand (vor Kapitel 43)

| Baustein | Stand |
|---|---|
| Asset-Domäne | `internal/asset` (Asset, Version, Representation, Metadata-Kategorien, Lifecycle `ingesting … published`, Outbox) — Postgres, Audit |
| Medien-Probe | `ffprobe` im Katalog-Node `omp-media-library` (eigenständig, ohne DB, Segmente nur je Datei) und im Process-Executor `script` |
| Wiedergabe | GStreamer-Player-Nodes nach MXL (`omp-mxf-player*`), **kein** Browser-Player |
| MXF | Lesen/Schreiben von Audio-Labels (`omp-mxf-mca`); keine Strukturvalidierung |
| QC | keine |
| Module | Registry mit Migrationen, Routen, Starter, Metriken, UI-Tabs (Kapitel 36) |

`omp-media-library` bleibt unverändert; Review/Conform/Segmente leben in der Asset-Domäne (Entscheidung 2026-10-19). Eine Brücke
(Conform-Segmente → `setSegments`) ist optional und noch nicht gebaut.

## 2. Architektur

```
Asset (registered, Datei lokal)
   │  Scan alle 15 s (oder POST /register, /import)            ┌───────────── Review-Proxy (H.264 Intra, AAC-Stereo)
   ▼                                                           │   eigene Datei, Schlüssel (asset, source_rev, profile)
review_items ──► qc_jobs (queued → running → done | execution_failed)
   │                 │ ffprobe + 3–4 ffmpeg-Läufe (Integrität, Video, je Tonspur)
   │                 ▼
   │            qc_reports (unveränderlich, je Lauf neu) + qc_findings
   ▼
Arbeitsliste ─► Claim (atomar) ─► Review (Player) ─► Conform-Entwurf (Segmente, Metadaten) ─► Einreichen ─► Freigabe/Ablehnung
```

- **Ausführung:** Hintergrundarbeiter im Orchestrator (nur Raft-Leader), `SKIP LOCKED`-Auftragsvergabe, Lebenszeichen alle 15 s, verwaiste
  Aufträge werden zurückgestellt (max. 3 Versuche, dann `execution_failed`). Alle Prozesse laufen mit `nice -n 10`. Keine temporären
  Dateien außer Proxy-`*.part.mp4` (Aufräumen: > 1 h alt).
- **Keine neue Abhängigkeit:** ffmpeg/ffprobe (PATH oder `OMP_FFMPEG`/`OMP_FFPROBE`), Postgres, vorhandene Module-Registry.
- **Dateien:** nur lokal lesbare Ablagen (`filesystem`). Objektspeicher-Dateien müssen vorher bereitgestellt werden (Materialisierung,
  Kapitel 27 P8); sonst steht die QC als „nicht ausführbar“ mit Grund da. Das ist ein bewusster Schnitt.

## 3. Referenzprofil (aus `ET290730x3_details.html`, reale Anlieferdatei)

MXF 1.3 OP1a · MPEG-2 4:2:2 (Level 2) · 1920×1080 · 25 fps · interlaced TFF · bt709 · 50 Mbit/s · 8 separate Mono-Spuren PCM s24le 48 kHz
(`channel_layout unknown`, Namen A1–A8, MCA-Labels über `omp-mxf-mca dump`) · Start-Timecode 00:00:00:00 · 499 Frames.
`TestReferenceProfile1080i8Tracks` baut dieses Profil kurz nach und prüft Probe → QC (inkl. Anlieferprofil dazu) → Proxy.

**Unterstützte/geprüfte Medienprofile:** Alles, was ffmpeg 5.1 liest. *Getestet* sind: MXF OP1a MPEG-2 4:2:2 (progressiv und mit
Interlace-Flags, TFF), 25 fps, 1–8 Tonspuren PCM24. Andere Bildraten (24, 29.97 DF, 50) sind im **Zeitmodell** (Timecode, Frame ↔ Zeit) gegen
Testvektoren geprüft, aber nicht mit echten Dateien end-to-end — bis dahin nicht als „unterstützt“ zugesichert. Variable Bildrate wird erkannt
(Warnung `video.vfr`); Positionen sind dann nur näherungsweise.

## 4. QC: was sie ist und was nicht

Es sind drei verschiedene Dinge (die Oberfläche sagt das im Bericht):

1. **Metadaten-Probe** (ffprobe): Container, Streams, Dauer, Timecode, Codec, Auflösung, Bildrate, Halbbilder, Farbraum, Bittiefe, Kanäle.
2. **Inhaltsprüfungen** (ffmpeg-Filter): Dekodierfehler, Schwarzbild, Standbild, Halbbild-Kadenz (idet), Stille, Lautheit EBU R128 (I, LRA),
   True Peak, Clipping-Verdacht (astats), A/V-Versatz und Dauerabweichung, Zeitstempelsprünge.
3. **Standardspezifische Validierung** (z. B. MXF-Struktur nach SMPTE ST 377, MCA-Konformität): **nicht Teil dieser Analyse.** `container.mxf`
   meldet nur „von ffprobe gelesen“ samt OP-UL. Ein Spezialwerkzeug lässt sich über die `Runner`-/Check-Struktur später ergänzen
   (Kandidaten: quelloffene Konformitätsprüfer; Einbindung wäre eine eigene Entscheidung inkl. Lizenzprüfung).

Der gemessene Wert und der Grenzwert stehen je Befund nebeneinander. Prüfungen, die nicht auswertbar sind, erscheinen als
`not_evaluated` mit Grund — nie als „bestanden“. `incomplete` = mindestens eine Prüfung konnte wegen eines Analyseproblems nicht
ausgewertet werden (Filter fehlt, Pass endete mit Fehler); `not_evaluated` „by design“ (z. B. Untertitel nicht gefordert) zählt nicht dazu.

**Gesamtstatus:** `fail` > `incomplete` > `warning` > `pass`.
**QC nicht ausführbar ≠ QC hat Fehler gefunden:** Werkzeug fehlt, Zeitlimit, Abbruch, Datei nicht lokal lesbar → Auftrag `execution_failed`,
Zustand `qc_failed_to_run`, **kein** Bericht, kein Urteil. Eine beschädigte/abgeschnittene Datei dagegen ist ein Ergebnis (`fail`).

### Prüfungen (Auszug; vollständige Liste: `qc.go`)

`container.readable|format|mxf|timecode|truncation` · `media.decode_errors` · `video.format|frame_count|vfr|multiple|black|freeze|scan` ·
`audio.present|format|layout|silence|loudness|lra|true_peak|clipping` · `sync.start_offset|duration_mismatch|discontinuity` ·
`content.captions` · `delivery.resolution|framerate|codec|scan|container|audio_tracks|samplerate|bitdepth`.

### Bericht-Schema (`qc_reports` + `qc_findings`)

Bericht: `id, jobId, assetId, sourceRev, overall, counts, streams (ffprobe-JSON), tools {ffmpeg, ffprobe}, profile (Schnappschuss), ruleset, createdAt`.
Befund: `checkId, category, status (pass|warning|fail|not_evaluated), severity (info|minor|major|critical), message, measured{}, threshold{},
startFrame/endFrame ([in,out) in Frames), stream, tool, toolVersion, analyzedAt, ruleset ("<profil>@<version>")`.
Berichte sind unveränderlich; „QC wiederholen“ erzeugt einen neuen, der alte bleibt abrufbar. Export: JSON (vollständig inkl. Profil und
Werkzeugversionen = reproduzierbar) und CSV (Formel-Injection-geschützt).

### QC-Profil (konfigurierbar)

`review.config` (Tab „Eingang“ → Einstellungen, nur Administratoren): `qcProfiles{}` mit Schwellen für Schwarz/Standbild/Stille (Mindestdauer, Warn-/Fehlerdauer,
Rauschgrenze), Lautheit (Ziel, Toleranzen, True-Peak-Grenze, LRA), Clipping, Sync (ms), Erwartungen des Anlieferprofils (`expect`: Größe,
Bildrate, Halbbild, Codec, Container, Mindestzahl Spuren, Abtastrate, Bittiefe, Untertitel) und Grenzen (`maxAudioStreams`, `timeoutSec`).
Standard `broadcast-default@1`. Hinweis: ffmpegs Standard für Standbilder (−60 dB) erkennt in verlustbehaftet kodiertem Material nichts;
der Standard hier ist −50 dB.

## 5. Zeitmodell

- Positionen = **ganzzahlige Frame-Indizes** der Originaldatei (0 = erstes Bild). Bildrate = exakter Bruch (`30000/1001`).
- **Bereiche sind `[in, out)`: In inklusiv, Out exklusiv** — in API, Datenbank, UI und Doku. Ganze Datei = `[0, Dauer)`. Das letzte enthaltene Bild ist `out−1`.
  Die Out-Marke im Player setzt auf „aktuelles Bild + 1“ (das aktuelle Bild bleibt enthalten).
- Timecode = Start-Timecode der Datei + Frame; Drop-Frame bei 29.97/59.94 (`;`). Dateien mit Start-Timecode ≠ 0 sind getestet.
- Go (`timecode.go`) und TypeScript (`ui/modules/review/timecode.ts`) rechnen gegen **dieselben Testvektoren** (`testdata/timecode_vectors.json`)
  plus Voll-Rundlauf der Drop-Frame-Zählung.
- Validierung: `0 ≤ in < out ≤ Dauer`, Mindestlänge (`minSegmentFrames`), Überlappung/Lücken nach Richtlinie (`allowOverlap`, `allowGaps`).

## 6. Wiedergabe-Architektur

- Direktes Abspielen von MXF im Browser ist nicht möglich (MXF ist ein Container, MPEG-2 4:2:2 spielt kein Browser). Deshalb ein
  **Review-Proxy**: H.264, **nur Intra-Bilder** (`-g 1`, exakter Einzelbild-Zugriff in beide Richtungen), 540 Zeilen (`proxyHeight`), CRF 23,
  Halbbilder per `yadif=mode=0` (ein Vollbild je Bild), Bildrate = Quelle als Bruch, Ton = Stereo-Mischung der ersten 8 Tonspuren.
- **Zeitabbildung verifiziert:** Der Proxy gilt erst als bereit, wenn Bildanzahl, Bildrate und Start (0) mit der Zeitachse der Quelle übereinstimmen
  (`Zeitabbildung nicht verifiziert …` sonst). Proxy-Bild n ⇔ Quellbild n. Test mit Burn-in (8 Bit Frame-Nummer): `TestProxyMapsFramesOneToOneAndIsVerified`
  (progressiv und interlaced-geflaggt) liest Bild n zurück und findet n.
- Proxy-Datei ist eigene Datei (`<OMP_REVIEW_DIR>/proxies/<asset>/`), Beziehung über `(asset_id, source_rev, profile)`. Ändert sich die Quelle
  (Größe/mtime-Fingerprint), wird der alte Proxy nicht mehr ausgeliefert und neu erzeugt. Die UI zeigt dauerhaft „PROXY“ am Bild.
- Auslieferung per `http.ServeContent` (Range-Anfragen, 206) — nie komplett im Browser-Speicher. `<video>`/`<img>` können keinen Authorization-Header
  senden; deshalb akzeptiert **nur** `GET /api/v1/review/media/…` zusätzlich `?access_token=` (Allowlist `queryTokenAllowedPath`).
- **Grenzen (ehrlich):** keine Feldgenauigkeit (Halbbilder werden zu Vollbildern); ein ursprünglicher A/V-Versatz wird nicht in den Proxy übernommen;
  Rückwärts-Shuttle gibt es im Browser nicht → Rückfall über Einzelbild-Seeks (nicht jedes Bild wird gezeigt, Rate hängt von der Seek-Geschwindigkeit ab);
  Frame-Genauigkeit wurde in Chromium gemessen (§9), nicht in anderen Browsern.

## 7. Player-Bedienung

Play/Pause, Stopp (= anhalten und zum Startpunkt der Wiedergabe zurück), Bild ± (Pfeile, Umschalt ±10, Strg ±1 s), **Jog** (Ziehen, 7 px = 1 Bild; Mausrad)
und **Shuttle** (Regler −8× … +8×, springt beim Loslassen auf Stopp; Tasten J/K/L wie am Schnittplatz) als getrennte Bedienarten, Go-to-Timecode (Eingabe/G),
In/Out-Marken (I/O, Alt = hinspringen), Segmentgrenzen springen (`[` `]`), Segment aus Marken (N), Bereichsvorschau (stoppt auf dem letzten Bild des Bereichs),
QC-Befunde als Marker auf der Zeitleiste und per „▶ Timecode“ aus dem Bericht. Anzeige: Timecode, Bildnummer, Dauer, Bildrate. An den Grenzen bleibt die
Position stehen (Bild 0 / letztes Bild).

## 8. Datenmodell (Migration `review` v1)

`review_items` (Arbeitsliste: Zustand, Bearbeiter, `revision`, QC-Zusammenfassung, Zeitachse) · `qc_jobs` · `qc_reports` · `qc_findings` ·
`review_proxies` · `conform_revisions` (`draft|submitted|approved|rejected|withdrawn`, genau ein Entwurf je Asset) · `conform_segments`
(stabile ID, Reihenfolge, `[in,out)`, Beschreibung, Metadaten) · `review_history` (Audit) · `review_skipped`.

Metadaten-Trennung: **Quelldatei** (Probe, nur lesend, im QC-Bericht) · **technisch** (QC) · **redaktionell** (`asset.Metadata.Editorial`, erst bei Freigabe
aus dem Conform-Entwurf übernommen — keine zweite Wahrheit) · **Segment** (an `conform_segments`). Formularschema (Pflichtfelder, Wertelisten, Typen) in `review.config`
→ `metadataFields`; Entwürfe dürfen unvollständig sein, **ungültige Werte nie**, Pflichtfelder prüft „Einreichen“.

## 9. Ablauf, Zustände, Nebenläufigkeit

Zustände (Unterstatus neben dem Asset-Lebenszyklus, der Playout-Preflight liest weiter `asset.Status*`): `awaiting_qc → qc_running → awaiting_review` (oder
`qc_failed_to_run`) `→ in_review → conforming → ready_for_approval → approved | rejected` `→ archived`. Übergangstabelle: `store.go` (`Transitions`).
Asset-Status wird best-effort nachgeführt (`ready→in_review→approved`).

- **Claim:** Zeilensperre (`FOR UPDATE`), genau ein Gewinner (Test: 12 parallele Claims → 1 Treffer), eigener erneuter Claim idempotent.
  Richtlinie: Review trotz laufender QC (`allowReviewWhileQcRunning`, Standard aus) / nach nicht ausführbarer QC (`allowReviewAfterQcExecFail`, Standard an).
  Freigeben (nur eigener), Neu zuweisen/Zwangsfreigabe (Recht `configure`).
- **Optimistische Sperre:** Jede Änderung trägt `expectedRevision`; veraltet → 409 mit aktuellem Stand; die UI bietet „Stand laden“ oder „trotzdem speichern“.
  Bereiche gelten für eine Quellversion (`source_rev`); hat sich die Quelle geändert, verlangt der Server `ackSourceChange`.
- **Freigabe:** `approvalMode` `none|single|dual` (Standard `single`), Selbstfreigabe konfigurierbar; Ablehnen verlangt Begründung; danach neue Revision aus der
  letzten (`revise`). Rechte: lesen = angemeldet, bearbeiten/Claim/Speichern/Einreichen = `operate`, Freigeben/Ablehnen/Neuzuweisen/Import = `configure`,
  Konfiguration = `admin` — **serverseitig** je Route (Test `TestRoutePermissionsAreDeclaredStrictly`).
- **Audit:** jede Aktion in `review_history` (Wer/Was/Wann/Zustand von→nach/Details) und im Domänen-Audit.

## 10. API (Auszug; Basis `/api/v1/review`)

`GET /items?state=&assignee=me|free&q=` · `GET /items/{id}` (+ `/history`, `/qc/reports`, `/qc/jobs`, `/conform`, `/conforms`, `/proxy`, `/timecode?tc=|frame=`) ·
`POST /items/{id}/claim|release|force-release|reassign|qc|submit|withdraw|revise|approve|reject|archive|unarchive|proxy` · `PUT /items/{id}/conform` ·
`GET /qc/reports/{rid}` und `/export?format=json|csv` · `GET /media/{id}/proxy` (Range) und `/media/{id}/frame/{n}.jpg` · `POST /import`, `GET /import/files` (Import aus `importDir`)
· `POST /register` · `GET|PUT /config`. Kennzahlen in `GET /metrics`: `omp_review_items{state}`, `omp_review_qc_jobs{state}`, `omp_review_proxies{state}`,
`omp_review_qc_runs_total`, `omp_review_qc_seconds_total`, `omp_review_qc_oldest_queued_seconds`.

## 11. Tests (Ist-Stand 2026-10-19)

Go (`internal/modules/review`, braucht ffmpeg + `OMP_POSTGRES_URL`; ohne beides werden die betroffenen Tests übersprungen): Timecode-Vektoren und Drop-Frame-Rundlauf, Parser,
QC gegen Fixtures mit bekannten Mängeln (Schwarz 2,0–3,5 s → Frame 50, Stille Spur 2 → Frame 25, Standbild bis Dateiende, Lautheit/True Peak, Anlieferprofil, abgeschnittene und
kaputte Datei, Werkzeug fehlt), Trennung Ausführungsfehler/Befund, Lebenszyklus, Claim-Parallelität, Revisionskonflikt, Validierung, Freigabemodi,
Quelländerung, verwaister Auftrag, Importschutz, Proxy-Abbildung mit Burn-in, Referenzprofil 1080i/8 Spuren, HTTP (Range 206, Konflikte, Rechte, Export).
TypeScript: Timecode-Vektoren, Segment-/Shuttle-/Tastatur-/Filterlogik, Texte DE/EN.
**Browser (Chromium headless, echter Orchestrator + Postgres + NATS):** Import → QC → Liste → Bericht (Filter, Aufklappen) → Übernehmen → Proxy → Player:
5× Pfeil = Bild 5, zurück, ±10, Go-to-Timecode, 13 Stichprobenbilder (GOP-Grenzen) — das **tatsächlich dargestellte Bild** wird aus dem `<video>` ausgelesen (Burn-in) und
stimmt jeweils mit dem Ziel überein; Jog, Marken, Segment, Bereichsvorschau (endet auf dem letzten Bild), Shuttle vorwärts/rückwärts, Grenzen, Speichern, Einreichen, Freigeben.
Das Skript liegt nicht im Repo (Einmalmessung); Reproduktion: Burn-in-Fixture wie in `proxy_test.go`, Auslesen per Canvas.

## 12. Offene Punkte / Folgearbeit (priorisiert)

1. MXF-Strukturvalidierung nach ST 377 / MCA-Konformität (Spezialwerkzeug, Lizenzprüfung).
2. Objektspeicher-Dateien automatisch bereitstellen (Materialisierung) statt „nicht lokal lesbar“.
3. Physisches Trimmen/Re-Encoden als eigener Prozess mit Ausgabe-Asset (Conform ist bisher nur Bereiche + Metadaten).
4. Brücke zu `omp-media-library`/Playout (Conform-Segmente als Mark-In/Out), Anzeige im Asset-Tab.
5. Feldgenaue Wiedergabe, Proxy mit Original-A/V-Versatz, Tonspurauswahl im Player, weitere Browser messen.
6. Echtzeit-Aktualisierung per SSE statt 5-s-Abfrage; Editor für QC-Profile statt JSON.
7. QC-Lauf über mehrere Hosts verteilen (heute: Orchestrator-Host).


## Ton im Review-Player (2026-10-29)

Der Browser-Player braucht den Ton mit Spurwahl und mit Ton beim Jog/Shuttle, damit Ein- und Ausstiege von Ton gefunden werden können.

- **Ton-Proxy** (`proxy.go`, Profil `…-v2`): neben dem stummen Video-Proxy entsteht eine zweite Datei mit **einem Stereo-AAC-Stream je Quell-Tonspur** (höchstens `proxyMaxAudioTracks`), auf die Bildlänge aufgefüllt (`apad`, `-t`) und bei 0 beginnend — Ton ab Sekunde *s* gehört zu Bild *s·Rate*. Ältere Proxys (`v1`) gelten als nicht vorhanden und werden beim Öffnen neu erzeugt.
- **Blockauslieferung** (`audio.go`): `GET /api/v1/review/media/{id}/audio/{track}/{block}.wav` liefert 10 Sekunden als 16-Bit-WAV (48 kHz, Stereo, exakter Kopf). Test `TestAudioProxyTracksAndBlocksAreTimeAccurate` prüft Toneinsatz (±1 Bild), Stereo-Pegel, Randblock und Fehlerfälle.
- **Browser** (`ui/modules/review/audio.ts`): Web Audio, Video bleibt stumm. Spurwahl `A1…An` (Taste 1–9, Umschalt = Solo), Lautstärke. **Wiedergabe** vorwärts/rückwärts bei −4× … +4× (Tonhöhe folgt dem Tempo, darüber stumm); **Einzelbild/Jog/Zeitleiste**: je Bildschritt ein kurzes Stück (90 ms ab Bildbeginn) mit kurzer Blende. Die Tonuhr wird alle 0,5 s mit dem Video abgeglichen (> 60 ms Abweichung → neu ansetzen). Rückwärts über umgekehrte Pufferkopien.
- **Prüfung:** Planung gegen Mock-AudioContext (`audio_test.ts`: lückenlose Stücke über Blockgrenzen, Rückwärts-Offsets, Scrub-Stück, Spurwahl/Solo). **Nicht** im echten Browser gehört/geprüft — das steht aus (Neustart des Orchestrators, UI-Bundle bauen).
- **Grenzen:** erster Ton nach dem Springen erscheint, sobald der Block geladen ist (ca. 50–150 ms, danach aus dem Zwischenspeicher); ein ursprünglicher Versatz zwischen Bild und Ton der Quelle wird nicht abgebildet (wie bisher).
