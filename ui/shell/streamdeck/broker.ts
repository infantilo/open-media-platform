// Broker (Kap. 40.4): hält das Gerät, verwaltet Tabs der geöffneten Node-UIs,
// komponiert Kopfzeile + Inhalt des aktiven Tabs und verteilt Eingaben nur
// an den aktiven Adapter. Zustand kommt aus dem Adapter (= aus dem
// Bildschirm-UI): ein Zustand, zwei Renderer.

import { RELAYOUT_EVENT, type StreamDeckAdapter } from "./adapter.ts";
import { adapterFor } from "./adapters/index.ts";
import { AutoRasterAdapter, proxyIO } from "./autoraster.ts";
import { composeLayout, type Composed, DialCoalescer, type TabInfo } from "./broker-logic.ts";
import { canvasRasterizer } from "./draw.ts";
import type { DeckEvent } from "./protocol.ts";
import { DeckRenderer, type Rasterizer } from "./render-logic.ts";
import type { DeckDevice } from "./transport.ts";

interface Tab {
  info: TabInfo;
  el: HTMLElement;
  nodeId: string;
  adapter: StreamDeckAdapter | null;
  page: number;
  onRelayout: () => void;
}

const REFRESH_MS = 1500;
const DIAL_FLUSH_MS = 50;

export class DeckBroker {
  #dev: DeckDevice;
  #renderer: DeckRenderer;
  #tabs = new Map<string, Tab>();
  #active: string | null = null;
  #tabPage = 0;
  #composed: Composed | null = null;
  #dials = new DialCoalescer();
  #timers: ReturnType<typeof setInterval>[] = [];
  #unsub: () => void;
  /** Gerät wählt einen Tab: Bildschirm soll folgen (Kachel nach vorn). */
  onFocusRequest: (id: string | null) => void = () => {};
  onError: (e: unknown) => void = (e) => console.warn("[streamdeck]", e);

  constructor(dev: DeckDevice, raster: Rasterizer = canvasRasterizer) {
    this.#dev = dev;
    this.#renderer = new DeckRenderer(dev, raster, { onError: (e) => this.onError(e) });
    this.#unsub = dev.onEvent((e) => this.#onEvent(e));
    this.#timers.push(globalThis.setInterval(() => this.#flushDials(), DIAL_FLUSH_MS));
    this.#timers.push(globalThis.setInterval(() => void this.#refresh(), REFRESH_MS));
    void dev.setBrightness(70).catch((e) => this.onError(e));
    this.relayout();
  }

  get active(): string | null {
    return this.#active;
  }
  get composed(): Composed | null {
    return this.#composed;
  }
  get model() {
    return this.#dev.model;
  }

  attach(id: string, label: string, el: HTMLElement, nodeId: string) {
    this.detach(id);
    const tab: Tab = { info: { id, label }, el, nodeId, adapter: null, page: 0, onRelayout: () => this.relayout() };
    el.addEventListener(RELAYOUT_EVENT, tab.onRelayout);
    this.#tabs.set(id, tab);
    this.relayout();
  }

  detach(id: string) {
    const t = this.#tabs.get(id);
    if (!t) return;
    t.el.removeEventListener(RELAYOUT_EVENT, t.onRelayout);
    t.adapter?.dispose?.();
    this.#tabs.delete(id);
    if (this.#active === id) this.#active = null;
    this.relayout();
  }

  /** Tab aktivieren (null = Home). `fromDevice`: Bildschirm soll folgen. */
  focus(id: string | null, fromDevice = false) {
    if (id !== null && !this.#tabs.has(id)) return;
    this.#active = id;
    if (id !== null) {
      const t = this.#tabs.get(id)!;
      t.adapter ??= this.#resolveAdapter(t);
    }
    if (fromDevice) this.onFocusRequest(id);
    this.relayout();
  }

  #resolveAdapter(t: Tab): StreamDeckAdapter {
    const own = adapterFor(t.el, t.nodeId);
    if (own) {
      const w = own as StreamDeckAdapter & { onChange?: () => void; onError?: (e: unknown) => void };
      if ("onChange" in w) w.onChange = () => this.relayout();
      if ("onError" in w) w.onError = (e) => this.onError(e);
      // Erste Werte sofort holen (ohne auf den Refresh-Takt zu warten).
      void Promise.resolve(own.refresh?.()).catch((e) => this.onError(e));
      return own;
    }
    const a = new AutoRasterAdapter(proxyIO(t.nodeId));
    a.onChange = () => this.relayout();
    a.onError = (e) => this.onError(e);
    return a;
  }

  relayout() {
    const m = this.#dev.model;
    const tabs = [...this.#tabs.values()].map((t) => t.info);
    const act = this.#active ? this.#tabs.get(this.#active) : undefined;
    const content = act?.adapter
      ? act.adapter.getLayout({ cols: m.cols, rows: m.rows - 1, dials: m.dials, page: act.page })
      : null;
    this.#composed = composeLayout(m, tabs, this.#active, this.#tabPage, content, act?.page ?? 0);
    const c = this.#composed;
    if (act) act.page = Math.min(act.page, c.contentPages - 1);
    this.#renderer.set(c.keys, c.dials);
  }

  /** Sendet ausstehende Bilder sofort (Tests/Schließen). */
  flushNow() {
    return this.#renderer.flushNow();
  }

  #onEvent(e: DeckEvent) {
    const c = this.#composed;
    const act = this.#active ? this.#tabs.get(this.#active) : undefined;
    if (e.kind === "key") {
      const p = c?.presses[e.index];
      if (!p) return;
      if (p.kind === "content") {
        act?.adapter?.onKey(p.row, p.col, e.down);
        return;
      }
      if (!e.down) return;
      if (p.kind === "home") this.focus(null, true);
      else if (p.kind === "tab") this.focus(p.id, true);
      else if (p.kind === "tabPage") {
        this.#tabPage = (this.#tabPage + 1) % (c?.tabPages ?? 1);
        this.relayout();
      } else if (p.kind === "contentPage" && act) {
        act.page = (act.page + 1) % (c?.contentPages ?? 1);
        this.relayout();
      }
    } else if (e.kind === "dialTurn") {
      this.#dials.add(e.index, e.delta);
    } else if (e.kind === "dialPress") {
      act?.adapter?.onDialPress?.(e.index, e.down);
    } else if (e.kind === "flick" && act && (c?.contentPages ?? 1) > 1) {
      const n = c!.contentPages;
      act.page = (act.page + (e.x2 < e.x ? 1 : n - 1)) % n;
      this.relayout();
    }
  }

  #flushDials() {
    const act = this.#active ? this.#tabs.get(this.#active) : undefined;
    for (const [i, d] of this.#dials.take()) act?.adapter?.onDial?.(i, d);
  }

  async #refresh() {
    const act = this.#active ? this.#tabs.get(this.#active) : undefined;
    try {
      await act?.adapter?.refresh?.();
    } catch (e) {
      this.onError(e);
    }
  }

  /** Beendet den Broker; das Gerät schließt der Aufrufer. */
  stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#unsub();
    for (const id of [...this.#tabs.keys()]) {
      const t = this.#tabs.get(id)!;
      t.el.removeEventListener(RELAYOUT_EVENT, t.onRelayout);
      t.adapter?.dispose?.();
    }
    this.#tabs.clear();
  }
}
