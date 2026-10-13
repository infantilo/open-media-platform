// Audio-Mixer-Adapter, reine Logik (Kap. 40.6): Kanalstreifen über die
// Spalten (MUTE/PFL/SELECT als Tastenzeilen, Gain als Dial), Detailseiten
// EQ / Dynamik / Pan für den gewählten Kanal. Schreiben nur über die
// `channel.<id>.set*`-Methoden (Kanal-Parameter sind readonly).

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";
import { type PlotSpec, widthToQ } from "../plot-logic.ts";

export type Mode = "mix" | "eq" | "dyn" | "pan";

export interface Chan {
  id: string;
  label: string;
}

export interface AudioState {
  channels: Chan[];
  /** Werte je `<kanalId>.<prop>` (gain, mute, pfl, eqLow, …). */
  values: Record<string, unknown>;
  sel: string | null;
  mode: Mode;
  focus: number;
}

export type AudioAction =
  | { t: "call"; id: string; method: string; body: Record<string, unknown> }
  | { t: "select"; id: string }
  | { t: "mode"; mode: Mode }
  | { t: "focus"; index: number }
  | { t: "nudge"; steps: number };

export interface ParamDef {
  prop: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Methode + Argumente für einen neuen Wert. */
  set: (v: number) => { method: string; body: Record<string, unknown> };
}
export interface ToggleDef {
  prop: string;
  label: string;
  set: (on: boolean) => { method: string; body: Record<string, unknown> };
}

const eqBand = (prop: string, band: string, label: string): ParamDef => ({
  prop, label, min: -24, max: 12, step: 0.5, unit: "dB",
  set: (v) => ({ method: "setEqGain", body: { band, gainDb: v } }),
});

export const MODE_PARAMS: Record<Exclude<Mode, "mix">, { params: ParamDef[]; toggles: ToggleDef[] }> = {
  eq: {
    params: [eqBand("eqLow", "low", "Low"), eqBand("eqMid", "mid", "Mid"), eqBand("eqMid2", "mid2", "Mid 2"), eqBand("eqHigh", "high", "High")],
    toggles: [{ prop: "eqBypass", label: "EQ Bypass", set: (on) => ({ method: "setEqBypass", body: { bypass: on } }) }],
  },
  dyn: {
    params: [
      { prop: "compThreshold", label: "Comp Thr", min: -60, max: 0, step: 1, unit: "dB", set: (v) => ({ method: "setComp", body: { thresholdDb: v } }) },
      { prop: "compRatio", label: "Comp Ratio", min: 1, max: 20, step: 0.5, unit: ":1", set: (v) => ({ method: "setComp", body: { ratio: v } }) },
      { prop: "compMakeup", label: "Makeup", min: 0, max: 24, step: 0.5, unit: "dB", set: (v) => ({ method: "setComp", body: { makeupDb: v } }) },
      { prop: "gateThreshold", label: "Gate Thr", min: -90, max: 0, step: 1, unit: "dB", set: (v) => ({ method: "setGate", body: { thresholdDb: v } }) },
    ],
    toggles: [
      { prop: "compEnabled", label: "Comp", set: (on) => ({ method: "setComp", body: { enabled: on } }) },
      { prop: "gateEnabled", label: "Gate", set: (on) => ({ method: "setGate", body: { enabled: on } }) },
    ],
  },
  pan: {
    params: [{ prop: "pan", label: "Pan", min: -1, max: 1, step: 0.05, unit: "", set: (v) => ({ method: "setPan", body: { pan: v } }) }],
    toggles: [
      { prop: "phaseInvert", label: "Phase", set: (on) => ({ method: "setPhase", body: { invert: on } }) },
      { prop: "mainRoute", label: "Main", set: (on) => ({ method: "setMainRoute", body: { routed: on } }) },
    ],
  },
};

/** Zusätzlich je Modus gelesene Parameter (nur für die Kurvenanzeige). */
export const EXTRA_PROPS: Record<"eq" | "dyn", string[]> = {
  eq: ["eqHpEnabled", "eqHpFreq", ...["Low", "Mid", "Mid2", "High"].flatMap((b) => [`eq${b}Freq`, `eq${b}Width`])],
  dyn: ["compKnee"],
};

export const GAIN: Omit<ParamDef, "set" | "label"> = { prop: "gain", min: -60, max: 12, step: 0.5, unit: "dB" };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const roundTo = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;

export function nudged(cur: number, steps: number, p: { min: number; max: number; step: number }): number {
  return roundTo(clamp(cur + steps * p.step, p.min, p.max), p.step);
}

export function fmt(v: unknown, unit: string): string {
  if (typeof v !== "number") return "–";
  const t = Math.abs(v) >= 100 ? v.toFixed(0) : (Math.round(v * 100) / 100).toString();
  return unit ? `${t} ${unit}` : t;
}

export const chShort = (c: Chan) => c.label.replace(/^omp-/, "").replace(/\s+Sender\s*\d+$/i, "") || c.id;

const EQ_DEF: [string, "low" | "peak" | "high", number, number][] = [
  ["Low", "low", 100, 200],
  ["Mid", "peak", 1000, 1000],
  ["Mid2", "peak", 3500, 3500],
  ["High", "high", 8000, 4000],
];

/** Kurven-Beschreibung für EQ/Dynamik aus den gelesenen Werten (Standardwerte, wo noch nichts gelesen). */
export function plotSpec(s: AudioState, id: string, mode: Mode, focus: number): PlotSpec | null {
  const n = (prop: string, d: number) => num(s, id, prop) ?? d;
  if (mode === "eq") {
    return {
      kind: "eq",
      bypass: bool(s, id, "eqBypass"),
      hp: bool(s, id, "eqHpEnabled") ? n("eqHpFreq", 80) : null,
      bands: EQ_DEF.map(([b, kind, f0, w0]) => {
        const f = n(`eq${b}Freq`, f0);
        return { kind, f, q: widthToQ(f, n(`eq${b}Width`, w0)), g: n(`eq${b}`, 0) };
      }),
      focus,
    };
  }
  if (mode === "dyn") {
    return {
      kind: "dyn",
      on: bool(s, id, "compEnabled"),
      thr: n("compThreshold", 0),
      ratio: n("compRatio", 1),
      makeup: n("compMakeup", 0),
      knee: n("compKnee", 0),
      gateOn: bool(s, id, "gateEnabled"),
      gateThr: n("gateThreshold", -90),
    };
  }
  return null;
}

export interface AudioLayout extends AdapterLayout {
  act: (AudioAction | null)[][];
  /** Dial-Belegung der aktuellen Seite. */
  dialAct: ({ id: string; p: Pick<ParamDef, "min" | "max" | "step" | "prop"> & { set: (v: number) => { method: string; body: Record<string, unknown> } }; press?: AudioAction } | null)[];
}

const num = (s: AudioState, id: string, prop: string): number | undefined => {
  const v = s.values[`${id}.${prop}`];
  return typeof v === "number" ? v : undefined;
};
const bool = (s: AudioState, id: string, prop: string): boolean => s.values[`${id}.${prop}`] === true;

function empty(rows: number, cols: number): { keys: (KeyDef | null)[][]; act: (AudioAction | null)[][] } {
  return {
    keys: Array.from({ length: rows }, () => Array(cols).fill(null)),
    act: Array.from({ length: rows }, () => Array(cols).fill(null)),
  };
}

export function layoutAudioMixer(s: AudioState, cols: number, rows: number, dialCount: number, page: number): AudioLayout {
  const { keys, act } = empty(rows, cols);
  const dialAct: AudioLayout["dialAct"] = [];
  const dials: (DialDef | null)[] = [];
  const sel = s.channels.find((c) => c.id === s.sel);

  if (s.mode !== "mix" && sel) {
    // Detailseite des gewählten Kanals
    const m = MODE_PARAMS[s.mode];
    const modeKeys: [Mode, string][] = [["mix", "◀ Mix"], ["eq", "EQ"], ["dyn", "Dynamik"], ["pan", "Pan"]];
    modeKeys.forEach(([mode, label], i) => {
      if (i >= cols) return;
      keys[0][i] = { label, sub: i === 0 ? chShort(sel) : undefined, state: mode === s.mode ? "preset" : "off" };
      act[0][i] = { t: "mode", mode };
    });
    const focus = Math.min(s.focus, m.params.length - 1);
    const showSelectors = rows >= 2 && (rows >= 3 || page % 2 === 0);
    if (showSelectors) {
      m.params.forEach((p, i) => {
        if (i >= cols) return;
        keys[1][i] = { label: p.label, sub: fmt(num(s, sel.id, p.prop), p.unit), state: i === focus ? "preset" : "off" };
        act[1][i] = { t: "focus", index: i };
      });
      m.toggles.forEach((t, j) => {
        const c = m.params.length + j;
        if (c >= cols) return;
        const on = bool(s, sel.id, t.prop);
        keys[1][c] = { label: t.label, state: on ? "onair" : "off" };
        const a = t.set(!on);
        act[1][c] = { t: "call", id: sel.id, ...a };
      });
    }
    const fp = m.params[focus];
    const showNudge = rows >= 3 || (rows === 2 && page % 2 === 1);
    if (showNudge) {
      const r = rows >= 3 ? 2 : 1;
      const steps: [string, number][] = [["−", -1], ["+", 1], ["−−", -5], ["++", 5]];
      steps.forEach(([label, n], i) => {
        if (i >= cols) return;
        keys[r][i] = { label, sub: i === 0 ? `${fp.label} ${fmt(num(s, sel.id, fp.prop), fp.unit)}` : undefined };
        act[r][i] = { t: "nudge", steps: n };
      });
    }
    m.params.slice(0, dialCount).forEach((p, i) => {
      const cur = num(s, sel.id, p.prop);
      dials.push({ label: p.label, value: fmt(cur, p.unit), fill: cur === undefined ? undefined : (cur - p.min) / (p.max - p.min) });
      dialAct.push({ id: sel.id, p, press: m.toggles[i] ? { t: "call", id: sel.id, ...m.toggles[i].set(!bool(s, sel.id, m.toggles[i].prop)) } : undefined });
    });
    const spec = plotSpec(s, sel.id, s.mode, focus);
    if (spec) {
      // Kurve: Block rechts neben den Bedientasten (XL / + XL) …
      const start = m.params.length + m.toggles.length;
      const cw = Math.min(4, cols - start);
      if (rows >= 3 && cw >= 2) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < cw; c++) keys[r][start + c] = { plot: { spec, cx: c, cy: r, cw, ch: 3 } };
      }
      // … und auf dem Touch-Streifen unter den Dials („+“, „+ XL“).
      for (let i = 0; i < dialCount; i++) {
        const plot = { spec, cx: i, cy: 0, cw: dialCount, ch: 1 };
        dials[i] = dials[i] ? { ...dials[i]!, plot } : { label: "", value: "", plot };
      }
    }
    return { keys, act, dials, dialAct, pages: rows === 2 ? 2 : 1 };
  }

  // Mix-Seite: Streifen über die Spalten
  const screens = rows >= 3 ? 1 : rows === 2 ? 2 : 3;
  const probe = Math.ceil(s.channels.length / cols) * screens;
  const reserve = probe > 1;
  const cap = Math.max(1, reserve ? cols - 1 : cols);
  const chPages = Math.max(1, Math.ceil(s.channels.length / cap));
  const pages = chPages * screens;
  const p = clamp(page, 0, pages - 1);
  const slice = s.channels.slice(Math.floor(p / screens) * cap, Math.floor(p / screens) * cap + cap);
  const screen = p % screens;
  const rowKinds: ("mute" | "pfl" | "sel")[] =
    rows >= 3 ? ["mute", "pfl", "sel"] : rows === 2 ? (screen === 0 ? ["mute", "sel"] : ["pfl", "sel"]) : [(["mute", "pfl", "sel"] as const)[screen]];
  slice.forEach((c, i) => {
    rowKinds.forEach((kind, r) => {
      if (kind === "mute") {
        const on = bool(s, c.id, "mute");
        keys[r][i] = { label: chShort(c), sub: "MUTE", state: on ? "onair" : "off" };
        act[r][i] = { t: "call", id: c.id, method: "setMute", body: { muted: !on } };
      } else if (kind === "pfl") {
        const on = bool(s, c.id, "pfl");
        keys[r][i] = { label: chShort(c), sub: "PFL", state: on ? "cue" : "off" };
        act[r][i] = { t: "call", id: c.id, method: "setPfl", body: { enabled: !on } };
      } else {
        keys[r][i] = { label: chShort(c), sub: fmt(num(s, c.id, "gain"), "dB"), state: c.id === s.sel ? "preset" : "off" };
        act[r][i] = { t: "select", id: c.id };
      }
    });
  });
  slice.slice(0, dialCount).forEach((c) => {
    const g = num(s, c.id, "gain");
    dials.push({ label: chShort(c), value: fmt(g, "dB"), fill: g === undefined ? undefined : (g - GAIN.min) / (GAIN.max - GAIN.min), dim: bool(s, c.id, "mute") });
    dialAct.push({
      id: c.id,
      p: { ...GAIN, set: (v) => ({ method: "setGain", body: { db: v } }) },
      press: { t: "call", id: c.id, method: "setMute", body: { muted: !bool(s, c.id, "mute") } },
    });
  });
  return { keys, act, dials, dialAct, pages };
}
