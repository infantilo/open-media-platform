// Reine Logik des Port-Tag-Editors (spiegelt orchestrator/internal/sourcetags:
// Format `domain.name`, höchstens 32 Tags je Quelle). Der Server prüft erneut —
// die Client-Prüfung dient nur der Sofort-Rückmeldung.

export const MAX_TAGS = 32;
const TAG_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

export type TagOrigin = "EXPLICIT" | "DERIVED" | "DISCOVERED";
export interface PortTag {
  tag: string;
  origin: TagOrigin;
}

export function isValidTag(tag: string): boolean {
  return tag.length <= 64 && TAG_RE.test(tag);
}

/** Eingabe normalisieren (Leerraum, Kleinschreibung). */
export function cleanTagInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export type AddResult = { ok: true; tags: string[] } | { ok: false; reason: "invalid" | "duplicate" | "limit" };

/** Fügt `raw` der Liste explizit gesetzter Tags hinzu. */
export function addTag(explicit: string[], raw: string): AddResult {
  const tag = cleanTagInput(raw);
  if (!isValidTag(tag)) return { ok: false, reason: "invalid" };
  if (explicit.includes(tag)) return { ok: false, reason: "duplicate" };
  if (explicit.length >= MAX_TAGS) return { ok: false, reason: "limit" };
  return { ok: true, tags: [...explicit, tag].sort() };
}

export function removeTag(explicit: string[], tag: string): string[] {
  return explicit.filter((t) => t !== tag);
}

/** Explizit gesetzte Tags aus der API-Antwort (`tags` mit Herkunft). */
export function explicitTags(tags: PortTag[]): string[] {
  return tags.filter((t) => t.origin === "EXPLICIT").map((t) => t.tag).sort();
}

/** Nicht editierbare Tags (abgeleitet/gemeldet), soweit nicht auch explizit gesetzt. */
export function inheritedTags(tags: PortTag[]): PortTag[] {
  const explicit = new Set(explicitTags(tags));
  return tags.filter((t) => t.origin !== "EXPLICIT" && !explicit.has(t.tag));
}

export function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((t, i) => t === [...b].sort()[i]);
}
