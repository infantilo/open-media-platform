// Reine Logik der Multiview-Wand (106.13f): welche Events groß mit Bild gezeigt werden und wie die Klickflächen liegen.

export interface WallAlarm { id: string; lineId: string; lineName: string; kind: string; severity: string; text: string; since: string; ackedBy?: string }
export interface WallLine { id: string; name: string; level: string; umd: string; alarms: string[]; alarmItems?: WallAlarm[]; x: number; y: number; w: number; h: number }
export interface WallEvent {
  id: string; name: string; state: string; plannedStart?: string; level: string; previewNodeId?: string;
  canvasW: number; canvasH: number; lines: WallLine[]; alarmCount: number;
  hasPip?: boolean; pipLine?: string; pipLock?: string; notices?: WallAlarm[];
  access?: { role?: string; view: boolean; test: boolean; live: boolean; edit: boolean };
}

/** Hinweise, die noch nicht angezeigt wurden (nach Alarmkennung). */
export function newNotices(events: WallEvent[], seen: Set<string>): { event: WallEvent; alarm: WallAlarm }[] {
  const out: { event: WallEvent; alarm: WallAlarm }[] = [];
  for (const e of events) for (const a of e.notices ?? []) if (!seen.has(a.id)) out.push({ event: e, alarm: a });
  return out;
}

/** Höchstens so viele Bilder gleichzeitig (jedes Bild hält einen Multiviewer am Laufen, ~2 Kerne). */
export const MAX_PICTURES = 3;

/** Events mit Fehler oder Warnung kommen automatisch groß ins Bild, dazu die angehefteten; höchstens `MAX_PICTURES`. */
export function pictureIds(events: WallEvent[], pinned: Set<string>): string[] {
  const out: string[] = [];
  const live = (e: WallEvent) => e.state === "testing" || e.state === "live";
  for (const e of events) if (live(e) && (e.level === "bad" || e.level === "warn")) out.push(e.id);
  for (const e of events) if (live(e) && pinned.has(e.id) && !out.includes(e.id)) out.push(e.id);
  return out.slice(0, MAX_PICTURES);
}

/** Klickfläche einer Leitung in Prozent des Multiviewer-Bildes. */
export function hotspot(l: WallLine, w: number, h: number): { left: number; top: number; width: number; height: number } | null {
  if (!w || !h || !l.w || !l.h) return null;
  return { left: (l.x / w) * 100, top: (l.y / h) * 100, width: (l.w / w) * 100, height: (l.h / h) * 100 };
}

export const LEVEL_COLOR: Record<string, string> = { bad: "var(--omp-error)", warn: "var(--omp-cue)", ok: "var(--omp-preset)", "": "var(--omp-text-disabled)" };

/** Signatur der Wand: ändert sich nur, wenn sich Sichtbares ändert (kein Neuaufbau bei jedem Abruf). */
export function wallSignature(events: WallEvent[]): string {
  return events.map((e) => `${e.id}:${e.level}:${e.state}`).join("|");
}
