// <omp-scheduler-view> — Workflow-übergreifende Zeitplan-Übersicht +
// Bearbeitung (Nachtrag 97 Folgearbeit, 2026-07-27): bisher waren
// Zeitpläne (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 1) nur im
// Bearbeiten-Formular EINES Workflows sichtbar (workflows-view.ts
// #renderScheduleRow) — dieser Tab zeigt alle Zeitpläne ALLER
// Workflows an einer Stelle und erlaubt Löschen/Neu-Anlegen/
// Verschieben/Verlängern-Verkürzen direkt hier, ohne pro Workflow ins
// Bearbeiten-Formular wechseln zu müssen.
//
// Kein neuer Endpunkt: Zeitpläne bleiben Teil von
// `Workflow.definition.schedules`, CRUD läuft über das bestehende
// `PUT /api/v1/workflows/{id}` (immer die GANZE Definition, s.
// orchestrator/internal/workflows/service.go Update() — `wf.Definition
// = def`, kein Partial-Merge) — jede Speicherung hier schickt daher die
// unverändert übernommene restliche Definition (roles/connections/
// settings/title/…) mit, nur `schedules` wird ersetzt.
//
// Explizites Speichern statt PUT-pro-Klick (gleiche Konvention wie das
// bestehende Workflow-Formular, s. dortige #submitForm-Doku): ein
// Workflow wird über "Bearbeiten" in einen lokalen Entwurfsmodus
// versetzt (#draftSchedules, unabhängig vom Poll-getriebenen
// #workflows), erst "Speichern" schickt das PUT. Ein laufender Poll
// während des Bearbeitens überschreibt daher nie eine unfertige
// Eingabe (nur die schreibgeschützten Zeilen der ANDEREN Workflows
// aktualisieren sich live).
import { apiFetch, connectionMonitor } from "./connection.ts";
import { showToast } from "../kit/omp-toast.ts";

interface Schedule {
  id: string;
  kind: "once" | "daily" | "weekly";
  action: "start" | "stop";
  at?: string;
  timeOfDay?: string;
  weekday?: number;
  lastFiredAt?: string;
}

// Definition hier bewusst als "unknown-durchgereichtes" Objekt typisiert
// (nicht Feld für Feld wie in workflows-view.ts): dieser Tab ändert nur
// `schedules`, alle anderen Felder (roles/connections/settings/title/…)
// werden unverändert durchgereicht, ihre genaue Form ist für dieses
// Formular ohne Belang.
interface Workflow {
  id: string;
  name: string;
  status: string;
  definition: Record<string, unknown> & { schedules?: Schedule[] };
}

const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const KIND_LABELS: Record<Schedule["kind"], string> = {
  once: "einmalig",
  daily: "täglich",
  weekly: "wöchentlich",
};

const POLL_FALLBACK_INTERVAL_MS = 30000;
const REFRESH_EVENT_TYPES = new Set(["workflow.updated", "lost-events"]);

// Wandelt einen gespeicherten ISO-Zeitstempel in den von
// <input type="datetime-local"> erwarteten lokalen Wert um (dieselbe
// Logik wie workflows-view.ts toDatetimeLocalValue — bewusst dupliziert,
// kein gemeinsames Util-Modul zwischen View-Dateien in diesem Projekt).
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleTimeLabel(s: Schedule): string {
  if (s.kind === "once") return s.at ? new Date(s.at).toLocaleString() : "(kein Zeitpunkt)";
  const time = s.timeOfDay ?? "(keine Zeit)";
  return s.kind === "weekly" ? `${WEEKDAY_LABELS[s.weekday ?? 0]} ${time}` : time;
}

// Gruppiert Schedules für die schreibgeschützte Übersicht: gleiche
// kind+weekday(bei weekly)-Kombination mit je einem start- und einem
// stop-Eintrag wird als eine Zeile "Start–Stop" dargestellt
// ("verlängern/verkürzen" = die Stop-Zeit bearbeiten) — Bearbeiten
// bleibt trotzdem pro einzelnem Schedule-Objekt (kein verschmolzenes
// Datenmodell, nur eine freundlichere Anzeige).
interface DisplayGroup {
  label: string;
  start?: Schedule;
  stop?: Schedule;
}

function groupForDisplay(schedules: Schedule[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  const used = new Set<string>();
  for (const s of schedules) {
    if (used.has(s.id)) continue;
    const partner = schedules.find(
      (o) =>
        !used.has(o.id) &&
        o.id !== s.id &&
        o.kind === s.kind &&
        o.action !== s.action &&
        (s.kind !== "weekly" || o.weekday === s.weekday),
    );
    const start = s.action === "start" ? s : partner;
    const stop = s.action === "stop" ? s : partner;
    used.add(s.id);
    if (partner) used.add(partner.id);
    const kindLabel = KIND_LABELS[s.kind];
    const label =
      start && stop
        ? `${kindLabel}: ${scheduleTimeLabel(start)} → ${scheduleTimeLabel(stop)}`
        : `${kindLabel}: ${scheduleTimeLabel(s)} (${s.action === "start" ? "Start" : "Stop"})`;
    groups.push({ label, start, stop });
  }
  return groups;
}

class SchedulerView extends HTMLElement {
  #pollHandle: number | undefined;
  #workflows: Workflow[] = [];
  #editingWfId: string | null = null;
  #draftSchedules: Schedule[] = [];

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
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
      const res = await apiFetch("/api/v1/workflows");
      if (!res.ok) return;
      this.#workflows = await res.json();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #startEditing(wf: Workflow) {
    this.#editingWfId = wf.id;
    this.#draftSchedules = (wf.definition.schedules ?? []).map((s) => ({ ...s }));
    this.#render();
  }

  #cancelEditing() {
    this.#editingWfId = null;
    this.#draftSchedules = [];
    this.#render();
  }

  async #saveEditing(wf: Workflow) {
    // Gleicher Unvollständig-Filter wie workflows-view.ts #submitForm —
    // eine gerade erst per "+ Zeitplan" angelegte, noch nicht befüllte
    // Zeile wird stillschweigend verworfen statt einen Backend-Validierungsfehler zu provozieren.
    const schedules = this.#draftSchedules.filter((s) => {
      if (s.kind === "once") return !!s.at;
      if (s.kind === "weekly") return !!s.timeOfDay && s.weekday !== undefined;
      return !!s.timeOfDay;
    });
    const body = {
      name: wf.name,
      definition: { ...wf.definition, schedules: schedules.length > 0 ? schedules : undefined },
    };
    try {
      const res = await apiFetch(`/api/v1/workflows/${wf.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        showToast(`Speichern fehlgeschlagen: ${await res.text()}`);
        return;
      }
    } catch (err) {
      showToast(`Speichern fehlgeschlagen: ${err}`);
      return;
    }
    this.#cancelEditing();
    await this.#poll();
  }

  #render() {
    const container = document.createElement("div");

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-bottom:8px;";
    heading.textContent = "Scheduler";
    container.appendChild(heading);

    if (this.#workflows.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Keine Workflows vorhanden.";
      container.appendChild(empty);
    }

    for (const wf of this.#workflows) {
      container.appendChild(this.#renderWorkflowSection(wf));
    }

    this.replaceChildren(container);
  }

  #renderWorkflowSection(wf: Workflow): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText =
      "padding:8px;margin-bottom:8px;border-radius:3px;background:rgba(255,255,255,0.04);";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;";
    const title = document.createElement("strong");
    title.textContent = `${wf.name} (${wf.status})`;
    header.appendChild(title);
    section.appendChild(header);

    if (this.#editingWfId === wf.id) {
      this.#draftSchedules.forEach((sched, i) => {
        section.appendChild(this.#renderDraftRow(sched, i));
      });

      const addBtn = document.createElement("button");
      addBtn.textContent = "+ Zeitplan";
      addBtn.style.cssText = "font-size:11px;cursor:pointer;margin:4px 4px 4px 0;";
      addBtn.addEventListener("click", () => {
        this.#draftSchedules.push({ id: crypto.randomUUID(), kind: "daily", action: "start" });
        this.#render();
      });
      section.appendChild(addBtn);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Speichern";
      saveBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
      saveBtn.addEventListener("click", () => void this.#saveEditing(wf));
      section.appendChild(saveBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Abbrechen";
      cancelBtn.style.cssText = "font-size:11px;cursor:pointer;";
      cancelBtn.addEventListener("click", () => this.#cancelEditing());
      section.appendChild(cancelBtn);
    } else {
      const schedules = wf.definition.schedules ?? [];
      if (schedules.length === 0) {
        const none = document.createElement("div");
        none.style.cssText = "color:var(--omp-text-dim);font-size:12px;";
        none.textContent = "Keine Zeitpläne.";
        section.appendChild(none);
      } else {
        for (const group of groupForDisplay(schedules)) {
          const row = document.createElement("div");
          row.style.cssText = "font-size:12px;color:var(--omp-text-dim);";
          row.textContent = group.label;
          section.appendChild(row);
        }
      }

      const editBtn = document.createElement("button");
      editBtn.textContent = "Bearbeiten";
      editBtn.style.cssText = "font-size:11px;cursor:pointer;margin-top:4px;";
      editBtn.addEventListener("click", () => this.#startEditing(wf));
      section.appendChild(editBtn);
    }

    return section;
  }

  // Eine Zeitplan-Zeile im Entwurfsmodus — dieselben Widgets wie
  // workflows-view.ts #renderScheduleRow (Kind/Aktion immer,
  // datetime-local für "once", Zeit+Wochentag für "daily"/"weekly"),
  // operiert hier auf #draftSchedules[i] statt einem Formular-Feld.
  #renderDraftRow(sched: Schedule, i: number): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

    const kindSelect = document.createElement("select");
    (["once", "daily", "weekly"] as const).forEach((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = KIND_LABELS[value];
      if (value === sched.kind) opt.selected = true;
      kindSelect.appendChild(opt);
    });
    kindSelect.addEventListener("change", () => {
      sched.kind = kindSelect.value as Schedule["kind"];
      this.#render();
    });

    const actionSelect = document.createElement("select");
    (["start", "stop"] as const).forEach((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "start" ? "Start" : "Stop";
      if (value === sched.action) opt.selected = true;
      actionSelect.appendChild(opt);
    });
    actionSelect.addEventListener("change", () => {
      sched.action = actionSelect.value as Schedule["action"];
    });

    row.append(kindSelect, actionSelect);

    if (sched.kind === "once") {
      const dtInput = document.createElement("input");
      dtInput.type = "datetime-local";
      dtInput.value = sched.at ? toDatetimeLocalValue(sched.at) : "";
      dtInput.addEventListener("input", () => {
        sched.at = dtInput.value ? new Date(dtInput.value).toISOString() : undefined;
      });
      row.appendChild(dtInput);
    } else {
      if (sched.kind === "weekly") {
        if (sched.weekday === undefined) sched.weekday = 0;
        const weekdaySelect = document.createElement("select");
        WEEKDAY_LABELS.forEach((label, idx) => {
          const opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = label;
          if (sched.weekday === idx) opt.selected = true;
          weekdaySelect.appendChild(opt);
        });
        weekdaySelect.addEventListener("change", () => {
          sched.weekday = Number(weekdaySelect.value);
        });
        row.appendChild(weekdaySelect);
      }
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.value = sched.timeOfDay ?? "";
      timeInput.addEventListener("input", () => {
        sched.timeOfDay = timeInput.value || undefined;
      });
      row.appendChild(timeInput);
    }

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.style.cssText = "cursor:pointer;";
    removeBtn.addEventListener("click", () => {
      this.#draftSchedules.splice(i, 1);
      this.#render();
    });
    row.appendChild(removeBtn);

    return row;
  }
}

customElements.define("omp-scheduler-view", SchedulerView);
