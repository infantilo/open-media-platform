// Rechenkern des Segue-Editors (RB7.3): Zeitachse, Marken ziehen, Blendkurven. Reine Funktionen ohne DOM — die Planung selbst
// (Startzeiten, Blenden) kommt immer vom Node (`POST …/segue/plan`, dieselbe Rechnung wie die Sendung); hier wird nur
// übersetzt zwischen Mausposition, Dateizeit und den Zahlen der Übergangs-Abweichung (`transition`).

export type CurveName = "linear" | "cosine" | "log";

/** Ein vom Node geplantes Element (Antwort von `/segue/plan`, Millisekunden ab Planstart). */
export interface Placed {
  id: string;
  startMs: number;
  offsetMs: number;
  fadeInMs: number;
  fadeInCurve: CurveName;
  stopAtMs: number | null;
  fadeOutMs: number;
  fadeOutCurve: CurveName;
  endMs: number;
  nextStartMs: number;
}

export interface Transition {
  fadeOutMs?: number;
  fadeInMs?: number;
  curveOut?: CurveName;
  curveIn?: CurveName;
  startShiftMs?: number;
}

/** Die vom Editor bearbeitbaren Marken eines Elements (Millisekunden in der Datei). */
export interface Marks {
  durationMs: number;
  somMs: number;
  introMs: number | null;
  outroMs: number | null;
}

export type MarkerKind = "aOutro" | "bStart" | "bIntro" | "bSom" | "fadeOutEnd" | "fadeInEnd";

/** Anstieg 0 → 1 über x ∈ [0, 1] — wie `omp-segue-player` (`mix.rs`, Curve::rise). */
export function rise(curve: CurveName, x: number): number {
  const v = Math.min(1, Math.max(0, x));
  switch (curve) {
    case "linear":
      return v;
    case "cosine":
      return Math.sin(v * Math.PI / 2);
    case "log":
      return v <= 0 ? 0 : Math.pow(10, (v - 1) * 3);
  }
}

/** Verstärkung (linear 0…1) einer Ausblendung nach `x` ∈ [0, 1] ihrer Länge. */
export const fall = (curve: CurveName, x: number): number => 1 - rise(curve, x);

/** Punkte (x, gain) für das Zeichnen einer Blende; `n` ≥ 2 Stützstellen. */
export function curvePoints(curve: CurveName, dir: "in" | "out", n = 32): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    pts.push([x, dir === "in" ? rise(curve, x) : fall(curve, x)]);
  }
  return pts;
}

/** Sichtfenster der Zeitachse: Millisekunden ↔ Bildpunkte. */
export interface View {
  fromMs: number;
  toMs: number;
  width: number;
}
export const msToX = (v: View, ms: number): number => ((ms - v.fromMs) / (v.toMs - v.fromMs)) * v.width;
export const xToMs = (v: View, x: number): number => v.fromMs + (x / v.width) * (v.toMs - v.fromMs);

/** Zoom um einen Fixpunkt (Mausposition): `factor` < 1 vergrößert. Mindestens 200 ms, höchstens `maxSpanMs` sichtbar. */
export function zoomView(v: View, atMs: number, factor: number, maxSpanMs: number): View {
  const span = Math.min(maxSpanMs, Math.max(200, (v.toMs - v.fromMs) * factor));
  const t = (atMs - v.fromMs) / (v.toMs - v.fromMs);
  const from = atMs - t * span;
  return { fromMs: from, toMs: from + span, width: v.width };
}

/** Anfangsfenster: um den Übergang, mit Vorlauf/Nachlauf. */
export function initialView(a: Placed, b: Placed, width: number, padMs = 12_000): View {
  const from = Math.max(0, Math.min(b.startMs, a.nextStartMs) - padMs);
  const to = Math.max(a.endMs, b.startMs + b.fadeInMs) + padMs;
  return { fromMs: from, toMs: Math.max(to, from + 1000), width };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v);

export interface Context {
  a: Marks;
  b: Marks;
  pa: Placed;
  pb: Placed;
  tr: Transition;
}

/** Position der Marke auf der Zeitachse (ms ab Planstart). */
export function markerTime(kind: MarkerKind, c: Context): number | null {
  const { a, b, pa, pb } = c;
  switch (kind) {
    case "aOutro":
      return pa.stopAtMs === null ? null : pa.startMs + (pa.stopAtMs - pa.offsetMs);
    case "bStart":
      return pb.startMs;
    case "bIntro":
      return b.introMs === null ? null : pb.startMs + (b.introMs - pb.offsetMs);
    case "bSom":
      return pb.startMs;
    case "fadeOutEnd":
      return pa.stopAtMs === null ? null : pa.startMs + (pa.stopAtMs - pa.offsetMs) + pa.fadeOutMs;
    case "fadeInEnd":
      return pb.startMs + pb.fadeInMs;
  }
  void a;
}

/** Änderung, die ein Ziehen auslöst: neue Marken-/Übergangswerte (nur die geänderten Felder). */
export interface Patch {
  a?: { outroMs?: number };
  b?: { introMs?: number; somMs?: number };
  tr?: Transition;
}

/**
 * Ziehen einer Marke nach `ms` (Zeitachse). Alle Ergebnisse sind auf die erlaubten Bereiche begrenzt und ganze Millisekunden.
 * - aOutro: Segue-Punkt in A (Datei); der Einsatz von B folgt über die Planung (Verschiebung bleibt erhalten).
 * - bStart: Einsatz von B → `startShiftMs` gegenüber dem Segue-Punkt von A (nie vor dem Start von A).
 * - bIntro / bSom: Marken in der Datei von B.
 * - fadeOutEnd / fadeInEnd: Blendlängen (nie negativ; Ausblenden höchstens bis zum Dateiende von A).
 */
export function dragMarker(kind: MarkerKind, ms: number, c: Context): Patch {
  const { a, b, pa, pb } = c;
  switch (kind) {
    case "aOutro": {
      const file = pa.offsetMs + (ms - pa.startMs);
      return { a: { outroMs: round(clamp(file, a.somMs, a.durationMs)) } };
    }
    case "bStart": {
      const segue = pa.startMs + ((pa.stopAtMs ?? a.durationMs) - pa.offsetMs);
      const shift = clamp(ms - segue, pa.startMs - segue, 600_000);
      return { tr: { ...c.tr, startShiftMs: round(shift) } };
    }
    case "bIntro": {
      const file = pb.offsetMs + (ms - pb.startMs);
      return { b: { introMs: round(clamp(file, b.somMs, b.durationMs)) } };
    }
    case "bSom": {
      return { b: { somMs: round(clamp(b.somMs + (ms - pb.startMs), 0, b.durationMs - 1)) } };
    }
    case "fadeOutEnd": {
      const segue = pa.startMs + ((pa.stopAtMs ?? a.durationMs) - pa.offsetMs);
      const tail = a.durationMs - (pa.stopAtMs ?? a.durationMs);
      return { tr: { ...c.tr, fadeOutMs: round(clamp(ms - segue, 0, tail)) } };
    }
    case "fadeInEnd": {
      return { tr: { ...c.tr, fadeInMs: round(clamp(ms - pb.startMs, 0, 60_000)) } };
    }
  }
}

/** Welche Marke liegt (innerhalb `tolPx`) unter der Maus? Nahe Marken: die mit dem kleinsten Abstand. */
export function hitMarker(x: number, v: View, times: Partial<Record<MarkerKind, number | null>>, tolPx = 7): MarkerKind | null {
  let best: MarkerKind | null = null;
  let bestD = tolPx + 1;
  for (const [k, t] of Object.entries(times) as Array<[MarkerKind, number | null | undefined]>) {
    if (t === null || t === undefined) continue;
    const d = Math.abs(msToX(v, t) - x);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Leerer Übergang? (dann beim Speichern weglassen, wie der Node). */
export function isEmptyTransition(t: Transition | undefined): boolean {
  return !t || Object.values(t).every((v) => v === undefined || v === null);
}

/** `mm:ss.mmm` für die Anzeige neben den Zahlenfeldern. */
export function fmtMs(ms: number): string {
  const neg = ms < 0;
  const a = Math.abs(Math.round(ms));
  const m = Math.floor(a / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const r = a % 1000;
  return `${neg ? "-" : ""}${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

// ---------- Vorhören (RB7.4) ----------

/** Zeitfenster des Vorhörens um den Übergang: ab `preMs` vor dem Segue-Punkt bis `postMs` nach dem Ende beider Blenden. */
export function previewWindow(pa: Placed, pb: Placed, preMs: number, postMs: number): { t0: number; t1: number } {
  const segue = pa.stopAtMs === null ? pa.endMs : pa.startMs + (pa.stopAtMs - pa.offsetMs);
  const t0 = Math.max(pa.startMs, Math.min(segue, pb.startMs) - Math.max(0, preMs));
  const t1 = Math.max(pa.endMs, pb.startMs + pb.fadeInMs) + Math.max(0, postMs);
  return { t0, t1: Math.min(t1, Math.max(pb.endMs, t0 + 1000)) };
}

/**
 * Welcher Dateiausschnitt einer Stimme liegt im Fenster [t0, t1]? `atMs` = Zeitachse-Beginn des Ausschnitts. Die Stimme belegt die Zeitachse
 * von `startMs` bis `endMs` (Ende nach dem Ausblenden); die Datei wird ab `offsetMs` gelesen.
 */
export function voiceSegment(p: Placed, t0: number, t1: number): { fileFromMs: number; fileToMs: number; atMs: number } | null {
  const a = Math.max(t0, p.startMs);
  const b = Math.min(t1, p.endMs);
  if (b <= a) return null;
  return { fileFromMs: p.offsetMs + (a - p.startMs), fileToMs: p.offsetMs + (b - p.startMs), atMs: a };
}

/** Verstärkung (linear, ohne Pegelkorrektur) einer Stimme zur Zeit `tMs`: Einblenden × Ausblenden, wie `omp-segue-player`. */
export function voiceGainAt(p: Placed, tMs: number): number {
  if (tMs < p.startMs || tMs >= p.endMs) return 0;
  let g = 1;
  if (p.fadeInMs > 0) g *= rise(p.fadeInCurve, (tMs - p.startMs) / p.fadeInMs);
  if (p.stopAtMs !== null) {
    const fadeStart = p.startMs + (p.stopAtMs - p.offsetMs);
    if (tMs >= fadeStart) g *= p.fadeOutMs > 0 ? fall(p.fadeOutCurve, (tMs - fadeStart) / p.fadeOutMs) : 0;
  }
  return g;
}

/** Verstärkungsverlauf einer Stimme über [from, to) mit `stepMs`-Raster (für `setValueCurveAtTime`). */
export function gainEnvelope(p: Placed, from: number, to: number, stepMs = 1): Float32Array {
  const n = Math.max(2, Math.ceil((to - from) / stepMs) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = voiceGainAt(p, from + i * stepMs);
  return out;
}

/** Rohes PCM (s16le, 2 Kanäle verschränkt) → zwei Float-Kanäle. */
export function pcmToChannels(raw: Uint8Array): [Float32Array, Float32Array] {
  const frames = Math.floor(raw.byteLength / 4);
  const view = new DataView(raw.buffer, raw.byteOffset, frames * 4);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = view.getInt16(i * 4, true) / 32768;
    r[i] = view.getInt16(i * 4 + 2, true) / 32768;
  }
  return [l, r];
}
