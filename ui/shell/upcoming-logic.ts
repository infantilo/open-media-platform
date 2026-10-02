// Reine Logik des Operator-Countdowns (ohne DOM, testbar).

export interface UpcomingStart {
  workflowId: string;
  workflowName: string;
  startsAt: string; // RFC 3339
}

/** „2 T 03:04:05“, „1:02:03“ bzw. „04:05“ — nie negativ. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d} T ${p(h)}:${p(m)}:${p(s)}`;
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

/** Der nächste noch bevorstehende Start (Server und Browser-Uhr können leicht abweichen). */
export function pickNext(list: UpcomingStart[], nowMs: number): UpcomingStart | null {
  let best: UpcomingStart | null = null;
  let bestAt = Infinity;
  for (const u of list) {
    const at = Date.parse(u.startsAt);
    if (Number.isFinite(at) && at > nowMs - 60_000 && at < bestAt) {
      best = u;
      bestAt = at;
    }
  }
  return best;
}
