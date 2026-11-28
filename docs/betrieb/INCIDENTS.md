# Incident runbook

For operations: for each incident how to detect it, what to do first, how to recover and how to check. Everything stated
here comes from the project's code and documentation. Anything not backed by them is marked **open** — do not guess.
The procedures were **not** rehearsed as incidents for this document. German version: [`STOERUNGEN.md`](STOERUNGEN.md).

**Always start with:** `make status` (development / single machine), the **Alarms** tab, Administration → Diagnosis
(error codes: [`../FEHLERCODES.md`](../FEHLERCODES.md), German), if needed the support bundle
(`GET /api/v1/admin/support-bundle`, admin).

**Never as a remedy:** `make down` or `make stop ARGS=--all` on a machine holding data — in the development setup the
database is lost.

## 1. Database unreachable (OMP-1001)

- **Detect:** login, workflows and logs fail; `make status` shows the role of each Postgres node.
- **First:** leave running nodes alone — login, operation and node restarts need the database.
- **Recover:** check the Postgres/Patroni service; `patronictl list` shows the primary (only it accepts writes); check
  `OMP_POSTGRES_URL`; then restart the orchestrator.
- **Check:** `make status` names exactly one leader; login works.
- **Open:** forced switchover and rebuild of a Patroni cluster in production; loss of the etcd majority.

## 2. NATS unreachable (OMP-1002)

- **Detect:** telemetry, host commands and events stop; hosts appear offline.
- **Recover:** check the NATS containers/services and port 4222, `OMP_NATS_URL` and, with TLS, the certificates. The
  orchestrator reconnects by itself; restart nodes if needed.
- **Careful:** if a host counts as lost because of a NATS outage, roles are moved to other hosts (section 4).
- **Open:** rebuilding a JetStream cluster after losing the majority.

## 3. Orchestrator cluster without majority (OMP-1004)

- **Detect:** Administration → Cluster or `GET /api/v1/cluster/status`: `quorumLost` (no leader for 15 s).
- **First:** start the failed orchestrator again — that is the normal way.
- **Emergency exit** (only if the partner is **certainly** down, otherwise two leaders run side by side):
  Administration → Cluster, or `POST /api/v1/cluster/emergency-solo` with
  `{"confirmPartnerDown": true, "restart": true}`. Accepted only without majority (otherwise 409), takes effect at the
  restart. Withdraw before the restart: `DELETE /api/v1/cluster/emergency-solo`.
- **Afterwards:** if the Raft store was created anew, host agents reject commands as coming from an "earlier leader":
  start each agent **once** with `OMP_HOST_AGENT_RESET_TERM=1`, then without it.
- **Prevent:** at least three voting members (witness: `deploy/systemd/omp-raft-witness.service`).

## 4. Host failed (OMP-5001)

- **Detect:** alarm "host offline", red row under Hosts.
- **What happens by itself:** after 45 s without telemetry, roles without a standby move to another host
  (`OMP_HOST_FAILURE_RELOCATE=off` or `placement.onHostFailure` per role disables this). Standalone instances are moved
  as well — **check the instance list and the load afterwards**. Hardware-bound nodes do not move.
- **Instances "Stop pending":** the stop is carried out once the host reports again. If it never returns:
  **Remove entry** in the instance list (anything still running there stays unmanaged).
- **Host gone for good:** "Remove" under Hosts (only without current telemetry).

## 5. Host agent does not start or executes nothing (OMP-5003)

| Message/symptom | Cause and remedy |
|---|---|
| `state load failed` | State file damaged: remove it and register the host again (new bootstrap token: Hosts → add host). This creates a new host; remove the old entry. |
| `no command key — all commands are refused` | Host without a key: register again, or once with `OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1` (trusted network only, remove afterwards). |
| Commands fail with `unauthorized` | Wrong key: register again. After rebuilding the cluster see section 3 (`OMP_HOST_AGENT_RESET_TERM`). |
| Location "not released" | Set `OMP_FILE_ROOTS` or `OMP_MEDIA_MOUNTS` on the agent. |

Stopping or restarting the `omp-host-agent` service also ends the nodes it started.

## 6. Node hangs or crashes repeatedly (OMP-2001, OMP-2004, OMP-2009)

- **Detect:** alarm, status "crashed" and restart counter in the instance list, node diagnosis 🩺.
- **First:** a role with a standby is taken over by it; otherwise restart the instance in the list (interrupts its
  output).
- **Recover:** find the cause via error code and log; after a crash the saved state of a role may be "held" (OMP-2007) —
  apply or discard it deliberately.

## 7. Restoring a backup (OMP-7002)

- **When:** data loss or a faulty change. A restore **overwrites the whole database**.
- **UI:** Administration → Backup/Restore (needs the running supervisor).
- **Command line:** `make stop`, then `make restore ARGS=.backups/omp-<timestamp>.sql.gz`, confirm with `yes`,
  `make start`.
- **Not in the backup:** key material (update keys, mTLS CA) — back it up separately.
- **Data loss:** everything since the last backup (default every 24 h). **Open:** point-in-time recovery (no WAL
  archiving).

## 8. Changing keys

| Key | Procedure |
|---|---|
| Command key of a host | `POST /api/v1/admin/hosts/<id>/rotate-key`; host online and connected to NATS with TLS |
| Signing key of the login tokens | `POST /api/v1/admin/auth/rotate-signing-key` (admin). Issued tokens expire normally (up to 24 h), a second rotation ends the oldest ones at once. Suspected theft: body `{"dropPrevious":true}` — **everyone** has to log in again, service tokens of workflows become invalid (restart the workflows) |
| Root secret (derives node and cluster tokens) | **open** — not changed by the rotation; no procedure without restarting all nodes is documented |
| Signing key for updates | **open** |
