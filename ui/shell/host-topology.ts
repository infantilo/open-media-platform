// <omp-host-topology> — grafische Ansicht der Hosts und ihrer Verbindungen (Kapitel 54): Kästen = Hosts mit Auslastung und ihren
// Nodes, Linien = Verbindungen des Signalgraphen, die Hostgrenzen überschreiten. Daten: Signalgraph, Instanzen und die vom
// Hosts-Reiter übergebene Hostliste.
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import { buildTopology, layoutBoxes, levelOf, linkPath, strokeFor, type GraphEdgeIn, type GraphNodeIn, type InstanceIn, type TopoBox, type TopoHostIn } from "./host-topology-logic.ts";

const NS = "http://www.w3.org/2000/svg";
const POLL_MS = 10000;
const LEVEL_COLOR = { none: "var(--omp-border)", ok: "var(--omp-accent-cyan)", warn: "var(--omp-cue, #db3)", full: "var(--omp-error, #d44)" };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text = ""): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

export class HostTopology extends HTMLElement {
  #hosts: TopoHostIn[] = [];
  #nodes: GraphNodeIn[] = [];
  #edges: GraphEdgeIn[] = [];
  #instances: InstanceIn[] = [];
  #timer?: number;
  #selected = "";
  #onSelect?: (id: string) => void;

  /** Hostliste vom Hosts-Reiter (id "" = Orchestrator-Host). */
  set hosts(h: TopoHostIn[]) {
    this.#hosts = h;
    this.#render();
  }
  /** Wird mit der Host-ID aufgerufen, wenn ein Kasten angeklickt wird (z. B. um den Verlauf dieses Hosts zu zeigen). */
  set onSelect(f: (id: string) => void) {
    this.#onSelect = f;
  }
  set selected(id: string) {
    this.#selected = id;
    this.#render();
  }

  #ro?: ResizeObserver;

  // Der Hosts-Reiter zeichnet sich komplett neu und hängt dieses Element dabei jedes Mal um: Timer nur einmal anlegen und nur
  // abbauen, wenn es wirklich entfernt bleibt.
  connectedCallback() {
    this.style.cssText = "display:block;";
    if (this.#timer !== undefined) return;
    void this.#load();
    this.#timer = window.setInterval(() => void this.#load(), POLL_MS);
    this.#ro = new ResizeObserver(() => this.#render());
    this.#ro.observe(this);
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected || this.#timer === undefined) return;
      window.clearInterval(this.#timer);
      this.#timer = undefined;
      this.#ro?.disconnect();
    });
  }

  async #load() {
    try {
      const [g, i] = await Promise.all([apiFetch("/api/v1/graph"), apiFetch("/api/v1/instances")]);
      if (g.ok) {
        const graph = (await g.json()) as { nodes?: { id: string; label: string; instanceId?: string; health?: string; inputs?: { id: string }[]; outputs?: { id: string; format?: string }[] }[]; edges?: GraphEdgeIn[] };
        this.#nodes = (graph.nodes ?? []).map((n) => ({ id: n.id, label: n.label, instanceId: n.instanceId, health: n.health, inputs: n.inputs ?? [], outputs: n.outputs ?? [] }));
        this.#edges = graph.edges ?? [];
      }
      if (i.ok) this.#instances = ((await i.json()) as { id: string; hostId?: string }[]).map((x) => ({ id: x.id, hostId: x.hostId }));
      this.#render();
    } catch {
      /* nächster Poll */
    }
  }

  #render() {
    const topo = buildTopology(this.#hosts, this.#nodes, this.#edges, this.#instances);
    if (topo.boxes.length === 0) {
      this.replaceChildren(Object.assign(document.createElement("div"), { className: "omp-empty", textContent: t("topo.none") }));
      return;
    }
    const avail = Math.max(320, this.clientWidth || 900);
    const lay = layoutBoxes(topo.boxes.map((b) => b.id), avail - 24);
    const pad = 12;
    const root = svg("svg", { width: lay.width + 2 * pad, height: lay.height + 2 * pad, viewBox: `${-pad} ${-pad} ${lay.width + 2 * pad} ${lay.height + 2 * pad}`, role: "img", "aria-label": t("topo.title") });
    root.style.cssText = "display:block;max-width:100%;font-family:var(--omp-font);font-size:11px;";
    const defs = svg("defs");
    const marker = svg("marker", { id: "omp-topo-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--omp-text-dim)" }));
    defs.append(marker);
    root.append(defs);

    // Verbindungen zuerst (unter den Kästen)
    const hasReverse = (a: string, b: string) => topo.links.some((l) => l.from === b && l.to === a);
    for (const l of topo.links) {
      const a = lay.pos.get(l.from);
      const b = lay.pos.get(l.to);
      if (!a || !b) continue;
      const p = linkPath(a, b, hasReverse(l.from, l.to) ? 22 : 0);
      const g = svg("g");
      const title = svg("title", {}, t("topo.linkTitle", { p0: this.#label(topo.boxes, l.from), p1: this.#label(topo.boxes, l.to), p2: l.count, p3: l.kinds.join(", ") || "–" }));
      g.append(title, svg("path", { d: p.d, fill: "none", stroke: "var(--omp-text-dim)", "stroke-width": strokeFor(l.count), "stroke-opacity": 0.75, "marker-end": "url(#omp-topo-arrow)" }));
      const lbl = svg("g");
      lbl.append(svg("rect", { x: p.lx - 14, y: p.ly - 9, width: 28, height: 16, rx: 8, fill: "var(--omp-surface-raised)", stroke: "var(--omp-border)" }), svg("text", { x: p.lx, y: p.ly + 3, "text-anchor": "middle", fill: "var(--omp-text)" }, String(l.count)));
      g.append(lbl);
      root.append(g);
    }
    for (const b of topo.boxes) {
      const pos = lay.pos.get(b.id)!;
      root.append(this.#box(b, pos.x, pos.y, pos.w, pos.h));
    }
    const hint = Object.assign(document.createElement("div"), { textContent: t("topo.hint") });
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);margin-top:6px;";
    this.replaceChildren(root, hint);
  }

  #label(boxes: TopoBox[], id: string): string {
    const b = boxes.find((x) => x.id === id);
    return b ? this.#title(b) : id;
  }

  #title(b: TopoBox): string {
    if (b.id === "local") return t("topo.local");
    if (b.id === "extern") return t("topo.extern");
    return b.label || b.id;
  }

  #box(b: TopoBox, x: number, y: number, w: number, h: number): SVGGElement {
    const g = svg("g", { transform: `translate(${x},${y})`, "data-host": b.id });
    g.style.cursor = "pointer";
    const sel = this.#selected === (b.id === "local" ? "" : b.id) || this.#selected === b.id;
    g.append(svg("rect", { width: w, height: h, rx: 8, fill: "var(--omp-surface-raised)", stroke: sel ? "var(--omp-accent-cyan)" : "var(--omp-border)", "stroke-width": sel ? 2 : 1, opacity: b.online || b.id === "extern" ? 1 : 0.6 }));
    g.append(svg("circle", { cx: 14, cy: 16, r: 5, fill: b.maintenance ? "var(--omp-cue, #db3)" : b.online || b.id === "extern" ? "var(--omp-ok, #3a3)" : "var(--omp-error, #d44)" }));
    const title = svg("text", { x: 26, y: 20, fill: "var(--omp-text)", "font-weight": 700, "font-size": 13 }, this.#title(b));
    g.append(title);
    const status = !b.online && b.id !== "extern" ? t("topo.offline") : b.maintenance ? t("topo.maintenance") : "";
    if (status) g.append(svg("text", { x: w - 10, y: 20, "text-anchor": "end", fill: "var(--omp-text-dim)" }, status));
    // Auslastungsbalken: CPU mit Markierung der Live-Reserve, Speicher, GPU, Netz
    const bars: [string, number | undefined, number | undefined][] = [["CPU", b.cpu, b.liveReserveCpu !== undefined ? 100 * (1 - b.liveReserveCpu) : undefined], ["RAM", b.mem, undefined], ["GPU", b.gpu, undefined], ["NET", b.net, undefined]];
    let by = 34;
    for (const [name, val, limit] of bars) {
      if (val === undefined || (!b.online && b.id !== "extern")) continue;
      g.append(svg("text", { x: 10, y: by + 7, fill: "var(--omp-text-dim)", "font-size": 10 }, name));
      g.append(svg("rect", { x: 40, y: by, width: w - 90, height: 7, rx: 3, fill: "var(--omp-bg)", stroke: "var(--omp-border)" }));
      g.append(svg("rect", { x: 40, y: by, width: Math.max(0, Math.min(100, val)) / 100 * (w - 90), height: 7, rx: 3, fill: LEVEL_COLOR[levelOf(val, limit ?? 100)] }));
      if (limit !== undefined) g.append(svg("rect", { x: 40 + limit / 100 * (w - 90) - 1, y: by - 2, width: 2, height: 11, fill: "var(--omp-text)", opacity: 0.8 }, ""));
      g.append(svg("text", { x: w - 44, y: by + 7, fill: "var(--omp-text-dim)", "font-size": 10 }, `${Math.round(val)} %`));
      by += 13;
    }
    // Nodes
    const maxChips = 6;
    let ny = Math.max(by + 14, 78);
    for (const n of b.nodes.slice(0, maxChips)) {
      const ok = !n.health || n.health === "ok" || n.health === "healthy" || n.health === "";
      g.append(svg("circle", { cx: 16, cy: ny - 3, r: 3, fill: ok ? "var(--omp-ok, #3a3)" : "var(--omp-error, #d44)" }));
      g.append(svg("text", { x: 24, y: ny, fill: "var(--omp-text)" }, n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label));
      ny += 14;
    }
    if (b.nodes.length > maxChips) g.append(svg("text", { x: 24, y: ny, fill: "var(--omp-text-dim)" }, t("topo.more", { p0: b.nodes.length - maxChips })));
    const foot = [t("topo.nodes", { p0: b.nodes.length }), b.internal > 0 ? t("topo.internal", { p0: b.internal }) : "", b.jobs ? t("topo.jobs", { p0: b.jobs }) : ""].filter(Boolean).join(" · ");
    g.append(svg("text", { x: 10, y: h - 8, fill: "var(--omp-text-dim)", "font-size": 10 }, foot));
    g.addEventListener("click", () => {
      this.#selected = b.id === "local" ? "" : b.id;
      this.#onSelect?.(b.id === "extern" ? "" : b.id === "local" ? "" : b.id);
      this.#render();
    });
    g.append(svg("title", {}, `${this.#title(b)} — ${t("topo.nodes", { p0: b.nodes.length })}`));
    return g;
  }
}

customElements.define("omp-host-topology", HostTopology);
