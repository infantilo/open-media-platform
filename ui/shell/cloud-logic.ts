// Reine Logik der Cloud-Ansicht (ARCHITECTURE.md §27, UMSETZUNG.md 35.7): Formularwerte ↔ API-Nutzlast,
// Budgetbalken, Geldformat. Kein DOM, damit testbar.

export type Mode = "off" | "suggest" | "auto";

// Wire-Format von GET/PUT /api/v1/cloud/policies (orchestrator/internal/cloud/policy.go).
export interface Policy {
  pool: string;
  mode: Mode;
  upCpuPercent: number;
  upMemPercent: number;
  upAfterSec: number;
  downCpuPercent: number;
  downAfterSec: number;
  cooldownSec: number;
  maxAutoHosts: number;
  dailyBudget: number;
  monthlyBudget: number;
}

// Formularwerte: Dauern in Minuten (bedienbar), Budgets als Text (leer = kein Deckel).
export interface PolicyForm {
  mode: Mode;
  upCpuPercent: string;
  upMemPercent: string;
  upAfterMin: string;
  downCpuPercent: string;
  downAfterMin: string;
  cooldownMin: string;
  maxAutoHosts: string;
  dailyBudget: string;
  monthlyBudget: string;
}

export function policyToForm(p: Policy): PolicyForm {
  return {
    mode: p.mode,
    upCpuPercent: String(p.upCpuPercent),
    upMemPercent: String(p.upMemPercent),
    upAfterMin: String(p.upAfterSec / 60),
    downCpuPercent: String(p.downCpuPercent),
    downAfterMin: String(p.downAfterSec / 60),
    cooldownMin: String(p.cooldownSec / 60),
    maxAutoHosts: String(p.maxAutoHosts),
    dailyBudget: p.dailyBudget > 0 ? String(p.dailyBudget) : "",
    monthlyBudget: p.monthlyBudget > 0 ? String(p.monthlyBudget) : "",
  };
}

function num(s: string): number {
  return Number(s.trim().replace(",", "."));
}

// Gibt die Nutzlast oder eine Fehlermeldung (Schlüssel) zurück. Spiegelt die wichtigsten Serverregeln, damit der
// Fehler vor dem Absenden erscheint; maßgeblich bleibt die Server-Validierung.
export function policyFromForm(pool: string, f: PolicyForm): { ok: true; policy: Policy } | { ok: false; error: string } {
  const p: Policy = {
    pool,
    mode: f.mode,
    upCpuPercent: num(f.upCpuPercent),
    upMemPercent: num(f.upMemPercent),
    upAfterSec: Math.round(num(f.upAfterMin) * 60),
    downCpuPercent: num(f.downCpuPercent),
    downAfterSec: Math.round(num(f.downAfterMin) * 60),
    cooldownSec: Math.round(num(f.cooldownMin) * 60),
    maxAutoHosts: Math.round(num(f.maxAutoHosts)),
    dailyBudget: f.dailyBudget.trim() === "" ? 0 : num(f.dailyBudget),
    monthlyBudget: f.monthlyBudget.trim() === "" ? 0 : num(f.monthlyBudget),
  };
  const nums = [p.upCpuPercent, p.upMemPercent, p.upAfterSec, p.downCpuPercent, p.downAfterSec, p.cooldownSec, p.maxAutoHosts, p.dailyBudget, p.monthlyBudget];
  if (nums.some((n) => !Number.isFinite(n))) return { ok: false, error: "cloudv.err.number" };
  if (p.downCpuPercent >= p.upCpuPercent) return { ok: false, error: "cloudv.err.hysteresis" };
  if (p.upAfterSec < 60 || p.downAfterSec < 60 || p.cooldownSec < 60) return { ok: false, error: "cloudv.err.duration" };
  if (p.dailyBudget < 0 || p.monthlyBudget < 0) return { ok: false, error: "cloudv.err.number" };
  if (p.mode === "auto" && p.dailyBudget === 0 && p.monthlyBudget === 0) return { ok: false, error: "cloudv.err.budget" };
  return { ok: true, policy: p };
}

// Anteil 0–100 für Balken: angefallen (dunkel) und hochgerechnet (hell) gegen den Deckel; ohne Deckel kein Balken.
export interface Bar {
  spentPct: number;
  projectedPct: number;
  over: boolean;
}

export function budgetBar(spent: number, projected: number, cap: number): Bar | null {
  if (!(cap > 0)) return null;
  const pct = (v: number) => Math.max(0, Math.min(100, (v / cap) * 100));
  return { spentPct: pct(spent), projectedPct: pct(projected), over: projected > cap };
}

export function fmtMoney(v: number, currency: string, locale = "de-DE"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency || "EUR", maximumFractionDigits: v < 10 ? 4 : 2, minimumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

// Reservierung: lokale datetime-local-Werte → ISO; Fehlerschlüssel bei ungültiger Eingabe.
export function reservationPayload(pool: string, count: string, from: string, to: string): { ok: true; body: { pool: string; hostCount: number; from: string; to: string } } | { ok: false; error: string } {
  const n = Math.round(num(count));
  const f = new Date(from);
  const t = new Date(to);
  if (!pool || !Number.isFinite(n) || n < 1) return { ok: false, error: "cloudv.err.count" };
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) return { ok: false, error: "cloudv.err.time" };
  return { ok: true, body: { pool, hostCount: n, from: f.toISOString(), to: t.toISOString() } };
}
