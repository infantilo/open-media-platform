# Störungshandbuch

Für den Betrieb: je Störfall Erkennen, Sofortmaßnahme, Wiederherstellen, Prüfen. Die Angaben stammen aus Code und
Doku des Projekts. Was dort nicht belegt ist, steht als **offen** da — hier nicht raten. Die Abläufe wurden für dieses
Dokument **nicht** als Störfall nachgestellt. Englische Fassung: [`INCIDENTS.md`](INCIDENTS.md).

**Zuerst immer:** `make status` (Entwicklungs-/Einzelrechner), Reiter **Alarme**, Administration → Diagnose
(Fehlercodes: [`../FEHLERCODES.md`](../FEHLERCODES.md)), bei Bedarf Support-Paket
(`GET /api/v1/admin/support-bundle`, Admin).

**Nie zur Fehlerbehebung:** `make down` oder `make stop ARGS=--all` auf einem Rechner mit Daten — in der
Entwicklungsumgebung geht dabei die Datenbank verloren.

## 1. Datenbank nicht erreichbar (OMP-1001)

- **Erkennen:** Anmeldung, Workflows und Protokolle gehen nicht; `make status` zeigt die Rolle je Postgres-Knoten.
- **Sofort:** Laufende Nodes nicht anfassen — Anmeldung und Bedienung brauchen die Datenbank, Neustarts von Nodes auch.
- **Wiederherstellen:** Postgres/Patroni-Dienst prüfen; `patronictl list` zeigt den Primary (nur er nimmt
  Schreibzugriffe an); `OMP_POSTGRES_URL` prüfen; danach den Orchestrator neu starten.
- **Prüfen:** `make status` nennt genau einen Leader; Anmeldung geht.
- **Offen:** erzwungene Umschaltung und Wiederaufbau eines Patroni-Verbunds in Produktion; Verlust der Mehrheit von etcd.

## 2. NATS nicht erreichbar (OMP-1002)

- **Erkennen:** Telemetrie, Host-Kommandos und Ereignisse bleiben aus; Hosts erscheinen offline.
- **Wiederherstellen:** NATS-Container/-Dienste und Port 4222 prüfen, `OMP_NATS_URL` und bei TLS die Zertifikate.
  Der Orchestrator verbindet sich selbst wieder; Nodes ggf. neu starten.
- **Achtung:** Gilt ein Host wegen eines NATS-Ausfalls als verloren, werden Rollen auf andere Hosts verlegt (Abschnitt 4).
- **Offen:** Wiederaufbau eines JetStream-Verbunds nach Verlust der Mehrheit.

## 3. Orchestrator-Cluster ohne Mehrheit (OMP-1004)

- **Erkennen:** Administration → Cluster bzw. `GET /api/v1/cluster/status`: `quorumLost` (seit 15 s kein Leader).
- **Sofort:** Den ausgefallenen Orchestrator wieder starten — das ist der Normalweg.
- **Notausgang** (nur wenn der Partner **sicher** aus ist, sonst laufen zwei Leader nebeneinander): Administration →
  Cluster, oder `POST /api/v1/cluster/emergency-solo` mit `{"confirmPartnerDown": true, "restart": true}`. Wird nur bei
  fehlender Mehrheit angenommen (sonst 409) und wirkt beim Neustart. Zurücknehmen vor dem Neustart:
  `DELETE /api/v1/cluster/emergency-solo`.
- **Danach:** Wurde der Raft-Speicher neu angelegt, weisen Host-Agents Kommandos als „früherer Leader“ ab: jeden Agent
  **einmal** mit `OMP_HOST_AGENT_RESET_TERM=1` starten, dann wieder ohne.
- **Vorbeugen:** mindestens drei stimmberechtigte Mitglieder (Zeuge: `deploy/systemd/omp-raft-witness.service`).

## 4. Host ausgefallen (OMP-5001)

- **Erkennen:** Alarm „Host offline“, rote Zeile unter Hosts.
- **Was von selbst geschieht:** Nach 45 s ohne Telemetrie ziehen Rollen ohne Standby auf einen anderen Host
  (`OMP_HOST_FAILURE_RELOCATE=off` bzw. `placement.onHostFailure` je Rolle schaltet das ab). Eigenständige Instanzen
  werden ebenfalls verlegt — **danach die Instanzliste und die Last prüfen**. Hardware-gebundene Nodes ziehen nicht um.
- **Instanzen „Stop vorgemerkt“:** Der Stop wird nachgeholt, sobald der Host wieder meldet. Kommt er nie zurück:
  **Eintrag entfernen** in der Instanzliste (läuft dort doch noch etwas, bleibt es unverwaltet).
- **Host endgültig weg:** unter Hosts „Entfernen“ (nur ohne laufende Telemetrie).

## 5. Host-Agent startet nicht oder führt nichts aus (OMP-5003)

| Meldung/Symptom | Ursache und Abhilfe |
|---|---|
| `state load failed` | Zustandsdatei defekt: entfernen und den Host neu registrieren (neues Bootstrap-Token: Hosts → Host hinzufügen). Es entsteht ein neuer Host; den alten Eintrag entfernen. |
| `no command key — all commands are refused` | Host ohne Schlüssel: neu registrieren, oder einmalig `OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1` (nur im vertrauenswürdigen Netz, danach entfernen). |
| Kommandos scheitern mit `unauthorized` | Falscher Schlüssel: neu registrieren. Nach Neuaufbau des Clusters siehe Abschnitt 3 (`OMP_HOST_AGENT_RESET_TERM`). |
| Ort „nicht freigegeben“ | `OMP_FILE_ROOTS` bzw. `OMP_MEDIA_MOUNTS` am Agent setzen. |

Beim Stoppen oder Neustarten des Dienstes `omp-host-agent` werden die von ihm gestarteten Nodes mit beendet.

## 6. Node hängt oder stürzt wiederholt ab (OMP-2001, OMP-2004, OMP-2009)

- **Erkennen:** Alarm, Status „Abgestürzt“ und Neustartzähler in der Instanzliste, Node-Diagnose 🩺.
- **Sofort:** Bei Rollen mit Standby übernimmt dieser; sonst Instanz in der Liste neu starten (unterbricht ihre Ausgabe).
- **Wiederherstellen:** Ursache über Fehlercode und Log; nach einem Absturz kann der gesicherte Stand einer Rolle
  „gehalten“ sein (OMP-2007) — bewusst einspielen oder verwerfen.

## 7. Datensicherung zurückspielen (OMP-7002)

- **Wann:** Datenverlust oder fehlerhafte Änderung. Ein Restore **überschreibt die gesamte Datenbank**.
- **Oberfläche:** Administration → Backup/Restore (braucht den laufenden Supervisor).
- **Kommandozeile:** `make stop`, dann `make restore ARGS=.backups/omp-<Zeitstempel>.sql.gz`, mit `yes` bestätigen,
  `make start`.
- **Nicht in der Sicherung:** Schlüsselmaterial (Update-Schlüssel, mTLS-CA) — getrennt sichern.
- **Datenverlust:** alles seit der letzten Sicherung (Standard alle 24 h). **Offen:** Wiederherstellung auf einen
  Zeitpunkt (keine WAL-Archivierung).

## 8. Schlüssel wechseln

| Schlüssel | Ablauf |
|---|---|
| Kommandoschlüssel eines Hosts | `POST /api/v1/admin/hosts/<id>/rotate-key`; Host online und über NATS mit TLS verbunden |
| Anmelde-Geheimnis (JWT) und daraus abgeleitetes Node-Token | **offen** — kein Ablauf ohne Abmeldung aller Nutzer dokumentiert |
| Signaturschlüssel für Updates | **offen** |
