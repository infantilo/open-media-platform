// Reine Logik des Diagnose-Panels (diagnose-panel.ts): Meldungen erklären,
// Zeit relativ ausdrücken, Server-Abfragen bauen.
export interface LogRow {
  id: number;
  occurredAt: string;
  level: string;
  message: string;
  traceId?: string;
  spanId?: string;
  nodeId?: string;
  hostId?: string;
  source: string;
}

export interface LogGroup {
  key: string;
  level: string;
  count: number;
  first: string;
  last: string;
  example: string;
  nodeIds: string[];
}

export type LevelId = "error" | "warn" | "info";
export const LEVELS: LevelId[] = ["error", "warn", "info"];
export type DiagRange = "1h" | "24h" | "7d" | "all";

// Bekannte Meldungen: Muster → verständliche Überschrift und Hinweis
// (i18n-Schlüssel "dg.x.<id>.title" / ".hint"). Ohne Treffer zeigt die UI
// die Meldung selbst im Wortlaut.
const KNOWN: { id: string; re: RegExp; param?: number }[] = [
  { id: "is05sender", re: /is05 PatchSenderStaged failed/ },
  { id: "proxyParam", re: /node proxy call failed \(GET \/params\/([\w.]+)\)/, param: 1 },
  { id: "proxyManifest", re: /node proxy call failed \(GET \/ui\/manifest/ },
  { id: "proxyOther", re: /node proxy call failed \((\w+) ([^)]*)\)/, param: 2 },
  { id: "restoreState", re: /failed to restore role state|giving up restoring role state|role state restore retry failed/ },
  { id: "registration", re: /registration timed out|failed to register/ },
];

export interface Explained {
  id: string;
  param?: string;
}

export function explain(message: string): Explained | undefined {
  for (const k of KNOWN) {
    const m = k.re.exec(message);
    if (m) return { id: k.id, param: k.param ? m[k.param] : undefined };
  }
  return undefined;
}

// Relative Zeit als [i18n-Schlüssel, Zahl].
export function relativeTime(iso: string, now = Date.now()): [string, number] {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return ["dg.ago.now", 0];
  if (s < 3600) return ["dg.ago.min", Math.round(s / 60)];
  if (s < 86400) return ["dg.ago.h", Math.round(s / 3600)];
  return ["dg.ago.d", Math.round(s / 86400)];
}

export function rangeSince(range: DiagRange, now = new Date()): string | undefined {
  const h = { "1h": 1, "24h": 24, "7d": 168, all: 0 }[range];
  return h ? new Date(now.getTime() - h * 3600_000).toISOString() : undefined;
}

export interface LogQuery {
  levels: Set<LevelId>;
  range: DiagRange;
  text: string;
  nodeId: string;
  traceId: string;
  msgKey: string;
  limit?: number;
  before?: number;
}

export function buildLogQuery(o: LogQuery): string {
  const p = new URLSearchParams();
  if (o.limit) p.set("limit", String(o.limit));
  if (o.before) p.set("before", String(o.before));
  // Alle drei Stufen = kein Stufenfilter.
  if (o.levels.size > 0 && o.levels.size < LEVELS.length) p.set("level", LEVELS.filter((l) => o.levels.has(l)).join(","));
  const since = rangeSince(o.range);
  if (since) p.set("since", since);
  if (o.text.trim()) p.set("q", o.text.trim());
  if (o.nodeId) p.set("nodeId", o.nodeId);
  if (o.traceId) p.set("traceId", o.traceId);
  if (o.msgKey) p.set("msgKey", o.msgKey);
  return p.toString();
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}
