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
import { type I18nKey, t, t as tt } from "./i18n.ts";
import "./settings-view.ts";
import "./playout-admin-view.ts";
import "./audio-rules-view.ts";
import "./locations-view.ts";
import { fetchBuildInfo, formatFirmwareLong } from "./version.ts";
import { apiFetch, connectionMonitor } from "./connection.ts";
import { getToken, login } from "./auth.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";

interface UserEntry {
  id: string;
  username: string;
  createdAt: string;
  isAdmin: boolean;
  // orgId (Kapitel 21 B14 UI-Anbindung, Nachtrag 284) — Wire-Format
  // identisch zu httpapi.userResponse.
  orgId: string;
}

interface RoleBinding {
  id: string;
  subject: string;
  // subjectType (Nutzerauftrag 2026-09-24: gruppenbasierte Rechte-
  // verwaltung) — "user" (subject ist ein Nutzername) oder "group"
  // (subject ist eine Gruppen-ID).
  subjectType: "user" | "group";
  // Kapitel 12 Teil 4 (docs/END-GOAL-FEATURES.md §12.3e): leer = global/
  // Node-gescoped (unverändert); gesetzt = Workflow-Scope, nodeId ist
  // dann ein Rollenname statt einer Instanz-ID.
  workflowId?: string;
  nodeId: string;
  verb: string;
}

// Group — Wire-Format identisch zu groups.Group (Nutzerauftrag
// 2026-09-24: gruppenbasierte Rechteverwaltung).
interface Group {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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

// LogEntry — Wire-Format identisch zu orchestrator/internal/
// logbus::Entry (ARCHITECTURE.md §25.2, UMSETZUNG.md D19).
interface LogEntry {
  id: number;
  occurredAt: string;
  level: string;
  message: string;
  traceId?: string;
  spanId?: string;
  nodeId?: string;
  hostId?: string;
  source: string;
}

interface NodeEntry {
  id: string;
  label: string;
  instanceId?: string;
}

// Organization — Wire-Format identisch zu organizations.Organization
// (Kapitel 21 B14, Nachtrag 283/284).
interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

// StorageBackend — Wire-Format identisch zu storagebackends.Backend
// (Nutzerauftrag 2026-09-24: super-admin-verwaltete, live hinzufügbare/
// entfernbare Asset-Speicherorte). secretKey selbst kommt NIE vom
// Server zurück (s. hasSecret).
interface StorageBackend {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  bucket: string;
  accessKey: string;
  useSsl: boolean;
  hasSecret: boolean;
  status: "active" | "deprecated";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Formular-Rohwerte des Storage-Backend-Wizards (Create UND Update
// teilen sich diese Form) — secretKey ist ein Klartext-Eingabewert nur
// während der Bearbeitung, nie ein Feld von StorageBackend selbst.
interface StorageBackendFormValues {
  name: string;
  provider: string;
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  useSsl: boolean;
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

// ARCHITECTURE.md §25.3 (UMSETZUNG.md D20) — gleiches SSE-first-Muster
// wie beim Audit-Log: logbus.Store.Insert broadcastet "log.appended"
// (schon seit D19 vorhanden, bisher ungenutzt, weil es noch keine
// Oberfläche dafür gab).
const LOG_POLL_FALLBACK_INTERVAL_MS = 30000;
const LOG_REFRESH_EVENT_TYPES = new Set(["log.appended", "lost-events"]);
const LOG_PAGE_LIMIT = 50; // <= httpapi's maxLogLimit (500)

const LOG_LEVEL_COLOR: Record<string, string> = {
  error: "var(--omp-error)",
  warn: "#e0a020",
  info: "var(--omp-text-dim)",
};

const VERBS = ["view", "operate", "configure", "admin"] as const;

const VERB_LABEL: Record<string, string> = {
  view: tt("adm.6970d8"),
  operate: tt("adm.993f73"),
  configure: tt("adm.c752db"),
  admin: tt("adm.d977b4"),
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
interface UpdateComponent { id: string; target: string; sha256: string }
interface UpdatePackage {
  id: string;
  version: string;
  signed: boolean;
  keyId?: string;
  sha256: string;
  size: number;
  uploadedAt: string;
  manifest: {
    version: string;
    gitCommit?: string;
    builtAt?: string;
    arch: string;
    minFromVersion?: string;
    migrations?: string[];
    notes?: string;
    components: UpdateComponent[];
  };
}
interface UpdateHistoryEntry { time: string; from?: string; version: string; ok: boolean; rolledBack?: boolean; error?: string }
interface UpdateHostResult { hostId: string; label: string; state: string; detail?: string; updated: string }
interface UpdateDistribution { packageId: string; version: string; running: boolean; hosts: UpdateHostResult[] }
interface UpdateOverview {
  distribution?: UpdateDistribution;
  current: { version: string; commit?: string; builtAt?: string };
  packages: UpdatePackage[];
  history: UpdateHistoryEntry[];
  trustedKeys: string[];
  allowUnsigned: boolean;
  outdatedInstances: number;
  supervisor?: { busy: boolean; kind?: string; phase?: string; version?: string; ok?: boolean; error?: string; endedAt?: string };
  supervisorError?: string;
}

type AdminTabId = "users" | "organizations" | "groups" | "bindings" | "catalog" | "storage" | "audit" | "diagnose" | "backup" | "update" | "nodeversions" | "settings" | "playout" | "audio" | "cluster";
// Gruppiert (Nutzerhinweis 2026-10-07): "Playout" und "Audio-Ausgabe" gehören
// zur Playout-Automation (Kapitel 27), nicht zur allgemeinen Plattform-Verwaltung.
const ADMIN_SUB_TAB_GROUPS: { id: string; labelKey: I18nKey; tabs: { id: AdminTabId; labelKey: I18nKey }[] }[] = [
  {
    id: "platform",
    labelKey: "admin.group.platform",
    tabs: [
      { id: "users", labelKey: "admin.tab.users" },
      { id: "organizations", labelKey: "admin.tab.organizations" },
      { id: "groups", labelKey: "admin.tab.groups" },
      { id: "bindings", labelKey: "admin.tab.bindings" },
      { id: "catalog", labelKey: "admin.tab.catalog" },
      { id: "nodeversions", labelKey: "admin.tab.nodeversions" },
      { id: "storage", labelKey: "admin.tab.storage" },
      { id: "audit", labelKey: "admin.tab.audit" },
      { id: "diagnose", labelKey: "admin.tab.diagnose" },
      { id: "backup", labelKey: "admin.tab.backup" },
      { id: "update", labelKey: "admin.tab.update" },
      { id: "settings", labelKey: "admin.tab.settings" },
      { id: "cluster", labelKey: "admin.tab.cluster" },
    ],
  },
  {
    id: "playout",
    labelKey: "admin.group.playout",
    tabs: [
      { id: "playout", labelKey: "admin.tab.playout" },
      { id: "audio", labelKey: "admin.tab.audio" },
    ],
  },
];
const SUB_TAB_BUTTON_BASE =
  "border:1px solid transparent;border-radius:var(--omp-radius);" +
  "padding:6px 12px;font-size:var(--omp-font-size-sm);font-family:var(--omp-font);cursor:pointer;";

interface RolloutItem {
  instanceId: string;
  label: string;
  mode: string;
  from: string;
  state: string;
  detail?: string;
}
interface RolloutStatus {
  name?: string;
  target?: string;
  running: boolean;
  items: RolloutItem[];
}
interface NodeVersionEntry {
  contract?: number;
  id: string;
  version: string;
  commit?: string;
  source?: string;
  size: number;
}
interface NodeVersionType {
  name: string;
  catalogTypes?: string[];
  installed?: { version: string; commit?: string; builtAt?: string };
  productive: string;
  versions: NodeVersionEntry[];
  instances: { id: string; label: string; type: string; nodeVersion?: string; outdated: boolean; remote?: boolean }[];
}
interface NodeVersionOverview {
  types: NodeVersionType[];
}

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
  // Diagnose-Cockpit (ARCHITECTURE.md §25.3, UMSETZUNG.md D20) — gleiche
  // Cursor-Pagination/SSE-Refresh-Struktur wie #audit oben, zusätzlich
  // drei client-seitig gehaltene Filter (Trace-ID/Node-ID/Level), die
  // #loadLogs() als Query-Parameter an GET /api/v1/logs anhängt.
  // #logsTraceIdFilter wird auch von außen gesetzt (showTrace(), von
  // app-shell.ts nach einem "omp-view-trace"-Event aus dem Flow Editor
  // aufgerufen — ein fehlgeschlagener IS-05-Connect trägt seine
  // trace_id bereits im Response-Header).
  #logs: LogEntry[] = [];
  #logsHasMore = false;
  #logsLoadingMore = false;
  #logsTraceIdFilter = "";
  #logsNodeIdFilter = "";
  #logsLevelFilter = "";
  #logPollHandle: number | undefined;
  #nodes: NodeEntry[] = [];
  #workflows: WorkflowSummary[] = [];
  #error = "";
  #showUserForm = false;
  #newUsername = "";
  #newPassword = "";
  #newUserOrgId = "";
  #resetTarget: string | null = null;
  #resetPassword = "";
  // Organisationen (Kapitel 21 B14 UI-Anbindung, Nachtrag 284) — gleiches
  // Muster wie #resetTarget/#resetPassword: #orgChangeTarget != null
  // schaltet die betroffene Nutzer-Zeile auf ein Inline-Auswahlfeld um.
  #organizations: Organization[] = [];
  #showOrgForm = false;
  #newOrgName = "";
  #orgChangeTarget: string | null = null;
  // Rechte-Übersicht je Nutzer (Nutzerfund 2026-09-24: "rollenbindung,
  // gruppen (in rollenbindung), gruppen und organisation... extrem
  // unübersichtlich... es muss immer klar sichtbar sein welcher user
  // welche rechte hat") — #rightsExpandedUsername ist wie
  // #selectedGroupId ein einzelner Toggle-Zustand (kein Set: es soll
  // immer nur ein Panel gleichzeitig offen sein, damit die Seite nicht
  // ausufert), #renderUserRightsPanel löst ihn zu direkten UND über
  // Gruppenmitgliedschaft geerbten Bindungen auf. #allGroupMembers cacht
  // die Mitgliederlisten ALLER Gruppen (nicht nur der in der
  // Gruppen-Unteransicht gerade aufgeklappten), s. #loadAllGroupMembers.
  #rightsExpandedUsername: string | null = null;
  #allGroupMembers: Map<string, string[]> = new Map();

  // Storage-Backends (Nutzerauftrag 2026-09-24). Formularwerte liegen
  // bewusst als eigene Instanzfelder vor (nicht in einem lokalen
  // Closure-Objekt) — #render() baut bei jeder Zustandsänderung (z. B.
  // dem Verbindungstest) das komplette Formular neu auf, gleiches
  // Muster wie #newUsername/#newOrgName: Texteingaben aktualisieren nur
  // das Feld (kein #render()-Aufruf pro Tastendruck, sonst Fokusverlust
  // bei jedem Zeichen), erst eine strukturelle Aktion (Test-Button,
  // Abschicken, Formular öffnen/schließen) rendert neu — und liest dann
  // den zuletzt getippten Wert aus genau diesen Feldern.
  #storageBackends: StorageBackend[] = [];
  #storageFeatureDisabled = false;
  #showStorageForm = false;
  #editingStorageBackend: StorageBackend | null = null;
  #storageForm: StorageBackendFormValues = { name: "", provider: "minio", endpoint: "", bucket: "", accessKey: "", secretKey: "", useSsl: false };
  #storageTestState: "idle" | "testing" | "ok" | "failed" = "idle";
  #storageTestMessage = "";
  #storageFormError = "";

  // Gruppen (Nutzerauftrag 2026-09-24: gruppenbasierte Rechteverwaltung).
  #groups: Group[] = [];
  #showGroupForm = false;
  #newGroupName = "";
  #newGroupDescription = "";
  #editingGroup: Group | null = null;
  #selectedGroupId: string | null = null;
  #groupMembers: string[] = [];
  #newGroupMemberUsername = "";

  #showBindingForm = false;
  #newSubject = "";
  // subjectType des Anlage-Formulars — "user" (Default, Freitext-
  // Nutzername) oder "group" (Auswahl aus #groups).
  #newSubjectType: "user" | "group" = "user";
  #newNodeId = "*";
  #newVerb = "operate";
  // Kapitel 12 Teil 4: "" = global/Node-gescoped (unverändertes
  // Verhalten), sonst die Workflow-ID — schaltet das Node-ID-Feld unten
  // von "Instanz-ID" auf "Rollenname" um.
  #newWorkflowId = "";
  // Nutzerwunsch 2026-09-11: Rollenbindungen aus beiden Richtungen
  // bedienbar machen. Backend/API sind bereits richtungsneutral (jede
  // Bindung trägt Subject UND NodeID gleichermaßen) — reine UI-Ergänzung:
  // #bindingsGroupBy steuert die Anzeige (Liste gruppiert nach Nutzer
  // ODER nach Node/Rolle), #newBindingDirection nur die Feld-Reihenfolge
  // im Anlage-Formular (Nutzer zuerst vs. Node zuerst) — #createBinding
  // selbst ist davon unabhängig, s. dort.
  #bindingsGroupBy: "subject" | "node" = "subject";
  #newBindingDirection: "userFirst" | "nodeFirst" = "userFirst";
  #auditPollHandle: number | undefined;

  // §17 Teil 4/5 Import/Export-UI (Nutzerwunsch: "node/microservice
  // import/export machen") — reine UI-Anbindung, Backend existiert
  // bereits vollständig inkl. C9-Admission-Check und Versionierung.
  #catalog: CatalogEntry[] = [];
  #showCatalogForm = false;
  // Node-Katalog-Redesign 2026-09-02: rein clientseitiger Freitext-Filter
  // (Katalog ist klein, kein Server-Roundtrip nötig) über Label/Typ/
  // Beschreibung — siehe #filteredCatalog.
  #catalogSearch = "";
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
  // Nutzerfund 2026-08-27 ("backup kann downgeloaded werden, aber
  // nicht per upload im Browser wiederhergestellt werden — derzeit
  // nur aus der Dropdownbox"): #uploadBackup unten lädt eine lokale
  // Datei hoch und wählt sie danach automatisch in genau dieser
  // Dropdown/Bestätigungs-Kette aus — kein separater Restore-Pfad,
  // nur ein zweiter Weg, eine Datei in die Liste zu bekommen.
  #uploadingBackup = false;
  #restoreSelected = "";
  #restoreTyped = "";
  #restoring = false;
  #reconnecting = false;

  // System-Update per Browser-Upload (docs/ENTWURF-SYSTEM-UPDATE.md):
  // Pakete sind signiert (Ed25519) und werden vom Orchestrator UND vom
  // Supervisor geprüft; angewendet wird per Supervisor (Backup → Stop →
  // Tausch → Start → Prüfung → ggf. Rollback). #updTyped ist die
  // "Version eintippen"-Bestätigung.
  #upd: UpdateOverview | null = null;
  #updUploading = false;
  #updSelected = "";
  #updTyped = "";
  #updBackup = true;
  #updForce = false;
  #updApplying = false;
  #updPollHandle: number | null = null;
  #restartingOutdated = false;

  // Node-Versionen (Kapitel 28): Versionsspeicher je Node-Typ, produktive Version
  // pro Typ. #nvBuilds: Instanz-ID → vom laufenden Node gemeldeter Build-Stempel.
  #nv: NodeVersionOverview | null = null;
  #nvBuilds = new Map<string, string>();
  #nvBusy = false;
  // Rollout (Kapitel 28 Schritt 3): letzter Stand je Binary-Name + Poll, solange einer läuft.
  #nvRollouts = new Map<string, RolloutStatus>();
  #nvRolloutPoll: number | null = null;
  // Einstellungs-Ansicht: dieselbe Instanz bei jedem Neuzeichnen, damit Eingaben erhalten bleiben.
  #settingsView: HTMLElement | null = null;
  #locationsView: HTMLElement | null = null;
  #playoutView: HTMLElement | null = null;
  #audioRulesView: HTMLElement | null = null;

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
    this.#loadOrganizations();
    this.#loadGroups();
    this.#loadStorageBackends();
    this.#loadBindings();
    this.#loadAudit();
    this.#loadLogs();
    this.#loadNodes();
    this.#loadWorkflows();
    this.#loadCatalog();
    this.#loadBackups();
    this.#loadUpdates();
    this.#loadNodeVersions();
    this.#loadClusterStatus();
    this.#auditPollHandle = window.setInterval(() => this.#loadAudit(), AUDIT_POLL_FALLBACK_INTERVAL_MS);
    this.#logPollHandle = window.setInterval(() => this.#loadLogs(), LOG_POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#auditPollHandle !== undefined) window.clearInterval(this.#auditPollHandle);
    if (this.#logPollHandle !== undefined) window.clearInterval(this.#logPollHandle);
    if (this.#updPollHandle !== null) window.clearInterval(this.#updPollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  // ARCHITECTURE.md §25.1/§25.3 (UMSETZUNG.md D20): aufgerufen von
  // app-shell.ts, nachdem es ein bubblendes "omp-view-trace"-Event
  // (ausgelöst z. B. von flow-canvas.ts nach einem fehlgeschlagenen
  // IS-05-Connect) aufgefangen und zu diesem Tab gewechselt hat —
  // gleiches Cross-Komponenten-Musters wie FlowCanvas.setWorkflowFilter.
  showTrace(traceId: string) {
    this.#activeAdminTab = "diagnose";
    this.#logsTraceIdFilter = traceId;
    this.#logsNodeIdFilter = "";
    this.#logsLevelFilter = "";
    this.#loadLogs();
    this.#render();
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (AUDIT_REFRESH_EVENT_TYPES.has(parsed.type)) this.#loadAudit();
    // Ein Filter (Trace-ID/Node-ID/Level) ist aktiv gesetzte Nutzerabsicht
    // ("zeig mir genau diesen Ausschnitt") — ein Live-Refresh würde ihn
    // sonst mit der ungefilterten neuesten Seite überschreiben. Kein
    // Datenverlust: der Filter selbst bleibt bestehen, ein manuelles Neu-
    // Anwenden (Feld erneut abschicken) holt neue Zeilen nach.
    if (
      LOG_REFRESH_EVENT_TYPES.has(parsed.type) &&
      !this.#logsTraceIdFilter &&
      !this.#logsNodeIdFilter &&
      !this.#logsLevelFilter
    ) {
      this.#loadLogs();
    }
  };

  async #loadOrganizations() {
    try {
      const res = await apiFetch("/api/v1/organizations");
      if (res.ok) {
        this.#organizations = await res.json();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  async #createOrganization() {
    if (!this.#newOrgName.trim()) return;
    const res = await apiFetch("/api/v1/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.#newOrgName.trim() }),
    });
    if (!res.ok) {
      this.#error = tt("adm.5b0f32", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#newOrgName = "";
    this.#showOrgForm = false;
    await this.#loadOrganizations();
  }

  // 409 heißt hier immer entweder "Default-Organisation" (unlöschbar,
  // s. organizations.Store.Delete-Doku) oder "hat noch Mitglieder/
  // Fachobjekte" (bewusst keine Kaskade) — beides braucht eine für
  // Nicht-Techniker verständliche Erklärung statt des rohen Backend-Texts.
  async #deleteOrganization(org: Organization) {
    if (!(await confirmDialog(tt("adm.44bbde", { p0: org.name }), { confirmLabel: tt("adm.1010b0") }))) return;
    const res = await apiFetch(`/api/v1/organizations/${encodeURIComponent(org.id)}`, { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 409 && text.includes("cannot be deleted")) {
        this.#error = tt("adm.ea96f5", { p0: org.name });
      } else if (res.status === 409) {
        this.#error = tt("adm.fc057a", { p0: org.name });
      } else {
        this.#error = tt("adm.05f6da", { p0: text });
      }
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadOrganizations();
  }

  async #changeUserOrg(username: string, orgId: string) {
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}/org`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    if (!res.ok) {
      this.#error = tt("adm.c9957a", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#orgChangeTarget = null;
    await this.#loadUsers();
  }

  // ---- Gruppen (Nutzerauftrag 2026-09-24) --------------------------------------------------------

  async #loadGroups() {
    try {
      const res = await apiFetch("/api/v1/groups");
      if (res.ok) {
        this.#groups = await res.json();
        this.#render();
        void this.#loadAllGroupMembers();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  // Lädt die Mitgliederliste JEDER Gruppe einmal im Hintergrund (nicht nur
  // der gerade in der Gruppen-Unteransicht aufgeklappten) — die
  // Rechte-Übersicht je Nutzer (#renderUserRightsPanel) muss für JEDEN
  // Nutzer wissen können, in welchen Gruppen er Mitglied ist, ohne dass
  // jede Nutzer-Zeile das einzeln nachladen müsste. Gruppenzahl ist im
  // Admin-Kontext klein genug, ein paralleler Fetch aller Mitgliederlisten
  // fällt nicht ins Gewicht (kein serverseitiges GroupsForUser-Äquivalent
  // über HTTP vorhanden, s. groups.Store.GroupsForUser-Doku — nur
  // service-intern genutzt).
  async #loadAllGroupMembers() {
    const entries = await Promise.all(
      this.#groups.map(async (g): Promise<[string, string[]]> => {
        try {
          const res = await apiFetch(`/api/v1/groups/${g.id}/members`);
          return [g.id, res.ok ? await res.json() : []];
        } catch {
          return [g.id, []];
        }
      }),
    );
    this.#allGroupMembers = new Map(entries);
    this.#render();
  }

  async #loadGroupMembers(groupId: string) {
    try {
      const res = await apiFetch(`/api/v1/groups/${groupId}/members`);
      if (res.ok) this.#groupMembers = await res.json();
      this.#render();
    } catch {
      // s.o.
    }
  }

  #selectGroup(groupId: string) {
    this.#selectedGroupId = groupId;
    this.#groupMembers = [];
    this.#render();
    void this.#loadGroupMembers(groupId);
  }

  async #createGroup() {
    if (!this.#newGroupName.trim()) return;
    const res = await apiFetch("/api/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.#newGroupName.trim(), description: this.#newGroupDescription.trim() }),
    });
    if (!res.ok) {
      this.#error = tt("adm.740737", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#newGroupName = "";
    this.#newGroupDescription = "";
    this.#showGroupForm = false;
    await this.#loadGroups();
  }

  async #updateGroup(group: Group, name: string, description: string) {
    const res = await apiFetch(`/api/v1/groups/${group.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: description.trim() }),
    });
    if (!res.ok) {
      this.#error = tt("adm.f0fe51", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#editingGroup = null;
    await this.#loadGroups();
  }

  // Erster Versuch ohne Kaskade — zeigt bei bestehenden Rollenbindungen
  // eine konkrete Fehlermeldung mit Anzahl (Backend-Guard). Erst nach
  // expliziter Rückfrage per confirmDialog wird mit ?cascade=true erneut
  // versucht (Nutzerauftrag: "protection guards... with warnings").
  async #deleteGroup(group: Group) {
    if (!(await confirmDialog(tt("adm.006ae0", { p0: group.name }), { confirmLabel: tt("adm.1010b0") }))) return;
    const res = await apiFetch(`/api/v1/groups/${group.id}`, { method: "DELETE" });
    if (res.ok) {
      this.#error = "";
      if (this.#selectedGroupId === group.id) this.#selectedGroupId = null;
      await this.#loadGroups();
      return;
    }
    const text = await res.text();
    if (res.status === 409) {
      const cascade = await confirmDialog(
        tt("adm.b0eec4", { p0: text }),
        { confirmLabel: tt("adm.bbd42e") },
      );
      if (!cascade) return;
      const res2 = await apiFetch(`/api/v1/groups/${group.id}?cascade=true`, { method: "DELETE" });
      if (!res2.ok) {
        this.#error = tt("adm.05f6da", { p0: await res2.text() });
        this.#render();
        return;
      }
      this.#error = "";
      if (this.#selectedGroupId === group.id) this.#selectedGroupId = null;
      await this.#loadGroups();
      return;
    }
    this.#error = tt("adm.05f6da", { p0: text });
    this.#render();
  }

  async #addGroupMember(groupId: string, username: string) {
    if (!username.trim()) return;
    const res = await apiFetch(`/api/v1/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim() }),
    });
    if (!res.ok) {
      this.#error = tt("adm.116589", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#newGroupMemberUsername = "";
    await this.#loadGroupMembers(groupId);
    void this.#loadAllGroupMembers();
  }

  async #removeGroupMember(groupId: string, username: string) {
    const res = await apiFetch(`/api/v1/groups/${groupId}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.473556", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadGroupMembers(groupId);
    void this.#loadAllGroupMembers();
  }

  // ---- Storage-Backends (Nutzerauftrag 2026-09-24) ----------------------------------------------

  async #loadStorageBackends() {
    try {
      const res = await apiFetch("/api/v1/storage-backends");
      if (res.status === 404 || res.status === 503) {
        // Feature serverseitig nicht aktiviert (kein OMP_STORAGE_SECRET_KEY)
        // — kein Fehler, sondern ein eigener, erklärender Zustand (s.
        // #renderStorageSection): "nicht konfiguriert", nicht "kaputt".
        this.#storageFeatureDisabled = true;
        this.#storageBackends = [];
        this.#render();
        return;
      }
      this.#storageFeatureDisabled = false;
      if (res.ok) this.#storageBackends = await res.json();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  // secretKey leer bei Update heißt "unverändert lassen" (Backend-
  // Vertrag, s. storagebackends.Store.UpdateMeta-Doku) — Create UND
  // Update senden trotzdem denselben, getrimmten Payload aus
  // #storageForm.
  #storageFormPayload() {
    const f = this.#storageForm;
    return {
      name: f.name.trim(), provider: f.provider.trim(), endpoint: f.endpoint.trim(),
      bucket: f.bucket.trim(), accessKey: f.accessKey.trim(), secretKey: f.secretKey,
      useSsl: f.useSsl,
    };
  }

  async #testStorageConnection() {
    this.#storageTestState = "testing";
    this.#storageTestMessage = "";
    this.#render();
    const res = await apiFetch("/api/v1/storage-backends/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.#storageFormPayload()),
    });
    if (res.ok) {
      this.#storageTestState = "ok";
      this.#storageTestMessage = tt("adm.d6c746");
    } else {
      this.#storageTestState = "failed";
      this.#storageTestMessage = await res.text();
    }
    this.#render();
  }

  // Zentraler Absende-Pfad für "Anlegen"/"Speichern" — der eigentliche
  // "protection guard" aus dem Nutzerauftrag: ungetestet oder mit
  // fehlgeschlagenem letzten Test abschicken verlangt eine bewusste
  // Bestätigung (gleiches confirmDialog-Muster wie jede andere
  // gefährliche Aktion in diesem Projekt), statt eine kaputte
  // Konfiguration stillschweigend zu übernehmen.
  async #submitStorageForm() {
    if (this.#storageTestState !== "ok") {
      const proceed = await confirmDialog(
        this.#storageTestState === "failed"
          ? tt("adm.c18d1f")
          : tt("adm.712bf9"),
        { confirmLabel: tt("adm.71af06") },
      );
      if (!proceed) return;
    }
    if (this.#editingStorageBackend) {
      await this.#updateStorageBackend(this.#editingStorageBackend.id);
    } else {
      await this.#createStorageBackend();
    }
  }

  async #createStorageBackend(): Promise<boolean> {
    const res = await apiFetch("/api/v1/storage-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.#storageFormPayload()),
    });
    if (!res.ok) {
      this.#storageFormError = tt("adm.055ecb", { p0: await res.text() });
      this.#render();
      return false;
    }
    this.#storageFormError = "";
    this.#showStorageForm = false;
    await this.#loadStorageBackends();
    showToast(tt("adm.d033fe"), { variant: "info" });
    return true;
  }

  async #updateStorageBackend(id: string): Promise<boolean> {
    const res = await apiFetch(`/api/v1/storage-backends/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.#storageFormPayload()),
    });
    if (!res.ok) {
      this.#storageFormError = tt("adm.616d9c", { p0: await res.text() });
      this.#render();
      return false;
    }
    this.#storageFormError = "";
    this.#showStorageForm = false;
    this.#editingStorageBackend = null;
    await this.#loadStorageBackends();
    showToast(tt("adm.24bd50"), { variant: "info" });
    return true;
  }

  async #setStorageBackendLifecycle(backend: StorageBackend, toStatus: "deprecated" | "active") {
    const action = toStatus === "deprecated" ? "deprecate" : "reactivate";
    const res = await apiFetch(`/api/v1/storage-backends/${backend.id}/${action}`, { method: "POST" });
    if (!res.ok) {
      this.#error = `${toStatus === "deprecated" ? tt("adm.5e3e07") : tt("adm.1a1a97")} fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadStorageBackends();
  }

  async #deleteStorageBackend(backend: StorageBackend) {
    const ok = await confirmDialog(
      tt("adm.22ae39", { p0: backend.name, p1: backend.endpoint, p2: backend.bucket }) +
        tt("adm.cab673"),
      { confirmLabel: tt("adm.513d30") },
    );
    if (!ok) return;
    const res = await apiFetch(`/api/v1/storage-backends/${backend.id}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.64bd21", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadStorageBackends();
  }

  // backend == null: neues Backend anlegen (leeres Formular); sonst:
  // bestehendes bearbeiten (Felder vorbefüllt, Secret Key bewusst LEER
  // — s. #storageFormPayload-Doku, nie ein Klartext-Roundtrip eines
  // bereits gespeicherten Secrets).
  #openStorageForm(backend: StorageBackend | null) {
    this.#editingStorageBackend = backend;
    this.#storageForm = backend
      ? { name: backend.name, provider: backend.provider, endpoint: backend.endpoint, bucket: backend.bucket, accessKey: backend.accessKey, secretKey: "", useSsl: backend.useSsl }
      : { name: "", provider: "minio", endpoint: "", bucket: "", accessKey: "", secretKey: "", useSsl: false };
    this.#storageTestState = "idle";
    this.#storageTestMessage = "";
    this.#storageFormError = "";
    this.#showStorageForm = true;
    this.#render();
  }

  #closeStorageForm() {
    this.#showStorageForm = false;
    this.#editingStorageBackend = null;
    this.#render();
  }

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

  // ARCHITECTURE.md §25.2/§25.3 (UMSETZUNG.md D20) — s. #loadAudit-Doku
  // für dieselbe Cursor-/Refresh-Logik, hier zusätzlich mit den drei
  // Filtern aus GET /api/v1/logs (alle optional, leer = keine
  // Einschränkung, s. httpapi/log_handlers.go).
  #logsQuery(extra: Record<string, string>): string {
    const params = new URLSearchParams(extra);
    if (this.#logsTraceIdFilter) params.set("traceId", this.#logsTraceIdFilter);
    if (this.#logsNodeIdFilter) params.set("nodeId", this.#logsNodeIdFilter);
    if (this.#logsLevelFilter) params.set("level", this.#logsLevelFilter);
    return params.toString();
  }

  async #loadLogs() {
    try {
      const res = await apiFetch(`/api/v1/logs?${this.#logsQuery({ limit: String(LOG_PAGE_LIMIT) })}`);
      if (res.ok) {
        const page: LogEntry[] = await res.json();
        this.#logs = page;
        this.#logsHasMore = page.length === LOG_PAGE_LIMIT;
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll/SSE-Refresh holt es auf.
    }
  }

  async #loadMoreLogs() {
    if (this.#logsLoadingMore || this.#logs.length === 0) return;
    this.#logsLoadingMore = true;
    this.#render();
    try {
      const oldestID = this.#logs[this.#logs.length - 1].id;
      const res = await apiFetch(`/api/v1/logs?${this.#logsQuery({ before: String(oldestID), limit: String(LOG_PAGE_LIMIT) })}`);
      if (res.ok) {
        const page: LogEntry[] = await res.json();
        this.#logs = [...this.#logs, ...page];
        this.#logsHasMore = page.length === LOG_PAGE_LIMIT;
      }
    } catch {
      // Nächster Klick versucht es erneut.
    } finally {
      this.#logsLoadingMore = false;
      this.#render();
    }
  }

  #applyLogFilters(traceId: string, nodeId: string, level: string) {
    this.#logsTraceIdFilter = traceId.trim();
    this.#logsNodeIdFilter = nodeId.trim();
    this.#logsLevelFilter = level;
    this.#loadLogs();
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
      body: JSON.stringify({ username, password, orgId: this.#newUserOrgId || undefined }),
    });
    if (!res.ok) {
      this.#error = tt("adm.8f63e4", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#error = "";
    this.#newUsername = "";
    this.#newPassword = "";
    this.#newUserOrgId = "";
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
        this.#error = tt("adm.d125d4");
        this.#render();
        return;
      }
    }

    await this.#loadUsers();
  }

  async #deleteUser(username: string) {
    if (!(await confirmDialog(tt("adm.50e59c", { p0: username }), { confirmLabel: tt("adm.1010b0") }))) return;
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.05f6da", { p0: await res.text() });
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
      this.#error = tt("adm.5d0b05", { p0: await res.text() });
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
        subjectType: this.#newSubjectType,
        workflowId: this.#newWorkflowId || undefined,
        nodeId: this.#newNodeId,
        verb: this.#newVerb,
      }),
    });
    if (!res.ok) {
      this.#error = tt("adm.f397bc", { p0: await res.text() });
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
      !(await confirmDialog(tt("adm.a9b709", { p0: this.#subjectLabel(binding), p1: label, p2: VERB_LABEL[binding.verb] ?? binding.verb }), {
        confirmLabel: tt("adm.1010b0"),
      }))
    ) {
      return;
    }
    const res = await apiFetch(`/api/v1/admin/role-bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.05f6da", { p0: await res.text() });
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
        this.#error = tt("adm.b8b2ff", { p0: await res.text() });
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
      this.#error = tt("adm.b8b2ff", { p0: err });
    } finally {
      this.#creatingBackup = false;
      this.#render();
    }
  }

  // Nutzerfund 2026-08-27: eine zuvor heruntergeladene (oder von einem
  // anderen OMP-Deployment stammende) Backup-Datei hochladen und
  // zurückspielen können, nicht nur aus der Server-eigenen Liste
  // wählen. Rohe Bytes im Body (kein multipart/form-data nötig für
  // eine einzelne Datei) — POST /api/v1/admin/backups/upload legt sie
  // unter einem neuen, serverseitig vergebenen Namen in .backups/ ab
  // (backup.Service.Import, nie der Client-Dateiname). Nach Erfolg:
  // Liste neu laden UND die hochgeladene Datei direkt in der
  // bestehenden Restore-Auswahl vorselektieren — die getippte
  // Namens-Bestätigung bleibt unverändert Pflicht, dieser Weg spart
  // nur das Suchen in der Dropdown-Liste.
  async #uploadBackup(file: File) {
    this.#uploadingBackup = true;
    this.#error = "";
    this.#render();
    try {
      const data = await file.arrayBuffer();
      const res = await apiFetch("/api/v1/admin/backups/upload", {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: data,
      });
      if (!res.ok) {
        this.#error = tt("adm.31299d", { p0: await res.text() });
        return;
      }
      const body = (await res.json()) as { name: string };
      await this.#loadBackups();
      this.#restoreSelected = body.name;
      this.#restoreTyped = "";
    } catch (err) {
      this.#error = tt("adm.31299d", { p0: err });
    } finally {
      this.#uploadingBackup = false;
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
          this.#error = tt("adm.3eceda", { p0: await res.text() });
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
        this.#error = tt("adm.3eceda", { p0: err });
        this.#render();
      }
    })();
  }

  // ---- Node-Versionen (Kapitel 28) ----------------------------------------

  async #loadNodeVersions() {
    try {
      const [res, nodesRes] = await Promise.all([apiFetch("/api/v1/admin/node-versions"), apiFetch("/api/v1/nodes")]);
      if (res.ok) {
        this.#nv = (await res.json()) as NodeVersionOverview;
        this.#nvBuilds.clear();
        if (nodesRes.ok) {
          const nodes = (await nodesRes.json()) as { instance_id?: string; build?: { version: string; commit?: string } }[];
          for (const n of nodes) {
            if (n.instance_id && n.build) {
              this.#nvBuilds.set(n.instance_id, n.build.commit ? `${n.build.version} (${n.build.commit})` : n.build.version);
            }
          }
        }
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — der nächste Tab-Wechsel lädt neu.
    }
  }

  async #nodeVersionCall(url: string, init: RequestInit, failure: string): Promise<string | null> {
    this.#nvBusy = true;
    this.#error = "";
    this.#render();
    try {
      const res = await apiFetch(url, init);
      if (!res.ok) {
        this.#error = `${failure}: ${(await res.text()).trim()}`;
        return null;
      }
      return res.status === 204 ? "" : await res.text();
    } catch (err) {
      this.#error = `${failure}: ${err}`;
      return null;
    } finally {
      this.#nvBusy = false;
      await this.#loadNodeVersions();
      await this.#loadUpdates();
    }
  }

  async #setProductiveVersion(t: NodeVersionType, id: string, force = false): Promise<void> {
    const target = id === "" ? tt("adm.361528") : tt("adm.4c4de5", { p0: id });
    const ok = force || await confirmDialog(
      tt("adm.b5d818", { p0: t.name, p1: target }) +
        tt("adm.0e3a0a"),
      { confirmLabel: tt("adm.a8aea0") },
    );
    if (!ok) return;
    const res = await this.#nodeVersionCall(
      `/api/v1/admin/node-versions/${encodeURIComponent(t.name)}/productive`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: id, force }) },
      tt("adm.89b0ff"),
    );
    // Wechsel über eine Contract-Generation: erst nach ausdrücklicher Bestätigung (unbekannte Generationen nie).
    if (res === null && !force && /Wechsel über eine Contract-Generation/.test(this.#error)) {
      const msg = this.#error;
      if (await confirmDialog(`${msg}\n\nTrotzdem umstellen?`, { confirmLabel: tt("adm.88ca3b") })) {
        this.#error = "";
        await this.#setProductiveVersion(t, id, true);
      }
    }
  }

  async #loadRollout(name: string) {
    try {
      const res = await apiFetch(`/api/v1/admin/node-versions/${encodeURIComponent(name)}/rollout`);
      if (res.ok) this.#nvRollouts.set(name, (await res.json()) as RolloutStatus);
    } catch {
      // nächster Poll
    }
  }

  #pollRollout(name: string) {
    if (this.#nvRolloutPoll !== null) return;
    this.#nvRolloutPoll = window.setInterval(async () => {
      await this.#loadRollout(name);
      this.#render();
      if (!this.#nvRollouts.get(name)?.running && this.#nvRolloutPoll !== null) {
        window.clearInterval(this.#nvRolloutPoll);
        this.#nvRolloutPoll = null;
        await this.#loadNodeVersions();
      }
    }, 2000);
  }

  /** Plan zeigen, bestätigen, dann nacheinander umstellen (mit Rollback bei Fehler). */
  async #startRollout(t: NodeVersionType) {
    const call = (body: unknown) =>
      apiFetch(`/api/v1/admin/node-versions/${encodeURIComponent(t.name)}/rollout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    this.#error = "";
    const dry = await call({ dryRun: true });
    if (!dry.ok) {
      this.#error = (await dry.text()).trim();
      this.#render();
      return;
    }
    const plan = (await dry.json()) as RolloutStatus;
    if (plan.items.length === 0) {
      this.#error = tt("adm.224408");
      this.#render();
      return;
    }
    const lines = plan.items.map((i) => `• ${i.label} (${i.mode === "workflow-role" ? tt("adm.ad2749") : tt("adm.74cacb")}): ${i.from || "installiert"} → ${plan.target || "installiert"}`);
    const ok = await confirmDialog(
      tt("adm.9a9247", { p0: plan.items.length, p1: plan.target || tt("adm.361528"), p2: lines.join("\n") }) +
        tt("adm.150afc") +
        tt("adm.5d9e5b"),
      { confirmLabel: tt("adm.603736") },
    );
    if (!ok) return;
    const res = await call({ confirm: true });
    if (!res.ok) {
      this.#error = tt("adm.2597aa", { p0: (await res.text()).trim() });
      this.#render();
      return;
    }
    this.#nvRollouts.set(t.name, (await res.json()) as RolloutStatus);
    this.#render();
    this.#pollRollout(t.name);
  }

  async #deleteNodeVersion(t: NodeVersionType, id: string) {
    if (!(await confirmDialog(tt("adm.68797a", { p0: t.name, p1: id }), { confirmLabel: tt("adm.1010b0") }))) return;
    await this.#nodeVersionCall(
      `/api/v1/admin/node-versions/${encodeURIComponent(t.name)}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      tt("adm.290534"),
    );
  }

  #renderNodeVersionsSection(): HTMLElement {
    const section = document.createElement("div");
    const head = document.createElement("div");
    head.className = "omp-h1";
    head.textContent = tt("adm.2b5ab6");
    section.appendChild(head);

    const info = document.createElement("div");
    info.style.cssText = "color:var(--omp-text-dim);margin:6px 0 12px;white-space:pre-wrap;";
    info.textContent =
      tt("adm.667df2") +
      tt("adm.3ca706") +
      tt("adm.bfb34a");
    section.appendChild(info);

    const nv = this.#nv;
    if (!nv) {
      info.textContent += "\n\nWird geladen …";
      return section;
    }
    const rescan = document.createElement("button");
    rescan.textContent = tt("adm.3397a7");
    rescan.disabled = this.#nvBusy;
    rescan.style.cssText = "margin-bottom:12px;";
    rescan.addEventListener("click", () => void this.#nodeVersionCall("/api/v1/admin/node-versions/rescan", { method: "POST" }, tt("adm.ff58ad")));
    section.appendChild(rescan);

    for (const t of nv.types) {
      const card = document.createElement("div");
      card.className = "omp-card";
      card.style.cssText = "margin-bottom:10px;";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;";
      title.textContent = t.name + (t.catalogTypes?.length ? `  (${t.catalogTypes.join(", ")})` : "");
      card.appendChild(title);
      const state = document.createElement("div");
      state.style.cssText = "color:var(--omp-text-dim);margin:4px 0 8px;";
      const inst = t.installed ? `${t.installed.version}${t.installed.commit ? ` (${t.installed.commit})` : ""}` : tt("adm.2f5000");
      state.textContent = tt("adm.3846c6", { p0: inst, p1: t.productive || tt("adm.dfb6b8") });
      card.appendChild(state);

      if (t.versions.length > 0) {
        const table = document.createElement("table");
        table.style.cssText = "border-collapse:collapse;font-size:12px;margin-bottom:8px;";
        for (const v of t.versions) {
          const tr = document.createElement("tr");
          const cell = (text: string) => {
            const td = document.createElement("td");
            td.style.cssText = "padding:2px 14px 2px 0;";
            td.textContent = text;
            return td;
          };
          const isProd = v.id === t.productive;
          tr.append(
            cell(isProd ? `● ${v.id}` : v.id),
            cell(v.commit ?? ""),
            cell(`Gen ${v.contract ?? 1}`),
            cell(v.source ?? ""),
            cell(`${(v.size / 1048576).toFixed(1)} MB`),
          );
          const actions = document.createElement("td");
          const setBtn = document.createElement("button");
          setBtn.textContent = isProd ? "produktiv" : tt("adm.ec4dde");
          setBtn.disabled = isProd || this.#nvBusy;
          setBtn.addEventListener("click", () => void this.#setProductiveVersion(t, v.id));
          actions.appendChild(setBtn);
          if (!isProd) {
            const del = document.createElement("button");
            del.className = "omp-btn-danger";
            del.style.cssText = "margin-left:6px;";
            del.textContent = tt("adm.1010b0");
            del.disabled = this.#nvBusy;
            del.addEventListener("click", () => void this.#deleteNodeVersion(t, v.id));
            actions.appendChild(del);
          }
          tr.appendChild(actions);
          table.appendChild(tr);
        }
        card.appendChild(table);
      } else {
        const none = document.createElement("div");
        none.style.cssText = "color:var(--omp-text-dim);margin-bottom:8px;";
        none.textContent = tt("adm.8c876a");
        card.appendChild(none);
      }
      if (t.productive) {
        const back = document.createElement("button");
        back.textContent = tt("adm.0c7131");
        back.disabled = this.#nvBusy;
        back.addEventListener("click", () => void this.#setProductiveVersion(t, ""));
        card.appendChild(back);
      }
      // Rollout: laufende lokale Instanzen, die nicht mit der gewählten Version laufen
      const target = t.productive;
      const behind = t.instances.filter((i) => !i.remote && (i.nodeVersion ?? "") !== target);
      const ro = this.#nvRollouts.get(t.name);
      if (behind.length > 0 || ro?.running) {
        const row = document.createElement("div");
        row.style.cssText = "margin-top:8px;";
        const btn = document.createElement("button");
        btn.textContent = ro?.running ? tt("adm.f43217") : tt("adm.2d37e3", { p0: behind.length, p1: target || tt("adm.dfb6b8") });
        btn.disabled = !!ro?.running || this.#nvBusy;
        btn.addEventListener("click", () => void this.#startRollout(t));
        row.appendChild(btn);
        if (ro && ro.items.length > 0) {
          const list = document.createElement("div");
          list.style.cssText = "margin-top:6px;font-size:11px;";
          const marks: Record<string, string> = { ok: "✓", rolled_back: "↩", failed: "✗", running: "…", pending: "·", skipped: "–" };
          for (const i of ro.items) {
            const line = document.createElement("div");
            line.style.cssText = i.state === "failed" || i.state === "rolled_back" ? "color:var(--omp-danger,#d33);" : "";
            line.textContent = `${marks[i.state] ?? "?"} ${i.label}: ${i.state}${i.detail ? ` — ${i.detail}` : ""}`;
            list.appendChild(line);
          }
          row.appendChild(list);
        }
        card.appendChild(row);
      }
      if (t.instances.length > 0) {
        const list = document.createElement("div");
        list.style.cssText = "margin-top:8px;font-size:11px;color:var(--omp-text-dim);";
        for (const i of t.instances) {
          const line = document.createElement("div");
          const build = this.#nvBuilds.get(i.id);
          line.textContent =
            `${i.label}: ${build ?? tt("adm.00b3d4")}${i.nodeVersion ? tt("adm.db0548", { p0: i.nodeVersion }) : ""}` +
            (i.outdated ? tt("adm.66a668") : "") +
            (i.remote ? tt("adm.4f37c8") : "");
          list.appendChild(line);
        }
        card.appendChild(list);
      }
      section.appendChild(card);
    }
    return section;
  }

  // ---- System-Update -----------------------------------------------------

  async #loadUpdates() {
    try {
      const res = await apiFetch("/api/v1/admin/updates");
      if (res.ok) {
        this.#upd = (await res.json()) as UpdateOverview;
        if (this.#updSelected && !this.#upd.packages.some((p) => p.id === this.#updSelected)) {
          this.#updSelected = "";
          this.#updTyped = "";
        }
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — der nächste Wechsel auf den Tab lädt neu.
    }
  }

  async #uploadUpdate(file: File) {
    this.#updUploading = true;
    this.#error = "";
    this.#render();
    try {
      // Rohe Bytes wie beim Backup-Upload; der Server streamt auf Platte
      // und prüft Struktur, Prüfsummen und Signatur.
      const res = await apiFetch("/api/v1/admin/updates/upload", {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: file,
      });
      if (!res.ok) {
        this.#error = tt("adm.207f5e", { p0: (await res.text()).trim() });
        return;
      }
      const entry = (await res.json()) as UpdatePackage;
      await this.#loadUpdates();
      this.#updSelected = entry.id;
      this.#updTyped = "";
      this.#updForce = false;
    } catch (err) {
      this.#error = tt("adm.31299d", { p0: err });
    } finally {
      this.#updUploading = false;
      this.#render();
    }
  }

  // Verteilt das Paket an alle Remote-Hosts (Host-Agents laden es mit einem
  // Einmal-Token, prüfen es mit ihrem eigenen Schlüssel und ersetzen Agent-
  // und Node-Binaries). Ergebnis je Host erscheint live in der Liste.
  async #distributeUpdate(pkg: UpdatePackage) {
    const ok = await confirmDialog(
      tt("adm.17421d", { p0: pkg.version }) +
        tt("adm.41c0d3") +
        tt("adm.77ae28"),
      { confirmLabel: tt("adm.b63a37") },
    );
    if (!ok) return;
    this.#error = "";
    const res = await apiFetch(`/api/v1/admin/updates/${encodeURIComponent(pkg.id)}/distribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, version: pkg.version }),
    });
    if (!res.ok) {
      this.#error = tt("adm.a7b1ed", { p0: (await res.text()).trim() });
      this.#render();
      return;
    }
    await this.#loadUpdates();
    this.#pollDistribution();
  }

  #pollDistribution() {
    if (this.#updPollHandle !== null) return;
    this.#updPollHandle = window.setInterval(async () => {
      await this.#loadUpdates();
      if (!this.#upd?.distribution?.running && this.#updPollHandle !== null) {
        window.clearInterval(this.#updPollHandle);
        this.#updPollHandle = null;
      }
    }, 2000);
  }

  // Startet veraltete Instanzen (Binary durch ein Update ersetzt) neu —
  // Workflow-Rollen über RestartRole (stabile IDs), freistehende Instanzen
  // per Stop + Start. Bewusst eine eigene, bestätigte Aktion: ein Update
  // startet nie selbstständig laufende Sendungen neu.
  async #restartOutdated() {
    const n = this.#upd?.outdatedInstances ?? 0;
    const ok = await confirmDialog(
      tt("adm.98298f", { p0: n }) +
        tt("adm.979273"),
      { confirmLabel: tt("adm.bad5b8") },
    );
    if (!ok) return;
    this.#restartingOutdated = true;
    this.#error = "";
    this.#render();
    try {
      const res = await apiFetch("/api/v1/admin/updates/restart-outdated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        this.#error = tt("adm.7b8028", { p0: (await res.text()).trim() });
      } else {
        const body = (await res.json()) as { results: { label: string; ok: boolean; error?: string }[] };
        const failed = body.results.filter((r) => !r.ok);
        if (failed.length > 0) {
          this.#error = tt("adm.e89f49", { p0: failed.map((f) => `${f.label} (${f.error})`).join("; ") });
        }
      }
    } catch (err) {
      this.#error = tt("adm.7b8028", { p0: err });
    } finally {
      this.#restartingOutdated = false;
      // Telemetrie/Prozessstart brauchen einen Moment, bis das Badge verschwindet.
      window.setTimeout(() => void this.#loadUpdates(), 3000);
      await this.#loadUpdates();
      this.#render();
    }
  }

  async #deleteUpdate(id: string) {
    const ok = await confirmDialog(tt("adm.901c45", { p0: id }), { confirmLabel: tt("adm.1010b0") });
    if (!ok) return;
    const res = await apiFetch(`/api/v1/admin/updates/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.05f6da", { p0: (await res.text()).trim() });
    }
    await this.#loadUpdates();
    this.#render();
  }

  async #applyUpdate(pkg: UpdatePackage) {
    if (this.#updTyped !== pkg.version) return;
    const migrations = pkg.manifest.migrations ?? [];
    const confirmed = await confirmDialog(
      tt("adm.1ec094", { p0: pkg.version }) +
        tt("adm.7dd803") +
        tt("adm.776d94") +
        (migrations.length > 0 ? tt("adm.e117f9", { p0: migrations.length }) : ""),
      { confirmLabel: tt("adm.6c6655") },
    );
    if (!confirmed) return;

    this.#updApplying = true;
    this.#error = "";
    this.#render();
    try {
      const res = await apiFetch(`/api/v1/admin/updates/${encodeURIComponent(pkg.id)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, version: pkg.version, backup: this.#updBackup, force: this.#updForce }),
      });
      if (!res.ok) {
        // Klarer Fehlschlag VOR dem eigentlichen Update (Prüfung, Backup,
        // Supervisor) — der Server lebt unverändert weiter.
        this.#error = tt("adm.20f290", { p0: (await res.text()).trim() });
        this.#updApplying = false;
        this.#render();
        return;
      }
    } catch {
      // Mehrdeutig wie beim Restore (s. #restoreDatabase): Verbindungsfehler
      // oder Prozess schon gestorben — beide führen in denselben Reconnect.
    }
    this.#waitForReconnectAndReload();
  }

  #renderUpdateSection(): HTMLElement {
    if (this.#updApplying || this.#reconnecting) {
      const box = document.createElement("div");
      box.className = "omp-card";
      box.innerHTML =
        `<div class="omp-h1">${tt("adm.a346cd")}</div>` +
        `<div style="color:var(--omp-text-dim);margin-top:8px;">${tt("adm.ed0484")} ` +
        tt("adm.737d1d") +
        tt("adm.450de1") +
        `${tt("adm.64e9be")}</div>`;
      return box;
    }

    const section = document.createElement("div");
    const upd = this.#upd;

    const head = document.createElement("div");
    head.className = "omp-h1";
    head.textContent = tt("adm.059a95");
    section.appendChild(head);

    // Kapitel „Firmware“: aktuelle Version gut sichtbar, auch solange die
    // Übersicht noch lädt oder das Update-System nicht aktiviert ist.
    const fw = document.createElement("div");
    fw.className = "omp-firmware-version";
    fw.style.cssText = "font-size:18px;font-weight:600;margin:4px 0;";
    fw.textContent = upd ? formatFirmwareLong(upd.current) : tt("adm.2a87f2");
    if (!upd) void fetchBuildInfo().then((i) => { if (i && !this.#upd) fw.textContent = formatFirmwareLong(i); });
    section.appendChild(fw);

    const info = document.createElement("div");
    info.style.cssText = "color:var(--omp-text-dim);margin:6px 0 12px;white-space:pre-wrap;";
    if (!upd) {
      info.textContent = tt("adm.cd73c1");
      section.appendChild(info);
      return section;
    }
    info.textContent =
      (upd.trustedKeys.length > 0
        ? tt("adm.f4f4c4", { p0: upd.trustedKeys.join(", ") })
        : tt("adm.e898a8")) +
      (upd.allowUnsigned ? tt("adm.9df498") : "");
    section.appendChild(info);

    if (upd.outdatedInstances > 0) {
      const warn = document.createElement("div");
      warn.style.cssText = "margin-bottom:12px;padding:6px 10px;border:1px solid var(--omp-warn, #b8860b);border-radius:var(--omp-radius);";
      warn.textContent =
        tt("adm.e9553d", { p0: upd.outdatedInstances }) +
        tt("adm.9301a7");
      const restartBtn = document.createElement("button");
      restartBtn.style.cssText = "margin-left:10px;";
      restartBtn.textContent = this.#restartingOutdated ? tt("adm.0c2f79") : tt("adm.b7843f");
      restartBtn.disabled = this.#restartingOutdated;
      restartBtn.addEventListener("click", () => void this.#restartOutdated());
      warn.appendChild(restartBtn);
      section.appendChild(warn);
    }

    const sup = upd.supervisor;
    if (sup && sup.kind === "update" && sup.busy) {
      const busy = document.createElement("div");
      busy.style.cssText = "margin-bottom:12px;";
      busy.textContent = tt("adm.d5fe38", { p0: sup.version ?? "?", p1: sup.phase ?? "?" });
      section.appendChild(busy);
    }
    if (upd.supervisorError) {
      const e = document.createElement("div");
      e.style.cssText = "margin-bottom:12px;color:var(--omp-danger, #d33);";
      e.textContent = tt("adm.9e6d27", { p0: upd.supervisorError });
      section.appendChild(e);
    }

    // Upload
    const uploadRow = document.createElement("div");
    uploadRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:var(--omp-space-3);";
    const uploadLabel = document.createElement("span");
    uploadLabel.textContent = this.#updUploading ? tt("adm.e2bdb7") : tt("adm.684cab");
    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.accept = ".gz,.tar.gz,application/gzip";
    uploadInput.disabled = this.#updUploading;
    uploadInput.addEventListener("change", () => {
      if (uploadInput.files?.[0]) void this.#uploadUpdate(uploadInput.files[0]);
    });
    uploadRow.append(uploadLabel, uploadInput);
    section.appendChild(uploadRow);

    // Pakete
    const pkgHead = document.createElement("div");
    pkgHead.style.cssText = "font-weight:600;margin-bottom:6px;";
    pkgHead.textContent = tt("adm.e05a6b", { p0: upd.packages.length });
    section.appendChild(pkgHead);
    if (upd.packages.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);margin-bottom:12px;";
      empty.textContent = tt("adm.7fcec6");
      section.appendChild(empty);
    }
    for (const pkg of upd.packages) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--omp-border);";
      const label = document.createElement("span");
      label.style.cssText = "flex:1;";
      label.textContent =
        `${pkg.version} · ${(pkg.size / (1024 * 1024)).toFixed(1)} MB · ${pkg.signed ? tt("adm.fc16a0", { p0: pkg.keyId }) : "NICHT signiert"}` +
        ` · ${new Date(pkg.uploadedAt).toLocaleString()}`;
      const pick = document.createElement("button");
      pick.textContent = pkg.id === this.#updSelected ? tt("adm.9ac107") : tt("adm.751a99");
      pick.disabled = pkg.id === this.#updSelected;
      pick.addEventListener("click", () => {
        this.#updSelected = pkg.id;
        this.#updTyped = "";
        this.#updForce = false;
        this.#render();
      });
      const del = document.createElement("button");
      del.textContent = tt("adm.1010b0");
      del.addEventListener("click", () => void this.#deleteUpdate(pkg.id));
      row.append(label, pick, del);
      section.appendChild(row);
    }

    const selected = upd.packages.find((p) => p.id === this.#updSelected);
    if (selected) {
      const m = selected.manifest;
      const detail = document.createElement("div");
      detail.className = "omp-card";
      detail.style.cssText = "margin-top:12px;";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:6px;";
      title.textContent = tt("adm.4c4de5", { p0: selected.version });
      detail.appendChild(title);
      const meta = document.createElement("div");
      meta.style.cssText = "color:var(--omp-text-dim);white-space:pre-wrap;margin-bottom:8px;";
      meta.textContent =
        tt("adm.6bf4de", { p0: m.arch, p1: m.gitCommit ? ` · Commit ${m.gitCommit}` : "", p2: m.builtAt ? ` · gebaut ${m.builtAt}` : "" }) +
        `SHA-256: ${selected.sha256}\n` +
        (m.minFromVersion ? tt("adm.cbe66e", { p0: m.minFromVersion }) : "") +
        (m.notes ? tt("adm.b57cef", { p0: m.notes }) : "");
      detail.appendChild(meta);
      if ((m.migrations ?? []).length > 0) {
        const mig = document.createElement("div");
        mig.style.cssText = "margin-bottom:8px;color:var(--omp-warn, #b8860b);";
        mig.textContent = tt("adm.2ebe10", { p0: m.migrations!.join(", ") });
        detail.appendChild(mig);
      }
      const comps = document.createElement("table");
      comps.style.cssText = "border-collapse:collapse;margin-bottom:8px;font-size:11px;";
      for (const c of m.components) {
        const tr = document.createElement("tr");
        const a = document.createElement("td");
        a.style.cssText = "padding:1px 10px 1px 0;";
        a.textContent = c.id;
        const b = document.createElement("td");
        b.style.cssText = "padding:1px 0;color:var(--omp-text-dim);";
        b.textContent = `→ ${c.target}`;
        tr.append(a, b);
        comps.appendChild(tr);
      }
      detail.appendChild(comps);

      // Verteilung an Remote-Hosts (unabhängig vom lokalen Installieren).
      const dist = upd.distribution && upd.distribution.packageId === selected.id ? upd.distribution : null;
      const distRow = document.createElement("div");
      distRow.style.cssText = "margin-bottom:10px;";
      const distBtn = document.createElement("button");
      distBtn.textContent = dist?.running ? tt("adm.3f6065") : "An Remote-Hosts verteilen";
      distBtn.disabled = !!dist?.running || (!selected.signed && !upd.allowUnsigned);
      distBtn.addEventListener("click", () => void this.#distributeUpdate(selected));
      distRow.appendChild(distBtn);
      if (dist) {
        const list = document.createElement("div");
        list.style.cssText = "margin-top:6px;font-size:11px;";
        for (const h of dist.hosts) {
          const line = document.createElement("div");
          line.style.cssText = "padding:1px 0;white-space:pre-wrap;" + (h.state === "failed" || h.state === "offline" ? "color:var(--omp-danger, #d33);" : "");
          const mark = h.state === "ok" ? "✓" : h.state === "pending" ? "…" : "✗";
          line.textContent = `${mark} ${h.label}: ${h.state}${h.detail ? ` — ${h.detail}` : ""}`;
          list.appendChild(line);
        }
        if (dist.hosts.length === 0) list.textContent = tt("adm.a85888");
        distRow.appendChild(list);
      }
      detail.appendChild(distRow);

      const backupLbl = document.createElement("label");
      backupLbl.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
      const backupCb = document.createElement("input");
      backupCb.type = "checkbox";
      backupCb.checked = this.#updBackup || (m.migrations ?? []).length > 0;
      backupCb.disabled = (m.migrations ?? []).length > 0;
      backupCb.addEventListener("change", () => (this.#updBackup = backupCb.checked));
      backupLbl.append(backupCb, document.createTextNode(tt("adm.c0fc67")));
      detail.appendChild(backupLbl);

      const forceLbl = document.createElement("label");
      forceLbl.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
      const forceCb = document.createElement("input");
      forceCb.type = "checkbox";
      forceCb.checked = this.#updForce;
      forceCb.addEventListener("change", () => (this.#updForce = forceCb.checked));
      forceLbl.append(forceCb, document.createTextNode(tt("adm.a2eeb2")));
      detail.appendChild(forceLbl);

      const confirmLabel = document.createElement("div");
      confirmLabel.style.cssText = "color:var(--omp-text-dim);margin-bottom:4px;";
      confirmLabel.textContent = tt("adm.700ea0", { p0: selected.version });
      detail.appendChild(confirmLabel);
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;";
      const typed = document.createElement("input");
      typed.type = "text";
      typed.value = this.#updTyped;
      typed.placeholder = selected.version;
      const go = document.createElement("button");
      go.textContent = tt("adm.69a300");
      go.disabled = this.#updTyped !== selected.version || !selected.signed && !upd.allowUnsigned;
      typed.addEventListener("input", () => {
        this.#updTyped = typed.value;
        go.disabled = this.#updTyped !== selected.version || (!selected.signed && !upd.allowUnsigned);
      });
      go.addEventListener("click", () => void this.#applyUpdate(selected));
      row.append(typed, go);
      detail.appendChild(row);
      section.appendChild(detail);
    }

    // Verlauf
    const histHead = document.createElement("div");
    histHead.style.cssText = "font-weight:600;margin:16px 0 6px;";
    histHead.textContent = tt("adm.2f93d5");
    section.appendChild(histHead);
    if (upd.history.length === 0) {
      const none = document.createElement("div");
      none.style.cssText = "color:var(--omp-text-dim);";
      none.textContent = tt("adm.641ad5");
      section.appendChild(none);
    }
    for (const h of upd.history) {
      const line = document.createElement("div");
      line.style.cssText = "padding:3px 0;white-space:pre-wrap;" + (h.ok ? "" : "color:var(--omp-danger, #d33);");
      line.textContent =
        `${new Date(h.time).toLocaleString()} · ${h.from ? `${h.from} → ` : ""}${h.version} · ` +
        (h.ok ? "erfolgreich" : h.rolledBack ? tt("adm.5a64e9") : "FEHLGESCHLAGEN") +
        (h.error ? `\n${h.error}` : "");
      section.appendChild(line);
    }

    const refresh = document.createElement("button");
    refresh.style.cssText = "margin-top:12px;";
    refresh.textContent = tt("adm.bf3cfc");
    refresh.addEventListener("click", () => void this.#loadUpdates());
    section.appendChild(refresh);
    return section;
  }

  // Löst POST /api/v1/admin/restore aus — nur erreichbar, wenn
  // #restoreTyped exakt #restoreSelected entspricht (s. #restoreSelected-
  // Doku), plus eine zusätzliche confirmDialog()-Rückfrage direkt davor
  // (gleiches Muster wie überall sonst in dieser Datei für destruktive
  // Aktionen, z. B. #removeRole in role-designer.ts).
  async #restoreDatabase() {
    if (!this.#restoreSelected || this.#restoreTyped !== this.#restoreSelected) return;
    const confirmed = await confirmDialog(
      tt("adm.13e8c8", { p0: this.#restoreSelected }) +
        tt("adm.d62715") +
        tt("adm.676834"),
      { confirmLabel: tt("adm.c8ef6c") },
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
        this.#error = tt("adm.3f341c", { p0: await res.text() });
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
      this.#error = tt("adm.e91dd5");
    }
    this.#render();
  }

  async #importCatalogEntry() {
    if (!this.#newCatalogType || !this.#newCatalogImage) return;
    let env: Record<string, string>;
    try {
      env = JSON.parse(this.#newCatalogEnvText || "{}");
    } catch {
      this.#error = tt("adm.1ee99d");
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
        this.#error = tt("adm.6cdb17", { p0: await res.text() });
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
    const versionLabel = entry.version ? tt("adm.c32b0c", { p0: entry.version }) : "";
    if (!(await confirmDialog(tt("adm.34066f", { p0: entry.label, p1: versionLabel }), { confirmLabel: tt("adm.513d30") })))
      return;
    const q = entry.version ? `?version=${encodeURIComponent(entry.version)}` : "";
    const res = await apiFetch(`/api/v1/catalog/${encodeURIComponent(entry.type)}${q}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.64bd21", { p0: await res.text() });
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
      this.#error = tt("adm.8a554c", { p0: await res.text() });
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

  // Nutzerfund 2026-08-27 (live im eigenen Testlauf desselben Tages
  // erlebt): der Leader konnte sich selbst entfernen, auch als
  // einziges verbleibendes Mitglied — das bricht den Cluster dauerhaft
  // (kein Mitglied mehr übrig, das je wieder eine Wahl abhalten
  // könnte). Serverseitig jetzt hart abgelehnt
  // (cluster.ErrLastVoterIsLeader) — dieser Client-seitige Guard
  // verhindert zusätzlich den unnötigen Rundlauf UND macht die
  // Einschränkung sichtbar, bevor überhaupt geklickt wird (s.
  // #renderClusterPeerRow: Button ist für genau diesen Fall
  // deaktiviert). Entfernt der Leader sich selbst, während ANDERE
  // Mitglieder übrig bleiben, ist das dagegen ein unterstützter Vorgang
  // (Neuwahl unter den Verbleibenden, raft.Config.ShutdownOnRemove) —
  // nur eine deutlichere Warnung statt eines Blocks.
  async #leaveClusterMember(peer: ClusterPeer) {
    const isLeader = peer.id === this.#cluster?.leaderId;
    const memberCount = this.#cluster?.peers.length ?? 0;
    if (isLeader && memberCount <= 1) {
      this.#error =
        tt("adm.e66e64", { p0: peer.id }) +
        tt("adm.835eb0");
      this.#render();
      return;
    }
    const message = isLeader
      ? tt("adm.4e0b70", { p0: peer.id, p1: peer.raftAddr }) +
        tt("adm.b8b22a", { p0: memberCount - 1 })
      : tt("adm.f7c6bf", { p0: peer.id, p1: peer.raftAddr });
    if (!(await confirmDialog(message, { confirmLabel: tt("adm.513d30") }))) return;
    const res = await apiFetch(`/api/v1/cluster/members/${encodeURIComponent(peer.id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = tt("adm.64bd21", { p0: await res.text() });
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
    heading.textContent = t("admin.title");
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
      case "organizations":
        this.appendChild(this.#renderOrganizationsSection());
        break;
      case "groups":
        this.appendChild(this.#renderGroupsSection());
        break;
      case "bindings":
        this.appendChild(this.#renderBindingsSection());
        break;
      case "catalog":
        this.appendChild(this.#renderCatalogSection());
        break;
      case "storage":
        this.appendChild(this.#renderStorageSection());
        this.#locationsView ??= document.createElement("omp-locations-view");
        this.appendChild(this.#locationsView);
        break;
      case "audit":
        this.appendChild(this.#renderAuditSection());
        break;
      case "diagnose":
        this.appendChild(this.#renderDiagnoseSection());
        break;
      case "backup":
        this.appendChild(this.#renderBackupSection());
        break;
      case "update":
        this.appendChild(this.#renderUpdateSection());
        break;
      case "playout":
        this.#playoutView ??= document.createElement("omp-playout-admin");
        this.appendChild(this.#playoutView);
        break;
      case "audio":
        this.#audioRulesView ??= document.createElement("omp-audio-rules");
        this.appendChild(this.#audioRulesView);
        break;
      case "settings":
        this.#settingsView ??= document.createElement("omp-settings-view");
        this.appendChild(this.#settingsView);
        break;
      case "nodeversions":
        this.appendChild(this.#renderNodeVersionsSection());
        break;
      case "cluster":
        this.appendChild(this.#renderClusterSection());
        break;
    }
  }

  #renderTabBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.setAttribute("data-role", "admin-sub-tabs");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:var(--omp-space-2) var(--omp-space-4);margin-bottom:var(--omp-space-3);";
    for (const group of ADMIN_SUB_TAB_GROUPS) {
      const box = document.createElement("div");
      box.setAttribute("data-group", group.id);
      box.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:var(--omp-space-2);";
      const label = document.createElement("span");
      label.textContent = t(group.labelKey);
      label.style.cssText =
        "font-size:var(--omp-font-size-xs);text-transform:uppercase;letter-spacing:0.05em;color:var(--omp-text-dim);";
      box.appendChild(label);
      for (const tab of group.tabs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = t(tab.labelKey);
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
        box.appendChild(btn);
      }
      bar.appendChild(box);
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
    title.textContent = tt("adm.da5fc1", { p0: this.#users.length });
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showUserForm ? tt("adm.4b9727") : tt("adm.e6319b");
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showUserForm = !this.#showUserForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    // Nutzerfund 2026-09-24 ("es muss immer klar sichtbar sein welcher
    // user welche rechte hat"): zeigt auf einen Blick, wo diese Ansicht
    // hinführt, statt dass man erst "Rollenbindungen"/"Gruppen" einzeln
    // durchsuchen und im Kopf zusammenrechnen muss.
    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      tt("adm.a9e8b4") +
      tt("adm.e2e8f7") +
      tt("adm.7bb70b");
    section.appendChild(hint);

    if (this.#showUserForm) {
      section.appendChild(this.#renderUserForm());
    }

    if (this.#users.length === 0 && !this.#showUserForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.5ea427");
      section.appendChild(empty);
      return section;
    }

    if (this.#users.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">${tt("adm.f5f8d4")}</th>
        <th style="padding:2px 8px;">${tt("adm.2c51ef")}</th>
        <th style="padding:2px 8px;">${tt("adm.17b83a")}</th>
        <th style="padding:2px 8px;">${tt("adm.e897f3")}</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const u of this.#users) {
        tbody.appendChild(this.#renderUserRow(u));
      }
      table.appendChild(tbody);
      section.appendChild(table);

      const expanded = this.#users.find((u) => u.username === this.#rightsExpandedUsername);
      if (expanded) section.appendChild(this.#renderUserRightsPanel(expanded));
    }

    return section;
  }

  // Alle Gruppen, in denen username Mitglied ist — löst #allGroupMembers
  // (Cache aller Gruppen-Mitgliederlisten) gegen #groups auf.
  #userGroups(username: string): Group[] {
    return this.#groups.filter((g) => (this.#allGroupMembers.get(g.id) ?? []).includes(username));
  }

  // Alle Rollenbindungen, deren Subjekt diese eine Gruppe ist — Gegenstück
  // zu #userDirectBindings, beide zusammen ergeben die vollständigen
  // effektiven Rechte eines Nutzers (s. #renderUserRightsPanel).
  #groupBindings(groupId: string): RoleBinding[] {
    return this.#bindings.filter((b) => b.subjectType === "group" && b.subject === groupId);
  }

  #userDirectBindings(username: string): RoleBinding[] {
    return this.#bindings.filter((b) => b.subjectType === "user" && b.subject === username);
  }

  // Rechte-Übersicht (Nutzerfund 2026-09-24): fasst zusammen, was heute
  // auf drei Unteransichten verteilt ist (Rollenbindungen nach Nutzer,
  // Rollenbindungen nach Gruppe, Gruppenmitgliedschaft) — direkte
  // Bindungen UND alle über Gruppenmitgliedschaft geerbten, mit
  // funktionierendem Löschen-Button (reuse #renderBindingGroup), damit
  // diese Ansicht nicht nur informiert, sondern auch der Ort ist, an dem
  // man ein überflüssiges Recht gleich entfernen kann.
  #renderUserRightsPanel(u: UserEntry): HTMLElement {
    const panel = document.createElement("div");
    panel.style.cssText =
      "margin:4px 0 var(--omp-space-3) 0;padding:10px 12px;border:1px solid var(--omp-border);" +
      "border-radius:var(--omp-radius);background:var(--omp-surface-raised);";

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-bottom:6px;";
    heading.textContent = tt("adm.4820a0", { p0: u.username });
    panel.appendChild(heading);

    if (u.isAdmin) {
      const note = document.createElement("div");
      note.style.cssText = "color:var(--omp-preset);font-size:var(--omp-font-size-xs);margin-bottom:6px;";
      note.textContent = tt("adm.64b2a5");
      panel.appendChild(note);
    }

    const direct = this.#userDirectBindings(u.username);
    if (direct.length > 0) {
      panel.appendChild(this.#renderBindingGroup(tt("adm.65f9b0"), direct, "scope"));
    }

    const groups = this.#userGroups(u.username);
    let anyGroupRights = false;
    for (const g of groups) {
      const bindings = this.#groupBindings(g.id);
      if (bindings.length === 0) continue;
      anyGroupRights = true;
      panel.appendChild(this.#renderBindingGroup(tt("adm.5241aa", { p0: g.name }), bindings, "scope"));
    }

    if (groups.length > 0 && !anyGroupRights) {
      const note = document.createElement("div");
      note.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:4px;";
      note.textContent = tt("adm.89d043", { p0: groups.map((g) => g.name).join(", ") });
      panel.appendChild(note);
    }

    if (!u.isAdmin && direct.length === 0 && !anyGroupRights) {
      const note = document.createElement("div");
      note.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
      note.textContent =
        tt("adm.1f9d88") +
        tt("adm.1e5016");
      panel.appendChild(note);
    }

    return panel;
  }

  #renderUserForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const userInput = document.createElement("input");
    userInput.placeholder = tt("adm.f5f8d4");
    userInput.autocomplete = "off";
    userInput.value = this.#newUsername;
    userInput.style.cssText = "flex:1;min-width:100px;";
    userInput.addEventListener("input", () => {
      this.#newUsername = userInput.value;
    });

    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = tt("adm.3e45af");
    passInput.autocomplete = "new-password";
    passInput.value = this.#newPassword;
    passInput.style.cssText = "flex:1;min-width:100px;";
    passInput.addEventListener("input", () => {
      this.#newPassword = passInput.value;
    });
    passInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#createUser();
    });

    const orgSelect = this.#renderOrgSelect(this.#newUserOrgId, (value) => {
      this.#newUserOrgId = value;
    });
    orgSelect.style.cssText = "flex:1;min-width:100px;";

    const createBtn = document.createElement("button");
    createBtn.textContent = tt("adm.6212ff");
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createUser());

    form.append(userInput, passInput, orgSelect, createBtn);
    return form;
  }

  // Gemeinsamer Organisations-Auswahl-Helfer für Anlage-Formular UND
  // Inline-"Organisation ändern" (#renderUserRow) — "" ist immer die
  // Default-Organisation (s. auth.Service.CreateUser/UpdateUserOrg-
  // Doku), nicht irgendein Sonderwert.
  #renderOrgSelect(value: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = document.createElement("select");
    for (const org of this.#organizations) {
      const opt = document.createElement("option");
      opt.value = org.id;
      opt.textContent = org.id === "default" ? `${org.name} (Standard)` : org.name;
      select.appendChild(opt);
    }
    select.value = value || "default";
    select.addEventListener("change", () => onChange(select.value === "default" ? "" : select.value));
    return select;
  }

  // Name statt roher ID anzeigen — fällt auf die ID selbst zurück, falls
  // #organizations noch nicht geladen ist (kurzes Zeitfenster beim
  // ersten Render).
  #orgName(orgId: string): string {
    const id = orgId || "default";
    return this.#organizations.find((o) => o.id === id)?.name ?? id;
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

    const orgTd = document.createElement("td");
    orgTd.style.cssText = "padding:2px 8px;";
    if (this.#orgChangeTarget === u.username) {
      const select = this.#renderOrgSelect(u.orgId, () => {});
      select.style.cssText = "font-size:11px;";
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "OK";
      confirmBtn.style.cssText = "font-size:11px;cursor:pointer;margin-left:4px;";
      confirmBtn.addEventListener("click", () => void this.#changeUserOrg(u.username, select.value === "default" ? "" : select.value));
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "×";
      cancelBtn.style.cssText = "cursor:pointer;margin-left:2px;";
      cancelBtn.addEventListener("click", () => {
        this.#orgChangeTarget = null;
        this.#render();
      });
      orgTd.append(select, confirmBtn, cancelBtn);
    } else {
      const nameSpan = document.createElement("span");
      nameSpan.textContent = this.#orgName(u.orgId);
      const changeBtn = document.createElement("button");
      changeBtn.textContent = tt("adm.94b42c");
      changeBtn.title = tt("adm.7ea51d");
      changeBtn.style.cssText = "font-size:11px;cursor:pointer;margin-left:6px;";
      changeBtn.addEventListener("click", () => {
        this.#orgChangeTarget = u.username;
        this.#resetTarget = null;
        this.#render();
      });
      orgTd.append(nameSpan, changeBtn);
    }
    tr.appendChild(orgTd);

    const roleTd = document.createElement("td");
    roleTd.style.cssText = "padding:2px 8px;";
    if (u.isAdmin) {
      const badge = document.createElement("span");
      badge.textContent = tt("adm.e3afed");
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
      pwInput.placeholder = tt("adm.191f52");
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

    const rightsBtn = document.createElement("button");
    const rightsOpen = this.#rightsExpandedUsername === u.username;
    rightsBtn.textContent = rightsOpen ? tt("adm.a294ab") : tt("adm.ae7313");
    rightsBtn.title = tt("adm.927eb5");
    rightsBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    rightsBtn.addEventListener("click", () => {
      this.#rightsExpandedUsername = rightsOpen ? null : u.username;
      this.#render();
    });

    const resetBtn = document.createElement("button");
    resetBtn.textContent = tt("adm.3e45af");
    resetBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    resetBtn.addEventListener("click", () => {
      this.#resetTarget = u.username;
      this.#resetPassword = "";
      this.#orgChangeTarget = null;
      this.#render();
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = tt("adm.1010b0");
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => this.#deleteUser(u.username));

    actionsTd.append(rightsBtn, resetBtn, delBtn);
    tr.appendChild(actionsTd);
    return tr;
  }

  // Organisationen (Kapitel 21 B14 UI-Anbindung, Nachtrag 284) — gleiche
  // Sub-Tab-Form wie #renderUsersSection (Titel+Zähler, "+ Neu"-Formular,
  // Tabelle). Zielgruppe: ein Admin, der noch nie mit Mandantenfähigkeit
  // gearbeitet hat — daher der erklärende Hinweistext statt vorauszusetzen,
  // dass "Organisation" selbsterklärend ist.
  #renderOrganizationsSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = tt("adm.201c47", { p0: this.#organizations.length });
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showOrgForm ? tt("adm.4b9727") : tt("adm.42d3b7");
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showOrgForm = !this.#showOrgForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      tt("adm.8e03b1") +
      tt("adm.51113f");
    section.appendChild(hint);

    if (this.#showOrgForm) {
      section.appendChild(this.#renderOrgForm());
    }

    if (this.#organizations.length === 0 && !this.#showOrgForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.cc1552");
      section.appendChild(empty);
      return section;
    }

    if (this.#organizations.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">${tt("adm.49ee30")}</th>
        <th style="padding:2px 8px;">${tt("adm.b718ad")}</th>
        <th style="padding:2px 8px;">${tt("adm.2c51ef")}</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const org of this.#organizations) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="padding:2px 8px;">${org.id === "default" ? `${escapeHtml(org.name)} <span style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${tt("adm.312ccb")}</span>` : escapeHtml(org.name)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);">${escapeHtml(org.id)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${new Date(org.createdAt).toLocaleString()}</td>
        `;
        const actionsTd = document.createElement("td");
        actionsTd.style.cssText = "padding:2px 8px;text-align:right;";
        if (org.id !== "default") {
          const delBtn = document.createElement("button");
          delBtn.textContent = tt("adm.1010b0");
          delBtn.className = "omp-btn-danger";
          delBtn.style.cssText = "font-size:11px;";
          delBtn.addEventListener("click", () => void this.#deleteOrganization(org));
          actionsTd.appendChild(delBtn);
        }
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderOrgForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const nameInput = document.createElement("input");
    nameInput.placeholder = tt("adm.90292d");
    nameInput.autocomplete = "off";
    nameInput.value = this.#newOrgName;
    nameInput.style.cssText = "flex:1;min-width:160px;";
    nameInput.addEventListener("input", () => {
      this.#newOrgName = nameInput.value;
    });
    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void this.#createOrganization();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = tt("adm.6212ff");
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => void this.#createOrganization());

    form.append(nameInput, createBtn);
    queueMicrotask(() => nameInput.focus());
    return form;
  }

  // Storage-Backends (Nutzerauftrag 2026-09-24: "asset folder should be
  // able to be dynamically added/removed without the need of restart...
  // only super admins may config this... i dont like hidden configs at
  // all... full control (with warnings, protection guards, hints,
  // wizards) and full overview"). Gleiche Sub-Tab-Form wie die anderen
  // Abschnitte (Titel+Zähler, "+ Neu"-Formular, Tabelle) — der
  // erklärende Hinweistext ist hier bewusst länger, da diese Funktion
  // ein serverseitiges Vorabgesetztes voraussetzt (OMP_STORAGE_SECRET_KEY),
  // das die UI selbst nicht setzen kann (s. #storageFeatureDisabled).
  #renderStorageSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText = "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = tt("adm.a45bce", { p0: this.#storageBackends.length });
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showStorageForm ? tt("adm.4b9727") : "+ Neues Backend";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      if (this.#showStorageForm) this.#closeStorageForm();
      else this.#openStorageForm(null);
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      tt("adm.1033d2") +
      tt("adm.5a8979");
    section.appendChild(hint);

    if (this.#storageFeatureDisabled) {
      const info = document.createElement("div");
      info.style.cssText =
        "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:var(--omp-space-3);" +
        "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);";
      info.innerHTML = `
        <div style="font-weight:600;color:var(--omp-text);margin-bottom:4px;">${tt("adm.074a2f")}</div>
        <div>${tt("adm.027b77")} <code>${tt("adm.ee8dd8")}</code> ${tt("adm.73e569")}</div>
        <div style="margin-top:8px;">${tt("adm.c2730d")} <code>${tt("adm.4aa4d5")}</code>${tt("adm.93d4c0")}</div>
      `;
      section.appendChild(info);
      return section;
    }

    if (this.#showStorageForm) {
      section.appendChild(this.#renderStorageForm());
    }

    if (this.#storageBackends.length === 0 && !this.#showStorageForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.9534f2");
      section.appendChild(empty);
      return section;
    }

    if (this.#storageBackends.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">${tt("adm.49ee30")}</th>
        <th style="padding:2px 8px;">${tt("adm.2a6ba7")}</th>
        <th style="padding:2px 8px;">${tt("adm.30edf7")}</th>
        <th style="padding:2px 8px;">${tt("adm.2e3a68")}</th>
        <th style="padding:2px 8px;">${tt("adm.ea52c3")}</th>
        <th style="padding:2px 8px;">${tt("adm.ec53a8")}</th>
        <th style="padding:2px 8px;">${tt("adm.2c51ef")}</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const b of this.#storageBackends) {
        tbody.appendChild(this.#renderStorageRow(b));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderStorageRow(b: StorageBackend): HTMLElement {
    const tr = document.createElement("tr");
    const statusBadge = b.status === "active"
      ? `<span style="color:var(--omp-preset);font-size:11px;font-weight:600;">${tt("adm.b47c95")}</span>`
      : `<span style="color:var(--omp-text-dim);font-size:11px;">${tt("adm.7c76fa")}</span>`;
    tr.innerHTML = `
      <td style="padding:2px 8px;font-weight:600;">${escapeHtml(b.name)}</td>
      <td style="padding:2px 8px;color:var(--omp-text-dim);word-break:break-all;">${escapeHtml(b.endpoint)}</td>
      <td style="padding:2px 8px;">${escapeHtml(b.bucket)}</td>
      <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(b.accessKey)}</td>
      <td style="padding:2px 8px;">${b.useSsl ? "ja" : "nein"}</td>
      <td style="padding:2px 8px;">${statusBadge}</td>
      <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(b.createdBy)}, ${new Date(b.createdAt).toLocaleDateString()}</td>
    `;
    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;white-space:nowrap;";

    const editBtn = document.createElement("button");
    editBtn.textContent = tt("adm.5ad05d");
    editBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    editBtn.addEventListener("click", () => this.#openStorageForm(b));
    actionsTd.appendChild(editBtn);

    const lifecycleBtn = document.createElement("button");
    lifecycleBtn.textContent = b.status === "active" ? tt("adm.5e3e07") : tt("adm.1a1a97");
    lifecycleBtn.title = b.status === "active"
      ? tt("adm.c0171a")
      : tt("adm.9cf390");
    lifecycleBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    lifecycleBtn.addEventListener("click", () => void this.#setStorageBackendLifecycle(b, b.status === "active" ? "deprecated" : "active"));
    actionsTd.appendChild(lifecycleBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = tt("adm.513d30");
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => void this.#deleteStorageBackend(b));
    actionsTd.appendChild(delBtn);

    tr.appendChild(actionsTd);
    return tr;
  }

  // Der Wizard: alle Felder auf einer Seite (kein mehrseitiger Stepper
  // nötig, um "Schritte" zu erfüllen) + ein "Verbindung testen"-Schritt
  // VOR dem Speichern mit sichtbarem Ergebnis direkt im Formular.
  #renderStorageForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:var(--omp-space-3);" +
      "margin-bottom:var(--omp-space-2);max-width:640px;";

    if (!document.getElementById("omp-storage-provider-suggestions")) {
      const dl = document.createElement("datalist");
      dl.id = "omp-storage-provider-suggestions";
      for (const v of ["minio", "s3"]) {
        const opt = document.createElement("option");
        opt.value = v;
        dl.appendChild(opt);
      }
      document.body.appendChild(dl);
    }

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";

    const field = (labelText: string, input: HTMLElement) => {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;";
      const l = document.createElement("span");
      l.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
      l.textContent = labelText;
      wrap.append(l, input);
      return wrap;
    };
    const textInput = (value: string, placeholder: string, onInput: (v: string) => void, opts: { type?: string; list?: string } = {}) => {
      const i = document.createElement("input");
      i.type = opts.type ?? "text";
      i.placeholder = placeholder;
      i.value = value;
      i.autocomplete = "off";
      if (opts.list) i.setAttribute("list", opts.list);
      i.style.cssText = "width:100%;box-sizing:border-box;";
      i.addEventListener("input", () => onInput(i.value));
      return i;
    };

    const f = this.#storageForm;
    const invalidateTest = () => {
      // Jede inhaltliche Änderung entwertet ein bisheriges "Verbindung
      // erfolgreich" — der Test bezieht sich sonst auf Werte, die nicht
      // mehr aktuell sind (echter, kleiner "protection guard").
      if (this.#storageTestState !== "idle") {
        this.#storageTestState = "idle";
        this.#storageTestMessage = "";
      }
    };

    grid.append(
      field(tt("adm.2688a5"), textInput(f.name, tt("adm.5fc938"), (v) => { f.name = v; invalidateTest(); })),
      field(tt("adm.b13884"), textInput(f.provider, "minio / s3", (v) => { f.provider = v; invalidateTest(); }, { list: "omp-storage-provider-suggestions" })),
      field(tt("adm.c35977"), textInput(f.endpoint, "z. B. 127.0.0.1:9000", (v) => { f.endpoint = v; invalidateTest(); })),
      field(tt("adm.af0262"), textInput(f.bucket, tt("adm.f2129f"), (v) => { f.bucket = v; invalidateTest(); })),
      field(tt("adm.3871a2"), textInput(f.accessKey, "", (v) => { f.accessKey = v; invalidateTest(); })),
      field(tt("adm.5eb6bb") + (this.#editingStorageBackend ? tt("adm.f85e9e") : " *"),
        textInput(f.secretKey, this.#editingStorageBackend ? tt("adm.2109fc") : "", (v) => { f.secretKey = v; invalidateTest(); }, { type: "password" })),
    );
    form.appendChild(grid);

    const sslLabel = document.createElement("label");
    sslLabel.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    const sslCb = document.createElement("input");
    sslCb.type = "checkbox";
    sslCb.checked = f.useSsl;
    sslCb.addEventListener("change", () => { f.useSsl = sslCb.checked; invalidateTest(); });
    sslLabel.append(sslCb, document.createTextNode("TLS/SSL verwenden"));
    form.appendChild(sslLabel);

    const testRow = document.createElement("div");
    testRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:12px;";
    const testBtn = document.createElement("button");
    testBtn.textContent = this.#storageTestState === "testing" ? tt("adm.8264ad") : tt("adm.6a0795");
    testBtn.disabled = this.#storageTestState === "testing";
    testBtn.style.cssText = "cursor:pointer;";
    testBtn.addEventListener("click", () => void this.#testStorageConnection());
    testRow.appendChild(testBtn);
    if (this.#storageTestMessage) {
      const msg = document.createElement("span");
      msg.style.cssText = `font-size:var(--omp-font-size-xs);color:${this.#storageTestState === "ok" ? "var(--omp-preset)" : "var(--omp-error)"};`;
      msg.textContent = (this.#storageTestState === "ok" ? "✓ " : "✗ ") + this.#storageTestMessage;
      testRow.appendChild(msg);
    }
    form.appendChild(testRow);

    if (this.#storageFormError) {
      const err = document.createElement("div");
      err.style.cssText = "color:var(--omp-error);font-size:var(--omp-font-size-xs);margin-top:8px;white-space:pre-wrap;";
      err.textContent = this.#storageFormError;
      form.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = tt("adm.4b9727");
    cancelBtn.style.cssText = "cursor:pointer;";
    cancelBtn.addEventListener("click", () => this.#closeStorageForm());
    const saveBtn = document.createElement("button");
    saveBtn.className = "omp-btn-primary";
    saveBtn.textContent = this.#editingStorageBackend ? tt("adm.b97d23") : tt("adm.6212ff");
    saveBtn.addEventListener("click", () => {
      if (!f.name.trim() || !f.provider.trim() || !f.endpoint.trim() || !f.bucket.trim() || !f.accessKey.trim()) {
        this.#storageFormError = tt("adm.3149a3");
        this.#render();
        return;
      }
      if (!this.#editingStorageBackend && !f.secretKey) {
        this.#storageFormError = tt("adm.7121c2");
        this.#render();
        return;
      }
      void this.#submitStorageForm();
    });
    actions.append(cancelBtn, saveBtn);
    form.appendChild(actions);

    return form;
  }

  // Gruppen (Nutzerauftrag 2026-09-24: gruppenbasierte Rechteverwaltung,
  // auch als Vorbereitung für eine spätere Windows-Active-Directory-
  // Anbindung). Gleiche flache Tabellen-Form wie Organisationen/
  // Storage-Backends (kein Split-Pane wie asset-view.ts — konsistent
  // mit dem Rest dieser Datei): eine Zeile pro Gruppe, "Mitglieder"
  // klappt ein Panel darunter auf statt in eine separate Ansicht zu
  // wechseln.
  #renderGroupsSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText = "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = tt("adm.1265eb", { p0: this.#groups.length });
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showGroupForm ? tt("adm.4b9727") : tt("adm.663258");
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showGroupForm = !this.#showGroupForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      tt("adm.022b83") +
      tt("adm.06144f") +
      tt("adm.1d455d");
    section.appendChild(hint);

    if (this.#showGroupForm) {
      section.appendChild(this.#renderGroupCreateForm());
    }

    if (this.#groups.length === 0 && !this.#showGroupForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.657888");
      section.appendChild(empty);
      return section;
    }

    for (const g of this.#groups) {
      section.appendChild(this.#renderGroupRow(g));
    }

    return section;
  }

  #renderGroupCreateForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const nameInput = document.createElement("input");
    nameInput.placeholder = tt("adm.916ea4");
    nameInput.autocomplete = "off";
    nameInput.value = this.#newGroupName;
    nameInput.style.cssText = "flex:1;min-width:140px;";
    nameInput.addEventListener("input", () => {
      this.#newGroupName = nameInput.value;
    });

    const descInput = document.createElement("input");
    descInput.placeholder = tt("adm.234de2");
    descInput.autocomplete = "off";
    descInput.value = this.#newGroupDescription;
    descInput.style.cssText = "flex:2;min-width:180px;";
    descInput.addEventListener("input", () => {
      this.#newGroupDescription = descInput.value;
    });
    descInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void this.#createGroup();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = tt("adm.6212ff");
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => void this.#createGroup());

    form.append(nameInput, descInput, createBtn);
    queueMicrotask(() => nameInput.focus());
    return form;
  }

  #renderGroupRow(g: Group): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "border-bottom:1px solid var(--omp-border);padding:6px 0;";

    const isEditing = this.#editingGroup?.id === g.id;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;";

    if (isEditing) {
      const nameInput = document.createElement("input");
      nameInput.value = g.name;
      nameInput.style.cssText = "flex:1;min-width:140px;";
      const descInput = document.createElement("input");
      descInput.value = g.description ?? "";
      descInput.placeholder = tt("adm.35bedb");
      descInput.style.cssText = "flex:2;min-width:180px;";
      const left = document.createElement("div");
      left.style.cssText = "display:flex;gap:6px;flex:1;";
      left.append(nameInput, descInput);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = tt("adm.b97d23");
      saveBtn.style.cssText = "font-size:11px;cursor:pointer;";
      saveBtn.addEventListener("click", () => void this.#updateGroup(g, nameInput.value, descInput.value));
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "×";
      cancelBtn.style.cssText = "cursor:pointer;";
      cancelBtn.addEventListener("click", () => {
        this.#editingGroup = null;
        this.#render();
      });
      row.append(left, saveBtn, cancelBtn);
      wrap.appendChild(row);
      queueMicrotask(() => nameInput.focus());
      return wrap;
    }

    const info = document.createElement("div");
    info.innerHTML = `<span style="font-weight:600;">${escapeHtml(g.name)}</span>` +
      (g.description ? ` <span style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">— ${escapeHtml(g.description)}</span>` : "");
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:4px;flex-shrink:0;";
    const membersBtn = document.createElement("button");
    membersBtn.textContent = this.#selectedGroupId === g.id ? tt("adm.ee5ce7") : tt("adm.be45f7");
    membersBtn.style.cssText = "font-size:11px;cursor:pointer;";
    membersBtn.addEventListener("click", () => {
      if (this.#selectedGroupId === g.id) {
        this.#selectedGroupId = null;
        this.#render();
      } else {
        this.#selectGroup(g.id);
      }
    });
    const editBtn = document.createElement("button");
    editBtn.textContent = tt("adm.5ad05d");
    editBtn.style.cssText = "font-size:11px;cursor:pointer;";
    editBtn.addEventListener("click", () => {
      this.#editingGroup = g;
      this.#render();
    });
    const delBtn = document.createElement("button");
    delBtn.textContent = tt("adm.1010b0");
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    delBtn.addEventListener("click", () => void this.#deleteGroup(g));
    actions.append(membersBtn, editBtn, delBtn);
    row.appendChild(actions);
    wrap.appendChild(row);

    if (this.#selectedGroupId === g.id) {
      wrap.appendChild(this.#renderGroupMembersPanel(g));
    }

    return wrap;
  }

  #renderGroupMembersPanel(g: Group): HTMLElement {
    const panel = document.createElement("div");
    panel.style.cssText = "margin:8px 0 4px 16px;padding:8px;border-left:2px solid var(--omp-border);";

    const heading = document.createElement("div");
    heading.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);margin-bottom:4px;";
    heading.textContent = tt("adm.6a7843", { p0: this.#groupMembers.length });
    panel.appendChild(heading);

    if (this.#groupMembers.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:6px;";
      empty.textContent = tt("adm.638b34");
      panel.appendChild(empty);
    } else {
      for (const username of this.#groupMembers) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:2px 0;";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = username;
        const rmBtn = document.createElement("button");
        rmBtn.textContent = tt("adm.513d30");
        rmBtn.style.cssText = "font-size:11px;cursor:pointer;";
        rmBtn.addEventListener("click", () => void this.#removeGroupMember(g.id, username));
        row.append(nameSpan, rmBtn);
        panel.appendChild(row);
      }
    }

    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex;gap:6px;margin-top:6px;";
    const userInput = document.createElement("input");
    userInput.placeholder = tt("adm.f5f8d4");
    userInput.value = this.#newGroupMemberUsername;
    userInput.style.cssText = "font-size:11px;flex:1;min-width:100px;";
    userInput.addEventListener("input", () => {
      this.#newGroupMemberUsername = userInput.value;
    });
    userInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void this.#addGroupMember(g.id, userInput.value);
    });
    const addBtn = document.createElement("button");
    addBtn.textContent = tt("adm.e2d84f");
    addBtn.style.cssText = "font-size:11px;cursor:pointer;";
    addBtn.addEventListener("click", () => void this.#addGroupMember(g.id, userInput.value));
    addRow.append(userInput, addBtn);
    panel.appendChild(addRow);

    // Nutzerfund 2026-09-24: die Rechte einer Gruppe direkt hier zeigen,
    // statt dass man dafür in den Rollenbindungen-Tab wechseln und dort
    // per Auge nach "👥 <dieser Gruppenname>" suchen muss — derselbe
    // Reuse von #renderBindingGroup wie in #renderUserRightsPanel, inkl.
    // funktionierendem Löschen-Button.
    const groupBindings = this.#groupBindings(g.id);
    if (groupBindings.length === 0) {
      const rightsHeading = document.createElement("div");
      rightsHeading.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);margin:10px 0 4px;";
      rightsHeading.textContent = tt("adm.ccdd47");
      panel.appendChild(rightsHeading);
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
      empty.textContent = tt("adm.422405");
      panel.appendChild(empty);
    } else {
      const rightsBox = this.#renderBindingGroup(tt("adm.ccdd47"), groupBindings, "scope");
      rightsBox.style.marginTop = "10px";
      panel.appendChild(rightsBox);
    }

    return panel;
  }

  #renderBindingsSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;gap:8px;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = tt("adm.2578ee", { p0: this.#bindings.length });

    const right = document.createElement("div");
    right.style.cssText = "display:flex;gap:8px;align-items:center;";
    right.appendChild(this.#renderBindingsGroupToggle());

    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showBindingForm ? tt("adm.4b9727") : tt("adm.473936");
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showBindingForm = !this.#showBindingForm;
      this.#render();
    });
    right.appendChild(newBtn);

    heading.append(title, right);
    section.appendChild(heading);

    // Nutzerfund 2026-09-24: dieser Tab bleibt das rohe CRUD-Werkzeug
    // (jede einzelne Bindung anlegen/löschen) — für "was hat Nutzer X
    // insgesamt" (inkl. über Gruppen geerbt) verweist der Hinweis gezielt
    // auf die neue, zusammenfassende Ansicht statt dass man hier selbst
    // Nutzer- und Gruppen-Bindungen im Kopf zusammenrechnen muss.
    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
    hint.textContent =
      tt("adm.aa6c6f") +
      tt("adm.c4e6da");
    section.appendChild(hint);

    if (this.#showBindingForm) {
      section.appendChild(this.#renderBindingForm());
    }

    if (this.#bindings.length === 0 && !this.#showBindingForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.782a90");
      section.appendChild(empty);
      return section;
    }

    if (this.#bindings.length > 0) {
      section.appendChild(
        this.#bindingsGroupBy === "node" ? this.#renderBindingsByNode() : this.#renderBindingsBySubject(),
      );
    }

    return section;
  }

  // Nutzerwunsch 2026-09-11 (§12.3e-Folge): Umschalter zwischen "Nach
  // Nutzer" (Standard, entspricht dem bisherigen Verhalten) und "Nach
  // Node/Rolle" — dieselben #bindings, nur anders gruppiert, kein
  // Reload nötig.
  #renderBindingsGroupToggle(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    const options: { value: "subject" | "node"; label: string }[] = [
      { value: "subject", label: tt("adm.18c4aa") },
      { value: "node", label: tt("adm.d4bcb3") },
    ];
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      const active = this.#bindingsGroupBy === opt.value;
      btn.style.cssText =
        "font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 8px;" +
        (active
          ? "background:var(--omp-surface-raised);color:var(--omp-text);"
          : "background:transparent;color:var(--omp-text-dim);");
      btn.addEventListener("click", () => {
        if (this.#bindingsGroupBy === opt.value) return;
        this.#bindingsGroupBy = opt.value;
        this.#render();
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  // Gruppiert nach Nutzer: pro Nutzer eine Überschrift, darunter alle
  // Bereiche/Rechte, die dieser Nutzer hat — Blickrichtung "Nutzer
  // auswählen, dann sehen/zuweisen, worauf er zugreifen darf".
  // subjectLabel löst eine Gruppen-ID zu ihrem Namen auf (Nutzerauftrag
  // 2026-09-24: gruppenbasierte Rechteverwaltung) — fällt auf die rohe
  // ID zurück, falls #groups noch nicht geladen ist oder die Gruppe
  // zwischenzeitlich gelöscht wurde. "👥 " -Präfix macht auf einen
  // Blick sichtbar, dass es sich um eine Gruppe handelt, nicht um einen
  // einzelnen Nutzer.
  #subjectLabel(b: RoleBinding): string {
    if (b.subjectType !== "group") return b.subject;
    const name = this.#groups.find((g) => g.id === b.subject)?.name ?? b.subject;
    return `👥 ${name}`;
  }

  #renderBindingsBySubject(): HTMLElement {
    const wrap = document.createElement("div");
    const bySubject = new Map<string, { label: string; bindings: RoleBinding[] }>();
    for (const b of this.#bindings) {
      const key = `${b.subjectType}:${b.subject}`;
      if (!bySubject.has(key)) bySubject.set(key, { label: this.#subjectLabel(b), bindings: [] });
      bySubject.get(key)!.bindings.push(b);
    }
    const keys = [...bySubject.keys()].sort((a, b) => bySubject.get(a)!.label.localeCompare(bySubject.get(b)!.label));
    for (const key of keys) {
      const entry = bySubject.get(key)!;
      wrap.appendChild(this.#renderBindingGroup(entry.label, entry.bindings, "scope"));
    }
    return wrap;
  }

  // Gruppiert nach Node/Rolle: pro Node (bzw. Workflow→Rolle) eine
  // Überschrift, darunter alle Nutzer mit Zugriff darauf — Blickrichtung
  // "Node auswählen, dann sehen/zuweisen, welche Nutzer zugreifen dürfen"
  // (bisher fehlende Richtung, Nutzerwunsch 2026-09-11).
  #renderBindingsByNode(): HTMLElement {
    const wrap = document.createElement("div");
    const byScope = new Map<string, RoleBinding[]>();
    for (const b of this.#bindings) {
      const key = `${b.workflowId ?? ""}::${b.nodeId}`;
      if (!byScope.has(key)) byScope.set(key, []);
      byScope.get(key)!.push(b);
    }
    const keys = [...byScope.keys()].sort((a, b) =>
      this.#scopeLabel(byScope.get(a)![0]).localeCompare(this.#scopeLabel(byScope.get(b)![0])),
    );
    for (const key of keys) {
      const group = byScope.get(key)!;
      wrap.appendChild(this.#renderBindingGroup(this.#scopeLabel(group[0]), group, "subject"));
    }
    return wrap;
  }

  // columnKind bestimmt nur, welches Feld in der ersten Spalte steht
  // (das jeweils NICHT in der Gruppenüberschrift stehende) — Rest der
  // Zeile (Recht, Löschen-Button) ist in beiden Blickrichtungen gleich.
  #renderBindingGroup(headerLabel: string, bindings: RoleBinding[], columnKind: "scope" | "subject"): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText = "margin-bottom:10px;";

    const header = document.createElement("div");
    header.textContent = headerLabel;
    header.style.cssText = "font-weight:600;margin-bottom:2px;";
    box.appendChild(header);

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;margin-bottom:4px;";
    const tbody = document.createElement("tbody");
    for (const b of bindings) {
      const tr = document.createElement("tr");

      const labelTd = document.createElement("td");
      labelTd.style.cssText = "padding:2px 8px 2px 16px;color:var(--omp-text-dim);";
      labelTd.textContent = columnKind === "scope" ? this.#scopeLabel(b) : this.#subjectLabel(b);
      tr.appendChild(labelTd);

      const verbTd = document.createElement("td");
      verbTd.style.cssText = "padding:2px 8px;";
      verbTd.textContent = VERB_LABEL[b.verb] ?? b.verb;
      tr.appendChild(verbTd);

      const actionsTd = document.createElement("td");
      actionsTd.style.cssText = "padding:2px 8px;text-align:right;";
      const delBtn = document.createElement("button");
      delBtn.textContent = tt("adm.1010b0");
      delBtn.className = "omp-btn-danger";
      delBtn.style.cssText = "font-size:11px;";
      delBtn.addEventListener("click", () => this.#deleteBinding(b));
      actionsTd.appendChild(delBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  #renderBindingForm(): HTMLElement {
    const wrap = document.createElement("div");

    // Nutzerwunsch 2026-09-11: Anlage-Formular aus beiden Richtungen
    // bedienbar — reine Feld-Reihenfolge, #createBinding() selbst nimmt
    // in jeder Reihenfolge dieselben drei Werte (subject/scope/verb)
    // entgegen, s. dort.
    const dirToggle = document.createElement("div");
    dirToggle.style.cssText = "display:flex;gap:0;margin-bottom:6px;width:fit-content;" +
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    const dirOptions: { value: "userFirst" | "nodeFirst"; label: string }[] = [
      { value: "userFirst", label: tt("adm.e9cc81") },
      { value: "nodeFirst", label: tt("adm.75894c") },
    ];
    for (const opt of dirOptions) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      const active = this.#newBindingDirection === opt.value;
      btn.style.cssText =
        "font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 8px;" +
        (active
          ? "background:var(--omp-surface-raised);color:var(--omp-text);"
          : "background:transparent;color:var(--omp-text-dim);");
      btn.addEventListener("click", () => {
        if (this.#newBindingDirection === opt.value) return;
        this.#newBindingDirection = opt.value;
        this.#render();
      });
      dirToggle.appendChild(btn);
    }
    wrap.appendChild(dirToggle);

    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
    wrap.appendChild(form);

    // Subject-Typ-Umschalter (Nutzerauftrag 2026-09-24: gruppenbasierte
    // Rechteverwaltung) — "Nutzer" (unverändertes Freitext-Verhalten mit
    // Vorschlagsliste) oder "Gruppe" (Auswahl aus #groups statt Freitext,
    // eine erfundene Gruppen-ID ergäbe keine wirksame Bindung).
    const typeToggle = document.createElement("div");
    typeToggle.style.cssText = "display:flex;gap:0;width:fit-content;" +
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    for (const opt of [{ value: "user" as const, label: tt("adm.8a940a") }, { value: "group" as const, label: tt("adm.3b77a5") }]) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      const active = this.#newSubjectType === opt.value;
      btn.style.cssText =
        "font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 8px;" +
        (active ? "background:var(--omp-surface-raised);color:var(--omp-text);" : "background:transparent;color:var(--omp-text-dim);");
      btn.addEventListener("click", () => {
        if (this.#newSubjectType === opt.value) return;
        this.#newSubjectType = opt.value;
        this.#newSubject = "";
        this.#render();
      });
      typeToggle.appendChild(btn);
    }
    wrap.insertBefore(typeToggle, form);
    typeToggle.style.marginBottom = "6px";

    const subjectDatalistId = "omp-admin-user-datalist";
    const subjectInput = document.createElement("input");
    subjectInput.placeholder = tt("adm.f5f8d4");
    subjectInput.value = this.#newSubject;
    subjectInput.setAttribute("list", subjectDatalistId);
    subjectInput.style.cssText = "flex:1;min-width:100px;";
    subjectInput.addEventListener("input", () => {
      this.#newSubject = subjectInput.value;
    });
    const subjectDatalist = document.createElement("datalist");
    subjectDatalist.id = subjectDatalistId;
    for (const u of this.#users) {
      const opt = document.createElement("option");
      opt.value = u.username;
      subjectDatalist.appendChild(opt);
    }

    const groupSelect = document.createElement("select");
    groupSelect.style.cssText = "flex:1;min-width:100px;";
    const noGroupOpt = document.createElement("option");
    noGroupOpt.value = "";
    noGroupOpt.textContent = this.#groups.length ? tt("adm.e5b1cd") : tt("adm.14a665");
    groupSelect.appendChild(noGroupOpt);
    for (const grp of this.#groups) {
      const opt = document.createElement("option");
      opt.value = grp.id;
      opt.textContent = grp.name;
      if (grp.id === this.#newSubject) opt.selected = true;
      groupSelect.appendChild(opt);
    }
    groupSelect.addEventListener("change", () => {
      this.#newSubject = groupSelect.value;
    });

    // subjectField: je nach Typ entweder [Freitext-Input + Datalist]
    // oder [Auswahl-Select] — an derselben Stelle im Formular eingesetzt,
    // egal in welcher Richtung (userFirst/nodeFirst, s. o.).
    const subjectField: HTMLElement[] = this.#newSubjectType === "group" ? [groupSelect] : [subjectInput, subjectDatalist];

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
    nodeInput.placeholder = selectedWorkflow ? tt("adm.3096f0") : tt("adm.3a7309");
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
    anyOpt.label = selectedWorkflow ? tt("adm.e5c1c7") : tt("adm.a78fea");
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
    createBtn.textContent = tt("adm.6212ff");
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createBinding());

    if (this.#newBindingDirection === "nodeFirst") {
      form.append(workflowSelect, nodeInput, datalist, ...subjectField, verbSelect, createBtn);
    } else {
      form.append(...subjectField, workflowSelect, nodeInput, datalist, verbSelect, createBtn);
    }
    return wrap;
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
      return b.nodeId === "*" ? tt("adm.a78fea") : this.#nodeLabel(b.nodeId);
    }
    const wfName = this.#workflows.find((wf) => wf.id === b.workflowId)?.name ?? b.workflowId;
    return b.nodeId === "*" ? `${wfName} (ganzer Workflow)` : `${wfName} → ${b.nodeId}`;
  }

  // Node-Katalog-Redesign 2026-09-02: rein clientseitiger Filter über
  // Label/Typ/Beschreibung, alphabetisch (Nutzerwunsch 2026-07-28,
  // unverändert) — Katalog ist klein genug, kein Server-Roundtrip nötig.
  #filteredCatalog(): CatalogEntry[] {
    const sorted = this.#catalog.slice().sort((a, b) => a.label.localeCompare(b.label));
    const q = this.#catalogSearch.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q),
    );
  }

  #renderCatalogSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "margin-bottom:var(--omp-space-3);display:flex;justify-content:space-between;align-items:center;gap:var(--omp-space-3);flex-wrap:wrap;";
    const title = document.createElement("span");
    title.className = "omp-h1";
    title.textContent = tt("adm.3dda54", { p0: this.#catalog.length });
    heading.appendChild(title);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-2);";
    const searchWrap = document.createElement("span");
    searchWrap.className = "omp-search-wrap";
    const searchInput = document.createElement("input");
    searchInput.className = "omp-search-input";
    searchInput.type = "search";
    searchInput.placeholder = tt("adm.2132be");
    searchInput.value = this.#catalogSearch;
    searchInput.style.cssText = "width:220px;";
    searchInput.addEventListener("input", () => {
      this.#catalogSearch = searchInput.value;
      this.#render();
    });
    searchWrap.appendChild(searchInput);
    controls.appendChild(searchWrap);

    const newBtn = document.createElement("button");
    newBtn.className = "omp-btn-primary";
    newBtn.textContent = "+ Node/Microservice importieren";
    newBtn.addEventListener("click", () => {
      this.#showCatalogForm = true;
      this.#admissionResults = null;
      this.#render();
    });
    controls.appendChild(newBtn);
    heading.appendChild(controls);
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-3);";
    hint.textContent =
      tt("adm.438c04");
    section.appendChild(hint);

    const filtered = this.#filteredCatalog();
    if (filtered.length > 0) {
      const grid = document.createElement("div");
      grid.className = "omp-card-grid";
      for (const entry of filtered) grid.appendChild(this.#renderCatalogCard(entry));
      section.appendChild(grid);
    } else {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = this.#catalogSearch
        ? tt("adm.c7c031")
        : tt("adm.f74d2d");
      section.appendChild(empty);
    }

    if (this.#showCatalogForm) section.appendChild(this.#renderCatalogModal());

    return section;
  }

  #closeCatalogModal() {
    this.#showCatalogForm = false;
    this.#admissionResults = null;
    this.#render();
  }

  // Backdrop-Klick/Escape schließen das Modal, gleiches Prinzip wie
  // ui/kit/omp-confirm.ts — hier als schlichte Klassen statt einer eigenen
  // Shadow-DOM-Komponente, weil admin-view.ts ohnehin komplett neu rendert
  // (kein Promise-Rückgabewert nötig, nur #showCatalogForm/#render()).
  #renderCatalogModal(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) this.#closeCatalogModal();
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.#closeCatalogModal();
    });

    const modal = document.createElement("div");
    modal.className = "omp-modal";

    const modalHeading = document.createElement("div");
    modalHeading.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-3);";
    const modalTitle = document.createElement("span");
    modalTitle.className = "omp-h1";
    modalTitle.textContent = tt("adm.d2dfcc");
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", tt("adm.8311b9"));
    closeBtn.addEventListener("click", () => this.#closeCatalogModal());
    modalHeading.append(modalTitle, closeBtn);
    modal.appendChild(modalHeading);

    modal.appendChild(this.#renderCatalogForm());
    if (this.#admissionResults) modal.appendChild(this.#renderAdmissionResults(this.#admissionResults));

    overlay.appendChild(modal);
    // Erst nach dem tatsächlichen Einhängen fokussieren (dieser Aufruf
    // läuft synchron VOR dem umschließenden appendChild in #render()) —
    // sonst greift focus() ins Leere, weil das Feld noch nicht im Dokument
    // ist. Zugleich macht das Escape von Anfang an nutzbar (s. o.), ohne
    // dass der Nutzer erst ins Formular klicken muss.
    queueMicrotask(() => modal.querySelector("input")?.focus());
    return overlay;
  }

  #renderCatalogForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-3);";

    const fileRow = document.createElement("div");
    fileRow.style.cssText = "display:flex;align-items:center;gap:6px;";
    const fileLabel = document.createElement("span");
    fileLabel.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
    fileLabel.textContent = tt("adm.2256dc");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json";
    fileInput.style.cssText = "font-size:var(--omp-font-size-xs);";
    fileInput.addEventListener("change", () => {
      if (fileInput.files?.[0]) this.#loadCatalogFromFile(fileInput.files[0]);
    });
    fileRow.append(fileLabel, fileInput);
    form.appendChild(fileRow);

    // <label>, die Text + Feld umschließt, statt reiner Placeholder-
    // Beschriftung (Nutzerauftrag 2026-09-02, "modern, intuitiv") —
    // Feldnamen/State-Bindings unverändert gegenüber vorher.
    const mkField = (labelText: string, placeholder: string, value: string, onInput: (v: string) => void, width = "140px") => {
      const wrap = document.createElement("label");
      wrap.style.cssText =
        `display:flex;flex-direction:column;gap:2px;flex:1;min-width:${width};` +
        "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = labelText;
      wrap.appendChild(labelSpan);
      const input = document.createElement("input");
      input.placeholder = placeholder;
      input.value = value;
      input.addEventListener("input", () => onInput(input.value));
      wrap.appendChild(input);
      return wrap;
    };

    const fieldsRow = document.createElement("div");
    fieldsRow.style.cssText = "display:flex;gap:var(--omp-space-2);flex-wrap:wrap;";
    fieldsRow.append(
      mkField(tt("adm.c2ea84"), tt("adm.7c9eea"), this.#newCatalogType, (v) => (this.#newCatalogType = v)),
      mkField(tt("adm.b021df"), tt("adm.2eb6eb"), this.#newCatalogLabel, (v) => (this.#newCatalogLabel = v)),
      mkField(tt("adm.be53a0"), "registry/name:tag", this.#newCatalogImage, (v) => (this.#newCatalogImage = v), "220px"),
      mkField(tt("adm.34b6cd"), "optional", this.#newCatalogVersion, (v) => (this.#newCatalogVersion = v), "100px"),
    );
    form.appendChild(fieldsRow);

    const fieldsRow2 = document.createElement("div");
    fieldsRow2.style.cssText = "display:flex;gap:var(--omp-space-2);flex-wrap:wrap;";
    fieldsRow2.append(
      mkField(tt("adm.35bedb"), "optional", this.#newCatalogDescription, (v) => (this.#newCatalogDescription = v), "220px"),
      mkField(tt("adm.722ff0"), "z. B. ~5% CPU · ~40 MB RAM", this.#newCatalogExpectedResources, (v) => (this.#newCatalogExpectedResources = v)),
      mkField(tt("adm.ea50f3"), tt("adm.6f865e"), this.#newCatalogCommand, (v) => (this.#newCatalogCommand = v), "220px"),
    );
    form.appendChild(fieldsRow2);

    const envWrap = document.createElement("label");
    envWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
    const envLabel = document.createElement("span");
    envLabel.textContent = tt("adm.47a997");
    envWrap.appendChild(envLabel);
    const envInput = document.createElement("textarea");
    envInput.rows = 3;
    envInput.value = this.#newCatalogEnvText;
    envInput.style.cssText = "font-family:var(--omp-font-mono);font-size:var(--omp-font-size-xs);";
    envInput.addEventListener("input", () => {
      this.#newCatalogEnvText = envInput.value;
    });
    envWrap.appendChild(envInput);
    form.appendChild(envWrap);

    const importBtn = document.createElement("button");
    importBtn.className = "omp-btn-primary";
    importBtn.textContent = tt("adm.5af5fb");
    importBtn.style.cssText = "align-self:flex-start;";
    importBtn.addEventListener("click", () => this.#importCatalogEntry());
    form.appendChild(importBtn);

    return form;
  }

  #renderAdmissionResults(results: AdmissionResult[]): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText =
      "border:1px solid var(--omp-error);border-radius:var(--omp-radius);padding:var(--omp-space-2);margin-top:var(--omp-space-3);";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;color:var(--omp-error);margin-bottom:var(--omp-space-2);";
    title.textContent = tt("adm.7003e3");
    box.appendChild(title);
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;font-size:var(--omp-font-size-xs);";
    const badgeClass = (status: string) =>
      status === "FAIL" ? "omp-badge omp-badge-error" : status === "PASS" ? "omp-badge omp-badge-running" : "omp-badge";
    const rows = results
      .map(
        (r) => `<tr>
        <td style="padding:2px 8px;">${escapeHtml(r.Name)}</td>
        <td style="padding:2px 8px;"><span class="${badgeClass(r.Status)}">${escapeHtml(r.Status)}</span></td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(r.Detail)}</td>
      </tr>`,
      )
      .join("");
    table.innerHTML = rows;
    box.appendChild(table);
    return box;
  }

  #renderCatalogCard(entry: CatalogEntry): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    card.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-1);";
    const isImported = entry.runner === "podman";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--omp-space-2);";
    const label = document.createElement("span");
    label.style.cssText = "font-weight:600;";
    label.textContent = entry.label;
    const badge = document.createElement("span");
    badge.className = `omp-badge ${isImported ? "omp-badge-imported" : "omp-badge-builtin"}`;
    badge.textContent = isImported ? tt("adm.e9e1f9") : tt("adm.5e4eb4");
    head.append(label, badge);
    card.appendChild(head);

    const sub = document.createElement("div");
    sub.style.cssText = "font-family:var(--omp-font-mono);font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
    sub.textContent = `${entry.type}${entry.version ? " · " + entry.version : ""}`;
    card.appendChild(sub);

    // Nur bei vorhandenem Wert rendern (optionale Freitextfelder) — bisher
    // in der Tabelle unsichtbares Backend-Feld, s. plan-Kontext.
    if (entry.description) {
      const desc = document.createElement("div");
      desc.style.cssText = "font-size:var(--omp-font-size-sm);";
      desc.textContent = entry.description;
      card.appendChild(desc);
    }
    if (entry.expectedResources) {
      const res = document.createElement("div");
      res.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
      res.textContent = entry.expectedResources;
      card.appendChild(res);
    }
    if (isImported) {
      const image = document.createElement("div");
      image.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);word-break:break-all;";
      image.textContent = entry.image ?? "";
      card.appendChild(image);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:var(--omp-space-2);margin-top:var(--omp-space-2);";
    const exportBtn = document.createElement("button");
    exportBtn.textContent = tt("adm.0095a9");
    exportBtn.addEventListener("click", () => this.#exportCatalogEntry(entry));
    actions.appendChild(exportBtn);
    if (isImported) {
      const delBtn = document.createElement("button");
      delBtn.textContent = tt("adm.513d30");
      delBtn.className = "omp-btn-danger";
      delBtn.addEventListener("click", () => this.#removeCatalogEntry(entry));
      actions.appendChild(delBtn);
    }
    card.appendChild(actions);

    return card;
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
    heading.textContent = tt("adm.e6e18b", { p0: this.#audit.length });
    section.appendChild(heading);

    if (this.#audit.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = tt("adm.5f30db");
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
      <th style="padding:2px 8px;">${tt("adm.718271")}</th>
      <th style="padding:2px 8px;">${tt("adm.8a940a")}</th>
      <th style="padding:2px 8px;">${tt("adm.41aa69")}</th>
      <th style="padding:2px 8px;">${tt("adm.b6a791")}</th>
      <th style="padding:2px 8px;">${tt("adm.ec53a8")}</th>
    </tr></thead><tbody>${rows}</tbody>`;
    section.appendChild(table);

    if (this.#auditHasMore) {
      const moreBtn = document.createElement("button");
      moreBtn.textContent = this.#auditLoadingMore ? tt("adm.4446bb") : tt("adm.5cc9dd");
      moreBtn.disabled = this.#auditLoadingMore;
      moreBtn.style.cssText = "font-size:11px;cursor:pointer;margin-top:8px;";
      moreBtn.addEventListener("click", () => this.#loadMoreAudit());
      section.appendChild(moreBtn);
    }

    return section;
  }

  // ARCHITECTURE.md §25.3 (UMSETZUNG.md D20) — das Diagnose-Cockpit:
  // Rohdaten-Ansicht auf GET /api/v1/logs (D19), mit den drei Filtern
  // als Formular statt einer vollen Query-Sprache (reicht für "was ist
  // bei DIESER trace_id/diesem Node/auf diesem Level passiert",
  // §25-Anforderung). Ein gesetzter Trace-Filter macht aus der sonst
  // reinen Live-Tabelle bereits die geforderte "Trace-Waterfall"-Sicht
  // (alle Zeilen EINER Operation, chronologisch — Sortierung kommt
  // fertig sortiert vom Server, `ORDER BY id DESC`), ohne dass dafür
  // eine eigene Zeitleisten-Grafik nötig wäre.
  #renderDiagnoseSection(): HTMLElement {
    const section = document.createElement("div");

    const heading = document.createElement("div");
    heading.className = "omp-h1";
    heading.style.cssText = "margin-bottom:var(--omp-space-3);";
    heading.textContent = tt("adm.56f489", { p0: this.#logs.length });
    section.appendChild(heading);

    section.appendChild(this.#renderLogFilterForm());

    if (this.#logs.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent =
        this.#logsTraceIdFilter || this.#logsNodeIdFilter || this.#logsLevelFilter
          ? tt("adm.9a4c0a")
          : tt("adm.51ff86");
      section.appendChild(empty);
      return section;
    }

    const rows = this.#logs
      .map((e) => {
        const traceShort = e.traceId ? escapeHtml(e.traceId.slice(0, 8)) : "";
        return `<tr>
        <td style="padding:2px 8px;color:var(--omp-text-dim);white-space:nowrap;">${escapeHtml(new Date(e.occurredAt).toLocaleString())}</td>
        <td style="padding:2px 8px;color:${LOG_LEVEL_COLOR[e.level] ?? "var(--omp-text)"};text-transform:uppercase;font-size:11px;">${escapeHtml(e.level)}</td>
        <td style="padding:2px 8px;">${escapeHtml(e.nodeId || e.source)}</td>
        <td style="padding:2px 8px;font-family:monospace;cursor:${e.traceId ? "pointer" : "default"};" data-role="log-trace-cell" data-trace-id="${escapeHtml(e.traceId ?? "")}" title="${e.traceId ? tt("adm.36311b") + escapeHtml(e.traceId) : ""}">${traceShort}</td>
        <td style="padding:2px 8px;word-break:break-word;">${escapeHtml(e.message)}</td>
      </tr>`;
      })
      .join("");

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">${tt("adm.718271")}</th>
      <th style="padding:2px 8px;">${tt("adm.a0db49")}</th>
      <th style="padding:2px 8px;">${tt("adm.6c3a69")}</th>
      <th style="padding:2px 8px;">${tt("adm.dd4ec0")}</th>
      <th style="padding:2px 8px;">${tt("adm.d87d49")}</th>
    </tr></thead><tbody>${rows}</tbody>`;
    table.querySelectorAll('[data-role="log-trace-cell"]').forEach((cell) => {
      const traceId = cell.getAttribute("data-trace-id");
      if (!traceId) return;
      cell.addEventListener("click", () => this.showTrace(traceId));
    });
    section.appendChild(table);

    if (this.#logsHasMore) {
      const moreBtn = document.createElement("button");
      moreBtn.textContent = this.#logsLoadingMore ? tt("adm.4446bb") : tt("adm.5cc9dd");
      moreBtn.disabled = this.#logsLoadingMore;
      moreBtn.style.cssText = "font-size:11px;cursor:pointer;margin-top:8px;";
      moreBtn.addEventListener("click", () => this.#loadMoreLogs());
      section.appendChild(moreBtn);
    }

    return section;
  }

  #renderLogFilterForm(): HTMLElement {
    const form = document.createElement("form");
    form.style.cssText = "display:flex;gap:var(--omp-space-2);align-items:flex-end;margin-bottom:var(--omp-space-3);flex-wrap:wrap;";

    const field = (labelText: string, input: HTMLInputElement | HTMLSelectElement) => {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--omp-text-dim);";
      const span = document.createElement("span");
      span.textContent = labelText;
      input.style.cssText = "font-family:var(--omp-font);font-size:var(--omp-font-size-sm);padding:4px 6px;";
      wrap.append(span, input);
      return wrap;
    };

    const traceInput = document.createElement("input");
    traceInput.type = "text";
    traceInput.placeholder = "z. B. 7f66dab3…";
    traceInput.value = this.#logsTraceIdFilter;

    const nodeInput = document.createElement("input");
    nodeInput.type = "text";
    nodeInput.placeholder = tt("adm.fb9f6f");
    nodeInput.value = this.#logsNodeIdFilter;

    const levelSelect = document.createElement("select");
    for (const [value, label] of [
      ["", tt("adm.05e870")],
      ["error", tt("adm.902b0d")],
      ["warn", tt("adm.56525a")],
      ["info", tt("adm.4059b0")],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === this.#logsLevelFilter;
      levelSelect.appendChild(opt);
    }

    form.append(field(tt("adm.9cbd4a"), traceInput), field(tt("adm.fb9f6f"), nodeInput), field(tt("adm.a0db49"), levelSelect));

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.textContent = tt("adm.2b98bc");
    submitBtn.style.cssText = "font-size:11px;cursor:pointer;";
    form.appendChild(submitBtn);

    if (this.#logsTraceIdFilter || this.#logsNodeIdFilter || this.#logsLevelFilter) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.textContent = tt("adm.cf743f");
      clearBtn.style.cssText = "font-size:11px;cursor:pointer;";
      clearBtn.addEventListener("click", () => this.#applyLogFilters("", "", ""));
      form.appendChild(clearBtn);
    }

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.#applyLogFilters(traceInput.value, nodeInput.value, levelSelect.value);
    });

    return form;
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
    backupTitle.textContent = tt("adm.24f46f", { p0: this.#backups.length });
    const createBtn = document.createElement("button");
    createBtn.textContent = this.#creatingBackup ? tt("adm.97a791") : tt("adm.edb4fa");
    createBtn.disabled = this.#creatingBackup;
    createBtn.className = "omp-btn-primary";
    createBtn.style.cssText = "font-size:11px;cursor:pointer;";
    createBtn.addEventListener("click", () => void this.#createBackup());
    backupHeading.append(backupTitle, createBtn);
    section.appendChild(backupHeading);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);";
    hint.textContent =
      tt("adm.2b953c") +
      tt("adm.1e8584") +
      tt("adm.9349ee");
    section.appendChild(hint);

    if (this.#backups.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-4);";
      empty.textContent = tt("adm.b86bfc");
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
        dlBtn.textContent = tt("adm.2099e6");
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
    restoreHeading.textContent = tt("adm.2bd339");
    section.appendChild(restoreHeading);

    const uploadRow = document.createElement("div");
    uploadRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:var(--omp-space-3);";
    const uploadLabel = document.createElement("span");
    uploadLabel.style.cssText = "font-size:11px;color:var(--omp-text-dim);";
    uploadLabel.textContent = this.#uploadingBackup
      ? tt("adm.150dcd")
      : tt("adm.047e43");
    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.accept = ".gz,application/gzip";
    uploadInput.disabled = this.#uploadingBackup;
    uploadInput.style.cssText = "font-size:11px;";
    uploadInput.addEventListener("change", () => {
      if (uploadInput.files?.[0]) void this.#uploadBackup(uploadInput.files[0]);
    });
    uploadRow.append(uploadLabel, uploadInput);
    section.appendChild(uploadRow);

    if (this.#backups.length === 0) {
      const noBackups = document.createElement("div");
      noBackups.style.cssText = "color:var(--omp-text-dim);";
      noBackups.textContent = tt("adm.aec2da");
      section.appendChild(noBackups);
      return section;
    }

    const restoreHint = document.createElement("div");
    restoreHint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-2);white-space:pre-wrap;";
    restoreHint.textContent =
      tt("adm.2a2629") +
      tt("adm.316a1c") +
      tt("adm.46dc6f") +
      tt("adm.4ec161");
    section.appendChild(restoreHint);

    const select = document.createElement("select");
    select.style.cssText = "margin-bottom:var(--omp-space-2);";
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = tt("adm.2cfe4a");
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
      confirmLabel.textContent = tt("adm.80c34c", { p0: this.#restoreSelected });
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
      restoreBtn.textContent = tt("adm.c8ef6c");
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
    title.textContent = this.#restoring ? tt("adm.42e0ae") : tt("adm.ea2f07");
    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--omp-text-dim);";
    detail.textContent = this.#restoring
      ? tt("adm.69d86c")
      : tt("adm.e55e76") +
        tt("adm.84e42d");
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
    title.textContent = tt("adm.58518d", { p0: this.#cluster?.peers.length ?? 0 });
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;";
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = tt("adm.bf3cfc");
    refreshBtn.style.cssText = "font-size:11px;cursor:pointer;";
    refreshBtn.addEventListener("click", () => void this.#loadClusterStatus());
    const joinToggleBtn = document.createElement("button");
    joinToggleBtn.textContent = this.#showClusterJoinForm ? tt("adm.4b9727") : tt("adm.6c359d");
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
      empty.textContent = tt("adm.3a035f");
      section.appendChild(empty);
      return section;
    }

    const c = this.#cluster;
    const statusCard = document.createElement("div");
    statusCard.className = "omp-card";
    statusCard.style.cssText = "margin-bottom:var(--omp-space-3);display:flex;flex-wrap:wrap;gap:var(--omp-space-4);";
    const facts: [string, string][] = [
      [tt("adm.67691f"), c.nodeId],
      [tt("adm.7f5acf"), c.isLeader ? tt("adm.5158a2") : c.state],
      [tt("adm.cf5f30"), String(c.term)],
      [tt("adm.2aeb64"), String(c.appliedIndex)],
      [tt("adm.5158a2"), c.leaderId ? (c.leaderId === c.nodeId ? tt("adm.262954", { p0: c.leaderId }) : c.leaderId) : "unbekannt"],
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
        <th style="padding:2px 8px;">${tt("adm.fb9f6f")}</th>
        <th style="padding:2px 8px;">${tt("adm.76d1d0")}</th>
        <th style="padding:2px 8px;">${tt("adm.e897f3")}</th>
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
      tt("adm.1771bd") +
      tt("adm.13b8c8");
    form.appendChild(hint);

    const fieldsRow = document.createElement("div");
    fieldsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--omp-space-2);";

    const nodeIdInput = document.createElement("input");
    nodeIdInput.placeholder = tt("adm.045fdc");
    nodeIdInput.value = this.#newClusterNodeId;
    nodeIdInput.style.cssText = "flex:1;min-width:120px;";
    const raftInput = document.createElement("input");
    raftInput.placeholder = tt("adm.ca9750");
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
    copyBtn.textContent = tt("adm.c5ce55");
    copyBtn.style.cssText = "font-size:11px;cursor:pointer;";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.#buildClusterJoinSnippet());
        copyBtn.textContent = tt("adm.70dfc1");
        window.setTimeout(() => {
          copyBtn.textContent = tt("adm.c5ce55");
        }, 1500);
      } catch {
        // Kein Clipboard-Zugriff — <pre> steht ohnehin zum manuellen Markieren da.
      }
    });
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.textContent = tt("adm.5728d7");
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
      badge.textContent = tt("adm.5158a2");
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
    delBtn.textContent = tt("adm.513d30");
    delBtn.className = "omp-btn-danger";
    delBtn.style.cssText = "font-size:11px;";
    // Sichtbar gesperrt statt erst nach dem Klick abgewiesen — der
    // Leader als letztes verbleibendes Mitglied ließe sich nie wieder
    // rückgängig machen (s. #leaveClusterMember-Doku).
    if (peer.id === c.leaderId && c.peers.length <= 1) {
      delBtn.disabled = true;
      delBtn.title = tt("adm.d07366");
    }
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
