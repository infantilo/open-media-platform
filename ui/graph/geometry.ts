// Reine Koordinaten-/Layout-Logik für <omp-flow-canvas> (UMSETZUNG.md B2)
// — kein DOM-Zugriff, damit sie ohne Browser per `deno test` prüfbar ist.

export interface Point {
  x: number;
  y: number;
}

/** Pan/Zoom-Zustand: (x, y) ist die Bildschirmposition des Weltursprungs,
 * scale der Zoomfaktor (Welt- auf Bildschirmkoordinaten). */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  };
}

/** Zoomt um den Faktor `factor` (>1 = rein, <1 = raus), so dass der
 * Weltpunkt unter `screenPoint` an derselben Bildschirmposition bleibt. */
export function zoomAt(
  viewport: Viewport,
  screenPoint: Point,
  factor: number,
): Viewport {
  const newScale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
  const worldPoint = screenToWorld(screenPoint, viewport);
  return {
    x: screenPoint.x - worldPoint.x * newScale,
    y: screenPoint.y - worldPoint.y * newScale,
    scale: newScale,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --- Node-/Port-Layout ---

export const NODE_WIDTH = 160;
export const HEADER_HEIGHT = 24;
export const PORT_SPACING = 20;
export const MIN_BODY_HEIGHT = 40;
// Größe der Kachel-Inline-Vorschau (16:9, s. flow-canvas.ts
// #renderPreviewThumbnail) — hier definiert, damit nodeHeight() für
// Nodes mit previewUrl genug Platz reserviert, statt das Bild über den
// Kachel-Rahmen hinausragen zu lassen (Nutzerfund 2026-07-12).
export const PREVIEW_WIDTH = NODE_WIDTH - 16;
export const PREVIEW_HEIGHT = Math.round((PREVIEW_WIDTH * 9) / 16);
const PREVIEW_MARGIN = 4;

/** Höhe einer Kachel abhängig von der größeren Port-Anzahl (Input/Output)
 * plus, falls `hasPreview`, reserviertem Platz für die Inline-Vorschau. */
export function nodeHeight(inputCount: number, outputCount: number, hasPreview = false): number {
  const rows = Math.max(inputCount, outputCount, 1);
  const bodyHeight = Math.max(MIN_BODY_HEIGHT, rows * PORT_SPACING);
  const previewSpace = hasPreview ? PREVIEW_HEIGHT + PREVIEW_MARGIN * 2 : 0;
  return HEADER_HEIGHT + bodyHeight + previewSpace;
}

export type PortSide = "input" | "output";

/** Position eines einzelnen Ports relativ zur Kachel-Position (nodeX,
 * nodeY): Input-Ports links, Output-Ports rechts, gleichmäßig über die
 * Körperhöhe verteilt. */
export function portPosition(
  nodeX: number,
  nodeY: number,
  nodeHeightValue: number,
  index: number,
  count: number,
  side: PortSide,
): Point {
  const bodyHeight = nodeHeightValue - HEADER_HEIGHT;
  const y = nodeY + HEADER_HEIGHT + (bodyHeight * (index + 1)) / (count + 1);
  const x = side === "input" ? nodeX : nodeX + NODE_WIDTH;
  return { x, y };
}

/** Default-Rasterposition für eine Kachel ohne gespeicherte Position
 * (neu erschienene Node), damit Kacheln nicht alle bei (0,0) stapeln. */
export function defaultPosition(index: number): Point {
  const columns = 4;
  const columnWidth = NODE_WIDTH + 60;
  const rowHeight = 160;
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { x: column * columnWidth + 40, y: row * rowHeight + 40 };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Sicherheitsabstand um bereits belegte Kacheln herum — ohne den würden
// zwei exakt aneinandergrenzende Kacheln (0 Abstand, Ränder berühren sich)
// optisch verschmelzen, obwohl rectsOverlap() sie technisch als
// "nicht überlappend" durchgehen ließe.
const FREE_POSITION_MARGIN = 20;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + FREE_POSITION_MARGIN &&
    a.x + a.width + FREE_POSITION_MARGIN > b.x &&
    a.y < b.y + b.height + FREE_POSITION_MARGIN &&
    a.y + a.height + FREE_POSITION_MARGIN > b.y
  );
}

/** Nächste Default-Rasterposition ab `startIndex`, die mit keinem der
 * `occupied`-Rechtecke überlappt — probiert aufsteigende Grid-Indizes
 * durch (dasselbe Raster wie `defaultPosition`), bis eine Kachel der
 * Größe `width`×`height` dort kollisionsfrei Platz hat. Deckt den Fall
 * ab, dass bereits vorhandene Kacheln manuell auf ein Default-Rasterfeld
 * verschoben wurden (`defaultPosition` allein kennt nur den Index, nicht
 * den tatsächlich belegten Platz). */
export function findFreePosition(
  occupied: Rect[],
  startIndex: number,
  width: number,
  height: number,
): Point {
  const MAX_ATTEMPTS = 10000;
  for (let index = startIndex; index < startIndex + MAX_ATTEMPTS; index++) {
    const pos = defaultPosition(index);
    const candidate: Rect = { x: pos.x, y: pos.y, width, height };
    if (!occupied.some((r) => rectsOverlap(candidate, r))) return pos;
  }
  return defaultPosition(startIndex);
}

export interface ArrangeNode {
  id: string;
  width: number;
  height: number;
}

export interface ArrangeEdge {
  from: string;
  to: string;
}

const ARRANGE_COLUMN_GAP = 80;
const ARRANGE_ROW_GAP = 30;
const ARRANGE_MARGIN = 40;

/** Ordnet Kacheln spaltenweise von Quellen (links) zu Senken (rechts) an,
 * nach Signalfluss-Tiefe (längster Pfad von einer Quelle ohne Eingänge) —
 * reine Topologie-Funktion für den "Auto-Anordnen"-Button, DOM-frei
 * testbar. Zyklen brechen die Berechnung nicht ab: Knoten, die wegen
 * eines Zyklus nie eine Eingangs-Kante von 0 erreichen, bekommen
 * pauschal die Spalte hinter der bisher tiefsten Ebene, statt undefiniert
 * (und damit optisch übereinander bei (0,0)) zu bleiben. */
export function arrangeByFlow(nodes: ArrangeNode[], edges: ArrangeEdge[]): Record<string, Point> {
  const ids = new Set(nodes.map((n) => n.id));
  const outgoing = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    remaining.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    outgoing.get(e.from)!.push(e.to);
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
  }

  // Kahn-artige Ebenen-Zuweisung: layer(v) = 1 + max(layer(u)) über alle
  // Kanten u->v, in Verarbeitungsreihenfolge topologisch aufsteigend.
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (remaining.get(n.id) === 0) {
      queue.push(n.id);
      layer.set(n.id, 0);
    }
  }
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    const l = layer.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, l + 1));
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (processed < nodes.length) {
    const fallbackLayer = Math.max(0, ...[...layer.values()]) + 1;
    for (const n of nodes) {
      if (!layer.has(n.id)) layer.set(n.id, fallbackLayer);
    }
  }

  const columns = new Map<number, ArrangeNode[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l)!.push(n);
  }

  const positions: Record<string, Point> = {};
  const sortedLayers = [...columns.keys()].sort((a, b) => a - b);
  let x = ARRANGE_MARGIN;
  for (const l of sortedLayers) {
    let y = ARRANGE_MARGIN;
    let widestInColumn = 0;
    for (const n of columns.get(l)!) {
      positions[n.id] = { x, y };
      y += n.height + ARRANGE_ROW_GAP;
      widestInColumn = Math.max(widestInColumn, n.width);
    }
    x += widestInColumn + ARRANGE_COLUMN_GAP;
  }
  return positions;
}
