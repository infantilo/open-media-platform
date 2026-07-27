// <omp-scheduler-view> — Workflow-übergreifende Zeitplan-Übersicht +
// Bearbeitung (Nachtrag 97 Folgearbeit, 2026-07-27). Ursprünglich eine
// flache Liste (Nachtrag 98) — Nutzerwunsch direkt im Anschluss:
// "sollte aber als Tag/Woche/Monat im horizontalen (halb-)Stundenplan
// sein", per Rückfrage auf Drag&Drop (statt Klick-öffnet-Formularfelder)
// präzisiert. Jetzt: eine Zeile pro Workflow, horizontale Zeitachse
// (Tag: 24h in 30-Min-Raster; Woche: 7 Tage à 24h, dieselbe
// 30-Min-Auflösung, nur schmaler; Monat: reine Tages-Übersicht ohne
// Uhrzeit-Auflösung, Klick springt in die Tagesansicht — wie in jeder
// verbreiteten Kalender-App das Monatsraster nur Überblick ist, nicht
// direkt editierbar). Balken sind direkt mit der Maus verschieb-/
// größenveränderbar, Speicherung sofort bei Loslassen (kein separater
// Speichern-Schritt — Direktmanipulation "committed on drop" ist hier
// die erwartete Interaktion, anders als das gestufte Text-Formular in
// workflows-view.ts, s. dortige explizite-Speichern-Doku).
//
// Kein neuer Endpunkt: Zeitpläne bleiben Teil von
// `Workflow.definition.schedules`, CRUD läuft über das bestehende
// `PUT /api/v1/workflows/{id}` (immer die GANZE Definition, s.
// orchestrator/internal/workflows/service.go Update() — `wf.Definition
// = def`, kein Partial-Merge) — jede Speicherung schickt daher die
// unverändert übernommene restliche Definition mit, nur `schedules`
// wird ersetzt.
//
// Bewusste Scope-Grenzen dieser Runde (dokumentiert, kein stiller Gap):
// - Monat-Ansicht ist reine Navigation (kein Drag) — Uhrzeit-Auflösung
//   bei 31 Tagen horizontal wäre unlesbar, kein verbreitetes
//   Kalender-App-Muster erlaubt das.
// - "+ Zeitplan" legt ein neues Start+Stop-Paar mit Standardzeiten an
//   (09:00–17:00, Kind aus einer kleinen Auswahl), kein Klick-Zieh-Neu-
//   Anlegen direkt auf leerer Fläche — reduziert Aufwand deutlich, ohne
//   Funktion zu verlieren (danach normal ziehbar).
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
// `schedules`, alle anderen Felder werden unverändert durchgereicht.
interface Workflow {
  id: string;
  name: string;
  status: string;
  definition: Record<string, unknown> & { schedules?: Schedule[] };
}

const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]; // JS Date.getDay()-Index

const KIND_LABELS: Record<Schedule["kind"], string> = {
  once: "einmalig",
  daily: "täglich",
  weekly: "wöchentlich",
};

const POLL_FALLBACK_INTERVAL_MS = 30000;
const REFRESH_EVENT_TYPES = new Set(["workflow.updated", "lost-events"]);

const DAY_MINUTES = 1440;
const SNAP_MINUTES = 30;
const MIN_DURATION_MINUTES = 30;
const EDGE_PX = 8; // Randbereich eines Balkens, der als Resize-Griff zählt
const ROW_HEIGHT_PX = 34;
const BAR_HEIGHT_PX = 22;

type ViewMode = "day" | "week" | "month";

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function startOfWeek(d: Date): Date {
  // Montag-basiert (JS Date.getDay(): 0=So..6=Sa).
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const r = startOfDay(d);
  r.setDate(r.getDate() + diffToMonday);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function sameCalendarDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function fmtDayLabel(d: Date): string {
  return `${WEEKDAY_LABELS[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
}

function fmtMinutes(m: number): string {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, Math.round(m)));
  const h = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseTimeOfDay(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

// Ermittelt, ob/wann sched an diesem Kalendertag feuert — dieselbe
// Grundidee wie orchestrator/internal/workflows/scheduler.go
// occurrenceAt, hier clientseitig für die Grid-Darstellung (kein
// Datenzugriff aufs Backend nötig, die rohen Schedules reichen).
function occurrenceMinutes(s: Schedule, date: Date): number | null {
  if (s.kind === "once") {
    if (!s.at) return null;
    const at = new Date(s.at);
    if (!sameCalendarDate(at, date)) return null;
    return at.getHours() * 60 + at.getMinutes();
  }
  if (s.kind === "daily") return parseTimeOfDay(s.timeOfDay);
  if (s.kind === "weekly") {
    if (s.weekday === undefined || date.getDay() !== s.weekday) return null;
    return parseTimeOfDay(s.timeOfDay);
  }
  return null;
}

interface Instance {
  schedule: Schedule;
  minutes: number;
  dateIndex: number; // Index in der sichtbaren Tagesliste (0 bei Tag-Ansicht, 0-6 bei Woche)
}

// Bar ist ein Start+Stop-Paar (oder ein unpaariger Rest) für EINEN
// sichtbaren Tag — Paarung wie zuvor (gleiche kind+weekday-Kombination,
// ein start + ein stop), jetzt zusätzlich pro dateIndex getrennt (ein
// wöchentlicher Zeitplan erscheint z. B. in der Wochenansicht nur an
// seinem einen Wochentag, ein täglicher an allen sieben).
interface Bar {
  start?: Instance;
  stop?: Instance;
}

function buildBarsForDates(schedules: Schedule[], dates: Date[]): Bar[] {
  const bars: Bar[] = [];
  dates.forEach((date, dateIndex) => {
    const instances: Instance[] = [];
    for (const s of schedules) {
      const m = occurrenceMinutes(s, date);
      if (m !== null) instances.push({ schedule: s, minutes: m, dateIndex });
    }
    const used = new Set<string>();
    for (const inst of instances) {
      if (used.has(inst.schedule.id) || inst.schedule.action !== "start") continue;
      const partner = instances.find(
        (o) =>
          !used.has(o.schedule.id) &&
          o.schedule.id !== inst.schedule.id &&
          o.schedule.action === "stop" &&
          o.schedule.kind === inst.schedule.kind &&
          (inst.schedule.kind !== "weekly" || o.schedule.weekday === inst.schedule.weekday),
      );
      used.add(inst.schedule.id);
      if (partner) used.add(partner.schedule.id);
      bars.push({ start: inst, stop: partner });
    }
    for (const inst of instances) {
      if (used.has(inst.schedule.id)) continue;
      used.add(inst.schedule.id);
      bars.push({ stop: inst });
    }
  });
  return bars;
}

type DragMode = "move" | "resize-start" | "resize-stop";

class SchedulerView extends HTMLElement {
  #pollHandle: number | undefined;
  #workflows: Workflow[] = [];
  #viewMode: ViewMode = "day";
  #anchorDate: Date = startOfDay(new Date());
  // Während eines Drags werden Poll-getriebene Re-Renders übersprungen
  // (gleiches Muster wie andernorts im Projekt bei Pointer-Interaktionen,
  // z. B. omp-fader/omp-knob #dragging-Guard) — sonst würde ein
  // SSE-getriebener Zwischen-Render das gerade gezogene DOM-Element
  // unter dem Zeiger ersetzen und den Drag abbrechen.
  #dragging = false;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;user-select:none;";
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
    if (this.#dragging) return;
    try {
      const res = await apiFetch("/api/v1/workflows");
      if (!res.ok) return;
      this.#workflows = await res.json();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #visibleDates(): Date[] {
    if (this.#viewMode === "day") return [this.#anchorDate];
    if (this.#viewMode === "week") {
      const monday = startOfWeek(this.#anchorDate);
      return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    }
    // "month": alle Tage des Monats von anchorDate.
    const year = this.#anchorDate.getFullYear();
    const month = this.#anchorDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));
  }

  #navigate(deltaUnits: number) {
    if (this.#viewMode === "day") this.#anchorDate = addDays(this.#anchorDate, deltaUnits);
    else if (this.#viewMode === "week") this.#anchorDate = addDays(this.#anchorDate, deltaUnits * 7);
    else {
      const d = new Date(this.#anchorDate);
      d.setMonth(d.getMonth() + deltaUnits, 1);
      this.#anchorDate = startOfDay(d);
    }
    this.#render();
  }

  #setViewMode(mode: ViewMode) {
    this.#viewMode = mode;
    this.#render();
  }

  async #persist(wf: Workflow, schedules: Schedule[]) {
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
    await this.#poll();
  }

  #addSchedulePair(wf: Workflow, kind: Schedule["kind"]) {
    const schedules = wf.definition.schedules ?? [];
    const start: Schedule = { id: crypto.randomUUID(), kind, action: "start", timeOfDay: "09:00" };
    const stop: Schedule = { id: crypto.randomUUID(), kind, action: "stop", timeOfDay: "17:00" };
    if (kind === "once") {
      const at = new Date(this.#anchorDate);
      const stopAt = new Date(this.#anchorDate);
      at.setHours(9, 0, 0, 0);
      stopAt.setHours(17, 0, 0, 0);
      start.at = at.toISOString();
      stop.at = stopAt.toISOString();
      delete start.timeOfDay;
      delete stop.timeOfDay;
    } else if (kind === "weekly") {
      start.weekday = this.#anchorDate.getDay();
      stop.weekday = this.#anchorDate.getDay();
    }
    void this.#persist(wf, [...schedules, start, stop]);
  }

  #deleteSchedules(wf: Workflow, ids: string[]) {
    const schedules = (wf.definition.schedules ?? []).filter((s) => !ids.includes(s.id));
    void this.#persist(wf, schedules);
  }

  #render() {
    const container = document.createElement("div");

    container.appendChild(this.#renderToolbar());

    if (this.#workflows.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);margin-top:8px;";
      empty.textContent = "Keine Workflows vorhanden.";
      container.appendChild(empty);
      this.replaceChildren(container);
      return;
    }

    if (this.#viewMode === "month") {
      container.appendChild(this.#renderMonthGrid());
    } else {
      container.appendChild(this.#renderTimeGrid());
    }

    this.replaceChildren(container);
  }

  #renderToolbar(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;";

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-right:8px;";
    heading.textContent = "Scheduler";
    toolbar.appendChild(heading);

    const modeGroup = document.createElement("div");
    modeGroup.style.cssText = "display:flex;gap:2px;";
    (["day", "week", "month"] as const).forEach((mode) => {
      const btn = document.createElement("button");
      btn.textContent = mode === "day" ? "Tag" : mode === "week" ? "Woche" : "Monat";
      const active = this.#viewMode === mode;
      btn.style.cssText =
        `font-size:11px;cursor:pointer;padding:3px 8px;` +
        `background:${active ? "var(--omp-accent, #5b9bd5)" : "rgba(255,255,255,0.06)"};` +
        `color:${active ? "#fff" : "var(--omp-text)"};border:none;border-radius:2px;`;
      btn.addEventListener("click", () => this.#setViewMode(mode));
      modeGroup.appendChild(btn);
    });
    toolbar.appendChild(modeGroup);

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "◀";
    prevBtn.style.cssText = "cursor:pointer;font-size:11px;";
    prevBtn.addEventListener("click", () => this.#navigate(-1));
    toolbar.appendChild(prevBtn);

    const todayBtn = document.createElement("button");
    todayBtn.textContent = "Heute";
    todayBtn.style.cssText = "cursor:pointer;font-size:11px;";
    todayBtn.addEventListener("click", () => {
      this.#anchorDate = startOfDay(new Date());
      this.#render();
    });
    toolbar.appendChild(todayBtn);

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▶";
    nextBtn.style.cssText = "cursor:pointer;font-size:11px;";
    nextBtn.addEventListener("click", () => this.#navigate(1));
    toolbar.appendChild(nextBtn);

    const label = document.createElement("span");
    label.style.cssText = "color:var(--omp-text-dim);font-size:12px;margin-left:4px;";
    label.textContent = this.#rangeLabel();
    toolbar.appendChild(label);

    return toolbar;
  }

  #rangeLabel(): string {
    if (this.#viewMode === "day") return fmtDayLabel(this.#anchorDate);
    if (this.#viewMode === "week") {
      const monday = startOfWeek(this.#anchorDate);
      return `${fmtDayLabel(monday)} – ${fmtDayLabel(addDays(monday, 6))}`;
    }
    return this.#anchorDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // Gemeinsamer Renderer für Tag- und Wochenansicht: horizontale
  // Zeitachse über `dates.length` Tage (1 oder 7), eine Zeile pro
  // Workflow, Balken absolut positioniert (Prozent relativ zur vollen
  // Zeilenbreite = dates.length * 1440 Minuten) — dieselbe Koordinate
  // für Tag UND Woche, nur die Gesamtspanne unterscheidet sich, s.
  // #startDrag zur Cross-Day-Logik.
  #renderTimeGrid(): HTMLElement {
    const dates = this.#visibleDates();
    const totalMinutes = dates.length * DAY_MINUTES;

    const wrap = document.createElement("div");
    wrap.style.cssText = "overflow-x:auto;";

    const grid = document.createElement("div");
    grid.style.cssText = `display:flex;flex-direction:column;min-width:${dates.length * 640}px;`;

    // Kopfzeile: Tageslabels (+ bei Tag-Ansicht Stundenmarken).
    const header = document.createElement("div");
    header.style.cssText = "display:flex;margin-left:140px;position:relative;height:20px;";
    dates.forEach((date) => {
      const cell = document.createElement("div");
      cell.style.cssText =
        `flex:1;text-align:center;font-size:11px;color:var(--omp-text-dim);` +
        `border-left:1px solid rgba(255,255,255,0.08);`;
      cell.textContent = fmtDayLabel(date);
      header.appendChild(cell);
    });
    grid.appendChild(header);

    if (this.#viewMode === "day") {
      const hourRow = document.createElement("div");
      hourRow.style.cssText = "display:flex;margin-left:140px;position:relative;height:16px;";
      for (let h = 0; h < 24; h += 2) {
        const tick = document.createElement("div");
        tick.style.cssText =
          `position:absolute;left:${(h / 24) * 100}%;font-size:9px;color:var(--omp-text-dim);`;
        tick.textContent = `${String(h).padStart(2, "0")}:00`;
        hourRow.appendChild(tick);
      }
      grid.appendChild(hourRow);
    }

    for (const wf of this.#workflows) {
      grid.appendChild(this.#renderWorkflowRow(wf, dates, totalMinutes));
    }

    wrap.appendChild(grid);
    return wrap;
  }

  #renderWorkflowRow(wf: Workflow, dates: Date[], totalMinutes: number): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = `display:flex;align-items:stretch;height:${ROW_HEIGHT_PX}px;`;

    const label = document.createElement("div");
    label.style.cssText =
      "width:140px;flex:0 0 140px;font-size:12px;padding-right:6px;display:flex;align-items:center;" +
      "gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    label.title = wf.name;
    label.textContent = wf.name;
    row.appendChild(label);

    const track = document.createElement("div");
    track.style.cssText =
      "position:relative;flex:1;background:rgba(255,255,255,0.03);" +
      "border-top:1px solid rgba(255,255,255,0.06);";
    track.dataset.role = "schedule-track";

    // Tagestrenner (nur optisch, bei Tag-Ansicht ein einziges Segment).
    dates.forEach((_, i) => {
      if (i === 0) return;
      const sep = document.createElement("div");
      sep.style.cssText =
        `position:absolute;top:0;bottom:0;left:${(i / dates.length) * 100}%;` +
        `width:1px;background:rgba(255,255,255,0.1);`;
      track.appendChild(sep);
    });

    const schedules = wf.definition.schedules ?? [];
    for (const bar of buildBarsForDates(schedules, dates)) {
      track.appendChild(this.#renderBar(wf, bar, dates.length, totalMinutes));
    }

    const addBtn = document.createElement("button");
    addBtn.textContent = "+";
    addBtn.title = "Zeitplan hinzufügen";
    addBtn.style.cssText =
      "position:absolute;right:2px;top:50%;transform:translateY(-50%);font-size:10px;cursor:pointer;" +
      "opacity:0.5;padding:1px 5px;";
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#openAddMenu(wf, addBtn);
    });
    track.appendChild(addBtn);

    row.appendChild(track);
    return row;
  }

  #openAddMenu(wf: Workflow, anchor: HTMLElement) {
    const existing = this.querySelector('[data-role="add-menu"]');
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.dataset.role = "add-menu";
    menu.style.cssText =
      "position:absolute;background:#222;border:1px solid #444;border-radius:3px;" +
      "padding:4px;z-index:10;display:flex;flex-direction:column;gap:2px;font-size:11px;";
    const rect = anchor.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    menu.style.left = `${rect.left - hostRect.left}px`;
    menu.style.top = `${rect.bottom - hostRect.top + 2}px`;

    (["daily", "weekly", "once"] as const).forEach((kind) => {
      const opt = document.createElement("button");
      opt.textContent = KIND_LABELS[kind];
      opt.style.cssText = "cursor:pointer;text-align:left;";
      opt.addEventListener("click", () => {
        menu.remove();
        this.#addSchedulePair(wf, kind);
      });
      menu.appendChild(opt);
    });

    this.appendChild(menu);
    const closeOnOutside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", closeOnOutside, true);
      }
    };
    window.setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
  }

  #renderBar(wf: Workflow, bar: Bar, dateCount: number, totalMinutes: number): HTMLElement {
    const startAbs = bar.start ? bar.start.dateIndex * DAY_MINUTES + bar.start.minutes : undefined;
    const stopAbs = bar.stop ? bar.stop.dateIndex * DAY_MINUTES + bar.stop.minutes : undefined;
    const left = startAbs ?? Math.max(0, (stopAbs ?? 0) - MIN_DURATION_MINUTES);
    const right = stopAbs ?? Math.min(totalMinutes, (startAbs ?? 0) + MIN_DURATION_MINUTES);

    const el = document.createElement("div");
    const isPartial = !bar.start || !bar.stop;
    el.style.cssText =
      `position:absolute;top:${(ROW_HEIGHT_PX - BAR_HEIGHT_PX) / 2}px;height:${BAR_HEIGHT_PX}px;` +
      `left:${(left / totalMinutes) * 100}%;width:${((right - left) / totalMinutes) * 100}%;` +
      `background:${isPartial ? "rgba(224,160,32,0.55)" : "rgba(91,155,213,0.7)"};` +
      `border:1px solid ${isPartial ? "#e0a020" : "#5b9bd5"};border-radius:3px;cursor:grab;` +
      "box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;";
    el.title =
      (bar.start ? `Start ${fmtMinutes(bar.start.minutes)}` : "kein Start") +
      " – " +
      (bar.stop ? `Stop ${fmtMinutes(bar.stop.minutes)}` : "kein Stop");

    const timeLabel = document.createElement("span");
    timeLabel.style.cssText = "font-size:9px;color:#fff;pointer-events:none;white-space:nowrap;";
    timeLabel.textContent = `${bar.start ? fmtMinutes(bar.start.minutes) : "?"}–${bar.stop ? fmtMinutes(bar.stop.minutes) : "?"}`;
    el.appendChild(timeLabel);

    const delBtn = document.createElement("span");
    delBtn.textContent = "×";
    delBtn.style.cssText =
      "position:absolute;right:1px;top:-1px;font-size:11px;color:#fff;cursor:pointer;display:none;" +
      "background:rgba(0,0,0,0.4);border-radius:2px;padding:0 3px;line-height:1.3;";
    delBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ids = [bar.start?.schedule.id, bar.stop?.schedule.id].filter((id): id is string => !!id);
      this.#deleteSchedules(wf, ids);
    });
    el.appendChild(delBtn);
    el.addEventListener("pointerenter", () => (delBtn.style.display = "block"));
    el.addEventListener("pointerleave", () => (delBtn.style.display = "none"));

    el.addEventListener("pointerdown", (ev) => this.#startDrag(ev, el, wf, bar, dateCount, totalMinutes, left, right));

    return el;
  }

  #startDrag(
    ev: PointerEvent,
    el: HTMLElement,
    wf: Workflow,
    bar: Bar,
    dateCount: number,
    totalMinutes: number,
    originalLeft: number,
    originalRight: number,
  ) {
    const track = el.parentElement;
    if (!track) return;
    ev.preventDefault();
    ev.stopPropagation();

    const trackRect = track.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offsetInBarPx = ev.clientX - elRect.left;
    const mode: DragMode =
      offsetInBarPx <= EDGE_PX && bar.start ? "resize-start" : elRect.right - ev.clientX <= EDGE_PX && bar.stop ? "resize-stop" : "move";

    // "daily" darf beim Ziehen den Tag nicht wechseln (gilt für jeden
    // Tag identisch, ein Tageswechsel wäre bedeutungslos) — auf das
    // Ursprungs-Tagessegment geklemmt, nur die Uhrzeit ändert sich.
    const lockedDateIndex = bar.start?.schedule.kind === "daily" ? Math.floor(originalLeft / DAY_MINUTES) : null;

    this.#dragging = true;
    el.style.cursor = "grabbing";
    el.setPointerCapture(ev.pointerId);

    const pxPerMinute = trackRect.width / totalMinutes;
    let currentLeft = originalLeft;
    let currentRight = originalRight;

    const clampToLockedDay = (abs: number): number => {
      if (lockedDateIndex === null) return Math.max(0, Math.min(totalMinutes, abs));
      const dayStart = lockedDateIndex * DAY_MINUTES;
      return Math.max(dayStart, Math.min(dayStart + DAY_MINUTES, abs));
    };

    const onMove = (moveEv: PointerEvent) => {
      const deltaMinutes = snap((moveEv.clientX - ev.clientX) / pxPerMinute);
      if (mode === "move") {
        const duration = originalRight - originalLeft;
        let newLeft = clampToLockedDay(originalLeft + deltaMinutes);
        newLeft = Math.min(newLeft, totalMinutes - duration);
        currentLeft = newLeft;
        currentRight = newLeft + duration;
      } else if (mode === "resize-start") {
        currentLeft = Math.min(clampToLockedDay(originalLeft + deltaMinutes), originalRight - MIN_DURATION_MINUTES);
      } else {
        currentRight = Math.max(clampToLockedDay(originalRight + deltaMinutes), originalLeft + MIN_DURATION_MINUTES);
      }
      el.style.left = `${(currentLeft / totalMinutes) * 100}%`;
      el.style.width = `${((currentRight - currentLeft) / totalMinutes) * 100}%`;
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.style.cursor = "grab";
      this.#dragging = false;
      this.#commitDrag(wf, bar, currentLeft, currentRight, mode);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // Schreibt die gezogene Position zurück in die betroffenen
  // Schedule-Objekte (start und/oder stop) und speichert sofort.
  // dateIndex/weekday werden aus der absoluten Minute (Tag*1440+Minute)
  // zurückgerechnet — bei "weekly" ändert ein Tageswechsel während des
  // Ziehens (nur in der Wochenansicht möglich) also tatsächlich den
  // Wochentag, bei "once" das Datum, bei "daily" bleibt der Tag dank
  // lockedDateIndex ohnehin unverändert (s. #startDrag).
  #commitDrag(wf: Workflow, bar: Bar, left: number, right: number, mode: DragMode) {
    const dates = this.#visibleDates();
    const schedules = (wf.definition.schedules ?? []).map((s) => ({ ...s }));

    const applyTo = (inst: Instance | undefined, absMinutes: number) => {
      if (!inst) return;
      const dateIndex = Math.max(0, Math.min(dates.length - 1, Math.floor(absMinutes / DAY_MINUTES)));
      const minutesOfDay = absMinutes - dateIndex * DAY_MINUTES;
      const target = schedules.find((s) => s.id === inst.schedule.id);
      if (!target) return;
      if (target.kind === "once") {
        const date = dates[dateIndex];
        const at = new Date(date);
        at.setHours(0, minutesOfDay, 0, 0);
        target.at = at.toISOString();
      } else {
        target.timeOfDay = fmtMinutes(minutesOfDay);
        if (target.kind === "weekly") target.weekday = dates[dateIndex].getDay();
      }
    };

    if (mode === "resize-start") applyTo(bar.start, left);
    else if (mode === "resize-stop") applyTo(bar.stop, right);
    else {
      applyTo(bar.start, left);
      applyTo(bar.stop, right);
    }

    void this.#persist(wf, schedules);
  }

  // Monat-Ansicht: reine Übersicht (kein Drag, s. Datei-Kopfkommentar) —
  // pro Workflow eine Zeile, pro Tag eine schmale Zelle, gefüllt wenn an
  // dem Tag mindestens ein Zeitplan feuert. Klick springt in die
  // Tagesansicht dieses Datums.
  #renderMonthGrid(): HTMLElement {
    const dates = this.#visibleDates();
    const wrap = document.createElement("div");
    wrap.style.cssText = "overflow-x:auto;";

    const grid = document.createElement("div");
    grid.style.cssText = `display:flex;flex-direction:column;min-width:${140 + dates.length * 20}px;`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;margin-left:140px;height:16px;";
    dates.forEach((date) => {
      const cell = document.createElement("div");
      cell.style.cssText =
        "flex:1;text-align:center;font-size:8px;color:var(--omp-text-dim);cursor:pointer;";
      cell.textContent = String(date.getDate());
      cell.title = fmtDayLabel(date);
      cell.addEventListener("click", () => {
        this.#anchorDate = date;
        this.#viewMode = "day";
        this.#render();
      });
      header.appendChild(cell);
    });
    grid.appendChild(header);

    for (const wf of this.#workflows) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;height:22px;";

      const label = document.createElement("div");
      label.style.cssText =
        "width:140px;flex:0 0 140px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      label.textContent = wf.name;
      label.title = wf.name;
      row.appendChild(label);

      const schedules = wf.definition.schedules ?? [];
      dates.forEach((date) => {
        const hasAny = schedules.some((s) => occurrenceMinutes(s, date) !== null);
        const cell = document.createElement("div");
        cell.style.cssText =
          `flex:1;height:14px;margin:0 1px;border-radius:2px;cursor:pointer;` +
          `background:${hasAny ? "#5b9bd5" : "rgba(255,255,255,0.05)"};`;
        cell.addEventListener("click", () => {
          this.#anchorDate = date;
          this.#viewMode = "day";
          this.#render();
        });
        row.appendChild(cell);
      });

      grid.appendChild(row);
    }

    wrap.appendChild(grid);
    return wrap;
  }
}

customElements.define("omp-scheduler-view", SchedulerView);
