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
import "./hosts-view.ts";
import "./workflows-view.ts";
import "./alarm-view.ts";
import "./admin-view.ts";
import { type ConnectionChangeDetail, type ConnectionState, connectionMonitor } from "./connection.ts";
import { whoami } from "./auth.ts";

type TabId = "flow" | "workflows" | "hosts" | "alarms" | "admin";

interface TabDef {
  id: TabId;
  label: string;
  element: string;
}

const BASE_TABS: TabDef[] = [
  { id: "flow", label: "Flow Editor", element: "omp-flow-canvas" },
  { id: "workflows", label: "Workflows", element: "omp-workflows-view" },
  { id: "hosts", label: "Hosts", element: "omp-hosts-view" },
  // §17 Teil 3 (docs/END-GOAL-FEATURES.md, 2026-07-17): genereller
  // Alarm-View, vierter Tab neben Flow-Editor/Workflows/Hosts.
  { id: "alarms", label: "Alarme", element: "omp-alarm-view" },
];

// Kapitel 11 Teil 1 (docs/END-GOAL-FEATURES.md §11.4): eigener Tab statt
// Teil von BASE_TABS, weil er nur bei whoami().isAdmin nachträglich
// angehängt wird (admin-Verb ODER Bootstrap-Modus, s. auth_handlers.go:
// handleWhoami) — für alle anderen Nutzer bleibt die Bar unverändert.
const ADMIN_TAB: TabDef = { id: "admin", label: "Administration", element: "omp-admin-view" };

const PILL_LABEL: Record<ConnectionState, string> = {
  connected: "● Connected",
  degraded: "● Degraded",
  disconnected: "● Disconnected",
};

const PILL_COLOR: Record<ConnectionState, string> = {
  connected: "var(--omp-preset)",
  degraded: "var(--omp-cue)",
  disconnected: "var(--omp-error)",
};

const TAB_BUTTON_BASE =
  "border:1px solid transparent;border-radius:var(--omp-radius);" +
  "padding:6px 12px;font-size:var(--omp-font-size-sm);font-family:var(--omp-font);cursor:pointer;";

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

  connectedCallback() {
    this.style.cssText = "display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;";
    this.#buildSkeleton();
    this.#switchTab("flow");
    this.#loadAdminTab();

    this.#lastState = connectionMonitor.state;
    connectionMonitor.addEventListener("statechange", this.#onStateChange);
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
      this.#tabsWrap.appendChild(this.#buildTabButton(ADMIN_TAB));
    } catch {
      // Kein Administration-Tab ohne bestätigtes isAdmin — sicherer
      // Default, kein Rätselraten bei einem unerreichbaren Orchestrator.
    }
  }

  disconnectedCallback() {
    connectionMonitor.removeEventListener("statechange", this.#onStateChange);
    clearInterval(this.#countdownHandle);
  }

  #buildSkeleton() {
    const bar = document.createElement("div");
    bar.setAttribute("data-role", "app-bar");
    bar.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;" +
      "height:var(--omp-appbar-height);background:var(--omp-surface);" +
      "border-bottom:1px solid var(--omp-border);padding:0 var(--omp-space-3);box-sizing:border-box;" +
      "font-family:var(--omp-font);color:var(--omp-text);";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-4);";

    const brand = document.createElement("span");
    brand.textContent = "OpenMediaPlatform";
    brand.style.cssText = "font-weight:600;font-size:var(--omp-font-size-md);white-space:nowrap;";

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
    const pill = document.createElement("span");
    pill.setAttribute("data-role", "connection-pill");
    pill.style.cssText = "font-size:var(--omp-font-size-xs);";
    this.#pillEl = pill;
    right.appendChild(pill);

    bar.append(left, right);

    const banner = document.createElement("div");
    banner.setAttribute("data-role", "disconnected-banner");
    banner.style.display = "none";

    const content = document.createElement("div");
    content.setAttribute("data-role", "app-content");
    content.style.cssText = "flex:1 1 auto;min-height:0;position:relative;background:var(--omp-bg);";

    this.replaceChildren(bar, banner, content);
    this.#bannerEl = banner;
    this.#contentEl = content;
  }

  #buildTabButton(tab: TabDef): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tab.label;
    btn.setAttribute("data-tab-id", tab.id);
    btn.addEventListener("click", () => this.#switchTab(tab.id));
    return btn;
  }

  #switchTab(id: TabId) {
    this.#activeTab = id;
    for (const el of this.#tabsWrap.children) {
      const btn = el as HTMLButtonElement;
      const isActive = btn.getAttribute("data-tab-id") === id;
      btn.style.cssText =
        TAB_BUTTON_BASE +
        (isActive
          ? "background:var(--omp-surface-raised);color:var(--omp-text);border-color:var(--omp-border);"
          : "background:transparent;color:var(--omp-text-dim);");
    }
    const tab = this.#tabs.find((t) => t.id === id);
    if (!tab) return;
    this.#contentEl.replaceChildren(document.createElement(tab.element));
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

    this.#pillEl.textContent = PILL_LABEL[state];
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
    retryBtn.textContent = "Reconnect now";
    retryBtn.style.cssText = "cursor:pointer;font-size:var(--omp-font-size-xs);";
    retryBtn.addEventListener("click", () => connectionMonitor.reconnectNow());
    this.#bannerEl.replaceChildren(label, retryBtn);

    const tick = () => {
      const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : 0;
      label.textContent = `Connection to orchestrator lost — retrying in ${secs}s`;
    };
    tick();
    this.#countdownHandle = setInterval(tick, 1000);
  }
}

customElements.define("omp-app-shell", AppShell);
