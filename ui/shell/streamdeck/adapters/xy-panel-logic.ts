// X/Y-Panel-Adapter, reine Logik (Kap. 40.7): Quellenzeile, Zielzeile,
// Steuerzeile (TAKE, AUTO, TRENNEN, Medium, Blättern). Schalten über die
// Kern-API (POST/DELETE /api/v1/graph/edges), nie am Node vorbei.

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";
// Gemeinsame reine Logik mit dem X/Y-Panel (Ordnerbaum, Bouquets) — hängt `globalThis.OmpXyLogic` an.
import "../../../../nodes/omp-xy-panel/ui/logic.js";

// deno-lint-ignore no-explicit-any
const L = () => (globalThis as any).OmpXyLogic;

export interface Point {
  id: string;
  label: string;
  nodeLabel: string;
  mediaType: string;
  online: boolean;
  /** Für Ebenen (Ordnerbaum) und Bouquets; fehlt in einfachen Aufrufen. */
  nodeId?: string;
  tags?: string[];
}

/** Ordnerbaum des Panels (`OmpXyLogic.buildModel`), null = keine Ebenen. */
// deno-lint-ignore no-explicit-any
export type XyModel = any;
// deno-lint-ignore no-explicit-any
export type Bouquet = any;

export type Media = "" | "video" | "audio" | "data";
export const MEDIA_CYCLE: Media[] = ["", "video", "audio", "data"];
const MEDIA_LABEL: Record<string, string> = { "": "Alle", video: "Video", audio: "Audio", data: "Daten" };

export interface XyState {
  sources: Point[];
  sinks: Point[];
  /** Receiver-ID → Sender-ID */
  routes: Record<string, string>;
  selSrc: string | null;
  selDst: string | null;
  media: Media;
  auto: boolean;
  srcOff: number;
  dstOff: number;
  /** Kategorie (= Node-Name) je Seite; null/fehlt = alle */
  srcCat?: string | null;
  dstCat?: string | null;
  srcCatOff?: number;
  dstCatOff?: number;
  /** Ebenen: Ordner-IDs ab Home je Seite (leer = Home). */
  srcPath?: string[];
  dstPath?: string[];
  model?: XyModel | null;
  bouquets?: Bouquet[];
  /** Rückgängig möglich (verbleibende Sekunden), 0/fehlt = nein. */
  undoSecs?: number;
  /** Zuletzt geschaltetes Bouquet (Anzeige): ID, Anzahl geschaltet, Anzahl Fehler. */
  lastRun?: { id: string; ok: number; bad: number } | null;
  /** Ebenen-Cursor der Dials (Index in `topEntries`) je Seite; `levelMode`: Dial 1/2 steuern die Ebenen („+“ ohne Zusatz-Dials). */
  srcCur?: number;
  dstCur?: number;
  levelMode?: boolean;
  /** Aufzeichnung eines Bouquets: gesammelte Schaltungen statt sofort zu schalten; null/fehlt = aus. */
  draft?: { from: Point; to: Point }[] | null;
  /** true: Speichern möglich (Recht `configure` + Schnittstelle) → Bouquet-Seite auch ohne vorhandene Bouquets, Aufzeichnen-Tasten. */
  canSaveBouquets?: boolean;
}

export type Side = "src" | "dst";

export type XyAction =
  | { t: "src"; id: string }
  | { t: "dst"; id: string }
  | { t: "take" }
  | { t: "disc" }
  | { t: "auto" }
  | { t: "media" }
  | { t: "cat"; side: Side; name: string | null }
  | { t: "more"; side: Side; what: "cat" | "pt" }
  | { t: "folder"; side: Side; id: string }
  | { t: "up"; side: Side }
  | { t: "bq"; id: string }
  | { t: "undo" }
  | { t: "rec" }
  | { t: "recSave" }
  | { t: "recDrop" }
  | { t: "scroll"; row: "src" | "dst"; dir: 1 | -1 };

const strip = (s: string) => String(s ?? "").replace(/\s*\([0-9a-f]{8}\)/g, "");
export const pointName = (p: Point) => {
  const n = strip(p.nodeLabel).replace(/^omp-/, "");
  const l = strip(p.label);
  return l.startsWith(strip(p.nodeLabel)) && l.length > strip(p.nodeLabel).length ? l.slice(strip(p.nodeLabel).length).trim() || l : l;
};

export function compatible(a: Point | undefined, b: Point | undefined): boolean {
  if (!a || !b) return false;
  if (!a.mediaType || !b.mediaType) return true;
  return a.mediaType === b.mediaType;
}

export const visible = (pts: Point[], media: Media) => pts.filter((p) => !media || p.mediaType === media);

/** Nächster/vorheriger Eintrag (für Dial-Auswahl); ohne Auswahl der erste/letzte. */
export function stepSelection(pts: Point[], cur: string | null, delta: number): string | null {
  if (!pts.length) return null;
  const i = pts.findIndex((p) => p.id === cur);
  const n = i < 0 ? (delta > 0 ? 0 : pts.length - 1) : Math.min(pts.length - 1, Math.max(0, i + (delta > 0 ? 1 : -1)));
  return pts[n].id;
}

export const nodeOf = (p: Point) => strip(p.nodeLabel).replace(/^omp-/, "") || "?";

/** Kategorien einer Seite: Node-Namen in Reihenfolge des ersten Auftretens. */
export function categories(pts: Point[]): string[] {
  return [...new Set(pts.map(nodeOf))];
}

/** Punkte nach Medium und Kategorie gefiltert. */
export function filtered(pts: Point[], media: Media, cat: string | null | undefined): Point[] {
  return visible(pts, media).filter((p) => !cat || nodeOf(p) === cat);
}

/** Tastentext: hat der Node nur einen Punkt auf dieser Seite, zählt der Node-Name („Viewer“ statt „Receiver 1“). */
export function keyName(p: Point, all: Point[]): string {
  return all.filter((x) => nodeOf(x) === nodeOf(p)).length === 1 ? nodeOf(p) : pointName(p);
}

/** Schaltflächen-Spalte (Mitte) im Spaltenlayout. */
export function columnControls(s: XyState): { key: KeyDef; act: XyAction }[] {
  const c = controlList(s);
  const by = (l: string) => c.find((x) => x.key.label === l)!;
  return [by("TAKE"), by("Trennen"), by("AUTO"), by("Medium")];
}

export interface XyLayout extends AdapterLayout {
  act: (XyAction | null)[][];
}

export function controlList(s: XyState): { key: KeyDef; act: XyAction }[] {
  const canTake = !!s.selSrc && !!s.selDst;
  return [
    { key: { label: "TAKE", sub: s.draft ? `● ${s.draft.length}` : undefined, state: canTake ? "onair" : "off", dim: !canTake }, act: { t: "take" } },
    { key: { label: "AUTO", sub: s.auto ? "an" : "aus", state: s.auto ? "preset" : "off" }, act: { t: "auto" } },
    { key: { label: "Medium", sub: MEDIA_LABEL[s.media] }, act: { t: "media" } },
    { key: { label: "Trennen", dim: !s.selDst }, act: { t: "disc" } },
    { key: { label: "◀ Quellen" }, act: { t: "scroll", row: "src", dir: -1 } },
    { key: { label: "Quellen ▶" }, act: { t: "scroll", row: "src", dir: 1 } },
    { key: { label: "◀ Ziele" }, act: { t: "scroll", row: "dst", dir: -1 } },
    { key: { label: "Ziele ▶" }, act: { t: "scroll", row: "dst", dir: 1 } },
  ];
}

function plan(ctrls: number, cols: number, rows: number, reserve: boolean) {
  const ctrlRows = rows >= 3 ? rows - 2 : rows;
  const cap = Math.max(1, ctrlRows * cols - (reserve ? 1 : 0));
  const chunks = Math.max(1, Math.ceil(ctrls / cap));
  const pages = rows >= 3 ? chunks : rows === 2 ? 1 + chunks : 2 + chunks;
  return { cap, chunks, pages };
}

const pathOf = (s: XyState, side: Side) => (side === "src" ? s.srcPath : s.dstPath) ?? [];
const catOf = (s: XyState, side: Side) => (side === "src" ? s.srcCat : s.dstCat) ?? null;
const allOf = (s: XyState, side: Side) => (side === "src" ? s.sources : s.sinks);

/** Punkte im Bereich der aktuellen Ebene (rekursiv unterhalb des Ordners); Home = alle. */
export function scoped(s: XyState, side: Side): Point[] {
  const all = allOf(s, side);
  const path = pathOf(s, side);
  if (!path.length || !s.model) return all;
  const ids = new Set<string>(L().folderNodeIds(s.model, path[path.length - 1]));
  return all.filter((p) => p.nodeId !== undefined && ids.has(p.nodeId));
}

/** Punkte, die eine Seite gerade zeigt: Ebene + Medium + Kategorie (Node). */
export const sideList = (s: XyState, side: Side): Point[] => filtered(scoped(s, side), s.media, catOf(s, side));

/** Pfad auf vorhandene Ordner kürzen (Ordner verschwunden). */
export function validPath(model: XyModel | null | undefined, path: string[]): string[] {
  if (!model) return [];
  const i = path.findIndex((f) => !model.folders.has(f));
  return i >= 0 ? path.slice(0, i) : path;
}

const folderTitle = (f: { kind: string; label: string }) => (f.kind === "unassigned" ? "Nicht zugewiesen" : f.label);

/**
 * Obere Zeile einer Seite: Hoch/Ordner/Unterordner/Nodes der Ebene. Ohne Ordnerbaum (oder ohne Ordner
 * auf Home) bleibt es bei „Alle“ + je Node wie bisher.
 */
export function topEntries(s: XyState, side: Side): { key: KeyDef; act: XyAction }[] {
  const out: { key: KeyDef; act: XyAction }[] = [];
  const cat = catOf(s, side);
  const path = pathOf(s, side);
  const media = visible(allOf(s, side), s.media);
  const model = s.model;
  const byNode = new Map<string, Point[]>();
  for (const p of media) if (p.nodeId !== undefined) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p]);
  const level = model ? L().levelContents(model, path, byNode) : null;
  const folders: { id: string; label: string; kind: string }[] = level?.folders ?? [];
  const folderKeys = () =>
    folders.map((f) => ({
      key: { label: folderTitle(f), sub: f.kind === "workflow" ? "Workflow" : f.kind === "group" ? "Gruppe" : "Ordner" } as KeyDef,
      act: { t: "folder", side, id: f.id } as XyAction,
    }));
  if (!path.length) {
    out.push({ key: { label: "Alle", sub: "Kategorie", state: cat === null ? "preset" : "off" }, act: { t: "cat", side, name: null } });
    if (folders.some((f) => f.kind !== "unassigned")) out.push(...folderKeys());
    else for (const n of categories(media)) out.push({ key: { label: n, sub: "Kategorie", state: n === cat ? "preset" : "off" }, act: { t: "cat", side, name: n } });
    return out;
  }
  const here = level?.crumbs[level.crumbs.length - 1];
  out.push({ key: { label: "↑ Hoch", sub: path.length > 1 ? "Ebene" : "Home" }, act: { t: "up", side } });
  out.push({
    key: { label: here ? folderTitle(here) : "Ordner", sub: "Ebene", state: cat === null ? "preset" : "off" },
    act: { t: "cat", side, name: null },
  });
  out.push(...folderKeys());
  // Nodes, die direkt in dieser Ebene liegen (Untergruppen-Nodes erreicht man über deren Ordner).
  const direct = new Set<string>((level?.nodes ?? []).map((n: { id: string }) => n.id));
  const inLevel = media.filter((p) => p.nodeId !== undefined && direct.has(p.nodeId));
  for (const n of categories(inLevel)) out.push({ key: { label: n, sub: "Node", state: n === cat ? "preset" : "off" }, act: { t: "cat", side, name: n } });
  return out;
}

/** Quellen links, Ebenen-/Kategorie-Zeile oben, Steuerspalte in der Mitte, Ziele rechts. */
function layoutColumns(s: XyState, cols: number, rows: number, dialCount: number, pages: number): XyLayout {
  const midC = Math.floor((cols - 1) / 2);
  const w = { src: midC, dst: cols - 1 - midC };
  const x0 = { src: 0, dst: midC + 1 };
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (XyAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const sel = s.sources.find((x) => x.id === s.selSrc);
  const nameOf = new Map(s.sources.map((x) => [x.id, keyName(x, s.sources)]));
  // Bei mehreren Seiten gehört die Taste unten rechts dem Broker („Seite weiter“).
  const reserved = (r: number, c: number) => pages > 1 && r === rows - 1 && c === cols - 1;

  for (const side of ["src", "dst"] as Side[]) {
    const all = allOf(s, side);
    const cat = catOf(s, side);
    const catOff = (side === "src" ? s.srcCatOff : s.dstCatOff) ?? 0;
    const off = side === "src" ? s.srcOff : s.dstOff;
    const W = w[side], X = x0[side];
    // Obere Zeile
    const top = topEntries(s, side);
    const catPer = top.length > W ? Math.max(1, W - 1) : W;
    const co = Math.min(catOff, Math.max(0, top.length - 1));
    top.slice(co, co + catPer).forEach((e, i) => {
      keys[0][X + i] = e.key;
      act[0][X + i] = e.act;
    });
    if (top.length > W) {
      keys[0][X + W - 1] = { label: "mehr ▶", sub: `${Math.min(top.length, co + catPer)}/${top.length}` };
      act[0][X + W - 1] = { t: "more", side, what: "cat" };
    }
    // Punkte: freie Zellen der Seite (ohne die Seiten-Taste)
    const pts = sideList(s, side);
    const free: [number, number][] = [];
    for (let r = 1; r < rows; r++) for (let i = 0; i < W; i++) if (!reserved(r, X + i)) free.push([r, X + i]);
    const per = pts.length > free.length ? Math.max(1, free.length - 1) : free.length;
    const o = Math.min(off, Math.max(0, pts.length - 1));
    pts.slice(o, o + per).forEach((pt, i) => {
      const [r, c] = free[i];
      if (side === "src") {
        keys[r][c] = { label: keyName(pt, all), sub: cat || keyName(pt, all) === nodeOf(pt) ? undefined : nodeOf(pt), state: pt.id === s.selSrc ? "preset" : "off", dim: !pt.online };
      } else {
        const from = s.routes[pt.id];
        const routedFromSel = !!from && from === s.selSrc;
        keys[r][c] = {
          label: keyName(pt, all),
          sub: from ? nameOf.get(from) ?? "?" : "—",
          state: pt.id === s.selDst ? "cue" : routedFromSel ? "onair" : "off",
          dim: !pt.online || (!!sel && !compatible(sel, pt)),
        };
      }
      act[r][c] = { t: side, id: pt.id } as XyAction;
    });
    if (pts.length > free.length) {
      const [r, c] = free[free.length - 1];
      keys[r][c] = { label: "mehr ▶", sub: `${Math.min(pts.length, o + per)}/${pts.length}` };
      act[r][c] = { t: "more", side, what: "pt" };
    }
  }
  columnControls(s).slice(0, rows).forEach((it, r) => {
    keys[r][midC] = it.key;
    act[r][midC] = it.act;
  });
  return { keys, act, dials: dialsFor(s, dialCount), pages };
}

// ---- Bouquet-Seiten ----------------------------------------------------------

/** Aufzeichnen-Tasten brauchen Platz: ab 8 Tasten (alle außer Mini/„+“-Streifenmodelle mit 1 Zeile). */
const hasRecCells = (s: XyState, cols: number, rows: number) => s.canSaveBouquets === true && cols * rows >= 8;
/** Plätze je Bouquet-Seite: ohne „Seite weiter“ (unten rechts), „Rückgängig“ (0,0) und ggf. Aufzeichnen/Speichern/Verwerfen (0,1)/(0,2). */
export const bouquetCapacity = (s: XyState, cols: number, rows: number) => Math.max(1, cols * rows - (hasRecCells(s, cols, rows) ? 4 : 2));
export const bouquetPages = (s: XyState, cols: number, rows: number) => {
  const n = s.bouquets?.length ?? 0;
  // Zum Aufzeichnen muss die Bouquet-Seite auch ohne vorhandene Bouquets erreichbar sein.
  return n ? Math.ceil(n / bouquetCapacity(s, cols, rows)) : hasRecCells(s, cols, rows) ? 1 : 0;
};

function bouquetLayout(s: XyState, cols: number, rows: number, dialCount: number, bqPage: number, pages: number): XyLayout {
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (XyAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const cap = bouquetCapacity(s, cols, rows);
  const rec = hasRecCells(s, cols, rows);
  const list = s.bouquets ?? [];
  const hasDst = !!s.sinks.find((x) => x.id === s.selDst);
  keys[0][0] = { label: "↶ Zurück", sub: s.undoSecs ? `${s.undoSecs} s` : undefined, dim: !s.undoSecs };
  act[0][0] = { t: "undo" };
  if (rec) {
    if (s.draft) {
      keys[0][1] = { label: "■ Speichern", sub: `${s.draft.length} Schaltung(en)`, state: "onair", dim: !s.draft.length };
      act[0][1] = { t: "recSave" };
      keys[0][2] = { label: "✕ Verwerfen" };
      act[0][2] = { t: "recDrop" };
    } else {
      keys[0][1] = { label: "● Aufzeichnen", sub: "Take sammelt" };
      act[0][1] = { t: "rec" };
    }
  }
  const skip = (r: number, c: number) => (r === 0 && (c === 0 || (rec && c <= 2))) || (r === rows - 1 && c === cols - 1);
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (skip(r, c)) continue;
      const b = list[bqPage * cap + n++];
      if (!b) continue;
      const run = s.lastRun && s.lastRun.id === b.id ? s.lastRun : null;
      const bundle = b.kind === "bundle";
      keys[r][c] = {
        label: String(b.name),
        sub: run ? (run.bad ? `${run.ok} ok, ${run.bad} Fehler` : `${run.ok} geschaltet`) : bundle ? (hasDst ? `Bündel ${b.items?.length ?? 0}` : "Bündel: Ziel wählen") : b.kind === "tags" ? "per Tags" : `${b.routes?.length ?? 0} Schaltungen`,
        state: run ? (run.bad ? "error" : "onair") : "off",
        dim: bundle && !hasDst,
      };
      act[r][c] = { t: "bq", id: b.id };
    }
  }
  return { keys, act, dials: dialsFor(s, dialCount), pages };
}

/** Eintrag unter dem Ebenen-Cursor der Seite (Cursor wird auf die Liste begrenzt). */
export function levelEntry(s: XyState, side: Side): { key: KeyDef; act: XyAction; index: number; count: number } | null {
  const list = topEntries(s, side);
  if (!list.length) return null;
  const i = Math.min(Math.max(0, (side === "src" ? s.srcCur : s.dstCur) ?? 0), list.length - 1);
  return { ...list[i], index: i, count: list.length };
}

function dialsFor(s: XyState, dialCount: number): (DialDef | null)[] {
  const dials: (DialDef | null)[] = [];
  if (dialCount > 0) {
    const ss = s.sources.find((x) => x.id === s.selSrc), sd = s.sinks.find((x) => x.id === s.selDst);
    const lv = (side: Side, label: string): DialDef => {
      const e = levelEntry(s, side);
      return { label, value: e ? String(e.key.label) : "–", fill: e && e.count > 1 ? (e.index + 1) / e.count : undefined };
    };
    // Ebenen-Modus („+“ mit 4 Dials): Dial 1/2 steuern die Ebenen, Dial 3 zeigt den Modus.
    dials.push(s.levelMode ? lv("src", "Ebene Q") : { label: "Quelle", value: ss ? pointName(ss) : "–" });
    if (dialCount > 1) dials.push(s.levelMode ? lv("dst", "Ebene Z") : { label: "Ziel", value: sd ? pointName(sd) : "–" });
    if (dialCount > 2) dials.push(s.levelMode ? { label: "Modus", value: "Ebene" } : { label: "Medium", value: MEDIA_LABEL[s.media] });
    if (dialCount > 3) dials.push({ label: "AUTO", value: s.auto ? "an" : "aus", dim: !s.auto });
    // „+ XL“ (6 Dials): eigene Ebenen-Dials
    if (dialCount > 5) {
      dials.push(lv("src", "Ebene Q"));
      dials.push(lv("dst", "Ebene Z"));
    }
  }
  return dials;
}

export function layoutXy(s: XyState, cols: number, rows: number, dialCount: number, page: number): XyLayout {
  const bq = bouquetPages(s, cols, rows);
  if (cols >= 5 && rows >= 3) {
    const pages = 1 + bq;
    const p = Math.min(Math.max(0, page), pages - 1);
    return p === 0 ? layoutColumns(s, cols, rows, dialCount, pages) : bouquetLayout(s, cols, rows, dialCount, p - 1, pages);
  }
  const ctrls = controlList(s);
  let pl = plan(ctrls.length, cols, rows, false);
  const reserve = pl.pages > 1 || bq > 0;
  if (reserve) pl = plan(ctrls.length, cols, rows, true);
  const total = pl.pages + bq;
  if (page >= pl.pages && bq > 0) return bouquetLayout(s, cols, rows, dialCount, Math.min(page, total - 1) - pl.pages, total);
  const p = Math.min(Math.max(0, page), pl.pages - 1);
  const slots = Math.max(1, rows < 3 ? cols - (reserve ? 1 : 0) : cols);

  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (XyAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const srcs = visible(s.sources, s.media);
  const dsts = visible(s.sinks, s.media);
  const sel = s.sources.find((x) => x.id === s.selSrc);
  const nameOf = new Map(s.sources.map((x) => [x.id, pointName(x)]));

  const srcRow = (r: number) => {
    srcs.slice(s.srcOff, s.srcOff + slots).forEach((pt, c) => {
      keys[r][c] = { label: pointName(pt), sub: strip(pt.nodeLabel).replace(/^omp-/, ""), state: pt.id === s.selSrc ? "preset" : "off", dim: !pt.online };
      act[r][c] = { t: "src", id: pt.id };
    });
  };
  const dstRow = (r: number) => {
    dsts.slice(s.dstOff, s.dstOff + slots).forEach((pt, c) => {
      const from = s.routes[pt.id];
      const routedFromSel = !!from && from === s.selSrc;
      keys[r][c] = {
        label: pointName(pt),
        sub: from ? nameOf.get(from) ?? "?" : "—",
        state: pt.id === s.selDst ? "cue" : routedFromSel ? "onair" : "off",
        dim: !pt.online || (!!sel && !compatible(sel, pt)),
      };
      act[r][c] = { t: "dst", id: pt.id };
    });
  };
  const ctrlRowsAt = (from: number, count: number, chunk: number) => {
    ctrls.slice(chunk * pl.cap, chunk * pl.cap + pl.cap).forEach((it, i) => {
      const r = from + Math.floor(i / cols), c = i % cols;
      if (r < from + count) {
        keys[r][c] = it.key;
        act[r][c] = it.act;
      }
    });
  };

  if (rows >= 3) {
    srcRow(0);
    dstRow(1);
    ctrlRowsAt(2, rows - 2, p);
  } else if (rows === 2) {
    if (p === 0) {
      srcRow(0);
      dstRow(1);
    } else ctrlRowsAt(0, 2, p - 1);
  } else if (p === 0) srcRow(0);
  else if (p === 1) dstRow(0);
  else ctrlRowsAt(0, 1, p - 2);

  const dials = dialsFor(s, dialCount);
  return { keys, act, dials, pages: total };
}
