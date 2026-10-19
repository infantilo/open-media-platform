# Plan: Geplanter Live-Ingest (Kap. 42) und File-QC / Review / Conform (Kap. 43)

Stand 2026-10-19 (Kapitel 43 umgesetzt, siehe `docs/ENTWURF-FILE-QC.md`; Kapitel 42 offen). Quellen: `Live Ingest.txt`, `File QC.txt` (Aufgabentexte, Verzeichnis oberhalb des Repos).
Dieser Plan ist **Bestandsaufnahme + Entscheidungen + Schrittfolge**. Es wurde noch kein Code geändert.
Alle Aussagen unter „Bestand" sind gegen die Dateien geprüft (Stichproben, keine Vollanalyse); was nicht
geprüft ist, steht unter „Vor Beginn zu klären".

Beide Aufträge hängen zusammen: Ingest erzeugt die Datei, QC/Review übernimmt sie. Gemeinsame Nahtstelle ist
das **Asset** (`orchestrator/internal/asset`). **Reihenfolge (Nutzerentscheid 2026-10-19): erst Kap. 43, dann Kap. 42** — 43 braucht
vom Ingest nur „Asset ist registriert". Entscheidungen und Fakten: §5.

---

## 1. Bestand (was es schon gibt, was fehlt)

| Baustein | Vorhanden | Datei(en) | Lücke |
|---|---|---|---|
| Aufnahme-Node | MXL-Video+Audio → Datei, `record.start/stop`, MXF mit MCA-Labels | `nodes/omp-recorder/src/{main,pipeline}.rs` | Keine Zeitplanung, keine Asset-Registrierung nach Stopp, 1 Aufnahme je Instanz, keine Metrik |
| Zeitplan | Cron-artiger Scheduler startet/stoppt **Workflows** (`ScheduleAction`), Tick+`fireWindow`, Zeitzone in `Schedule` | `orchestrator/internal/workflows/scheduler.go`, `store.go` | Kein Dauer/Ende-Konzept für Aufnahmen, keine Wiederholung nach DST-Regeln explizit geprüft, kein Job-Lebenszyklus (nur Workflow-Runs) |
| Workflow-Runs | Persistierte Läufe, `ReconcileRuns` nach Neustart | `workflows/runs.go`, Migration `0031_workflow_runs.sql` | Läufe sind Start/Stop-Protokoll, keine Zustandsmaschine mit Retry |
| Ressourcenmodell | Host-Kapazität, gemessene Profile je Node-Typ (p95 CPU, max RSS), I/O-Ports, Belegung jetzt+Forecast 15 min | `httpapi/scheduler_resources_handlers.go`, `workflows/forecast.go`, `placement/placement.go` (982 Z.), `profiles` | Forecast nur 15 min, nur Host-Affinität; **keine Zeitfenster-Reservierung**, keine Disk/Netz/MXL-Shm-Budgets, nicht atomar |
| Scheduler-UI | Zeitachse, Maschinen-Lanes, Platzierungs-Prognose (Memory: 6335ec6) | `ui/` (Scheduler-View) | Zeigt Workflows, keine Aufnahmejobs, keine Engpassursache je Ressourcenart |
| Asset-Domäne | Asset/Version/Representation/Metadata, Lifecycle-Zustandsgraph, Outbox | `orchestrator/internal/asset/{types,store}.go`, Migration `0019_assets.sql` | Lifecycle ist Publish-orientiert (`ingesting … published`), kein QC-/Review-Zustand, kein Claim |
| Materialisierung | Asset-Preflight, `AVAILABLE/REMOTE_ONLY/TRANSFERRING` | `internal/materialize`, Kap. 27 P8 | — (wiederverwendbar) |
| Prozess-Engine | Executors inkl. ffmpeg/ffprobe (Task-Registry, Kap. 23/25) | `internal/process/executors.go`, `internal/ffmpegtools` | Kein QC-Executor mit strukturiertem Report |
| Media-Katalog | `ffprobe`-Analyse, Mark-In/Out-Segmente je Datei (`setSegments`) | `nodes/omp-media-library/src/main.rs` (631 Z.) | Segmente sind dateibasiert, nicht versioniert/auditiert, kein Frame-Modell; Katalog ≠ Asset-Domäne (Doppelung vermeiden!) |
| MXF-Wiedergabe | GStreamer-Player → MXL, Direkt-Variante mit Seeking, MXF-MCA-Tool | `nodes/omp-mxf-player{,-direct}`, `omp-mxf-mca` | Kein Browser-Review-Player, keine Proxies, kein Timecode-Modell |
| Audit / Authz | Audit-Paket, `domainaudit`, `authz`, `auth` | `internal/{audit,domainaudit,authz}` | — (wiederverwenden) |
| Migrationen | zuletzt `0041_host_maintenance.sql` | `orchestrator/internal/db/migrations` | nächste frei: 0042 |

**Wichtig für die Aufgabentexte:** Beide Texte verweisen auf `github.com/infantilo/open-media-platform` und verlangen
„Repository erst inspizieren". Das ist mit dieser Tabelle geleistet; sie wird in Schritt 42.0/43.0 als
`docs/ENTWURF-INGEST.md` / `docs/ENTWURF-FILE-QC.md` mit Datei-/Zeilenverweisen finalisiert (Deliverable 1 der Texte).

---

## 2. Kapitel 42 — Geplanter Live-Ingest mit ressourcenbewusster Orchestrierung

### 2.1 Architekturentscheidung (Pool vs. dynamisch vs. hybrid)

Empfehlung: **C, hybrid — aber ohne eigenen Pool-Manager.** Begründung aus dem Bestand:

- `omp-recorder` ist ein leichter Control-Node (GStreamer-Pipeline, ein Encoder). Start per Launcher ist im
  Bestand ein bekannter Pfad (Workflow-Start, Host-Platzierung, Make-before-break in Kap. 41). Reines
  „dynamisch je Job" (B) ist daher machbar; Start-Latenz ist aber unbekannt → **messen** (Schritt 42.1), nicht annehmen.
- Reines Pool-Modell (A) widerspricht der Plattform-Linie (Workflows starten/stoppen Instanzen, Cloud-Autoscaling Kap. 35).
- Hybrid = **Vorwärmen vor Startzeit**: Der Job-Runner startet Recorder/Converter `leadTime` (Standard 60 s,
  pro Profil konfigurierbar, aus gemessener Startdauer abgeleitet) vor dem Fenster, hält sie nur während des Fensters
  und stoppt sie nach Finalisierung (+ `idleGrace`). Optionales „warmes Minimum" (`warmRecorders`, Standard 0) pro Host,
  nur für Profile mit harter Startzeit-Zusicherung.
- Langlebig: Orchestrator-Scheduler/Reservierungen, ggf. Converter-Worker (reine ffmpeg-Prozesse, ohnehin on demand).
  On demand: `omp-recorder`-Instanz, MXL-Flows der Quelle (existieren bereits beim Sender; Recorder ist nur Leser —
  siehe Memory „MXL-Ausgang nur bei Leser").
- MXL ist **kein** Scheduler. Verantwortung: Control-Plane = Plan/Admission/Reservierung; Orchestrator/Launcher =
  Instanzen, Host-Wahl; MXL = Medienaustausch (Shm-Flows). MXL-Shm-Budget wird als Ressource **gezählt**, nicht verwaltet.

Vergleichstabelle (A/B/C × die 13 Kriterien des Textes) wird in `docs/ENTWURF-INGEST.md` ausgeführt, mit gemessenen
Startlatenzen als Beleg (Schritt 42.1).

### 2.2 Datenmodell (Migration 0042, 0043)

- `ingest_jobs`: `id`, `idempotency_key` (UNIQUE: `schedule_id + occurrence_start_utc`), `source_ref`, `start_utc`,
  `end_utc` (oder `duration`), `tz` (IANA), `recurrence` (RRULE-Teilmenge, **lokal in `tz` expandiert** → DST korrekt),
  `profile_id`, `workflow_ref`, `storage_target`, `metadata` (jsonb), `priority`, `retry_policy`, `late_policy`
  (`fail|delay|wait`, Standard `delay` mit `maxDelay`), `state`, `state_since`, `revision`, `created_by`.
- Zustände (Anlehnung an `statemachine`-Paket): `scheduled → waiting_for_resources → starting → recording →
  finalizing → processing → completed`; Seitenzustände `failed`, `cancelled`, `needs_attention`. Übergangstabelle explizit
  wie `asset.LifecycleTransitions`, jeder Übergang in `ingest_job_events` (Audit + Diagnose).
- `ingest_profiles`: Container/Codec, Zielbitrate, Konverter-Kette, **Ressourcenbedarf** mit Herkunftsmarke je Wert
  (`measured | configured | default`), Quelle: `profiles`-Paket (gemessen) → Konfiguration → konservativer Default.
- `resource_reservations`: `job_id`, `host_id`, `resource` (`cpu|mem|gpu|disk_bps|disk_bytes|net_bps|mxl_shm|recorder_slots|converter_slots|source_conn`),
  `amount`, `t_start`, `t_end`, `state` (`held|active|released`).
- `host_budgets` (Konfig + Admin-UI Kap. 29): harte Obergrenze und weiche Warnschwelle je Host/Ressource.

### 2.3 Admission-Control & Reservierung

- Reiner Planer `internal/ingestplan` (ohne I/O, voll testbar): Sweep-Line über `[t_start, t_end)` je Host und Ressource,
  liefert **typisierte Ergebnisse**: `source_conflict`, `hard_shortage`, `temporarily_occupied` (mit frühestem möglichem Start),
  `missing_function`, `storage_or_io_insufficient`, `soft_warning`, `uncertain_estimate`. Genau die 7 Klassen des Textes.
- Atomarität: Reservierung in **einer DB-Transaktion** mit `pg_advisory_xact_lock(host)` (bzw. SERIALIZABLE + Retry);
  Test mit parallelen Goroutinen, die zusammen die Kapazität überschreiten würden (muss genau so viele annehmen, wie passen).
- Priorität/Preemption: Kapazität wird für Priorität ≥ `reservedPriority` anteilig freigehalten (`reservePct` je Ressource).
  **Nie** automatisches Abbrechen laufender Aufnahmen, außer Policy `allowPreempt=true` am niedriger priorisierten Job (Standard false).
- Rollback: Jeder Starthandler arbeitet mit Kompensationsliste (reservieren → Instanz starten → Verbinden → ready → record);
  Fehler an Stufe n macht n-1…1 rückgängig; `ReconcileIngest()` beim Start gleicht `ingest_jobs`/`reservations` gegen
  `launcher.List()` ab (Vorbild `ReconcileRuns`): verwaiste Instanzen stoppen, Reservierungen ohne Instanz freigeben,
  laufende Aufnahmen **adoptieren** statt neu starten (Idempotenz).

### 2.4 Laufzeit

- `internal/ingest` (Runner): Tick wie `workflows.Scheduler`, aber über `ingest_jobs`; Auslösung nur über
  `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` + `SELECT … FOR UPDATE SKIP LOCKED` (mehrere Orchestratoren im Cluster Kap. 8 → nur Raft-Leader aktiv, sonst Lock-basiert).
- Aufnahme-Ende: Recorder bekommt `record.stop` zur Endzeit; **Asset wird erst nach erfolgreicher Finalisierung** registriert
  (`asset.Store`: Asset + Representation, Status → hier `registered`, danach löst die Outbox QC aus, Kap. 43).
- Konverter-Fehler verliert die Rohaufnahme nie: Roh-Representation wird vor dem Konverter registriert; Konverter läuft als
  `process`-Schritt (vorhandene Engine, ffmpeg-Task-Registry) → Fehler = Job `processing_failed`, Original bleibt.
- Doppelte Formatwandlung vermeiden: Profil definiert `outputs[]`; Planer überspringt Konverter, wenn Recorder-Ausgang
  bereits das Zielformat ist.

### 2.5 UI (Erweiterung des vorhandenen Scheduler-Views, kein neuer)

- Neue Lane-Gruppe „Aufnahmen" im Scheduler-View (Zeitachse existiert): Jobs als Balken, Zustandsfarbe, Konfliktmarkierung.
- Neues Panel „Kapazität": **je Ressourcenart eine eigene Zeile** (CPU, Speicher, GPU, Disk-Durchsatz, Disk-Platz, Netz,
  Recorder-Slots, Konverter-Slots, MXL-Shm) über den Planungshorizont — ausdrücklich **keine** Gesamtprozentzahl.
- Engpass-Karte: betroffene Jobs, limitierende Ressource, Zeitintervall, Empfehlung (frühester Start, alternativer Host, Priorität ändern).
  „Vorhergesagt" (gestrichelt) vs. „tatsächlich fehlgeschlagen" (voll) strikt getrennt.
- Job-Formular (Dialog-Kit `omp-confirm/omp-prompt`, **kein** JS-`confirm/alert/prompt`), alle Texte über `t()` in `de.ts`+`en.ts`.
  Zeit-Popup OK/Abbrechen wie in Memory 2026-10-16.
- Live-Aktualisierung über SSE (`internal/sse`).

### 2.6 Beobachtbarkeit

Metriken im vorhandenen Metrik-/Health-Pfad (`internal/health`, Prometheus-Export prüfen — **Vor Beginn zu klären**):
Queue-Tiefe, Planungslatenz, Startabweichung (`actual_start − planned_start`), Reservierungsfehler je Klasse, aktive Recorder/Konverter,
Pool-Auslastung, Startlatenz, verwaiste/unreconcilierte Instanzen. Keine Zugangsdaten in Logs (Quell-URLs maskieren).

### 2.7 Schritte Kap. 42 (je ≈ 1 Sitzung, UMSETZUNG.md §0 gilt)

| Schritt | Inhalt | Verifikation |
|---|---|---|
| 42.0 | Bestandsdoku `docs/ENTWURF-INGEST.md` (Datei-Referenzen, Lücken); offene Fragen §5 klären | Review durch Nutzer |
| 42.1 | **Messung** Startlatenz `omp-recorder` (Launcher → ready → erste Datei) lokal + .60/.61; Entscheidung A/B/C mit Zahlen festschreiben | Messprotokoll im Entwurf |
| 42.2 | Migration 0042/0043, Paket `ingest` (Store, Zustandsmaschine, Idempotenzschlüssel, Events), reine Tests | `go test ./internal/ingest/...` inkl. Restart-/Doppelstart-Test (dbtest-Isolierung!) |
| 42.3 | Zeit/Wiederholung: IANA-Zone, RRULE-Teilmenge, DST-Lücke/-Überlappung deterministisch | Tabellentests Frühling/Herbst Europe/Berlin |
| 42.4 | `ingestplan` (Sweep-Line, 7 Ergebnisklassen) + Budgets/Profile + Herkunftsmarken | Property-Tests: nie Überbuchung |
| 42.5 | Atomare Reservierung (Advisory-Lock), Parallel-Test, Prioritäts-Reserve, Preemption-Policy | Test 50 parallele Zusagen |
| 42.6 | Runner: Vorwärmen, Start-Kette mit Kompensation, Bereitschaft, Aufnahme, Finalisierung, Asset-Registrierung | Integrationstest mit Mock-Recorder (`nodes/mock`) |
| 42.7 | Konverter-Schritt via Process-Engine, Rohdatei-Schutz bei Fehler | Test: Konverter-Fehler → Roh-Asset bleibt |
| 42.8 | `ReconcileIngest` (Adoption/Aufräumen), Late-Policy, Retry | Test: Orchestrator-Kill mitten in Aufnahme |
| 42.9 | REST-API (`httpapi`, `authz`-Rollen), Audit | API-Tests inkl. Rechte |
| 42.10 | Scheduler-View: Aufnahme-Lanes, Job-Dialog | CDP-Klicktest (Memory: UI click-test) |
| 42.11 | Kapazitäts-Panel + Engpasskarte | CDP-Test mit absichtlich überbuchtem Fenster |
| 42.12 | Metriken, Konfiguration (Admin-UI Kap. 29), Katalog-Beschreibung, BENUTZERHANDBUCH, HANDBUCH §9, `deploy/` | Doku-Check, `make` Gesamttest |

---

## 3. Kapitel 43 — File-QC, Operator-Review, framegenaues Conform, Metadaten

### 3.1 Architekturentscheidung

- **QC-Engine:** `ffprobe` (Struktur/Streams) + `ffmpeg`-Filter (`blackdetect`, `freezedetect`, `silencedetect`, `ebur128`
  mit true-peak, `astats`, `-xerror`/Decode-Fehler) hinter einer **Tool-Schnittstelle**, damit später ein
  Spezial-QC angebunden werden kann. Dokumentiert und in der UI sichtbar: *Das ist Probing + Inhaltsprüfung, kein Ersatz für ein
  standardkonformes Broadcast-QC (MXF-Strukturvalidierung nach ST 377 nur soweit `ffprobe`/`omp-mxf-mca dump` liefern).*
  Nicht ausgewertete Prüfungen erscheinen als `not_evaluated`, nie als `pass`.
- **Ausführung:** als Prozess-Engine-Schritt (`internal/process`) bzw. Worker auf Hosts mit Zugriff auf die Datei (Materialisierung
  Kap. 27 P8 nutzen); asynchron, mit Fortschritt, Retry, Abbruch, temp-Dateien in eigenem Verzeichnis mit Aufräumjob (`housekeeping`).
- **Wiedergabe:** Original bleibt unveränderlich. **Review-Proxy** (H.264 All-Intra/kurze GOP, fMP4 oder MP4 mit Range-Requests)
  per ffmpeg erzeugt, als eigene `Representation` (Typ `review_proxy`) mit `source_version_id`, Profil-Hash und
  **verifizierter Timeline-Abbildung** (Frame 0 des Proxys ↔ Quell-Timecode, Frame-Anzahl gleich → sonst Proxy ungültig).
  Rückwärts/Shuttle: bei All-Intra-Proxy `currentTime`-basiertes Stepping; Fallback Frame-Sprite/Einzelbild-Endpunkt
  (`/frames/{n}`) für Jog. Frame-Genauigkeit wird **im Browser gemessen** (Test mit Burn-in-Frame-Nummer im Fixture) bevor sie behauptet wird.
  Alternative `omp-mxf-player-direct` als Kontroll-Ausgang bleibt unberührt.
- **Zeitmodell:** ganzzahlige Frames für CFR (`frame_index`), rationale Zeitstempel (`num/den`) für VFR; Fps als exakter Bruch
  (30000/1001); Drop-Frame-Timecode nur für 29.97/59.94. Konvention: **In inklusiv, Out exklusiv** (`[in, out)`), überall (API, DB, UI, Doku).
  Start-Timecode der Datei als `tc_offset_frames`; Rechnung in einer Bibliothek `timecode` (Go **und** TS-Spiegel mit gemeinsamen Testvektoren).
- **Segmente/Conform:** nicht-destruktiv, Revisionen; physisches Trimmen später als eigener Prozess mit eigenem Ausgabe-Asset (nicht Teil dieses Kapitels).
- **Keine Doppelung mit `omp-media-library`:** `setSegments` bleibt für das Playout-Katalog-Verhalten; Quelle der Wahrheit für Conform wird
  die Asset-Domäne. Migration/Entscheid in §5 Punkt 3: `omp-media-library` bleibt unverändert, Brücke optional nach Kap. 43.

### 3.2 Datenmodell (Migration 0044ff.)

`asset_review` (Zustand, Bearbeiter, `revision`), `qc_jobs` (Zustand: queued/running/**execution_failed**/done; Ruleset-Version, Tool-Versionen),
`qc_reports` (unveränderlich, je Lauf neu, `source_version_id`, Gesamtstatus `pass|warning|fail|incomplete`), `qc_findings`
(check_id, Kategorie, Status, Severity, Messwert, Schwelle, tc_start/tc_end, Tool, Zeitstempel, Ruleset),
`qc_profiles` (versionierte Schwellen, Liefer-Profile), `conform_revisions` (+ `conform_segments` mit uuid, Label, Reihenfolge, in/out, Metadaten),
`review_history` (Audit; zusätzlich `domainaudit`). Metadaten-Trennung: Quelldatei (aus Probe, read-only) / technisch (QC) /
redaktionell (`asset.Metadata.editorial`) / Segment (an `conform_segments`). Redaktionelle Felder über konfigurierbares Schema
(Pflichtfelder, Wertelisten) — vorhandene Metadatenkategorien in `asset/types.go` nutzen, kein zweites Modell.

Claim: `UPDATE asset_review SET assignee=$u, revision=revision+1 WHERE asset_id=$a AND (assignee IS NULL OR claim_expired)`; Zeilen-Anzahl 0 → 409.
Speichern von Conform/Metadaten: optimistisches Locking über `expected_revision` + `source_version_id`; Konflikt → 409 mit aktuellem Stand.

Lifecycle: bestehende `asset.LifecycleTransitions` erweitern statt parallel (QC-/Review-Zustände als **Substatus** von `asset_review`, Hauptstatus
bleibt kompatibel zu Publish/Preflight — Kompatibilitätstest gegen Kap. 27 P8). Zustände des Textes werden zugeordnet in 43.0.

### 3.3 UI

Neuer Shell-View „Eingang / Review" (vanilla TS, Deno-Check, Kit-Elemente): (1) Arbeitsliste mit Filter/Claim, (2) QC-Bericht
(Zusammenfassung, Kategorie-/Severity-Filter, aufklappbare Befunde, Messwert vs. Schwelle, Klick → Timecode springen, Stream-Details,
Export JSON/CSV; Wiederholung erhält Verlauf), (3) Review-Player (Play/Pause/Stop, Frame ±, Jog (Zeiger/Tasten), Shuttle (J/K/L-Stufen),
Go-to-TC, I/O-Marken, Segmentleiste mit Grenzen, Befund-Marker auf der Zeitachse, klares „PROXY"-Abzeichen), (4) Segmentliste + Metadatenformular,
(5) Speichern/Einreichen, ungesicherte Änderungen → `omp-confirm`-Dialog (nie `beforeunload`-Alert allein). Texte über `t()`.

### 3.4 Schritte Kap. 43

| Schritt | Inhalt | Verifikation |
|---|---|---|
| 43.0 | Bestandsdoku + Zustandszuordnung + Fixture-Beschaffung (frei verteilbare MXF/MP4: aus `ffmpeg`/`gst` erzeugte Testbilder mit Burn-in, DF- und 25-fps-Varianten) | Review |
| 43.1 | Bibliothek `timecode`/Frames (Go+TS, gemeinsame Vektoren: 24, 25, 29.97 DF/NDF, 30000/1001, 50, 59.94, Start-TC ≠ 0) | Tests beider Seiten identisch |
| 43.2 | Migrationen + Stores: `qc_*`, `asset_review`, Claim, Revisionen, Audit | Claim-Parallel-Test, Revisions-Konflikttest |
| 43.3 | QC-Runner (ffprobe+ffmpeg-Filter), Ruleset-Profil, Report-Schema, `execution_failed` ≠ `fail`; asynchron, Cleanup | Test mit defekter Datei (abgeschnitten), mit Black/Freeze/Silence-Fixture, mit nicht ausführbarem Tool |
| 43.4 | Auto-Trigger nach Asset-Registrierung (Outbox), Richtlinie „Review trotz laufender/fehlgeschlagener QC" | Integrationstest Ingest→QC |
| 43.5 | Proxy-Erzeugung + Timeline-Verifikation, Range-Streaming-Endpunkt, Frame-Endpunkt | Frame-Anzahl/TC-Abgleich; Range-Request-Test |
| 43.6 | Conform-API (Segmente, Validierung Überlappung/Lücken per Workflow-Policy, `[in,out)`), Revisionen | Randfalltests (out=Dauer, in=out, VFR) |
| 43.7 | Metadatenschema + Validierung + Segmentmetadaten + Verlauf | Pflichtfeld-/Wertelistentests |
| 43.8 | Shell-View Arbeitsliste + QC-Bericht | CDP-Klicktest, Export |
| 43.9 | Review-Player (Transport, Jog/Shuttle, Marken) — **Browser-Messung der Frame-Genauigkeit** | Test gegen Burn-in-Fixture: ±0 Frames bei Step; Ergebnis dokumentiert, Grenzen ehrlich benannt |
| 43.10 | Segment-/Metadaten-UI, Speichern/Einreichen/Freigabe/Ablehnung, Konfliktdialog | CDP-Test mit zwei Sitzungen (Claim + Revisionskonflikt) |
| 43.11 | Rechte (`authz`: `review`, `approve`, `qc.configure`), Serverdurchsetzung, Audit-Tests | Negativtests je Endpunkt |
| 43.12 | Doku (BENUTZERHANDBUCH, HANDBUCH §9, Katalog), unterstützte MXF-Profile und Grenzen, Abschlussbericht | Doku-Check, `make` Gesamttest |

---

## 4. Risiken

1. **Frame-Genauigkeit im Browser** (`<video>` hat keine garantierte Frame-Adressierung): Gegenmaßnahme All-Intra-Proxy + Messung; falls nicht
   erreichbar, Fallback Einzelbild-Endpunkt für Jog/Step und Dokumentation statt falscher Zusage.
2. **Planungsmodell über 15-min-Forecast hinaus** berührt `placement.go` (982 Z.): neues Paket `ingestplan` kapselt das, `placement` wird nur gelesen — keine Regression für Workflows.
3. **Asset-Lifecycle-Erweiterung** kann Playout-Preflight (Kap. 27 P8) brechen → Substatus statt neuer Hauptzustände, Kompatibilitätstests.
4. **CPU-Last bei Tests** (Memory: „du grillst mein cpu"): QC-/Proxy-Tests mit kurzen Fixtures (≤10 s), `nice`, wenige Instanzen.
5. **Test-Datenbank:** nur `internal/dbtest` (Memory: `go test` wiped Dev-Postgres).
6. **Aufgabentexte verlangen „alles implementieren und verifizieren in einem Zug"** — hier bewusst in 13 + 13 Sitzungsschritte zerlegt (UMSETZUNG.md §0: ein Schritt pro Sitzung). Kein Schritt gilt ohne Verifikation als fertig.
7. Stack-Regeln: kein Message-Broker, keine neue DB, keine neue Mediengrundlage (ffmpeg/GStreamer/Postgres bleiben); UI ohne Framework.

## 5. Entscheidungen (Nutzer, 2026-10-19) und geprüfte Fakten

1. **Reihenfolge: zuerst Kap. 43 (File-QC/Review/Conform), danach Kap. 42 (Ingest).** Kap. 43 braucht von 42 nichts außer „Asset ist registriert"; die Nahtstelle (Asset-Outbox → QC-Auslösung) wird in 43.4 so gebaut, dass der spätere Ingest sie nur noch bedient.
2. **ffmpeg/ffprobe geprüft (lokal):** ffmpeg/ffprobe 5.1.9 (Debian 12) vorhanden; die Filter `blackdetect`, `blackframe`, `freezedetect`, `silencedetect`, `ebur128` (inkl. true-peak), `astats`, `volumedetect`, `idet`, `signalstats`, `cropdetect` sind verfügbar. Der Orchestrator prüft beim Start bereits `ffmpeg`/`ffprobe` (`orchestrator/main.go:892`). **Metrik-Endpunkt existiert:** `GET /metrics`, handgeschrieben im Prometheus-Textformat (`httpapi/metrics.go`, keine Abhängigkeit) — Ingest-/QC-Metriken kommen dort hinein. Folge: QC-Prüfungen beschränken sich auf das, was diese ffmpeg-Version liefert; fehlt ein Filter auf einem Host, wird die Prüfung `not_evaluated` mit Grund (Filterliste wird beim Start einmal abgefragt, nicht angenommen).
3. **`omp-media-library` — geprüft, Antwort: weder voll Überbleibsel noch im Orchestrator enthalten.** Es ist ein eigenständiger Control-Plane-Node (C17, Juli 2026, Vorbild PIPELINE CONTROLLER: Verzeichnis-Scan + ffprobe + Mark-In/Out je Datei, **ohne Datenbank**). Die Asset-Domäne im Orchestrator (`internal/asset`, Kap. 21, Postgres, Lifecycle, Audit) ist ein *zweites, neueres* Modell und hat den Katalog nicht übernommen (`asset/types.go:3`, `docs/decisions.md` ~26604 nennt die Dopplung selbst). Der Playout-Automator liest keinen Library-Katalog, sondern eine Dateiliste (`media_library: Vec<String>`, `omp-playout-automation/src/main.rs:709`; die geplante ffprobe-Anreicherung ist als „künftiger Ausbau" kommentiert). **Entscheidung für den Plan:** `omp-media-library` bleibt unverändert und wird **nicht** erweitert; Quelle der Wahrheit für Review/Conform/Segmente ist die Asset-Domäne. Eine Brücke (Conform-Segmente → `setSegments`) ist *optional* und erst nach Kap. 43 sinnvoll; ob der Node später entfällt, ist eine eigene Entscheidung (Rückfrage dann, weil er im Katalog/Handbuch steht).
4. **Reales MXF-Profil (aus `ET290730x3_details.html`, ffprobe-Ausgabe eines bestehenden Files):** MXF 1.3, OP1a; Video MPEG-2 4:2:2 (Profil „4:2:2", Level 2), 1920×1080, 25 fps (`r_frame_rate 25/1`), `field_order tt` (**interlaced, top field first**), bt709, 50 Mbit/s, 499 Frames (19,96 s); Audio **8 separate Mono-Spuren** PCM s24le 48 kHz (`channel_layout unknown`, Spurnamen A1–A8; MCA-Labels über `omp-mxf-mca dump`); Start-Timecode 00:00:00:00; erzeugt mit libMXF. Das ist die Referenz für Fixtures und Proxy-Profil. Folgen:
   - Interlaced-Material: Frames des Proxys = Vollbilder (Deinterlace per `yadif=mode=send_frame`, Feldfolge tff beachten); Timeline-Abbildung bleibt 1 Quellframe ↔ 1 Proxy-Frame (25 fps). Feldgenauigkeit wird **nicht** beansprucht.
   - Audio: 8 Mono-Spuren sind erste-Klasse-Fall in QC (Kanalzuordnung, Pegel je Spur) und Player (Spurwahl); `channel_layout unknown` ist **kein** Fehler, sondern Hinweis „Layout nur über MCA-Labels bestimmbar".
   - Fixtures: Testdateien (≤10 s, 25 fps, MPEG-2 422 interlaced, 8×PCM24, MXF OP1a) werden mit `ffmpeg` selbst erzeugt (Burn-in der Framenummer + Testton, definierte schwarze/eingefrorene/stille Abschnitte); weitere Profile (z. B. 29.97 DF, 50p) nur als synthetische Fixtures, nicht als „unterstützt" deklariert, bevor sie gemessen wurden.
   - Die bestehende Datei selbst wird nicht ins Repo kopiert (Urheber-/Größenfrage); sie dient als lokaler Gegencheck, falls der Nutzer sie bereitstellt.
5. **Aufnahmequellen (Kap. 42): beides** — MXL-Sender (wie `omp-recorder` heute) **und** externe Streams (SRT/RTMP über die vorhandenen Gateways, `omp-srt-gateway`, ggf. RTMP-Empfang). Der Plan für 42 ergänzt: „Quelle" ist ein Verweis auf einen MXL-Sender; externe Streams werden über das Gateway zuerst zu einem MXL-Sender gemacht, damit der Recorder nur einen Eingangstyp kennt. Quellen-Verbindungslimits (pro Gateway) werden Ressource `source_conn`.
6. **Startabweichung ≈ 10 s akzeptabel (Kap. 42):** Damit genügt reines Vorwärmen (Modell B mit `leadTime`) in der Regel; „warme" Dauer-Recorder (`warmRecorders`) bleiben Standard 0. `leadTime` = gemessene p95-Startdauer + Sicherheit, mindestens 30 s; Zielwert „Start ≤ 10 s nach Planzeit" wird als Metrik und Alarmschwelle geführt, **nicht** als harte Zusicherung, bevor 42.1 gemessen hat.
7. **Freigabe: nicht festgelegt, fallweise.** Umsetzung: `approvalMode` je Workflow-/Profil-Konfiguration (`none` = direkt abgeschlossen, `single`, `dual`), Standard `single`, Änderung ohne Migration möglich; Rechte `review.approve` getrennt von `review.edit`; Selbstfreigabe per Flag erlaubt/verboten (Standard verboten bei `dual`).
8. **QC vorerst nur ffmpeg/ffprobe.** Die Tool-Schnittstelle (`QcTool`: `name`, `version`, `checks[]`, `run(asset, profile) -> findings[]`) wird trotzdem von Beginn an als Plug-in-Punkt gebaut, sodass ein quelloffenes Werkzeug (Kandidaten später prüfen: z. B. MediaConch für Container-/Strukturkonformität, MediaInfo für Metadaten) ohne Umbau ergänzt werden kann. Im Produkt/UI/Doku werden nur generische Namen genutzt, solange nicht tatsächlich eingebunden; Einbindung wäre eine eigene Entscheidung inkl. Lizenzprüfung (`THIRD-PARTY-NOTICES.md`).

### Anpassungen an den Schritten durch diese Entscheidungen
- **43.0:** Fixture-Erzeugung nach Punkt 4; Filter-Inventur nach Punkt 2 als Test (`ffmpeg -filters` → Fähigkeitenliste im QC-Report).
- **43.3:** Zusatzprüfungen für Interlace (`idet`), Spurweise Pegel (8 Mono-Tracks), `channel_layout unknown`-Hinweis; kein Anspruch auf MXF-Strukturvalidierung über das hinaus, was `ffprobe`/`omp-mxf-mca` liefern.
- **43.5:** Proxy `yadif send_frame`, tff, 25 fps; Timeline-Verifikation Frame-Anzahl 499 ↔ 499 an der Fixture.
- **43.11:** `approvalMode` und Rechte nach Punkt 7.
- **Reihenfolge:** Kap. 43 zuerst; Kap. 42 folgt danach unverändert (42.0 klärt nur noch Punkt 5/6-Details).

## 6. Nicht-Ziele (explizit)

Physisches Trimmen/Re-Encoden (separater Folgeschritt), Cloud-Scale-out für Ingest (Kap. 35 vorhanden, Anbindung später), Hardware-Capture-Karten,
GPU-Beschleunigung für QC, Archivierung (Zustand vorhanden, Prozess später).
