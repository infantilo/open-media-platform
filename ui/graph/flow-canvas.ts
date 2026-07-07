// <omp-flow-canvas>: rendert /api/v1/graph als SVG-Kacheln mit Pan/Zoom,
// verschiebbaren Nodes (B2) und Drag&Drop-Verbindungen (B3). Reine
// Koordinaten-/Kompatibilitätslogik steckt in geometry.ts/
// compatibility.ts (dort per `deno test` geprüft) — dieses Modul bindet
// sie nur an DOM-/Fetch-/Storage-APIs.

import {
  defaultPosition,
  HEADER_HEIGHT,
  IDENTITY_VIEWPORT,
  NODE_WIDTH,
  nodeHeight,
  type Point,
  portPosition,
  screenToWorld,
  type Viewport,
  worldToScreen,
  zoomAt,
} from "./geometry.ts";
import { portsCompatible } from "./compatibility.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const POSITIONS_STORAGE_KEY = "omp-flow-positions";

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

type PortSide = "input" | "output";

type DragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport }
  | { kind: "node"; nodeId: string; startScreen: Point; startWorld: Point }
  | { kind: "connect"; fromPortId: string; fromFormat: string; fromWorld: Point; currentScreen: Point };

const SSE_RECONNECT_INITIAL_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 15000;
const NODE_INVENTORY_EVENT_TYPES = new Set(["node.added", "node.updated", "node.removed"]);
const TALLY_EVENT_PREFIX = "omp.tally.";

export class FlowCanvas extends HTMLElement {
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #positions: Record<string, Point> = {};
  #graph: Graph = { nodes: [], edges: [] };
  #tally: Record<string, boolean> = {};
  #drag: DragState | null = null;
  #rubberBand: SVGPathElement | null = null;
  #selectedEdgeId: string | null = null;

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;

  #eventSource: EventSource | null = null;
  #reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  #onKeyDown = (ev: KeyboardEvent) => {
    if (!this.#selectedEdgeId) return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      this.#deleteSelectedEdge();
    }
  };

  connectedCallback() {
    this.#loadPositions();
    this.#buildSkeleton();
    document.addEventListener("keydown", this.#onKeyDown);
    this.#fetchAndRender();
    this.#connectEvents();
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
    clearTimeout(this.#reconnectTimer);
    this.#eventSource?.close();
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

  #loadPositions() {
    try {
      const raw = localStorage.getItem(POSITIONS_STORAGE_KEY);
      this.#positions = raw ? JSON.parse(raw) : {};
    } catch {
      this.#positions = {};
    }
  }

  #savePositions() {
    localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(this.#positions));
  }

  #buildSkeleton() {
    this.style.display ||= "block";

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

    this.replaceChildren(svg);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;
  }

  async #fetchAndRender() {
    const response = await fetch("/api/v1/graph");
    this.#graph = await response.json();
    this.#assignMissingPositions();
    this.#render();
  }

  #assignMissingPositions() {
    let changed = false;
    this.#graph.nodes.forEach((node, index) => {
      if (!this.#positions[node.id]) {
        this.#positions[node.id] = defaultPosition(index);
        changed = true;
      }
    });
    if (changed) this.#savePositions();
  }

  #render() {
    this.#viewportGroup.replaceChildren();
    this.#applyViewportTransform();

    for (const node of this.#graph.nodes) {
      this.#viewportGroup.appendChild(this.#renderNode(node));
    }
    for (const edge of this.#graph.edges) {
      const edgeEl = this.#renderEdge(edge);
      if (edgeEl) this.#viewportGroup.insertBefore(edgeEl, this.#viewportGroup.firstChild);
    }
  }

  #applyViewportTransform() {
    const { x, y, scale } = this.#viewport;
    this.#viewportGroup.setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
  }

  #renderNode(node: GraphNode): SVGGElement {
    const pos = this.#positions[node.id] ?? { x: 0, y: 0 };
    const height = nodeHeight(node.inputs.length, node.outputs.length);

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "node");
    g.setAttribute("data-id", node.id);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const onTally = this.#tally[node.id] === true;

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(height));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", onTally ? "#8b1a1a" : "#2d2d2d");
    body.setAttribute("stroke", onTally ? "#ff3b3b" : healthColor(node.health));
    body.setAttribute("stroke-width", onTally ? "3" : "2");
    g.appendChild(body);

    const header = document.createElementNS(SVG_NS, "rect");
    header.setAttribute("width", String(NODE_WIDTH));
    header.setAttribute("height", String(HEADER_HEIGHT));
    header.setAttribute("rx", "4");
    header.setAttribute("fill", "#3a3a3a");
    g.appendChild(header);

    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", "8");
    title.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    title.setAttribute("fill", "#f0f0f0");
    title.setAttribute("font-size", "12");
    title.textContent = node.label;
    g.appendChild(title);

    node.inputs.forEach((port, i) => {
      const circle = this.#renderPort(port, i, node.inputs.length, "input", pos, height);
      g.appendChild(circle);
    });
    node.outputs.forEach((port, i) => {
      const circle = this.#renderPort(port, i, node.outputs.length, "output", pos, height);
      circle.addEventListener("pointerdown", (ev) => this.#onOutputPortPointerDown(ev, port));
      g.appendChild(circle);
    });

    g.addEventListener("pointerdown", (ev) => this.#onNodePointerDown(ev, node.id));

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
    const from = this.#findPortWorldPosition(edge.fromSender, "output");
    const to = this.#findPortWorldPosition(edge.toReceiver, "input");
    if (!from || !to) return null;

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

  #findPortWorldPosition(portId: string, side: PortSide): Point | null {
    for (const node of this.#graph.nodes) {
      const ports = side === "input" ? node.inputs : node.outputs;
      const index = ports.findIndex((p) => p.id === portId);
      if (index === -1) continue;
      const pos = this.#positions[node.id] ?? { x: 0, y: 0 };
      const height = nodeHeight(node.inputs.length, node.outputs.length);
      return portPosition(pos.x, pos.y, height, index, ports.length, side);
    }
    return null;
  }

  #onNodePointerDown(ev: PointerEvent, nodeId: string) {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const startWorld = this.#positions[nodeId] ?? { x: 0, y: 0 };
    this.#drag = {
      kind: "node",
      nodeId,
      startScreen: this.#screenPoint(ev),
      startWorld,
    };
  }

  #onOutputPortPointerDown(ev: PointerEvent, port: GraphPort) {
    ev.stopPropagation();
    this.#svg.setPointerCapture(ev.pointerId);
    const fromWorld = this.#findPortWorldPosition(port.id, "output") ?? { x: 0, y: 0 };
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
    this.#render();
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = {
      kind: "pan",
      startScreen: this.#screenPoint(ev),
      startViewport: { ...this.#viewport },
    };
  }

  #onPointerMove(ev: PointerEvent) {
    if (!this.#drag) return;
    const current = this.#screenPoint(ev);

    if (this.#drag.kind === "pan") {
      const dx = current.x - this.#drag.startScreen.x;
      const dy = current.y - this.#drag.startScreen.y;
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

    const dxScreen = current.x - this.#drag.startScreen.x;
    const dyScreen = current.y - this.#drag.startScreen.y;
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
      this.#savePositions();
    } else if (this.#drag?.kind === "connect") {
      this.#finishConnect(ev);
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
