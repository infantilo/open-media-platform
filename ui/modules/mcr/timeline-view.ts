// Zeitplan-Ansicht der Events: Balken je Event über ein Fenster von 1, 3 oder 7 Tagen, Jetzt-Linie, Klick öffnet das Event.
import { t } from "../host.ts";
import { h, segmented } from "./mcr-dom.ts";
import { stateColor } from "./mcr-logic.ts";
import { laneCount, layout, nowPct, ticks, type TlEvent, unscheduled, windowFor } from "./timeline-logic.ts";

const LANE_H = 36; // feste Höhe je Bahn (keine Layout-Sprünge)

export class Timeline {
  readonly el = h("div", { class: "mcr-page" });
  #days = 3;
  #shift = 0;
  #events: TlEvent[] = [];
  #chart = h("div", { class: "mcr-tl" });
  #label = h("span", { class: "mcr-hint", style: "min-width:200px" });
  #timer = 0;

  constructor(private onOpen: (id: string) => void) {
    const nav = (txt: string, title: string, fn: () => void) => {
      const b = h("button", { type: "button", class: "mcr-btn mcr-btn-sm", title, "aria-label": title }, txt);
      b.addEventListener("click", fn);
      return b;
    };
    const step = () => this.#days; // eine Fensterbreite weiter/zurück
    this.el.append(
      h("h2", {}, t("mcr.tab.timeline")),
      h("p", { class: "mcr-sub" }, t("mcr.tl.sub")),
      h("div", { class: "mcr-quick", style: "margin:8px 0;align-items:center" },
        segmented([{ value: "1", label: t("mcr.tl.d1") }, { value: "3", label: t("mcr.tl.d3") }, { value: "7", label: t("mcr.tl.d7") }], String(this.#days), (v) => {
          this.#days = Number(v);
          this.#draw();
        }),
        nav("‹", t("mcr.tl.prev"), () => { this.#shift -= step(); this.#draw(); }),
        nav(t("mcr.tl.today"), t("mcr.tl.today"), () => { this.#shift = 0; this.#draw(); }),
        nav("›", t("mcr.tl.next"), () => { this.#shift += step(); this.#draw(); }),
        this.#label),
      this.#chart);
  }

  setEvents(events: TlEvent[]) {
    this.#events = events;
    this.#draw();
  }

  /** Jetzt-Linie nachführen, solange der Reiter offen ist. */
  start() {
    this.stop();
    this.#timer = setInterval(() => this.#draw(), 30_000) as unknown as number;
  }
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = 0;
  }

  #draw() {
    const now = Date.now();
    const win = windowFor(now, this.#days, this.#shift);
    const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    this.#label.textContent = `${fmt(win.from)} – ${fmt(win.to - 1)}`;
    const bars = layout(this.#events, win);
    const byId = new Map(this.#events.map((e) => [e.id, e]));
    const lanes = Math.max(1, laneCount(bars));
    const axis = h("div", { class: "mcr-tl-axis" }, ...ticks(win).map((k) => h("span", { class: "mcr-tl-tick", "data-major": String(k.major), style: `left:${k.left}%` }, k.label)));
    const grid = h("div", { class: "mcr-tl-grid", style: `height:${lanes * LANE_H}px` },
      ...ticks(win).map((k) => h("i", { class: "mcr-tl-gl", "data-major": String(k.major), style: `left:${k.left}%` })));
    const tf = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "–");
    for (const b of bars) {
      const ev = byId.get(b.id)!;
      const btn = h("button", {
        type: "button", class: "mcr-tl-bar", "data-over": String(b.overlaps), "data-open": String(b.openEnd), "data-cs": String(b.clippedStart), "data-ce": String(b.clippedEnd),
        style: `left:${b.left}%;width:${b.width}%;top:${b.lane * LANE_H + 3}px;--st:${stateColor(ev.state)}`,
        title: `${ev.name}\n${t(`mcr.state.${ev.state}`)}\n${tf(ev.plannedStart)} → ${b.openEnd ? t("mcr.tl.openEnd") : tf(ev.plannedEnd)}${b.overlaps ? `\n${t("mcr.tl.overlap")}` : ""}`,
      }, h("span", {}, ev.name));
      btn.addEventListener("click", () => this.onOpen(b.id));
      grid.append(btn);
    }
    const np = nowPct(win, now);
    if (np !== null) grid.append(h("div", { class: "mcr-tl-now", style: `left:${np}%`, title: t("mcr.tl.now") }));
    const nodate = unscheduled(this.#events);
    const kids: HTMLElement[] = [axis, grid];
    if (!bars.length) kids.push(h("div", { class: "mcr-hint", style: "padding:10px 0" }, t("mcr.tl.empty")));
    if (nodate.length) {
      const chips = nodate.map((e) => {
        const c = h("button", { type: "button", class: "mcr-chip", style: `--st:${stateColor(e.state)}` }, e.name);
        c.addEventListener("click", () => this.onOpen(e.id));
        return c;
      });
      kids.push(h("div", { class: "mcr-tl-nodate" }, h("span", { class: "mcr-hint" }, t("mcr.tl.nodate")), ...chips));
    }
    this.#chart.replaceChildren(...kids);
  }
}
