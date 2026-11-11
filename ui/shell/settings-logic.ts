import { t } from "./i18n.ts";
// Reine Logik der Einstellungs-Ansicht (Kapitel 29) — ohne DOM, testbar.

export interface OptionDef {
  key: string;
  label: string;
  description?: string;
  type: "string" | "path" | "int" | "float" | "enum" | "host" | "port" | "url";
  default?: string;
  group?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  choices?: { value: string; label?: string }[];
  pathKind?: "dir" | "file";
  mustExist?: boolean;
  /** Für den Node-Typ gespeicherter Wert ("" = Standard). */
  value?: string;
}

/** Optionen nach Gruppe, Reihenfolge der ersten Nennung bleibt erhalten. */
export function groupOptions<T extends { group?: string }>(opts: readonly T[], fallback = t("stl.0a6892")): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const o of opts) {
    const g = o.group || fallback;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  return [...groups.entries()];
}

/** Hinweistext unter dem Eingabefeld: Standard, Bereich, Pfadart. */
export function hintFor(o: OptionDef): string {
  const parts: string[] = [];
  if (o.default) parts.push(t("stl.440a36", { p0: o.default }));
  else parts.push(t("stl.36a797"));
  if (o.min !== undefined || o.max !== undefined) {
    parts.push(t("stl.cca832", { p0: o.min ?? "−∞", p1: o.max ?? "∞" }));
  }
  if (o.type === "path") parts.push(o.pathKind === "file" ? t("stl.e2aa67") : t("stl.6c4ca0"));
  if (o.type === "path" && o.mustExist) parts.push(t("stl.b2780d"));
  return parts.join(" · ");
}

/** Wirksamer Wert einer Option für eine Instanz: Instanz > Typ > Standard (zur Anzeige). */
export function effectiveValue(o: OptionDef, instanceOverride: string | undefined): { value: string; source: "instance" | "type" | "default" | "node" } {
  if (instanceOverride) return { value: instanceOverride, source: "instance" };
  if (o.value) return { value: o.value, source: "type" };
  if (o.default) return { value: o.default, source: "default" };
  return { value: "", source: "node" };
}

export function isDirty(current: string, saved: string): boolean {
  return current.trim() !== saved.trim();
}

/** Zahlenfelder bekommen ein numerisches Eingabefeld, alles andere Text/Auswahl. */
export function inputKind(o: OptionDef): "number" | "select" | "text" {
  if (o.type === "enum") return "select";
  if (o.type === "int" || o.type === "port" || o.type === "float") return "number";
  return "text";
}

export interface SystemItem {
  key: string;
  label: string;
  description: string;
  group: string;
  unit?: string;
  min: number;
  max: number;
  integer: boolean;
  active: string;
  override?: string;
  pendingRestart: boolean;
}

/** Suche: alle Wörter der Eingabe müssen (ohne Groß-/Kleinschreibung) in einem der Felder vorkommen; leere Eingabe trifft alles. */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export type SettingsTab = "nodes" | "system" | "mail" | "directory";
export const SETTINGS_TABS: SettingsTab[] = ["nodes", "system", "mail", "directory"];

/** Erster Reiter mit Treffern; bleibt beim aktuellen, wenn der Treffer hat oder es keine Treffer gibt. */
export function tabForQuery(current: SettingsTab, counts: Record<SettingsTab, number>): SettingsTab {
  if (counts[current] > 0) return current;
  return SETTINGS_TABS.find((t) => counts[t] > 0) ?? current;
}
