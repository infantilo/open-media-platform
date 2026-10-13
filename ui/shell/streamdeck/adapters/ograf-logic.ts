// OGraf-Adapter, reine Logik (Kap. 40.9): Vorlagen („Presets“) als Tastenraster,
// Steuerzeile TAKE / TAKE OUT / CONTINUE / ALLE AUS, On-Air-Anzeige je Ebene.
// Ebenen-ID = Vorlagen-ID (wie das Panel); TAKE = show, TAKE OUT = hide.

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";

export interface Template {
  id: string;
  label: string;
  stepCount: number;
}

export interface Layer {
  id: string;
  templateId: string;
  label: string;
  step: number;
  stepCount: number;
  canContinue: boolean;
}

export interface OgrafState {
  templates: Template[];
  layers: Layer[];
  /** Gewählte Vorlage (Preset). */
  sel: string | null;
}

export type OgrafAction =
  | { t: "pick"; id: string }
  | { t: "take" }
  | { t: "out" }
  | { t: "cont" }
  | { t: "clear" };

export interface OgrafLayout extends AdapterLayout {
  act: (OgrafAction | null)[][];
  dialAct: (OgrafAction | null)[];
}

const layerOf = (s: OgrafState, id: string | null) => (id ? s.layers.find((l) => l.id === id) : undefined);

/** Ebene, die CONTINUE bedient: die gewählte, sonst die einzige on-air. */
export function continueTarget(s: OgrafState): Layer | undefined {
  const l = layerOf(s, s.sel);
  if (l) return l;
  return s.layers.length === 1 ? s.layers[0] : undefined;
}

export function controlList(s: OgrafState): { key: KeyDef; act: OgrafAction }[] {
  const sel = s.templates.find((t) => t.id === s.sel);
  const onAir = !!layerOf(s, s.sel);
  const c = continueTarget(s);
  const multi = !!c && c.stepCount > 1;
  return [
    { key: { label: "TAKE", sub: sel?.label, state: sel && !onAir ? "preset" : "off", dim: !sel || onAir }, act: { t: "take" } },
    { key: { label: "TAKE OUT", state: onAir ? "onair" : "off", dim: !onAir }, act: { t: "out" } },
    {
      key: {
        label: "CONTINUE",
        sub: multi ? `${c!.step + 1}/${c!.stepCount}` : undefined,
        state: c?.canContinue ? "cue" : "off",
        dim: !c?.canContinue,
      },
      act: { t: "cont" },
    },
    { key: { label: "ALLE AUS", sub: s.layers.length ? `${s.layers.length} on air` : undefined, state: s.layers.length ? "error" : "off", dim: !s.layers.length }, act: { t: "clear" } },
  ];
}

function presetKey(s: OgrafState, t: Template): KeyDef {
  const l = layerOf(s, t.id);
  const selected = t.id === s.sel;
  return {
    label: t.label,
    sub: l ? (l.stepCount > 1 ? `ON AIR ${l.step + 1}/${l.stepCount}` : "ON AIR") : t.stepCount > 1 ? `${t.stepCount} Schritte` : undefined,
    state: l ? "onair" : selected ? "preset" : "off",
    // Gewählt und on air: Rahmen-Hinweis über den Untertitel
    ...(l && selected ? { icon: "▶" } : {}),
  };
}

export function dialsFor(s: OgrafState, count: number): (DialDef | null)[] {
  const sel = s.templates.find((t) => t.id === s.sel);
  const names = s.layers.map((l) => l.label).join(", ");
  const all: DialDef[] = [
    { label: "Preset", value: sel?.label ?? "–", fill: s.templates.length > 1 && sel ? s.templates.indexOf(sel) / (s.templates.length - 1) : undefined },
    { label: "TAKE/OUT", value: layerOf(s, s.sel) ? "ON AIR" : sel ? "bereit" : "–", dim: !sel },
    { label: "CONTINUE", value: continueTarget(s)?.canContinue ? "bereit" : "–", dim: !continueTarget(s)?.canContinue },
    { label: "On Air", value: s.layers.length ? `${s.layers.length}: ${names}` : "–", dim: !s.layers.length },
    { label: "ALLE AUS", value: s.layers.length ? "drücken" : "–", dim: !s.layers.length },
    { label: "", value: "" },
  ];
  return all.slice(0, count);
}

export function dialActions(count: number): (OgrafAction | null)[] {
  return [null, { t: "take" } as OgrafAction, { t: "cont" } as OgrafAction, null, { t: "clear" } as OgrafAction, null].slice(0, count);
}

export function layoutOgraf(s: OgrafState, cols: number, rows: number, dialCount: number, page: number): OgrafLayout {
  const ctrls = controlList(s);
  const n = s.templates.length;
  // Preset-Zeilen: bei ≥ 2 Zeilen alle außer der letzten; bei 1 Zeile eigene Seiten.
  const single = rows < 2;
  const presetRows = single ? 1 : rows - 1;
  // Blättern belegt die letzte Zelle (Broker): bei 1 Zeile ist das auch die der Steuerseite.
  const perPage = (reserve: boolean) => Math.max(1, presetRows * cols - (single && reserve ? 1 : 0));
  let cap = perPage(false);
  let pages = single ? 1 + Math.max(1, Math.ceil(n / cap)) : Math.max(1, Math.ceil(n / cap));
  if (single || pages > 1) {
    cap = perPage(true);
    pages = single ? 1 + Math.max(1, Math.ceil(n / cap)) : Math.max(1, Math.ceil(n / cap));
  }
  const ctrlSlots = single && pages > 1 ? cols - 1 : cols;
  const p = Math.min(Math.max(0, page), pages - 1);

  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (OgrafAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const putPresets = (row0: number, chunk: number, perRow: number) => {
    s.templates.slice(chunk * cap, chunk * cap + cap).forEach((t, i) => {
      const r = row0 + Math.floor(i / perRow), c = i % perRow;
      if (r < row0 + presetRows) {
        keys[r][c] = presetKey(s, t);
        act[r][c] = { t: "pick", id: t.id };
      }
    });
  };
  const putCtrls = (r: number) => {
    ctrls.slice(0, ctrlSlots).forEach((it, c) => {
      keys[r][c] = it.key;
      act[r][c] = it.act;
    });
  };
  if (!single) {
    putPresets(0, p, cols);
    putCtrls(rows - 1);
  } else if (p === 0) putCtrls(0);
  else putPresets(0, p - 1, cols);

  return { keys, act, dials: dialsFor(s, dialCount), dialAct: dialActions(dialCount), pages };
}

/** Nächste/vorherige Vorlage (Dial); ohne Auswahl die erste/letzte, an den Enden begrenzt. */
export function stepTemplate(s: OgrafState, delta: number): string | null {
  const n = s.templates.length;
  if (!n) return null;
  const i = s.templates.findIndex((t) => t.id === s.sel);
  const j = i < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, i + (delta > 0 ? 1 : -1)));
  return s.templates[j].id;
}
