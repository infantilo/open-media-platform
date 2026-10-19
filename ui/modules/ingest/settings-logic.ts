// Logik des Einstellungsformulars der Aufnahme (ohne DOM): Argumentlisten, Prüfungen vor dem Speichern, Hilfsfunktionen für Profile.
export interface ConvertStep {
  ext: string;
  args: string[];
}
export interface Profile {
  id: string;
  label: string;
  ext: string;
  demand?: Record<string, number>;
  mcaPlan?: string;
  convert?: ConvertStep | null;
}
export interface HostBudget {
  hard?: Record<string, number>;
  softFraction?: number;
  functions?: string[];
}
export interface IngestConfig {
  profiles: Record<string, Profile>;
  defaultBudget: HostBudget;
  hostBudgets: Record<string, HostBudget>;
  rules: { reservePct?: Record<string, number>; reserveFromPriority?: number; sourceLimit?: number; sourceOverride?: Record<string, number>; allowPreempt?: boolean };
  leadTimeS: number;
  maxStartDeviationS: number;
  horizonHours: number;
  mediaDir: string;
  defaultLate: { mode?: string; maxDelayS?: number };
  defaultRetry: { maxAttempts?: number; backoffS?: number; minRemainingS?: number };
}

export const RESOURCE_KINDS = ["recorder_slots", "converter_slots", "cpu_cores", "mem_mb", "gpu_units", "disk_mbps", "disk_gb", "net_mbps", "mxl_shm_mb"];
/** Ressourcen, für die ein Aufnahmeprofil einen Bedarf angeben kann (Rekorder-Platz zählt immer 1). */
export const DEMAND_KINDS = ["cpu_cores", "mem_mb", "disk_mbps", "net_mbps", "mxl_shm_mb"];
export const FUNCTIONS = ["recorder", "converter"];
export const LATE_MODES = ["wait", "delay", "fail"];
export const FORMAT_PRESETS: { ext: string; label: string }[] = [
  { ext: ".mxf", label: "MXF (H.264 + PCM 24 Bit)" },
  { ext: ".mp4", label: "MP4" },
  { ext: ".mkv", label: "Matroska" },
  { ext: ".mov", label: "QuickTime" },
  { ext: ".ts", label: "MPEG-TS" },
];

/** Zerlegt eine Argumentzeile an Leerraum; Teile in doppelten Anführungszeichen bleiben zusammen. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

export function joinArgs(a: string[]): string {
  return a.map((x) => (x === "" || /\s/.test(x) ? `"${x}"` : x)).join(" ");
}

export function cloneConfig(c: IngestConfig): IngestConfig {
  return JSON.parse(JSON.stringify(c)) as IngestConfig;
}

/** Freie, lesbare Profil-ID aus der Bezeichnung (a–z, 0–9, Bindestrich), eindeutig gegenüber vorhandenen. */
export function newProfileId(label: string, existing: string[]): string {
  const base = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profil";
  if (!existing.includes(base)) return base;
  for (let i = 2;; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** Prüfungen vor dem Speichern (Spiegel der Server-Prüfung, damit Fehler am Feld erscheinen). Liefert Meldungsschlüssel + Parameter. */
export function validateConfig(c: IngestConfig): { key: string; p0?: string }[] {
  const out: { key: string; p0?: string }[] = [];
  if (!Number.isFinite(c.leadTimeS) || c.leadTimeS < 0 || c.leadTimeS > 3600) out.push({ key: "ing.cfg.err.lead" });
  if (!Number.isFinite(c.horizonHours) || c.horizonHours < 1 || c.horizonHours > 720) out.push({ key: "ing.cfg.err.horizon" });
  if (Object.keys(c.profiles).length === 0) out.push({ key: "ing.cfg.err.noprofile" });
  for (const p of Object.values(c.profiles)) {
    const nm = p.label || p.id;
    if (!/^\.[a-z0-9]{2,5}$/i.test(p.ext)) out.push({ key: "ing.cfg.err.ext", p0: nm });
    if (p.convert && (!/^\.[a-z0-9]{2,5}$/i.test(p.convert.ext) || p.convert.args.length === 0)) out.push({ key: "ing.cfg.err.convert", p0: nm });
    for (const v of Object.values(p.demand ?? {})) if (!(v >= 0)) out.push({ key: "ing.cfg.err.demand", p0: nm });
  }
  return out;
}

/** Zahl aus einem Eingabefeld; leer → undefined (Feld entfällt, Standard gilt). */
export function numOrUndef(s: string): number | undefined {
  const t = s.trim().replace(",", ".");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
