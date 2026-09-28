// Reine Logik für <omp-console-board> (console-board.ts) — gleiches
// Trennungsprinzip wie console-logic.ts/ui/graph/groups.ts: DOM-freier Teil
// separat testbar, das Custom Element fasst nur noch DOM/Pointer-Events/
// localStorage an.
//
// Kachel-Board (Kapitel 12 Teil 5 Ergänzung, 2026-07-22, Nutzerwunsch):
// zeigt — anders als die Tab-Leiste in console-view.ts — ALLE einem
// Operator in einem Workflow zugewiesenen Node-UIs gleichzeitig als frei
// verschieb-/skalierbare Kacheln (z. B. Bildmischer + OGraf + Viewer
// nebeneinander, statt zwischen ihnen wegzutabben).
export interface ConsoleEntryLike {
  nodeRoleId: string;
  uiBundleUrl: string;
}

export interface TileLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  // Optional, rückwärtskompatibel zu bereits gespeicherten Layouts ohne
  // diese Felder (Kapitel 24, 2026-09-28: echte Fenster-Semantik —
  // Minimieren/Vor-Reihenfolge). `minimized` bleibt über Sitzungen hinweg
  // erhalten (ein bewusst weggeklapptes Panel soll es nach Reload bleiben),
  // `zIndex` ebenso (zuletzt fokussierte Kachel bleibt vorne).
  minimized?: boolean;
  zIndex?: number;
}

// Referenzgröße angelehnt an das bestehende ~280px-Parameter-Panel
// (flow-canvas.ts) — genug Platz für die meisten Node-UI-Bundles (Crosspoint-
// Buttons, kleine Formulare), ohne bei drei Kacheln nebeneinander sofort den
// sichtbaren Bereich zu sprengen.
export const DEFAULT_TILE_WIDTH = 340;
export const DEFAULT_TILE_HEIGHT = 320;
export const TILE_GAP = 12;
export const MIN_TILE_WIDTH = 260;
export const MIN_TILE_HEIGHT = 180;

// Einfaches Auto-Flow-Raster für eine Kachel ohne gespeicherte Position —
// Spaltenzahl aus der verfügbaren Container-Breite, mindestens eine Spalte
// (auch bei einem sehr schmalen/mobilen Viewport bleibt das Layout gültig).
export function computeDefaultLayout(index: number, containerWidth: number): TileLayout {
  const columns = Math.max(1, Math.floor((containerWidth + TILE_GAP) / (DEFAULT_TILE_WIDTH + TILE_GAP)));
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: col * (DEFAULT_TILE_WIDTH + TILE_GAP),
    y: row * (DEFAULT_TILE_HEIGHT + TILE_GAP),
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  };
}

// "Alle anordnen" (Kapitel 24, 2026-09-28, Nutzerwunsch "auto-arrange/
// tile"): anders als computeDefaultLayout (feste Komfort-Größe, nur für
// neu erscheinende Einzelkacheln) packt diese Funktion ALLE Kacheln in
// ein möglichst quadratisches Raster, das den sichtbaren Board-Bereich
// ausfüllt — klassisches Tiling-WM-Verhalten statt einer Spalte fester
// Breite. Wird nur bei explizitem Klick auf "Alle anordnen" aufgerufen,
// überschreibt bestehende Positionen bewusst.
export function computeTileGridLayout(count: number, containerWidth: number, containerHeight: number): TileLayout[] {
  if (count === 0) return [];
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const width = Math.max(MIN_TILE_WIDTH, Math.floor((containerWidth - TILE_GAP * (columns + 1)) / columns));
  const height = Math.max(MIN_TILE_HEIGHT, Math.floor((containerHeight - TILE_GAP * (rows + 1)) / rows));
  const layouts: TileLayout[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    layouts.push({
      x: TILE_GAP + col * (width + TILE_GAP),
      y: TILE_GAP + row * (height + TILE_GAP),
      width,
      height,
    });
  }
  return layouts;
}

// Baut die Layout-Map für den aktuellen Eintrags-Satz: gespeicherte
// Positionen bleiben für weiterhin vorhandene Rollen erhalten, neue Rollen
// bekommen eine Default-Position (fortlaufender Index NACH den bereits
// platzierten, gleicher Grund wie flow-canvas.ts#assignMissingPositions:
// sonst würden mehrere gleichzeitig neu erscheinende Kacheln sich alle auf
// denselben Default-Platz stapeln). Verwaiste Einträge (Rolle nicht mehr in
// `entries`) fehlen im Ergebnis — kein unbegrenztes Wachstum über viele
// Sitzungen hinweg (gleiches Prinzip wie
// flow-canvas.ts#pruneStalePositions).
export function reconcileLayouts<T extends ConsoleEntryLike>(
  entries: T[],
  stored: Record<string, TileLayout>,
  containerWidth: number,
): Record<string, TileLayout> {
  const result: Record<string, TileLayout> = {};
  let nextDefaultIndex = entries.filter((e) => stored[e.nodeRoleId]).length;
  for (const entry of entries) {
    const existing = stored[entry.nodeRoleId];
    result[entry.nodeRoleId] = existing ?? computeDefaultLayout(nextDefaultIndex++, containerWidth);
  }
  return result;
}

export interface EntriesDiff<T> {
  toMount: T[];
  toRemount: T[];
  toUnmount: string[];
}

// Ersetzt console-logic.ts#pickActiveEntry's Ein-Auswahl-Prinzip durch eine
// Mehrfach-Diff: alle gleichzeitig sichtbaren Kacheln müssen einzeln
// verglichen werden, nicht nur "welche EINE Rolle ist jetzt aktiv". Gleicher
// Neustart/Failover-Grund wie dort (s. pickActiveEntry-Doku): eine Rolle
// bleibt über einen Prozess-Neustart hinweg stabil (nodeRoleId), aber die
// dahinterliegende NMOS-Node-ID (Teil der uiBundleUrl) nicht — das muss als
// Remount erkannt werden, nicht als "unverändert".
export function diffEntries<T extends ConsoleEntryLike>(previous: T[], next: T[]): EntriesDiff<T> {
  const previousById = new Map(previous.map((e) => [e.nodeRoleId, e]));
  const nextIds = new Set(next.map((e) => e.nodeRoleId));

  const toMount: T[] = [];
  const toRemount: T[] = [];
  for (const entry of next) {
    const prior = previousById.get(entry.nodeRoleId);
    if (!prior) {
      toMount.push(entry);
    } else if (prior.uiBundleUrl !== entry.uiBundleUrl) {
      toRemount.push(entry);
    }
  }

  const toUnmount = previous.filter((e) => !nextIds.has(e.nodeRoleId)).map((e) => e.nodeRoleId);

  return { toMount, toRemount, toUnmount };
}
