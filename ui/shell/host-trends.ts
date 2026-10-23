// <omp-host-trends> — Verlaufsdiagramme der Hosts (Kapitel 54): CPU, RAM, Live-Anteil der Nodes, GPU und Netz über 1 h bis 30 Tage.
// Linie = Mittelwert, Band = bis zur Spitze; bei CPU die Grenze, ab der Jobs nicht mehr starten (Live-Reserve).
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import { chartPaths, hasData, METRICS, nearest, series, WINDOWS, yMax, type HistoryWindowIn, type Metric } from "./host-trend-logic.ts";

const NS = "http://www.w3.org/2000/svg";
const W = 760;
const H = 200;

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text = ""): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

export interface TrendHost { id: string; label: string; cores?: number; reserveCpu?: number }

export class HostTrends extends HTMLElement {
  #hosts: TrendHost[] = [];
  #host = "local";
  #metric: Metric = "cpu";
  #win = "24h";
  #data: HistoryWindowIn | null = null;
  #timer?: number;
  #seq = 0;

  set hosts(h: TrendHost[]) {
    this.#hosts = h;
    if (!h.some((x) => x.id === this.#host) && h.length > 0) this.#host = h[0].id;
    this.#renderControls();
    this.#draw();
  }

  /** Host von außen wählen (Klick im Topologie-Diagramm). "" = Orchestrator-Host. */
  select(id: string) {
    this.#host = id === "" ? "local" : id;
    this.#renderControls();
    void this.#load();
  }

  // Umhängen durch den Hosts-Reiter darf weder Timer verdoppeln noch den Zustand verlieren (s. host-topology.ts).
  connectedCallback() {
    this.style.cssText = "display:block;";
    if (this.#timer !== undefined) return;
    this.#renderControls();
    void this.#load();
    this.#timer = window.setInterval(() => void this.#load(), 30000);
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected || this.#timer === undefined) return;
      window.clearInterval(this.#timer);
      this.#timer = undefined;
    });
  }

  #controls!: HTMLDivElement;
  #chart!: HTMLDivElement;

  #renderControls() {
    if (!this.#controls) {
      this.#controls = document.createElement("div");
      this.#controls.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;";
      this.#chart = document.createElement("div");
      this.append(this.#controls, this.#chart);
    }
    const mk = (label: string, active: boolean, on: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "font-size:var(--omp-font-size-xs);" + (active ? "background:var(--omp-surface);border-color:var(--omp-accent-cyan);" : "");
      b.addEventListener("click", on);
      return b;
    };
    const host = document.createElement("select");
    host.setAttribute("aria-label", t("trend.host"));
    for (const h of this.#hosts) host.append(new Option(h.id === "local" ? t("topo.local") : h.label || h.id, h.id, false, h.id === this.#host));
    host.addEventListener("change", () => { this.#host = host.value; void this.#load(); });
    const metrics = document.createElement("span");
    metrics.style.cssText = "display:flex;gap:4px;";
    for (const m of METRICS) metrics.append(mk(t(`trend.metric.${m}`), m === this.#metric, () => { this.#metric = m; this.#renderControls(); this.#draw(); }));
    const wins = document.createElement("span");
    wins.style.cssText = "display:flex;gap:4px;";
    for (const w of WINDOWS) wins.append(mk(w.id, w.id === this.#win, () => { this.#win = w.id; this.#renderControls(); void this.#load(); }));
    this.#controls.replaceChildren(host, metrics, wins);
  }

  async #load() {
    const seq = ++this.#seq;
    const w = WINDOWS.find((x) => x.id === this.#win) ?? WINDOWS[2];
    try {
      const r = await apiFetch(`/api/v1/hosts/${encodeURIComponent(this.#host)}/metrics/history?window=${w.query}`);
      if (seq !== this.#seq) return;
      this.#data = r.ok ? ((await r.json()) as HistoryWindowIn) : null;
    } catch {
      this.#data = null;
    }
    this.#draw();
  }

  #draw() {
    if (!this.#chart) return;
    const host = this.#hosts.find((h) => h.id === this.#host);
    const percent = this.#metric !== "live" || !!host?.cores;
    const pts = series(this.#data, this.#metric, host?.cores);
    if (pts.length < 2 || !hasData(pts)) {
      const d = document.createElement("div");
      d.className = "omp-empty";
      d.textContent = t(pts.length < 2 ? "trend.collecting" : "trend.noData");
      this.#chart.replaceChildren(d);
      return;
    }
    const ymax = yMax(pts, percent);
    const c = chartPaths(pts, W, H, ymax);
    const root = s("svg", { viewBox: `-38 -8 ${W + 50} ${H + 34}`, width: "100%", role: "img", "aria-label": t(`trend.metric.${this.#metric}`) });
    root.style.cssText = "display:block;max-width:900px;font-family:var(--omp-font);font-size:10px;";
    for (const f of [0, 0.5, 1]) {
      const y = H - f * H;
      root.append(s("line", { x1: 0, x2: W, y1: y, y2: y, stroke: "var(--omp-border)", "stroke-dasharray": f === 0 ? "" : "3 3" }));
      root.append(s("text", { x: -6, y: y + 3, "text-anchor": "end", fill: "var(--omp-text-dim)" }, `${(ymax * f).toFixed(ymax <= 1 ? 1 : 0)}${percent ? " %" : ""}`));
    }
    root.append(s("path", { d: c.band, fill: "var(--omp-accent-cyan)", opacity: 0.22 }));
    root.append(s("path", { d: c.line, fill: "none", stroke: "var(--omp-accent-cyan)", "stroke-width": 1.6 }));
    if (this.#metric === "cpu" && host?.reserveCpu !== undefined) {
      const lim = 100 * (1 - host.reserveCpu);
      if (lim < ymax) {
        const y = H - (lim / ymax) * H;
        root.append(s("line", { x1: 0, x2: W, y1: y, y2: y, stroke: "var(--omp-error, #d44)", "stroke-dasharray": "5 3" }));
        root.append(s("text", { x: W, y: y - 3, "text-anchor": "end", fill: "var(--omp-error, #d44)" }, t("trend.reserveLimit", { p0: Math.round(lim) })));
      }
    }
    const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    root.append(s("text", { x: 0, y: H + 14, fill: "var(--omp-text-dim)" }, fmt(c.x0)), s("text", { x: W, y: H + 14, "text-anchor": "end", fill: "var(--omp-text-dim)" }, fmt(c.x1)));
    const tip = s("g", { visibility: "hidden" });
    const dot = s("circle", { r: 3.5, fill: "var(--omp-text)" });
    const label = s("text", { y: -2, fill: "var(--omp-text)" });
    tip.append(dot, label);
    root.append(tip);
    const overlay = s("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
    overlay.addEventListener("mousemove", (ev) => {
      const r = root.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * (W + 50) - 38;
      const p = nearest(pts, Math.max(0, Math.min(W, x)), W);
      if (!p) return;
      const px = ((p.t - c.x0) / Math.max(1, c.x1 - c.x0)) * W;
      const py = H - (Math.min(p.avg, ymax) / ymax) * H;
      dot.setAttribute("cx", String(px));
      dot.setAttribute("cy", String(py));
      label.setAttribute("x", String(Math.min(W - 150, px + 8)));
      label.setAttribute("y", String(Math.max(12, py - 8)));
      label.textContent = `${fmt(p.t)} · Ø ${p.avg.toFixed(1)} · ${t("trend.peak")} ${p.max.toFixed(1)}${percent ? " %" : ""}`;
      tip.setAttribute("visibility", "visible");
    });
    overlay.addEventListener("mouseleave", () => tip.setAttribute("visibility", "hidden"));
    root.append(overlay);
    const note = document.createElement("div");
    note.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);margin-top:4px;";
    note.textContent = t(`trend.note.${this.#metric}`);
    this.#chart.replaceChildren(root, note);
  }
}

customElements.define("omp-host-trends", HostTrends);
