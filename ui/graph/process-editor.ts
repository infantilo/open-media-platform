// <omp-process-editor> — Kapitel 21 Phase 6 Teil 2: visueller Drag&Drop-
// Editor für den Schritt-Graph einer ProcessDefinition (A10, ersetzt das
// rohe JSON-<textarea>, das Phase 6 Teil 1 dafür bewusst als
// Übergangslösung dokumentiert hatte, s. ui/shell/process-view.ts
// Kopfkommentar). Nutzerentscheidung 2026-09-22 (UMSETZUNG.md §6b
// Entscheidung 3): eigener Editor auf ui/graph-Basis statt Blockly.
//
// Wiederverwendet geometry.ts (Pan/Zoom, NODE_WIDTH/HEADER_HEIGHT,
// arrangeByFlow für "Auto-Anordnen") UNVERÄNDERT — genau die reine,
// DOM-freie Koordinatenlogik, die role-designer.ts (der dokumentierte
// "Präzedenzfall genau für A10") bereits für einen strukturell
// identischen Anwendungsfall (abstrakter Knoten+Kanten-Graph statt
// Live-NMOS-Wiring) etabliert hat. Interaktionsmuster (Pan/Zoom/Drag-
// Zustandsmaschine, Kachel verschieben, vom Ausgangs-Anker ziehen zum
// Verbinden, Kante/× zum Entfernen anklicken, Palette mit Klick-ODER-
// Ziehen) bewusst 1:1 von role-designer.ts gespiegelt — dieselbe
// Begründung wie dort für dessen eigene, kleinere Kopie statt einer
// dritten, gemeinsamen Basisklasse: die Zustandsmaschine unterscheidet
// sich genug (Next- vs. Branch- vs. Compensation-Kanten statt eines
// einzigen Verbindungstyps), dass eine Abstraktion für nur zwei/drei
// Nutzer mehr kosten als sparen würde.
//
// Ein einzelner Ausgangs-Anker pro Kachel kann MEHRERE Kanten tragen
// (Next erlaubt AND-Fan-out, Branches mehrere benannte Fälle) — beim
// Ablegen einer gezogenen Verbindung auf einer Ziel-Kachel entscheidet
// ein kleines Modal, ob es eine unbedingte Next-Kante oder eine
// benannte Branch-Kante werden soll (s. #finishConnect/#openEdgeKindModal).
// CompensationStepID ist bewusst KEINE Ziehen-Kante (die Domäne selbst
// behandelt sie separat vom normalen Graph-Vorgänger-Pfad, s.
// orchestrator/internal/process/validate.go) — wird stattdessen im
// Konfigurations-Panel je Kachel als Dropdown gesetzt, optisch als
// eigene, gepunktete Linie mitgezeichnet.
import {
  arrangeByFlow,
  HEADER_HEIGHT,
  IDENTITY_VIEWPORT,
  NODE_WIDTH,
  type Point,
  screenToWorld,
  type Viewport,
  zoomAt,
} from "./geometry.ts";
import {
  addBranchConnection,
  addNextConnection,
  addStep,
  type DraftDefinition,
  type DraftStep,
  removeBranchConnection,
  removeNextConnection,
  removeStep,
  renameStepId,
  setCompensationStep,
  setStartStep,
  STEP_TYPES,
  uniqueStepId,
  updateStepFields,
} from "./process-editor-logic.ts";
import { showToast } from "../kit/omp-toast.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { apiFetch } from "../shell/connection.ts";
import {
  branchLabelsFor,
  DECISION_LABELS,
  missingConfig,
  type OutputField,
  STEP_TYPE_INFO,
  stepTypeLabel,
  triggerKindForSubject,
  type TriggerKind,
  triggerKinds,
} from "./process-step-config-logic.ts";
import { decisionLabel, openStepConfigModal } from "./process-step-config.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 3;
const TYPE_ROW_HEIGHT = 18;
const ACTIONS_ROW_HEIGHT = 22;
const TILE_HEIGHT = HEADER_HEIGHT + TYPE_ROW_HEIGHT + ACTIONS_ROW_HEIGHT;

// Menschenlesbare Namen/Beschreibungen je Typ: STEP_TYPE_INFO in
// process-step-config-logic.ts (Nachtrag 270 — vorher englische
// Fachbegriffe wie "Service Call"/"Condition").
const PALETTE_GROUPS: { id: "action" | "flow" | "human"; label: string }[] = [
  { id: "action", label: "Aktionen" },
  { id: "human", label: "Menschen" },
  { id: "flow", label: "Ablauf" },
];

// Asset-Status für Auslöser "Asset wechselt auf …" — Fallback, falls
// GET /api/v1/asset-lifecycle nicht erreichbar ist.
const ASSET_STATUS_LABEL: Record<string, string> = {
  ingesting: "Eingang",
  registered: "Registriert",
  processing: "In Verarbeitung",
  ready: "Bereit",
  in_review: "In Prüfung",
  approved: "Freigegeben",
  published: "Veröffentlicht",
  archived: "Archiviert",
  expired: "Abgelaufen",
  deleted: "Gelöscht",
};

type DragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport }
  | { kind: "tile"; id: string; startScreen: Point; startWorld: Point; moved: boolean }
  | { kind: "connect"; fromId: string; fromWorld: Point; currentScreen: Point };

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export class ProcessEditor extends HTMLElement {
  #def: DraftDefinition = { steps: [], startStepId: "" };
  #positions: Record<string, Point> = {};
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #changeReason = "";
  #drag: DragState | null = null;
  #editingId: string | null = null;
  // GET /api/v1/process-capabilities: null = (noch) unbekannt → alle
  // Typen anbieten, nichts als "nicht ausführbar" markieren.
  #executable: Set<string> | null = null;
  #scriptCommands: string[] = [];
  #assetStatuses: string[] = Object.keys(ASSET_STATUS_LABEL);

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #toolbar!: HTMLElement;
  #palette!: HTMLDivElement;

  connectedCallback() {
    this.style.cssText = "position:fixed;inset:0;z-index:2000;background:var(--omp-bg);font-family:var(--omp-font);";

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("data-role", "process-editor-canvas");
    svg.style.cssText =
      "position:absolute;top:40px;left:200px;right:0;width:calc(100% - 200px);height:calc(100% - 40px);" +
      "background:#1e1e1e;touch-action:none;";
    const viewportGroup = document.createElementNS(SVG_NS, "g");
    svg.appendChild(viewportGroup);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;

    svg.addEventListener("pointerdown", (ev) => this.#onCanvasPointerDown(ev));
    svg.addEventListener("pointermove", (ev) => this.#onPointerMove(ev));
    svg.addEventListener("pointerup", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("pointercancel", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("wheel", (ev) => this.#onWheel(ev), { passive: false });
    svg.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    });
    svg.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const type = ev.dataTransfer?.getData("text/plain");
      if (!type) return;
      const world = screenToWorld(this.#screenPoint(ev), this.#viewport);
      this.#addStepAt(type, { x: world.x - NODE_WIDTH / 2, y: world.y - TILE_HEIGHT / 2 });
    });

    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-role", "process-editor-toolbar");
    toolbar.style.cssText =
      "position:absolute;top:0;left:0;right:0;height:40px;background:#252525;color:#ddd;" +
      "font-size:12px;display:flex;align-items:center;gap:8px;padding:0 8px;box-sizing:border-box;z-index:10;";
    this.#toolbar = toolbar;

    const palette = document.createElement("div");
    palette.setAttribute("data-role", "process-editor-palette");
    palette.style.cssText =
      "position:absolute;top:40px;left:0;bottom:0;width:200px;background:#252525;color:#ddd;" +
      "padding:8px;overflow-y:auto;box-sizing:border-box;border-right:1px solid #444;z-index:10;";
    this.#palette = palette;

    this.append(toolbar, palette, svg);
    this.#renderToolbar();
    this.#renderPalette();
    this.#render();
    void this.#loadCapabilities();
  }

  async #loadCapabilities() {
    try {
      const [capRes, lcRes] = await Promise.all([apiFetch("/api/v1/process-capabilities"), apiFetch("/api/v1/asset-lifecycle")]);
      if (capRes.ok) {
        const caps = (await capRes.json()) as { stepTypes: string[]; scriptCommands: string[] };
        this.#executable = new Set(caps.stepTypes ?? []);
        this.#scriptCommands = caps.scriptCommands ?? [];
      }
      if (lcRes.ok) {
        const lc = (await lcRes.json()) as { asset: Record<string, string[]> };
        const all = new Set<string>(Object.keys(lc.asset));
        for (const tos of Object.values(lc.asset)) for (const t of tos) all.add(t);
        const order = Object.keys(ASSET_STATUS_LABEL);
        this.#assetStatuses = [...all].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      }
    } catch {
      // Editor bleibt voll benutzbar, nur ohne Ausführbarkeits-Hinweise.
    }
    this.#renderPalette();
    this.#renderToolbar();
    this.#render();
  }

  #isExecutable(type: string): boolean {
    return this.#executable === null || this.#executable.has(type);
  }

  #triggerKinds(): TriggerKind[] {
    return triggerKinds(this.#assetStatuses, (st) => ASSET_STATUS_LABEL[st] ?? st);
  }

  // Felder, die die konfigurierten Auslöser als Start-Eingabe liefern
  // (für den Variablen-Picker: input.*).
  #triggerFields(): OutputField[] {
    const kinds = this.#triggerKinds();
    const out: OutputField[] = [];
    for (const t of (this.#def.triggers ?? []) as { subject?: string }[]) {
      const k = triggerKindForSubject(kinds, t.subject ?? "");
      if (k) out.push(...k.inputFields);
    }
    return out;
  }

  // Öffnet den Editor mit einer bestehenden Definition (Bearbeiten) oder
  // leer (definition=null, neue Version). changeReason bleibt vom
  // Aufrufer unabhängig editierbar (eigenes Toolbar-Feld, s.
  // #renderToolbar) statt eines separaten Formulars in ui/shell/
  // process-view.ts — eine Stelle für die gesamte Versions-Erstellung.
  open(definition: DraftDefinition | null) {
    this.#def = definition
      ? { ...definition, steps: definition.steps.map((s) => ({ ...s })) }
      : { steps: [], startStepId: "" };
    this.#positions = {};
    this.#def.steps.forEach((s, i) => {
      this.#positions[s.id] = { x: (i % 4) * 220 + 40, y: Math.floor(i / 4) * 160 + 40 };
    });
    this.#changeReason = "";
    this.#editingId = null;
    this.#renderToolbar();
    // Positionen sind nicht Teil des Wire-Formats (Definition kennt
    // keine Layout-Daten) — eine geladene Version wird daher nach dem
    // Kantenfluss angeordnet statt im reinen Raster, sonst läse sich
    // ein bestehender Graph beim Bearbeiten wie Kraut und Rüben.
    if (this.#def.steps.length > 0) this.#autoArrange();
    else this.#render();
  }

  // Wird vom Aufrufer (process-view.ts) beim Speichern gelesen — der
  // Editor feuert bewusst kein "saved"-Event mit dem Payload, ruft aber
  // #close() selbst nicht auf: process-view.ts entscheidet (nach einem
  // evtl. fehlgeschlagenen POST) selbst, ob/wann der Editor verschwindet.
  getDefinition(): DraftDefinition {
    return this.#def;
  }

  getChangeReason(): string {
    return this.#changeReason;
  }

  #addStepAt(type: string, position?: Point) {
    const used = new Set(this.#def.steps.map((s) => s.id));
    const id = uniqueStepId(type, used);
    this.#def = addStep(this.#def, id, type);
    this.#positions[id] = position ?? this.#nextDefaultPosition();
    this.#renderToolbar();
    this.#render();
  }

  #nextDefaultPosition(): Point {
    const index = this.#def.steps.length;
    return { x: (index % 4) * 220 + 40, y: Math.floor(index / 4) * 160 + 40 };
  }

  async #removeStep(id: string) {
    const ok = await confirmDialog(`Schritt "${id}" wirklich entfernen? Verweise darauf (next/branches/compensation) werden mit entfernt.`);
    if (!ok) return;
    this.#def = removeStep(this.#def, id);
    delete this.#positions[id];
    this.#renderToolbar();
    this.#render();
  }

  #renameStep(oldId: string, newId: string) {
    const result = renameStepId(this.#def, oldId, newId);
    if (!result.ok) {
      if (newId.trim() && newId.trim() !== oldId) showToast("Ungültige oder bereits vergebene Schritt-ID.", { variant: "error" });
      this.#editingId = null;
      this.#render();
      return;
    }
    this.#def = result.def;
    this.#positions[newId.trim()] = this.#positions[oldId];
    delete this.#positions[oldId];
    this.#editingId = null;
    this.#renderToolbar();
    this.#render();
  }

  #autoArrange() {
    const nodes = this.#def.steps.map((s) => ({ id: s.id, width: NODE_WIDTH, height: TILE_HEIGHT }));
    const edges = this.#def.steps.flatMap((s) => [
      ...(s.next ?? []).map((to) => ({ from: s.id, to })),
      ...Object.values(s.branches ?? {}).map((to) => ({ from: s.id, to })),
    ]);
    this.#positions = arrangeByFlow(nodes, edges);
    this.#render();
  }

  // ---- Toolbar/Palette ---------------------------------------------------------------------

  #renderToolbar() {
    this.#toolbar.replaceChildren();
    // Knöpfe nie umbrechen; der lange Hinweistext wird stattdessen gekürzt.
    const nowrap = (b: HTMLElement) => (b.style.whiteSpace = "nowrap");

    const title = document.createElement("span");
    title.style.cssText = "font-weight:600;white-space:nowrap;";
    title.textContent = "Prozess-Ablauf";
    this.#toolbar.appendChild(title);

    const stats = document.createElement("span");
    stats.style.cssText = "color:#999;white-space:nowrap;";
    stats.textContent = `${this.#def.steps.length} Schritte`;
    this.#toolbar.appendChild(stats);

    const trigBtn = document.createElement("button");
    const nTrig = (this.#def.triggers ?? []).length;
    trigBtn.textContent = nTrig ? `⚡ Auslöser (${nTrig})` : "⚡ Auslöser: nur manuell";
    trigBtn.title = "Festlegen, bei welchem Ereignis der Prozess automatisch startet";
    trigBtn.setAttribute("data-role", "process-editor-triggers");
    trigBtn.addEventListener("click", () => this.#openTriggersModal());
    this.#toolbar.appendChild(trigBtn);

    const arrangeBtn = document.createElement("button");
    arrangeBtn.textContent = "Auto-Anordnen";
    arrangeBtn.addEventListener("click", () => this.#autoArrange());
    this.#toolbar.appendChild(arrangeBtn);

    const reasonInput = document.createElement("input");
    reasonInput.placeholder = "Änderungsgrund (optional)";
    reasonInput.value = this.#changeReason;
    reasonInput.style.cssText = "width:220px;";
    reasonInput.addEventListener("input", () => {
      this.#changeReason = reasonInput.value;
    });
    this.#toolbar.appendChild(reasonInput);

    const hint = document.createElement("span");
    hint.style.cssText = "color:#999;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    hint.textContent =
      "Doppelklick auf eine Kachel: einstellen · vom Kreis rechts auf eine Kachel ziehen: verbinden · " +
      "Verbindung anklicken: entfernen";
    this.#toolbar.appendChild(hint);

    const saveBtn = document.createElement("button");
    saveBtn.className = "omp-btn-primary";
    saveBtn.textContent = "Speichern";
    saveBtn.setAttribute("data-role", "process-editor-save");
    saveBtn.addEventListener("click", () => this.dispatchEvent(new CustomEvent("process-editor-save")));
    this.#toolbar.appendChild(saveBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Abbrechen";
    closeBtn.addEventListener("click", () => this.dispatchEvent(new CustomEvent("process-editor-cancel")));
    this.#toolbar.appendChild(closeBtn);
    this.#toolbar.querySelectorAll("button").forEach((b) => nowrap(b as HTMLElement));
    hint.title = hint.textContent ?? "";
  }

  #renderPalette() {
    this.#palette.replaceChildren();

    const heading = document.createElement("div");
    heading.textContent = "Bausteine";
    heading.style.cssText = "font-size:12px;font-weight:600;margin-bottom:2px;";
    this.#palette.appendChild(heading);
    const sub = document.createElement("div");
    sub.textContent = "Klicken oder auf die Fläche ziehen.";
    sub.style.cssText = "font-size:10px;color:#999;margin-bottom:6px;";
    this.#palette.appendChild(sub);

    const makeItem = (type: string, enabled: boolean) => {
      const info = STEP_TYPE_INFO[type];
      const item = document.createElement("div");
      item.setAttribute("data-role", "process-editor-palette-item");
      item.setAttribute("data-step-type", type);
      item.textContent = `+ ${stepTypeLabel(type)}`;
      item.title = enabled ? (info?.help ?? "") : `${info?.help ?? ""} Auf diesem Server nicht ausführbar — ein Prozess mit diesem Baustein würde beim Erreichen des Schritts fehlschlagen.`;
      item.style.cssText =
        "padding:4px 6px;margin-bottom:4px;border:1px solid #444;border-radius:3px;" +
        "background:#2a2a2a;font-size:11px;user-select:none;" +
        (enabled ? "cursor:grab;color:#ddd;" : "cursor:not-allowed;color:#777;border-style:dashed;");
      if (enabled) {
        item.draggable = true;
        item.addEventListener("dragstart", (ev) => {
          ev.dataTransfer?.setData("text/plain", type);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
        });
        item.addEventListener("click", () => this.#addStepAt(type));
      }
      return item;
    };

    for (const group of PALETTE_GROUPS) {
      const types = STEP_TYPES.filter((t) => (STEP_TYPE_INFO[t]?.group ?? "action") === group.id && this.#isExecutable(t));
      if (types.length === 0) continue;
      const gh = document.createElement("div");
      gh.textContent = group.label;
      gh.style.cssText = "font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.04em;margin:8px 0 4px;";
      this.#palette.appendChild(gh);
      for (const t of types) this.#palette.appendChild(makeItem(t, true));
    }
    const unavailable = STEP_TYPES.filter((t) => !this.#isExecutable(t));
    if (unavailable.length) {
      const det = document.createElement("details");
      det.style.cssText = "margin-top:10px;";
      const sum = document.createElement("summary");
      sum.textContent = `Nicht verfügbar (${unavailable.length})`;
      sum.style.cssText = "font-size:10px;color:#999;cursor:pointer;";
      det.appendChild(sum);
      for (const t of unavailable) det.appendChild(makeItem(t, false));
      this.#palette.appendChild(det);
    }
  }

  // ---- Rendering -----------------------------------------------------------------------------

  #render() {
    this.#viewportGroup.replaceChildren();
    this.#viewportGroup.setAttribute("transform", `translate(${this.#viewport.x},${this.#viewport.y}) scale(${this.#viewport.scale})`);

    type Edge = { from: string; to: string; kind: "next" | "branch" | "compensation"; label?: string };
    const edges: Edge[] = [];
    for (const s of this.#def.steps) {
      for (const to of s.next ?? []) edges.push({ from: s.id, to, kind: "next" });
      for (const [label, to] of Object.entries(s.branches ?? {})) edges.push({ from: s.id, to, kind: "branch", label });
      if (s.compensationStepId) edges.push({ from: s.id, to: s.compensationStepId, kind: "compensation" });
    }

    edges.forEach((e, i) => {
      if (!this.#positions[e.from] || !this.#positions[e.to]) return;
      this.#viewportGroup.appendChild(this.#renderEdge(e, i));
    });
    for (const step of this.#def.steps) {
      this.#viewportGroup.appendChild(this.#renderTile(step));
    }
    if (this.#drag?.kind === "connect") {
      this.#viewportGroup.appendChild(this.#renderRubberBand(this.#drag));
    }
  }

  #tilePos(id: string): Point {
    return this.#positions[id] ?? { x: 0, y: 0 };
  }

  #outputAnchor(id: string): Point {
    const p = this.#tilePos(id);
    return { x: p.x + NODE_WIDTH, y: p.y + TILE_HEIGHT / 2 };
  }

  #inputAnchor(id: string): Point {
    const p = this.#tilePos(id);
    return { x: p.x, y: p.y + TILE_HEIGHT / 2 };
  }

  #renderEdge(edge: { from: string; to: string; kind: "next" | "branch" | "compensation"; label?: string }, index: number): SVGGElement {
    const from = this.#outputAnchor(edge.from);
    const to = this.#inputAnchor(edge.to);
    const color = edge.kind === "next" ? "#5b9bd5" : edge.kind === "branch" ? "#e0a75b" : "#c0392b";
    const dash = edge.kind === "next" ? "" : edge.kind === "branch" ? "4 4" : "2 3";

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "process-edge");

    const hitLine = document.createElementNS(SVG_NS, "line");
    hitLine.setAttribute("x1", String(from.x));
    hitLine.setAttribute("y1", String(from.y));
    hitLine.setAttribute("x2", String(to.x));
    hitLine.setAttribute("y2", String(to.y));
    hitLine.setAttribute("stroke", "transparent");
    hitLine.setAttribute("stroke-width", "14");
    hitLine.style.cursor = "pointer";

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "2");
    if (dash) line.setAttribute("stroke-dasharray", dash);
    line.style.pointerEvents = "none";

    const title = document.createElementNS(SVG_NS, "title");
    title.textContent =
      edge.kind === "next"
        ? `${edge.from} → ${edge.to} (next) — anklicken zum Entfernen`
        : edge.kind === "branch"
          ? `${edge.from} → ${edge.to} (branch: ${edge.label}) — anklicken zum Entfernen`
          : `${edge.from} → ${edge.to} (compensation)`;
    hitLine.appendChild(title);

    if (edge.kind !== "compensation") {
      hitLine.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        if (edge.kind === "next") {
          this.#def = removeNextConnection(this.#def, edge.from, edge.to);
        } else {
          this.#def = removeBranchConnection(this.#def, edge.from, edge.label!);
        }
        this.#render();
      });
    }

    g.append(hitLine, line);

    if (edge.kind === "branch" && edge.label) {
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(mid.x));
      label.setAttribute("y", String(mid.y - 4));
      label.setAttribute("fill", color);
      label.setAttribute("font-size", "10");
      label.setAttribute("text-anchor", "middle");
      label.style.pointerEvents = "none";
      label.textContent = DECISION_LABELS[edge.label] ?? edge.label;
      g.appendChild(label);
    }

    return g;
  }

  #renderRubberBand(drag: Extract<DragState, { kind: "connect" }>): SVGLineElement {
    const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
    const currentWorld = screenToWorld(drag.currentScreen, this.#viewport);
    line.setAttribute("x1", String(drag.fromWorld.x));
    line.setAttribute("y1", String(drag.fromWorld.y));
    line.setAttribute("x2", String(currentWorld.x));
    line.setAttribute("y2", String(currentWorld.y));
    line.setAttribute("stroke", "#5b9bd5");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "2 2");
    line.style.pointerEvents = "none";
    return line;
  }

  #renderTile(step: DraftStep): SVGGElement {
    const pos = this.#tilePos(step.id);
    const isStart = step.id === this.#def.startStepId;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "process-step-tile");
    g.setAttribute("data-step-id", step.id);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(TILE_HEIGHT));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", "#2a2a2a");
    body.setAttribute("stroke", isStart ? "#e0c05b" : "#5b9bd5");
    body.setAttribute("stroke-width", isStart ? "3" : "2");
    body.style.cursor = "move";
    body.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, step.id));
    body.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this.#openConfigModal(step.id);
    });
    g.appendChild(body);

    if (this.#editingId === step.id) {
      g.appendChild(this.#renderIdEditor(step.id));
    } else {
      const idText = document.createElementNS(SVG_NS, "text");
      idText.setAttribute("x", "6");
      idText.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      idText.setAttribute("fill", isStart ? "#e0c05b" : "#f0f0f0");
      idText.setAttribute("font-size", "12");
      // Auf die Breite bis zu den Kachel-Icons kürzen (★ braucht Platz),
      // voller Name + ID als Tooltip.
      const full = step.name || step.id;
      const max = isStart ? 13 : 15;
      const shown = full.length > max ? full.slice(0, max - 1) + "…" : full;
      idText.textContent = (isStart ? "★ " : "") + shown;
      const tip = document.createElementNS(SVG_NS, "title");
      tip.textContent = step.name ? `${step.name} (ID: ${step.id})` : step.id;
      idText.appendChild(tip);
      idText.style.cursor = "text";
      idText.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      idText.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.#editingId = step.id;
        this.#render();
      });
      g.appendChild(idText);
    }

    const renameIcon = document.createElementNS(SVG_NS, "text");
    renameIcon.setAttribute("x", String(NODE_WIDTH - 46));
    renameIcon.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    renameIcon.setAttribute("fill", "#999");
    renameIcon.setAttribute("font-size", "11");
    renameIcon.textContent = "✎";
    renameIcon.style.cursor = "pointer";
    renameIcon.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    renameIcon.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#editingId = step.id;
      this.#render();
    });
    g.appendChild(renameIcon);

    const configIcon = document.createElementNS(SVG_NS, "text");
    configIcon.setAttribute("x", String(NODE_WIDTH - 32));
    configIcon.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    configIcon.setAttribute("fill", "#999");
    configIcon.setAttribute("font-size", "11");
    configIcon.textContent = "⚙";
    configIcon.style.cursor = "pointer";
    configIcon.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    configIcon.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#openConfigModal(step.id);
    });
    g.appendChild(configIcon);

    const removeIcon = document.createElementNS(SVG_NS, "text");
    removeIcon.setAttribute("x", String(NODE_WIDTH - 16));
    removeIcon.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    removeIcon.setAttribute("fill", "#c0392b");
    removeIcon.setAttribute("font-size", "12");
    removeIcon.textContent = "×";
    removeIcon.style.cursor = "pointer";
    removeIcon.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    removeIcon.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.#removeStep(step.id);
    });
    g.appendChild(removeIcon);

    const typeText = document.createElementNS(SVG_NS, "text");
    typeText.setAttribute("x", "6");
    typeText.setAttribute("y", String(HEADER_HEIGHT + 13));
    typeText.setAttribute("font-size", "10");
    // Warnung direkt auf der Kachel statt erst beim Ausführen: nicht
    // ausführbarer Typ (rot) oder fehlende Pflichtangabe (orange).
    const problem = !this.#isExecutable(step.type) ? "nicht ausführbar" : missingConfig(step);
    typeText.setAttribute("fill", problem ? (this.#isExecutable(step.type) ? "#e0a75b" : "#e06b5b") : "#999");
    typeText.setAttribute("data-role", "process-step-status");
    typeText.textContent = problem ? `⚠ ${stepTypeLabel(step.type)}: ${problem}` : stepTypeLabel(step.type);
    typeText.style.pointerEvents = "none";
    g.appendChild(typeText);

    if (!isStart) {
      const startBtn = document.createElementNS(SVG_NS, "text");
      startBtn.setAttribute("x", "6");
      startBtn.setAttribute("y", String(HEADER_HEIGHT + TYPE_ROW_HEIGHT + 15));
      startBtn.setAttribute("fill", "#999");
      startBtn.setAttribute("font-size", "10");
      startBtn.textContent = "☆ als Start setzen";
      startBtn.style.cursor = "pointer";
      startBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      startBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#def = setStartStep(this.#def, step.id);
        this.#renderToolbar();
        this.#render();
      });
      g.appendChild(startBtn);
    }

    const anchor = document.createElementNS(SVG_NS, "circle");
    anchor.setAttribute("data-role", "process-output-anchor");
    anchor.setAttribute("cx", String(NODE_WIDTH));
    anchor.setAttribute("cy", String(TILE_HEIGHT / 2));
    anchor.setAttribute("r", "7");
    anchor.setAttribute("fill", "#1e1e1e");
    anchor.setAttribute("stroke", "#5b9bd5");
    anchor.setAttribute("stroke-width", "2");
    anchor.style.cursor = "crosshair";
    anchor.addEventListener("pointerdown", (ev) => this.#onOutputAnchorPointerDown(ev, step.id));
    g.appendChild(anchor);

    return g;
  }

  #renderIdEditor(oldId: string): SVGForeignObjectElement {
    const obj = document.createElementNS(SVG_NS, "foreignObject") as SVGForeignObjectElement;
    obj.setAttribute("x", "4");
    obj.setAttribute("y", "2");
    obj.setAttribute("width", String(NODE_WIDTH - 50));
    obj.setAttribute("height", String(HEADER_HEIGHT - 4));
    obj.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const input = document.createElement("input");
    input.type = "text";
    input.value = oldId;
    input.style.cssText =
      "width:100%;height:100%;box-sizing:border-box;font-size:11px;font-family:inherit;" +
      "background:#1e1e1e;color:#f0f0f0;border:1px solid #5b9bd5;border-radius:2px;padding:0 3px;";

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      this.#renameStep(oldId, input.value);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.#editingId = null;
      this.#render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", commit);
    obj.appendChild(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return obj;
  }

  // ---- Konfigurations-Modal (Name/Config/Retry/Timeout/Compensation) ----------------------

  #openConfigModal(id: string) {
    openStepConfigModal(
      this,
      { def: this.#def, stepId: id, scriptCommands: this.#scriptCommands, triggerFields: this.#triggerFields() },
      (r) => {
        this.#def = updateStepFields(this.#def, id, {
          name: r.name,
          config: r.config,
          retry: r.retry,
          timeoutSeconds: r.timeoutSeconds,
        });
        this.#def = setCompensationStep(this.#def, id, r.compensationStepId);
        this.#render();
      },
    );
  }

  // Auslöser (A8): wann startet der Prozess automatisch? Formular statt
  // JSON — Asset-Ereignisse als Auswahl, eigenes Subject nur unter
  // "Erweitert". Ein Filter-Ausdruck wird bewusst NICHT angeboten: das
  // Backend (triggerlistener.go) wertet EventTrigger.Filter noch nicht
  // aus, ein Feld dafür würde eine Wirkung versprechen, die es nicht gibt.
  #openTriggersModal() {
    const kinds = this.#triggerKinds();
    const triggers = ((this.#def.triggers ?? []) as { subject?: string }[]).map((t) => ({ ...t }));
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "2100";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = "560px";
    modal.setAttribute("data-role", "triggers-modal");
    modal.innerHTML = `<div class="omp-h1">Automatisch starten, wenn …</div>
      <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:4px 0 8px;">
        Ohne Auslöser startet der Prozess nur manuell („Starten“). Die Daten des Ereignisses stehen den Schritten als Start-Eingabe zur Verfügung (z. B. die Asset-ID).
        Auslöser wirken erst, wenn die Version veröffentlicht ist.</div>`;
    const list = document.createElement("div");
    modal.appendChild(list);

    const render = () => {
      list.replaceChildren();
      if (triggers.length === 0) {
        const e = document.createElement("div");
        e.className = "omp-empty";
        e.textContent = "Kein Auslöser — nur manueller Start.";
        list.appendChild(e);
      }
      triggers.forEach((t, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:4px;margin-top:4px;align-items:center;";
        const sel = document.createElement("select");
        sel.name = "trigger-kind";
        sel.style.cssText = "flex:1;min-width:0;";
        for (const k of kinds) sel.appendChild(new Option(k.label, k.subject));
        const known = triggerKindForSubject(kinds, t.subject ?? "");
        const custom = document.createElement("input");
        custom.name = "trigger-subject";
        custom.placeholder = "eigenes Subject, z. B. omp.process.x.fertig";
        custom.style.cssText = "flex:1;min-width:0;font-family:ui-monospace,monospace;";
        sel.appendChild(new Option("Eigenes Ereignis (erweitert) …", "__custom"));
        sel.value = known ? known.subject : "__custom";
        custom.value = known ? "" : t.subject ?? "";
        custom.style.display = known ? "none" : "block";
        sel.addEventListener("change", () => {
          if (sel.value === "__custom") {
            custom.style.display = "block";
            t.subject = custom.value;
          } else {
            custom.style.display = "none";
            t.subject = sel.value;
          }
        });
        custom.addEventListener("input", () => (t.subject = custom.value.trim()));
        const rm = document.createElement("button");
        rm.textContent = "✕";
        rm.addEventListener("click", () => {
          triggers.splice(idx, 1);
          render();
        });
        row.append(sel, custom, rm);
        list.appendChild(row);
      });
    };
    render();

    const add = document.createElement("button");
    add.textContent = "+ Auslöser";
    add.setAttribute("data-role", "trigger-add");
    add.style.marginTop = "6px";
    add.addEventListener("click", () => {
      triggers.push({ subject: kinds[0]?.subject ?? "" });
      render();
    });
    modal.appendChild(add);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
    const cancel = document.createElement("button");
    cancel.textContent = "Abbrechen";
    cancel.addEventListener("click", () => overlay.remove());
    const ok = document.createElement("button");
    ok.className = "omp-btn-primary";
    ok.textContent = "Übernehmen";
    ok.setAttribute("data-role", "triggers-apply");
    ok.addEventListener("click", () => {
      if (triggers.some((t) => !t.subject)) {
        showToast("Jeder Auslöser braucht ein Ereignis.", { variant: "error" });
        return;
      }
      this.#def = { ...this.#def, triggers: triggers.length ? triggers : undefined };
      overlay.remove();
      this.#renderToolbar();
    });
    actions.append(cancel, ok);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) overlay.remove();
    });
    this.appendChild(overlay);
  }

  // Kleines Modal nach dem Ablegen einer gezogenen Verbindung: Next
  // (unbedingt) oder Branch (mit Label) — s. Moduldoku oben.
  #openEdgeKindModal(fromId: string, toId: string) {
    const fromStep = this.#def.steps.find((s) => s.id === fromId);
    const toStep = this.#def.steps.find((s) => s.id === toId);
    const labels = branchLabelsFor(fromStep);
    const used = new Set(Object.keys(fromStep?.branches ?? {}));
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "2100";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = "420px";
    modal.setAttribute("data-role", "edge-kind-modal");
    modal.innerHTML = `<div class="omp-h1" style="margin-bottom:8px;">${escapeHtml(fromStep?.name || fromId)} → ${escapeHtml(toStep?.name || toId)}</div>`;

    const close = () => overlay.remove();
    const addBranch = (label: string) => {
      const result = addBranchConnection(this.#def, fromId, label, toId);
      if (!result.ok) {
        showToast("Bitte einen Namen für den Weg angeben.", { variant: "error" });
        return;
      }
      this.#def = result.def;
      close();
      this.#render();
    };

    // Schritte mit Ergebnis-Wegen (Wenn/Verteiler/Freigabe): die Wege,
    // die der Schritt WIRKLICH liefert, als Knöpfe — ein frei getippter,
    // nie gelieferter Name würde den Ablauf an dieser Stelle still enden
    // lassen.
    if (labels.length) {
      const hint = document.createElement("div");
      hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:6px;";
      hint.textContent = "Welcher Weg führt hierher?";
      modal.appendChild(hint);
      for (const l of labels) {
        const b = document.createElement("button");
        b.className = used.has(l) ? "" : "omp-btn-primary";
        b.style.cssText = "display:block;width:100%;margin-bottom:4px;text-align:left;";
        b.textContent = decisionLabel(l) + (used.has(l) ? " — ersetzt bestehende Verbindung" : "");
        b.setAttribute("data-branch-label", l);
        b.addEventListener("click", () => addBranch(l));
        modal.appendChild(b);
      }
    }

    const nextBtn = document.createElement("button");
    nextBtn.className = labels.length ? "" : "omp-btn-primary";
    nextBtn.style.cssText = "display:block;width:100%;margin-top:6px;text-align:left;";
    nextBtn.setAttribute("data-role", "edge-next");
    nextBtn.textContent = labels.length ? "Immer (unabhängig vom Ergebnis)" : "Danach weiter mit diesem Schritt";
    nextBtn.addEventListener("click", () => {
      const result = addNextConnection(this.#def, fromId, toId);
      if (!result.ok) showToast("Diese Verbindung besteht bereits.", { variant: "error" });
      else this.#def = result.def;
      close();
      this.#render();
    });
    modal.appendChild(nextBtn);

    const adv = document.createElement("details");
    adv.style.cssText = "margin-top:10px;";
    const sum = document.createElement("summary");
    sum.style.cssText = "cursor:pointer;color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    sum.textContent = "Erweitert: eigener Weg-Name";
    adv.appendChild(sum);
    const branchRow = document.createElement("div");
    branchRow.style.cssText = "display:flex;gap:6px;margin-top:6px;";
    const labelInput = document.createElement("input");
    labelInput.placeholder = "Weg-Name";
    labelInput.style.cssText = "flex:1;";
    const branchBtn = document.createElement("button");
    branchBtn.textContent = "Verbinden";
    branchBtn.addEventListener("click", () => addBranch(labelInput.value));
    branchRow.append(labelInput, branchBtn);
    adv.appendChild(branchRow);
    modal.appendChild(adv);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.style.cssText = "display:block;margin-top:12px;";
    cancelBtn.addEventListener("click", close);
    modal.appendChild(cancelBtn);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });
    this.appendChild(overlay);
  }

  // ---- Pointer-Interaktion (1:1 an role-designer.ts gespiegelt, s. Moduldoku) --------------

  #onCanvasPointerDown(ev: PointerEvent) {
    if (this.#drag) return;
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = { kind: "pan", startScreen: this.#screenPoint(ev), startViewport: { ...this.#viewport } };
  }

  #onTilePointerDown(ev: PointerEvent, id: string) {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    this.#drag = { kind: "tile", id, startScreen: this.#screenPoint(ev), startWorld: this.#tilePos(id), moved: false };
  }

  #onOutputAnchorPointerDown(ev: PointerEvent, id: string) {
    ev.stopPropagation();
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = { kind: "connect", fromId: id, fromWorld: this.#outputAnchor(id), currentScreen: this.#screenPoint(ev) };
    this.#render();
  }

  #onPointerMove(ev: PointerEvent) {
    if (!this.#drag) return;
    const current = this.#screenPoint(ev);

    if (this.#drag.kind === "pan") {
      const dx = current.x - this.#drag.startScreen.x;
      const dy = current.y - this.#drag.startScreen.y;
      this.#viewport = { x: this.#drag.startViewport.x + dx, y: this.#drag.startViewport.y + dy, scale: this.#drag.startViewport.scale };
      this.#render();
      return;
    }
    if (this.#drag.kind === "connect") {
      this.#drag = { ...this.#drag, currentScreen: current };
      this.#render();
      return;
    }
    const dxScreen = current.x - this.#drag.startScreen.x;
    const dyScreen = current.y - this.#drag.startScreen.y;
    if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
    this.#drag.moved = true;
    const dxWorld = dxScreen / this.#viewport.scale;
    const dyWorld = dyScreen / this.#viewport.scale;
    this.#positions[this.#drag.id] = { x: this.#drag.startWorld.x + dxWorld, y: this.#drag.startWorld.y + dyWorld };
    this.#render();
  }

  #onPointerUp(ev: PointerEvent) {
    if (this.#drag?.kind === "connect") this.#finishConnect(ev);
    this.#drag = null;
  }

  #finishConnect(ev: PointerEvent) {
    if (this.#drag?.kind !== "connect") return;
    const fromId = this.#drag.fromId;
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const tileEl = target?.closest('[data-role="process-step-tile"]');
    const toId = tileEl?.getAttribute("data-step-id");
    if (!toId || toId === fromId) {
      this.#render();
      return;
    }
    this.#openEdgeKindModal(fromId, toId);
    this.#render();
  }

  #onWheel(ev: WheelEvent) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.#viewport = zoomAt(this.#viewport, this.#screenPoint(ev), factor);
    this.#render();
  }

  #screenPoint(ev: MouseEvent): Point {
    const rect = this.#svg.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
}

customElements.define("omp-process-editor", ProcessEditor);
