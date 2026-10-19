// Reine Logik der Aufnahme-Oberfläche (DOM-frei, per `deno test` geprüft): Zeitleisten-Layout, Zustände, Kapazitätsreihen,
// Formular ↔ API-Nutzlast. Zeiten kommen als UTC-ISO-Strings; angezeigt wird in der Zeitzone des Auftrags bzw. des Browsers.

export interface Source {
  instanceId?: string;
  senderLabel?: string;
  senderId?: string;
  label?: string;
}

export interface Verdict {
  kind: string;
  blocking: boolean;
  resource?: string;
  host?: string;
  from?: string;
  to?: string;
  jobs?: string[];
  needed?: number;
  available?: number;
  message: string;
  action?: string;
  preemptable?: string[];
}

export interface Job {
  id: string;
  scheduleId?: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
  tz: string;
  shifted?: boolean;
  ambiguous?: boolean;
  state: string;
  attempt: number;
  maxAttempts: number;
  priority: number;
  source: Source;
  profileId: string;
  hostId?: string;
  filePath?: string;
  assetId?: string;
  actualStart?: string;
  actualEnd?: string;
  startDeviationMs?: number;
  error?: string;
  failedStage?: string;
  verdicts?: Verdict[];
  earliestStart?: string;
  revision: number;
  /** Verantwortliche Person bzw. Gruppe (Kapitel 44). */
  owner?: string;
  ownerGroup?: string;
}

export const STATE_ORDER = ["recording", "starting", "waiting_for_resources", "scheduled", "blocked", "finalizing", "processing", "completed", "failed", "cancelled"];

/** Farbe je Zustand (CSS-Variablen der Design-Tokens). */
export function stateColor(state: string): string {
  switch (state) {
    case "recording":
      return "var(--omp-onair)";
    case "starting":
    case "finalizing":
    case "processing":
      return "var(--omp-cue)";
    case "waiting_for_resources":
      return "var(--omp-cue)";
    case "scheduled":
      return "var(--omp-info)";
    case "blocked":
    case "failed":
      return "var(--omp-error)";
    case "completed":
      return "var(--omp-preset)";
    default:
      return "var(--omp-text-disabled)";
  }
}

export const isTerminal = (s: string): boolean => s === "completed" || s === "failed" || s === "cancelled";
export const isRunning = (s: string): boolean => s === "starting" || s === "recording" || s === "finalizing" || s === "processing";
export const canCancel = (s: string): boolean => s === "blocked" || s === "scheduled" || s === "waiting_for_resources";
export const canAbort = (s: string): boolean => s === "starting" || s === "recording";

// ---- Zeitleiste ------------------------------------------------------------------------------------------------------

export interface Bar {
  job: Job;
  left: number; // Prozent
  width: number;
  lane: number; // Zeile innerhalb der Spur (überlappende Aufträge werden gestapelt)
  clippedLeft: boolean;
  clippedRight: boolean;
}

/** Ordnet Aufträge im Fenster [from,to) einer Spur zu und stapelt Überlappungen (zeitlich sortiert, greedy). */
export function layoutBars(jobs: Job[], from: number, to: number): { bars: Bar[]; lanes: number } {
  const span = to - from;
  const sorted = jobs
    .map((j) => ({ j, s: Date.parse(j.plannedStart), e: Date.parse(j.plannedEnd) }))
    .filter((x) => x.e > from && x.s < to)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const laneEnd: number[] = [];
  const bars: Bar[] = [];
  for (const x of sorted) {
    let lane = laneEnd.findIndex((e) => e <= x.s);
    if (lane < 0) {
      lane = laneEnd.length;
      laneEnd.push(0);
    }
    laneEnd[lane] = x.e;
    const s = Math.max(x.s, from);
    const e = Math.min(x.e, to);
    bars.push({ job: x.j, left: ((s - from) / span) * 100, width: Math.max(0.15, ((e - s) / span) * 100), lane, clippedLeft: x.s < from, clippedRight: x.e > to });
  }
  return { bars, lanes: Math.max(1, laneEnd.length) };
}

/** Teilung der Aufträge in Spuren: je Host eine, „nicht zugelassen“ eine eigene. */
export function laneKey(j: Job): string {
  return j.state === "blocked" ? "__blocked" : j.hostId || "__none";
}

export function groupLanes(jobs: Job[]): Map<string, Job[]> {
  const m = new Map<string, Job[]>();
  for (const j of jobs) {
    if (j.state === "cancelled") continue;
    const k = laneKey(j);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(j);
  }
  return m;
}

/** Stundenmarken im Fenster (volle Stunden oder bei langen Fenstern Tage). */
export function ticks(from: number, to: number): { t: number; label: "hour" | "day"; major: boolean }[] {
  const out: { t: number; label: "hour" | "day"; major: boolean }[] = [];
  const hours = (to - from) / 3600000;
  const step = hours <= 12 ? 1 : hours <= 36 ? 3 : hours <= 72 ? 6 : 24;
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < from) d.setHours(d.getHours() + 1);
  for (let t = d.getTime(); t < to; t += 3600000) {
    const h = new Date(t).getHours();
    if (step === 24 ? h === 0 : h % step === 0) out.push({ t, label: step === 24 ? "day" : "hour", major: h === 0 });
  }
  return out;
}

// ---- Kapazität -------------------------------------------------------------------------------------------------------

export interface UsagePoint {
  from: string;
  to: string;
  use: Record<string, number>;
  jobs?: string[];
}

export interface HostView {
  id: string;
  label: string;
  online: boolean;
  functions: string[];
  hard: Record<string, number>;
  softFraction: number;
  usage: UsagePoint[];
  warnings: Verdict[];
}

export const RESOURCE_UNITS: Record<string, string> = {
  recorder_slots: "", converter_slots: "", cpu_cores: "Kerne", mem_mb: "MB", gpu_units: "", disk_mbps: "MB/s", disk_gb: "GB", net_mbps: "Mbit/s", mxl_shm_mb: "MB",
};

export interface SeriesPoint {
  x0: number; // Prozent
  x1: number;
  use: number;
}

/** Nutzungsreihe einer Ressource über das Fenster (Prozent der Breite, Absolutwert). */
export function usageSeries(h: HostView, res: string, from: number, to: number): { points: SeriesPoint[]; peak: number } {
  const span = to - from;
  const points: SeriesPoint[] = [];
  let peak = 0;
  for (const u of h.usage) {
    const v = u.use[res] ?? 0;
    const s = Math.max(Date.parse(u.from), from);
    const e = Math.min(Date.parse(u.to), to);
    if (e <= s) continue;
    points.push({ x0: ((s - from) / span) * 100, x1: ((e - from) / span) * 100, use: v });
    peak = Math.max(peak, v);
  }
  return { points, peak };
}

/** Zustand einer Ressourcenzeile: ok | soft (Warnschwelle überschritten) | hard (Grenze erreicht/überschritten). */
export function resourceLevel(h: HostView, res: string, peak: number): "ok" | "soft" | "hard" {
  const hard = h.hard[res];
  if (!hard) return "ok";
  if (peak > hard + 1e-9) return "hard";
  if (peak >= hard - 1e-9) return "soft"; // Grenze genau erreicht: voll, aber nicht überbucht
  if (h.softFraction > 0 && peak / hard > h.softFraction) return "soft";
  return "ok";
}

// ---- Verdict-Darstellung ---------------------------------------------------------------------------------------------

export function verdictKindKey(kind: string): string {
  return "ing.v." + kind;
}

/** Empfohlene Maßnahme bevorzugt vom Server, sonst aus der Art. */
export function actionKey(v: Verdict): string {
  return v.action ? "" : "ing.va." + v.kind;
}

// ---- Zeit und Formular -----------------------------------------------------------------------------------------------

export function fmtInZone(iso: string, tz: string, locale: string, withDate = true): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: tz, ...(withDate ? { dateStyle: "short" } : {}), timeStyle: "short" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString(locale);
  }
}

export function fmtDuration(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return `${h}:${String(m).padStart(2, "0")}${s ? ":" + String(s).padStart(2, "0") : ""}`;
}

/** "1:30", "01:30:15", "90" (Minuten nur mit Doppelpunkt) → Sekunden; null bei ungültig. */
export function parseDuration(s: string): number | null {
  const t = s.trim();
  const m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) return null;
  return secs > 0 && secs <= 7 * 24 * 3600 ? secs : null;
}

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export interface FormState {
  name: string;
  sourceKey: string; // "instanceId|senderLabel"
  sourceLabel: string;
  profileId: string;
  tz: string;
  startLocal: string; // yyyy-mm-ddThh:mm
  duration: string; // h:mm
  freq: string;
  interval: string;
  byDay: string[];
  until: string;
  count: string;
  priority: string;
  lateMode: string;
  lateMaxDelayMin: string;
  retryMax: string;
  hostPref: string;
  dir: string;
  template: string;
  description: string;
}

export interface FormProblem {
  field: string;
  key: string;
}

export function validateForm(f: FormState): FormProblem[] {
  const p: FormProblem[] = [];
  if (!f.name.trim()) p.push({ field: "name", key: "name" });
  if (!f.sourceKey) p.push({ field: "source", key: "source" });
  if (!f.profileId) p.push({ field: "profile", key: "profile" });
  if (!f.tz.trim()) p.push({ field: "tz", key: "tz" });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.startLocal)) p.push({ field: "start", key: "start" });
  if (parseDuration(f.duration) === null) p.push({ field: "duration", key: "duration" });
  const pr = Number(f.priority);
  if (!Number.isInteger(pr) || pr < 0 || pr > 9) p.push({ field: "priority", key: "priority" });
  if (f.freq === "weekly" && f.byDay.length === 0) p.push({ field: "byDay", key: "byday" });
  if (f.until && !/^\d{4}-\d{2}-\d{2}$/.test(f.until)) p.push({ field: "until", key: "until" });
  if (f.count && (!Number.isInteger(Number(f.count)) || Number(f.count) < 1)) p.push({ field: "count", key: "count" });
  return p;
}

export function formToPayload(f: FormState): Record<string, unknown> {
  const [instanceId, senderLabel] = f.sourceKey.split("|");
  const rec: Record<string, unknown> = { freq: f.freq === "once" ? "" : f.freq };
  if (f.freq !== "once") {
    if (Number(f.interval) > 1) rec.interval = Number(f.interval);
    if (f.freq === "weekly") rec.byDay = f.byDay;
    if (f.until) rec.until = f.until;
    if (f.count) rec.count = Number(f.count);
  }
  return {
    name: f.name.trim(),
    source: { instanceId, senderLabel: senderLabel || undefined, label: f.sourceLabel || undefined },
    profileId: f.profileId,
    spec: { tz: f.tz.trim(), startLocal: f.startLocal, durationS: parseDuration(f.duration), recurrence: rec },
    priority: Number(f.priority),
    late: { mode: f.lateMode, maxDelayS: f.lateMode === "delay" ? Math.round(Number(f.lateMaxDelayMin || "0") * 60) : 0 },
    retry: { maxAttempts: Math.max(1, Number(f.retryMax || "1")) },
    hostPref: f.hostPref,
    storage: { dir: f.dir.trim(), fileTemplate: f.template.trim() },
    metadata: f.description.trim() ? { description: f.description.trim() } : {},
  };
}

export function emptyForm(tz: string, nowIso: string): FormState {
  const d = new Date(nowIso);
  d.setMinutes(Math.ceil((d.getMinutes() + 5) / 5) * 5, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    name: "", sourceKey: "", sourceLabel: "", profileId: "", tz, startLocal: local, duration: "1:00", freq: "once", interval: "1", byDay: [], until: "", count: "",
    priority: "5", lateMode: "wait", lateMaxDelayMin: "10", retryMax: "2", hostPref: "", dir: "", template: "", description: "",
  };
}

/** Nutzlast des Trockenlaufs (/plan) aus dem Formular — nur der erste Termin zählt. */
export function planPayload(f: FormState): Record<string, unknown> | null {
  const dur = parseDuration(f.duration);
  if (dur === null || !f.sourceKey || !f.profileId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.startLocal)) return null;
  const [instanceId, senderLabel] = f.sourceKey.split("|");
  // Wanduhr in der gewählten Zeitzone → UTC-Instant (gleiche Regel wie der Server: erste Instanz, Lücke → danach)
  const start = zonedToUtc(f.startLocal, f.tz);
  if (!start) return null;
  return { source: { instanceId, senderLabel: senderLabel || undefined }, profileId: f.profileId, start: start.toISOString(), durationS: dur, priority: Number(f.priority), hostPref: f.hostPref };
}

/** Wanduhrzeit in IANA-Zone → UTC (Näherung über zweimaliges Anpassen; reicht für die Vorschau, der Server rechnet maßgeblich). */
export function zonedToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    const offsetAt = (t: number): number => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
      const g = (k: string) => Number(parts.find((p) => p.type === k)!.value);
      return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
    };
    let t = asUtc - offsetAt(asUtc);
    t = asUtc - offsetAt(t);
    return new Date(t);
  } catch {
    return null;
  }
}
