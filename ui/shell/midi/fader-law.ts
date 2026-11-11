// Fader-Kennlinie (Kap. 93): Stellung 0…1 ↔ Verstärkung in dB. OMP-Eigenlösung (es gibt keine Norm für die Kennlinie eines
// Mischpult-Faders): stückweise linear in dB, 0 dB bei 75 % Weg, +12 dB oben, −60 dB unten. **Dieselben Stützstellen wie der Bildschirm-Fader
// des Audiomischers** (`nodes/omp-audio-mixer/ui/00-core.js`, `FADER_POINTS`) — Fahrfader und Bildschirm-Fader stehen so an derselben Stelle.
// Der Audiomischer begrenzt `gain` auf −60…+12 dB (channel.<id>.setGain).

export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;

/** Stützstellen (Stellung, dB), streng steigend. */
const POINTS: readonly (readonly [number, number])[] = [
  [0, GAIN_MIN_DB],
  [0.15, -40],
  [0.35, -20],
  [0.55, -10],
  [0.75, 0],
  [1, GAIN_MAX_DB],
];

export const FADER_MAX = 16383;

export function positionToDb(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  for (let i = 1; i < POINTS.length; i++) {
    const [x1, y1] = POINTS[i];
    if (x <= x1) {
      const [x0, y0] = POINTS[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return GAIN_MAX_DB;
}

export function dbToPosition(db: number): number {
  const y = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, db));
  for (let i = 1; i < POINTS.length; i++) {
    const [x1, y1] = POINTS[i];
    if (y <= y1) {
      const [x0, y0] = POINTS[i - 1];
      return x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
    }
  }
  return 1;
}

/** 14-Bit-Pitchbend-Wert → dB, auf 0,1 dB gerundet (kein Rauschen auf der Leitung). */
export const faderToDb = (v14: number): number => Math.round(positionToDb(v14 / FADER_MAX) * 10) / 10;
export const dbToFader = (db: number): number => Math.round(dbToPosition(db) * FADER_MAX);
