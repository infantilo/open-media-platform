// Reine Logik der Playout-Admin-Ansicht (Kapitel 27 / P7) — ohne DOM, testbar.

export interface TriggerRecord {
  id: string;
  correlationId: string;
  originChannel: string;
  targetChannel: string;
  event: string;
  seq: number;
  status: string;
  detail?: string;
  createdAt: string;
  statusAt: string;
  targetTime?: string;
  latePolicy: string;
  attempts: number;
}

export interface TriggerRule {
  id: string;
  origin: string;
  target: string;
}

const STATUS_TEXT: Record<string, string> = {
  published: "zugestellt, wartet auf Quittung",
  scheduled: "geplant (Zielzeit)",
  applied: "ausgeführt",
  applied_late: "verspätet ausgeführt",
  skipped_late: "verspätet übersprungen",
  failed: "fehlgeschlagen",
  rejected: "abgelehnt (Ziel)",
  denied: "verweigert (keine Regel)",
  expired: "keine Quittung",
};

export function statusText(s: string): string {
  return STATUS_TEXT[s] ?? s;
}

/** Farbklasse: ok / warn / bad / neutral. */
export function statusTone(s: string): "ok" | "warn" | "bad" | "neutral" {
  switch (s) {
    case "applied":
      return "ok";
    case "applied_late":
    case "skipped_late":
    case "scheduled":
      return "warn";
    case "failed":
    case "rejected":
    case "denied":
    case "expired":
      return "bad";
    default:
      return "neutral";
  }
}

/** „channel:abc“ → „Channel National“, „group:regional“ → „Gruppe regional“, „*“ → „alle“. */
export function describeSelector(sel: string, channelName: (id: string) => string): string {
  if (sel === "*") return "alle";
  if (sel.startsWith("group:")) return `Gruppe ${sel.slice(6)}`;
  if (sel.startsWith("channel:")) return `Channel ${channelName(sel.slice(8))}`;
  return sel;
}

export interface TriggerGroup {
  correlationId: string;
  origin: string;
  event: string;
  at: string;
  items: TriggerRecord[];
}

/** Gruppiert Zustellungen nach Korrelations-ID (ein Trigger an eine Gruppe = mehrere Zeilen), neueste zuerst. */
export function groupByCorrelation(list: readonly TriggerRecord[]): TriggerGroup[] {
  const groups = new Map<string, TriggerGroup>();
  for (const r of list) {
    let g = groups.get(r.correlationId);
    if (!g) {
      g = { correlationId: r.correlationId, origin: r.originChannel, event: r.event, at: r.createdAt, items: [] };
      groups.set(r.correlationId, g);
    }
    g.items.push(r);
    if (r.createdAt > g.at) g.at = r.createdAt;
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => a.seq - b.seq || a.targetChannel.localeCompare(b.targetChannel));
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ---- As-Run (Kapitel 27 / P10, Spec §117–119) ----

export interface AsRunRow {
  key: string;
  kind: string; // primary | child | warning | trigger | operator
  recordedAt: string;
  eventId?: string;
  childId?: string;
  label?: string;
  asset?: string;
  source?: string;
  plannedStart?: string;
  actualStart?: string;
  plannedDurationMs?: number;
  actualEnd?: string;
  status?: string;
  reason?: string;
  mode?: string;
  operator?: string;
  action?: string;
  correlationId?: string;
}

const KIND_TEXT: Record<string, string> = {
  primary: "Event",
  child: "Child Event",
  warning: "Warnung",
  trigger: "Trigger",
  operator: "Bedienung",
};

export function asRunKindText(k: string): string {
  return KIND_TEXT[k] ?? k;
}

/** Abweichung Ist-Start − Plan-Start in Millisekunden (positiv = zu spät), `undefined` ohne Planzeit. */
export function startDeviationMs(r: AsRunRow): number | undefined {
  if (!r.plannedStart || !r.actualStart) return undefined;
  return Date.parse(r.actualStart) - Date.parse(r.plannedStart);
}

/** „+1,2 s“ / „−0,3 s“ / „±0“ bzw. „—“ ohne Planzeit. */
export function deviationText(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (Math.abs(ms) < 50) return "±0";
  const s = (Math.abs(ms) / 1000).toFixed(1).replace(".", ",");
  return `${ms > 0 ? "+" : "−"}${s} s`;
}

/** Ist-Dauer in ms (Start→Ende), `undefined` solange das Event läuft. */
export function actualDurationMs(r: AsRunRow): number | undefined {
  if (!r.actualStart || !r.actualEnd) return undefined;
  return Date.parse(r.actualEnd) - Date.parse(r.actualStart);
}

/** Dauer als „m:ss“. */
export function durationText(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Ton eines Endstatus: ok / warn / bad / neutral. */
export function asRunTone(r: AsRunRow): "ok" | "warn" | "bad" | "neutral" {
  if (r.kind === "warning") return "warn";
  switch (r.status) {
    case "COMPLETED":
      return "ok";
    case "RUNNING":
    case "ACTIVE":
    case "FIRED":
      return "neutral";
    case "FAILED":
      return "bad";
    case "STOPPED":
    case "INTERRUPTED":
      return "warn";
    default:
      return "neutral";
  }
}

/** Filtert nach Art (`""` = alle) und sortiert neueste zuerst. */
export function filterAsRun(rows: readonly AsRunRow[], kind: string): AsRunRow[] {
  return rows.filter((r) => !kind || r.kind === kind).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
}
