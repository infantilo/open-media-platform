# Geplante Live-Aufnahme: Zeitplan, Ressourcenplanung, Ablauf (Kapitel 42)

Stand 2026-10-19. Orchestrator-Modul `internal/modules/ingest` (Name `ingest`, abschaltbar mit `OMP_MODULES_DISABLE=ingest`) und UI-Modul
`ui/modules/ingest` (Tab „Aufnahmen“). Auftragstext: `Live Ingest.txt`; Plan und Entscheidungen: `docs/PLAN-LIVE-INGEST-UND-FILE-QC.md`.
Das aufgenommene Asset geht automatisch in den **Eingang** (Kapitel 43, QC, Review).

## 1. Bestand (vor Kapitel 42) und Lücken

| Baustein | Stand |
|---|---|
| Aufnahme-Node | `omp-recorder`: MXL (Video+Audio) → Datei (H.264 + PCM, MCA-Labels bei `.mxf`), `record.start(fileName)`/`record.stop`, 1 Aufnahme je Instanz, schreibt nach `OMP_MEDIA_DIR` |
| Zeitplan | `workflows.Scheduler` startet/stoppt **Workflows** (Cron-artig); keine Aufnahmedauer, kein Job-Zustand, keine Retry-/Verspätungsrichtlinie |
| Ressourcen | Host-Kapazität/Profile/Forecast (15 min) in `placement`, `workflows/forecast.go`; **keine** Zeitfenster-Reservierung, keine Disk-/Netz-/MXL-Budgets, nicht atomar |
| Laufzeit | `launcher` (Start/Stop lokal/Host), Registry (IS-04), `graph.Connect` (IS-05), Node-Methoden per HTTP |
| Asset | `internal/asset` (Version/Representation/Lifecycle), Eingang (Kap. 43) |

## 2. Architekturentscheidung: Pool vs. dynamisch vs. hybrid

Gewählt: **hybrid, ohne eigenen Pool-Manager** — je Auftrag ein Rekorder, aber `leadTimeS` (Standard 45 s) **vor** dem Start gestartet, verbunden und bereit, nach der
Sicherung wieder beendet. Begründung aus Messung (2026-10-19, lokal, echte Nodes): Rekorder starten, registrieren, per IS-05 verbinden und `record.start` kostete insgesamt
**0,64 s Startabweichung** bei 20 s Vorwärmzeit (Auftrag mit Start +45 s; erste Aufnahme nach 639 ms). Der Zielwert „≈ 10 s“ ist damit mit großem Spielraum erreichbar; er wird als Kennzahl
(`omp_ingest_start_deviation_ms_max`, `…late_starts_total`) überwacht, nicht als Zusage gegeben.

| Kriterium | A: feste Pools | B: nur dynamisch | C: hybrid (gewählt) |
|---|---|---|---|
| Startlatenz/Bereitschaft | sofort | Startzeit = Prozessstart + Registrierung (Sekunden) im kritischen Pfad | Vorwärmen vor dem Fenster, Bereitschaft vor Start geprüft |
| Leerlaufverbrauch | dauerhaft (RAM, MXL-Flows) | keiner | nur im Vorwärm-/Aufnahmefenster |
| Isolierung | schwach (geteilte Prozesse) | stark (Prozess je Aufnahme) | stark |
| Absturz | Pool-Instanz ersetzen | Prozess neu | Prozess neu, Teilaufnahme gesichert, Rest neu aufgenommen |
| Planbarkeit | Pool-Größe = Limit | Reservierung nötig | Reservierung je Fenster (`recorder_slots`) |
| Mehrere Hosts | Pools je Host pflegen | Host je Auftrag wählen | Host je Auftrag, Budgets je Host |
| Betrieb | Pool-Verwaltung | keine zusätzliche Komponente | keine zusätzliche Komponente |

Verantwortlichkeiten: **Control Plane (dieses Modul)** plant, lässt zu, reserviert und steuert den Ablauf; **Laufzeit (Launcher/Host-Agent)** startet und beendet Prozesse;
**MXL** tauscht Medien — es ist kein Scheduler. MXL-Flow-Puffer werden als Ressource `mxl_shm_mb` *gezählt*, nicht verwaltet (die Quelle liefert den Flow ohnehin; der Rekorder liest nur).
Warm bleibt nichts dauerhaft (`warmRecorders` wurde bewusst nicht gebaut: Startlatenz ist gemessen unkritisch); auf Bedarf: Konverter sind ohnehin Einmalprozesse (ffmpeg).

## 3. Zeit (Zeitzone, Wiederholung, Zeitumstellung)

Startzeit = **Wanduhrzeit in einer IANA-Zeitzone** (`startLocal` + `tz`), Dauer in echten Sekunden. Wiederholung: einmalig, täglich, wöchentlich (Wochentage), monatlich (Monate ohne den Tag werden
übersprungen), mit Intervall, `until`, `count` (zählt ab dem ersten Vorkommen, unabhängig vom Fenster). Zeitumstellung deterministisch (getestet für Europe/Berlin):
**Lücke** (02:30 existiert nicht) → erster existierender Zeitpunkt danach (`shifted`), **Wiederholung** (02:30 zweimal) → die erste Instanz (`ambiguous`), Dauer bleibt echte Zeit.
Beide Fälle sind in der Auftragsliste markiert (⏱). **Idempotenz:** Schlüssel `<zeitplan>|<start UTC>|<index>` (UNIQUE) — Mehrfachauslösung, Neustart oder zwei Orchestratoren erzeugen nie zwei Aufträge.

## 4. Ressourcenplanung und Zulassung (`plan.go`, `store.go: Admit`)

Ressourcen (je Host, je Profil): `recorder_slots`, `converter_slots`, `cpu_cores`, `mem_mb`, `gpu_units`, `disk_mbps`, `disk_gb` (kumulativ), `net_mbps`, `mxl_shm_mb`; plus **Quellenlimit** (gleichzeitige
Aufnahmen je Quelle, Standard 4, je Quelle überschreibbar). Bedarf je Wert mit **Herkunft**: `measured` (aus abgeschlossenen Aufnahmen: Rate = Dateigröße/Dauer ×1,2) vor `configured` (Profil) vor `default`
(konservativ). Budgets: `defaultBudget`/`hostBudgets` (Konfiguration), begrenzt durch erkannte Hardware (RAM, freier Platz).

Entscheidung über das **ganze Fenster** (Sweep über Anfang/Ende aller Buchungen auf dem Host, nicht Momentaufnahme), mit sieben **unterscheidbaren Gründen**:
`source_conflict`, `hard_shortage`, `temporarily_occupied` (mit frühestem möglichem Start und Alternativen je Host), `missing_function`, `storage_insufficient` (Platz **oder** Schreibdurchsatz),
`soft_capacity_warning` (zugelassen, über Warnschwelle), `uncertain_estimate` (zugelassen, Bedarf nur Standardwert). Blockierte Aufträge behalten Gründe, Zeitraum, beteiligte Aufträge, empfohlene Maßnahme und werden
periodisch neu bewertet (höhere Priorität zuerst).

- **Atomar:** ein Advisory-Lock serialisiert Zulassungen; Buchungen werden in derselben Transaktion gelesen und geschrieben. Test: 10 parallele Zulassungen bei 3 Slots → genau 3 zugelassen;
  Eigenschaftstest: nach beliebigen Folgen von Zulassungen überschreitet die Nutzung nie eine harte Grenze (unabhängige Minutenprüfung).
- **Priorität:** `reservePct` hält einen Anteil je Ressource für Aufträge ab `reserveFromPriority` frei. **Verdrängung:** nie automatisch; mit `allowPreempt` nur ein *Vorschlag* künftiger Aufträge niedrigerer
  Priorität; **laufende Aufnahmen sind nie verdrängbar** (gebucht bis Fensterende).
- **Freigabe/Rückbau:** Reservierungen werden in derselben Transaktion wie der Wechsel in einen Endzustand (`completed|failed|cancelled`) freigegeben; Test: nach Fehlschlag keine offenen Reservierungen.

## 5. Ablauf und Wiederherstellung (`runner.go`)

`blocked → scheduled → starting (Vorwärmen) → recording → finalizing → [processing] → completed`, daneben `waiting_for_resources`, `failed`, `cancelled`. Jeder Schritt ist idempotent und liest den Zustand aus
der Datenbank. **Neustart des Orchestrators mitten in der Aufnahme:** die Aufnahme läuft weiter, der Ablauf übernimmt sie (Adopt) — gemessen live: Neustart während einer 120-s-Aufnahme → eine Datei, ein Asset, ein
Rekorder, `completed`. Verwaiste Rekorder (Label `ingest-…`, ohne aktiven Auftrag) beendet `Reconcile`.

- **Verspätete Quelle** (je Zeitplan): `wait` (warten; Aufnahme endet zur geplanten Zeit), `delay` (höchstens N Minuten), `fail`. Die Abweichung wird als `startDeviationMs` festgehalten; im Fenster nie verfügbar → `failed` (Stufe „Quelle“).
- **Abbruch/Absturz in der Aufnahme:** Teilaufnahme wird gesichert und als Asset registriert; danach nach Richtlinie (Versuche, Mindestrestzeit) neue Datei für den Rest, sonst `failed` (Stufe „Aufnahme“) — **nichts geht verloren**.
- **Fehlgeschlagene Nachbearbeitung** (optionaler ffmpeg-Schritt je Profil) verliert die Aufnahme nie: das Asset existiert vorher; Auftrag `failed` (Stufe „Nachbearbeitung“).
- **Laufende Aufnahmen werden nie automatisch unterbrochen** — weder durch Zeitplan-Änderung (nur künftige Aufträge werden ersetzt) noch durch Absage (`abort` ist ausdrücklich nötig; die Teilaufnahme bleibt Asset).
- Verpasstes Fenster (Orchestrator war aus) → `failed` (Stufe „Planung“), sichtbar, nicht still verworfen.

Hand-over an den Eingang: nach Finalisierung entsteht ein Asset (Version + Repräsentation `recorded`, Typ `video`, Status `registered`); der Eingang (Kap. 43) findet es beim nächsten Scan und startet die QC.
Gemessen live: Aufnahme → Asset → QC → „Wartet auf Prüfung“.

## 6. Datenmodell (Migration `ingest` v1), API, Oberfläche

Tabellen `ingest_schedules`, `ingest_jobs` (UNIQUE `idempotency_key`), `ingest_job_events` (jeder Zustandswechsel mit Meldung), `ingest_reservations`, `ingest_profile_stats`. Konfiguration (`ingest.config`, JSON,
Admin): Profile (Endung, Bedarf, MCA-Plan, optionale Konvertierung), Budgets, Regeln, Vorwärmzeit, Horizont, `mediaDir`, Standard-Verspätung/-Wiederholung.

API `/api/v1/ingest`: `GET|POST /schedules`, `GET|PUT|DELETE /schedules/{id}` (+`/preview`), `GET /jobs`, `GET /jobs/{id}` (+Verlauf), `POST /jobs/{id}/cancel|reschedule|readmit`, `POST /adhoc`,
`POST /plan` (**Trockenlauf**, speichert nichts), `GET /capacity`, `GET /sources`, `GET|PUT /config`. Rechte: lesen = angemeldet, planen/absagen = `operate`, Konfiguration = `admin` (Test erzwingt, dass keine verändernde Route nur „angemeldet“ verlangt).

Oberfläche (Tab „Aufnahmen“, nicht in den Scheduler-Tab eingebaut — dessen Workflow-Modell ist ein anderes): **Probleme** zuerst, strikt getrennt in *VORHERGESAGT* (Engpass, noch nicht eingetreten) und *FEHLGESCHLAGEN*/*AKTUELL*;
**Zeitleiste** je Host mit überlappenden Aufträgen gestapelt und eigener Spur „Nicht zugelassen“; **Kapazität je Ressourcenart** (Balken = reservierte Nutzung, gestrichelt = Warnschwelle, Spitze/Grenze mit Einheit) — bewusst
keine Gesamtprozentzahl; Auftragsliste mit Filter; Zeitpläne; Formular mit **Live-Prüfung** (Trockenlauf bei jeder Eingabe: machbar/Gründe/frühester Start); Auftragsdialog mit Verlauf, Neubewertung, Sprung in den Eingang.

Kennzahlen (`/metrics`): `omp_ingest_jobs{state}`, `…queue_depth`, `…overdue`, `…active_recorders`, `…reservations`, `…started/completed/failed/retries_total`, `…start_deviation_ms_sum/max`, `…late_starts_total`,
`…orphans_reaped_total`, `…admission_rejected_total`.

## 7. Tests (Ist-Stand)

Go (`internal/modules/ingest`, Postgres nötig, sonst übersprungen): Zeitzonen/Zeitumstellung/Wiederholung, Planer (alle sieben Gründe, Priorität, Verdrängungsvorschlag, Alternativhost, Eigenschaftstest), Zulassung atomar parallel, Idempotenz,
Zeitplanänderung ohne Eingriff in Laufendes, Verspätungsrichtlinien, Absturz mit Teilsicherung und Wiederholung, Konvertierungsfehler, Abbruch, verpasstes Fenster, Neustart mit Übernahme, verwaiste Rekorder, Messwerte, HTTP/Rechte.
TypeScript: Zeitleisten-Layout, Kapazitätsreihen, Zeitzonenrechnung, Formular, Texte DE/EN.
**Live (echte Nodes, 2026-10-19):** Quelle `omp-source`, Aufnahme 30 s → MXL-Datei (H.264 + PCM), Rekorder gestartet/beendet vom Ablauf, Abweichung 639 ms, Asset + QC im Eingang; Orchestrator-Neustart mitten in einer Aufnahme (Übernahme);
Browser: Tab, Zeitleiste, Kapazität je Ressource, Formular mit Live-Prüfung, Zeitplan anlegen.

## 8. Grenzen / Folgearbeit

1. **Remote-Hosts:** Rekorder können auf Hosts starten (Launcher), die Datei liegt dann auf dem Host; Asset-Registrierung verweist auf den Pfad — Review/QC brauchen gemeinsamen Speicher oder Materialisierung (Kap. 27 P8). Nur lokal live geprüft.
2. **CPU/RAM-Messung je Profil** ist angelegt, wird aber noch nicht aus Host-Telemetrie befüllt (nur Schreibrate); bis dahin Standard/Konfiguration (sichtbar als „unsichere Schätzung“).
3. **Cloud-Hosts** (Kap. 35) nicht angebunden; keine Verdrängung von Aufträgen im Betrieb (nur Vorschlag).
4. Zeitleiste in den bestehenden **Scheduler-Tab** integrieren (heute eigener Tab).
5. Konverter als eigene Ressource wird gebucht (`converter_slots`), die Konvertierung selbst läuft als einfacher ffmpeg-Schritt (keine Pool-Verwaltung).
6. Echtzeit per SSE statt 5-s-Abfrage; Zeitumstellungs-Vorschau im Formular zeigt nur die Wanduhr-Umrechnung des ersten Termins.
