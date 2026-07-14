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
  breadcrumbPath,
  createGroup,
  dissolveGroup,
  emptyTree,
  type GroupTree,
  type PortRef,
  promotedPorts,
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

const SVG_NS = "http://www.w3.org/2000/svg";
const LAYOUT_NAME = "default";

interface GraphPort {
  id: string;
  label: string;
  format: string;
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
}

interface SnapshotSummary {
  id: string;
  label: string;
}

interface ApplyResult {
  errors: string[];
}

interface TileSpec {
  id: string;
  label: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  kind: "node" | "group";
  health: string;
  instanceId?: string;
}

// CatalogEntry (UMSETZUNG.md C8) — Wire-Format identisch zu
// orchestrator/internal/launcher.CatalogEntry.
interface CatalogEntry {
  type: string;
  label: string;
  runner: string;
  command: string[];
  env: Record<string, string>;
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
}

// HostEntry — Wire-Format identisch zu httpapi.hostResponse
// (ARCHITECTURE.md §18, UMSETZUNG.md D6). Nur die für die Katalog-
// Palette gebrauchten Felder.
interface HostEntry {
  id: string;
  label: string;
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
]);
const TALLY_EVENT_PREFIX = "omp.tally.";
const DRAG_THRESHOLD_PX = 3;

export class FlowCanvas extends HTMLElement {
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #positions: Record<string, Point> = {};
  #groupTree: GroupTree = emptyTree();
  #scope: string | null = null;
  #selectedIds: Set<string> = new Set();
  #graph: Graph = { nodes: [], edges: [] };
  #tally: Record<string, boolean> = {};
  #drag: DragState | null = null;
  #rubberBand: SVGPathElement | null = null;
  #selectionRect: SVGRectElement | null = null;
  #selectedEdgeId: string | null = null;
  #portLocation: Map<string, PortLocation> = new Map();
  #tileHeightById: Map<string, number> = new Map();
  // Inline-Vorschau auf der Kachel selbst (nicht nur im geöffneten
  // Parameter-Panel) für Nodes mit einem "previewUrl"-Parameter (bisher
  // nur omp-viewer, C6) — `null` = geprüft, kein previewUrl vorhanden.
  // Einmalig pro Node-ID abgefragt, nicht bei jedem Render-Tick erneut.
  #previewUrlById: Map<string, string | null> = new Map();
  #previewFetchInFlight: Set<string> = new Set();

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #breadcrumbBar!: HTMLDivElement;
  #panelContainer!: HTMLDivElement;
  #panelNodeId: string | null = null;
  #snapshotBar!: HTMLDivElement;
  #palette!: HTMLDivElement;

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

  async #saveLayout() {
    const blob: LayoutBlob = {
      positions: this.#positions,
      groups: this.#groupTree,
      viewport: this.#viewport,
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

    const breadcrumb = document.createElement("div");
    breadcrumb.setAttribute("data-role", "breadcrumb");
    breadcrumb.style.cssText =
      "position:absolute;top:0;left:0;right:0;padding:6px 10px;" +
      "background:#252525;color:#ddd;font-family:sans-serif;font-size:12px;" +
      "display:flex;gap:6px;align-items:center;z-index:10;";

    const panel = document.createElement("div");
    panel.setAttribute("data-role", "parameter-panel");
    panel.style.cssText =
      "position:absolute;top:0;right:0;bottom:0;width:280px;" +
      "background:var(--omp-surface);color:var(--omp-text);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);padding:var(--omp-space-2);padding-top:36px;overflow-y:auto;" +
      "display:none;z-index:20;border-left:1px solid var(--omp-border);box-sizing:border-box;";

    const snapshotBar = document.createElement("div");
    snapshotBar.setAttribute("data-role", "snapshot-bar");
    snapshotBar.style.cssText =
      "position:absolute;bottom:0;left:0;right:0;padding:6px 10px;" +
      "background:#252525;color:#ddd;font-family:sans-serif;font-size:12px;" +
      "display:flex;gap:8px;align-items:center;z-index:10;" +
      "border-top:1px solid #444;box-sizing:border-box;";

    // Katalog-Palette (UMSETZUNG.md C8): Node-Typen aus /api/v1/catalog
    // mit Start-Button, symmetrisch zum Parameter-Panel auf der rechten
    // Seite platziert.
    const palette = document.createElement("div");
    palette.setAttribute("data-role", "palette");
    palette.style.cssText =
      "position:absolute;top:0;left:0;bottom:0;width:160px;" +
      "background:#252525;color:#ddd;font-family:sans-serif;font-size:12px;" +
      "padding:10px;padding-top:36px;overflow-y:auto;" +
      "z-index:10;border-right:1px solid #444;box-sizing:border-box;";

    this.replaceChildren(svg, breadcrumb, panel, palette, snapshotBar);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;
    this.#breadcrumbBar = breadcrumb;
    this.#panelContainer = panel;
    this.#snapshotBar = snapshotBar;
    this.#palette = palette;
  }

  async #fetchAndRender() {
    const response = await apiFetch("/api/v1/graph");
    this.#graph = await response.json();
    // Beide geben nur zurück, *ob* sich #positions geändert hat, statt
    // selbst zu speichern — sonst würde ein Zwischen-Save mit dem noch
    // unangepassten Viewport (IDENTITY_VIEWPORT vor dem Fit unten)
    // persistiert und ein späterer Reload fiele fälschlich nicht mehr auf
    // #fitViewportToPositions() zurück, weil `blob.viewport` dann schon
    // (falsch) gesetzt wäre.
    let changed = this.#pruneStalePositions();
    changed = this.#assignMissingPositions(false) || changed;
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
    for (const id of [...items.nodeIds, ...items.groupIds]) {
      if (!this.#positions[id]) {
        this.#positions[id] = defaultPosition(nextIndex);
        nextIndex++;
        changed = true;
      }
    }
    if (changed && save) this.#saveLayout();
    return changed;
  }

  #itemsAtScope(): { nodeIds: string[]; groupIds: string[] } {
    return topLevelItems(
      this.#groupTree,
      this.#scope,
      this.#graph.nodes.map((n) => n.id),
    );
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

  #buildTilesAtScope(): TileSpec[] {
    const items = this.#itemsAtScope();
    const tiles: TileSpec[] = [];

    for (const nodeId of items.nodeIds) {
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

    const tiles = this.#buildTilesAtScope();

    this.#portLocation.clear();
    this.#tileHeightById.clear();
    for (const tile of tiles) {
      const hasPreview = !!this.#previewUrlById.get(tile.id);
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

  #renderBreadcrumb() {
    const path = breadcrumbPath(this.#groupTree, this.#scope);
    this.#breadcrumbBar.replaceChildren();

    this.#breadcrumbBar.appendChild(this.#breadcrumbLink("Root", null));
    for (const group of path) {
      const sep = document.createElement("span");
      sep.textContent = "›";
      this.#breadcrumbBar.appendChild(sep);
      this.#breadcrumbBar.appendChild(this.#breadcrumbLink(group.label, group.id));
    }

    const fitBtn = document.createElement("button");
    fitBtn.textContent = "Alle einpassen";
    fitBtn.style.cssText = `margin-left:${this.#scope === null ? "auto" : "8px"};font-size:11px;cursor:pointer;`;
    fitBtn.addEventListener("click", () => this.#fitAllToViewport());
    this.#breadcrumbBar.appendChild(fitBtn);

    if (this.#scope !== null) {
      const dissolveBtn = document.createElement("button");
      dissolveBtn.textContent = "Gruppe auflösen";
      dissolveBtn.style.cssText = "font-size:11px;cursor:pointer;";
      dissolveBtn.addEventListener("click", () => this.#dissolveCurrentGroup());
      this.#breadcrumbBar.appendChild(dissolveBtn);
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
      selected ? "#ffcc00" : onTally ? "#ff3b3b" : isGroup ? "#5b9bd5" : healthColor(tile.health),
    );
    body.setAttribute("stroke-width", selected || onTally ? "3" : "2");
    if (selected) body.setAttribute("stroke-dasharray", "6 3");
    g.appendChild(body);

    const header = document.createElementNS(SVG_NS, "rect");
    header.setAttribute("width", String(NODE_WIDTH));
    header.setAttribute("height", String(HEADER_HEIGHT));
    header.setAttribute("rx", "4");
    header.setAttribute("fill", isGroup ? "#3a4a5d" : "#3a3a3a");
    g.appendChild(header);

    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", "8");
    title.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    title.setAttribute("fill", "#f0f0f0");
    title.setAttribute("font-size", "12");
    title.textContent = isGroup ? `▣ ${tile.label}` : tile.label;
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
        this.#stopInstance(instanceId);
      });
      g.appendChild(stopBtn);
    }

    tile.inputs.forEach((port, i) => {
      g.appendChild(this.#renderPort(port, i, tile.inputs.length, "input", pos, height));
    });
    tile.outputs.forEach((port, i) => {
      const circle = this.#renderPort(port, i, tile.outputs.length, "output", pos, height);
      circle.addEventListener("pointerdown", (ev) => this.#onOutputPortPointerDown(ev, port));
      g.appendChild(circle);
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
    const previewUrl = this.#previewUrlById.get(nodeId);
    if (!previewUrl) return null;

    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", "8");
    fo.setAttribute("y", String(HEADER_HEIGHT + 4));
    fo.setAttribute("width", String(PREVIEW_WIDTH));
    fo.setAttribute("height", String(PREVIEW_HEIGHT));
    fo.style.pointerEvents = "none"; // Ziehen/Auswählen der Kachel bleibt unverändert möglich.

    const img = document.createElement("img");
    img.src = previewUrl;
    img.alt = "Vorschau";
    img.style.cssText = `display:block;width:${PREVIEW_WIDTH}px;height:${PREVIEW_HEIGHT}px;object-fit:cover;background:#000;border:1px solid #444;border-radius:2px;`;
    fo.appendChild(img);
    return fo;
  }

  #maybeFetchPreviewUrl(nodeId: string) {
    if (this.#previewUrlById.has(nodeId) || this.#previewFetchInFlight.has(nodeId)) return;
    this.#previewFetchInFlight.add(nodeId);
    apiFetch(`/api/v1/nodes/${nodeId}/params/previewUrl`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const url = body && typeof body.value === "string" && body.value ? body.value : null;
        this.#previewUrlById.set(nodeId, url);
        if (url) this.#render();
      })
      .catch(() => {
        this.#previewUrlById.set(nodeId, null);
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
  ): SVGCircleElement {
    const world = portPosition(nodePos.x, nodePos.y, height, index, count, side);
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(world.x - nodePos.x));
    circle.setAttribute("cy", String(world.y - nodePos.y));
    circle.setAttribute("r", "5");
    // Farbe primär nach Format (Nutzerfund 2026-07-12: zwei Output-Ports
    // desselben Nodes — z. B. omp-sources Video-/Audio-Sender — waren
    // beide gleich eingefärbt, nur nach input/output unterscheidbar, nicht
    // nach Format); input/output bleibt über die Randfarbe erkennbar.
    circle.setAttribute("fill", portColor(port.format));
    circle.setAttribute("stroke", side === "input" ? "#5b9bd5" : "#70ad47");
    circle.setAttribute("stroke-width", "1.5");
    circle.setAttribute("data-role", "port");
    circle.setAttribute("data-port-id", port.id);
    circle.setAttribute("data-port-side", side);
    circle.setAttribute("data-format", port.format);
    const titleEl = document.createElementNS(SVG_NS, "title");
    titleEl.textContent = port.label;
    circle.appendChild(titleEl);
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
    const midX = (from.x + to.x) / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", selected ? "#ffffff" : edge.state === "active" ? "#e0a030" : "#666");
    path.setAttribute("stroke-width", selected ? "3" : "2");
    path.setAttribute("data-role", "edge");
    path.setAttribute("data-id", edge.id);
    path.style.cursor = "pointer";
    path.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#selectedEdgeId = edge.id;
      this.#render();
    });
    return path;
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
        this.#openParameterPanel(this.#drag.nodeId);
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

  async #openParameterPanel(nodeId: string) {
    if (!this.#graph.nodes.some((n) => n.id === nodeId)) return; // Gruppen haben keinen Descriptor
    this.#panelNodeId = nodeId;
    this.#panelContainer.style.display = "block";
    this.#panelContainer.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Lädt…";
    this.#panelContainer.appendChild(loading);

    const mounted = await mountUIBundle(this.#panelContainer, `/api/v1/nodes/${nodeId}`);
    if (mounted) {
      this.#panelContainer.insertBefore(this.#panelCloseButton(), this.#panelContainer.firstChild);
      return;
    }

    await this.#renderGenericPanel(nodeId);
  }

  #closePanel() {
    if (this.#panelNodeId === null) return;
    this.#panelNodeId = null;
    this.#panelContainer.style.display = "none";
    this.#panelContainer.replaceChildren();
  }

  #panelCloseButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.style.cssText = "position:absolute;top:8px;right:8px;cursor:pointer;";
    btn.addEventListener("click", () => this.#closePanel());
    return btn;
  }

  async #renderGenericPanel(nodeId: string) {
    let descriptor: Descriptor;
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/descriptor`);
      if (!res.ok) throw new Error(String(res.status));
      descriptor = await res.json();
    } catch (err) {
      this.#panelContainer.replaceChildren();
      this.#panelContainer.appendChild(this.#panelCloseButton());
      const p = document.createElement("p");
      p.textContent = `Descriptor konnte nicht geladen werden: ${err}`;
      this.#panelContainer.appendChild(p);
      return;
    }

    this.#panelContainer.replaceChildren();
    this.#panelContainer.appendChild(this.#panelCloseButton());

    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    const title = document.createElement("h3");
    title.textContent = node?.label ?? nodeId;
    title.style.cssText = "margin:0 0 8px 0;font-size:14px;";
    this.#panelContainer.appendChild(title);

    for (const param of descriptor.parameters) {
      const value = await this.#fetchParamValue(nodeId, param.name);
      this.#panelContainer.appendChild(this.#buildParamRow(nodeId, param, value));
    }

    if (descriptor.methods.length > 0) {
      const hr = document.createElement("hr");
      hr.style.borderColor = "#444";
      this.#panelContainer.appendChild(hr);
    }
    for (const method of descriptor.methods) {
      const btn = document.createElement("button");
      btn.textContent = method.name;
      btn.style.cssText = "display:block;margin:6px 0;cursor:pointer;";
      btn.addEventListener("click", () => this.#invokeMethod(nodeId, method));
      this.#panelContainer.appendChild(btn);
    }
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
    label.style.cssText = "display:block;margin-bottom:2px;color:#aaa;";
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
    saveBtn.style.cursor = "pointer";
    saveBtn.addEventListener("click", () => this.#saveSnapshot());
    this.#snapshotBar.appendChild(saveBtn);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;gap:6px;overflow-x:auto;min-width:0;flex:1;";
    this.#snapshotBar.appendChild(list);

    try {
      const res = await apiFetch("/api/v1/snapshots");
      if (res.ok) {
        const snaps = (await res.json()) as SnapshotSummary[];
        for (const snap of snaps) {
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
    this.#palette.replaceChildren();

    const heading = document.createElement("div");
    heading.textContent = "Node-Katalog";
    heading.style.cssText = "font-weight:bold;margin-bottom:8px;";
    this.#palette.appendChild(heading);

    try {
      const [catalogRes, instancesRes, hostsRes] = await Promise.all([
        apiFetch("/api/v1/catalog"),
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
      ]);
      if (!catalogRes.ok) return;
      const catalog = (await catalogRes.json()) as CatalogEntry[];
      const instances = instancesRes.ok ? ((await instancesRes.json()) as LauncherInstance[]) : [];
      // Remote-Hosts (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 2) sind
      // optional — kein Fehler, wenn der Endpunkt (noch) nichts liefert
      // oder der Nutzer keine Admin-Sicht hat (403 möglich, D3 Teil 2).
      const hosts: HostEntry[] = hostsRes.ok ? await hostsRes.json() : [];

      if (catalog.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "Katalog leer.";
        empty.style.cssText = "color:#888;";
        this.#palette.appendChild(empty);
        return;
      }

      for (const entry of catalog) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";

        const btn = document.createElement("button");
        btn.textContent = `+ ${entry.label}`;
        btn.title = `${entry.label} starten`;
        btn.style.cssText = "cursor:pointer;flex:1;text-align:left;padding:4px 6px;";

        // Host-Auswahl nur anzeigen, wenn es überhaupt entfernte Hosts
        // gibt — im (heute üblichen) Fall ohne Host-Agents bleibt die
        // Palette optisch unverändert gegenüber vor D6 Teil 2.
        let hostSelect: HTMLSelectElement | null = null;
        if (hosts.length > 0) {
          hostSelect = document.createElement("select");
          hostSelect.title = "Zielhost";
          hostSelect.style.cssText = "font-size:10px;max-width:90px;";
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

        btn.addEventListener("click", () => this.#startInstance(entry.type, hostSelect?.value || undefined));
        row.appendChild(btn);
        this.#palette.appendChild(row);

        for (const inst of instances.filter((i) => i.type === entry.type)) {
          this.#palette.appendChild(this.#renderInstanceRow(inst, hosts));
        }
      }
    } catch {
      // Palette bleibt leer, wenn der Server (noch) nicht erreichbar ist.
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

    if (inst.hostId) {
      const hostLabel = hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId;
      const hostTag = document.createElement("div");
      hostTag.textContent = `Host: ${hostLabel}`;
      hostTag.style.cssText = "color:#888;font-size:9px;";
      row.appendChild(hostTag);
    }

    if (inst.crashed) {
      const msg = document.createElement("div");
      msg.textContent = inst.crashMessage || "Prozess abgestürzt";
      msg.style.cssText = "color:#e57373;white-space:pre-wrap;word-break:break-word;margin-top:2px;";
      row.appendChild(msg);
    }

    const stopBtn = document.createElement("button");
    stopBtn.textContent = inst.crashed ? "Entfernen" : "Stop";
    stopBtn.style.cssText = "font-size:10px;cursor:pointer;margin-top:3px;";
    stopBtn.addEventListener("click", () => this.#stopInstance(inst.id));
    row.appendChild(stopBtn);

    return row;
  }

  async #startInstance(type: string, hostId?: string) {
    try {
      const res = await apiFetch("/api/v1/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hostId ? { type, hostId } : { type }),
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
      this.#showToast(`${type} wird gestartet …`);
      await this.#renderPalette();
    } catch (err) {
      this.#showToast(`Start fehlgeschlagen: ${err}`);
    }
  }

  async #stopInstance(instanceId: string) {
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
function portColor(format: string): string {
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

// Re-export für Tests/andere Module, die die reinen Helfer direkt
// brauchen, ohne den Custom Element selbst zu laden.
export { screenToWorld, worldToScreen };

customElements.define("omp-flow-canvas", FlowCanvas);
