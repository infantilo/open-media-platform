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
import {
  addDays,
  AUTO_LANE,
  computeTimeline,
  type Contribution,
  DAY_MINUTES,
  findBottlenecks,
  fmtBytes,
  fmtCores,
  fmtMbps,
  isOver,
  laneCapacity,
  type Level,
  type LaneSlot,
  occurrenceMinutes,
  type ResHost,
  type ResourceModel,
  sameCalendarDate,
  type Schedule,
  slotUtilization,
  startOfDay,
  type Timeline,
} from "./scheduler-logic.ts";

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

const SNAP_MINUTES = 30;
const MIN_DURATION_MINUTES = 30;
const EDGE_PX = 8; // Randbereich eines Balkens, der als Resize-Griff zählt
const ROW_HEIGHT_PX = 34;
const BAR_HEIGHT_PX = 22;

type ViewMode = "day" | "week" | "month";

function startOfWeek(d: Date): Date {
  // Montag-basiert (JS Date.getDay(): 0=So..6=Sa).
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const r = startOfDay(d);
  r.setDate(r.getDate() + diffToMonday);
  return r;
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

// Wandelt einen gespeicherten ISO-Zeitstempel in den von
// <input type="datetime-local"> erwarteten lokalen Wert um (dieselbe
// Logik wie workflows-view.ts toDatetimeLocalValue — bewusst dupliziert,
// kein gemeinsames Util-Modul zwischen View-Dateien in diesem Projekt).
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
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
  // Ressourcenmodell (GET /api/v1/scheduler/resources) — Host-Kapazitäten,
  // Bedarf je Rolle. Null, solange nicht geladen (dann keine Ressourcen-
  // Anzeige, der Rest funktioniert unverändert).
  #model: ResourceModel | null = null;
  // Womit "Neu ziehen" auf einer leeren Fläche einen Zeitplan anlegt.
  #newKind: Schedule["kind"] = "once";
  // Live-Vorschau beim Ziehen: ersetzt die Zeitpläne EINES Workflows nur
  // für die Ressourcen-Berechnung, gespeichert wird erst beim Loslassen.
  #preview: { wfId: string; schedules: Schedule[] } | null = null;
  #resEl: HTMLElement | null = null;
  #resDates: Date[] = [];
  #resRaf = 0;
  // Pro Workflow: Slot-Index -> Engpass-Beschreibung (Markierung der Balken).
  #wfOver = new Map<string, Map<number, string[]>>();

  connectedCallback() {
    // position:relative ist Pflicht: #openAddMenu positioniert das
    // Add-Menü absolut relativ zu DIESEM Element (per getBoundingClientRect-
    // Differenz berechnet) — ohne eigenen Positionierungskontext hätte
    // "position:absolute" stattdessen relativ zum nächsten positionierten
    // Vorfahren (oder dem Viewport) gewirkt, was das Menü weit außerhalb
    // des sichtbaren Bereichs landen ließ (Nutzerfund 2026-07-27).
    this.style.cssText =
      "display:block;position:relative;background:var(--omp-surface);font-family:var(--omp-font);" +
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
      const [res, resModel] = await Promise.all([
        apiFetch("/api/v1/workflows"),
        apiFetch("/api/v1/scheduler/resources").catch(() => null),
      ]);
      if (!res.ok) return;
      this.#workflows = await res.json();
      if (resModel && resModel.ok) this.#model = (await resModel.json()) as ResourceModel;
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
    heading.className = "omp-h1";
    heading.style.cssText = "margin-right:var(--omp-space-2);";
    heading.textContent = "Scheduler";
    toolbar.appendChild(heading);

    const modeGroup = document.createElement("div");
    modeGroup.style.cssText = "display:flex;gap:2px;";
    (["day", "week", "month"] as const).forEach((mode) => {
      const btn = document.createElement("button");
      btn.textContent = mode === "day" ? "Tag" : mode === "week" ? "Woche" : "Monat";
      // Aktiver Modus per .omp-btn-primary statt eigener Farb-Inline-
      // Duplikation (Nutzerauftrag 2026-09-02) — der globale
      // button-Reset (design-tokens.css) deckt den Rest bereits ab.
      if (this.#viewMode === mode) btn.className = "omp-btn-primary";
      btn.addEventListener("click", () => this.#setViewMode(mode));
      modeGroup.appendChild(btn);
    });
    toolbar.appendChild(modeGroup);

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "◀";
    prevBtn.addEventListener("click", () => this.#navigate(-1));
    toolbar.appendChild(prevBtn);

    const todayBtn = document.createElement("button");
    todayBtn.textContent = "Heute";
    todayBtn.addEventListener("click", () => {
      this.#anchorDate = startOfDay(new Date());
      this.#render();
    });
    toolbar.appendChild(todayBtn);

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▶";
    nextBtn.addEventListener("click", () => this.#navigate(1));
    toolbar.appendChild(nextBtn);

    const label = document.createElement("span");
    label.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);margin-left:4px;";
    label.textContent = this.#rangeLabel();
    toolbar.appendChild(label);

    if (this.#viewMode !== "month") {
      const newLbl = document.createElement("label");
      newLbl.style.cssText = "margin-left:auto;display:flex;align-items:center;gap:4px;color:var(--omp-text-dim);";
      newLbl.title = "Auf eine leere Stelle einer Zeile ziehen, um einen Zeitplan anzulegen";
      newLbl.append("Neu ziehen als:");
      const sel = document.createElement("select");
      (["once", "daily", "weekly"] as const).forEach((k) => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = KIND_LABELS[k];
        if (k === this.#newKind) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => (this.#newKind = sel.value as Schedule["kind"]));
      newLbl.appendChild(sel);
      toolbar.appendChild(newLbl);
    }

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

    // Ressourcen-Zeitachse vorab berechnen: die Balken markieren damit
    // Überlast, der Ressourcen-Block darunter zeigt sie im Detail.
    const timeline = this.#computeTimeline(dates, null);
    this.#updateWorkflowOverloads(timeline);

    for (const wf of this.#workflows) {
      grid.appendChild(this.#renderWorkflowRow(wf, dates, totalMinutes));
    }

    if (timeline && this.#model) {
      grid.appendChild(this.#renderResources(dates, timeline));
    }

    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Ressourcen (Nutzerwunsch 2026-09-30) -------------------------------------

  #slotsFor(dates: Date[]): Date[] {
    const out: Date[] = [];
    for (const d of dates) {
      for (let m = 0; m < DAY_MINUTES; m += SNAP_MINUTES) {
        const t = new Date(d);
        t.setHours(0, m, 0, 0);
        out.push(t);
      }
    }
    return out;
  }

  #computeTimeline(dates: Date[], override: { wfId: string; schedules: Schedule[] } | null): Timeline | null {
    if (!this.#model) return null;
    const map = new Map<string, Schedule[]>();
    for (const wf of this.#workflows) {
      map.set(wf.id, override && override.wfId === wf.id ? override.schedules : wf.definition.schedules ?? []);
    }
    return computeTimeline(this.#model, map, this.#slotsFor(dates), SNAP_MINUTES, new Date());
  }

  // Slot-Index -> Engpass-Text je Workflow, nur für die Lanes, auf denen der
  // Workflow Rollen hat und in Slots, in denen er tatsächlich läuft.
  #updateWorkflowOverloads(timeline: Timeline | null) {
    this.#wfOver = new Map();
    const model = this.#model;
    if (!timeline || !model) return;
    const bottlenecks = findBottlenecks(model, timeline);
    if (bottlenecks.length === 0) return;
    const laneLabel = (id: string) => (id === AUTO_LANE ? "Auto-Pool" : model.hosts.find((h) => h.id === id)?.label ?? id);
    for (const mw of model.workflows) {
      const lanes = new Set(mw.roles.map((r) => (r.hostId && timeline.has(r.hostId) ? r.hostId : AUTO_LANE)));
      const perSlot = new Map<number, string[]>();
      for (const b of bottlenecks) {
        if (!lanes.has(b.laneId)) continue;
        const slot = timeline.get(b.laneId)![b.slotIndex];
        if (!slot.contribs.some((c) => c.wfId === mw.id)) continue; // läuft in diesem Slot gar nicht
        const arr = perSlot.get(b.slotIndex) ?? [];
        arr.push(`${laneLabel(b.laneId)}: ${b.what.join(", ")}`);
        perSlot.set(b.slotIndex, arr);
      }
      if (perSlot.size > 0) this.#wfOver.set(mw.id, perSlot);
    }
  }

  #slotLabel(dates: Date[], slotIndex: number): string {
    const perDay = DAY_MINUTES / SNAP_MINUTES;
    const dayIdx = Math.floor(slotIndex / perDay);
    const minutes = (slotIndex % perDay) * SNAP_MINUTES;
    const time = fmtMinutes(minutes);
    return dates.length > 1 ? `${fmtDayLabel(dates[dayIdx])} ${time}` : time;
  }

  // Aufeinanderfolgende Slot-Indizes zu [von, bis]-Bereichen zusammenfassen.
  #ranges(indices: number[]): [number, number][] {
    const out: [number, number][] = [];
    for (const i of [...indices].sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else out.push([i, i]);
    }
    return out;
  }

  #levelColor(level: Level, pct: number | null, threshold: number): string {
    switch (level) {
      case "over":
        return "rgba(211,51,51,0.9)";
      case "warn":
        return "rgba(224,160,32,0.75)";
      case "ok": {
        const a = 0.22 + 0.4 * Math.min(1, (pct ?? 0) / threshold);
        return `rgba(76,175,80,${a.toFixed(2)})`;
      }
      case "free":
        return "rgba(76,175,80,0.08)";
      default:
        return "rgba(255,255,255,0.10)";
    }
  }

  #renderResources(dates: Date[], timeline: Timeline): HTMLElement {
    const box = document.createElement("div");
    box.dataset.role = "resources";
    box.style.cssText = "margin-top:14px;";
    this.#resEl = box;
    this.#resDates = dates;
    this.#fillResources(box, dates, timeline);
    return box;
  }

  // Live-Neuzeichnen (Ziehen): nur den Ressourcen-Block ersetzen.
  #repaintResources() {
    if (this.#resRaf) return;
    this.#resRaf = requestAnimationFrame(() => {
      this.#resRaf = 0;
      const box = this.#resEl;
      if (!box || !box.isConnected) return;
      const tl = this.#computeTimeline(this.#resDates, this.#preview);
      if (tl) this.#fillResources(box, this.#resDates, tl);
    });
  }

  #fillResources(box: HTMLElement, dates: Date[], timeline: Timeline) {
    const model = this.#model!;
    box.replaceChildren();
    const totalMinutes = dates.length * DAY_MINUTES;
    const perDay = DAY_MINUTES / SNAP_MINUTES;

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:baseline;gap:10px;margin:0 0 4px;flex-wrap:wrap;";
    const title = document.createElement("div");
    title.className = "omp-h1";
    title.style.cssText = "font-size:var(--omp-font-size-md);";
    title.textContent = this.#preview ? "Ressourcen (Vorschau beim Ziehen)" : "Ressourcen (geplant)";
    head.appendChild(title);
    const legend = document.createElement("div");
    legend.style.cssText = "display:flex;gap:8px;align-items:center;font-size:10px;color:var(--omp-text-dim);";
    for (const [lvl, txt] of [["free", "frei"], ["ok", "ok"], ["warn", "knapp"], ["over", "Engpass"], ["unknown", "Bedarf/Kapazität unbekannt"]] as const) {
      const item = document.createElement("span");
      item.style.cssText = "display:inline-flex;align-items:center;gap:3px;";
      const sw = document.createElement("span");
      sw.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;background:${this.#levelColor(lvl, lvl === "ok" ? 60 : null, 85)};`;
      item.append(sw, txt);
      legend.appendChild(item);
    }
    head.appendChild(legend);
    box.appendChild(head);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:var(--omp-text-dim);margin-bottom:6px;";
    hint.textContent =
      "Geplanter Bedarf = gemessenes Profil je Node-Typ (CPU: 95. Perzentil, RAM: Maximum) aller Workflows, die zu diesem Zeitpunkt laufen, " +
      "gegen die Kapazität des Hosts. Rollen ohne Messprofil sind schraffiert (Bedarf unbekannt, nicht null).";
    box.appendChild(hint);

    const laneIds = [...model.hosts.map((h) => h.id), AUTO_LANE];
    const now = new Date();
    for (const laneId of laneIds) {
      const slots = timeline.get(laneId);
      if (!slots) continue;
      const cap = laneCapacity(model, laneId);
      const host: ResHost | undefined = model.hosts.find((h) => h.id === laneId);
      const isAuto = laneId === AUTO_LANE;

      const anyDemand = slots.some((sl) => sl.cpuCores > 0 || sl.rssBytes > 0 || sl.netRxMbps > 0 || sl.netTxMbps > 0 || Object.keys(sl.io).length > 0 || sl.unknown.length > 0);
      // Veraltete Host-Registrierungen (offline, nichts eingeplant) nur Rauschen.
      if (host && !host.online && !host.local && !anyDemand) continue;
      const utils = slots.map((sl) => slotUtilization(sl, cap, model.thresholds));

      const block = document.createElement("div");
      block.style.cssText = "margin-bottom:10px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.06);";

      // Kopf: Name, Kapazität, live, Zusammenfassung.
      const bh = document.createElement("div");
      bh.style.cssText = "display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:3px;";
      const name = document.createElement("span");
      name.style.cssText = "font-weight:600;";
      name.textContent = isAuto ? "Ohne Host-Festlegung (Auto-Platzierung)" : host!.label;
      bh.appendChild(name);
      const capTxt = document.createElement("span");
      capTxt.style.cssText = "color:var(--omp-text-dim);font-size:11px;";
      const capParts: string[] = [];
      if (cap.cpuCores > 0) capParts.push(`${cap.cpuCores} Kerne`);
      if (cap.memBytes > 0) capParts.push(`${fmtBytes(cap.memBytes)} RAM`);
      if (cap.netMbps > 0) capParts.push(`Netz ${fmtMbps(cap.netMbps)} je Richtung`);
      for (const [k, n] of Object.entries(cap.io)) capParts.push(`${n}× ${k}`);
      capTxt.textContent =
        (isAuto ? "Summe aller erreichbaren Hosts: " : "") + (capParts.length ? capParts.join(" · ") : "Kapazität unbekannt");
      bh.appendChild(capTxt);
      if (host && !host.online && !host.local) {
        const off = document.createElement("span");
        off.style.cssText = "color:var(--omp-error, #d33);font-size:11px;";
        off.textContent = "offline";
        bh.appendChild(off);
      }
      if (host?.live) {
        const live = document.createElement("span");
        live.style.cssText = "font-size:11px;color:var(--omp-text-dim);";
        live.title = "Momentaufnahme der aktuellen Auslastung (nicht die Planung)";
        live.textContent =
          `jetzt: CPU ${host.live.cpuPercent.toFixed(0)} % · RAM ${host.live.memPercent.toFixed(0)} %` +
          (host.live.netPercent !== undefined ? ` · Netz ${host.live.netPercent.toFixed(0)} %` : "") +
          (host.live.gpuPercent !== undefined ? ` · GPU ${host.live.gpuPercent.toFixed(0)} %` : "");
        bh.appendChild(live);
      }
      block.appendChild(bh);

      // Zusammenfassung: Engpässe und freie Reserve im sichtbaren Ausschnitt.
      const overIdx = utils.map((u, i) => (isOver(u) ? i : -1)).filter((i) => i >= 0);
      const sum = document.createElement("div");
      sum.style.cssText = "font-size:11px;margin-bottom:3px;";
      if (overIdx.length > 0) {
        const parts = this.#ranges(overIdx).slice(0, 4).map(([a, b]) => {
          const what = new Set<string>();
          for (let i = a; i <= b; i++) {
            if (utils[i].cpuLevel === "over") what.add("CPU");
            if (utils[i].memLevel === "over") what.add("RAM");
            if (utils[i].netLevel === "over") what.add("Netz");
            utils[i].ioOver.forEach((k) => what.add(k));
          }
          return `${this.#slotLabel(dates, a)}–${this.#slotLabel(dates, b + 1 > dates.length * perDay - 1 ? b : b + 1)} (${[...what].join(", ")})`;
        });
        sum.style.color = "var(--omp-error, #e55)";
        sum.textContent = `⚠ Engpass: ${parts.join(" · ")}${this.#ranges(overIdx).length > 4 ? " …" : ""}`;
      } else if (anyDemand) {
        const freeC = utils.map((u) => u.freeCores).filter((v): v is number => v !== null);
        const freeM = utils.map((u) => u.freeMemBytes).filter((v): v is number => v !== null);
        const freeN = utils.map((u) => u.freeNetMbps).filter((v): v is number => v !== null);
        sum.style.color = "var(--omp-text-dim)";
        sum.textContent =
          "Kein Engpass. Freie Reserve (bis Grenzwert), Minimum im Ausschnitt: " +
          [freeC.length ? `${fmtCores(Math.min(...freeC))} Kerne` : "", freeM.length ? `${fmtBytes(Math.min(...freeM))} RAM` : "", freeN.length ? `${fmtMbps(Math.min(...freeN))} Netz` : ""].filter(Boolean).join(" · ");
      } else {
        sum.style.color = "var(--omp-text-dim)";
        sum.textContent = "Im Ausschnitt nichts eingeplant — komplett frei.";
      }
      block.appendChild(sum);

      const rows: { label: string; kind: "cpu" | "mem" | "net" | "io"; key?: string }[] = [];
      if (cap.cpuCores > 0 || slots.some((s2) => s2.cpuCores > 0)) rows.push({ label: "CPU", kind: "cpu" });
      if (cap.memBytes > 0 || slots.some((s2) => s2.rssBytes > 0)) rows.push({ label: "RAM", kind: "mem" });
      if (cap.netMbps > 0 || slots.some((s2) => s2.netRxMbps > 0 || s2.netTxMbps > 0)) rows.push({ label: "Netzwerk", kind: "net" });
      const ioKeys = new Set<string>([...Object.keys(cap.io), ...slots.flatMap((s2) => Object.keys(s2.io))]);
      for (const k of [...ioKeys].sort()) rows.push({ label: k, kind: "io", key: k });

      for (const r of rows) {
        block.appendChild(this.#renderStrip(dates, totalMinutes, slots, utils, cap, r, now));
      }
      box.appendChild(block);
    }
  }

  #renderStrip(
    dates: Date[],
    totalMinutes: number,
    slots: LaneSlot[],
    utils: ReturnType<typeof slotUtilization>[],
    cap: ReturnType<typeof laneCapacity>,
    row: { label: string; kind: "cpu" | "mem" | "net" | "io"; key?: string },
    now: Date,
  ): HTMLElement {
    const model = this.#model!;
    const perDay = DAY_MINUTES / SNAP_MINUTES;
    const wrapRow = document.createElement("div");
    wrapRow.style.cssText = "display:flex;align-items:stretch;height:14px;margin-bottom:2px;";
    const lbl = document.createElement("div");
    lbl.style.cssText = "width:140px;flex:0 0 140px;font-size:10px;color:var(--omp-text-dim);padding-right:6px;text-align:right;line-height:14px;";
    lbl.textContent = row.label;
    wrapRow.appendChild(lbl);

    const track = document.createElement("div");
    track.style.cssText = "position:relative;flex:1;display:flex;gap:0;background:rgba(255,255,255,0.03);";

    // Gruppen: Tag/Woche = jeder Slot eine Zelle; Monat = ein Slot-Bündel je Tag.
    const groups: number[][] = [];
    if (this.#viewMode === "month") {
      for (let d = 0; d < dates.length; d++) groups.push(Array.from({ length: perDay }, (_, i) => d * perDay + i));
    } else {
      for (let i = 0; i < slots.length; i++) groups.push([i]);
    }

    const metric = (i: number): number => {
      const u = utils[i];
      if (row.kind === "cpu") return u.cpuPercent ?? 0;
      if (row.kind === "mem") return u.memPercent ?? 0;
      if (row.kind === "net") return u.netPercent ?? Math.max(slots[i].netRxMbps, slots[i].netTxMbps) / 1e6;
      const need = slots[i].io[row.key!] ?? 0;
      return need;
    };

    for (const g of groups) {
      let rep = g[0];
      for (const i of g) if (metric(i) > metric(rep)) rep = i;
      const u = utils[rep];
      const slot = slots[rep];
      let level: Level;
      let pct: number | null = null;
      let thr = 85;
      let tip = "";
      const when = this.#slotLabel(dates, rep);
      if (row.kind === "cpu") {
        pct = u.cpuPercent;
        thr = model.thresholds.cpu;
        level = u.cpuLevel;
        tip = `${when} · CPU ${fmtCores(slot.cpuCores)} von ${cap.cpuCores || "?"} Kernen` +
          (pct !== null ? ` (${pct.toFixed(0)} %)` : "") +
          (u.freeCores !== null ? ` · frei bis Grenzwert: ${fmtCores(u.freeCores)} Kerne` : "");
      } else if (row.kind === "mem") {
        pct = u.memPercent;
        thr = model.thresholds.mem;
        level = u.memLevel;
        tip = `${when} · RAM ${fmtBytes(slot.rssBytes)} von ${cap.memBytes ? fmtBytes(cap.memBytes) : "?"}` +
          (pct !== null ? ` (${pct.toFixed(0)} %)` : "") +
          (u.freeMemBytes !== null ? ` · frei bis Grenzwert: ${fmtBytes(u.freeMemBytes)}` : "");
      } else if (row.kind === "net") {
        pct = u.netPercent;
        thr = model.thresholds.net ?? 85;
        level = u.netLevel;
        // Link unbekannt: Bedarf trotzdem zeigen, aber nicht als "frei" einfärben.
        if (level === "free" && (slot.netRxMbps > 0 || slot.netTxMbps > 0)) level = "unknown";
        const est = slot.netEstimated ? "~" : "";
        tip = `${when} · Netz Rx ${est}${fmtMbps(slot.netRxMbps)} · Tx ${est}${fmtMbps(slot.netTxMbps)}` +
          (cap.netMbps > 0
            ? ` von ${fmtMbps(cap.netMbps)} je Richtung` + (pct !== null ? ` (${pct.toFixed(0)} %)` : "") +
              (u.freeNetMbps !== null ? ` · frei bis Grenzwert: ${fmtMbps(u.freeNetMbps)}` : "")
            : " · Link-Geschwindigkeit der Karte unbekannt (Host-Agent: OMP_HOST_AGENT_NET_IFACE setzen)");
        if (slot.netEstimated) tip += "\n~ = Annahme (Format der Rolle nicht gesetzt: 1080p50, bzw. Nennwert)";
      } else {
        const need = slot.io[row.key!] ?? 0;
        const total = cap.io[row.key!] ?? 0;
        level = need > total ? "over" : need > 0 ? (need === total ? "warn" : "ok") : "free";
        pct = total > 0 ? (need / total) * 100 : null;
        thr = 100;
        tip = `${when} · ${row.key}: ${need} von ${total} Port(s) belegt · frei: ${Math.max(0, total - need)}`;
      }
      const contribs: Contribution[] = slot.contribs;
      if (contribs.length > 0 && row.kind !== "io") {
        const val = (c: Contribution): number =>
          row.kind === "cpu" ? c.cpuCores : row.kind === "mem" ? c.rssBytes : Math.max(c.netRxMbps, c.netTxMbps);
        const fmt = (c: Contribution): string =>
          row.kind === "cpu"
            ? fmtCores(c.cpuCores) + " Kerne"
            : row.kind === "mem"
            ? fmtBytes(c.rssBytes)
            : `${c.netRxMbps > 0 ? "Rx " + fmtMbps(c.netRxMbps) : ""}${c.netTxMbps > 0 ? "Tx " + fmtMbps(c.netTxMbps) : ""}`;
        tip += "\n" + contribs
          .filter((c) => val(c) > 0)
          .sort((a, b) => val(b) - val(a))
          .map((c) => `  ${c.wfName}/${c.role}: ${fmt(c)}`)
          .join("\n");
      }
      if (slot.unknown.length > 0) tip += `\n⚠ Bedarf unbekannt (kein Messprofil): ${slot.unknown.join(", ")}`;
      if (this.#viewMode === "month") tip += "\n(ungünstigster Zeitpunkt des Tages)";

      const cell = document.createElement("div");
      cell.style.cssText = `flex:1;min-width:0;background:${this.#levelColor(level, pct, thr)};`;
      if (slot.unknown.length > 0) {
        cell.style.backgroundImage = "repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0 2px, transparent 2px 5px)";
      }
      cell.title = tip;
      track.appendChild(cell);
    }

    this.#addNowMarker(track, dates, totalMinutes, now);
    wrapRow.appendChild(track);
    return wrapRow;
  }

  // Senkrechte Linie bei "jetzt", falls im sichtbaren Ausschnitt.
  #addNowMarker(track: HTMLElement, dates: Date[], totalMinutes: number, now: Date) {
    if (this.#viewMode === "month") return;
    const idx = dates.findIndex((d) => sameCalendarDate(d, now));
    if (idx < 0) return;
    const minute = idx * DAY_MINUTES + now.getHours() * 60 + now.getMinutes();
    const line = document.createElement("div");
    line.style.cssText =
      `position:absolute;top:0;bottom:0;left:${(minute / totalMinutes) * 100}%;width:2px;` +
      "background:var(--omp-info, #5b9bd5);pointer-events:none;z-index:2;";
    line.title = "jetzt";
    track.appendChild(line);
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
    track.style.touchAction = "none";

    // Tagestrenner (nur optisch, bei Tag-Ansicht ein einziges Segment).
    dates.forEach((_, i) => {
      if (i === 0) return;
      const sep = document.createElement("div");
      sep.style.cssText =
        `position:absolute;top:0;bottom:0;left:${(i / dates.length) * 100}%;` +
        `width:1px;background:rgba(255,255,255,0.1);`;
      sep.dataset.sep = "1";
      track.appendChild(sep);
    });
    this.#addNowMarker(track, dates, totalMinutes, new Date());
    track.title = "Auf eine leere Stelle ziehen: neuen Zeitplan anlegen";
    track.addEventListener("pointerdown", (ev) => this.#startCreateDrag(ev, track, wf, dates, totalMinutes));

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
    menu.className = "omp-popover";
    menu.style.cssText = "position:absolute;padding:4px;z-index:10;display:flex;flex-direction:column;gap:2px;";
    const rect = anchor.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    // Am RECHTEN statt linken Rand des "+"-Knopfs verankern (wächst nach
    // links): der Knopf sitzt selbst nahe dem rechten Zeilenrand, ein
    // linksbündiges Menü würde regelmäßig über den rechten Bildschirmrand
    // hinauswachsen.
    menu.style.right = `${hostRect.right - rect.right}px`;
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
      `border:1px solid ${isPartial ? "var(--omp-cue)" : "var(--omp-info)"};border-radius:3px;cursor:grab;` +
      "box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;";
    el.title =
      (bar.start ? `Start ${fmtMinutes(bar.start.minutes)}` : "kein Start") +
      " – " +
      (bar.stop ? `Stop ${fmtMinutes(bar.stop.minutes)}` : "kein Stop");
    // Ressourcen-Engpass in der Laufzeit dieses Balkens? (roter Rand + Grund)
    const over = this.#wfOver.get(wf.id);
    if (over && right > left) {
      const from = Math.floor(left / SNAP_MINUTES);
      const to = Math.ceil(right / SNAP_MINUTES);
      const reasons = new Set<string>();
      for (let i = from; i < to; i++) for (const r of over.get(i) ?? []) reasons.add(r);
      if (reasons.size > 0) {
        el.style.borderColor = "var(--omp-error, #e55)";
        el.style.boxShadow = "0 0 0 1px var(--omp-error, #e55)";
        el.title += `\n⚠ Ressourcen-Engpass: ${[...reasons].join(" · ")}`;
      }
    }

    const timeLabel = document.createElement("span");
    timeLabel.style.cssText = "font-size:9px;color:var(--omp-text);pointer-events:none;white-space:nowrap;";
    timeLabel.textContent = `${bar.start ? fmtMinutes(bar.start.minutes) : "?"}–${bar.stop ? fmtMinutes(bar.stop.minutes) : "?"}`;
    el.appendChild(timeLabel);

    // Touch-Fund 2026-09-07: `display:none` bis `pointerenter` machte den
    // Button auf Touch-Geräten unerreichbar — dort feuert `pointerenter`
    // (falls überhaupt) nicht zuverlässig vor einem Tap, der Button blieb
    // unsichtbar genau dort, wo der Finger ihn treffen müsste. Jetzt immer
    // im DOM/klickbar, nur die Deckkraft ändert sich auf Hover (Maus) —
    // dieselbe "dezent, außer man braucht es"-Absicht ohne den Touch-Bruch.
    const delBtn = document.createElement("span");
    delBtn.textContent = "×";
    delBtn.style.cssText =
      "position:absolute;right:1px;top:-1px;font-size:11px;color:var(--omp-text);cursor:pointer;opacity:0.6;" +
      "background:rgba(0,0,0,0.4);border-radius:2px;padding:0 3px;line-height:1.3;transition:opacity 0.1s;";
    delBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ids = [bar.start?.schedule.id, bar.stop?.schedule.id].filter((id): id is string => !!id);
      this.#deleteSchedules(wf, ids);
    });
    el.appendChild(delBtn);
    el.addEventListener("pointerenter", () => (delBtn.style.opacity = "1"));
    el.addEventListener("pointerleave", () => (delBtn.style.opacity = "0.6"));

    el.addEventListener("pointerdown", (ev) => this.#startDrag(ev, el, wf, bar, dateCount, totalMinutes, left, right));
    // Doppelklick: exakte HH:MM-Eingabe wie im alten Formular
    // (workflows-view.ts #renderScheduleRow) — Ziehen ist ungenau
    // (30-Min-Snapping), für exakte Zeiten bleibt das Tippen die
    // verlässlichere Alternative (Nutzerfund 2026-07-27).
    el.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this.#openTimeEditor(wf, bar, el);
    });

    return el;
  }

  #openTimeEditor(wf: Workflow, bar: Bar, anchor: HTMLElement) {
    this.querySelector('[data-role="add-menu"]')?.remove();
    this.querySelector('[data-role="time-editor"]')?.remove();

    const panel = document.createElement("div");
    panel.dataset.role = "time-editor";
    panel.className = "omp-popover";
    panel.style.cssText = "position:absolute;padding:6px;z-index:10;display:flex;flex-direction:column;gap:4px;";
    const rect = anchor.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    panel.style.left = `${Math.min(Math.max(0, rect.left - hostRect.left), hostRect.width - 160)}px`;
    panel.style.top = `${rect.bottom - hostRect.top + 2}px`;

    // Lokale, veränderbare Kopie — jede Feldänderung speichert sofort
    // (gleiche "committed on change"-Konvention wie beim Drag), operiert
    // aber auf einer Kopie, damit ein Zwischen-Poll während des Tippens
    // (selten, aber möglich) nicht mit einer halb bearbeiteten Referenz
    // kollidiert.
    const schedules = (wf.definition.schedules ?? []).map((s) => ({ ...s }));

    const addRow = (label: string, inst: Instance | undefined) => {
      if (!inst) return;
      const target = schedules.find((s) => s.id === inst.schedule.id);
      if (!target) return;

      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;";
      const lbl = document.createElement("span");
      lbl.textContent = label;
      lbl.style.cssText = "color:var(--omp-text-dim);width:32px;";
      row.appendChild(lbl);

      if (target.kind === "weekly") {
        const weekdaySelect = document.createElement("select");
        WEEKDAY_LABELS.forEach((wd, idx) => {
          const opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = wd;
          if (target.weekday === idx) opt.selected = true;
          weekdaySelect.appendChild(opt);
        });
        weekdaySelect.addEventListener("change", () => {
          target.weekday = Number(weekdaySelect.value);
          void this.#persist(wf, schedules);
        });
        row.appendChild(weekdaySelect);
      }

      if (target.kind === "once") {
        const dt = document.createElement("input");
        dt.type = "datetime-local";
        dt.value = target.at ? toDatetimeLocalValue(target.at) : "";
        dt.addEventListener("change", () => {
          target.at = dt.value ? new Date(dt.value).toISOString() : undefined;
          void this.#persist(wf, schedules);
        });
        row.appendChild(dt);
      } else {
        const time = document.createElement("input");
        time.type = "time";
        time.value = target.timeOfDay ?? "";
        time.addEventListener("change", () => {
          target.timeOfDay = time.value || undefined;
          void this.#persist(wf, schedules);
        });
        row.appendChild(time);
      }

      panel.appendChild(row);
    };

    addRow("Start", bar.start);
    addRow("Stop", bar.stop);

    this.appendChild(panel);
    const closeOnOutside = (ev: MouseEvent) => {
      if (!panel.contains(ev.target as Node)) {
        panel.remove();
        document.removeEventListener("pointerdown", closeOnOutside, true);
      }
    };
    window.setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
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
      // Live-Vorschau der Ressourcen für die neue Position.
      this.#preview = { wfId: wf.id, schedules: this.#dragSchedules(wf, bar, currentLeft, currentRight, mode) };
      this.#repaintResources();
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.style.cursor = "grab";
      this.#dragging = false;
      this.#preview = null;
      // Ein reiner Klick (auch die zwei Klicks eines Doppelklicks für
      // #openTimeEditor) darf keine unnötige PUT auslösen — nur
      // speichern, wenn sich tatsächlich etwas verschoben hat.
      if (currentLeft !== originalLeft || currentRight !== originalRight) {
        const next = this.#dragSchedules(wf, bar, currentLeft, currentRight, mode);
        this.#warnNewBottlenecks(wf, next);
        void this.#persist(wf, next);
      } else {
        this.#repaintResources();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // Liefert die Zeitpläne des Workflows mit der gezogenen Position
  // (start und/oder stop verschoben) — OHNE zu speichern; #startDrag nutzt
  // das für die Live-Vorschau der Ressourcen und speichert erst beim
  // Loslassen. dateIndex/weekday werden aus der absoluten Minute
  // (Tag*1440+Minute) zurückgerechnet — bei "weekly" ändert ein Tageswechsel
  // während des Ziehens (nur in der Wochenansicht möglich) also tatsächlich
  // den Wochentag, bei "once" das Datum, bei "daily" bleibt der Tag dank
  // lockedDateIndex ohnehin unverändert (s. #startDrag).
  #dragSchedules(wf: Workflow, bar: Bar, left: number, right: number, mode: DragMode): Schedule[] {
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
    return schedules;
  }

  // Warnt beim Loslassen, wenn die neuen Zeitpläne Engpässe erzeugen, die es
  // vorher nicht gab (der Nutzer entscheidet — gespeichert wird trotzdem).
  #warnNewBottlenecks(wf: Workflow, next: Schedule[]) {
    const model = this.#model;
    if (!model) return;
    const dates = this.#visibleDates();
    const before = this.#computeTimeline(dates, null);
    const after = this.#computeTimeline(dates, { wfId: wf.id, schedules: next });
    if (!before || !after) return;
    const key = (b: { laneId: string; slotIndex: number }) => `${b.laneId}#${b.slotIndex}`;
    const had = new Set(findBottlenecks(model, before).map(key));
    const fresh = findBottlenecks(model, after).filter((b) => !had.has(key(b)));
    if (fresh.length === 0) return;
    const laneLabel = (id: string) => (id === AUTO_LANE ? "Auto-Pool" : model.hosts.find((h) => h.id === id)?.label ?? id);
    const parts = fresh.slice(0, 3).map((b) => `${laneLabel(b.laneId)} ${this.#slotLabel(dates, b.slotIndex)} (${b.what.join(", ")})`);
    showToast(`⚠ Ressourcen-Engpass durch diese Änderung: ${parts.join(" · ")}${fresh.length > 3 ? ` … (+${fresh.length - 3})` : ""}`);
  }

  // Ziehen auf leerer Fläche einer Workflow-Zeile legt einen neuen Zeitplan
  // (Start+Stop) an — Art laut Auswahl in der Werkzeugleiste. Auf EINEN Tag
  // begrenzt (ein Paar gehört immer zu einem Tag).
  #startCreateDrag(ev: PointerEvent, track: HTMLElement, wf: Workflow, dates: Date[], totalMinutes: number) {
    const target = ev.target as HTMLElement;
    if (ev.button !== 0 || (target !== track && !target.dataset.sep)) return;
    ev.preventDefault();
    const rect = track.getBoundingClientRect();
    const toMinute = (clientX: number) =>
      Math.max(0, Math.min(totalMinutes, snap(((clientX - rect.left) / rect.width) * totalMinutes)));
    const anchor = Math.min(toMinute(ev.clientX), totalMinutes - SNAP_MINUTES);
    const dayIdx = Math.min(dates.length - 1, Math.floor(anchor / DAY_MINUTES));
    const dayStart = dayIdx * DAY_MINUTES;
    const dayEnd = dayStart + DAY_MINUTES;

    const ghost = document.createElement("div");
    ghost.style.cssText =
      `position:absolute;top:${(ROW_HEIGHT_PX - BAR_HEIGHT_PX) / 2}px;height:${BAR_HEIGHT_PX}px;` +
      "background:rgba(91,155,213,0.35);border:1px dashed var(--omp-info);border-radius:3px;pointer-events:none;box-sizing:border-box;" +
      "display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--omp-text);white-space:nowrap;";
    track.appendChild(ghost);
    track.setPointerCapture(ev.pointerId);
    this.#dragging = true;

    let left = anchor;
    let right = anchor + SNAP_MINUTES;
    const draw = () => {
      ghost.style.left = `${(left / totalMinutes) * 100}%`;
      ghost.style.width = `${((right - left) / totalMinutes) * 100}%`;
      ghost.textContent = `${fmtMinutes(left - dayStart)}–${fmtMinutes(right - dayStart)}`;
    };
    draw();

    const pair = (): Schedule[] => this.#buildPair(this.#newKind, dates[dayIdx], left - dayStart, right - dayStart);
    const onMove = (m: PointerEvent) => {
      const cur = Math.max(dayStart, Math.min(dayEnd, toMinute(m.clientX)));
      left = Math.min(anchor, cur);
      right = Math.max(anchor, cur);
      if (right - left < SNAP_MINUTES) {
        if (cur < anchor) left = Math.max(dayStart, right - SNAP_MINUTES);
        else right = Math.min(dayEnd, left + SNAP_MINUTES);
      }
      draw();
      this.#preview = { wfId: wf.id, schedules: [...(wf.definition.schedules ?? []), ...pair()] };
      this.#repaintResources();
    };
    const cleanup = () => {
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", onUp);
      track.removeEventListener("pointercancel", onCancel);
      ghost.remove();
      this.#dragging = false;
      this.#preview = null;
    };
    const onUp = () => {
      const created = pair();
      cleanup();
      const next = [...(wf.definition.schedules ?? []), ...created];
      this.#warnNewBottlenecks(wf, next);
      void this.#persist(wf, next);
    };
    const onCancel = () => {
      cleanup();
      this.#repaintResources();
    };
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onCancel);
  }

  #buildPair(kind: Schedule["kind"], date: Date, startMin: number, stopMin: number): Schedule[] {
    const start: Schedule = { id: crypto.randomUUID(), kind, action: "start" };
    const stop: Schedule = { id: crypto.randomUUID(), kind, action: "stop" };
    if (kind === "once") {
      const a = new Date(date);
      a.setHours(0, startMin, 0, 0);
      const b = new Date(date);
      // 24:00 = Mitternacht des Folgetags
      b.setHours(0, stopMin, 0, 0);
      start.at = a.toISOString();
      stop.at = b.toISOString();
    } else {
      // "daily"/"weekly" kennen kein 24:00 — auf 23:59 begrenzen.
      start.timeOfDay = fmtMinutes(Math.min(startMin, DAY_MINUTES - 1));
      stop.timeOfDay = fmtMinutes(Math.min(stopMin, DAY_MINUTES - 1));
      if (kind === "weekly") {
        start.weekday = date.getDay();
        stop.weekday = date.getDay();
      }
    }
    return [start, stop];
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
          `background:${hasAny ? "var(--omp-info)" : "rgba(255,255,255,0.05)"};`;
        cell.addEventListener("click", () => {
          this.#anchorDate = date;
          this.#viewMode = "day";
          this.#render();
        });
        row.appendChild(cell);
      });

      grid.appendChild(row);
    }

    // Ressourcen je Tag (ungünstigster Zeitpunkt des Tages) — ein Blick
    // über den Monat zeigt, wo Engpässe drohen und wo Platz ist.
    const timeline = this.#computeTimeline(dates, null);
    if (timeline && this.#model) grid.appendChild(this.#renderResources(dates, timeline));

    wrap.appendChild(grid);
    return wrap;
  }
}

customElements.define("omp-scheduler-view", SchedulerView);
