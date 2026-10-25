// Topologie der Hosts (Kapitel 54): welche Nodes laufen auf welchem Host, und welche Verbindungen des Signalgraphen
// überschreiten Hostgrenzen. Reine Logik ohne DOM.

export interface TopoHostIn {
  id: string; // "" = Orchestrator-Host
  label: string;
  online: boolean;
  maintenance?: boolean;
  cpu?: number;
  mem?: number;
  gpu?: number;
  net?: number; // Auslastung der Netzwerkkarte in %, wenn bekannt
  jobs?: number;
  jobsMax?: number;
  liveReserveCpu?: number; // Anteil 0–1
}
export interface PortIn { id: string; format?: string }
export interface GraphNodeIn { id: string; label: string; instanceId?: string; inputs: PortIn[]; outputs: PortIn[]; health?: string }
export interface GraphEdgeIn { id: string; fromSender: string; toReceiver: string; state?: string }
export interface InstanceIn { id: string; hostId?: string }

export const LOCAL = "local";
export const EXTERN = "extern";

export interface TopoNode { id: string; label: string; health?: string }
export interface TopoBox extends Omit<TopoHostIn, "id"> {
  id: string;
  nodes: TopoNode[];
  /** Verbindungen, deren beide Enden auf diesem Host liegen. */
  internal: number;
}
export interface TopoLink {
  from: string;
  to: string;
  count: number;
  edgeIds: string[];
  /** Formate der Quellen (z. B. "video", "audio"), für die Beschriftung. */
  kinds: string[];
}
export interface Topology { boxes: TopoBox[]; links: TopoLink[] }

const hostKey = (id: string | undefined): string => (id === undefined || id === "" ? LOCAL : id);

/** Kurzform eines NMOS-Formats ("urn:x-nmos:format:video" → "video"). */
export function kindOf(format?: string): string {
  if (!format) return "";
  const i = format.lastIndexOf(":");
  return i >= 0 ? format.slice(i + 1) : format;
}

export function buildTopology(hosts: TopoHostIn[], nodes: GraphNodeIn[], edges: GraphEdgeIn[], instances: InstanceIn[]): Topology {
  const boxes = new Map<string, TopoBox>();
  for (const h of hosts) {
    const id = hostKey(h.id);
    boxes.set(id, { ...h, id, nodes: [], internal: 0 });
  }
  const instHost = new Map(instances.map((i) => [i.id, hostKey(i.hostId)]));
  const ownerOfNode = new Map<string, string>();
  const portOwner = new Map<string, { node: string; kind: string }>();
  for (const n of nodes) {
    let owner = n.instanceId ? instHost.get(n.instanceId) ?? LOCAL : EXTERN;
    if (!boxes.has(owner)) {
      // Host unbekannt (z. B. entfernt): eigener Kasten, damit nichts verschwindet
      boxes.set(owner, { id: owner, label: owner === EXTERN ? "" : owner, online: false, nodes: [], internal: 0 });
    }
    ownerOfNode.set(n.id, owner);
    boxes.get(owner)!.nodes.push({ id: n.id, label: n.label, health: n.health });
    for (const p of n.inputs) portOwner.set(p.id, { node: n.id, kind: "" });
    for (const p of n.outputs) portOwner.set(p.id, { node: n.id, kind: kindOf(p.format) });
  }
  const links = new Map<string, TopoLink>();
  for (const e of edges) {
    const a = portOwner.get(e.fromSender);
    const b = portOwner.get(e.toReceiver);
    if (!a || !b) continue;
    const from = ownerOfNode.get(a.node)!;
    const to = ownerOfNode.get(b.node)!;
    if (from === to) {
      boxes.get(from)!.internal++;
      continue;
    }
    const key = `${from}→${to}`;
    const l = links.get(key) ?? { from, to, count: 0, edgeIds: [], kinds: [] };
    l.count++;
    l.edgeIds.push(e.id);
    if (a.kind && !l.kinds.includes(a.kind)) l.kinds.push(a.kind);
    links.set(key, l);
  }
  // „Extern“ nur zeigen, wenn dort etwas liegt; leere unbekannte Kästen entfallen
  const list = [...boxes.values()].filter((b) => b.id !== EXTERN || b.nodes.length > 0);
  list.sort((a, b) => (a.id === LOCAL ? -1 : b.id === LOCAL ? 1 : a.id === EXTERN ? 1 : b.id === EXTERN ? -1 : a.label.localeCompare(b.label, "de")));
  return { boxes: list, links: [...links.values()].sort((x, y) => y.count - x.count) };
}

export interface BoxPos { id: string; x: number; y: number; w: number; h: number }

/** Raster der Kästen; Spaltenzahl aus der verfügbaren Breite. */
export function layoutBoxes(ids: string[], width: number, box = { w: 250, h: 190, gx: 110, gy: 60 }): { pos: Map<string, BoxPos>; width: number; height: number } {
  const cols = Math.max(1, Math.min(ids.length || 1, Math.floor((width + box.gx) / (box.w + box.gx))));
  const pos = new Map<string, BoxPos>();
  ids.forEach((id, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(id, { id, x: c * (box.w + box.gx), y: r * (box.h + box.gy), w: box.w, h: box.h });
  });
  const rows = Math.ceil(ids.length / cols);
  return { pos, width: cols * box.w + (cols - 1) * box.gx, height: Math.max(1, rows) * box.h + Math.max(0, rows - 1) * box.gy };
}

/** Schnittpunkt der Linie vom Mittelpunkt von `a` zum Punkt p mit dem Rand von `a`. */
function edgePoint(a: BoxPos, px: number, py: number): { x: number; y: number } {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const s = Math.min(a.w / 2 / Math.abs(dx || 1e-9), a.h / 2 / Math.abs(dy || 1e-9));
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Pfad einer Verbindung zwischen zwei Kästen; `bend` versetzt die Kurve seitlich (gegenläufige Verbindungen nicht überlagern). */
export function linkPath(a: BoxPos, b: BoxPos, bend = 0): { d: string; lx: number; ly: number } {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const len = Math.hypot(bcx - acx, bcy - acy) || 1;
  const nx = -(bcy - acy) / len, ny = (bcx - acx) / len;
  const mx = (acx + bcx) / 2 + nx * bend, my = (acy + bcy) / 2 + ny * bend;
  const p1 = edgePoint(a, mx, my);
  const p2 = edgePoint(b, mx, my);
  return { d: `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`, lx: mx, ly: my };
}

/** Strichstärke aus der Anzahl Verbindungen (1 → 2 px, saturiert bei 8 px). */
export const strokeFor = (count: number): number => Math.min(8, 1.5 + count * 0.9);

/** Farbstufe einer Auslastung gegen eine Grenze. */
export function levelOf(value: number | undefined, limit = 100): "none" | "ok" | "warn" | "full" {
  if (value === undefined) return "none";
  const r = value / limit;
  return r >= 1 ? "full" : r >= 0.85 ? "warn" : "ok";
}

// --- Verbindungen um Kästen herumführen ---------------------------------------------------------------------------------

type Pt = { x: number; y: number };

/** Schneidet die achsenparallele oder schräge Strecke p→q das Rechteck r (Innenraum)? */
function segmentHitsRect(p: Pt, q: Pt, r: { x: number; y: number; w: number; h: number }): boolean {
  // Liang–Barsky
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const clip = (pp: number, qq: number): boolean => {
    if (pp === 0) return qq >= 0;
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, p.x - r.x) && clip(dx, r.x + r.w - p.x) && clip(-dy, p.y - r.y) && clip(dy, r.y + r.h - p.y) && t1 - t0 > 1e-9;
}

const grow = (b: BoxPos, m: number) => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

function polylineClear(pts: Pt[], others: BoxPos[], margin: number): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const o of others) if (segmentHitsRect(pts[i], pts[i + 1], grow(o, margin))) return false;
  }
  return true;
}

const pathLength = (pts: Pt[]) => pts.reduce((s, p, i) => (i === 0 ? 0 : s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)), 0);

/** Polylinie mit abgerundeten Ecken. */
function roundedPath(pts: Pt[], radius = 12): string {
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const a = { x: c.x + ((p.x - c.x) / l1) * r, y: c.y + ((p.y - c.y) / l1) * r };
    const b = { x: c.x + ((n.x - c.x) / l2) * r, y: c.y + ((n.y - c.y) / l2) * r };
    d += ` L${a.x.toFixed(1)},${a.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x.toFixed(1)},${last.y.toFixed(1)}`;
}

/** Mitte der längsten Teilstrecke (dort sitzt die Beschriftung). */
function labelPoint(pts: Pt[]): Pt {
  let best = 0;
  let at: Pt = pts[0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (l > best) {
      best = l;
      at = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    }
  }
  return at;
}

/**
 * Weg einer Verbindung zwischen zwei Kästen. Liegt die gerade Linie frei, bleibt sie (wie `linkPath`); sonst läuft sie
 * rechtwinklig mit runden Ecken durch die Gassen zwischen den Kästen bzw. um das Raster herum. `lane` versetzt parallele
 * Verbindungen, `bend` wirkt nur auf die gerade Linie (Gegenrichtung).
 */
export function routeLink(a: BoxPos, b: BoxPos, boxes: BoxPos[], bend = 0, lane = 0, gutter = 30): { d: string; lx: number; ly: number; routed: boolean } {
  const others = boxes.filter((x) => x.id !== a.id && x.id !== b.id);
  const straight = linkPath(a, b, bend);
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const sp = [{ x: acx, y: acy }, { x: bcx, y: bcy }];
  if (polylineClear(sp, others, 6)) return { ...straight, routed: false };

  const off = lane * 8;
  const all = boxes;
  const minX = Math.min(...all.map((x) => x.x)), maxX = Math.max(...all.map((x) => x.x + x.w));
  const minY = Math.min(...all.map((x) => x.y)), maxY = Math.max(...all.map((x) => x.y + x.h));
  const ys = [...new Set(all.flatMap((x) => [x.y, x.y + x.h]))].sort((p, q) => p - q);
  const xs = [...new Set(all.flatMap((x) => [x.x, x.x + x.w]))].sort((p, q) => p - q);
  const chY = [minY - gutter / 2], chX = [minX - gutter / 2];
  for (let i = 1; i + 1 < ys.length; i += 2) chY.push((ys[i] + ys[i + 1]) / 2);
  for (let i = 1; i + 1 < xs.length; i += 2) chX.push((xs[i] + xs[i + 1]) / 2);
  chY.push(maxY + gutter / 2);
  chX.push(maxX + gutter / 2);

  const cands: Pt[][] = [];
  for (const y0 of chY) {
    const y = y0 + off;
    if ((y > a.y && y < a.y + a.h) || (y > b.y && y < b.y + b.h)) continue;
    const ax = acx + off, bx = bcx + off;
    cands.push([{ x: ax, y: y < acy ? a.y : a.y + a.h }, { x: ax, y }, { x: bx, y }, { x: bx, y: y < bcy ? b.y : b.y + b.h }]);
  }
  for (const x0 of chX) {
    const x = x0 + off;
    if ((x > a.x && x < a.x + a.w) || (x > b.x && x < b.x + b.w)) continue;
    const ay = acy + off, by = bcy + off;
    cands.push([{ x: x < acx ? a.x : a.x + a.w, y: ay }, { x, y: ay }, { x, y: by }, { x: x < bcx ? b.x : b.x + b.w, y: by }]);
  }
  let best: Pt[] | undefined;
  let bestLen = Infinity;
  for (const c of cands) {
    if (!polylineClear(c, others, 4)) continue;
    // der Weg darf auch die eigenen Kästen nur an den Enden berühren
    if (!polylineClear(c.slice(1, -1).length ? [c[1], c[2]] : c, [a, b], 0)) continue;
    const len = pathLength(c);
    if (len < bestLen) {
      best = c;
      bestLen = len;
    }
  }
  if (!best) return { ...straight, routed: false };
  const lp = labelPoint(best);
  return { d: roundedPath(best), lx: lp.x, ly: lp.y, routed: true };
}
