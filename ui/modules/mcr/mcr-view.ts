// Arbeitsplatz „Hauptkontrollraum“ (UMSETZUNG 106.15): Eventliste, Event-Detail mit Leitungskarten, Vorlagen, Hausformat.
// Aufbau: Karten werden einmal gebaut und danach nur noch in ihren Werten aktualisiert (feste Größen, kein Springen).
import { apiFetch, confirmDialog, dateLocale, features, getLang, showToast, t, whoami } from "../host.ts";
import { hasFeature } from "../../kit/features.ts";
import { promptDialog } from "../../kit/omp-prompt.ts";
import { dateTime, ensureStyle, field, h, input, modal, nextFullHour, note, quickTimes, segmented, toLocalValue } from "./mcr-dom.ts";
import { houseFields, openLineForm } from "./line-form.ts";
import { openMatrix } from "./matrix-view.ts";
import { chainEditor } from "./chain-editor.ts";
import { Timeline } from "./timeline-view.ts";
import { type Stage, type StageType } from "./chain-logic.ts";
import { Wall } from "./wall-view.ts";
import { AlarmHistory } from "./alarm-view.ts";
import { type MonCfg, monitorEditor } from "./monitor-editor.ts";
import { type Member, membersEditor } from "./members-editor.ts";
import {
  avLight, fmtConfidence, fmtMs, fmtVideo, type Graph, type HouseDraft, inputLamp, type LineDraft, lineMode, MODE_COLOR, needsConfirm, nextStep, otherSteps, parseStages, relTime,
  scalePct, STATE_INFO, STATES, stateColor, validateHouse,
} from "./mcr-logic.ts";

type Obj = Record<string, any>;

async function api<T = Obj>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    const res = await apiFetch(`/api/v1/mcr${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {} as T;
    try {
      data = await res.json();
    } catch { /* leer */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } as unknown as T };
  }
}

const errText = (d: Obj): string => (d.problems as string[] | undefined)?.join("\n") || (d.code === "confirmation_required" ? t("mcr.err.confirm") : String(d.error ?? t("mcr.err.generic")));

interface CardRefs {
  root: HTMLElement;
  lamp: HTMLElement;
  inFmt: HTMLElement;
  inSub: HTMLElement;
  houseFmt: HTMLElement;
  wire: HTMLElement;
  val: HTMLElement;
  lbl: HTMLElement;
  needle: HTMLElement;
  conf: HTMLElement;
  measure: HTMLButtonElement;
  adopt: HTMLButtonElement;
  stats: HTMLElement;
  ret: HTMLElement;
  err: HTMLElement;
  modeSeg: HTMLElement;
  sig: string;
}

interface Slot { nodeType?: string; video?: boolean; audio?: boolean; strict?: boolean; ports?: Record<string, string>; env?: Record<string, string>; params?: Record<string, unknown>; maxFrames?: number }
interface Slots { normalizer?: Slot; converter?: Slot; avdelay?: Slot }

class McrView extends HTMLElement {
  #tab: "wall" | "events" | "timeline" | "alarms" | "templates" | "house" = "wall";
  #timeline: Timeline | null = null;
  #alarms: AlarmHistory | null = null;
  #wall: Wall | null = null;
  #events: Obj[] = [];
  #graph: Graph = {};
  #filter = "";
  #sel = "";
  #ev: Obj | null = null;
  #status: Obj | null = null;
  #templates: Obj[] = [];
  #global: Obj | null = null;
  #globalChain: Stage[] = [];
  #stageTypes: StageType[] = [];
  #slots: Slots = {};
  #isAdmin = false;
  #canManage = true;
  #canLive = true;

  /** Darf die Person am Event handeln? Der Server meldet es je Event (`access`); ohne Angabe gelten die globalen Rechte. */
  #can(ev: Obj | null | undefined, what: "test" | "live" | "edit"): boolean {
    const a = ev?.access as Obj | undefined;
    if (a) return !!a[what];
    return what === "edit" ? this.#canManage : this.#canLive;
  }

  /** Zustandswechsel: Geplant ↔ Test bedient die Technik, alles andere die Leitung. */
  #canStep(ev: Obj, to: string): boolean {
    return this.#can(ev, to === "testing" || to === "planned" ? "test" : "live");
  }
  #t1 = 0;
  #t2 = 0;
  #t3 = 0;
  #cards = new Map<string, CardRefs>();
  #railSig = "";
  #mainSig = "";
  #root = h("div", { class: "mcr" });
  #body = h("div", { class: "mcr-body" });
  #clock = h("span", { class: "mcr-clock" });
  #loaded = false;

  connectedCallback() {
    ensureStyle();
    this.style.cssText = "display:block;box-sizing:border-box;width:100%;height:100%;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#init();
    } else this.#start();
  }

  disconnectedCallback() {
    clearInterval(this.#t1);
    clearInterval(this.#t2);
    clearInterval(this.#t3);
    this.#wall?.stop();
  }

  async #init() {
    const w = await whoami();
    this.#isAdmin = !!w.isAdmin || !!w.canConfigure || !w.authRequired;
    // Rechte aus den Funktionsrechten der Person (z. B. Gruppe „hkr“): ohne Recht keine Bedienelemente dafür (der Server prüft ohnehin).
    if (w.authRequired) {
      const f = await features().catch(() => null);
      this.#canManage = this.#isAdmin || hasFeature(f, "mcr.manage");
      this.#canLive = this.#isAdmin || hasFeature(f, "mcr.live");
    }
    this.replaceChildren(this.#root);
    this.#root.replaceChildren(this.#tabsBar(), this.#body);
    await Promise.all([this.#loadEvents(), this.#loadTemplates(), this.#loadGlobal()]);
    const ref = this.getAttribute("focus-ref");
    if (ref) this.#sel = ref;
    this.#paint();
    this.#start();
  }

  #start() {
    clearInterval(this.#t1);
    clearInterval(this.#t2);
    clearInterval(this.#t3);
    this.#t1 = setInterval(() => void this.#pollList(), 5000) as unknown as number;
    this.#t2 = setInterval(() => void this.#pollStatus(), 2000) as unknown as number;
    this.#t3 = setInterval(() => this.#tickClock(), 1000) as unknown as number;
    this.#tickClock();
    if (this.#tab === "wall") this.#wall?.start();
  }

  #tickClock() {
    this.#clock.textContent = new Date().toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ---- Daten ----------------------------------------------------------------------------------------------------------

  async #loadEvents() {
    const r = await api<{ events: Obj[]; lifecycle: Graph }>("GET", "/events");
    if (r.ok) {
      this.#events = r.data.events ?? [];
      this.#graph = r.data.lifecycle ?? {};
    }
  }
  async #loadTemplates() {
    const r = await api<{ templates: Obj[] }>("GET", "/templates");
    if (r.ok) this.#templates = r.data.templates ?? [];
  }
  async #loadGlobal() {
    const r = await api<{ houseFormat: Obj | null; chain?: Stage[]; stageTypes?: StageType[]; slots?: Slots }>("GET", "/settings");
    if (r.ok) {
      this.#global = r.data.houseFormat ?? null;
      this.#globalChain = r.data.chain ?? [];
      this.#stageTypes = r.data.stageTypes ?? [];
      this.#slots = r.data.slots ?? {};
    }
  }
  async #loadEvent() {
    if (!this.#sel) {
      this.#ev = null;
      return;
    }
    const r = await api("GET", `/events/${this.#sel}`);
    this.#ev = r.ok ? r.data : null;
    if (!r.ok && r.status === 404) this.#sel = "";
  }

  async #pollList() {
    await this.#loadEvents();
    if (this.#sel) await this.#loadEvent();
    if (this.#tab === "events") this.#paintEvents(false);
  }

  async #pollStatus() {
    if (this.#tab !== "events" || !this.#ev || (this.#ev.state !== "testing" && this.#ev.state !== "live")) return;
    const r = await api("GET", `/events/${this.#sel}/status`);
    if (r.ok && this.#ev && r.data.eventId === this.#ev.id) {
      this.#status = r.data;
      this.#updateCards();
    }
  }

  // ---- Rahmen ---------------------------------------------------------------------------------------------------------

  #tabsBar(): HTMLElement {
    const tabs = h("div", { class: "mcr-tabs", role: "tablist" });
    const mk = (id: "wall" | "events" | "timeline" | "alarms" | "templates" | "house", label: string) => {
      const b = h("button", { class: "mcr-tab", role: "tab", type: "button", "aria-selected": String(this.#tab === id) }, label);
      b.addEventListener("click", () => {
        this.#tab = id;
        for (const x of Array.from(tabs.querySelectorAll(".mcr-tab"))) x.setAttribute("aria-selected", "false");
        b.setAttribute("aria-selected", "true");
        this.#paint();
      });
      return b;
    };
    tabs.append(mk("wall", t("mcr.tab.wall")), mk("events", t("mcr.tab.events")), mk("timeline", t("mcr.tab.timeline")), mk("alarms", t("mcr.tab.alarms")), ...(this.#canManage ? [mk("templates", t("mcr.tab.templates")), mk("house", t("mcr.tab.house"))] : []), h("span", { class: "mcr-tab-spacer" }), this.#clock);
    return tabs;
  }

  #paint() {
    if (this.#tab !== "wall") this.#wall?.stop();
    if (this.#tab !== "timeline") this.#timeline?.stop();
    if (this.#tab === "wall") this.#paintWall();
    else if (this.#tab === "events") void this.#loadEvent().then(() => this.#paintEvents(true));
    else if (this.#tab === "timeline") this.#paintTimeline();
    else if (this.#tab === "alarms") this.#paintAlarms();
    else if (this.#tab === "templates") this.#paintTemplates();
    else this.#paintHouse();
  }

  #paintTimeline() {
    if (!this.#timeline) {
      this.#timeline = new Timeline((id) => {
        this.#sel = id;
        this.#tab = "events";
        const tabs = this.querySelectorAll(".mcr-tab");
        tabs.forEach((x) => x.setAttribute("aria-selected", "false"));
        tabs[1]?.setAttribute("aria-selected", "true");
        this.#paint();
      });
    }
    this.#timeline.setEvents(this.#events as never);
    this.#body.replaceChildren(this.#timeline.el);
    this.#timeline.start();
  }

  #paintAlarms() {
    const names: Record<string, string> = {};
    for (const e of this.#events) names[e.id] = e.name;
    this.#alarms = new AlarmHistory(names);
    this.#body.replaceChildren(this.#alarms.el);
    void this.#alarms.load();
  }

  #paintWall() {
    if (!this.#wall) {
      this.#wall = new Wall(this.#canLive || this.#canManage, (id) => {
        this.#sel = id;
        this.#tab = "events";
        const tabs = this.querySelectorAll(".mcr-tab");
        tabs.forEach((x) => x.setAttribute("aria-selected", "false"));
        tabs[1]?.setAttribute("aria-selected", "true");
        this.#paint();
      });
    }
    this.#body.replaceChildren(this.#wall.el);
    this.#wall.start();
  }

  // ---- Events ---------------------------------------------------------------------------------------------------------

  #paintEvents(force: boolean) {
    if (this.#body.firstElementChild?.className !== "mcr-split") {
      this.#railSig = "";
      this.#mainSig = "";
      this.#body.replaceChildren(h("div", { class: "mcr-split" }, h("div", { class: "mcr-rail", id: "mcr-rail" }), h("div", { class: "mcr-main", id: "mcr-main" })));
    }
    this.#paintRail(force);
    this.#paintMain(force);
  }

  #visibleEvents(): Obj[] {
    const f = this.#filter;
    const list = this.#events.filter((e) => !f || (f === "open" ? ["planned", "testing", "live", "teardown"].includes(e.state) : e.state === f));
    return list;
  }

  #paintRail(force: boolean) {
    const rail = this.#body.querySelector("#mcr-rail") as HTMLElement;
    const list = this.#visibleEvents();
    const sig = JSON.stringify([this.#filter, this.#sel, list.map((e) => [e.id, e.name, e.state, e.plannedStart, (e.warnings ?? []).length])]);
    if (!force && sig === this.#railSig) return;
    this.#railSig = sig;
    const chips = h("div", { class: "mcr-chips" });
    for (const [v, label] of [["", t("mcr.filter.all")], ["open", t("mcr.filter.open")], ["live", t("mcr.state.live")], ["testing", t("mcr.state.testing")], ["done", t("mcr.state.done")]] as const) {
      const b = h("button", { class: "mcr-chip", type: "button", "aria-pressed": String(this.#filter === v) }, label);
      b.addEventListener("click", () => {
        this.#filter = v;
        this.#paintRail(true);
      });
      chips.append(b);
    }
    const add = h("button", { class: "mcr-btn mcr-btn-primary", type: "button" }, t("mcr.event.new"));
    add.addEventListener("click", () => void this.#newEvent());
    add.style.display = this.#canManage ? "" : "none";
    const listEl = h("div", { class: "mcr-rail-list" });
    const now = Date.now();
    for (const e of list) {
      const st = stateColor(e.state);
      const warns = (e.warnings ?? []).length;
      const card = h("button", { class: "mcr-ev", type: "button", style: `--st:${st}`, "aria-current": String(e.id === this.#sel) },
        h("div", { class: "mcr-ev-name" }, e.name),
        h("div", { class: "mcr-ev-sub" }, h("span", { class: "mcr-pill" }, t(`mcr.state.${e.state}`)), h("span", {}, e.plannedStart ? relTime(e.plannedStart, now, getLang()) : t("mcr.noTime")), warns ? h("span", { class: "mcr-badge", title: t("mcr.warnings") }, String(warns)) : null));
      card.addEventListener("click", () => {
        this.#sel = e.id;
        this.#status = null;
        void this.#loadEvent().then(() => {
          this.#paintRail(true);
          this.#paintMain(true);
          void this.#pollStatus();
        });
      });
      listEl.append(card);
    }
    if (!list.length) listEl.append(h("div", { class: "mcr-hint", style: "padding:14px 6px" }, t("mcr.rail.empty")));
    rail.replaceChildren(h("div", { class: "mcr-rail-head" }, add, chips), listEl);
  }

  #paintMain(force: boolean) {
    const main = this.#body.querySelector("#mcr-main") as HTMLElement;
    const ev = this.#ev;
    if (!ev) {
      this.#mainSig = "";
      this.#cards.clear();
      const btn = h("button", { class: "mcr-btn mcr-btn-primary", type: "button" }, t("mcr.event.new"));
      btn.addEventListener("click", () => void this.#newEvent());
      main.replaceChildren(h("div", { class: "mcr-empty" }, h("div", {}, h("h3", {}, t("mcr.empty.title")), h("p", {}, t("mcr.empty.text"))), this.#canManage ? btn : null));
      return;
    }
    const sig = JSON.stringify([ev.id, ev.name, ev.state, ev.plannedStart, ev.plannedEnd, ev.houseFormat, ev.warnings, (ev.lines ?? []).map((l: Obj) => [l.id, l.name, l.kind, l.transport, l.houseFormat, l.avsync, l.intercom])]);
    if (!force && sig === this.#mainSig) return;
    this.#mainSig = sig;
    this.#cards.clear();
    main.replaceChildren(this.#header(ev), ...this.#warnStrip(ev), this.#grid(ev));
    this.#updateCards();
  }

  #header(ev: Obj): HTMLElement {
    const st = stateColor(ev.state);
    const now = Date.now();
    const next = nextStep(ev.state, this.#graph);
    const rank = STATE_INFO[ev.state as keyof typeof STATE_INFO]?.rank ?? -1;
    const steps = h("div", { class: "mcr-steps", style: `--st:${st}` });
    for (const s of STATES) {
      const r = STATE_INFO[s].rank;
      const d = ev.state === "cancelled" ? "future" : r < rank ? "past" : r === rank ? "now" : "future";
      steps.append(h("div", { class: "mcr-step", "data-s": d, style: `--st:${stateColor(s)}` }, t(`mcr.state.${s}`)));
    }
    const actions = h("div", { class: "mcr-actions" });
    if (next && this.#canStep(ev, next)) {
      const labels: Record<string, string> = { testing: t("mcr.act.test"), live: t("mcr.act.live"), teardown: t("mcr.act.teardown"), done: t("mcr.act.done") };
      const b = h("button", { class: `mcr-btn ${next === "live" ? "mcr-btn-live" : "mcr-btn-primary"}`, type: "button" }, labels[next] ?? next);
      b.addEventListener("click", () => void this.#transition(ev, next));
      actions.append(b);
    }
    for (const to of otherSteps(ev.state, this.#graph).filter((x) => this.#canStep(ev, x))) {
      const b = h("button", { class: "mcr-btn mcr-btn-quiet", type: "button" }, to === "planned" ? t("mcr.act.back") : to === "cancelled" ? t("mcr.act.cancel") : to);
      b.addEventListener("click", () => void this.#transition(ev, to));
      actions.append(b);
    }
    const edit = h("button", { class: "mcr-btn", type: "button", disabled: !["planned", "testing", "live"].includes(ev.state) }, t("mcr.event.edit"));
    edit.addEventListener("click", () => void this.#editEvent(ev));
    if (this.#can(ev, "edit")) actions.append(edit);
    if (this.#can(ev, "edit") && ["planned", "done", "cancelled"].includes(ev.state)) {
      const del = h("button", { class: "mcr-btn mcr-btn-quiet", type: "button" }, t("mcr.event.delete"));
      del.addEventListener("click", () => void this.#deleteEvent(ev));
      actions.append(del);
    }
    const when = ev.plannedStart ? new Date(ev.plannedStart).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" }) : t("mcr.noTime");
    const house = this.#houseSummary(ev);
    const meta = h("div", { class: "mcr-meta" }, h("span", { class: "mcr-pill", style: `--st:${st}` }, t(`mcr.state.${ev.state}`)), h("span", {}, when + (ev.plannedStart ? ` · ${relTime(ev.plannedStart, now, getLang())}` : "")), h("span", {}, `${t("mcr.house")}: ${house}`), ev.owner ? h("span", {}, `${t("mcr.owner")}: ${ev.owner}`) : null);
    return h("div", { class: "mcr-head" }, h("div", {}, h("h1", { class: "mcr-title", title: ev.name }, ev.name), meta), actions, steps);
  }

  /** Hausformat des Events: Vorgabe, vom Event überstimmt (Leitungen mit eigenem Format zählen hier nicht). */
  #houseSummary(ev: Obj): string {
    const g = (this.#global ?? {}) as Obj;
    const e = (ev.houseFormat ?? {}) as Obj;
    const video = e.video ?? g.video;
    const audio = e.audio ?? g.audio;
    const v = video ? fmtVideo({ height: video.height, rate: video.rate, scan: video.scan }) : t("mcr.house.none");
    const a = audio ? `${audio.channels} ch` : "";
    return [v, a].filter(Boolean).join(" · ");
  }

  #warnStrip(ev: Obj): HTMLElement[] {
    const w: string[] = ev.warnings ?? [];
    if (!w.length) return [];
    return [h("div", { class: "mcr-warns" }, ...w.map((x) => note(x, "warn")))];
  }

  #grid(ev: Obj): HTMLElement {
    const grid = h("div", { class: "mcr-grid" });
    for (const l of ev.lines ?? []) grid.append(this.#card(ev, l));
    if (this.#can(ev, "edit") && ["planned", "testing"].includes(ev.state)) {
      const add = h("button", { class: "mcr-add", type: "button" }, h("b", {}, "+"), h("span", {}, t("mcr.line.add")));
      add.addEventListener("click", () => void this.#editLine(ev, null));
      grid.append(add);
      if ((ev.lines ?? []).length) {
        const mx = h("button", { class: "mcr-add", type: "button" }, h("b", {}, "▦"), h("span", {}, t("mcr.mx.open")));
        mx.addEventListener("click", () => void this.#matrix(ev));
        grid.append(mx);
      }
    }
    if (!(ev.lines ?? []).length && !["planned", "testing"].includes(ev.state)) grid.append(note(t("mcr.lines.none")));
    return grid;
  }

  #card(ev: Obj, l: Obj): HTMLElement {
    const root = h("article", { class: "mcr-card", "data-mode": "waiting", "aria-label": l.name });
    const lamp = h("span", { class: "mcr-lamp" });
    const kebab = h("button", { class: "mcr-kebab", type: "button", title: t("mcr.line.menu"), "aria-label": t("mcr.line.menu") }, "⋯");
    kebab.disabled = !["planned", "testing", "live"].includes(ev.state);
    if (!this.#can(ev, "edit")) kebab.style.display = "none";
    kebab.addEventListener("click", () => void this.#lineMenu(ev, l, kebab));
    const head = h("div", { class: "mcr-card-head" }, lamp, h("div", { class: "mcr-card-name", title: l.name }, l.name), h("span", { class: "mcr-kind" }, t(`mcr.kind.${l.kind}`)), kebab);

    const inFmt = h("b", {}, "–");
    const inSub = h("small", {}, t("mcr.in"));
    const houseFmt = h("b", {}, "–");
    const wire = h("div", { class: "mcr-wire" });
    const path = h("div", { class: "mcr-path" }, h("div", { class: "mcr-node" }, inSub, inFmt), wire, h("div", { class: "mcr-node" }, h("small", {}, t("mcr.houseNode")), houseFmt));

    const val = h("div", { class: "mcr-av-val", "data-l": "none" }, "–");
    const lbl = h("div", { class: "mcr-av-lbl" }, t("mcr.av.none"));
    const needle = h("div", { class: "mcr-needle", "data-on": "0" });
    const gauge = h("div", { class: "mcr-gauge", role: "img", "aria-label": t("mcr.av.gauge") }, needle);
    const conf = h("span", { class: "mcr-av-lbl" }, "");
    const measure = h("button", { class: "mcr-btn mcr-btn-sm", type: "button", title: t("mcr.av.measureHint") }, t("mcr.av.measure"));
    measure.addEventListener("click", () => void this.#measure(ev, l));
    const adopt = h("button", { class: "mcr-btn mcr-btn-sm", type: "button", title: t("mcr.av.adoptHint") }, t("mcr.av.adopt"));
    adopt.addEventListener("click", () => void this.#adopt(ev, l));
    const mode = String((l.avsync as Obj | undefined)?.mode ?? "once");
    const modeSeg = segmented([{ value: "off", label: t("mcr.av.off") }, { value: "once", label: t("mcr.av.once"), title: t("mcr.av.onceHint") }, { value: "manual", label: t("mcr.av.manual") }], mode, (v) => void this.#setMode(ev, l, v));
    if (!this.#can(ev, "test")) modeSeg.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const av = h("div", { class: "mcr-av" }, h("div", { class: "mcr-av-top" }, val, lbl), gauge, h("div", { class: "mcr-av-bot" }, measure, adopt, conf, modeSeg));

    const stats = h("div", { class: "mcr-stats" });
    const ret = h("span", { class: "mcr-ret" });
    const err = h("span", { class: "mcr-hint", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1" });
    const foot = h("div", { class: "mcr-foot" }, ret, err);
    root.append(head, path, av, stats, foot);
    this.#cards.set(l.id, { root, lamp, inFmt, inSub, houseFmt, wire, val, lbl, needle, conf, measure, adopt, stats, ret, err, modeSeg, sig: "" });
    return root;
  }

  /** Werte der Karten aus Status und Event aktualisieren (nur Text/Klassen, keine neuen Elemente außer der Stufenleiste). */
  #updateCards() {
    const ev = this.#ev;
    if (!ev) return;
    const st = new Map<string, Obj>();
    for (const s of this.#status?.lines ?? []) st.set(s.lineId, s);
    const running = ev.state === "testing" || ev.state === "live";
    for (const l of ev.lines ?? []) {
      const c = this.#cards.get(l.id);
      if (!c) continue;
      const s = st.get(l.id) ?? {};
      const norm: Obj | undefined = s.normalizer;
      const inp: Obj | undefined = s.input;
      const mode = running ? lineMode(norm) : "waiting";
      c.root.dataset.mode = mode;
      c.lamp.style.setProperty("--c", MODE_COLOR[mode]);
      // Format: Eingang → Haus
      let inV: Obj | undefined;
      try {
        inV = norm?.["normalize.inputFormat"] ? JSON.parse(String(norm["normalize.inputFormat"])).video : undefined;
      } catch { /* leer */ }
      const eff = ev.effectiveHouse?.[l.id];
      c.inFmt.textContent = inV ? fmtVideo({ height: inV.height, rate: inV.rate, scan: inV.interlace_mode ?? inV.scan }) : running ? "–" : this.#transportSummary(l);
      c.inSub.textContent = running ? t("mcr.in") : t("mcr.source");
      c.houseFmt.textContent = eff?.video ? fmtVideo({ height: eff.video.height, rate: eff.video.rate, scan: eff.video.scan }) : t("mcr.house.none");
      // Verbindung: Stufen oder „durchgereicht“
      const stages = parseStages(norm?.["normalize.stages"]);
      const names = [...stages.video, ...stages.audio.map((x) => `${x}`)];
      const wsig = `${mode}|${running}|${names.join(",")}`;
      if (c.sig !== wsig) {
        c.sig = wsig;
        c.wire.style.setProperty("--wc", MODE_COLOR[mode]);
        c.wire.replaceChildren(...(mode === "convert" && names.length ? names.map((n) => h("span", { class: "mcr-stage" }, t(`mcr.stage.${n}`))) : [h("span", { class: "mcr-pass", "data-k": mode }, t(running ? `mcr.pass.${mode}` : "mcr.pass.idle"))]));
      }
      // A/V
      const measured = typeof norm?.["avsync.measuredMs"] === "number" ? (norm["avsync.measuredMs"] as number) : null;
      const appliedMs = typeof norm?.["avsync.appliedMs"] === "number" ? (norm["avsync.appliedMs"] as number) : 0;
      const shown = measured ?? ((l.avsync as Obj | undefined)?.heldMs ?? null);
      const light = avLight(shown);
      c.val.textContent = fmtMs(shown);
      c.val.dataset.l = light;
      const running2 = norm?.["avsync.running"] === "running";
      c.lbl.textContent = running2 ? t("mcr.av.running") : measured === null ? (shown === null ? t("mcr.av.none") : t("mcr.av.held")) : shown! > 0 ? t("mcr.av.early") : shown! < 0 ? t("mcr.av.late") : t("mcr.av.exact");
      c.needle.dataset.on = shown === null ? "0" : "1";
      if (shown !== null) c.needle.style.left = `${scalePct(shown)}%`;
      c.conf.textContent = measured !== null ? `${t("mcr.av.confidence")} ${fmtConfidence(norm?.["avsync.confidence"] as number)}` : appliedMs !== 0 ? t("mcr.av.applied", { ms: fmtMs(appliedMs) }) : "";
      c.measure.disabled = !this.#can(this.#ev, "test") || !running || running2 || mode === "waiting";
      c.adopt.disabled = !this.#can(this.#ev, "test") || !running || measured === null;
      // Statistik des Eingangs
      c.stats.replaceChildren(...this.#statNodes(l, inp));
      // Rückweg
      const rc = (l.intercom as Obj | undefined)?.return;
      c.ret.replaceChildren(...(rc ? [h("i", { style: `--c:${(ev.warnings ?? []).some((w: string) => w.includes(`„${l.name}“`)) ? "var(--omp-cue)" : "var(--omp-preset)"}` }), `${t("mcr.ret.label")}: ${t(`mcr.ret.${rc.mode ?? "mix"}`)}`] : []));
      const msg = String(norm?.["normalize.lastError"] ?? inp?.["contrib.lastError"] ?? s.error ?? "");
      c.err.textContent = msg;
      c.err.title = msg;
    }
  }

  #transportSummary(l: Obj): string {
    const tr = (l.transport ?? {}) as Obj;
    return String(tr.uri ?? tr.url ?? (tr.videoPort ? `UDP ${tr.videoPort}` : t(`mcr.kind.${l.kind}`)));
  }

  #statNodes(l: Obj, inp?: Obj): (Node | string)[] {
    const n = (k: string): number | null => (typeof inp?.[k] === "number" ? (inp[k] as number) : null);
    const br = n("contrib.bitrateKbps");
    if (br === null && !inp) return [t("mcr.stats.none")];
    const loss = n("contrib.lossPermille");
    const rtt = n("contrib.rttMs");
    const out: (Node | string)[] = [];
    if (br !== null) out.push(h("span", {}, t("mcr.stats.bitrate") + " ", h("b", {}, `${Math.round(br)} kbit/s`)));
    if (loss !== null) out.push(h("span", {}, t("mcr.stats.loss") + " ", h("b", {}, `${(loss / 10).toFixed(1)} %`)));
    if (rtt !== null) out.push(h("span", {}, "RTT ", h("b", {}, `${rtt.toFixed(0)} ms`)));
    if (!out.length) out.push(`${t("mcr.input")}: ${String(inp?.["state"] ?? inp?.["contrib.state"] ?? "–")}`);
    void l;
    void inputLamp;
    return out;
  }

  // ---- Aktionen -------------------------------------------------------------------------------------------------------

  async #transition(ev: Obj, to: string) {
    if (ev.state === "planned" && to === "testing") {
      // Vorprüfung: tragen die Hosts alle Rollen des Events? Nur Warnung, der Bediener entscheidet.
      const c = await api<Obj>("GET", `/events/${ev.id}/precheck`);
      if (c.ok && c.data.ok === false) {
        const lines = (c.data.warnings as string[]).filter((x) => !x.startsWith("Hinweis"));
        const text = `${t("mcr.cap.warn", { need: Number(c.data.needCores).toFixed(1), free: Number(c.data.freeCores).toFixed(1) })}\n\n${lines.join("\n")}`;
        if (!(await confirmDialog(text, { confirmLabel: t("mcr.cap.startAnyway") }))) return;
      }
    }
    if (needsConfirm(ev.state, to)) {
      const ok = await confirmDialog(t(`mcr.confirm.${to}`, { name: ev.name }), { confirmLabel: t("mcr.confirmBtn") });
      if (!ok) return;
    }
    const r = await api("POST", `/events/${ev.id}/transition`, { to, confirm: true });
    if (!r.ok) {
      showToast(errText(r.data));
      return;
    }
    await this.#pollList();
    this.#paintEvents(true);
    void this.#pollStatus();
  }

  async #deleteEvent(ev: Obj) {
    if (!(await confirmDialog(t("mcr.confirm.delete", { name: ev.name }), { confirmLabel: t("mcr.event.delete") }))) return;
    const r = await api("DELETE", `/events/${ev.id}`);
    if (!r.ok) return showToast(errText(r.data));
    this.#sel = "";
    this.#ev = null;
    await this.#loadEvents();
    this.#paintEvents(true);
  }

  async #newEvent(templateId = "") {
    const name = input("", { placeholder: t("mcr.event.namePlaceholder") });
    const tpl = h("select", {}) as HTMLSelectElement;
    tpl.append(h("option", { value: "" }, t("mcr.event.noTemplate")), ...this.#templates.map((x) => h("option", { value: x.id }, `${x.name} (${(x.lines ?? []).length})`)));
    tpl.value = templateId;
    const start = dateTime(toLocalValue(nextFullHour()));
    const end = dateTime("");
    const startQuick = quickTimes(start, [
      { label: t("mcr.time.now"), at: () => new Date() },
      { label: t("mcr.time.nextHour"), at: () => nextFullHour() },
      { label: t("mcr.time.today20"), at: () => { const d = new Date(); d.setHours(20, 0, 0, 0); return d; } },
      { label: t("mcr.time.tomorrow"), at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d; } },
    ]);
    const endQuick = quickTimes(end, [1, 2, 3].map((hh) => ({ label: t("mcr.time.afterStart", { h: hh }), at: () => new Date((Date.parse(start.value) || Date.now()) + hh * 3600000) })));
    const body = h("div", { class: "mcr-form" }, field(t("mcr.f.name"), name), field(t("mcr.event.template"), tpl, t("mcr.event.templateHint")),
      h("div", { class: "mcr-form-grid" }, h("div", {}, field(t("mcr.event.start"), start), startQuick), h("div", {}, field(t("mcr.event.end"), end, t("mcr.event.endHint")), endQuick)));
    const made = await modal<Obj>(t("mcr.event.new"), body, {
      save: t("mcr.event.create"),
      onSave: async () => {
        if (!name.value.trim()) throw new Error(t("mcr.err.line.name"));
        const r = await api("POST", "/events", { name: name.value.trim(), templateId: tpl.value, plannedStart: start.value ? new Date(start.value).toISOString() : undefined, plannedEnd: end.value ? new Date(end.value).toISOString() : undefined });
        if (!r.ok) throw new Error(errText(r.data));
        return r.data;
      },
    });
    if (!made) return;
    this.#sel = made.id;
    await this.#loadEvents();
    await this.#loadEvent();
    this.#paintEvents(true);
  }

  async #editEvent(ev: Obj) {
    const name = input(ev.name);
    const toLocal = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
    const start = dateTime(toLocal(ev.plannedStart));
    const end = dateTime(toLocal(ev.plannedEnd));
    const own = h("input", { type: "checkbox" }) as HTMLInputElement;
    own.checked = !!ev.houseFormat && Object.keys(ev.houseFormat).length > 0;
    const hf = houseFields(ev.houseFormat);
    const hbox = h("div", {}, hf.el);
    hbox.style.display = own.checked ? "" : "none";
    own.addEventListener("change", () => (hbox.style.display = own.checked ? "" : "none"));
    const chain = chainEditor(ev.chain as Stage[] | null | undefined, this.#stageTypes, { canInherit: true, inheritHint: t("mcr.chain.eventHint") });
    const mayMembers = ev.access ? !!(ev.access as Obj).members : this.#canManage;
    const members = membersEditor((ev.members ?? []) as Member[]);
    const mon = monitorEditor(ev.monitoring as MonCfg | null | undefined, { withReactions: true, lines: (ev.lines ?? []).map((l: Obj) => ({ id: l.id, name: l.name })) });
    const body = h("div", { class: "mcr-form" }, field(t("mcr.f.name"), name), h("div", { class: "mcr-form-grid" }, field(t("mcr.event.start"), start), field(t("mcr.event.end"), end)),
      h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.chain.title")), chain.el),
      h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.mon.title")), mon.el),
      ...(mayMembers ? [h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.members.title")), members.el)] : []),
      h("div", { class: "mcr-fieldset" }, h("label", { class: "mcr-sw" }, own, t("mcr.event.ownHouse")), note(t("mcr.event.houseHint")), hbox));
    const out = await modal<Obj>(t("mcr.event.edit"), body, {
      wide: true,
      onSave: async () => {
        const upd: Obj = { name: name.value.trim(), plannedStart: start.value ? new Date(start.value).toISOString() : undefined, plannedEnd: end.value ? new Date(end.value).toISOString() : undefined, owner: ev.owner, ownerGroup: ev.ownerGroup, houseFormat: null, chain: chain.read(), monitoring: mon.read() };
        if (own.checked) {
          const hd = hf.read();
          const bad = validateHouse(hd);
          if (bad.length) throw new Error(bad.map((k) => t(`mcr.err.house.${k}`)).join("\n"));
          upd.houseFormat = hd;
        }
        const r = await api("PUT", `/events/${ev.id}`, upd);
        if (!r.ok) throw new Error(errText(r.data));
        if (mayMembers) {
          const mr = await api("PUT", `/events/${ev.id}/members`, { members: members.read() });
          if (!mr.ok) throw new Error(errText(mr.data));
        }
        return r.data;
      },
    });
    if (out) await this.#reload();
  }

  async #reload() {
    await this.#loadEvents();
    await this.#loadEvent();
    this.#paintEvents(true);
  }

  async #editLine(ev: Obj, l: Obj | null) {
    const others = (ev.lines ?? []).filter((x: Obj) => !l || x.id !== l.id).map((x: Obj) => ({ id: x.id, name: x.name }));
    const out = await openLineForm(l as LineDraft | null, others, { structureLocked: ev.state === "live", stageTypes: this.#stageTypes });
    if (!out) return;
    const lines: Obj[] = (ev.lines ?? []).map((x: Obj) => (l && x.id === l.id ? { ...x, ...out } : x));
    if (!l) lines.push(out as Obj);
    const r = await api("PUT", `/events/${ev.id}`, { name: ev.name, plannedStart: ev.plannedStart, plannedEnd: ev.plannedEnd, owner: ev.owner, ownerGroup: ev.ownerGroup, houseFormat: ev.houseFormat ?? null, chain: ev.chain ?? null, monitoring: ev.monitoring ?? null, lines });
    if (!r.ok) return showToast(errText(r.data));
    await this.#reload();
  }

  async #matrix(ev: Obj) {
    const out = await openMatrix((ev.lines ?? []) as Obj[] as any[]);
    if (!out) return;
    const r = await api("PUT", `/events/${ev.id}`, { name: ev.name, plannedStart: ev.plannedStart, plannedEnd: ev.plannedEnd, owner: ev.owner, ownerGroup: ev.ownerGroup, houseFormat: ev.houseFormat ?? null, chain: ev.chain ?? null, monitoring: ev.monitoring ?? null, lines: out });
    if (!r.ok) return showToast(errText(r.data));
    await this.#reload();
  }

  async #lineMenu(ev: Obj, l: Obj, anchor: HTMLElement) {
    document.querySelectorAll(".mcr-menu").forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const menu = h("div", { class: "mcr-menu", style: `position:fixed;z-index:2400;top:${r.bottom + 4}px;left:${Math.max(8, r.right - 170)}px;width:170px;background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:8px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5)` });
    const item = (label: string, fn: () => void, danger = false) => {
      const b = h("button", { type: "button", style: `display:block;width:100%;text-align:left;background:none;border:0;padding:8px 10px;border-radius:5px;color:${danger ? "var(--omp-error)" : "var(--omp-text)"};font:inherit;cursor:pointer` }, label);
      b.addEventListener("mouseenter", () => (b.style.background = "rgba(255,255,255,.06)"));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
      b.addEventListener("click", () => {
        menu.remove();
        fn();
      });
      return b;
    };
    menu.append(item(t("mcr.line.edit"), () => void this.#editLine(ev, l)));
    if (ev.state !== "live") menu.append(item(t("mcr.line.remove"), () => void this.#removeLine(ev, l), true));
    document.body.append(menu);
    const off = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", off, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  }

  async #removeLine(ev: Obj, l: Obj) {
    if (!(await confirmDialog(t("mcr.confirm.removeLine", { name: l.name }), { confirmLabel: t("mcr.line.remove") }))) return;
    const lines = (ev.lines ?? []).filter((x: Obj) => x.id !== l.id);
    const r = await api("PUT", `/events/${ev.id}`, { name: ev.name, plannedStart: ev.plannedStart, plannedEnd: ev.plannedEnd, owner: ev.owner, ownerGroup: ev.ownerGroup, houseFormat: ev.houseFormat ?? null, chain: ev.chain ?? null, monitoring: ev.monitoring ?? null, lines });
    if (!r.ok) return showToast(errText(r.data));
    await this.#reload();
  }

  async #measure(ev: Obj, l: Obj) {
    const r = await api("POST", `/events/${ev.id}/lines/${l.id}/measure`, { seconds: 10 });
    if (!r.ok) showToast(errText(r.data));
    else showToast(t("mcr.av.started"));
    void this.#pollStatus();
  }

  async #putAvsync(ev: Obj, l: Obj, patch: Obj) {
    const cur = { ...((l.avsync as Obj | undefined) ?? {}), ...patch };
    const r = await api("PUT", `/events/${ev.id}/lines/${l.id}/avsync`, cur);
    if (!r.ok) {
      showToast(errText(r.data));
      return false;
    }
    l.avsync = cur;
    await this.#loadEvent();
    this.#mainSig = JSON.stringify(this.#ev);
    void this.#pollStatus();
    return true;
  }

  async #adopt(ev: Obj, l: Obj) {
    const m = this.#status?.lines?.find((x: Obj) => x.lineId === l.id)?.normalizer?.["avsync.measuredMs"];
    if (typeof m !== "number") return;
    if (await this.#putAvsync(ev, l, { mode: "once", heldMs: m })) showToast(t("mcr.av.adopted", { ms: fmtMs(m) }));
  }

  async #setMode(ev: Obj, l: Obj, mode: string) {
    if (mode === "manual") {
      const v = await promptDialog(t("mcr.av.manualPrompt"), { initial: String((l.avsync as Obj | undefined)?.manualMs ?? 0), okLabel: t("mcr.apply") });
      if (v === null) return this.#paintMain(true);
      const ms = Number(v.replace(",", "."));
      if (!Number.isFinite(ms)) {
        showToast(t("mcr.av.manualBad"));
        return this.#paintMain(true);
      }
      await this.#putAvsync(ev, l, { mode: "manual", manualMs: ms });
    } else {
      if (ev.state === "live" && !(await confirmDialog(t("mcr.av.liveChange"), { confirmLabel: t("mcr.confirmBtn") }))) return this.#paintMain(true);
      await this.#putAvsync(ev, l, { mode });
    }
  }

  // ---- Vorlagen -------------------------------------------------------------------------------------------------------

  #paintTemplates() {
    const page = h("div", { class: "mcr-page" });
    const add = h("button", { class: "mcr-btn mcr-btn-primary", type: "button" }, t("mcr.tpl.new"));
    add.addEventListener("click", () => void this.#editTemplate(null));
    page.append(h("div", { style: "display:flex;align-items:flex-start;gap:16px;margin-bottom:6px" }, h("div", { style: "flex:1" }, h("h2", {}, t("mcr.tab.templates")), h("p", { class: "mcr-sub" }, t("mcr.tpl.sub"))), add));
    const grid = h("div", { class: "mcr-tpl-grid" });
    for (const tp of this.#templates) {
      const chips = h("div", { class: "mcr-tpl-lines" }, ...(tp.lines ?? []).map((l: Obj) => h("span", { class: "mcr-lchip" }, l.name, h("em", {}, t(`mcr.kind.${l.kind}`)))));
      if (!(tp.lines ?? []).length) chips.append(h("span", { class: "mcr-hint" }, t("mcr.tpl.noLines")));
      const use = h("button", { class: "mcr-btn mcr-btn-sm mcr-btn-primary", type: "button" }, t("mcr.tpl.use"));
      use.addEventListener("click", () => void this.#eventFromTemplate(tp));
      const edit = h("button", { class: "mcr-btn mcr-btn-sm", type: "button" }, t("mcr.tpl.edit"));
      edit.addEventListener("click", () => void this.#editTemplate(tp));
      const del = h("button", { class: "mcr-btn mcr-btn-sm mcr-btn-quiet", type: "button" }, t("mcr.tpl.delete"));
      del.addEventListener("click", () => void this.#deleteTemplate(tp));
      grid.append(h("article", { class: "mcr-tpl" }, h("div", {}, h("h3", {}, tp.name), tp.description ? h("div", { class: "mcr-hint" }, tp.description) : null), chips, h("div", { class: "mcr-foot" }, use, edit, del)));
    }
    if (!this.#templates.length) grid.append(note(t("mcr.tpl.empty")));
    page.append(grid);
    this.#body.replaceChildren(page);
  }

  async #eventFromTemplate(tp: Obj) {
    this.#tab = "events";
    (this.querySelectorAll(".mcr-tab")[1] as HTMLElement | undefined)?.click();
    await this.#newEvent(tp.id);
  }

  async #deleteTemplate(tp: Obj) {
    if (!(await confirmDialog(t("mcr.confirm.deleteTpl", { name: tp.name }), { confirmLabel: t("mcr.tpl.delete") }))) return;
    const r = await api("DELETE", `/templates/${tp.id}`);
    if (!r.ok) return showToast(errText(r.data));
    await this.#loadTemplates();
    this.#paintTemplates();
  }

  async #editTemplate(tp: Obj | null) {
    let lines: Obj[] = [...(tp?.lines ?? [])];
    const name = input(tp?.name ?? "");
    const desc = input(tp?.description ?? "");
    const list = h("div", { style: "display:flex;flex-wrap:wrap;gap:8px" });
    const redraw = () => {
      list.replaceChildren(...lines.map((l, i) => {
        const chip = h("span", { class: "mcr-lchip", style: "display:inline-flex;align-items:center;gap:8px;padding:4px 8px" }, l.name, h("em", {}, t(`mcr.kind.${l.kind}`)));
        const ed = h("button", { class: "mcr-btn mcr-btn-sm mcr-btn-quiet", type: "button" }, t("mcr.tpl.edit"));
        ed.addEventListener("click", async () => {
          const o = await openLineForm(l as LineDraft, lines.filter((_, j) => j !== i).map((x) => ({ id: x.id ?? x.name, name: x.name })), { stageTypes: this.#stageTypes });
          if (o) {
            lines[i] = o as Obj;
            redraw();
          }
        });
        const rm = h("button", { class: "mcr-btn mcr-btn-sm mcr-btn-quiet", type: "button", "aria-label": t("mcr.line.remove") }, "✕");
        rm.addEventListener("click", () => {
          lines = lines.filter((_, j) => j !== i);
          redraw();
        });
        chip.append(ed, rm);
        return chip;
      }));
      if (!lines.length) list.append(h("span", { class: "mcr-hint" }, t("mcr.tpl.noLines")));
    };
    redraw();
    const addBtn = h("button", { class: "mcr-btn mcr-btn-sm", type: "button" }, t("mcr.line.add"));
    addBtn.addEventListener("click", async () => {
      const o = await openLineForm(null, lines.map((x) => ({ id: x.id ?? x.name, name: x.name })), { stageTypes: this.#stageTypes });
      if (o) {
        lines.push(o as Obj);
        redraw();
      }
    });
    const body = h("div", { class: "mcr-form" }, field(t("mcr.f.name"), name), field(t("mcr.tpl.desc"), desc), h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.tpl.lines")), list, addBtn));
    const out = await modal<Obj>(tp ? t("mcr.tpl.edit") : t("mcr.tpl.new"), body, {
      wide: true,
      onSave: async () => {
        if (!name.value.trim()) throw new Error(t("mcr.err.line.name"));
        const payload = { name: name.value.trim(), description: desc.value.trim(), lines, houseFormat: tp?.houseFormat ?? null };
        const r = tp ? await api("PUT", `/templates/${tp.id}`, payload) : await api("POST", "/templates", payload);
        if (!r.ok) throw new Error(errText(r.data));
        return r.data;
      },
    });
    if (out) {
      await this.#loadTemplates();
      this.#paintTemplates();
    }
  }

  /** Zugelassene Node-Typen der Kette (nur Administratoren): neue Microservices werden hier eingetragen. */
  #typesEditor(): HTMLElement {
    let rows: StageType[] = this.#stageTypes.map((x) => ({ ...x }));
    const list = h("div", { class: "mcr-chain-params" });
    const out = h("div", { class: "mcr-hint", "aria-live": "polite", style: "min-height:18px" });
    const draw = () => {
      list.replaceChildren(...rows.map((r, i) => {
        const nt = input(r.nodeType, { placeholder: t("mcr.chain.typeNode") });
        nt.addEventListener("input", () => (r.nodeType = nt.value.trim()));
        const lb = input(r.label ?? "", { placeholder: t("mcr.chain.label") });
        lb.addEventListener("input", () => (r.label = lb.value || undefined));
        const cb = (k: "video" | "audio", label: string) => {
          const c = h("input", { type: "checkbox" }) as HTMLInputElement;
          c.checked = r[k];
          c.addEventListener("change", () => (r[k] = c.checked));
          return h("label", { class: "mcr-sw" }, c, label);
        };
        const del = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", "aria-label": t("mcr.chain.remove") }, "✕");
        del.addEventListener("click", () => {
          rows.splice(i, 1);
          draw();
        });
        return h("div", { class: "mcr-chain-head" }, nt, lb, cb("video", t("mcr.chain.typeVideo")), cb("audio", t("mcr.chain.typeAudio")), del);
      }));
    };
    draw();
    const add = h("button", { type: "button", class: "mcr-btn mcr-btn-sm", disabled: !this.#isAdmin }, `+ ${t("mcr.chain.addType")}`);
    add.addEventListener("click", () => {
      rows.push({ nodeType: "", video: true, audio: false });
      draw();
    });
    const save = h("button", { type: "button", class: "mcr-btn mcr-btn-primary", disabled: !this.#isAdmin }, t("mcr.save"));
    save.addEventListener("click", async () => {
      rows = rows.filter((r) => r.nodeType);
      const r = await api("PUT", "/settings", { stageTypes: rows });
      out.style.color = r.ok ? "var(--omp-preset)" : "var(--omp-error)";
      out.textContent = r.ok ? t("mcr.chain.saved") : errText(r.data);
      if (r.ok) await this.#loadGlobal();
    });
    return h("div", { class: "mcr-form" }, h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.chain.types")), note(t("mcr.chain.typesHint")), list, h("div", { class: "mcr-quick" }, add), h("div", { style: "display:flex;gap:12px;align-items:center" }, save, out)));
  }

  /** Austauschbare Funktionen (106.13h): Node-Typ für Normalizer, Converter und A/V-Delay (nur Administratoren). */
  #slotsEditor(): HTMLElement {
    const cur: Slots = JSON.parse(JSON.stringify(this.#slots));
    const out = h("div", { class: "mcr-hint", "aria-live": "polite", style: "min-height:18px" });
    const slotErrors = new Set<HTMLElement>(); // Felder mit ungültiger Eingabe: Speichern bleibt gesperrt
    const row = (key: keyof Slots, label: string, withKinds: boolean) => {
      const s = (cur[key] ??= { nodeType: "" });
      const nt = input(s.nodeType ?? "", { placeholder: withKinds ? t("mcr.slots.internal") : t("mcr.slots.typePh") });
      nt.disabled = !this.#isAdmin;
      nt.addEventListener("input", () => (s.nodeType = nt.value.trim()));
      const cb = (k: "video" | "audio" | "strict", lbl: string, title?: string) => {
        const c = h("input", { type: "checkbox" }) as HTMLInputElement;
        c.checked = !!s[k];
        if (title) c.title = title;
        c.disabled = !this.#isAdmin;
        c.addEventListener("change", () => (s[k] = c.checked));
        return h("label", { class: "mcr-sw" }, c, lbl);
      };
      const port = (k: string, ph: string) => {
        const i = input(s.ports?.[k] ?? "", { placeholder: ph });
        i.disabled = !this.#isAdmin;
        i.title = t("mcr.slots.portsHint");
        i.addEventListener("input", () => {
          s.ports = { ...(s.ports ?? {}), [k]: i.value.trim() };
          if (!i.value.trim()) delete s.ports[k];
        });
        return i;
      };
      const ports = withKinds ? h("div", { class: "mcr-chain-head", style: "display:grid;grid-template-columns:260px repeat(4,minmax(0,1fr));gap:6px;align-items:center" }, h("span", { class: "mcr-hint" }, t("mcr.slots.ports")), port("videoIn", "Receiver 1"), port("videoOut", "Sender 1"), port("audioIn", "Receiver 2"), port("audioOut", "Sender 2")) : null;
      // Erweitert: Start-Umgebung-Vorlage (env), Start-Parameter (params) als JSON-Objekt, Bildobergrenze des Delay-Nodes.
      const json = (k: "env" | "params", ph: string) => {
        const i = input(s[k] && Object.keys(s[k]!).length ? JSON.stringify(s[k]) : "", { placeholder: ph });
        i.disabled = !this.#isAdmin;
        i.title = t(`mcr.slots.${k}Hint`);
        i.addEventListener("input", () => {
          const txt = i.value.trim();
          if (!txt) {
            delete s[k];
            slotErrors.delete(i);
            i.removeAttribute("aria-invalid");
            return;
          }
          try {
            const v = JSON.parse(txt);
            if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("object");
            (s as Record<string, unknown>)[k] = v;
            slotErrors.delete(i);
            i.removeAttribute("aria-invalid");
          } catch {
            slotErrors.add(i);
            i.setAttribute("aria-invalid", "true");
          }
        });
        return i;
      };
      const maxF = key === "avdelay" ? input(s.maxFrames ?? "", { placeholder: "25", inputmode: "numeric" }) : null;
      if (maxF) {
        maxF.disabled = !this.#isAdmin;
        maxF.title = t("mcr.slots.maxFramesHint");
        maxF.addEventListener("input", () => {
          const n = Number(maxF.value);
          if (!maxF.value.trim()) delete s.maxFrames;
          else if (Number.isInteger(n) && n >= 1 && n <= 250) s.maxFrames = n;
          else return void (slotErrors.add(maxF), maxF.setAttribute("aria-invalid", "true"));
          slotErrors.delete(maxF);
          maxF.removeAttribute("aria-invalid");
        });
      }
      const adv = withKinds ? h("details", { class: "mcr-adv" }, h("summary", {}, t("mcr.slots.advanced")),
        h("div", { class: "mcr-chain-head" }, h("span", { style: "min-width:260px", class: "mcr-hint" }, t("mcr.slots.env")), json("env", '{"OMP_WIDTH":"{width}"}')),
        h("div", { class: "mcr-chain-head" }, h("span", { style: "min-width:260px", class: "mcr-hint" }, t("mcr.slots.params")), json("params", '{"delay.slewPermille":5}')),
        ...(maxF ? [h("div", { class: "mcr-chain-head" }, h("span", { style: "min-width:260px", class: "mcr-hint" }, t("mcr.slots.maxFrames")), maxF)] : [])) : null;
      return h("div", {}, h("div", { class: "mcr-chain-head" }, h("span", { style: "min-width:260px" }, label), nt, ...(withKinds ? [cb("video", t("mcr.chain.typeVideo")), cb("audio", t("mcr.chain.typeAudio")), ...(key === "converter" ? [cb("strict", t("mcr.slots.strict"), t("mcr.slots.strictHint"))] : [])] : [])), ports, adv);
    };
    const save = h("button", { type: "button", class: "mcr-btn mcr-btn-primary", disabled: !this.#isAdmin }, t("mcr.save"));
    save.addEventListener("click", async () => {
      if (slotErrors.size) {
        out.style.color = "var(--omp-error)";
        out.textContent = t("mcr.slots.invalid");
        return;
      }
      const r = await api("PUT", "/settings", { slots: cur });
      out.style.color = r.ok ? "var(--omp-preset)" : "var(--omp-error)";
      out.textContent = r.ok ? t("mcr.slots.saved") : errText(r.data);
      if (r.ok) await this.#loadGlobal();
    });
    return h("div", { class: "mcr-form", style: "margin-top:18px" }, h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.slots.title")), note(t("mcr.slots.hint")), note(t("mcr.slots.override")),
      h("div", { class: "mcr-chain-params" }, row("normalizer", t("mcr.slots.normalizer"), false), row("converter", t("mcr.slots.converter"), true), row("avdelay", t("mcr.slots.avdelay"), true)),
      h("div", { style: "display:flex;gap:12px;align-items:center" }, save, out)));
  }

  // ---- Hausformat -----------------------------------------------------------------------------------------------------

  #paintHouse() {
    const hf = houseFields(this.#global as HouseDraft | null);
    const page = h("div", { class: "mcr-page" });
    const save = h("button", { class: "mcr-btn mcr-btn-primary", type: "button", disabled: !this.#isAdmin }, t("mcr.save"));
    const out = h("div", { class: "mcr-hint", "aria-live": "polite", style: "min-height:18px" });
    save.addEventListener("click", async () => {
      const hd = hf.read();
      const bad = validateHouse(hd);
      if (bad.length) {
        out.textContent = bad.map((k) => t(`mcr.err.house.${k}`)).join(" · ");
        out.style.color = "var(--omp-error)";
        return;
      }
      const r = await api("PUT", "/settings", { houseFormat: Object.keys(hd).length ? hd : null });
      out.style.color = r.ok ? "var(--omp-preset)" : "var(--omp-error)";
      out.textContent = r.ok ? t("mcr.house.saved") : errText(r.data);
      if (r.ok) await this.#loadGlobal();
    });
    const chain = chainEditor(this.#globalChain, this.#stageTypes, { canInherit: false });
    const cout = h("div", { class: "mcr-hint", "aria-live": "polite", style: "min-height:18px" });
    const csave = h("button", { class: "mcr-btn mcr-btn-primary", type: "button", disabled: !this.#isAdmin }, t("mcr.save"));
    csave.addEventListener("click", async () => {
      try {
        const r = await api("PUT", "/settings", { chain: chain.read() ?? [] });
        cout.style.color = r.ok ? "var(--omp-preset)" : "var(--omp-error)";
        cout.textContent = r.ok ? t("mcr.chain.saved") : errText(r.data);
        if (r.ok) await this.#loadGlobal();
      } catch (e) {
        cout.style.color = "var(--omp-error)";
        cout.textContent = String((e as Error).message);
      }
    });
    const types = this.#typesEditor();
    const slots = this.#slotsEditor();
    page.append(h("h2", {}, t("mcr.tab.house")), h("p", { class: "mcr-sub" }, t("mcr.house.sub")), h("div", { class: "mcr-form" }, h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.house.global")), hf.el), h("div", { style: "display:flex;gap:12px;align-items:center" }, save, out), this.#isAdmin ? null : note(t("mcr.house.adminOnly"))),
      h("div", { class: "mcr-form", style: "margin-top:18px" }, h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.chain.global")), note(t("mcr.chain.globalHint")), chain.el, h("div", { style: "display:flex;gap:12px;align-items:center" }, csave, cout)), slots, types));
    this.#body.replaceChildren(page);
  }
}

if (!customElements.get("omp-mcr-view")) customElements.define("omp-mcr-view", McrView);
