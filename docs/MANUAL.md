# OMP Manual (Operations and Dev Setup)

> English version of [`HANDBUCH.md`](HANDBUCH.md) (the German original). The German text is authoritative when the two differ. Section numbers match.
> The user-facing guide is [`USER-MANUAL.md`](USER-MANUAL.md).

A short guide to running the orchestrator locally for development. Architectural
background is in `ARCHITECTURE.md`, the implementation plan in
`UMSETZUNG.md` — this document is only about "how do I start the thing".

## 1. Prerequisites and preflight check

> **Fresh install:** see `docs/INSTALLATION.md` (one-command installer `./install.sh`, port/firewall table, communication paths). This manual describes operation.

- **Go** (current version, see `docs/decisions.md` 2026-07-07)
- **Deno** (for the UI bundle, no Node/npm needed)
- **Podman** (rootless; starts NATS + NMOS registry + PostgreSQL as containers)
- Standard tools: `make`, `curl`, `openssl`, `git`
- Recommended: at least 2 GB RAM for the base system (8 GB or more for media nodes), 10 GB
  free disk space, Linux (x86_64 tested)

Only needed for the node-contract demo services (`omp-source`/`-viewer`/
`-switcher`, `nodes/`), **not** for the orchestrator
itself:
- **Rust/Cargo** (`make nodes` builds them; edition 2024, at least 1.85)
- **GStreamer** (development libraries + the plugin packages
  base/good/bad/ugly)
- **MXL library** (`deploy/dev/install-mxl.sh`, see its header comment)
  — without it the nodes still build (MXL is loaded at run time via
  `libloading`/`dlopen`), but they cannot be started
  (`libmxl.so … cannot open shared object file`).

### 1.1 Preflight: `make preflight`

Before the first installation (and for any problem), run

```sh
make preflight                                    # everything
make preflight PREFLIGHT_ARGS="--for=start"       # only what make start needs
make preflight PREFLIGHT_ARGS="--strict"          # treat warnings as errors
make preflight PREFLIGHT_ARGS="--json"            # machine-readable (one line per check)
```

(or `./deploy/dev/preflight.sh` directly) to see whether the machine has everything. Each
line is ✔ OK, `!` notice or ✘ error; below every problem is the **command to fix it**
for the detected distribution (apt, dnf, pacman, zypper). The script changes nothing
on the system and needs no `sudo`. It checks:

- **System:** Linux, architecture, memory, CPU cores, disk space.
- **Tools:** `make`, `curl`, `openssl`, `git`, Go (version against
  `go.mod`), Deno.
- **Containers:** Podman present and working (`podman info`),
  `subuid`/`subgid` for rootless, the required images (NATS, NMOS registry,
  etcd — derived from the Makefile) and the locally built Postgres image;
  if images are missing, it checks whether the registries are reachable (otherwise
  an error pointing to `podman save`/`load`).
- **Ports:** 8000, 8091, 8010/8011, 4222–4224, 8222, 5432/5442/5452, 8008,
  2379 — if a **foreign** process occupies one of these ports, its name
  is shown. Occupation by an already running OpenMediaPlatform stack is
  not an error.
- **Configuration:** write permission in `.run/` and `bin/`, storage key,
  signing key for the system update (notice, not an error).
- **Media nodes** (not with `--for=start`): Rust version, GStreamer
  development libraries, GStreamer core elements (mixer, multiviewer,
  MXF player …) and optional ones (WebRTC, x264, SRT, ST 2110, Matroska),
  built MXL library, `/dev/shm` size, ffmpeg/ffprobe.

Exit code 0 = no error, 1 = at least one error. `make start` automatically runs
the short form (`--for=start --quiet`) and aborts on
errors **before** the first step; with `OMP_SKIP_PREFLIGHT=1 make start`
the check can be skipped (it is off during the system update anyway).

## 2. Quick start

```sh
make start
```

In one step this:
1. Starts NATS + NMOS registry + PostgreSQL as Podman containers
   (`make up`, idempotent). The orchestrator applies its SQL
   migrations (`orchestrator/internal/db`) automatically at start —
   no manual schema step needed.
2. Builds the UI bundle (`make ui`).
3. Builds the orchestrator binary (`orchestrator/` → `bin/omp-orchestrator`).
4. Starts the orchestrator in the background and waits for `/healthz`.

Then open **http://localhost:8000** in the browser — that is the
Flow Editor shell.

```sh
make status   # short overview: are orchestrator/NATS/registry/Postgres running?
make stop     # stops only the orchestrator process (containers stay up)
make stop ARGS=--all   # additionally stops NATS + NMOS registry + Postgres
make down     # alternative: stop only the containers (make up reverses this)
```

Layouts (B5) and snapshots (B7) have lived in Postgres since D1 instead of as
files under `data/` — `data/` is now only used for the instance
launcher state (C8) and `role-bindings.json` (C13).

Orchestrator log: `.run/orchestrator.log` (not versioned).

### 2.1 Optional: simulate several hosts (dev)

By default only one host runs (this machine, invisible to the
GUI as long as no host agent is registered). Chapters 13/14/15
(host zones in the Flow Editor, placement, resource profiles — see `make
start` above, section 4) need at least two registered
hosts. Two simulated `omp-host-agent` processes on the same machine
are enough for that (`docs/decisions.md` 2026-08-13 ff., "Regie-Host-A"/
"Regie-Host-B"):

```sh
make hosts
```

Builds `bin/omp-host-agent` and starts both agents in the background
(`.run/host1/`, `.run/host2/` — logs, PID file, `state.json`). The
host identity (host ID + label) stays stable across restarts via `state.json`
— calling `make hosts` again registers the same two hosts again
(existing zone assignments/workflows stay linked), no new ones. Idempotent: an agent that is already running is
skipped. Both read the same catalog as the instance launcher
(`deploy/catalog.json` directly — an earlier copy to
`/tmp/host-catalog.json` shifted the base directory for relative
command paths and made every node start on a simulated host
fail, user finding 2026-09-10).

```sh
deploy/dev/stop-hosts.sh   # stops both again (state.json is kept)
```

`make stop ARGS=--all` stops them too. More about the
host view in the Flow Editor: section 4 below,
[`docs/USER-MANUAL.md`](USER-MANUAL.md) §2.5/§8.

### 2.2 Optional: mTLS orchestrator↔nodes (D3)

**Off** by default — the quick start above needs none of this, all
flows work unchanged over plain HTTP. To try
mTLS (`ARCHITECTURE.md` §4.6):

```sh
make mtls-up            # starts step-ca (own internal CA), separate from "make up"
make mtls-issue-certs    # issues dev certificates for orchestrator + mock node
OMP_MTLS_ENABLED=true ./deploy/dev/start-omp.sh
OMP_MTLS_ENABLED=true OMP_MTLS_CERT_FILE=.run/mtls/mock-node.crt \
  OMP_MTLS_KEY_FILE=.run/mtls/mock-node.key OMP_MTLS_CA_FILE=.run/mtls/root_ca.crt \
  nodes/mock/mock --label "Mock (mTLS)" --port 9001
```

A node with mTLS enabled registers with an `https://` href and
demands a valid client certificate from the same CA for **every**
access (even `curl` without a certificate is rejected) — the generic
orchestrator proxy works unchanged, because it automatically uses the
matching (mTLS-capable or plain) client for the respective
`http://`/`https://` node address; a mixed fleet of
mTLS and plain nodes works at the same time. Certificates are
valid for 23 h (step-ca default limit) — for a longer session run
`make mtls-issue-certs` again. Only `nodes/mock` (Go)
supports mTLS so far — the Rust `omp-node-sdk` nodes do not yet
(`docs/decisions.md` D3, remaining scope). `make mtls-down` stops
the CA container again (separate from `make down`).

## 3. Login

As long as no user exists, the GUI runs **without** login
(auth is disabled while `UserCount()==0`,
`ARCHITECTURE.md` §12) — **but only for requests from the machine itself**; from
another machine the initial setup needs `OMP_BOOTSTRAP_OPEN=1`
or `OMP_BOOTSTRAP_TOKEN` (section 5b, "first administrator"). In practice this
only matters on a completely fresh database; on this dev machine a user already
exists (see below). On a **fresh installation** none exists yet: create an admin in Administration right away.

**Current dev default user** (bootstrap admin with a wildcard
`admin` role, created when implementing chapter 11 part 1,
`docs/END-GOAL-FEATURES.md` §11, see the `UMSETZUNG.md` status checklist):

| User name | Password |
|---|---|
| `admin` | `adminpass123` |

Further users/role bindings are managed in the **Administration** tab in
the app bar (only visible to users with the `admin` verb, and in the
bootstrap case for the initial setup): create/delete users, reset passwords,
create/delete role bindings (user × node × right — `view` <
`operate` < `configure` < `admin`, `"*"` = all nodes), and view the audit log. The last remaining admin
cannot delete or demote themselves there (protection against
accidental lock-out).

**Passwords.** New and reset passwords need at least 10 characters
(`OMP_AUTH_MIN_PASSWORD`, not below 8), at most 72 bytes, must not consist of a single
character, contain the user name or be among the most common
passwords; the message states the reason. Existing passwords stay
valid (including the dev password above — change it for production).

**Windows Active Directory / LDAP (chapter 92).** With `OMP_LDAP_URL` set on the orchestrator,
directory users log in with their Windows name and password; OMP stores no password. **All settings
can be maintained in the UI** (Administration → Maintenance → Settings → "Active Directory" tab; the group mapping is under Administration → Groups:
saving takes effect immediately without a restart, "Test" checks the entered values beforehand, other orchestrators of the
cluster pick up changes within ~20 s; the service-account password is stored encrypted and needs
`OMP_STORAGE_SECRET_KEY`). As long as nothing is saved there, the environment variables apply. Sequence: search for the
user (service account) → bind with their DN and password → read groups (nested for AD, OID
1.2.840.113556.1.4.1941). The user is created at first login (marked "AD" in the user list),
their **directory groups** are mapped to **OMP groups** at **every** login (Administration →
Groups → "Active Directory / LDAP": directory group, name or DN, → OMP group). As before, rights are attached to
the OMP groups; only mapped groups are managed by the directory, memberships in other groups
maintained by hand stay. Settings (orchestrator environment):

| Variable | Meaning |
|---|---|
| `OMP_LDAP_URL` | `ldaps://dc1.company.example:636` (several separated by commas = failover order); empty = off |
| `OMP_LDAP_BASE_DN` | Search base, e.g. `DC=company,DC=example` (required) |
| `OMP_LDAP_BIND_DN`, `OMP_LDAP_BIND_PASSWORD` | Service account (read only) for the search |
| `OMP_LDAP_USER_FILTER` | Default: `(&(objectCategory=person)(objectClass=user)(\|(sAMAccountName={user})(userPrincipalName={user})))` — log in with `hans` or `hans@company.example` |
| `OMP_LDAP_USER_ATTR` | Attribute of the OMP name, default `sAMAccountName` |
| `OMP_LDAP_GROUP_BASE_DN`, `OMP_LDAP_GROUP_FILTER` | Group search; default `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))` (nested groups) |
| `OMP_LDAP_REQUIRED_GROUP` | Optional: only members of this group (name or DN) may log in |
| `OMP_LDAP_CA_FILE` | PEM of the company CA (empty = system certificates) |
| `OMP_LDAP_STARTTLS=1` | Switch to TLS for `ldap://` |
| `OMP_LDAP_ALLOW_PLAIN=1` | Allow plain text — **lab only**, passwords travel in the clear |
| `OMP_LDAP_TIMEOUT_S` | Time limit per request, default 8 |

Rules: **local accounts take precedence** and remain usable as emergency access (if the directory fails,
you can still get in with the local administrator). A directory name that equals a local account is
rejected. As long as there is **no** user yet (initial setup), directory login is off —
create the local administrator first. The password of a directory user cannot be
set in OMP. A user locked/deleted in the directory can no longer get in; sessions
already issued continue until they expire (then delete the user in the user list or use "Revoke sessions").
Group changes in the directory take effect from the **next login**. The login lock also protects against
trying passwords against the AD (otherwise the AD account would be locked). The "Test connection" check binds only the
service account.

**Login lock.** Failed attempts are counted three ways: per **name and
address** (5 in 15 minutes, then locked for 15 minutes), per **address** (30,
against trying many names) and per **name across all addresses**
(50, against distributed guessing). Whoever knows a user name therefore cannot lock the
real user out at their own address. Behind a
reverse proxy on the same machine the last
`X-Forwarded-For` entry counts as the address. The counters are in memory (a restart resets
them). If the login reports "too many failed login attempts", wait 15
minutes or log in from a different address.

**Tokens.** If a user is deleted, their login token becomes invalid immediately
(even if a user with the same name is created later);
"Log out everywhere" and password changes also revoke all tokens.

### 3.1 Rights model: four terms, four different questions

The Administration tab has four sub-views that may seem to overlap at first
glance — but they answer four different
questions and deliberately remain independent of one another:

| Term | Answers | Sub-view |
|---|---|---|
| **User** | Who can log in? | Users |
| **Organization** | Which workflows/assets does a user see at all (tenant/visibility boundary)? | Organizations |
| **Group** | A bundle of rights for several users at once (e.g. for a later AD connection that synchronizes group membership, not individual rights) | Groups |
| **Role binding** | The actual permission: subject (user **or** group) × scope (node/`"*"`/workflow role) × verb | Role bindings |

A role binding is therefore the only place where rights are actually
granted — both directly to a user and indirectly via
a group they belong to. Organization is completely
independent of it: it restricts what a user can see at all,
regardless of what their role bindings would allow.

**To find out what a particular user may do overall** (directly
assigned role bindings **plus** everything inherited via their group memberships), do not
jump back and forth between the sub-views and add it up in your head — instead click **"Rights"**
for that person in the **Users** tab: the panel lists
direct bindings and every group with its bindings in one place
(including a delete button if something should be removed there). Likewise
the **Groups** tab shows "Rights of this group" directly
under "Members" — that also saves the detour through
role bindings just to see what a group grants.

**Forgot the password, no second admin left?** There is no
CLI password reset — instead remove the users from the
database, which returns the system to the
bootstrap state (then create a new admin in the GUI):
```sh
podman exec -it omp-postgres psql -U omp -d omp \
  -c "DELETE FROM role_bindings; DELETE FROM users;"
```

**JWT secret in production deployments (S4, docs/REVIEW-2026-07-17-
SKALIERUNG-24-7.md):** without `OMP_AUTH_JWT_SECRET` set,
the orchestrator generates a secret itself on first start
(file `OMP_AUTH_JWT_SECRET_FILE`, default `../data/auth-jwt-secret`) and stores it
**in the database** (table `app_secrets`,
`internal/auth.LoadOrCreateSharedSecret`): an existing file secret is
adopted (existing logins stay valid), and **all
orchestrator instances of a cluster use the same secret** — a token
therefore also works after a leader change. Convenient for
local dev operation (no manual step needed), but for a
real deployment you **must** set `OMP_AUTH_JWT_SECRET_FILE` to
a durable, protected path (or feed
`OMP_AUTH_JWT_SECRET` directly from your own secret management):
if the auto-generated secret instead ends up on a transient volume (e.g. a container overlay without a volume),
all issued login tokens become invalid after every restart —
every logged-in user is logged out without being asked.

## 4. First steps in the GUI

- The Flow Editor initially shows an empty graph — no nodes registered
  yet.
- Through the catalog palette (left), the node types listed in `deploy/catalog.json`
  can be started from the GUI (instance launcher,
  `UMSETZUNG.md` C8) — provided they were built beforehand:
  ```sh
  make nodes   # builds nodes/target/debug/{omp-source,omp-switcher,omp-viewer}
  ```
- Started instances appear automatically as tiles (self-registration
  via NMOS, no manual entry).
- As soon as more than one host is registered through a host agent, the
  Flow Editor automatically shows host zones per machine (toggle
  "Host view" at the top right) — details with screenshots:
  [`docs/USER-MANUAL.md`](USER-MANUAL.md) §2.5/§8.

### 4.1 Add a real remote host (wizard)

Section 2.1 above simulates two hosts on the same dev machine.
For a real second machine (bare metal, VM, or an AWS EC2
instance), the bootstrap-token flow (`ARCHITECTURE.md` §18.3), previously reachable only via API,
can be operated through the GUI: Hosts tab → "+ Add new
host" (visible to admins only). The wizard creates the
token, delivers a ready provisioning script (shell one-liner
or EC2 user data, depending on the chosen target environment) and detects
the registration of the new `omp-host-agent` live. Details with screenshot:
[`docs/USER-MANUAL.md`](USER-MANUAL.md) §8.1.

**Secure command channel.** At registration the host receives its
own key (in its `state.json`, permissions 0600); all commands from the
orchestrator to this host are signed with it (section 5b). A
**first installation needs to do nothing for this**; the wizard flow stays
the same.

No prebuilt installation artifact for `omp-host-agent`
exists so far (no curl installer) — the generated script assumes
that the OMP repo is on the target host (`./install.sh --media`).
It builds the agent itself (`go build` runs **in** `host-agent/`,
result `bin/omp-host-agent`), loads `deploy/dev/mxl.env` and sets
`OMP_HOST_AGENT_CATALOG_PATH` to `deploy/catalog.json`. Without a catalog
the agent reports "unknown catalog type … on this host".

### 4.2 Set up an orchestrator cluster (wizard)

For the Raft redundancy of the orchestrator itself described in §19.3 (`ARCHITECTURE.md`):
Administration → Cluster (details with
screenshot: [`docs/USER-MANUAL.md`](USER-MANUAL.md) §7).
Shows status/members of the own instance and offers "+ Add another
orchestrator" — a form for node ID/Raft address/
HTTP address of the new instance generates the required start script live
(`OMP_NODE_ID`/`OMP_RAFT_LISTEN`/`OMP_RAFT_DATA_DIR`/
`OMP_CLUSTER_JOIN=true`), and a click on "Join now" then calls
`POST /api/v1/cluster/join`. For a local test run with
two real orchestrator processes on the same machine (instead of a
real second machine), a second `bin/omp-orchestrator`
call with its own `OMP_NODE_ID`/`OMP_RAFT_LISTEN`/`OMP_RAFT_DATA_DIR`/
`OMP_LISTEN`/`OMP_CLUSTER_JOIN=true` and the same `OMP_POSTGRES_URL`/
`OMP_NATS_URL` as the first instance (shared infrastructure) is enough —
leave the Postgres/NATS/registry addresses unchanged, only the
cluster-specific variables are unique per instance.

**Restart/reboot:** instances that were running when the orchestrator or the machine was shut down
(process nodes that had not crashed) are restarted under their old ID after startup:
local ones by the respective orchestrator itself (field `origin`, so two cluster orchestrators
do not take instances away from each other), instances on host agents by the cluster leader. The agent
idempotently reports back an instance that is still running; if a host is not yet reachable, the
leader retries for up to 10 minutes every 10 s. Podman instances are not restored automatically.

## 5. Backup & restore

The complete orchestrator state (users, role bindings, audit log,
layouts, snapshots, workflows, hosts) lives in Postgres (the `omp-postgres`
container).

**Backup and restore — both possible through the GUI** (user request
2026-08-13): Administration → Backup/Restore.

- "Create backup now" (`POST /api/v1/admin/backup`, admin right
  required) creates a backup exactly like `backup-omp.sh` (same
  `.backups/` folder, same rotation) and delivers it immediately as a
  download.
- Restore: choose a backup from the list, type the file name exactly to confirm,
  "Restore". A restore requires the orchestrator itself to be stopped — a running process
  cannot command itself to do that while it is answering the restore request.
  That is why, since the user decision of 2026-08-13, a standalone, permanently running **supervisor process**
  always runs alongside
  (`omp-supervisor`, `supervisor/main.go`, reachable only on `127.0.0.1`,
  started automatically by `make start`/`start-omp.sh`,
  survives a `make stop`/`make start` cycle of the orchestrator
  unchanged) — the orchestrator endpoint calls it internally, and it
  carries out the actual stop→restore→start cycle (using
  the same `stop-omp.sh`/`start-omp.sh` scripts as below, no
  separate reimplementation). Meanwhile the browser page reports
  "Server is restarting …" and reloads itself after about 5–10 s
  as soon as `/healthz` answers again.

Two scripts, `deploy/dev/backup-omp.sh`/`restore-omp.sh`
(or `make backup`/`make restore`), remain as a command-line
alternative, e.g. for a script-driven deployment without a
browser:

**Backup:**
```sh
make backup
# or directly:
./deploy/dev/backup-omp.sh
```
**Scheduled backup.** The orchestrator (as Raft leader) creates a backup itself every 24
hours when the newest one is older (`OMP_BACKUP_INTERVAL_HOURS`,
`0` turns it off; a failure is logged loudly and retried after an hour).
Not included are key material (update key, mTLS CA)
and any external target — back both up separately.

Writes `.backups/omp-<UTC-timestamp>.sql.gz` (`pg_dump --clean
--if-exists` via `podman exec`, no locally installed
`postgresql-client` package needed). Automatically keeps the last 14
backups; older ones are deleted after a successful new dump.
`.backups/` is deliberately not part of the Git repo
(`.gitignore`) — it contains password hashes and other sensitive data and
belongs on a separate, protected backup target (not rolled out from this
dev session).

**Restore:**
```sh
make stop                                    # the orchestrator must be stopped
make restore ARGS=.backups/omp-<timestamp>.sql.gz
```
Asks for interactive confirmation (type exactly `yes`) — the script
**overwrites the complete current content** of the database
`omp` with the state from the given file. Without an argument
`restore-omp.sh` lists the existing backups in `.backups/`.

**A restore that has never been run is no restore** — this
pair of scripts was actually played through once when introduced
(backup → test user created → restore → test user gone again,
documented in `docs/decisions.md`), not just read/written.

## 5a. Retention and automatic cleanup

Everything that grows over time is deleted automatically — at start and daily thereafter. The duration can be set per area with an orchestrator environment variable; `0` or less turns deletion off for the area.

| Area | Variable | Default |
|---|---|---|
| Central log (`logs`) | `OMP_LOG_RETENTION_HOURS` | 72 hours |
| Audit log and domain audit | `OMP_AUDIT_RETENTION_DAYS` | 90 days |
| Workflow runs (scheduler: planned vs. real) | `OMP_WORKFLOW_RUN_RETENTION_DAYS` | 30 days |
| Sent outbox events | `OMP_OUTBOX_RETENTION_DAYS` | 14 days |
| Used/expired one-time host tokens | `OMP_HOST_TOKEN_RETENTION_DAYS` | 7 days |
| Finished process executions (with steps, tasks and asset links) | `OMP_PROCESS_EXECUTION_RETENTION_DAYS` | 180 days |
| Acknowledged/masked alarms | fixed | 30 days or until expiry |

Not deleted automatically are user data and operating state: workflows, snapshots, layouts, assets, process definitions, hosts, catalog, consumption profiles and instances. Outbox events not yet sent and workflow runs still running are always kept. The NATS streams (domain events, logs) are limited by NATS itself through their maximum age.

## 5b. System update (browser upload)

New versions of the server can be installed without access to the machine:
Administration → **System update** (operation: `USER-MANUAL.md`
§7). This section describes setup, package building and operation; the
complete concept is in `docs/entwuerfe/ENTWURF-SYSTEM-UPDATE.md`.

**Building blocks.** The orchestrator receives the package and checks it;
it is applied by the standalone **supervisor** (the same process as
for restore, `deploy/dev/start-supervisor.sh`), which has to
stop and restart the orchestrator for that. Both check the package independently
of one another — the supervisor does not trust the orchestrator, which is about
to be replaced.

**Package format.** `omp-update-<version>.tar.gz` with `manifest.json`
(version, architecture, minimum version, migrations, components with
SHA-256 and target) and `manifest.sig` (Ed25519 signature over the
manifest). Any archive is rejected that contains symlinks, `..`/absolute
paths, files not listed in the manifest, a wrong checksum,
a wrong architecture or targets outside the allowed list:
`bin/omp-orchestrator`, `bin/omp-supervisor`, `bin/omp-host-agent`,
`ui/dist/…` and `node:<omp-name>` (which is mapped through the catalog to the real
path, only for nodes that are in the catalog).

**Setup (once).**
```sh
make update-keygen                                  # creates ~/.omp-update/update-signing.key (SECRET) and update-trusted.pub
cp ~/.omp-update/update-trusted.pub .run/update-trusted.pub   # trust anchor on the server
make stop && make start                             # orchestrator + supervisor load the new code
```
Do not put the private key on the server. Without `.run/update-trusted.pub`
the server rejects every package; `OMP_UPDATE_ALLOW_UNSIGNED=true` allows
unsigned packages and is intended for development only.

**Building a package.**
```sh
make update-bundle                    # builds binaries + UI and packs them signed into dist/
make update-bundle UPDATE_VERSION=2026.10.1 NODES_PROFILE=release
```
Included: orchestrator (with version stamp), supervisor, host agent,
UI bundle and all node programs referenced in the catalog from
`nodes/target/<NODES_PROFILE>`. Debug nodes add up to several GB;
use `NODES_PROFILE=release` for packages. The version must increase
numerically (default: date + time). Additional options (migrations,
minimum version, notice text) via `UPDATE_BUNDLE_ARGS` or directly with
`cd tools/update-bundle && go run . pack -h`; `go run . verify -pub <key> <package>`
checks a package on the command line.

**Cluster rolling update (chapter 84).** `go run . pack … -rolling-safe` sets
`rollingSafe: true` in the manifest; only such packages are accepted by the cluster rollout.
The flag is a promise by the package builder: (1) migrations purely additive
(expand/contract), the old program runs against the new schema; (2) no new
Raft FSM command type (`cluster.KnownCommandTypes`, the test `fsm_compat_test.go`
fails on every addition and forces the decision). Sequence and
decisions: `docs/entwuerfe/ENTWURF-SYSTEM-UPDATE.md` §11. Technique: rollout state in the
table `cluster_rollouts` (migration 0056), the driver `internal/clusterupdate`
runs only on the leader (`runWhileLeader`); members are addressed through internal
routes `/api/v1/internal/cluster-update/{info,fetch,apply}`
(authentication: HMAC `omp-cluster-update-v1` from the shared
JWT secret; `apply` carries the Raft term, a deposed leader is rejected with
409). The member checks the package with its **own**
trust anchor. For this the supervisor offers `POST /restart` (restart without a
package). Followers announce their HTTP address to the leader themselves (`…/internal/cluster-update/announce`, HMAC); this also makes a cluster founded via `OMP_CLUSTER_PEERS` addressable without `Join`. "Host agents first" (§11.5) is the pseudo step `@hosts` before all members. API: `GET/POST /api/v1/admin/cluster-rollout`, `…/resume`, `…/cancel`.

**Sequence when installing.**
1. Backup (mandatory if the package contains database migrations).
2. All files are staged next to their targets and checked —
   still without any outage.
3. Stop the orchestrator (`stop-omp.sh`), swap the files atomically (the
   predecessors are in `.updates/rollback/<timestamp>/`, the last
   three are kept), start the orchestrator (`start-omp.sh` with
   `OMP_SKIP_BUILD=1`, so **nothing is built from source**).
4. Check: `/healthz` and `GET /api/v1/version` must report the new version
   (time limit 90 s).
5. On errors, **automatic rollback** and restart of the old state;
   the reason is in the history. If the update contained database migrations
   that were already applied, the message explicitly points out
   that the schema may be newer than the old program — then restore the
   backup through Backup/Restore (an automatic database
   restore deliberately does not happen).
6. If the supervisor itself is part of the package, it replaces itself last via
   `exec` (same PID). If the `exec` itself fails, the old
   supervisor keeps running; if the new program crashes only after starting,
   it must be restarted with `deploy/dev/start-supervisor.sh`.

**Nodes and host agents.** Running processes keep their old program
(Linux holds on to the old file) and stay in operation; they count as
**"outdated"** until restarted — detection: the program is
newer than the process start. "Restart outdated instances now"
(`POST /api/v1/admin/updates/restart-outdated`) restarts workflow roles
via RestartRole and standalone instances by stop + start.
"Distribute to remote hosts" (`POST /api/v1/admin/updates/{id}/distribute`)
sends an `update` command to every reachable host agent; the agent
fetches the package from its own orchestrator with a one-time token, checks it
with **its** trust anchor (`OMP_UPDATE_PUBKEY_FILE` on the host,
set in `start-hosts.sh` for the simulated hosts) and replaces agent
and node programs of its local catalog. A new host agent only becomes active
after its restart, because a restart would orphan its managed
child processes.

**Important environment variables.** `OMP_UPDATE_DIR` (storage of the packages,
rollback copies and history, default `.updates/`),
`OMP_UPDATE_PUBKEY_FILE` (default `.run/update-trusted.pub`),
`OMP_UPDATE_ALLOW_UNSIGNED`, `OMP_SKIP_BUILD` (skips the source build in
`start-omp.sh`/`start-supervisor.sh`/`start-hosts.sh`).

**Signed host commands.** The orchestrator signs every command to a host agent (HMAC, key per host). New hosts receive the key at registration, older ones get it automatically as soon as they are online; afterwards the agent rejects unsigned, expired or repeated commands. `OMP_HOST_AGENT_REQUIRE_KEY=1` on the agent refuses commands even before the key handover. If an agent has a wrong key (commands fail with "unauthorized"), remove `cmdKey` from its `state.json` and restart the agent. To rotate a host's key: `POST /api/v1/admin/hosts/<id>/rotate-key` (the host must be online). The token secret for logins lives in the database (`app_secrets`) and is adopted at first start from `OMP_AUTH_JWT_SECRET_FILE` — all orchestrator instances of a cluster use the same one. `OMP_METRICS_TOKEN` protects `/metrics` with a bearer token.

**Container images and their digests.** All images are listed with tag **and** digest in `deploy/images.env`
(`repo:tag@sha256:…`) — a moving tag therefore cannot silently deliver a different image. To refresh:
`./deploy/dev/update-image-pins.sh` (resolves the tags anew and enters the digests into `images.env`, quadlets,
CI and the Patroni Dockerfile), to only check: `make image-pins-check`. For a new version: first change the tag in
`images.env`, then run the script. For **offline installations** (images via `podman load`)
the installer creates `.run/images-unpinned`; then only the tag applies.

**First administrator (bootstrap mode).** As long as no user exists, the
API is open so that the first administrator can be created — but only
for requests from the machine itself (loopback, without proxy headers). From
another machine: set `OMP_BOOTSTRAP_OPEN=1` (only for the initial setup,
remove it afterwards) or set `OMP_BOOTSTRAP_TOKEN=<secret>` and send the call
with the header `X-Bootstrap-Token: <secret>`. Behind a reverse proxy
on the same machine the request counts as remote.

**Development operation.** A later `make start` builds from source again
(version "dev") and thereby overwrites an installed
state. The update path is intended for installations with ready-made binaries;
in development operation `git pull` + `make start` remains the
normal way.

**Not included yet.** A rolling update of several orchestrator
members (cluster) and an automatic restart of host agents/nodes
after the update.

## 6. Remote access / reverse proxy (S7)

The orchestrator itself only speaks plain HTTP (`http://localhost:8000`)
— that is correct for local dev operation, but **not** secure
enough for access from outside this machine: login runs
through a bearer token (`Authorization: Bearer …`), and the node UI bundle
and SSE reconnects additionally accept the token as a
`?access_token=` query parameter (handy for `<img src>`/
`EventSource`, which cannot set their own header) — **both
only make sense with HTTPS**, otherwise the token travels in clear text on the
wire or is visible in every proxy/server log that records the URL.

**Solution: TLS termination by an upstream reverse proxy**
(`deploy/dev/Caddyfile`), the orchestrator stays plain text behind it
unchanged — the same separation as with the optional mTLS
orchestrator↔nodes (section 2.1): TLS handling is the job of the
infrastructure, not of the Go code.

```sh
make proxy-up     # starts Caddy (Podman container) on https://localhost:8443
make proxy-down   # stops it again
```

`tls internal` makes Caddy automatically create its own
local CA on first start and issue a certificate from it — no
manual certificate step needed. The browser still shows a
security warning because it does not know Caddy's local CA (can be
ignored/accepted for a dev test; Caddy can also export the CA
so it can be imported into the system trust store, see the
[Caddy docs](https://caddyserver.com/docs/automatic-https#local-https)
— deliberately not automated here, it is operating-system specific).
`.run/caddy` persists this CA across `make proxy-down`/`proxy-up`
so the browser does not have to accept it anew after every restart.

**Real remote access over the internet** (not just `localhost`):
replace `:8443` in the Caddyfile with your own domain (e.g.
`omp.example.org`) — Caddy then automatically obtains a real
Let's Encrypt certificate, no `tls internal` needed any more, no
further configuration. For that the host must be reachable from outside on port 443
(firewall/router forwarding), which is outside the
scope of this manual.

**`X-Forwarded-*` compatibility checked, no code contribution needed:**
the orchestrator nowhere reads `r.Host`/`r.TLS` or sets
cookies/CORS headers (code searched, `docs/decisions.md` 2026-07-18)
— the whole auth runs through the self-contained bearer token, which
stays valid regardless of the scheme/host used. A reverse proxy
in front therefore changes nothing about the orchestrator's behavior, regardless of
whether/how it sets `X-Forwarded-*` headers.

## 7. Metrics & soak test (S8)

`GET /metrics` delivers metrics in Prometheus text format — Go runtime
(goroutines, heap, GC), registry (nodes online/total, poll duration),
SSE (clients, lost events), launcher (instances, automatic
restarts) and HTTP requests by status class. Handwritten, no
`prometheus/client_golang` (minimal-dependency rule) — unauthenticated by default
like `/healthz` (network isolation is the expected
protection here). With `OMP_METRICS_TOKEN=<secret>`, `/metrics` instead requires
`Authorization: Bearer <secret>` (in Prometheus: `authorization:
credentials: <secret>`).

```sh
curl http://localhost:8000/metrics
```

SSE metrics in detail: `omp_sse_clients` (all open event streams,
including the orchestrator's internal subscribers such as alarm mail and timeline),
`omp_sse_clients_identified` (only browsers with a known user),
`omp_sse_clients_by_user{user="…"}` (per user),
`omp_sse_clients_with_midi` / `omp_sse_clients_with_streamdeck` (browsers reporting a
MIDI controller or Stream Deck, including simulators),
`omp_sse_client_kicks_total` (clients disconnected by an admin since process start)
and `omp_sse_dropped_events_total`. Who is connected is shown by Administration →
Connected clients; via API `GET /api/v1/admin/clients` (list with `id`,
`user`, `remoteIp`, `userAgent`, `since`, `devices`) and `POST
/api/v1/admin/clients/{id}/disconnect` (body `{"endSessions":true}` additionally ends
all logins of the user; without it the browser reconnects
by itself), both for admins only. The devices (`devices.midi`, `devices.streamDeck`)
are reported by the browser itself via `PUT /api/v1/clients/devices` (body `cid`, `midi`,
`streamDeck`; it appends the identifier `cid` as `?cid=` to the event stream); the
server assigns them only to connections of the same user.

**Soak test:**

```sh
make soak                        # 1 h, one sample every 60 s (S8 default)
make soak ARGS="1800 30"         # 30 min, every 30 s (seconds: duration interval)
```

Starts the stack (if not already started) + 2 test nodes
(`omp-source`, pure base load, no wiring needed) and writes
`/metrics` every N seconds as a line into
`.run/soak/soak-<UTC-timestamp>.csv` (not part of the Git repo,
`.gitignore`). Ctrl+C aborts early, the CSV collected up to then
stays valid; test nodes are stopped again automatically on exit (also after Ctrl+C).

**Soak analysis (stop criterion, S8):** no automatic trend test
in the script — a human evaluates the resulting CSV. If
`heap_alloc_bytes` or `goroutines` rise monotonically over the **whole** runtime
without a recognizable plateau/sawtooth pattern (normal GC cycles cause
regular ups and downs), that is a leak finding. A single short smoke run (2.5 min, 5 samples,
`docs/decisions.md` 2026-07-18) showed the expected healthy pattern
(goroutines/heap fluctuating, no trend) — the actual 1-hour verification without
a monotonic rise required in the review is still open (documented follow-up work,
exceeds a single session).

## 8. Troubleshooting

**For any problem run `make preflight` first** (section 1.1): it checks tools,
Podman, images, ports and permissions and names the command to fix them.

**Login form appears but no credentials are known** — see
section 3 above (default user `admin`/`adminpass123`, or the
password reset procedure if this user has since been changed or
deleted).

**Hosts table shows "⏱ Clock"** — the host's system clock is not synchronized
(NTP/PTP) and/or the TAI offset is not set (`CLOCK_TAI` then equals UTC,
currently 37 s off). MXL timestamps and switch times (`takeAt`) then do not match
other hosts. Remedy: chrony with `leapsectz right/UTC` (sets the
TAI offset) or `ptp4l`/`phc2sys`; check with `timedatectl` and `chronyc tracking`.
The notice only appears for host agents that report the clock.

**Commands to a host fail with "unauthorized: …"** — the host agent
checks the signature of commands (section 5b). "command is not signed":
the command does not come from the orchestrator (or the orchestrator has not yet delivered a key for
this host — it does that automatically as soon as
the host is online, after about 20 seconds at the latest). "signature invalid":
orchestrator and agent have different keys (e.g. because the
database was set up anew). Remedy: remove `cmdKey` from the agent's
`state.json`, restart the agent — the orchestrator delivers
the key anew. To rotate on schedule: `POST
/api/v1/admin/hosts/<id>/rotate-key`.

**Initial creation of the administrator from another machine fails (401)** —
on a fresh installation the API is open only locally. Either work via
`localhost`/SSH tunnel or set `OMP_BOOTSTRAP_OPEN=1` (remove it again after the
initial setup), see section 5b.

**"A process that is not known through start-omp.sh/PID file is already answering on port 8000"** — an orphaned process (e.g. from
a session started manually in a terminal) blocks the port:
```sh
ss -ltnp | grep 8000     # shows the PID of the process
kill <PID>                # or kill -9 if it does not react
```

**`registry poll failed: connection refused` shortly after start** — harmless:
the orchestrator polls the NMOS registry every 2 s; immediately after `make up`
the registry container needs a few hundred ms to come up. Goes away
by itself; if not, check `podman logs omp-nmos-registry`.

**`make check` fails at `cargo test -p omp-mediaio`
(`libmxl.so … cannot open shared object file`)** — expected as long as
`deploy/dev/install-mxl.sh` has not been run (see prerequisites above).
Affects only the MXL nodes, not the orchestrator/UI.

**Tally in the Flow Editor stays off, audio-follows-video (AFV) does not switch
along, "tally publish … timed out" appears in the orchestrator log** — the nodes
cannot reach NATS. Common cause: the path variables
`OMP_NATS_TLS_*` are set (`start-omp.sh` exports default paths
under `.run/mtls`), but the NATS cluster runs in plain text. The
node SDK only uses TLS to NATS if additionally
`OMP_NATS_TLS_ENABLED=true` is set (default: plain text). To check: the
NATS monitoring ports (`curl localhost:8222/connz`) must show the
nodes' `omp-node-sdk` connections.

**System update is rejected** — "Signature invalid" means: the
key of the package is not in `.run/update-trusted.pub` (or the file does not
exist); "Architecture" means: the package was built for a different
platform; "Minimum version" requires an intermediate update first.
If applying fails, the reason together with the automatic rollback is in the
System update tab under "History" and in `.run/supervisor.log`.

**Rootless Podman does not start** — see `deploy/quadlets/README.md` or
`docs/decisions.md` (2026-07-07, toolchain installation) for the configuration
verified on this dev machine.

## 9. Microservices at a glance

Every microservice is a standalone process (a member of the `nodes/` workspace)
that registers itself with the orchestrator via NMOS IS-04 and describes its
parameters/methods itself through the node contract (§5, `ARCHITECTURE.md`)
— the orchestrator has none of the following types hard-wired, the list below only describes what
actually exists today and can be started through the instance launcher (`deploy/catalog.json`).

### 9.1 Media-producing/-processing nodes

| Node | Function |
|---|---|
| **omp-source** | Produces a selectable GStreamer test picture (color bars etc.) plus a test tone as an MXL flow. A pure test source, no real camera/file connection. `OMP_AUDIO_CHANNELS` (1…64) sets the channel count; with more than 2 channels every channel gets its own tone (channel k = 220·k Hz) — a test source for multichannel sound and the audio splitter. |
| **omp-hls-source** | HLS input: fetches an HTTP Live Streaming stream (`.m3u8`, http/https) and writes video and sound as MXL flows; reconnects by itself on errors. See USER-MANUAL 10c-2b. |
| **omp-mxl-bridge** | MXL domain bridge: copies a flow (video or audio) from one MXL domain into another **without conversion** (same format; conversion optionally via `OMP_BRIDGE_CONVERT`). Blocking read, waits via inotify for sources that appear later. Best practice: section 9.3a. |
| **omp-avdelay** | A real A/V delay for picture and sound (MXL → MXL, same domain): picture by whole frames (`delay.videoFrames`, limit `OMP_AVDELAY_MAX_VIDEO_FRAMES`, default 25), sound sample-accurately (`delay.audioMs`, slews without a jump with `delay.slewPermille`); everything adjustable at runtime. Changes only time, never the format (direct copy, almost no CPU; a source that does not match is rejected, a source flow that appears later is detected via inotify). Display: `delay.videoMs`, `delay.audioCurrentMs`, `delay.offsetMs` (sound minus picture, positive = sound later). Usable as the "A/V delay" function in the MCR (section 10k, "Replaceable functions"). |
| **omp-audio-split** | Audio splitter: splits a multichannel audio flow (e.g. 16 tracks, `audio/float32`, 48 kHz) into separate output flows, such as 1/2 stereo programme, 3/4 international sound, 9 commentary, so that e.g. the audio mixer can take each output individually via IS-05. One sender per output (label = output name). A pure channel copier: bit-exact, the sample index is kept, data channels (non-PCM) pass through unchanged, a source channel may appear in several outputs. Outputs at start via `OMP_SPLIT_OUTPUTS` (JSON `[{"name":"Programme","channels":[1,2]},…]`, without it every two channels form one output from `OMP_SPLIT_INPUT_CHANNELS`, default 16); `split.outputs` re-assigns channels at runtime (names and channel counts stay). Display: `inputChannels`, `mode`, `flowing`, `outputFlowIds`. In the MCR as the "audio splitter" function per line. |
| **omp-audio-matrix** | Audio matrix: crosspoint matrix with freely configurable inputs and outputs that can be changed at runtime (`audio/float32`, 48 kHz). Every input is a receiver with channel labels, every output its own sender/flow (mono up to 64 channels) with a name and channel labels (IS-04 source `channels[]`: `label`, `symbol` per VSF TR-03 appendix A). Crosspoints assign input channels to output channels: a crosspoint without gain is a **bit-exact copy** (hardly any CPU, sample index kept), several sources or a gain (−120…+24 dB) are **summed** (only that channel computes; no silent limiting, overload is counted in `overs`). Splitter (1 → n) and combiner (n sources → e.g. one 16-channel flow) are special cases. Limits: 16 inputs, 32 outputs, 64 channels, 16 sources per channel. Configuration as JSON in parameter `matrix.config` (start: `OMP_MATRIX_CONFIG`; checked before applying, errors in `matrix.error`), read: `matrix.status` (inputs with signal indicator, outputs with sender/flow ID, `overs`). Routing, gain, labels and names take effect without interruption; if the channel count of an output changes, a **new flow** (same sender ID) is created and the orchestrator reactivates connected receivers itself (`graph.Service.Rewire`). State via `GET/POST /state` (configuration plus receiver/sender IDs: connections survive stop/start). Alarm `matrix-input-silent` if a connected input delivers no signal for 6 s. Panel with the crosspoint matrix in the node window. In the MCR as the “audio matrix” function per line (`normalize.audioMatrix`). |
| **omp-contribution** | Contribution input (chapter 106.6, catalog `omp-contribution-in`): `srtsrc` (SRT Internet-Draft draft-sharabayko-srt-01; caller/listener/rendezvous) → `tsdemux` → `decodebin` per stream → MXL flows in the **native** format. The output is built at the first decoded picture (two pipelines, pattern `omp-srt-gateway/autobridge`), rebuilt with the same flow IDs on a raster change. Sound: up to 8 PIDs (`contrib.audioPids` or PID order), each stereo at 48 kHz, one audio flow with the sum of the channels (2 PIDs = 4 channels). Writable parameters `contrib.uri`, `contrib.mode`, `contrib.latencyMs`, `contrib.streamId`, `contrib.audioPids` (a change = rebuild); readable `contrib.state` (connecting/playing/reconnecting/error), `rttMs`, `lossPermille`, `retransmits`, `bitrateKbps`, `inputFormat`, `audioChannels`, `lastError`. RIST (`rist://host:port[,host:port…]`, Simple Profile TR-06-1 via `ristsrc`, bonding `bonding-addresses`) and relay of the original TS (`contrib.relayUri`, `contrib.relayMode`, byte-identical) are implemented; recording only as the decoded MXL flow via the ingest. **Return feed** (`OMP_CONTRIB_DIRECTION=out`, catalog `omp-contribution-out`, chapter 106.11): IS-05 receivers sound + picture (MXL) → AAC / optionally H.264 → `mpegtsmux` → `tsparse alignment=7` → SRT or RIST; parameters `contrib.uri/mode/latencyMs/streamId/audioBitrateKbps/videoEnabled/videoBitrateKbps`, end-to-end latency locally ≈ 457 ms (with 200 ms SRT latency). The input accepts streams without picture (audio flow only). Passphrase only from `OMP_CONTRIB_PASSPHRASE_FILE` (permissions 0600, 10–79 characters), never in an address, parameter or log (an address with `passphrase=` is rejected). Environment: `OMP_CONTRIB_URI`, `_MODE`, `_LATENCY_MS`, `_STREAMID`, `_AUDIO_PIDS`, `OMP_WIDTH/HEIGHT/FRAMERATE_*` and `OMP_CONTRIB_AUDIO_CHANNELS` only as an **NMOS declaration** before the first picture. |
| **omp-normalizer** | Master-control-room normalizer (chapter 106): compares the `flow_def` of each branch with the house format (`normalize.houseFormat`, JSON, changeable at runtime, video/sound separate) and, on a match, copies **bit-exact with the grain index preserved** (`rawcopy`); only on a deviation does the conversion chain run (size, rate, resolve/create fields via `deinterlace`/`interlace` in 8-bit 4:2:2, color matrix via `videoconvert` with `colorimetry` set, sound via `audiomixmatrix`/`audioresample`; assignment `normalize.audioMap`). The output marking (color space/transfer) follows the house format via `colorimetry::set_process_override`. `normalize.mode`: `auto` or `copyOnly` (deviation = alarm, no conversion). Both values are writable parameters and survive stop/start. Known limit: if downstream nodes keep the output flow open, a changed house format cannot replace the flow (state `error`, hint: disconnect consumers and reconnect). Transfer function (SDR/HLG/PQ): `normalize.transferPolicy` (`house`/`warn`/`block`/`map`), `map` via the replaceable stage `normalize.mapBackend` (`builtin` = fixed minimal curve on Y without a quality promise, otherwise an external process under contract v1, `docs/entwuerfe/ENTWURF-MCR.md` §6). A/V measurement: method `avsync.measure(seconds)` measures at the input with a marker test signal (blip/flash, library `omp_mediaio::avmarker`), result `avsync.measuredMs` in standard convention (positive = sound leads the picture), `avsync.confidence`, `avsync.method` (`marker`/`none`; without a marker no measured value). A/V compensation (copy path only): `avsync.mode` (`off`/`manual`/`once`, default `once`; `tracking` is reserved and rejected), `avsync.manualMs`, `avsync.heldMs`, `avsync.deadbandMs`, `avsync.maxSlewPermille`, `avsync.freeze`; methods `avsync.apply` (take over and hold the last measured value) and `avsync.reset`. Sound early → sound is delayed (sample-accurate, offset bit-exactly); sound late → picture by whole frames (local ring), remainder in the sound. Changes in operation slew without a jump. Design: `ARCHITECTURE.md` §33. Data track (ANC, timecode, subtitles): a third receiver "Data" passes a data flow unchanged and with the same grain index into the own data output (`normalize.dataState`, `normalize.dataFlowing` — only fresh data, i.e. a grain within the last 3 s, counts as flowing). |
| **omp-switcher** | A simple video switcher between automatically discovered MXL sources by button. The sources appear as a menu: first workflows/groups, in them subgroups and sources (back button, breadcrumb); "Own group only" restricts to the group/workflow of the switcher including subgroups. Inactive inputs are read only throttled (low CPU load). No program/preset bus, no mix effect (functional predecessor of the Video Mixer M/E). |
| **omp-video-mixer-me** | A full M/E picture mixer with an adjustable number of mixer levels (1–8, node option `OMP_ME_LEVELS` or the "Mixer levels" field of the role in the workflow editor, default 1; every level with its own program/preset bus and its own MXL/NMOS output, shared source pool, the PGM outputs of the other levels are available as sources): program/preset bus (crosspoint matrix), cut/auto transition, several PIP slots per level (scenes, z-order, rotation/keystone in the 2D slots, click focus in the PGM monitor; options `OMP_PIP_SLOTS`, `OMP_PIP_2D_SLOTS`, `OMP_ME_PGM_MONITOR`), downstream keyer (DSK, fill+key), tally signaling. Supports `setOutputDelay()` since D8 part 3 (latency-budget compensation, see section 9.7). |
| **omp-audio-mixer** | A digital audio console with a dynamic channel count, gain/EQ (LO/MID/HIGH) and compressor per channel, master limiter, automatic audio-follows-video (choice of picture mixers/tally givers globally and per video source, `setTallyFilter`; `setVideoContext` optionally takes `giver`), global "Scenes & automation" dialog. Two surfaces (classic and the dense "Console 2" with EQ graph, dynamics, routing and compact mode), switchable in the header. |
| **omp-mxf-player** | MXF file/playlist player, operated by cue/take (A/B slot), with program-group audio shuffle. Can additionally play a discovered live MXL source as a playlist item. Program groups and shuffle presets come from the shared audio document (Administration → Audio output, see user manual 10c); the former separate editor in the Flow Editor is gone. Reads MXF audio labels per SMPTE ST 377-4/-41 (MCA): channel language, content and class are adopted as tags into the audio rules (taking precedence over the track scheme) and shown in the panel. |
| **omp-mxf-player-direct** | Diagnostic/direct variant of omp-mxf-player: no A/B slot cue/take, no playlist — automatically plays exactly one file directly into the MXL outputs at start. Output groups and shuffle presets come from the shared audio document (Administration → Audio output); "Reload settings" in the panel applies changes live. The former local editor with its own state file is gone. |
| **omp-channel-player** | An Isel-free, single-branch player without playlist/cue-take — `load()` replaces the current content immediately. Intended as one of two physical sources at the video mixer crosspoint for a real crossfade. Audio: one sender per target group of the output profile (default: program sound, audio description/AD, original sound, Dolby E, 5.1), assignment per event via `audioMapping`, substitution rules for missing tracks (see `docs/funktionen/PLAYOUT-AUTOMATION.md` §7a). |
| **omp-multiviewer** | Automatically shows discovered MXL video sources as a tile grid. When it runs as a role of a workflow, it shows **only the sources of that workflow** (node tag `urn:x-omp:workflow`); started manually it shows all. Pure monitoring, no program signal that can be chained further. |
| **omp-viewer** | Shows a selected MXL video stream as an MJPEG preview in the browser. |
| **omp-playout-automation** | Automated playlist sequencing: remote-controls two omp-channel-player channels (A/B) and a picture mixer (auto/hold mode, Next/Next-Live/Stop, cart/interrupt assets), a real crossfade between the two channels. No media pipeline of its own. |
| **omp-scte35** | Produces SCTE-35 markers (`splice_insert` out/in/cancel, `time_signal` with a segmentation descriptor) and SCTE-104 messages for ad breaks, with lead time and frame-accurate. Output: history/parameters, UDP, sidecar transport stream (UDP/SRT, selectable PID) and **SCTE 104 as ANC** (`video/smpte291`, DID 0x41/SDID 0x07) in an MXL data flow that appears as an NMOS sender. The playout automation controls it and can mark ad breaks **automatically from the event classification** (switch "Mark ad breaks automatically" in the automation panel). Settings: node options (Admin → Settings), details in `docs/funktionen/PLAYOUT-AUTOMATION.md`. |
| **omp-ograf** | Renders EBU OGraf graphics templates (lower third, ticker etc.) as a fill+key MXL output for the picture mixer DSK. Several graphics can be on air at the same time: the "On air" list in the panel shows them, a click opens the graphic in the editor (update live, off), "Next" only appears for multi-step templates. **Template library** (button "Edit templates…" in the panel): list with search, new/duplicate/change ID/delete, import and export as ZIP (import also as a JSON package), tabs General (manifest), Parameters (schema as a field list) and Source (all files, uploading images and fonts). Validation follows the official OGraf v1 schema; edited templates reload at the next fade-in. **Layout coupling:** elements with `data-ograf-zone="<id>"` are measured live (property `zones`); `layout.bind` lets a zone lead a PIP slot of the picture mixer (`kind` empty, source sender ID or `pst:N`) or set the window of the paternoster transition (`kind: window`, template `paternoster-frame`); the panel has the section **Layout coupling (picture mixer)** for this: per reported zone choose kind, mixer, source and PIP slot, "Couple"/"Release", display of the state and the lag. Bindings survive a restart of the node (workflow backup `/state`). The binding optionally carries `templateId` (`layout.bind`/`layout.unbind`): it then only applies while the layer shows this template (otherwise it rests, `active: false` in `layout`); empty = any template of the layer (legacy). Templates name their windows in the manifest in the vendor field `v_omp_zones` (`[{id, name, slot?}]`; OGraf v1 allows extra fields only with the prefix `v_`), the node delivers them as `zones` per template in the `templates` parameter. The bundled PIP wall has the option `focusCover` (default on): the enlarged window hides frame and caption of the others, also on the way back. Bundled templates are replaced in `data/ograf-templates/` at start if the installed `version` is lower than that of the program. **Actions:** method `action {layerId, id}` triggers a `customAction` of the graphic that is up (panel button per action of the template). |
| **omp-audio-player** (radio) | Plays audio files (WAV, FLAC, MP3, AAC, Ogg …) or live sound as a pure audio sender: one MXL audio output per target group, **no picture sender** and no timecode output, `media_ready` reports only the sound. Technically the channel player with `OMP_AUDIO_ONLY=1`; in audio workflows (only audio types and recorders) the warning about the missing picture output anchor is omitted. Planning of further radio building blocks: `docs/entwuerfe/RADIO-PLAN.md`. |
| **omp-audio-delay** (radio) | Broadcast delay for the stereo programme sound: holds `delayMs` (default 8 s), output on its own clock (never breaks off). **Dump** (`dump{ms}`) discards the oldest seconds (jump forward, 5 ms crossfade); afterwards the node rebuilds the delay by itself with `rebuildPercent` (default 1 % pitch). Second input "Emergency source": if the programme fails, the buffer first plays empty, then the emergency source runs (otherwise silence), after the return the delay refills (`state`: fill/run/hold). Displays: `currentDelayMs`, `rebuilding`, input/output level, `dumpedMs`, `underruns`. Target and rebuild speed can be changed in operation and survive a restart. **Dead-air watchdog:** if the input is below `deadAirThresholdDb` (−60 dBFS) for longer than `deadAirHoldMs` (default 5 s), the emergency source takes over; return only after `deadAirReturnMs` (2 s) of a stable signal; metrics `deadAirActive`, `deadAirCount`, `deadAirSeconds`; alarm on takeover and return. Threshold and hold times are our own solution (no standard). |
| **omp-lowlat-mixer** (studio mixer, low latency) | Block mixer for conference, presenter and in-ear paths (target 2–15 ms round trip, **measure on a real-time host**). Clock `OMP_LL_BLOCK` (16/48/96/192/480 frames = 0.33…10 ms). Inputs: ALSA card (`OMP_LL_ALSA_IN`, the card sets the clock), AES67 RTP (`OMP_LL_AES_RX`, 1 ms, L24/L16), MXL (NMOS receiver per strip or `strip.N.setFlow`); source per strip `off\|mxl\|alsa:K\|alsa:K-L\|aes:K\|aes:K-L`. Outputs: one MXL audio flow per bus (sender), ALSA channel pair (`bus.N.alsaOut`), AES67 stream (`OMP_LL_AES_TX`, send SDP in the parameter `aesTxSdp`). Per strip level, mute and sends to up to 16 stereo buses; **mix-minus** via `bus.N.mixMinus{strip}`. Every input has a ring with drift control (no resampler) and a self-growing reserve (`OMP_LL_INPUT_BUFFER_MS`/`…_MAX_MS`). Metrics: compute time, missed cycles, underruns, drift compensation, ALSA dropouts, AES counters. Control panel with faders, level, send matrix. Card diagnosis: `omp-lowlat-mixer --alsa-test <device> [period]`. Without real-time rights (`RLIMIT_RTPRIO`/`CAP_SYS_NICE`) the node runs at normal priority (metric `realtime` = no) and absorbs dropouts of the machine with a larger reserve — the latency is then higher. **Sound processing without latency** (everything without look-ahead, compute cores as in the audio mixer): per strip phase, high-pass + 4-band EQ (`strip.N.eq.*`), gate/expander (`strip.N.gate.*`), compressor (`strip.N.comp.*`) with gain-reduction display; per bus a **limiter** (`bus.N.limiter.enabled/ceiling/release`, instant attack within the same frame — the output never exceeds the ceiling; headphone protection for in-ear). All values are in the workflow backup. Write path for control surfaces: method `setParam{name,value}`. **Stream Deck:** adapter `lowlat-mixer` (MUTE/SEND/SELECT, EQ, dynamics and bus pages with mix-minus and limiter, dials = level). Standards status: RTP RFC 3550, L24 RFC 3190, L16 RFC 3551, SDP RFC 4566/7273; AES67-2018 and ST 2110-30 not read, unchecked against real devices. |
| **omp-segue-player** (radio) | Polyphonic player for tracks, jingles and beds: up to 8 files at once in one process, mixed **sample-accurately** to a stereo output. Each voice starts at a TAI time in the exact frame, with level, fade in/out (linear, equal power, logarithmic), fade out at a point in the file and start in the middle of the file; `stop`/`fade` can be commanded even before loading has finished. A `voiceId` assigned by the caller prevents double starts. Contract: `docs/contracts/CONTRACT-SEGUE-PLAYER.md`. |
| **omp-radio-automation** (radio) | Plays a radio log through the segue player. From the marks (segue point, intro) the node plans the transitions: track→track crossfade (equal power) at the segue point, track→jingle (jingle over the outro), jingle→track (track under the end of the jingle), speech in one piece. The voices go to the segue player with lead time (default 30 s) and a TAI start time (parameter `target` = name of the segue player); a fixed voice ID per log and slot prevents double starts on repetition and restart. Methods `load` (log JSON), `start` (`atTai`/`delayMs`), `stop`; as-run in the parameter `asRun`, backup via `/state`. **Control panel** in the console: choose target (segue player) and lead time, edit the log in a table (name, kind, file, duration, intro, segue point, start in file, level) or paste/show it as JSON, adopt with "Load log"; the "Run" timeline shows overlaps, crossfade areas, sent/running/past and the running time; start "in n s" or "at HH:MM:SS", stop with a confirmation; as-run below. **Hard marks (backtiming):** an element with `fixAtUnixMs` (column "Hard mark") starts at the time of day; at start the automation leaves out filler candidates (`optional`, column "Filler") before it or inserts candidates from `fillers` and shifts segue points (at most 8 s per track); every decision is in the as-run. **Radio console:** header bar "Now" (running, remaining, next, clock); in the log editor sort elements by drag & drop, column "Title" (display name) and "Block" — consecutive elements with the same name form a block (e.g. an ad break) with target length, sum, difference and "Append filler"; "+ Spot (ad break)" creates a spot; the time column shows the planned start. **Hotkeys:** keys with name, color, file and level (Edit → + Key → Save); a click plays immediately through the segue player, another click fades out. Methods `setCarts`, `fireCart`, `stopCart`. **Preparing shows:** section "Show" in the control panel (module `radio`, rights `radio.show.prepare`/`release`/`manage_all`): create a show or generate it from a template, set title, time window and presenter, prepare and save log, hotkeys, presenter cards (text, "at element", minutes) and notes (versions, restore). Release, at show time "Load on air" (log and hotkeys go into the automation, the cards appear large under "Now"), then "Complete show". Saving as a template turns it into a format for future shows. **Recurrence:** on a template you can set weekdays, time of day, duration and time zone; the system then creates the shows as drafts up to the set lead time (default 14 days) so they can be prepared early (deleted dates do not come back). **Weekly schedule:** weekly overview of all shows; a click opens, "+" creates a new one on that day. **Time control:** shows with "Status automatically after the time window" go to "on air" at the start and to "aired" after the end. **Load and start automatically** (header bar): the automation loads the next released show in good time before its start (lead time adjustable), starts it at show start and does not touch a show that is running. **Collaboration:** whoever opens a show for editing holds a soft lock; others see "… is editing" and the show read-only but can take it over (the lock expires without a heartbeat after 30 s; the revision check additionally protects against overwriting). **Cards:** reading time per card (≈ 150 words/min, warning when the planned minutes are exceeded); **teleprompter** (full screen) shows all cards continuously, the active one highlighted and followed, with font size, mirroring and auto-scroll; Esc closes. **Segue editor (transition editor):** double-click on the time cell of a playlist row, or the "Transitions" tab → "Edit", opens the transition from the previous track to the track: two waveforms with marks (segue point, entry, intro end, crossfade areas) that can be dragged (mouse wheel = zoom, Shift+drag = pan), plus number fields for segue point, start of B (offset), fade-out/fade-in duration and curves. Non-destructive: only the transition in the log (`transition`) is saved, the files stay unchanged. **Preview** of the transition, of A or B individually, with a loop and adjustable pre-/post-roll; **"Check broadcast quality"** renders the window with the unchanged mixer of the segue player and compares it with the preview (measured −91 dB deviation). "Default crossfade" resets the transition. **On-air position (tab "Broadcast"):** header with clock, date, show title, "on air" lamp and auto display; colored playlist (running red, ready green, played dimmed, edge color per kind, fixed times outlined in yellow), a click selects a row; key pad (start, stop, load, cue, reset, transition, navigator, edit, planning, presenter text, teleprompter, log); **pre-fade listen (PFL)** of the selected row with a waveform in the browser (not in the broadcast path); players M1/M2 with waveform, remaining time and a large countdown to the next element; library as a placeholder until the data sources are connected. **Dynamic layout** ("⚙ Layout"): show/hide and reorder areas of the right column, set the height of the playlist, column width and colors — applies per show (stored in the show document under `layout`, with "Save") and is remembered in the browser as a default. Routes `POST /segue/plan`, `GET /segue/peaks`, `GET /segue/audio`, `POST /segue/render`; design `docs/entwuerfe/ENTWURF-SEGUE-EDITOR.md`. |
| **omp-gpio** (radio, studio) | Generic contact inputs/outputs as a node (contract `docs/contracts/CONTRACT-GPIO.md`). Inputs debounced (`debounceMs`, default 20 ms) → NATS `omp.gpio.<node>.in.<pin>`; outputs via `setOutput(pin, level, holdMs)`, with a hold time the output falls back to the fail-safe level without renewal (`configurePin`), on loss of connection all immediately. Device in this stage: simulator (`simulateInput`, `simulateLink`). Environment `OMP_GPIO_INPUTS`/`OMP_GPIO_OUTPUTS`. **Control panel:** inputs as lamps, outputs switchable (with selectable hold time), names and fail-safe level, debounce time, simulator switches for inputs and connection, latest events. |
| **omp-ptz** | PTZ camera control via VISCA over IP (UDP 52381), one instance per camera (contract `docs/contracts/CONTRACT-PTZ.md`, chapter 104). `move(pan, tilt)`/`zoom(speed)` with a **hold time** (`holdMs`, default 1000 ms): without renewal the node stops the camera itself. Presets `recall`/`store`/`clearPreset`, absolute moves `goto`/`zoomTo`, `home`, `stop`; positions as raw values, events `omp.ptz.<node>.<link\|preset\|hold\|error>`. Control panel with a joystick. `OMP_PTZ_TARGET` (camera), `OMP_PTZ_SIM=1` (simulator). **Still unchecked on a real camera.** |
| **omp-tams-writer** (recording) | Continuously records an MXL source connected via the crosspoint matrix into a time-addressable media store (TAMS, API 8.2): GOP-accurate MPEG-TS segments (H.264/AAC), video and sound as separate flows, time axis on MXL/TAI time. Queue on disk on storage failure. `tams.start`/`tams.stop`. Setup `OMP_TAMS_URL`, `OMP_TAMS_AUTH`, token only from file/environment (contract `docs/contracts/CONTRACT-TAMS.md`, chapter 105). **Still unchecked against a real store.** |
| **omp-tams-reader** (playback) | Plays a time range from the store as an MXL source (`tams.play`, by timestamp or "N seconds ago") or plays a running recording back time-shifted (`tams.follow`, e.g. instant replay). Gaps are filled (`OMP_TAMS_GAP`). Follow mode polls, no webhook. **Still unchecked against a real store.** |
| **omp-midi-gateway** (control surfaces) | MIDI control surfaces at the server (contract `docs/contracts/CONTRACT-MIDI.md`): Mackie Control surfaces (main unit + extensions, e.g. iCON V1-M/V1-X, P1-M/P1-X) control the audio mixer (motor fader, mute, solo = PFL, select, encoder = pan, bank/channel, display, level, Rec LED = on-air, master fader → aux bus); key assignment `keys` (function field F1–F8 in pages, fixed keys, jog modes, additional profile for freely assigned pads/controls); the mode `profile` maps arbitrary MIDI devices to methods via JSON. Connections: `raw` (`/dev/snd/midiC<n>D<m>`), `rtp` (RTP-MIDI/AppleMIDI as listener or inviter), `sim`. Parameters `config`/`status`/`ports`/`recent`, methods `setConfig`, `bank`, `simulate*` (incl. `simulateJog`, `simulateMove`). The iMAP port (port 4) of the iCON surfaces is not opened. NATS `omp.midi.<node>.link`, `.button.<name>`, `.control.<id>`. **Control panel:** status, set up units, choose mixer, profile, simulator surface, events. |
| **omp-studio-logic** (radio, studio) | Microphone logic of the presenter position (contract `docs/contracts/CONTRACT-STUDIO-LOGIC.md`). Per microphone group: mixer channel on air → red light at the GPIO node (with a hold time, falls off on failure) and studio loudspeaker muted. Cough: key at the GPIO input or method `cough`, restores the previous mute state, opens on release, GPIO failure or maximum duration. Studio handover `offerHandover`/`acceptHandover`/`abortHandover` to a point in time, with audit. Rules as JSON in the parameter `config`, targets `mixer` and `gpio`. **Control panel:** cards per microphone group with lamp and state, **cough hold key** (hold = muted, release = open), studio handover (from/to, time, offer/accept/abort, countdown, audit) and "Rules" for editing the groups and studios with channel suggestions from the mixer; changes only apply after "Save". **Presenter position as a workflow:** the template `docs/examples/workflow-radio-moderationsplatz.json` (import with `POST /api/v1/workflows`) creates segue player, radio automation, presenter mixer, GPIO and studio logic; the targets of the control nodes are already set through the role names (role environment `OMP_RADIO_TARGET_LABEL`, `OMP_STUDIO_MIXER_LABEL`, `OMP_STUDIO_GPIO_LABEL`). Channels and the source of the segue player are created in the mixer (`channel.<id>.setSource` with the "Programme" sender of the segue player); afterwards "Save in workflow" in the Flow Editor so the state comes back at the next start. |
| **omp-failover** (radio, television to follow) | Modulation watchdog and failover switch before the last signal point (`docs/entwuerfe/ENTWURF-HAVARIEUMSCHALTER.md`). Main signal and three emergency sources as MXL audio flows, plus a built-in emergency clip (file in a loop). If the main signal fails (no signal for longer than `noSignalMs`, default 1.5 s; silence below `silenceDb`, default −60 dBFS, for longer than `silenceMs`, default 5 s), the node raises an alarm (`omp.alert.<node>` → alarm paths) and switches to the first healthy source of the order `order` (with a 20 ms crossfade). Return automatically when the main signal has been stable for `returnMs` (3 s) and the minimum dwell time `minHoldMs` (2 s) has passed, can be turned off (`autoReturn`). **Manual:** method `select(source)` (`main`, `n1`–`n3`, `clip`) — the choice stays, an alarm reports a faulty manual source; `auto` restores the automatic mode. **Control panel:** status display (NORMAL / FAILOVER / ALL FAULTY), sources with level, state and "Switch to" (with a confirmation if the main signal is fine), automatic mode, settings (times, threshold, order, clip file; save), log. All times and thresholds are our own values (no standard). After "Save in workflow" the settings are kept. **Television operation:** with `OMP_FAILOVER_VIDEO=1` (role environment) every source gets a **picture receiver** (`… Picture`, sound `… Sound`) and an MXL **picture output** in the format `OMP_FAILOVER_WIDTH/HEIGHT/FPS`; additionally detected are **frozen picture** (`freezeMs`, default 5 s) and **black picture** (`blackMs`, default 5 s; at most 0.1 % bright pixels — dark content stays "picture", black with a faded-in logo counts as picture); further emergency sources are the **still** (`stillFile`, image file, `OMP_FAILOVER_STILL`; without sound) and the emergency clip with picture and sound (`clipFile`, `OMP_FAILOVER_CLIP`). Picture and sound switch with **one** decision (the picture follows at the next frame clock). **"Redundancy pair" profile (chapter 109 stage B):** `OMP_FAILOVER_PROFILE=redundancy` (role environment, together with `OMP_FAILOVER_VIDEO=1`) or the method `profile(name)` (`emergency`/`redundancy`) turns the node into the switch behind a mixer pair: main signal = active mixer, fallback 1 = standby mixer. Failure = no new picture for `presentMs` (3 frame periods) + `noSignalMs` (20 ms), i.e. about 0.1–0.15 s; return to the main signal only after 5 s of stable picture and 5 s dwell (`returnMs`/`minHoldMs`), start-up grace: armed only once the main signal was healthy (`arm_required`, at the latest after 10 s), silence/freeze/black are not failures (`checkSilence` off, `freezeMs`/`blackMs` 0). In the workflow enter the standby role as **live standby** and connect its output explicitly to "fallback 1 picture"; all consumers connect to the switch only. Measured (2026-11-25, test sources 640×360@25, 6 of 6 runs): switch 107–142 ms after a hard kill, the output kept running without interruption. |
| **omp-sign-avatar** | Sign-language avatar (DGS), Rust, software rasterizer (no browser/GPU): input "Subtitles" (`video/smpte291`, text stream or CEA-608, IS-05 as with viewer/multiviewer), fill+key output (two `video/v210` flows, 25 fps, size small/medium/large). Pipeline: split sentences → words via lexicon (JSON, `verified` required) and rules file (JSON) to glosses → key sequence with crossfade; fallbacks: fingerspelling, text in the picture (built-in 5×7 font) with too many unknowns; queue with catch-up/discard (`OMP_SIGN_MAX_DELAY_S`). Renders only when the pose changes and only while a reader reads the flow (`gate_on_consumers`). Parameters `auto`, `speed`, `text`, read-only `state`, `subtitle`, `lexicon`, `renderMs`; methods `translate`, `speak`, `stop`. Check tool `--lexicon-check`/`--sheet`, measurement `--bench`. Concept and measurements: `docs/funktionen/GEBAERDENSPRACHE.md`. |
| **omp-recorder** | Records an MXL source (video/audio) connected via the crosspoint matrix as a Matroska file (`record.start`/`record.stop`). If the file name ends in `.mxf`, MXF is produced (H.264 + 24-bit PCM); if `record.mcaPlan` (JSON, format as for `mxf-mca inject`) has been set beforehand, MCA labels (ST 377-4/-41) are written into the file after the stop. MXL only as input, no capture card. "Warm, unsubscribed" until the start — no read pipeline while idle. **Channel plan (chapter 45):** `OMP_RECORDER_AUDIO_INPUTS=n` (1–8) creates the audio receivers "Audio", "Audio 2" …; `record.audioPlan` (JSON `{"channels":[{"input":0,"channel":1,"gainDb":-3},{"input":null}]}`, `input` = number of the audio receiver from 0, `null` = silence) assigns channels of several sources to the output channels of the file (`audiomixmatrix` per source + `audiomixer`); without a plan the sound of the first receiver is recorded unchanged. MXF: up to 32 channels PCM, Matroska/AAC: up to 8. |
| **omp-device-hub** | Detects the local video (V4L2) and audio devices (ALSA/USB) of the host with a stable device ID (serial number, otherwise USB position) and capabilities. For each device you switch "Offer" on: an MXL flow with an NMOS sender (tag `source.live`) is then created that appears in the crosspoint matrix like any other source. Default: everything off; the selection is kept across restarts, an unplugged device is offered again when plugged back in (same sender ID). **Audio outputs** (playback of the sound card, headphones/loudspeakers) appear as their own entry "Audio output": switched on it becomes an NMOS receiver that is connected to an audio source in the crosspoint matrix and then plays through the card (multichannel is mixed to the channel count of the card). Status per device: Off / Starting / Sending / Waiting for connection / Not plugged in / Error. One node per host, not per device. |
| **omp-capture-card** | Card node for SDI/IP capture cards (Blackmagic DeckLink, AJA, further SDK cards through a plugin built by the operator), **one instance per card**. The start wizard shows the detected cards of the host with input/output per connector (free/in use); the choice is made via `OMP_CARD_PORTS` (`0:in,0:out,1:in`), the vendor via `OMP_CARD_VENDOR` (`decklink`, `aja`, `custom`, ch. 76). Per input one video and one audio sender, per output three IS-05 receivers (video, audio, ANC/subtitles); duplex connectors get both. Port IDs in the inventory: `<vendor>-<N>-in|out`. Mode, device and extra values (`OMP_CARD_PROPS`) are checked against the plugin by introspection; a missing plugin or an unknown property = a clear start error. Detection: `omp-capture-card --list-cards` (host-agent action `list-cards`, orchestrator `GET /api/v1/hosts/{id}/cards`). Not checked on hardware. KONA IP in ST 2110 operation runs through NMOS and the ST 2110 gateway instead. |
| **omp-vfa** | Video follows audio (chapter 46), Go, a pure control plane without ports. Reads levels of the audio mixer (SSE `levelsUrl`, `inDb` per channel) and face states (NATS `vfa.vision.state`), decides with `internal/engine` (speaker + hold time, minimum duration, wide shot on silence, face position per confirmed shot) and switches the picture mixer via `crosspoint.select`+`crosspoint.cut` through the orchestrator proxy (service token; type registered as a control plane in `main.go`). Reports the preview URLs of the cameras on `vfa.vision.config`. Setup via "Person speaks now" (learning window 5 s, candidates from `engine.Learner`). Persistence `OMP_VFA_DATA` (JSON). |
| **omp-vfa-vision** | Face counting per camera, Go without CGO (Pico cascade `esimov/pigo`, embedded). Fetches `GET /preview` of the camera nodes every 300 ms (camera list comes from `omp-vfa` via `vfa.vision.config`, alternatively `OMP_VFA_CAMERAS`), determines position/size and publishes `{camera_id, faces:[{center_x, center_y, size_percent}]}` on `vfa.vision.state`. No identities. |
| **omp-intercom** | Intercom (chapter 47), Rust. Own mix core `mix.rs` (20 ms clock, participant×channel matrix, mix-minus via channel sums O(N·C), ducking for IFB/priority, limiter, speaker detection, VOX), one **static** WebRTC pipeline per participant (`peer.rs`: webrtcbin sendrecv Opus + data channel `ctl`, panel page `GET /panel?token=`, signaling `POST /offer?token=`), shared Opus encoders per identical listening signal (`encpool.rs`), silence is not sent, browser DTX for resting microphones. State/commands over the data channel (JSON, ping every 2 s, expiry 8 s). MXL: IS-05 receivers "Programme n" and MXL senders "Intercom Mix n" (`mxl_io.rs`). **The node is a service of its own (chapter 48):** it keeps channels, participants, templates and guests itself (`admin.rs`, file `OMP_INTERCOM_DATA`, default `data/omp-intercom.json`, written atomically) and registers with the service gateway of the orchestrator with a manifest (`GET /service.json`, routes under `/service/…`, only with the service token `OMP_SERVICE_TOKEN`). A backup copy is in the orchestrator's database (data backup); if the node starts empty (file lost, different host), the gateway restores it. `PUT /config` (raw node document) only exists without a service token (development/tests). `GET /status`, Stream Deck through the contract roles `deck.state`/`deck.command` (`/service/deck/{party}`, `docs/contracts/CONTRACT-INTERCOM.md`). On air: parameter `onAir` + tally bus (`OMP_INTERCOM_ONAIR_SOURCES`). Start options: `OMP_INTERCOM_PROGRAM_INPUTS`/`_MIX_OUTPUTS`/`_LATENCY_MS`, HTTPS because of the browser microphone (`OMP_HTTPS`). **Audio guest (RC3):** `POST /service/guests` with `"audio": true` creates return-feed and microphone channels including their connections in one step (return-feed input = free programme input, microphone = free mix output); revocation and expiry clean everything up again. Connecting the N-1 output of the audio mixer to the named programme input and the mix output to a mixer channel is done by a human in the Flow Editor. Measured with a real audio mixer: the guest hears the other guest (level 0.18), not themselves (0.0000); `tools/intercom-e2e/ton-gast-n1.mjs`. |
| **omp-xy-panel** | X/Y crosspoint matrix as a control panel (pure control plane, no ports): sources on the left, destinations on the right, each with home/up key through workflows, groups (nested) and "Unassigned". Three views (lists, matrix, router tile grid with video/audio/data levels; display only, choice remembered in the browser). Switches via `POST /api/v1/graph/edges` (rights, audit, loop protection of the core apply). With "⇉ All ports" it switches a whole node (e.g. video+audio) to another node: pairing by shared tags, otherwise 1:1 per media type (`planTagRoutes`). Additionally bouquets (several switches with one take, stored in the layout `xy-bouquets`) and tag-based switching via `GET /api/v1/sources` and `GET /api/v1/sinks` (tags on source **and** sink, e.g. `role.commentator`). For desktop and smartphone/tablet (layout follows the width of the tile). |
| **omp-scope** | Passive measuring instrument (tap, no output) on one optional MXL video and one audio flow each. **Picture:** waveform + vectorscope as one measurement picture, mean luma, frame-to-frame difference. **Sound:** peak/RMS, EBU R 128 loudness (M/S/I/LRA), true peak in dBTP per ITU-R BS.1770 including the R 128 conformance traffic light (−23 ±0.5 LUFS, ≤ −1 dBTP). **Timing:** transport latency, jitter, actual/target cadence, skipped grains and reader restarts per flow — computed from the MXL origin timestamps of the grains, not from arrival times; from that the **A/V offset (lipsync)**, evaluated per EBU R 37 (sound at most 40 ms before, 60 ms after the picture). **Flow:** the declaration from the MXL domain (media type, rate, bit depth, color space, interlace, group hint, grain size, data rate), deliberately shown separate from the measured actual. **Signal monitoring:** black picture, frozen picture and silence as held alarms (1/2/2 s hold time) as well as **gamut per EBU R 103 v3.0** (R, G, B, Y outside 5…246 at 8 bit on more than 1 % of the area, pre-filter and matrix choice per the standard, hold time 1 s). A negative latency value is not a display error but the statement "the writer stamps into the future" — see `docs/decisions.md` addendum 226. |
| **omp-scaler** | Scales/converts an MXL video source connected by drag & drop to a fixed target format (role format, see the workflow form) and writes it back as a second MXL flow — compensates resolution/frame-rate differences between sources and destinations. Supports `setOutputDelay()` since D8 part 3 (latency-budget compensation, see section 9.7). **Known limitation:** in a chain source→scaler→destination within the same workflow start, the last connection (scaler→destination) can be triggered too early, before the scaler has finished building its own output flow — re-drawing the affected connection once in the Flow Editor fixes it immediately (see `docs/decisions.md` addendum 109). **Frame-rate conversion:** default `videorate` (drops/duplicates frames); the option `OMP_FRAMERATE_CONVERSION=blend` crossfades instead (optional plugin `avvideofilter`, without the plugin falls back to `videorate`, +9…43 ms latency depending on the rate pair, no stage at equal rate; installation and offline route: `docs/INSTALLATION.md` §9). The target format is only taken at start (`OMP_WIDTH`/`OMP_HEIGHT`/`OMP_FRAMERATE_NUM`/`OMP_FRAMERATE_DEN`); in the MCR it comes from the house format of the line. |
| **omp-playout-buffer** | **Output anchor** at the end of a workflow (chapter 39): holds back picture and sound by an adjustable depth (`bufferMs`, default 2500 ms) and writes them as their own, never-breaking MXL flows (video + audio) in the role format. If the predecessor fails (crash, source change, hot-standby takeover), the output first keeps running from the buffer (up to the buffer depth without visible disturbance), then with a still picture or black and silence — the downstream sender stays connected. By default one receiver/sender each for video and audio; optionally several parallel tracks (`videoTracks` 1–8, `audioTracks` 1–16, start via `OMP_VIDEO_TRACKS`/`OMP_AUDIO_TRACKS`, changeable at runtime, own ring per track; `status` contains `videoTracks`/`audioTracks` with connection, fill level, counters). Timestamps are assigned anew and strictly monotonic on the MXL grid; picture and sound keep their original relation after every splice (measured with the marker source). After a bridged outage the depth is rebuilt with `refillPermille` (default 1 %). Memory strictly limited (`OMP_BUFFER_MAX_MIB`; 1080p25 at 2.5 s ≈ 0.45 GiB, ≈ 28 % of a core). Parameters: `bufferMs`, `resumeMs`, `holdMode` (`last`/`black`), `refillPermille` as well as measured values (`state` = `fill`/`run`/`hold`, `fillMs`, `bufferBytes`, `underruns`, …, collected in `status`). Supports `setOutputDelay()` (the compensation is added to the depth, picture + sound together) and is marked `anchor` in the catalog: not deletable in the workflow editor, the start preview warns about a missing anchor. A role connection to the buffer connects picture **and** sound. **Limits:** only the uncompressed path (MXL frames); the latency in the catalog (63 frames) applies to 25 frames/s and the default depth of 2.5 s; channel count/sample rate of the audio output are fixed (`OMP_AUDIO_CHANNELS`, 48 kHz). Details: `ARCHITECTURE.md` §30, `docs/USER-MANUAL.md` section 10f. |

### 9.2 Gateway nodes (site/third-party device connection)

| Node | Function |
|---|---|
| **omp-2110-gateway** | Bidirectional bridge SMPTE ST 2110 multicast (LAN, third-party devices) ⇄ OMP-internal MXL fabric. Directional per instance (ingest/output), SDP or single env-var configuration. **Labels (ingest, ch. 106.8):** picture and sound get their MXL labels from the RTP timestamps (ST 2110-10/ST 2059-1, `omp-mediaio::rtptime`/`rtplabel`) instead of from arrival, as soon as a common clock is available (`OMP_PTP_DOMAIN`, synchronized); otherwise arrival. Parameter `ingest.labelSource` (`rtp`/`arrival`), readable `ingest.labelClock`, `labelJumps`, `labelFallbacks`, `labelMessage`; `OMP_2110_LABEL_CLOCK=system` only as a substitute for testing without a PTP card. **JPEG XS (ST 2110-22, optional, user request 2026-11-22):** the module `omp_mediaio::jxs` looks up `svtjpegxsenc`/`svtjpegxsdec` (gst-plugins-bad) and `rtpjxsvpay`/`rtpjxsvdepay` (gst-plugins-rs, RFC 9134) at run time, creates the SDP (`jxsv/90000`, `SSN=ST2110-22:2019`) and builds send/receive chains; if elements are missing, a clear error message. **Not yet connected** in the gateway data path (a JPEG XS SDP is rejected with a reason), not verified live on the development machine (GStreamer 1.22); MXL stays V210. |
| **omp-aes67-gateway** | Audio counterpart of `omp-2110-gateway`: AES67/RTP multicast (devices in AES67 mode, Ravenna etc.) ⇄ MXL, including SAP discovery (RFC 2974) for third-party streams that can only be found that way. |
| **omp-srt-gateway** | Bidirectional bridge ST 2110 (LAN) ⇄ SRT (WAN) for contribution/distribution over lossy networks. Directional per instance (uplink/downlink). **Any resolution and frame rate** per instance (`OMP_SRT_GATEWAY_WIDTH`, `_HEIGHT`, `_FPS`; even values 16–16384, also fractional rates such as `30000/1001`; they must match the ST 2110 stream because its SDP fixes them). **Transport** (`OMP_SRT_GATEWAY_CODEC`): `raw` (default, RTP raw video per RFC 4175 over SRT, very high data rate), `h264` or `hevc` (compressed as an **MPEG-2 transport stream over SRT**, ISO/IEC 13818-1; `_BITRATE_KBPS`, otherwise automatic from the raster; `_BIT_DEPTH=10` for H.264 High 10 / HEVC Main 10). **Optional automatic raster:** `OMP_SRT_GATEWAY_RASTER=auto` (downlink with `h264`/`hevc` only) takes resolution and rate from the incoming stream; the 2110 output is built at the first decoded picture and rebuilt on a change in the running stream (new SDP, receivers have to follow); if the rate is missing from the stream, `OMP_SRT_GATEWAY_FPS` applies (default 25). For the uplink and for raw video the specification is needed because the raster there is not given by itself in the 2110 stream (SDP) or RTP — `auto` is rejected there. Not included: AV1 (no decoder installed, `mpegtsmux` without AV1) and learning-based codecs (no standardized, usable stream); new codecs come as a further variant in `codec.rs`. In compressed operation there is no RTP jitter buffer, losses are reported by the SRT statistics. |
| **omp-webrtc-gateway** (types `omp-webrtc-gateway-camera` / `-monitor`) | Connects ordinary phones through the browser, without an app: **Camera** takes the phone camera/microphone via WebRTC (WHIP, H.264 + Opus) and feeds it in as an MXL flow; **Monitor** sends a chosen MXL flow back as a return picture (WHEP). Access only through invitation links/QR codes; the invitations survive a restart of the gateway, also a manual restart with a new instance ID (a file per state key `OMP_STATE_KEY` and direction under `.run/webrtc-gateway/`, adjustable with `OMP_WEBRTC_GATEWAY_STATE_DIR`, permissions 0600; files of other instances that have been unchanged for more than 90 days are cleaned up by the gateway at start, `OMP_WEBRTC_GATEWAY_INVITE_KEEP_DAYS`). In detail: user manual, section "Phone camera". **Tally:** the camera page shows ON AIR when a picture mixer/switcher/tally giver (`OMP_TALLY_GIVER`, e.g. a 2110 output) puts it on air (`OMP_TALLY_SOURCES` restricts triggers; the tally event `omp.tally.<node>` carries the sender `src`). Fixed HTTPS ports via `OMP_HTTPS_PORT` (9443/9444). |
| **omp-fabrics-gateway** | See section 9.3 — **remote memory access** between two OMP hosts. |

### 9.3 Remote memory access (MXL-native fabrics)

For media transport **between** hosts there are two ways to choose from:
classic **ST 2110 ⇄ SRT** (`omp-srt-gateway`, WAN-capable, loss-treated)
or **MXL-native fabrics** (`omp-fabrics-gateway`) — real,
zero-copy **remote memory access** across host boundaries based on
libfabric (the OFI standard abstraction for RDMA-capable transports),
vendored in MXL itself (`third_party/mxl/lib/fabrics/ofi/`).

- **Implemented and verified live** (chapter 16 part 0/1/2,
  `docs/END-GOAL-FEATURES.md` §16, `docs/decisions.md` addenda 41–55):
  a dedicated `omp-fabrics-gateway` node (split in two like the other
  gateways, `OMP_FABRICS_GATEWAY_ROLE=target|initiator`) relays a
  complete MXL flow continuously by a real one-sided RDMA write into
  a domain on another host — **no mock, no GStreamer
  pipeline needed**, since fabrics works below the GStreamer level directly on
  `mxlFlowWriter`/`mxlFlowReader` handles.
- **The software provider (`tcp`) runs without RDMA hardware** — plain
  Ethernet/loopback is enough, a real RDMA connection with a continuously
  growing MXL head index identical on both sides has been
  verified (two MXL domains on one machine, real
  multi-host verification is chapter 16 part 3, waiting for a second
  physical host).
- **Still open:** the `verbs`/`efa` provider with real RoCEv2 hardware
  (chapter 16 part 4 — hardware procurement decided but not yet
  available) and an automatic placement choice of fabrics vs.
  ST 2110/SRT by the orchestrator (so far manual node choice).
- Providers are configured through `OMP_FABRICS_PROVIDER=tcp|verbs|efa|shm`
  — the same code, so the switch to real RoCEv2 hardware
  is a configuration question, not an architecture change.
- **Not yet in the GUI instance catalog** (`deploy/catalog.json`) —
  `omp-fabrics-gateway` has so far been started by hand
  (`OMP_FABRICS_GATEWAY_ROLE`/`OMP_FABRICS_TARGET_URL` etc., see
  `nodes/omp-fabrics-gateway/src/main.rs`), not via a catalog tile like
  the other nodes.

### 9.3a MXL domains: operation and best practice

**Principle: one domain until there is a reason for more.** The default domain `default` (`/dev/shm/omp-mxl`) is enough for operating one production. Every additional domain costs attention: connections across domain boundaries exist only through a bridge, and every bridge is a process that copies pictures.

**When a separate domain makes sense**

| Occasion | Recommendation |
|---|---|
| Test next to live on the same machine | Domain `test` (path separation is enough); a test run cannot touch or clean up a live flow |
| Tenants / separate visibility | one domain per tenant, **isolated** |
| Third-party or little-trusted nodes | a separate, isolated domain; only the bridge sees both sides |
| Only "it looks tidier" | no domain — workflows and the host view exist for that |

**Rules**

1. **Names:** lower-case letters, digits, hyphen; by purpose, not by person (`live`, `test`, `tenant-a`). Use **the same name on all hosts** — the assignment runs through the name, every host creates the path itself. Never set paths by hand.
2. **Assignment per workflow** (workflow setting "MXL domain"), not per role. A role only gets a different domain if it is a **bridge** (target domain). That way a workflow stays self-contained, and move/failover put it into the same domain of the target host.
3. **Bridges sparingly:** a bridge only copies, it does not convert (same format on both sides; otherwise the conversion is done **before** the bridge in the source domain, e.g. with `omp-scaler`). One bridge per flow pair, on the host that has both domains. Copying costs memory and some CPU, the bridge waits blocking (no polling) and rests without a source.
4. **Isolate only with reason:** isolation (sandbox) is chosen at creation and cannot be changed afterwards. It hides the flows of other domains from the nodes; it does not protect against a node with root rights on the host. Prerequisite: `unshare` (util-linux) and permitted user namespaces; if that is missing, the node does not start (no silently continuing without protection). After creating, check once: `ls /proc/<PID>/root/dev/shm` must show only the own domain.
5. **Domain of a running instance** only through "Change domain" (without connections, not for workflow members) or a restart; stop workflows, then change.
6. **Deleting:** only empty domains (no instance). Leftovers (flows without a writer) are shown by "MXL flows" as *orphaned*; they occupy `/dev/shm`.
7. **Memory:** all domains live in the same tmpfs `/dev/shm` of the host and share its size (section 10.6). There is no size limit per domain; leftovers and full areas are shown by the self-test.
8. **Across host boundaries** no domain helps: MXL is host-local. Between hosts you need SMPTE ST 2110, SRT or fabrics. For this the domain view in the Flow Editor shows the hosts as tabs per domain.
9. **Container nodes** automatically get only their own domain mounted.

**Read mode (troubleshooting):** the MXL read loops of all nodes wait blocking for the next grain (no more 5 ms polling). If a node shows no picture at 100 % CPU or "Last read time" stays frozen, cross-check with `OMP_MXL_READ_MODE=poll` in the node environment variables and report the finding.

**Not checked:** browser/WPE nodes (OGraf) in isolated domains (they run in the namespace as user 0), operation with third-party writers that write partial grains.

### 9.4 Reference/tutorial node

**`nodes/mock`** (Go) — a reference node without real media technology, companion
to `docs/entwicklung/NODE-TUTORIAL.md` for your own node implementations; the only
mTLS-capable node so far (section 2.1).

### 9.5 Add your own microservice to the catalog

Two independent ways, depending on the form of delivery (details/code paths:
`docs/entwicklung/NODE-TUTORIAL.md` step 5):

- **Locally built binary** (`runner: "process"`, the normal case for
  a node freshly built with the SDK, see `docs/entwicklung/NODE-TUTORIAL.md`):
  an entry by hand in `deploy/catalog.json`, then restart the orchestrator
  (`make stop && make start`) — the file is only read at start,
  no hot reload.
- **Container image** (`runner: "podman"`, §17 part 4/5): import through
  the **Administration** tab (or `POST /api/v1/catalog`) without an
  orchestrator restart, including an admission check and multiple versions
  of the same type (§17 part 5). This way accepts on the server side
  only `runner: "podman"` — a pure process entry cannot be created through it.

Start options of a node (what you can set in the start dialog or through `options` in `POST /api/v1/instances`) must be declared in `deploy/node-options.json`; the launcher rejects an undeclared option with "unknown option for this node type". When a node gets a new environment variable, add it there too (German label and the `i18n.en` translation).

**Distribute imported container microservices to hosts (ch. 85).**
The import first applies only on the orchestrator. For the type to also run on
remote hosts, its catalog card (Administration › Node catalog)
has the **Hosts** block with **"Distribute to hosts …"** (only with a version given at import).
Sequence: the orchestrator builds a **signed bundle** from the catalog entry and image
(Ed25519 distribution key of the cluster, stored in the database) and sends each
chosen host a signed command with a one-time token. The host agent downloads the
bundle **only from its own orchestrator**, checks the signature (own trust anchor,
the distribution key is stored at first contact and afterwards not silently
replaced) and the checksum of the image archive, then `podman load`, and enters the
type in its own catalog (`<state directory>/microservices/`).

- **The host decides** about trust extensions of the entry. Without
  configuration it allows all (`mxlAccess`, `mediaRead`, `hostNetwork`, `extraPort`,
  `dataDir`; user decision 2026-11-04) — the import stays admin-only, the bundle
  signed, the contract check mandatory. To narrow it: `OMP_MICROSERVICE_ALLOW` on the host agent
  (comma list, e.g. `extraPort,dataDir`; `none` = no extension). If an entry demands
  more than allowed, the installation is rejected (error text in the UI), never silently weakened.
- **Target state in Postgres** (table `catalog_distribution`): a reconciliation on the
  leader later catches up hosts that were added or became reachable again, repeats
  failures with growing intervals (up to 10 minutes; "Retry" immediately) and
  detects hosts where the type has disappeared (reconciliation with `catalog-list` every 2 minutes).
- **Placement:** an imported type is only offered and automatically
  placed on hosts where it is "ready". A direct start on another host
  returns HTTP 409 with a plain-text reason instead of OMP-2002.
- **Removing** ("Remove" on the host or "Delete" in the catalog) cleans up the image and —
  at the last version of the type — the data volume on the hosts; if an instance is still running
  there, it stays "failed" until it is stopped.
- Configuration on the host agent: `OMP_MICROSERVICE_DIR` (default `microservices/`
  next to the state file), `OMP_MICROSERVICE_ALLOW`, optionally `OMP_MICROSERVICE_PUBKEY`
  (distribution key in advance); on the orchestrator `OMP_CATALOG_BUNDLE_DIR` (cache
  of the built bundles, default `<OMP_UPDATE_DIR>/catalog-bundles`).
- **Limits:** the image must be present on the orchestrator that builds the bundles (in the
  orchestrator cluster the leader). The download runs through the orchestrator address configured in the host agent
  (as with the system update). Rootless Podman on SELinux hosts (Rocky 9) has not been checked yet.
- Software state per host: `GET /api/v1/hosts/software[?refresh=1]` (agent action `software`; build stamp via
  `-ldflags` in `deploy/dev/start-hosts.sh` or `make update-bundle`, node stamp from `OMPBUILD1…` in the binaries,
  never executed; UI: Hosts tab).
- API: `GET /api/v1/catalog/distribution`, `POST|DELETE /api/v1/catalog/{type}/hosts`
  (admin), `POST …/hosts/retry`, download `GET /api/v1/host-catalog/{id}?token=…`.

### 9.6 Assign an instance label

Without a label of its own, every started instance is called generically
"`<catalog label>` (`<short ID>`)" (e.g. "Source (66a0c71b)") — also in
crosspoint dropdowns of other nodes (picture/audio mixers). For roles started through a
**workflow**, the launcher automatically adopts
the role name freely assigned in the workflow as the label (no extra step
needed). For a direct catalog start (`POST /api/v1/instances`) a label can additionally be
passed explicitly in the request body:
`{"type": "omp-source", "label": "Camera 1"}`.

**Renaming roles of existing workflows.** Role names are references: they appear in the port labels of the nodes ("`<role>` Sender 1"), in environment values that let one node find another by name (e.g. `OMP_RADIO_TARGET_LABEL`), in connections, in the workflow interface, in the backed-up node state (placeholders and also names such as `"mixer":"<role>"`) and in the playout channels (bound to workflow + role name). Do not rename roles by saving the definition — that discards the backed-up state and leaves these references behind. Use `POST /api/v1/workflows/{id}/rename-roles` with `{"roles":{"old":"new"}}` for a **stopped** workflow: it rewrites definition, connections (including the port prefix), interface and environment values, migrates the backed-up state (keys, placeholders and name references) and lets modules follow (the playout channels).

### 9.7 Redundancy & latency budget (workflow settings)

Two workflow definition fields affect several roles at once
and are only enforced at `Start()` — both set purely declaratively
in the role designer or workflow form, no manual
orchestrator intervention needed (operation in detail:
`docs/USER-MANUAL.md` section 4):

- **Hot standby (`Role.standbyFor`, since K7 part 4):** a role can
  accompany another role of the same node type as a standby. If the
  primary instance fails for good after the crash-loop brake is exhausted,
  or its host is detected as offline (telemetry staleness), the
  standby instance is promoted automatically — wiring and
  operating state (via `/state` GET/POST) taken over, its tile in the Flow
  Editor shown dashed until then. Break-before-make (a short
  visible cut), no genlock equivalent — details/limits in
  `ARCHITECTURE.md` §6.3 stage 4.
- **Latency budget (`Settings.targetLatencyFrames`, since D8):** defines
  after how many frames every path of the workflow should leave the graph.
  `Start()` hard-rejects a wiring whose shortest path
  is longer than the target band; for paths that are **shorter**,
  the orchestrator automatically assigns the missing difference to the latest
  delay-capable role in the path through `setOutputDelay()` (so far
  `omp-scaler`, `omp-video-mixer-me`, see the section 9.1 table). No
  delay-capable node on a too-short path → the same hard
  start error instead of a silent partial compensation. Details:
  `ARCHITECTURE.md` §15.1.


### 9.8 Cloud hosts (orchestrator module, not a node)

The orchestrator can rent cloud hosts through a **provider adapter** (`OMP_CLOUD_PROVIDER=mock|aws`; credentials and configuration belong in the file `deploy/dev/cloud.env` (template `cloud.env.example`, not in the repo, `chmod 600`), which `make start` reads — never in the UI or database; safety nets in `docs/betrieb/CLOUD-AWS.md`). A cloud host is an ordinary host (host agent via bootstrap token, placement, migration); only creating/terminating and costs are new. Building blocks: pools (provider, region, instance type, min/max), reservations ("capacity from–to"), autoscaling rules per pool (off/suggest/automatic, hard daily/monthly cap), cost pre-calculation and estimated actual costs, draining teardown. API: `/api/v1/cloud/{pricing,estimate,hosts,costs,reservations,policies,suggestions}`; operation: **Cloud** tab (user manual §10e). The AWS connection is built without an SDK and **has not yet been tested against real AWS**; real starts are blocked by default (dry run only).


### 9.9 Orchestrator modules (playout, audio output, cloud, file intake control/review, stream ingest)

> **Services instead of modules (chapter 48):** the intercom is no longer a module but a service in the node `omp-intercom`. The module `extsvc` is the generic service gateway (`/api/v1/ext/<service>/…`): it checks login and function right, passes the identity on to the service and brings its rights, tabs, tiles and metrics into the platform. Guide: `docs/entwicklung/MODULE-SCHREIBEN.md` §7.

Domain functions are **modules** of the orchestrator, not core functions: **playout** (channels, triggers, as-run, preflight),
**audio output** (audio rules), **cloud** (§9.8) and **file intake control/review** (file QC, review player, conform, metadata — `docs/entwuerfe/ENTWURF-FILE-QC.md`) and **stream ingest** (scheduled live recording with resource planning — `docs/entwuerfe/ENTWURF-INGEST.md`). Each module brings its routes, background jobs if any, metrics and its
UI with it; `GET /api/v1/modules` shows the state and UI (the shell builds its tabs from it). With the environment variable
`OMP_MODULES_DISABLE=cloud,audio-rules` (comma list of the names `cloud`, `playout`, `audio-rules`, `review`, `ingest`) a module can be switched off:
its routes then answer 404 and the tab is missing — the core (nodes, graph, hosts, workflows, rights) runs unchanged. A module
whose start or migration fails is shown as `failed` in the manifest, the others keep running. Your own modules: `docs/entwicklung/MODULE-SCHREIBEN.md`.

**Master control room (module `mcr`, ch. 106.9):** events with lines, templates and roles per event; name `mcr` in `OMP_MODULES_DISABLE`. Routes under `/api/v1/mcr/`: `templates` (GET/POST, PUT/DELETE `{id}`), `events` (GET/POST, GET/PUT/DELETE `{id}`), `events/{id}/transition` (`{"to": …}`), `events/{id}/members` (PUT), `settings` (GET/PUT, admin only; house format of the default and the replaceable functions, see below). Lifecycle `planned → testing → live → teardown → done`, also `cancelled` from `planned`/`testing`, `testing → planned` (rebuild) allowed; everything else → 409. Deleting only in `planned`/`done`/`cancelled`. In `live` the line structure does not change (settings only). Line kinds `srt`, `rist`, `st2110`, `hls`, `mxl`. **Secrets (passphrases, passwords, tokens) are never stored** (error 400); only the name of a key is allowed (`passphraseKey`). House format: default (`mcr.houseFormat`) → event → line, separate for picture and sound, changeable at any time, without fixed values in code; the response of an event contains `effectiveHouse` per line. Function rights `mcr.manage` and `mcr.live`. **Lifecycle with effect (106.10):** `testing` creates the workflow `mcr-<name>-<id>` and starts it (per line input + `omp-normalizer`, interface output = line name); `live` turns the stop confirmation on, `teardown` only stops with `"confirm": true` (otherwise 409 `confirmation_required`), `done`/`cancelled` delete the workflow. The database is the source of truth: the start environment of the roles (house format, input settings) comes from the database at every start through the role-environment observer, and every 3 s the module reconciles restarted instances (house format, compensation). Passphrases: only `passphraseKey`, the file is in `OMP_MCR_SECRETS_DIR` (permissions 0600). Routes: `GET /api/v1/mcr/events/{id}/status`, `POST …/lines/{lineId}/measure`, `PUT …/lines/{lineId}/avsync`. **Intercom return feeds (106.12):** line JSON `intercom.return` (`mode` `mix`/`guest`, `source`, `transport`); rule: source without commentary → IFB directly, source with commentary → N-1 bus at the mixer (`aux.<id>.setN1`, `exclude` = commentary channel), otherwise a warning on the event (`warnings`). Contract roles of the intercom `event.return.create`/`.delete`. **Monitoring, alarms, roles, chain (106.13–106.15):** per event a multiviewer workflow, per line an `omp-scope` in monitoring mode (renders nothing); multiviewer only for events being watched (watch), `GET /api/v1/mcr/monitor` delivers the wall, `POST …/lines/{id}/monitor` the listen/measurement station. Alarms: table (migration V4), `GET /api/v1/mcr/alarms/history` (filters `event`, `line`, `kind` as a case-insensitive substring with or without `signal-`, `severity`, `state` = `open|ended|unacked`, `days`), acknowledge `POST …/events/{id}/alarms/{alarmId}/ack`; check profile `qc.profile` (`standard`/`strict`/`off`) plus deviations `<check>.<holdSeconds|threshold|enabled|severity>` per event/line (`monitoring`), reaction rules on the event (frame, alarm PiP via `omp-switcher`, notice, GPIO, `panel` = text display at intercom stations through the contract role `panel.notice`, only on alarm onset, only to connected panels). Recordings through the ingest (migration V5, decoded MXL flow only). Roles per event (`lead`, `engineer`, `viewer`, `commentator`, migration V6, `mcr.view` ⊂ `mcr.live` ⊂ `mcr.manage`); connections of the members as `authz` bindings; access rules (`accessrules`) are deliberately not set. Processing chain as data (`mcr.chain`, `mcr.stageTypes`, migration V3); running workflows are reshaped by `workflows.Service.Reshape`. Capacity pre-check `GET …/events/{id}/precheck` (warning, no block). **Replaceable functions (106.13h):** the setting `mcr.slots` (`PUT /settings {"slots":{…}}`) names the node type for the normalizer, the up/down converter, the A/V delay and the audio splitter; empty converter/delay = the function stays inside the normalizer, otherwise the node is inserted automatically before (converter) or after (A/V delay) the normalizer; with a separate A/V delay the normalizer's own compensation is switched off and a measured or manual offset is converted to frames + milliseconds and set at the delay node (`delay.videoFrames`/`delay.audioMs`); optional per slot `ports`, `env` (start environment template from the house format, placeholders `{width} {height} {rate} {rateNum} {rateDen} {scan} {channels} {sampleRate}`), `params`, `maxFrames`, `strict`, `data`. **Audio splitter (106.19):** line option `normalize.audioSplit` (`tracks`/`pairs`/`outputs`, house channels); each output becomes a workflow output "line · name". **Data track:** with a data source on the line the normalizer passes ANC/timecode/subtitles; the alarm `signal-dataLoss` (4 reconcile runs ≈ 12 s without data) goes through the alarm list, reactions and the global alarm path. **Global alarm path (106.13i):** MCR signal alarms are enriched with event, line and event workflow (`alertsink.Sink.Enrich`; rules per event workflow, webhook field `mcr`), appear in the global Alarms tab and footer bar (source "MCR") and close when the event ends or is deleted (`SweepStaleAlarms` at start). **Operation:** passphrases are files (permissions 0600) in `OMP_MCR_SECRETS_DIR`, never in the database. After changes to routes/rights `go run ./cmd/routetable -strip-source > cmd/routetable/testdata/routes.golden.json`. **Limits:** one audio flow per line; CPU per event is high on small hosts (normalizer ~1 core, multiviewer ~1.4 cores at a 720p canvas, scope ~0.33 core each) — heed the pre-check before the test start; content-based A/V measurement (106.16) is waiting for material.

### 9.9a Access rules, file transfer and AVC-Intra (new)

- **Access rules for sources and sinks** (`internal/accessrules`, table `access_rules`, migration 0064): who may see and switch which sources/sinks, per user, group or global; blocking wins, every allow rule switches to an allow list, switching requires seeing. Enforced in `GET /api/v1/sources|sinks|graph` (filtered), `POST/DELETE /api/v1/graph/edges` and switching onto workflow inputs (403 with a reason); administration under `/api/v1/access-rules` (right `configure`, change log), preview `GET /api/v1/access-rules/effective?user=…`. Exempt: `configure`, service accounts of the nodes, support access. Operation: user manual 10c-3b.
- **Copy and move files** (module `files`, right `files.transfer`): block by block through the jobwire operations `read-chunk`, `write-chunk`, `commit`, `abort`, `move`, `mkdir` (384 KiB per block, SHA-256 per block, target file as `.omp-part` until the atomic `commit`); endpoints `POST /api/v1/files/transfer/preview`, `POST /api/v1/files/transfer`, `GET /api/v1/files/transfers`, `POST /api/v1/files/transfers/{id}/cancel`; progress in `file_transfers`. **Host agents must be updated to the new version** (section 5b), otherwise they report "unknown operation". Background: `docs/decisions.md`, addendum "Copy and move files".
- **Workflow import with checking:** `POST /api/v1/workflows/import/preview` (catalog, definition, hosts, groups, version of the file, unknown fields, existing workflow including differences) and `POST /api/v1/workflows/import?replace=<id>`; export files carry `meta.orchestratorVersion`, role bindings `subjectType`/`subjectName`.
- **AVC-Intra Class 100 (1080/50p, 16 audio tracks):** recorder profile `record.profile` or `OMP_RECORDER_PROFILE` (`avci50|100|200`, `.mxf` only); MXF player and channel player follow the frame rate of the workflow (`OMP_FRAMERATE_NUM/DEN`); QC profile `avc-intra-100-1080p50`; audio-rules schema `mxf-16`. Compute needs and open points: user manual 5d-2.

### 9.10 Stream Deck (WebHID, browser control surface)

Purely client-side (`ui/shell/streamdeck/`), no server part. Models (manufacturer HID description, `docs/entwuerfe/ENTWURF-STREAMDECK.md` §1): XL and XL 2022
(8×4, 96 px, rotated 180°), the 15-key family (5×3, 72 px, 180°), "+" (4×2, 120 px, 4 dials, strip 800×100, unrotated) and **"+ XL"** (PID `0x00C6`,
9×4, 112 px, 6 dials, strip 1200×100, **90° counter-clockwise**, also the strip partial images).

| File | Task |
|---|---|
| `models.ts`, `protocol.ts` | Model table (incl. `rotation`), chunking/decoding of the HID reports (pure, tested) |
| `transport.ts`, `sim-device.ts` | WebHID (`HidLike`) or simulator fulfilling the same interface |
| `render-logic.ts`, `draw.ts`, `plot-*.ts` | Fingerprint + debounce, canvas → JPEG (text with wrapping/auto size), curves (EQ/dynamics) across several keys/strips |
| `broker*.ts`, `session.ts` | Header line (home + tabs), input distribution, 1.5 s clock `refresh()` (not stacked, 8 s limit), tab register of the console, reconnecting |
| `adapters/` | `video-mixer`, `audio-mixer`, `ograf`, `xy-panel` (each `*-logic.ts` + Deno test); otherwise `autoraster*.ts` |

**X/Y adapter: levels and bouquets.** *Levels:* the top row of every page shows "All" + the folders (workflows, groups, "Unassigned") like the panel; a folder restricts sources or destinations to its nodes (recursively), "↑ Up" goes back one level, nodes of the level can be chosen as a category. Without folders it stays at "All" + per node. *Bouquets* (from the layout `xy-bouquets`, created in the panel) are on their own pages behind the crosspoint matrix (key at the bottom right "Next page"): key = switch the bouquet (green/red: switched/with errors), "↶ Back" at the top left undoes the last switch within 60 s (also take/disconnect). Bundle bouquets need a chosen destination (its node is the bundle destination). On small decks the bouquet pages are appended to the pages of the crosspoint matrix.

*Levels by dial:* on the "+ XL" (6 dials) dial 5/6 choose the level of sources/destinations (turning = entry, press = open/back); on the "+" (4 dials) a press on dial 3 switches to level mode (dial 1/2 then control the levels, dial 3 again = back to the selection). *Record a bouquet:* on the bouquet page "● Record" (only with `configure`, from 8 keys): take/AUTO collect switches without switching (TAKE shows "● n"); "■ Save" creates a bouquet "Deck HH:MM:SS" (renameable in the panel), "✕ Discard" cancels.

**Flow Editor (engineering):** users with global `configure` get the tab "Flow" on the Stream Deck with the same crosspoint matrix as on the X/Y panel (`FlowCanvas.streamDeck` → `xyPanelAdapter(coreIO())`); operators do not see it (`whoami.canConfigure`).

**X/Y adapter (`adapters/xy-panel*.ts`):** from 5 columns × 3 rows a column layout (sources left, control column middle, destinations right; top row per page = categories "All" + per node, "more ▶" to page through), below that the page layout (sources/destinations/control) without categories. Switching through `POST/DELETE /api/v1/graph/edges`; for that the core requires `operate` on the node of the target receiver (node binding or workflow role) or global `configure` (`requireVerbOnReceiver`, `orchestrator/internal/httpapi/auth_middleware.go`). **Rights per user or per panel:** (1) per user/group through bindings (`operate` on the target node or the workflow role); (2) per panel: an engineering user (`configure`) switches on the option "Allow switching through this panel" in the panel (layout `xy-panel-grants`, `{"grants":{"<panel instance>":true}}`); then anyone with `operate` on **this panel node** (also through groups) may switch arbitrary destinations through it. Panel and Stream Deck adapter send the header `X-OMP-Panel` for this; without a grant or operate right it stays at 403. `GET /api/v1/auth/whoami` additionally returns `canConfigure`.

Adapter resolution (3 stages, `adapters/index.ts`): property `streamDeck` on the element of the node UI bundle → factory by element name in the shell → auto raster
from the descriptor. **Your own/third-party nodes:** `docs/entwicklung/NODE-TUTORIAL.md`, section "Stream Deck assignment for your own node".
Linux: udev rule on the **operator-position machine** (`make streamdeck-udev [ARGS=--dry-run|--remove]`, `deploy/dev/streamdeck-udev.sh`,
`./install.sh --streamdeck-udev`; see also `docs/INSTALLATION.md` §6). Test page/simulator: `/streamdeck-sim` (orchestrator route; embedded in the console panel).
The simulator scales to the window width. Tests: `cd ui && deno test -A shell/streamdeck`.

## 10. Real-time operation (deterministic timing, host tuning)

OMP itself sets **no** real-time priorities, affinities or memory locks;
the timing depends on the operating system (GStreamer streaming threads, MXL reading/
writing, network interrupts). This chapter describes what to set on the host
so that outputs run without dropouts, frame drops or jitter.
Order by effect: **(1) BIOS, (2) kernel boot parameters, (3) CPU partitioning,
(4) interrupts/NIC, (5) priorities of the services, (6) memory, (7) time base,
(8) measuring.** Steps 1–4 and 6–8 bring most of the benefit; hard
SCHED_FIFO priorities (5) are optional and dangerous when wrong.

> **Important:** none of this is automated in the repo or measured on the
> target hardware. Introduce every change individually and prove it with §10.8.
> A reference setup "Proxmox + RT kernel" has not been tested yet.

### 9.10a MIDI control surfaces (Web MIDI and gateway)

Two ways, one logic (`docs/contracts/CONTRACT-MIDI.md`): **browser** (`ui/shell/midi/`, button "MIDI") for USB surfaces at the operator machine, **node `omp-midi-gateway`** for surfaces at the server or on the
network, without a browser. Core (TypeScript and Rust, checked against `docs/midi/*.json`): Mackie Control codec (`mcu`), fader curve (`fader-law`/`fader.rs`), surface logic (`surface-logic`/`surface.rs`) and the
generic profile (`profile`). The **simulator** (`sim-surface.ts`, `SimPort`) understands the computer's messages like a surface (motor fader only without touch, LEDs, display, level) and produces operation —
all tests run without a device. The connection to the mixer is `audio-backend.ts` or `mixer.rs` (`mixState`, live stream, `channel.<id>.set*`). **Key assignment** (`keys.ts`/`keys.rs`, scenarios `docs/midi/keys-golden.json`): default assignment without configuration (F1–F8 on the selected channel, arrows, solo clears pre-fade listen, scrub toggles the jog wheel), `{ch}` templates, LED from the mixer state, pages via the eight view keys, short message in the surface display; jog modes `gain`/`select`/`nudge`. Keys, encoders and jog apply only on MIDI channel 1, everything else goes to the additional profile (`keys.profile`); notes without a name are called `note<N>`. **Device knowledge from the P1-M manual:** four USB ports (1–3 = DAW keys, 4 = iMAP), a touchscreen with 16 fields in 5 color layers is assigned in iMAP and sends Mackie keys (`docs/contracts/CONTRACT-MIDI.md` §1). **Simulator fader** in the style of the audio mixer faders (`sim-fader.ts`), curve with the same support points as the on-screen fader.
**Not checked on real hardware**, the open points are in `UMSETZUNG.md` ch. 93.

### 10.1 BIOS/UEFI

- C-states deeply off (C-state limit C1 or "Maximum Performance"), package C-states off
- Fixed frequency: governor `performance`, turbo as you choose (for determinism rather off), SpeedStep/Cool'n'Quiet off
- Hyper-Threading/SMT: off for hard real time, or isolate the sibling threads of the media cores as well
- PCIe power saving (ASPM), "Memory Power Saving" off
- Minimize system management interrupts (SMI) (disable vendor options "Legacy USB", "Platform Firmware Performance")
- VT-x/VT-d (IOMMU) on if VMs or PCIe passthrough are needed
- On multi-socket systems: NUMA on, keep media nodes and NIC on the **same** node

### 10.2 Kernel (Proxmox host)

Three stages, ascending in effort:

1. **Standard pve kernel with full preemption** (recommended as a start; no
   package change): the pve kernel is `PREEMPT_DYNAMIC`, the mode can be chosen by
   boot parameter. In `/etc/default/grub` (or `/etc/kernel/cmdline`
   for systemd-boot/ZFS root, then `proxmox-boot-tool refresh`):
   `preempt=full threadirqs`
2. **Debian RT kernel** (`PREEMPT_RT`, in the mainline since kernel 6.12):
   `apt install linux-image-rt-amd64` (Debian 13), then choose it in the boot menu.
   Restrictions on Proxmox: the RT kernel is **not supported** by Proxmox;
   ZFS/DKMS modules (e.g. NVIDIA, Mellanox OFED) must match the
   kernel, KVM works but has clearly less throughput in RT operation.
   Choose it only if stage 1 + CPU isolation is not enough.
3. **A dedicated device only for OMP**: if OMP runs directly on Debian 13 (without
   Proxmox, see `docs/INSTALLATION.md`), the RT kernel is unproblematic.
   For hard broadcast operation this is the easier way.

Check: `uname -v` shows `PREEMPT_RT` or `PREEMPT_DYNAMIC`; `cat /sys/kernel/debug/sched/preempt` shows `(full)`.

### 10.3 CPU partitioning (pinning, isolation)

Idea: a few "housekeeping" cores (operating system, orchestrator, database, UI,
interrupts) and dedicated media cores on which nothing else runs.
Example with 16 cores (0–15): housekeeping 0–3, media 4–15.

Boot parameters (in addition to §10.2):

```
isolcpus=managed_irq,domain,4-15 nohz_full=4-15 rcu_nocbs=4-15 \
rcu_nocb_poll irqaffinity=0-3 skew_tick=1 \
intel_pstate=disable processor.max_cstate=1 intel_idle.max_cstate=0 \
nosoftlockup tsc=reliable
```

(`intel_*` for Intel only; on AMD `amd_pstate=passive` or leave out.)

Put services on the cores (systemd, inherited by all child processes — so
also by the nodes that the orchestrator or host agent start):

```ini
# /etc/systemd/system/omp-host-agent.service.d/rt.conf   (media host)
[Service]
CPUAffinity=4-15
Nice=-10
LimitMEMLOCK=infinity
LimitRTPRIO=95
LimitNICE=-15

# /etc/systemd/system/omp.service.d/rt.conf              (main machine, orchestrator/DB/NATS)
[Service]
CPUAffinity=0-3
```

`systemctl daemon-reload && systemctl restart omp-host-agent`. Note: restarting the
agent ends its nodes (see the header comment of the unit) — only
in a maintenance window. Also pin system services (`system.slice`, `user.slice`,
`init.scope`) to housekeeping: `/etc/systemd/system.conf` →
`CPUAffinity=0-3`.

Per node, targeted (e.g. only mixer and output on their own cores): the optional
catalog field `realtime` on the entry in `deploy/catalog.json` (applies to orchestrator
and host agent, `runner:"process"` only):

```json
"realtime": { "cpus": "4-7", "policy": "fifo", "priority": 40 }
"realtime": { "cpus": "8,10-11", "nice": -10 }
```

`cpus` (taskset list), `policy` (`other`|`fifo`|`rr`), `priority` (1–90, only
fifo/rr), `nice` (−20…19, relative to the priority of the starting service, only without fifo/rr). Implemented as a wrapper
`chrt`/`taskset`/`nice` before the binary; the PID stays that of the node, pinning
applies from the first thread. Parts that cannot be applied (the CPU does not exist on this
host, `LimitRTPRIO`/`LimitNICE` missing, tool missing) are left out with a
warning in the log — the instance then starts unpinned. Cores differ
per host: with hosts of different sizes set the entry only where it fits, or set `OMP_RT_DISABLE=1` on every host that should
not use it. Applies to newly started instances, not to running ones.
Podman entries (`runner:"podman"`) are excluded (use `--cpuset-cpus` there).

### 10.4 Interrupts and network card

- Turn `irqbalance` off (`systemctl disable --now irqbalance`), set IRQs by hand:
  `for i in /proc/irq/*/smp_affinity_list; do echo 0-3 > $i 2>/dev/null; done`;
  deliberately put the queues of the media NIC on **one** nearby core
  (`/proc/interrupts` shows names, e.g. `eth1-TxRx-0`).
- NIC: `ethtool -C eth1 adaptive-rx off rx-usecs 0 tx-usecs 0` (no
  interrupt coalescing delay), rings large enough
  (`ethtool -G eth1 rx 4096 tx 4096`), power saving off
  (`ethtool --set-eee eth1 eee off`), LRO/GRO off for real-time media if needed.
- A separate NIC (or VLAN + QoS) for media and for management/database;
  mark media traffic with DSCP EF/AF41, prioritize at the switch.
- For ST 2110/PTP: a card with hardware timestamping (`ethtool -T eth1` shows
  `hardware-transmit/receive`), a switch with PTP boundary/transparent clock.
- Bypass firewall connection tracking (`conntrack`) for media ports
  (`NOTRACK`), it costs time per packet.

### 10.5 Thread priorities (optional, with care)

- **Often enough already**: pinning + `Nice=-10` (§10.3) + isolated cores.
  On isolated cores nobody competes anyway.
- **SCHED_FIFO** for the time-critical threads (output nodes, mixer):
  `chrt -f -p 50 <tid>` per thread (`ps -L -p <pid> -o tid,comm`), never 99
  (reserved for the kernel watchdog/migration). Order: interrupt threads
  (`irq/…`, with `threadirqs`) 80–90 > media NIC threads 60 > OMP streaming
  threads 40–50 > everything else normal. If you set `CPUSchedulingPolicy=fifo` +
  `CPUSchedulingPriority=40` in a drop-in, that applies to **all**
  child processes including database/orchestrator — only on a dedicated media machine
  and with housekeeping cores (otherwise the system starves). Alternative:
  `CPUSchedulingResetOnFork=yes` in the drop-in and raise the nodes individually via `chrt`.
- **Danger**: a FIFO thread in an infinite loop blocks its core
  completely. Therefore keep housekeeping cores free and leave `kernel.sched_rt_runtime_us`
  at the default 950000 (the last 5 % belong to the normal
  scheduler and keep SSH reachable).
- GStreamer raises some threads via `rtkit` (only if installed); on
  pinned systems that is unnecessary and unpredictable — remove `rtkit` if need be.

### 10.6 Memory

- `vm.swappiness=0` and swap off (`swapoff -a`, remove the entry from `/etc/fstab`);
  no zram. On Proxmox no RAM ballooning for OMP VMs.
- Transparent hugepages off: `transparent_hugepage=never` (boot parameter).
  If you want hugepages for VMs, reserve them statically: `hugepagesz=1G hugepages=16`.
- `LimitMEMLOCK=infinity` (see §10.3) so media processes can lock
  memory; the MXL domain is under `/dev/shm` (tmpfs in RAM) — on NUMA put it on
  the media node and provide enough size in the mount (`size=`).
- Set `vm.min_free_kbytes` to about 1 GiB so the kernel does not get into
  direct reclaim under pressure; `vm.dirty_ratio=5`, `vm.dirty_background_ratio=2`
  (disk recordings otherwise disturb real-time threads).
- No NUMA balancing: `kernel.numa_balancing=0`.

### 10.7 Time base and background load

- Clocks: NTP is enough for management (`chrony`); for ST 2110/AES67 real PTP
  (`ptp4l` + `phc2sys -s eth1 -c CLOCK_REALTIME`), see `OMP_PTP_DOMAIN`
  (`docs/decisions.md`, ch. 19 part 2). Do not work with NTP stepping
  on the same clock at the same time (`makestep` off for media hosts).
- No background noise on the media cores: `fstrim.timer`, `apt-daily*`,
  `unattended-upgrades`, virus scanners, backup runs and `make`/`cargo`
  builds only in broadcast pauses or on the housekeeping cores.
- Container services (Postgres, NATS, registry) onto the housekeeping cores via `--cpuset-cpus=0-3`
  (quadlet: `PodmanArgs=--cpuset-cpus=0-3`).
- Power management: `cpupower frequency-set -g performance`,
  `tuned-adm profile realtime-virtual-host` (host) or `realtime-virtual-guest` (VM)
  takes over many of the settings above in one step.

### 10.8 Proxmox: VM or LXC?

- **VM (KVM)**: `cpu: host`, pin vCPUs to host cores
  (`qm set <id> --affinity 4-11`), `numa: 1`, fixed memory (`balloon: 0`,
  optionally hugepages `hugepages: 1024`), VirtIO network with `queues=` ≥ 2 or
  better the NIC via **PCIe/SR-IOV passthrough** (bypasses the host switch, delivers
  hardware timestamps). In the guest the same boot parameters apply (§10.2–10.3).
  The guest is only as deterministic as its host: keep the host free with
  `isolcpus` so that nothing else runs on the VM cores.
- **LXC**: shares the host kernel (the RT kernel acts directly, no
  virtualization jitter). CPU via `lxc.cgroup2.cpuset.cpus: 4-15`,
  more rights: `lxc.prlimit.rtprio: 95`, `lxc.prlimit.memlock: unlimited`,
  deliberately pass through access to the `/dev/shm` MXL domain and `/dev/dri` (GPU). For hard real time
  usually the better choice compared with a VM.
- One VM/container per task is fine, but orchestrator/Postgres and
  media nodes **not** on the same cores.

### 10.9 Measuring and acceptance

Without measurement everything is guesswork. Always under real load (all channels of the
target workflow running, browser with the console open):

```
apt install rt-tests linux-perf
# Scheduler latency on a media core, 30 min:
cyclictest -m -S -p 90 -i 200 -h 400 -D 30m --affinity 4-15
# Uncover hardware/firmware disturbances (SMI):
hwlat_detector  or  cd /sys/kernel/tracing && echo hwlat > current_tracer
# Who runs on the media cores?
ps -eLo psr,pid,tid,cls,rtprio,ni,comm | awk '$1>=4' | sort -n
cat /proc/interrupts      # counters of the media cores must barely grow
```

Reference values (acceptance): `cyclictest` maximum **< 50 µs** (RT kernel, isolated)
or < 200 µs (pve kernel with `preempt=full`); no SMI spikes > 20 µs.
Then in OMP itself: observe `make soak` or the alarms (ch. 6 in the user manual) over
24 h — counters for frame drops/underruns of the output node
must stay at 0. For outliers: `perf sched record` / `trace-cmd`
show which thread occupied the core.

### 10.10 "Runs perfectly" checklist

- [ ] BIOS: C-states/turbo/ASPM/SMI as in §10.1, firmware current
- [ ] Kernel with `preempt=full` or RT (§10.2), `threadirqs`
- [ ] Housekeeping/media cores separated, `isolcpus`/`nohz_full`/`rcu_nocbs` (§10.3)
- [ ] `irqbalance` off, IRQs pinned, NIC without coalescing (§10.4)
- [ ] Services placed with `CPUAffinity`/`Nice`, FIFO individually if need be (§10.3, §10.5)
- [ ] Swap off, THP off, `LimitMEMLOCK=infinity`, hugepages as needed (§10.6)
- [ ] PTP/chrony clean, no noise on media cores (§10.7)
- [ ] Separate NIC/VLAN for media, DSCP + switch QoS, SR-IOV if need be (§10.4, §10.8)
- [ ] `cyclictest` + 24 h soak under load passed and recorded (§10.9)
- [ ] Power supply/UPS, cooling (thermal throttling destroys determinism), server hardware with ECC

## 11. More context

- Architecture/concepts: `ARCHITECTURE.md` (reference document, updated with every
  larger decision)
- Implementation plan/status: `UMSETZUNG.md` (status checklist at the end)
- Individual decisions/blocker history: `docs/decisions.md`
- Building your own node type (SDK tutorial): `docs/entwicklung/NODE-TUTORIAL.md`
