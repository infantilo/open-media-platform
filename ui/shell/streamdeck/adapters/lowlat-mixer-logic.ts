// Studio-Mischer-Adapter (omp-lowlat-mixer), reine Logik: Streifen über die Spalten (MUTE / SEND / SELECT als Tastenzeilen, Pegel als
// Dial), Detailseiten EQ / Dynamik / Bus für den gewählten Streifen. Muster: audio-mixer-logic.ts. Schreiben nur über die Methode
// `setParam{name,value}` (Zahl oder Schalter 0/1) und `bus.N.mixMinus`; gelesen wird über `getParam` (`strips`, `buses`, Einzelwerte).

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";
import type { PlotSpec } from "../plot-logic.ts";

export type Mode = "mix" | "eq" | "dyn" | "bus";

export interface Item {
  id: string;
  label: string;
}

export interface LowlatState {
  strips: Item[];
  buses: Item[];
  /** Werte je vollem Parameternamen (`strip.1.gain`, `bus.2.limiter.enabled`, …). */
  values: Record<string, unknown>;
  /** Gewählter Streifen (Detailseiten). */
  sel: string | null;
  /** Gewählter Bus für SEND und die Bus-Seite. */
  bus: string;
  mode: Mode;
  focus: number;
}

export type Action =
  | { t: "set"; name: string; value: number }
  | { t: "mixminus"; bus: string; strip: string }
  | { t: "select"; id: string }
  | { t: "mode"; mode: Mode }
  | { t: "focus"; index: number }
  | { t: "nudge"; steps: number }
  | { t: "cycleBus" };

export interface ParamDef {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Voller Parametername für Strip `s` und Bus `b`. */
  name: (s: string, b: string) => string;
}

export interface ToggleDef {
  label: string;
  name: (s: string, b: string) => string;
  /** Wert, der als „an“ gilt (Standard: true). Für Sends: größer als −90 dB. */
  isOn?: (v: unknown) => boolean;
  /** Wert beim Einschalten / Ausschalten (Standard 1 / 0). */
  onValue?: number;
  offValue?: number;
}

const strip = (key: string) => (s: string) => `strip.${s}.${key}`;
const bus = (key: string) => (_s: string, b: string) => `bus.${b}.${key}`;

const eqGain = (n: number, label: string): ParamDef => ({ label, min: -24, max: 12, step: 0.5, unit: "dB", name: strip(`eq.b${n}.gain`) });

export const MODE_PARAMS: Record<Exclude<Mode, "mix">, { params: ParamDef[]; toggles: ToggleDef[] }> = {
  eq: {
    params: [eqGain(1, "Low"), eqGain(2, "Mid"), eqGain(3, "Mid 2"), eqGain(4, "High")],
    toggles: [
      { label: "EQ Bypass", name: strip("eq.bypass") },
      { label: "Hochpass", name: strip("eq.hp.enabled") },
    ],
  },
  dyn: {
    params: [
      { label: "Comp Thr", min: -60, max: 0, step: 1, unit: "dB", name: strip("comp.threshold") },
      { label: "Comp Ratio", min: 1, max: 20, step: 0.5, unit: ":1", name: strip("comp.ratio") },
      { label: "Makeup", min: 0, max: 24, step: 0.5, unit: "dB", name: strip("comp.makeup") },
      { label: "Gate Thr", min: -90, max: 0, step: 1, unit: "dB", name: strip("gate.threshold") },
    ],
    toggles: [
      { label: "Comp", name: strip("comp.enabled") },
      { label: "Gate", name: strip("gate.enabled") },
    ],
  },
  bus: {
    params: [
      { label: "Send", min: -90, max: 12, step: 1, unit: "dB", name: (s, b) => `strip.${s}.send.${b}` },
      { label: "Bus Pegel", min: -90, max: 12, step: 0.5, unit: "dB", name: bus("gain") },
      { label: "Limiter", min: -24, max: 0, step: 0.5, unit: "dB", name: bus("limiter.ceiling") },
    ],
    toggles: [
      { label: "Bus Mute", name: bus("mute") },
      { label: "Limiter an", name: bus("limiter.enabled") },
    ],
  },
};

export const GAIN = { min: -60, max: 12, step: 0.5 };
/** Ein Send gilt ab diesem Pegel als „an“. */
export const SEND_OFF_DB = -90;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const roundTo = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;

export function nudged(cur: number, steps: number, p: { min: number; max: number; step: number }): number {
  return roundTo(clamp(cur + steps * p.step, p.min, p.max), p.step);
}

export function fmt(v: unknown, unit: string): string {
  if (typeof v !== "number") return "–";
  if (v <= -90 && (unit === "dB")) return "−∞";
  const t = Math.abs(v) >= 100 ? v.toFixed(0) : (Math.round(v * 100) / 100).toString();
  return unit ? `${t} ${unit}` : t;
}

export const short = (c: Item) => c.label || c.id;

/** Zusätzlich je Modus gelesene Parameter (nur für die Kurvenanzeige). */
export function extraNames(s: LowlatState, mode: "eq" | "dyn"): string[] {
  if (!s.sel) return [];
  if (mode === "eq") {
    return ["eq.hp.enabled", "eq.hp.freq", ...[1, 2, 3, 4].flatMap((n) => [`eq.b${n}.freq`, `eq.b${n}.q`])].map((k) => `strip.${s.sel}.${k}`);
  }
  return [`strip.${s.sel}.comp.knee`, `strip.${s.sel}.gate.enabled`];
}

const num = (s: LowlatState, name: string): number | undefined => (typeof s.values[name] === "number" ? (s.values[name] as number) : undefined);
const flag = (s: LowlatState, name: string): boolean => s.values[name] === true;

const KINDS: ("low" | "peak" | "high")[] = ["low", "peak", "peak", "high"];
const DEF_F = [100, 1000, 3500, 8000];
const DEF_Q = [0.5, 1, 1, 2];

/** Kurven-Beschreibung für EQ/Dynamik aus den gelesenen Werten (Standardwerte, wo noch nichts gelesen). */
export function plotSpec(s: LowlatState, id: string, mode: Mode, focus: number): PlotSpec | null {
  const n = (key: string, d: number) => num(s, `strip.${id}.${key}`) ?? d;
  if (mode === "eq") {
    return {
      kind: "eq",
      bypass: flag(s, `strip.${id}.eq.bypass`),
      hp: flag(s, `strip.${id}.eq.hp.enabled`) ? n("eq.hp.freq", 80) : null,
      bands: KINDS.map((kind, i) => ({ kind, f: n(`eq.b${i + 1}.freq`, DEF_F[i]), q: n(`eq.b${i + 1}.q`, DEF_Q[i]), g: n(`eq.b${i + 1}.gain`, 0) })),
      focus,
    };
  }
  if (mode === "dyn") {
    return {
      kind: "dyn",
      on: flag(s, `strip.${id}.comp.enabled`),
      thr: n("comp.threshold", 0),
      ratio: n("comp.ratio", 1),
      makeup: n("comp.makeup", 0),
      knee: n("comp.knee", 0),
      gateOn: flag(s, `strip.${id}.gate.enabled`),
      gateThr: n("gate.threshold", -90),
    };
  }
  return null;
}

export interface LowlatLayout extends AdapterLayout {
  act: (Action | null)[][];
  dialAct: ({ name: string; p: Pick<ParamDef, "min" | "max" | "step">; press?: Action } | null)[];
}

function empty(rows: number, cols: number): { keys: (KeyDef | null)[][]; act: (Action | null)[][] } {
  return { keys: Array.from({ length: rows }, () => Array(cols).fill(null)), act: Array.from({ length: rows }, () => Array(cols).fill(null)) };
}

function toggleOn(s: LowlatState, t: ToggleDef, name: string): boolean {
  const v = s.values[name];
  return t.isOn ? t.isOn(v) : v === true;
}

export function toggleAction(t: ToggleDef, name: string, on: boolean): Action {
  return { t: "set", name, value: on ? (t.offValue ?? 0) : (t.onValue ?? 1) };
}

export function layoutLowlat(s: LowlatState, cols: number, rows: number, dialCount: number, page: number): LowlatLayout {
  const { keys, act } = empty(rows, cols);
  const dialAct: LowlatLayout["dialAct"] = [];
  const dials: (DialDef | null)[] = [];
  const sel = s.strips.find((c) => c.id === s.sel);
  const busItem = s.buses.find((b) => b.id === s.bus) ?? s.buses[0];
  const busId = busItem?.id ?? s.bus;

  if (s.mode !== "mix" && sel) {
    const m = MODE_PARAMS[s.mode];
    const modeKeys: [Mode, string][] = [["mix", "◀ Mix"], ["eq", "EQ"], ["dyn", "Dynamik"], ["bus", "Bus"]];
    modeKeys.forEach(([mode, label], i) => {
      if (i >= cols) return;
      keys[0][i] = { label, sub: i === 0 ? short(sel) : undefined, state: mode === s.mode ? "preset" : "off" };
      act[0][i] = { t: "mode", mode };
    });
    const focus = Math.min(s.focus, m.params.length - 1);
    const showSelectors = rows >= 2 && (rows >= 3 || page % 2 === 0);
    // Bus-Seite: erste Zelle der Parameterzeile wählt den Bus (weiter), danach die Parameter
    const offset = s.mode === "bus" ? 1 : 0;
    if (showSelectors) {
      if (s.mode === "bus" && cols > 0) {
        keys[1][0] = { label: busItem ? short(busItem) : "Bus", sub: "Bus weiter", state: "cue" };
        act[1][0] = { t: "cycleBus" };
      }
      m.params.forEach((p, i) => {
        const c = i + offset;
        if (c >= cols) return;
        keys[1][c] = { label: p.label, sub: fmt(num(s, p.name(sel.id, busId)), p.unit), state: i === focus ? "preset" : "off" };
        act[1][c] = { t: "focus", index: i };
      });
      m.toggles.forEach((t, j) => {
        const c = m.params.length + offset + j;
        if (c >= cols) return;
        const name = t.name(sel.id, busId);
        const on = toggleOn(s, t, name);
        keys[1][c] = { label: t.label, state: on ? "onair" : "off" };
        act[1][c] = toggleAction(t, name, on);
      });
      if (s.mode === "bus") {
        const c = m.params.length + offset + m.toggles.length;
        if (c < cols) {
          keys[1][c] = { label: "Mix-minus", sub: short(sel), state: "off" };
          act[1][c] = { t: "mixminus", bus: busId, strip: sel.id };
        }
      }
    }
    const fp = m.params[focus];
    const showNudge = rows >= 3 || (rows === 2 && page % 2 === 1);
    if (showNudge) {
      const r = rows >= 3 ? 2 : 1;
      const steps: [string, number][] = [["−", -1], ["+", 1], ["−−", -5], ["++", 5]];
      steps.forEach(([label, n], i) => {
        if (i >= cols) return;
        keys[r][i] = { label, sub: i === 0 ? `${fp.label} ${fmt(num(s, fp.name(sel.id, busId)), fp.unit)}` : undefined };
        act[r][i] = { t: "nudge", steps: n };
      });
    }
    m.params.slice(0, dialCount).forEach((p, i) => {
      const name = p.name(sel.id, busId);
      const cur = num(s, name);
      dials.push({ label: p.label, value: fmt(cur, p.unit), fill: cur === undefined ? undefined : (cur - p.min) / (p.max - p.min) });
      const t = m.toggles[i];
      dialAct.push({ name, p, press: t ? toggleAction(t, t.name(sel.id, busId), toggleOn(s, t, t.name(sel.id, busId))) : undefined });
    });
    const spec = plotSpec(s, sel.id, s.mode, focus);
    if (spec) {
      const start = m.params.length + m.toggles.length;
      const cw = Math.min(4, cols - start);
      if (rows >= 3 && cw >= 2) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < cw; c++) keys[r][start + c] = { plot: { spec, cx: c, cy: r, cw, ch: 3 } };
      }
      for (let i = 0; i < dialCount; i++) {
        const plot = { spec, cx: i, cy: 0, cw: dialCount, ch: 1 };
        dials[i] = dials[i] ? { ...dials[i]!, plot } : { label: "", value: "", plot };
      }
    }
    return { keys, act, dials, dialAct, pages: rows === 2 ? 2 : 1 };
  }

  // Mix-Seite: Streifen über die Spalten; Zeilen MUTE, SEND (zum gewählten Bus), SELECT
  const screens = rows >= 3 ? 1 : rows === 2 ? 2 : 3;
  const probe = Math.ceil(s.strips.length / cols) * screens;
  const reserve = probe > 1;
  const cap = Math.max(1, reserve ? cols - 1 : cols);
  const chPages = Math.max(1, Math.ceil(s.strips.length / cap));
  const pages = chPages * screens;
  const p = clamp(page, 0, pages - 1);
  const slice = s.strips.slice(Math.floor(p / screens) * cap, Math.floor(p / screens) * cap + cap);
  const screen = p % screens;
  const rowKinds: ("mute" | "send" | "sel")[] =
    rows >= 3 ? ["mute", "send", "sel"] : rows === 2 ? (screen === 0 ? ["mute", "sel"] : ["send", "sel"]) : [(["mute", "send", "sel"] as const)[screen]];
  slice.forEach((c, i) => {
    rowKinds.forEach((kind, r) => {
      if (kind === "mute") {
        const on = flag(s, `strip.${c.id}.mute`);
        keys[r][i] = { label: short(c), sub: "MUTE", state: on ? "onair" : "off" };
        act[r][i] = { t: "set", name: `strip.${c.id}.mute`, value: on ? 0 : 1 };
      } else if (kind === "send") {
        const name = `strip.${c.id}.send.${busId}`;
        const v = num(s, name);
        const on = v !== undefined && v > SEND_OFF_DB;
        keys[r][i] = { label: short(c), sub: `→ ${busItem ? short(busItem) : "Bus"}`, state: on ? "cue" : "off" };
        act[r][i] = { t: "set", name, value: on ? SEND_OFF_DB : 0 };
      } else {
        keys[r][i] = { label: short(c), sub: fmt(num(s, `strip.${c.id}.gain`), "dB"), state: c.id === s.sel ? "preset" : "off" };
        act[r][i] = { t: "select", id: c.id };
      }
    });
  });
  slice.slice(0, dialCount).forEach((c) => {
    const g = num(s, `strip.${c.id}.gain`);
    dials.push({ label: short(c), value: fmt(g, "dB"), fill: g === undefined ? undefined : (g - GAIN.min) / (GAIN.max - GAIN.min), dim: flag(s, `strip.${c.id}.mute`) });
    dialAct.push({ name: `strip.${c.id}.gain`, p: GAIN, press: { t: "set", name: `strip.${c.id}.mute`, value: flag(s, `strip.${c.id}.mute`) ? 0 : 1 } });
  });
  return { keys, act, dials, dialAct, pages };
}
