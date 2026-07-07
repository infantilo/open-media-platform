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
  NODE_WIDTH,
  nodeHeight,
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
}

interface TileSpec {
  id: string;
  label: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  kind: "node" | "group";
  health: string;
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

const SSE_RECONNECT_INITIAL_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 15000;
const NODE_INVENTORY_EVENT_TYPES = new Set(["node.added", "node.updated", "node.removed"]);
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

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #breadcrumbBar!: HTMLDivElement;
  #panelContainer!: HTMLDivElement;
  #panelNodeId: string | null = null;

  #eventSource: EventSource | null = null;
  #reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.#connectEvents();
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
    clearTimeout(this.#reconnectTimer);
    this.#eventSource?.close();
  }

  async #init() {
    await this.#loadLayout();
    await this.#fetchAndRender();
  }

  async #loadLayout() {
    try {
      const response = await fetch(`/api/v1/layouts/${LAYOUT_NAME}`);
      if (response.ok) {
        const blob = (await response.json()) as Partial<LayoutBlob>;
        this.#positions = blob.positions ?? {};
        this.#groupTree = blob.groups ?? emptyTree();
        return;
      }
    } catch {
      // Server (noch) nicht erreichbar — mit leerem Layout starten.
    }
    this.#positions = {};
    this.#groupTree = emptyTree();
  }

  async #saveLayout() {
    const blob: LayoutBlob = { positions: this.#positions, groups: this.#groupTree };
    try {
      const response = await fetch(`/api/v1/layouts/${LAYOUT_NAME}`, {
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

  // Verbindet den Live-Status-Overlay-Stream (UMSETZUNG.md B4): Node-
  // Inventar-Änderungen (A6) lösen ein Neuladen des Graphen aus,
  // Tally-Events (omp.tally.<id>) färben die betroffene Kachel rot.
  // Bei Verbindungsabbruch reconnectet mit exponentiellem Backoff statt
  // sich auf EventSources festen Standard-Retry zu verlassen.
  #connectEvents() {
    const es = new EventSource("/api/v1/events");
    this.#eventSource = es;

    es.onopen = () => {
      this.#reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
    };
    es.onmessage = (ev) => this.#handleServerEvent(ev);
    es.onerror = () => {
      es.close();
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#connectEvents(), this.#reconnectDelayMs);
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, SSE_RECONNECT_MAX_DELAY_MS);
  }

  #handleServerEvent(ev: MessageEvent) {
    let parsed: { type: string; data: unknown };
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (NODE_INVENTORY_EVENT_TYPES.has(parsed.type)) {
      this.#fetchAndRender();
      return;
    }

    if (parsed.type.startsWith(TALLY_EVENT_PREFIX)) {
      const nodeId = parsed.type.slice(TALLY_EVENT_PREFIX.length);
      const on = (parsed.data as { on?: boolean } | null)?.on === true;
      this.#setTally(nodeId, on);
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
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.touchAction = "none";
    svg.style.background = "#1e1e1e";

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
      "background:#252525;color:#ddd;font-family:sans-serif;font-size:12px;" +
      "padding:10px;padding-top:36px;overflow-y:auto;display:none;" +
      "z-index:20;border-left:1px solid #444;box-sizing:border-box;";

    this.replaceChildren(svg, breadcrumb, panel);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;
    this.#breadcrumbBar = breadcrumb;
    this.#panelContainer = panel;
  }

  async #fetchAndRender() {
    const response = await fetch("/api/v1/graph");
    this.#graph = await response.json();
    this.#assignMissingPositions();
    this.#render();
  }

  #assignMissingPositions() {
    let changed = false;
    const items = this.#itemsAtScope();
    [...items.nodeIds, ...items.groupIds].forEach((id, index) => {
      if (!this.#positions[id]) {
        this.#positions[id] = defaultPosition(index);
        changed = true;
      }
    });
    if (changed) this.#saveLayout();
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
      this.#tileHeightById.set(tile.id, nodeHeight(tile.inputs.length, tile.outputs.length));
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

    if (this.#scope !== null) {
      const dissolveBtn = document.createElement("button");
      dissolveBtn.textContent = "Gruppe auflösen";
      dissolveBtn.style.cssText = "margin-left:auto;font-size:11px;cursor:pointer;";
      dissolveBtn.addEventListener("click", () => this.#dissolveCurrentGroup());
      this.#breadcrumbBar.appendChild(dissolveBtn);
    }
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

    tile.inputs.forEach((port, i) => {
      g.appendChild(this.#renderPort(port, i, tile.inputs.length, "input", pos, height));
    });
    tile.outputs.forEach((port, i) => {
      const circle = this.#renderPort(port, i, tile.outputs.length, "output", pos, height);
      circle.addEventListener("pointerdown", (ev) => this.#onOutputPortPointerDown(ev, port));
      g.appendChild(circle);
    });

    g.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, tile.id));
    if (isGroup) {
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.#enterScope(tile.id);
      });
    }

    return g;
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
    circle.setAttribute("fill", side === "input" ? "#5b9bd5" : "#70ad47");
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
    } else if (this.#drag?.kind === "pan" && !this.#drag.moved) {
      this.#closePanel();
    }
    this.#drag = null;
  }

  #onWheel(ev: WheelEvent) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.#viewport = zoomAt(this.#viewport, this.#screenPoint(ev), factor);
    this.#applyViewportTransform();
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
      const response = await fetch("/api/v1/graph/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromSender, to: toReceiver }),
      });
      if (!response.ok) {
        const text = await response.text();
        this.#showToast(`Verbindung fehlgeschlagen: ${text || response.status}`);
        return;
      }
      await this.#fetchAndRender();
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
      const response = await fetch(`/api/v1/graph/edges/${encodeURIComponent(edgeId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const text = await response.text();
        this.#showToast(`Trennen fehlgeschlagen: ${text || response.status}`);
        return;
      }
      this.#selectedEdgeId = null;
      await this.#fetchAndRender();
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

    const mounted = await this.#tryMountUIBundle(nodeId);
    if (mounted) return;

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

  // Versucht, das node-eigene UI-Bundle zu laden (ARCHITECTURE.md §4.5):
  // liefert der Node /ui/manifest.json + /ui/bundle.js, wird dessen
  // Custom Element per nativem import() geladen statt des generischen
  // Panels. Liefert false, wenn der Node kein Bundle hat (404 o. ä.) —
  // dann übernimmt #renderGenericPanel.
  async #tryMountUIBundle(nodeId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/nodes/${nodeId}/ui/manifest.json`);
      if (!res.ok) return false;
      const manifest = (await res.json()) as { tag?: string };
      if (!manifest.tag) return false;

      await import(/* webpackIgnore: true */ `/api/v1/nodes/${nodeId}/ui/bundle.js`);

      this.#panelContainer.replaceChildren();
      this.#panelContainer.appendChild(this.#panelCloseButton());
      const el = document.createElement(manifest.tag);
      el.setAttribute("node-id", nodeId);
      this.#panelContainer.appendChild(el);
      return true;
    } catch {
      return false;
    }
  }

  async #renderGenericPanel(nodeId: string) {
    let descriptor: Descriptor;
    try {
      const res = await fetch(`/api/v1/nodes/${nodeId}/descriptor`);
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
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${name}`);
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
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${param.name}`, {
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
      const res = await fetch(`/api/v1/nodes/${nodeId}/methods/${method.name}`, {
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

  #showToast(message: string) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("data-role", "toast");
    toast.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" +
      "background:#c0392b;color:#fff;padding:8px 16px;border-radius:4px;" +
      "font-family:sans-serif;font-size:13px;z-index:1000;opacity:0.95;";
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

// Re-export für Tests/andere Module, die die reinen Helfer direkt
// brauchen, ohne den Custom Element selbst zu laden.
export { screenToWorld, worldToScreen };

customElements.define("omp-flow-canvas", FlowCanvas);
