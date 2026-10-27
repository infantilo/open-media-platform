// Reine Logik der Ereignis-Zeitleiste (timeline-panel.ts, UMSETZUNG.md Kap. 72.6): Ereignisse einordnen, in Klartext fassen,
// auf der Zeitachse verdichten und den Zustand zu einem Zeitpunkt aus den aufgezeichneten Wechseln nachspielen.
import { describe as describeAudit, type Resolvers } from "./audit-logic.ts";
import { CATEGORIES } from "./audit-logic.ts";

export type TLSeverity = "info" | "warn" | "error";
export type TLSource = "event" | "audit" | "domain" | "log";

export interface TLItem {
  id: string;
  at: string;
  source: TLSource;
  kind: string;
  severity: TLSeverity;
  subject?: string;
  actor?: string;
  data?: Record<string, unknown>;
}

export type TLCat = "fault" | "ops" | "change" | "marker" | "log";
export const TL_CATS: { id: TLCat; icon: string }[] = [
  { id: "fault", icon: "⚠" },
  { id: "marker", icon: "⚑" },
  { id: "change", icon: "✎" },
  { id: "ops", icon: "⚙" },
  { id: "log", icon: "▤" },
];
export const DEFAULT_CATS: TLCat[] = ["fault", "marker", "change", "ops"];

export const WINDOWS = [
  { id: "1h", ms: 3_600_000 },
  { id: "6h", ms: 6 * 3_600_000 },
  { id: "24h", ms: 24 * 3_600_000 },
  { id: "7d", ms: 7 * 24 * 3_600_000 },
] as const;
export type WindowId = typeof WINDOWS[number]["id"];

const FAULT_KINDS = new Set(["instance.crashed", "node.notready", "host.silent", "workflow.failover"]);
const CHANGE_KINDS = new Set(["workflow.migration", "workflow.status", "host.registered", "host.removed", "host.maintenance", "edge.added", "edge.removed"]);

export function categoryOf(i: TLItem): TLCat {
  if (i.kind === "marker") return "marker";
  if (i.source === "log") return "log";
  if (i.source === "audit" || i.source === "domain") return "change";
  if (FAULT_KINDS.has(i.kind) || (i.source === "event" && i.severity === "error")) return "fault";
  if (CHANGE_KINDS.has(i.kind)) return "change";
  return "ops";
}

export function timelineUrl(sinceMs: number, untilMs: number, operate: boolean): string {
  const q = new URLSearchParams({ since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), limit: "1000" });
  if (operate) q.set("operate", "1");
  return `/api/v1/timeline?${q}`;
}

export interface Described {
  icon: string;
  /** i18n-Schlüssel und Parameter, oder fertiger Text (Audit/Log). */
  key?: string;
  params?: Record<string, string>;
  text?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const short = (id: string) => (id.length > 12 ? id.slice(0, 8) + "…" : id);

/** Beschreibt eine Zeile in Klartext; Bedienungen über die Sätze des Audit-Logs. */
export function describeItem(i: TLItem, r: Resolvers, tr: (key: string) => string | undefined, auditText: (key: string, p: Record<string, string>) => string): Described {
  const d = i.data ?? {};
  switch (i.source) {
    case "audit": {
      const row = { method: str(d.method), path: str(d.path), nodeId: str(d.nodeId) || undefined };
      const a = describeAudit(row, r, tr);
      const cat = CATEGORIES.find((c) => c.id === a.category);
      return { icon: cat?.icon ?? "✎", text: a.key ? auditText(a.key, a.params) : `${row.method} ${row.path}` };
    }
    case "domain":
      return { icon: "✎", key: "tl.k.domain", params: { type: str(d.objectType), id: short(str(d.objectId)), action: str(d.action) } };
    case "log":
      return { icon: "▤", text: str(d.message).slice(0, 300) };
  }
  const label = str(d.label) || (i.subject ? r.instance(i.subject) ?? r.node(i.subject) ?? short(i.subject) : "?");
  const icons: Record<string, string> = {
    "instance.crashed": "✖", "instance.restarted": "↻", "node.notready": "✖", "node.ready": "✔", "host.silent": "✖", "host.resumed": "✔",
    "host.clock.lost": "⏱", "host.clock.ok": "⏱", "workflow.failover": "⇄", marker: "⚑", "orchestrator.started": "⏻",
  };
  const icon = icons[i.kind] ?? "•";
  switch (i.kind) {
    case "instance.crashed":
      return { icon, key: "tl.k.instance.crashed", params: { label, message: str(d.message).split("\n").pop() ?? "" } };
    case "instance.restarted":
      return { icon, key: "tl.k.instance.restarted", params: { label } };
    case "workflow.failover":
      return { icon, key: "tl.k.workflow.failover", params: { workflow: r.workflow(str(d.workflowId)) ?? short(str(d.workflowId)), trigger: str(d.trigger) } };
    case "workflow.status": {
      const status = str(d.status);
      const known = ["running", "stopped", "failed"].includes(status);
      return { icon: "▶", key: known ? `tl.k.workflow.status.${status}` : "tl.k.workflow.status.other", params: { name: str(d.name) || short(i.subject ?? ""), error: str(d.error), status } };
    }
    case "workflow.migration":
      return { icon: "⇄", key: "tl.k.workflow.migration", params: { workflow: r.workflow(str(d.workflowId)) ?? short(str(d.workflowId)), status: str(d.status), reason: str(d.reason) } };
    case "host.registered":
      return { icon: "＋", key: "tl.k.host.registered", params: { label: str(d.label) || short(str(d.hostId)) } };
    case "host.removed":
      return { icon: "－", key: "tl.k.host.removed", params: { id: short(str(d.hostId)) } };
    case "host.maintenance":
      return { icon: "🔧", key: "tl.k.host.maintenance", params: { id: short(str(d.hostId)) } };
    case "edge.added":
    case "edge.removed":
      return { icon: "🔗", key: `tl.k.${i.kind}`, params: { id: short(str(d.id)) } };
    case "marker":
      return { icon, key: str(d.note) ? "tl.k.marker.note" : "tl.k.marker", params: { actor: i.actor ?? "", note: str(d.note) } };
    case "orchestrator.started":
      return { icon, key: "tl.k.orchestrator.started", params: { version: str(d.version) } };
  }
  const known = ["node.ready", "node.notready", "host.silent", "host.resumed", "host.clock.lost", "host.clock.ok"];
  if (known.includes(i.kind)) return { icon, key: `tl.k.${i.kind}`, params: { label } };
  return { icon, key: "tl.k.other", params: { kind: i.kind } };
}

// ---- Zeitachse -----------------------------------------------------------------------------------------------------

export interface Bin {
  from: number;
  to: number;
  error: number;
  warn: number;
  info: number;
}

/** Verdichtet die Zeilen in n gleich breite Abschnitte [from, to) (für den Balken über der Liste). */
export function bins(items: TLItem[], fromMs: number, toMs: number, n: number): Bin[] {
  const width = (toMs - fromMs) / n;
  const out: Bin[] = Array.from({ length: n }, (_, k) => ({ from: fromMs + k * width, to: fromMs + (k + 1) * width, error: 0, warn: 0, info: 0 }));
  for (const i of items) {
    const t = Date.parse(i.at);
    const k = Math.floor((t - fromMs) / width);
    if (k >= 0 && k < n) out[k][i.severity]++;
  }
  return out;
}

export function worstLevel(b: Bin): TLSeverity | null {
  return b.error ? "error" : b.warn ? "warn" : b.info ? "info" : null;
}

// ---- Zustand zu einem Zeitpunkt -------------------------------------------------------------------------------------

export interface OpenProblem {
  key: string;
  since: number;
  item: TLItem;
}

// Wechselpaare: Öffner → Schließer (Schlüssel des Problems = Art + Gegenstand)
const OPEN: Record<string, { close: string[]; key: string }> = {
  "instance.crashed": { close: ["instance.restarted"], key: "instance" },
  "node.notready": { close: ["node.ready"], key: "media" },
  "host.silent": { close: ["host.resumed"], key: "host" },
  "host.clock.lost": { close: ["host.clock.ok"], key: "clock" },
};

/**
 * Spielt die aufgezeichneten Wechsel bis atMs nach und liefert, was zu diesem Zeitpunkt gestört war. Nur was aufgezeichnet
 * wurde: ein Orchestrator-Neustart verwirft den abgeleiteten Zustand (Medien, Hosts, Uhr) und schließt diese Probleme.
 */
export function problemsAt(items: TLItem[], atMs: number): OpenProblem[] {
  const open = new Map<string, OpenProblem>();
  const asc = items.filter((i) => i.source === "event" && Date.parse(i.at) <= atMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const i of asc) {
    const t = Date.parse(i.at);
    if (i.kind === "orchestrator.started") {
      for (const k of [...open.keys()]) if (!k.startsWith("instance:") && !k.startsWith("wf:")) open.delete(k);
      continue;
    }
    if (i.kind === "workflow.status") {
      const key = `wf:${i.subject}`;
      if (i.severity === "error") open.set(key, { key, since: t, item: i });
      else open.delete(key);
      continue;
    }
    const o = OPEN[i.kind];
    if (o) {
      const key = `${o.key}:${i.subject}`;
      if (!open.has(key)) open.set(key, { key, since: t, item: i });
      continue;
    }
    for (const [kind, def] of Object.entries(OPEN)) {
      if (def.close.includes(i.kind)) open.delete(`${def.key}:${i.subject}`);
      void kind;
    }
  }
  return [...open.values()].sort((a, b) => a.since - b.since);
}

/** Zeilen im Fenster (atMs − spanMs, atMs], neueste zuerst: „Was hat sich kurz davor geändert?“ */
export function changesBefore(items: TLItem[], atMs: number, spanMs: number): TLItem[] {
  return items
    .filter((i) => {
      const t = Date.parse(i.at);
      return t <= atMs && t > atMs - spanMs;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
