// Zeitmodell des Review-Moduls — TypeScript-Spiegelung von orchestrator/internal/modules/review/timecode.go.
// Beide Seiten werden gegen dieselben Testvektoren (testdata/timecode_vectors.json) geprüft.
//
//  - Positionen sind ganzzahlige Frame-Indizes (0 = erstes Bild der Datei).
//  - Die Bildrate ist ein exakter Bruch (30000/1001, nicht 29.97).
//  - Bereiche sind [in, out): In inklusiv, Out exklusiv.
//  - Timecode ist reine Darstellung: Frame-Index + Start-Timecode der Datei.

export interface Rate {
  num: number;
  den: number;
}

export interface Timeline {
  rate: Rate;
  durationFrames: number;
  startFrames: number;
  dropFrame: boolean;
  vfr?: boolean;
}

export function parseRate(s: string): Rate | null {
  const m = /^\s*(\d+)(?:\/(\d+))?\s*$/.exec(s);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!(num > 0) || !(den > 0)) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export const nominal = (r: Rate): number => Math.floor((r.num + Math.floor(r.den / 2)) / r.den);
export const dropCapable = (r: Rate): boolean => r.den === 1001 && (r.num === 30000 || r.num === 60000);
const dropFrames = (r: Rate): number => Math.floor((2 * nominal(r)) / 30);
const pad = (n: number): string => String(n).padStart(2, "0");

export function formatTimecode(frame: number, r: Rate, drop: boolean): string {
  if (frame < 0) frame = 0;
  const fps = nominal(r);
  let sep = ":";
  if (drop && dropCapable(r)) {
    sep = ";";
    const d = dropFrames(r);
    const perMin = fps * 60 - d;
    const per10 = perMin * 10 + d;
    const tens = Math.floor(frame / per10);
    const rem = frame % per10;
    frame += 9 * d * tens;
    if (rem >= d) frame += d * Math.floor((rem - d) / perMin);
  }
  const ff = frame % fps;
  const s = Math.floor(frame / fps);
  return `${pad(Math.floor(s / 3600) % 100)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${sep}${pad(ff)}`;
}

export interface ParsedTimecode {
  frame: number;
  drop: boolean;
}

/** null bei ungültiger/nicht existierender Eingabe (z. B. 00:01:00;00 bei Drop-Frame). */
export function parseTimecode(s: string, r: Rate): ParsedTimecode | null {
  s = s.trim();
  const m = /^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/.exec(s);
  if (!m) return null;
  const [hh, mm, ss, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5])];
  const drop = m[4] !== ":";
  const fps = nominal(r);
  if (mm > 59 || ss > 59 || ff >= fps) return null;
  if (drop && !dropCapable(r)) return null;
  let total = (hh * 3600 + mm * 60 + ss) * fps + ff;
  if (drop) {
    const d = dropFrames(r);
    if (ss === 0 && ff < d && mm % 10 !== 0) return null;
    const totalMin = hh * 60 + mm;
    total -= d * (totalMin - Math.floor(totalMin / 10));
  }
  return { frame: total, drop };
}

export const timecodeOf = (tl: Timeline, n: number): string => formatTimecode(tl.startFrames + n, tl.rate, tl.dropFrame);

/** Frame-Index relativ zum Dateianfang; null außerhalb der Datei oder bei ungültigem Timecode. */
export function frameForTimecode(tl: Timeline, tc: string): number | null {
  const p = parseTimecode(tc, tl.rate);
  if (!p) return null;
  const n = p.frame - tl.startFrames;
  return n < 0 || n > tl.durationFrames ? null : n;
}

/** Medienzeit (Sekunden) in der MITTE von Bild n — Rundungsfehler treffen so nie das Nachbarbild. */
export const timeForFrame = (n: number, r: Rate): number => ((n + 0.5) * r.den) / r.num;

/** Bild, das zur Medienzeit t (Sekunden) sichtbar ist. */
export const frameForTime = (t: number, r: Rate): number => Math.max(0, Math.floor((t * r.num) / r.den + 1e-9));

/** Bild zu einer exakten Präsentationszeit (requestVideoFrameCallback.mediaTime = pts) — gerundet, weil pts auf dem Raster liegt. */
export const frameForPts = (pts: number, r: Rate): number => Math.max(0, Math.round((pts * r.num) / r.den));

export function validateRange(tl: Timeline, inF: number, outF: number, minFrames = 1): string | null {
  if (!Number.isInteger(inF) || !Number.isInteger(outF)) return "range.int";
  if (inF < 0) return "range.before";
  if (outF > tl.durationFrames) return "range.after";
  if (outF - inF < Math.max(1, minFrames)) return "range.short";
  return null;
}
