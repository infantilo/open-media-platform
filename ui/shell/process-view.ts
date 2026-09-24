// <omp-process-view> — Kapitel 21 Phase 6: UI für die neue Process-
// Engine-Domäne (Definitions/Versions/Executions/HumanTasks, disjunkt
// vom bestehenden Workflow-Tab — s. UMSETZUNG.md §6b/21.2 Namens-
// kollisions-Entscheidung, "Process" ist der Business-Prozess-Schritt-
// Graph, "Workflow" bleibt das Node-Rollen-Deployment-Bündel).
// Konsumiert ausschließlich die in Kapitel 21 Phase 5 Teil 2 gebaute
// HTTP-API (/api/v1/process-*, /api/v1/human-tasks).
//
// Der Schritt-Graph (Definition.steps) wird seit Phase 6 Teil 2 über
// <omp-process-editor> bearbeitet (Nutzerentscheidung 2026-09-22,
// UMSETZUNG.md §6b Entscheidung 3: eigener visueller Editor auf
// ui/graph-Basis, kein Blockly) — ein rohes JSON-<textarea> war Teil 1s
// bewusst dokumentierte Übergangslösung, s. dortiger docs/decisions.md-
// Nachtrag 266, jetzt ersetzt.
import { apiFetch, connectionMonitor } from "./connection.ts";
import { whoami } from "./auth.ts";
import { showToast } from "../kit/omp-toast.ts";
import "../graph/process-editor.ts";
import type { DraftDefinition } from "../graph/process-editor-logic.ts";
import type { ProcessEditor } from "../graph/process-editor.ts";

// Wire-Formate identisch zu internal/process (orchestrator/internal/
// process/types.go) — eigene, lokale Deklaration statt eines Imports,
// gleiches Muster wie jede andere View-Datei in diesem Projekt.
interface ProcessDefinition {
  id: string;
  name: string;
  description?: string;
  category?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // latestVersionStatus (Kapitel 21 UI-Anbindung, Nachtrag 284) — Status
  // der jüngsten Version dieser Definition, "" ohne jede Version. Nur
  // von GET /api/v1/process-definitions befüllt (internal/process.
  // Store.ListDefinitions-Doku).
  latestVersionStatus?: string;
}

interface ProcessVersion {
  id: string;
  processDefinitionId: string;
  versionNumber: number;
  status: "draft" | "published" | "deprecated" | "archived";
  definition: { steps: unknown[]; startStepId: string; triggers?: unknown[] };
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
}

interface ProcessExecution {
  id: string;
  processDefinitionId: string;
  processVersionId: string;
  status: string;
  correlationId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  createdBy: string;
  rowVersion: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface ProcessStepExecution {
  id: string;
  processExecutionId: string;
  stepId: string;
  stepType: string;
  status: string;
  attempt: number;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

interface HumanTask {
  id: string;
  processExecutionId: string;
  title: string;
  description?: string;
  assignee?: string;
  priority?: string;
  status: string;
  decision?: string;
  comment?: string;
  rowVersion: number;
  createdAt: string;
  completedAt?: string;
}

// AssetLink — Wire-Format identisch zu internal/assetlinks.Link
// (Kapitel 21 B10 UI-Anbindung, Nachtrag 284): verknüpft diese
// Execution mit einer AssetVersion aus der Asset-Domäne (omp-asset-
// view.ts) — "input" (gelesen) oder "output" (erzeugt), frei wie im
// Backend (keine Go-Enum).
interface AssetLink {
  id: string;
  processExecutionId: string;
  assetVersionId: string;
  role: string;
  createdAt: string;
}

const EXEC_BADGE: Record<string, string> = {
  completed: "omp-badge-running",
  running: "omp-badge-info",
  pending: "omp-badge-cue",
  waiting: "omp-badge-cue",
  paused: "omp-badge-cue",
  compensating: "omp-badge-cue",
  compensated: "omp-badge-info",
  failed: "omp-badge-error",
  cancelled: "omp-badge-error",
  timed_out: "omp-badge-error",
};

const VERSION_BADGE: Record<string, string> = {
  draft: "omp-badge-cue",
  published: "omp-badge-running",
  deprecated: "omp-badge-info",
  archived: "",
};

const TASK_BADGE: Record<string, string> = {
  pending: "omp-badge-cue",
  claimed: "omp-badge-info",
  approved: "omp-badge-running",
  rejected: "omp-badge-error",
  changes_requested: "omp-badge-error",
  cancelled: "omp-badge-error",
  escalated: "omp-badge-error",
  timed_out: "omp-badge-error",
  delegated: "omp-badge-info",
};

const REFRESH_EVENT_TYPES = new Set(["lost-events"]);
const POLL_FALLBACK_INTERVAL_MS = 15000;

// Sortierkriterien der Prozessliste im linken Seitenpanel (Nutzerwunsch
// 2026-09-24: "durchsuchbar und sortierbar nach name/datum/user/status").
// "status" sortiert nach dem Status der jüngsten Version
// (latestVersionStatus, s. ProcessDefinition-Doku) — eine Definition
// ohne jede Version gilt dabei als "vor draft" (frisch angelegt, noch
// nichts zu tun).
type DefSort = "updated" | "name" | "user" | "status";
const DEF_SORT_LABEL: Record<DefSort, string> = {
  updated: "Zuletzt geändert",
  name: "Name",
  user: "Angelegt von",
  status: "Status",
};
const DEF_STATUS_ORDER = ["", "draft", "published", "deprecated", "archived"];

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

function badge(text: string, cls: string): string {
  return `<span class="omp-badge ${cls}">${escapeHtml(text)}</span>`;
}

class ProcessView extends HTMLElement {
  #definitions: ProcessDefinition[] = [];
  #selectedDefId: string | null = null;
  #versions: ProcessVersion[] = [];
  #executions: ProcessExecution[] = [];
  #selectedExecId: string | null = null;
  #steps: ProcessStepExecution[] = [];
  #execTasks: HumanTask[] = [];
  // Asset-Verknüpfungen (Kapitel 21 B10 UI-Anbindung, Nachtrag 284) —
  // der lokale Lesbarkeits-Cache löst assetVersionId einmalig zu
  // "Titel vN" auf (zwei zusätzliche GET je neuer Verknüpfung, s.
  // #resolveAssetLinkLabels), damit die Liste nicht nur rohe UUIDs
  // zeigt. Bleibt über #selectExecution-Wechsel hinweg bestehen (kleine,
  // harmlose Wiederverwendung bei wiederholt besuchten Executions).
  #assetLinks: AssetLink[] = [];
  #assetLinkLabelCache = new Map<string, string>();
  #showLinkForm = false;
  #linkExecId: string | null = null;
  #linkAssetOptions: { id: string; title: string }[] = [];
  #linkVersionOptions: { id: string; versionNumber: number; status: string }[] = [];
  #linkSelectedAssetId = "";
  #linkSelectedVersionId = "";
  #linkRole: "input" | "output" = "output";
  #myTasks: HumanTask[] = [];
  #username = "";

  #showDefForm = false;
  #showStartForm = false;
  #startVersionId = "";

  // Prozessliste: Suche + Sortierung (Nutzerwunsch 2026-09-24) — rein
  // clientseitig über die bereits geladenen #definitions, kein
  // Server-Roundtrip (gleiche Linie wie asset-view.ts' Filterleiste).
  #defSearch = "";
  #defSort: DefSort = "updated";

  // Gebaut einmalig in #build() statt bei jedem #render() neu erzeugt —
  // sonst verlöre das Suchfeld bei jedem Tastendruck (und beim 15s-
  // Poll) den Fokus, weil ein neues <input>-Element entstünde (gleiches
  // Muster wie asset-view.ts' #listEl/#detailEl-Trennung).
  #built = false;
  #defCountEl!: HTMLElement;
  #defListEl!: HTMLElement;
  #detailEl!: HTMLElement;
  #extrasEl!: HTMLElement;

  #pollHandle: number | undefined;
  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (REFRESH_EVENT_TYPES.has(parsed.type)) void this.#refresh();
  };

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-bg);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    if (!this.#built) this.#build();
    void whoami().then((w) => {
      this.#username = w.username ?? "";
    });
    void this.#refresh();
    this.#pollHandle = window.setInterval(() => void this.#refresh(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  async #refresh() {
    await this.#loadDefinitions();
    if (this.#selectedDefId) await this.#loadVersionsAndExecutions(this.#selectedDefId);
    if (this.#selectedExecId) await this.#loadExecutionDetail(this.#selectedExecId);
    await this.#loadMyTasks();
    // Offenes Formular (neue Definition/Start-Eingabe) nicht per Poll
    // neu aufbauen — #render() erzeugt die Modals leer neu, halb
    // Eingetipptes ginge verloren (Nachtrag 269/270). Die frischen Daten
    // erscheinen mit dem nächsten Render nach dem Schließen.
    if (this.#showDefForm || this.#showStartForm || this.#showLinkForm) return;
    this.#render();
  }

  async #loadDefinitions() {
    try {
      const res = await apiFetch("/api/v1/process-definitions");
      this.#definitions = res.ok ? await res.json() : [];
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  async #loadVersionsAndExecutions(defId: string) {
    try {
      const [vRes, eRes] = await Promise.all([
        apiFetch(`/api/v1/process-definitions/${defId}/versions`),
        apiFetch(`/api/v1/process-executions?processDefinitionId=${defId}`),
      ]);
      this.#versions = vRes.ok ? await vRes.json() : [];
      this.#executions = eRes.ok ? await eRes.json() : [];
    } catch {
      // s.o.
    }
  }

  async #loadExecutionDetail(execId: string) {
    try {
      const [sRes, tRes, lRes] = await Promise.all([
        apiFetch(`/api/v1/process-executions/${execId}/steps`),
        apiFetch(`/api/v1/process-executions/${execId}/human-tasks`),
        apiFetch(`/api/v1/process-executions/${execId}/asset-links`),
      ]);
      this.#steps = sRes.ok ? await sRes.json() : [];
      this.#execTasks = tRes.ok ? await tRes.json() : [];
      this.#assetLinks = lRes.ok ? await lRes.json() : [];
      void this.#resolveAssetLinkLabels();
    } catch {
      // s.o.
    }
  }

  // Löst assetVersionId -> "Titel vN" für die Anzeige auf (zwei GETs je
  // neuer, noch unbekannter Verknüpfung) — best effort: schlägt eine
  // Auflösung fehl (z. B. Asset inzwischen gelöscht), zeigt die Zeile
  // die rohe ID, kein Fehler-Toast für eine reine Anzeige-Hilfe.
  async #resolveAssetLinkLabels() {
    const missing = this.#assetLinks.filter((l) => !this.#assetLinkLabelCache.has(l.assetVersionId));
    if (missing.length === 0) return;
    for (const link of missing) {
      try {
        const vRes = await apiFetch(`/api/v1/asset-versions/${link.assetVersionId}`);
        if (!vRes.ok) continue;
        const version = (await vRes.json()) as { assetId: string; versionNumber: number };
        const aRes = await apiFetch(`/api/v1/assets/${version.assetId}`);
        const title = aRes.ok ? ((await aRes.json()) as { title: string }).title : version.assetId;
        this.#assetLinkLabelCache.set(link.assetVersionId, `${title} v${version.versionNumber}`);
      } catch {
        // s.o.
      }
    }
    this.#render();
  }

  async #loadMyTasks() {
    if (!this.#username) return;
    try {
      const res = await apiFetch(`/api/v1/human-tasks?assignee=${encodeURIComponent(this.#username)}`);
      this.#myTasks = res.ok ? await res.json() : [];
    } catch {
      // s.o.
    }
  }

  #selectDefinition(id: string) {
    this.#selectedDefId = id;
    this.#selectedExecId = null;
    this.#steps = [];
    this.#execTasks = [];
    void this.#loadVersionsAndExecutions(id).then(() => this.#render());
    this.#render();
  }

  #selectExecution(id: string) {
    this.#selectedExecId = id;
    void this.#loadExecutionDetail(id).then(() => this.#render());
    this.#render();
  }

  // ---- Mutations -----------------------------------------------------------------------------

  async #createDefinition(name: string, description: string, category: string) {
    const res = await apiFetch("/api/v1/process-definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, category }),
    });
    if (!res.ok) {
      showToast(`Anlegen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    this.#showDefForm = false;
    await this.#loadDefinitions();
    this.#render();
    showToast("Prozess-Definition angelegt.", { variant: "info" });
  }

  // Öffnet den visuellen Schritt-Graph-Editor als Vollbild-Overlay —
  // gleiches Einhänge-Muster wie workflows-view.ts#openRoleDesigner
  // (der dokumentierte Präzedenzfall für einen ui/graph-basierten
  // Editor außerhalb von flow-canvas.ts): eigenes Element direkt an
  // document.body, kein zusätzliches umschließendes .omp-modal (der
  // Editor bringt seine eigene Vollbild-Toolbar samt Speichern/
  // Abbrechen mit, s. process-editor.ts).
  //
  // base != null: "Bearbeiten" einer bestehenden Version — veröffentlichte
  // Versionen sind unveränderlich (A7), ein Draft hat ebenfalls keinen
  // Update-Endpunkt; Bearbeiten heißt daher immer "neue Draft-Version auf
  // Basis von vN", nie Überschreiben.
  #openVersionEditor(defId: string, base: ProcessVersion | null = null) {
    const editor = document.createElement("omp-process-editor") as ProcessEditor;
    document.body.appendChild(editor);
    editor.open(base ? (base.definition as DraftDefinition) : null);

    const close = () => editor.remove();
    editor.addEventListener("process-editor-cancel", close);
    editor.addEventListener("process-editor-save", () => {
      void this.#createVersion(defId, editor.getDefinition(), editor.getChangeReason(), close);
    });
  }

  async #createVersion(defId: string, definition: DraftDefinition, changeReason: string, onSuccess: () => void) {
    const res = await apiFetch(`/api/v1/process-definitions/${defId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
    if (!res.ok) {
      showToast(`Version anlegen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    onSuccess();
    await this.#loadVersionsAndExecutions(defId);
    this.#render();
    showToast(`Version angelegt${changeReason ? ` (${changeReason})` : ""}.`, { variant: "info" });
  }

  async #versionAction(versionId: string, action: "publish" | "deprecate" | "archive") {
    const res = await apiFetch(`/api/v1/process-versions/${versionId}/${action}`, { method: "POST" });
    if (!res.ok) {
      showToast(`${action} fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    if (this.#selectedDefId) await this.#loadVersionsAndExecutions(this.#selectedDefId);
    this.#render();
  }

  async #startExecution(defId: string, versionId: string, inputText: string) {
    let input: unknown = undefined;
    if (inputText.trim()) {
      try {
        input = JSON.parse(inputText);
      } catch (err) {
        showToast(`Ungültiges Input-JSON: ${err instanceof Error ? err.message : String(err)}`, { variant: "error" });
        return;
      }
    }
    const res = await apiFetch("/api/v1/process-executions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ processDefinitionId: defId, processVersionId: versionId, input }),
    });
    if (!res.ok) {
      showToast(`Start fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    this.#showStartForm = false;
    await this.#loadVersionsAndExecutions(defId);
    this.#render();
    showToast("Execution gestartet.", { variant: "info" });
  }

  async #executionAction(execId: string, action: "cancel" | "pause" | "resume") {
    const res = await apiFetch(`/api/v1/process-executions/${execId}/${action}`, { method: "POST" });
    if (!res.ok) {
      showToast(`${action} fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    if (this.#selectedDefId) await this.#loadVersionsAndExecutions(this.#selectedDefId);
    if (this.#selectedExecId === execId) await this.#loadExecutionDetail(execId);
    this.#render();
  }

  // Öffnet das "Asset verknüpfen"-Formular — lädt die Asset-Liste erst
  // hier (nicht dauerhaft vorgehalten): process-view.ts brauchte bisher
  // nie die Asset-Domäne, ein einmaliger Abruf bei Bedarf bleibt
  // konsistent mit dem Rest der Datei (kein Dauer-Polling einer fremden
  // Domäne).
  async #openLinkForm(execId: string) {
    this.#showLinkForm = true;
    this.#linkExecId = execId;
    this.#linkSelectedAssetId = "";
    this.#linkSelectedVersionId = "";
    this.#linkVersionOptions = [];
    this.#linkRole = "output";
    this.#render();
    try {
      const res = await apiFetch("/api/v1/assets");
      const assets: { id: string; title: string }[] = res.ok ? await res.json() : [];
      this.#linkAssetOptions = assets.map((a) => ({ id: a.id, title: a.title }));
    } catch {
      this.#linkAssetOptions = [];
    }
    this.#render();
  }

  async #selectLinkAsset(assetId: string) {
    this.#linkSelectedAssetId = assetId;
    this.#linkSelectedVersionId = "";
    this.#linkVersionOptions = [];
    this.#render();
    if (!assetId) return;
    try {
      const res = await apiFetch(`/api/v1/assets/${assetId}/versions`);
      this.#linkVersionOptions = res.ok ? await res.json() : [];
    } catch {
      this.#linkVersionOptions = [];
    }
    this.#render();
  }

  async #createAssetLink(execId: string, assetVersionId: string, role: string) {
    const res = await apiFetch(`/api/v1/process-executions/${execId}/asset-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetVersionId, role }),
    });
    if (!res.ok) {
      showToast(`Verknüpfen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    this.#showLinkForm = false;
    this.#linkExecId = null;
    await this.#loadExecutionDetail(execId);
    this.#render();
    showToast("Asset verknüpft.", { variant: "info" });
  }

  async #deleteAssetLink(link: AssetLink) {
    const res = await apiFetch(`/api/v1/asset-links/${link.id}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`Entfernen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    if (this.#selectedExecId) await this.#loadExecutionDetail(this.#selectedExecId);
    this.#render();
  }

  // "Für mich beanspruchen": setzt Assignee (POST .../assign ändert NUR
  // den Assignee, KEINEN Status, s. process.Store.AssignHumanTask-Doku)
  // und transitioniert danach explizit pending -> claimed — zwei
  // Server-Aufrufe für eine Bedienhandlung, weil die Domäne diese beiden
  // Schritte bewusst getrennt hält (Zuweisung ≠ aktive Übernahme).
  async #claimTask(task: HumanTask) {
    if (task.assignee !== this.#username) {
      const assignRes = await apiFetch(`/api/v1/human-tasks/${task.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee: this.#username }),
      });
      if (!assignRes.ok) {
        showToast(`Zuweisen fehlgeschlagen: ${await assignRes.text()}`, { variant: "error" });
        return;
      }
      const updated = (await assignRes.json()) as HumanTask;
      task = updated;
    }
    await this.#completeTask(task.id, task.rowVersion, "claimed", "", "");
  }

  async #completeTask(taskId: string, expectedRowVersion: number, status: string, decision: string, comment: string) {
    const res = await apiFetch(`/api/v1/human-tasks/${taskId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRowVersion, status, decision, comment }),
    });
    if (!res.ok) {
      showToast(`Aktion fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    await this.#loadMyTasks();
    if (this.#selectedExecId) await this.#loadExecutionDetail(this.#selectedExecId);
    this.#render();
  }

  // ---- Rendering -------------------------------------------------------------------------------

  // Einmalig aufgebautes Grundgerüst — Suchfeld/Sortier-Auswahl müssen
  // über #render()-Aufrufe hinweg stabile DOM-Knoten bleiben (Fokus/
  // Tastatureingabe), gleiches Muster wie asset-view.ts' #build()/
  // #listEl/#detailEl.
  #build() {
    this.#built = true;
    const layout = document.createElement("div");
    layout.style.cssText = "display:grid;grid-template-columns:280px 1fr;gap:var(--omp-space-3);height:100%;";

    const col = document.createElement("div");
    col.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-2);min-height:0;overflow-y:auto;";

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
    this.#defCountEl = document.createElement("span");
    this.#defCountEl.className = "omp-h1";
    const newBtn = document.createElement("button");
    newBtn.className = "omp-btn-primary";
    newBtn.textContent = "+ Neu";
    newBtn.addEventListener("click", () => {
      this.#showDefForm = true;
      this.#render();
    });
    heading.append(this.#defCountEl, newBtn);
    col.appendChild(heading);
    col.appendChild(this.#buildDefFilterBar());

    this.#defListEl = document.createElement("div");
    this.#defListEl.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-2);";
    col.appendChild(this.#defListEl);

    this.#detailEl = document.createElement("div");
    this.#detailEl.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-3);min-height:0;overflow-y:auto;";

    layout.append(col, this.#detailEl);
    this.appendChild(layout);

    this.#extrasEl = document.createElement("div");
    this.appendChild(this.#extrasEl);
  }

  // Suche (Name/Kategorie/Beschreibung/Nutzer) + Sortierung — Zielgruppe
  // laut Aufgabenstellung auch Nicht-Techniker, daher ausgeschriebene
  // Sortier-Labels statt Spaltenköpfen zum Anklicken (gleiche Linie wie
  // asset-view.ts' Filterleiste, kein zusätzliches Bedienkonzept).
  #buildDefFilterBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-direction:column;gap:4px;";

    const searchWrap = document.createElement("span");
    searchWrap.className = "omp-search-wrap";
    searchWrap.style.cssText = "display:block;";
    const search = document.createElement("input");
    search.className = "omp-search-input";
    search.type = "search";
    search.placeholder = "Suche (Name, Kategorie, Beschreibung, Nutzer) …";
    search.style.cssText = "width:100%;box-sizing:border-box;";
    search.addEventListener("input", () => {
      this.#defSearch = search.value;
      this.#renderDefinitionList();
    });
    searchWrap.appendChild(search);
    bar.appendChild(searchWrap);

    const sortRow = document.createElement("div");
    sortRow.style.cssText = "display:flex;align-items:center;gap:6px;";
    const sortLabel = document.createElement("span");
    sortLabel.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);white-space:nowrap;";
    sortLabel.textContent = "Sortieren:";
    const sortSelect = document.createElement("select");
    sortSelect.style.cssText = "flex:1;min-width:0;";
    for (const [value, label] of Object.entries(DEF_SORT_LABEL) as [DefSort, string][]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sortSelect.appendChild(opt);
    }
    sortSelect.value = this.#defSort;
    sortSelect.addEventListener("change", () => {
      this.#defSort = sortSelect.value as DefSort;
      this.#renderDefinitionList();
    });
    sortRow.append(sortLabel, sortSelect);
    bar.appendChild(sortRow);

    return bar;
  }

  #filteredSortedDefinitions(): ProcessDefinition[] {
    const q = this.#defSearch.trim().toLowerCase();
    const list = q
      ? this.#definitions.filter(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            (d.category ?? "").toLowerCase().includes(q) ||
            (d.description ?? "").toLowerCase().includes(q) ||
            d.createdBy.toLowerCase().includes(q),
        )
      : [...this.#definitions];

    switch (this.#defSort) {
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "user":
        list.sort((a, b) => a.createdBy.localeCompare(b.createdBy) || a.name.localeCompare(b.name));
        break;
      case "status":
        list.sort((a, b) => {
          const ai = DEF_STATUS_ORDER.indexOf(a.latestVersionStatus ?? "");
          const bi = DEF_STATUS_ORDER.indexOf(b.latestVersionStatus ?? "");
          return ai - bi || a.name.localeCompare(b.name);
        });
        break;
      case "updated":
      default:
        list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
    }
    return list;
  }

  #render() {
    this.#renderDefinitionList();
    this.#detailEl.replaceChildren(this.#renderDetail());

    this.#extrasEl.replaceChildren();
    if (this.#myTasks.length > 0) this.#extrasEl.appendChild(this.#renderMyTasks());
    if (this.#showDefForm) this.#extrasEl.appendChild(this.#renderDefFormModal());
    if (this.#showStartForm && this.#selectedDefId) this.#extrasEl.appendChild(this.#renderStartFormModal(this.#selectedDefId));
    if (this.#showLinkForm && this.#linkExecId) this.#extrasEl.appendChild(this.#renderLinkFormModal(this.#linkExecId));
  }

  #renderDefinitionList() {
    const visible = this.#filteredSortedDefinitions();
    this.#defCountEl.textContent =
      visible.length === this.#definitions.length
        ? `Prozesse (${this.#definitions.length})`
        : `Prozesse (${visible.length} von ${this.#definitions.length})`;

    this.#defListEl.replaceChildren();

    if (this.#definitions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch keine Prozess-Definition angelegt.";
      this.#defListEl.appendChild(empty);
      return;
    }
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Kein Prozess passt zum Filter.";
      this.#defListEl.appendChild(empty);
      return;
    }

    for (const def of visible) {
      const card = document.createElement("div");
      card.className = "omp-card-compact";
      card.style.cssText = "cursor:pointer;" + (def.id === this.#selectedDefId ? "border-color:var(--omp-info);" : "");
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline;">
          <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(def.name)}</span>
          ${def.latestVersionStatus ? badge(def.latestVersionStatus, VERSION_BADGE[def.latestVersionStatus] ?? "") : ""}
        </div>
        ${def.category ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${escapeHtml(def.category)}</div>` : ""}
        ${def.description ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:2px;">${escapeHtml(def.description)}</div>` : ""}
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:2px;">${escapeHtml(def.createdBy)} · ${fmtTime(def.updatedAt)}</div>
      `;
      card.addEventListener("click", () => this.#selectDefinition(def.id));
      this.#defListEl.appendChild(card);
    }
  }

  #renderDetail(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-3);min-height:0;overflow-y:auto;";

    if (!this.#selectedDefId) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Links eine Prozess-Definition auswählen.";
      wrap.appendChild(empty);
      return wrap;
    }

    const def = this.#definitions.find((d) => d.id === this.#selectedDefId);
    if (def) {
      const header = document.createElement("div");
      header.className = "omp-card";
      header.innerHTML = `
        <div class="omp-h1">${escapeHtml(def.name)}</div>
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:4px;">
          Angelegt von ${escapeHtml(def.createdBy)} am ${fmtTime(def.createdAt)}
        </div>
      `;
      wrap.appendChild(header);
    }

    wrap.appendChild(this.#renderVersionsSection());
    wrap.appendChild(this.#renderExecutionsSection());

    if (this.#selectedExecId) {
      wrap.appendChild(this.#renderExecutionDetail());
      wrap.appendChild(this.#renderAssetLinksSection(this.#selectedExecId));
    }

    return wrap;
  }

  #renderVersionsSection(): HTMLElement {
    const section = document.createElement("div");
    section.className = "omp-card";

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    heading.innerHTML = `<span style="font-weight:600;">Versionen (${this.#versions.length})</span>`;
    const newVersionBtn = document.createElement("button");
    newVersionBtn.textContent = "+ Neue Version";
    newVersionBtn.addEventListener("click", () => {
      if (this.#selectedDefId) this.#openVersionEditor(this.#selectedDefId);
    });
    heading.appendChild(newVersionBtn);
    section.appendChild(heading);

    if (this.#versions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch keine Version.";
      section.appendChild(empty);
      return section;
    }

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">#</th><th style="padding:2px 8px;">Status</th>
      <th style="padding:2px 8px;">Start-Schritt</th><th style="padding:2px 8px;">Angelegt</th>
      <th style="padding:2px 8px;"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const v of [...this.#versions].sort((a, b) => b.versionNumber - a.versionNumber)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="padding:2px 8px;">v${v.versionNumber}</td>
        <td style="padding:2px 8px;">${badge(v.status, VERSION_BADGE[v.status] ?? "")}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(v.definition?.startStepId ?? "")}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${fmtTime(v.createdAt)}</td>
      `;
      const actionsTd = document.createElement("td");
      actionsTd.style.cssText = "padding:2px 8px;display:flex;gap:4px;";
      const editBtn = document.createElement("button");
      editBtn.textContent = "Bearbeiten";
      editBtn.title = `Öffnet v${v.versionNumber} im grafischen Editor — Speichern legt eine neue Draft-Version an`;
      editBtn.addEventListener("click", () => {
        if (this.#selectedDefId) this.#openVersionEditor(this.#selectedDefId, v);
      });
      actionsTd.appendChild(editBtn);
      if (v.status === "draft") {
        const publishBtn = document.createElement("button");
        publishBtn.textContent = "Veröffentlichen";
        publishBtn.addEventListener("click", () => void this.#versionAction(v.id, "publish"));
        actionsTd.appendChild(publishBtn);
        const archiveBtn = document.createElement("button");
        archiveBtn.textContent = "Archivieren";
        archiveBtn.addEventListener("click", () => void this.#versionAction(v.id, "archive"));
        actionsTd.appendChild(archiveBtn);
      } else if (v.status === "published") {
        const startBtn = document.createElement("button");
        startBtn.className = "omp-btn-primary";
        startBtn.textContent = "Starten";
        startBtn.addEventListener("click", () => {
          this.#startVersionId = v.id;
          this.#showStartForm = true;
          this.#render();
        });
        actionsTd.appendChild(startBtn);
        const deprecateBtn = document.createElement("button");
        deprecateBtn.textContent = "Deprecaten";
        deprecateBtn.addEventListener("click", () => void this.#versionAction(v.id, "deprecate"));
        actionsTd.appendChild(deprecateBtn);
      } else if (v.status === "deprecated") {
        const archiveBtn = document.createElement("button");
        archiveBtn.textContent = "Archivieren";
        archiveBtn.addEventListener("click", () => void this.#versionAction(v.id, "archive"));
        actionsTd.appendChild(archiveBtn);
      }
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  #renderExecutionsSection(): HTMLElement {
    const section = document.createElement("div");
    section.className = "omp-card";
    section.innerHTML = `<div style="font-weight:600;margin-bottom:var(--omp-space-2);">Executions (${this.#executions.length})</div>`;

    if (this.#executions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch keine Execution.";
      section.appendChild(empty);
      return section;
    }

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">Status</th><th style="padding:2px 8px;">Gestartet</th>
      <th style="padding:2px 8px;">Abgeschlossen</th><th style="padding:2px 8px;"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const e of [...this.#executions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      const tr = document.createElement("tr");
      tr.style.cssText = "cursor:pointer;" + (e.id === this.#selectedExecId ? "background:var(--omp-surface-raised);" : "");
      tr.innerHTML = `
        <td style="padding:2px 8px;">${badge(e.status, EXEC_BADGE[e.status] ?? "")}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${fmtTime(e.startedAt)}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${fmtTime(e.completedAt)}</td>
      `;
      const actionsTd = document.createElement("td");
      actionsTd.style.cssText = "padding:2px 8px;display:flex;gap:4px;";
      if (["pending", "running", "waiting"].includes(e.status)) {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "omp-btn-danger";
        cancelBtn.textContent = "Abbrechen";
        cancelBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.#executionAction(e.id, "cancel");
        });
        actionsTd.appendChild(cancelBtn);
        const pauseBtn = document.createElement("button");
        pauseBtn.textContent = "Pausieren";
        pauseBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.#executionAction(e.id, "pause");
        });
        actionsTd.appendChild(pauseBtn);
      } else if (e.status === "paused") {
        const resumeBtn = document.createElement("button");
        resumeBtn.textContent = "Fortsetzen";
        resumeBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.#executionAction(e.id, "resume");
        });
        actionsTd.appendChild(resumeBtn);
      }
      tr.appendChild(actionsTd);
      tr.addEventListener("click", () => this.#selectExecution(e.id));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  #renderExecutionDetail(): HTMLElement {
    const section = document.createElement("div");
    section.className = "omp-card";
    const exec = this.#executions.find((e) => e.id === this.#selectedExecId);
    section.innerHTML = `<div style="font-weight:600;margin-bottom:var(--omp-space-2);">
      Schritte${exec ? ` — ${badge(exec.status, EXEC_BADGE[exec.status] ?? "")}` : ""}
    </div>`;
    if (exec?.error) {
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "color:var(--omp-error);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);white-space:pre-wrap;";
      errDiv.textContent = exec.error;
      section.appendChild(errDiv);
    }

    const stepsList = document.createElement("div");
    stepsList.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    for (const s of this.#steps) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;padding:2px 4px;border-bottom:1px solid var(--omp-border);";
      row.innerHTML = `
        <span>${escapeHtml(s.stepId)} <span style="color:var(--omp-text-dim);">(${escapeHtml(s.stepType)})</span></span>
        <span>${badge(s.status, EXEC_BADGE[s.status] ?? "")}</span>
      `;
      if (s.error) {
        const errLine = document.createElement("div");
        errLine.style.cssText = "color:var(--omp-error);font-size:var(--omp-font-size-xs);width:100%;white-space:pre-wrap;";
        errLine.textContent = s.error;
        row.appendChild(errLine);
      }
      stepsList.appendChild(row);
    }
    section.appendChild(stepsList);

    if (this.#execTasks.length > 0) {
      const tasksHeading = document.createElement("div");
      tasksHeading.style.cssText = "font-weight:600;margin-top:var(--omp-space-2);margin-bottom:4px;";
      tasksHeading.textContent = "Human Tasks dieser Execution";
      section.appendChild(tasksHeading);
      for (const t of this.#execTasks) {
        section.appendChild(this.#renderTaskRow(t));
      }
    }

    return section;
  }

  // Verknüpfte Assets (Kapitel 21 B10 UI-Anbindung, Nachtrag 284) —
  // eigene Karte statt Teil von #renderExecutionDetail: andere Domäne
  // (internal/assetlinks referenziert internal/asset, nicht internal/
  // process), verdient einen eigenen sichtbaren Abschnitt statt in den
  // Schritten mitzulaufen.
  #renderAssetLinksSection(execId: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "omp-card";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Verknüpfte Assets (${this.#assetLinks.length})</span>`;
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Asset verknüpfen";
    addBtn.addEventListener("click", () => void this.#openLinkForm(execId));
    head.appendChild(addBtn);
    section.appendChild(head);

    if (this.#assetLinks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Keine Asset-Version verknüpft — z. B. eine Datei, die dieser Lauf gelesen oder erzeugt hat.";
      section.appendChild(empty);
      return section;
    }

    for (const link of this.#assetLinks) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--omp-border);gap:8px;";
      const label = this.#assetLinkLabelCache.get(link.assetVersionId) ?? link.assetVersionId;
      const left = document.createElement("span");
      left.innerHTML = `${badge(link.role, link.role === "input" ? "omp-badge-info" : "omp-badge-running")} ${escapeHtml(label)}`;
      const delBtn = document.createElement("button");
      delBtn.textContent = "Entfernen";
      delBtn.addEventListener("click", () => void this.#deleteAssetLink(link));
      row.append(left, delBtn);
      section.appendChild(row);
    }
    return section;
  }

  #renderLinkFormModal(execId: string): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";

    const title = document.createElement("div");
    title.className = "omp-h1";
    title.textContent = "Asset verknüpfen";
    modal.appendChild(title);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:4px 0 var(--omp-space-2);";
    hint.textContent = "Verknüpft eine Asset-Version mit dieser Execution — z. B. eine Datei, die dieser Lauf gelesen (Input) oder erzeugt (Output) hat.";
    modal.appendChild(hint);

    const assetSelect = document.createElement("select");
    assetSelect.style.cssText = "width:100%;margin-bottom:var(--omp-space-2);";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = this.#linkAssetOptions.length ? "– Asset wählen –" : "– lädt … –";
    assetSelect.appendChild(noneOpt);
    for (const a of this.#linkAssetOptions) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.title;
      assetSelect.appendChild(opt);
    }
    assetSelect.value = this.#linkSelectedAssetId;
    assetSelect.addEventListener("change", () => void this.#selectLinkAsset(assetSelect.value));
    modal.appendChild(assetSelect);

    const versionSelect = document.createElement("select");
    versionSelect.style.cssText = "width:100%;margin-bottom:var(--omp-space-2);";
    if (this.#linkVersionOptions.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = this.#linkSelectedAssetId ? "– keine Version vorhanden –" : "– zuerst ein Asset wählen –";
      versionSelect.appendChild(opt);
    } else {
      for (const v of this.#linkVersionOptions) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `v${v.versionNumber} (${v.status})`;
        versionSelect.appendChild(opt);
      }
    }
    versionSelect.value = this.#linkSelectedVersionId;
    versionSelect.addEventListener("change", () => {
      this.#linkSelectedVersionId = versionSelect.value;
    });
    modal.appendChild(versionSelect);

    const roleSelect = document.createElement("select");
    roleSelect.style.cssText = "width:100%;margin-bottom:var(--omp-space-3);";
    const roleOptions: [string, string][] = [
      ["output", "Output — von diesem Lauf erzeugt"],
      ["input", "Input — von diesem Lauf gelesen"],
    ];
    for (const [value, label] of roleOptions) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      roleSelect.appendChild(opt);
    }
    roleSelect.value = this.#linkRole;
    roleSelect.addEventListener("change", () => {
      this.#linkRole = roleSelect.value as "input" | "output";
    });
    modal.appendChild(roleSelect);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => {
      this.#showLinkForm = false;
      this.#linkExecId = null;
      this.#render();
    });
    const saveBtn = document.createElement("button");
    saveBtn.className = "omp-btn-primary";
    saveBtn.textContent = "Verknüpfen";
    saveBtn.addEventListener("click", () => {
      if (!this.#linkSelectedVersionId) {
        showToast("Bitte ein Asset und eine Version wählen.", { variant: "error" });
        return;
      }
      void this.#createAssetLink(execId, this.#linkSelectedVersionId, this.#linkRole);
    });
    actions.append(cancelBtn, saveBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) {
        this.#showLinkForm = false;
        this.#linkExecId = null;
        this.#render();
      }
    });
    return overlay;
  }

  #renderMyTasks(): HTMLElement {
    const section = document.createElement("div");
    section.className = "omp-card";
    section.style.cssText += "margin-top:var(--omp-space-3);";
    section.innerHTML = `<div class="omp-h1" style="margin-bottom:var(--omp-space-2);">Meine Human Tasks (${this.#myTasks.length})</div>`;
    for (const t of this.#myTasks) {
      section.appendChild(this.#renderTaskRow(t));
    }
    return section;
  }

  #renderTaskRow(task: HumanTask): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--omp-border);gap:8px;";

    const info = document.createElement("div");
    info.innerHTML = `
      <div>${escapeHtml(task.title)} ${badge(task.status, TASK_BADGE[task.status] ?? "")}</div>
      <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">
        ${task.assignee ? `Zugewiesen: ${escapeHtml(task.assignee)}` : "Nicht zugewiesen"}
      </div>
    `;
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:4px;flex-shrink:0;";

    if (task.status === "pending") {
      const claimBtn = document.createElement("button");
      claimBtn.className = "omp-btn-primary";
      claimBtn.textContent = "Für mich beanspruchen";
      claimBtn.addEventListener("click", () => void this.#claimTask(task));
      actions.appendChild(claimBtn);
    } else if (task.status === "claimed" && task.assignee === this.#username) {
      const approveBtn = document.createElement("button");
      approveBtn.className = "omp-btn-primary";
      approveBtn.textContent = "Genehmigen";
      approveBtn.addEventListener("click", () => this.#promptDecision(task, "approved"));
      actions.appendChild(approveBtn);
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "omp-btn-danger";
      rejectBtn.textContent = "Ablehnen";
      rejectBtn.addEventListener("click", () => this.#promptDecision(task, "rejected"));
      actions.appendChild(rejectBtn);
      const changesBtn = document.createElement("button");
      changesBtn.textContent = "Änderungen anfordern";
      changesBtn.addEventListener("click", () => this.#promptDecision(task, "changes_requested"));
      actions.appendChild(changesBtn);
    }
    row.appendChild(actions);
    return row;
  }

  // Ein einzeiliger Kommentar-Prompt statt eines eigenen Modals — die
  // Entscheidung selbst (approved/rejected/changes_requested) steht
  // bereits fest (per Button gewählt), nur der optionale Kommentar
  // braucht noch Eingabe. window.confirm/prompt sind hier bewusst
  // pragmatisch statt eines vierten Modal-Typs für eine einzelne
  // Textzeile — gleiche Abwägung wie z. B. admin-view.ts' einfache
  // Lösch-Bestätigungen.
  #promptDecision(task: HumanTask, status: "approved" | "rejected" | "changes_requested") {
    const comment = window.prompt("Kommentar (optional):", "") ?? "";
    void this.#completeTask(task.id, task.rowVersion, status, status, comment);
  }

  #renderDefFormModal(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";

    const title = document.createElement("div");
    title.className = "omp-h1";
    title.textContent = "Neue Prozess-Definition";
    modal.appendChild(title);

    const nameInput = document.createElement("input");
    nameInput.placeholder = "Name";
    nameInput.style.cssText = "width:100%;margin:var(--omp-space-2) 0;box-sizing:border-box;";
    modal.appendChild(nameInput);

    const categoryInput = document.createElement("input");
    categoryInput.placeholder = "Kategorie (optional)";
    categoryInput.style.cssText = "width:100%;margin-bottom:var(--omp-space-2);box-sizing:border-box;";
    modal.appendChild(categoryInput);

    const descInput = document.createElement("textarea");
    descInput.placeholder = "Beschreibung (optional)";
    descInput.rows = 3;
    descInput.style.cssText = "width:100%;margin-bottom:var(--omp-space-3);box-sizing:border-box;resize:vertical;font-family:inherit;";
    modal.appendChild(descInput);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => {
      this.#showDefForm = false;
      this.#render();
    });
    const saveBtn = document.createElement("button");
    saveBtn.className = "omp-btn-primary";
    saveBtn.textContent = "Anlegen";
    saveBtn.addEventListener("click", () => {
      if (!nameInput.value.trim()) {
        showToast("Name ist erforderlich.", { variant: "error" });
        return;
      }
      void this.#createDefinition(nameInput.value.trim(), descInput.value.trim(), categoryInput.value.trim());
    });
    actions.append(cancelBtn, saveBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) {
        this.#showDefForm = false;
        this.#render();
      }
    });
    queueMicrotask(() => nameInput.focus());
    return overlay;
  }

  #renderStartFormModal(defId: string): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = "640px";

    const title = document.createElement("div");
    title.className = "omp-h1";
    title.textContent = "Execution starten";
    modal.appendChild(title);

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:4px 0;";
    hint.textContent = "Input als JSON (optional, leer lassen für kein Input).";
    modal.appendChild(hint);

    const jsonArea = document.createElement("textarea");
    jsonArea.rows = 8;
    jsonArea.style.cssText =
      "width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);" +
      "resize:vertical;margin-bottom:var(--omp-space-3);";
    modal.appendChild(jsonArea);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => {
      this.#showStartForm = false;
      this.#render();
    });
    const startBtn = document.createElement("button");
    startBtn.className = "omp-btn-primary";
    startBtn.textContent = "Starten";
    startBtn.addEventListener("click", () => void this.#startExecution(defId, this.#startVersionId, jsonArea.value));
    actions.append(cancelBtn, startBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) {
        this.#showStartForm = false;
        this.#render();
      }
    });
    return overlay;
  }
}

customElements.define("omp-process-view", ProcessView);
