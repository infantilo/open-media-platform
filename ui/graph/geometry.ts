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

/** Höhe einer Kachel abhängig von der größeren Port-Anzahl (Input/Output). */
export function nodeHeight(inputCount: number, outputCount: number): number {
  const rows = Math.max(inputCount, outputCount, 1);
  return HEADER_HEIGHT + Math.max(MIN_BODY_HEIGHT, rows * PORT_SPACING);
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
