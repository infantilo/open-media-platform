# Entwurf: Host-Auswahl und Lastverteilung für ffmpeg-Jobs

Stand 2026-10-23 (Entscheidungen des Nutzers eingearbeitet) · Status: **umgesetzt 2026-10-23 (F1–F6), lokal getestet — siehe UMSETZUNG.md Kapitel 52 für Abweichungen und offene Prüfpunkte** · Nutzerauftrag: „Host-Auswahl für ffmpeg-Jobs inklusive automatischer Zuweisung/Lastverteilung“.

## 0. Entscheidungen des Nutzers (2026-10-23)

1. **.60/.61 sind derzeit nicht verfügbar** → Entwicklung und Test zunächst nur auf dem Entwicklungsrechner. Ein zweiter Host wird mit einem **zweiten Host-Agent auf demselben Rechner** (anderer `hostId`, eigenes `tools.json`/`jobRoots`) nachgebildet; gemeinsamer Speicher ist dort trivial erfüllt. Die Frage „gemeinsamer Speicher im Cluster“ bleibt als Betriebsvoraussetzung dokumentiert, blockiert aber nichts.
2. **Standardziel ist frei definierbar** (kein fest verdrahtetes `local`): System-Standard, Standard je Aufrufer und je Job einstellbar (3.4). Auslieferungswert bleibt `local`, damit ein Update nichts verschiebt.
3. **GPU zählt in der Lastbewertung**, wenn vorhanden (3.3).
4. **Sendeschutz hat höchste Priorität** – wichtiger als Durchsatz und als gleichmäßige Verteilung (3.6).

## 1. Ausgangslage (Code-Befund)

ffmpeg/ffprobe laufen heute **ausschließlich als Kindprozess des Orchestrators**:

| Aufrufer | Stelle | Eigenschaft |
|---|---|---|
| Workflow-Schritt `script` | `process/executors.go` (`NewScriptExecutor`, Allow-Liste aus `main.go` per `exec.LookPath`) | frei gewählte Argumente |
| File-QC, Review-Proxy | `modules/review/qc_runner.go` (`Runner`-Interface, `osRunner` mit `nice -n 10`) | Fortschritt über stderr |
| Ingest-Nachbearbeitung | `modules/ingest/runner.go` (`s.FFmpeg`) | Auftrag mit Ressourcen-Bedarf (`ResConverter`) |
| FFmpeg-Assistent (Introspektion) | `ffmpegtools` | Hilfetexte **dieses** Hosts |

Bausteine, die schon da sind und wiederverwendet werden:

* **Host-Agent** (`host-agent/internal/commands`): NATS-Request/Reply auf `omp.host.<id>.cmd`, Aktionen `start|stop|update|check-path`, Ereignisse auf `omp.host.<id>.events`. Der Agent führt nur aus, was sein **lokaler Katalog** erlaubt (Sicherheitsgrenze).
* **Host-Telemetrie** (`telemetry.Sample`): CPU-%, RAM, Instanzen, NIC, GPU; Orchestrator kennt `CPUCores`, `MemTotalMB`, `DiskFreeGB`, `Maintenance`, `Online`.
* **Ingest-Planer** (`modules/ingest/plan.go`): `HostCap` (Funktionen, harte Grenzen, Warnschwelle), `Demand`, `Plan()` – inkl. Funktion `converter`.
* **`check-path`**: Pfadprüfung auf dem Ziel-Host.

Lücke: Es gibt **keine** Ausführung beliebiger (allow-gelisteter) Programme auf einem Agent und keine Zuordnung Job → Host.

## 2. Ziele / Nicht-Ziele

Ziele: (a) Jeder ffmpeg-Job hat ein Ziel `auto | <Host-ID> | local`. (b) `auto` wählt nach Eignung und Last und verteilt gleichmäßig. (c) Ausfall eines Hosts führt zum Neustart auf einem anderen. (d) **Sendeschutz geht vor allem anderen:** Live-Nodes (Mischer, Playout, Rekorder, Encoder) werden durch Jobs nachweislich nicht gestört (3.6).

Nicht-Ziele (v1): Dateien zwischen Hosts kopieren; ein Job über mehrere Hosts aufteilen (Segment-Parallelisierung); GPU-Zuteilung auf mehrere Karten eines Hosts (v1: eine Karte je Host, wie `OMP_HOST_AGENT_GPU_INDEX`).

## 3. Architektur

```
Aufrufer (script / QC / Proxy / Ingest-convert)
        │  JobSpec{tool,args,inputs[],outputs[],prio,target,needs}
        ▼
  jobrun.Dispatcher  (neues Paket orchestrator/internal/jobrun)
   ├─ Placement: Filter → Bewertung → Reservierung
   ├─ Warteschlange (nach Priorität), Wiederholung bei Hostverlust
   └─ Backend je Ziel:
        ├─ localBackend   = heutiger osRunner (nice, Allow-Liste)
        └─ agentBackend   = NATS → Host-Agent "exec"
```

`review.Runner` bleibt als Schnittstelle bestehen (`Run(ctx,name,args,onStderr)`); `jobrun` liefert eine zweite Implementierung, die den Host wählt. So ändern sich QC/Proxy nur im Konstruktor, nicht in der Logik.

### 3.1 Host-Agent: neue Aktion `exec` (agent-lokale Freigabe)

* Neue Datei `tools.json` neben dem Katalog (wie `node-options.json`): erlaubte Programme `{ "ffmpeg": {"path":"/usr/bin/ffmpeg","maxJobs":2,"nice":10,"threads":0}, "ffprobe": {...} }` und `jobRoots` (Verzeichnisse, in denen Ein-/Ausgaben liegen dürfen). **Ohne** `tools.json` lehnt der Agent `exec` ab – gleiche Verantwortungsteilung wie beim Node-Katalog.
* Request: `{action:"exec", jobId, tool, args[], timeoutS}`; kein Shell, `exec.Command` mit Argumentliste. Agent prüft: Tool in Liste, jeder Argumentwert, der wie ein Pfad aussieht (absolut), liegt unter `jobRoots`; `-protocol_whitelist file,pipe` wird erzwungen, damit ein Job keine Netz-Quellen des Agent-Hosts öffnet (Netz-Ein-/Ausgänge nur, wenn `tools.json` `allowNet:true` setzt).
* Antwort sofort (Ack, PID); das Ergebnis kommt als **Ereignis** (`omp.host.<id>.job.<jobId>`: `progress` (geparste `-progress`-Zeilen, gedrosselt), `log` (letzte N stderr-Zeilen), `done{exitCode,durationMs}`). Grund: NATS-Request-Timeouts passen nicht zu Jobs von Minuten/Stunden.
* Aktion `exec-cancel {jobId}` (SIGTERM → nach 3 s SIGKILL, wie `stopGracePeriod`).
* Ressourcenschutz: Start über `nice -n <nice>` und optional `systemd-run --scope -p CPUQuota=…` (falls vorhanden); `-threads` aus `tools.json`.
* **Fähigkeitsmeldung** beim Registrieren/Heartbeat (additiv in `Sample` oder Hello): `tools:{ffmpeg:{version,encoders:["libx264","h264_nvenc",…],hwaccels:[…]}}`, `jobRoots`, `jobsRunning`. Ermittelt beim Agent-Start einmal (`ffmpeg -encoders -hwaccels`), erneut bei Änderung.

### 3.2 Medienzugriff (der kritische Punkt)

Ein Job darf nur auf einen Host, der **dieselben Dateien sieht**. v1 nimmt **gemeinsamen Speicher** an (NFS/SMB/S3-Mount; SeaweedFS ist als Dev-Backend schon im Projekt) und modelliert ihn explizit:

* Settings-Dokument `ffmpeg.config`: `pathMap: { "<Orchestrator-Pfadpräfix>": { "<hostId>": "<Pfadpräfix auf dem Host>" } }`. Der Dispatcher schreibt Pfade im Argument-Vektor je Ziel-Host um.
* Eignungsprüfung: vorhandenes `check-path` für jede Eingabe (lesbar) und das Ausgabeverzeichnis (schreibbar), Ergebnis kurz gecacht (30 s). Besteht ein Host sie nicht, ist er für diesen Job **ungeeignet** (nicht „langsam“).
* Ausgaben immer nach `<name>.part` schreiben und nach Erfolg per `rename` (auf dem Host) übernehmen → ein abgebrochener Job hinterlässt nie eine halbe Zieldatei und kann gefahrlos auf einem anderen Host wiederholt werden.
* Lokale Aufnahmen (Rekorder schreibt auf `OMP_MEDIA_DIR` seines Hosts): **Datenlokalität** zählt in der Bewertung (3.3); ohne gemeinsamen Speicher bleibt der Job auf diesem Host.

### 3.3 Zuweisung („auto“)

1. **Filter** (hart): Host `Online` und nicht `Maintenance`; Funktion `ffmpeg` im Host-Budget (`Functions`); Tool vorhanden; benötigte Encoder/Hwaccel vorhanden (`needs`, aus dem Argumentvektor abgeleitet: `-c:v h264_nvenc` → `h264_nvenc`); Pfade gültig (3.2); freie Job-Slots (`maxJobs`) und Budget (`ResCPU`, `ResMem`, `ResConverter` aus dem bestehenden `HostCap.Hard`); Host nicht in `excludeHosts` des Jobs/der Richtlinie.
2. **Bewertung** (kleinster Wert gewinnt):
   `score = w_cpu · cpuLoad + w_gpu · gpuLoad · usesGpu + w_jobs · (jobsRunning+reserved)/maxJobs + w_live · liveNodePenalty + w_data · (dataLocal ? 0 : 1) + w_net · nicLoad`
   * `cpuLoad`: geglättete Telemetrie (EWMA über ~30 s) **plus** noch nicht in der Telemetrie sichtbarer Bedarf bereits zugewiesener Jobs (Reservierung, damit zehn gleichzeitige Jobs nicht alle auf den gerade leersten Host fallen).
   * `gpuLoad`: nur wenn der Host eine GPU meldet (`Sample.Gpu != nil`) **und** der Job sie nutzt (`-hwaccel`, `*_nvenc`, `*_cuvid`, `*_qsv`, `*_vaapi` im Argumentvektor). Zählt Encoder-/Decoder-Auslastung und VRAM. Nutzt der Job die GPU, aber der Host meldet keine Messung, ist der Host **nicht** ungeeignet, bekommt aber den Mittelwert aller Hosts mit Messung plus Aufschlag („unbekannt ≠ leer“, gleiche Ehrlichkeitslinie wie bei `Net`/`Gpu`). Ein Job ohne GPU-Nutzung ignoriert GPU-Last, meidet aber GPU-Hosts mit laufenden GPU-Jobs nicht grundlos.
   * `liveNodePenalty`: hoch, wenn auf dem Host Live-Nodes laufen (Rekorder, Playout, Mischer, Encoder) – Batch-Arbeit soll auf **unbelasteten oder dedizierten** Hosts landen. Hosts können in den Budgets als `batchOnly` oder `noBatch` markiert werden.
   * Standardgewichte: `w_cpu 1.0, w_gpu 1.0, w_jobs 0.7, w_live 1.5, w_data 0.5, w_net 0.3`; änderbar in `ffmpeg.config.weights`.
   * Gleichstand: stabil nach Host-ID (reproduzierbar, testbar).
3. **Reservieren** (Zähler im Dispatcher, Lease mit Ablauf), dann `exec` senden. Bleibt das Ack aus (2 s) oder lehnt der Agent ab → Reservierung freigeben, Host für 60 s „gesperrt“, nächsten Kandidaten nehmen.
4. **Keine Kandidaten**: Job bleibt in der Warteschlange (Priorität, dann FIFO); Anzeige „wartet auf freien Host (Grund: …)“, nach `maxWaitS` Alarm statt stillem Hängen. Auf Wunsch (`fallbackLocal:true`) Ausführung auf dem Orchestrator-Host.

### 3.4 Ziel-Auswahl (festlegen, wo es läuft)

Rangfolge, die spezifischste gewinnt:

1. **Job**: Feld `target` – `auto` | `local` | `host:<id>` | `pool:<name>` (Workflow-Schritt `script`: neues Feld im Schritt-Editor; QC/Proxy: im Profil; Ingest-convert: im Aufnahmeprofil `convert.target`).
2. **Funktion/Modul**: Standard je Aufrufer in `ffmpeg.config.defaults` (`script`, `qc`, `proxy`, `convert`).
3. **System**: `ffmpeg.config.defaultTarget` – vom Betreiber frei wählbar (`local`, `auto`, `host:<id>`, `pool:<name>`), im Einstellungsdialog „ffmpeg-Jobs“ änderbar ohne Neustart. Auslieferungswert `local` (heutiges Verhalten, ein Update verschiebt nichts). Ungültiges oder nicht erreichbares Ziel (Host gelöscht, Pool leer) → Job wartet mit klarer Begründung bzw. nutzt `fallbackLocal`, wenn gesetzt; nie stilles Umbiegen.

Hosts erhalten in der Host-Ansicht (Einstellungen → Hosts) pro Host: Funktion „ffmpeg-Jobs“ an/aus, `maxJobs`, `batchOnly`, Pool-Zugehörigkeit; Pools (`pool:render`) sind benannte Host-Gruppen für gezielte Zuteilung (z. B. Hosts mit GPU).

### 3.5 Ausfall und Wiederholung

* Agent meldet kein `done` und die Host-Telemetrie bricht ab (Offline-Erkennung existiert) → Job „unterbrochen“, `attempt+1`, zurück in die Warteschlange mit `excludeHosts += alterHost` (bis `maxAttempts`, Standard 2, analog `RetryPolicy`).
* Exit-Code ≠ 0 ist ein **Ergebnis** (nicht wiederholen); nur Ausführungsfehler (Host weg, Tool fehlt, Pfad nicht sichtbar) wiederholen – wie die bestehende Trennung „QC nicht ausführbar ≠ QC fand Fehler“.
* Orchestrator-Neustart: laufende Jobs stehen in `jobrun_jobs` (Postgres); beim Start Abgleich mit den Agents (`exec-list`), Jobs übernehmen statt neu starten (gleiches Muster wie PID-Wiederanbindung der Instanzen).

### 3.6 Sendeschutz (höchste Priorität)

Regel: **Kein Job darf eine laufende oder bald startende Sendung verschlechtern.** Das ist ein harter Filter und eine Laufzeitregel, kein Gewicht.

1. **Reservierte Kapazität für Live:** Je Host gilt `liveReserve` (Standard: CPU 30 %, RAM 25 %, GPU-Encoder 30 %, NIC 25 % der Kapazität). Jobs dürfen nur den Rest nutzen, unabhängig davon, wie leer der Host gerade aussieht.
2. **Live-Hosts sind für Batch gesperrt, wenn so konfiguriert:** Host-Option `noBatch` (nie Jobs) / `batchOnly` (nur Jobs). Standard für Hosts mit laufenden Playout-/Mischer-/Encoder-/Rekorder-Nodes: Jobs nur der Klasse `interactive`, und nur unterhalb der Reserve.
3. **Vorausschau:** Der Ingest-Planer und die Playout-Automation kennen kommende Aufnahmen/Sendungen. Ein Job wird nicht gestartet, wenn er innerhalb seiner geschätzten Laufzeit (oder `lookaheadMin`, Standard 30 min) in eine gebuchte Live-Belegung desselben Hosts hineinlaufen würde, die die Reserve verletzt.
4. **Laufzeit-Wächter:** Der Dispatcher überwacht die Host-Telemetrie. Überschreitet die Live-Last (Instanz-Samples der Live-Nodes) oder die Gesamtlast die Soft-Grenze, oder meldet ein Live-Node Aussetzer (Alarm vorhanden: Tonaussetzer/Frame-Drops), wird gestuft eingegriffen: **(a)** Drosselung (`nice`, bei systemd `CPUQuota` herabsetzen, `SIGSTOP` für `batch`), **(b)** Pausieren/Abbrechen von `batch` und Neustart später oder auf anderem Host, **(c)** `scheduled`/`interactive` nur nach Soft-Grenze der Stufe (b). Reihenfolge beim Abbruch: zuletzt gestartet, niedrigste Priorität zuerst.
5. **Prozess-Isolation:** Jobs laufen mit `nice 10–19`, `ionice -c3` (Idle-IO), optionaler CPU-Affinität auf nicht von Live-Nodes belegte Kerne und – falls vorhanden – in einer eigenen cgroup/systemd-Scope mit `CPUQuota`/`MemoryMax`. Der Kernel-OOM-Killer darf einen Job, nie einen Live-Node treffen (`OOMScoreAdjust` hoch für Jobs).
6. **Klassen:** `interactive` (Nutzer wartet) > `scheduled` (Ingest-convert vor Termin) > `batch` (QC-Massenlauf). Je Klasse eigene Obergrenze gleichzeitiger Jobs je Host; `batch` startet nie über `softFraction`.
7. **Eine Quelle der Wahrheit:** Der Dispatcher übernimmt die Buchungen des Ingest-Planers (`converter`, CPU, RAM, Platte) als Vorbelegung, statt ein zweites Kapazitätsmodell zu führen.
8. **Nachweisbar:** Jeder Eingriff (Drosselung, Pause, Abbruch, verweigerter Start) wird mit Grund protokolliert, als Metrik gezählt und als Alarm sichtbar (`omp_job_protect_total{action}`).

### 3.7 Sichtbarkeit

* Neue Seite/Reiter „Jobs“: laufende und wartende Jobs mit Host, Fortschritt, Dauer, Versuch; Abbrechen; Verlauf (letzte 200).
* Host-Ansicht: Auslastungsbalken zeigt Live-Nodes **und** Jobs getrennt.
* Metriken `omp_jobs_running{host}`, `omp_jobs_waiting`, `omp_job_placement_total{reason}`; Alarm „Job wartet > maxWaitS“ und „Host fiel während Job aus“.
* Jeder Job-Datensatz hält die **Begründung der Auswahl** (Kandidaten mit Score/Ablehnungsgrund) – die erste Frage im Betrieb ist „warum dort?“.

## 4. Schnittstellen (Skizze)

```
POST /api/v1/jobs                 {tool,args,target,prio,inputs[],outputs[]} → {id}
GET  /api/v1/jobs?state=...       Liste
GET  /api/v1/jobs/{id}            inkl. placement.candidates[]
DELETE /api/v1/jobs/{id}          abbrechen
GET/PUT /api/v1/settings/ffmpeg.config
Agent: exec | exec-cancel | exec-list   (NATS omp.host.<id>.cmd)
Ereignisse: omp.host.<id>.job.<jobId>   progress|log|done
```
Funktionsrecht: neues Recht `jobs.run` (Ansehen/Abbrechen) und `jobs.configure` (Ziele/Gewichte/Hosts) im bestehenden Rechtesystem (Kap. 44).

## 5. Phasenplan (jeweils eine Sitzung, mit Prüfkriterium)

| Phase | Inhalt | Prüfkriterium |
|---|---|---|
| F1 | Paket `jobrun`: `JobSpec`, Dispatcher, `localBackend`, Persistenz, API, Reiter „Jobs“; `review.Runner` und `script`-Schritt darauf umgestellt, Standardziel `local` | Alle bestehenden Tests grün; Verhalten unverändert; Jobs erscheinen in der Liste |
| F2 | Agent: `tools.json`, `exec`/`exec-cancel`/`exec-list`, Ereignisse, Pfad-/Protokollprüfung, Fähigkeitsmeldung | Agent-Tests: Tool nicht freigegeben → abgelehnt; Pfad außerhalb `jobRoots` → abgelehnt; Abbruch killt Prozess; `-progress` kommt an |
| F3 | `agentBackend` + `target: host:<id>`, `pathMap`, `.part`-Rename | Lokal: zweiter Host-Agent (andere `hostId`) auf dem Entwicklungsrechner; ffprobe/ffmpeg-Job über NATS dorthin, Ergebnisdatei identisch zu lokal |
| F4 | Placement `auto` (Filter, Bewertung inkl. GPU, Reservierung, Warteschlange), Einstellungen `ffmpeg.config` (frei definierbares Standardziel), Host-Optionen/Pools | Tabellentest der Bewertung (u. a. GPU-Job bevorzugt GPU-Host, GPU unbekannt ≠ leer); 10 gleichzeitige Jobs verteilen sich ~gleichmäßig über 2 Agent-Hosts; `maxJobs` wird nie überschritten |
| F4b | **Sendeschutz** (3.6): Live-Reserve, `noBatch/batchOnly`, Vorausschau, Laufzeit-Wächter mit Drosselung/Pause/Abbruch, Isolation (nice/ionice/cgroup/OOM), Protokoll + Metriken | Mit einem laufenden Test-Live-Node (Testmuster→Mischer) Last durch Jobs erzeugen: Live-Node zeigt keine Frame-Drops/Tonaussetzer; Wächter drosselt/pausiert nachweislich; Job in gebuchter Live-Zeit startet nicht. Kurz und klein testen (CPU-Last begrenzen) |
| F5 | Ausfall/Wiederholung, Orchestrator-Neustart-Abgleich, Alarme | Zweiten Agent mitten im Job beenden → Job läuft auf anderem Host fertig, keine halbe Zieldatei; Orchestrator-Neustart verliert keinen Job |
| F6 | UI-Felder (Schritt-Editor, QC-/Convert-Profile), Priorität/Schutz der Sendung, Handbuch (BENUTZERHANDBUCH, HANDBUCH §9), Katalogtext | Click-Test per CDP; Batch-Job startet nicht auf Host über Softgrenze |

## 6. Offene Punkte (nach Nutzerentscheidungen)

Entschieden: Standardziel frei definierbar; GPU in der Bewertung; Sendeschutz höchste Priorität; .60/.61 zunächst außen vor.

1. **Gemeinsamer Speicher im Cluster** (Betriebsvoraussetzung für Lastverteilung zwischen echten Hosts): später mit .60/.61 klären; bis dahin Tests mit zweitem Agent auf dem Entwicklungsrechner.
2. **Netz-Ein-/Ausgänge** (RTMP/SRT) in Jobs: in v1 gesperrt (`allowNet:false`), je Host freigebbar.
3. **Rekorder-Dateien ohne Shared Storage:** `convert` bleibt hart an den Rekorder-Host gebunden (im Planer als Bindung abbilden).
4. **Standardwerte der Live-Reserve** (30/25/30/25 %) sind Annahmen und sind am echten Betrieb zu kalibrieren.
5. **Drosselung per `SIGSTOP`:** funktioniert nicht für Jobs mit Live-Eingang (Netzquelle läuft weiter); für Dateijobs zulässig. Bei Live-Eingang nur Abbruch.

## 7. Nachtrag 2026-10-23 (Kapitel 54): Wire-Format, Trend-Daten, Auto-Kalibrierung

* **Wire-Format** (`jobwire`): Anfrage, Ereignisse, Fähigkeitsmeldung, Aktionsnamen, Subjects und die beiden Fehlertexte stehen jetzt in einem gemeinsamen Go-Modul (`/jobwire`, wie `nodeoptions` per `replace` eingebunden), das Orchestrator und Host-Agent importieren — die handgepflegte Doppelung samt Vertragstests entfällt; ein Formattest im Modul schreibt die JSON-Form fest.
* **Trend-Daten:** Die Host-Historie trägt je Sample zusätzlich Live-CPU (Kerne der Instanzen), Live-RAM, Live-GPU, GPU und Netz; Minutenwerte (24 h) tragen die Maxima, **Stundenwerte** (`host_metrics_hourly`, 30 Tage) überleben Neustarts. Der Orchestrator-Rechner wird alle 5 s als Host `local` eingetragen.
* **Auto-Kalibrierung:** `jobrun.Calibrate` (rein): Bedarf = max(P95, 0,75 · Spitze) der Live-Last in % der Hostkapazität + Abstand, begrenzt [10 %, 60 %]; ohne Job-Last gemessen (Instanzen, nicht Gesamtlast); GPU nur mit GPU; Netz bleibt manuell. Modus `manual` (Standard, nur Vorschlag) | `auto`; Glättung: Anstieg sofort, Rückgang ≤ 1 Punkt je 5 min; Rangfolge Host-Vorgabe → Auto → System-Reserve; mindestens 2 h Messdauer. Place, Wächter und Anzeige nutzen die **Reserve des Hosts** (`HostState.Reserve`).
* **Entscheidung Trending:** sinnvoll, aber bewusst klein — Stundenwerte statt Zeitreihen-Datenbank (die Plattform liefert für Langzeit/Alarmierung weiter `/metrics` an Prometheus). Zweck: Kalibrierung, Kapazitätsplanung (7/30 Tage), Ursachenanalyse nach Vorfällen.
