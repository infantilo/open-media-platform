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
//
// Nachtrag 243: Alarme sind quittierbar ("gesehen", bleibt sichtbar) und
// maskierbar (ausgeblendet, unter "Maskiert" wiederherstellbar). Beides
// gilt nur, solange der Alarm-Zustand (Fingerprint, s. alarms.ts) gleich
// bleibt, und ist serverseitig geteilt (/api/v1/alarms/acks).
import { connectionMonitor } from "./connection.ts";
import { clearAlarmAck, fetchAlarms, REFRESH_EVENT_TYPES, setAlarmAck, SEVERITY_COLOR, SEVERITY_LABEL } from "./alarms.ts";
import type { AlarmState, AckMode } from "./alarms.ts";

const POLL_FALLBACK_INTERVAL_MS = 30000;


class AlarmView extends HTMLElement {
  #pollHandle: number | undefined;
  #states: AlarmState[] = [];
  #maskedOpen = false;
  #notice = "";
  #renderPending = false;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render();
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
    this.addEventListener("click", this.#onClick);
    this.addEventListener("focusout", this.#onFocusOut);
    this.addEventListener("toggle", this.#onToggle, true);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
    this.removeEventListener("click", this.#onClick);
    this.removeEventListener("focusout", this.#onFocusOut);
    this.removeEventListener("toggle", this.#onToggle, true);
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

  #onToggle = (ev: Event) => {
    const t = ev.target as HTMLElement;
    if (t instanceof HTMLDetailsElement && t.dataset.role === "masked") this.#maskedOpen = t.open;
  };

  // Während der Nutzer in einem Kommentarfeld/Select tippt, wird nicht neu
  // gerendert (sonst ginge die Eingabe bei jedem SSE-Event verloren);
  // nachgeholt beim Verlassen des Felds.
  #onFocusOut = () => {
    if (this.#renderPending) queueMicrotask(() => this.#render());
  };

  #onClick = async (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const row = btn.closest<HTMLElement>("[data-row]");
    if (!row?.dataset.key || row.dataset.fp === undefined) return;
    const alarm = { key: decodeURIComponent(row.dataset.key), fingerprint: decodeURIComponent(row.dataset.fp) };
    const action = btn.dataset.action;
    let ok = true;
    if (action === "clear") {
      ok = await clearAlarmAck(alarm.key);
    } else if (action === "ack" || action === "mask") {
      const comment = (row?.querySelector<HTMLInputElement>("input[data-role=comment]")?.value ?? "").trim();
      const minutes = Number(row?.querySelector<HTMLSelectElement>("select[data-role=dur]")?.value ?? "0");
      ok = await setAlarmAck(alarm, action as AckMode, comment, action === "mask" ? minutes : 0);
    }
    this.#notice = ok ? "" : "Aktion fehlgeschlagen (fehlende Berechtigung \"operate\" oder Orchestrator nicht erreichbar).";
    this.#renderPending = false;
    await this.#poll();
    this.#render();
  };

  async #poll() {
    try {
      this.#states = await fetchAlarms();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render() {
    const focused = document.activeElement;
    if (focused && this.contains(focused) && (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement)) {
      this.#renderPending = true;
      return;
    }
    this.#renderPending = false;

    const indexed = this.#states.map((a) => ({ a }));
    const active = indexed.filter(({ a }) => !a.ack);
    const acked = indexed.filter(({ a }) => a.ack?.mode === "ack");
    const masked = indexed.filter(({ a }) => a.ack?.mode === "mask");
    const criticalCount = active.filter(({ a }) => a.severity === "critical").length;
    const warningCount = active.length - criticalCount;
    const notice = this.#notice
      ? `<div style="padding:var(--omp-space-2);color:var(--omp-error);">${escapeHtml(this.#notice)}</div>`
      : "";

    const activeHtml =
      active.length === 0
        ? `<div style="padding:var(--omp-space-2);color:var(--omp-preset);">✓ Keine aktiven Alarme.</div>`
        : active.map(({ a }) => row(a, "active")).join("");
    const ackedHtml =
      acked.length === 0
        ? ""
        : `<div class="omp-h1" style="font-size:var(--omp-font-size-md,14px);margin:var(--omp-space-3) 0 var(--omp-space-1);">Quittiert (${acked.length})</div>` +
          acked.map(({ a }) => row(a, "acked")).join("");
    const maskedHtml =
      masked.length === 0
        ? ""
        : `<details data-role="masked" ${this.#maskedOpen ? "open" : ""} style="margin-top:var(--omp-space-3);">
             <summary style="cursor:pointer;color:var(--omp-text-dim);">Maskiert (${masked.length})</summary>
             <div style="margin-top:var(--omp-space-1);">${masked.map(({ a }) => row(a, "masked")).join("")}</div>
           </details>`;

    this.innerHTML = `
      <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">
        Alarme (${criticalCount} kritisch, ${warningCount} Warnung${warningCount === 1 ? "" : "en"})
      </div>
      ${notice}${activeHtml}${ackedHtml}${maskedHtml}
    `;
  }
}

// Nutzerauftrag 2026-09-02 ("Alarme nach demselben Muster"): .omp-card
// statt Inline-Duplikation von Fläche/Rahmen/Radius, Severity-Badge statt
// reiner Farbtext — nur der linke Akzentrand bleibt Inline.
function row(a: AlarmState, kind: "active" | "acked" | "masked"): string {
  // Key + Fingerprint stehen in der Zeile selbst (URL-kodiert, damit
  // Anführungszeichen o. ä. das Attribut nicht sprengen): Quittiert wird
  // exakt der Zustand, den der Nutzer gesehen hat — nicht ein Array-Index,
  // der sich zwischen Rendern und Klick durch einen Refresh verschieben
  // könnte.
  const color = SEVERITY_COLOR[a.severity];
  const dim = kind === "active" ? "" : "opacity:0.7;";
  let meta = "";
  let controls: string;
  if (a.ack) {
    const who = `${a.ack.mode === "ack" ? "quittiert" : "maskiert"} von ${escapeHtml(a.ack.username)} um ${new Date(a.ack.createdAt).toLocaleString()}`;
    const until = a.ack.expiresAt ? `, bis ${new Date(a.ack.expiresAt).toLocaleString()}` : ", bis zur Zustandsänderung";
    const cmt = a.ack.comment ? ` — „${escapeHtml(a.ack.comment)}“` : "";
    meta = `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${who}${a.ack.mode === "mask" ? until : ""}${cmt}</div>`;
    controls = `<button type="button" data-action="clear">Wiederherstellen</button>`;
  } else {
    controls = `
      <input data-role="comment" type="text" maxlength="500" placeholder="Kommentar (optional)" style="flex:1 1 140px;min-width:0;">
      <button type="button" data-action="ack" title="Gesehen — bleibt sichtbar, zählt nicht mehr als laut">Quittieren</button>
      <select data-role="dur" title="Dauer der Maskierung">
        <option value="0">bis Änderung</option><option value="60">1 h</option><option value="480">8 h</option>
      </select>
      <button type="button" data-action="mask" title="Ausblenden aus Footer/Zähler">Maskieren</button>`;
  }
  return `
    <div class="omp-card" data-row data-key="${encodeURIComponent(a.key)}" data-fp="${encodeURIComponent(a.fingerprint)}" style="padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);border-left:3px solid ${color};${dim}">
      <div style="display:flex;gap:var(--omp-space-2);align-items:flex-start;">
        <span class="omp-badge" style="color:${color};border-color:${color};white-space:nowrap;flex-shrink:0;">${SEVERITY_LABEL[a.severity]}</span>
        <div>
          <div><strong>${escapeHtml(a.source)}: ${escapeHtml(a.title)}</strong></div>
          <div style="color:var(--omp-text-dim);white-space:pre-wrap;word-break:break-word;">${escapeHtml(a.detail)}</div>
          ${meta}
        </div>
      </div>
      <div style="display:flex;gap:var(--omp-space-1);align-items:center;flex-wrap:wrap;margin-top:var(--omp-space-1);">${controls}</div>
    </div>`;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-alarm-view", AlarmView);
