// Reine Logik des Ketteneditors (106.13g): Stufen, Parameter-Eingabe, Kennungen.

export interface Stage { id: string; nodeType: string; where: "pre" | "post"; enabled?: boolean; label?: string; params?: Record<string, unknown> }
export interface StageType { nodeType: string; label?: string; video: boolean; audio: boolean }

export const MAX_STAGES = 8;

/** Parameterwert aus einer Texteingabe: Zahl, true/false, JSON-Objekt/-Liste oder sonst Text. */
export function parseParam(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch { /* bleibt Text */ }
  }
  return t;
}

export function paramText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Neue freie Kennung im Muster `<typ>-<n>` (a–z, 0–9, Bindestrich, höchstens 24 Zeichen). */
export function newStageId(nodeType: string, taken: string[]): string {
  const base = nodeType.replace(/^omp-/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "stufe";
  for (let i = 1; i < 100; i++) {
    const id = `${base}-${i}`;
    if (!taken.includes(id)) return id;
  }
  return `${base}-x`;
}

/** Schlägt vor dem Speichern Alarm: ergibt Schlüssel der Fehlermeldung oder null. */
export function validateStages(list: Stage[], types: StageType[]): string | null {
  if (list.length > MAX_STAGES) return "tooMany";
  const seen = new Set<string>();
  for (const s of list) {
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(s.id) || seen.has(s.id)) return "id";
    seen.add(s.id);
    if (!types.some((t) => t.nodeType === s.nodeType)) return "type";
  }
  return null;
}

/** Kurzbeschreibung der Kette für Listen: „Scaler → Normalizer → Filter“. */
export function chainSummary(list: Stage[] | null | undefined, types: StageType[], normalizer: string): string {
  if (list == null) return "";
  const name = (s: Stage) => s.label || types.find((t) => t.nodeType === s.nodeType)?.label || s.nodeType;
  const on = list.filter((s) => s.enabled !== false);
  return [...on.filter((s) => s.where === "pre").map(name), normalizer, ...on.filter((s) => s.where === "post").map(name)].join(" → ");
}
