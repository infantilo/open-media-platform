// Reine Logik der Intercom-Einrichtung (ohne DOM): Entwurf bearbeiten, Matrix-Klicks, Aufräumen.

export interface Route {
  ch: number;
  talk: boolean;
  listen: boolean;
  level?: number;
  pan?: number;
  vox?: boolean;
}
export interface Channel {
  id: number;
  name: string;
  color?: string;
  kind?: "party" | "ifb";
  duck_db?: number;
}
export type PartyKind = "human" | "seat" | "program" | "port";
export interface Party {
  id: number;
  name: string;
  kind?: PartyKind;
  priority?: number;
  force?: boolean;
  onair_lock?: boolean;
  users?: string[];
  groups?: string[];
  open?: boolean;
  mxl_in?: number;
  mxl_out?: number;
  routes: Route[];
}
export interface Guest {
  id: number;
  name: string;
  expires: string;
  url?: string;
  routes: Route[];
}
export interface Config {
  channels: Channel[];
  parties: Party[];
  guests?: Guest[];
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Nächste freie ID (größte + 1, mindestens 1). */
export function nextId(items: { id: number }[]): number {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

export function addChannel(cfg: Config, name: string): Channel {
  const ch: Channel = { id: nextId(cfg.channels), name, kind: "party" };
  cfg.channels.push(ch);
  return ch;
}

/** Löscht einen Kanal und seine Zuordnungen bei allen Teilnehmern. */
export function removeChannel(cfg: Config, id: number): void {
  cfg.channels = cfg.channels.filter((c) => c.id !== id);
  for (const p of cfg.parties) p.routes = p.routes.filter((r) => r.ch !== id);
}

export function addParty(cfg: Config, name: string): Party {
  const p: Party = { id: nextId(cfg.parties), name, kind: "human", routes: [] };
  cfg.parties.push(p);
  return p;
}

export function removeParty(cfg: Config, id: number): void {
  cfg.parties = cfg.parties.filter((p) => p.id !== id);
}

export function getRoute(p: Party, ch: number): Route | undefined {
  return p.routes.find((r) => r.ch === ch);
}

/** Schaltet Sprechen/Hören eines Kanals. Eine Zuordnung ohne beides verschwindet. */
export function setRoute(p: Party, ch: number, field: "talk" | "listen", on: boolean): void {
  let r = getRoute(p, ch);
  if (!r) {
    r = { ch, talk: false, listen: false };
    p.routes.push(r);
  }
  r[field] = on;
  if (!r.talk && !r.listen) p.routes = p.routes.filter((x) => x.ch !== ch);
}

/** "anna, bob ,," → ["anna","bob"] */
export function splitList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** Räumt einen Entwurf vor dem Speichern auf (Namen trimmen, leere Zuordnungen und Listen entfernen). */
export function cleanConfig(cfg: Config): Config {
  const out = clone(cfg);
  out.channels = out.channels.map((c) => ({ ...c, name: c.name.trim() }));
  out.parties = out.parties.map((p) => {
    const q: Party = { ...p, name: p.name.trim(), routes: p.routes.filter((r) => r.talk || r.listen).sort((a, b) => a.ch - b.ch) };
    if (!q.users?.length) delete q.users;
    if (!q.groups?.length) delete q.groups;
    if (!q.mxl_in) delete q.mxl_in;
    if (!q.mxl_out) delete q.mxl_out;
    if (q.kind !== "program" && q.kind !== "port") {
      delete q.mxl_in;
      delete q.mxl_out;
    }
    return q;
  });
  delete out.guests; // Gäste verwaltet der Server über eigene Endpunkte
  return out;
}

/** Vorab-Prüfung für die Oberfläche (der Server prüft erneut und gewinnt). */
export function localProblems(cfg: Config): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  for (const c of cfg.channels) {
    if (c.name.trim() === "") p.push(`#${c.id}`);
    const k = c.name.trim().toLowerCase();
    if (k && seen.has(k)) p.push(c.name);
    seen.add(k);
  }
  const pseen = new Set<string>();
  for (const x of cfg.parties) {
    if (x.name.trim() === "") p.push(`#${x.id}`);
    const k = x.name.trim().toLowerCase();
    if (k && pseen.has(k)) p.push(x.name);
    pseen.add(k);
  }
  return p;
}

/** Zuordnungen eines Gasts aus den gewählten Kanälen (Sprechen und Hören). */
export function guestRoutes(selected: Set<number>, talk: boolean): Route[] {
  return [...selected].sort((a, b) => a - b).map((ch) => ({ ch, talk, listen: true }));
}

export function sameConfig(a: Config, b: Config): boolean {
  return JSON.stringify(cleanConfig(a)) === JSON.stringify(cleanConfig(b));
}
