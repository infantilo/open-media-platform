// Zeitleiste der Events (Reiter „Zeitplan“): reine Rechnung ohne DOM. Fenster, Bahnen, Position in Prozent, Skalenstriche.

export interface TlEvent { id: string; name: string; state: string; plannedStart?: string; plannedEnd?: string }

export interface TlBar {
  id: string;
  lane: number;
  /** Position und Breite in Prozent des Fensters (auf das Fenster zugeschnitten). */
  left: number;
  width: number;
  /** Beginnt vor / endet nach dem Fenster. */
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Kein Ende geplant: Standarddauer angenommen. */
  openEnd: boolean;
  /** Überschneidet sich mit einem anderen Event derselben Zeit (nur Hinweis, kein Fehler). */
  overlaps: boolean;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Standarddauer für Events ohne geplantes Ende. */
export const DEFAULT_DURATION = HOUR;
/** Mindestbreite eines Balkens in Prozent, damit sehr kurze Events greifbar bleiben. */
export const MIN_WIDTH_PCT = 0.6;

export interface Win { from: number; to: number }

/** Fenster ab Tagesbeginn (lokal) von `anchor`, `days` Tage lang, um `shiftDays` verschoben. */
export function windowFor(anchor: number, days: number, shiftDays = 0): Win {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + shiftDays);
  const from = d.getTime();
  const e = new Date(from);
  e.setDate(e.getDate() + days);
  return { from, to: e.getTime() };
}

function span(e: TlEvent): { s: number; e: number; openEnd: boolean } | null {
  if (!e.plannedStart) return null;
  const s = Date.parse(e.plannedStart);
  if (!Number.isFinite(s)) return null;
  const en = e.plannedEnd ? Date.parse(e.plannedEnd) : NaN;
  const openEnd = !Number.isFinite(en) || en <= s;
  return { s, e: openEnd ? s + DEFAULT_DURATION : en, openEnd };
}

/** Events ohne Termin (kein plannedStart): gehören unter die Leiste. */
export function unscheduled(events: TlEvent[]): TlEvent[] {
  return events.filter((e) => span(e) === null);
}

/** Bahnen und Positionen aller Events, die das Fenster berühren; stabile Reihenfolge nach Beginn, dann Name. */
export function layout(events: TlEvent[], win: Win): TlBar[] {
  const items = events
    .map((ev) => ({ ev, sp: span(ev) }))
    .filter((x): x is { ev: TlEvent; sp: { s: number; e: number; openEnd: boolean } } => x.sp !== null && x.sp.e > win.from && x.sp.s < win.to)
    .sort((a, b) => a.sp.s - b.sp.s || a.ev.name.localeCompare(b.ev.name) || a.ev.id.localeCompare(b.ev.id));
  const laneEnds: number[] = [];
  const total = win.to - win.from;
  const bars: TlBar[] = [];
  for (const { ev, sp } of items) {
    let lane = laneEnds.findIndex((end) => end <= sp.s);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = sp.e;
    const cs = Math.max(sp.s, win.from);
    const ce = Math.min(sp.e, win.to);
    const left = ((cs - win.from) / total) * 100;
    const width = Math.min(Math.max(((ce - cs) / total) * 100, MIN_WIDTH_PCT), 100 - left);
    bars.push({ id: ev.id, lane, left, width, clippedStart: sp.s < win.from, clippedEnd: sp.e > win.to, openEnd: sp.openEnd, overlaps: false });
  }
  // Überschneidung = mindestens zwei Bahnen gleichzeitig belegt.
  const spans = new Map(items.map((x) => [x.ev.id, x.sp]));
  for (const b of bars) {
    const a = spans.get(b.id)!;
    b.overlaps = bars.some((o) => o.id !== b.id && (() => { const c = spans.get(o.id)!; return c.s < a.e && a.s < c.e; })());
  }
  return bars;
}

export function laneCount(bars: TlBar[]): number {
  return bars.reduce((m, b) => Math.max(m, b.lane + 1), 0);
}

export interface Tick { left: number; label: string; major: boolean }

/** Skalenstriche: bis 1 Tag alle 2 Stunden, bis 3 Tage alle 6 Stunden, sonst je Tag. `fmt` formatiert Datum/Uhrzeit (austauschbar für Tests). */
export function ticks(win: Win, fmt: { hour: (d: Date) => string; day: (d: Date) => string } = { hour: (d) => String(d.getHours()).padStart(2, "0"), day: (d) => `${d.getDate()}.${d.getMonth() + 1}.` }): Tick[] {
  const total = win.to - win.from;
  const days = Math.round(total / DAY);
  const stepH = days <= 1 ? 2 : days <= 3 ? 6 : 24;
  const out: Tick[] = [];
  const d = new Date(win.from);
  while (d.getTime() < win.to) {
    const major = d.getHours() === 0;
    out.push({ left: ((d.getTime() - win.from) / total) * 100, label: major || stepH === 24 ? fmt.day(d) : fmt.hour(d), major });
    d.setHours(d.getHours() + stepH);
  }
  return out;
}

/** Position der „Jetzt“-Linie in Prozent; null außerhalb des Fensters. */
export function nowPct(win: Win, now: number): number | null {
  if (now < win.from || now >= win.to) return null;
  return ((now - win.from) / (win.to - win.from)) * 100;
}
