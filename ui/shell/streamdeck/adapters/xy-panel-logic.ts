// X/Y-Panel-Adapter, reine Logik (Kap. 40.7): Quellenzeile, Zielzeile,
// Steuerzeile (TAKE, AUTO, TRENNEN, Medium, Blättern). Schalten über die
// Kern-API (POST/DELETE /api/v1/graph/edges), nie am Node vorbei.

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";

export interface Point {
  id: string;
  label: string;
  nodeLabel: string;
  mediaType: string;
  online: boolean;
}

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
}

export type XyAction =
  | { t: "src"; id: string }
  | { t: "dst"; id: string }
  | { t: "take" }
  | { t: "disc" }
  | { t: "auto" }
  | { t: "media" }
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

export interface XyLayout extends AdapterLayout {
  act: (XyAction | null)[][];
}

export function controlList(s: XyState): { key: KeyDef; act: XyAction }[] {
  const canTake = !!s.selSrc && !!s.selDst;
  return [
    { key: { label: "TAKE", state: canTake ? "onair" : "off", dim: !canTake }, act: { t: "take" } },
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

export function layoutXy(s: XyState, cols: number, rows: number, dialCount: number, page: number): XyLayout {
  const ctrls = controlList(s);
  let pl = plan(ctrls.length, cols, rows, false);
  const reserve = pl.pages > 1;
  if (reserve) pl = plan(ctrls.length, cols, rows, true);
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

  const dials: (DialDef | null)[] = [];
  if (dialCount > 0) {
    const ss = s.sources.find((x) => x.id === s.selSrc), sd = s.sinks.find((x) => x.id === s.selDst);
    dials.push({ label: "Quelle", value: ss ? pointName(ss) : "–" });
    if (dialCount > 1) dials.push({ label: "Ziel", value: sd ? pointName(sd) : "–" });
    if (dialCount > 2) dials.push({ label: "Medium", value: MEDIA_LABEL[s.media] });
    if (dialCount > 3) dials.push({ label: "AUTO", value: s.auto ? "an" : "aus", dim: !s.auto });
  }
  return { keys, act, dials, pages: pl.pages };
}
