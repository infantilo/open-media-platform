// Countdown „Nächster Workflow startet in …“ für Operatoren, die (noch) keine
// Konsole bedienen können. Datenquelle: GET /api/v1/me/upcoming (nur Workflows,
// die der Nutzer bedienen darf, frühester Start zuerst).

import { dateLocale, t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { formatCountdown, pickNext, type UpcomingStart } from "./upcoming-logic.ts";

const REFRESH_MS = 30_000;

class UpcomingStartElement extends HTMLElement {
  #list: UpcomingStart[] = [];
  #tick: number | undefined;
  #refresh: number | undefined;

  connectedCallback() {
    this.style.cssText = "display:none;margin-top:var(--omp-space-3);";
    void this.#load();
    this.#tick = window.setInterval(() => this.#paint(), 1000);
    this.#refresh = window.setInterval(() => void this.#load(), REFRESH_MS);
  }

  disconnectedCallback() {
    if (this.#tick !== undefined) window.clearInterval(this.#tick);
    if (this.#refresh !== undefined) window.clearInterval(this.#refresh);
  }

  async #load() {
    try {
      const res = await apiFetch("/api/v1/me/upcoming");
      if (res.ok) this.#list = ((await res.json()) as UpcomingStart[] | null) ?? [];
    } catch {
      // Orchestrator kurz nicht erreichbar — nächster Versuch in 30 s.
    }
    this.#paint();
  }

  #paint() {
    const now = Date.now();
    const next = pickNext(this.#list, now);
    if (!next) {
      this.style.display = "none";
      return;
    }
    const at = new Date(next.startsAt);
    const remaining = at.getTime() - now;
    this.style.display = "block";
    this.replaceChildren();
    const name = document.createElement("div");
    name.style.cssText = "color:var(--omp-text-dim);";
    name.textContent = t(remaining > 0 ? "up.next" : "up.starting", { name: next.workflowName });
    const clock = document.createElement("div");
    clock.className = "omp-countdown";
    clock.style.cssText = "font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;margin:4px 0;";
    clock.textContent = remaining > 0 ? formatCountdown(remaining) : t("up.now");
    const when = document.createElement("div");
    when.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    when.textContent = t("up.planned", { when: at.toLocaleString(dateLocale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) });
    this.append(name, clock, when);
    // Beim Start erscheint die Konsole über den bestehenden Refresh (SSE node.added / 30-s-Poll).
  }
}

customElements.define("omp-upcoming-start", UpcomingStartElement);
