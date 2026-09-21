// <omp-alert-bar> — globale Alarmleiste im Footer der App-Shell
// (Nutzerauftrag 2026-09-21: Alarme, v. a. ein unerwartet offline
// gegangener Host, müssen auf JEDEM Tab sichtbar sein, nicht nur im
// Alarme-Tab). Zeigt sich nur, solange Alarme anstehen; kritische
// pulsieren. Klick öffnet den Alarme-Tab (Event "omp-open-alarms",
// vom app-shell behandelt). Quelle ist dieselbe fetchAlarms() wie im
// Alarme-Tab; Poll alle 5 s, weil "Host offline" zeitbasiert entsteht
// (kein SSE-Event beim Ausbleiben von Telemetrie).
import { connectionMonitor } from "./connection.ts";
import { fetchAlarms, REFRESH_EVENT_TYPES, SEVERITY_COLOR } from "./alarms.ts";
import type { Alarm } from "./alarms.ts";

const POLL_INTERVAL_MS = 5000;
const MAX_LISTED = 3;

class AlertBar extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.setAttribute("role", "alert");
    this.style.display = "none";
    this.addEventListener("click", this.#onClick);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    this.removeEventListener("click", this.#onClick);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onClick = () => {
    this.dispatchEvent(new CustomEvent("omp-open-alarms", { bubbles: true }));
  };

  #onSseMessage = (ev: Event) => {
    try {
      const parsed = JSON.parse((ev as CustomEvent<string>).detail) as { type: string };
      if (REFRESH_EVENT_TYPES.has(parsed.type)) this.#poll();
    } catch {
      // ignorieren — der 5-s-Poll holt es ohnehin auf
    }
  };

  async #poll() {
    try {
      this.#render(await fetchAlarms());
    } catch {
      // Orchestrator nicht erreichbar: das zeigt bereits das
      // Verbindungs-Banner; hier den letzten Stand stehen lassen.
    }
  }

  #render(alarms: Alarm[]) {
    if (alarms.length === 0) {
      this.style.display = "none";
      this.replaceChildren();
      return;
    }
    const critical = alarms.filter((a) => a.severity === "critical");
    const worst = critical.length > 0 ? "critical" : "warning";
    const color = SEVERITY_COLOR[worst];
    this.style.cssText =
      "display:flex;align-items:center;gap:var(--omp-space-3);flex:0 0 auto;cursor:pointer;" +
      "padding:var(--omp-space-1) var(--omp-space-3);font-family:var(--omp-font);" +
      `font-size:var(--omp-font-size-sm);font-weight:600;color:#fff;background:${color};` +
      (worst === "critical" ? "animation:omp-pulse 1.2s ease-in-out infinite;" : "");
    this.title = "Klicken: Alarme-Tab öffnen";

    const summary = document.createElement("span");
    summary.style.whiteSpace = "nowrap";
    summary.textContent =
      `⚠ ${critical.length > 0 ? `${critical.length} kritisch` : ""}` +
      `${critical.length > 0 && alarms.length > critical.length ? ", " : ""}` +
      `${alarms.length > critical.length ? `${alarms.length - critical.length} Warnung(en)` : ""}`;

    const list = document.createElement("span");
    list.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;";
    const shown = alarms.slice(0, MAX_LISTED).map((a) => `${a.source} ${a.title}: ${a.detail}`);
    const more = alarms.length > MAX_LISTED ? ` (+${alarms.length - MAX_LISTED} weitere)` : "";
    list.textContent = shown.join("  •  ") + more;

    this.replaceChildren(summary, list);
  }
}

customElements.define("omp-alert-bar", AlertBar);
