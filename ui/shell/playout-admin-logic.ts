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
