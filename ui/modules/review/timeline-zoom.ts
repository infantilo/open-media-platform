// Ausschnitt der Review-Zeitleiste (Zoom): welche Bilder [start, end) die Leiste und die Wellenform gerade zeigen.
// Rein rechnerisch (ohne DOM), damit Zoom, Verschieben und Mitlaufen des Spielkopfs testbar sind.

export interface View {
  start: number;
  end: number;
}

/** Kleinster Ausschnitt in Bildern — die Wellenform hat einen Spitzenwert je Bild, feiner gibt es nichts zu sehen. */
export const MIN_SPAN = 10;

export function fullView(total: number): View {
  return { start: 0, end: Math.max(1, total) };
}

export function span(v: View): number {
  return v.end - v.start;
}

/** Ausschnitt in [0, total] halten; Breite bleibt (zwischen MIN_SPAN und total), Rundung auf ganze Bilder. */
export function clampView(v: View, total: number): View {
  const t = Math.max(1, total);
  const s = Math.min(t, Math.max(Math.min(MIN_SPAN, t), Math.round(span(v))));
  const start = Math.min(t - s, Math.max(0, Math.round(v.start)));
  return { start, end: start + s };
}

/** `factor` > 1 vergrößert (zeigt weniger Bilder), < 1 verkleinert. Der Bildpunkt `anchor` bleibt an derselben Stelle. */
export function zoom(v: View, total: number, factor: number, anchor: number): View {
  const f = Math.min(Math.max(anchor, v.start), v.end);
  const ratio = span(v) > 0 ? (f - v.start) / span(v) : 0.5;
  const s = span(v) / factor;
  return clampView({ start: f - ratio * s, end: f - ratio * s + s }, total);
}

export function pan(v: View, total: number, frames: number): View {
  return clampView({ start: v.start + frames, end: v.end + frames }, total);
}

/** Läuft der Spielkopf aus dem Ausschnitt, wird der Ausschnitt seitenweise weitergeschoben (Spielkopf bei 10 %). */
export function follow(v: View, total: number, frame: number): View {
  if (frame >= v.start && frame < v.end) return v;
  return clampView({ start: frame - span(v) * 0.1, end: frame - span(v) * 0.1 + span(v) }, total);
}

/** Ausschnitt um einen Bereich (z. B. die Marken I/O) mit etwas Rand. */
export function around(a: number, b: number, total: number, margin = 0.15): View {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const pad = Math.max(2, (hi - lo) * margin);
  return clampView({ start: lo - pad, end: hi + pad }, total);
}

/** Lage eines Bildes im Ausschnitt: 0 = linker, 1 = rechter Rand (außerhalb: < 0 bzw. > 1). */
export function frameToFrac(v: View, frame: number): number {
  return (frame - v.start) / span(v);
}

export function fracToFrame(v: View, frac: number, total: number): number {
  return Math.min(total - 1, Math.max(0, Math.floor(v.start + frac * span(v))));
}

/** Bereich [a, b) im Ausschnitt als Anteil (links, Breite) — null, wenn nichts davon sichtbar ist. */
export function placeRange(v: View, a: number, b: number): { left: number; width: number } | null {
  const lo = Math.max(a, v.start);
  const hi = Math.min(b, v.end);
  if (hi <= lo && !(a === b && a >= v.start && a < v.end)) return null;
  return { left: frameToFrac(v, lo), width: Math.max(0, (hi - lo) / span(v)) };
}

export function zoomFactor(v: View, total: number): number {
  return Math.round((Math.max(1, total) / span(v)) * 10) / 10;
}

export function isZoomed(v: View, total: number): boolean {
  return span(v) < Math.max(1, total);
}
