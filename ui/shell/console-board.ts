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
import { confirmDialog } from "../kit/omp-confirm.ts";
import { layoutDialog } from "./layout-dialog.ts";
import { t } from "./i18n.ts";
import "./upcoming.ts";
import { mountUIBundleEl, hasUIBundle } from "./ui-bundle.ts";
import { whoami } from "./auth.ts";
import { deckSession } from "./streamdeck/session.ts";
import type { ConsoleEntry } from "./console-view.ts";
import {
  applyPreset,
  computeTileGridLayout,
  type LayoutPreset,
  diffEntries,
  reconcileLayouts,
  MIN_TILE_HEIGHT,
  MIN_TILE_WIDTH,
  type TileLayout,
} from "./console-board-logic.ts";
import { hasPreviewUrl, bundleOwnsPreview, mountNodePreview, type MountedPreview } from "./node-preview.ts";

const FALLBACK_CONTAINER_WIDTH = 1200;
const FALLBACK_CONTAINER_HEIGHT = 800;
// Höhe des Knopfstreifens oben (Alle anordnen / Stream Deck): Kacheln beginnen darunter und werden nicht überdeckt.
const TOOLBAR_HEIGHT = 36;

interface Tile {
  wrapper: HTMLDivElement;
  content: HTMLDivElement;
  resizeHandle: HTMLDivElement;
  minimizeBtn: HTMLButtonElement;
  maximizeBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
  // Node liefert ein previewUrl-Bild (Schalter nur dann sichtbar); Vorschau selbst nur auf Wunsch.
  canPreview: boolean;
  previewHandle?: MountedPreview;
  // Nur im Speicher (Kapitel 24, 2026-09-28): Maximieren ist eine
  // vorübergehende Fokus-Aktion, keine dauerhafte Layout-Entscheidung wie
  // Minimieren — nach Neuladen der Seite startet keine Kachel maximiert.
  maximized: boolean;
}

export class ConsoleBoard extends HTMLElement {
  #workflowId: string | null = null;
  #entries: ConsoleEntry[] = [];
  #layouts: Record<string, TileLayout> = {};
  // Gespeicherter Kachel-Zustand je Rollen-Label (der Rollenname im Workflow): die
  // nodeRoleId (Instanz-ID) wechselt bei jedem Workflow-Neustart, das Label nicht.
  #stored: LayoutPreset = {};
  #tiles = new Map<string, Tile>();
  #emptyMessage!: HTMLParagraphElement;
  // Laufender Zähler für z-index/Vor-Reihenfolge (Kapitel 24) — beim Laden
  // gespeicherter Layouts auf deren höchsten Wert+1 gesetzt (s.
  // #loadLayouts), damit eine neu hinzukommende Kachel nicht versehentlich
  // vor eine kürzlich manuell nach vorne geholte Kachel rutscht.
  #nextZIndex = 1;
  // Höchstens eine Kachel gleichzeitig maximiert (klassisches
  // Fenster-Verhalten) — zweiter Klick auf "maximieren" woanders stellt
  // zuerst die vorherige Kachel wieder her.
  #maximizedRoleId: string | null = null;
  #resizeObserver?: ResizeObserver;
  // Vermeidet ein localStorage-Schreiben bei jedem Klick INNERHALB der
  // bereits vordersten Kachel (z. B. Tippen in ein Formularfeld des
  // Node-UI-Bundles) — #bringToFront feuert auf jedes Pointerdown in der
  // Kachel, nicht nur beim Ziehen.
  #topRoleId: string | null = null;
  #taskbar!: HTMLDivElement;
  #presetSelect!: HTMLSelectElement;
  #username = "";

  connectedCallback() {
    // Nutzerauftrag 2026-09-02 ("Console nach demselben Muster"): eigene
    // Farben durch Design-Tokens ersetzt — die "beleuchtete Hardware-
    // Taste" der eigentlichen Operator-UI-Bundles bleibt davon
    // unberührt, hier geht es nur um das Kachel-Chrome dieser View
    // selbst (Rahmen/Titelleisten, s. #mountTile unten).
    this.style.cssText =
      "display:block;position:relative;width:100%;height:100%;overflow:auto;" +
      "background:var(--omp-bg);font-family:var(--omp-font);";

    this.#emptyMessage = document.createElement("p");
    this.#emptyMessage.className = "omp-empty";
    this.#emptyMessage.textContent = t("console.none");
    this.#emptyMessage.style.cssText = "padding:12px;display:none;";
    this.appendChild(this.#emptyMessage);
    // Countdown bis zum nächsten für den Nutzer geplanten Workflow-Start; blendet sich selbst aus.
    this.appendChild(document.createElement("omp-upcoming-start"));

    const toolbar = document.createElement("div");
    toolbar.style.cssText = `position:sticky;top:0;display:flex;justify-content:flex-end;align-items:center;box-sizing:border-box;height:${TOOLBAR_HEIGHT}px;padding:0 6px;z-index:1000000;pointer-events:none;`;
    const arrangeBtn = document.createElement("button");
    arrangeBtn.type = "button";
    arrangeBtn.textContent = t("board.arrangeAll");
    arrangeBtn.title = t("board.arrangeAllTitle");
    arrangeBtn.style.cssText =
      "pointer-events:auto;padding:4px 10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);" +
      "background:var(--omp-surface-raised);color:var(--omp-text);cursor:pointer;font-size:var(--omp-font-size-sm);box-shadow:0 1px 4px rgba(0,0,0,0.4);";
    arrangeBtn.addEventListener("click", () => this.#retileAll());
    const btnCss =
      "pointer-events:auto;padding:4px 10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);" +
      "background:var(--omp-surface-raised);color:var(--omp-text);cursor:pointer;font-size:var(--omp-font-size-sm);box-shadow:0 1px 4px rgba(0,0,0,0.4);margin-left:6px;";
    this.#presetSelect = document.createElement("select");
    this.#presetSelect.style.cssText = btnCss;
    this.#presetSelect.addEventListener("change", () => {
      const name = this.#presetSelect.value;
      if (name) this.#applyNamedPreset(name);
      this.#presetSelect.value = "";
    });
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "💾";
    saveBtn.title = t("board.layoutSaveTitle");
    saveBtn.style.cssText = btnCss;
    saveBtn.addEventListener("click", () => this.#saveNamedPreset());
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "🗑";
    delBtn.title = t("board.layoutDelete");
    delBtn.style.cssText = btnCss;
    delBtn.addEventListener("click", () => this.#deleteNamedPreset());
    toolbar.append(this.#presetSelect, saveBtn, delBtn, arrangeBtn);
    arrangeBtn.style.marginLeft = "6px";
    // Layouts gelten je Nutzer + Workflow (Browser-lokal, s. Moduldoku).
    whoami().then((w) => {
      this.#username = w.username ?? "";
      this.#refreshPresetSelect();
    }).catch(() => {});

    this.#taskbar = document.createElement("div");
    this.#taskbar.setAttribute("aria-label", t("board.taskbar"));
    this.#taskbar.style.cssText =
      "position:absolute;left:0;right:0;display:none;gap:6px;align-items:center;box-sizing:border-box;height:34px;padding:0 8px;" +
      "background:var(--omp-surface-raised);border-top:1px solid var(--omp-border);z-index:1000001;overflow-x:auto;";
    this.appendChild(this.#taskbar);
    this.addEventListener("scroll", () => this.#positionTaskbar());

    deckSession.focusRequest = (id) => {
      if (id !== null && this.#tiles.has(id)) this.#bringToFront(id);
    };
    this.appendChild(toolbar);

    // Maximierte Kachel muss bei Board-Größenänderung (z. B. Browserfenster
    // resized, Seitenleiste ein-/ausgeklappt) den sichtbaren Bereich weiter
    // exakt ausfüllen — gleiches ResizeObserver-Muster wie bei der
    // Alert-Leiste-/User-Widget-Überlappung (Kapitel 21).
    this.#resizeObserver = new ResizeObserver(() => {
      this.#positionTaskbar();
      if (this.#maximizedRoleId) this.#applyMaximizedSize(this.#maximizedRoleId);
    });
    this.#resizeObserver.observe(this);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
    // Das Gerät gehört der App (bleibt beim Tab-Wechsel verbunden), die Kacheln dieser Ansicht nicht.
    for (const id of this.#tiles.keys()) deckSession.unregisterTab(id);
  }

  // Muss vor dem ersten setEntries()-Aufruf gesetzt sein — bestimmt den
  // localStorage-Schlüssel für die Kachel-Positionen (pro Workflow getrennt,
  // da unterschiedliche Workflows unterschiedliche Rollen-Sätze haben).
  setWorkflowId(id: string) {
    this.#workflowId = id;
    this.#layouts = {};
    this.#stored = this.#loadStored();
    this.#refreshPresetSelect();
  }

  // Taskleiste klebt unten am sichtbaren Ausschnitt (Board scrollt, Kacheln sind absolut).
  #positionTaskbar() {
    if (!this.#taskbar) return;
    this.#taskbar.style.top = `${this.scrollTop + this.clientHeight - 34}px`;
    // Rechts Platz für das feste Benutzer-Widget (Abmelden) lassen.
    const w = document.querySelector<HTMLElement>("[data-omp-user-widget]");
    const r = this.getBoundingClientRect();
    const overlap = w ? Math.max(0, r.right - w.getBoundingClientRect().left + 8) : 0;
    this.#taskbar.style.right = `${overlap}px`;
  }

  #renderTaskbar() {
    if (!this.#taskbar) return;
    this.#taskbar.replaceChildren();
    for (const e of this.#entries) {
      if (!this.#layouts[e.nodeRoleId]?.minimized) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = e.nodeLabel;
      chip.title = t("board.restore");
      chip.style.cssText =
        "flex-shrink:0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 12px;" +
        "border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface);" +
        "color:var(--omp-text);cursor:pointer;font-size:var(--omp-font-size-sm);";
      chip.addEventListener("click", () => this.#toggleMinimize(e.nodeRoleId));
      this.#taskbar.appendChild(chip);
    }
    this.#taskbar.style.display = this.#taskbar.childElementCount > 0 ? "flex" : "none";
    this.#positionTaskbar();
    // Widget wird ggf. erst nach dem Board eingehängt.
    setTimeout(() => this.#positionTaskbar(), 300);
  }

  // ---- Benannte Layouts (je Nutzer + Workflow, localStorage) ----
  #presetKey(): string {
    return `omp-console-board-presets:${this.#username}:${this.#workflowId ?? "default"}`;
  }

  #loadPresets(): Record<string, LayoutPreset> {
    try {
      return JSON.parse(localStorage.getItem(this.#presetKey()) ?? "{}") as Record<string, LayoutPreset>;
    } catch {
      return {};
    }
  }

  // Layouts werden unter dem Rollen-Label (= Rollenname im Workflow) abgelegt: die
  // nodeRoleId ist die Instanz-ID und ändert sich bei jedem Workflow-Neustart.
  #presetByLabel(byRole: Record<string, TileLayout>): LayoutPreset {
    const out: LayoutPreset = {};
    for (const [roleId, layout] of Object.entries(byRole)) {
      const label = this.#entries.find((e) => e.nodeRoleId === roleId)?.nodeLabel ?? roleId;
      out[label] = structuredClone(layout);
    }
    return out;
  }

  #presetByRole(byLabel: LayoutPreset): LayoutPreset {
    const out: LayoutPreset = {};
    for (const e of this.#entries) {
      const l = byLabel[e.nodeLabel] ?? byLabel[e.nodeRoleId];
      if (l) out[e.nodeRoleId] = l;
    }
    return out;
  }

  #refreshPresetSelect() {
    if (!this.#presetSelect) return;
    this.#presetSelect.replaceChildren(new Option(t("board.layouts"), ""));
    for (const name of Object.keys(this.#loadPresets()).sort()) this.#presetSelect.add(new Option(name, name));
    this.#presetSelect.value = "";
  }

  async #saveNamedPreset() {
    const presets = this.#loadPresets();
    const name = (await layoutDialog({
      title: t("board.layoutName"),
      confirmLabel: t("board.layoutSaveConfirm"),
      suggestions: Object.keys(presets).sort(),
    }))?.trim();
    if (!name) return;
    presets[name] = this.#presetByLabel(this.#layouts);
    try {
      localStorage.setItem(this.#presetKey(), JSON.stringify(presets));
    } catch {}
    this.#refreshPresetSelect();
  }

  async #deleteNamedPreset() {
    const presets = this.#loadPresets();
    const names = Object.keys(presets).sort();
    if (names.length === 0) return;
    const name = await layoutDialog({
      title: t("board.layoutDelete"),
      confirmLabel: t("kit.delete"),
      danger: true,
      choices: names,
    });
    if (!name || !(name in presets)) return;
    if (!(await confirmDialog(t("board.layoutConfirmDelete", { name }), { confirmLabel: t("kit.delete") }))) return;
    delete presets[name];
    try {
      localStorage.setItem(this.#presetKey(), JSON.stringify(presets));
    } catch {}
    this.#refreshPresetSelect();
  }

  #applyNamedPreset(name: string) {
    const preset = this.#loadPresets()[name];
    if (!preset) return;
    if (this.#maximizedRoleId) this.#toggleMaximize(this.#maximizedRoleId);
    this.#layouts = applyPreset(this.#layouts, this.#presetByRole(preset));
    for (const [roleId, tile] of this.#tiles) {
      const layout = this.#layouts[roleId];
      if (!layout) continue;
      this.#applyLayout(tile.wrapper, layout);
      this.#updateWindowButtons(roleId);
      this.#syncPreview(roleId);
    }
    this.#saveLayouts();
    this.#renderTaskbar();
  }

  #storageKey(): string {
    return `omp-console-board-layout:${this.#workflowId ?? "default"}`;
  }

  #loadStored(): LayoutPreset {
    let stored: LayoutPreset = {};
    try {
      const raw = localStorage.getItem(this.#storageKey());
      stored = raw ? (JSON.parse(raw) as LayoutPreset) : {};
    } catch {
      stored = {};
    }
    const maxZ = Math.max(0, ...Object.values(stored).map((l) => l.zIndex ?? 0));
    this.#nextZIndex = maxZ + 1;
    return stored;
  }

  // Übernimmt für neu eingehängte Rollen den gespeicherten Zustand (nach Label,
  // ersatzweise nach Instanz-ID wie in älteren Speicherständen).
  #seedFromStored(entries: ConsoleEntry[]) {
    for (const e of entries) {
      if (this.#layouts[e.nodeRoleId]) continue;
      const l = this.#stored[e.nodeLabel] ?? this.#stored[e.nodeRoleId];
      if (l) this.#layouts[e.nodeRoleId] = structuredClone(l);
    }
  }

  #saveLayouts() {
    // Nicht mehr laufende Rollen behalten ihren Eintrag, damit er nach Stop/Neustart wieder greift.
    this.#stored = { ...this.#stored, ...this.#presetByLabel(this.#layouts) };
    try {
      localStorage.setItem(this.#storageKey(), JSON.stringify(this.#stored));
    } catch {}
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
      const tile = this.#tiles.get(roleId);
      tile?.previewHandle?.dispose();
      tile?.wrapper.remove();
      deckSession.unregisterTab(roleId);
      this.#tiles.delete(roleId);
      delete this.#layouts[roleId];
    }
    if (diff.toUnmount.length > 0) this.#saveLayouts();
    queueMicrotask(() => this.#renderTaskbar());

    this.#emptyMessage.style.display = entries.length === 0 ? "block" : "none";

    if (diff.toMount.length > 0) {
      this.#seedFromStored(diff.toMount);
      this.#layouts = reconcileLayouts(entries, this.#layouts, this.clientWidth || FALLBACK_CONTAINER_WIDTH);
      this.#saveLayouts();
      await Promise.all(diff.toMount.map((entry) => this.#mountTile(entry)));
      this.#renderTaskbar();
    }

    if (diff.toRemount.length > 0) {
      await Promise.all(diff.toRemount.map((entry) => this.#remountTileContent(entry)));
    }
  }

  async #mountTile(entry: ConsoleEntry) {
    const wrapper = document.createElement("div");
    wrapper.dataset.nodeRoleId = entry.nodeRoleId;
    wrapper.style.cssText =
      "position:absolute;display:flex;flex-direction:column;background:var(--omp-surface);" +
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    this.#applyLayout(wrapper, this.#layouts[entry.nodeRoleId]);

    const header = document.createElement("div");
    header.title = t("board.dragMove");
    header.style.cssText =
      "cursor:move;padding:6px 10px;background:var(--omp-surface-raised);border-bottom:1px solid var(--omp-border);" +
      "display:flex;align-items:baseline;gap:6px;user-select:none;flex-shrink:0;" +
      "white-space:nowrap;overflow:hidden;";
    const label = document.createElement("span");
    label.textContent = entry.nodeLabel;
    label.style.cssText =
      "font-size:var(--omp-font-size-sm);font-weight:bold;color:var(--omp-text);overflow:hidden;text-overflow:ellipsis;";
    header.appendChild(label);
    // Host-Anzeige (Kapitel 13 Teil 4, Nutzerfund 2026-08-13): welcher
    // Host diese Rolle gerade ausführt — shell.ts#fetchConsoles reichert
    // hostLabel client-seitig an (s. ConsoleEntry-Doku), fehlt sie (noch
    // nicht angereichert/Join fehlgeschlagen), bleibt nur der Node-Name.
    if (entry.hostLabel) {
      const hostBadge = document.createElement("span");
      hostBadge.textContent = entry.hostLabel;
      hostBadge.title = t("board.hostTitle", { host: entry.hostLabel });
      hostBadge.style.cssText =
        "font-size:10px;font-weight:normal;color:var(--omp-text-dim);background:var(--omp-surface);padding:1px 6px;" +
        "border-radius:8px;overflow:hidden;text-overflow:ellipsis;";
      header.appendChild(hostBadge);
    }
    header.addEventListener("pointerdown", (ev) => this.#onDragStart(ev, entry.nodeRoleId));

    const spacer = document.createElement("div");
    spacer.style.cssText = "flex:1;min-width:6px;";
    header.appendChild(spacer);

    const windowButtonStyle =
      "flex-shrink:0;width:18px;height:18px;line-height:16px;padding:0;border:1px solid var(--omp-border);" +
      "border-radius:3px;background:var(--omp-surface);color:var(--omp-text-dim);cursor:pointer;font-size:11px;";
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.textContent = "👁";
    previewBtn.title = t("board.previewTitle");
    previewBtn.style.cssText = windowButtonStyle + "display:none;";
    previewBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    previewBtn.addEventListener("click", () => {
      const l = this.#layouts[entry.nodeRoleId];
      if (!l) return;
      l.preview = !l.preview;
      this.#saveLayouts();
      this.#syncPreview(entry.nodeRoleId);
    });
    header.appendChild(previewBtn);

    const minimizeBtn = document.createElement("button");
    minimizeBtn.type = "button";
    minimizeBtn.style.cssText = windowButtonStyle;
    minimizeBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    minimizeBtn.addEventListener("click", () => this.#toggleMinimize(entry.nodeRoleId));
    header.appendChild(minimizeBtn);

    const maximizeBtn = document.createElement("button");
    maximizeBtn.type = "button";
    maximizeBtn.style.cssText = windowButtonStyle;
    maximizeBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    maximizeBtn.addEventListener("click", () => this.#toggleMaximize(entry.nodeRoleId));
    header.appendChild(maximizeBtn);

    const content = document.createElement("div");
    content.style.cssText =
      "flex:1;min-height:0;overflow:auto;padding:8px;color:var(--omp-text);display:flex;flex-direction:column;gap:8px;";

    const resizeHandle = document.createElement("div");
    resizeHandle.title = t("board.dragResize");
    resizeHandle.textContent = "◢";
    resizeHandle.style.cssText =
      "position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;" +
      "font-size:10px;line-height:16px;text-align:right;padding-right:1px;color:var(--omp-text-dim);user-select:none;";
    resizeHandle.addEventListener("pointerdown", (ev) => this.#onResizeStart(ev, entry.nodeRoleId));

    wrapper.append(header, content, resizeHandle);
    // Klick/Ziehen irgendwo auf der Kachel (auch innerhalb des eigenen
    // Node-UI-Bundles) holt sie nach vorne — Capture-Phase, damit es
    // unabhängig davon feuert, ob ein Kind (z. B. Titelleiste, Fenster-
    // Buttons) das Event später per stopPropagation in der Bubble-Phase
    // anhält.
    wrapper.addEventListener("pointerdown", () => this.#bringToFront(entry.nodeRoleId), { capture: true });
    this.appendChild(wrapper);
    this.#tiles.set(entry.nodeRoleId, { wrapper, content, resizeHandle, minimizeBtn, maximizeBtn, previewBtn, canPreview: false, maximized: false });
    this.#bringToFront(entry.nodeRoleId);
    this.#updateWindowButtons(entry.nodeRoleId);

    await this.#loadTileContent(content, entry);
  }

  async #remountTileContent(entry: ConsoleEntry) {
    const tile = this.#tiles.get(entry.nodeRoleId);
    if (!tile) return;
    await this.#loadTileContent(tile.content, entry);
  }

  // Zeigt, falls vorhanden, die Live-Vorschau (previewUrl-Stream) ÜBER
  // dem node-eigenen UI-Bundle in derselben Kachel — Nutzerfund
  // 2026-08-25: ein Operator mit nur `operate` auf z. B.
  // omp-multiviewer-custom bekam bisher NUR dessen PIP-Layout-Editor zu
  // sehen, nie das eigentliche Video ("er muss ja das Video sehen
  // können"). previewUrl ist node-typ-unabhängig (Viewer, Multiviewer,
  // …) — kein Hardcoding auf einen bestimmten Node-Typ nötig.
  async #loadTileContent(content: HTMLDivElement, entry: ConsoleEntry) {
    this.#tiles.get(entry.nodeRoleId)?.previewHandle?.dispose();

    content.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = t("console.loading");
    loading.style.cssText = "color:var(--omp-text-dim);margin:0;";
    content.appendChild(loading);

    // Ausnahme (Nutzerfund 2026-09-28/29, `ownsPreview`-Manifestfeld, s.
    // console-view.ts + node-preview.ts#bundleOwnsPreview): Nodes wie
    // omp-viewer/omp-scope zeigen ihr previewUrl-Bild bereits selbst groß
    // als eigentlichen Bundle-Inhalt — der Aufsatz hier würde es nur
    // sinnlos doppeln. Der ursprüngliche Fix (27309d3) patchte nur
    // console-view.ts (Einzel-Kachel); console-board.ts (Mehrfach-Kacheln,
    // Kapitel 12 Teil 5) hatte denselben generischen Aufsatz-Code separat
    // und blieb unkorrigiert — sichtbar wurde das nur, wenn ein Operator
    // mehr als eine Konsolen-Rolle zugewiesen bekam (dann board statt
    // view, s. shell.ts#createConsoleHost).
    const [showsPreview, ownsPreview] = await Promise.all([
      hasPreviewUrl(entry.uiBundleUrl),
      bundleOwnsPreview(entry.uiBundleUrl),
    ]);
    content.replaceChildren();

    const tile = this.#tiles.get(entry.nodeRoleId);
    if (tile) {
      tile.previewHandle = undefined;
      tile.canPreview = showsPreview && !ownsPreview;
    }
    this.#syncPreview(entry.nodeRoleId);

    const bundleContainer = document.createElement("div");
    bundleContainer.style.cssText = "flex:1;min-height:0;";
    content.appendChild(bundleContainer);

    const mountedEl = await mountUIBundleEl(bundleContainer, entry.uiBundleUrl);
    // Stream Deck (Kap. 40.4): geöffnete Node-UI = Tab am Gerät.
    if (mountedEl) deckSession.registerTab(entry.nodeRoleId, entry.nodeLabel, mountedEl, entry.uiBundleUrl.split("/").pop() ?? "");
    else deckSession.unregisterTab(entry.nodeRoleId);
    if (!mountedEl) {
      bundleContainer.replaceChildren();
      const p = document.createElement("p");
      // Kein Bundle (z. B. omp-source) ist kein Fehler.
      const noUi = !(await hasUIBundle(entry.uiBundleUrl));
      p.textContent = noUi ? t("board.noUi") : t("console.bundleFailed", { node: entry.nodeLabel });
      if (noUi) {
        p.style.cssText = "margin:0;color:var(--omp-text-dim);";
        bundleContainer.appendChild(p);
        return;
      }
      p.style.cssText = "margin:0;color:var(--omp-error);";
      bundleContainer.appendChild(p);
    }
  }

  // Vorschau nur bei Bedarf einhängen (Standard aus); Schalter nur sichtbar, wenn der Node ein Bild liefert.
  #syncPreview(roleId: string) {
    const tile = this.#tiles.get(roleId);
    const entry = this.#entries.find((e) => e.nodeRoleId === roleId);
    const layout = this.#layouts[roleId];
    if (!tile || !entry || !layout) return;
    const want = tile.canPreview && !!layout.preview;
    tile.previewBtn.style.display = tile.canPreview ? "" : "none";
    tile.previewBtn.style.opacity = want ? "1" : "0.5";
    if (want && !tile.previewHandle) {
      tile.previewHandle = mountNodePreview(entry.uiBundleUrl);
      tile.content.prepend(tile.previewHandle.element);
    } else if (!want && tile.previewHandle) {
      tile.previewHandle.dispose();
      tile.previewHandle.element.remove();
      tile.previewHandle = undefined;
    }
  }

  #applyLayout(wrapper: HTMLDivElement, layout: TileLayout) {
    wrapper.style.left = `${layout.x}px`;
    wrapper.style.top = `${layout.y + TOOLBAR_HEIGHT}px`;
    wrapper.style.width = `${layout.width}px`;
    wrapper.style.height = `${layout.height}px`;
    // Minimierte Fenster verschwinden und liegen als Chip in der Taskleiste unten.
    wrapper.style.display = layout.minimized ? "none" : "flex";
    wrapper.style.zIndex = String(layout.zIndex ?? 0);
  }

  // Vor-Reihenfolge (Kapitel 24): "vorne" heißt hier "höchster z-index",
  // kein DOM-Reordering nötig — vermeidet, dass ein Reorder mitten im
  // Drag/Resize eines anderen Tiles dessen laufenden Pointer-Capture stört.
  #bringToFront(roleId: string) {
    if (this.#topRoleId === roleId) return;
    const layout = this.#layouts[roleId];
    const tile = this.#tiles.get(roleId);
    if (!layout || !tile) return;
    layout.zIndex = this.#nextZIndex++;
    tile.wrapper.style.zIndex = String(layout.zIndex);
    this.#topRoleId = roleId;
    deckSession.focusFromScreen(roleId);
    this.#saveLayouts();
  }

  #updateWindowButtons(roleId: string) {
    const tile = this.#tiles.get(roleId);
    const layout = this.#layouts[roleId];
    if (!tile || !layout) return;
    tile.minimizeBtn.textContent = layout.minimized ? "▢" : "–";
    tile.minimizeBtn.title = layout.minimized ? t("board.restore") : t("board.minimize");
    tile.maximizeBtn.textContent = tile.maximized ? "❐" : "▭";
    tile.maximizeBtn.title = tile.maximized ? t("board.restore") : t("board.maximize");
    tile.maximizeBtn.disabled = !!layout.minimized;
    tile.maximizeBtn.style.opacity = layout.minimized ? "0.4" : "1";
    tile.content.style.display = layout.minimized ? "none" : "flex";
    tile.resizeHandle.style.display = layout.minimized || tile.maximized ? "none" : "block";
  }

  #toggleMinimize(roleId: string) {
    const layout = this.#layouts[roleId];
    const tile = this.#tiles.get(roleId);
    if (!layout || !tile) return;
    if (tile.maximized) this.#toggleMaximize(roleId); // erst wiederherstellen, dann einklappen
    layout.minimized = !layout.minimized;
    this.#applyLayout(tile.wrapper, layout);
    this.#updateWindowButtons(roleId);
    this.#saveLayouts();
    if (!layout.minimized) this.#bringToFront(roleId);
    this.#renderTaskbar();
  }

  #toggleMaximize(roleId: string) {
    const layout = this.#layouts[roleId];
    const tile = this.#tiles.get(roleId);
    if (!layout || !tile) return;
    if (tile.maximized) {
      tile.maximized = false;
      this.#maximizedRoleId = null;
      this.#applyLayout(tile.wrapper, layout);
    } else {
      if (this.#maximizedRoleId && this.#maximizedRoleId !== roleId) this.#toggleMaximize(this.#maximizedRoleId);
      tile.maximized = true;
      this.#maximizedRoleId = roleId;
      this.#applyMaximizedSize(roleId);
      this.#bringToFront(roleId);
    }
    this.#updateWindowButtons(roleId);
  }

  #applyMaximizedSize(roleId: string) {
    const tile = this.#tiles.get(roleId);
    if (!tile) return;
    tile.wrapper.style.left = "0px";
    tile.wrapper.style.top = `${TOOLBAR_HEIGHT}px`;
    tile.wrapper.style.width = `${this.clientWidth || FALLBACK_CONTAINER_WIDTH}px`;
    tile.wrapper.style.height = `${(this.clientHeight || FALLBACK_CONTAINER_HEIGHT) - TOOLBAR_HEIGHT}px`;
  }

  // "Alle anordnen" (Nutzerwunsch, Kapitel 24): setzt jede sichtbare
  // Kachel auf ein frisches Raster zurück und klappt eingeklappte Kacheln
  // dabei wieder auf — ein Reset-Kommando, kein inkrementelles Umsortieren.
  #retileAll() {
    if (this.#maximizedRoleId) this.#toggleMaximize(this.#maximizedRoleId);
    const roleIds = this.#entries.map((e) => e.nodeRoleId);
    const grid = computeTileGridLayout(roleIds.length, this.clientWidth || FALLBACK_CONTAINER_WIDTH, (this.clientHeight || FALLBACK_CONTAINER_HEIGHT) - TOOLBAR_HEIGHT);
    roleIds.forEach((roleId, i) => {
      const layout = this.#layouts[roleId];
      const tile = this.#tiles.get(roleId);
      if (!layout || !tile) return;
      Object.assign(layout, grid[i], { minimized: false, zIndex: layout.zIndex });
      this.#applyLayout(tile.wrapper, layout);
      this.#updateWindowButtons(roleId);
    });
    this.#saveLayouts();
    this.#renderTaskbar();
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
    if (!tile || !base || tile.maximized) return;
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
    if (!tile || !base || tile.maximized) return;
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
