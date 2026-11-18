# Entwurf: System-Update per Supervisor (Browser-Upload als Admin)

Stand: 2026-09-30 · Status: **umgesetzt (siehe „Umsetzung“ am Ende), live getestet.**
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

## 10. Umsetzung (2026-09-30)

Entscheidungen zu §9: **Signatur ab Phase 1 verpflichtend** (Ed25519,
`OMP_UPDATE_ALLOW_UNSIGNED=true` nur für Entwicklung), **Node-Binaries und
Supervisor sind von Anfang an Teil des Pakets**, **laufende Nodes laufen
weiter und werden als „veraltet“ markiert**, Ziel sind **fertige Binaries**
(`OMP_SKIP_BUILD=1` überspringt Go-/Deno-Build in `start-omp.sh`).

Bausteine

- `update/` — gemeinsames Go-Modul: Paketformat, Manifest, sichere
  Prüfung (kein Symlink/`..`/absoluter Pfad/nicht gelistete Datei,
  SHA-256, Ed25519), Entpacken, Versionsvergleich. Von Orchestrator,
  Supervisor und Werkzeug gemeinsam genutzt.
- `tools/update-bundle` — `keygen`, `pack`, `verify`; `make update-keygen`
  und `make update-bundle` (Orchestrator mit Versionsstempel, Supervisor,
  Host-Agent, UI, alle im Katalog referenzierten Nodes).
- Orchestrator — `GET /api/v1/version` (offen), `GET/POST/DELETE
  /api/v1/admin/updates…`, `POST …/{id}/apply` (Admin; getippte
  Versionsbestätigung, Backup vorher — Pflicht bei Migrationen,
  Mindestversion/Downgrade-Schutz, Domain-Audit). Instanzen mit
  `outdated` (Binary jünger als Prozessstart).
- Supervisor — `POST /update`: prüft erneut, stellt neben den Zielen bereit
  (ohne Downtime), stop → tauschen (Vorgänger nach
  `.updates/rollback/<ts>/`) → start → Version/Health prüfen →
  automatischer Rollback; ersetzt sich zuletzt per `exec` (gleiche PID);
  Verlauf in `.updates/history.json`. Ein gemeinsames Busy-Flag mit Restore.
- UI — Admin → „System-Update“; Badge „veraltet“ in der Instanzenansicht.

Einrichtung (einmalig)

1. `make update-keygen` — privater Schlüssel unter `~/.omp-update/`
   (geheim halten, nicht auf den Server), `update-trusted.pub` daneben.
2. `update-trusted.pub` auf den Server nach `.run/update-trusted.pub`.
3. Orchestrator und Supervisor einmal mit dem neuen Code starten
   (`make stop && make start`) — danach reicht der Browser.

Ablauf pro Update: `make update-bundle` → `dist/omp-update-<Version>.tar.gz`
→ im Browser hochladen → prüfen → Version eintippen → installieren.

Live geprüft am 2026-09-30: erfolgreiches Update (Orchestrator, UI,
Supervisor per `exec`, Host-Agent, Node-Binary über den Katalog), manipuliertes
Paket abgelehnt, absichtlich defekter Orchestrator → automatischer Rollback
auf den vorherigen Stand.

Remote-Hosts (umgesetzt, live mit den simulierten Hosts geprüft)

- `POST /api/v1/admin/updates/{id}/distribute` (Admin, Versionsbestätigung)
  schickt jedem online gemeldeten Host-Agent per NATS ein `update`-Kommando
  mit einem **Einmal-Token-Pfad**. Der Agent lädt das Paket nur von
  SEINEM Orchestrator (`GET /api/v1/host-updates/{id}?token=…`, bewusst
  außerhalb des Auth-Gates, Token nur für diese Paket-ID, 30 min), prüft es
  mit seinem **eigenen** Vertrauensanker (`OMP_UPDATE_PUBKEY_FILE` auf dem
  Host) und ersetzt nur das eigene Agent-Binary und Node-Binaries aus dem
  **agent-lokalen** Katalog. Offline-Hosts werden übersprungen und gemeldet.
- Ergebnis je Host live in der UI (Admin → System-Update → Paket →
  „An Remote-Hosts verteilen“).
- Kein Agent-Neustart (ein `exec` würde seine im Speicher gehaltenen
  Kindprozesse verwaisen lassen): das neue Agent-Binary wird beim nächsten
  Agent-Neustart aktiv. Instanzen auf Hosts werden über die Telemetrie als
  „veraltet“ markiert (Binary jünger als Prozessstart).

Noch nicht enthalten

- **Cluster-Rolling-Update** (mehrere Orchestrator-Mitglieder) — nicht
  testbar mit einem einzelnen Mitglied, bewusst nicht geraten.
- Ein **automatischer** Neustart von Host-Agents/Nodes nach dem Update —
  bewusst nicht: ein Update startet nie selbstständig laufende Sendungen
  neu. Stattdessen gibt es die bestätigte Aktion „Veraltete Instanzen jetzt
  neu starten“ (Admin → System-Update, `POST /api/v1/admin/updates/
  restart-outdated`): Workflow-Rollen per `RestartRole` (stabile IDs),
  freistehende Instanzen per Stop + Start mit denselben Angaben.
- Im Entwicklungsbetrieb überschreibt ein späteres `make start` den
  eingespielten Stand wieder mit einem Quellcode-Build (Version „dev“);
  `start-hosts.sh` verhält sich genauso (außer mit `OMP_SKIP_BUILD=1`).

## 11. Cluster-Rolling-Update (Plan 2026-11-03, umgesetzt 2026-11-04 – Schritte 84.1–84.5; 84.6 siehe UMSETZUNG.md)

Ziel: ein Paket im Browser einspielen, alle Orchestrator-Mitglieder des
Raft-Clusters werden nacheinander aktualisiert, ohne dass die Steuerung
ausfällt. Dieselbe Mechanik liefert „Cluster rollierend neu starten“ (Paket
leer, nur Neustart) — das ist der zentrale Neustart.

### 11.1 Ausgangslage (geprüft)

- Jedes Mitglied hat eigenes Dateisystem und eigenen Supervisor
  (`127.0.0.1:8091`); `apply` wirkt nur lokal (`handleApplyUpdate`).
- Postgres, NATS und JWT-Geheimnis sind gemeinsam; Raft hält nur
  Mitgliedschaft/Leader (`cluster.Status`: Peers, `peerHttpAddrs`,
  `appliedIndex/lastIndex`, `fsmVersion`).
- Vorbild für die Verteilung: `updates/distribute.go` (Einmal-Token, Download
  vom eigenen Orchestrator, Prüfung mit dem **eigenen** Vertrauensanker).
- Fencing-Vorbild: Raft-Amtszeit `Omp-Term` in signierten Host-Kommandos.

### 11.2 Ablauf

1. Vorprüfung (alles muss grün sein, sonst 409 mit Klartext):
   - mindestens **3 stimmberechtigte Mitglieder** (oder 2 + Zeuge); bei genau
     2 gibt es beim Neustart eines Mitglieds kein Quorum → blockiert (Befund `cluster-quorum`, siehe 11.9);
   - alle Mitglieder erreichbar, Follower, `appliedIndex` nahe `lastIndex`;
   - Paket hat Manifest-Merkmal **`rollingSafe: true`** (siehe 11.4);
   - kein Restore/Update läuft (gemeinsames Busy-Flag).
2. Paket an alle Mitglieder verteilen (Einmal-Token, Download vom
   Koordinator, Prüfung am Mitglied selbst). Erst wenn **alle** das Paket
   geprüft haben, beginnt der Tausch.
3. Reihenfolge: Zeuge, dann Follower einzeln, **Leader zuletzt**. Vor dem
   Leader: `raft.LeadershipTransfer()` auf ein bereits aktualisiertes
   Mitglied (neue Methode `Node.TransferLeadership`), dann den alten Leader
   als Follower aktualisieren.
4. Je Mitglied: lokaler Supervisor führt die bekannten Phasen aus (stopping →
   swapping → starting → verifying → bei Fehler eigener Rollback). **Tor zum
   nächsten Mitglied:** `/healthz` ok, Version = Zielversion, Raft-Zustand
   Follower/Leader, Rückstand `lastIndex − appliedIndex` unter Schwelle,
   Quorum weiter vorhanden. Erst dann der nächste.
5. Fehler irgendwo: Rollout **hält an**, übrige Mitglieder bleiben
   unberührt, UI zeigt „gemischter Stand“ (Mitglied → Version). Das
   fehlgeschlagene Mitglied hat sich selbst zurückgerollt. Kein automatisches
   Zurückrollen bereits fertiger Mitglieder; Knopf „Rollout fortsetzen“ /
   „bereits aktualisierte zurücksetzen“ (Vorgängerpaket liegt im
   `.updates/rollback`).

### 11.3 Wer steuert? (Kernentscheidung)

Der Koordinator darf nicht „der Prozess sein, mit dem der Browser spricht“ —
der Leader wird mitten im Rollout neu gestartet. Daher:

- **Rollout-Zustand in Postgres** (Tabelle `cluster_rollouts`: ID, Paket,
  Zielversion, Schritte je Mitglied mit Zustand/Zeit/Fehler, Gesamtzustand).
- Der Treiber läuft unter `runWhileLeader` (bestehendes Muster D12). Wechselt
  der Leader (Transfer oder Absturz), setzt der neue Leader den Rollout aus
  dem Datenbankzustand fort; Schritte sind idempotent (Zielversion schon da
  → überspringen).
- Befehl an ein Mitglied: neue interne Route
  `POST /api/v1/internal/cluster-update/apply`, Authentisierung per HMAC aus
  dem gemeinsamen JWT-Geheimnis (Ableitung `omp-cluster-update-v1`, gleiche
  Technik wie `nodeauth`) **plus** `Omp-Term`-Fencing (ein abgelöster Leader
  kann keinen Schritt mehr auslösen). Das Mitglied ruft seinen lokalen
  Supervisor — der Supervisor bleibt loopback-only.

### 11.4 Datenbank-Migrationen (das eigentliche Risiko)

Während des Rollouts laufen alte und neue Version gleichzeitig gegen
**dieselbe** Datenbank. Daher:

- Manifest-Merkmal `rollingSafe`: Migrationen sind rein additiv
  (Expand/Contract, §7) und das alte Binary läuft gegen das neue Schema.
  `tools/update-bundle` setzt es nur auf ausdrückliche Angabe; ohne das
  Merkmal bietet die UI nur „Alle gleichzeitig mit kurzer Unterbrechung“ an
  (Mitglieder stoppen, einer migriert, übrige starten).
- Raft-FSM: neue Befehlsarten, die ein altes Mitglied nicht kennt, brechen
  die Replikation. Tor: `fsmVersion` der Zielversion darf höchstens +0
  Befehlsarten abweichen, sonst nicht `rollingSafe`. Prüfung im Test
  (FSM der alten Version spielt Log der neuen ab).
- Migrationen laufen beim Start des ersten aktualisierten Mitglieds; die
  Migrationssperre existiert bereits (prüfen: nicht geraten, vor Schritt 4
  im Code nachlesen).

### 11.5 Reihenfolge mit Hosts

Wie in §6 vorgesehen: erst Host-Agents (`distribute`, bestehend), dann
Orchestrator-Cluster. Im Rollout ein Schalter „Hosts zuerst verteilen“
(Standard an). Laufende Sendungen werden nie neu gestartet.

### 11.6 Oberfläche

Administration → System-Update → Paket: Karte „Cluster-Rollout“ mit Tabelle
Mitglied | Rolle | Version | Schritt | Zustand, Fortschrittsbalken,
„Abbrechen/Anhalten“, „Fortsetzen“. Zusätzlich „Cluster rollierend neu
starten“ (ohne Paket). Bestätigung durch Tippen der Zielversion wie bisher.
Texte über `t()` (de.ts + en.ts), Dialoge nie per JS-`confirm`.

### 11.7 Tests und Verifikation

- Unit: Zustandsautomat des Treibers mit Fake-Mitgliedern (Erfolg, Fehler im
  2. Mitglied, Leader-Wechsel mitten im Rollout, Fortsetzen, Quorum-Tor,
  Vorprüfung 2 Mitglieder).
- Cluster-Test in-process (`cluster_test.go`, 3 Knoten): `TransferLeadership`.
- FSM-Kompatibilität alt → neu (11.4).
- **Live:** 3 Orchestratoren lokal (andere Ports/Datenverzeichnisse, gemeinsame
  Test-Postgres, Fake-Supervisor-Skripte bzw. echter Supervisor je Instanz),
  zwei gestempelte Pakete, Rollout alt → neu; währenddessen ein Schleifen-
  Client auf `/api/v1/cluster/status` gegen alle Mitglieder (nie länger als
  Wahlzeit ohne Leader). Absichtlich kaputtes Paket → Halt am ersten
  Mitglied, Rest unberührt. `.60/.61` haben nur 2 Mitglieder: dort nur mit
  Zeuge oder `force`-Test. Wenig CPU: 3 Orchestratoren, keine Nodes.

### 11.8 Schritte (je Sitzung einer)

| # | Inhalt | Prüfkriterium |
|---|---|---|
| 84.1 | `Node.TransferLeadership` + Mitglieds-Zustand (Rolle/Lag/Quorum-Tor) | Cluster-Test 3 Knoten |
| 84.2 | Manifest `rollingSafe` + `update-bundle` + FSM-Kompatibilitätstest | Bundle-Test, Tests grün |
| 84.3 | Tabelle `cluster_rollouts` (Migration), Treiber-Zustandsautomat mit Fakes | Unit-Tests inkl. Leader-Wechsel |
| 84.4 | Interne Mitglieds-Route (HMAC + Term) + Paketverteilung an Mitglieder | Handler-Tests, Fremd-Token 401, alter Term abgewiesen |
| 84.5 | API + UI-Karte + i18n + Handbuch/HANDBUCH §9 | `deno check`, i18n-Test |
| 84.6 | Live-Lauf mit 3 lokalen Orchestratoren, Fehlerfall, Browser-Klicktest | siehe 11.7 |

### 11.9 Entscheidungen des Nutzers (2026-11-03)

1. **2 Mitglieder ohne Zeuge: blockieren.** Kein `force`; die Vorprüfung
   verweist auf Zeuge/dritten Orchestrator.
2. **Bei Fehler nur anhalten**, kein automatisches Zurückrollen bereits
   aktualisierter Mitglieder; manuell „Fortsetzen“ (das „bereits
   aktualisierte zurücksetzen“ aus 11.2 Punkt 5 entfällt).
3. **Paket ohne `rollingSafe` wird verweigert** (kein „alle gleichzeitig“).
