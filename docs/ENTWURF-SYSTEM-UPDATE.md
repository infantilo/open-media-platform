# Entwurf: System-Update per Supervisor (Browser-Upload als Admin)

Stand: 2026-09-30 · Status: **Entwurf, nichts davon ist implementiert.**
Auslöser: „Gibt es schon eine Möglichkeit, den Orchestrator/Server per UI zu
updaten (Firmware-Update)?" — Antwort heute: nein. Vorhanden ist nur der
Backup/Restore-Weg über `omp-supervisor` (`supervisor/main.go`), der
denselben Bausteine-Satz nutzt, den dieses Update wiederverwenden soll.

## 1. Ziele und Nicht-Ziele

Ziele

- Ein Admin lädt im Browser ein **Update-Paket** hoch, sieht dessen Inhalt
  (Version, Komponenten, Prüfsummen), bestätigt, und der Server aktualisiert
  sich selbst — mit automatischem Backup vorher und **automatischem Rollback**,
  wenn der neue Stand nicht gesund hochkommt.
- Kein neuer Mechanismus für „Prozess stoppen/starten": der Supervisor ruft
  weiter `deploy/dev/{stop,start}-omp.sh` (wie beim Restore).
- Lokaler Upload ist der Standardweg (kein Internetzugang nötig, Air-Gap-fähig).

Nicht-Ziele (Phase 1)

- Kein Download aus dem Netz/Git aus der UI.
- Kein Cluster-Rolling-Update (mehrere Orchestrator-Mitglieder), kein
  Host-Agent-/Remote-Node-Update — siehe Phase 3.
- Kein Update von Containern (NATS, Postgres/Patroni, NMOS-Registry).

## 2. Ist-Stand (relevante Fakten)

| Baustein | Stand |
|---|---|
| Supervisor | eigener Prozess, `127.0.0.1:8091`, kennt `GET /status`, `POST /restore`; Ablauf stop → Restore → start in Goroutine, antwortet vorher (400 ms `sleepBeforeStop`) |
| Orchestrator → Supervisor | `SupervisorClient.TriggerRestore`, Route `POST /api/v1/admin/restore` (`VerbAdmin`, harte `confirm:true`-Bestätigung) |
| Upload-Muster | `POST /api/v1/admin/backups` nimmt rohe Bytes (`maxBackupUploadBytes`), legt sie serverseitig benannt in `.backups/` ab |
| Start | `start-omp.sh` **baut den Orchestrator jedes Mal aus dem Quellcode** (`go build`, Zeile 99) — für ein Binär-Update ungeeignet |
| Nodes | Binaries liegen unter `nodes/target/debug/…`, `deploy/catalog.json` verweist per relativem Pfad darauf; UI-Bundle `ui/dist/shell.js` |
| Migrationen | laufen beim Orchestrator-Start (nur vorwärts) |
| Version | es gibt keine Versionsnummer/Build-Stempel |
| Laufende Nodes | überleben einen Orchestrator-Neustart (PID-Reattach) — laufen dann mit dem **alten** Binary weiter |

## 3. Update-Paket

Datei `omp-update-<version>.tar.gz`, erzeugt von einem neuen Make-Target
`make update-bundle` (baut Release-Binaries + UI und packt sie).

```
manifest.json          # siehe unten
manifest.sig           # Phase 2: Ed25519-Signatur über manifest.json
orchestrator/omp-orchestrator
supervisor/omp-supervisor          # optional, s. §6
ui/dist/…                          # gebündeltes UI
nodes/<name>                       # optionale Node-Binaries
deploy/catalog.json                # optional
```

```json
{
  "schemaVersion": 1,
  "version": "2026.10.0",
  "gitCommit": "05fe9f2",
  "builtAt": "2026-09-30T15:00:00Z",
  "arch": "linux/amd64",
  "minFromVersion": "2026.9.0",
  "migrations": ["0031_xyz.sql"],
  "components": [
    {"id": "orchestrator", "path": "orchestrator/omp-orchestrator", "sha256": "…", "target": "bin/omp-orchestrator"},
    {"id": "ui",           "path": "ui/dist/shell.js",              "sha256": "…", "target": "ui/dist/shell.js"}
  ]
}
```

Regeln: jede Datei nur in einem **fest erlaubten Zielpfad-Satz** (Allowlist
im Supervisor, keine freien Pfade aus dem Manifest ohne Prüfung); `..`,
absolute Pfade und Symlinks im Archiv werden abgelehnt; `sha256` jeder
Komponente wird beim Staging und noch einmal vor dem Tausch geprüft.

## 4. Ablauf

```
Browser ──POST /api/v1/admin/updates (rohe Bytes)──▶ Orchestrator
   Orchestrator: streamt in .updates/incoming/, entpackt nach
   .updates/staged/<id>/, prüft Manifest + sha256, meldet Inhalt zurück.
Browser ──GET /api/v1/admin/updates, /{id}──▶ Liste + Details (Version,
   Komponenten, „Migrationen: ja/nein", Kompatibilität)
Browser ──POST /api/v1/admin/updates/{id}/apply {confirm:true, version:"…"}──▶
   Orchestrator ──POST http://127.0.0.1:8091/update {id}──▶ Supervisor
Supervisor (Goroutine, antwortet sofort):
  1. Phase "backup":    DB-Backup (vorhandener Backup-Code) — Abbruch bei Fehler
  2. Phase "stopping":  stop-omp.sh
  3. Phase "swapping":  je Komponente: alte Datei nach .updates/rollback/<ts>/,
                        neue per atomarem rename() an den Zielpfad
  4. Phase "starting":  start-omp.sh mit OMP_SKIP_BUILD=1
  5. Phase "verifying": GET /healthz + GET /api/v1/version == Manifest-Version,
                        Timeout 60 s
  6. Erfolg → status ok; Fehler → Phase "rolling-back": stop, Dateien aus
                        rollback/ zurück, start, status failed + Log.
Browser: Overlay „Update läuft" (Muster des Restore-Overlays), pollt
   /api/v1/health bis der Server zurück ist, zeigt Ergebnis + Logauszug.
```

`GET /status` des Supervisors wird um Phase/Ergebnis des Updates erweitert
(derselbe `status`-Typ wie beim Restore, ein gemeinsames „Busy"-Flag, damit
Restore und Update nie parallel laufen).

## 5. Sicherheit

- **Ein Update-Paket ist ausführbarer Code.** Admin-Upload ist damit
  absichtlich eine Remote-Code-Ausführung auf dem Server. Deshalb:
  - nur `VerbAdmin`, Eintrag im Audit-Log (wer, welche Version, sha256),
  - Upload-Limit (z. B. 1 GiB), Streaming auf Platte statt `io.ReadAll`,
  - getippte Bestätigung der Versionsnummer beim Anwenden (wie beim
    Restore der Dateiname),
  - **Phase 2: Ed25519-Signatur** des Manifests; der öffentliche Schlüssel
    liegt beim Supervisor (nicht im Paket, nicht per UI änderbar). Ohne
    gültige Signatur wird das Paket in Produktion abgelehnt; für Dev ein
    Schalter `OMP_UPDATE_ALLOW_UNSIGNED=true`.
- Der Supervisor bleibt loopback-only. Er entpackt/prüft selbst noch einmal
  (vertraut dem Orchestrator nicht blind, der ja gerade ersetzt wird).
- Ein kompromittierter Admin-Account ist damit Vollzugriff — das ist die
  bewusste Grenze; die Signatur (Phase 2) trennt „Admin im Browser" von
  „darf Code einspielen".

## 6. Was genau wird ersetzt

| Komponente | Phase | Anmerkung |
|---|---|---|
| Orchestrator-Binary | 1 | Neustart per stop/start |
| UI-Bundle (`ui/dist`) | 1 | wird vom Orchestrator serviert, mit dem Neustart aktiv |
| Node-Binaries + `catalog.json` | 2 | ersetzen per rename (laufende Prozesse behalten ihren alten Inode und laufen weiter); neue Version wirkt erst beim **nächsten Instanz-/Workflow-Start** — UI zeigt „Node läuft mit älterer Version" |
| Supervisor selbst | 3 | kann sich nicht selbst ersetzen: neues Binary daneben ablegen, dann `exec` per kleinem Übergabeschritt am Ende des Updates |
| Host-Agents / Remote-Hosts | 3 | eigener `update`-Befehl (Allowlist wie `allowedExtraEnvKeys`), Reihenfolge: Hosts vor dem Orchestrator |
| Cluster (Raft-Mitglieder) | 3 | rollierend, Leader zuletzt |

## 7. Datenbank-Migrationen und Rollback

Migrationen laufen nur vorwärts beim Start. Ein Binär-Rollback nach
erfolgreicher Migration kann deshalb gegen ein neueres Schema laufen.
Vorgehen:

- Das Paket deklariert `migrations` im Manifest; die UI zeigt „Dieses Update
  ändert die Datenbank".
- Das Backup in Phase „backup" ist Pflicht (nicht abschaltbar, wenn
  `migrations` nicht leer ist).
- Schlägt die Verifikation fehl **nach** angewendeter Migration, rollt der
  Supervisor nur die Dateien zurück und meldet deutlich: „DB-Schema neuer als
  Binary — Backup `<name>` über den Restore-Weg einspielen". Ein
  automatischer DB-Restore wird bewusst **nicht** gemacht (folgenreichste
  Aktion der Plattform, s. `handleRestore`).
- Regel für künftige Migrationen: erst additiv (neue Spalten/Tabellen), damit
  das vorige Binary weiterläuft (Expand/Contract).

## 8. Änderungen im Code (Umfang Phase 1)

1. `internal/version` (Build-Stempel per `-ldflags`) + `GET /api/v1/version`.
2. `start-omp.sh`: `OMP_SKIP_BUILD=1` überspringt `go build`.
3. Orchestrator: `internal/updates` (Staging, Manifest-Prüfung, Liste),
   Routen `GET/POST /api/v1/admin/updates`, `POST …/{id}/apply`,
   `DELETE …/{id}`; `SupervisorClient.TriggerUpdate`.
4. Supervisor: `POST /update`, Phasen backup/stopping/swapping/starting/
   verifying/rolling-back, gemeinsamer Busy-Status mit Restore.
5. `make update-bundle` + `tools/update-bundle` (Manifest erzeugen).
6. UI (`admin-view.ts`, Karte „System-Update"): aktuelle Version, Upload,
   Liste gestagter Pakete mit Details, „Anwenden" mit Bestätigung und
   Backup-Häkchen, Fortschritts-Overlay mit Reconnect, Update-Historie.
7. Tests: Manifest-/Pfad-Validierung (Zip-Slip, Symlink, falscher Hash),
   Supervisor-Ablauf mit Fake-Skripten inkl. Rollback-Pfad, HTTP-Handler.

Verifikation Phase 1: (a) gültiges Paket → Version wechselt, `/healthz` ok;
(b) Paket mit absichtlich kaputtem Binary → automatischer Rollback, alter
Stand läuft; (c) manipulierter Hash / `..`-Pfad → abgelehnt; (d) Restore und
Update gleichzeitig → 409.

## 9. Offene Entscheidungen

1. **Umfang Phase 1:** nur Orchestrator + UI, oder gleich die Node-Binaries?
   (Empfehlung: nur Orchestrator + UI; Nodes in Phase 2.)
2. **Signatur:** ab Phase 1 verpflichtend oder erst Phase 2? (Empfehlung:
   Phase 2, bis dahin nur Admin + Prüfsummen + Bestätigung.)
3. **Laufende Nodes nach dem Update:** automatisch neu starten (Workflows
   kurz unterbrochen) oder nur markieren „läuft mit älterer Version"?
   (Empfehlung: nur markieren.)
4. **Dev vs. Release:** dieses Update setzt ein Release-Layout mit fertigen
   Binaries voraus. Im Dev-Betrieb (`make start` baut aus dem Quellcode)
   bliebe `git pull` + `make start` der Weg; der Update-Knopf wäre dort
   nur zum Testen des Ablaufs. Soll `bin/` bzw. `nodes/target/release`
   das Ziel sein?
