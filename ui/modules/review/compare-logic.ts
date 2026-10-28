// Aufnahme-Vergleich (Kapitel 74.5): reine Darstellungslogik zur Antwort von POST /api/v1/review/items/{id}/compare.

export interface CompareCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skipped";
  original?: string;
  recorded?: string;
  message: string;
}

export interface CompareReport {
  overall: "pass" | "fail" | "warning";
  checks: CompareCheck[];
  ssim?: number;
  offsetSec?: number;
  offsetAuto?: boolean;
}

export interface CompareForm {
  offsetSec: string;
  durationTolMs: string;
  ssimMin: string;
  sampleSec: string;
  skipQuality: boolean;
  /** Vorlauf der Aufnahme aus den Bildern bestimmen lassen (Standard an). */
  autoOffset: boolean;
}

/** Optionen für die Anfrage: leere/ungültige Felder entfallen (dann gilt der Standard des Servers). */
export function compareOptions(f: CompareForm): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  const num = (v: string): number | null => {
    const n = Number(v.replace(",", "."));
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const offset = num(f.offsetSec);
  if (offset !== null && offset !== 0) out.offsetSec = offset;
  const tol = num(f.durationTolMs);
  if (tol !== null && tol > 0) out.durationTolMs = tol;
  const ssim = num(f.ssimMin);
  if (ssim !== null && ssim > 0 && ssim <= 1) out.ssimMin = ssim;
  const sample = num(f.sampleSec);
  if (sample !== null && sample > 0) out.sampleSec = sample;
  if (f.skipQuality) out.skipQuality = true;
  if (f.autoOffset) out.autoOffset = true;
  return out;
}

export const STATUS_ICON: Record<CompareCheck["status"], string> = { pass: "✓", fail: "✗", warn: "⚠", skipped: "–" };

/** Anzeigefarbe (CSS-Variable) je Status; unbekannte Werte neutral. */
export function statusColor(s: string): string {
  return s === "pass" ? "var(--omp-ok, #4caf50)" : s === "fail" ? "var(--omp-error, #e05252)" : s === "warn" ? "var(--omp-cue, #e0a030)" : "var(--omp-text-dim)";
}

/** Reihenfolge: Fehler zuerst, dann Hinweise, dann Bestandenes, Übersprungenes zuletzt. */
export function sortChecks(checks: CompareCheck[]): CompareCheck[] {
  const rank: Record<string, number> = { fail: 0, warn: 1, pass: 2, skipped: 3 };
  return [...checks].sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
}
