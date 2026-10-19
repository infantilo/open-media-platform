// Logik des Einstellungsformulars des Eingangs (ohne DOM).
export const APPROVAL_MODES = ["none", "single", "dual"];
export const FIELD_TYPES = ["text", "longtext", "select", "multiselect", "tags", "date", "number"];
export const FIELD_ORDERS = ["", "progressive", "tt", "bb", "any"];

/* deno-lint-ignore no-explicit-any */
export type Cfg = Record<string, any>;

export function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter((x) => x !== "");
}
export const joinList = (a: string[] | undefined): string => (a ?? []).join(", ");

export function idFrom(label: string, existing: string[]): string {
  const base = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "feld";
  if (!existing.includes(base)) return base;
  for (let i = 2;; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export function moveItem<T>(a: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= a.length) return a;
  const b = a.slice();
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}

/** Prüfungen vor dem Speichern (Spiegel der Serverprüfung). */
export function validateReviewConfig(c: Cfg): { key: string; p0?: string }[] {
  const out: { key: string; p0?: string }[] = [];
  if (!APPROVAL_MODES.includes(c.approvalMode)) out.push({ key: "rv.cfg.err.mode" });
  const profiles = Object.values(c.qcProfiles ?? {}) as Cfg[];
  if (profiles.length === 0) out.push({ key: "rv.cfg.err.noprofile" });
  if (!(c.qcProfiles ?? {})[c.defaultQcProfile]) out.push({ key: "rv.cfg.err.default" });
  for (const p of profiles) {
    const fr = p.expect?.frameRate;
    if (fr && !/^\d+(\/\d+)?$/.test(fr)) out.push({ key: "rv.cfg.err.rate", p0: p.name || p.id });
  }
  const seen = new Set<string>();
  for (const f of (c.metadataFields ?? []) as Cfg[]) {
    if (!f.id || seen.has(f.id)) out.push({ key: "rv.cfg.err.fieldid", p0: f.label || f.id || "" });
    seen.add(f.id);
    if ((f.type === "select" || f.type === "multiselect") && !(f.values?.length)) out.push({ key: "rv.cfg.err.values", p0: f.label || f.id });
  }
  return out;
}
