// Verlaufsdiagramme der Hosts (Kapitel 54): Reihen aus GET /api/v1/hosts/{id}/metrics/history für CPU, RAM, Live-Anteil, GPU, Netz.
export type Metric = "cpu" | "mem" | "live" | "gpu" | "net";
export const METRICS: Metric[] = ["cpu", "mem", "live", "gpu", "net"];

export interface Point { t: number; avg: number; max: number }

interface RawSample { timestamp: string; cpuPercent: number; memPercent: number; liveCpuCores?: number; liveMemPercent?: number; gpuPercent?: number; netPercent?: number }
interface Aggr { bucketStart: string; cpuAvg: number; cpuMax: number; memAvg: number; memMax: number; liveCpuCoresMax?: number; liveMemMax?: number; gpuMax?: number; netMax?: number }
interface Hour { hour: string; cpuAvg: number; cpuMax: number; memAvg: number; memMax: number; liveCpuCoresAvg?: number; liveCpuCoresMax?: number; liveMemMax?: number; gpuMax?: number; netMax?: number }
export interface HistoryWindowIn { resolution: "raw" | "aggregate" | "hourly"; samples?: RawSample[]; aggregates?: Aggr[]; hours?: Hour[] }

export const WINDOWS: { id: string; query: string; ms: number }[] = [
  { id: "1h", query: "1h", ms: 3600e3 },
  { id: "6h", query: "6h", ms: 6 * 3600e3 },
  { id: "24h", query: "24h", ms: 24 * 3600e3 },
  { id: "7d", query: "168h", ms: 7 * 24 * 3600e3 },
  { id: "30d", query: "720h", ms: 30 * 24 * 3600e3 },
];

/** Reihe einer Messgröße. `cores` rechnet die Live-CPU (Kerne) in % des Hosts um; ohne Kernzahl bleibt sie in Kernen. */
export function series(win: HistoryWindowIn | null | undefined, metric: Metric, cores?: number): Point[] {
  if (!win) return [];
  const live = (v: number | undefined) => ((v ?? 0) / (cores && cores > 0 ? cores : 1)) * (cores && cores > 0 ? 100 : 1);
  const out: Point[] = [];
  if (win.resolution === "raw") {
    for (const s of win.samples ?? []) {
      const v = metric === "cpu" ? s.cpuPercent : metric === "mem" ? s.memPercent : metric === "live" ? live(s.liveCpuCores) : metric === "gpu" ? s.gpuPercent ?? 0 : s.netPercent ?? 0;
      out.push({ t: Date.parse(s.timestamp), avg: v, max: v });
    }
  } else if (win.resolution === "aggregate") {
    for (const a of win.aggregates ?? []) {
      const [avg, max] = metric === "cpu" ? [a.cpuAvg, a.cpuMax] : metric === "mem" ? [a.memAvg, a.memMax] : metric === "live" ? [live(a.liveCpuCoresMax), live(a.liveCpuCoresMax)] : metric === "gpu" ? [a.gpuMax ?? 0, a.gpuMax ?? 0] : [a.netMax ?? 0, a.netMax ?? 0];
      out.push({ t: Date.parse(a.bucketStart), avg, max });
    }
  } else {
    for (const h of win.hours ?? []) {
      const [avg, max] = metric === "cpu" ? [h.cpuAvg, h.cpuMax] : metric === "mem" ? [h.memAvg, h.memMax] : metric === "live" ? [live(h.liveCpuCoresAvg), live(h.liveCpuCoresMax)] : metric === "gpu" ? [h.gpuMax ?? 0, h.gpuMax ?? 0] : [h.netMax ?? 0, h.netMax ?? 0];
      out.push({ t: Date.parse(h.hour), avg, max });
    }
  }
  return out.filter((p) => Number.isFinite(p.t));
}

/** Gibt es überhaupt Messwerte (≠ 0)? Sonst „nicht gemessen“ statt einer flachen Linie. */
export const hasData = (pts: Point[]): boolean => pts.some((p) => p.max > 0);

/** Obergrenze der Y-Achse: auf 10/25/50/100 aufgerundet, höchstens 100 bei Prozenten. */
export function yMax(pts: Point[], percent: boolean): number {
  const m = Math.max(0, ...pts.map((p) => p.max));
  if (!percent) return m <= 1 ? 1 : Math.ceil(m);
  for (const c of [10, 25, 50, 100]) if (m <= c) return c;
  return 100;
}

export interface Chart { line: string; band: string; x0: number; x1: number; y: number }

/** SVG-Pfade: Linie (Mittel) und Band (Mittel bis Spitze). */
export function chartPaths(pts: Point[], w: number, h: number, ymax: number): Chart {
  if (pts.length === 0) return { line: "", band: "", x0: 0, x1: 0, y: ymax };
  const x0 = pts[0].t;
  const x1 = pts[pts.length - 1].t;
  const span = Math.max(1, x1 - x0);
  const X = (t: number) => ((t - x0) / span) * w;
  const Y = (v: number) => h - (Math.min(v, ymax) / ymax) * h;
  const f = (n: number) => n.toFixed(1);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${f(X(p.t))},${f(Y(p.avg))}`).join(" ");
  const top = pts.map((p, i) => `${i === 0 ? "M" : "L"}${f(X(p.t))},${f(Y(p.max))}`).join(" ");
  const back = [...pts].reverse().map((p) => `L${f(X(p.t))},${f(Y(p.avg))}`).join(" ");
  return { line, band: `${top} ${back} Z`, x0, x1, y: ymax };
}

/** Nächster Punkt zu einer x-Position (0..w) für den Hinweistext. */
export function nearest(pts: Point[], x: number, w: number): Point | undefined {
  if (pts.length === 0) return undefined;
  const x0 = pts[0].t;
  const span = Math.max(1, pts[pts.length - 1].t - x0);
  const t = x0 + (x / w) * span;
  return pts.reduce((b, p) => (Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), pts[0]);
}
