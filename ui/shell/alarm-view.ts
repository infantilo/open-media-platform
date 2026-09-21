// <omp-alarm-view> — genereller Alarm-View (docs/END-GOAL-FEATURES.md
// §17.3c/§17.4 Teil 3, 2026-07-17): sammelt alle bereits existierenden
// Fehler-/Warn-Signale an einer Stelle statt verteilt. Bewusst **kein**
// neuer Alarm-Erzeuger — nur ein neuer, zentraler Konsument dreier
// bereits bestehender Endpunkte:
//   - GET /api/v1/instances (crashed/restartCount, K7-Teil-1)
//   - GET /api/v1/placement/advice (Ressourcen-Ampel, D6 Teil 3)
//   - GET /api/v1/workflows (status "failed")
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): reagiert
// auf "instance.crashed"/"instance.restarted" (launcher.go),
// "placement.advice" (D6 Teil 3) und "workflow.updated" — alle drei
// existieren bereits, kein neues Backend-Event nötig — statt alle paar
// Sekunden zu pollen. Poll bleibt nur als deutlich langsamerer
// Reconnect-/Fallback-Pfad (POLL_FALLBACK_INTERVAL_MS). Über apiFetch()
// (connection.ts), damit ein Fehlschlag den geteilten ConnectionMonitor
// auf "degraded" setzt statt still zu bleiben.
//
// Bewusst additiv, nicht ersetzend: hosts-view.ts zeigt Placement-
// Advice weiterhin zusätzlich inline (kontextuell dort sinnvoll, wenn
// man sich ohnehin einen Host ansieht) — dieser Tab ist der neue,
// zusätzliche zentrale Überblick über alle Alarmarten zusammen, keine
// Ablösung der bestehenden Einzelanzeigen (docs/decisions.md,
// 2026-07-17 Nachtrag 5, Abwägung dokumentiert).
import { connectionMonitor } from "./connection.ts";
import { fetchAlarms, REFRESH_EVENT_TYPES, SEVERITY_COLOR, SEVERITY_LABEL } from "./alarms.ts";
import type { Alarm } from "./alarms.ts";

const POLL_FALLBACK_INTERVAL_MS = 30000;


class AlarmView extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([]);
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

  async #poll() {
    try {
      this.#render(await fetchAlarms());
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render(alarms: Alarm[]) {
    if (alarms.length === 0) {
      this.innerHTML = `
        <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">Alarme</div>
        <div style="padding:var(--omp-space-2);color:var(--omp-preset);">✓ Keine aktiven Alarme.</div>
      `;
      return;
    }

    const criticalCount = alarms.filter((a) => a.severity === "critical").length;
    const warningCount = alarms.length - criticalCount;

    // Nutzerauftrag 2026-09-02 ("Alarme nach demselben Muster"): .omp-card
    // statt Inline-Duplikation von Fläche/Rahmen/Radius (identische
    // Formel wie überall sonst), Severity-Badge statt reiner Farbtext —
    // nur der linke Akzentrand bleibt Inline (variiert je Alarm).
    const rows = alarms
      .map(
        (a) => `
        <div class="omp-card" style="display:flex;gap:var(--omp-space-2);align-items:flex-start;padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);border-left:3px solid ${SEVERITY_COLOR[a.severity]};">
          <span class="omp-badge" style="color:${SEVERITY_COLOR[a.severity]};border-color:${SEVERITY_COLOR[a.severity]};white-space:nowrap;flex-shrink:0;">${SEVERITY_LABEL[a.severity]}</span>
          <div>
            <div><strong>${escapeHtml(a.source)}: ${escapeHtml(a.title)}</strong></div>
            <div style="color:var(--omp-text-dim);white-space:pre-wrap;word-break:break-word;">${escapeHtml(a.detail)}</div>
          </div>
        </div>`,
      )
      .join("");

    this.innerHTML = `
      <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">
        Alarme (${criticalCount} kritisch, ${warningCount} Warnung${warningCount === 1 ? "" : "en"})
      </div>
      ${rows}
    `;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-alarm-view", AlarmView);
