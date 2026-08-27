// <omp-admin-view> — Administration-Tab (Kapitel 11 Teil 1,
// docs/END-GOAL-FEATURES.md §11.4): Nutzerverwaltung + Bootstrap-erster-
// Nutzer, Rollenbindungs-CRUD, Audit-Log — alles bereits vorhandene
// Backend-Endpunkte (D3 Teil 2), nur bisher ohne UI erreichbar. Nur
// gemountet, wenn app-shell.ts per whoami().isAdmin grünes Licht gibt
// (admin-Verb ODER Bootstrap-Modus, s. auth_handlers.go:handleWhoami) —
// dieser View selbst verlässt sich zusätzlich auf die serverseitige
// admin-only-Gate der Endpunkte, kein rein clientseitiges Vertrauen.
//
// Bewusst kein Poll-/SSE-Refresh für Nutzer/Bindungen (anders als
// hosts-view.ts/workflows-view.ts): ein offenes Formular würde bei
// jedem Rerender Fokus/Cursor verlieren. Stattdessen einmaliges Laden +
// gezieltes Neuladen nach jeder Mutation. Nur das rein lesende
// Audit-Log aktualisiert sich automatisch, das stört kein offenes
// Formular.
//
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): das
// Audit-Log reagiert auf "audit.appended" (neu, audit.go) statt alle
// paar Sekunden zu pollen. Poll bleibt nur als deutlich langsamerer
// Reconnect-/Fallback-Pfad (AUDIT_POLL_FALLBACK_INTERVAL_MS).
import { apiFetch, connectionMonitor } from "./connection.ts";
import { getToken, login } from "./auth.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";

interface UserEntry {
  id: string;
  username: string;
  createdAt: string;
  isAdmin: boolean;
}

interface RoleBinding {
  id: string;
  subject: string;
  // Kapitel 12 Teil 4 (docs/END-GOAL-FEATURES.md §12.3e): leer = global/
  // Node-gescoped (unverändert); gesetzt = Workflow-Scope, nodeId ist
  // dann ein Rollenname statt einer Instanz-ID.
  workflowId?: string;
  nodeId: string;
  verb: string;
}

// WorkflowSummary — nur die für den Scope-Selector nötigen Felder.
interface WorkflowSummary {
  id: string;
  name: string;
  definition: { roles: { name: string; nodeType: string }[] };
}

interface AuditEntry {
  id: number;
  occurredAt: string;
  username: string;
  method: string;
  path: string;
  nodeId?: string;
  status: number;
}

interface NodeEntry {
  id: string;
  label: string;
  instanceId?: string;
}

// ClusterStatus/ClusterPeer — Wire-Format identisch zu
// orchestrator/internal/cluster::Status/Peer (ARCHITECTURE.md §19.3,
// UMSETZUNG.md D12). Nur die Felder, die dieser View tatsächlich
// anzeigt (kein FSMVersion/PeerHTTPAddrs-Bedarf hier).
interface ClusterPeer {
  id: string;
  raftAddr: string;
  suffrage: string;
}

interface ClusterStatus {
  nodeId: string;
  raftAddr: string;
  httpAddr?: string;
  state: string;
  isLeader: boolean;
  leaderId?: string;
  leaderRaftAddr?: string;
  leaderHttpAddr?: string;
  term: number;
  appliedIndex: number;
  lastIndex: number;
  peers: ClusterPeer[];
}

// CatalogEntry — Wire-Format identisch zu orchestrator/internal/
// launcher/catalog.go::CatalogEntry (§17 Teil 4/5). Runner ist bei
// eigenen (statischen) Einträgen immer "process", bei importierten
// immer "podman" (`Launcher.ImportCatalogEntry` erzwingt das serverseitig
// hart — s. dortige Doku) — genau dieses Feld unterscheidet unten
// entfernbare (importierte) von statischen Einträgen, kein separates
// Flag nötig.
interface CatalogEntry {
  type: string;
  label: string;
  runner: string;
  command: string[];
  image?: string;
  env: Record<string, string>;
  description?: string;
  expectedResources?: string;
  version?: string;
}

// AdmissionResult — Wire-Format identisch zu tools/contract-check/
// checker::Result (Name/Status/Detail), wie sie writeCatalogImportError
// (launcher_handlers.go) im 422-Body unter "results" mitliefert.
interface AdmissionResult {
  Name: string;
  Status: "PASS" | "FAIL" | "SKIP";
  Detail: string;
}

const AUDIT_POLL_FALLBACK_INTERVAL_MS = 30000;
const AUDIT_REFRESH_EVENT_TYPES = new Set(["audit.appended", "lost-events"]);
// AUDIT_PAGE_LIMIT (S5, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) —
// muss <= server.go's maxAuditLogLimit (200) sein, sonst kappt der
// Server ohnehin; als eigene Konstante statt einer Magic Number an
// beiden Aufrufstellen unten (#loadAudit/#loadMoreAudit).
const AUDIT_PAGE_LIMIT = 50;

const VERBS = ["view", "operate", "configure", "admin"] as const;

const VERB_LABEL: Record<string, string> = {
  view: "Ansehen",
  operate: "Bedienen",
  configure: "Konfigurieren",
  admin: "Administrieren",
};

// Nutzerwunsch 2026-08-13: die vier Abschnitte liefen bisher als eine
// einzige, lang scrollende Seite untereinander — bei vier unabhängigen
// Tabellen (Nutzer/Rollenbindungen/Node-Katalog/Audit-Log) unnötig
// unübersichtlich. Eigene, kleine Sub-Tab-Leiste statt eines weiteren
// Eintrags in app-shell.ts' TabDef-Liste (dort sind Tabs eigene
// Custom-Element-Instanzen mit eigenem Lifecycle — hier sind es vier
// Methoden auf demselben Element mit gemeinsam geladenen Daten, ein
// Wechsel darf kein Neuladen auslösen). Style bewusst dieselbe CSS-
// Formel wie app-shell.ts' TAB_BUTTON_BASE/#styleTabButton (visuelle
// Konsistenz), aber als eigene, kleine Kopie hier — admin-view.ts
// importiert nichts aus app-shell.ts und umgekehrt (gleiches Muster wie
// die anderen kleinen bewussten Dopplungen im Projekt, z. B.
// STREAM_TOKEN_KEY in flow-canvas.ts).
type AdminTabId = "users" | "bindings" | "catalog" | "audit" | "backup" | "cluster";
const ADMIN_SUB_TABS: { id: AdminTabId; label: string }[] = [
  { id: "users", label: "Nutzer" },
  { id: "bindings", label: "Rollenbindungen" },
  { id: "catalog", label: "Node-Katalog" },
  { id: "audit", label: "Audit-Log" },
  { id: "backup", label: "Backup/Restore" },
  { id: "cluster", label: "Cluster" },
];
const SUB_TAB_BUTTON_BASE =
  "border:1px solid transparent;border-radius:var(--omp-radius);" +
  "padding:6px 12px;font-size:var(--omp-font-size-sm);font-family:var(--omp-font);cursor:pointer;";

class AdminView extends HTMLElement {
  // Nutzerwunsch 2026-08-13: welcher der vier Abschnitte gerade sichtbar
  // ist — überlebt #render()-Aufrufe (Klassenfeld, nicht in #render()
  // neu initialisiert), damit ein Datennachladen (#loadUsers() etc.)
  // oder eine Mutation nicht auf "Nutzer" zurückspringt.
  #activeAdminTab: AdminTabId = "users";
  #users: UserEntry[] = [];
  #bindings: RoleBinding[] = [];
  #audit: AuditEntry[] = [];
  // S5: true, solange die letzte geladene Seite genau AUDIT_PAGE_LIMIT
  // Einträge enthielt — dann könnte eine weitere Seite existieren
  // (kein zusätzlicher COUNT(*) nötig, s. audit.Store.List-Doku).
  #auditHasMore = false;
  #auditLoadingMore = false;
  #nodes: NodeEntry[] = [];
  #workflows: WorkflowSummary[] = [];
  #error = "";
  #showUserForm = false;
  #newUsername = "";
  #newPassword = "";
  #resetTarget: string | null = null;
  #resetPassword = "";
  #showBindingForm = false;
  #newSubject = "";
  #newNodeId = "*";
  #newVerb = "operate";
  // Kapitel 12 Teil 4: "" = global/Node-gescoped (unverändertes
  // Verhalten), sonst die Workflow-ID — schaltet das Node-ID-Feld unten
  // von "Instanz-ID" auf "Rollenname" um.
  #newWorkflowId = "";
  #auditPollHandle: number | undefined;

  // §17 Teil 4/5 Import/Export-UI (Nutzerwunsch: "node/microservice
  // import/export machen") — reine UI-Anbindung, Backend existiert
  // bereits vollständig inkl. C9-Admission-Check und Versionierung.
  #catalog: CatalogEntry[] = [];
  #showCatalogForm = false;
  #newCatalogType = "";
  #newCatalogLabel = "";
  #newCatalogImage = "";
  #newCatalogVersion = "";
  #newCatalogDescription = "";
  #newCatalogExpectedResources = "";
  #newCatalogCommand = "";
  #newCatalogEnvText = "{}";
  // Ergebnis des letzten fehlgeschlagenen Admission-Checks (422) —
  // separat von #error gerendert (Tabelle statt Fließtext), da genau
  // diese Detailauflösung der eigentliche Zweck des Checks ist.
  #admissionResults: AdmissionResult[] | null = null;

  // Nutzerwunsch 2026-08-13 ("generelles Backup/Restore über das
  // Browser-UI"): Backup und Restore laufen jetzt beide über die GUI.
  // Restore braucht den eigenständigen, immer laufenden Supervisor-
  // Prozess (der Orchestrator kann sich nicht selbst befehlen, sich zu
  // stoppen, während er den Restore-Request gerade beantwortet —
  // Nutzerentscheidung 2026-08-13, s. supervisor/main.go), der
  // Orchestrator-Prozess ist während eines Restores für einige Sekunden
  // nicht erreichbar — #restoring/#reconnecting bilden das im UI ab
  // (Overlay statt einer scheinbar hängenden Seite), #restoreSelected/
  // #restoreTyped sind die "Dateinamen exakt eintippen"-Bestätigung
  // (gleiche Reibung wie restore-omp.shs "yes"-Eingabe, hier aber
  // dateiname-spezifisch statt generisch, damit sichtbar wird, WAS
  // gerade zurückgespielt wird, nicht nur DASS bestätigt wurde).
  #backups: string[] = [];
  #creatingBackup = false;
  #restoreSelected = "";
  #restoreTyped = "";
  #restoring = false;
  #reconnecting = false;

  // Cluster-Sub-Tab (ARCHITECTURE.md §19.3, UMSETZUNG.md D12) — die
  // bisher UI-lose Raft-Status-/Join-/Leave-API bekommt hier eine
  // Oberfläche (Nutzerauftrag 2026-08-27, gleicher Anlass wie
  // host-wizard.ts). Kein eigener Poll-Loop (anders als hosts-view.ts):
  // kein SSE-Event für Cluster-Änderungen existiert, ein manueller
  // "Aktualisieren"-Button genügt für einen selten wechselnden
  // Control-Plane-Zustand — gleiche Zurückhaltung wie die übrigen
  // admin-view.ts-Abschnitte (Laden einmalig + gezielt nach Mutation).
  #cluster: ClusterStatus | null = null;
  #showClusterJoinForm = false;
  #newClusterNodeId = "";
  #newClusterRaftAddr = "";
  #newClusterHttpAddr = "";

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render();
    this.#loadUsers();
    this.#loadBindings();
    this.#loadAudit();
    this.#loadNodes();
    this.#loadWorkflows();
    this.#loadCatalog();
    this.#loadBackups();
    this.#loadClusterStatus();
    this.#auditPollHandle = window.setInterval(() => this.#loadAudit(), AUDIT_POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#auditPollHandle !== undefined) window.clearInterval(this.#auditPollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (AUDIT_REFRESH_EVENT_TYPES.has(parsed.type)) this.#loadAudit();
  };

  async #loadUsers() {
    try {
      const res = await apiFetch("/api/v1/auth/users");
      if (res.ok) {
        this.#users = await res.json();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  async #loadBindings() {
    try {
      const res = await apiFetch("/api/v1/admin/role-bindings");
      if (res.ok) {
        this.#bindings = await res.json();
        this.#render();
      }
    } catch {
      // s.o.
    }
  }

  // S5: lädt immer die erste (neueste) Seite und ersetzt #audit
  // komplett — der richtige Reflex bei "audit.appended"/"lost-events"
  // (neue Zeile(n) seit dem letzten Stand) und beim Fallback-Poll,
  // nicht bei "Mehr laden" (das hängt an, s. #loadMoreAudit).
  async #loadAudit() {
    try {
      const res = await apiFetch(`/api/v1/admin/audit-log?limit=${AUDIT_PAGE_LIMIT}`);
      if (res.ok) {
        const page: AuditEntry[] = await res.json();
        this.#audit = page;
        this.#auditHasMore = page.length === AUDIT_PAGE_LIMIT;
        this.#render();
      }
    } catch {
      // s.o.
    }
  }

  // S5: "Mehr laden" — hängt die nächste Seite an, per Cursor (kleinste
  // bisher geladene ID) statt eines Offsets (robust gegen neue Zeilen,
  // die zwischen zwei Klicks dazukommen — die verschieben einen
  // Offset, nicht aber die Cursor-ID).
  async #loadMoreAudit() {
    if (this.#auditLoadingMore || this.#audit.length === 0) return;
    this.#auditLoadingMore = true;
    this.#render();
    try {
      const oldestID = this.#audit[this.#audit.length - 1].id;
      const res = await apiFetch(`/api/v1/admin/audit-log?before=${oldestID}&limit=${AUDIT_PAGE_LIMIT}`);
      if (res.ok) {
        const page: AuditEntry[] = await res.json();
        this.#audit = [...this.#audit, ...page];
        this.#auditHasMore = page.length === AUDIT_PAGE_LIMIT;
      }
    } catch {
      // Nächster Klick versucht es erneut — kein Retry-Automatismus nötig.
    } finally {
      this.#auditLoadingMore = false;
      this.#render();
    }
  }

  async #loadNodes() {
    try {
      const res = await apiFetch("/api/v1/nodes");
      if (res.ok) {
        this.#nodes = await res.json();
        // Nur neu rendern, wenn die Node-Datalist tatsächlich gerade
        // sichtbar ist — sonst kein Grund, ein evtl. offenes
        // Nutzer-Formular anzufassen.
        if (this.#showBindingForm) this.#render();
      }
    } catch {
      // Node-Liste ist nur eine Eingabehilfe für das Bindungs-Formular,
      // kein Hard-Requirement.
    }
  }

  // Kapitel 12 Teil 4: Workflow-Liste für den Scope-Selector im
  // Bindungs-Formular — reine Eingabehilfe wie #loadNodes, kein
  // Hard-Requirement.
  async #loadWorkflows() {
    try {
      const res = await apiFetch("/api/v1/workflows");
      if (res.ok) {
        this.#workflows = await res.json();
        if (this.#showBindingForm) this.#render();
      }
    } catch {
      // s. o.
    }
  }

  async #createUser() {
    if (!this.#newUsername || !this.#newPassword) return;
    const username = this.#newUsername;
    const password = this.#newPassword;
    const res = await apiFetch("/api/v1/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      this.#error = `Nutzer anlegen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#newUsername = "";
    this.#newPassword = "";
    this.#showUserForm = false;

    // Bootstrap-Fall (Kapitel 11 Teil 1, §11.4): kein Token im Speicher
    // heißt, wir liefen bis eben im Bootstrap-Bypass (UserCount()==0,
    // s. auth_handlers.go:handleWhoami) — sonst hätte dieser admin-only
    // Aufruf selbst schon ein Token gebraucht. Der gerade angelegte
    // Nutzer bekam als allererster automatisch die Wildcard-admin-
    // Bindung (handleCreateUser), also gleich als er/sie einloggen und
    // neu laden — sonst bliebe die aktuelle Sitzung ohne Token stecken,
    // während UserCount ab jetzt eine echte Anmeldung verlangt, und jeder
    // weitere Admin-Aufruf in diesem Tab würde ins Leere laufen (401).
    if (!getToken()) {
      try {
        await login(username, password);
        location.reload();
        return;
      } catch {
        this.#error = "Nutzer angelegt, automatische Anmeldung fehlgeschlagen — bitte manuell anmelden.";
        this.#render();
        return;
      }
    }

    await this.#loadUsers();
  }

  async #deleteUser(username: string) {
    if (!(await confirmDialog(`Nutzer "${username}" wirklich löschen?`, { confirmLabel: "Löschen" }))) return;
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Löschen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadUsers();
  }

  async #submitPasswordReset(username: string) {
    if (!this.#resetPassword) return;
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.#resetPassword }),
    });
    if (!res.ok) {
      this.#error = `Passwort-Reset fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#resetTarget = null;
    this.#resetPassword = "";
    this.#render();
  }

  async #createBinding() {
    if (!this.#newSubject || !this.#newNodeId) return;
    const res = await apiFetch("/api/v1/admin/role-bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: this.#newSubject,
        workflowId: this.#newWorkflowId || undefined,
        nodeId: this.#newNodeId,
        verb: this.#newVerb,
      }),
    });
    if (!res.ok) {
      this.#error = `Rollenbindung anlegen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#newSubject = "";
    this.#newWorkflowId = "";
    this.#newNodeId = "*";
    this.#showBindingForm = false;
    await this.#loadBindings();
  }

  async #deleteBinding(binding: RoleBinding) {
    // Bisher ohne jede Bestätigung (S10, docs/REVIEW-2026-07-17-
    // SKALIERUNG-24-7.md) — ein Fehlklick entzog sofort ein Zugriffsrecht,
    // ohne Rückfrage. Gleiches Confirm-Muster wie #deleteUser.
    const label = this.#scopeLabel(binding);
    if (
      !(await confirmDialog(`Rollenbindung "${binding.subject}" → ${label} (${VERB_LABEL[binding.verb] ?? binding.verb}) wirklich löschen?`, {
        confirmLabel: "Löschen",
      }))
    ) {
      return;
    }
    const res = await apiFetch(`/api/v1/admin/role-bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Löschen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadBindings();
  }

  async #loadCatalog() {
    try {
      const res = await apiFetch("/api/v1/catalog");
      if (res.ok) {
        this.#catalog = await res.json();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  async #loadBackups() {
    try {
      const res = await apiFetch("/api/v1/admin/backups");
      if (res.ok) {
        this.#backups = await res.json();
        this.#render();
      }
    } catch {
      // s.o.
    }
  }

  // Gleiches Blob+<a download>-Muster wie workflows-view.ts'
  // #exportWorkflow — POST erstellt eine neue Sicherung UND liefert sie
  // direkt zurück (kein zweiter Request nötig), Download startet sofort.
  async #createBackup() {
    this.#creatingBackup = true;
    this.#error = "";
    this.#render();
    try {
      const res = await apiFetch("/api/v1/admin/backup", { method: "POST" });
      if (!res.ok) {
        this.#error = `Backup fehlgeschlagen: ${await res.text()}`;
        return;
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "backup.sql.gz";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      // Kein zusätzlicher Erfolgs-Hinweis nötig — der gestartete Download
      // plus die neue Zeile in der (gleich neu geladenen) Backup-Liste
      // sind die Bestätigung, gleiches Prinzip wie überall sonst in
      // dieser Datei (z. B. #createUser: die neue Zeile IST die
      // Bestätigung, kein separater Toast).
      await this.#loadBackups();
    } catch (err) {
      this.#error = `Backup fehlgeschlagen: ${err}`;
    } finally {
      this.#creatingBackup = false;
      this.#render();
    }
  }

  // Lädt eine bereits vorhandene Sicherung erneut herunter — gleiches
  // Blob-Muster wie #createBackup (nicht per direktem <a href>-Link:
  // der Token steckt im localStorage, nicht in einem automatisch
  // mitgeschickten Cookie, s. connection.ts — ein simpler Link ohne
  // Authorization-Header bekäme 401, apiFetch() muss den Request
  // stellen).
  #downloadBackup(name: string) {
    void (async () => {
      try {
        const res = await apiFetch(`/api/v1/admin/backups/${encodeURIComponent(name)}`);
        if (!res.ok) {
          this.#error = `Download fehlgeschlagen: ${await res.text()}`;
          this.#render();
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        this.#error = `Download fehlgeschlagen: ${err}`;
        this.#render();
      }
    })();
  }

  // Löst POST /api/v1/admin/restore aus — nur erreichbar, wenn
  // #restoreTyped exakt #restoreSelected entspricht (s. #restoreSelected-
  // Doku), plus eine zusätzliche confirmDialog()-Rückfrage direkt davor
  // (gleiches Muster wie überall sonst in dieser Datei für destruktive
  // Aktionen, z. B. #removeRole in role-designer.ts).
  async #restoreDatabase() {
    if (!this.#restoreSelected || this.#restoreTyped !== this.#restoreSelected) return;
    const confirmed = await confirmDialog(
      `Backup „${this.#restoreSelected}" wirklich zurückspielen? Dies ERSETZT den kompletten ` +
        `aktuellen Datenbankinhalt (Nutzer, Rollenbindungen, Audit-Log, Layouts, Snapshots, ` +
        `Workflows, Hosts) unwiderruflich.`,
      { confirmLabel: "Zurückspielen" },
    );
    if (!confirmed) return;

    this.#restoring = true;
    this.#error = "";
    this.#render();
    try {
      const res = await apiFetch("/api/v1/admin/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: this.#restoreSelected, confirm: true }),
      });
      if (!res.ok) {
        // Klarer Fehlschlag VOR dem eigentlichen Restore (Validierung,
        // Supervisor nicht erreichbar) — der Orchestrator lebt
        // unverändert weiter, kein Reconnect-Overlay nötig.
        this.#error = `Restore fehlgeschlagen: ${await res.text()}`;
        this.#restoring = false;
        this.#render();
        return;
      }
    } catch {
      // Ein Netzwerkfehler HIER ist mehrdeutig: entweder eine echte
      // Verbindungsstörung, oder der Orchestrator-Prozess ist bereits
      // mitten in der Antwort gestorben (s. supervisor/main.go
      // sleepBeforeStop-Doku — ein knappes Zeitfenster bleibt trotz der
      // Verzögerung theoretisch möglich). Beide Fälle behandelt die
      // Reconnect-Logik unten identisch, statt einen für den Nutzer
      // nicht unterscheidbaren Fehler zu zeigen.
    }
    this.#waitForReconnectAndReload();
  }

  #waitForReconnectAndReload() {
    this.#restoring = false;
    this.#reconnecting = true;
    this.#render();
    const poll = () => {
      fetch("/healthz")
        .then((res) => {
          if (res.ok) {
            window.location.reload();
            return;
          }
          setTimeout(poll, 1000);
        })
        .catch(() => setTimeout(poll, 1000));
    };
    // Anfangsverzögerung: der alte Prozess braucht selbst nach dem
    // Antworten noch einen Moment, um tatsächlich zu sterben (s.
    // supervisor/main.go sleepBeforeStop) — ein sofortiger erster Poll
    // träfe fast immer noch ihn selbst und meldete fälschlich "schon
    // wieder da", bevor der eigentliche Neustart überhaupt begonnen hat.
    setTimeout(poll, 2000);
  }

  // Füllt das Formular aus einer zuvor per #exportCatalogEntry
  // heruntergeladenen (oder von einem anderen OMP-Deployment
  // stammenden) JSON-Datei — reiner Komfort für den Import-Rundlauf,
  // der eigentliche Sicherheitsnetz bleibt der serverseitige
  // Admission-Check bei "Importieren", nicht diese Vorbefüllung.
  async #loadCatalogFromFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<CatalogEntry>;
      this.#newCatalogType = parsed.type ?? "";
      this.#newCatalogLabel = parsed.label ?? "";
      this.#newCatalogImage = parsed.image ?? "";
      this.#newCatalogVersion = parsed.version ?? "";
      this.#newCatalogDescription = parsed.description ?? "";
      this.#newCatalogExpectedResources = parsed.expectedResources ?? "";
      this.#newCatalogCommand = (parsed.command ?? []).join(" ");
      this.#newCatalogEnvText = JSON.stringify(parsed.env ?? {}, null, 2);
      this.#error = "";
    } catch {
      this.#error = "Datei konnte nicht als Katalog-Eintrag gelesen werden (ungültiges JSON).";
    }
    this.#render();
  }

  async #importCatalogEntry() {
    if (!this.#newCatalogType || !this.#newCatalogImage) return;
    let env: Record<string, string>;
    try {
      env = JSON.parse(this.#newCatalogEnvText || "{}");
    } catch {
      this.#error = "Env muss gültiges JSON sein (Objekt aus String-Paaren), z. B. {}";
      this.#render();
      return;
    }
    const entry: CatalogEntry = {
      type: this.#newCatalogType,
      label: this.#newCatalogLabel || this.#newCatalogType,
      runner: "podman",
      command: this.#newCatalogCommand.trim() ? this.#newCatalogCommand.trim().split(/\s+/) : [],
      image: this.#newCatalogImage,
      env,
      description: this.#newCatalogDescription || undefined,
      expectedResources: this.#newCatalogExpectedResources || undefined,
      version: this.#newCatalogVersion || undefined,
    };

    const res = await apiFetch("/api/v1/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      if (res.status === 422) {
        const body = await res.json();
        this.#admissionResults = body.results ?? [];
        this.#error = "";
      } else {
        this.#admissionResults = null;
        this.#error = `Import fehlgeschlagen: ${await res.text()}`;
      }
      this.#render();
      return;
    }
    this.#error = "";
    this.#admissionResults = null;
    this.#newCatalogType = "";
    this.#newCatalogLabel = "";
    this.#newCatalogImage = "";
    this.#newCatalogVersion = "";
    this.#newCatalogDescription = "";
    this.#newCatalogExpectedResources = "";
    this.#newCatalogCommand = "";
    this.#newCatalogEnvText = "{}";
    this.#showCatalogForm = false;
    await this.#loadCatalog();
  }

  async #removeCatalogEntry(entry: CatalogEntry) {
    const versionLabel = entry.version ? ` (Version ${entry.version})` : "";
    if (!(await confirmDialog(`Katalog-Eintrag "${entry.label}"${versionLabel} wirklich entfernen?`, { confirmLabel: "Entfernen" })))
      return;
    const q = entry.version ? `?version=${encodeURIComponent(entry.version)}` : "";
    const res = await apiFetch(`/api/v1/catalog/${encodeURIComponent(entry.type)}${q}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Entfernen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadCatalog();
  }

  // Export = derselbe CatalogEntry, den GET /api/v1/catalog ohnehin
  // schon liefert, als herunterladbare Datei — kein neuer Backend-Weg
  // nötig. Dateiname enthält die Version (falls gesetzt), damit
  // mehrere exportierte Versionen desselben Typs nicht überschreiben.
  #exportCatalogEntry(entry: CatalogEntry) {
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entry.type}${entry.version ? `-${entry.version}` : ""}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async #loadClusterStatus() {
    try {
      const res = await apiFetch("/api/v1/cluster/status");
      if (res.ok) {
        this.#cluster = await res.json();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — "Aktualisieren" versucht es erneut.
    }
  }

  // Join wird auf dem Leader ausgeführt (server-seitig transparent
  // weitergeleitet, falls diese Instanz nicht selbst Leader ist —
  // s. cluster_handlers.go:forwardToLeader) — kein eigener
  // Leader-Check hier nötig.
  async #joinClusterMember() {
    const nodeId = this.#newClusterNodeId.trim();
    const raftAddr = this.#newClusterRaftAddr.trim();
    if (!nodeId || !raftAddr) return;
    const res = await apiFetch("/api/v1/cluster/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, raftAddr, httpAddr: this.#newClusterHttpAddr.trim() || undefined }),
    });
    if (!res.ok) {
      this.#error = `Beitritt fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#showClusterJoinForm = false;
    this.#newClusterNodeId = "";
    this.#newClusterRaftAddr = "";
    this.#newClusterHttpAddr = "";
    this.#cluster = await res.json();
    this.#render();
  }

  async #leaveClusterMember(peer: ClusterPeer) {
    if (
      !(await confirmDialog(`Mitglied "${peer.id}" (${peer.raftAddr}) wirklich aus dem Cluster entfernen?`, {
        confirmLabel: "Entfernen",
      }))
    )
      return;
    const res = await apiFetch(`/api/v1/cluster/members/${encodeURIComponent(peer.id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Entfernen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#cluster = await res.json();
    this.#render();
  }

  // buildClusterJoinSnippet: das kopierbare Env-Variablen-Skript für
  // die NEUE Instanz (host-wizard.ts' #buildSnippet-Pendant für den
  // Cluster-Fall) — Variablennamen aus config.go verifiziert (OMP_NODE_ID/
  // OMP_RAFT_LISTEN/OMP_RAFT_DATA_DIR/OMP_CLUSTER_JOIN), nicht geraten.
  // Postgres/NATS/Registry bewusst NICHT wiederholt: das ist identisch
  // zu jeder anderen Orchestrator-Instanz, kein Cluster-Spezifikum.
  #buildClusterJoinSnippet(): string {
    const nodeId = this.#newClusterNodeId.trim() || "<Node-ID>";
    const raftAddr = this.#newClusterRaftAddr.trim() || "<von anderen Instanzen erreichbare host:port-Adresse>";
    const httpAddr = this.#newClusterHttpAddr.trim();
    const lines = [
      "# Auf der NEUEN Instanz ausführen. Startet passiv (kein Selbst-",
      "# Bootstrap, ARCHITECTURE.md §19.3) und wartet, bis sie über",
      '# „Jetzt beitreten lassen" unten aufgenommen wird. OMP_POSTGRES_URL/',
      "# OMP_NATS_URL/OMP_REGISTRY_URL wie bei jeder anderen Instanz setzen",
      "# (identische, bereits geteilte Infrastruktur) — hier nur die",
      "# cluster-spezifischen Variablen.",
      `OMP_NODE_ID="${nodeId}" \\`,
      `OMP_RAFT_LISTEN="${raftAddr}" \\`,
      `OMP_RAFT_DATA_DIR="../data/raft/${nodeId}" \\`,
      "OMP_CLUSTER_JOIN=true \\",
    ];
    if (httpAddr) lines.push(`OMP_ORCHESTRATOR_URL="${httpAddr}" \\`);
    lines.push("./orchestrator");
    return lines.join("\n");
  }

  #render() {
    this.replaceChildren();

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:700;font-size:var(--omp-font-size-md);margin-bottom:var(--omp-space-3);";
    heading.textContent = "Administration";
    this.appendChild(heading);

    if (this.#error) {
      const err = document.createElement("div");
      err.style.cssText =
        "color:var(--omp-error);background:rgba(239,83,80,0.1);border:1px solid var(--omp-error);" +
        "border-radius:var(--omp-radius);padding:var(--omp-space-2);margin-bottom:var(--omp-space-3);white-space:pre-wrap;";
      err.textContent = this.#error;
      this.appendChild(err);
    }

    this.appendChild(this.#renderTabBar());

    switch (this.#activeAdminTab) {
      case "users":
        this.appendChild(this.#renderUsersSection());
        break;
      case "bindings":
        this.appendChild(this.#renderBindingsSection());
        break;
      case "catalog":
        this.appendChild(this.#renderCatalogSection());
        break;
      case "audit":
        this.appendChild(this.#renderAuditSection());
        break;
      case "backup":
        this.appendChild(this.#renderBackupSection());
        break;
      case "cluster":
        this.appendChild(this.#renderClusterSection());
        break;
    }
  }

  #renderTabBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.setAttribute("data-role", "admin-sub-tabs");
    bar.style.cssText = "display:flex;gap:var(--omp-space-2);margin-bottom:var(--omp-space-3);";
    for (const tab of ADMIN_SUB_TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tab.label;
      btn.setAttribute("data-tab-id", tab.id);
      const isActive = tab.id === this.#activeAdminTab;
      btn.style.cssText =
        SUB_TAB_BUTTON_BASE +
        (isActive
          ? "background:var(--omp-surface-raised);color:var(--omp-text);border-color:var(--omp-border);"
          : "background:transparent;color:var(--omp-text-dim);");
      btn.addEventListener("click", () => {
        this.#activeAdminTab = tab.id;
        this.#render();
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  #renderUsersSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = `Nutzer (${this.#users.length})`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showUserForm ? "Abbrechen" : "+ Neuer Nutzer";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showUserForm = !this.#showUserForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    if (this.#showUserForm) {
      section.appendChild(this.#renderUserForm());
    }

    if (this.#users.length === 0 && !this.#showUserForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = 'Noch kein Nutzer angelegt — mit "+ Neuer Nutzer" den ersten (Admin-)Nutzer anlegen.';
      section.appendChild(empty);
      return section;
    }

    if (this.#users.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Nutzername</th>
        <th style="padding:2px 8px;">Angelegt</th>
        <th style="padding:2px 8px;">Rolle</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const u of this.#users) {
        tbody.appendChild(this.#renderUserRow(u));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderUserForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const userInput = document.createElement("input");
    userInput.placeholder = "Nutzername";
    userInput.autocomplete = "off";
    userInput.value = this.#newUsername;
    userInput.style.cssText = "flex:1;min-width:100px;";
    userInput.addEventListener("input", () => {
      this.#newUsername = userInput.value;
    });

    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = "Passwort";
    passInput.autocomplete = "new-password";
    passInput.value = this.#newPassword;
    passInput.style.cssText = "flex:1;min-width:100px;";
    passInput.addEventListener("input", () => {
      this.#newPassword = passInput.value;
    });
    passInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#createUser();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Anlegen";
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createUser());

    form.append(userInput, passInput, createBtn);
    return form;
  }

  #renderUserRow(u: UserEntry): HTMLElement {
    const isResetting = this.#resetTarget === u.username;
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.style.cssText = "padding:2px 8px;";
    nameTd.textContent = u.username;
    tr.appendChild(nameTd);

    const createdTd = document.createElement("td");
    createdTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    createdTd.textContent = new Date(u.createdAt).toLocaleString();
    tr.appendChild(createdTd);

    const roleTd = document.createElement("td");
    roleTd.style.cssText = "padding:2px 8px;";
    if (u.isAdmin) {
      const badge = document.createElement("span");
      badge.textContent = "Admin";
      badge.style.cssText = "color:var(--omp-preset);font-size:var(--omp-font-size-xs);font-weight:600;";
      roleTd.appendChild(badge);
    } else {
      roleTd.textContent = "–";
    }
    tr.appendChild(roleTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;white-space:nowrap;";

    if (isResetting) {
      const pwInput = document.createElement("input");
      pwInput.type = "password";
      pwInput.placeholder = "neues Passwort";
      pwInput.autocomplete = "new-password";
      pwInput.style.cssText = "font-size:11px;width:120px;";
      pwInput.value = this.#resetPassword;
      pwInput.addEventListener("input", () => {
        this.#resetPassword = pwInput.value;
      });
      pwInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") this.#submitPasswordReset(u.username);
      });

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "OK";
      confirmBtn.style.cssText = "font-size:11px;cursor:pointer;";
      confirmBtn.addEventListener("click", () => this.#submitPasswordReset(u.username));

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "×";
      cancelBtn.style.cssText = "cursor:pointer;";
      cancelBtn.addEventListener("click", () => {
        this.#resetTarget = null;
        this.#resetPassword = "";
        this.#render();
      });

      actionsTd.append(pwInput, confirmBtn, cancelBtn);
      tr.appendChild(actionsTd);
      queueMicrotask(() => pwInput.focus());
      return tr;
    }

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Passwort";
    resetBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    resetBtn.addEventListener("click", () => {
      this.#resetTarget = u.username;
      this.#resetPassword = "";
      this.#render();
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => this.#deleteUser(u.username));

    actionsTd.append(resetBtn, delBtn);
    tr.appendChild(actionsTd);
    return tr;
  }

  #renderBindingsSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = `Rollenbindungen (${this.#bindings.length})`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showBindingForm ? "Abbrechen" : "+ Neue Bindung";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showBindingForm = !this.#showBindingForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    if (this.#showBindingForm) {
      section.appendChild(this.#renderBindingForm());
    }

    if (this.#bindings.length === 0 && !this.#showBindingForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Noch keine Rollenbindung angelegt.";
      section.appendChild(empty);
      return section;
    }

    if (this.#bindings.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Nutzer</th>
        <th style="padding:2px 8px;">Bereich</th>
        <th style="padding:2px 8px;">Recht</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const b of this.#bindings) {
        tbody.appendChild(this.#renderBindingRow(b));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderBindingForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const subjectInput = document.createElement("input");
    subjectInput.placeholder = "Nutzername";
    subjectInput.value = this.#newSubject;
    subjectInput.style.cssText = "flex:1;min-width:100px;";
    subjectInput.addEventListener("input", () => {
      this.#newSubject = subjectInput.value;
    });

    // Kapitel 12 Teil 4 (§12.3e): Scope-Auswahl — "(Global)" ist das
    // unveränderte Vor-Kapitel-12-Teil-4-Verhalten (Node-ID/Instanz-ID
    // unten), ein gewählter Workflow schaltet das Feld darunter auf
    // Rollennamen um (stabil über Rollen-Neustarts, anders als eine
    // Instanz-ID).
    const workflowSelect = document.createElement("select");
    workflowSelect.style.cssText = "min-width:140px;";
    const globalOpt = document.createElement("option");
    globalOpt.value = "";
    globalOpt.textContent = "(Global)";
    workflowSelect.appendChild(globalOpt);
    for (const wf of this.#workflows) {
      const opt = document.createElement("option");
      opt.value = wf.id;
      opt.textContent = wf.name;
      if (wf.id === this.#newWorkflowId) opt.selected = true;
      workflowSelect.appendChild(opt);
    }
    workflowSelect.addEventListener("change", () => {
      this.#newWorkflowId = workflowSelect.value;
      // Ein Rollenname aus dem alten Scope ergibt im neuen keinen Sinn
      // (oder umgekehrt) — auf den jeweiligen "alle"-Default zurücksetzen
      // statt einen ungültigen Wert stehen zu lassen.
      this.#newNodeId = "*";
      this.#render();
    });

    const datalistId = "omp-admin-node-datalist";
    const selectedWorkflow = this.#workflows.find((wf) => wf.id === this.#newWorkflowId);
    const nodeInput = document.createElement("input");
    nodeInput.placeholder = selectedWorkflow ? "Rollenname (* = ganzer Workflow)" : "Node-ID (* = alle Nodes)";
    nodeInput.value = this.#newNodeId;
    nodeInput.setAttribute("list", datalistId);
    nodeInput.style.cssText = "flex:1;min-width:160px;";
    nodeInput.addEventListener("input", () => {
      this.#newNodeId = nodeInput.value;
    });

    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    const anyOpt = document.createElement("option");
    anyOpt.value = "*";
    anyOpt.label = selectedWorkflow ? "Ganzer Workflow" : "Alle Nodes";
    datalist.appendChild(anyOpt);
    if (selectedWorkflow) {
      for (const role of selectedWorkflow.definition.roles) {
        const opt = document.createElement("option");
        opt.value = role.name;
        opt.label = `${role.name} (${role.nodeType})`;
        datalist.appendChild(opt);
      }
    } else {
      for (const n of this.#nodes) {
        const opt = document.createElement("option");
        opt.value = n.instanceId || n.id;
        opt.label = n.label;
        datalist.appendChild(opt);
      }
    }

    const verbSelect = document.createElement("select");
    for (const v of VERBS) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = VERB_LABEL[v];
      if (v === this.#newVerb) opt.selected = true;
      verbSelect.appendChild(opt);
    }
    verbSelect.addEventListener("change", () => {
      this.#newVerb = verbSelect.value;
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Anlegen";
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createBinding());

    form.append(subjectInput, workflowSelect, nodeInput, datalist, verbSelect, createBtn);
    return form;
  }

  #renderBindingRow(b: RoleBinding): HTMLElement {
    const tr = document.createElement("tr");

    const subjectTd = document.createElement("td");
    subjectTd.style.cssText = "padding:2px 8px;";
    subjectTd.textContent = b.subject;
    tr.appendChild(subjectTd);

    const scopeTd = document.createElement("td");
    scopeTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    scopeTd.textContent = this.#scopeLabel(b);
    tr.appendChild(scopeTd);

    const verbTd = document.createElement("td");
    verbTd.style.cssText = "padding:2px 8px;";
    verbTd.textContent = VERB_LABEL[b.verb] ?? b.verb;
    tr.appendChild(verbTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;";
    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => this.#deleteBinding(b));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    return tr;
  }

  #nodeLabel(nodeId: string): string {
    const n = this.#nodes.find((n) => n.instanceId === nodeId || n.id === nodeId);
    return n ? `${n.label} (${nodeId})` : nodeId;
  }

  // Kapitel 12 Teil 4 (§12.3e): "Bereich"-Spaltentext für eine Bindung —
  // global/Node-gescoped wie bisher, oder "<Workflow> → <Rolle>" bzw.
  // "<Workflow> (ganzer Workflow)" für eine Workflow-gescopte Bindung.
  #scopeLabel(b: RoleBinding): string {
    if (!b.workflowId) {
      return b.nodeId === "*" ? "Alle Nodes" : this.#nodeLabel(b.nodeId);
    }
    const wfName = this.#workflows.find((wf) => wf.id === b.workflowId)?.name ?? b.workflowId;
    return b.nodeId === "*" ? `${wfName} (ganzer Workflow)` : `${wfName} → ${b.nodeId}`;
  }

  #renderCatalogSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = `Node-Katalog: Import/Export (${this.#catalog.length})`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showCatalogForm ? "Abbrechen" : "+ Node/Microservice importieren";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showCatalogForm = !this.#showCatalogForm;
      this.#admissionResults = null;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:8px;";
    hint.textContent =
      "Importierte Microservices laufen als Podman-Container (OCI-Image) und durchlaufen vor der Aufnahme denselben Contract-Check wie `make contract` — ein Kandidat, der den Node-Contract nicht erfüllt, wird abgelehnt.";
    section.appendChild(hint);

    if (this.#showCatalogForm) {
      section.appendChild(this.#renderCatalogForm());
    }
    if (this.#admissionResults) {
      section.appendChild(this.#renderAdmissionResults(this.#admissionResults));
    }

    if (this.#catalog.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Typ</th>
        <th style="padding:2px 8px;">Label</th>
        <th style="padding:2px 8px;">Version</th>
        <th style="padding:2px 8px;">Herkunft</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      // Nutzerwunsch 2026-07-28: alphabetisch statt Katalog-Dateireihenfolge.
      const sortedCatalog = this.#catalog.slice().sort((a, b) => a.label.localeCompare(b.label));
      for (const entry of sortedCatalog) {
        tbody.appendChild(this.#renderCatalogRow(entry));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderCatalogForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;flex-direction:column;gap:6px;";

    const fileRow = document.createElement("div");
    fileRow.style.cssText = "display:flex;align-items:center;gap:6px;";
    const fileLabel = document.createElement("span");
    fileLabel.style.cssText = "font-size:11px;color:var(--omp-text-dim);";
    fileLabel.textContent = "Aus exportierter Datei vorbefüllen:";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json";
    fileInput.style.cssText = "font-size:11px;";
    fileInput.addEventListener("change", () => {
      if (fileInput.files?.[0]) this.#loadCatalogFromFile(fileInput.files[0]);
    });
    fileRow.append(fileLabel, fileInput);
    form.appendChild(fileRow);

    const fieldsRow = document.createElement("div");
    fieldsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    const mkInput = (placeholder: string, value: string, onInput: (v: string) => void, width = "140px") => {
      const input = document.createElement("input");
      input.placeholder = placeholder;
      input.value = value;
      input.style.cssText = `flex:1;min-width:${width};`;
      input.addEventListener("input", () => onInput(input.value));
      return input;
    };

    fieldsRow.append(
      mkInput("Typ (z. B. omp-thirdparty-node)", this.#newCatalogType, (v) => (this.#newCatalogType = v)),
      mkInput("Label", this.#newCatalogLabel, (v) => (this.#newCatalogLabel = v)),
      mkInput("Image (registry/name:tag)", this.#newCatalogImage, (v) => (this.#newCatalogImage = v), "220px"),
      mkInput("Version (optional)", this.#newCatalogVersion, (v) => (this.#newCatalogVersion = v), "100px"),
    );
    form.appendChild(fieldsRow);

    const fieldsRow2 = document.createElement("div");
    fieldsRow2.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    fieldsRow2.append(
      mkInput("Beschreibung (optional)", this.#newCatalogDescription, (v) => (this.#newCatalogDescription = v), "220px"),
      mkInput("Erwartete Ressourcen (optional)", this.#newCatalogExpectedResources, (v) => (this.#newCatalogExpectedResources = v)),
      mkInput("Command-Override (optional, Leerzeichen-getrennt)", this.#newCatalogCommand, (v) => (this.#newCatalogCommand = v), "220px"),
    );
    form.appendChild(fieldsRow2);

    const envLabel = document.createElement("span");
    envLabel.style.cssText = "font-size:11px;color:var(--omp-text-dim);";
    envLabel.textContent = "Env (JSON-Objekt, optional):";
    form.appendChild(envLabel);
    const envInput = document.createElement("textarea");
    envInput.rows = 3;
    envInput.value = this.#newCatalogEnvText;
    envInput.style.cssText = "font-family:var(--omp-mono, monospace);font-size:11px;";
    envInput.addEventListener("input", () => {
      this.#newCatalogEnvText = envInput.value;
    });
    form.appendChild(envInput);

    const importBtn = document.createElement("button");
    importBtn.textContent = "Importieren";
    importBtn.style.cssText = "cursor:pointer;align-self:flex-start;";
    importBtn.addEventListener("click", () => this.#importCatalogEntry());
    form.appendChild(importBtn);

    return form;
  }

  #renderAdmissionResults(results: AdmissionResult[]): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText =
      "border:1px solid var(--omp-error);border-radius:var(--omp-radius);padding:8px;margin-bottom:8px;";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;color:var(--omp-error);margin-bottom:4px;";
    title.textContent = "Import abgelehnt: Contract-Check nicht bestanden";
    box.appendChild(title);
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;font-size:11px;";
    const rows = results
      .map(
        (r) => `<tr>
        <td style="padding:2px 8px;">${escapeHtml(r.Name)}</td>
        <td style="padding:2px 8px;color:${r.Status === "FAIL" ? "var(--omp-error)" : r.Status === "PASS" ? "var(--omp-preset)" : "var(--omp-text-dim)"};">${r.Status}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(r.Detail)}</td>
      </tr>`,
      )
      .join("");
    table.innerHTML = rows;
    box.appendChild(table);
    return box;
  }

  #renderCatalogRow(entry: CatalogEntry): HTMLElement {
    const tr = document.createElement("tr");
    const isImported = entry.runner === "podman";

    const typeTd = document.createElement("td");
    typeTd.style.cssText = "padding:2px 8px;";
    typeTd.textContent = entry.type;
    tr.appendChild(typeTd);

    const labelTd = document.createElement("td");
    labelTd.style.cssText = "padding:2px 8px;";
    labelTd.textContent = entry.label;
    tr.appendChild(labelTd);

    const versionTd = document.createElement("td");
    versionTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    versionTd.textContent = entry.version || "–";
    tr.appendChild(versionTd);

    const originTd = document.createElement("td");
    originTd.style.cssText = "padding:2px 8px;";
    if (isImported) {
      const badge = document.createElement("span");
      badge.textContent = `importiert · ${entry.image}`;
      badge.style.cssText = "color:var(--omp-cue);font-size:var(--omp-font-size-xs);";
      originTd.appendChild(badge);
    } else {
      originTd.textContent = "eingebaut";
      originTd.style.color = "var(--omp-text-dim)";
    }
    tr.appendChild(originTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;white-space:nowrap;";
    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export";
    exportBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    exportBtn.addEventListener("click", () => this.#exportCatalogEntry(entry));
    actionsTd.appendChild(exportBtn);
    if (isImported) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Entfernen";
      delBtn.className = "omp-btn-danger";
      delBtn.style.cssText = "font-size:11px;";
      delBtn.addEventListener("click", () => this.#removeCatalogEntry(entry));
      actionsTd.appendChild(delBtn);
    }
    tr.appendChild(actionsTd);

    return tr;
  }

  #renderAuditSection(): HTMLElement {
    const section = document.createElement("div");

    const heading = document.createElement("div");
    heading.className = "omp-h1";
    heading.style.cssText = "margin-bottom:var(--omp-space-3);";
    // S5: die Zahl ist die Anzahl geladener, nicht aller je
    // protokollierten Zeilen (Cursor-Pagination, "Mehr laden" lädt
    // weitere nach) — deshalb "geladen" statt einer nackten Zahl, die
    // wie ein Gesamtstand aussehen würde.
    heading.textContent = `Audit-Log (${this.#audit.length} geladen)`;
    section.appendChild(heading);

    if (this.#audit.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Noch keine protokollierten Aktionen.";
      section.appendChild(empty);
      return section;
    }

    const rows = this.#audit
      .map(
        (e) => `<tr>
        <td style="padding:2px 8px;color:var(--omp-text-dim);white-space:nowrap;">${escapeHtml(new Date(e.occurredAt).toLocaleString())}</td>
        <td style="padding:2px 8px;">${escapeHtml(e.username)}</td>
        <td style="padding:2px 8px;">${escapeHtml(e.method)}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);word-break:break-all;">${escapeHtml(e.path)}</td>
        <td style="padding:2px 8px;color:${e.status >= 400 ? "var(--omp-error)" : "var(--omp-text)"};">${e.status}</td>
      </tr>`,
      )
      .join("");

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">Zeit</th>
      <th style="padding:2px 8px;">Nutzer</th>
      <th style="padding:2px 8px;">Methode</th>
      <th style="padding:2px 8px;">Pfad</th>
      <th style="padding:2px 8px;">Status</th>
    </tr></thead><tbody>${rows}</tbody>`;
    section.appendChild(table);

    if (this.#auditHasMore) {
      const moreBtn = document.createElement("button");
      moreBtn.textContent = this.#auditLoadingMore ? "Lädt …" : "Mehr laden";
      moreBtn.disabled = this.#auditLoadingMore;
      moreBtn.style.cssText = "font-size:11px;cursor:pointer;margin-top:8px;";
      moreBtn.addEventListener("click", () => this.#loadMoreAudit());
      section.appendChild(moreBtn);
    }

    return section;
  }

  // Nutzerwunsch 2026-08-13: Backup und Restore sind beide voll
  // funktionsfähig (Backend s. orchestrator/internal/backup +
  // supervisor/main.go). Während eines Restores (#restoring/
  // #reconnecting) ersetzt diese Methode ihre gesamte Ausgabe durch ein
  // Overlay — der Orchestrator ist für einige Sekunden komplett nicht
  // erreichbar, jede andere Interaktion in diesem Abschnitt wäre in
  // diesem Fenster ohnehin bedeutungslos.
  #renderBackupSection(): HTMLElement {
    if (this.#restoring || this.#reconnecting) {
      return this.#renderRestoreOverlay();
    }

    const section = document.createElement("div");

    const backupHeading = document.createElement("div");
    backupHeading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const backupTitle = document.createElement("span");
    backupTitle.className = "omp-h1";
    backupTitle.textContent = `Backups (${this.#backups.length})`;
    const createBtn = document.createElement("button");
    createBtn.textContent = this.#creatingBackup ? "Erstellt …" : "Backup jetzt erstellen";
    createBtn.disabled = this.#creatingBackup;
    createBtn.className = "omp-btn-primary";
    createBtn.style.cssText = "font-size:11px;cursor:pointer;";
    createBtn.addEventListener("click", () => void this.#createBackup());
    backupHeading.append(backupTitle, createBtn);
    section.appendChild(backupHeading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);";
    hint.textContent =
      "Ein Backup ist ein vollständiger pg_dump der Orchestrator-Datenbank (Nutzer, Rollenbindungen, " +
      "Audit-Log, Layouts, Snapshots, Workflows, Hosts) — komprimiert, sofort als Download. " +
      "Dieselbe Rotation (14 neueste behalten) wie „make backup“.";
    section.appendChild(hint);

    if (this.#backups.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-4);";
      empty.textContent = "Noch kein Backup vorhanden.";
      section.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;margin-bottom:var(--omp-space-4);";
      const tbody = document.createElement("tbody");
      for (const name of this.#backups) {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.style.cssText = "padding:2px 8px;";
        nameCell.textContent = name;
        const actionCell = document.createElement("td");
        actionCell.style.cssText = "padding:2px 8px;text-align:right;";
        const dlBtn = document.createElement("button");
        dlBtn.textContent = "Herunterladen";
        dlBtn.style.cssText = "font-size:11px;cursor:pointer;";
        dlBtn.addEventListener("click", () => this.#downloadBackup(name));
        actionCell.appendChild(dlBtn);
        row.append(nameCell, actionCell);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    const restoreHeading = document.createElement("div");
    restoreHeading.className = "omp-h1";
    restoreHeading.style.cssText = "margin-bottom:var(--omp-space-2);";
    restoreHeading.textContent = "Restore";
    section.appendChild(restoreHeading);

    if (this.#backups.length === 0) {
      const noBackups = document.createElement("div");
      noBackups.style.cssText = "color:var(--omp-text-dim);";
      noBackups.textContent = "Erst ein Backup erstellen, bevor ein Restore möglich ist.";
      section.appendChild(noBackups);
      return section;
    }

    const restoreHint = document.createElement("div");
    restoreHint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-2);white-space:pre-wrap;";
    restoreHint.textContent =
      "ERSETZT den kompletten aktuellen Datenbankinhalt (Nutzer, Rollenbindungen, Audit-Log, " +
      "Layouts, Snapshots, Workflows, Hosts) mit dem gewählten Stand — nicht rückgängig zu " +
      "machen, außer durch ein weiteres Restore. Der Orchestrator ist während des Vorgangs " +
      "(wenige Sekunden) nicht erreichbar, diese Seite lädt danach automatisch neu.";
    section.appendChild(restoreHint);

    const select = document.createElement("select");
    select.style.cssText = "margin-bottom:var(--omp-space-2);";
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = "Backup wählen …";
    select.appendChild(placeholderOpt);
    for (const name of this.#backups) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === this.#restoreSelected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.#restoreSelected = select.value;
      this.#restoreTyped = "";
      this.#render();
    });
    section.appendChild(select);

    if (this.#restoreSelected) {
      const confirmLabel = document.createElement("div");
      confirmLabel.style.cssText = "color:var(--omp-text-dim);margin:var(--omp-space-2) 0 4px;";
      confirmLabel.textContent = `Zur Bestätigung exakt eintippen: ${this.#restoreSelected}`;
      section.appendChild(confirmLabel);

      const confirmRow = document.createElement("div");
      confirmRow.style.cssText = "display:flex;gap:var(--omp-space-2);align-items:center;";
      const typedInput = document.createElement("input");
      typedInput.type = "text";
      typedInput.value = this.#restoreTyped;
      typedInput.style.cssText = "width:320px;";
      typedInput.addEventListener("input", () => {
        this.#restoreTyped = typedInput.value;
        // Nur den Knopf-Zustand aktualisieren, kein voller #render() —
        // sonst verliert das Eingabefeld bei jedem Tastendruck den Fokus
        // (gleiches Muster wie #renderFilterBar in workflows-view.ts).
        restoreBtn.disabled = this.#restoreTyped !== this.#restoreSelected;
      });
      const restoreBtn: HTMLButtonElement = document.createElement("button");
      restoreBtn.textContent = "Zurückspielen";
      restoreBtn.className = "omp-btn-danger";
      restoreBtn.disabled = this.#restoreTyped !== this.#restoreSelected;
      restoreBtn.style.cssText = "font-size:11px;cursor:pointer;";
      restoreBtn.addEventListener("click", () => void this.#restoreDatabase());
      confirmRow.append(typedInput, restoreBtn);
      section.appendChild(confirmRow);
    }

    return section;
  }

  #renderRestoreOverlay(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:var(--omp-space-4) 0;text-align:center;color:var(--omp-text);";
    const title = document.createElement("div");
    title.className = "omp-h1";
    title.style.cssText = "margin-bottom:var(--omp-space-2);";
    title.textContent = this.#restoring ? "Restore wird eingeleitet …" : "Server wird neu gestartet …";
    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--omp-text-dim);";
    detail.textContent = this.#restoring
      ? "Sende den Restore-Auftrag an den Supervisor."
      : "Datenbank wird zurückgespielt, der Orchestrator startet danach automatisch neu — " +
        "diese Seite lädt sich von selbst neu, sobald er wieder erreichbar ist.";
    wrap.append(title, detail);
    return wrap;
  }

  #renderClusterSection(): HTMLElement {
    const section = document.createElement("div");

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;gap:var(--omp-space-2);";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = `Cluster (${this.#cluster?.peers.length ?? 0} Mitglieder)`;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;";
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "Aktualisieren";
    refreshBtn.style.cssText = "font-size:11px;cursor:pointer;";
    refreshBtn.addEventListener("click", () => void this.#loadClusterStatus());
    const joinToggleBtn = document.createElement("button");
    joinToggleBtn.textContent = this.#showClusterJoinForm ? "Abbrechen" : "+ Weiteren Orchestrator hinzufügen";
    joinToggleBtn.className = this.#showClusterJoinForm ? "" : "omp-btn-primary";
    joinToggleBtn.style.cssText = "font-size:11px;cursor:pointer;";
    joinToggleBtn.addEventListener("click", () => {
      this.#showClusterJoinForm = !this.#showClusterJoinForm;
      this.#render();
    });
    actions.append(refreshBtn, joinToggleBtn);
    heading.append(title, actions);
    section.appendChild(heading);

    if (!this.#cluster) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Cluster-Status wird geladen …";
      section.appendChild(empty);
      return section;
    }

    const c = this.#cluster;
    const statusCard = document.createElement("div");
    statusCard.className = "omp-card";
    statusCard.style.cssText = "margin-bottom:var(--omp-space-3);display:flex;flex-wrap:wrap;gap:var(--omp-space-4);";
    const facts: [string, string][] = [
      ["Diese Instanz", c.nodeId],
      ["Zustand", c.isLeader ? "Leader" : c.state],
      ["Term", String(c.term)],
      ["Angewandter Log-Index", String(c.appliedIndex)],
      ["Leader", c.leaderId ? (c.leaderId === c.nodeId ? `${c.leaderId} (diese Instanz)` : c.leaderId) : "unbekannt"],
    ];
    for (const [k, v] of facts) {
      const box = document.createElement("div");
      const kEl = document.createElement("div");
      kEl.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
      kEl.textContent = k;
      const vEl = document.createElement("div");
      vEl.style.cssText = "font-weight:600;";
      vEl.textContent = v;
      box.append(kEl, vEl);
      statusCard.appendChild(box);
    }
    section.appendChild(statusCard);

    if (this.#showClusterJoinForm) {
      section.appendChild(this.#renderClusterJoinForm());
    }

    if (c.peers.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Node-ID</th>
        <th style="padding:2px 8px;">Raft-Adresse</th>
        <th style="padding:2px 8px;">Rolle</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const peer of c.peers) {
        tbody.appendChild(this.#renderClusterPeerRow(peer, c));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderClusterJoinForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:var(--omp-space-3);" +
      "margin-bottom:var(--omp-space-3);";

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      "Node-ID und Raft-Adresse der neuen Instanz eintragen, das Skript unten auf ihr ausführen, " +
      "warten bis sie läuft (passiv, ohne Selbst-Bootstrap) — dann hier beitreten lassen.";
    form.appendChild(hint);

    const fieldsRow = document.createElement("div");
    fieldsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--omp-space-2);";

    const nodeIdInput = document.createElement("input");
    nodeIdInput.placeholder = "Node-ID, z. B. node-2";
    nodeIdInput.value = this.#newClusterNodeId;
    nodeIdInput.style.cssText = "flex:1;min-width:120px;";
    const raftInput = document.createElement("input");
    raftInput.placeholder = "Raft-Adresse, z. B. host-2:8300";
    raftInput.value = this.#newClusterRaftAddr;
    raftInput.style.cssText = "flex:1;min-width:160px;";
    const httpInput = document.createElement("input");
    httpInput.placeholder = "HTTP-Adresse (optional), z. B. http://host-2:8000";
    httpInput.value = this.#newClusterHttpAddr;
    httpInput.style.cssText = "flex:1;min-width:200px;";

    const preview = document.createElement("pre");
    preview.style.cssText =
      "background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:var(--omp-radius);" +
      "padding:var(--omp-space-2);font-family:var(--omp-font-mono);font-size:var(--omp-font-size-xs);" +
      "white-space:pre-wrap;word-break:break-all;margin:0 0 var(--omp-space-2) 0;";
    preview.textContent = this.#buildClusterJoinSnippet();

    const updatePreview = () => {
      preview.textContent = this.#buildClusterJoinSnippet();
    };
    nodeIdInput.addEventListener("input", () => {
      this.#newClusterNodeId = nodeIdInput.value;
      updatePreview();
    });
    raftInput.addEventListener("input", () => {
      this.#newClusterRaftAddr = raftInput.value;
      updatePreview();
    });
    httpInput.addEventListener("input", () => {
      this.#newClusterHttpAddr = httpInput.value;
      updatePreview();
    });

    fieldsRow.append(nodeIdInput, raftInput, httpInput);
    form.appendChild(fieldsRow);
    form.appendChild(preview);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Skript kopieren";
    copyBtn.style.cssText = "font-size:11px;cursor:pointer;";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.#buildClusterJoinSnippet());
        copyBtn.textContent = "Kopiert!";
        window.setTimeout(() => {
          copyBtn.textContent = "Skript kopieren";
        }, 1500);
      } catch {
        // Kein Clipboard-Zugriff — <pre> steht ohnehin zum manuellen Markieren da.
      }
    });
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.textContent = "Jetzt beitreten lassen";
    joinBtn.className = "omp-btn-primary";
    joinBtn.style.cssText = "font-size:11px;cursor:pointer;";
    joinBtn.addEventListener("click", () => void this.#joinClusterMember());
    actions.append(copyBtn, joinBtn);
    form.appendChild(actions);

    return form;
  }

  #renderClusterPeerRow(peer: ClusterPeer, c: ClusterStatus): HTMLElement {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.style.cssText = "padding:2px 8px;";
    idTd.textContent = peer.id;
    if (peer.id === c.leaderId) {
      const badge = document.createElement("span");
      badge.className = "omp-badge omp-badge-running";
      badge.style.cssText = "margin-left:6px;";
      badge.textContent = "Leader";
      idTd.appendChild(badge);
    }
    tr.appendChild(idTd);

    const raftTd = document.createElement("td");
    raftTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    raftTd.textContent = peer.raftAddr;
    tr.appendChild(raftTd);

    const suffrageTd = document.createElement("td");
    suffrageTd.style.cssText = "padding:2px 8px;";
    suffrageTd.textContent = peer.suffrage;
    tr.appendChild(suffrageTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;";
    const delBtn = document.createElement("button");
    delBtn.textContent = "Entfernen";
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => void this.#leaveClusterMember(peer));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    return tr;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-admin-view", AdminView);
