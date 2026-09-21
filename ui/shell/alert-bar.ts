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
import type { AlarmState } from "./alarms.ts";

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

  // Nachtrag 243: nur AKTIVE (weder quittierte noch maskierte) Alarme
  // färben/pulsieren die Leiste. Quittierte bleiben sichtbar, aber
  // gedämpft; maskierte erscheinen nur als dezente Zahl. Sind alle
  // Alarme maskiert, verschwindet die Leiste ganz.
  #render(alarms: AlarmState[]) {
    const active = alarms.filter((a) => !a.ack);
    const acked = alarms.filter((a) => a.ack?.mode === "ack");
    const maskedCount = alarms.filter((a) => a.ack?.mode === "mask").length;
    if (active.length === 0 && acked.length === 0) {
      this.style.display = "none";
      this.replaceChildren();
      return;
    }
    const critical = active.filter((a) => a.severity === "critical");
    const quiet = active.length === 0;
    const worst = critical.length > 0 ? "critical" : "warning";
    const bg = quiet ? "var(--omp-surface-raised)" : SEVERITY_COLOR[worst];
    this.style.cssText =
      "display:flex;align-items:center;gap:var(--omp-space-3);flex:0 0 auto;cursor:pointer;" +
      "padding:var(--omp-space-1) var(--omp-space-3);font-family:var(--omp-font);" +
      `font-size:var(--omp-font-size-sm);font-weight:600;color:${quiet ? "var(--omp-text-dim)" : "#fff"};background:${bg};` +
      (quiet ? "border-top:1px solid var(--omp-border);" : "") +
      (!quiet && worst === "critical" ? "animation:omp-pulse 1.2s ease-in-out infinite;" : "");
    this.title = "Klicken: Alarme-Tab öffnen";

    const parts: string[] = [];
    if (critical.length > 0) parts.push(`${critical.length} kritisch`);
    if (active.length > critical.length) parts.push(`${active.length - critical.length} Warnung(en)`);
    const summary = document.createElement("span");
    summary.style.whiteSpace = "nowrap";
    summary.textContent = quiet ? `✓ ${acked.length} quittiert` : `⚠ ${parts.join(", ")}`;

    const list = document.createElement("span");
    list.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;flex:1 1 auto;";
    const shownAlarms = active.length > 0 ? active : acked;
    const shown = shownAlarms.slice(0, MAX_LISTED).map((a) => `${a.source} ${a.title}: ${a.detail}`);
    const more = shownAlarms.length > MAX_LISTED ? ` (+${shownAlarms.length - MAX_LISTED} weitere)` : "";
    list.textContent = shown.join("  •  ") + more;

    const extras: string[] = [];
    if (!quiet && acked.length > 0) extras.push(`${acked.length} quittiert`);
    if (maskedCount > 0) extras.push(`${maskedCount} maskiert`);
    const children: HTMLElement[] = [summary, list];
    if (extras.length > 0) {
      const note = document.createElement("span");
      note.style.cssText = "white-space:nowrap;font-weight:400;opacity:0.75;font-size:var(--omp-font-size-xs);";
      note.textContent = extras.join(" · ");
      children.push(note);
    }
    this.replaceChildren(...children);
  }
}

customElements.define("omp-alert-bar", AlertBar);
