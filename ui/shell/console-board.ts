// <omp-console-board>: Kachel-Ansicht für Mehrfach-Konsolen (Kapitel 12
// Teil 5 Ergänzung, 2026-07-22, Nutzerwunsch) — ersetzt console-view.ts's
// Tab-Leiste, sobald einem Operator mehr als eine Rolle in einem Workflow
// zugewiesen ist: alle zugewiesenen Node-UIs (z. B. Video Mixer M/E, OGraf,
// Viewer) gleichzeitig sichtbar und bedienbar, als frei verschieb- und
// skalierbare Kacheln statt hintereinander weggetabbt — echter Live-Betrieb
// braucht i. d. R. mehrere Instrumente gleichzeitig im Blick (PGM umschalten
// UND die Vorschau sehen), nicht nacheinander.
//
// Bei genau einem Eintrag bleibt console-view.ts (Vollbild, kein
// Kachel-Chrome) zuständig — s. shell.ts#createConsoleHost.
//
// Layout-Persistenz bewusst NUR im Browser (localStorage), nicht über den
// bestehenden `/api/v1/layouts`-Endpunkt (der verlangt `configure`, das
// reine Operatoren nicht haben) — passt ohnehin zum Kiosk-Charakter eines
// Regieplatzes (festes Gerät/Browser), gleiches Muster wie die bereits
// bestehende, lokal gespeicherte Parameter-Panel-Breite in
// ui/graph/flow-canvas.ts.
import { mountUIBundle } from "./ui-bundle.ts";
import type { ConsoleEntry } from "./console-view.ts";
import { diffEntries, reconcileLayouts, MIN_TILE_HEIGHT, MIN_TILE_WIDTH, type TileLayout } from "./console-board-logic.ts";

const FALLBACK_CONTAINER_WIDTH = 1200;

interface Tile {
  wrapper: HTMLDivElement;
  content: HTMLDivElement;
}

export class ConsoleBoard extends HTMLElement {
  #workflowId: string | null = null;
  #entries: ConsoleEntry[] = [];
  #layouts: Record<string, TileLayout> = {};
  #tiles = new Map<string, Tile>();
  #emptyMessage!: HTMLParagraphElement;

  connectedCallback() {
    this.style.cssText =
      "display:block;position:relative;width:100%;height:100%;overflow:auto;" +
      "background:#181818;font-family:sans-serif;";

    this.#emptyMessage = document.createElement("p");
    this.#emptyMessage.textContent = "Keine Konsole für diesen Nutzer zugewiesen.";
    this.#emptyMessage.style.cssText = "color:#eee;padding:12px;display:none;";
    this.appendChild(this.#emptyMessage);
  }

  // Muss vor dem ersten setEntries()-Aufruf gesetzt sein — bestimmt den
  // localStorage-Schlüssel für die Kachel-Positionen (pro Workflow getrennt,
  // da unterschiedliche Workflows unterschiedliche Rollen-Sätze haben).
  setWorkflowId(id: string) {
    this.#workflowId = id;
    this.#layouts = this.#loadLayouts();
  }

  #storageKey(): string {
    return `omp-console-board-layout:${this.#workflowId ?? "default"}`;
  }

  #loadLayouts(): Record<string, TileLayout> {
    try {
      const raw = localStorage.getItem(this.#storageKey());
      return raw ? (JSON.parse(raw) as Record<string, TileLayout>) : {};
    } catch {
      return {};
    }
  }

  #saveLayouts() {
    localStorage.setItem(this.#storageKey(), JSON.stringify(this.#layouts));
  }

  // Zweiter Parameter (preselectNodeRoleId) existiert nur, damit dieselbe
  // Aufrufstelle (shell.ts#watchConsoleEntries) unverändert sowohl gegen
  // <omp-console-view> als auch gegen dieses Element funktioniert — im
  // Kachel-Fall ergibt "eine Rolle vorauswählen" keinen Sinn (alle Rollen
  // sind ohnehin gleichzeitig sichtbar), Parameter wird ignoriert.
  async setEntries(entries: ConsoleEntry[], _preselectNodeRoleId?: string) {
    const diff = diffEntries(this.#entries, entries);
    this.#entries = entries;

    for (const roleId of diff.toUnmount) {
      this.#tiles.get(roleId)?.wrapper.remove();
      this.#tiles.delete(roleId);
      delete this.#layouts[roleId];
    }
    if (diff.toUnmount.length > 0) this.#saveLayouts();

    this.#emptyMessage.style.display = entries.length === 0 ? "block" : "none";

    if (diff.toMount.length > 0) {
      this.#layouts = reconcileLayouts(entries, this.#layouts, this.clientWidth || FALLBACK_CONTAINER_WIDTH);
      this.#saveLayouts();
      await Promise.all(diff.toMount.map((entry) => this.#mountTile(entry)));
    }

    if (diff.toRemount.length > 0) {
      await Promise.all(diff.toRemount.map((entry) => this.#remountTileContent(entry)));
    }
  }

  async #mountTile(entry: ConsoleEntry) {
    const wrapper = document.createElement("div");
    wrapper.dataset.nodeRoleId = entry.nodeRoleId;
    wrapper.style.cssText =
      "position:absolute;display:flex;flex-direction:column;background:#1f1f1f;" +
      "border:1px solid #444;border-radius:6px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    this.#applyLayout(wrapper, this.#layouts[entry.nodeRoleId]);

    const header = document.createElement("div");
    header.textContent = entry.nodeLabel;
    header.title = "Ziehen zum Verschieben";
    header.style.cssText =
      "cursor:move;padding:6px 10px;background:#262626;border-bottom:1px solid #444;" +
      "font-size:12px;font-weight:bold;color:#eee;user-select:none;flex-shrink:0;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    header.addEventListener("pointerdown", (ev) => this.#onDragStart(ev, entry.nodeRoleId));

    const content = document.createElement("div");
    content.style.cssText = "flex:1;min-height:0;overflow:auto;padding:8px;color:#eee;";

    const resizeHandle = document.createElement("div");
    resizeHandle.title = "Ziehen zum Skalieren";
    resizeHandle.textContent = "◢";
    resizeHandle.style.cssText =
      "position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;" +
      "font-size:10px;line-height:16px;text-align:right;padding-right:1px;color:#666;user-select:none;";
    resizeHandle.addEventListener("pointerdown", (ev) => this.#onResizeStart(ev, entry.nodeRoleId));

    wrapper.append(header, content, resizeHandle);
    this.appendChild(wrapper);
    this.#tiles.set(entry.nodeRoleId, { wrapper, content });

    await this.#loadTileContent(content, entry);
  }

  async #remountTileContent(entry: ConsoleEntry) {
    const tile = this.#tiles.get(entry.nodeRoleId);
    if (!tile) return;
    await this.#loadTileContent(tile.content, entry);
  }

  async #loadTileContent(content: HTMLDivElement, entry: ConsoleEntry) {
    content.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Lädt …";
    loading.style.cssText = "color:#999;margin:0;";
    content.appendChild(loading);

    const mounted = await mountUIBundle(content, entry.uiBundleUrl);
    if (!mounted) {
      content.replaceChildren();
      const p = document.createElement("p");
      p.textContent = `UI-Bundle für "${entry.nodeLabel}" konnte nicht geladen werden.`;
      p.style.margin = "0";
      content.appendChild(p);
    }
  }

  #applyLayout(wrapper: HTMLDivElement, layout: TileLayout) {
    wrapper.style.left = `${layout.x}px`;
    wrapper.style.top = `${layout.y}px`;
    wrapper.style.width = `${layout.width}px`;
    wrapper.style.height = `${layout.height}px`;
  }

  // Pointer-Capture auf dem Element selbst (Titelleiste bzw. Resize-Griff)
  // statt eines zentralen Drag-Zustands wie in flow-canvas.ts: hier kann
  // ohnehin immer nur eine Kachel gleichzeitig gezogen werden (ein
  // Pointer), jede Titelleiste/jeder Griff verwaltet ihren eigenen
  // Drag-Vorgang unabhängig — kein gemeinsamer Zustand nötig. Position wird
  // erst bei pointerup persistiert (kein Netzwerk-Call wie beim
  // Flow-Editor-Layout, ein `localStorage.setItem` bei jedem Pixel wäre
  // unnötiger Overhead).
  #onDragStart(ev: PointerEvent, roleId: string) {
    ev.stopPropagation();
    const header = ev.currentTarget as HTMLElement;
    const tile = this.#tiles.get(roleId);
    const base = this.#layouts[roleId];
    if (!tile || !base) return;
    header.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startLayout = { ...base };

    const onMove = (mv: PointerEvent) => {
      const next: TileLayout = {
        ...startLayout,
        x: Math.max(0, startLayout.x + (mv.clientX - startX)),
        y: Math.max(0, startLayout.y + (mv.clientY - startY)),
      };
      this.#layouts[roleId] = next;
      this.#applyLayout(tile.wrapper, next);
    };
    const onUp = () => {
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      this.#saveLayouts();
    };
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
  }

  #onResizeStart(ev: PointerEvent, roleId: string) {
    ev.stopPropagation();
    const handle = ev.currentTarget as HTMLElement;
    const tile = this.#tiles.get(roleId);
    const base = this.#layouts[roleId];
    if (!tile || !base) return;
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startLayout = { ...base };

    const onMove = (mv: PointerEvent) => {
      const next: TileLayout = {
        ...startLayout,
        width: Math.max(MIN_TILE_WIDTH, startLayout.width + (mv.clientX - startX)),
        height: Math.max(MIN_TILE_HEIGHT, startLayout.height + (mv.clientY - startY)),
      };
      this.#layouts[roleId] = next;
      this.#applyLayout(tile.wrapper, next);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      this.#saveLayouts();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }
}

if (!customElements.get("omp-console-board")) {
  customElements.define("omp-console-board", ConsoleBoard);
}
