// Kurvenanzeigen für das Deck (EQ-Frequenzgang, Dynamik-Kennlinie): reine Rechnung,
// ohne Canvas (Zeichnen: plot-draw.ts). Eine Kurve überspannt mehrere Tasten bzw. Dial-
// Felder; jede Taste bekommt einen `PlotSlice` (Ausschnitt in Zellen).

export interface EqBand {
  kind: "low" | "peak" | "high";
  f: number;
  q: number;
  g: number;
}

export type PlotSpec =
  | { kind: "eq"; bypass: boolean; hp: number | null; bands: EqBand[]; focus: number }
  | { kind: "dyn"; on: boolean; thr: number; ratio: number; makeup: number; knee: number; gateOn: boolean; gateThr: number };

/** Ausschnitt der Kurve: Zelle (cx, cy) eines Blocks aus cw × ch Zellen. */
export interface PlotSlice {
  spec: PlotSpec;
  cx: number;
  cy: number;
  cw: number;
  ch: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Biquad-Betragsgang in dB (RBJ) — dieselbe Formel wie die Bildschirm-Anzeige/dsp.rs. */
export function biquadMagDb(kind: "hp" | "low" | "peak" | "high", f0: number, q: number, gainDb: number, f: number, fs = 48000): number {
  f0 = clamp(f0, 10, fs * 0.45);
  q = clamp(q, 0.1, 20);
  const w0 = (2 * Math.PI * f0) / fs, sw = Math.sin(w0), cw = Math.cos(w0);
  const alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "hp") {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (kind === "peak") {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else {
    const s = 2 * Math.sqrt(A) * alpha;
    if (kind === "low") {
      b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
    }
  }
  const w = (2 * Math.PI * f) / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Gesamt-Frequenzgang des EQ bei f Hz. */
export function eqResponseDb(spec: Extract<PlotSpec, { kind: "eq" }>, f: number): number {
  let db = spec.hp ? biquadMagDb("hp", spec.hp, Math.SQRT1_2, 0, f) : 0;
  for (const b of spec.bands) if (Math.abs(b.g) > 0.01) db += biquadMagDb(b.kind, b.f, b.q, b.g, f);
  return db;
}

/** Kompressor-Kennlinie (Eingang → Ausgang in dB) mit weichem Knie und Makeup. */
export function compOutDb(spec: Extract<PlotSpec, { kind: "dyn" }>, x: number): number {
  const { thr, ratio, knee, makeup } = spec;
  const r = Math.max(1, ratio);
  let y: number;
  if (2 * (x - thr) < -knee) y = x;
  else if (knee > 0 && 2 * Math.abs(x - thr) <= knee) y = x + ((1 / r - 1) * (x - thr + knee / 2) ** 2) / (2 * knee);
  else y = thr + (x - thr) / r;
  return y + makeup;
}

/** Q aus der API-Bandbreite (Hz): wie `dsp::bandwidth_to_q`. */
export const widthToQ = (freq: number, widthHz: number) => clamp(freq / Math.max(widthHz, 1), 0.1, 20);
