// Visueller Filter-Graph-Builder (UMSETZUNG.md Kapitel 22, W3) —
// funktionaler Modal-Baustein wie `process-step-config.ts::
// openStepConfigModal`, kein eigenes Custom Element (dieselbe
// Abwägung: ein spezialisierter Dialog, keine wiederverwendbare
// Komponente). Reine Darstellung/Interaktion; die eigentliche
// Compile-Logik (Graph → `-filter_complex`-Zeichenkette) liegt DOM-frei
// in `filter-graph-logic.ts`.
//
// Architekturentscheidung (ARCHITECTURE.md §26.3): Pan/Zoom- und
// Port-Layout-Mathematik aus `geometry.ts` wiederverwendet (bereits
// zweimal für `flow-canvas.ts`/`role-designer.ts` genutzt) statt einer
// neuen Zeichenbibliothek — Filter-Pads sind strukturell dasselbe wie
// NMOS-Sender/Receiver-Ports (mehrere benannte Ein-/Ausgänge je
// Kachel), nur die Bedeutung ist eine andere.
import {
  arrangeByFlow,
  type ArrangeEdge,
  type ArrangeNode,
  HEADER_HEIGHT,
  IDENTITY_VIEWPORT,
  NODE_WIDTH,
  nodeHeight as portNodeHeight,
  type Point,
  portPosition,
  screenToWorld,
  type Viewport,
  zoomAt,
} from "./geometry.ts";
import { fetchFFmpegDetail, fetchFFmpegList } from "./ffmpeg-client.ts";
import type { FFFilterEntry, FFOption } from "./process-step-config-logic.ts";
import {
  compileFilterGraph,
  type FilterGraph,
  type GraphEdge,
  type GraphNode,
  nodePadCounts,
  parseFilterIO,
} from "./filter-graph-logic.ts";
import { showToast } from "../kit/omp-toast.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}
function h<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const INPUT_OUTPUT_BODY_HEIGHT = 44;
const FILTER_BODY_HEIGHT = 170;
const DRAG_THRESHOLD_PX = 3;

function bodyHeightFor(node: GraphNode): number {
  return node.kind === "filter" ? FILTER_BODY_HEIGHT : INPUT_OUTPUT_BODY_HEIGHT;
}

function totalHeightFor(node: GraphNode): number {
  const { inputs, outputs } = nodePadCounts(node);
  return Math.max(HEADER_HEIGHT + bodyHeightFor(node), portNodeHeight(inputs, outputs));
}

type DragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport }
  | { kind: "tile"; id: string; startScreen: Point; startWorld: Point }
  | { kind: "connect"; fromNode: string; fromPort: number; fromWorld: Point; currentScreen: Point };

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export function openFilterGraphEditor(
  host: HTMLElement,
  initialGraph: FilterGraph | null,
  initialPositions: Record<string, Point> | null,
  onApply: (graph: FilterGraph, positions: Record<string, Point>, filterComplex: string, outputLabels: string[]) => void,
) {
  let nodes: GraphNode[] = initialGraph ? initialGraph.nodes.map((n) => ({ ...n, options: { ...n.options } })) : [];
  let edges: GraphEdge[] = initialGraph ? initialGraph.edges.map((e) => ({ ...e })) : [];
  const positions: Record<string, Point> = initialPositions ? { ...initialPositions } : {};
  const optionDefs = new Map<string, FFOption[]>(); // nodeId -> AVOptions-Definitionen (fürs Rendern der Felder)
  let viewport: Viewport = { ...IDENTITY_VIEWPORT };
  let drag: DragState | null = null;

  const overlay = h("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.cssText = "z-index:2200;";
  const panel = h("div", "width:94vw;height:88vh;max-width:1400px;display:flex;flex-direction:column;padding:0;overflow:hidden;");
  panel.className = "omp-modal";
  panel.setAttribute("data-role", "filter-graph-editor");

  const toolbar = h("div", "display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--omp-border);flex-shrink:0;");
  const title = h("div", "font-weight:600;flex:1;", "Filter-Kette bearbeiten");
  const arrangeBtn = h("button", "", "Automatisch anordnen");
  arrangeBtn.type = "button";
  const cancelBtn = h("button", "", "Abbrechen");
  cancelBtn.type = "button";
  const applyBtn = h("button", "", "Übernehmen");
  applyBtn.type = "button";
  applyBtn.className = "omp-btn-primary";
  applyBtn.setAttribute("data-role", "filter-graph-apply");
  toolbar.append(title, arrangeBtn, cancelBtn, applyBtn);

  const body = h("div", "flex:1;display:flex;min-height:0;");
  const palette = h("div", "width:220px;flex-shrink:0;border-right:1px solid var(--omp-border);padding:8px;overflow-y:auto;box-sizing:border-box;");
  const canvasWrap = h("div", "flex:1;position:relative;overflow:hidden;background:#1e1e1e;");
  body.append(palette, canvasWrap);

  const svg = svgEl("svg");
  svg.setAttribute("data-role", "filter-graph-canvas");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;touch-action:none;";
  const viewportGroup = svgEl("g");
  svg.appendChild(viewportGroup);
  canvasWrap.appendChild(svg);

  panel.append(toolbar, body);
  overlay.appendChild(panel);

  // ---- Palette --------------------------------------------------------

  const addInputBtn = h("button", "width:100%;margin-bottom:4px;", "+ Eingang");
  addInputBtn.type = "button";
  addInputBtn.addEventListener("click", () => {
    const id = nextId("in");
    nodes.push({ id, kind: "input", label: "0:v" });
    positions[id] = defaultNodePosition();
    render();
  });
  const addOutputBtn = h("button", "width:100%;margin-bottom:8px;", "+ Ausgang");
  addOutputBtn.type = "button";
  addOutputBtn.addEventListener("click", () => {
    const id = nextId("out");
    const n = nodes.filter((x) => x.kind === "output").length + 1;
    nodes.push({ id, kind: "output", label: `Ausgang ${n}` });
    positions[id] = defaultNodePosition();
    render();
  });
  const filterSearch = h("input", "width:100%;box-sizing:border-box;margin-bottom:4px;");
  filterSearch.placeholder = "Filter suchen …";
  const filterList = h("div", "max-height:none;");
  let allFilters: FFFilterEntry[] = [];
  const renderFilterList = () => {
    filterList.replaceChildren();
    const q = filterSearch.value.trim().toLowerCase();
    const shown = (q ? allFilters.filter((f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)) : allFilters).slice(0, 60);
    for (const f of shown) {
      const item = h("div", "padding:3px 4px;cursor:pointer;border-radius:3px;font-size:11px;");
      item.title = f.description;
      item.textContent = `${f.name} (${f.io})`;
      item.addEventListener("mouseenter", () => (item.style.background = "var(--omp-surface-raised)"));
      item.addEventListener("mouseleave", () => (item.style.background = ""));
      item.addEventListener("click", () => addFilterNode(f));
      filterList.appendChild(item);
    }
    if (shown.length === 0) filterList.appendChild(h("div", "font-size:11px;color:var(--omp-text-dim);", q ? "Kein Filter passt." : "lade Filter …"));
  };
  filterSearch.addEventListener("input", renderFilterList);
  (async () => {
    allFilters = await fetchFFmpegList<FFFilterEntry>("filters");
    renderFilterList();
  })();
  palette.append(
    h("div", "font-weight:600;font-size:12px;margin-bottom:4px;", "Bausteine"),
    addInputBtn,
    addOutputBtn,
    h("div", "font-size:11px;color:var(--omp-text-dim);margin:6px 0 2px;", "Filter (aus echter ffmpeg-Liste):"),
    filterSearch,
    filterList,
  );

  function defaultNodePosition(): Point {
    const used = Object.values(positions);
    let x = 40;
    let y = 40;
    // simple Kaskade, damit neue Knoten nicht exakt übereinander landen.
    x += (nodes.length % 6) * 30;
    y += Math.floor(nodes.length / 6) * 30;
    void used;
    return { x, y };
  }

  function addFilterNode(f: FFFilterEntry) {
    const id = nextId("f");
    const node: GraphNode = { id, kind: "filter", filterName: f.name, filterIO: f.io, options: {} };
    const shape = parseFilterIO(f.io);
    if (shape.inputs.dynamic) node.inputCount = 2;
    if (shape.outputs.dynamic) node.outputCount = 2;
    nodes.push(node);
    positions[id] = defaultNodePosition();
    render();
    (async () => {
      const detail = await fetchFFmpegDetail("filter", f.name);
      optionDefs.set(id, detail?.options ?? []);
      render();
    })();
  }

  // ---- Rendering --------------------------------------------------------

  function removeNode(id: string) {
    nodes = nodes.filter((n) => n.id !== id);
    edges = edges.filter((e) => e.fromNode !== id && e.toNode !== id);
    delete positions[id];
    optionDefs.delete(id);
    render();
  }

  function portScreenPos(nodeId: string, side: "input" | "output", index: number): Point | null {
    const node = nodes.find((n) => n.id === nodeId);
    const pos = positions[nodeId];
    if (!node || !pos) return null;
    const { inputs, outputs } = nodePadCounts(node);
    const count = side === "input" ? inputs : outputs;
    if (count === 0) return null;
    return portPosition(pos.x, pos.y, totalHeightFor(node), index, count, side);
  }

  function renderNode(node: GraphNode): SVGGElement {
    const pos = positions[node.id] ?? { x: 40, y: 40 };
    positions[node.id] = pos;
    const height = totalHeightFor(node);
    const g = svgEl("g");
    g.setAttribute("data-role", "filter-graph-node");
    g.setAttribute("data-node-id", node.id);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const headerColor = node.kind === "input" ? "#4a7d4a" : node.kind === "output" ? "#7d4a4a" : "#3a5a7d";
    const bodyRect = svgEl("rect");
    bodyRect.setAttribute("width", String(NODE_WIDTH));
    bodyRect.setAttribute("height", String(height));
    bodyRect.setAttribute("rx", "4");
    bodyRect.setAttribute("fill", "#2a2a2a");
    bodyRect.setAttribute("stroke", "#555");
    g.appendChild(bodyRect);

    const header = svgEl("rect");
    header.setAttribute("width", String(NODE_WIDTH));
    header.setAttribute("height", String(HEADER_HEIGHT));
    header.setAttribute("rx", "4");
    header.setAttribute("fill", headerColor);
    header.style.cursor = "move";
    header.addEventListener("pointerdown", (ev) => onTilePointerDown(ev, node.id));
    g.appendChild(header);

    const label = svgEl("text");
    label.setAttribute("x", "6");
    label.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    label.setAttribute("fill", "#fff");
    label.setAttribute("font-size", "11");
    label.style.pointerEvents = "none";
    label.textContent = node.kind === "filter" ? (node.filterName ?? "") : node.kind === "input" ? "Eingang" : "Ausgang";
    g.appendChild(label);

    const rm = svgEl("text");
    rm.setAttribute("x", String(NODE_WIDTH - 14));
    rm.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    rm.setAttribute("fill", "#fff");
    rm.setAttribute("font-size", "12");
    rm.style.cursor = "pointer";
    rm.textContent = "✕";
    rm.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    rm.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeNode(node.id);
    });
    g.appendChild(rm);

    // Body: echte HTML-Formularfelder per foreignObject statt SVG-Text-
    // Editing — deutlich einfacher korrekt umzusetzen als ein eigenes
    // SVG-Inline-Editier-System, und der Nutzer bekommt vertraute
    // <input>/<select>-Steuerelemente.
    const fo = svgEl("foreignObject");
    fo.setAttribute("x", "4");
    fo.setAttribute("y", String(HEADER_HEIGHT + 2));
    fo.setAttribute("width", String(NODE_WIDTH - 8));
    fo.setAttribute("height", String(height - HEADER_HEIGHT - 4));
    const fowrap = h("div", "font-size:10px;color:#ddd;height:100%;overflow-y:auto;box-sizing:border-box;");
    fowrap.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    if (node.kind === "input" || node.kind === "output") {
      const li = h("input", "width:100%;box-sizing:border-box;font-size:10px;");
      li.value = node.label ?? "";
      li.placeholder = node.kind === "input" ? "z. B. 0:v" : "Name (optional)";
      li.addEventListener("input", () => {
        node.label = li.value;
        renderEdgesOnly();
      });
      fowrap.appendChild(li);
    } else {
      const shape = parseFilterIO(node.filterIO ?? "");
      if (shape.inputs.dynamic) {
        const row = h("div", "display:flex;align-items:center;gap:3px;margin-bottom:2px;");
        row.append(h("span", "", "Eingänge:"));
        const n = h("input", "width:36px;");
        n.type = "number";
        n.min = "1";
        n.value = String(node.inputCount ?? 2);
        n.addEventListener("input", () => {
          node.inputCount = Math.max(1, Number(n.value) || 1);
          render();
        });
        row.appendChild(n);
        fowrap.appendChild(row);
      }
      if (shape.outputs.dynamic) {
        const row = h("div", "display:flex;align-items:center;gap:3px;margin-bottom:2px;");
        row.append(h("span", "", "Ausgänge:"));
        const n = h("input", "width:36px;");
        n.type = "number";
        n.min = "1";
        n.value = String(node.outputCount ?? 2);
        n.addEventListener("input", () => {
          node.outputCount = Math.max(1, Number(n.value) || 1);
          render();
        });
        row.appendChild(n);
        fowrap.appendChild(row);
      }
      const defs = optionDefs.get(node.id);
      if (defs === undefined) {
        fowrap.appendChild(h("div", "color:#999;", "lade Optionen …"));
      } else {
        for (const opt of defs) {
          const row = h("div", "margin-bottom:2px;");
          const lbl = h("div", "color:#aaa;", opt.name);
          row.appendChild(lbl);
          let input: HTMLInputElement | HTMLSelectElement;
          if (opt.choices && opt.choices.length > 0) {
            input = h("select", "width:100%;font-size:10px;");
            input.appendChild(new Option("– Standard –", ""));
            for (const c of opt.choices) input.appendChild(new Option(c.name, c.value || c.name));
          } else {
            input = h("input", "width:100%;box-sizing:border-box;font-size:10px;");
            input.placeholder = opt.default ? `Standard: ${opt.default}` : "";
          }
          input.value = node.options?.[opt.name] ?? "";
          input.title = opt.description ?? "";
          input.addEventListener("input", () => {
            node.options = { ...node.options, [opt.name]: (input as HTMLInputElement).value };
          });
          input.addEventListener("change", () => {
            node.options = { ...node.options, [opt.name]: (input as HTMLInputElement).value };
          });
          row.appendChild(input);
          fowrap.appendChild(row);
        }
        if (defs.length === 0) fowrap.appendChild(h("div", "color:#999;", "keine Optionen"));
      }
    }
    fo.appendChild(fowrap);
    g.appendChild(fo);

    // Ports.
    const { inputs, outputs } = nodePadCounts(node);
    for (let i = 0; i < inputs; i++) {
      const p = portPosition(0, 0, height, i, inputs, "input");
      g.appendChild(renderPort(node.id, "input", i, p));
    }
    for (let o = 0; o < outputs; o++) {
      const p = portPosition(0, 0, height, o, outputs, "output");
      g.appendChild(renderPort(node.id, "output", o, p));
    }

    return g;
  }

  function renderPort(nodeId: string, side: "input" | "output", index: number, pos: Point): SVGCircleElement {
    const c = svgEl("circle");
    c.setAttribute("cx", String(pos.x));
    c.setAttribute("cy", String(pos.y));
    c.setAttribute("r", "5");
    c.setAttribute("fill", side === "input" ? "#e0c05b" : "#5b9bd5");
    c.setAttribute("data-role", "filter-port");
    c.setAttribute("data-node-id", nodeId);
    c.setAttribute("data-side", side);
    c.setAttribute("data-index", String(index));
    c.style.cursor = side === "output" ? "crosshair" : "default";
    if (side === "output") {
      c.addEventListener("pointerdown", (ev) => onOutputPortPointerDown(ev, nodeId, index));
    }
    return c;
  }

  function renderEdge(edge: GraphEdge): SVGLineElement | null {
    const from = portScreenPos(edge.fromNode, "output", edge.fromPort);
    const to = portScreenPos(edge.toNode, "input", edge.toPort);
    if (!from || !to) return null;
    const line = svgEl("line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", "#aaa");
    line.setAttribute("stroke-width", "6");
    line.setAttribute("stroke-opacity", "0.01"); // breiter, fast unsichtbarer Klick-Hitbereich
    line.style.cursor = "pointer";
    line.addEventListener("click", () => {
      edges = edges.filter((e) => e.id !== edge.id);
      render();
    });
    const visible = svgEl("line");
    visible.setAttribute("x1", String(from.x));
    visible.setAttribute("y1", String(from.y));
    visible.setAttribute("x2", String(to.x));
    visible.setAttribute("y2", String(to.y));
    visible.setAttribute("stroke", "#888");
    visible.setAttribute("stroke-width", "2");
    visible.style.pointerEvents = "none";
    const group = svgEl("g");
    group.append(visible, line);
    return group as unknown as SVGLineElement;
  }

  function renderEdgesOnly() {
    // Für reine Label-Änderungen (Eingang/Ausgang-Text) reicht ein
    // Voll-Render — Kanten selbst hängen nicht am Label, aber ein
    // gezielteres Teil-Rendering lohnt sich hier nicht (kleine Graphen).
    render();
  }

  function render() {
    viewportGroup.replaceChildren();
    viewportGroup.setAttribute("transform", `translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`);
    for (const e of edges) {
      const el = renderEdge(e);
      if (el) viewportGroup.appendChild(el);
    }
    for (const n of nodes) viewportGroup.appendChild(renderNode(n));
    if (drag?.kind === "connect") {
      const line = svgEl("line");
      const to = screenToWorldLocal(drag.currentScreen);
      line.setAttribute("x1", String(drag.fromWorld.x));
      line.setAttribute("y1", String(drag.fromWorld.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("stroke", "#5b9bd5");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("stroke-dasharray", "4,3");
      line.style.pointerEvents = "none";
      viewportGroup.appendChild(line);
    }
  }

  // ---- Pan/Zoom/Drag ------------------------------------------------------

  function screenPoint(ev: MouseEvent): Point {
    const rect = svg.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function screenToWorldLocal(p: Point): Point {
    return screenToWorld(p, viewport);
  }

  svg.addEventListener("pointerdown", (ev) => {
    if (drag) return;
    svg.setPointerCapture(ev.pointerId);
    drag = { kind: "pan", startScreen: screenPoint(ev), startViewport: { ...viewport } };
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const current = screenPoint(ev);
    if (drag.kind === "pan") {
      viewport = { x: drag.startViewport.x + (current.x - drag.startScreen.x), y: drag.startViewport.y + (current.y - drag.startScreen.y), scale: drag.startViewport.scale };
      render();
      return;
    }
    if (drag.kind === "connect") {
      drag = { ...drag, currentScreen: current };
      render();
      return;
    }
    const dx = current.x - drag.startScreen.x;
    const dy = current.y - drag.startScreen.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    positions[drag.id] = { x: drag.startWorld.x + dx / viewport.scale, y: drag.startWorld.y + dy / viewport.scale };
    render();
  });
  svg.addEventListener("pointerup", (ev) => {
    if (drag?.kind === "connect") finishConnect(ev);
    drag = null;
  });
  svg.addEventListener("pointercancel", () => (drag = null));
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    viewport = zoomAt(viewport, screenPoint(ev), ev.deltaY < 0 ? 1.1 : 1 / 1.1);
    render();
  }, { passive: false });

  function onTilePointerDown(ev: PointerEvent, id: string) {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    drag = { kind: "tile", id, startScreen: screenPoint(ev), startWorld: positions[id] ?? { x: 0, y: 0 } };
  }

  function onOutputPortPointerDown(ev: PointerEvent, nodeId: string, index: number) {
    ev.stopPropagation();
    svg.setPointerCapture(ev.pointerId);
    const world = portScreenPos(nodeId, "output", index) ?? { x: 0, y: 0 };
    drag = { kind: "connect", fromNode: nodeId, fromPort: index, fromWorld: world, currentScreen: screenPoint(ev) };
    render();
  }

  function finishConnect(ev: PointerEvent) {
    if (drag?.kind !== "connect") return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const portEl = target?.closest('[data-role="filter-port"][data-side="input"]');
    const toNode = portEl?.getAttribute("data-node-id");
    const toPort = portEl ? Number(portEl.getAttribute("data-index")) : NaN;
    if (!toNode || toNode === drag.fromNode || Number.isNaN(toPort)) {
      render();
      return;
    }
    // Ein Eingangs-Pad akzeptiert nur EINE Quelle — eine vorhandene
    // Verbindung dorthin wird beim Neuverbinden ersetzt, nicht addiert.
    edges = edges.filter((e) => !(e.toNode === toNode && e.toPort === toPort));
    edges.push({ id: nextId("e"), fromNode: drag.fromNode, fromPort: drag.fromPort, toNode, toPort });
    render();
  }

  // ---- Toolbar-Aktionen ---------------------------------------------------

  arrangeBtn.addEventListener("click", () => {
    const arrangeNodes: ArrangeNode[] = nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: totalHeightFor(n) }));
    const arrangeEdges: ArrangeEdge[] = edges.map((e) => ({ from: e.fromNode, to: e.toNode }));
    const newPositions = arrangeByFlow(arrangeNodes, arrangeEdges);
    for (const [id, p] of Object.entries(newPositions)) positions[id] = p;
    render();
  });
  cancelBtn.addEventListener("click", () => overlay.remove());
  applyBtn.addEventListener("click", () => {
    const graph: FilterGraph = { nodes, edges };
    const result = compileFilterGraph(graph);
    if (!result.ok) {
      showToast(result.error, { variant: "error" });
      return;
    }
    onApply(graph, positions, result.result.filterComplex, result.result.outputLabels);
    overlay.remove();
  });
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  host.appendChild(overlay);
  render();
}
