// Reine Logik der Node-Diagnose an der Kachel (node-diagnose-dialog.ts, UMSETZUNG.md Kap. 72.7): Pipeline-Momentaufnahme in ein
// Bild bringen (Spalten von der Quelle zum Ausgang), Füllstände und Zustände einfärben.

export type NdLevel = "ok" | "warn" | "err";

export interface NdCheck {
  id: string;
  group: string;
  level: NdLevel;
  title: string;
  detail?: string;
  fix?: string;
}

export interface NdPad {
  name: string;
  dir: "src" | "sink";
  peer?: string | null;
  caps?: string | null;
}

export interface NdElement {
  name: string;
  factory: string;
  state: string;
  parent?: string | null;
  pads: NdPad[];
  level?: { buffers?: number; bytes?: number; timeNs?: number; maxBuffers?: number; maxBytes?: number; maxTimeNs?: number };
}

export interface NdPipeline {
  name: string;
  state: string;
  elements: NdElement[];
  error?: string;
}

export interface NdEdge {
  from: string;
  to: string;
  caps?: string;
}

export interface NdBox {
  name: string;
  factory: string;
  state: string;
  rank: number;
  row: number;
  /** Zahl der Elemente, die in diesem Baustein (Bin) stecken; 0 = ein einzelnes Element. */
  children: number;
  fill: number | null;
}

export interface NdLayout {
  boxes: NdBox[];
  edges: NdEdge[];
  ranks: number;
  rows: number;
}

/** Füllstand einer Queue 0…1 (Puffer, Bytes oder Zeit — das Größte); null ohne Grenze oder Zähler. */
export function queueFill(l: NdElement["level"]): number | null {
  if (!l) return null;
  const parts: number[] = [];
  if (l.maxBuffers && l.buffers !== undefined) parts.push(l.buffers / l.maxBuffers);
  if (l.maxBytes && l.bytes !== undefined) parts.push(l.bytes / l.maxBytes);
  if (l.maxTimeNs && l.timeNs !== undefined) parts.push(l.timeNs / l.maxTimeNs);
  if (parts.length === 0) return null;
  return Math.min(1, Math.max(...parts));
}

const elementOf = (peer: string): string => peer.slice(0, peer.lastIndexOf("."));

/**
 * Legt die Pipeline in Spalten (Rang = längster Weg von einer Quelle) und Zeilen. Es zeigt nur die oberste Ebene: Bausteine
 * (Bins) erscheinen als ein Kasten mit der Zahl ihrer Elemente — ihre Innenverbindungen wären sonst unlesbar.
 */
export function layoutPipeline(p: NdPipeline): NdLayout {
  const names = new Set(p.elements.map((e) => e.name));
  const top = p.elements.filter((e) => !e.parent || !names.has(e.parent));
  const topNames = new Set(top.map((e) => e.name));
  const children = new Map<string, number>();
  for (const e of p.elements) {
    // jedes Element zählt für seinen obersten Vorfahren
    let anc = e;
    const seen = new Set<string>();
    while (anc.parent && names.has(anc.parent) && !seen.has(anc.name)) {
      seen.add(anc.name);
      anc = p.elements.find((x) => x.name === anc.parent) ?? anc;
      if (anc.parent === undefined || anc === e) break;
    }
    if (anc !== e && topNames.has(anc.name)) children.set(anc.name, (children.get(anc.name) ?? 0) + 1);
  }

  const edges: NdEdge[] = [];
  const edgeKey = new Set<string>();
  for (const e of top) {
    for (const pad of e.pads) {
      if (pad.dir !== "src" || !pad.peer) continue;
      const to = elementOf(pad.peer);
      if (!topNames.has(to) || to === e.name) continue;
      const key = `${e.name}>${to}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ from: e.name, to, caps: pad.caps ?? undefined });
    }
  }

  // Rang = längster Weg von einer Quelle; Schleifen werden durch die begrenzte Rundenzahl abgefangen.
  const rank = new Map<string, number>(top.map((e) => [e.name, 0]));
  for (let round = 0; round < top.length; round++) {
    let changed = false;
    for (const ed of edges) {
      const r = (rank.get(ed.from) ?? 0) + 1;
      if (r > (rank.get(ed.to) ?? 0) && r < top.length) {
        rank.set(ed.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const rowOf = new Map<number, number>();
  const boxes: NdBox[] = top
    .slice()
    .sort((a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0) || a.name.localeCompare(b.name))
    .map((e) => {
      const r = rank.get(e.name) ?? 0;
      const row = rowOf.get(r) ?? 0;
      rowOf.set(r, row + 1);
      return { name: e.name, factory: e.factory, state: e.state, rank: r, row, children: children.get(e.name) ?? 0, fill: queueFill(e.level) };
    });
  return { boxes, edges, ranks: boxes.reduce((m, b) => Math.max(m, b.rank + 1), 0), rows: Math.max(0, ...rowOf.values()) };
}

/** Farbe eines Kastens: Zustand der Pipeline als Maßstab, Queue am Limit gelb. */
export function boxLevel(b: NdBox, pipelineState: string): NdLevel {
  if (pipelineState === "Playing" && b.state !== "Playing") return "err";
  if (b.fill !== null && b.fill >= 1) return "warn";
  return "ok";
}

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MiB`;
  return `${(n / 1024).toFixed(0)} KiB`;
}

/** Hängt die Zeile je Befund-Stufe zusammen: Probleme zuerst, in Ordnung getrennt. */
export function splitFindings(cs: NdCheck[]): { problems: NdCheck[]; fine: NdCheck[] } {
  return { problems: cs.filter((c) => c.level !== "ok"), fine: cs.filter((c) => c.level === "ok") };
}
