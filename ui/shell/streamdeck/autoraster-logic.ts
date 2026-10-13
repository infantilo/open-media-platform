// Auto-Raster aus dem Descriptor (Kap. 40.4, K8 Teil 1): Nodes ohne eigenen
// Adapter bekommen Tasten für schreibbare bool-/enum-Parameter und
// argumentlose Methoden; schreibbare Zahlen mit Bereich → Dials.

import type { AdapterLayout } from "./adapter.ts";
import type { DialDef, KeyDef } from "./render-logic.ts";

export interface DescriptorParam {
  name: string;
  type: "number" | "boolean" | "enum" | "string";
  unit?: string | null;
  range?: { min: number; max: number } | { values: string[] } | null;
  readonly: boolean;
}
export interface Descriptor {
  parameters: DescriptorParam[];
  methods: { name: string; args: unknown[] }[];
}

export type AutoItem =
  | { kind: "toggle"; name: string }
  | { kind: "enum"; name: string; values: string[] }
  | { kind: "trigger"; name: string };
export interface DialItem {
  name: string;
  min: number;
  max: number;
  unit: string;
}

export function buildItems(d: Descriptor): AutoItem[] {
  const items: AutoItem[] = [];
  for (const p of d.parameters) {
    if (p.readonly) continue;
    if (p.type === "boolean") items.push({ kind: "toggle", name: p.name });
    else if (p.type === "enum" && p.range && "values" in p.range && p.range.values.length > 0) {
      items.push({ kind: "enum", name: p.name, values: p.range.values });
    }
  }
  for (const m of d.methods) if (m.args.length === 0) items.push({ kind: "trigger", name: m.name });
  return items;
}

export function buildDialItems(d: Descriptor): DialItem[] {
  const out: DialItem[] = [];
  for (const p of d.parameters) {
    if (!p.readonly && p.type === "number" && p.range && "min" in p.range && p.range.max > p.range.min) {
      out.push({ name: p.name, min: p.range.min, max: p.range.max, unit: p.unit ?? "" });
    }
  }
  return out;
}

/** Schrittweite je Raststellung: kleinste „schöne“ Zahl (1/2/5·10ⁿ) ≥ 1 % des Bereichs. */
export function dialStep(spec: DialItem): number {
  const raw = (spec.max - spec.min) / 100;
  const exp = Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    const v = m * Math.pow(10, exp);
    if (v >= raw * 0.999) return Math.round(v * 1e9) / 1e9;
  }
  return raw;
}

export function applyDial(value: number, delta: number, spec: DialItem): number {
  const v = Math.min(spec.max, Math.max(spec.min, value + delta * dialStep(spec)));
  return Math.round(v * 1e6) / 1e6;
}

export function nextEnum(values: string[], cur: unknown): string {
  const i = values.indexOf(String(cur));
  return values[(i + 1) % values.length];
}

export function shortName(name: string): string {
  return name.replace(/[._]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function keyFor(item: AutoItem, value: unknown): KeyDef {
  if (item.kind === "toggle") return { label: shortName(item.name), state: value === true ? "onair" : "off", dim: value === undefined };
  if (item.kind === "enum") return { label: shortName(item.name), sub: value === undefined ? undefined : String(value), state: "off" };
  return { label: shortName(item.name), state: "off", icon: "▶" };
}

export function formatDial(v: unknown, unit: string): string {
  if (typeof v !== "number") return "–";
  return `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ""}`;
}

export interface AutoLayout extends AdapterLayout {
  /** Zuordnung Zelle → Eintrag der aktuellen Seite. */
  cells: (AutoItem | null)[][];
  visible: AutoItem[];
  visibleDials: DialItem[];
}

export function layoutAuto(
  items: AutoItem[],
  dials: DialItem[],
  values: Record<string, unknown>,
  cols: number,
  rows: number,
  dialCount: number,
  page: number,
): AutoLayout {
  const cells = cols * rows;
  const perPage = items.length > cells ? cells - 1 : cells;
  const pages = Math.max(1, Math.ceil(items.length / Math.max(1, perPage)));
  const p = Math.min(Math.max(0, page), pages - 1);
  const visible = items.slice(p * perPage, p * perPage + perPage);
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const grid: (AutoItem | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  visible.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    keys[r][c] = keyFor(it, values[it.name]);
    grid[r][c] = it;
  });
  const dialPages = dialCount > 0 ? Math.max(1, Math.ceil(dials.length / dialCount)) : 1;
  const visibleDials = dialCount > 0 ? dials.slice((p % dialPages) * dialCount, (p % dialPages) * dialCount + dialCount) : [];
  const dd: (DialDef | null)[] = visibleDials.map((d) => ({ label: shortName(d.name), value: formatDial(values[d.name], d.unit), fill: typeof values[d.name] === "number" ? ((values[d.name] as number) - d.min) / (d.max - d.min) : undefined }));
  return { keys, dials: dd, pages: Math.max(pages, dialCount > 0 ? dialPages : 1), cells: grid, visible, visibleDials };
}
