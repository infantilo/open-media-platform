// Reine Logik der Review-Oberfläche (DOM-frei, per `deno test` geprüft): Zustände, Befund-Filter, Segment-Bearbeitung,
// Shuttle-Stufen, Tastaturbelegung, Segmentgrenzen. Zeitmodell: ganzzahlige Frames, Bereiche [in, out) — s. timecode.ts.
import { type Timeline, validateRange } from "./timecode.ts";

export interface Item {
  assetId: string;
  fileName: string;
  title?: string;
  state: string;
  assignee?: string;
  /** Zuweisung (Kapitel 44): wer die Datei prüfen soll, bis wann. */
  assignedTo?: string;
  assignedGroup?: string;
  dueAt?: string;
  assignedBy?: string;
  revision: number;
  qcStatus?: string;
  qcFailCount: number;
  qcWarnCount: number;
  qcReportId?: string;
  timeline?: Timeline;
  approvalMode: string;
  sizeBytes?: number;
  format?: string;
  ingestJob?: string;
  conformRevision: number;
  sourceRev: string;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  id?: number;
  checkId: string;
  category: string;
  status: string;
  severity: string;
  message: string;
  measured?: Record<string, unknown>;
  threshold?: Record<string, unknown>;
  startFrame?: number;
  endFrame?: number;
  stream?: number;
  tool: string;
  toolVersion: string;
  analyzedAt: string;
  ruleset: string;
}

export interface Segment {
  id: string;
  order?: number;
  label: string;
  in: number;
  out: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface Policy {
  allowOverlap: boolean;
  allowGaps: boolean;
  minSegmentFrames: number;
}

export const STATE_ORDER = [
  "awaiting_qc", "qc_running", "qc_failed_to_run", "awaiting_review", "in_review", "conforming", "ready_for_approval", "rejected", "approved", "archived",
];

/** Farbklasse (omp-badge-…) je Zustand. */
export function stateBadge(state: string): string {
  switch (state) {
    case "qc_running":
    case "in_review":
    case "conforming":
      return "omp-badge omp-badge-running";
    case "qc_failed_to_run":
    case "rejected":
      return "omp-badge omp-badge-error";
    case "awaiting_review":
    case "ready_for_approval":
      return "omp-badge omp-badge-cue";
    case "approved":
      return "omp-badge omp-badge-info";
    default:
      return "omp-badge";
  }
}

export function qcBadge(status: string | undefined): string {
  switch (status) {
    case "fail":
      return "omp-badge omp-badge-error";
    case "warning":
    case "incomplete":
      return "omp-badge omp-badge-cue";
    case "pass":
      return "omp-badge omp-badge-info";
    default:
      return "omp-badge";
  }
}

export const SEVERITY_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, info: 1 };
export const STATUS_RANK: Record<string, number> = { fail: 4, warning: 3, not_evaluated: 2, pass: 1 };

export interface FindingFilter {
  category: string;
  status: string;
  severity: string;
  q: string;
  onlyIssues: boolean;
}

export const NO_FILTER: FindingFilter = { category: "", status: "", severity: "", q: "", onlyIssues: false };

/** Filtert Befunde; Ergebnis nach Status (schlechteste zuerst), dann Position. */
export function filterFindings(all: Finding[], f: FindingFilter): Finding[] {
  const q = f.q.trim().toLowerCase();
  return all
    .filter((x) => (!f.category || x.category === f.category) && (!f.status || x.status === f.status) && (!f.severity || x.severity === f.severity))
    .filter((x) => !f.onlyIssues || x.status === "fail" || x.status === "warning")
    .filter((x) => !q || x.message.toLowerCase().includes(q) || x.checkId.toLowerCase().includes(q))
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || (a.startFrame ?? -1) - (b.startFrame ?? -1));
}

export function countBy(all: Finding[], key: "status" | "category" | "severity"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of all) out[f[key]] = (out[f[key]] ?? 0) + 1;
  return out;
}

/** Gemessener Wert gegen Grenzwert als lesbare Zeilen (Schlüssel/Wert). */
export function measuredRows(f: Finding): { key: string; measured: string; threshold: string }[] {
  const keys = new Set<string>([...Object.keys(f.measured ?? {}), ...Object.keys(f.threshold ?? {})]);
  keys.delete("incomplete");
  const show = (v: unknown): string => (v === undefined || v === null ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));
  return [...keys].map((k) => ({ key: k, measured: show(f.measured?.[k]), threshold: show(f.threshold?.[k]) }));
}

// ---- Segmente ---------------------------------------------------------------------------------------------------------

let idSeq = 0;
/** Vorläufige Client-ID für ein neues Segment (der Server vergibt beim Speichern eine stabile ID, solange id leer ist). */
export const tempId = (): string => `new-${Date.now().toString(36)}-${idSeq++}`;
export const isTempId = (id: string): boolean => id.startsWith("new-");

export function addSegment(segs: Segment[], inF: number, outF: number, label = ""): Segment[] {
  return [...segs, { id: tempId(), label: label || "", in: inF, out: outF, description: "", metadata: {} }];
}

export function removeSegment(segs: Segment[], id: string): Segment[] {
  return segs.filter((s) => s.id !== id);
}

export function moveSegment(segs: Segment[], id: string, dir: -1 | 1): Segment[] {
  const i = segs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= segs.length) return segs;
  const out = [...segs];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function updateSegment(segs: Segment[], id: string, patch: Partial<Segment>): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Beim Speichern: leere/temporäre IDs entfernen, damit der Server stabile IDs vergibt. */
export function toServerSegments(segs: Segment[]): Segment[] {
  return segs.map((s) => ({ ...s, id: isTempId(s.id) ? "" : s.id }));
}

export interface SegProblem {
  index: number; // -1 = Gesamt
  key: string; // i18n-Schlüssel suffix
  params?: Record<string, unknown>;
}

/** Spiegelt die Server-Prüfung für sofortiges Feedback (der Server prüft immer erneut und ist maßgeblich). */
export function validateSegments(segs: Segment[], tl: Timeline | undefined, p: Policy, usable?: { in: number; out: number } | null): SegProblem[] {
  const out: SegProblem[] = [];
  if (!tl) return [{ index: -1, key: "notimeline" }];
  if (usable) {
    const e = validateRange(tl, usable.in, usable.out, p.minSegmentFrames);
    if (e) out.push({ index: -1, key: "usable." + e });
  }
  segs.forEach((s, i) => {
    const e = validateRange(tl, s.in, s.out, p.minSegmentFrames);
    if (e) out.push({ index: i, key: e, params: { min: p.minSegmentFrames } });
    else if (usable && (s.in < usable.in || s.out > usable.out)) out.push({ index: i, key: "outside" });
  });
  const sorted = segs.map((s, i) => ({ ...s, i })).filter((s) => s.out > s.in).sort((a, b) => a.in - b.in);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    const cur = sorted[k];
    if (cur.in < prev.out && !p.allowOverlap) out.push({ index: cur.i, key: "overlap", params: { a: prev.i + 1, b: cur.i + 1 } });
    if (cur.in > prev.out && !p.allowGaps) out.push({ index: cur.i, key: "gap", params: { a: prev.i + 1, b: cur.i + 1 } });
  }
  return out;
}

/** Nächste Segmentgrenze (In oder Out) vor/hinter `frame`; null, wenn keine. Out zählt als Grenze „am ersten Bild hinter dem Segment“. */
export function nextBoundary(segs: Segment[], frame: number, dir: -1 | 1): number | null {
  const pts = [...new Set(segs.flatMap((s) => [s.in, s.out]))].sort((a, b) => a - b);
  if (dir > 0) return pts.find((p) => p > frame) ?? null;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < frame) return pts[i];
  return null;
}

// ---- Player-Steuerung -------------------------------------------------------------------------------------------------

/** Shuttle-Stufen (Vielfache der Echtzeit); negativ = rückwärts. */
export const SHUTTLE_SPEEDS = [-8, -4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 8];

/** J/L wie am Schnittplatz: L beschleunigt vorwärts (1×,2×,4×,8×), J rückwärts; die Gegenrichtung bremst zuerst bis Stillstand. */
export function shuttleStep(current: number, key: "J" | "L"): number {
  const up = key === "L";
  if (up) {
    if (current < 0) return SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.indexOf(current) + 1] ?? 0;
    if (current === 0) return 1;
    return Math.min(8, current * 2 >= 2 && current >= 1 ? current * 2 : 1);
  }
  if (current > 0) return SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.indexOf(current) - 1] ?? 0;
  if (current === 0) return -1;
  return Math.max(-8, current <= -1 ? current * 2 : -1);
}

export type KeyAction =
  | { kind: "step"; frames: number }
  | { kind: "togglePlay" }
  | { kind: "shuttle"; key: "J" | "K" | "L" }
  | { kind: "markIn" }
  | { kind: "markOut" }
  | { kind: "gotoIn" }
  | { kind: "gotoOut" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "gotoTimecode" }
  | { kind: "boundary"; dir: -1 | 1 }
  | { kind: "addSegment" };

/** Tastaturbelegung des Players. Pfeile: ±1 Bild, Umschalt ±10 Bilder, Strg ±1 Sekunde (nominal). */
export function keyAction(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }, fps: number): KeyAction | null {
  if (e.metaKey) return null;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const n = e.ctrlKey ? Math.round(fps) : e.shiftKey ? 10 : 1;
  switch (k) {
    case "ArrowLeft":
      return { kind: "step", frames: -n };
    case "ArrowRight":
      return { kind: "step", frames: n };
    case " ":
      return { kind: "togglePlay" };
    case "J":
    case "K":
    case "L":
      return e.ctrlKey ? null : { kind: "shuttle", key: k };
    case "I":
      return e.altKey ? { kind: "gotoIn" } : { kind: "markIn" };
    case "O":
      return e.altKey ? { kind: "gotoOut" } : { kind: "markOut" };
    case "Home":
      return { kind: "home" };
    case "End":
      return { kind: "end" };
    case "G":
      return { kind: "gotoTimecode" };
    case "[":
      return { kind: "boundary", dir: -1 };
    case "]":
      return { kind: "boundary", dir: 1 };
    case "N":
      return { kind: "addSegment" };
    default:
      return null;
  }
}

/** Zielbild nach einer Schrittweite, begrenzt auf [0, Dauer-1]. */
export const clampFrame = (f: number, tl: Timeline): number => Math.min(Math.max(0, Math.round(f)), Math.max(0, tl.durationFrames - 1));

/** Bild beim Rückwärts-Shuttle nach `elapsedMs` ab Startbild (Rückfall über Einzelbild-Seeks). */
export const shuttleFrame = (start: number, speed: number, elapsedMs: number, rateFps: number): number => start + Math.round((speed * rateFps * elapsedMs) / 1000);

export function formatBytes(n: number | undefined): string {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Zustände, in denen ein Bearbeiter Änderungen speichern darf. */
export const EDITABLE_STATES = ["in_review", "conforming"];

/** Wem ist die Datei zugewiesen? „anna“, „Gruppe nachtschicht“, beides oder leer. */
export function assignmentLabel(it: Pick<Item, "assignedTo" | "assignedGroup">, groupWord: string, groupName: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  if (it.assignedTo) parts.push(it.assignedTo);
  if (it.assignedGroup) parts.push(`${groupWord} ${groupName(it.assignedGroup)}`);
  return parts.join(" · ");
}

/** Frist überschritten (nur für noch offene Dateien sinnvoll — das entscheidet der Aufrufer)? */
export function isOverdue(dueAt: string | undefined, nowMs: number): boolean {
  if (!dueAt) return false;
  const at = Date.parse(dueAt);
  return Number.isFinite(at) && at < nowMs;
}

/** `datetime-local`-Wert (Ortszeit) → ISO-Zeit (UTC); leer/ungültig → undefined. */
export function localInputToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO-Zeit → `datetime-local`-Wert in Ortszeit (für das Eingabefeld). */
export function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Zustand der Proxy-Erzeugung für den Fortschrittsbalken: `pct` = null → unbestimmt (wartet noch). */
export function proxyProgress(p: { state: string; progress?: number } | null): { pct: number | null; waiting: boolean } {
  if (!p || p.state === "queued") return { pct: null, waiting: true };
  const n = Number.isFinite(p.progress) ? Math.round(p.progress as number) : 0;
  return { pct: Math.min(100, Math.max(0, n)), waiting: false };
}
