// Betrachter für die Auswertung eines Support-Pakets / einer Momentaufnahme (UMSETZUNG.md Kap. 73): Befunde, Ausfälle, Zeitleiste, Kurven, Logs.
import { t } from "./i18n.ts";

export interface AnFinding { level: "err" | "warn" | "info"; source: string; title: string; detail?: string; fix?: string; at?: string; subject?: string }
export interface AnEvent { at: string; source: string; kind: string; severity: string; subject?: string; text?: string }
export interface AnSeries { group: string; id: string; label: string; metric: string; unit?: string; points: { t: number; v: number }[]; min: number; max: number; avg: number; first: number; last: number; flag?: string }
export interface AnOutage { id: string; label: string; from: string; to: string; seconds: number; open?: boolean }
export interface AnLogGroup { level: string; source: string; message: string; code?: string; count: number; first: string; last: string }
export interface AnReport {
  kind: "bundle" | "freeze"; title: string; from?: string; to?: string; trigger?: string; reason?: string; note?: string;
  verdict: "ok" | "warn" | "err"; summary: string; findings: AnFinding[]; outages?: AnOutage[]; timeline?: AnEvent[];
  series?: AnSeries[]; logGroups?: AnLogGroup[]; pipelines?: string[]; version?: string; files: string[];
}

const COLORS = { ok: "#3fb950", warn: "#e0a020", err: "#e5534b", info: "var(--omp-text-dim)" } as const;
const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export function fmtValue(v: number, unit?: string): string {
  if (unit === "B") {
    const u = ["B", "KiB", "MiB", "GiB"];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  return unit === "%" ? `${v.toFixed(0)} %` : String(Math.round(v * 10) / 10);
}

/** Linie einer Messreihe als SVG-Pfad; liegt `from..to` (ms) auf der x-Achse, damit mehrere Kurven zeitgleich laufen. */
export function linePath(pts: { t: number; v: number }[], from: number, to: number, lo: number, hi: number, W: number, H: number): string {
  if (pts.length === 0 || to <= from) return "";
  const span = hi - lo || 1;
  return pts.map((p, i) => `${i ? "L" : "M"}${(((p.t - from) / (to - from)) * W).toFixed(1)},${(H - ((p.v - lo) / span) * (H - 4) - 2).toFixed(1)}`).join("");
}

function chart(s: AnSeries, from: number, to: number): SVGElement {
  const W = 420, H = 48, ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.style.cssText = "background:var(--omp-surface);border-radius:4px;";
  const lo = s.metric === "ready" || s.unit === "%" ? 0 : Math.min(s.min, 0);
  const hi = s.metric === "ready" ? 1 : s.unit === "%" ? 100 : s.max;
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", linePath(s.points, from, to, lo, hi, W, H));
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", s.flag ? COLORS.warn : "var(--omp-accent,#4c9aff)");
  p.setAttribute("stroke-width", "1.5");
  svg.append(p);
  return svg;
}

function section(title: string, count?: number): HTMLDetailsElement {
  const d = el("details", "margin-top:10px;");
  d.append(el("summary", "cursor:pointer;font-weight:600;", count === undefined ? title : `${title} (${count})`));
  return d;
}

const time = (s?: string) => (s && Date.parse(s) > 0 ? new Date(s).toLocaleString() : "-");

/** Baut die Ansicht für einen Bericht. */
export function renderAnalysis(r: AnReport): HTMLElement {
  const root = el("div", "margin-top:10px;");
  root.setAttribute("data-testid", "analysis");
  const head = el("div", `border-left:4px solid ${COLORS[r.verdict]};padding:4px 10px;`);
  head.append(el("div", "font-weight:600;", `${r.title}: ${r.summary}`));
  head.append(el("div", DIM, `${time(r.from)} … ${time(r.to)}${r.version ? " · " + r.version : ""}${r.trigger ? " · " + r.trigger : ""}${r.reason ? " — " + r.reason : ""}${r.note ? " — " + r.note : ""}`));
  root.append(head);

  for (const f of r.findings ?? []) {
    const c = el("div", `margin-top:6px;padding:6px 10px;border-left:3px solid ${COLORS[f.level]};background:var(--omp-surface);border-radius:4px;`);
    c.append(el("div", "font-weight:600;", f.title));
    if (f.detail) c.append(el("div", DIM, f.detail));
    if (f.fix) c.append(el("div", "font-size:var(--omp-font-size-sm);margin-top:2px;", `${t("an.next")} ${f.fix}`));
    root.append(c);
  }

  if (r.outages?.length) {
    const d = section(t("an.outages"), r.outages.length);
    d.open = true;
    for (const o of r.outages) d.append(el("div", DIM, `${o.label}: ${time(o.from)} … ${o.open ? t("an.open") : time(o.to)} (${Math.round(o.seconds)} s)`));
    root.append(d);
  }

  if (r.timeline?.length) {
    const d = section(t("an.timeline"), r.timeline.length);
    const box = el("div", "max-height:260px;overflow:auto;font-size:var(--omp-font-size-xs);");
    for (const e of r.timeline) {
      const sev = e.severity === "err" ? COLORS.err : e.severity === "warn" ? COLORS.warn : "var(--omp-text)";
      box.append(el("div", `color:${sev};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`, `${new Date(e.at).toLocaleTimeString()}  ${e.kind}  ${e.subject ?? ""}  ${e.text ?? ""}`));
    }
    d.append(box);
    root.append(d);
  }

  const series = r.series ?? [];
  if (series.length) {
    const from = r.from ? Date.parse(r.from) : Math.min(...series.flatMap((s) => s.points.map((p) => p.t)));
    const to = r.to ? Date.parse(r.to) : Math.max(...series.flatMap((s) => s.points.map((p) => p.t)));
    const notable = series.filter((s) => s.flag);
    const draw = (list: AnSeries[], into: HTMLElement) => {
      for (const s of list) {
        const row = el("div", "margin-top:6px;");
        row.append(el("div", DIM, `${s.label} — ${s.metric}: min ${fmtValue(s.min, s.unit)}, Ø ${fmtValue(s.avg, s.unit)}, max ${fmtValue(s.max, s.unit)}${s.flag ? " ⚠ " + s.flag : ""}`), chart(s, from, to));
        into.append(row);
      }
    };
    if (notable.length) {
      const d = section(t("an.notable"), notable.length);
      d.open = true;
      draw(notable, d);
      root.append(d);
    }
    const d = section(t("an.allSeries"), series.length);
    let filled = false;
    d.addEventListener("toggle", () => {
      if (d.open && !filled) { filled = true; draw(series, d); }
    });
    root.append(d);
  }

  if (r.logGroups?.length) {
    const d = section(t("an.logs"), r.logGroups.length);
    for (const g of r.logGroups) {
      d.append(el("div", `font-size:var(--omp-font-size-xs);color:${g.level === "err" ? COLORS.err : COLORS.warn};`, `${g.count}× ${g.source} ${g.code ?? ""} ${g.message}`));
    }
    root.append(d);
  }
  if (r.pipelines?.length) root.append(el("div", DIM + "margin-top:8px;", `${t("an.pipelines")}: ${r.pipelines.join(", ")}`));
  return root;
}
