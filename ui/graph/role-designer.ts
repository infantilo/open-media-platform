// <omp-role-designer> — grafischer Workflow-Designer (Kapitel 12 Teil 6,
// docs/END-GOAL-FEATURES.md §12.3g, ARCHITECTURE.md §22.3 Punkt 1:
// "technisch eine Variante des bestehenden SVG-Graph-Editors ... aber
// auf Rollen statt konkreten Node-Instanzen ... Derselbe Zeichen-/
// Gruppierungs-Code (ui/graph/*), andere Datenquelle (Workflow-Objekt
// statt Live-Registry) — keine zweite Implementierung").
//
// Bewusst ein eigenes, zweites DOM-bindendes Element statt eines
// "Design-Modus"-Flags in <omp-flow-canvas> selbst: flow-canvas.ts ist
// laut seinem eigenen Kopfkommentar bereits in "reine Koordinaten-/
// Kompatibilitäts-/Gruppenlogik" (geometry.ts/compatibility.ts/
// groups.ts, per `deno test` geprüft, DOM-frei) und einen DOM-/Fetch-/
// EventSource-bindenden Rest aufgeteilt — genau diese reine
// Koordinatenlogik (geometry.ts: Pan/Zoom, Kachel-/Port-Layout) wird
// hier eins zu eins wiederverwendet, "derselbe Code" also für den Teil,
// der tatsächlich geteilt werden kann, ohne die SSE-/Live-Registry-
// gekoppelte flow-canvas.ts (2400+ Zeilen, zentrale Datei für den
// produktiven Betrieb) um einen zweiten, grundverschiedenen
// Datenquellen-Pfad zu erweitern — das Regressionsrisiko dafür wäre
// erheblich größer als der Nutzen einer einzigen gemeinsamen Klasse
// (docs/decisions.md 2026-07-18).
//
// Deckt Rollen + Rolle→Rolle-Verbindungs-Template ab (die eigentliche
// "Graph"-Substanz eines Workflows) — Titel/Beschreibung/Tags/
// Kategorie/Auflösung/Zeitpläne bleiben bewusst beim bestehenden
// Text-Formular (ui/shell/workflows-view.ts, Kapitel 12 Teil 1/6):
// derselbe Workflow lässt sich abwechselnd grafisch (Topologie) und
// per Formular (Metadaten) bearbeiten, keine doppelte Formular-UI für
// bereits vollständig vorhandene Felder.
import {
  defaultPosition,
  HEADER_HEIGHT,
  IDENTITY_VIEWPORT,
  MIN_BODY_HEIGHT,
  NODE_WIDTH,
  type Point,
  screenToWorld,
  type Viewport,
  zoomAt,
} from "./geometry.ts";
import { uniqueRoleName } from "./roles.ts";
import { addConnection, type DraftConnection, type DraftRole, removeRole } from "./role-designer-logic.ts";
import { apiFetch } from "../shell/connection.ts";
import { showToast } from "../kit/omp-toast.ts";

export type { DraftConnection, DraftRole };

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 3;
const TILE_HEIGHT = MIN_BODY_HEIGHT + HEADER_HEIGHT;
const ANCHOR_RADIUS = 6;

interface CatalogEntry {
  type: string;
  label: string;
}

interface HostEntry {
  id: string;
  label: string;
}

// Wire-Format identisch zu workflows.Workflow (nur die für den Designer
// gebrauchten Felder) — s. orchestrator/internal/workflows/types.go.
interface WorkflowDto {
  id: string;
  name: string;
  status: string;
  definition: {
    roles: DraftRole[];
    connections: DraftConnection[];
  };
}

type DesignerDragState =
  | { kind: "pan"; startScreen: Point; startViewport: Viewport; moved: boolean }
  | { kind: "tile"; role: string; startScreen: Point; startWorld: Point; moved: boolean }
  | { kind: "connect"; fromRole: string; fromWorld: Point; currentScreen: Point };

// Kapitel 12 Teil 1 (§12.3c): Bearbeiten einer bestehenden Definition
// ist nur in "stopped"/"paused" erlaubt (workflows.Service.Update) —
// derselbe Zustand, den auch das Text-Formular voraussetzt
// (ui/shell/workflows-view.ts #renderWorkflowRow "isIdle"). Der
// Designer öffnet sich für andere Zustände erst gar nicht (s.
// workflows-view.ts #openRoleDesigner).
export class RoleDesigner extends HTMLElement {
  #workflowId: string | null = null;
  #name = "";
  #roles: DraftRole[] = [];
  #connections: DraftConnection[] = [];
  #positions: Record<string, Point> = {};
  #viewport: Viewport = { ...IDENTITY_VIEWPORT };
  #catalog: CatalogEntry[] = [];
  #hosts: HostEntry[] = [];
  #drag: DesignerDragState | null = null;
  #saving = false;

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #toolbar!: HTMLElement;
  #rubberBand: SVGLineElement | null = null;

  connectedCallback() {
    this.style.cssText = "display:block;position:relative;width:100%;height:100%;box-sizing:border-box;";

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("data-role", "role-designer-canvas");
    svg.style.cssText = "position:absolute;top:40px;left:0;right:0;bottom:0;width:100%;background:#1e1e1e;touch-action:none;";
    const viewportGroup = document.createElementNS(SVG_NS, "g");
    svg.appendChild(viewportGroup);
    this.#svg = svg;
    this.#viewportGroup = viewportGroup;

    svg.addEventListener("pointerdown", (ev) => this.#onCanvasPointerDown(ev));
    svg.addEventListener("pointermove", (ev) => this.#onPointerMove(ev));
    svg.addEventListener("pointerup", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("pointercancel", (ev) => this.#onPointerUp(ev));
    svg.addEventListener("wheel", (ev) => this.#onWheel(ev), { passive: false });

    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-role", "role-designer-toolbar");
    toolbar.style.cssText =
      "position:absolute;top:0;left:0;right:0;height:40px;background:#252525;color:#ddd;" +
      "font-family:var(--omp-font,sans-serif);font-size:12px;display:flex;align-items:center;" +
      "gap:8px;padding:0 8px;box-sizing:border-box;z-index:10;";
    this.#toolbar = toolbar;

    this.append(toolbar, svg);
    this.#loadCatalogAndHosts();
    this.#renderToolbar();
    this.#render();
  }

  // Öffnet den Designer für einen neuen, noch nicht gespeicherten
  // Entwurf (workflowId=null) oder zum Bearbeiten einer bestehenden,
  // bereits gestoppten/pausierten Definition.
  async open(workflowId: string | null) {
    this.#workflowId = workflowId;
    if (workflowId) {
      try {
        const res = await apiFetch(`/api/v1/workflows/${workflowId}`);
        if (res.ok) {
          const wf = (await res.json()) as WorkflowDto;
          this.#name = wf.name;
          this.#roles = wf.definition.roles.map((r) => ({ ...r }));
          this.#connections = wf.definition.connections.map((c) => ({ ...c }));
        }
      } catch {
        showToast("Workflow konnte nicht geladen werden.");
      }
    } else {
      this.#name = "";
      this.#roles = [];
      this.#connections = [];
    }
    this.#positions = {};
    this.#roles.forEach((r, i) => {
      this.#positions[r.name] = defaultPosition(i);
    });
    this.#renderToolbar();
    this.#render();
  }

  async #loadCatalogAndHosts() {
    try {
      const [catalogRes, hostsRes] = await Promise.all([apiFetch("/api/v1/catalog"), apiFetch("/api/v1/hosts")]);
      if (catalogRes.ok) this.#catalog = await catalogRes.json();
      if (hostsRes.ok) this.#hosts = await hostsRes.json();
      this.#renderToolbar();
    } catch {
      // Katalog/Hosts optional für die Palette — "+ Rolle" bleibt ohne
      // sie funktionslos (leere Auswahl), kein harter Fehler.
    }
  }

  #addRole(nodeType: string, hostId: string) {
    if (!nodeType) return;
    const used = new Set(this.#roles.map((r) => r.name));
    const name = uniqueRoleName(nodeType, used);
    this.#roles.push({ name, nodeType, hostId: hostId || undefined });
    this.#positions[name] = this.#nextDefaultPosition();
    this.#render();
  }

  #nextDefaultPosition(): Point {
    return defaultPosition(this.#roles.length - 1);
  }

  #removeRole(name: string) {
    const result = removeRole(this.#roles, this.#connections, name);
    this.#roles = result.roles;
    this.#connections = result.connections;
    delete this.#positions[name];
    this.#render();
  }

  #removeConnection(index: number) {
    this.#connections = this.#connections.filter((_, i) => i !== index);
    this.#render();
  }

  async #save() {
    const roles = this.#roles.filter((r) => r.name && r.nodeType);
    if (!this.#name || roles.length === 0) {
      showToast("Name und mindestens eine Rolle sind nötig.");
      return;
    }
    const body = {
      name: this.#name,
      definition: { roles, connections: this.#connections },
    };
    this.#saving = true;
    this.#renderToolbar();
    try {
      const res = await apiFetch(this.#workflowId ? `/api/v1/workflows/${this.#workflowId}` : "/api/v1/workflows", {
        method: this.#workflowId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        showToast(`Speichern fehlgeschlagen: ${await res.text()}`);
        return;
      }
      this.dispatchEvent(new CustomEvent("designer-saved", { bubbles: true }));
    } catch (err) {
      showToast(`Speichern fehlgeschlagen: ${err}`);
    } finally {
      this.#saving = false;
      this.#renderToolbar();
    }
  }

  #close() {
    this.dispatchEvent(new CustomEvent("designer-closed", { bubbles: true }));
  }

  // --- Toolbar ---

  #renderToolbar() {
    this.#toolbar.replaceChildren();

    const nameInput = document.createElement("input");
    nameInput.placeholder = "Workflow-Name";
    nameInput.value = this.#name;
    nameInput.style.cssText = "width:180px;";
    nameInput.addEventListener("input", () => {
      this.#name = nameInput.value;
    });
    this.#toolbar.appendChild(nameInput);

    const typeSelect = document.createElement("select");
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "Node-Typ …";
    typeSelect.appendChild(emptyOpt);
    for (const entry of this.#catalog) {
      const opt = document.createElement("option");
      opt.value = entry.type;
      opt.textContent = entry.label;
      typeSelect.appendChild(opt);
    }
    this.#toolbar.appendChild(typeSelect);

    const hostSelect = document.createElement("select");
    const localOpt = document.createElement("option");
    localOpt.value = "";
    localOpt.textContent = "(lokal)";
    hostSelect.appendChild(localOpt);
    for (const host of this.#hosts) {
      const opt = document.createElement("option");
      opt.value = host.id;
      opt.textContent = host.label;
      hostSelect.appendChild(opt);
    }
    this.#toolbar.appendChild(hostSelect);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Rolle";
    addBtn.addEventListener("click", () => {
      this.#addRole(typeSelect.value, hostSelect.value);
      typeSelect.value = "";
      hostSelect.value = "";
    });
    this.#toolbar.appendChild(addBtn);

    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    this.#toolbar.appendChild(spacer);

    const hint = document.createElement("span");
    hint.style.cssText = "color:#999;";
    hint.textContent = "Ziehen: verschieben · vom Kreis rechts zum Kreis links ziehen: verbinden";
    this.#toolbar.appendChild(hint);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = this.#saving ? "Speichert …" : this.#workflowId ? "Speichern" : "Anlegen";
    saveBtn.disabled = this.#saving;
    saveBtn.addEventListener("click", () => this.#save());
    this.#toolbar.appendChild(saveBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Schließen";
    closeBtn.addEventListener("click", () => this.#close());
    this.#toolbar.appendChild(closeBtn);
  }

  // --- Rendering ---

  #render() {
    this.#viewportGroup.replaceChildren();
    this.#viewportGroup.setAttribute("transform", `translate(${this.#viewport.x},${this.#viewport.y}) scale(${this.#viewport.scale})`);

    for (const conn of this.#connections) {
      this.#viewportGroup.appendChild(this.#renderConnectionLine(conn));
    }
    this.#connections.forEach((conn, i) => {
      const marker = this.#renderConnectionDeleteMarker(conn, i);
      if (marker) this.#viewportGroup.appendChild(marker);
    });
    for (const role of this.#roles) {
      this.#viewportGroup.appendChild(this.#renderRoleTile(role));
    }
    if (this.#drag?.kind === "connect") {
      this.#viewportGroup.appendChild(this.#renderRubberBand(this.#drag));
    }
  }

  #tileCenter(name: string): Point {
    const pos = this.#positions[name] ?? { x: 0, y: 0 };
    return { x: pos.x + NODE_WIDTH / 2, y: pos.y + TILE_HEIGHT / 2 };
  }

  #outputAnchor(name: string): Point {
    const pos = this.#positions[name] ?? { x: 0, y: 0 };
    return { x: pos.x + NODE_WIDTH, y: pos.y + TILE_HEIGHT / 2 };
  }

  #inputAnchor(name: string): Point {
    const pos = this.#positions[name] ?? { x: 0, y: 0 };
    return { x: pos.x, y: pos.y + TILE_HEIGHT / 2 };
  }

  #renderConnectionLine(conn: DraftConnection): SVGLineElement {
    const from = this.#outputAnchor(conn.fromRole);
    const to = this.#inputAnchor(conn.toRole);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("data-role", "template-edge");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", "#5b9bd5");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "4 4");
    return line;
  }

  // Kleiner klickbarer "×"-Kreis auf der Kantenmitte zum Entfernen einer
  // Verbindung — beide Rollen müssen noch eine gültige Position haben
  // (sollte immer zutreffen, defensiv geprüft statt anzunehmen).
  #renderConnectionDeleteMarker(conn: DraftConnection, index: number): SVGGElement | null {
    if (!this.#positions[conn.fromRole] || !this.#positions[conn.toRole]) return null;
    const from = this.#outputAnchor(conn.fromRole);
    const to = this.#inputAnchor(conn.toRole);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "template-edge-delete");
    g.setAttribute("transform", `translate(${mid.x},${mid.y})`);
    g.style.cursor = "pointer";

    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("r", "8");
    circle.setAttribute("fill", "#333");
    circle.setAttribute("stroke", "#5b9bd5");
    g.appendChild(circle);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "-3");
    text.setAttribute("y", "4");
    text.setAttribute("fill", "#ddd");
    text.setAttribute("font-size", "11");
    text.textContent = "×";
    g.appendChild(text);

    g.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#removeConnection(index);
    });
    return g;
  }

  #renderRoleTile(role: DraftRole): SVGGElement {
    const pos = this.#positions[role.name] ?? { x: 0, y: 0 };
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "role-tile");
    g.setAttribute("data-role-name", role.name);
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("width", String(NODE_WIDTH));
    body.setAttribute("height", String(TILE_HEIGHT));
    body.setAttribute("rx", "4");
    body.setAttribute("fill", "#2a2a2a");
    body.setAttribute("stroke", "#5b9bd5");
    body.setAttribute("stroke-width", "2");
    body.setAttribute("stroke-dasharray", "6 3");
    body.style.cursor = "move";
    body.addEventListener("pointerdown", (ev) => this.#onTilePointerDown(ev, role.name));
    g.appendChild(body);

    const nameText = document.createElementNS(SVG_NS, "text");
    nameText.setAttribute("x", "8");
    nameText.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    nameText.setAttribute("fill", "#f0f0f0");
    nameText.setAttribute("font-size", "12");
    nameText.textContent = role.name;
    nameText.style.pointerEvents = "none";
    g.appendChild(nameText);

    const typeText = document.createElementNS(SVG_NS, "text");
    typeText.setAttribute("x", "8");
    typeText.setAttribute("y", String(HEADER_HEIGHT + 16));
    typeText.setAttribute("fill", "#999");
    typeText.setAttribute("font-size", "11");
    typeText.textContent = role.nodeType + (role.hostId ? ` @ ${role.hostId}` : "");
    typeText.style.pointerEvents = "none";
    g.appendChild(typeText);

    const removeBtn = document.createElementNS(SVG_NS, "text");
    removeBtn.setAttribute("data-role", "role-tile-remove");
    removeBtn.setAttribute("x", String(NODE_WIDTH - 14));
    removeBtn.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
    removeBtn.setAttribute("fill", "#e57373");
    removeBtn.setAttribute("font-size", "13");
    removeBtn.textContent = "×";
    removeBtn.style.cursor = "pointer";
    removeBtn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#removeRole(role.name);
    });
    g.appendChild(removeBtn);

    const inputAnchor = document.createElementNS(SVG_NS, "circle");
    inputAnchor.setAttribute("data-role", "role-input-anchor");
    inputAnchor.setAttribute("cx", "0");
    inputAnchor.setAttribute("cy", String(TILE_HEIGHT / 2));
    inputAnchor.setAttribute("r", String(ANCHOR_RADIUS));
    inputAnchor.setAttribute("fill", "#1e1e1e");
    inputAnchor.setAttribute("stroke", "#5b9bd5");
    inputAnchor.setAttribute("stroke-width", "2");
    g.appendChild(inputAnchor);

    const outputAnchor = document.createElementNS(SVG_NS, "circle");
    outputAnchor.setAttribute("data-role", "role-output-anchor");
    outputAnchor.setAttribute("cx", String(NODE_WIDTH));
    outputAnchor.setAttribute("cy", String(TILE_HEIGHT / 2));
    outputAnchor.setAttribute("r", String(ANCHOR_RADIUS));
    outputAnchor.setAttribute("fill", "#1e1e1e");
    outputAnchor.setAttribute("stroke", "#5b9bd5");
    outputAnchor.setAttribute("stroke-width", "2");
    outputAnchor.style.cursor = "crosshair";
    outputAnchor.addEventListener("pointerdown", (ev) => this.#onOutputAnchorPointerDown(ev, role.name));
    g.appendChild(outputAnchor);

    return g;
  }

  #renderRubberBand(drag: Extract<DesignerDragState, { kind: "connect" }>): SVGLineElement {
    if (!this.#rubberBand) {
      this.#rubberBand = document.createElementNS(SVG_NS, "line") as SVGLineElement;
      this.#rubberBand.setAttribute("data-role", "rubber-band");
      this.#rubberBand.setAttribute("stroke", "#5b9bd5");
      this.#rubberBand.setAttribute("stroke-width", "2");
      this.#rubberBand.setAttribute("stroke-dasharray", "2 2");
      // Per Live-Test gefunden: ohne dies liegt die Linie direkt über dem
      // Ziel-Anker (ihr Endpunkt IST der Mauszeiger), und
      // document.elementFromPoint() in #finishConnect trifft dann die
      // Linie statt den darunterliegenden Input-Anker — die Verbindung
      // scheitert lautlos genau am Zielpunkt. pointer-events:none nimmt
      // die rein dekorative Vorschau-Linie aus dem Hit-Test heraus.
      this.#rubberBand.style.pointerEvents = "none";
    }
    const currentWorld = screenToWorld(drag.currentScreen, this.#viewport);
    this.#rubberBand.setAttribute("x1", String(drag.fromWorld.x));
    this.#rubberBand.setAttribute("y1", String(drag.fromWorld.y));
    this.#rubberBand.setAttribute("x2", String(currentWorld.x));
    this.#rubberBand.setAttribute("y2", String(currentWorld.y));
    return this.#rubberBand;
  }

  // --- Pointer-Interaktion (spiegelt flow-canvas.ts' Pan/Zoom/Drag-
  // Muster, s. Kopfkommentar zur Begründung, warum das hier eine
  // eigene, kleinere Kopie statt einer geteilten Basisklasse ist:
  // die Zustandsmaschine (DragState) unterscheidet sich genug — kein
  // "select"/"group"-Fall, dafür fromRole statt fromPortId — dass eine
  // gemeinsame Basisklasse mehr Abstraktionsaufwand als Ersparnis
  // bedeutet hätte für nur zwei Nutzer dieser Logik.) ---

  #onCanvasPointerDown(ev: PointerEvent) {
    if (this.#drag) return;
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = { kind: "pan", startScreen: this.#screenPoint(ev), startViewport: { ...this.#viewport }, moved: false };
  }

  #onTilePointerDown(ev: PointerEvent, roleName: string) {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const startWorld = this.#positions[roleName] ?? { x: 0, y: 0 };
    this.#drag = { kind: "tile", role: roleName, startScreen: this.#screenPoint(ev), startWorld, moved: false };
  }

  #onOutputAnchorPointerDown(ev: PointerEvent, roleName: string) {
    ev.stopPropagation();
    this.#svg.setPointerCapture(ev.pointerId);
    this.#drag = {
      kind: "connect",
      fromRole: roleName,
      fromWorld: this.#outputAnchor(roleName),
      currentScreen: this.#screenPoint(ev),
    };
    this.#render();
  }

  #onPointerMove(ev: PointerEvent) {
    if (!this.#drag) return;
    const current = this.#screenPoint(ev);

    if (this.#drag.kind === "pan") {
      const dx = current.x - this.#drag.startScreen.x;
      const dy = current.y - this.#drag.startScreen.y;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) this.#drag.moved = true;
      this.#viewport = { x: this.#drag.startViewport.x + dx, y: this.#drag.startViewport.y + dy, scale: this.#drag.startViewport.scale };
      this.#render();
      return;
    }

    if (this.#drag.kind === "connect") {
      this.#drag = { ...this.#drag, currentScreen: current };
      this.#render();
      return;
    }

    // kind === "tile"
    const dxScreen = current.x - this.#drag.startScreen.x;
    const dyScreen = current.y - this.#drag.startScreen.y;
    if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
    this.#drag.moved = true;
    const dxWorld = dxScreen / this.#viewport.scale;
    const dyWorld = dyScreen / this.#viewport.scale;
    this.#positions[this.#drag.role] = { x: this.#drag.startWorld.x + dxWorld, y: this.#drag.startWorld.y + dyWorld };
    this.#render();
  }

  #onPointerUp(ev: PointerEvent) {
    if (this.#drag?.kind === "connect") {
      this.#finishConnect(ev);
    }
    this.#drag = null;
  }

  #finishConnect(ev: PointerEvent) {
    if (this.#drag?.kind !== "connect") return;
    const fromRole = this.#drag.fromRole;
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const anchorEl = target?.closest('[data-role="role-input-anchor"]');
    if (!anchorEl) {
      this.#render();
      return;
    }
    const tileEl = anchorEl.closest('[data-role="role-tile"]');
    const toRole = tileEl?.getAttribute("data-role-name");
    if (!toRole) {
      this.#render();
      return;
    }
    const result = addConnection(this.#connections, fromRole, toRole);
    if (!result.ok) {
      showToast(fromRole === toRole ? "Eine Rolle kann sich nicht selbst verbinden." : "Diese Verbindung besteht bereits.");
    }
    this.#connections = result.connections;
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

customElements.define("omp-role-designer", RoleDesigner);
