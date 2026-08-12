// <omp-flow-canvas>: rendert /api/v1/graph als SVG-Kacheln mit Pan/Zoom,
// verschiebbaren Nodes (B2), Drag&Drop-Verbindungen (B3), Live-Status (B4)
// und Gruppen/Verschachtelung (B5). Reine Koordinaten-/Kompatibilitäts-/
// Gruppenlogik steckt in geometry.ts/compatibility.ts/groups.ts (dort per
// `deno test` geprüft) — dieses Modul bindet sie nur an DOM-/Fetch-/
// EventSource-APIs.

import {
  defaultPosition,
  HEADER_HEIGHT,
  IDENTITY_VIEWPORT,
  MIN_BODY_HEIGHT,
  NODE_WIDTH,
  nodeHeight,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  type Point,
  type PortSide,
  portPosition,
  screenToWorld,
  type Viewport,
  worldToScreen,
  zoomAt,
} from "./geometry.ts";
import { portsCompatible } from "./compatibility.ts";
import {
  addMember,
  breadcrumbPath,
  createGroup,
  dissolveGroup,
  emptyTree,
  flattenMembers,
  type GroupTree,
  type PortRef,
  promotedPorts,
  setGroupWorkflowId,
  topLevelItems,
} from "./groups.ts";
import {
  controlKindFor,
  type ControlKind,
  type Descriptor,
  enumValues,
  type MethodSpec,
  numberRange,
  type ParamSpec,
} from "./controls.ts";
import { mountUIBundle } from "../shell/ui-bundle.ts";
import { apiFetch, connectionMonitor } from "../shell/connection.ts";
import { ROLE_FORMATS, uniqueRoleName } from "./roles.ts";
import { renameRole } from "./role-designer-logic.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const LAYOUT_NAME = "default";

// Kapitel 13 (docs/END-GOAL-FEATURES.md §13.3/§13.4 Teil 1): feste
// Lane-Breite/Kopfhöhe für die Host-Ansicht — konstant statt vom
// Inhalt abgeleitet (das ist gerade der Punkt der "festen Lanes",
// §13.5 Frage 1), nur die Lane-Höhe wächst mit der tatsächlichen
// Kachel-Anzahl (s. #buildHostZoneLayer).
const HOST_ZONE_LANE_WIDTH = NODE_WIDTH + 100;
const HOST_ZONE_LANE_GAP = 30;
const HOST_ZONE_HEADER_HEIGHT = 46;
const HOST_ZONE_TILE_GAP = 24;
const HOST_ZONE_MARGIN = 24;
// Ein Host gilt als "online", wenn seine letzte Telemetrie nicht älter
// als das Dreifache des Sende-Intervalls ist (host-agent, alle 5s,
// s. host-agent/main.go) — großzügig genug, um einzelne verpasste
// NATS-Zyklen nicht sofort als offline zu werten, aber knapp genug,
// dass ein tatsächlich abgeschalteter Host zeitnah als offline zeigt.
const HOST_ONLINE_THRESHOLD_MS = 15000;
// Kapitel 13 Teil 2 (docs/END-GOAL-FEATURES.md §13.4): identischer
// Transport-URN-Wert wie nodes/omp-node-sdk/src/is04.rs::TRANSPORT_MXL
// (keine gemeinsame Konstante über die Sprachgrenze hinweg möglich) —
// Grundlage der Kanten-Klassifizierung über Host-Zonengrenzen (§13.3:
// "MXL ist host-lokal").
const TRANSPORT_MXL = "urn:x-omp:transport:mxl";
const MXL_ZONE_WARNING_TITLE =
  "MXL ist host-lokal — für Hostgrenzen ST-2110/SRT-Gateway (D4) einsetzen";

// Gleicher Storage-Key wie `auth.ts`s `TOKEN_KEY`/`connection.ts`s eigene
// Kopie davon, absichtlich dupliziert statt eines gemeinsamen Imports
// (s. `connection.ts`s Begründung: `auth.ts`s Modul-Ladezeit-Seiteneffekt
// bricht unter `deno test`). Gebraucht für den Stream-Proxy (K4,
// docs/END-GOAL-FEATURES.md Kapitel 10 Entscheidungssitzung Punkt 5):
// `<img src>` kann anders als `apiFetch()` keinen `Authorization`-Header
// setzen (Web-Plattform-Einschränkung, identischer Befund wie
// `connection.ts`s eigener `?access_token=`-Fallback für die
// SSE-Verbindung) — ohne den Query-Parameter hier bekäme jede
// Kachel-Vorschau ein stilles 401 statt eines Bildes, sobald ein echter
// Nutzer (außerhalb des Zero-User-Bootstrap-Zustands) angemeldet ist.
const STREAM_TOKEN_KEY = "omp-auth-token";

function streamProxyUrl(nodeId: string, paramName: string): string {
  const token = localStorage.getItem(STREAM_TOKEN_KEY);
  const base = `/api/v1/nodes/${nodeId}/stream/${paramName}`;
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
}

// Parameter-Panel-Breite (§1.6, docs/END-GOAL-FEATURES.md, 2026-07-17):
// die frühere feste 280px liess Operator-Konsolen-Bundles wie den
// Bildmischer ihre eigentlich horizontale Crosspoint-Reihe umbrechen —
// dasselbe Bundle wie in der Vollbild-Konsole (`ui/shell/console-view.ts`),
// nur zu eng eingefasst. Breiterer Default + Resize-Handle statt einer
// zweiten, festen Zahl.
const PANEL_WIDTH_STORAGE_KEY = "omp.parameterPanelWidth";
const PANEL_WIDTH_DEFAULT = 420;
const PANEL_WIDTH_MIN = 240;
const PANEL_WIDTH_MAX = 900;

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
  if (Number.isFinite(raw) && raw >= PANEL_WIDTH_MIN && raw <= PANEL_WIDTH_MAX) return raw;
  return PANEL_WIDTH_DEFAULT;
}

interface GraphPort {
  id: string;
  label: string;
  format: string;
  // Kapitel 13 Teil 2 (docs/END-GOAL-FEATURES.md §13.4): IS-04-Transport-
  // URN unverändert vom Orchestrator durchgereicht (orchestrator/internal/
  // graph.Port), z. B. "urn:x-omp:transport:mxl" — Grundlage für die
  // Kanten-Klassifizierung über Host-Zonengrenzen (#isMxlTransport).
  // Optional: ältere/gemockte Graph-Antworten haben das Feld nicht.
  transport?: string;
}

interface GraphNode {
  id: string;
  label: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  health: string;
  // Gesetzt, wenn der Node vom Instanz-Launcher gestartet wurde
  // (UMSETZUNG.md C8) — Grundlage für den Stop-Control an der Kachel.
  instanceId?: string;
}

interface GraphEdge {
  id: string;
  fromSender: string;
  toReceiver: string;
  state: string;
}

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface LayoutBlob {
  positions: Record<string, Point>;
  groups: GroupTree;
  // Optional (ältere gespeicherte Layouts haben das Feld nicht):
  // Pan/Zoom-Zustand, damit ein Reload die zuletzt sichtbare Ansicht
  // wiederherstellt statt immer auf IDENTITY_VIEWPORT zurückzufallen —
  // ohne das landeten gespeicherte Kachel-Positionen nach einem Reload
  // ggf. außerhalb des sichtbaren Bereichs (Nutzerfund 2026-07-12).
  viewport?: Viewport;
  // Kapitel 13 (docs/END-GOAL-FEATURES.md §13.3): "Positionen werden
  // beim Einschalten [der Host-Ansicht] innerhalb der Zone des
  // jeweiligen Hosts angeordnet und separat gemerkt — Ausschalten
  // stellt das freie Layout wieder her." `positions` bleibt IMMER die
  // freie Kachel-Anordnung (auch während die Host-Ansicht aktiv ist,
  // s. #saveLayout); dieses Feld hält nur die Root-Node-Positionen der
  // Lane-Anordnung, separat vom freien Layout. Fehlt bei älteren
  // Layouts — dann berechnet #enableHostView() die Lanes einmalig neu.
  hostViewPositions?: Record<string, Point>;
}

interface SnapshotSummary {
  id: string;
  label: string;
  // §4.6 Punkt 4 (docs/END-GOAL-FEATURES.md, "Mixer-Presets"): nicht
  // leer = ein Node-Preset, kein globaler Szenen-Snapshot — die
  // Snapshot-Leiste hier zeigt nur echte Szenen (s. #renderSnapshotBar),
  // Node-Presets erscheinen stattdessen im UI-Bundle des jeweiligen
  // Nodes selbst (z. B. `omp-audio-mixer/ui/bundle.js`).
  nodeIds?: string[];
}

interface ApplyResult {
  errors: string[];
}

// WorkflowSummary (Kapitel 12 Teil 2, docs/END-GOAL-FEATURES.md §12.3b):
// nur die Felder, die der Editor für den "benannten Rahmen um die
// Kacheln ihrer Runtime-Nodes" braucht — Wire-Format identisch zu
// workflows.Workflow (orchestrator/internal/workflows/types.go).
interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  runtime?: Record<string, { instanceId: string; nodeId?: string }>;
  // Kapitel 12 Teil 3 (§12.3c): für die Platzhalter-Kacheln eines
  // pausierten Workflows — der hat keine Runtime-Nodes mehr (gleiche
  // Ressourcen-Wirkung wie "stopped"), daher Rollenname+Typ+Template-
  // Kanten direkt aus der Definition statt aus Runtime-Node-IDs.
  // Bug 2 (2026-07-24): definition trägt zur Laufzeit weitere, hier nicht
  // typisierte Felder (settings, schedules, title, description, tags,
  // category, ...). Der Bearbeiten-Modus liest/schreibt nur roles/
  // connections, muss die übrigen Felder aber beim PUT unangetastet
  // durchreichen (Object-Spread) statt ein neues Objekt zu bauen.
  definition: WorkflowDefinition;
}

// s. WorkflowSummary.definition-Doku — auch der Typ des lokalen
// Bearbeiten-Entwurfs (#workflowEditDraft), da beide dieselbe Form
// haben (ein Entwurf IST eine Definition, nur (noch) nicht gespeichert).
type WorkflowDefinition = {
  // standbyFor (K7 Teil 4, docs/END-GOAL-FEATURES.md §7.4) — s.
  // orchestrator/internal/workflows/types.go Role.StandbyFor.
  roles: { name: string; nodeType: string; standbyFor?: string }[];
  connections: { fromRole: string; toRole: string }[];
} & Record<string, unknown>;

const WORKFLOW_FRAME_COLORS: Record<string, string> = {
  stopped: "#999",
  starting: "#e0a020",
  started: "#4caf50",
  paused: "#5b9bd5",
  pausing: "#e0a020",
  stopping: "#e0a020",
  failed: "#e57373",
};

interface TileSpec {
  id: string;
  label: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  kind: "node" | "group";
  health: string;
  instanceId?: string;
  // isStandby (K7 Teil 4, docs/END-GOAL-FEATURES.md §7.4, Hot-Standby):
  // gesetzt, wenn dieser Node eine warme, aktuell unverbundene
  // Standby-Rolle erfüllt (Role.StandbyFor in der Workflow-Definition) —
  // nur von #renderRunningWorkflowScope befüllt, s. dortige Doku.
  isStandby?: boolean;
}

// CatalogEntry (UMSETZUNG.md C8) — Wire-Format identisch zu
// orchestrator/internal/launcher.CatalogEntry.
interface CatalogEntry {
  type: string;
  label: string;
  runner: string;
  command: string[];
  env: Record<string, string>;
  // description/expectedResources (§17 Teil 1, docs/END-GOAL-
  // FEATURES.md, 2026-07-17): optional, ein Community-/Fremd-
  // Microservice-Eintrag ohne diese Felder muss weiterhin gültig
  // bleiben.
  description?: string;
  expectedResources?: string;
  // version (§17 Teil 5, docs/END-GOAL-FEATURES.md §17.4 Teil 5): leer
  // für statische Einträge und einfache, unversionierte Importe
  // (unverändertes Verhalten seit §17 Teil 4) — gesetzt, wenn mehrere
  // Versionen desselben Typs parallel importiert wurden.
  version?: string;
}

// FailoverEvent — Wire-Format identisch zum "workflow.failover"-SSE-Event
// (orchestrator/internal/workflows/failover.go, K7 Teil 4, Hot-Standby).
interface FailoverEvent {
  workflowId: string;
  role: string;
  fromInstanceId: string;
  toInstanceId: string;
  trigger: "crash-loop" | "host-offline";
  at: string;
}

// LauncherInstance — Wire-Format identisch zu
// orchestrator/internal/launcher.Instance. crashed/crashMessage: Nutzer-
// fund "crash müssen angezeigt werden" — ein Subprozess, der ohne Stop()
// endet (z. B. MXL-Init-Fehler), verschwindet sonst spurlos aus der
// Palette, sobald seine (evtl. nie erfolgte) NMOS-Registrierung ausläuft.
interface LauncherInstance {
  id: string;
  type: string;
  label: string;
  pid: number;
  hostId?: string;
  crashed?: boolean;
  crashMessage?: string;
  // Automatische Neustarts seit dem ursprünglichen Start (K7-Teil-1,
  // docs/END-GOAL-FEATURES.md §7.3a) — auch sichtbar, wenn die Instanz
  // gerade NICHT crashed ist (sie hat sich ja gerade erholt), damit ein
  // Operator eine flatternde Instanz erkennt, nicht nur eine tote.
  restartCount?: number;
  // Kapitel 14 Teil 2 (docs/END-GOAL-FEATURES.md §14.3b): CPU%/RSS der
  // Instanz — für lokale Instanzen von launcher.Launcher.List() selbst
  // gemessen, für entfernte aus der Host-Agent-Telemetrie des Hosts
  // gemischt (orchestrator/internal/httpapi.mergeInstanceMetrics).
  // Fehlt, solange noch kein Sample vorliegt (z. B. direkt nach dem
  // Start) — kein impliziter 0%-Wert.
  cpuPercent?: number;
  rssBytes?: number;
  // version (§17 Teil 5) — die CatalogEntry.Version, mit der diese
  // Instanz gestartet wurde; leer für statische/unversionierte Typen.
  version?: string;
}

// Kapitel 13 (docs/END-GOAL-FEATURES.md §13.3): Momentwert-Telemetrie für
// den Zonen-Kopf im Host-Ansicht-Modus — gleiches Wire-Format wie
// hosts-view.ts' eigene (separate, bewusst duplizierte statt geteilte)
// HostMetrics-Deklaration.
interface HostMetrics {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  receivedAt: string;
}

// HostEntry — Wire-Format identisch zu httpapi.hostResponse
// (ARCHITECTURE.md §18, UMSETZUNG.md D6). Nur die für die Katalog-
// Palette gebrauchten Felder — metrics zusätzlich seit Kapitel 13 für
// den Zonen-Kopf (Live-CPU/RAM, s. #buildHostZoneLayer).
interface HostEntry {
  id: string;
  label: string;
  metrics?: HostMetrics;
}

// ProfileResponse — Wire-Format identisch zu httpapi.profileResponse
// (Kapitel 14 Teil 3, docs/END-GOAL-FEATURES.md §14.3d). known=false
// heißt "erster Start dieses Typs" (weder host-spezifisches noch
// Typ-Fallback-Profil vorhanden) — nie ein stiller Block, nur eine
// Anzeige-Entscheidung ("Bedarf unbekannt" statt Zahlen).
interface ProfileResponse {
  nodeType: string;
  hostId: string;
  known: boolean;
  fallback?: boolean;
  cpuMin?: number;
  cpuAvg?: number;
  cpuMax?: number;
  cpuP95?: number;
  rssMin?: number;
  rssAvg?: number;
  rssMax?: number;
  sampleCount?: number;
  status: "ok" | "knapp" | "ueberbucht" | "lokal" | "unbekannt";
  hostCpuPercent?: number;
  hostMemPercent?: number;
  projectedCpuPercent?: number;
  projectedMemPercent?: number;
}

// Wire-Format identisch zu orchestrator/internal/httpapi/node_settings_
// handlers.go's mxfPlayerSettings (Nutzerwunsch 2026-08-06: Shuffle-
// Presets/Programmgruppen für omp-mxf-player nicht mehr in Rust
// hartcodiert, s. #buildMxfPlayerSettingsSection).
interface MxfProgramGroup {
  id: string;
  label: string;
  channels: number;
}

interface MxfRoute {
  srcTrack: number;
  group: string;
  groupChannel: number;
}

interface MxfPreset {
  id: string;
  label: string;
  routes: MxfRoute[];
}

interface MxfPlayerSettings {
  groups: MxfProgramGroup[];
  presets: MxfPreset[];
}

interface PortLocation {
  tileId: string;
  side: PortSide;
  index: number;
  count: number;
}

type DragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport; moved: boolean }
  | { kind: "node"; nodeId: string; startScreen: Point; startWorld: Point; moved: boolean }
  | { kind: "connect"; fromPortId: string; fromFormat: string; fromWorld: Point; currentScreen: Point }
  | { kind: "select"; startScreen: Point };

// Event-Typen, die ein volles Neuladen des Graphen auslösen: Node-
// Inventar-Änderungen (registry.Poller) sowie Kanten-Änderungen
// (graph.Service.publish) — letztere fehlten bis zu einem Bugfix nach
// C7: eine per API (nicht per eigenem Drag&Drop) erzeugte/getrennte
// Kante blieb sonst bis zum manuellen Reload unsichtbar, weil nur
// Node-Events ein Neuladen anstießen.
const GRAPH_REFRESH_EVENT_TYPES = new Set([
  "node.added",
  "node.updated",
  "node.removed",
  "edge.added",
  "edge.removed",
  // Kapitel 12 Teil 2: ein Workflow-Start/-Stop ändert, welche Nodes
  // gerade zu welchem Workflow-Rahmen gehören — ohne dieses Event bliebe
  // der Rahmen bis zum nächsten Node-Event (oder nie) veraltet.
  "workflow.updated",
]);
const TALLY_EVENT_PREFIX = "omp.tally.";
const DRAG_THRESHOLD_PX = 3;

// Kapitel 13: gleiches Erkennungsmuster für den rohen NATS-Subject-
// Passthrough "omp.host.<id>.metrics" wie hosts-view.ts' eigene (bewusst
// duplizierte, s. dortige Modul-Doku) isRefreshEvent()-Prüfung.
const HOST_METRICS_SUBJECT_PREFIX = "omp.host.";
const HOST_METRICS_SUBJECT_SUFFIX = ".metrics";
function isHostMetricsEvent(type: string): boolean {
  return type.startsWith(HOST_METRICS_SUBJECT_PREFIX) && type.endsWith(HOST_METRICS_SUBJECT_SUFFIX);
}

export class FlowCanvas extends HTMLElement {
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #positions: Record<string, Point> = {};
  #groupTree: GroupTree = emptyTree();
  #scope: string | null = null;
  #selectedIds: Set<string> = new Set();
  #graph: Graph = { nodes: [], edges: [] };
  // Kapitel 12 Teil 2: alle Workflows, für ihre kollabierte
  // Root-Kachel (s. #renderWorkflowTiles) — unabhängig vom Gruppenbaum
  // (#groupTree bleibt B5s rein visuelles Konzept, s. Abgrenzung in
  // docs/END-GOAL-FEATURES.md §12.1).
  #workflows: WorkflowSummary[] = [];
  // S6 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "Flow-Editor-Filter
  // auf die Nodes des gewählten Workflows, globale Sicht bleibt als
  // 'Alle' wählbar") — gesetzt von außen über setWorkflowFilter()
  // (ui/shell/app-shell.ts, dort die eigentliche Auswahl-UI in der
  // App-Bar). null = "Alle", unverändertes Verhalten. Bewusst orthogonal
  // zu #scope (B5-Gruppen-Zoom, s. Abgrenzung oben) — ein aktiver
  // Workflow-Filter umgeht den Gruppenbaum komplett und zeigt flache
  // Node-Kacheln (s. #buildTilesForWorkflowFilter), statt Gruppen-
  // Zugehörigkeit und Workflow-Zugehörigkeit gleichzeitig aufzulösen.
  #workflowFilter: string | null = null;
  // Bugfix 2026-07-26 (Nutzerwunsch: "einen Workflow im Flow-Editor
  // weiter bearbeiten können — Elemente hinzufügen/löschen/verbinden,
  // so wie in einer Gruppe"): Bearbeitungs-Scope für genau einen
  // gestoppten/pausierten Workflow (workflows.Service.Update() erlaubt
  // nur diese beiden Status, s. dortige Doku) — orthogonal zu #scope
  // (B5-Gruppen) und #workflowFilter (reine Lesefilter-Ansicht laufender
  // Workflows): hier werden keine echten Nodes gezeigt, sondern die
  // Rollen der Workflow-**Definition** als editierbare Platzhalter-
  // Kacheln (s. #renderEditableRoleTile). Von außen
  // gesetzt über enterWorkflowEditScope() (ui/shell/app-shell.ts, nach
  // einem Tab-Wechsel aus der Workflows-Ansicht).
  #workflowEditId: string | null = null;
  // Nutzerfund (2026-07-26): PUT bei jeder einzelnen Mutation (erster
  // Anlauf dieses Features) fühlte sich nicht wie ein Editor an — jede
  // Rolle/Verbindung sollte sich wie in einem Formular erst lokal
  // ändern, ein expliziter "Speichern"-Button committet den ganzen
  // Entwurf auf einmal. Geklont beim Betreten (enterWorkflowEditScope),
  // alle #addWorkflowRole/#removeWorkflowRole/#addWorkflowConnection/
  // #removeWorkflowConnection ändern NUR dieses Objekt (kein Netzwerk),
  // #renderWorkflowEditScope liest ausschließlich daraus — erst
  // #saveWorkflowEditDraft() sendet den PUT.
  #workflowEditDraft: WorkflowDefinition | null = null;
  // Nutzerwunsch (2026-07-26, zweite Präzisierung): ein LAUFENDER
  // Workflow lässt sich genauso betreten wie ein gestoppter/pausierter
  // (s. #renderRunningWorkflowScope) — echte Nodes, echte Ports, normales
  // Ziehen/Verbinden/Parameter-Panel, kein Entwurf nötig (jede Änderung
  // wirkt sofort, wie überall sonst im Editor). Diese beiden Felder
  // verfolgen nur, welche Nodes NEU in dieser Sitzung zur Workflow-
  // Ansicht hinzukamen (per Katalog gestartet, während dieser Scope
  // offen war) — #buildTilesForWorkflowFilter() allein kennt nur
  // wf.Runtime (den Stand beim letzten Start), ein frisch hinzugefügter
  // Node gehört noch zu keiner Rolle. #workflowScopePendingInstanceIds
  // hält Instanz-IDs, deren Node-ID noch unbekannt ist (Start-Response
  // kommt vor der NMOS-Registrierung zurück, s. #startInstance) — sobald
  // ein #graph.nodes-Eintrag mit passender instanceId auftaucht, wandert
  // die ID nach #workflowScopeExtraNodeIds (s. #reconcileWorkflowScopePendingInstances).
  #workflowScopeExtraNodeIds: Set<string> = new Set();
  #workflowScopePendingInstanceIds: Set<string> = new Set();
  // Nutzerreport 2026-07-30 ("in einer Gruppe neue Nodes hinzufügen
  // landet im Root"): dasselbe Zeitfenster-Problem wie oben
  // (#workflowScopePendingInstanceIds), nur fürs B5-Gruppenmodell statt
  // Workflow-Scopes — die beiden Container-Konzepte sind laut #render()
  // strikt getrennt (Workflow-Bearbeiten-Modus überspringt
  // #buildTilesAtScope() komplett), #startInstance kannte bisher nur
  // den Workflow-Fall. Wert = groupId, in der das Node bei Klick auf den
  // Katalog-Button landen soll (nicht einfach "die aktuelle Gruppe" zum
  // Reconcile-Zeitpunkt — der Nutzer kann die Gruppe zwischen Klick und
  // NMOS-Registrierung bereits wieder verlassen haben).
  #groupScopePendingInstances: Map<string, string> = new Map();
  // Klick-zu-Verbinden-Zustand (kein Drag möglich — Platzhalter-Kacheln
  // haben keine echten Ports, da ihr Node nicht läuft): erster Klick
  // markiert die Quellrolle, zweiter Klick auf eine andere Rolle legt
  // die Verbindung an, erneuter Klick auf dieselbe Rolle bricht ab.
  #connectFromRole: string | null = null;
  // Nutzerwunsch 2026-07-30 ("sprechender Name" je Service/Stream, s.
  // `renameRole`-Doku in role-designer-logic.ts): Rollenkachel im
  // Bearbeiten-Modus, deren Name gerade per Doppelklick umbenannt wird.
  #editingWorkflowRoleName: string | null = null;
  #tally: Record<string, boolean> = {};
  #drag: DragState | null = null;
  #rubberBand: SVGPathElement | null = null;
  #selectionRect: SVGRectElement | null = null;
  #selectedEdgeId: string | null = null;
  #portLocation: Map<string, PortLocation> = new Map();
  // Kapitel 13 Teil 2: Transport-URN je Port-ID, unabhängig vom aktuell
  // sichtbaren Scope (anders als #portLocation) — eine Gruppen-Kachel
  // promotet fremde Port-IDs unverändert (s. groups.ts::promotedPorts),
  // die Transport-Zugehörigkeit bleibt also über die ID auffindbar, egal
  // ob der Port gerade an seiner Node- oder an einer Gruppen-Kachel
  // hängt. Aus #graph.nodes befüllt (#fetchAndRender), nicht aus tiles.
  #portTransport: Map<string, string> = new Map();
  #tileHeightById: Map<string, number> = new Map();
  // Inline-Vorschau auf der Kachel selbst (nicht nur im geöffneten
  // Parameter-Panel) für Nodes mit einem "previewUrl"-Parameter (bisher
  // nur omp-viewer, C6) — hält seit K4 (docs/END-GOAL-FEATURES.md
  // Kapitel 10 Entscheidungssitzung Punkt 5) nur noch, OB ein Node eine
  // Vorschau hat (`false` = geprüft, keine vorhanden), nicht mehr die
  // aufgelöste Node-URL selbst — das <img> zeigt stattdessen auf den
  // generischen Orchestrator-Stream-Proxy, der previewUrl intern selbst
  // auflöst (kein direkter Browser-Zugriff auf den Node-Host mehr
  // nötig, gleicher Auth-Schutz wie jeder andere `/api/v1`-Endpunkt).
  // Einmalig pro Node-ID abgefragt, nicht bei jedem Render-Tick erneut.
  #hasPreviewById: Map<string, boolean> = new Map();
  #previewFetchInFlight: Set<string> = new Set();

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #breadcrumbBar!: HTMLDivElement;
  #panelContainer!: HTMLDivElement;
  #panelResizeHandle!: HTMLDivElement;
  #panelContent!: HTMLDivElement;
  #panelResizeStartX = 0;
  #panelResizeStartWidth = 0;
  #panelNodeId: string | null = null;
  #snapshotBar!: HTMLDivElement;
  #palette!: HTMLDivElement;
  // Skalierungs-Review D5 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md):
  // Suchfeld für den Node-Katalog — Query + zuletzt geholte Daten getrennt
  // von #renderPalette() gehalten, damit ein Tastendruck nur neu filtert
  // (#renderPaletteList()), statt Katalog/Instanzen/Hosts erneut vom
  // Server zu holen.
  #paletteFilterQuery = "";
  #paletteCatalog: CatalogEntry[] | null = null;
  #paletteInstances: LauncherInstance[] = [];
  #paletteHosts: HostEntry[] = [];

  // Kapitel 13 (docs/END-GOAL-FEATURES.md §13): Host-Zonen im
  // Flow-Editor. #hostViewEnabled ist nur bei #scope===null relevant
  // (root) — s. #buildHostZoneLayer/#renderBreadcrumb. #hostViewUserSet
  // unterscheidet "noch nie manuell umgeschaltet" (dann greift der
  // Auto-Default ab >1 Host, §13.5 Frage 2, Nutzerentscheidung
  // 2026-08-10) von einer bewussten Nutzerwahl, die der Auto-Default
  // danach nicht mehr überschreibt. #hostViewPositions ist die separat
  // gemerkte Lane-Anordnung (persistiert, s. LayoutBlob); #freeRoot
  // Positions ist nur ein Laufzeit-Backup der freien Layout-Positionen
  // der Root-Node-Kacheln für die Dauer der aktiven Host-Ansicht (s.
  // #enableHostView/#saveLayout) — kein eigenes Persistenzfeld nötig,
  // #positions selbst bleibt bei ausgeschalteter Host-Ansicht ohnehin
  // die freie Wahrheit.
  #hostViewEnabled = false;
  #hostViewUserSet = false;
  #hostViewPositions: Record<string, Point> = {};
  #freeRootPositions: Record<string, Point> = {};
  // Kapitel 13 Teil 2 (docs/END-GOAL-FEATURES.md §13.4: "Zone
  // einklappbar (analog B5-Gruppe)"): rein session-lokal wie
  // #hostViewEnabled selbst (kein Persistenzbedarf — anders als
  // #hostViewPositions ist "eingeklappt" ein reiner Sichtbarkeits-,
  // kein Layout-Zustand, eine neue Sitzung startet wieder vollständig
  // ausgeklappt).
  #collapsedZoneIds: Set<string> = new Set();

  // Serialisiert #fetchAndRender()-Aufrufe (siehe #queueFetchAndRender).
  #renderQueue: Promise<void> = Promise.resolve();
  #viewportSaveTimer: ReturnType<typeof setTimeout> | undefined;
  // Bindung an den geteilten ConnectionMonitor (UMSETZUNG.md K1-Teil-1)
  // statt einer eigenen EventSource — s. #onSseMessage/connectedCallback.
  #onSseMessage = (ev: Event) => this.#handleServerEvent((ev as CustomEvent<string>).detail);
  // Gesetzt von #loadLayout(), wenn kein gespeicherter Viewport vorliegt —
  // #fetchAndRender() zentriert dann einmalig auf den (bereits bereinigten)
  // Kachel-Bestand, s. #pruneStalePositions().
  #viewportNeedsFit = false;

  #onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (this.#selectedEdgeId) {
        ev.preventDefault();
        this.#deleteSelectedEdge();
      }
      return;
    }
    if ((ev.key === "g" || ev.key === "G") && this.#selectedIds.size >= 2) {
      ev.preventDefault();
      this.#groupSelection();
    }
  };

  connectedCallback() {
    this.#buildSkeleton();
    document.addEventListener("keydown", this.#onKeyDown);
    this.#init();
    // Geteilte EventSource-Verbindung (UMSETZUNG.md K1-Teil-1):
    // connectionMonitor.start() ist idempotent, die App-Bar
    // (app-shell.ts) ruft sie unabhängig ebenfalls auf — hier wird nur
    // noch auf rohe SSE-Payloads gehorcht, nicht mehr selbst verbunden/
    // reconnectet (das übernimmt jetzt ausschließlich connection.ts).
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
    connectionMonitor.start();
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
    clearTimeout(this.#viewportSaveTimer);
  }

  async #init() {
    await this.#loadLayout();
    await this.#queueFetchAndRender();
    await this.#renderSnapshotBar();
    await this.#renderPalette();
  }

  async #loadLayout() {
    try {
      const response = await apiFetch(`/api/v1/layouts/${LAYOUT_NAME}`);
      if (response.ok) {
        const blob = (await response.json()) as Partial<LayoutBlob>;
        this.#positions = blob.positions ?? {};
        this.#groupTree = blob.groups ?? emptyTree();
        this.#hostViewPositions = blob.hostViewPositions ?? {};
        // Gespeicherte Layouts von vor diesem Fix (2026-07-12) haben kein
        // `viewport`-Feld — dann auf den Kachel-Bestand zentrieren statt
        // stur auf IDENTITY_VIEWPORT zurückzufallen (Nutzerfund: nach
        // einem Reload lagen gespeicherte Positionen außerhalb des
        // sichtbaren Bereichs). Das Zentrieren selbst passiert erst in
        // `#fetchAndRender()`, NACH `#pruneStalePositions()` — an dieser
        // Stelle hier ist der Graph (und damit die Menge tatsächlich noch
        // existierender Nodes) noch gar nicht bekannt, eine Bounding-Box
        // über `#positions` wäre durch längst verwaiste Einträge verzerrt.
        if (blob.viewport) {
          this.#viewport = blob.viewport;
          this.#applyViewportTransform();
        } else {
          this.#viewportNeedsFit = true;
        }
        return;
      }
    } catch {
      // Server (noch) nicht erreichbar — mit leerem Layout starten.
    }
    this.#positions = {};
    this.#groupTree = emptyTree();
  }

  // Kapitel 13: solange die Host-Ansicht aktiv ist, hält #positions für
  // die Root-Node-Kacheln die Lane-Anordnung, nicht das freie Layout —
  // ein naives `positions: this.#positions` würde das freie Layout beim
  // Speichern also stillschweigend mit Lane-Koordinaten überschreiben
  // (bei einem Reload während aktiver Host-Ansicht sonst dauerhaft
  // verloren). #hostViewPositions wird hier zusätzlich aus dem
  // aktuellen #positions synchronisiert (deckt auch ein Verschieben
  // einer Kachel INNERHALB der Host-Ansicht ab, nicht nur den
  // Ein-/Ausschalt-Übergang selbst).
  async #saveLayout() {
    let positionsToPersist = this.#positions;
    let hostViewPositionsToPersist = this.#hostViewPositions;
    if (this.#hostViewEnabled) {
      const rootIds = this.#rootZoneTileIdsFlat();
      const syncedHostViewPositions = { ...this.#hostViewPositions };
      const freeOverride: Record<string, Point> = {};
      for (const id of rootIds) {
        if (this.#positions[id]) syncedHostViewPositions[id] = this.#positions[id];
        if (this.#freeRootPositions[id]) freeOverride[id] = this.#freeRootPositions[id];
      }
      hostViewPositionsToPersist = syncedHostViewPositions;
      positionsToPersist = { ...this.#positions, ...freeOverride };
      for (const id of rootIds) {
        if (!this.#freeRootPositions[id]) delete positionsToPersist[id];
      }
      this.#hostViewPositions = syncedHostViewPositions;
    }
    const blob: LayoutBlob = {
      positions: positionsToPersist,
      groups: this.#groupTree,
      viewport: this.#viewport,
      hostViewPositions: hostViewPositionsToPersist,
    };
    try {
      const response = await apiFetch(`/api/v1/layouts/${LAYOUT_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blob),
      });
      if (!response.ok) {
        this.#showToast(`Layout konnte nicht gespeichert werden: ${response.status}`);
      }
    } catch (err) {
      this.#showToast(`Layout konnte nicht gespeichert werden: ${err}`);
    }
  }

  // Reagiert auf Live-Status-Overlay-Events (UMSETZUNG.md B4), die der
  // geteilte ConnectionMonitor (connection.ts, K1-Teil-1) roh
  // weiterreicht: Node-Inventar-Änderungen (A6) und Kanten-Änderungen
  // (graph.Service, auch von fremden Clients/Skripten) lösen ein
  // Neuladen des Graphen aus, Tally-Events (omp.tally.<id>) färben die
  // betroffene Kachel rot. Verbindungsaufbau/-abbruch/Reconnect-Backoff
  // sind nicht mehr Sache dieser Klasse.
  #handleServerEvent(data: string) {
    let parsed: { type: string; data: unknown };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (GRAPH_REFRESH_EVENT_TYPES.has(parsed.type)) {
      this.#queueFetchAndRender();
      return;
    }

    if (parsed.type.startsWith(TALLY_EVENT_PREFIX)) {
      const nodeId = parsed.type.slice(TALLY_EVENT_PREFIX.length);
      const on = (parsed.data as { on?: boolean } | null)?.on === true;
      this.#setTally(nodeId, on);
      return;
    }

    // Kapitel 13: ein neu registrierter Host kann den Auto-Default
    // (§13.5 Frage 2) umschalten — voller #renderPalette()-Refresh wie
    // beim Crash-/Neustart-Pfad unten (seltenes Event, kein Performance-
    // Thema). Reine CPU/RAM-Ticks (alle 5s pro Host) bekommen dagegen
    // den leichtgewichtigen Pfad, damit nicht bei jedem Tick Katalog +
    // Instanzen unnötig neu geholt werden.
    if (parsed.type === "host.registered") {
      void this.#renderPalette();
      return;
    }
    if (isHostMetricsEvent(parsed.type)) {
      if (this.#hostViewEnabled) void this.#refreshHostMetrics();
      return;
    }

    // Nutzerfund "crash müssen angezeigt werden": launcher.Launcher
    // meldet einen unerwarteten Prozess-Exit separat von den Registry-
    // Inventar-Events oben, weil eine Instanz, deren MXL-Init-Fehler noch
    // vor jeder NMOS-Registrierung auftritt, sonst nie ein "node.added"/
    // "node.removed" auslöst und damit für JEDEN verbundenen Client
    // spurlos bliebe — nicht nur den, der sie gestartet hat.
    if (parsed.type === "instance.crashed") {
      const inst = parsed.data as LauncherInstance;
      this.#showToast(`${inst.label} abgestürzt: ${inst.crashMessage || "unbekannter Fehler"}`);
      void this.#renderPalette();
      return;
    }

    // K7-Teil-1 (docs/END-GOAL-FEATURES.md §7.3a): der Launcher hat eine
    // abgestürzte Instanz automatisch neu gestartet, ohne dass jemand
    // eingegriffen hat — sichtbar, aber bewusst unauffälliger als
    // "instance.crashed" (kein andauerndes Problem, sondern eine bereits
    // behobene Störung).
    if (parsed.type === "instance.restarted") {
      const inst = parsed.data as LauncherInstance;
      this.#showToast(`${inst.label} automatisch neu gestartet (${inst.restartCount ?? "?"}. Neustart)`);
      void this.#renderPalette();
      return;
    }

    // K7 Teil 4 (docs/END-GOAL-FEATURES.md §7.4, Hot-Standby): eine
    // Rolle wurde automatisch auf ihre warme Standby-Instanz umgeschaltet
    // — das begleitende "workflow.updated"-Event (promoteStandby,
    // failover.go) lässt GRAPH_REFRESH_EVENT_TYPES oben bereits neu
    // laden, hier nur der zusätzliche, erklärende Toast (§7.6: der
    // Operator soll unmerklich weiterarbeiten können, aber trotzdem
    // erfahren, DASS/WARUM gerade umgeschaltet wurde).
    if (parsed.type === "workflow.failover") {
      const ev = parsed.data as FailoverEvent;
      const reason = ev.trigger === "host-offline" ? "Host nicht mehr erreichbar" : "Prozess-Absturz";
      this.#showToast(`Rolle „${ev.role}" auf Standby umgeschaltet (${reason})`);
    }
  }

  #setTally(nodeId: string, on: boolean) {
    if (on) {
      this.#tally[nodeId] = true;
    } else {
      delete this.#tally[nodeId];
    }
    this.#render();
  }

  #buildSkeleton() {
    this.style.display ||= "block";
    this.style.position ||= "relative";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.style.touchAction = "none";
    svg.style.userSelect = "none";
    svg.style.background = "#1e1e1e";
    // Links Platz für die Katalog-Palette lassen (UMSETZUNG.md C8) —
    // sonst landen frisch platzierte Kacheln (defaultPosition startet
    // nahe world x=0) optisch unter der Palette. #screenPoint() liest
    // bei jedem Pointer-Event getBoundingClientRect() der svg neu, die
    // Pan/Zoom-Koordinatenrechnung bleibt dadurch unverändert korrekt.
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "160px";
    svg.style.width = "calc(100% - 160px)";
    svg.style.height = "100%";

    const viewportGroup = document.createElementNS(SVG_NS, "g");
    viewportGroup.setAttribute("data-role", "viewport");
    svg.appendChild(viewportGroup);

    svg.addEventListener("pointerdown", (ev) => this.#onPointerDown(ev));
    svg.addEventListener("pointermove", (ev) => this.#onPointerMove(ev));
    svg.addEventListener("pointerup", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("pointercancel", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("wheel", (ev) => this.#onWheel(ev), { passive: false });

    // Nutzerfund: `left:0` reichte bis unter die Katalog-Palette (auch
    // `left:0`, 160px breit, gleicher z-index, aber später im DOM
    // angehängt — deckt die Breadcrumb-Leiste in diesem Bereich optisch
    // UND für Klicks ab). Live per `elementFromPoint` bestätigt: sowohl
    // der komplette Breadcrumb-Pfad ("Root"/Gruppenname, wenn kurz genug)
    // als auch — bei kurzem Gruppennamen — der "Alle einpassen"-Button
    // direkt danach lagen unklickbar in dieser Zone. Gleiche Lösung wie
    // beim SVG-Kanvas selbst (das hat `left:160px` schon immer): die
    // Breadcrumb-Leiste beginnt jetzt ebenfalls erst nach der Palette.
    const breadcrumb = document.createElement("div");
    breadcrumb.setAttribute("data-role", "breadcrumb");
    breadcrumb.style.cssText =
      "position:absolute;top:0;left:160px;right:0;padding:var(--omp-space-2) var(--omp-space-3);" +
      "background:var(--omp-surface);color:var(--omp-text);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);" +
      "display:flex;gap:var(--omp-space-2);align-items:center;z-index:10;border-bottom:1px solid var(--omp-border);";

    const panel = document.createElement("div");
    panel.setAttribute("data-role", "parameter-panel");
    panel.style.cssText =
      `position:absolute;top:0;right:0;bottom:0;width:${loadPanelWidth()}px;` +
      "background:var(--omp-surface);color:var(--omp-text);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);padding:var(--omp-space-2);padding-top:36px;overflow-y:auto;" +
      "display:none;z-index:20;border-left:1px solid var(--omp-border);box-sizing:border-box;";

    const panelResizeHandle = document.createElement("div");
    panelResizeHandle.setAttribute("data-role", "parameter-panel-resize-handle");
    panelResizeHandle.style.cssText =
      "position:absolute;top:0;left:-4px;bottom:0;width:8px;cursor:ew-resize;z-index:21;";
    panel.appendChild(panelResizeHandle);
    panelResizeHandle.addEventListener("pointerdown", (ev) => this.#onPanelResizeStart(ev));

    // Eigenständiges Content-Element: die Render-Methoden unten leeren/
    // befüllen nur dieses (via replaceChildren) statt `panel` selbst —
    // sonst würde jedes Neu-Rendern den Resize-Handle mit wegwischen.
    const panelContent = document.createElement("div");
    panelContent.setAttribute("data-role", "parameter-panel-content");
    panel.appendChild(panelContent);

    const snapshotBar = document.createElement("div");
    snapshotBar.setAttribute("data-role", "snapshot-bar");
    snapshotBar.style.cssText =
      "position:absolute;bottom:0;left:0;right:0;padding:var(--omp-space-2) var(--omp-space-3);" +
      "background:var(--omp-surface);color:var(--omp-text);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);" +
      "display:flex;gap:var(--omp-space-2);align-items:center;z-index:10;" +
      "border-top:1px solid var(--omp-border);box-sizing:border-box;";

    // Katalog-Palette (UMSETZUNG.md C8): Node-Typen aus /api/v1/catalog
    // mit Start-Button, symmetrisch zum Parameter-Panel auf der rechten
    // Seite platziert.
    const palette = document.createElement("div");
    palette.setAttribute("data-role", "palette");
    palette.style.cssText =
      "position:absolute;top:0;left:0;bottom:0;width:160px;" +
      "background:var(--omp-surface);color:var(--omp-text);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);" +
      "padding:var(--omp-space-2);padding-top:36px;overflow-y:auto;" +
      "z-index:10;border-right:1px solid var(--omp-border);box-sizing:border-box;";

    this.replaceChildren(svg, breadcrumb, panel, palette, snapshotBar);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;
    this.#breadcrumbBar = breadcrumb;
    this.#panelContainer = panel;
    this.#panelResizeHandle = panelResizeHandle;
    this.#panelContent = panelContent;
    this.#snapshotBar = snapshotBar;
    this.#palette = palette;
  }

  async #fetchAndRender() {
    const response = await apiFetch("/api/v1/graph");
    this.#graph = await response.json();
    this.#portTransport.clear();
    for (const node of this.#graph.nodes) {
      for (const p of [...node.inputs, ...node.outputs]) {
        if (p.transport) this.#portTransport.set(p.id, p.transport);
      }
    }
    // Kapitel 12 Teil 2: best effort — ein fehlgeschlagener Workflow-
    // Abruf (z. B. fehlende Rechte) lässt den Graphen selbst unberührt,
    // nur die Rahmen bleiben dann leer statt den ganzen Refresh
    // abzubrechen.
    try {
      const workflowsRes = await apiFetch("/api/v1/workflows");
      this.#workflows = workflowsRes.ok ? await workflowsRes.json() : [];
    } catch {
      this.#workflows = [];
    }
    // Beide geben nur zurück, *ob* sich #positions geändert hat, statt
    // selbst zu speichern — sonst würde ein Zwischen-Save mit dem noch
    // unangepassten Viewport (IDENTITY_VIEWPORT vor dem Fit unten)
    // persistiert und ein späterer Reload fiele fälschlich nicht mehr auf
    // #fitViewportToPositions() zurück, weil `blob.viewport` dann schon
    // (falsch) gesetzt wäre.
    let changed = this.#pruneStalePositions();
    changed = this.#pruneStaleHostViewPositions() || changed;
    changed = this.#reconcileGroupScopePendingInstances() || changed;
    changed = this.#assignMissingPositions(false) || changed;
    // Kapitel 13: zwischenzeitlich neu erschienene Root-Node-Kacheln
    // (z. B. per Instanz-Launcher gestartet, während die Host-Ansicht
    // bereits aktiv ist) bekämen sonst erst beim nächsten manuellen
    // Ein-/Ausschalten eine Lane-Position statt der generischen
    // #assignMissingPositions()-Rasterposition oben.
    if (this.#hostViewEnabled) {
      changed = this.#arrangeIntoLanes(this.#rootZoneTiles()) || changed;
    }
    if (this.#viewportNeedsFit) {
      this.#viewportNeedsFit = false;
      this.#viewport = this.#fitViewportToPositions();
      this.#applyViewportTransform();
      changed = true;
    }
    if (changed) this.#saveLayout();
    this.#render();
  }

  // Entfernt Positions-Einträge für Nodes/Gruppen, die nicht mehr
  // existieren (z. B. gestoppte Instanzen, UMSETZUNG.md C8) — ohne das
  // wächst `#positions` über viele Sitzungen unbegrenzt: `#assignMissing
  // Positions()`s Index zählt alle jemals gespeicherten Einträge, verwaiste
  // Einträge schieben neue Kacheln immer weiter nach unten/rechts, und
  // seit dem Viewport-Persistenz-Fix (2026-07-12) verzerren sie auch
  // `#fitViewportToPositions()`s Bounding-Box (Nutzerfund: Kacheln lagen
  // nach mehreren Sitzungen weit außerhalb des sichtbaren Bereichs).
  #pruneStalePositions(): boolean {
    const validIds = new Set<string>([
      ...this.#graph.nodes.map((n) => n.id),
      ...Object.keys(this.#groupTree.groups),
      ...this.#workflowEditRolePlaceholderIds(),
      ...this.#allWorkflowTileIds(),
    ]);
    let changed = false;
    for (const id of Object.keys(this.#positions)) {
      if (!validIds.has(id)) {
        delete this.#positions[id];
        changed = true;
      }
    }
    return changed;
  }

  // Kapitel 13: Gegenstück zu #pruneStalePositions() für die separat
  // gemerkte Lane-Anordnung (#hostViewPositions) — enthält Root-Node-IDs
  // UND Root-Gruppen-IDs (seit dem Nutzerfund 2026-08-12, s.
  // #rootZoneTileIds-Doku), nie Workflow-Kacheln (s. #arrangeIntoLanes),
  // sonst wächst sie über viele Sitzungen unbegrenzt mit längst
  // entfernten Instanzen/aufgelösten Gruppen weiter.
  #pruneStaleHostViewPositions(): boolean {
    const validIds = new Set([
      ...this.#graph.nodes.map((n) => n.id),
      ...Object.keys(this.#groupTree.groups),
    ]);
    let changed = false;
    for (const id of Object.keys(this.#hostViewPositions)) {
      if (!validIds.has(id)) {
        delete this.#hostViewPositions[id];
        changed = true;
      }
    }
    return changed;
  }

  // Löst #groupScopePendingInstances gegen den aktuellen #graph.nodes-
  // Stand auf (s. dortige Doku) — Gegenstück zu
  // #reconcileWorkflowScopePendingInstances, nur fürs B5-Gruppenmodell.
  // Läuft bei jedem #fetchAndRender(), nicht nur während eine Gruppe
  // offen ist: die Ziel-Gruppe steht schon fest (im Map-Value), der
  // Nutzer kann also zwischenzeitlich woanders hin navigiert sein, ohne
  // dass das Node deshalb am Root landen soll.
  #reconcileGroupScopePendingInstances(): boolean {
    if (this.#groupScopePendingInstances.size === 0) return false;
    let changed = false;
    for (const node of this.#graph.nodes) {
      if (!node.instanceId) continue;
      const groupId = this.#groupScopePendingInstances.get(node.instanceId);
      if (groupId === undefined) continue;
      this.#groupScopePendingInstances.delete(node.instanceId);
      this.#groupTree = addMember(this.#groupTree, groupId, node.id);
      changed = true;
    }
    return changed;
  }

  // Serialisiert #fetchAndRender()-Aufrufe über eine Promise-Kette.
  // Ohne das können mehrere SSE-Events kurz hintereinander (z. B. mehrere
  // vom Instanz-Launcher gestartete Nodes, die binnen Sekunden alle
  // registrieren, UMSETZUNG.md C8) überlappende #fetchAndRender()-Läufe
  // auslösen: jeder liest #positions, bevor der vorherige Lauf seine
  // frisch zugewiesene defaultPosition() zurückgeschrieben hat, wodurch
  // mehrere neue Kacheln denselben Index/dieselbe Default-Position
  // bekommen und sich optisch stapeln (in der Praxis beobachtet: vier
  // gleichzeitig gestartete Instanzen landeten alle auf (40,40)).
  #queueFetchAndRender(): Promise<void> {
    this.#renderQueue = this.#renderQueue.catch(() => {}).then(() => this.#fetchAndRender());
    return this.#renderQueue;
  }

  // `save=false` lässt den Aufrufer selbst entscheiden, wann gespeichert
  // wird (s. #fetchAndRender(): dort soll ein einziger, konsolidierter
  // Save nach Pruning + Default-Zuweisung + ggf. Viewport-Fit passieren,
  // nicht mehrere Zwischen-Saves mit noch unfertigem Zustand).
  #assignMissingPositions(save = true): boolean {
    let changed = false;
    const items = this.#itemsAtScope();
    // Index für defaultPosition() startet bei der Anzahl bereits
    // bekannter Positionen, nicht bei 0 innerhalb dieses Aufrufs: die
    // Reihenfolge von items.nodeIds folgt der Registry-Rückgabe (z. B.
    // nach letzter Aktivität sortiert, nicht nach Registrierungs-
    // reihenfolge) und ist zwischen Aufrufen instabil. Erscheinen neue
    // Nodes einzeln nacheinander (UMSETZUNG.md C8: mehrere Instanzen
    // kurz hintereinander aus der GUI gestartet), landet der jeweils
    // einzige neue Eintrag sonst bei jedem Aufruf erneut auf Index 0 und
    // alle stapeln sich auf derselben Default-Position — beobachtet mit
    // vier gestarteten Instanzen, die alle auf (40,40) landeten.
    let nextIndex = Object.keys(this.#positions).length;
    for (
      const id of [
        ...items.nodeIds,
        ...items.groupIds,
        ...this.#workflowEditRolePlaceholderIds(),
        ...this.#allWorkflowTileIds(),
      ]
    ) {
      if (!this.#positions[id]) {
        this.#positions[id] = defaultPosition(nextIndex);
        nextIndex++;
        changed = true;
      }
    }
    if (changed && save) this.#saveLayout();
    return changed;
  }

  // Positionen der Rollen-Kacheln INNERHALB des gerade bearbeiteten
  // Workflows (s. #renderWorkflowEditScope) — aus dem lokalen Entwurf,
  // nicht aus dem zuletzt gespeicherten Stand, sonst bekäme eine gerade
  // erst im Entwurf hinzugefügte, noch ungespeicherte Rolle nie eine
  // Position zugewiesen.
  #workflowEditRolePlaceholderIds(): string[] {
    if (!this.#workflowEditId || !this.#workflowEditDraft) return [];
    const workflowId = this.#workflowEditId;
    return this.#workflowEditDraft.roles.map((role) => pausedPlaceholderId(workflowId, role.name));
  }

  // Eine einzige, kollabierte Kachel-Position pro Workflow — JEDER
  // Status, nicht nur gestoppt/pausiert (s. #renderWorkflowTiles):
  // Nutzerwunsch 2026-07-26: "im Root soll ein Workflow aussehen wie
  // eine Gruppe", auch während er läuft — also eine Position pro
  // Workflow statt (wie vorher, nur für laufende) einer pro Runtime-Node.
  #allWorkflowTileIds(): string[] {
    return this.#workflows.map((wf) => workflowTileId(wf.id));
  }

  // Alle Node-IDs, die zur Runtime IRGENDEINES Workflows gehören — am
  // Root-Scope ausgeschlossen aus der normalen Kachel-Liste
  // (#buildTilesAtScope), weil sie stattdessen als Teil ihrer
  // kollabierten Workflow-Kachel gezählt werden (s. dortige Doku, sonst
  // erschiene ein laufender Workflow doppelt: als Kachel UND als seine
  // einzelnen Mitglieder).
  #allWorkflowMemberNodeIds(): Set<string> {
    const ids = new Set<string>();
    for (const wf of this.#workflows) {
      for (const rt of Object.values(wf.runtime ?? {})) {
        if (rt.nodeId) ids.add(rt.nodeId);
      }
    }
    return ids;
  }

  #itemsAtScope(): { nodeIds: string[]; groupIds: string[] } {
    return topLevelItems(
      this.#groupTree,
      this.#scope,
      this.#graph.nodes.map((n) => n.id),
    );
  }

  // Kapitel 13 (docs/END-GOAL-FEATURES.md §13): dieselbe Node-/Gruppen-
  // Auswahl wie #itemsAtScope()/#buildTilesAtScope() für den Root-Scope,
  // aber bewusst UNABHÄNGIG vom aktuell offenen #scope — die Host-Ansicht
  // betrifft immer die Root-Kacheln, auch wenn der Aufruf (z. B.
  // #saveLayout während einer Kachel-Verschiebung innerhalb einer
  // Gruppe) gerade in einem anderen Scope passiert. Workflow-Kacheln
  // bleiben außen vor (eigener Renderpfad, #renderWorkflowTiles) — echte
  // B5-Gruppen dagegen bekommen seit dem Nutzerfund 2026-08-12 ("Gruppen-
  // Nodes werden nicht in der Host-Ansicht angezeigt") ebenfalls eine
  // Zone (s. #zoneIdForTile-Doku), statt wie zuvor komplett außerhalb
  // der Lanes an ihrer alten Freilayout-Position zu verharren.
  #rootZoneTileIds(): { nodeIds: string[]; groupIds: string[] } {
    const items = topLevelItems(this.#groupTree, null, this.#graph.nodes.map((n) => n.id));
    const workflowMemberIds = this.#allWorkflowMemberNodeIds();
    const nodeIds = items.nodeIds.filter((id) => !workflowMemberIds.has(id));
    // Eine Gruppe, die zugleich einen Workflow repräsentiert, erscheint
    // am Root bereits über #renderWorkflowTiles() (s. #buildTilesAtScope-
    // Kommentar zu group.workflowId) — dieselbe Ausnahme gilt hier.
    const groupIds = items.groupIds.filter((id) => !this.#groupTree.groups[id]?.workflowId);
    return { nodeIds, groupIds };
  }

  #rootZoneTileIdsFlat(): string[] {
    const { nodeIds, groupIds } = this.#rootZoneTileIds();
    return [...nodeIds, ...groupIds];
  }

  #rootZoneTiles(): TileSpec[] {
    const { nodeIds, groupIds } = this.#rootZoneTileIds();
    const nodeIdSet = new Set(nodeIds);
    const tiles: TileSpec[] = [];
    for (const node of this.#graph.nodes) {
      if (!nodeIdSet.has(node.id)) continue;
      tiles.push({
        id: node.id,
        label: node.label,
        inputs: node.inputs,
        outputs: node.outputs,
        kind: "node",
        health: node.health,
        instanceId: node.instanceId,
      });
    }
    if (groupIds.length > 0) {
      const allPorts = this.#allPortRefs();
      for (const groupId of groupIds) {
        const group = this.#groupTree.groups[groupId];
        if (!group) continue;
        const { inputs, outputs } = promotedPorts(this.#groupTree, groupId, allPorts, this.#graph.edges);
        tiles.push({
          id: groupId,
          label: group.label,
          inputs: inputs.map((p) => ({ id: p.portId, label: p.label, format: p.format })),
          outputs: outputs.map((p) => ({ id: p.portId, label: p.label, format: p.format })),
          kind: "group",
          health: "",
        });
      }
    }
    return tiles;
  }

  // Welche Zone (Host) eine Root-Gruppen-Kachel zugeordnet ist: die
  // gemeinsame Zone all ihrer (rekursiven) Mitglieder-Nodes, sofern
  // eindeutig — eine Gruppe KANN Nodes auf verschiedenen Hosts
  // enthalten (deshalb ursprünglich ganz von der Zonen-Zuordnung
  // ausgenommen), landet dann aber in der eigenen "Gruppen über mehrere
  // Hosts"-Lane statt gar nicht angezeigt zu werden. Eine leere Gruppe
  // (nur verschachtelte Untergruppen ohne eigene Nodes, praktisch nie
  // der Fall) zählt ebenfalls als gemischt — es gibt keine sinnvollere
  // Einzel-Zone dafür.
  #zoneIdForGroup(groupId: string): string {
    const memberIds = flattenMembers(this.#groupTree, groupId);
    const zones = new Set(memberIds.map((id) => this.#zoneIdForNodeId(id)));
    return zones.size === 1 ? [...zones][0] : "mixed";
  }

  #zoneIdForNodeId(nodeId: string): string {
    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    if (!node?.instanceId) return "unassigned";
    const inst = this.#paletteInstances.find((i) => i.id === node.instanceId);
    if (!inst || !inst.hostId) return "local";
    return inst.hostId;
  }

  // Welcher Zone (Host) eine Root-Kachel zugeordnet ist — reine
  // Client-Arbeit (§13.1: "der Join graph.instanceId → instances.hostId
  // → hosts.label ist reine Client-Arbeit, für Teil 1 ist kein neuer
  // Endpunkt nötig"). "local" = kein instanceId→hostId (lokal gestartet
  // oder Instanz-Liste kurzzeitig veraltet), "unassigned" = gar kein
  // instanceId (manuell gestartet, kein Launcher-Node, C8), "mixed" =
  // Gruppen-Kachel mit Mitgliedern auf uneinheitlichen Zonen
  // (#zoneIdForGroup-Doku).
  #zoneIdForTile(tile: TileSpec): string {
    return this.#zoneIdForTileId(tile.id);
  }

  // Wie #zoneIdForTile, aber ohne TileSpec — für Kapitel 13 Teil 2s
  // Kanten-Klassifizierung (#renderEdge), die nur die tileId aus
  // #portLocation kennt, keine volle TileSpec.
  #zoneIdForTileId(tileId: string): string {
    return this.#groupTree.groups[tileId] ? this.#zoneIdForGroup(tileId) : this.#zoneIdForNodeId(tileId);
  }

  // Zonen-Reihenfolge für die festen Lanes (§13.5 Frage 1, Nutzerwahl
  // 2026-08-10: "feste vertikale Lanes"): immer zuerst die lokale Zone
  // (Orchestrator-Host selbst registriert sich nie als eigener Host-
  // Datensatz, s. §13.1), dann alle registrierten Remote-Hosts in
  // API-Reihenfolge, danach — nur falls tatsächlich betroffen —
  // "Unzugeordnet", zuletzt "Gruppen über mehrere Hosts" (Nutzerfund
  // 2026-08-12: Gruppen-Kacheln mit uneinheitlichen Mitglieder-Zonen,
  // s. #zoneIdForGroup-Doku).
  #hostZones(tiles: TileSpec[]): { id: string; label: string; metrics?: HostMetrics }[] {
    const zones: { id: string; label: string; metrics?: HostMetrics }[] = [
      { id: "local", label: "Orchestrator-Host (lokal)" },
      ...this.#paletteHosts.map((h) => ({ id: h.id, label: h.label, metrics: h.metrics })),
    ];
    if (tiles.some((t) => this.#zoneIdForTile(t) === "unassigned")) {
      zones.push({ id: "unassigned", label: "Unzugeordnet" });
    }
    if (tiles.some((t) => this.#zoneIdForTile(t) === "mixed")) {
      zones.push({ id: "mixed", label: "Gruppen über mehrere Hosts" });
    }
    return zones;
  }

  // Ordnet jede der übergebenen Root-Node-Kacheln in die Lane ihrer
  // Zone ein — bereits in #hostViewPositions gemerkte Kacheln behalten
  // ihre (ggf. innerhalb der Lane verschobene) Position, nur wirklich
  // neue bekommen eine Default-Stapelposition innerhalb ihrer Lane.
  // Rein additiv zu #positions (schreibt nur die übergebenen IDs) —
  // aufrufbar sowohl beim Einschalten (alle Root-Node-Kacheln) als auch
  // nach einem #fetchAndRender() für zwischenzeitlich neu erschienene
  // Kacheln (s. dortiger Aufruf).
  //
  // Live-Fund 2026-08-12 (beim Verifizieren von Kapitel 13 Teil 2 mit
  // einem zweiten Host): eine "gemerkte" Position ist nur INNERHALB
  // ihrer eigenen Lane vertrauenswürdig — registriert sich ein neuer
  // Host, verschiebt sich die Lane-Reihenfolge (z. B. rückt
  // "Unzugeordnet" von Index 1 auf Index 2), und eine alte gemerkte
  // Position landet dann optisch in einer FREMDEN Lane, obwohl die
  // Kachel weiterhin korrekt der richtigen Zone zugeordnet ist (rein
  // datengetrieben über #zoneIdForTile, unabhängig von #positions).
  // Ein `remembered.x`-Abgleich gegen die Lane-Grenzen der AKTUELLEN
  // Zone verwirft eine so verwaiste Position statt sie blind zu
  // übernehmen.
  #arrangeIntoLanes(tiles: TileSpec[]): boolean {
    let changed = false;
    const zones = this.#hostZones(tiles);
    let x = HOST_ZONE_MARGIN;
    for (const zone of zones) {
      const zoneTiles = tiles.filter((t) => this.#zoneIdForTile(t) === zone.id);
      let y = HOST_ZONE_HEADER_HEIGHT + HOST_ZONE_MARGIN;
      for (const tile of zoneTiles) {
        const remembered = this.#hostViewPositions[tile.id];
        const rememberedInThisLane = !!remembered && remembered.x >= x - 1 && remembered.x < x + HOST_ZONE_LANE_WIDTH;
        const pos = rememberedInThisLane ? remembered : { x, y };
        if (!this.#positions[tile.id] || this.#positions[tile.id].x !== pos.x || this.#positions[tile.id].y !== pos.y) {
          this.#positions[tile.id] = pos;
          changed = true;
        }
        if (!rememberedInThisLane) this.#hostViewPositions[tile.id] = pos;
        const height = this.#tileHeightById.get(tile.id) ?? nodeHeight(tile.inputs.length, tile.outputs.length);
        y += height + HOST_ZONE_TILE_GAP;
      }
      x += HOST_ZONE_LANE_WIDTH + HOST_ZONE_LANE_GAP;
    }
    return changed;
  }

  // Auto-Default (§13.5 Frage 2, Nutzerentscheidung 2026-08-10: "ja,
  // automatisch ab 2 Hosts"): greift nur, solange der Nutzer die
  // Host-Ansicht in dieser Sitzung noch nicht selbst umgeschaltet hat
  // (#hostViewUserSet) — danach hat die bewusste Wahl Vorrang, auch
  // wenn sich die Host-Zahl danach nochmal ändert. Von #renderPalette()
  // nach jedem Host-Abruf aufgerufen (dort wird #paletteHosts befüllt).
  #updateHostViewAutoDefault() {
    if (this.#hostViewUserSet) return;
    const shouldEnable = this.#paletteHosts.length > 1;
    if (shouldEnable !== this.#hostViewEnabled) this.#toggleHostView(shouldEnable, false);
  }

  // Kapitel 13 Teil 2 (§13.4: "Zone einklappbar, analog B5-Gruppe") —
  // reiner Sichtbarkeits-Toggle, s. #collapsedZoneIds-Doku.
  #toggleZoneCollapsed(zoneId: string) {
    if (this.#collapsedZoneIds.has(zoneId)) {
      this.#collapsedZoneIds.delete(zoneId);
    } else {
      this.#collapsedZoneIds.add(zoneId);
    }
    this.#render();
  }

  #toggleHostView(enabled: boolean, userInitiated = true) {
    if (userInitiated) this.#hostViewUserSet = true;
    if (enabled === this.#hostViewEnabled) return;
    if (enabled) this.#enableHostView();
    else this.#disableHostView();
  }

  // s. #hostViewEnabled-Doku: #positions hält für die Root-Node-Kacheln
  // ab hier die Lane-Anordnung statt des freien Layouts — #freeRoot
  // Positions sichert das freie Layout für #disableHostView().
  #enableHostView() {
    const rootIds = this.#rootZoneTileIdsFlat();
    this.#freeRootPositions = {};
    for (const id of rootIds) {
      if (this.#positions[id]) this.#freeRootPositions[id] = this.#positions[id];
    }
    this.#hostViewEnabled = true;
    this.#arrangeIntoLanes(this.#rootZoneTiles());
    this.#render();
    this.#saveLayout();
  }

  #disableHostView() {
    const rootIds = this.#rootZoneTileIdsFlat();
    for (const id of rootIds) {
      if (this.#positions[id]) this.#hostViewPositions[id] = this.#positions[id];
    }
    this.#hostViewEnabled = false;
    for (const id of rootIds) {
      if (this.#freeRootPositions[id]) this.#positions[id] = this.#freeRootPositions[id];
      else delete this.#positions[id];
    }
    this.#assignMissingPositions(false);
    this.#render();
    this.#saveLayout();
  }

  #allPortRefs(): PortRef[] {
    const refs: PortRef[] = [];
    for (const node of this.#graph.nodes) {
      for (const p of node.inputs) {
        refs.push({ nodeId: node.id, portId: p.id, side: "input", label: p.label, format: p.format });
      }
      for (const p of node.outputs) {
        refs.push({ nodeId: node.id, portId: p.id, side: "output", label: p.label, format: p.format });
      }
    }
    return refs;
  }

  // S6: von ui/shell/app-shell.ts aufgerufen, wenn die Workflow-Auswahl
  // in der App-Bar wechselt (auch beim (Wieder-)Mounten des Flow-Editor-
  // Tabs, damit eine zuvor getroffene Auswahl erhalten bleibt — die
  // App-Bar hält den Filter, nicht die Kachel selbst, die bei jedem
  // Tab-Wechsel neu erzeugt wird).
  setWorkflowFilter(workflowId: string | null) {
    this.#workflowFilter = workflowId;
    this.#render();
  }

  // Von außen aufgerufen (ui/shell/app-shell.ts, nach Tab-Wechsel aus
  // der Workflows-Ansicht heraus) — s. #workflowEditId-Doku oben. Ein
  // laufender Workflow lässt sich nicht bearbeiten (Backend lehnt
  // Update() dafür ab, s. dort) — hier schon vorab abgefangen, damit
  // der Nutzer nicht erst nach einem fehlgeschlagenen Schreibversuch
  // erfährt, dass der Workflow läuft.
  // Async statt eines synchronen Lookups gegen #workflows: wird von
  // app-shell.ts direkt nach dem Tab-Wechsel auf "flow" aufgerufen
  // (s. #switchTab), also potenziell BEVOR die frisch gemountete Kachel
  // ihre eigene #init()-Ladephase abgeschlossen hat. #queueFetchAndRender
  // reiht sich hinter einen bereits laufenden Fetch ein (eigene
  // Promise-Kette, s. dortige Doku) statt einen zweiten parallel
  // loszuschicken — dieser Await liefert deshalb garantiert frische Daten,
  // ganz gleich ob #workflows schon gefüllt war oder nicht.
  async enterWorkflowEditScope(workflowId: string) {
    if (this.#workflowEditId === workflowId) return; // bereits offen
    if (this.#workflowEditId !== null && !this.#confirmDiscardDraft()) return;
    await this.#queueFetchAndRender();
    const wf = this.#workflows.find((w) => w.id === workflowId);
    if (!wf) {
      this.#showToast("Workflow nicht gefunden.");
      return;
    }
    // Kapitel 12 Teil 1/orchestrator workflows.Service.Update(): erlaubt
    // "stopped"/"paused"/"started" (2026-07-26 erweitert, s. dortige
    // Doku) — die übrigen Status sind transiente Zwischenzustände, in
    // denen weder eine Vorlagen- noch eine Live-Ansicht sinnvoll wäre.
    const editable = wf.status === "stopped" || wf.status === "paused" || wf.status === "started";
    if (!editable) {
      this.#showToast(`Workflow „${wf.name}" ist gerade „${wf.status}" — kurz warten und erneut versuchen.`);
      return;
    }
    this.#workflowEditId = workflowId;
    this.#connectFromRole = null;
    this.#selectedIds = new Set();
    if (this.#isIdleWorkflow(wf)) {
      this.#workflowEditDraft = structuredClone(wf.definition);
    } else {
      // Laufender Workflow: keine Vorlage nötig, s.
      // #renderRunningWorkflowScope — jede Sitzung startet mit einer
      // leeren Extra-Node-Menge.
      this.#workflowEditDraft = null;
      this.#workflowScopeExtraNodeIds = new Set();
      this.#workflowScopePendingInstanceIds = new Set();
    }
    this.#assignMissingPositions();
    this.#render();
  }

  #exitWorkflowEditScope() {
    if (!this.#confirmDiscardDraft()) return;
    this.#workflowEditId = null;
    this.#workflowEditDraft = null;
    this.#workflowScopeExtraNodeIds = new Set();
    this.#workflowScopePendingInstanceIds = new Set();
    this.#connectFromRole = null;
    this.#render();
  }

  // Reiner JSON-Vergleich Entwurf vs. zuletzt vom Server geladener
  // Stand — beide entstehen aus derselben Struktur (Klon bei
  // enterWorkflowEditScope), Feldreihenfolge bleibt beim Mutieren über
  // Object-Spread stabil genug für diesen Zweck. Ein falsches "dirty"
  // bei zufälliger Schlüsselreihenfolge wäre nur eine unnötige
  // Rückfrage, kein Datenverlust — anders herum (fälschlich "clean")
  // wäre ein stilles Verwerfen echter Änderungen, deshalb im Zweifel
  // eher zu oft nachfragen als zu selten.
  //
  // Für einen LAUFENDEN Workflow gibt es keinen Entwurf (Positions-/
  // Verbindungsänderungen wirken dort sofort, wie überall sonst) —
  // "dirty" bedeutet hier: seit dem Betreten wurden neue Nodes
  // hinzugefügt, die noch nicht per "Im Workflow speichern" in der
  // Definition verankert sind.
  #isDraftDirty(): boolean {
    if (this.#workflowScopeExtraNodeIds.size > 0) return true;
    const wf = this.#workflows.find((w) => w.id === this.#workflowEditId);
    if (!wf || !this.#workflowEditDraft) return false;
    return JSON.stringify(this.#workflowEditDraft) !== JSON.stringify(wf.definition);
  }

  // Nutzerwunsch (2026-07-26): kein stilles Verwerfen ungespeicherter
  // Änderungen beim Verlassen des Bearbeiten-Modus — nur nachfragen,
  // wenn der Entwurf tatsächlich vom gespeicherten Stand abweicht.
  #confirmDiscardDraft(): boolean {
    if (!this.#isDraftDirty()) return true;
    return confirm("Ungespeicherte Änderungen verwerfen?");
  }

  // Löst #workflowScopePendingInstanceIds gegen den aktuellen
  // #graph.nodes-Stand auf (s. #startInstance/#workflowScopeExtraNodeIds-
  // Doku) — am Anfang jedes #renderRunningWorkflowScope()-Laufs, da
  // dieser nach jedem SSE-getriebenen Refetch neu läuft.
  #reconcileWorkflowScopePendingInstances() {
    if (this.#workflowScopePendingInstanceIds.size === 0) return;
    for (const node of this.#graph.nodes) {
      if (node.instanceId && this.#workflowScopePendingInstanceIds.has(node.instanceId)) {
        this.#workflowScopePendingInstanceIds.delete(node.instanceId);
        this.#workflowScopeExtraNodeIds.add(node.id);
      }
    }
  }

  // Nutzerwunsch (2026-07-26, zweite Präzisierung): "wenn der Workflow
  // gestartet ist... doppelklicke... darin bin und Änderungen vornehme
  // (Position, neues Node)... muss ich das im Workflow speichern
  // können." Zeigt die ECHTEN Runtime-Nodes dieses Workflows (+ diese
  // Sitzung neu hinzugekommene, s. #workflowScopeExtraNodeIds) über die
  // GANZ NORMALE Kachel-/Kanten-Pipeline (#renderTile/#renderEdge) —
  // echte Ports, Ziehen, Verbinden per Port-Ziehen, Parameter-Panel,
  // nichts davon ist neu, nur die Knotenmenge ist gefiltert (exakt das
  // Muster von #buildTilesForWorkflowFilter, dessen #portLocation-
  // Aufbau #renderEdge() implizit auf sichtbare Kanten begrenzt, s.
  // dort). Positions-/Verbindungsänderungen wirken sofort wie überall
  // im Editor; "Im Workflow speichern"
  // (#saveRunningWorkflowFromLiveTopology) erfasst diesen Stand
  // zusätzlich als neue Definition fürs nächste Mal.
  #renderRunningWorkflowScope() {
    const workflowId = this.#workflowEditId;
    const wf = this.#workflows.find((w) => w.id === workflowId);
    if (!wf) {
      this.#workflowEditId = null;
      this.#render();
      return;
    }
    this.#reconcileWorkflowScopePendingInstances();

    const memberIds = new Set(
      Object.values(wf.runtime ?? {})
        .map((rt) => rt.nodeId)
        .filter((id): id is string => !!id),
    );
    for (const id of this.#workflowScopeExtraNodeIds) memberIds.add(id);

    // K7 Teil 4: nodeId -> Rollenname (Runtime), Rollenname -> ob sie eine
    // Standby-Rolle ist (Definition) — zwei kleine lokale Lookups statt
    // einer dauerhaften Struktur, nur für diesen Render-Durchlauf gebraucht.
    const roleNameByNodeId = new Map<string, string>();
    for (const [roleName, rt] of Object.entries(wf.runtime ?? {})) {
      if (rt.nodeId) roleNameByNodeId.set(rt.nodeId, roleName);
    }
    const standbyRoleNames = new Set(
      wf.definition.roles.filter((r) => !!r.standbyFor).map((r) => r.name),
    );

    const tiles: TileSpec[] = this.#graph.nodes
      .filter((n) => memberIds.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        inputs: n.inputs,
        outputs: n.outputs,
        kind: "node" as const,
        health: n.health,
        instanceId: n.instanceId,
        isStandby: standbyRoleNames.has(roleNameByNodeId.get(n.id) ?? ""),
      }));

    this.#portLocation.clear();
    this.#tileHeightById.clear();
    for (const tile of tiles) {
      const hasPreview = !!this.#hasPreviewById.get(tile.id);
      this.#tileHeightById.set(tile.id, nodeHeight(tile.inputs.length, tile.outputs.length, hasPreview));
      tile.inputs.forEach((p, i) =>
        this.#portLocation.set(p.id, { tileId: tile.id, side: "input", index: i, count: tile.inputs.length })
      );
      tile.outputs.forEach((p, i) =>
        this.#portLocation.set(p.id, { tileId: tile.id, side: "output", index: i, count: tile.outputs.length })
      );
    }

    for (const tile of tiles) {
      this.#viewportGroup.appendChild(this.#renderTile(tile));
    }
    for (const edge of this.#graph.edges) {
      const edgeEl = this.#renderEdge(edge);
      if (edgeEl) this.#viewportGroup.insertBefore(edgeEl, this.#viewportGroup.firstChild);
    }
  }

  // Bug 2: Bearbeiten-Modus-Renderpfad — eine Kachel pro Rolle
  // (editierbar, s. #renderEditableRoleTile), eine klickbare gestrichelte
  // Linie pro Verbindung (Klick = trennen). Liest ausschließlich aus dem
  // lokalen Entwurf (#workflowEditDraft), NICHT aus wf.definition — erst
  // #saveWorkflowEditDraft() schreibt zurück. Nutzt dieselben
  // synthetischen Positionen wie die Pause-Platzhalter
  // (pausedPlaceholderId), damit ein Wechsel pausiert-Ansicht ↔
  // Bearbeiten-Modus das Layout nicht springen lässt.
  #renderWorkflowEditScope() {
    const wf = this.#workflows.find((w) => w.id === this.#workflowEditId);
    const draft = this.#workflowEditDraft;
    if (!wf || !draft) {
      this.#workflowEditId = null;
      this.#workflowEditDraft = null;
      this.#render();
      return;
    }

    const height = MIN_BODY_HEIGHT + HEADER_HEIGHT;
    for (const conn of draft.connections) {
      const fromPos = this.#positions[pausedPlaceholderId(wf.id, conn.fromRole)];
      const toPos = this.#positions[pausedPlaceholderId(wf.id, conn.toRole)];
      if (!fromPos || !toPos) continue;

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("data-role", "workflow-edit-connection");
      line.setAttribute("data-from-role", conn.fromRole);
      line.setAttribute("data-to-role", conn.toRole);
      line.setAttribute("x1", String(fromPos.x + NODE_WIDTH / 2));
      line.setAttribute("y1", String(fromPos.y + height / 2));
      line.setAttribute("x2", String(toPos.x + NODE_WIDTH / 2));
      line.setAttribute("y2", String(toPos.y + height / 2));
      line.setAttribute("stroke", "#5b9bd5");
      line.setAttribute("stroke-width", "3");
      line.setAttribute("stroke-dasharray", "4 4");
      line.style.cursor = "pointer";
      line.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#removeWorkflowConnection(conn.fromRole, conn.toRole);
      });
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = "Verbindung trennen";
      line.appendChild(title);
      this.#viewportGroup.appendChild(line);
    }

    for (const role of draft.roles) {
      this.#viewportGroup.appendChild(this.#renderEditableRoleTile(wf.id, role));
    }
  }

  // Textfeld-Ersatz für die Namens-`<text>` einer Bearbeiten-Modus-
  // Kachel (`#editingWorkflowRoleName`) — gleiches Muster wie
  // `RoleDesigner#renderRoleNameEditor`, eigene Kopie statt geteilter
  // Helfer: unterschiedliche Host-Klassen (`this` ist hier `FlowCanvas`,
  // dort `RoleDesigner`), reine JSON-Logik (`renameRole`) ist bereits
  // geteilt, nur das DOM-Rendering nicht.
  #renderWorkflowRoleNameEditor(oldName: string): SVGForeignObjectElement {
    const editObject = document.createElementNS(SVG_NS, "foreignObject") as SVGForeignObjectElement;
    editObject.setAttribute("x", "6");
    editObject.setAttribute("y", "2");
    editObject.setAttribute("width", String(NODE_WIDTH - 16));
    editObject.setAttribute("height", String(HEADER_HEIGHT - 4));
    editObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.style.cssText =
      "width:100%;height:100%;box-sizing:border-box;font-size:12px;font-family:inherit;" +
      "background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-info);border-radius:2px;padding:0 3px;";

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      this.#renameWorkflowRole(oldName, input.value);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.#editingWorkflowRoleName = null;
      this.#render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", commit);
    editObject.appendChild(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return editObject;
  }

  // Ziehbare Rollen-Kachel im Bearbeiten-Modus (wie eine echte Node-
  // Kachel, s. #onTilePointerDown-Aufruf unten). Ein reiner Klick (keine
  // Bewegung) startet/beendet den Verbindungs-Modus (s.
  // #onWorkflowEditRoleClick) — ohne echte Ports, eine Rollen-Verbindung
  // im Template kennt keine Port-Geometrie, daher Kachel-zu-Kachel statt
  // Port-zu-Port. "×"-Knopf entfernt die Rolle.
  #renderEditableRoleTile(workflowId: string, role: { name: string; nodeType: string }): SVGGElement {
    const id = pausedPlaceholderId(workflowId, role.name);
    const pos = this.#positions[id] ?? { x: 0, y: 0 };
    const height = MIN_BODY_HEIGHT + HEADER_HEIGHT;
    const armed = this.#connectFromRole === role.name;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "workflow-edit-role");
    g.setAttribute("data-role-name", role.name);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(height));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", armed ? "#2d3a4d" : "#2d2d2d");
    body.setAttribute("stroke", armed ? "#ffcc00" : "#5b9bd5");
    body.setAttribute("stroke-width", armed ? "3" : "2");
    body.setAttribute("stroke-dasharray", "6 3");
    body.style.cursor = "pointer";
    const bodyTitle = document.createElementNS(SVG_NS, "title");
    bodyTitle.textContent = armed
      ? "Zielrolle anklicken, um zu verbinden (oder hier klicken zum Abbrechen) — ziehen zum Verschieben"
      : "Klicken, dann Zielrolle anklicken, um zu verbinden — ziehen zum Verschieben";
    body.appendChild(bodyTitle);
    g.appendChild(body);

    // Nutzerwunsch (2026-07-26): "wie eine Gruppe bearbeiten" — dieselbe
    // Zieh-Logik wie bei echten Node-/Gruppen-Kacheln (#onTilePointerDown
    // ist ID-agnostisch), damit sich Rollen-Kacheln frei positionieren
    // lassen. Ein reiner Klick ohne Bewegung (#onPointerUp, kind==="node")
    // erkennt anhand von workflowEditRoleName(), dass `id` eine Rollen-
    // Kachel ist, und ruft #onWorkflowEditRoleClick() statt
    // #openParameterPanel() auf.
    g.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, id));

    if (this.#editingWorkflowRoleName === role.name) {
      g.appendChild(this.#renderWorkflowRoleNameEditor(role.name));
    } else {
      const nameText = document.createElementNS(SVG_NS, "text");
      nameText.setAttribute("data-role", "workflow-edit-role-name");
      nameText.setAttribute("x", "8");
      nameText.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      nameText.setAttribute("fill", "#f0f0f0");
      nameText.setAttribute("font-size", "12");
      nameText.textContent = role.name;
      nameText.style.cursor = "text";
      // Muss Pointer-Events selbst fangen (dblclick zum Umbenennen) —
      // dafür wie bei `closeBtn` explizit stoppen, sonst startet
      // derselbe Klick zusätzlich #onTilePointerDown/den Verbinden-Klick.
      nameText.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      nameText.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.#editingWorkflowRoleName = role.name;
        this.#render();
      });
      const nameTitle = document.createElementNS(SVG_NS, "title");
      nameTitle.textContent =
        "Doppelklick zum Umbenennen — dieser Name erscheint als Sender-/Crosspoint-Label (Nutzerwunsch 2026-07-30: sprechende Namen).";
      nameText.appendChild(nameTitle);
      g.appendChild(nameText);
    }

    const typeText = document.createElementNS(SVG_NS, "text");
    typeText.setAttribute("x", "8");
    typeText.setAttribute("y", String(HEADER_HEIGHT + 16));
    typeText.setAttribute("fill", "#999");
    typeText.setAttribute("font-size", "11");
    typeText.setAttribute("pointer-events", "none");
    typeText.textContent = role.nodeType;
    g.appendChild(typeText);

    const closeBtn = document.createElementNS(SVG_NS, "text");
    closeBtn.setAttribute("x", String(NODE_WIDTH - 8));
    closeBtn.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    closeBtn.setAttribute("text-anchor", "end");
    closeBtn.setAttribute("fill", "#e05050");
    closeBtn.setAttribute("font-size", "12");
    closeBtn.style.cursor = "pointer";
    closeBtn.setAttribute("data-role", "remove-workflow-role");
    closeBtn.textContent = "×";
    const closeTitle = document.createElementNS(SVG_NS, "title");
    closeTitle.textContent = "Rolle entfernen";
    closeBtn.appendChild(closeTitle);
    closeBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#removeWorkflowRole(role.name);
    });
    g.appendChild(closeBtn);

    return g;
  }

  // Erster Klick auf eine Rolle merkt sie als Verbindungs-Quelle
  // (#connectFromRole, optisch hervorgehoben). Zweiter Klick auf
  // dieselbe Rolle bricht ab, auf eine andere Rolle legt die Verbindung
  // im Entwurf an (rein lokal, kein Netzwerk — s. #mutateWorkflowDraft).
  #onWorkflowEditRoleClick(roleName: string) {
    if (this.#connectFromRole === null) {
      this.#connectFromRole = roleName;
      this.#render();
      return;
    }
    if (this.#connectFromRole === roleName) {
      this.#connectFromRole = null;
      this.#render();
      return;
    }
    const fromRole = this.#connectFromRole;
    this.#connectFromRole = null;
    this.#addWorkflowConnection(fromRole, roleName);
  }

  // Gemeinsamer Mutations-Helfer für alle Bearbeiten-Modus-Aktionen:
  // ändert NUR den lokalen Entwurf (#workflowEditDraft), sendet nichts —
  // erst #saveWorkflowEditDraft() PUTet. `mutate` bekommt eine flache
  // Kopie des aktuellen Entwurfs (Object-Spread) — unbekannte Felder
  // (settings, schedules, title, ...) bleiben dadurch erhalten, ohne
  // dass diese Datei ihre volle Struktur kennen muss (s.
  // WorkflowSummary.definition-Doku). `null` bricht klientenseitig ab
  // (z. B. doppelte Verbindung).
  #mutateWorkflowDraft(mutate: (draft: WorkflowDefinition) => WorkflowDefinition | null) {
    if (!this.#workflowEditDraft) return;
    const next = mutate({ ...this.#workflowEditDraft });
    if (next === null) return;
    this.#workflowEditDraft = next;
    this.#assignMissingPositions();
    this.#render();
  }

  #addWorkflowRole(nodeType: string) {
    if (!this.#workflowEditDraft) return;
    const usedNames = new Set(this.#workflowEditDraft.roles.map((r) => r.name));
    const roleName = uniqueRoleName(nodeType, usedNames);
    this.#mutateWorkflowDraft((draft) => ({
      ...draft,
      roles: [...draft.roles, { name: roleName, nodeType }],
    }));
  }

  #removeWorkflowRole(roleName: string) {
    if (!this.#workflowEditDraft) return;
    if (this.#workflowEditDraft.roles.length <= 1) {
      this.#showToast("Ein Workflow braucht mindestens eine Rolle.");
      return;
    }
    if (this.#connectFromRole === roleName) this.#connectFromRole = null;
    this.#mutateWorkflowDraft((draft) => ({
      ...draft,
      roles: draft.roles.filter((r) => r.name !== roleName),
      connections: draft.connections.filter((c) => c.fromRole !== roleName && c.toRole !== roleName),
    }));
  }

  #renameWorkflowRole(oldName: string, newName: string) {
    this.#editingWorkflowRoleName = null;
    if (!this.#workflowEditDraft) return;
    const result = renameRole(this.#workflowEditDraft.roles, this.#workflowEditDraft.connections, oldName, newName);
    if (!result.ok) {
      if (newName.trim() && newName.trim() !== oldName) {
        this.#showToast(`Name "${newName.trim()}" ist schon vergeben oder ungültig.`);
      }
      this.#render();
      return;
    }
    if (this.#connectFromRole === oldName) this.#connectFromRole = newName.trim();
    const workflowId = this.#workflowEditId;
    if (workflowId) {
      const oldId = pausedPlaceholderId(workflowId, oldName);
      const newId = pausedPlaceholderId(workflowId, newName.trim());
      if (this.#positions[oldId]) {
        this.#positions[newId] = this.#positions[oldId];
        delete this.#positions[oldId];
      }
    }
    this.#mutateWorkflowDraft((draft) => ({ ...draft, roles: result.roles, connections: result.connections }));
  }

  #addWorkflowConnection(fromRole: string, toRole: string) {
    this.#mutateWorkflowDraft((draft) => {
      if (draft.connections.some((c) => c.fromRole === fromRole && c.toRole === toRole)) {
        this.#showToast("Verbindung besteht bereits.");
        return null;
      }
      return { ...draft, connections: [...draft.connections, { fromRole, toRole }] };
    });
  }

  #removeWorkflowConnection(fromRole: string, toRole: string) {
    this.#mutateWorkflowDraft((draft) => ({
      ...draft,
      connections: draft.connections.filter((c) => !(c.fromRole === fromRole && c.toRole === toRole)),
    }));
  }

  // Einziger PUT-Aufruf des Bearbeiten-Modus, ausgelöst durch den
  // "Speichern"-Button (Nutzerwunsch 2026-07-26: explizites Speichern
  // statt PUT bei jeder einzelnen Mutation). Bleibt nach Erfolg im
  // Bearbeiten-Modus (der Entwurf entspricht jetzt dem gespeicherten
  // Stand, kein erneutes Klonen nötig) — #queueFetchAndRender aktualisiert
  // wf.status/updatedAt u. Ä. für den Rest der Ansicht.
  async #saveWorkflowEditDraft() {
    const workflowId = this.#workflowEditId;
    const wf = this.#workflows.find((w) => w.id === workflowId);
    if (!workflowId || !wf || !this.#workflowEditDraft) return;
    try {
      const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wf.name, definition: this.#workflowEditDraft }),
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Speichern fehlgeschlagen: ${text || res.status}`);
        return;
      }
      this.#showToast("Workflow gespeichert.");
      await this.#queueFetchAndRender();
      // Entwurf gegen den frisch vom Server bestätigten Stand neu klonen
      // (statt einfach unverändert zu lassen) — sonst könnte #isDraftDirty
      // durch bloße JSON-Schlüsselreihenfolge-Unterschiede (Go-Encoding
      // vs. Browser-Klon) fälschlich "dirty" melden, obwohl gerade erst
      // erfolgreich gespeichert wurde.
      const refreshed = this.#workflows.find((w) => w.id === workflowId);
      if (refreshed) this.#workflowEditDraft = structuredClone(refreshed.definition);
    } catch (err) {
      this.#showToast(`Speichern fehlgeschlagen: ${err}`);
    }
  }

  // Nutzerwunsch (2026-07-26, zweite Präzisierung, wörtlich): "wenn ich
  // dann doppelklicke und darin bin und Änderungen vornehme (Position,
  // neues Node) muss ich die Möglichkeit haben, das im Workflow zu
  // speichern." Leitet Rollen+Verbindungen aus dem AKTUELLEN Live-Stand
  // ab — Runtime-Mitglieder plus diese Sitzung neu hinzugekommene Extra-
  // Nodes (#workflowScopeExtraNodeIds) — exakt nach demselben Muster wie
  // #saveGroupAsWorkflow(), aber: (a) PUT auf den EXISTIERENDEN Workflow
  // statt POST eines neuen, (b) bereits bekannte Rollen behalten ihren
  // Namen (aus wf.runtime aufgelöst) statt neu vergeben zu werden. Setzt
  // voraus, dass workflows.Service.Update() jetzt auch "started"
  // akzeptiert (2026-07-26 gelockert, s. dortige Doku) — sicher, weil
  // die neue Definition per Konstruktion exakt dem entspricht, was
  // gerade läuft; sie wirkt erst beim NÄCHSTEN Start, nicht rückwirkend
  // auf die laufenden Prozesse.
  async #saveRunningWorkflowFromLiveTopology() {
    const workflowId = this.#workflowEditId;
    const wf = this.#workflows.find((w) => w.id === workflowId);
    if (!workflowId || !wf) return;

    const existingRoleNameByNodeId = new Map<string, string>();
    for (const [roleName, rt] of Object.entries(wf.runtime ?? {})) {
      if (rt.nodeId) existingRoleNameByNodeId.set(rt.nodeId, roleName);
    }
    const memberIds = new Set(existingRoleNameByNodeId.keys());
    for (const id of this.#workflowScopeExtraNodeIds) memberIds.add(id);

    let instances: LauncherInstance[];
    try {
      const res = await apiFetch("/api/v1/instances");
      instances = res.ok ? ((await res.json()) as LauncherInstance[]) : [];
    } catch {
      instances = [];
    }
    const instanceById = new Map(instances.map((i) => [i.id, i]));

    const roleNameByNodeId = new Map<string, string>();
    const roles: { name: string; nodeType: string; hostId?: string }[] = [];
    const missing: string[] = [];
    const usedNames = new Set<string>(existingRoleNameByNodeId.values());

    for (const nodeId of memberIds) {
      const node = this.#graph.nodes.find((n) => n.id === nodeId);
      const inst = node?.instanceId ? instanceById.get(node.instanceId) : undefined;
      if (!node || !inst) {
        missing.push(node?.label ?? nodeId);
        continue;
      }
      const roleName = existingRoleNameByNodeId.get(nodeId) ?? uniqueRoleName(inst.type, usedNames);
      usedNames.add(roleName);
      roleNameByNodeId.set(nodeId, roleName);
      roles.push({ name: roleName, nodeType: inst.type, hostId: inst.hostId });
    }

    if (missing.length > 0) {
      this.#showToast(
        `Im Workflow speichern nicht möglich — ohne Launcher-Instanz (nicht über den Katalog gestartet): ${
          missing.join(", ")
        }`,
      );
      return;
    }
    if (roles.length === 0) {
      this.#showToast("Keine speicherbaren Nodes in diesem Workflow.");
      return;
    }

    // Gleiche fromSender/toReceiver-Logik wie #saveGroupAsWorkflow: nur
    // gesetzt, wenn die jeweilige Node mehr als einen Port auf dieser
    // Seite hat (s. dortige ausführliche Begründung).
    const portOwner = new Map<string, { nodeId: string; label: string; siblingCount: number }>();
    for (const node of this.#graph.nodes) {
      for (const p of node.outputs) portOwner.set(p.id, { nodeId: node.id, label: p.label, siblingCount: node.outputs.length });
      for (const p of node.inputs) portOwner.set(p.id, { nodeId: node.id, label: p.label, siblingCount: node.inputs.length });
    }

    const connections: { fromRole: string; fromSender?: string; toRole: string; toReceiver?: string }[] = [];
    for (const edge of this.#graph.edges) {
      const from = portOwner.get(edge.fromSender);
      const to = portOwner.get(edge.toReceiver);
      if (!from || !to) continue;
      if (!memberIds.has(from.nodeId) || !memberIds.has(to.nodeId)) continue;
      connections.push({
        fromRole: roleNameByNodeId.get(from.nodeId)!,
        fromSender: from.siblingCount > 1 ? from.label : undefined,
        toRole: roleNameByNodeId.get(to.nodeId)!,
        toReceiver: to.siblingCount > 1 ? to.label : undefined,
      });
    }

    try {
      const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wf.name, definition: { ...wf.definition, roles, connections } }),
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Im Workflow speichern fehlgeschlagen: ${text || res.status}`);
        return;
      }
      this.#workflowScopeExtraNodeIds = new Set();
      this.#workflowScopePendingInstanceIds = new Set();
      this.#showToast("Workflow gespeichert (wirkt beim nächsten Start).");
      await this.#queueFetchAndRender();
    } catch (err) {
      this.#showToast(`Im Workflow speichern fehlgeschlagen: ${err}`);
    }
  }

  // Flache Node-Kacheln nur der Runtime-Rollen eines einzelnen
  // Workflows — bewusst ohne Gruppen-/Scope-Auflösung (s. #workflowFilter
  // -Doku oben): ein gefilterter Workflow zeigt immer seine tatsächlichen
  // Instanzen, unabhängig davon, ob eine davon zufällig Mitglied einer
  // B5-Gruppe ist.
  #buildTilesForWorkflowFilter(workflowId: string): TileSpec[] {
    const wf = this.#workflows.find((w) => w.id === workflowId);
    if (!wf) return [];
    const nodeIds = new Set(
      Object.values(wf.runtime ?? {})
        .map((rt) => rt.nodeId)
        .filter((id): id is string => !!id),
    );
    return this.#graph.nodes
      .filter((n) => nodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        inputs: n.inputs,
        outputs: n.outputs,
        kind: "node" as const,
        health: n.health,
        instanceId: n.instanceId,
      }));
  }

  #buildTilesAtScope(): TileSpec[] {
    if (this.#workflowFilter) return this.#buildTilesForWorkflowFilter(this.#workflowFilter);

    const items = this.#itemsAtScope();
    const tiles: TileSpec[] = [];

    // Nutzerwunsch (2026-07-26): jeder Workflow erscheint im Root als
    // EINE kollabierte Kachel (s. #renderWorkflowTiles), nicht mehr
    // zusätzlich als seine einzelnen Runtime-Nodes — sonst erschiene ein
    // laufender Workflow doppelt. Nur am Root relevant: innerhalb einer
    // B5-Gruppe (#scope !== null) bleiben ihre Mitglieder normal
    // sichtbar, auch wenn die Gruppe zugleich über "Als Workflow
    // speichern" einen Workflow repräsentiert (Kapitel 12 Teil 2).
    const workflowMemberIds = this.#scope === null ? this.#allWorkflowMemberNodeIds() : new Set<string>();

    for (const nodeId of items.nodeIds) {
      if (workflowMemberIds.has(nodeId)) continue;
      const node = this.#graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      tiles.push({
        id: node.id,
        label: node.label,
        inputs: node.inputs,
        outputs: node.outputs,
        kind: "node",
        health: node.health,
        instanceId: node.instanceId,
      });
    }

    if (items.groupIds.length > 0) {
      const allPorts = this.#allPortRefs();
      for (const groupId of items.groupIds) {
        const group = this.#groupTree.groups[groupId];
        if (!group) continue;
        // Live gefundener Bug (Nutzerreport 2026-07-29: "regiplatz 1
        // doppelt im floweditor"): eine Gruppe mit `workflowId` wird am
        // Root bereits über #renderWorkflowTiles() als EINE kollabierte
        // Kachel gezeigt (s. Kommentar zu workflowMemberIds oben, exakt
        // dieselbe Begründung — nur dort bisher nur für die einzelnen
        // Mitglieds-NODES angewendet, nicht für die Gruppen-Kachel
        // selbst). Ohne diesen Schnitt rendert eine solche Gruppe
        // zusätzlich hier noch ein zweites Mal als eigene Gruppen-Kachel.
        if (this.#scope === null && group.workflowId) continue;
        const { inputs, outputs } = promotedPorts(this.#groupTree, groupId, allPorts, this.#graph.edges);
        tiles.push({
          id: groupId,
          label: group.label,
          inputs: inputs.map((p) => ({ id: p.portId, label: p.label, format: p.format })),
          outputs: outputs.map((p) => ({ id: p.portId, label: p.label, format: p.format })),
          kind: "group",
          health: "",
        });
      }
    }

    return tiles;
  }

  #render() {
    this.#viewportGroup.replaceChildren();
    this.#applyViewportTransform();
    this.#renderBreadcrumb();

    // Bug 2 (2026-07-24, erweitert 2026-07-26): Bearbeiten-Modus ist ein
    // eigener Renderpfad, kein weiterer Scope innerhalb
    // #buildTilesAtScope(). Zwei Varianten je nach Status: ein gestoppter/
    // pausierter Workflow hat keine laufenden Runtime-Nodes (Vorlagen-
    // Rollen als Platzhalter, s. #renderWorkflowEditScope); ein
    // LAUFENDER Workflow zeigt dagegen seine echten Nodes mit echten
    // Ports (s. #renderRunningWorkflowScope) — beide skippen die normale
    // Root-Kachel-Liste komplett.
    if (this.#workflowEditId) {
      const wf = this.#workflows.find((w) => w.id === this.#workflowEditId);
      if (wf && !this.#isIdleWorkflow(wf)) {
        this.#renderRunningWorkflowScope();
      } else {
        this.#renderWorkflowEditScope();
      }
      return;
    }

    const tiles = this.#buildTilesAtScope();

    // Kapitel 13 Teil 2 ("Zone einklappbar"): Kacheln einer eingeklappten
    // Zone bekommen bewusst WEDER eine #portLocation- NOCH eine
    // #tileHeightById-Eintragung — #renderEdge()s bestehender
    // `!fromLoc || !toLoc`-Guard blendet ihre Kanten dadurch automatisch
    // mit aus, ohne eigene Kanten-Filterlogik. Nur am Root relevant
    // (s. #buildHostZoneLayer-Doku).
    const hiddenTileIds = this.#hostViewEnabled && this.#scope === null
      ? new Set(tiles.filter((t) => this.#collapsedZoneIds.has(this.#zoneIdForTile(t))).map((t) => t.id))
      : new Set<string>();

    this.#portLocation.clear();
    this.#tileHeightById.clear();
    for (const tile of tiles) {
      if (hiddenTileIds.has(tile.id)) continue;
      const hasPreview = !!this.#hasPreviewById.get(tile.id);
      this.#tileHeightById.set(tile.id, nodeHeight(tile.inputs.length, tile.outputs.length, hasPreview));
      tile.inputs.forEach((p, i) =>
        this.#portLocation.set(p.id, { tileId: tile.id, side: "input", index: i, count: tile.inputs.length })
      );
      tile.outputs.forEach((p, i) =>
        this.#portLocation.set(p.id, { tileId: tile.id, side: "output", index: i, count: tile.outputs.length })
      );
    }

    // Kapitel 13: Zonen-Hintergrund ist die unterste Ebene der Canvas —
    // vor allem anderen angehängt, damit Kanten/Kacheln optisch darüber
    // liegen (s. #buildHostZoneLayer-Doku für die Scope-Einschränkung).
    // `tiles` ist hier bereits die volle Root-Liste (Nodes UND Gruppen,
    // s. #buildTilesAtScope) — seit dem Nutzerfund 2026-08-12 bekommen
    // auch Gruppen-Kacheln eine Zone (#zoneIdForTile), ein Filtern auf
    // `kind === "node"` würde ihre Lane sonst wieder ohne Hintergrund/
    // Kopfzeile lassen.
    const zoneLayer = (this.#hostViewEnabled && this.#scope === null)
      ? this.#buildHostZoneLayer(tiles)
      : null;
    if (zoneLayer) this.#viewportGroup.appendChild(zoneLayer);

    for (const workflowTile of this.#renderWorkflowTiles()) {
      this.#viewportGroup.appendChild(workflowTile);
    }
    for (const tile of tiles) {
      if (hiddenTileIds.has(tile.id)) continue;
      this.#viewportGroup.appendChild(this.#renderTile(tile));
    }
    for (const edge of this.#graph.edges) {
      const edgeEl = this.#renderEdge(edge);
      if (edgeEl) {
        // Kanten sollen über dem Zonen-Hintergrund, aber unter den
        // Kacheln liegen — ohne zoneLayer bleibt es beim bisherigen
        // Verhalten (ganz vorne, s. Git-Historie vor Kapitel 13).
        this.#viewportGroup.insertBefore(edgeEl, zoneLayer ? zoneLayer.nextSibling : this.#viewportGroup.firstChild);
      }
    }
  }

  // Kapitel 12 Teil 2 (docs/END-GOAL-FEATURES.md §12.3b): "der Editor
  // rendert laufende Workflows als benannten Rahmen um die Kacheln ihrer
  // Runtime-Nodes (Zuordnung über wf.Runtime[role].NodeID, liegt im
  // Workflow-Objekt bereits vor)". Rein additiv/lesend — kennt weder
  // #groupTree noch verändert es Positionen; ein Rahmen erscheint nur,
  // wenn ALLE Runtime-Nodes des Workflows gerade als eigene Kachel im
  // aktuellen Scope sichtbar sind (z. B. keine davon in einer fremden
  // B5-Gruppe versteckt) — sonst still übersprungen statt eine
  // unvollständige Box zu zeichnen.
  // S6: bei aktivem Workflow-Filter zeigen Rahmen/Platzhalter-Kacheln/
  // -Kanten nur noch den einen ausgewählten Workflow — sonst blieben
  // fremde Workflow-Rahmen/-Platzhalter im gefilterten Bild sichtbar,
  // obwohl #buildTilesForWorkflowFilter() bereits nur dessen eigene
  // Node-Kacheln zeigt (widersprüchliches Bild sonst).
  #workflowsInScope(): WorkflowSummary[] {
    if (!this.#workflowFilter) return this.#workflows;
    return this.#workflows.filter((wf) => wf.id === this.#workflowFilter);
  }

  // Bug 2 Nachfund (2026-07-26): "stopped" und "paused" haben beide keine
  // Runtime-Nodes mehr (Kapitel 12 Teil 3), sind also für die Rahmen-/
  // Platzhalter-Darstellung ununterscheidbar — vorher war das hier auf
  // "paused" verengt, wodurch ein gestoppter Workflow im Root-Scope
  // komplett unsichtbar war (kein Rahmen, keine Kacheln) und sich damit
  // gar nicht per Doppelklick erreichen ließ, obwohl "stopped" der
  // Regelfall für einen zu bearbeitenden Workflow ist.
  #isIdleWorkflow(wf: WorkflowSummary): boolean {
    return wf.status === "stopped" || wf.status === "paused";
  }

  // Nutzerwunsch (2026-07-26, wörtlich, zweite Präzisierung): "ein
  // Workflow soll im Root (oder Parent) aussehen wie eine Gruppe...
  // aber wenn er läuft, ist er im Floweditor maximiert und sieht nicht
  // aus wie eine geschlossene Gruppe. Soll aber so aussehen (andere
  // Farbe)." Jeder Workflow — unabhängig vom Status — erscheint im
  // Root als EINE kollabierte Kachel, optisch wie eine echte
  // Gruppen-Kachel (gleiche Form/Farben wie der isGroup-Zweig in
  // #renderTile), nur der Rahmen wechselt die Farbe je Status
  // (WORKFLOW_FRAME_COLORS, bisher nur für den jetzt entfernten
  // laufenden-Rahmen genutzt). Doppelklick öffnet aber
  // enterWorkflowEditScope() statt #enterScope() — ein Workflow ist
  // keine echte B5-Gruppe (viele haben gar keine, s.
  // #workflowEditId-Doku), daher ein eigener, aber optisch identischer
  // Renderpfad statt Wiederverwendung der TileSpec/#renderTile-Pipeline
  // (deren dblclick fest auf #enterScope zeigt und eine echte
  // groupTree-ID erwartet). Nur im Root-Scope — ein Workflow ist nicht
  // innerhalb einer Gruppe verschachtelbar.
  #renderWorkflowTiles(): SVGGElement[] {
    if (this.#scope !== null) return [];
    const height = MIN_BODY_HEIGHT + HEADER_HEIGHT;
    const tiles: SVGGElement[] = [];

    for (const wf of this.#workflowsInScope()) {
      const id = workflowTileId(wf.id);
      const pos = this.#positions[id];
      if (!pos) continue;
      const color = WORKFLOW_FRAME_COLORS[wf.status] ?? "#5b9bd5";

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("data-role", "workflow-tile");
      g.setAttribute("data-workflow-id", wf.id);
      g.setAttribute("data-workflow-status", wf.status);
      g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

      const body = document.createElementNS(SVG_NS, "rect");
      body.setAttribute("width", String(NODE_WIDTH));
      body.setAttribute("height", String(height));
      body.setAttribute("rx", "4");
      body.setAttribute("fill", "#2d3a4d");
      body.setAttribute("stroke", color);
      body.setAttribute("stroke-width", "2");
      g.appendChild(body);

      const header = document.createElementNS(SVG_NS, "rect");
      header.setAttribute("width", String(NODE_WIDTH));
      header.setAttribute("height", String(HEADER_HEIGHT));
      header.setAttribute("rx", "4");
      header.setAttribute("fill", "#3a4a5d");
      g.appendChild(header);

      const fullLabel = `▣ ${wf.name}`;
      const title = document.createElementNS(SVG_NS, "text");
      title.setAttribute("x", "8");
      title.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      title.setAttribute("fill", "#f0f0f0");
      title.setAttribute("font-size", "12");
      title.setAttribute("pointer-events", "none");
      title.textContent = truncateTileTitle(fullLabel, 20);
      if (fullLabel.length > 20) {
        const tooltip = document.createElementNS(SVG_NS, "title");
        tooltip.textContent = fullLabel;
        title.appendChild(tooltip);
      }
      g.appendChild(title);

      const subtitle = document.createElementNS(SVG_NS, "text");
      subtitle.setAttribute("x", "8");
      subtitle.setAttribute("y", String(HEADER_HEIGHT + 16));
      subtitle.setAttribute("fill", color);
      subtitle.setAttribute("font-size", "11");
      subtitle.setAttribute("pointer-events", "none");
      subtitle.textContent = `${wf.status} — Doppelklick zum Bearbeiten`;
      g.appendChild(subtitle);

      // Wie eine echte Gruppen-Kachel: ziehbar (#onTilePointerDown ist ID-
      // agnostisch, arbeitet nur über #positions/#drag) UND per Doppelklick
      // zu öffnen. #onTilePointerDown ruft bei einem reinen Klick (keine
      // Bewegung) #openParameterPanel(id) auf — die bricht für eine ID
      // ohne Graph-Node-Treffer bereits selbst früh ab (s. dortige Doku),
      // also ungefährlich für diese synthetische ID.
      g.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, id));
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.enterWorkflowEditScope(wf.id);
      });

      tiles.push(g);
    }
    return tiles;
  }

  #renderBreadcrumb() {
    this.#breadcrumbBar.replaceChildren();

    // Bug 2: eigener Breadcrumb statt Gruppen-Pfad — der bearbeitete
    // Workflow ist keine B5-Gruppe (viele haben gar keine, s.
    // #workflowEditId-Doku), #scope bleibt dabei unverändert im
    // Hintergrund stehen, damit "Verlassen" exakt dorthin zurückkehrt.
    if (this.#workflowEditId) {
      const wf = this.#workflows.find((w) => w.id === this.#workflowEditId);
      const rootLink = document.createElement("a");
      rootLink.textContent = "Root";
      rootLink.href = "#";
      rootLink.style.color = "#5b9bd5";
      rootLink.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.#exitWorkflowEditScope();
      });
      this.#breadcrumbBar.appendChild(rootLink);
      const sep = document.createElement("span");
      sep.textContent = "›";
      this.#breadcrumbBar.appendChild(sep);
      const isLive = !!wf && !this.#isIdleWorkflow(wf);
      const label = document.createElement("span");
      label.textContent = isLive
        ? `Bearbeiten (live): ${wf?.name ?? this.#workflowEditId}`
        : `Bearbeiten: ${wf?.name ?? this.#workflowEditId}`;
      this.#breadcrumbBar.appendChild(label);

      // Nutzerwunsch (2026-07-26): expliziter Speichern-Button statt
      // PUT bei jeder einzelnen Mutation (s. #saveWorkflowEditDraft-
      // Doku) — nur aktiv, wenn etwas ungespeichert ist
      // (#isDraftDirty() deckt beide Fälle ab: Entwurf-Abweichung beim
      // gestoppten/pausierten Workflow, neue Extra-Nodes beim
      // laufenden). Bei einem laufenden Workflow speichert der Button
      // den aktuellen LIVE-Stand (#saveRunningWorkflowFromLiveTopology)
      // statt eines Entwurfs — Positions-/Verbindungsänderungen
      // wirken dort ohnehin schon sofort, nur neue Nodes müssen noch
      // in der Definition verankert werden.
      const dirty = this.#isDraftDirty();
      const saveBtn = document.createElement("button");
      saveBtn.textContent = isLive ? "Im Workflow speichern" : "Speichern";
      if (dirty) saveBtn.className = "omp-btn-primary";
      saveBtn.style.cssText = "margin-left:auto;font-size:var(--omp-font-size-xs);";
      saveBtn.disabled = !dirty;
      saveBtn.title = dirty ? "" : "Keine ungespeicherten Änderungen";
      saveBtn.addEventListener("click", () => {
        if (isLive) this.#saveRunningWorkflowFromLiveTopology();
        else this.#saveWorkflowEditDraft();
      });
      this.#breadcrumbBar.appendChild(saveBtn);

      const exitBtn = document.createElement("button");
      exitBtn.textContent = "Verlassen";
      exitBtn.style.cssText = "font-size:11px;cursor:pointer;";
      exitBtn.addEventListener("click", () => this.#exitWorkflowEditScope());
      this.#breadcrumbBar.appendChild(exitBtn);
      return;
    }

    const path = breadcrumbPath(this.#groupTree, this.#scope);
    this.#breadcrumbBar.appendChild(this.#breadcrumbLink("Root", null));
    for (const group of path) {
      const sep = document.createElement("span");
      sep.textContent = "›";
      this.#breadcrumbBar.appendChild(sep);
      this.#breadcrumbBar.appendChild(this.#breadcrumbLink(group.label, group.id));
    }

    // Nutzerfund: `margin-left:8px` statt `auto` innerhalb einer Gruppe
    // ließ den Button bei kurzen Gruppen-/Workflow-Namen im Bereich der
    // Katalog-Palette (`left:0`, 160px breit) landen — Breadcrumb-Leiste
    // und Palette liegen beide bei `left:0`/`z-index:10`, die Palette
    // (später im DOM) deckt den Button dann optisch UND für Klicks ab.
    // Immer `auto`, unabhängig vom Scope — schiebt den Button (und die
    // beiden folgenden, nur innerhalb einer Gruppe sichtbaren Knöpfe)
    // zuverlässig an den rechten Rand, außerhalb der Palette-Spalte.
    const fitBtn = document.createElement("button");
    fitBtn.textContent = "Alle einpassen";
    fitBtn.style.cssText = "margin-left:auto;font-size:var(--omp-font-size-xs);";
    fitBtn.addEventListener("click", () => this.#fitAllToViewport());
    this.#breadcrumbBar.appendChild(fitBtn);

    // Kapitel 13 (docs/END-GOAL-FEATURES.md §13.3: "Umschaltbar:
    // Toolbar-Toggle 'Host-Ansicht'") — nur am Root sinnvoll, s.
    // #buildHostZoneLayer-Doku (Zonen bilden immer die GESAMTE
    // Root-Ebene ab, nicht den Inhalt einer B5-Gruppe).
    if (this.#scope === null) {
      const hostViewBtn = document.createElement("button");
      hostViewBtn.setAttribute("data-role", "host-view-toggle");
      hostViewBtn.textContent = this.#hostViewEnabled ? "Host-Ansicht: An" : "Host-Ansicht: Aus";
      if (this.#hostViewEnabled) hostViewBtn.className = "omp-btn-primary";
      hostViewBtn.style.cssText = "font-size:var(--omp-font-size-xs);";
      hostViewBtn.addEventListener("click", () => this.#toggleHostView(!this.#hostViewEnabled));
      this.#breadcrumbBar.appendChild(hostViewBtn);
    }

    if (this.#scope !== null) {
      const dissolveBtn = document.createElement("button");
      dissolveBtn.textContent = "Gruppe auflösen";
      dissolveBtn.style.cssText = "font-size:11px;cursor:pointer;";
      dissolveBtn.addEventListener("click", () => this.#dissolveCurrentGroup());
      this.#breadcrumbBar.appendChild(dissolveBtn);

      // Kapitel 12 Teil 2 (§12.3b): "die Brücke Editor ↔ Workflow" — eine
      // Gruppe (Regieplatz-Kandidat) als startbaren Workflow speichern.
      const saveAsWorkflowBtn = document.createElement("button");
      saveAsWorkflowBtn.textContent = "Als Workflow speichern";
      saveAsWorkflowBtn.style.cssText = "font-size:11px;cursor:pointer;";
      saveAsWorkflowBtn.addEventListener("click", () => this.#saveGroupAsWorkflow());
      this.#breadcrumbBar.appendChild(saveAsWorkflowBtn);
    }
  }

  // Manuelles Gegenstück zum Auto-Fit in #loadLayout (nur beim allerersten
  // Laden ohne gespeicherten Viewport): holt Kacheln zurück in den
  // sichtbaren Bereich, wenn sie z. B. nach vielen Sitzungen mit
  // verwaisten/neu hinzugekommenen Positionen (siehe #pruneStalePositions,
  // #assignMissingPositions) optisch außerhalb liegen — Nutzerfund: neu
  // per Instanz-Launcher gestartete Nodes waren im Graph vorhanden
  // (`/api/v1/graph`), aber im aktuellen Scroll-/Zoom-Zustand nicht
  // sichtbar. Fittet nur auf die im aktuellen Scope sichtbaren Kacheln,
  // nicht auf `#positions` insgesamt — sonst würde bei verschachtelten
  // Gruppen die Bounding-Box durch Kind-Positionen verzerrt, die auf
  // dieser Ebene gar nicht gerendert werden.
  #fitAllToViewport() {
    const ids = this.#itemsAtScope();
    this.#viewport = this.#fitViewportToIds([...ids.nodeIds, ...ids.groupIds]);
    this.#applyViewportTransform();
    this.#saveLayout();
  }

  #breadcrumbLink(label: string, scopeGroupId: string | null): HTMLAnchorElement {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = "#";
    link.style.color = "#5b9bd5";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      this.#enterScope(scopeGroupId);
    });
    return link;
  }

  #enterScope(groupId: string | null) {
    this.#scope = groupId;
    this.#selectedIds = new Set();
    this.#selectedEdgeId = null;
    this.#assignMissingPositions();
    this.#render();
  }

  #dissolveCurrentGroup() {
    if (this.#scope === null) return;
    const parent = this.#groupTree.groups[this.#scope]?.parentId ?? null;
    this.#groupTree = dissolveGroup(this.#groupTree, this.#scope);
    this.#scope = parent;
    this.#selectedIds = new Set();
    this.#saveLayout();
    this.#render();
  }

  #groupSelection() {
    const label = prompt("Name der Gruppe:", "Neue Gruppe");
    if (!label) return;

    const items = this.#itemsAtScope();
    const memberNodeIds = items.nodeIds.filter((id) => this.#selectedIds.has(id));
    const memberGroupIds = items.groupIds.filter((id) => this.#selectedIds.has(id));
    if (memberNodeIds.length + memberGroupIds.length < 2) return;

    const newGroupId = crypto.randomUUID();
    this.#groupTree = createGroup(this.#groupTree, newGroupId, label, this.#scope, memberNodeIds, memberGroupIds);

    const memberPositions = [...memberNodeIds, ...memberGroupIds]
      .map((id) => this.#positions[id])
      .filter((p): p is Point => !!p);
    if (memberPositions.length > 0) {
      this.#positions[newGroupId] = {
        x: memberPositions.reduce((s, p) => s + p.x, 0) / memberPositions.length,
        y: memberPositions.reduce((s, p) => s + p.y, 0) / memberPositions.length,
      };
    }

    this.#selectedIds = new Set();
    this.#saveLayout();
    this.#render();
  }

  // Kapitel 12 Teil 2 (§12.3b): "leitet aus den Gruppenmitgliedern die
  // Rollen ab (graph.instanceId → Instanz-Typ über /api/v1/instances;
  // Nodes ohne Launcher-Instanz sind nicht ableitbar → verständliche
  // Fehlermeldung statt stillem Auslassen) und aus den gruppeninternen
  // Kanten das port-genaue Template". Rollenname = Node-Typ
  // (+ laufender Suffix bei mehreren Rollen desselben Typs) — der
  // Nutzer kann ihn danach im Workflows-Tab per "Bearbeiten" (Kapitel 12
  // Teil 1, PUT) umbenennen, dieser Schritt braucht keinen eigenen
  // Namens-Dialog.
  async #saveGroupAsWorkflow() {
    if (this.#scope === null) return;
    const group = this.#groupTree.groups[this.#scope];
    if (!group) return;

    const memberNodeIds = flattenMembers(this.#groupTree, this.#scope);
    if (memberNodeIds.length === 0) {
      this.#showToast("Gruppe enthält keine Nodes.");
      return;
    }

    let instances: LauncherInstance[];
    try {
      const res = await apiFetch("/api/v1/instances");
      instances = res.ok ? ((await res.json()) as LauncherInstance[]) : [];
    } catch {
      instances = [];
    }
    const instanceById = new Map(instances.map((i) => [i.id, i]));

    const roleNameByNodeId = new Map<string, string>();
    const roles: { name: string; nodeType: string; hostId?: string }[] = [];
    const missing: string[] = [];
    const usedNames = new Set<string>();
    // Nutzerwunsch (2026-07-21): die Gruppenmitglieder laufen zum
    // Speicherzeitpunkt bereits — der neue Workflow soll das
    // widerspiegeln (Status "started", nicht "stopped") statt so
    // auszusehen, als wäre er nie gestartet worden. Jede Rolle kennt
    // hier bereits ihre echte, gerade laufende Instanz/Node-ID (woher
    // sonst käme roleName?), also direkt mitschicken statt separat neu
    // aufzulösen.
    const adoptRuntime: Record<string, { instanceId: string; nodeId: string }> = {};

    for (const nodeId of memberNodeIds) {
      const node = this.#graph.nodes.find((n) => n.id === nodeId);
      const inst = node?.instanceId ? instanceById.get(node.instanceId) : undefined;
      if (!node || !inst) {
        missing.push(node?.label ?? nodeId);
        continue;
      }
      const roleName = uniqueRoleName(inst.type, usedNames);
      usedNames.add(roleName);
      roleNameByNodeId.set(nodeId, roleName);
      roles.push({ name: roleName, nodeType: inst.type, hostId: inst.hostId });
      adoptRuntime[roleName] = { instanceId: inst.id, nodeId: node.id };
    }

    if (missing.length > 0) {
      this.#showToast(
        `Als Workflow speichern nicht möglich — ohne Launcher-Instanz (nicht über den Katalog gestartet): ${
          missing.join(", ")
        }`,
      );
      return;
    }

    // Nur Kanten, deren BEIDE Enden Gruppenmitglieder sind, werden Teil
    // des Templates (die gruppenexternen sind Sache der jeweils anderen
    // Rolle/eines anderen Workflows). fromSender/toReceiver werden nur
    // gesetzt, wenn die jeweilige Node mehr als einen Port auf dieser
    // Seite hat — bei genau einem Port ist der Kompatibilitäts-Fallback
    // (erster Sender/Receiver) robuster als ein eingefrorenes Label: bei
    // Node-Typen ohne explizites `SenderSpec.label` (z. B. omp-source)
    // hängt das Auto-Label vom Launcher-vergebenen `OMP_LABEL` ab, das
    // sich mit jedem Neustart der Rolle ändert (live gefunden
    // 2026-07-18, docs/decisions.md Nachtrag 17) — ein Label nur dann
    // einzufrieren, wenn es zur Auflösung wirklich gebraucht wird, hält
    // das Template robuster gegen genau diese Instabilität.
    const memberSet = new Set(memberNodeIds);
    const portOwner = new Map<string, { nodeId: string; label: string; siblingCount: number }>();
    for (const node of this.#graph.nodes) {
      for (const p of node.outputs) portOwner.set(p.id, { nodeId: node.id, label: p.label, siblingCount: node.outputs.length });
      for (const p of node.inputs) portOwner.set(p.id, { nodeId: node.id, label: p.label, siblingCount: node.inputs.length });
    }

    const connections: { fromRole: string; fromSender?: string; toRole: string; toReceiver?: string }[] = [];
    for (const edge of this.#graph.edges) {
      const from = portOwner.get(edge.fromSender);
      const to = portOwner.get(edge.toReceiver);
      if (!from || !to) continue;
      if (!memberSet.has(from.nodeId) || !memberSet.has(to.nodeId)) continue;
      connections.push({
        fromRole: roleNameByNodeId.get(from.nodeId)!,
        fromSender: from.siblingCount > 1 ? from.label : undefined,
        toRole: roleNameByNodeId.get(to.nodeId)!,
        toReceiver: to.siblingCount > 1 ? to.label : undefined,
      });
    }

    try {
      const res = await apiFetch("/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: group.label, definition: { roles, connections }, adoptRuntime }),
      });
      if (!res.ok) {
        this.#showToast(`Als Workflow speichern fehlgeschlagen: ${await res.text()}`);
        return;
      }
      const wf = (await res.json()) as { id: string };
      // Verknüpfung merken (s. GroupNode.workflowId-Doku) — damit die
      // Kachel dieser Gruppe im Root-Editor einen Stop-Button bekommt,
      // ohne raten zu müssen, welcher Workflow zu welcher Gruppe gehört.
      this.#groupTree = setGroupWorkflowId(this.#groupTree, this.#scope, wf.id);
      this.#saveLayout();
      this.#render();
      this.#showToast(`Workflow „${group.label}" angelegt und läuft bereits (aus der laufenden Gruppe übernommen).`);
    } catch (err) {
      this.#showToast(`Als Workflow speichern fehlgeschlagen: ${err}`);
    }
  }

  #applyViewportTransform() {
    const { x, y, scale } = this.#viewport;
    this.#viewportGroup.setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
  }

  // Zentriert die Bounding-Box aller bekannten Kachel-Positionen im
  // sichtbaren SVG-Bereich (scale=1, keine Zoom-Anpassung) — Fallback für
  // Layouts ohne gespeicherten Viewport (s. #loadLayout).
  #fitViewportToPositions(): Viewport {
    return this.#fitViewportToIds(Object.keys(this.#positions));
  }

  // Gemeinsame Bounding-Box-Logik für den Auto-Fit beim allerersten Laden
  // (#fitViewportToPositions, alle bekannten Positionen) und den manuellen
  // "Alle einpassen"-Button (#fitAllToViewport, nur die im aktuellen Scope
  // sichtbaren Kacheln).
  #fitViewportToIds(ids: string[]): Viewport {
    const points = ids.map((id) => this.#positions[id]).filter((p): p is Point => !!p);
    if (points.length === 0) return { ...IDENTITY_VIEWPORT };

    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x)) + NODE_WIDTH;
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y)) + MIN_BODY_HEIGHT + HEADER_HEIGHT;
    const rect = this.#svg.getBoundingClientRect();

    return {
      x: rect.width / 2 - (minX + maxX) / 2,
      y: rect.height / 2 - (minY + maxY) / 2,
      scale: 1,
    };
  }

  // Kapitel 13 (docs/END-GOAL-FEATURES.md §13.3): der Hintergrund-Ebene
  // "ein Zonen-Rechteck mit Kopfzeile (Label, Online-Punkt, CPU/RAM
  // live) pro registriertem Host". Nur am Root sinnvoll (#render() ruft
  // dies auch nur dort auf) — Zonen bilden immer die GESAMTE Fläche ab,
  // eine B5-Gruppe zeigt nur einen Ausschnitt ihrer Mitglieder, deren
  // Host-Zugehörigkeit hier keine sinnvolle Lane-Aussage mehr hätte.
  // `pointer-events:none` auf jedem Element: reines Hintergrundbild,
  // Klicks (Pan/Rubber-Band-Select) müssen unverändert bis zur Canvas
  // durchgereicht werden.
  #buildHostZoneLayer(rootTiles: TileSpec[]): SVGGElement {
    const layer = document.createElementNS(SVG_NS, "g");
    layer.setAttribute("data-role", "host-zones");
    layer.setAttribute("pointer-events", "none");

    const zones = this.#hostZones(rootTiles);
    let x = HOST_ZONE_MARGIN;
    for (const zone of zones) {
      const zoneTiles = rootTiles.filter((t) => this.#zoneIdForTile(t) === zone.id);
      const collapsed = this.#collapsedZoneIds.has(zone.id);
      let bottom = HOST_ZONE_HEADER_HEIGHT + HOST_ZONE_MARGIN * 2;
      if (!collapsed) {
        for (const tile of zoneTiles) {
          const pos = this.#positions[tile.id];
          if (!pos) continue;
          const height = this.#tileHeightById.get(tile.id) ?? nodeHeight(tile.inputs.length, tile.outputs.length);
          bottom = Math.max(bottom, pos.y - HOST_ZONE_MARGIN + height + HOST_ZONE_MARGIN);
        }
      }

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("data-role", "host-zone");
      g.setAttribute("data-host-id", zone.id);
      g.setAttribute("transform", `translate(${x},0)`);

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(HOST_ZONE_LANE_WIDTH));
      rect.setAttribute("height", String(bottom));
      rect.setAttribute("rx", "6");
      rect.setAttribute("fill", "#26282b");
      rect.setAttribute("stroke", "#3a3d42");
      rect.setAttribute("stroke-width", "1");
      g.appendChild(rect);

      const header = document.createElementNS(SVG_NS, "rect");
      header.setAttribute("x", "0");
      header.setAttribute("y", "0");
      header.setAttribute("width", String(HOST_ZONE_LANE_WIDTH));
      header.setAttribute("height", String(HOST_ZONE_HEADER_HEIGHT));
      header.setAttribute("rx", "6");
      header.setAttribute("fill", "#2f3237");
      g.appendChild(header);

      // Online-Punkt (§13.3) nur für echte Hosts (Metriken kommen per
      // NATS vom Host-Agent, s. HOST_ONLINE_THRESHOLD_MS-Doku) — die
      // lokale Zone hat keinen eigenen Host-Agent (der Orchestrator
      // selbst registriert sich nie als Host, s. §13.1), "Unzugeordnet"
      // und "Gruppen über mehrere Hosts" (Nutzerfund 2026-08-12) sind
      // beide keine echten Hosts, also kein Punkt für alle drei.
      let labelX = 10;
      if (zone.id !== "local" && zone.id !== "unassigned" && zone.id !== "mixed") {
        const online = !!zone.metrics &&
          Date.now() - Date.parse(zone.metrics.receivedAt) < HOST_ONLINE_THRESHOLD_MS;
        const dot = document.createElementNS(SVG_NS, "text");
        dot.setAttribute("x", "10");
        dot.setAttribute("y", "18");
        dot.setAttribute("fill", online ? "#4caf50" : "#777");
        dot.setAttribute("font-size", "12");
        dot.textContent = "●";
        g.appendChild(dot);
        labelX = 22;
      }

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(labelX));
      label.setAttribute("y", "18");
      label.setAttribute("fill", "#e0e0e0");
      label.setAttribute("font-size", "12");
      label.textContent = truncateTileTitle(zone.label, 26);
      if (zone.label.length > 26) {
        const tooltip = document.createElementNS(SVG_NS, "title");
        tooltip.textContent = zone.label;
        label.appendChild(tooltip);
      }
      g.appendChild(label);

      if (zone.metrics && !collapsed) {
        const metricsText = document.createElementNS(SVG_NS, "text");
        metricsText.setAttribute("x", String(labelX));
        metricsText.setAttribute("y", "34");
        metricsText.setAttribute("fill", "#9aa0a6");
        metricsText.setAttribute("font-size", "10");
        const gb = (bytes: number) => (bytes / 1024 / 1024 / 1024).toFixed(1);
        metricsText.textContent =
          `CPU ${zone.metrics.cpuPercent.toFixed(0)}% · RAM ${gb(zone.metrics.memUsedBytes)}/${gb(zone.metrics.memTotalBytes)} GB`;
        g.appendChild(metricsText);
      }

      if (collapsed) {
        const countText = document.createElementNS(SVG_NS, "text");
        countText.setAttribute("x", String(labelX));
        countText.setAttribute("y", "34");
        countText.setAttribute("fill", "#9aa0a6");
        countText.setAttribute("font-size", "10");
        countText.textContent = zoneTiles.length === 1 ? "1 Kachel" : `${zoneTiles.length} Kacheln`;
        g.appendChild(countText);
      }

      // Einklapp-Toggle (§13.4 Teil 2: "Zone einklappbar, analog
      // B5-Gruppe") — einziges interaktive Element innerhalb der sonst
      // rein dekorativen, `pointer-events:none`-Ebene (s. #buildHostZoneLayer
      // -Doku); SVG erlaubt pro-Element-Overrides, `stopPropagation()`
      // verhindert, dass derselbe Klick zusätzlich die Canvas-Pan-Logik
      // auf der Ebene darunter auslöst.
      const toggle = document.createElementNS(SVG_NS, "text");
      toggle.setAttribute("x", String(HOST_ZONE_LANE_WIDTH - 18));
      toggle.setAttribute("y", "18");
      toggle.setAttribute("fill", "#9aa0a6");
      toggle.setAttribute("font-size", "11");
      toggle.setAttribute("pointer-events", "auto");
      toggle.setAttribute("data-role", "host-zone-toggle");
      toggle.style.cursor = "pointer";
      toggle.textContent = collapsed ? "▸" : "▾";
      const toggleTitle = document.createElementNS(SVG_NS, "title");
      toggleTitle.textContent = collapsed ? "Zone ausklappen" : "Zone einklappen";
      toggle.appendChild(toggleTitle);
      toggle.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        this.#toggleZoneCollapsed(zone.id);
      });
      g.appendChild(toggle);

      layer.appendChild(g);
      x += HOST_ZONE_LANE_WIDTH + HOST_ZONE_LANE_GAP;
    }
    return layer;
  }

  #renderTile(tile: TileSpec): SVGGElement {
    const pos = this.#positions[tile.id] ?? { x: 0, y: 0 };
    const height = this.#tileHeightById.get(tile.id) ?? nodeHeight(tile.inputs.length, tile.outputs.length);
    const selected = this.#selectedIds.has(tile.id);
    const onTally = this.#tally[tile.id] === true;
    const isGroup = tile.kind === "group";

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", isGroup ? "group-tile" : "node");
    g.setAttribute("data-id", tile.id);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(height));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", onTally ? "#8b1a1a" : isGroup ? "#2d3a4d" : "#2d2d2d");
    body.setAttribute(
      "stroke",
      selected ? "#ffcc00" : onTally ? "#ff3b3b" : tile.isStandby ? "#e0a020" : isGroup ? "#5b9bd5" : healthColor(tile.health),
    );
    body.setAttribute("stroke-width", selected || onTally ? "3" : "2");
    if (selected) {
      body.setAttribute("stroke-dasharray", "6 3");
    } else if (tile.isStandby) {
      // K7 Teil 4 (Hot-Standby): gestrichelter Rahmen statt eines
      // durchgezogenen — visuell "wartet, ist noch nicht das aktive
      // Signal", analog dem Muster für ausgewählte Kacheln oben, nur
      // engmaschiger gestrichelt, um beide Zustände unterscheidbar zu
      // halten.
      body.setAttribute("stroke-dasharray", "3 3");
      const standbyTitle = document.createElementNS(SVG_NS, "title");
      standbyTitle.textContent = "Standby (warm) — übernimmt automatisch, wenn die Primärrolle ausfällt (K7 Teil 4).";
      body.appendChild(standbyTitle);
    }
    g.appendChild(body);

    const header = document.createElementNS(SVG_NS, "rect");
    header.setAttribute("width", String(NODE_WIDTH));
    header.setAttribute("height", String(HEADER_HEIGHT));
    header.setAttribute("rx", "4");
    header.setAttribute("fill", isGroup ? "#3a4a5d" : "#3a3a3a");
    g.appendChild(header);

    // Nutzerfund: bei längeren Labels überlappte der Titel den
    // Stop-Button (⏹, vorhanden bei tile.instanceId ODER — Nutzerfund
    // 2026-07-21 — einer Gruppe mit verknüpftem Workflow) — SVG-Text
    // bricht/kürzt nicht von selbst. Fester Zeichen-Budget-Ansatz statt
    // Live-Messung (`getComputedTextLength()` bräuchte das Element
    // bereits im Dokument, `g` wird aber erst vom Aufrufer angehängt) —
    // gleiches Prinzip wie `portShortLabel` unten, nur mit größerem
    // Budget (volle Kachelbreite statt Port-Label-Platz). Der volle
    // Titel bleibt über das `<title>`-Tooltip (Hover) erreichbar.
    const fullLabel = isGroup ? `▣ ${tile.label}` : tile.label;
    const hasStopButton = isGroup ? !!this.#groupTree.groups[tile.id]?.workflowId : !!tile.instanceId;
    const titleMaxChars = hasStopButton ? 17 : 20;
    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", "8");
    title.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    title.setAttribute("fill", "#f0f0f0");
    title.setAttribute("font-size", "12");
    title.textContent = truncateTileTitle(fullLabel, titleMaxChars);
    if (fullLabel.length > titleMaxChars) {
      const titleTooltip = document.createElementNS(SVG_NS, "title");
      titleTooltip.textContent = fullLabel;
      title.appendChild(titleTooltip);
    }
    g.appendChild(title);

    // Stop-Control (UMSETZUNG.md C8): nur an Kacheln, deren Node einen
    // Instanz-Tag trägt — manuell gestartete/entdeckte Nodes (alle vor
    // C8) haben keinen Stop-Weg vom Orchestrator aus.
    if (!isGroup && tile.instanceId) {
      const instanceId = tile.instanceId;
      const stopBtn = document.createElementNS(SVG_NS, "text");
      stopBtn.setAttribute("x", String(NODE_WIDTH - 8));
      stopBtn.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      stopBtn.setAttribute("text-anchor", "end");
      stopBtn.setAttribute("fill", "#e05050");
      stopBtn.setAttribute("font-size", "12");
      stopBtn.style.cursor = "pointer";
      stopBtn.setAttribute("data-role", "stop-instance");
      stopBtn.textContent = "⏹";
      const stopTitle = document.createElementNS(SVG_NS, "title");
      stopTitle.textContent = "Instanz stoppen";
      stopBtn.appendChild(stopTitle);
      stopBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      stopBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#stopInstance(instanceId, tile.label);
      });
      g.appendChild(stopBtn);
    } else if (isGroup && this.#groupTree.groups[tile.id]?.workflowId) {
      // Nutzerfund (2026-07-21): eine Gruppe, die per "Als Workflow
      // speichern" einen Workflow angelegt hat, hatte keinen Stop-Weg im
      // Root-Editor — nur über den separaten Workflows-Tab stoppbar.
      // Gleiche Optik wie der Instanz-Stop-Button oben, ruft aber den
      // Workflow-Stop auf (stoppt alle Rollen gebündelt).
      const workflowId = this.#groupTree.groups[tile.id]!.workflowId!;
      const stopBtn = document.createElementNS(SVG_NS, "text");
      stopBtn.setAttribute("x", String(NODE_WIDTH - 8));
      stopBtn.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      stopBtn.setAttribute("text-anchor", "end");
      stopBtn.setAttribute("fill", "#e05050");
      stopBtn.setAttribute("font-size", "12");
      stopBtn.style.cursor = "pointer";
      stopBtn.setAttribute("data-role", "stop-workflow");
      stopBtn.textContent = "⏹";
      const stopTitle = document.createElementNS(SVG_NS, "title");
      stopTitle.textContent = "Workflow stoppen";
      stopBtn.appendChild(stopTitle);
      stopBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      stopBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#stopWorkflow(workflowId, tile.label);
      });
      g.appendChild(stopBtn);
    }

    tile.inputs.forEach((port, i) => {
      this.#renderPort(port, i, tile.inputs.length, "input", pos, height, g);
    });
    tile.outputs.forEach((port, i) => {
      const circle = this.#renderPort(port, i, tile.outputs.length, "output", pos, height, g);
      circle.addEventListener("pointerdown", (ev) => this.#onOutputPortPointerDown(ev, port));
    });

    if (!isGroup) {
      const previewEl = this.#renderPreviewThumbnail(tile.id);
      if (previewEl) g.appendChild(previewEl);
    }

    g.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, tile.id));
    if (isGroup) {
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.#enterScope(tile.id);
      });
    }

    return g;
  }

  // Kachel-Inline-Vorschau ("Probe"): rendert das node-eigene
  // `previewUrl` (bisher `omp-viewer`/C6, jetzt auch `omp-multiviewer`)
  // als <img> in einem `<foreignObject>` direkt unter dem Kachel-Header —
  // dieselbe MJPEG-multipart/x-mixed-replace-URL, die das Parameter-Panel
  // (omp-viewer/ui/bundle.js) schon nutzt, hier aber ohne den Panel zu
  // öffnen. `nodeHeight()` reserviert für Nodes mit previewUrl genug
  // Platz (PREVIEW_HEIGHT, geometry.ts) — das Bild bleibt dadurch
  // innerhalb des Kachel-Rahmens (Nutzerfund 2026-07-12: überragte vorher
  // sichtbar den Rahmen).
  #renderPreviewThumbnail(nodeId: string): SVGForeignObjectElement | null {
    this.#maybeFetchPreviewUrl(nodeId);
    if (!this.#hasPreviewById.get(nodeId)) return null;

    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", "8");
    fo.setAttribute("y", String(HEADER_HEIGHT + 4));
    fo.setAttribute("width", String(PREVIEW_WIDTH));
    fo.setAttribute("height", String(PREVIEW_HEIGHT));
    fo.style.pointerEvents = "none"; // Ziehen/Auswählen der Kachel bleibt unverändert möglich.

    const img = document.createElement("img");
    img.src = streamProxyUrl(nodeId, "previewUrl");
    img.alt = "Vorschau";
    img.style.cssText = `display:block;width:${PREVIEW_WIDTH}px;height:${PREVIEW_HEIGHT}px;object-fit:cover;background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:2px;`;
    fo.appendChild(img);
    return fo;
  }

  #maybeFetchPreviewUrl(nodeId: string) {
    if (this.#hasPreviewById.has(nodeId) || this.#previewFetchInFlight.has(nodeId)) return;
    this.#previewFetchInFlight.add(nodeId);
    apiFetch(`/api/v1/nodes/${nodeId}/params/previewUrl`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const has = !!(body && typeof body.value === "string" && body.value);
        this.#hasPreviewById.set(nodeId, has);
        if (has) this.#render();
      })
      .catch(() => {
        this.#hasPreviewById.set(nodeId, false);
      })
      .finally(() => {
        this.#previewFetchInFlight.delete(nodeId);
      });
  }

  #renderPort(
    port: GraphPort,
    index: number,
    count: number,
    side: PortSide,
    nodePos: Point,
    height: number,
    parent: SVGGElement,
  ): SVGCircleElement {
    const world = portPosition(nodePos.x, nodePos.y, height, index, count, side);
    const cx = world.x - nodePos.x;
    const cy = world.y - nodePos.y;
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "5");
    // Farbe primär nach Format (Nutzerfund 2026-07-12: zwei Output-Ports
    // desselben Nodes — z. B. omp-sources Video-/Audio-Sender — waren
    // beide gleich eingefärbt, nur nach input/output unterscheidbar, nicht
    // nach Format); input/output bleibt über die Randfarbe erkennbar.
    circle.setAttribute("fill", portColor(port.format, port.label));
    circle.setAttribute("stroke", side === "input" ? "#5b9bd5" : "#70ad47");
    circle.setAttribute("stroke-width", "1.5");
    circle.setAttribute("data-role", "port");
    circle.setAttribute("data-port-id", port.id);
    circle.setAttribute("data-port-side", side);
    circle.setAttribute("data-format", port.format);
    const titleEl = document.createElementNS(SVG_NS, "title");
    titleEl.textContent = port.label;
    circle.appendChild(titleEl);

    // Immer sichtbares Kurz-Label (Nutzerfund 2026-07-16): bisher stand
    // der Port-Name nur im Hover-Tooltip — an einer Kachel mit mehreren
    // Ports desselben Typs (PGM/PST, Fill/Key) war von außen nicht
    // erkennbar, welcher Port welches Signal führt. `pointer-events:none`,
    // damit der Text keine eigenen Drag/Click-Events abfängt (die bleiben
    // exklusiv am `circle`, s. Aufrufer).
    //
    // Format-Kürzel (V/A/D/K, Nutzerfund 2026-07-16 Nachtrag: Farbe
    // allein verlangt, die Legende auswendig zu kennen) als eigenes,
    // in der Port-Farbe eingefärbtes `<tspan>` vor dem Rollen-Text —
    // steht so IM Text selbst, nicht nur an der (evtl. schwer zu
    // unterscheidenden) Kreisfarbe.
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("y", String(cy + 3));
    text.setAttribute("font-size", "8");
    text.setAttribute("pointer-events", "none");
    if (side === "input") {
      text.setAttribute("x", String(cx + 8));
    } else {
      text.setAttribute("x", String(cx - 8));
      text.setAttribute("text-anchor", "end");
    }
    const formatTspan = document.createElementNS(SVG_NS, "tspan");
    formatTspan.setAttribute("fill", portColor(port.format, port.label));
    formatTspan.setAttribute("font-weight", "bold");
    formatTspan.textContent = formatAbbrev(port.format, port.label);
    const roleTspan = document.createElementNS(SVG_NS, "tspan");
    roleTspan.setAttribute("fill", "#c8c8c8");
    roleTspan.textContent = ` ${portShortLabel(port.label)}`;
    // Reihenfolge im Markup bleibt Format-vor-Rolle unabhängig von der
    // Seite — bei Ausgängen (rechte Kante) sorgt `text-anchor=end`
    // allein für die optische Rechtsbündigkeit.
    text.append(formatTspan, roleTspan);
    parent.appendChild(text);
    parent.appendChild(circle);
    return circle;
  }

  #renderEdge(edge: GraphEdge): SVGPathElement | null {
    const fromLoc = this.#portLocation.get(edge.fromSender);
    const toLoc = this.#portLocation.get(edge.toReceiver);
    if (!fromLoc || !toLoc) return null;
    if (fromLoc.tileId === toLoc.tileId) return null; // auf dieser Ebene vollständig intern

    const from = this.#portWorldPosition(fromLoc);
    const to = this.#portWorldPosition(toLoc);

    const selected = edge.id === this.#selectedEdgeId;
    const mxlZoneWarning = this.#isCrossZoneMxlEdge(edge, fromLoc.tileId, toLoc.tileId);
    const midX = (from.x + to.x) / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
    );
    path.setAttribute("fill", "none");
    path.setAttribute(
      "stroke",
      selected ? "#ffffff" : mxlZoneWarning ? "var(--omp-error)" : edge.state === "active" ? "#e0a030" : "#666",
    );
    path.setAttribute("stroke-width", selected ? "3" : "2");
    if (mxlZoneWarning) path.setAttribute("stroke-dasharray", "6 4");
    path.setAttribute("data-role", "edge");
    path.setAttribute("data-id", edge.id);
    path.style.cursor = "pointer";
    if (mxlZoneWarning) {
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = MXL_ZONE_WARNING_TITLE;
      path.appendChild(title);
    }
    path.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#selectedEdgeId = edge.id;
      this.#render();
    });
    return path;
  }

  // Kapitel 13 Teil 2 (docs/END-GOAL-FEATURES.md §13.3): "eine Kante
  // zwischen Kacheln verschiedener Zonen, deren Ports MXL-Format
  // tragen, wird im Warn-Stil gerendert" — advisory, kein Blockieren
  // (harte Durchsetzung wäre Graph-API-Arbeit, bewusst spätere Stufe).
  // Nur relevant, solange die Host-Ansicht tatsächlich sichtbar ist
  // (Root-Scope, s. #buildHostZoneLayer-Doku) — außerhalb hat "Zone"
  // keine Bedeutung.
  #isCrossZoneMxlEdge(edge: GraphEdge, fromTileId: string, toTileId: string): boolean {
    if (!this.#hostViewEnabled || this.#scope !== null) return false;
    if (this.#portTransport.get(edge.fromSender) !== TRANSPORT_MXL) return false;
    return this.#zoneIdForTileId(fromTileId) !== this.#zoneIdForTileId(toTileId);
  }

  #portWorldPosition(loc: PortLocation): Point {
    const tilePos = this.#positions[loc.tileId] ?? { x: 0, y: 0 };
    const height = this.#tileHeightById.get(loc.tileId) ?? nodeHeight(0, 0);
    return portPosition(tilePos.x, tilePos.y, height, loc.index, loc.count, loc.side);
  }

  #findPortWorldPosition(portId: string): Point | null {
    const loc = this.#portLocation.get(portId);
    return loc ? this.#portWorldPosition(loc) : null;
  }

  #onTilePointerDown(ev: PointerEvent, tileId: string) {
    ev.stopPropagation();
    if (ev.shiftKey) {
      this.#toggleSelection(tileId);
      return;
    }
    // Nur neu rendern, wenn sich die Auswahl tatsächlich ändert — ein
    // Re-Render bei jedem Klick tauscht den DOM-Knoten aus und verhindert,
    // dass der Browser einen Doppelklick auf dieselbe Kachel erkennt.
    if (this.#selectedIds.size > 0) {
      this.#selectedIds = new Set();
      this.#render();
    }
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const startWorld = this.#positions[tileId] ?? { x: 0, y: 0 };
    this.#drag = {
      kind: "node",
      nodeId: tileId,
      startScreen: this.#screenPoint(ev),
      startWorld,
      moved: false,
    };
  }

  #toggleSelection(tileId: string) {
    if (this.#selectedIds.has(tileId)) {
      this.#selectedIds.delete(tileId);
    } else {
      this.#selectedIds.add(tileId);
    }
    this.#render();
  }

  #onOutputPortPointerDown(ev: PointerEvent, port: GraphPort) {
    ev.stopPropagation();
    this.#svg.setPointerCapture(ev.pointerId);
    const fromWorld = this.#findPortWorldPosition(port.id) ?? { x: 0, y: 0 };
    this.#drag = {
      kind: "connect",
      fromPortId: port.id,
      fromFormat: port.format,
      fromWorld,
      currentScreen: this.#screenPoint(ev),
    };
    this.#highlightIncompatiblePorts(port.format);
    this.#updateRubberBand();
  }

  #onPointerDown(ev: PointerEvent) {
    if (this.#drag) return;
    this.#selectedEdgeId = null;

    if (ev.shiftKey) {
      this.#svg.setPointerCapture(ev.pointerId);
      this.#drag = { kind: "select", startScreen: this.#screenPoint(ev) };
      return;
    }

    if (this.#selectedIds.size > 0) {
      this.#selectedIds = new Set();
      this.#render();
    }
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = {
      kind: "pan",
      startScreen: this.#screenPoint(ev),
      startViewport: { ...this.#viewport },
      moved: false,
    };
  }

  #onPointerMove(ev: PointerEvent) {
    if (!this.#drag) return;
    const current = this.#screenPoint(ev);

    if (this.#drag.kind === "pan") {
      const dx = current.x - this.#drag.startScreen.x;
      const dy = current.y - this.#drag.startScreen.y;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) this.#drag.moved = true;
      this.#viewport = {
        x: this.#drag.startViewport.x + dx,
        y: this.#drag.startViewport.y + dy,
        scale: this.#drag.startViewport.scale,
      };
      this.#applyViewportTransform();
      return;
    }

    if (this.#drag.kind === "connect") {
      this.#drag = { ...this.#drag, currentScreen: current };
      this.#updateRubberBand();
      return;
    }

    if (this.#drag.kind === "select") {
      this.#updateSelectionRect(this.#drag.startScreen, current);
      return;
    }

    const dxScreen = current.x - this.#drag.startScreen.x;
    const dyScreen = current.y - this.#drag.startScreen.y;
    // Klick-Toleranz: Mausjitter unterhalb der Schwelle löst noch keinen
    // Re-Render aus — sonst tauscht ein "zittriger" Klick den DOM-Knoten
    // aus und der Browser erkennt einen nachfolgenden Doppelklick nicht
    // mehr auf derselben Kachel.
    if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
    this.#drag.moved = true;

    const dxWorld = dxScreen / this.#viewport.scale;
    const dyWorld = dyScreen / this.#viewport.scale;
    this.#positions[this.#drag.nodeId] = {
      x: this.#drag.startWorld.x + dxWorld,
      y: this.#drag.startWorld.y + dyWorld,
    };
    this.#render();
  }

  #onPointerUp(ev: PointerEvent) {
    if (this.#drag?.kind === "node") {
      if (this.#drag.moved) {
        this.#saveLayout();
      } else {
        // Ein reiner Klick (keine Bewegung) auf eine Rollen-Kachel des
        // gerade bearbeiteten Workflows (s. #renderEditableRoleTile)
        // steuert den Klick-zu-Verbinden-Zustand statt das (für so eine
        // synthetische ID ohnehin wirkungslose) Parameter-Panel zu
        // öffnen.
        const roleName = this.#workflowEditId
          ? workflowEditRoleName(this.#workflowEditId, this.#drag.nodeId)
          : null;
        if (roleName !== null) {
          this.#onWorkflowEditRoleClick(roleName);
        } else {
          this.#openParameterPanel(this.#drag.nodeId);
        }
      }
    } else if (this.#drag?.kind === "connect") {
      this.#finishConnect(ev);
    } else if (this.#drag?.kind === "select") {
      this.#finishSelection(ev);
    } else if (this.#drag?.kind === "pan") {
      if (this.#drag.moved) {
        // Pan-Zustand mitpersistieren (Nutzerfund 2026-07-12): sonst
        // zeigt ein Reload wieder IDENTITY_VIEWPORT, auch wenn die
        // gespeicherten Kachel-Positionen längst außerhalb davon liegen.
        this.#saveLayout();
      } else {
        this.#closePanel();
      }
    }
    this.#drag = null;
  }

  #onWheel(ev: WheelEvent) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.#viewport = zoomAt(this.#viewport, this.#screenPoint(ev), factor);
    this.#applyViewportTransform();
    // Debounced (Wheel-Events feuern viel zu oft für einen Save pro
    // Event) — derselbe Persistenzgrund wie beim Pan-Ende oben.
    clearTimeout(this.#viewportSaveTimer);
    this.#viewportSaveTimer = setTimeout(() => this.#saveLayout(), 500);
  }

  #screenPoint(ev: MouseEvent): Point {
    const rect = this.#svg.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  #updateSelectionRect(start: Point, current: Point) {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);

    if (!this.#selectionRect) {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("fill", "rgba(91,155,213,0.15)");
      rect.setAttribute("stroke", "#5b9bd5");
      rect.setAttribute("stroke-dasharray", "4 4");
      rect.setAttribute("data-role", "selection-rect");
      this.#svg.appendChild(rect);
      this.#selectionRect = rect;
    }
    this.#selectionRect.setAttribute("x", String(x));
    this.#selectionRect.setAttribute("y", String(y));
    this.#selectionRect.setAttribute("width", String(w));
    this.#selectionRect.setAttribute("height", String(h));
  }

  #removeSelectionRect() {
    this.#selectionRect?.remove();
    this.#selectionRect = null;
  }

  #finishSelection(ev: PointerEvent) {
    if (this.#drag?.kind !== "select") return;
    const end = this.#screenPoint(ev);
    const worldStart = screenToWorld(this.#drag.startScreen, this.#viewport);
    const worldEnd = screenToWorld(end, this.#viewport);
    this.#removeSelectionRect();

    const minX = Math.min(worldStart.x, worldEnd.x);
    const maxX = Math.max(worldStart.x, worldEnd.x);
    const minY = Math.min(worldStart.y, worldEnd.y);
    const maxY = Math.max(worldStart.y, worldEnd.y);

    const items = this.#itemsAtScope();
    const selected = [...items.nodeIds, ...items.groupIds].filter((id) => {
      const pos = this.#positions[id];
      if (!pos) return false;
      return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
    });

    this.#selectedIds = new Set(selected);
    this.#render();
  }

  #highlightIncompatiblePorts(fromFormat: string) {
    const inputs = this.#viewportGroup.querySelectorAll('[data-port-side="input"]');
    inputs.forEach((el) => {
      const format = el.getAttribute("data-format") ?? "";
      const compatible = portsCompatible(fromFormat, format);
      const svgEl = el as SVGElement;
      svgEl.style.opacity = compatible ? "1" : "0.25";
      svgEl.style.pointerEvents = compatible ? "auto" : "none";
    });
  }

  #clearPortHighlights() {
    const ports = this.#viewportGroup.querySelectorAll('[data-role="port"]');
    ports.forEach((el) => {
      const svgEl = el as SVGElement;
      svgEl.style.opacity = "1";
      svgEl.style.pointerEvents = "auto";
    });
  }

  #updateRubberBand() {
    if (this.#drag?.kind !== "connect") return;
    const toWorld = screenToWorld(this.#drag.currentScreen, this.#viewport);
    const from = this.#drag.fromWorld;
    const midX = (from.x + toWorld.x) / 2;
    const d = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${toWorld.y}, ${toWorld.x} ${toWorld.y}`;

    if (!this.#rubberBand) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#ffffff");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-dasharray", "4 4");
      path.setAttribute("data-role", "rubber-band");
      // Kapitel 12 Teil 6 (§22.3 Punkt 1, Rollen-Designer): beim Bau des
      // dortigen, analogen Verbindungs-Drags per Live-Test gefunden und
      // hierher zurückübertragen — ohne dies liegt die Linie beim Loslassen
      // direkt über dem Ziel-Port (ihr Endpunkt IST der Mauszeiger), und
      // document.elementFromPoint() in #finishConnect trifft dann die
      // Linie statt den darunterliegenden Port, die Verbindung scheitert
      // lautlos genau am Zielpunkt. pointer-events:none nimmt die rein
      // dekorative Vorschau-Linie aus dem Hit-Test heraus.
      path.style.pointerEvents = "none";
      this.#viewportGroup.appendChild(path);
      this.#rubberBand = path;
    }
    this.#rubberBand.setAttribute("d", d);
  }

  #removeRubberBand() {
    this.#rubberBand?.remove();
    this.#rubberBand = null;
  }

  #finishConnect(ev: PointerEvent) {
    if (this.#drag?.kind !== "connect") return;
    const fromPortId = this.#drag.fromPortId;

    this.#clearPortHighlights();
    this.#removeRubberBand();

    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const portEl = target?.closest('[data-role="port"][data-port-side="input"]');
    if (!portEl) return; // Drop außerhalb eines kompatiblen Ports: Kante wird nicht gezeichnet.

    const toPortId = portEl.getAttribute("data-port-id");
    if (!toPortId) return;

    this.#createEdge(fromPortId, toPortId);
  }

  async #createEdge(fromSender: string, toReceiver: string) {
    try {
      const response = await apiFetch("/api/v1/graph/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromSender, to: toReceiver }),
      });
      if (!response.ok) {
        const text = await response.text();
        this.#showToast(`Verbindung fehlgeschlagen: ${text || response.status}`);
        return;
      }
      await this.#queueFetchAndRender();
    } catch (err) {
      this.#showToast(`Verbindung fehlgeschlagen: ${err}`);
    }
  }

  #deleteSelectedEdge() {
    const edgeId = this.#selectedEdgeId;
    if (!edgeId) return;
    this.#removeEdge(edgeId);
  }

  async #removeEdge(edgeId: string) {
    try {
      const response = await apiFetch(`/api/v1/graph/edges/${encodeURIComponent(edgeId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const text = await response.text();
        this.#showToast(`Trennen fehlgeschlagen: ${text || response.status}`);
        return;
      }
      this.#selectedEdgeId = null;
      await this.#queueFetchAndRender();
    } catch (err) {
      this.#showToast(`Trennen fehlgeschlagen: ${err}`);
    }
  }

  // --- Parameter-Panel (UMSETZUNG.md B6) ---

  // Panel-Breite per Pointer-Drag am linken Rand, persistiert in
  // localStorage (§1.6 — vor einer echten Nutzer-Präferenz-API,
  // Kapitel 1 §1.3c/§1.4 Teil 4, ist das der pragmatische Zwischenstand).
  #onPanelResizeStart(ev: PointerEvent) {
    ev.preventDefault();
    this.#panelResizeStartX = ev.clientX;
    this.#panelResizeStartWidth = this.#panelContainer.getBoundingClientRect().width;
    this.#panelResizeHandle.setPointerCapture(ev.pointerId);
    this.#panelResizeHandle.addEventListener("pointermove", this.#onPanelResizeMove);
    this.#panelResizeHandle.addEventListener("pointerup", this.#onPanelResizeEnd);
    this.#panelResizeHandle.addEventListener("pointercancel", this.#onPanelResizeEnd);
  }

  #onPanelResizeMove = (ev: PointerEvent) => {
    // Panel sitzt rechtsbündig — nach links ziehen (kleineres clientX)
    // muss die Breite VERGRÖSSERN.
    const delta = this.#panelResizeStartX - ev.clientX;
    const width = Math.min(
      PANEL_WIDTH_MAX,
      Math.max(PANEL_WIDTH_MIN, this.#panelResizeStartWidth + delta),
    );
    this.#panelContainer.style.width = `${width}px`;
  };

  #onPanelResizeEnd = (ev: PointerEvent) => {
    this.#panelResizeHandle.removeEventListener("pointermove", this.#onPanelResizeMove);
    this.#panelResizeHandle.removeEventListener("pointerup", this.#onPanelResizeEnd);
    this.#panelResizeHandle.removeEventListener("pointercancel", this.#onPanelResizeEnd);
    this.#panelResizeHandle.releasePointerCapture(ev.pointerId);
    localStorage.setItem(
      PANEL_WIDTH_STORAGE_KEY,
      String(Math.round(this.#panelContainer.getBoundingClientRect().width)),
    );
  };

  async #openParameterPanel(nodeId: string) {
    if (!this.#graph.nodes.some((n) => n.id === nodeId)) return; // Gruppen haben keinen Descriptor
    this.#panelNodeId = nodeId;
    this.#panelContainer.style.display = "block";
    this.#panelContent.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Lädt…";
    this.#panelContent.appendChild(loading);

    const mounted = await mountUIBundle(this.#panelContent, `/api/v1/nodes/${nodeId}`);
    if (mounted) {
      this.#panelContent.insertBefore(this.#panelButtonBar(nodeId), this.#panelContent.firstChild);
      return;
    }

    await this.#renderGenericPanel(nodeId);
  }

  #closePanel() {
    if (this.#panelNodeId === null) return;
    this.#panelNodeId = null;
    this.#panelContainer.style.display = "none";
    this.#panelContent.replaceChildren();
  }

  // Schließen + „Als Operator ansehen" (§1.6, docs/END-GOAL-FEATURES.md,
  // 2026-07-17): dieselbe Konsolen-Route (`ui/shell/shell.ts` KIOSK_ROUTE),
  // die auch ein dedizierter Operator sieht — Admin muss dafür nicht
  // raten/separat navigieren, sondern bekommt sie direkt am Node.
  #panelButtonBar(nodeId: string): HTMLDivElement {
    const bar = document.createElement("div");
    bar.style.cssText = "position:absolute;top:8px;right:8px;display:flex;gap:6px;z-index:22;";

    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    const roleId = node?.instanceId || nodeId; // s. orchestrator/internal/consoles/resolve.go NodeRoleID
    const operatorLink = document.createElement("a");
    operatorLink.textContent = "Als Operator ansehen ↗";
    operatorLink.href = `/console/default/${encodeURIComponent(roleId)}`;
    operatorLink.target = "_blank";
    operatorLink.rel = "noopener";
    operatorLink.style.cssText =
      "font-size:11px;color:var(--omp-text-dim);text-decoration:none;" +
      "border:1px solid var(--omp-border);border-radius:4px;padding:3px 6px;white-space:nowrap;";
    bar.appendChild(operatorLink);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "cursor:pointer;";
    closeBtn.addEventListener("click", () => this.#closePanel());
    bar.appendChild(closeBtn);

    return bar;
  }

  async #renderGenericPanel(nodeId: string) {
    let descriptor: Descriptor;
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/descriptor`);
      if (!res.ok) throw new Error(String(res.status));
      descriptor = await res.json();
    } catch (err) {
      this.#panelContent.replaceChildren();
      this.#panelContent.appendChild(this.#panelButtonBar(nodeId));
      const p = document.createElement("p");
      p.textContent = `Descriptor konnte nicht geladen werden: ${err}`;
      this.#panelContent.appendChild(p);
      return;
    }

    this.#panelContent.replaceChildren();
    this.#panelContent.appendChild(this.#panelButtonBar(nodeId));

    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    const title = document.createElement("h3");
    title.textContent = node?.label ?? nodeId;
    title.style.cssText = "margin:0 0 8px 0;font-size:14px;";
    this.#panelContent.appendChild(title);

    // Rollen-Zielformat (Nutzerwunsch 2026-07-29: "scaler hat immer noch
    // keine Auswahl im Property-Editor für Format") — nur für Node-Typen
    // ohne eigenes UI-Bundle relevant (omp-scaler/omp-source landen hier
    // im generischen Panel; role.Format ist aber ein workflow-weiter
    // Mechanismus, kein scaler-spezifischer, s. formats.go). Setzt
    // NICHT live per PATCH /params (alle Scaler-Parameter sind bewusst
    // readonly, die Zielauflösung ist am MXL-Ausgangs-Flow fest verankert)
    // — startet stattdessen NUR diese eine Rolle neu (Orchestrator-
    // Entscheidung 2026-07-29: kein Live-Rekonfigurations-Risiko wie bei
    // der früheren swap_input_resolution-Baustelle), Rest des Workflows
    // läuft unterbrechungsfrei weiter.
    const roleInfo = await this.#findRunningRoleForNode(nodeId);
    if (roleInfo) {
      this.#panelContent.appendChild(this.#buildRoleFormatSection(roleInfo));
    }

    // Nutzerwunsch 2026-08-06 ("Shuffle Presets und Output Groups
    // dynamisch definieren, für einfachere künftige Anpassungen"): statt
    // eines neuen, generischen Editor-Mechanismus für JEDEN Node-Typ
    // (Overkill für diesen einen Fall) hier node-typ-spezifisch, erkannt
    // über das Vorhandensein der beiden dafür charakteristischen
    // readonly-Params (nicht über einen Node-"type"-Vergleich —
    // `GraphNode` kennt den Katalog-Typ hier gar nicht, s. Moduldoku
    // oben zur NMOS-Registry-Herkunft der Graph-Daten; robuster
    // Nebeneffekt: jeder künftige Node-Typ mit denselben zwei Params
    // bekäme denselben Editor automatisch).
    const hasMxfPlayerSettings =
      descriptor.parameters.some((p) => p.name === "programGroups") &&
      descriptor.parameters.some((p) => p.name === "shufflePresets");
    if (hasMxfPlayerSettings) {
      this.#panelContent.appendChild(this.#buildMxfPlayerSettingsSection());
    }

    for (const param of descriptor.parameters) {
      const value = await this.#fetchParamValue(nodeId, param.name);
      this.#panelContent.appendChild(this.#buildParamRow(nodeId, param, value));
    }

    if (descriptor.methods.length > 0) {
      const hr = document.createElement("hr");
      hr.style.borderColor = "var(--omp-border)";
      this.#panelContent.appendChild(hr);
    }
    for (const method of descriptor.methods) {
      const btn = document.createElement("button");
      btn.textContent = method.name;
      btn.style.cssText = "display:block;margin:6px 0;cursor:pointer;";
      btn.addEventListener("click", () => this.#invokeMethod(nodeId, method));
      this.#panelContent.appendChild(btn);
    }
  }

  // Löst nodeId auf ein (workflowId, roleName, aktuelles role.Format) auf
  // — nur für Rollen eines aktuell GESTARTETEN Workflows (RestartRole
  // verlangt genau das, s. dortige Doku); sonst `null`, die Format-
  // Sektion bleibt dann einfach weg (z. B. Node ganz ohne Workflow-
  // Zugehörigkeit, oder Workflow gerade nicht "started"). Kein neuer
  // Backend-Endpunkt nötig: GET /api/v1/workflows liefert `runtime`
  // bereits vollständig, gleiches Musters wie omp-audio-mixers
  // `loadFollowTargets` (ui/bundle.js).
  async #findRunningRoleForNode(
    nodeId: string,
  ): Promise<{ workflowId: string; roleName: string; format: string } | null> {
    try {
      const res = await apiFetch("/api/v1/workflows");
      if (!res.ok) return null;
      const list = (await res.json()) as Array<{
        id: string;
        status: string;
        definition: { roles: Array<{ name: string; format?: string }> };
        runtime?: Record<string, { nodeId?: string }>;
      }>;
      for (const wf of list) {
        if (wf.status !== "started") continue;
        for (const [roleName, rt] of Object.entries(wf.runtime ?? {})) {
          if (rt.nodeId !== nodeId) continue;
          const role = wf.definition.roles.find((r) => r.name === roleName);
          return { workflowId: wf.id, roleName, format: role?.format ?? "" };
        }
      }
    } catch {
      // Sektion bleibt weg — kein harter Fehler fürs übrige Panel.
    }
    return null;
  }

  #buildRoleFormatSection(info: { workflowId: string; roleName: string; format: string }): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-role", "role-format-row");
    wrapper.style.cssText =
      "margin:8px 0 14px 0;padding:8px;border:1px solid var(--omp-border,#444);border-radius:4px;";

    const label = document.createElement("label");
    label.textContent = "Rollen-Zielformat";
    label.style.cssText = "display:block;margin-bottom:var(--omp-space-1);color:var(--omp-text-dim);";
    wrapper.appendChild(label);

    const select = document.createElement("select");
    select.style.cssText = "width:100%;";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Node-Standard";
    select.appendChild(defaultOpt);
    for (const name of ROLE_FORMATS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === info.format) opt.selected = true;
      select.appendChild(opt);
    }
    wrapper.appendChild(select);

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Übernehmen (Node neu starten)";
    applyBtn.style.cssText = "display:block;margin-top:6px;cursor:pointer;";
    applyBtn.addEventListener("click", async () => {
      const confirmed = await confirmDialog(
        `Rolle "${info.roleName}" mit neuem Format neu starten? Der Node ist dabei kurz nicht erreichbar, der Rest des Workflows läuft weiter.`,
      );
      if (!confirmed) return;
      applyBtn.disabled = true;
      try {
        const res = await apiFetch(
          `/api/v1/workflows/${info.workflowId}/roles/${encodeURIComponent(info.roleName)}/restart`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ format: select.value }),
          },
        );
        if (!res.ok) {
          this.#showToast(`Neustart fehlgeschlagen: ${await res.text()}`);
        } else {
          this.#showToast(`Rolle "${info.roleName}" wird mit neuem Format neu gestartet …`);
        }
      } catch (err) {
        this.#showToast(`Neustart fehlgeschlagen: ${err}`);
      } finally {
        applyBtn.disabled = false;
      }
    });
    wrapper.appendChild(applyBtn);

    return wrapper;
  }

  // Programmgruppen/Shuffle-Presets für omp-mxf-player (Nutzerwunsch
  // 2026-08-06) — Node-Typ-weite, nicht Instanz-weite Einstellungen
  // (orchestrator/internal/httpapi/node_settings_handlers.go), deshalb
  // ohne nodeId-Bezug in der API (anders als #buildParamRow). Kein
  // client-seitiges Admin-Gating (kein bestehendes Muster dafür in
  // dieser Datei, s. Katalog-Palette oben) — GET ist für jeden
  // angemeldeten Nutzer erlaubt, PUT lehnt der Server für Nicht-Admins
  // mit 403 ab, was #showToast unten genauso wie jeden anderen
  // Speicherfehler anzeigt.
  #buildMxfPlayerSettingsSection(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-role", "mxf-player-settings-section");
    wrapper.style.cssText =
      "margin:8px 0 14px 0;padding:8px;border:1px solid var(--omp-border,#444);border-radius:4px;";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "Programmgruppen/Presets bearbeiten";
    toggleBtn.style.cssText = "cursor:pointer;";

    const body = document.createElement("div");
    body.style.cssText = "display:none;margin-top:10px;";
    let loaded = false;

    toggleBtn.addEventListener("click", async () => {
      const isOpen = body.style.display !== "none";
      if (isOpen) {
        body.style.display = "none";
        return;
      }
      body.style.display = "block";
      if (!loaded) {
        loaded = true;
        await this.#loadMxfPlayerSettingsEditor(body);
      }
    });

    wrapper.append(toggleBtn, body);
    return wrapper;
  }

  async #loadMxfPlayerSettingsEditor(container: HTMLElement): Promise<void> {
    container.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Lädt…";
    container.appendChild(loading);

    let settings: MxfPlayerSettings;
    try {
      const res = await apiFetch("/api/v1/node-types/omp-mxf-player/settings");
      if (!res.ok) throw new Error(String(res.status));
      settings = await res.json();
    } catch (err) {
      container.replaceChildren();
      const p = document.createElement("p");
      p.textContent = `Einstellungen konnten nicht geladen werden: ${err}`;
      container.appendChild(p);
      return;
    }

    this.#renderMxfPlayerSettingsEditor(container, settings);
  }

  // `state` ist eine lokale Arbeitskopie — Bearbeitung sammelt sich nur
  // im Browser, erst der "Speichern"-Klick schreibt per PUT (Ganz-
  // Dokument-Ersatz, kein PATCH-per-Feldänderung,
  // feedback_editors_need_explicit_save).
  #renderMxfPlayerSettingsEditor(container: HTMLElement, state: MxfPlayerSettings): void {
    container.replaceChildren();
    const rerender = () => this.#renderMxfPlayerSettingsEditor(container, state);

    const hint = document.createElement("p");
    hint.textContent =
      "Programmgruppen-Änderungen wirken erst nach einem Neustart der Instanz (neue NMOS-Sender werden nur beim Start registriert). Preset-Änderungen wirken sofort für neu gecute Items.";
    hint.style.cssText = "font-size:11px;color:var(--omp-text-dim,#888);margin:0 0 10px 0;";
    container.appendChild(hint);

    const groupsHeading = document.createElement("h4");
    groupsHeading.textContent = "Programmgruppen";
    groupsHeading.style.cssText = "margin:0 0 4px 0;font-size:12px;";
    container.appendChild(groupsHeading);
    container.appendChild(this.#buildMxfGroupsTable(state, rerender));

    const presetsHeading = document.createElement("h4");
    presetsHeading.textContent = "Shuffle-Presets";
    presetsHeading.style.cssText = "margin:14px 0 4px 0;font-size:12px;";
    container.appendChild(presetsHeading);
    container.appendChild(this.#buildMxfPresetsTable(state, rerender));

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Speichern";
    saveBtn.className = "omp-btn-primary";
    saveBtn.style.cssText = "display:block;margin-top:var(--omp-space-3);";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const res = await apiFetch("/api/v1/node-types/omp-mxf-player/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
        });
        if (!res.ok) {
          this.#showToast(`Speichern fehlgeschlagen: ${await res.text()}`);
        } else {
          this.#showToast("Gespeichert — Programmgruppen wirken erst nach Neustart der Instanz.");
        }
      } catch (err) {
        this.#showToast(`Speichern fehlgeschlagen: ${err}`);
      } finally {
        saveBtn.disabled = false;
      }
    });
    container.appendChild(saveBtn);
  }

  #buildMxfGroupsTable(state: MxfPlayerSettings, rerender: () => void): HTMLElement {
    const table = document.createElement("div");
    table.setAttribute("data-role", "mxf-groups-table");

    for (const group of state.groups) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:4px;";

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.value = group.id;
      idInput.placeholder = "id";
      idInput.style.cssText = "width:70px;";
      idInput.addEventListener("change", () => {
        group.id = idInput.value;
      });

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = group.label;
      labelInput.placeholder = "Label";
      labelInput.style.cssText = "flex:1;";
      labelInput.addEventListener("change", () => {
        group.label = labelInput.value;
      });

      const channelsInput = document.createElement("input");
      channelsInput.type = "number";
      channelsInput.min = "1";
      channelsInput.max = "64";
      channelsInput.value = String(group.channels);
      channelsInput.style.cssText = "width:56px;";
      channelsInput.addEventListener("change", () => {
        group.channels = Number(channelsInput.value) || 1;
      });

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.className = "omp-btn-danger";
      removeBtn.addEventListener("click", () => {
        state.groups = state.groups.filter((g) => g !== group);
        rerender();
      });

      row.append(idInput, labelInput, channelsInput, removeBtn);
      table.appendChild(row);
    }

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Gruppe";
    addBtn.style.cssText = "cursor:pointer;";
    addBtn.addEventListener("click", () => {
      state.groups.push({ id: "", label: "", channels: 2 });
      rerender();
    });
    table.appendChild(addBtn);

    return table;
  }

  #buildMxfPresetsTable(state: MxfPlayerSettings, rerender: () => void): HTMLElement {
    const table = document.createElement("div");
    table.setAttribute("data-role", "mxf-presets-table");

    for (const preset of state.presets) {
      const presetBox = document.createElement("div");
      presetBox.style.cssText =
        "border:1px solid var(--omp-border,#444);border-radius:4px;padding:6px;margin-bottom:6px;";

      const headerRow = document.createElement("div");
      headerRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:4px;";

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.value = preset.id;
      idInput.placeholder = "id";
      idInput.style.cssText = "width:110px;";
      idInput.addEventListener("change", () => {
        preset.id = idInput.value;
      });

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = preset.label;
      labelInput.placeholder = "Label";
      labelInput.style.cssText = "flex:1;";
      labelInput.addEventListener("change", () => {
        preset.label = labelInput.value;
      });

      const removePresetBtn = document.createElement("button");
      removePresetBtn.textContent = "✕ Preset";
      removePresetBtn.className = "omp-btn-danger";
      removePresetBtn.addEventListener("click", () => {
        state.presets = state.presets.filter((p) => p !== preset);
        rerender();
      });

      headerRow.append(idInput, labelInput, removePresetBtn);
      presetBox.appendChild(headerRow);

      for (const route of preset.routes) {
        const routeRow = document.createElement("div");
        routeRow.style.cssText = "display:flex;gap:4px;align-items:center;margin:2px 0 2px 12px;";

        const trackInput = document.createElement("input");
        trackInput.type = "number";
        trackInput.min = "1";
        trackInput.title = "Quell-Tonspur (1-basiert)";
        trackInput.value = String(route.srcTrack);
        trackInput.style.cssText = "width:48px;";
        trackInput.addEventListener("change", () => {
          route.srcTrack = Number(trackInput.value) || 1;
        });

        const groupSelect = document.createElement("select");
        for (const g of state.groups) {
          const opt = document.createElement("option");
          opt.value = g.id;
          opt.textContent = g.id || "(ohne id)";
          if (g.id === route.group) opt.selected = true;
          groupSelect.appendChild(opt);
        }
        groupSelect.addEventListener("change", () => {
          route.group = groupSelect.value;
        });

        const channelInput = document.createElement("input");
        channelInput.type = "number";
        channelInput.min = "0";
        channelInput.title = "Ziel-Kanal in der Gruppe (0-basiert)";
        channelInput.value = String(route.groupChannel);
        channelInput.style.cssText = "width:48px;";
        channelInput.addEventListener("change", () => {
          route.groupChannel = Number(channelInput.value) || 0;
        });

        const removeRouteBtn = document.createElement("button");
        removeRouteBtn.textContent = "✕";
        removeRouteBtn.className = "omp-btn-danger";
        removeRouteBtn.addEventListener("click", () => {
          preset.routes = preset.routes.filter((r) => r !== route);
          rerender();
        });

        routeRow.append(trackInput, groupSelect, channelInput, removeRouteBtn);
        presetBox.appendChild(routeRow);
      }

      const addRouteBtn = document.createElement("button");
      addRouteBtn.textContent = "+ Route";
      addRouteBtn.style.cssText = "cursor:pointer;margin-left:12px;";
      addRouteBtn.addEventListener("click", () => {
        preset.routes.push({ srcTrack: 1, group: state.groups[0]?.id ?? "", groupChannel: 0 });
        rerender();
      });
      presetBox.appendChild(addRouteBtn);

      table.appendChild(presetBox);
    }

    const addPresetBtn = document.createElement("button");
    addPresetBtn.textContent = "+ Preset";
    addPresetBtn.style.cssText = "cursor:pointer;";
    addPresetBtn.addEventListener("click", () => {
      state.presets.push({ id: "", label: "", routes: [] });
      rerender();
    });
    table.appendChild(addPresetBtn);

    return table;
  }

  async #fetchParamValue(nodeId: string, name: string): Promise<unknown> {
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/params/${name}`);
      if (res.ok) return (await res.json()).value;
    } catch {
      // Steuerelement zeigt dann einen Platzhalter.
    }
    return null;
  }

  #buildParamRow(nodeId: string, param: ParamSpec, value: unknown): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-role", "param-row");
    wrapper.setAttribute("data-param-name", param.name);
    wrapper.style.cssText = "margin:8px 0;";

    const label = document.createElement("label");
    label.textContent = param.name + (param.unit ? ` (${param.unit})` : "");
    label.style.cssText = "display:block;margin-bottom:2px;color:var(--omp-text-dim);";
    wrapper.appendChild(label);

    const control = this.#buildControlElement(controlKindFor(param), param, value, (newValue) => {
      this.#patchParam(nodeId, param, newValue, wrapper);
    });
    wrapper.appendChild(control);
    return wrapper;
  }

  #buildControlElement(
    kind: ControlKind,
    param: ParamSpec,
    value: unknown,
    onCommit: (newValue: unknown) => void,
  ): HTMLElement {
    switch (kind) {
      case "slider": {
        const container = document.createElement("div");
        container.style.cssText = "display:flex;gap:6px;align-items:center;";

        const range = numberRange(param);
        const slider = document.createElement("input");
        slider.type = "range";
        if (range) {
          slider.min = String(range.min);
          slider.max = String(range.max);
        }
        slider.value = String(value ?? 0);
        slider.style.flex = "1";

        const numberField = document.createElement("input");
        numberField.type = "number";
        numberField.value = String(value ?? 0);
        numberField.style.width = "56px";

        const commit = (raw: string) => {
          slider.value = raw;
          numberField.value = raw;
          onCommit(Number(raw));
        };
        slider.addEventListener("input", () => commit(slider.value));
        numberField.addEventListener("change", () => commit(numberField.value));

        container.append(slider, numberField);
        return container;
      }
      case "toggle": {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = value === true;
        checkbox.addEventListener("change", () => onCommit(checkbox.checked));
        return checkbox;
      }
      case "select": {
        const select = document.createElement("select");
        for (const option of enumValues(param)) {
          const opt = document.createElement("option");
          opt.value = option;
          opt.textContent = option;
          if (option === value) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener("change", () => onCommit(select.value));
        return select;
      }
      case "text": {
        const input = document.createElement("input");
        input.type = "text";
        input.value = String(value ?? "");
        input.addEventListener("change", () => onCommit(input.value));
        return input;
      }
      case "readonly":
      default: {
        // Manche readonly-String-Params tragen bereits geparstes JSON
        // (Arrays/Objekte, z. B. omp-player/omp-audio-mixer/omp-mxf-player
        // items/mediaLibrary/programGroups/shufflePresets) — `String(value)`
        // ergäbe "[object Object]" statt einer lesbaren Darstellung.
        if (value !== null && typeof value === "object") {
          const pre = document.createElement("pre");
          pre.style.cssText =
            "margin:0;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px;";
          pre.textContent = JSON.stringify(value, null, 2);
          return pre;
        }
        const span = document.createElement("span");
        span.textContent = String(value ?? "–");
        return span;
      }
    }
  }

  // Optimistisches UI: der Control-Wert wurde bereits geändert, bevor
  // dieser PATCH-Aufruf startet. Schlägt er fehl, wird der tatsächliche
  // Server-Wert neu abgefragt und die Zeile damit neu aufgebaut — der
  // Server-Wert ist die Wahrheit (UMSETZUNG.md B6), nicht der zuletzt
  // versuchte Client-Wert.
  async #patchParam(nodeId: string, param: ParamSpec, newValue: unknown, wrapper: HTMLElement) {
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/params/${param.name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: newValue }),
      });
      if (res.ok) return;
      const text = await res.text();
      this.#showToast(`Parameter „${param.name}" fehlgeschlagen: ${text || res.status}`);
    } catch (err) {
      this.#showToast(`Parameter „${param.name}" fehlgeschlagen: ${err}`);
    }

    const serverValue = await this.#fetchParamValue(nodeId, param.name);
    wrapper.replaceWith(this.#buildParamRow(nodeId, param, serverValue));
  }

  async #invokeMethod(nodeId: string, method: MethodSpec) {
    let body: Record<string, unknown> | undefined;
    if (method.args.length > 0) {
      body = {};
      for (const arg of method.args) {
        const raw = prompt(`Wert für „${arg.name}" (${arg.type}):`);
        if (raw === null) return; // Abbruch
        body[arg.name] = arg.type === "number" ? Number(raw) : arg.type === "boolean" ? raw === "true" : raw;
      }
    }

    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/methods/${method.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Methode „${method.name}" fehlgeschlagen: ${text || res.status}`);
        return;
      }
      await this.#renderGenericPanel(nodeId);
    } catch (err) {
      this.#showToast(`Methode „${method.name}" fehlgeschlagen: ${err}`);
    }
  }

  // --- Snapshots/Szenen (UMSETZUNG.md B7) ---

  async #renderSnapshotBar() {
    this.#snapshotBar.replaceChildren();

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Snapshot speichern";
    saveBtn.addEventListener("click", () => this.#saveSnapshot());
    this.#snapshotBar.appendChild(saveBtn);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;gap:6px;overflow-x:auto;min-width:0;flex:1;";
    this.#snapshotBar.appendChild(list);

    try {
      const res = await apiFetch("/api/v1/snapshots");
      if (res.ok) {
        const snaps = (await res.json()) as SnapshotSummary[];
        // Node-Presets (§4.6 Punkt 4) gehören ins UI-Bundle ihres Nodes,
        // nicht in diese workflow-weite Szenen-Leiste.
        for (const snap of snaps.filter((s) => !s.nodeIds || s.nodeIds.length === 0)) {
          const chip = document.createElement("button");
          chip.textContent = snap.label || snap.id.slice(0, 8);
          chip.title = "Szene anwenden";
          chip.style.cssText = "cursor:pointer;white-space:nowrap;flex-shrink:0;";
          chip.addEventListener("click", () => this.#applySnapshot(snap.id));
          list.appendChild(chip);
        }
        list.scrollLeft = list.scrollWidth;
      }
    } catch {
      // Liste bleibt leer, wenn der Server (noch) nicht erreichbar ist.
    }
  }

  async #saveSnapshot() {
    const label = prompt("Name der Szene:", "Neue Szene");
    if (!label) return;

    try {
      const res = await apiFetch("/api/v1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        this.#showToast(`Snapshot speichern fehlgeschlagen: ${res.status}`);
        return;
      }
      await this.#renderSnapshotBar();
    } catch (err) {
      this.#showToast(`Snapshot speichern fehlgeschlagen: ${err}`);
    }
  }

  async #applySnapshot(id: string) {
    try {
      const res = await apiFetch(`/api/v1/snapshots/${id}/apply`, { method: "POST" });
      if (!res.ok) {
        this.#showToast(`Snapshot anwenden fehlgeschlagen: ${res.status}`);
        return;
      }
      const result = (await res.json()) as ApplyResult;
      if (result.errors.length > 0) {
        this.#showToast(`Snapshot mit ${result.errors.length} Fehler(n) angewendet`);
      }
      await this.#queueFetchAndRender();
      if (this.#panelNodeId !== null) {
        await this.#openParameterPanel(this.#panelNodeId);
      }
    } catch (err) {
      this.#showToast(`Snapshot anwenden fehlgeschlagen: ${err}`);
    }
  }

  // --- Instanz-Launcher (UMSETZUNG.md C8) ---

  async #renderPalette() {
    try {
      const [catalogRes, instancesRes, hostsRes] = await Promise.all([
        apiFetch("/api/v1/catalog"),
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
      ]);
      if (!catalogRes.ok) {
        this.#paletteCatalog = null;
        this.#renderPaletteList();
        return;
      }
      this.#paletteCatalog = (await catalogRes.json()) as CatalogEntry[];
      this.#paletteInstances = instancesRes.ok ? ((await instancesRes.json()) as LauncherInstance[]) : [];
      // Remote-Hosts (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 2) sind
      // optional — kein Fehler, wenn der Endpunkt (noch) nichts liefert
      // oder der Nutzer keine Admin-Sicht hat (403 möglich, D3 Teil 2).
      this.#paletteHosts = hostsRes.ok ? await hostsRes.json() : [];
      this.#updateHostViewAutoDefault();
    } catch {
      this.#paletteCatalog = null;
    }
    this.#renderPaletteList();
    // Kapitel 13: neue/aktualisierte Host-Metriken bzw. ein per
    // Auto-Default umgeschalteter Modus wirken sich auf den Zonen-Kopf
    // im Canvas aus, nicht nur auf die Palette-Liste selbst.
    if (this.#hostViewEnabled) this.#render();
  }

  // Kapitel 13: leichtgewichtiges Gegenstück zu #renderPalette() für
  // die 5s-CPU/RAM-Ticks (omp.host.<id>.metrics) — nur der Hosts-Abruf,
  // ohne Katalog/Instanzen erneut zu holen und ohne die Palette-Liste
  // (inkl. Fokus-Erhalt-Logik) neu aufzubauen, die sich durch reine
  // Metrik-Änderungen nie ändert.
  async #refreshHostMetrics() {
    try {
      const res = await apiFetch("/api/v1/hosts");
      if (!res.ok) return;
      this.#paletteHosts = (await res.json()) as HostEntry[];
    } catch {
      return;
    }
    this.#updateHostViewAutoDefault();
    if (this.#hostViewEnabled) this.#render();
  }

  // Reiner DOM-Aufbau aus den zuletzt per #renderPalette() geholten Daten
  // (kein Netzwerk-Zugriff) — wird sowohl nach einem frischen Fetch als
  // auch bei jedem Tastendruck im Suchfeld aufgerufen. Erhält Fokus +
  // Cursor-Position des Suchfelds über den Rebuild hinweg (gleiche
  // Fokus-Erhalt-Linie wie Nachtrag 72, hier seltener nötig, da
  // #renderPalette() nur bei Instanz-Crash/-Neustart/-Start/-Stop
  // erneut aufgerufen wird, nicht auf einem festen Poll-Timer).
  #renderPaletteList() {
    const searchWasFocused = this.#palette.querySelector<HTMLInputElement>('[data-role="palette-search"]') ===
      document.activeElement;
    const searchSelectionStart = searchWasFocused
      ? (document.activeElement as HTMLInputElement).selectionStart
      : null;

    this.#palette.replaceChildren();

    const heading = document.createElement("div");
    heading.textContent = "Node-Katalog";
    heading.className = "omp-h1";
    heading.style.cssText = "font-size:var(--omp-font-size-md);margin-bottom:var(--omp-space-2);";
    this.#palette.appendChild(heading);

    const catalog = this.#paletteCatalog;
    if (catalog === null) return;

    if (catalog.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "Katalog leer.";
      empty.className = "omp-empty";
      this.#palette.appendChild(empty);
      return;
    }

    const searchInput = document.createElement("input");
    searchInput.setAttribute("data-role", "palette-search");
    searchInput.type = "search";
    searchInput.placeholder = "Suchen…";
    searchInput.value = this.#paletteFilterQuery;
    searchInput.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:var(--omp-space-2);";
    searchInput.addEventListener("input", () => {
      this.#paletteFilterQuery = searchInput.value;
      this.#renderPaletteList();
    });
    this.#palette.appendChild(searchInput);
    if (searchWasFocused) {
      searchInput.focus();
      if (searchSelectionStart !== null) searchInput.setSelectionRange(searchSelectionStart, searchSelectionStart);
    }

    const query = this.#paletteFilterQuery.trim().toLowerCase();
    const filtered = (query === ""
      ? catalog
      : catalog.filter((entry) => entry.label.toLowerCase().includes(query) || entry.type.toLowerCase().includes(query)))
      // Nutzerwunsch 2026-07-28: alphabetisch statt in deploy/catalog.json-
      // Dateireihenfolge (historisch gewachsen, kein bewusstes Ordnungs-
      // prinzip) — localeCompare für Umlaute/Groß-Kleinschreibung korrekt.
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));

    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "Keine Treffer.";
      empty.className = "omp-empty";
      this.#palette.appendChild(empty);
      return;
    }

    const instances = this.#paletteInstances;
    const hosts = this.#paletteHosts;
    for (const entry of filtered) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";

      const btn = document.createElement("button");
      // version (§17 Teil 5): mehrere importierte Versionen desselben
      // Typs erscheinen als getrennte Katalog-Einträge/Karten — ohne
      // die Version im Label wären zwei Karten mit identischem
      // "+ Label" ununterscheidbar.
      btn.textContent = entry.version ? `+ ${entry.label} (${entry.version})` : `+ ${entry.label}`;
      // Beschreibung/Ressourcen-Schätzung stehen sichtbar als
      // Untertitel (s. u.), zusätzlich hier im Tooltip für den
      // schnellen Hover-Fall.
      const tooltipParts = [`${entry.label} starten`, entry.description, entry.expectedResources]
        .filter((p): p is string => !!p);
      btn.title = tooltipParts.join(" — ");
      btn.style.cssText = "flex:1;text-align:left;justify-content:flex-start;";

      // Host-Auswahl nur anzeigen, wenn es überhaupt entfernte Hosts
      // gibt — im (heute üblichen) Fall ohne Host-Agents bleibt die
      // Palette optisch unverändert gegenüber vor D6 Teil 2.
      let hostSelect: HTMLSelectElement | null = null;
      if (hosts.length > 0) {
        hostSelect = document.createElement("select");
        hostSelect.title = "Zielhost";
        hostSelect.style.cssText = "font-size:10px;max-width:90px;padding:2px 4px;";
        const localOpt = document.createElement("option");
        localOpt.value = "";
        localOpt.textContent = "(lokal)";
        hostSelect.appendChild(localOpt);
        for (const host of hosts) {
          const opt = document.createElement("option");
          opt.value = host.id;
          opt.textContent = host.label;
          hostSelect.appendChild(opt);
        }
        row.appendChild(hostSelect);
      }

      // Bug 2: im Bearbeiten-Modus eines GESTOPPTEN/PAUSIERTEN Workflows
      // fügt der Katalog-Button eine Rolle zur Definition hinzu statt
      // eine Instanz zu starten — der Host-Selector greift hier nicht
      // (Rollen bekommen ihren Host erst beim nächsten Workflow-Start
      // über den Launcher, s. orchestrator/internal/workflows/
      // service.go runStart). Bei einem LAUFENDEN Workflow (s.
      // #renderRunningWorkflowScope) ist es dagegen ein ganz normaler
      // Instanz-Start — #startInstance() selbst erkennt den offenen
      // Live-Scope und ordnet die neue Instanz dort zu.
      btn.addEventListener("click", () => {
        if (this.#workflowEditId) {
          const wf = this.#workflows.find((w) => w.id === this.#workflowEditId);
          if (wf && this.#isIdleWorkflow(wf)) {
            this.#addWorkflowRole(entry.type);
            return;
          }
        }
        this.#startInstance(entry.type, entry.version, hostSelect?.value || undefined);
      });
      row.appendChild(btn);
      this.#palette.appendChild(row);

      // §17 Teil 1 (docs/END-GOAL-FEATURES.md, 2026-07-17): sichtbare
      // Kurzbeschreibung + grobe Ressourcen-Schätzung statt nur eines
      // Labels — vermutete Ressourcen sind bewusst als Freitext-Hinweis
      // gekennzeichnet ("~"), keine Messung (bewusst weiterhin
      // Freitext statt der echten Kapitel-14-Teil-3-Messung unten:
      // dieser Hinweis kommt vom Katalog-Eintrag selbst, unabhängig
      // davon, ob der Node-Typ je gemessen wurde).
      if (entry.description || entry.expectedResources) {
        const meta = document.createElement("div");
        meta.style.cssText = "margin:-2px 0 6px 2px;color:var(--omp-text-dim);font-size:9px;line-height:1.3;";
        if (entry.description) {
          const desc = document.createElement("div");
          desc.textContent = entry.description;
          meta.appendChild(desc);
        }
        if (entry.expectedResources) {
          const res = document.createElement("div");
          res.textContent = `~ ${entry.expectedResources}`;
          res.style.cssText = "font-style:italic;";
          meta.appendChild(res);
        }
        this.#palette.appendChild(meta);
      }

      // Kapitel 14 Teil 3 (docs/END-GOAL-FEATURES.md §14.3d):
      // profilbasierte Start-Vorprüfung/Warnung — echte gemessene
      // Werte statt des Freitext-Hinweises oben, sobald der Node-Typ
      // mindestens einmal gelaufen ist. Aktualisiert sich beim
      // Wechsel der Host-Auswahl neu (anderer Host = andere freie
      // Kapazität).
      const profileTag = document.createElement("div");
      profileTag.setAttribute("data-role", "profile-tag");
      profileTag.style.cssText = "margin:-2px 0 6px 2px;font-size:9px;line-height:1.3;";
      this.#palette.appendChild(profileTag);
      void this.#applyProfileTag(profileTag, entry.type, hostSelect?.value || "");
      hostSelect?.addEventListener("change", () => {
        void this.#applyProfileTag(profileTag, entry.type, hostSelect.value || "");
      });

      // §17 Teil 5: nach (Type, Version) filtern, nicht nur Type —
      // sonst würde jede laufende Instanz eines Typs unter JEDER
      // seiner Versions-Karten doppelt auftauchen, sobald mehrere
      // Versionen desselben Typs importiert sind.
      for (const inst of instances.filter((i) => i.type === entry.type && (i.version || "") === (entry.version || ""))) {
        this.#palette.appendChild(this.#renderInstanceRow(inst, hosts));
      }
    }
  }

  // Kapitel 14 Teil 3 (docs/END-GOAL-FEATURES.md §14.3d): holt das
  // Verbrauchsprofil für (nodeType, hostId) und befüllt tag damit — "~"
  // Freitext-Vorahnung (oben) wird hier durch echte Zahlen ergänzt,
  // sobald mindestens ein Sample existiert. known=false zeigt ehrlich
  // "Bedarf unbekannt (erster Start dieses Typs)", nie einen stillen
  // Fehlschlag oder ein erratenes Ergebnis.
  async #applyProfileTag(tag: HTMLDivElement, nodeType: string, hostId: string) {
    tag.textContent = "";
    try {
      const res = await apiFetch(`/api/v1/profiles?nodeType=${encodeURIComponent(nodeType)}&hostId=${encodeURIComponent(hostId)}`);
      if (!res.ok) return;
      const profile = (await res.json()) as ProfileResponse;
      if (!profile.known) {
        tag.textContent = "Bedarf unbekannt (erster Start dieses Typs)";
        tag.style.color = "var(--omp-text-dim)";
        return;
      }

      const cpu = `${(profile.cpuAvg ?? 0).toFixed(0)}–${(profile.cpuMax ?? 0).toFixed(0)}% CPU`;
      const rss = `${((profile.rssAvg ?? 0) / 1024 / 1024).toFixed(0)} MB RAM`;
      const fallbackNote = profile.fallback ? " (Typ-Schätzung, kein Wert für diesen Host)" : "";

      const dotColor: Record<ProfileResponse["status"], string> = {
        ok: "#4caf50",
        knapp: "#f0ad4e",
        ueberbucht: "#c0392b",
        lokal: "#888",
        unbekannt: "#888",
      };
      const dot = document.createElement("span");
      dot.textContent = "●";
      dot.style.cssText = `color:${dotColor[profile.status]};margin-right:3px;`;
      tag.appendChild(dot);

      const text = document.createElement("span");
      text.style.cssText = "color:var(--omp-text-dim);";
      let label = `typisch ${cpu} · ${rss}${fallbackNote}`;
      if (profile.status === "ok" || profile.status === "knapp" || profile.status === "ueberbucht") {
        const free = 100 - (profile.hostCpuPercent ?? 0);
        label += ` — frei: ${free.toFixed(0)}% CPU`;
      }
      text.textContent = label;
      tag.appendChild(text);
    } catch {
      // Ampel bleibt leer, wenn der Server (noch) nicht erreichbar ist —
      // gleiche Degradations-Linie wie #renderPalette selbst.
    }
  }

  // Zeigt eine laufende oder abgestürzte Instanz unter ihrem Katalog-
  // Eintrag — Nutzerfund "crash müssen angezeigt werden": eine per MXL-
  // Init-Fehler abgestürzte Instanz hat oft nie eine NMOS-Registrierung
  // (also nie eine Kachel im Graph) bekommen, verschwand also bis hierhin
  // komplett spurlos. Bleibt sichtbar (rot markiert, mit Fehlertext), bis
  // sie per "Entfernen" weggeklickt oder neu gestartet wird.
  #renderInstanceRow(inst: LauncherInstance, hosts: HostEntry[] = []): HTMLDivElement {
    const row = document.createElement("div");
    row.setAttribute("data-role", "instance-row");
    row.setAttribute("data-instance-id", inst.id);
    row.style.cssText =
      `margin:0 0 6px 4px;padding:3px 5px;border-radius:3px;font-size:10px;` +
      `border-left:3px solid ${inst.crashed ? "#c0392b" : "#4caf50"};` +
      `background:${inst.crashed ? "rgba(192,57,43,0.15)" : "rgba(255,255,255,0.04)"};`;

    const label = document.createElement("div");
    label.textContent = inst.label;
    row.appendChild(label);

    // K7-Teil-1: ein Restart-Zähler > 0 ist auch dann sichtbar, wenn die
    // Instanz gerade läuft — eine Instanz, die alle paar Sekunden neu
    // startet, ist ein eigener Alarm-würdiger Zustand ("flatternd"), kein
    // "ist ja wieder online" (docs/END-GOAL-FEATURES.md §7.2, PIPELINE-
    // CONTROLLER-Vorbild `supervisor.js:412`).
    if (inst.restartCount) {
      const restartTag = document.createElement("div");
      restartTag.textContent = `↻ ${inst.restartCount}× automatisch neu gestartet`;
      restartTag.style.cssText = "color:var(--omp-cue);font-size:9px;margin-top:1px;";
      row.appendChild(restartTag);
    }

    if (inst.hostId) {
      const hostLabel = hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId;
      const hostTag = document.createElement("div");
      hostTag.textContent = `Host: ${hostLabel}`;
      hostTag.style.cssText = "color:var(--omp-text-dim);font-size:9px;";
      row.appendChild(hostTag);
    }

    // Kapitel 14 Teil 2: nur anzeigen, wenn bereits ein Sample vorliegt
    // (cpuPercent undefined heißt "noch nicht gemessen", nicht "0%").
    if (inst.cpuPercent !== undefined) {
      const resourceTag = document.createElement("div");
      const rss = inst.rssBytes !== undefined ? `${(inst.rssBytes / 1024 / 1024).toFixed(0)} MB` : "?";
      resourceTag.textContent = `CPU ${inst.cpuPercent.toFixed(0)}% · RAM ${rss}`;
      resourceTag.style.cssText = "color:var(--omp-text-dim);font-size:9px;";
      row.appendChild(resourceTag);
    }

    if (inst.crashed) {
      const msg = document.createElement("div");
      msg.textContent = inst.crashMessage || "Prozess abgestürzt";
      msg.style.cssText = "color:var(--omp-error);white-space:pre-wrap;word-break:break-word;margin-top:2px;";
      row.appendChild(msg);
    }

    const stopBtn = document.createElement("button");
    stopBtn.textContent = inst.crashed ? "Entfernen" : "Stop";
    stopBtn.style.cssText = "font-size:10px;cursor:pointer;margin-top:3px;";
    stopBtn.className = "omp-btn-danger";
    stopBtn.addEventListener("click", () => this.#stopInstance(inst.id, inst.label));
    row.appendChild(stopBtn);

    return row;
  }

  async #startInstance(type: string, version?: string, hostId?: string) {
    try {
      const res = await apiFetch("/api/v1/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...(version ? { version } : {}), ...(hostId ? { hostId } : {}) }),
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Start fehlgeschlagen: ${text || res.status}`);
        return;
      }
      // Kein #fetchAndRender() nötig: die Instanz registriert sich
      // selbst bei der NMOS-Registry, was ein "node.added"-SSE-Event
      // auslöst (registry.Poller) — der Graph lädt sich dadurch von
      // selbst neu, sobald die Instanz tatsächlich erschienen ist. Die
      // Palette dagegen zeigt die Instanz (laufend oder später
      // abgestürzt) unabhängig von einer NMOS-Registrierung, deshalb
      // hier explizit neu rendern.
      //
      // Läuft gerade der Live-Scope eines laufenden Workflows (s.
      // #renderRunningWorkflowScope), soll die neue Instanz dort
      // erscheinen, sobald sie sich registriert — die Antwort liefert
      // die Instanz-ID sofort (vor der NMOS-Registrierung), die
      // zugehörige Node-ID kennen wir erst, sobald sie in #graph.nodes
      // auftaucht (s. #reconcileWorkflowScopePendingInstances, am
      // Anfang jedes #renderRunningWorkflowScope()-Laufs aufgerufen).
      const scopedWf = this.#workflowEditId ? this.#workflows.find((w) => w.id === this.#workflowEditId) : undefined;
      // Sonst, falls stattdessen eine echte B5-Gruppe offen ist (s.
      // #groupScopePendingInstances-Doku): gleiches Prinzip, andere
      // Zielstruktur (#groupTree statt Workflow-Runtime).
      if ((scopedWf && !this.#isIdleWorkflow(scopedWf)) || (!this.#workflowEditId && this.#scope !== null)) {
        const inst = (await res.json()) as { id: string };
        if (scopedWf) {
          this.#workflowScopePendingInstanceIds.add(inst.id);
        } else if (this.#scope !== null) {
          this.#groupScopePendingInstances.set(inst.id, this.#scope);
        }
      }
      this.#showToast(`${type} wird gestartet …`);
      await this.#renderPalette();
    } catch (err) {
      this.#showToast(`Start fehlgeschlagen: ${err}`);
    }
  }

  // UX-Audit 2026-08-07 (Nachtrag 126): bislang KEINE Bestätigung — ein
  // versehentlicher Klick auf das kleine "⏹"-Icon einer Kachel (oder den
  // "Stop"-Knopf in der generischen Instanz-Zeile, s. dortigen Aufrufer)
  // beendete die Instanz sofort, ohne Rückfrage. Gleiches Muster wie
  // #stopWorkflow oben (confirmDialog, "confirmLabel" statt der
  // englischen Default-Beschriftung).
  async #stopInstance(instanceId: string, label: string) {
    if (!(await confirmDialog(`Instanz „${label}" wirklich stoppen?`, { confirmLabel: "Stoppen" }))) return;
    try {
      const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(instanceId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Stop fehlgeschlagen: ${text || res.status}`);
        return;
      }
      // Die Kachel verschwindet, sobald der Node aus der Registry
      // ausläuft (registration_expiry_interval) und ein "node.removed"
      // die #fetchAndRender() auslöst — kein optimistisches Entfernen
      // hier, das wäre eine zweite, potenziell falsche Zustandsquelle.
      // Die Palette-Zeile dagegen entfernt DELETE serverseitig sofort aus
      // Launcher.instances (auch für eine bereits abgestürzte Instanz
      // ohne jede NMOS-Registrierung), deshalb hier direkt neu rendern.
      this.#showToast("Instanz wird gestoppt …");
      await this.#renderPalette();
    } catch (err) {
      this.#showToast(`Stop fehlgeschlagen: ${err}`);
    }
  }

  // Stop-Button am Gruppen-Tile (Nutzerfund 2026-07-21, s. GroupNode.
  // workflowId-Doku) — stoppt alle Rollen des Workflows gebündelt über
  // dessen eigenen Lifecycle, statt jede Mitglieds-Instanz einzeln zu
  // suchen/stoppen. `confirm:true` immer mitgeschickt, gleiches Muster
  // wie workflows-view.ts#stopWorkflow (der Orchestrator wertet es nur
  // aus, wenn der Workflow selbst `settings.confirmStop` gesetzt hat).
  async #stopWorkflow(workflowId: string, label: string) {
    if (!(await confirmDialog(`Workflow „${label}" wirklich stoppen?`, { confirmLabel: "Stoppen" }))) return;
    try {
      const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const text = await res.text();
        this.#showToast(`Workflow-Stop fehlgeschlagen: ${text || res.status}`);
        return;
      }
      this.#showToast(`Workflow „${label}" wird gestoppt …`);
    } catch (err) {
      this.#showToast(`Workflow-Stop fehlgeschlagen: ${err}`);
    }
  }

  #showToast(message: string) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("data-role", "toast");
    toast.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" +
      "background:var(--omp-error);color:#fff;padding:var(--omp-space-2) var(--omp-space-4);" +
      "border-radius:var(--omp-radius);font-family:var(--omp-font);font-size:var(--omp-font-size-md);" +
      "z-index:1000;opacity:0.95;";
    this.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

// Kapitel 12 Teil 3 (§12.3c): synthetische Tile-ID für die Platzhalter-
// Kachel einer Rolle in einem pausierten Workflow — ein pausierter
// Workflow hat keine Runtime-Node-IDs mehr (Runtime wird beim Pausieren
// geleert, gleiche Ressourcen-Wirkung wie "stopped"), also keine
// natürliche ID, an die sich eine Position hängen ließe. Diese
// synthetische ID nimmt exakt am selben Positions-Zuweisungs-/Pruning-
// Mechanismus wie echte Node-/Gruppen-IDs teil (#assignMissingPositions/
// #pruneStalePositions) — die Platzhalter-Position ist damit über
// Reloads hinweg stabil, genau wie bei jeder anderen Kachel.
function pausedPlaceholderId(workflowId: string, role: string): string {
  return `paused:${workflowId}:${role}`;
}

// Rückrichtung zu pausedPlaceholderId — liefert den Rollennamen zurück,
// wenn `id` eine Rollen-Kachel DES angegebenen (gerade bearbeiteten)
// Workflows ist, sonst null. Wird von #onPointerUp gebraucht, um einen
// beendeten Klick-Drag auf so einer Kachel von einem echten Node-/
// Gruppen-Klick zu unterscheiden (s. dortige Doku).
function workflowEditRoleName(workflowId: string, id: string): string | null {
  const prefix = pausedPlaceholderId(workflowId, "");
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

// Position der EINEN kollabierten Wurzel-Kachel eines Workflows, jeder
// Status (s. #renderWorkflowTiles) — eigener Namensraum
// ("workflow-tile:"), damit er nicht mit einer Rollen-Platzhalter-ID
// (pausedPlaceholderId) kollidieren kann, falls ein Workflow zufällig
// eine Rolle namens z. B. dem eigenen Namen hätte.
function workflowTileId(workflowId: string): string {
  return `workflow-tile:${workflowId}`;
}

function healthColor(health: string): string {
  switch (health) {
    case "ok":
      return "#4caf50";
    case "offline":
      return "#888";
    default:
      return "#e0a030";
  }
}

// Port-Füllfarbe nach IS-04-Format-URN (unverändert aus dem Graph-API,
// gleiches Vokabular wie compatibility.ts) — unbekanntes/leeres Format
// (z. B. Sender ohne aufgelösten Flow, A5) bekommt eine neutrale Farbe
// statt fälschlich einer der bekannten Formatfarben.
//
// Key/Alpha (Nutzerfund 2026-07-16): IS-04 kennt kein eigenes Format
// dafür — ein Key-Signal (z. B. omp-ografs Fill+Key, `UMSETZUNG.md`
// K5-Teil-1) ist protokollseitig ein ganz normaler
// `urn:x-nmos:format:video`-Sender, nur inhaltlich eine Alpha-Maske
// statt eines Bilds. Statt einer Protokollerweiterung wird das über
// das Port-Label erkannt (heuristisch, aber robust genug: die einzige
// Quelle für "Key" im Label ist `SenderSpec::label`, das die Nodes
// selbst setzen — kein geratener String-Match auf beliebigen
// Fremdtext). Gemeinsame Erkennung für `portColor()` und
// `formatAbbrev()`, damit beide konsistent bleiben.
function isKeyPort(format: string, label: string): boolean {
  return format === "urn:x-nmos:format:video" && /\bkey\b/i.test(label);
}

function portColor(format: string, label: string): string {
  if (isKeyPort(format, label)) return "#e05de0";
  switch (format) {
    case "urn:x-nmos:format:video":
      return "#3fa7ff";
    case "urn:x-nmos:format:audio":
      return "#ffb300";
    case "urn:x-nmos:format:data":
      return "#b47cff";
    default:
      return "#999";
  }
}

// Explizites Format-Kürzel fürs Port-Label (Nutzerfund 2026-07-16:
// „ich kann anhand des Labels noch nicht erkennen, ob es ein Video-,
// Audio- oder Daten-Ein-/Ausgang ist" — Farbe allein verlangt, die
// Legende auswendig zu kennen; das Kürzel macht es aus dem Text selbst
// lesbar, ohne dass der Rollen-Teil des Labels — "PGM"/"Fill"/
// "Sender 2" — dafür Platz verlieren muss).
function formatAbbrev(format: string, label: string): string {
  if (isKeyPort(format, label)) return "K";
  switch (format) {
    case "urn:x-nmos:format:video":
      return "V";
    case "urn:x-nmos:format:audio":
      return "A";
    case "urn:x-nmos:format:data":
      return "D";
    default:
      return "?";
  }
}

// Kurzform eines Port-Labels für die immer sichtbare Beschriftung neben
// dem Port (Nutzerfund 2026-07-16: bisher nur als Hover-Tooltip
// vorhanden — an einer Kachel mit mehreren Ports desselben Typs, z. B.
// PGM/PST oder Fill/Key, war von außen nicht erkennbar, welcher Port
// welches Signal führt).
//
// Live-Test-Fund beim ersten Versuch (reines Kappen von vorne auf 10
// Zeichen): zwei Ports derselben Kachel — z. B. "OGraf Grafik (id) Fill"
// und "... Key" — teilen sich den langen Node-Namen als Präfix, eine
// Kürzung von VORNE zeigte für beide identisch "OGraf Gra…" und verlor
// genau das unterscheidende letzte Wort. Fix: das letzte Wort bevorzugen
// (meist die eigentliche Rolle — "Fill"/"Key"/"PGM"), außer es ist eine
// nackte Zahl (generische "<Label> Sender N"-Fallback-Namen ohne eigenes
// Label, s. `omp_node_sdk::node::run`) — dann die letzten zwei Wörter
// ("Sender 1"), damit wenigstens Video-/Audio-Sender-Nummer erkennbar
// bleibt (Farbe unterscheidet Video/Audio ohnehin zusätzlich).
// s. #renderTile-Aufrufstelle: fester Zeichen-Budget-Kürzung statt
// Live-Textmessung (gleiches Prinzip wie portShortLabel unten). Labels
// folgen überwiegend dem Muster "<Beschreibung> (<Instanz-ID-Präfix>)"
// (main.rs-Konvention aller Nodes) — die ID-Klammer ist gerade bei
// mehreren Instanzen desselben Typs das eigentlich unterscheidende
// Merkmal (s. DSK-Fill/Key-Diskussion), deshalb wird sie bevorzugt
// erhalten und nur der Beschreibungsteil gekürzt, statt blind vom Ende
// abzuschneiden.
function truncateTileTitle(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label;
  const match = label.match(/^(.*) (\([0-9a-fA-F]{4,}\))$/);
  if (match) {
    const [, prefix, suffix] = match;
    const prefixBudget = maxLen - 1 - suffix.length;
    if (prefixBudget >= 3) {
      return `${prefix.slice(0, prefixBudget)}…${suffix}`;
    }
  }
  return `${label.slice(0, maxLen - 1)}…`;
}

function portShortLabel(label: string): string {
  const words = label.trim().split(/\s+/);
  const last = words[words.length - 1] ?? label;
  const isBareNumber = /^\d+$/.test(last);
  const candidate = isBareNumber && words.length >= 2 ? words.slice(-2).join(" ") : last;
  const max = 10;
  return candidate.length > max ? `${candidate.slice(0, max - 1)}…` : candidate;
}

// Re-export für Tests/andere Module, die die reinen Helfer direkt
// brauchen, ohne den Custom Element selbst zu laden.
export { screenToWorld, worldToScreen };

customElements.define("omp-flow-canvas", FlowCanvas);
