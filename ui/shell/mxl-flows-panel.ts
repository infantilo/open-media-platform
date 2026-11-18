// Admin → MXL-Flows: die Flows der lokalen MXL-Domain mit Schreiber (Instanz, Programm, PID, Container) und
// Rest-Erkennung (Flow-Verzeichnis ohne Schreiber). Nur lesend; Datenquelle GET /api/v1/admin/mxl/flows.
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";

const REFRESH_MS = 5_000;

interface FlowRow {
  id: string;
  label?: string;
  format?: string;
  active: boolean;
  stale: boolean;
  sizeBytes: number;
  writers: { pid: number; cmd?: string; container?: string }[];
  instance?: string;
  instanceLabel?: string;
  instanceType?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export function formatName(f: string | undefined): string {
  return (f ?? "").replace("urn:x-nmos:format:", "") || "–";
}

export function humanSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

export function matchesFlow(r: FlowRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    r.id, r.label, r.format, r.instanceLabel, r.instanceType,
    ...r.writers.flatMap((w) => [String(w.pid), w.cmd, w.container]),
  ].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export class MxlFlowsPanel {
  readonly el: HTMLElement;
  #summary = el("div", "margin:4px 0 12px;color:var(--omp-text-dim);");
  #body = el("div");
  #search = el("input", "margin:0 0 10px;min-width:280px;");
  #rows: FlowRow[] = [];
  #domain = "";
  #timer: number | undefined;
  #seq = 0;

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:1100px;");
    const title = el("span", "", t("mxlflows.title"));
    title.className = "omp-h1";
    this.#search.type = "search";
    this.#search.className = "omp-input";
    this.#search.placeholder = t("mxlflows.search");
    this.#search.setAttribute("aria-label", t("mxlflows.search"));
    this.#search.addEventListener("input", () => this.#render());
    this.el.append(title, this.#summary, this.#search, this.#body);
  }

  start() {
    void this.refresh();
    if (this.#timer !== undefined) return;
    this.#timer = window.setInterval(() => {
      if (!this.el.isConnected) {
        window.clearInterval(this.#timer);
        this.#timer = undefined;
        return;
      }
      void this.refresh();
    }, REFRESH_MS);
  }

  async refresh() {
    const seq = ++this.#seq;
    try {
      const res = await apiFetch("/api/v1/admin/mxl/flows");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { domain: string; flows: FlowRow[] };
      if (seq !== this.#seq) return;
      this.#rows = data.flows ?? [];
      this.#domain = data.domain;
      this.#render();
    } catch {
      if (seq !== this.#seq) return;
      this.#summary.textContent = t("mxlflows.error");
    }
  }

  #render() {
    const rows = this.#rows;
    const stale = rows.filter((r) => r.stale);
    const shown = rows.filter((r) => matchesFlow(r, this.#search.value));
    this.#summary.textContent = t("mxlflows.summary", {
      domain: this.#domain,
      total: String(rows.length),
      stale: String(stale.length),
    });
    this.#body.replaceChildren();
    if (rows.length === 0) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", t("mxlflows.none")));
      return;
    }
    if (shown.length === 0) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", t("mxlflows.noMatch")));
      return;
    }
    const table = el("table", "border-collapse:collapse;width:100%;");
    const head = el("tr");
    for (const k of ["mxlflows.col.flow", "mxlflows.col.format", "mxlflows.col.status", "mxlflows.col.writer", "mxlflows.col.size"] as const) {
      head.append(el("th", "text-align:left;padding:4px 8px;border-bottom:1px solid var(--omp-border);", t(k)));
    }
    table.append(head);
    for (const r of shown) {
      const tr = el("tr");
      const cell = (txt: string, title = "", css = "") => {
        const td = el("td", "padding:4px 8px;border-bottom:1px solid var(--omp-border);" + css, txt);
        if (title) td.title = title;
        return td;
      };
      const status = r.stale
        ? cell(t("mxlflows.status.stale"), t("mxlflows.status.stale.hint"), "color:#e0a020;")
        : cell(t("mxlflows.status.active"));
      const writer = r.writers.length === 0
        ? "–"
        : r.writers
          .map((w) => {
            const owner = r.instanceLabel ? `${r.instanceLabel} · ` : "";
            const box = w.container ? ` · ${t("mxlflows.container")} ${w.container}` : "";
            return `${owner}${w.cmd || "?"} (PID ${w.pid})${box}`;
          })
          .join("\n");
      tr.append(
        cell(r.label || r.id.slice(0, 8), r.id),
        cell(formatName(r.format)),
        status,
        cell(writer.split("\n")[0] ?? "–", writer),
        cell(humanSize(r.sizeBytes)),
      );
      table.append(tr);
    }
    this.#body.append(table);
  }
}
