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
import { ROLE_FORMATS, uniqueRoleName } from "./roles.ts";
import {
  addConnection,
  type DraftConnection,
  type DraftRole,
  removeRole,
  renameRole,
  standbyCandidates,
} from "./role-designer-logic.ts";
import { apiFetch } from "../shell/connection.ts";
import { showToast } from "../kit/omp-toast.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";

export type { DraftConnection, DraftRole };

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 3;
// Nutzerwunsch 2026-07-29: Scaler-Zielformat war im grafischen Designer
// nirgends wählbar (nur im Text-Formular, workflows-view.ts) — die
// Kachel bekommt deshalb eine zusätzliche Zeile für das
// Format-Dropdown, TILE_HEIGHT wächst entsprechend (Anker-/
// Body-Positionen hängen unten bereits dynamisch von TILE_HEIGHT ab,
// keine weiteren Anpassungen nötig).
const FORMAT_ROW_HEIGHT = 22;
// K7 Teil 4 (docs/END-GOAL-FEATURES.md §7.4, Hot-Standby): zweite Zeile
// unter dem Format-Dropdown für "Standby für: <Rolle>" — gleiches Muster
// wie FORMAT_ROW_HEIGHT seinerzeit, TILE_HEIGHT wächst entsprechend.
const STANDBY_ROW_HEIGHT = 22;
// D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2): dritte
// Zeile für die Placement-Eskalation dieser Rolle — gleiches Muster wie
// FORMAT_ROW_HEIGHT/STANDBY_ROW_HEIGHT.
const PLACEMENT_ROW_HEIGHT = 22;
// Nutzerfund 2026-08-13 ("Rollen-Editor muss intuitiver werden"): der
// Host war bisher nur beim Anlegen einer Rolle über die Toolbar wählbar
// (Text "nodeType @ hostId" danach nur noch statisch angezeigt) — vierte
// Zeile macht ihn nachträglich änderbar, gleiches Baumuster wie
// FORMAT_ROW_HEIGHT.
const HOST_ROW_HEIGHT = 22;
const TILE_HEIGHT =
  MIN_BODY_HEIGHT + HEADER_HEIGHT + HOST_ROW_HEIGHT + FORMAT_ROW_HEIGHT + STANDBY_ROW_HEIGHT + PLACEMENT_ROW_HEIGHT;
// Nutzerfund 2026-08-13: 6px-Anker waren ein zu kleines, präzisions-
// abhängiges Ziel zum Verbinden — auf 9px vergrößert (weiterhin klein
// genug, um bei TILE_HEIGHT nicht zu dominieren).
const ANCHOR_RADIUS = 9;

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
  // Nutzerwunsch 2026-07-30 ("sprechender Name" je Service/Stream, s.
  // `renameRole`-Doku in role-designer-logic.ts): welche Kachel gerade
  // per Doppelklick auf ihren Namen im Umbenennen-Modus ist (Textfeld
  // statt statischem `<text>`) — nur eine gleichzeitig, `#render()`
  // baut bei jeder Mutation ohnehin alle Kacheln neu auf.
  #editingRoleName: string | null = null;

  #svg!: SVGSVGElement;
  #viewportGroup!: SVGGElement;
  #toolbar!: HTMLElement;
  #rubberBand: SVGLineElement | null = null;

  connectedCallback() {
    this.style.cssText = "display:block;position:relative;width:100%;height:100%;box-sizing:border-box;";

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("data-role", "role-designer-canvas");
    // `height:100%` explizit setzen, nicht nur `top`/`bottom`: SVG ist ein
    // "replaced element" — dessen `auto`-Höhe wird bei `position:absolute`
    // NICHT aus `top`+`bottom` berechnet (das gilt nur für Nicht-Replaced-
    // Elemente, CSS2.1 §10.6.4 vs. §10.6.5), sondern fällt ohne explizite
    // Höhe auf die UA-Standardgröße für Replaced-Elemente zurück (300×150,
    // live per CDP gemessen: exakt 150px unabhängig von der Fenstergröße).
    // Rollen-Kacheln in einer zweiten/weiteren Zeile (ab `translate(x,200)`)
    // lagen dadurch zwar sichtbar (SVG `overflow:visible`), aber außerhalb
    // der eigentlichen Hit-Test-Box des Canvas — `document.elementFromPoint`
    // (in `#finishConnect`) traf dort nie den Anker, jede Verbindung zu/von
    // einer zweiten Zeile ging beim Speichern verloren (Bug-Report: Viewer
    // ohne Vorschau, weil PGM→Viewer nie tatsächlich gezogen werden konnte).
    svg.style.cssText = "position:absolute;top:40px;left:0;right:0;width:100%;height:calc(100% - 40px);background:#1e1e1e;touch-action:none;";
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

  // Nutzerfund 2026-08-13 ("Rollen-Editor muss intuitiver werden"): das
  // Entfernen einer Rolle hatte bisher KEINE Bestätigung, obwohl es
  // still ihre Verbindungen UND jede Standby-Zuordnung darauf mitreißt
  // (s. removeRole-Doku, role-designer-logic.ts) — ein einzelner
  // Fehlklick auf das kleine "×" konnte unbemerkt Verkabelung verlieren.
  // Nachricht nennt den tatsächlichen Umfang des Verlusts, statt immer
  // pauschal zu warnen (eine isolierte Rolle ohne Verbindungen/Standby-
  // Bezug braucht keine dramatische Formulierung).
  async #removeRole(name: string) {
    const hasConnections = this.#connections.some((c) => c.fromRole === name || c.toRole === name);
    const hasStandbyRef = this.#roles.some((r) => r.standbyFor === name);
    let message = `Rolle „${name}" wirklich entfernen?`;
    if (hasConnections || hasStandbyRef) {
      const losses = [hasConnections && "ihre Verbindungen", hasStandbyRef && "eine Standby-Zuordnung darauf"]
        .filter((x): x is string => !!x)
        .join(" und ");
      message = `Rolle „${name}" wirklich entfernen? Dabei gehen auch ${losses} verloren.`;
    }
    if (!(await confirmDialog(message, { confirmLabel: "Entfernen" }))) return;
    const result = removeRole(this.#roles, this.#connections, name);
    this.#roles = result.roles;
    this.#connections = result.connections;
    delete this.#positions[name];
    this.#render();
  }

  #renameRole(oldName: string, newName: string) {
    const result = renameRole(this.#roles, this.#connections, oldName, newName);
    this.#editingRoleName = null;
    if (!result.ok) {
      if (newName.trim() && newName.trim() !== oldName) {
        showToast(`Name "${newName.trim()}" ist schon vergeben oder ungültig.`);
      }
      this.#render();
      return;
    }
    this.#roles = result.roles;
    this.#connections = result.connections;
    if (this.#positions[oldName]) {
      this.#positions[newName.trim()] = this.#positions[oldName];
      delete this.#positions[oldName];
    }
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

    const hostSelect = document.createElement("select");
    hostSelect.title = "Ziel-Host für die nächste hinzugefügte Rolle.";
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

    // Nutzerfund 2026-08-13 ("Rollen-Editor muss intuitiver werden"):
    // vorher zwei getrennte Schritte (Typ wählen, dann extra auf
    // "+ Rolle" klicken) für dieselbe eine Absicht — die Typ-Auswahl
    // legt die Rolle jetzt direkt an (change feuert erst bei
    // abgeschlossener Auswahl, nicht bei jedem Pfeiltasten-Durchlauf
    // innerhalb der Liste, also kein Risiko für versehentliches Anlegen
    // beim reinen Durchblättern). Host bleibt ein separates Feld
    // (globale Voreinstellung für die nächste Rolle, gleiches Muster
    // wie die Export-Checkbox in workflows-view.ts), weil er sich
    // seltener ändert als der Typ.
    const typeSelect = document.createElement("select");
    typeSelect.title = "Node-Typ wählen, um sofort eine neue Rolle dieses Typs anzulegen.";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "+ Rolle: Node-Typ wählen …";
    typeSelect.appendChild(emptyOpt);
    // Nutzerwunsch 2026-07-28: alphabetisch statt Katalog-Dateireihenfolge.
    const sortedCatalog = this.#catalog.slice().sort((a, b) => a.label.localeCompare(b.label));
    for (const entry of sortedCatalog) {
      const opt = document.createElement("option");
      opt.value = entry.type;
      opt.textContent = entry.label;
      typeSelect.appendChild(opt);
    }
    typeSelect.addEventListener("change", () => {
      if (!typeSelect.value) return;
      this.#addRole(typeSelect.value, hostSelect.value);
      typeSelect.value = "";
    });
    this.#toolbar.appendChild(typeSelect);

    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    this.#toolbar.appendChild(spacer);

    const hint = document.createElement("span");
    hint.style.cssText = "color:#999;";
    hint.textContent =
      "Ziehen: verschieben · vom Kreis rechts zum Kreis links ziehen: verbinden · " +
      "Kante oder ✕ anklicken: entfernen · ✎ oder Doppelklick auf den Namen: umbenennen";
    this.#toolbar.appendChild(hint);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = this.#saving ? "Speichert …" : this.#workflowId ? "Speichern" : "Anlegen";
    saveBtn.className = "omp-btn-primary";
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

    this.#connections.forEach((conn, i) => {
      this.#viewportGroup.appendChild(this.#renderConnectionLine(conn, i));
    });
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

  // Nutzerfund 2026-08-13 ("Rollen-Editor muss intuitiver werden"):
  // vorher nur über die winzige 8px-"×"-Blase auf der exakten
  // Kantenmitte löschbar (#renderConnectionDeleteMarker, bleibt als
  // präzises Ziel zusätzlich bestehen) — jetzt zusätzlich über die
  // gesamte sichtbare Linie klickbar, per unsichtbarem, breiterem
  // "Hit-Strich" darunter (gleiches Muster wie ein üblicher SVG-
  // Klickziel-Trick: ein breiter, transparenter Strich fängt den Klick,
  // der schmale sichtbare bleibt optisch unverändert). Hover hebt die
  // Linie hervor, damit klar ist, dass sie interaktiv ist.
  #renderConnectionLine(conn: DraftConnection, index: number): SVGGElement {
    const from = this.#outputAnchor(conn.fromRole);
    const to = this.#inputAnchor(conn.toRole);

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-role", "template-edge-group");

    const hitLine = document.createElementNS(SVG_NS, "line");
    hitLine.setAttribute("x1", String(from.x));
    hitLine.setAttribute("y1", String(from.y));
    hitLine.setAttribute("x2", String(to.x));
    hitLine.setAttribute("y2", String(to.y));
    hitLine.setAttribute("stroke", "transparent");
    hitLine.setAttribute("stroke-width", "14");
    hitLine.style.cursor = "pointer";

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("data-role", "template-edge");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", "#5b9bd5");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "4 4");
    line.style.pointerEvents = "none";

    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${conn.fromRole} → ${conn.toRole} — anklicken zum Entfernen`;
    hitLine.appendChild(title);

    hitLine.addEventListener("pointerenter", () => line.setAttribute("stroke", "#8ec1ea"));
    hitLine.addEventListener("pointerleave", () => line.setAttribute("stroke", "#5b9bd5"));
    hitLine.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#removeConnection(index);
    });

    g.appendChild(hitLine);
    g.appendChild(line);
    return g;
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

  // Textfeld-Ersatz für die Namens-`<text>` einer Kachel im
  // Umbenennen-Modus (`#editingRoleName`) — gleiches `foreignObject`-
  // Muster wie das Format-`<select>` weiter unten.
  #renderRoleNameEditor(oldName: string): SVGForeignObjectElement {
    const editObject = document.createElementNS(SVG_NS, "foreignObject") as SVGForeignObjectElement;
    editObject.setAttribute("x", "6");
    editObject.setAttribute("y", "2");
    editObject.setAttribute("width", String(NODE_WIDTH - 26));
    editObject.setAttribute("height", String(HEADER_HEIGHT - 4));
    editObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.style.cssText =
      "width:100%;height:100%;box-sizing:border-box;font-size:12px;font-family:inherit;" +
      "background:#1e1e1e;color:#f0f0f0;border:1px solid #5b9bd5;border-radius:2px;padding:0 3px;";

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      this.#renameRole(oldName, input.value);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.#editingRoleName = null;
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
    editObject.appendChild(input);
    // `#render()` hängt das Element frisch ein — Fokus erst nach dem
    // eigentlichen DOM-Insert möglich (`g.appendChild` im Aufrufer läuft
    // synchron danach), ein Mikrotask reicht.
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return editObject;
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

    if (this.#editingRoleName === role.name) {
      g.appendChild(this.#renderRoleNameEditor(role.name));
    } else {
      const nameText = document.createElementNS(SVG_NS, "text");
      nameText.setAttribute("data-role", "role-tile-name");
      nameText.setAttribute("x", "8");
      nameText.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      nameText.setAttribute("fill", "#f0f0f0");
      nameText.setAttribute("font-size", "12");
      nameText.textContent = role.name;
      nameText.style.cursor = "text";
      // Muss Pointer-Events selbst fangen (dblclick zum Umbenennen) —
      // dafür wie bei `removeBtn`/`formatSelect` explizit stoppen, sonst
      // bubbelt derselbe Klick bis zum `<svg>` durch und startet
      // zusätzlich `#onCanvasPointerDown`s Canvas-Pan.
      nameText.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      nameText.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.#editingRoleName = role.name;
        this.#render();
      });
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent =
        "Doppelklick zum Umbenennen — dieser Name erscheint als Sender-/Crosspoint-Label (Nutzerwunsch 2026-07-30: sprechende Namen).";
      nameText.appendChild(title);
      g.appendChild(nameText);

      // Nutzerfund 2026-08-13: Doppelklick zum Umbenennen war die
      // EINZIGE Möglichkeit und nirgends sichtbar (nur ein <title>-
      // Tooltip) — ein immer sichtbares Stift-Symbol macht die Funktion
      // entdeckbar, ohne das bestehende Doppelklick-Verhalten zu ändern.
      const renameIcon = document.createElementNS(SVG_NS, "text");
      renameIcon.setAttribute("data-role", "role-tile-rename");
      renameIcon.setAttribute("x", String(NODE_WIDTH - 30));
      renameIcon.setAttribute("y", String(HEADER_HEIGHT / 2 + 4));
      renameIcon.setAttribute("fill", "#999");
      renameIcon.setAttribute("font-size", "11");
      renameIcon.textContent = "✎";
      renameIcon.style.cursor = "pointer";
      renameIcon.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      renameIcon.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#editingRoleName = role.name;
        this.#render();
      });
      const renameTitle = document.createElementNS(SVG_NS, "title");
      renameTitle.textContent = "Umbenennen";
      renameIcon.appendChild(renameTitle);
      g.appendChild(renameIcon);
    }

    const typeText = document.createElementNS(SVG_NS, "text");
    typeText.setAttribute("x", "8");
    typeText.setAttribute("y", String(HEADER_HEIGHT + 16));
    typeText.setAttribute("fill", "#999");
    typeText.setAttribute("font-size", "11");
    typeText.textContent = role.nodeType;
    typeText.style.pointerEvents = "none";
    g.appendChild(typeText);

    // Nutzerfund 2026-08-13: Host nachträglich änderbar (s.
    // HOST_ROW_HEIGHT-Doku) — gleiches foreignObject-Baumuster wie
    // formatSelect/standbySelect/placementSelect unten.
    const hostObject = document.createElementNS(SVG_NS, "foreignObject");
    hostObject.setAttribute("x", "6");
    hostObject.setAttribute("y", String(HEADER_HEIGHT + MIN_BODY_HEIGHT));
    hostObject.setAttribute("width", String(NODE_WIDTH - 12));
    hostObject.setAttribute("height", String(HOST_ROW_HEIGHT));
    hostObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    const hostSelect = document.createElement("select");
    hostSelect.title = "Ziel-Host dieser Rolle.";
    hostSelect.style.cssText =
      "width:100%;font-size:10px;background:#1e1e1e;color:#ddd;border:1px solid #444;box-sizing:border-box;";
    const hostLocalOpt = document.createElement("option");
    hostLocalOpt.value = "";
    hostLocalOpt.textContent = "Host: (lokal)";
    if (!role.hostId) hostLocalOpt.selected = true;
    hostSelect.appendChild(hostLocalOpt);
    for (const host of this.#hosts) {
      const opt = document.createElement("option");
      opt.value = host.id;
      opt.textContent = `Host: ${host.label}`;
      if (host.id === role.hostId) opt.selected = true;
      hostSelect.appendChild(opt);
    }
    // Zeigt einen gesetzten, aber unbekannten hostId ehrlich statt ihn
    // stillschweigend als "(lokal)" darzustellen (z. B. ein inzwischen
    // abgemeldeter Host) — verschwindet automatisch, sobald der Host
    // wieder in `#hosts` auftaucht oder der Nutzer aktiv umschaltet.
    if (role.hostId && !this.#hosts.some((h) => h.id === role.hostId)) {
      const unknownOpt = document.createElement("option");
      unknownOpt.value = role.hostId;
      unknownOpt.textContent = `Host: ${role.hostId} (nicht registriert)`;
      unknownOpt.selected = true;
      hostSelect.appendChild(unknownOpt);
    }
    hostSelect.addEventListener("change", () => {
      role.hostId = hostSelect.value || undefined;
    });
    hostObject.appendChild(hostSelect);
    g.appendChild(hostObject);

    const formatObject = document.createElementNS(SVG_NS, "foreignObject");
    formatObject.setAttribute("x", "6");
    formatObject.setAttribute("y", String(HEADER_HEIGHT + MIN_BODY_HEIGHT + HOST_ROW_HEIGHT));
    formatObject.setAttribute("width", String(NODE_WIDTH - 12));
    formatObject.setAttribute("height", String(FORMAT_ROW_HEIGHT));
    // pointerdown darf nicht bis zum <svg> durchbubbeln — sonst startet
    // ein Klick ins Dropdown stattdessen einen Canvas-Pan (kein Listener
    // auf `g` selbst, nur auf `body`/den Ankern, s. Kopfkommentar zur
    // Pointer-Interaktion unten).
    formatObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    const formatSelect = document.createElement("select");
    formatSelect.title = "Standard-Format dieser Rolle — leer lässt den Node bei seinem eigenen Default.";
    formatSelect.style.cssText =
      "width:100%;font-size:10px;background:#1e1e1e;color:#ddd;border:1px solid #444;box-sizing:border-box;";
    const formatDefaultOpt = document.createElement("option");
    formatDefaultOpt.value = "";
    formatDefaultOpt.textContent = "Format: Node-Standard";
    formatSelect.appendChild(formatDefaultOpt);
    for (const name of ROLE_FORMATS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === role.format) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    formatSelect.addEventListener("change", () => {
      role.format = formatSelect.value || undefined;
    });
    formatObject.appendChild(formatSelect);
    g.appendChild(formatObject);

    // K7 Teil 4 (docs/END-GOAL-FEATURES.md §7.4/§7.7, Hot-Standby):
    // "Standby für: <Rolle>"-Dropdown, gleiches Baumuster wie der
    // Format-Dropdown oben. Kandidatenliste kommt aus standbyCandidates
    // (role-designer-logic.ts, reine Funktion) — nur Rollen desselben
    // NodeTypes ohne bereits bestehende Standby-Bindung, das Backend
    // (workflows.validate) bleibt die eigentliche Durchsetzung.
    const standbyObject = document.createElementNS(SVG_NS, "foreignObject");
    standbyObject.setAttribute("x", "6");
    standbyObject.setAttribute("y", String(HEADER_HEIGHT + MIN_BODY_HEIGHT + HOST_ROW_HEIGHT + FORMAT_ROW_HEIGHT));
    standbyObject.setAttribute("width", String(NODE_WIDTH - 12));
    standbyObject.setAttribute("height", String(STANDBY_ROW_HEIGHT));
    standbyObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    const standbySelect = document.createElement("select");
    standbySelect.title = "Warme Standby-Rolle für eine andere Rolle desselben Node-Typs — übernimmt automatisch, wenn die Primärrolle ausfällt (K7 Teil 4).";
    standbySelect.style.cssText =
      "width:100%;font-size:10px;background:#1e1e1e;color:#ddd;border:1px solid #444;box-sizing:border-box;";
    const standbyNoneOpt = document.createElement("option");
    standbyNoneOpt.value = "";
    standbyNoneOpt.textContent = "Standby für: —";
    standbySelect.appendChild(standbyNoneOpt);
    for (const candidate of standbyCandidates(this.#roles, role)) {
      const opt = document.createElement("option");
      opt.value = candidate.name;
      opt.textContent = `Standby für: ${candidate.name}`;
      if (candidate.name === role.standbyFor) opt.selected = true;
      standbySelect.appendChild(opt);
    }
    standbySelect.addEventListener("change", () => {
      role.standbyFor = standbySelect.value || undefined;
      this.#render();
    });
    standbyObject.appendChild(standbySelect);
    g.appendChild(standbyObject);

    // D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2):
    // Placement-Eskalation bei Host-Überlast — gleiches Baumuster wie
    // Format-/Standby-Dropdown oben. "auto-confirm-window" blendet
    // zusätzlich ein Zahlenfeld für das Bestätigungsfenster (Sekunden)
    // ein, leer = Backend-Default (30s, s. workflows.DefaultConfirmWindowSeconds).
    const placementObject = document.createElementNS(SVG_NS, "foreignObject");
    placementObject.setAttribute("x", "6");
    placementObject.setAttribute(
      "y",
      String(HEADER_HEIGHT + MIN_BODY_HEIGHT + HOST_ROW_HEIGHT + FORMAT_ROW_HEIGHT + STANDBY_ROW_HEIGHT),
    );
    placementObject.setAttribute("width", String(NODE_WIDTH - 12));
    placementObject.setAttribute("height", String(PLACEMENT_ROW_HEIGHT));
    placementObject.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    const placementWrap = document.createElement("div");
    placementWrap.style.cssText = "display:flex;gap:2px;width:100%;box-sizing:border-box;";
    const placementSelect = document.createElement("select");
    placementSelect.title =
      "Placement-Eskalation bei Host-Überlast (D6 Teil 4) — advisory zeigt nur einen Alarm, auto-confirm-window/auto ziehen die Rolle automatisch auf einen gesunden Ausweichhost um.";
    placementSelect.style.cssText =
      "flex:1;min-width:0;font-size:10px;background:#1e1e1e;color:#ddd;border:1px solid #444;box-sizing:border-box;";
    const windowInput = document.createElement("input");
    windowInput.type = "number";
    windowInput.min = "1";
    windowInput.placeholder = "30s";
    windowInput.title = "Bestätigungsfenster in Sekunden, bevor die Migration ohne Eingriff automatisch ausgeführt wird (leer = 30s).";
    windowInput.style.cssText =
      "width:44px;font-size:10px;background:#1e1e1e;color:#ddd;border:1px solid #444;box-sizing:border-box;";
    windowInput.value = role.placement?.confirmWindowSeconds ? String(role.placement.confirmWindowSeconds) : "";
    windowInput.style.display = role.placement?.escalation === "auto-confirm-window" ? "" : "none";
    windowInput.addEventListener("change", () => {
      const n = parseInt(windowInput.value, 10);
      role.placement = {
        escalation: role.placement?.escalation,
        confirmWindowSeconds: Number.isFinite(n) && n > 0 ? n : undefined,
      };
    });
    const placementOptions: Array<[string, string]> = [
      ["", "Placement: advisory"],
      ["auto-confirm-window", "Placement: auto (Bestätigung)"],
      ["auto", "Placement: auto (sofort)"],
    ];
    for (const [value, label] of placementOptions) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === (role.placement?.escalation ?? "")) opt.selected = true;
      placementSelect.appendChild(opt);
    }
    placementSelect.addEventListener("change", () => {
      const escalation = placementSelect.value || undefined;
      role.placement = escalation ? { escalation, confirmWindowSeconds: role.placement?.confirmWindowSeconds } : undefined;
      this.#render();
    });
    placementWrap.appendChild(placementSelect);
    placementWrap.appendChild(windowInput);
    placementObject.appendChild(placementWrap);
    g.appendChild(placementObject);

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
      void this.#removeRole(role.name);
    });
    g.appendChild(removeBtn);

    // Nutzerfund 2026-08-13 ("Rollen-Editor muss intuitiver werden"):
    // während eine Verbindung gezogen wird (this.#drag?.kind==="connect"),
    // zeigt jeder Eingangs-Anker präventiv an, ob ein Drop hier gültig
    // wäre (addConnection() rein lesend aufgerufen, kein Zustand
    // verändert — dieselbe Regel, die #finishConnect ohnehin anwendet,
    // hier nur vorab sichtbar statt erst per Toast nach dem Loslassen).
    const connectDrag = this.#drag?.kind === "connect" ? this.#drag : null;
    const inputValidity = connectDrag ? addConnection(this.#connections, connectDrag.fromRole, role.name).ok : null;

    const inputAnchor = document.createElementNS(SVG_NS, "circle");
    inputAnchor.setAttribute("data-role", "role-input-anchor");
    inputAnchor.setAttribute("cx", "0");
    inputAnchor.setAttribute("cy", String(TILE_HEIGHT / 2));
    inputAnchor.setAttribute("r", String(ANCHOR_RADIUS));
    if (inputValidity === false) {
      inputAnchor.setAttribute("fill", "#1e1e1e");
      inputAnchor.setAttribute("stroke", "#555");
      inputAnchor.style.opacity = "0.4";
    } else if (inputValidity === true) {
      inputAnchor.setAttribute("fill", "#2e7d32");
      inputAnchor.setAttribute("stroke", "#8ec97a");
    } else {
      inputAnchor.setAttribute("fill", "#1e1e1e");
      inputAnchor.setAttribute("stroke", "#5b9bd5");
      inputAnchor.addEventListener("pointerenter", () => inputAnchor.setAttribute("stroke", "#8ec1ea"));
      inputAnchor.addEventListener("pointerleave", () => inputAnchor.setAttribute("stroke", "#5b9bd5"));
    }
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
    outputAnchor.addEventListener("pointerenter", () => outputAnchor.setAttribute("stroke", "#8ec1ea"));
    outputAnchor.addEventListener("pointerleave", () => outputAnchor.setAttribute("stroke", "#5b9bd5"));
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
