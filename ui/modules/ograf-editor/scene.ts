// Szenenmodell der Designer-Vorlagen (Kapitel 90.5): Elemente auf einer Fläche (Text, Rechteck, Bild, Zone) samt Verschieben,
// Skalieren, Ausrichten, Reihenfolge, Platzhaltern `{{schluessel}}` und der Erzeugung der Paketdateien. Rein und ohne DOM
// (Deno-Tests). Gespeichert wird `scene.json` im Paket; die Vorlagen-Datei `<id>.js` ist daraus + `runtime.js` erzeugt.
import { SCHEMA_URL, stringify } from "./logic.ts";
import type { Field, Files } from "./logic.ts";

export const SCENE_FORMAT = "omp-ograf-scene/1";
export type Kind = "rect" | "text" | "image" | "zone";
export const KINDS: Kind[] = ["text", "rect", "image", "zone"];
export const ANIM_TYPES = ["none", "fade", "fromLeft", "fromRight", "fromTop", "fromBottom", "scale", "wipe"] as const;

export interface AnimSpec {
  type: string;
  ms: number;
  delay: number;
  ease: string;
}
export interface SceneElement {
  id: string;
  kind: Kind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  anim?: { in?: AnimSpec; out?: AnimSpec };
  // Rechteck
  fill?: string;
  radius?: number;
  stroke?: string;
  strokeW?: number;
  // Text
  text?: string;
  font?: string;
  size?: number;
  weight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  bg?: string;
  padding?: number;
  /** Schrift verkleinern, bis der Text ins Feld passt (nicht unter `minSize`). */
  autofit?: boolean;
  minSize?: number;
  /** Schritte, in denen das Element steht: ab `from` (Standard 0), bis `to` (−1 = letzter Schritt). */
  from?: number;
  to?: number;
  // Bild
  file?: string;
  fit?: "contain" | "cover" | "fill";
  // Zone
  zone?: string;
}
export const EFFECT_TYPES = ["pulse", "flash", "shake", "bounce"] as const;
export interface SceneEffect {
  target: string;
  type: string;
  ms: number;
  delay: number;
}
/** Benutzerdefinierte Aktion (OGraf `customAction`): Effekte auf Elementen, z. B. „Hervorheben“. */
export interface SceneAction {
  id: string;
  name: string;
  effects: SceneEffect[];
}
export interface SceneFont {
  family: string;
  file: string;
}
export interface Scene {
  format: typeof SCENE_FORMAT;
  width: number;
  height: number;
  elements: SceneElement[];
  /** Aktionen, die der Operator auf einer stehenden Grafik auslösen kann. */
  actions?: SceneAction[];
  /** Anzahl Schritte (Weiter-Taste), mindestens 1. */
  stepCount?: number;
  /** Schriftdateien des Pakets (woff/woff2/ttf), die als Schriftfamilie bereitstehen. */
  fonts?: SceneFont[];
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 4;
const num = (v: unknown, d: number): number => typeof v === "number" && Number.isFinite(v) ? v : d;
const str = (v: unknown, d = ""): string => typeof v === "string" ? v : d;

export function newScene(width = 1920, height = 1080): Scene {
  return { format: SCENE_FORMAT, width, height, elements: [] };
}

function uniqueId(scene: Scene, base: string): string {
  const ids = new Set(scene.elements.map((e) => e.id));
  for (let i = 1; i < 10000; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now()}`;
}

const LABEL: Record<Kind, string> = { text: "Text", rect: "Fläche", image: "Bild", zone: "Zone" };

/** Neues Element mit sinnvollen Vorgaben, mittig auf der Fläche. */
export function newElement(kind: Kind, scene: Scene): SceneElement {
  const id = uniqueId(scene, kind === "zone" ? "z" : kind[0]);
  const same = scene.elements.filter((e) => e.kind === kind).length + 1;
  const base = { id, kind, name: `${LABEL[kind]} ${same}`, rotation: 0, opacity: 1 };
  const w = kind === "text" ? 720 : kind === "zone" ? 640 : 480;
  const h = kind === "text" ? 100 : kind === "zone" ? 360 : 270;
  const box = { x: Math.round((scene.width - w) / 2), y: Math.round((scene.height - h) / 2), w, h };
  switch (kind) {
    case "text":
      return { ...base, ...box, text: "Text", font: "system-ui, sans-serif", size: 64, weight: 600, color: "#ffffff", align: "left", valign: "middle", lineHeight: 1.2, padding: 0, anim: { in: { type: "fade", ms: 300, delay: 0, ease: "ease-out" }, out: { type: "fade", ms: 300, delay: 0, ease: "ease-in" } } };
    case "rect":
      return { ...base, ...box, fill: "#10151f", radius: 0, stroke: "", strokeW: 0, anim: { in: { type: "fade", ms: 300, delay: 0, ease: "ease-out" }, out: { type: "fade", ms: 300, delay: 0, ease: "ease-in" } } };
    case "image":
      return { ...base, ...box, file: "", fit: "contain", anim: { in: { type: "fade", ms: 300, delay: 0, ease: "ease-out" }, out: { type: "fade", ms: 300, delay: 0, ease: "ease-in" } } };
    default:
      return { ...base, ...box, zone: uniqueZone(scene) };
  }
}

function uniqueZone(scene: Scene): string {
  const used = new Set(scene.elements.filter((e) => e.kind === "zone").map((e) => e.zone));
  if (!used.has("window")) return "window";
  for (let i = 2; i < 100; i++) if (!used.has(`window${i}`)) return `window${i}`;
  return "zone";
}

// ── Einlesen ──────────────────────────────────────────────────────────────────────────────────────────────

function parseAnim(v: unknown): AnimSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const type = str(o.type, "none");
  return { type: (ANIM_TYPES as readonly string[]).includes(type) ? type : "none", ms: Math.max(0, num(o.ms, 400)), delay: Math.max(0, num(o.delay, 0)), ease: str(o.ease, "ease-out") };
}

/** Liest `scene.json`; unbekannte Arten werden verworfen, Zahlen begrenzt. Fehler: `null`. */
export function parseScene(text: string): Scene | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Record<string, unknown> | null;
  if (!o || o.format !== SCENE_FORMAT || !Array.isArray(o.elements)) return null;
  const scene = newScene(Math.max(16, num(o.width, 1920)), Math.max(16, num(o.height, 1080)));
  if (Array.isArray(o.actions)) {
    const ids = new Set<string>();
    scene.actions = [];
    for (const a of o.actions as Record<string, unknown>[]) {
      if (!a || typeof a.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(a.id) || ids.has(a.id)) continue;
      ids.add(a.id);
      const effects = (Array.isArray(a.effects) ? a.effects as Record<string, unknown>[] : [])
        .filter((f) => f && typeof f.target === "string" && (EFFECT_TYPES as readonly string[]).includes(f.type as string))
        .map((f) => ({ target: f.target as string, type: f.type as string, ms: Math.max(50, num(f.ms, 600)), delay: Math.max(0, num(f.delay, 0)) }));
      scene.actions.push({ id: a.id, name: str(a.name, a.id), effects });
    }
  }
  scene.stepCount = Math.min(20, Math.max(1, Math.round(num(o.stepCount, 1))));
  if (Array.isArray(o.fonts)) {
    scene.fonts = (o.fonts as Record<string, unknown>[])
      .filter((f) => f && typeof f.family === "string" && /^[^"'\\;{}]+$/.test(f.family as string) && typeof f.file === "string" && /^[A-Za-z0-9._-]+$/.test(f.file as string))
      .map((f) => ({ family: f.family as string, file: f.file as string }));
  }
  const seen = new Set<string>();
  for (const raw of o.elements) {
    const e = raw as Record<string, unknown>;
    if (!e || typeof e !== "object" || !KINDS.includes(e.kind as Kind)) continue;
    let id = str(e.id) || "e";
    while (seen.has(id)) id += "x";
    seen.add(id);
    const anim = e.anim && typeof e.anim === "object" ? e.anim as Record<string, unknown> : {};
    scene.elements.push({
      ...(e as unknown as SceneElement),
      id,
      kind: e.kind as Kind,
      name: str(e.name, id),
      x: num(e.x, 0), y: num(e.y, 0), w: Math.max(MIN_SIZE, num(e.w, 100)), h: Math.max(MIN_SIZE, num(e.h, 100)),
      rotation: num(e.rotation, 0),
      opacity: Math.min(1, Math.max(0, num(e.opacity, 1))),
      from: Math.max(0, Math.round(num(e.from, 0))),
      to: Math.max(-1, Math.round(num(e.to, -1))),
      anim: { in: parseAnim(anim.in), out: parseAnim(anim.out) },
    });
  }
  return scene;
}

// ── Bearbeiten (unveränderlich: jede Funktion liefert eine neue Szene) ──────────────────────────────────

export const withElements = (s: Scene, elements: SceneElement[]): Scene => ({ ...s, elements });

export function updateElement(s: Scene, id: string, patch: Partial<SceneElement>): Scene {
  return withElements(s, s.elements.map((e) => e.id === id ? clampElement({ ...e, ...patch }) : e));
}

function clampElement(e: SceneElement): SceneElement {
  return { ...e, w: Math.max(MIN_SIZE, e.w), h: Math.max(MIN_SIZE, e.h), opacity: Math.min(1, Math.max(0, e.opacity)) };
}

export function addElement(s: Scene, e: SceneElement): Scene {
  return withElements(s, [...s.elements, e]);
}

export function removeElements(s: Scene, ids: string[]): Scene {
  return withElements(s, s.elements.filter((e) => !ids.includes(e.id)));
}

export function duplicateElement(s: Scene, id: string): { scene: Scene; id: string } {
  const src = s.elements.find((e) => e.id === id);
  if (!src) return { scene: s, id: "" };
  const nid = uniqueId(s, src.kind === "zone" ? "z" : src.kind[0]);
  const copy: SceneElement = { ...structuredClone(src), id: nid, name: `${src.name} (Kopie)`, x: src.x + 40, y: src.y + 40 };
  if (copy.kind === "zone") copy.zone = uniqueZone(s);
  const i = s.elements.findIndex((e) => e.id === id);
  const els = [...s.elements];
  els.splice(i + 1, 0, copy);
  return { scene: withElements(s, els), id: nid };
}

export function moveElements(s: Scene, ids: string[], dx: number, dy: number): Scene {
  return withElements(s, s.elements.map((e) => ids.includes(e.id) ? { ...e, x: Math.round(e.x + dx), y: Math.round(e.y + dy) } : e));
}

/** Reihenfolge: das letzte Element liegt oben. */
export function reorder(s: Scene, id: string, how: "front" | "back" | "up" | "down"): Scene {
  const i = s.elements.findIndex((e) => e.id === id);
  if (i < 0) return s;
  const els = [...s.elements];
  const [e] = els.splice(i, 1);
  const j = how === "front" ? els.length : how === "back" ? 0 : how === "up" ? Math.min(els.length, i + 1) : Math.max(0, i - 1);
  els.splice(j, 0, e);
  return withElements(s, els);
}

/** Dauer/Verzug einer Animation setzen (auf 50 ms gerundet, nie negativ); Art bleibt, bei „keine“ wird „Überblenden“ gesetzt. */
export function setTiming(s: Scene, id: string, dir: "in" | "out", patch: { ms?: number; delay?: number }): Scene {
  const e = s.elements.find((x) => x.id === id);
  if (!e) return s;
  const cur = e.anim?.[dir] ?? { type: "fade", ms: 300, delay: 0, ease: "ease-out" };
  const snap = (v: number) => Math.max(0, Math.round(v / 50) * 50);
  const next = { ...cur, type: cur.type === "none" ? "fade" : cur.type, ms: patch.ms !== undefined ? Math.max(50, snap(patch.ms)) : cur.ms, delay: patch.delay !== undefined ? snap(patch.delay) : cur.delay };
  return updateElement(s, id, { anim: { ...e.anim, [dir]: next } });
}

/** Ende der längsten Animation (ms) einer Richtung, mindestens `min` — Maßstab der Zeitleiste. */
export function timelineEnd(s: Scene, dir: "in" | "out", min = 1000): number {
  let end = min;
  for (const e of s.elements) {
    const a = e.anim?.[dir];
    if (a && a.type !== "none") end = Math.max(end, a.delay + a.ms);
  }
  return Math.ceil(end / 250) * 250;
}

/** Neue Aktion mit freier ID; nimmt, wenn vorhanden, das erste Textelement als Ziel. */
export function newAction(s: Scene): SceneAction {
  const used = new Set((s.actions ?? []).map((a) => a.id));
  let i = 1;
  while (used.has(`aktion${i}`)) i++;
  const target = s.elements.find((e) => e.kind === "text") ?? s.elements.find((e) => e.kind !== "zone");
  return { id: `aktion${i}`, name: i === 1 ? "Hervorheben" : `Aktion ${i}`, effects: target ? [{ target: target.id, type: "pulse", ms: 600, delay: 0 }] : [] };
}

export function setActions(s: Scene, actions: SceneAction[]): Scene {
  return { ...s, actions };
}

/** Anzahl Schritte setzen und die Schrittbereiche der Elemente einpassen. */
export function setStepCount(s: Scene, n: number): Scene {
  const count = Math.min(20, Math.max(1, Math.round(n)));
  return { ...s, stepCount: count, elements: s.elements.map((e) => ({ ...e, from: Math.min(e.from ?? 0, count - 1), to: (e.to ?? -1) >= count ? -1 : e.to ?? -1 })) };
}

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
/** Richtet ein Element an der Fläche aus. */
export function alignToScene(s: Scene, id: string, how: Align): Scene {
  const e = s.elements.find((x) => x.id === id);
  if (!e) return s;
  const p: Partial<SceneElement> = how === "left" ? { x: 0 } : how === "hcenter" ? { x: Math.round((s.width - e.w) / 2) } : how === "right" ? { x: s.width - e.w }
    : how === "top" ? { y: 0 } : how === "vcenter" ? { y: Math.round((s.height - e.h) / 2) } : { y: s.height - e.h };
  return updateElement(s, id, p);
}

// ── Geometrie ───────────────────────────────────────────────────────────────────────────────────────────────

/** Punkt (Szenenkoordinaten) im (ggf. gedrehten) Element? */
export function hits(e: SceneElement, px: number, py: number): boolean {
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
  const a = -(e.rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= e.w / 2 && Math.abs(ly) <= e.h / 2;
}

/** Oberstes Element unter dem Punkt (Zonen zuletzt, weil sie meist große Flächen sind) oder `null`. */
export function hitTest(s: Scene, px: number, py: number): string | null {
  for (let i = s.elements.length - 1; i >= 0; i--) if (hits(s.elements[i], px, py)) return s.elements[i].id;
  return null;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Neue Box nach Ziehen eines Griffs um (dx, dy); `keepRatio` hält das Seitenverhältnis (nur Eckgriffe). */
export function resizeBox(b: Box, handle: Handle, dx: number, dy: number, keepRatio = false): Box {
  let { x, y, w, h } = b;
  const ratio = b.w / b.h;
  if (handle.includes("e")) w = b.w + dx;
  if (handle.includes("w")) { w = b.w - dx; x = b.x + dx; }
  if (handle.includes("s")) h = b.h + dy;
  if (handle.includes("n")) { h = b.h - dy; y = b.y + dy; }
  if (keepRatio && handle.length === 2) {
    if (Math.abs(w - b.w) / b.w >= Math.abs(h - b.h) / b.h) h = w / ratio;
    else w = h * ratio;
    if (handle.includes("w")) x = b.x + b.w - w;
    if (handle.includes("n")) y = b.y + b.h - h;
  }
  if (w < MIN_SIZE) { if (handle.includes("w")) x -= MIN_SIZE - w; w = MIN_SIZE; }
  if (h < MIN_SIZE) { if (handle.includes("n")) y -= MIN_SIZE - h; h = MIN_SIZE; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Wie `resizeBox`, aber für ein um seine Mitte gedrehtes Element: gezogen wird im Elementkoordinatensystem, die gegenüberliegende Kante bleibt stehen. */
export function resizeRotated(b: Box, rotation: number, handle: Handle, dx: number, dy: number, keepRatio = false): Box {
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), sn = Math.sin(a);
  const ldx = dx * c + dy * sn, ldy = -dx * sn + dy * c; // Zeigerweg ins Elementsystem (um −Winkel gedreht)
  const nb = resizeBox({ x: 0, y: 0, w: b.w, h: b.h }, handle, ldx, ldy, keepRatio);
  const shiftX = nb.x + nb.w / 2 - b.w / 2, shiftY = nb.y + nb.h / 2 - b.h / 2; // Verschiebung der Mitte im Elementsystem
  const cx = b.x + b.w / 2 + shiftX * c - shiftY * sn;
  const cy = b.y + b.h / 2 + shiftX * sn + shiftY * c;
  return { x: Math.round(cx - nb.w / 2), y: Math.round(cy - nb.h / 2), w: nb.w, h: nb.h };
}

/** Drehwinkel (Grad) für einen Zeiger bei (px, py) um die Mitte des Elements; der Griff liegt oberhalb (0°); `snap` rastet auf 15°. */
export function angleFor(b: Box, px: number, py: number, snap = false): number {
  let deg = (Math.atan2(py - (b.y + b.h / 2), px - (b.x + b.w / 2)) * 180) / Math.PI + 90;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  if (snap) deg = Math.round(deg / 15) * 15;
  return Math.round(deg * 10) / 10;
}

/** Umgebendes Rechteck (ohne Drehung) mehrerer Elemente. */
export function boundsOf(s: Scene, ids: string[]): Box | null {
  const els = s.elements.filter((e) => ids.includes(e.id));
  if (!els.length) return null;
  const x1 = Math.min(...els.map((e) => e.x)), y1 = Math.min(...els.map((e) => e.y));
  const x2 = Math.max(...els.map((e) => e.x + e.w)), y2 = Math.max(...els.map((e) => e.y + e.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Elemente, deren Rechteck das Auswahlrechteck berührt (Aufziehen). */
export function elementsInRect(s: Scene, r: Box): string[] {
  return s.elements.filter((e) => e.x < r.x + r.w && e.x + e.w > r.x && e.y < r.y + r.h && e.y + e.h > r.y).map((e) => e.id);
}

/** Mehrere Elemente aneinander ausrichten (an den Rändern/der Mitte ihres gemeinsamen Rechtecks). */
export function alignGroup(s: Scene, ids: string[], how: Align): Scene {
  const b = boundsOf(s, ids);
  if (!b || ids.length < 2) return s;
  return withElements(s, s.elements.map((e) => {
    if (!ids.includes(e.id)) return e;
    switch (how) {
      case "left": return { ...e, x: b.x };
      case "hcenter": return { ...e, x: Math.round(b.x + (b.w - e.w) / 2) };
      case "right": return { ...e, x: b.x + b.w - e.w };
      case "top": return { ...e, y: b.y };
      case "vcenter": return { ...e, y: Math.round(b.y + (b.h - e.h) / 2) };
      default: return { ...e, y: b.y + b.h - e.h };
    }
  }));
}

/** Drei oder mehr Elemente mit gleichem Abstand verteilen (nach Position sortiert, äußere bleiben stehen). */
export function distribute(s: Scene, ids: string[], axis: "x" | "y"): Scene {
  const els = s.elements.filter((e) => ids.includes(e.id));
  if (els.length < 3) return s;
  const size = axis === "x" ? "w" : "h";
  const sorted = [...els].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const total = last[axis] + last[size] - first[axis];
  const gap = (total - sorted.reduce((a, e) => a + e[size], 0)) / (sorted.length - 1);
  const pos = new Map<string, number>();
  let at = first[axis];
  for (const e of sorted) {
    pos.set(e.id, Math.round(at));
    at += e[size] + gap;
  }
  return withElements(s, s.elements.map((e) => pos.has(e.id) ? { ...e, [axis]: pos.get(e.id)! } : e));
}

/** Mehrere Elemente duplizieren (alle versetzt); liefert die neuen IDs. */
export function duplicateMany(s: Scene, ids: string[]): { scene: Scene; ids: string[] } {
  let cur = s;
  const out: string[] = [];
  for (const id of ids) {
    const r = duplicateElement(cur, id);
    cur = r.scene;
    if (r.id) out.push(r.id);
  }
  return { scene: cur, ids: out };
}

export interface Guide {
  axis: "x" | "y";
  at: number;
}
/** Rastet die Box an Flächenrändern/-mitte und Kanten anderer Elemente ein (je Achse die nächste innerhalb `threshold`). */
export function snapBox(b: Box, s: Scene, skipIds: string[], threshold: number): { box: Box; guides: Guide[] } {
  const xs = [0, s.width / 2, s.width];
  const ys = [0, s.height / 2, s.height];
  for (const e of s.elements) {
    if (skipIds.includes(e.id)) continue;
    xs.push(e.x, e.x + e.w / 2, e.x + e.w);
    ys.push(e.y, e.y + e.h / 2, e.y + e.h);
  }
  const pick = (own: number[], targets: number[]): { d: number; at: number } | null => {
    let best: { d: number; at: number } | null = null;
    for (const o of own) for (const t of targets) {
      const d = t - o;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
    return best;
  };
  const sx = pick([b.x, b.x + b.w / 2, b.x + b.w], xs);
  const sy = pick([b.y, b.y + b.h / 2, b.y + b.h], ys);
  const guides: Guide[] = [];
  if (sx) guides.push({ axis: "x", at: sx.at });
  if (sy) guides.push({ axis: "y", at: sy.at });
  return { box: { ...b, x: Math.round(b.x + (sx?.d ?? 0)), y: Math.round(b.y + (sy?.d ?? 0)) }, guides };
}

// ── Platzhalter und Paketdateien ───────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Alle `{{schluessel}}` der Szene (Text, Farben), in Reihenfolge des ersten Auftretens. */
export function placeholders(s: Scene): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    for (const m of v.matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  };
  for (const e of s.elements) for (const k of ["text", "fill", "stroke", "color", "bg"] as const) add(e[k]);
  return out;
}

/** Zonen-IDs der Szene. */
export function zoneIds(s: Scene): string[] {
  return s.elements.filter((e) => e.kind === "zone").map((e) => e.zone ?? "");
}

/** Dateien, die ein Element braucht (Bilder). */
export function usedAssets(s: Scene): string[] {
  return [...new Set(s.elements.filter((e) => e.kind === "image" && e.file).map((e) => e.file!))];
}

export function isDesigner(files: Files): boolean {
  return "scene.json" in files;
}

const HEADER = "// ERZEUGT vom OGraf-Editor (Leinwand) — Änderungen bitte in der Leinwand machen, sie werden beim Speichern überschrieben.\n";

/** Hauptmodul einer Designer-Vorlage: Laufzeit + Szene. */
export function generateMain(runtime: string, scene: Scene): string {
  return `${HEADER}${runtime}\nexport default createSceneElement(${JSON.stringify(scene)}, import.meta.url);\n`;
}

/** Schreibt Szene und erzeugtes Hauptmodul in die Paketdateien (Manifest-`main` zeigt auf `<id>.js`). */
export function applyScene(files: Files, id: string, scene: Scene, runtime: string): Files {
  const out: Files = { ...files, "scene.json": JSON.stringify(scene, null, 2) + "\n", [`${id}.js`]: generateMain(runtime, scene) };
  const mname = Object.keys(out).find((n) => n.endsWith(".ograf.json"));
  if (mname) {
    try {
      const m = JSON.parse(out[mname]);
      const steps = Math.max(1, scene.stepCount ?? 1);
      const next: Record<string, unknown> = { ...m, main: `${id}.js`, stepCount: steps };
      const acts = (scene.actions ?? []).map((a) => ({ id: a.id, name: a.name }));
      if (acts.length) next.customActions = acts;
      else delete next.customActions;
      if (JSON.stringify(next) !== JSON.stringify(m)) out[mname] = stringify(next);
    } catch { /* kaputtes Manifest: der Node meldet es */ }
  }
  return out;
}

/** Startpaket einer Designer-Vorlage: Balken mit zwei Textfeldern (Name, Untertitel) und Farbparameter. */
export function newDesignerPackage(id: string, name: string, runtime: string): Files {
  const scene = newScene();
  const bar = { ...newElement("rect", scene), name: "Balken", x: 120, y: 820, w: 900, h: 150, fill: "{{barColor}}" };
  scene.elements.push(bar);
  const accent = { ...newElement("rect", withElements(scene, scene.elements)), name: "Akzent", x: 120, y: 820, w: 12, h: 150, fill: "{{accentColor}}" };
  accent.id = "r2";
  scene.elements.push(accent);
  const t1 = { ...newElement("text", withElements(scene, scene.elements)), name: "Name", id: "t1", x: 160, y: 830, w: 840, h: 80, text: "{{name}}", size: 60, weight: 700 };
  t1.anim = { in: { type: "fromLeft", ms: 400, delay: 150, ease: "ease-out" }, out: { type: "fade", ms: 250, delay: 0, ease: "ease-in" } };
  scene.elements.push(t1);
  const t2 = { ...newElement("text", withElements(scene, scene.elements)), name: "Untertitel", id: "t2", x: 160, y: 905, w: 840, h: 55, text: "{{title}}", size: 38, weight: 400, color: "#c8d0dc" };
  t2.anim = { in: { type: "fromLeft", ms: 400, delay: 280, ease: "ease-out" }, out: { type: "fade", ms: 250, delay: 0, ease: "ease-in" } };
  scene.elements.push(t2);
  const manifest = {
    $schema: SCHEMA_URL, id, name, version: "1.0.0", main: `${id}.js`, supportsRealTime: true, supportsNonRealTime: false, stepCount: 1,
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", default: "Max Mustermann" },
        title: { type: "string", title: "Untertitel", default: "Reporter" },
        barColor: { type: "string", title: "Balkenfarbe", gddType: "color-rrggbb", pattern: "^#[0-9a-fA-F]{6}$", default: "#10151f" },
        accentColor: { type: "string", title: "Akzentfarbe", gddType: "color-rrggbb", pattern: "^#[0-9a-fA-F]{6}$", default: "#00c8ff" },
      },
    },
  };
  return applyScene({ [`${id}.ograf.json`]: stringify(manifest) }, id, scene, runtime);
}

/** Ergänzt für jeden Platzhalter der Szene ein fehlendes Parameterfeld (Farbe, wenn er in einem Farbfeld steht, sonst Text). */
export function ensureParams(fields: Field[], s: Scene): Field[] {
  const have = new Set(fields.map((f) => f.key));
  const colorKeys = new Set<string>();
  for (const e of s.elements) {
    for (const k of ["fill", "stroke", "color", "bg"] as const) {
      const v = e[k];
      if (typeof v === "string") for (const m of v.matchAll(PLACEHOLDER)) colorKeys.add(m[1]);
    }
  }
  const out = [...fields];
  for (const k of placeholders(s)) {
    if (have.has(k)) continue;
    const isColor = colorKeys.has(k);
    out.push({ key: k, title: k, kind: isColor ? "color" : "text", def: isColor ? "#ffffff" : "", choices: [], required: false, extra: {} });
  }
  return out;
}

// ── Rückgängig / Wiederholen ────────────────────────────────────────────────────────────────────────────────

/** Einfacher Verlauf; `push` verwirft den Wiederholen-Zweig, `limit` begrenzt den Speicher. */
export class History<T> {
  #past: T[] = [];
  #future: T[] = [];
  constructor(private current: T, private limit = 100) {}
  get value(): T {
    return this.current;
  }
  push(next: T): void {
    this.#past.push(this.current);
    if (this.#past.length > this.limit) this.#past.shift();
    this.#future = [];
    this.current = next;
  }
  /** Aktuellen Stand ersetzen, ohne Verlaufseintrag (laufende Zeigergeste). */
  replaceCurrent(next: T): void {
    this.current = next;
  }
  get canUndo(): boolean {
    return this.#past.length > 0;
  }
  get canRedo(): boolean {
    return this.#future.length > 0;
  }
  undo(): T {
    const p = this.#past.pop();
    if (p !== undefined) {
      this.#future.push(this.current);
      this.current = p;
    }
    return this.current;
  }
  redo(): T {
    const f = this.#future.pop();
    if (f !== undefined) {
      this.#past.push(this.current);
      this.current = f;
    }
    return this.current;
  }
}
