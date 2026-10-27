// Zeitleiste (Admin → Zeitleiste): "Was hat sich um 14:02 geändert?" auf einer einzigen Zeitachse.
//   • Balken      — Ereignisse des Zeitraums, rot/gelb/blau nach schlimmster Stufe; Klick oder Regler wählt einen Zeitpunkt
//   • Zustand     — was zu diesem Zeitpunkt gestört war (aus den aufgezeichneten Wechseln) und was sich kurz davor geändert hat
//   • Liste       — Störungen, Marker, Änderungen (Bedienungen, Workflows, Verbindungen), Betrieb und Fehler-Logs chronologisch
import { t } from "./i18n.ts";
import { apiFetch, connectionMonitor } from "./connection.ts";
import type { Resolvers } from "./audit-logic.ts";
import {
  bins,
  categoryOf,
  changesBefore,
  DEFAULT_CATS,
  describeItem,
  problemsAt,
  TL_CATS,
  type TLCat,
  type TLItem,
  timelineUrl,
  type WindowId,
  WINDOWS,
  worstLevel,
} from "./timeline-logic.ts";

export interface TimelineContext {
  nodes: { id: string; label: string; instanceId?: string }[];
  workflows: { id: string; name: string }[];
  processes: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

const BIN_COUNT = 72;
const BEFORE_MS = 5 * 60_000;
const COLOR = { error: "var(--omp-error)", warn: "#e0a020", info: "var(--omp-accent, #19d3f3)" };
const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
const CARD = "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:8px;padding:10px 12px;margin-bottom:10px;";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function tryT(key: string): string | undefined {
  const v = t(key as never);
  return v === key ? undefined : v;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export class TimelinePanel {
  readonly el: HTMLElement;
  #ctx: TimelineContext = { nodes: [], workflows: [], processes: [], groups: [] };
  #window: WindowId = "6h";
  #operate = false;
  #cats = new Set<TLCat>(DEFAULT_CATS);
  #items: TLItem[] = [];
  #from = 0;
  #until = 0;
  #truncated = false;
  #at: number | null = null; // gewählter Zeitpunkt
  #loading = false;
  #failed = "";
  #seq = 0;
  #debounce: number | undefined;
  #listening = false;
  #controls = el("div", "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;");
  #axis = el("div");
  #state = el("div");
  #list = el("div");

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:1000px;");
    const title = el("span", "", t("tl.title"));
    title.className = "omp-h1";
    this.el.append(title, el("div", DIM + "margin:4px 0 10px;", t("tl.hint")), this.#controls, this.#axis, this.#state, this.#list);
    this.#buildControls();
  }

  setContext(c: TimelineContext) {
    this.#ctx = c;
    this.#renderAll();
  }

  /** Beim Anzeigen des Tabs: lädt und hört auf neue Ereignisse, solange das Panel im Dokument hängt. */
  start() {
    void this.refresh();
    if (this.#listening) return;
    this.#listening = true;
    const onMsg = (ev: Event) => {
      if (!this.el.isConnected) {
        connectionMonitor.removeEventListener("sse-message", onMsg);
        this.#listening = false;
        return;
      }
      try {
        const type = (JSON.parse((ev as CustomEvent<string>).detail) as { type: string }).type;
        if (type === "timeline.appended" || type === "instance.crashed" || type === "audit.appended" || type === "lost-events") this.#soon();
      } catch { /* kein JSON */ }
    };
    connectionMonitor.addEventListener("sse-message", onMsg);
  }

  #soon() {
    window.clearTimeout(this.#debounce);
    this.#debounce = window.setTimeout(() => void this.refresh(), 1000);
  }

  async refresh() {
    const seq = ++this.#seq;
    this.#loading = true;
    const ms = WINDOWS.find((w) => w.id === this.#window)!.ms;
    const until = Date.now() + 60_000;
    const from = until - ms;
    this.#renderAll();
    try {
      const res = await apiFetch(timelineUrl(from, until, this.#operate));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: TLItem[]; truncated: boolean };
      if (seq !== this.#seq) return;
      this.#items = data.items ?? [];
      this.#truncated = !!data.truncated;
      this.#from = from;
      this.#until = until;
      this.#failed = "";
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#failed = String((e as Error).message ?? e);
    }
    this.#loading = false;
    this.#renderAll();
  }

  #buildControls() {
    const c = this.#controls;
    c.replaceChildren();
    const win = el("select");
    for (const w of WINDOWS) {
      const o = el("option", "", t(`tl.window.${w.id}` as never));
      o.value = w.id;
      o.selected = w.id === this.#window;
      win.append(o);
    }
    win.addEventListener("change", () => {
      this.#window = win.value as WindowId;
      this.#at = null;
      void this.refresh();
    });
    c.append(el("label", DIM, t("tl.window")), win);
    for (const cat of TL_CATS) {
      const lab = el("label", "display:inline-flex;gap:4px;align-items:center;cursor:pointer;font-size:var(--omp-font-size-sm);");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = this.#cats.has(cat.id);
      cb.addEventListener("change", () => {
        if (cb.checked) this.#cats.add(cat.id);
        else this.#cats.delete(cat.id);
        this.#renderAll();
      });
      lab.append(cb, document.createTextNode(`${cat.icon} ${t(`tl.cat.${cat.id}` as never)}`));
      c.append(lab);
    }
    const op = el("label", "display:inline-flex;gap:4px;align-items:center;cursor:pointer;" + DIM);
    const opCb = el("input");
    opCb.type = "checkbox";
    opCb.checked = this.#operate;
    opCb.addEventListener("change", () => {
      this.#operate = opCb.checked;
      void this.refresh();
    });
    op.append(opCb, document.createTextNode(t("tl.operate")));
    c.append(op);
  }

  #resolvers(): Resolvers {
    const x = this.#ctx;
    return {
      node: (id) => x.nodes.find((n) => n.id === id)?.label,
      workflow: (id) => x.workflows.find((w) => w.id === id)?.name,
      process: (id) => x.processes.find((p) => p.id === id)?.name,
      instance: (id) => x.nodes.find((n) => n.instanceId === id || n.id === id)?.label,
      group: (id) => x.groups.find((g) => g.id === id)?.name,
    };
  }

  #text(i: TLItem): { icon: string; text: string } {
    const d = describeItem(i, this.#resolvers(), tryT, (k, p) => t(k as never, p));
    return { icon: d.icon, text: d.text ?? (d.key ? t(d.key as never, d.params) : i.kind) };
  }

  #renderAll() {
    this.#renderAxis();
    this.#renderState();
    this.#renderList();
  }

  // ---- Balken und Regler ---------------------------------------------------------------------------------------------

  #renderAxis() {
    const box = this.#axis;
    box.replaceChildren();
    box.style.cssText = CARD;
    if (this.#failed) {
      box.append(el("div", "color:var(--omp-error);", t("tl.loadFailed", { error: this.#failed })));
      return;
    }
    if (!this.#until) {
      box.append(el("div", DIM, t("tl.loading")));
      return;
    }
    const visible = this.#items.filter((i) => this.#cats.has(categoryOf(i)));
    const b = bins(visible, this.#from, this.#until, BIN_COUNT);
    const max = Math.max(1, ...b.map((x) => x.error + x.warn + x.info));
    const bars = el("div", "position:relative;display:flex;align-items:flex-end;gap:1px;height:56px;cursor:crosshair;");
    for (const x of b) {
      const col = el("div", "flex:1;height:100%;display:flex;align-items:flex-end;");
      const lvl = worstLevel(x);
      if (lvl) {
        const h = 6 + (44 * Math.sqrt(x.error + x.warn + x.info)) / Math.sqrt(max);
        col.append(el("div", `width:100%;height:${h.toFixed(0)}px;background:${COLOR[lvl]};border-radius:2px 2px 0 0;opacity:.9;`));
      } else col.append(el("div", "width:100%;height:2px;background:var(--omp-border);"));
      bars.append(col);
    }
    const span = this.#until - this.#from;
    if (this.#at !== null) {
      const x = ((this.#at - this.#from) / span) * 100;
      bars.append(el("div", `position:absolute;top:0;bottom:0;left:${x.toFixed(2)}%;width:2px;background:var(--omp-text);pointer-events:none;`));
    }
    bars.addEventListener("click", (ev) => {
      const r = bars.getBoundingClientRect();
      this.#select(this.#from + ((ev.clientX - r.left) / r.width) * span);
    });
    const slider = el("input", "width:100%;margin:6px 0 0;");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1000";
    slider.value = this.#at === null ? "1000" : String(Math.round(((this.#at - this.#from) / span) * 1000));
    slider.setAttribute("aria-label", t("tl.slider"));
    slider.addEventListener("input", () => this.#select(this.#from + (Number(slider.value) / 1000) * span));
    const labels = el("div", "display:flex;justify-content:space-between;" + DIM);
    labels.append(el("span", "", new Date(this.#from).toLocaleString()), el("span", "", this.#at === null ? t("tl.pick") : ""), el("span", "", t("tl.now")));
    box.append(bars, slider, labels);
  }

  #select(ms: number) {
    this.#at = Math.max(this.#from, Math.min(this.#until, ms));
    this.#renderAll();
  }

  // ---- Zustand zu einem Zeitpunkt --------------------------------------------------------------------------------------

  #renderState() {
    const box = this.#state;
    box.replaceChildren();
    if (this.#at === null || this.#failed) {
      box.style.cssText = "";
      return;
    }
    box.style.cssText = CARD + "border-left:4px solid var(--omp-text);";
    const at = this.#at;
    const head = el("div", "display:flex;gap:10px;align-items:center;");
    head.append(el("strong", "flex:1;font-size:var(--omp-font-size-md);", t("tl.stateAt", { time: clock(at) })));
    const back = el("button", "", t("tl.backToNow"));
    back.className = "omp-btn";
    back.addEventListener("click", () => {
      this.#at = null;
      this.#renderAll();
    });
    head.append(back);
    box.append(head);

    const problems = problemsAt(this.#items, at);
    box.append(el("div", "font-weight:600;margin-top:8px;", t("tl.problems.title")));
    if (problems.length === 0) box.append(el("div", DIM, t("tl.problems.none")));
    for (const p of problems) {
      const row = el("div", "display:flex;gap:8px;align-items:baseline;margin-top:3px;");
      row.append(el("span", `color:${COLOR[p.item.severity]};`, this.#text(p.item).icon), el("span", "", this.#text(p.item).text), el("span", DIM, t("tl.problems.since", { time: clock(p.since) })));
      box.append(row);
    }
    const changes = changesBefore(this.#items.filter((i) => categoryOf(i) !== "log"), at, BEFORE_MS);
    box.append(el("div", "font-weight:600;margin-top:10px;", t("tl.changes.title", { min: BEFORE_MS / 60_000 })));
    if (changes.length === 0) box.append(el("div", DIM, t("tl.changes.none")));
    for (const i of changes.slice(0, 30)) box.append(this.#row(i, false));
    box.append(el("div", DIM + "margin-top:8px;", t("tl.limit")));
  }

  // ---- Liste -----------------------------------------------------------------------------------------------------------

  #row(i: TLItem, clickable = true): HTMLElement {
    const d = this.#text(i);
    const ms = Date.parse(i.at);
    const inWindow = this.#at !== null && ms <= this.#at && ms > this.#at - BEFORE_MS;
    const row = el(
      "div",
      `display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-left:3px solid ${i.severity === "info" ? "transparent" : COLOR[i.severity]};` +
        (inWindow ? "background:var(--omp-surface-raised);" : "") + (clickable ? "cursor:pointer;" : ""),
    );
    row.setAttribute("data-testid", "tl-row");
    row.append(el("span", DIM + "min-width:62px;", clock(ms)), el("span", `min-width:16px;${i.severity === "info" ? "" : `color:${COLOR[i.severity]};`}`, d.icon), el("span", "flex:1;word-break:break-word;", d.text));
    if (i.actor && i.kind !== "marker") row.append(el("span", DIM, i.actor));
    if (clickable) row.addEventListener("click", () => this.#select(ms));
    return row;
  }

  #renderList() {
    const box = this.#list;
    box.replaceChildren();
    if (this.#failed || !this.#until) return;
    box.style.cssText = "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    const visible = this.#items.filter((i) => this.#cats.has(categoryOf(i)));
    if (visible.length === 0) {
      box.append(el("div", "padding:14px;" + DIM, this.#loading ? t("tl.loading") : t("tl.empty")));
      return;
    }
    let lastDay = "";
    for (const i of visible) {
      const day = new Date(i.at).toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long" });
      if (day !== lastDay) {
        lastDay = day;
        box.append(el("div", "padding:4px 8px;background:var(--omp-surface);font-weight:600;" + DIM, day));
      }
      box.append(this.#row(i));
    }
    if (this.#truncated) box.append(el("div", "padding:8px;" + DIM, t("tl.truncated", { n: this.#items.length })));
  }
}
