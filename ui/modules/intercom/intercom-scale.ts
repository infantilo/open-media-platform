// Logik für große Einrichtungen (hundert und mehr Sprechstellen): Filter, Sammelaktionen und das sichtbare Fenster der Matrix.
// Reine Funktionen ohne DOM, damit sie getestet werden können.

import { addParty, type Config, getRoute, type Party, type PartyKind, pruneLayouts, setRoute } from "./intercom-logic.ts";

export interface PartyFilter {
  text: string;
  kind: PartyKind | "all";
  /** Nur Teilnehmer mit mindestens einer Zuordnung (true) bzw. ganz ohne (false); undefined = alle. */
  assigned?: boolean;
}

/** Teilnehmer nach Text (Name enthält, ohne Groß-/Kleinschreibung), Art und Zuordnung. Reihenfolge bleibt. */
export function filterParties(parties: Party[], f: PartyFilter): Party[] {
  const q = f.text.trim().toLowerCase();
  return parties.filter((p) => {
    if (q && !(p.name || `#${p.id}`).toLowerCase().includes(q)) return false;
    if (f.kind !== "all" && (p.kind ?? "human") !== f.kind) return false;
    if (f.assigned !== undefined && p.routes.some((r) => r.talk || r.listen) !== f.assigned) return false;
    return true;
  });
}

/** Kanäle nach Text filtern. */
export function filterChannels<T extends { id: number; name: string }>(channels: T[], text: string): T[] {
  const q = text.trim().toLowerCase();
  return q ? channels.filter((c) => (c.name || `#${c.id}`).toLowerCase().includes(q)) : channels;
}

/** Welche Zeilen sind sichtbar? [start, end) mit Puffer; Zeilen liegen mit fester Höhe untereinander. */
export function visibleWindow(scrollTop: number, viewHeight: number, rowHeight: number, total: number, buffer = 4): { start: number; end: number } {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const count = Math.ceil(Math.max(0, viewHeight) / rowHeight);
  return { start: Math.max(0, first - buffer), end: Math.min(total, first + count + buffer) };
}

/** Sprechen/Hören eines Kanals für viele Teilnehmer auf einmal. Liefert die Zahl der tatsächlich geänderten. */
export function setForParties(parties: Party[], ch: number, field: "talk" | "listen", on: boolean): number {
  let n = 0;
  for (const p of parties) {
    if (!!getRoute(p, ch)?.[field] === on) continue;
    setRoute(p, ch, field, on);
    n++;
  }
  return n;
}

/** Alle Zuordnungen eines Teilnehmers für viele Kanäle auf einmal (z. B. eine ganze Zeile löschen). */
export function setAllChannels(p: Party, channels: number[], field: "talk" | "listen", on: boolean): void {
  for (const ch of channels) if (!!getRoute(p, ch)?.[field] !== on) setRoute(p, ch, field, on);
}

/** Übernimmt die Zuordnungen von `src` bei allen `targets` (ersetzt deren bisherige). Pegel/Lage/VOX werden mitkopiert. */
export function copyRoutes(src: Party, targets: Party[]): number {
  let n = 0;
  for (const t of targets) {
    if (t.id === src.id) continue;
    t.routes = src.routes.filter((r) => r.talk || r.listen).map((r) => ({ ...r }));
    n++;
  }
  return n;
}

/** Nächste freie Nummer für „Präfix N“, sodass kein Name doppelt vergeben wird. */
function nextNumber(cfg: Config, prefix: string): number {
  const lower = new Set(cfg.parties.map((p) => p.name.trim().toLowerCase()));
  let n = 1;
  while (lower.has(`${prefix} ${n}`.trim().toLowerCase())) n++;
  return n;
}

export const MAX_BULK_ADD = 500;

/** Legt `count` Teilnehmer „Präfix 1…“ an (fortlaufend ab der ersten freien Nummer). Optional mit den Zuordnungen von `like`. */
export function addParties(cfg: Config, prefix: string, count: number, kind: PartyKind, like?: Party): Party[] {
  const n = Math.max(0, Math.min(MAX_BULK_ADD, Math.floor(count)));
  const pre = prefix.trim();
  const out: Party[] = [];
  let num = nextNumber(cfg, pre);
  for (let i = 0; i < n; i++, num++) {
    // Zwischendurch belegte Nummern überspringen (Namen bleiben eindeutig).
    while (cfg.parties.some((p) => p.name.trim().toLowerCase() === `${pre} ${num}`.trim().toLowerCase())) num++;
    const p = addParty(cfg, `${pre} ${num}`.trim());
    p.kind = kind;
    if (like) p.routes = like.routes.filter((r) => r.talk || r.listen).map((r) => ({ ...r }));
    out.push(p);
  }
  return out;
}

/** Duplikat mit eigenem Namen („Name 2“) und denselben Zuordnungen und Rechten (ohne Zugangs-Zuordnung zu Nutzern). */
export function duplicateParty(cfg: Config, id: number): Party | null {
  const src = cfg.parties.find((p) => p.id === id);
  if (!src) return null;
  const base = src.name.trim().replace(/\s+\d+$/, "");
  const [p] = addParties(cfg, base, 1, src.kind ?? "human", src);
  if (!p) return null;
  for (const k of ["priority", "force", "onair_lock", "open", "template", "mxl_in", "mxl_out"] as const) {
    if (src[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = src[k];
  }
  if (src.layout) p.layout = JSON.parse(JSON.stringify(src.layout));
  return p;
}

export function removeParties(cfg: Config, ids: Set<number>): number {
  const before = cfg.parties.length;
  cfg.parties = cfg.parties.filter((p) => !ids.has(p.id));
  pruneLayouts(cfg);
  return before - cfg.parties.length;
}

/** Kennzahlen für die Kopfzeile: Teilnehmer ohne jede Zuordnung, Zuordnungen insgesamt. */
export function matrixStats(cfg: Config): { parties: number; channels: number; unassigned: number; routes: number } {
  let routes = 0;
  let unassigned = 0;
  for (const p of cfg.parties) {
    const n = p.routes.filter((r) => r.talk || r.listen).length;
    routes += n;
    if (n === 0) unassigned++;
  }
  return { parties: cfg.parties.length, channels: cfg.channels.length, unassigned, routes };
}
