// <omp-workflows-view> — Workflow-Bereitstellung & -Verteilung
// (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1): benannte Bündel aus
// Node-Rollen + Rolle→Rolle-Verbindungs-Template anlegen sowie als
// Ganzes starten/stoppen. Bewusst kein eigenes Engineering-Dashboard
// (§17.2 existiert noch nicht) — seit K1-Teil-1 eine Vollansicht im
// App-Bar-Tab "Workflows" (app-shell.ts), vormals ein per Knopf ein-/
// ausblendbares Floating-Panel (gleiches Muster wie hosts-view.ts).
//
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): reagiert
// auf "workflow.updated" (workflows/service.go) statt alle paar Sekunden
// zu pollen — Poll bleibt nur als deutlich langsamerer Reconnect-/
// Fallback-Pfad (POLL_FALLBACK_INTERVAL_MS), falls die SSE-Verbindung
// gerade unterbrochen ist oder ein Event verloren ging ("lost-events",
// s. sse.Hub). Über apiFetch() (connection.ts) statt rohem fetch — ein
// Fehlschlag setzt den geteilten ConnectionMonitor auf "degraded" statt
// still zu bleiben.
import { apiFetch, connectionMonitor } from "./connection.ts";

interface CatalogEntry {
  type: string;
  label: string;
}

interface HostEntry {
  id: string;
  label: string;
}

interface Role {
  name: string;
  nodeType: string;
  hostId?: string;
}

interface Connection {
  fromRole: string;
  toRole: string;
}

// Settings (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c, 2026-07-17):
// pro Workflow konfigurierbare, node-übergreifende Werte — aktuell nur
// die Programm-Auflösung. 0/undefined = Node behält ihren eigenen
// Default (heute meist 640×480 fest verdrahtet).
interface Settings {
  programWidth?: number;
  programHeight?: number;
}

interface Workflow {
  id: string;
  name: string;
  definition: { roles: Role[]; connections: Connection[]; settings?: Settings };
  status: string;
  error?: string;
  runtime?: Record<string, { instanceId: string; nodeId?: string }>;
}

// Fallback/Reconnect-Intervall (S2) — der Normalfall ist SSE-getrieben
// (#onSseMessage), dieser Poll fängt nur eine unterbrochene SSE-
// Verbindung oder ein verpasstes Event auf (lost-events triggert
// ohnehin sofort ein gezieltes #poll(), dieses Intervall ist das
// zusätzliche Sicherheitsnetz für den Fall, dass sogar das
// lost-events-Signal selbst nicht ankam).
const POLL_FALLBACK_INTERVAL_MS = 30000;

// Event-Typen, bei denen die Workflow-Liste neu geladen wird.
const REFRESH_EVENT_TYPES = new Set(["workflow.updated", "lost-events"]);

const STATUS_COLORS: Record<string, string> = {
  stopped: "#999",
  starting: "#e0a020",
  started: "#4caf50",
  stopping: "#e0a020",
  failed: "#e57373",
};

class WorkflowsView extends HTMLElement {
  #pollHandle: number | undefined;
  #catalog: CatalogEntry[] = [];
  #hosts: HostEntry[] = [];
  #workflows: Workflow[] = [];
  #formRoles: Role[] = [{ name: "", nodeType: "", hostId: "" }];
  #formConnections: Connection[] = [];
  #formName = "";
  // Kapitel 15: leer gelassen = kein settings-Feld im Request, Nodes
  // laufen mit ihrem eigenen Default (keine erzwungene Auflösung).
  #formWidth = "";
  #formHeight = "";
  #showForm = false;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    // Sofort synchron rendern (leere Liste, "+ Neu" bereits klickbar) —
    // sonst bliebe das Panel bis zum ersten aufgelösten Poll komplett
    // leer (per CDP-Test gefunden: kurzzeitig kein einziges Kind-Element,
    // "+ Neu" nicht anklickbar).
    this.#render();
    this.#loadStatic();
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (REFRESH_EVENT_TYPES.has(parsed.type)) this.#poll();
  };

  async #loadStatic() {
    try {
      const [catalogRes, hostsRes] = await Promise.all([apiFetch("/api/v1/catalog"), apiFetch("/api/v1/hosts")]);
      if (catalogRes.ok) this.#catalog = await catalogRes.json();
      if (hostsRes.ok) this.#hosts = await hostsRes.json();
      // Neu rendern, falls das Anlegen-Formular schon offen ist, bevor
      // dieser Fetch zurückkam — sonst bliebe die Node-Typ-Auswahl leer
      // (nur die "Node-Typ …"-Leeroption), falls jemand "+ Neu" schneller
      // klickt, als der Katalog-Request braucht (per CDP-Test gefunden).
      if (this.#showForm) this.#render();
    } catch {
      // Katalog/Hosts optional für die Anzeige laufender Workflows —
      // nur das Anlegen neuer Workflows braucht sie tatsächlich.
    }
  }

  async #poll() {
    try {
      const res = await apiFetch("/api/v1/workflows");
      if (!res.ok) return;
      this.#workflows = await res.json();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  async #createWorkflow() {
    const roles = this.#formRoles.filter((r) => r.name && r.nodeType);
    if (!this.#formName || roles.length === 0) return;
    const width = parseInt(this.#formWidth, 10);
    const height = parseInt(this.#formHeight, 10);
    const settings: Settings = {};
    if (Number.isFinite(width) && width > 0) settings.programWidth = width;
    if (Number.isFinite(height) && height > 0) settings.programHeight = height;
    const body = {
      name: this.#formName,
      definition: {
        roles: roles.map((r) => ({ name: r.name, nodeType: r.nodeType, hostId: r.hostId || undefined })),
        connections: this.#formConnections.filter((c) => c.fromRole && c.toRole),
        settings: Object.keys(settings).length > 0 ? settings : undefined,
      },
    };
    const res = await apiFetch("/api/v1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      alert(`Anlegen fehlgeschlagen: ${await res.text()}`);
      return;
    }
    this.#formName = "";
    this.#formRoles = [{ name: "", nodeType: "", hostId: "" }];
    this.#formConnections = [];
    this.#formWidth = "";
    this.#formHeight = "";
    this.#showForm = false;
    await this.#poll();
  }

  async #startWorkflow(id: string) {
    await apiFetch(`/api/v1/workflows/${id}/start`, { method: "POST" });
    await this.#poll();
  }

  async #stopWorkflow(id: string) {
    await apiFetch(`/api/v1/workflows/${id}/stop`, { method: "POST" });
    await this.#poll();
  }

  async #deleteWorkflow(id: string) {
    const res = await apiFetch(`/api/v1/workflows/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert(`Löschen fehlgeschlagen: ${await res.text()}`);
      return;
    }
    await this.#poll();
  }

  #render() {
    this.replaceChildren();

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;";
    heading.innerHTML = `<span>Workflows (${this.#workflows.length})</span>`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showForm ? "Abbrechen" : "+ Neu";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showForm = !this.#showForm;
      this.#render();
    });
    heading.appendChild(newBtn);
    this.appendChild(heading);

    if (this.#showForm) {
      this.appendChild(this.#renderForm());
    }

    if (this.#workflows.length === 0 && !this.#showForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#999;";
      empty.textContent = "Noch kein Workflow angelegt.";
      this.appendChild(empty);
      return;
    }

    for (const wf of this.#workflows) {
      this.appendChild(this.#renderWorkflowRow(wf));
    }
  }

  #renderWorkflowRow(wf: Workflow): HTMLElement {
    const row = document.createElement("div");
    row.setAttribute("data-role", "workflow-row");
    row.setAttribute("data-workflow-id", wf.id);
    row.style.cssText =
      `margin:0 0 6px 0;padding:6px 8px;border-radius:3px;background:rgba(255,255,255,0.04);` +
      `border-left:3px solid ${STATUS_COLORS[wf.status] ?? "#999"};`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.textContent = wf.name;
    title.style.fontWeight = "600";
    const status = document.createElement("span");
    status.setAttribute("data-role", "workflow-status");
    status.textContent = wf.status;
    status.style.cssText = `color:${STATUS_COLORS[wf.status] ?? "#999"};font-size:11px;`;
    header.append(title, status);
    row.appendChild(header);

    const roles = document.createElement("div");
    roles.style.cssText = "color:#999;font-size:11px;margin-top:2px;";
    roles.textContent = wf.definition.roles.map((r) => r.name).join(", ");
    row.appendChild(roles);

    // Kapitel 15: nur anzeigen, wenn tatsächlich gesetzt — die meisten
    // Workflows laufen weiterhin mit den Node-eigenen Defaults.
    const settings = wf.definition.settings;
    if (settings?.programWidth && settings?.programHeight) {
      const res = document.createElement("div");
      res.style.cssText = "color:#999;font-size:11px;margin-top:2px;";
      res.textContent = `${settings.programWidth}×${settings.programHeight}`;
      row.appendChild(res);
    }

    if (wf.error) {
      const err = document.createElement("div");
      err.style.cssText = "color:#e57373;font-size:11px;margin-top:2px;white-space:pre-wrap;";
      err.textContent = wf.error;
      row.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "margin-top:4px;display:flex;gap:6px;";
    const canStart = wf.status === "stopped" || wf.status === "failed";
    const canStop = wf.status === "started" || wf.status === "failed" || wf.status === "starting";

    const startBtn = document.createElement("button");
    startBtn.textContent = "Start";
    startBtn.style.cssText = "font-size:11px;cursor:pointer;";
    startBtn.disabled = !canStart;
    startBtn.addEventListener("click", () => this.#startWorkflow(wf.id));
    actions.appendChild(startBtn);

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop";
    stopBtn.style.cssText = "font-size:11px;cursor:pointer;";
    stopBtn.disabled = !canStop;
    stopBtn.addEventListener("click", () => this.#stopWorkflow(wf.id));
    actions.appendChild(stopBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.style.cssText = "font-size:11px;cursor:pointer;";
    delBtn.disabled = wf.status !== "stopped";
    delBtn.title = wf.status !== "stopped" ? "Erst stoppen, dann löschen" : "";
    delBtn.addEventListener("click", () => this.#deleteWorkflow(wf.id));
    actions.appendChild(delBtn);

    row.appendChild(actions);
    return row;
  }

  #renderForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText = "border:1px solid #333;border-radius:4px;padding:8px;margin-bottom:8px;";

    const nameInput = document.createElement("input");
    nameInput.placeholder = "Workflow-Name";
    nameInput.value = this.#formName;
    nameInput.style.cssText = "width:100%;margin-bottom:6px;box-sizing:border-box;";
    nameInput.addEventListener("input", () => {
      this.#formName = nameInput.value;
    });
    form.appendChild(nameInput);

    const rolesHeading = document.createElement("div");
    rolesHeading.textContent = "Rollen";
    rolesHeading.style.cssText = "color:#999;margin-bottom:2px;";
    form.appendChild(rolesHeading);

    this.#formRoles.forEach((role, i) => {
      const roleRow = document.createElement("div");
      roleRow.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";

      const nameField = document.createElement("input");
      nameField.placeholder = "Rollenname";
      nameField.value = role.name;
      nameField.style.cssText = "width:30%;";
      nameField.addEventListener("input", () => {
        role.name = nameField.value;
      });
      // "change" (nicht "input") löst zusätzlich ein Re-Render aus: die
      // Verbindungs-Dropdowns und der "+ Verbindung"-Button-Disabled-
      // Zustand hängen von den Rollennamen ab (s. #renderForm unten) und
      // würden sonst veraltet bleiben, bis irgendein anderer Klick
      // zufällig neu rendert — "input" bei jedem Tastendruck neu zu
      // rendern würde dagegen den Cursor/Fokus mitten im Tippen verlieren.
      nameField.addEventListener("change", () => this.#render());

      const typeSelect = document.createElement("select");
      typeSelect.style.cssText = "width:35%;";
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "Node-Typ …";
      typeSelect.appendChild(emptyOpt);
      for (const entry of this.#catalog) {
        const opt = document.createElement("option");
        opt.value = entry.type;
        opt.textContent = entry.label;
        if (entry.type === role.nodeType) opt.selected = true;
        typeSelect.appendChild(opt);
      }
      typeSelect.addEventListener("change", () => {
        role.nodeType = typeSelect.value;
      });

      const hostSelect = document.createElement("select");
      hostSelect.style.cssText = "width:25%;";
      const localOpt = document.createElement("option");
      localOpt.value = "";
      localOpt.textContent = "(lokal)";
      hostSelect.appendChild(localOpt);
      for (const host of this.#hosts) {
        const opt = document.createElement("option");
        opt.value = host.id;
        opt.textContent = host.label;
        if (host.id === role.hostId) opt.selected = true;
        hostSelect.appendChild(opt);
      }
      hostSelect.addEventListener("change", () => {
        role.hostId = hostSelect.value;
      });

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "×";
      removeBtn.title = "Rolle entfernen";
      removeBtn.style.cssText = "cursor:pointer;";
      removeBtn.addEventListener("click", () => {
        this.#formRoles.splice(i, 1);
        this.#render();
      });

      roleRow.append(nameField, typeSelect, hostSelect, removeBtn);
      form.appendChild(roleRow);
    });

    const addRoleBtn = document.createElement("button");
    addRoleBtn.textContent = "+ Rolle";
    addRoleBtn.style.cssText = "font-size:11px;cursor:pointer;margin-bottom:8px;";
    addRoleBtn.addEventListener("click", () => {
      this.#formRoles.push({ name: "", nodeType: "", hostId: "" });
      this.#render();
    });
    form.appendChild(addRoleBtn);

    const connHeading = document.createElement("div");
    connHeading.textContent = "Verbindungen (Rolle → Rolle)";
    connHeading.style.cssText = "color:#999;margin-bottom:2px;";
    form.appendChild(connHeading);

    const roleNames = this.#formRoles.map((r) => r.name).filter(Boolean);

    this.#formConnections.forEach((conn, i) => {
      const connRow = document.createElement("div");
      connRow.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;";

      const fromSelect = this.#roleSelect(roleNames, conn.fromRole, (v) => (conn.fromRole = v));
      const arrow = document.createElement("span");
      arrow.textContent = "→";
      const toSelect = this.#roleSelect(roleNames, conn.toRole, (v) => (conn.toRole = v));

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "×";
      removeBtn.style.cssText = "cursor:pointer;";
      removeBtn.addEventListener("click", () => {
        this.#formConnections.splice(i, 1);
        this.#render();
      });

      connRow.append(fromSelect, arrow, toSelect, removeBtn);
      form.appendChild(connRow);
    });

    const addConnBtn = document.createElement("button");
    addConnBtn.textContent = "+ Verbindung";
    addConnBtn.style.cssText = "font-size:11px;cursor:pointer;margin-bottom:8px;";
    addConnBtn.disabled = roleNames.length < 2;
    addConnBtn.addEventListener("click", () => {
      this.#formConnections.push({ fromRole: "", toRole: "" });
      this.#render();
    });
    form.appendChild(addConnBtn);

    // Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c): pro-Workflow
    // Programm-Auflösung, optional — leer gelassen behalten die Nodes
    // ihren eigenen Default.
    const settingsHeading = document.createElement("div");
    settingsHeading.textContent = "Auflösung (optional)";
    settingsHeading.style.cssText = "color:#999;margin-bottom:2px;";
    form.appendChild(settingsHeading);

    const settingsRow = document.createElement("div");
    settingsRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:8px;";
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.placeholder = "Breite (z. B. 1280)";
    widthInput.value = this.#formWidth;
    widthInput.style.cssText = "width:45%;";
    widthInput.addEventListener("input", () => {
      this.#formWidth = widthInput.value;
    });
    const xLabel = document.createElement("span");
    xLabel.textContent = "×";
    xLabel.style.cssText = "color:#999;";
    const heightInput = document.createElement("input");
    heightInput.type = "number";
    heightInput.placeholder = "Höhe (z. B. 720)";
    heightInput.value = this.#formHeight;
    heightInput.style.cssText = "width:45%;";
    heightInput.addEventListener("input", () => {
      this.#formHeight = heightInput.value;
    });
    settingsRow.append(widthInput, xLabel, heightInput);
    form.appendChild(settingsRow);

    const createBtn = document.createElement("button");
    createBtn.textContent = "Anlegen";
    createBtn.style.cssText = "display:block;cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createWorkflow());
    form.appendChild(createBtn);

    return form;
  }

  #roleSelect(roleNames: string[], selected: string, onChange: (v: string) => void): HTMLSelectElement {
    const select = document.createElement("select");
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "Rolle …";
    select.appendChild(emptyOpt);
    for (const name of roleNames) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === selected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }
}

customElements.define("omp-workflows-view", WorkflowsView);
