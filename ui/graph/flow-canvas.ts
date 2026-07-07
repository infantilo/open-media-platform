// <omp-flow-canvas>: rendert /api/v1/graph als SVG-Kacheln mit Pan/Zoom
// und verschiebbaren Nodes (UMSETZUNG.md B2). Reine Koordinatenlogik
// steckt in geometry.ts (dort per `deno test` geprüft) — dieses Modul
// bindet sie nur an DOM-/Fetch-/Storage-APIs.

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

const SVG_NS = "http://www.w3.org/2000/svg";
const POSITIONS_STORAGE_KEY = "omp-flow-positions";

interface GraphPort {
  id: string;
  label: string;
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

type DragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport }
  | { kind: "node"; nodeId: string; startScreen: Point; startWorld: Point };

export class FlowCanvas extends HTMLElement {
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #positions: Record<string, Point> = {};
  #graph: Graph = { nodes: [], edges: [] };
  #drag: DragState | null = null;

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;

  connectedCallback() {
    this.#loadPositions();
    this.#buildSkeleton();
    this.#fetchAndRender();
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

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(height));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", "#2d2d2d");
    body.setAttribute("stroke", healthColor(node.health));
    body.setAttribute("stroke-width", "2");
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
      g.appendChild(this.#renderPort(port, i, node.inputs.length, "input", pos, height));
    });
    node.outputs.forEach((port, i) => {
      g.appendChild(this.#renderPort(port, i, node.outputs.length, "output", pos, height));
    });

    g.addEventListener("pointerdown", (ev) => this.#onNodePointerDown(ev, node.id));

    return g;
  }

  #renderPort(
    port: GraphPort,
    index: number,
    count: number,
    side: "input" | "output",
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
    const titleEl = document.createElementNS(SVG_NS, "title");
    titleEl.textContent = port.label;
    circle.appendChild(titleEl);
    return circle;
  }

  #renderEdge(edge: GraphEdge): SVGPathElement | null {
    const from = this.#findPortWorldPosition(edge.fromSender, "output");
    const to = this.#findPortWorldPosition(edge.toReceiver, "input");
    if (!from || !to) return null;

    const midX = (from.x + to.x) / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", edge.state === "active" ? "#e0a030" : "#666");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("data-role", "edge");
    path.setAttribute("data-id", edge.id);
    return path;
  }

  #findPortWorldPosition(portId: string, side: "input" | "output"): Point | null {
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

  #onPointerDown(ev: PointerEvent) {
    if (this.#drag) return;
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

  #onPointerUp(_ev: PointerEvent) {
    if (this.#drag?.kind === "node") {
      this.#savePositions();
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
