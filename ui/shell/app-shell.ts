// <omp-app-shell> — Engineering-App-Chrome (END-GOAL-FEATURES.md §1.3b,
// ARCHITECTURE.md §22.1, UMSETZUNG.md K1-Teil-1). Ersetzt die zwei
// Floating-Toggle-Buttons (vormals shell.ts: buildHostsToggle/
// buildWorkflowsToggle) durch eine echte Top-Bar mit Tabs — Hosts/
// Workflows werden von Floating-Panels zu vollwertigen Ansichten
// (Kapitel-10-Entscheidung 2: "Vollansichten mit Tabs", Abweichung von
// der Dokument-Empfehlung "andockbare Panels"). Nur für die Engineering-
// Ansicht gemountet (shell.ts) — Console-Ansicht (§14) bleibt unverändert
// Vollfläche ohne jede Chrome, wie schon vor diesem Schritt.
import "../graph/flow-canvas.ts";
import type { FlowCanvas } from "../graph/flow-canvas.ts";
import "./hosts-view.ts";
import "./workflows-view.ts";
import "./process-view.ts";
import "./asset-view.ts";
import "./instances-view.ts";
import "./alarm-view.ts";
import "./alert-bar.ts";
import "./health-view.ts";
import "./signal-path-view.ts";
import "./scheduler-view.ts";
import "./admin-view.ts";
import { apiFetch, type ConnectionChangeDetail, type ConnectionState, connectionMonitor } from "./connection.ts";
import { whoami } from "./auth.ts";
import { buildLangSelect, getLang, type I18nKey, t, t as tt } from "./i18n.ts";
import { ensureBundle, getModules } from "./modules-registry.ts";
import { insertIndex, mainTabs } from "./modules-logic.ts";

// Kern-Tabs haben feste IDs; Modul-Tabs `mod:<modul>:<tab>` (Kapitel 36.3).
type TabId = string;

interface TabDef {
  id: TabId;
  labelKey?: I18nKey;
  /** Beschriftung eines Modul-Tabs (aus dem Manifest, schon in der aktuellen Sprache). */
  label?: string;
  element: string;
  /** Modul-Tab: ESM-Bundle, das das Element registriert; scheitert das Laden, zeigt der Tab eine Fehlermeldung. */
  bundle?: string;
  bundleError?: string;
}

const BASE_TABS: TabDef[] = [
  { id: "flow", labelKey: "app.tab.flow", element: "omp-flow-canvas" },
  { id: "workflows", labelKey: "app.tab.workflows", element: "omp-workflows-view" },
  // Kapitel 21 Phase 6 Teil 1: Business-Prozess-Engine (Definitions/
  // Versions/Executions/HumanTasks) — disjunkt vom Workflow-Tab, s.
  // UMSETZUNG.md §6b/21.2 Namenskollisions-Entscheidung.
  { id: "process", labelKey: "app.tab.process", element: "omp-process-view" },
  // Kapitel 21 Phase 6 Teil 3: Asset/Content-Domäne (Assets/Lifecycle/
  // Metadaten/Versionen/Representations), direkt neben "Prozesse" —
  // beide Domänen gehören laut Aufgabenstellung eng zusammen.
  { id: "assets", labelKey: "app.tab.assets", element: "omp-asset-view" },
  { id: "hosts", labelKey: "app.tab.hosts", element: "omp-hosts-view" },
  // §17 Teil 2 (docs/END-GOAL-FEATURES.md, 2026-07-19): "Laufende
  // Instanzen"-Tab — baut auf Kapitel 14 (Ressourcenwerte), kein neuer
  // Backend-Konsument.
  { id: "instances", labelKey: "app.tab.instances", element: "omp-instances-view" },
  // §17 Teil 3 (docs/END-GOAL-FEATURES.md, 2026-07-17): genereller
  // Alarm-View, fünfter Tab neben Flow-Editor/Workflows/Hosts/Instanzen.
  { id: "alarms", labelKey: "app.tab.alarms", element: "omp-alarm-view" },
  // Nutzerauftrag 2026-09-14 ("BCP008 Dashboard"): systemweite Fleet-
  // Übersicht über alle BCP-008-fähigen Instanzen gleichzeitig — anders
  // als das bestehende Statuspanel im Flow-Editor (EIN Node, Nachtrag
  // 214), s. ui/shell/health-view.ts.
  { id: "health", labelKey: "app.tab.health", element: "omp-health-view" },
  // Nutzerauftrag 2026-10-07: Signalweg Quelle → Ziel über die IST-
  // Verbindungen, reine Anzeige, s. ui/shell/signal-path-view.ts.
  { id: "signal-path", labelKey: "app.tab.signalPath", element: "omp-signal-path-view" },
  // Nachtrag 97 Folgearbeit (2026-07-27): workflow-übergreifende
  // Zeitplan-Übersicht/-Bearbeitung, sichtbar für alle wie der
  // Workflows-Tab selbst — kein eigenes Client-Gating, das zugrunde
  // liegende PUT /api/v1/workflows/{id} bleibt serverseitig
  // VerbConfigure-gated (schlägt für Nutzer ohne diesen Verb einfach
  // fehl, exakt wie im bestehenden Workflow-Formular).
  { id: "scheduler", labelKey: "app.tab.scheduler", element: "omp-scheduler-view" },
];

// Kapitel 11 Teil 1 (docs/END-GOAL-FEATURES.md §11.4): eigener Tab statt
// Teil von BASE_TABS, weil er nur bei whoami().isAdmin nachträglich
// angehängt wird (admin-Verb ODER Bootstrap-Modus, s. auth_handlers.go:
// handleWhoami) — für alle anderen Nutzer bleibt die Bar unverändert.
const ADMIN_TAB: TabDef = { id: "admin", labelKey: "app.tab.admin", element: "omp-admin-view" };

const PILL_LABEL: Record<ConnectionState, I18nKey> = {
  connected: "app.conn.connected",
  degraded: "app.conn.degraded",
  disconnected: "app.conn.disconnected",
};

const PILL_COLOR: Record<ConnectionState, string> = {
  connected: "var(--omp-preset)",
  degraded: "var(--omp-cue)",
  disconnected: "var(--omp-error)",
};

const TAB_BUTTON_BASE =
  "border:1px solid transparent;border-radius:var(--omp-radius);" +
  "padding:6px 12px;font-size:var(--omp-font-size-sm);font-family:var(--omp-font);cursor:pointer;";

// S6 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "Workflow-Auswahl in
// der App-Bar, Flow-Editor-Filter auf die Nodes des gewählten
// Workflows — globale Sicht bleibt als 'Alle' wählbar"). Nur die für
// die Auswahl-Beschriftung gebrauchten Felder — Wire-Format identisch
// zu workflows.Workflow (orchestrator/internal/workflows/types.go).
interface WorkflowOption {
  id: string;
  name: string;
  definition: { title?: string };
}

// SSE-Ereignisse, bei denen die Workflow-Auswahl neu geladen wird
// (gleiches Muster wie ui/shell/workflows-view.ts REFRESH_EVENT_TYPES).
const WORKFLOW_REFRESH_EVENT_TYPES = new Set(["workflow.updated", "lost-events"]);

class AppShell extends HTMLElement {
  #activeTab: TabId = "flow";
  #tabs: TabDef[] = [...BASE_TABS];
  #lastState: ConnectionState = "connected";
  #tabsWrap!: HTMLElement;
  #pillEl!: HTMLElement;
  #bannerEl!: HTMLElement;
  #contentEl!: HTMLElement;
  #countdownHandle: ReturnType<typeof setInterval> | undefined;
  #onStateChange = (ev: Event) => {
    this.#applyConnectionState((ev as CustomEvent<ConnectionChangeDetail>).detail);
  };
  // S6: Auswahl lebt in der App-Bar (nicht in <omp-flow-canvas> selbst)
  // — die Kachel wird bei jedem Tab-Wechsel neu erzeugt (#switchTab
  // ersetzt sie per replaceChildren), eine dort gehaltene Auswahl ginge
  // sonst bei jedem Verlassen des Flow-Editor-Tabs verloren.
  #workflowFilter: string | null = null;
  #workflowSelect!: HTMLSelectElement;
  // Bug 2: workflows-view.ts feuert dieses Event (bubbles:true) mit der
  // Workflow-ID als detail, wenn der Nutzer dort "Im Flow-Editor
  // bearbeiten" klickt. #switchTab("flow") ersetzt die Tab-Kachel
  // synchron (s. dortige Doku) — enterWorkflowEditScope() ist async und
  // wartet selbst auf frische Daten, hier reicht "fire and forget".
  #onOpenWorkflowInEditor = (ev: Event) => {
    const workflowId = (ev as CustomEvent<string>).detail;
    this.#switchTab("flow");
    const canvas = this.#contentEl.querySelector("omp-flow-canvas") as FlowCanvas | null;
    void canvas?.enterWorkflowEditScope(workflowId);
  };
  // ARCHITECTURE.md §25.1/§25.3 (UMSETZUNG.md D20): flow-canvas.ts feuert
  // dieses Event (bubbles:true), wenn der Nutzer nach einem
  // fehlgeschlagenen IS-05-Connect/Disconnect auf "Diagnose öffnen"
  // klickt — die trace_id steckt bereits im X-OMP-Trace-Id-Response-
  // Header dieses Aufrufs. Gleiches Cross-Tab-Muster wie
  // #onOpenWorkflowInEditor oben. Kein Effekt, falls der Administration-
  // Tab nie gemountet wurde (Nicht-Admin, s. #loadAdminTab) —
  // #switchTab("admin") ist dann ein No-Op, GET /api/v1/logs wäre für
  // diesen Nutzer ohnehin admin-gated abgewiesen worden.
  #onViewTrace = (ev: Event) => {
    const traceId = (ev as CustomEvent<string>).detail;
    this.#switchTab("admin");
    const admin = this.#contentEl.querySelector("omp-admin-view") as (HTMLElement & { showTrace(traceId: string): void }) | null;
    admin?.showTrace(traceId);
  };
  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (WORKFLOW_REFRESH_EVENT_TYPES.has(parsed.type)) void this.#loadWorkflowOptions();
  };

  connectedCallback() {
    this.style.cssText = "display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;";
    this.#buildSkeleton();
    this.#switchTab("flow");
    this.#loadAdminTab();
    void this.#loadModuleTabs();
    void this.#loadWorkflowOptions();
    // Bug 2 (2026-07-24): Einstiegspunkt vom Workflows-Tab in den
    // Flow-Editor-Bearbeiten-Modus (ui/graph/flow-canvas.ts
    // enterWorkflowEditScope) — normale bubbling CustomEvent-Zustellung
    // reicht, da keine Shadow-DOM-Grenze zwischen workflows-view.ts und
    // hier liegt (kein composed:true nötig).
    this.#contentEl.addEventListener("open-workflow-in-editor", this.#onOpenWorkflowInEditor);
    this.#contentEl.addEventListener("omp-view-trace", this.#onViewTrace);

    this.#lastState = connectionMonitor.state;
    connectionMonitor.addEventListener("statechange", this.#onStateChange);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
    connectionMonitor.start();
    this.#applyConnectionState({ state: connectionMonitor.state, nextRetryAt: connectionMonitor.nextRetryAt });
  }

  // Kapitel 11 Teil 1: Administration-Tab erst nachträglich anhängen,
  // sobald whoami() zurück ist — #buildSkeleton() läuft synchron, damit
  // die restliche Bar sofort nutzbar ist (gleicher Grund wie
  // workflows-view.ts' sofortiges #render() vor dem ersten Poll).
  async #loadAdminTab() {
    try {
      const { isAdmin } = await whoami();
      if (!isAdmin || this.#tabs.some((t) => t.id === "admin")) return;
      this.#tabs.push(ADMIN_TAB);
      const btn = this.#buildTabButton(ADMIN_TAB);
      this.#tabsWrap.appendChild(btn);
      this.#styleTabButton(btn);
    } catch {
      // Kein Administration-Tab ohne bestätigtes isAdmin — sicherer
      // Default, kein Rätselraten bei einem unerreichbaren Orchestrator.
    }
  }

  // Kapitel 36.3: Tabs der Orchestrator-Module kommen aus GET /api/v1/modules statt aus fest verdrahteten Importen. Ein
  // Modul, dessen Bundle nicht lädt, zeigt seinen Tab mit Fehlermeldung — die übrige Shell bleibt unberührt. Der
  // Administration-Tab bleibt immer der letzte (#loadAdminTab hängt ihn an; Modul-Tabs werden davor eingefügt).
  async #loadModuleTabs() {
    try {
      const tabs = mainTabs(await getModules(), getLang());
      for (const mt of tabs) {
        if (this.#tabs.some((x) => x.id === mt.id)) continue;
        const def: TabDef = { id: mt.id, label: mt.label, element: mt.element, bundle: mt.bundle };
        const err = await ensureBundle(mt.bundle);
        if (err) def.bundleError = err;
        const at = insertIndex(this.#tabs.map((x) => x.id), mt.after);
        this.#tabs.splice(at, 0, def);
        const btn = this.#buildTabButton(def);
        this.#tabsWrap.insertBefore(btn, this.#tabsWrap.children[at] ?? null);
        this.#styleTabButton(btn);
      }
    } catch {
      // Manifest nicht erreichbar: keine Modul-Tabs; der Kern bleibt voll nutzbar.
    }
  }

  disconnectedCallback() {
    connectionMonitor.removeEventListener("statechange", this.#onStateChange);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
    this.#contentEl.removeEventListener("open-workflow-in-editor", this.#onOpenWorkflowInEditor);
    this.#contentEl.removeEventListener("omp-view-trace", this.#onViewTrace);
    clearInterval(this.#countdownHandle);
  }

  async #loadWorkflowOptions() {
    try {
      const res = await apiFetch("/api/v1/workflows");
      const list: WorkflowOption[] = res.ok ? await res.json() : [];
      this.#renderWorkflowOptions(list);
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — die Auswahl bleibt auf
      // ihrem letzten Stand, kein harter Fehler für die restliche Bar.
    }
  }

  #renderWorkflowOptions(list: WorkflowOption[]) {
    const select = this.#workflowSelect;
    const previousValue = select.value;
    select.replaceChildren();

    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = tt("aps.00a8fd");
    select.appendChild(allOpt);

    for (const wf of list) {
      const opt = document.createElement("option");
      opt.value = wf.id;
      opt.textContent = wf.definition.title || wf.name;
      select.appendChild(opt);
    }

    // Auswahl erhalten, solange der Workflow noch existiert — verschwindet
    // er (gestoppt+gelöscht), fällt die Auswahl auf "Alle" zurück statt
    // einen toten Filter stillschweigend weiter anzuwenden.
    if (list.some((wf) => wf.id === previousValue)) {
      select.value = previousValue;
    } else if (this.#workflowFilter !== null) {
      this.#workflowFilter = null;
      this.#applyWorkflowFilter();
    }
  }

  #buildSkeleton() {
    const bar = document.createElement("div");
    bar.setAttribute("data-role", "app-bar");
    bar.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;" +
      "height:var(--omp-appbar-height);background:linear-gradient(180deg,#0d1424,#0a101d);" +
      "border-bottom:1px solid var(--omp-border);box-shadow:0 1px 0 rgba(25,211,243,0.08), 0 4px 18px rgba(0,0,0,0.35);padding:0 var(--omp-space-3);box-sizing:border-box;" +
      "font-family:var(--omp-font);color:var(--omp-text);";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-4);";

    const brand = document.createElement("span");
    brand.textContent = "OpenMediaPlatform";
    brand.style.cssText =
      "font-weight:700;font-size:var(--omp-font-size-md);white-space:nowrap;letter-spacing:0.02em;" +
      "background:var(--omp-accent-gradient);-webkit-background-clip:text;background-clip:text;color:transparent;";

    const tabsWrap = document.createElement("div");
    tabsWrap.setAttribute("data-role", "app-tabs");
    tabsWrap.style.cssText = "display:flex;gap:var(--omp-space-1);";
    this.#tabsWrap = tabsWrap;
    for (const tab of this.#tabs) {
      tabsWrap.appendChild(this.#buildTabButton(tab));
    }
    left.append(brand, tabsWrap);

    const right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-3);";

    // S6: Workflow-Auswahl in der App-Bar — wirkt nur auf den Flow-
    // Editor-Tab (s. #switchTab/FlowCanvas.setWorkflowFilter), bleibt
    // aber über Tab-Wechsel hinweg erhalten (s. #workflowFilter-Doku).
    const workflowSelect = document.createElement("select");
    workflowSelect.setAttribute("data-role", "workflow-filter-select");
    workflowSelect.style.cssText = "font-size:var(--omp-font-size-xs);";
    workflowSelect.addEventListener("change", () => {
      this.#workflowFilter = workflowSelect.value || null;
      this.#applyWorkflowFilter();
    });
    this.#workflowSelect = workflowSelect;
    right.appendChild(workflowSelect);

    const pill = document.createElement("span");
    pill.setAttribute("data-role", "connection-pill");
    pill.style.cssText = "font-size:var(--omp-font-size-xs);";
    this.#pillEl = pill;
    right.appendChild(pill);
    right.appendChild(buildLangSelect());

    bar.append(left, right);

    const banner = document.createElement("div");
    banner.setAttribute("data-role", "disconnected-banner");
    banner.style.display = "none";

    const content = document.createElement("div");
    content.setAttribute("data-role", "app-content");
    content.style.cssText = "flex:1 1 auto;min-height:0;position:relative;background:var(--omp-bg);";

    // Globale Alarmleiste (Footer, Nutzerauftrag 2026-09-21) — auf jedem
    // Tab sichtbar, blendet sich ohne Alarme selbst aus.
    const alertBar = document.createElement("omp-alert-bar");
    alertBar.addEventListener("omp-open-alarms", () => this.#switchTab("alarms"));

    this.replaceChildren(bar, banner, content, alertBar);
    this.#bannerEl = banner;
    this.#contentEl = content;
  }

  #buildTabButton(tab: TabDef): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tab.label ?? t(tab.labelKey as I18nKey);
    btn.setAttribute("data-tab-id", tab.id);
    btn.addEventListener("click", () => this.#switchTab(tab.id));
    return btn;
  }

  // Gemeinsam mit #loadAdminTab() genutzt (Bugfix 2026-07-26): der
  // Administration-Tab wird erst asynchron nach whoami() angehängt,
  // also NACH dem synchronen #switchTab("flow") in connectedCallback()
  // — ohne dieses Neu-Stylen blieb sein Button vollständig ungestylt
  // (kein TAB_BUTTON_BASE, kein aktiv/inaktiv-Zustand) und zeigte damit
  // die native Browser-Button-Optik (hellgrau), die neben den bewusst
  // dunkel/transparent gestylten übrigen Tabs wie "aktiv/ausgewählt"
  // aussah, obwohl der Flow-Editor-Tab tatsächlich aktiv war.
  #styleTabButton(btn: HTMLButtonElement) {
    const isActive = btn.getAttribute("data-tab-id") === this.#activeTab;
    btn.style.cssText =
      TAB_BUTTON_BASE +
      (isActive
        ? "background:rgba(47,140,255,0.12);color:var(--omp-text);border-color:rgba(25,211,243,0.35);"
        : "background:transparent;color:var(--omp-text-dim);");
  }

  #switchTab(id: TabId) {
    this.#activeTab = id;
    for (const el of this.#tabsWrap.children) {
      this.#styleTabButton(el as HTMLButtonElement);
    }
    const tab = this.#tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.bundleError) {
      const msg = document.createElement("p");
      msg.className = "omp-empty";
      msg.style.cssText = "color:var(--omp-error);padding:var(--omp-space-3);";
      msg.textContent = t("app.module.loadFailed", { name: tab.label ?? tab.id });
      msg.title = tab.bundleError;
      this.#contentEl.replaceChildren(msg);
      return;
    }
    this.#contentEl.replaceChildren(document.createElement(tab.element));
    // S6: eine zuvor getroffene Workflow-Auswahl auf den frisch
    // gemounteten Flow-Editor-Tab anwenden — die Kachel selbst hält
    // dazwischen keinen Zustand (s. #workflowFilter-Doku oben).
    if (id === "flow") this.#applyWorkflowFilter();
  }

  #applyWorkflowFilter() {
    const canvas = this.#contentEl.querySelector("omp-flow-canvas") as FlowCanvas | null;
    canvas?.setWorkflowFilter(this.#workflowFilter);
  }

  // Primärsignal (SSE) + Sekundärsignal (apiFetch) laufen hier zusammen
  // in einer Anzeige: Pill immer sichtbar, Banner nur bei "disconnected"
  // (END-GOAL-FEATURES.md §1.3a). Reconnect (disconnected → connected)
  // remountet den aktiven Tab, damit Graph/Panel-Daten einmal frisch
  // geladen werden statt auf dem letzten, evtl. veralteten Stand zu
  // bleiben — der #init()-/connectedCallback()-Pfad der jeweiligen
  // View existiert dafür bereits, kein neuer Reload-Mechanismus nötig.
  #applyConnectionState(detail: ConnectionChangeDetail) {
    const { state, nextRetryAt } = detail;
    const reconnected = state === "connected" && this.#lastState === "disconnected";
    this.#lastState = state;

    this.#pillEl.textContent = t(PILL_LABEL[state]);
    this.#pillEl.style.color = PILL_COLOR[state];

    this.#setInteractiveLock(state === "disconnected");
    this.#renderBanner(state, nextRetryAt);

    if (reconnected) this.#switchTab(this.#activeTab);
  }

  #setInteractiveLock(locked: boolean) {
    if (locked) {
      this.#contentEl.setAttribute("aria-disabled", "true");
      this.#contentEl.style.pointerEvents = "none";
      this.#contentEl.style.opacity = "0.5";
    } else {
      this.#contentEl.removeAttribute("aria-disabled");
      this.#contentEl.style.pointerEvents = "";
      this.#contentEl.style.opacity = "";
    }
  }

  #renderBanner(state: ConnectionState, nextRetryAt: number | null) {
    clearInterval(this.#countdownHandle);
    this.#countdownHandle = undefined;

    if (state !== "disconnected") {
      this.#bannerEl.style.display = "none";
      return;
    }

    this.#bannerEl.style.cssText =
      "display:flex;align-items:center;justify-content:center;gap:var(--omp-space-3);flex:0 0 auto;" +
      "padding:6px var(--omp-space-3);box-sizing:border-box;background:rgba(239,83,80,0.15);" +
      "border-bottom:1px solid var(--omp-error);color:var(--omp-error);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);animation:omp-pulse 2s ease-in-out infinite;";

    const label = document.createElement("span");
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.textContent = t("app.conn.retryNow");
    retryBtn.style.cssText = "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);";
    retryBtn.addEventListener("click", () => connectionMonitor.reconnectNow());
    this.#bannerEl.replaceChildren(label, retryBtn);

    const tick = () => {
      const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : 0;
      label.textContent = t("app.conn.lost", { secs });
    };
    tick();
    this.#countdownHandle = setInterval(tick, 1000);
  }
}

customElements.define("omp-app-shell", AppShell);
