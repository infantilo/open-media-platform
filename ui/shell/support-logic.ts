// Reine Logik des Support-Tabs (support-panel.ts): Ampel-Befunde ordnen, Dateinamen und Adressen bauen.
export type SupportLevel = "ok" | "warn" | "err";

export interface SelftestCheck {
  id: string;
  group: string;
  level: SupportLevel;
  title: string;
  detail?: string;
  fix?: string;
  /** Fehlercode (OMP-nnnn) aus dem Katalog. */
  code?: string;
}

export interface SelftestReport {
  generatedAt: string;
  level: SupportLevel;
  summary: string;
  errors: number;
  warnings: number;
  checks: SelftestCheck[];
}

// Teilt die Befunde für die Anzeige: Probleme zuerst, „in Ordnung“ getrennt (eingeklappt).
export function splitChecks(r: SelftestReport): { problems: SelftestCheck[]; fine: SelftestCheck[] } {
  const rank = (l: SupportLevel) => (l === "err" ? 0 : l === "warn" ? 1 : 2);
  const sorted = [...r.checks].sort((a, b) => rank(a.level) - rank(b.level));
  return { problems: sorted.filter((c) => c.level !== "ok"), fine: sorted.filter((c) => c.level === "ok") };
}

export const BUNDLE_WINDOWS = [30, 120, 1440] as const;

export function bundleUrl(minutes: number): string {
  const m = (BUNDLE_WINDOWS as readonly number[]).includes(minutes) ? minutes : 120;
  return `/api/v1/admin/support-bundle?minutes=${m}`;
}

// Dateiname aus Content-Disposition; ohne Angabe ein fester Name mit Zeitstempel.
export function bundleFileName(disposition: string | null, now: Date): string {
  const m = disposition?.match(/filename="?([A-Za-z0-9._-]+\.zip)"?/);
  if (m) return m[1];
  const p = (n: number) => String(n).padStart(2, "0");
  return `omp-support-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

export function levelColor(l: SupportLevel): string {
  return l === "err" ? "var(--omp-error)" : l === "warn" ? "#e0a020" : "var(--omp-ok, #3fb950)";
}

export interface SupportGrant {
  id: string;
  createdBy: string;
  note?: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  useCount: number;
  lastUsedAt?: string;
}

export const ACCESS_DURATIONS = [60, 240, 1440, 4320] as const;

/** Der Link, den der Support öffnet; das Token steht hinter „#“ und geht so nie an einen Server oder in ein Zugriffsprotokoll. */
export function accessLink(origin: string, token: string): string {
  return `${origin}/#support=${encodeURIComponent(token)}`;
}

/** Aktive zuerst (die nächste Ablaufzeit oben), dann abgelaufene und widerrufene, neueste zuerst. */
export function sortGrants(list: SupportGrant[]): SupportGrant[] {
  const rank = (g: SupportGrant) => (g.status === "active" ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt) : Date.parse(b.createdAt) - Date.parse(a.createdAt)));
}

export interface FreezeMeta {
  id: string;
  createdAt: string;
  createdBy?: string;
  trigger: "manual" | "auto";
  reason?: string;
  note?: string;
  windowMinutes: number;
  scope?: string[];
  sizeBytes: number;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function freezeUrl(id: string): string {
  return `/api/v1/freezes/${encodeURIComponent(id)}/download`;
}
