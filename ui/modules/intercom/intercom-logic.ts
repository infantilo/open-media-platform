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
  layout?: Layout;
  template?: number;
  mxl_in?: number;
  mxl_out?: number;
  routes: Route[];
}
export type KeyType = "channel" | "call" | "all" | "reply" | "mute" | "dnd";
export interface Key {
  type: KeyType;
  ch?: number;
  party?: number;
  label?: string;
  style?: "strip" | "key";
}
export interface Page {
  name: string;
  keys: Key[];
}
export interface Layout {
  pages: Page[];
}
export interface Template {
  id: number;
  name: string;
  layout: Layout;
}

export const KEY_TYPES: KeyType[] = ["channel", "call", "all", "reply", "mute", "dnd"];
export const MAX_PAGES = 8;
export const MAX_KEYS = 48;

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
  templates?: Template[];
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
  pruneLayouts(cfg);
}

export function addParty(cfg: Config, name: string): Party {
  const p: Party = { id: nextId(cfg.parties), name, kind: "human", routes: [] };
  cfg.parties.push(p);
  return p;
}

export function removeParty(cfg: Config, id: number): void {
  cfg.parties = cfg.parties.filter((p) => p.id !== id);
  pruneLayouts(cfg);
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

// ---------- Panel-Layout ----------

export function newLayout(): Layout {
  return { pages: [{ name: "", keys: [] }] };
}

export function addPage(l: Layout): Page | null {
  if (l.pages.length >= MAX_PAGES) return null;
  const pg: Page = { name: "", keys: [] };
  l.pages.push(pg);
  return pg;
}

/** Entfernt eine Seite; die letzte Seite bleibt (ein Layout hat mindestens eine). */
export function removePage(l: Layout, i: number): void {
  if (l.pages.length > 1) l.pages.splice(i, 1);
}

export function movePage(l: Layout, i: number, delta: number): void {
  const j = i + delta;
  if (j < 0 || j >= l.pages.length) return;
  [l.pages[i], l.pages[j]] = [l.pages[j], l.pages[i]];
}

/** Neue Taste am Seitenende; `null`, wenn die Seite voll ist. */
export function addKey(l: Layout, page: number, type: KeyType, target?: number): Key | null {
  const pg = l.pages[page];
  if (!pg || pg.keys.length >= MAX_KEYS) return null;
  const k: Key = { type };
  if (type === "channel") {
    k.ch = target;
    k.style = "strip";
  }
  if (type === "call") k.party = target;
  pg.keys.push(k);
  return k;
}

export function moveKey(l: Layout, page: number, i: number, delta: number): void {
  const keys = l.pages[page]?.keys;
  const j = i + delta;
  if (!keys || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
}

export function removeKey(l: Layout, page: number, i: number): void {
  l.pages[page]?.keys.splice(i, 1);
}

/** Startpunkt „aus Zuteilung“: alle Kanäle des Teilnehmers als Karten, danach Rufen-Tasten der anderen Teilnehmer. */
export function layoutFromAssignment(p: Party, cfg: Config): Layout {
  const keys: Key[] = [];
  for (const r of [...p.routes].sort((a, b) => a.ch - b.ch)) {
    if (cfg.channels.some((c) => c.id === r.ch)) keys.push({ type: "channel", ch: r.ch, style: "strip" });
  }
  for (const o of cfg.parties) {
    if (o.id !== p.id && o.kind !== "program" && o.kind !== "port") keys.push({ type: "call", party: o.id });
  }
  return { pages: [{ name: "", keys: keys.slice(0, MAX_KEYS) }] };
}

/** Beschriftung einer Taste für die Vorschau (eigene Beschriftung, sonst Kanal-/Teilnehmername, sonst die Art). */
export function keyCaption(k: Key, cfg: Config, typeLabel: (t: KeyType) => string): string {
  if (k.label) return k.label;
  if (k.type === "channel") return cfg.channels.find((c) => c.id === k.ch)?.name || `#${k.ch ?? "?"}`;
  if (k.type === "call") return cfg.parties.find((p) => p.id === k.party)?.name || `#${k.party ?? "?"}`;
  return typeLabel(k.type);
}

/** Welches Layout gilt für den Teilnehmer: "own" (eigenes), "template" (Vorlage), "default" (Standardansicht)? */
export function layoutMode(p: Party): "own" | "template" | "default" {
  if (p.layout) return "own";
  return p.template ? "template" : "default";
}

export function addTemplate(cfg: Config, name: string): Template {
  cfg.templates ??= [];
  const t: Template = { id: nextId(cfg.templates), name, layout: newLayout() };
  cfg.templates.push(t);
  return t;
}

export function removeTemplate(cfg: Config, id: number): void {
  cfg.templates = (cfg.templates ?? []).filter((t) => t.id !== id);
  for (const p of cfg.parties) if (p.template === id) delete p.template;
}

/** Wirft Tasten weg, die auf gelöschte Kanäle/Teilnehmer zeigen, und Vorlagen-Verweise ins Leere. */
export function pruneLayouts(cfg: Config): void {
  const ch = new Set(cfg.channels.map((c) => c.id));
  const pa = new Set(cfg.parties.map((p) => p.id));
  const prune = (l: Layout | undefined) => {
    for (const pg of l?.pages ?? []) {
      pg.keys = pg.keys.filter((k) => (k.type === "channel" ? ch.has(k.ch ?? -1) : k.type === "call" ? pa.has(k.party ?? -1) : true));
    }
  };
  for (const p of cfg.parties) {
    prune(p.layout);
    if (p.template && !(cfg.templates ?? []).some((t) => t.id === p.template)) delete p.template;
  }
  for (const t of cfg.templates ?? []) prune(t.layout);
}

/** Layout vor dem Speichern bereinigen; ein Layout ohne jede Taste gilt als nicht gesetzt (`undefined`). */
export function cleanLayout(l: Layout | undefined): Layout | undefined {
  if (!l) return undefined;
  const out: Layout = {
    pages: l.pages.map((pg, i) => ({
      name: pg.name.trim() || (l.pages.length > 1 ? String(i + 1) : ""),
      keys: pg.keys.map((k) => {
        const c: Key = { type: k.type };
        if (k.type === "channel") {
          c.ch = k.ch;
          c.style = k.style === "key" ? "key" : "strip";
        }
        if (k.type === "call") c.party = k.party;
        if (k.label?.trim()) c.label = k.label.trim();
        return c;
      }),
    })),
  };
  return out.pages.some((pg) => pg.keys.length > 0) ? out : undefined;
}

/** Räumt einen Entwurf vor dem Speichern auf (Namen trimmen, leere Zuordnungen und Listen entfernen). */
export function cleanConfig(cfg: Config): Config {
  const out = clone(cfg);
  out.channels = out.channels.map((c) => ({ ...c, name: c.name.trim() }));
  out.parties = out.parties.map((p) => {
    const q: Party = { ...p, name: p.name.trim(), routes: p.routes.filter((r) => r.talk || r.listen).sort((a, b) => a.ch - b.ch) };
    if (!q.users?.length) delete q.users;
    if (!q.groups?.length) delete q.groups;
    const lay = cleanLayout(q.layout);
    if (lay) q.layout = lay;
    else delete q.layout;
    if (!q.template) delete q.template;
    if (!q.mxl_in) delete q.mxl_in;
    if (!q.mxl_out) delete q.mxl_out;
    if (q.kind !== "program" && q.kind !== "port") {
      delete q.mxl_in;
      delete q.mxl_out;
    }
    return q;
  });
  const tpl = (out.templates ?? []).map((t) => ({ ...t, name: t.name.trim(), layout: cleanLayout(t.layout) ?? newLayout() }));
  if (tpl.length) out.templates = tpl;
  else delete out.templates;
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
  const tseen = new Set<string>();
  for (const t of cfg.templates ?? []) {
    if (t.name.trim() === "") p.push(`#${t.id}`);
    const k = t.name.trim().toLowerCase();
    if (k && tseen.has(k)) p.push(t.name);
    tseen.add(k);
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
