// Baseline und Trends in der Oberfläche (UMSETZUNG.md Kap. 72.11): Messwerte lesbar schreiben, Verläufe als Linie zeichnen,
// Auffälligkeiten den Befunden des Selbsttests zuordnen.

export interface TrendPoint {
  t: string;
  avg: number;
  max: number;
}

export interface TrendFinding {
  subject: string;
  label: string;
  metric: string;
  kind: "deviation" | "drift";
  unit?: string;
  value: number;
  baseline: number;
  slopePerHour?: number;
  hours?: number;
  hoursToLimit?: number;
  points?: TrendPoint[];
}

export interface TrendReport {
  analyzedAt: string;
  findings: TrendFinding[];
  seriesChecked: number;
  coverageHours: number;
}

/** So viele Stunden Verlauf braucht die Baseline mindestens, bevor „ungewöhnlich für diese Tageszeit“ ein Urteil ist. */
export const BASELINE_HOURS = 72;

export function formatMetric(v: number, unit?: string): string {
  if (unit === "%") return `${v.toFixed(0)} %`;
  if (unit === "B") {
    if (v >= 1 << 30) return `${(v / (1 << 30)).toFixed(1)} GiB`;
    if (v >= 1 << 20) return `${(v / (1 << 20)).toFixed(0)} MiB`;
    return `${(v / 1024).toFixed(0)} KiB`;
  }
  return v.toFixed(0);
}

/** Der Schlüssel eines Befunds (Subjekt enthält Doppelpunkte, deshalb von hinten zerlegt): wie die ID im Selbsttest „trend:<Subjekt>:<Metrik>:<Art>“. */
export function findingId(f: Pick<TrendFinding, "subject" | "metric" | "kind">): string {
  return `trend:${f.subject}:${f.metric}:${f.kind}`;
}

export function findFinding(report: TrendReport | null, checkId: string): TrendFinding | undefined {
  if (!report || !checkId.startsWith("trend:")) return undefined;
  return report.findings.find((f) => findingId(f) === checkId);
}

export interface Spark {
  line: string;
  /** Y der Vergleichslinie (das Übliche bzw. der Anfangswert), falls sie ins Bild passt. */
  baselineY: number | null;
  lastX: number;
  lastY: number;
}

/** Berechnet die Linie eines Verlaufs für ein Bild der Größe w × h (SVG-Koordinaten, y nach unten). Leer bei weniger als 2 Punkten. */
export function sparkline(points: TrendPoint[] | undefined, baseline: number, w: number, h: number, pad = 3): Spark | null {
  if (!points || points.length < 2) return null;
  const ts = points.map((p) => Date.parse(p.t));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const vals = points.map((p) => p.avg);
  const lo = Math.min(...vals, baseline);
  const hi = Math.max(...vals, baseline);
  const span = hi - lo || 1;
  const x = (t: number) => pad + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (w - 2 * pad));
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const coords = points.map((p, i) => `${x(ts[i]).toFixed(1)},${y(p.avg).toFixed(1)}`);
  return {
    line: "M" + coords.join(" L"),
    baselineY: Number(y(baseline).toFixed(1)),
    lastX: Number(x(ts[ts.length - 1]).toFixed(1)),
    lastY: Number(y(vals[vals.length - 1]).toFixed(1)),
  };
}

/** Ein Satz zur Datenlage: wie viel Verlauf da ist und ob die Baseline schon trägt. */
export function coverageKey(report: TrendReport | null): "none" | "building" | "ready" {
  if (!report || report.seriesChecked === 0) return "none";
  return report.coverageHours >= BASELINE_HOURS ? "ready" : "building";
}
