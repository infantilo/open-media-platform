// Auto-Raster-Adapter (Kap. 40.4): holt Descriptor + Werte über die generische
// Node-Proxy-API; Tastendruck = derselbe Aufruf wie im Parameter-Panel.

import { apiFetch } from "../connection.ts";
import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "./adapter.ts";
import {
  applyDial,
  type AutoLayout,
  buildDialItems,
  buildItems,
  type AutoItem,
  type Descriptor,
  type DialItem,
  layoutAuto,
  nextEnum,
} from "./autoraster-logic.ts";

export interface NodeIO {
  descriptor(): Promise<Descriptor>;
  getParam(name: string): Promise<unknown>;
  setParam(name: string, value: unknown): Promise<void>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

export function proxyIO(nodeId: string): NodeIO {
  const base = `/api/v1/nodes/${nodeId}`;
  return {
    async descriptor() {
      const r = await apiFetch(`${base}/descriptor`);
      if (!r.ok) throw new Error(`descriptor ${r.status}`);
      return await r.json();
    },
    async getParam(name) {
      const r = await apiFetch(`${base}/params/${name}`);
      if (!r.ok) throw new Error(`param ${name} ${r.status}`);
      const j = await r.json();
      return j && typeof j === "object" && "value" in j ? j.value : j;
    },
    async setParam(name, value) {
      const r = await apiFetch(`${base}/params/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!r.ok) throw new Error(`set ${name} ${r.status}`);
    },
    async call(name, body) {
      const r = await apiFetch(`${base}/methods/${name}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error(`call ${name} ${r.status}`);
    },
  };
}

export class AutoRasterAdapter implements StreamDeckAdapter {
  #items: AutoItem[] = [];
  #dials: DialItem[] = [];
  #values: Record<string, unknown> = {};
  #last: AutoLayout | null = null;
  #ready = false;
  #ctx: LayoutContext | null = null;
  /** Vom Broker gesetzt: Anzeige neu aufbauen. */
  onChange: () => void = () => {};
  /** Vom Broker gesetzt: Fehlermeldung. */
  onError: (e: unknown) => void = () => {};

  constructor(private io: NodeIO) {
    void this.#init();
  }

  async #init() {
    try {
      const d = await this.io.descriptor();
      this.#items = buildItems(d);
      this.#dials = buildDialItems(d);
      this.#ready = true;
      await this.refresh();
    } catch (e) {
      this.onError(e);
    }
    this.onChange();
  }

  getLayout(ctx: LayoutContext): AdapterLayout {
    this.#ctx = ctx;
    if (!this.#ready) return { keys: [[{ label: "…", dim: true }]] };
    this.#last = layoutAuto(this.#items, this.#dials, this.#values, ctx.cols, ctx.rows, ctx.dials, ctx.page);
    return this.#last;
  }

  onKey(row: number, col: number, down: boolean): void {
    if (!down) return;
    const item = this.#last?.cells[row]?.[col];
    if (!item) return;
    void this.#act(item);
  }

  async #act(item: AutoItem) {
    try {
      if (item.kind === "toggle") {
        const v = !(this.#values[item.name] === true);
        this.#values[item.name] = v; // optimistisch, refresh holt die Wahrheit
        this.onChange();
        await this.io.setParam(item.name, v);
      } else if (item.kind === "enum") {
        const v = nextEnum(item.values, this.#values[item.name]);
        this.#values[item.name] = v;
        this.onChange();
        await this.io.setParam(item.name, v);
      } else {
        await this.io.call(item.name);
      }
    } catch (e) {
      this.onError(e);
    }
    await this.refresh();
  }

  onDial(index: number, delta: number): void {
    const spec = this.#last?.visibleDials[index];
    if (!spec) return;
    const cur = typeof this.#values[spec.name] === "number" ? (this.#values[spec.name] as number) : spec.min;
    const v = applyDial(cur, delta, spec);
    this.#values[spec.name] = v;
    this.onChange();
    this.io.setParam(spec.name, v).catch((e) => this.onError(e));
  }

  async refresh(): Promise<void> {
    const names = new Set<string>();
    for (const i of this.#last?.visible ?? this.#items.slice(0, 64)) if (i.kind !== "trigger") names.add(i.name);
    for (const d of this.#last?.visibleDials ?? []) names.add(d.name);
    let changed = false;
    await Promise.all([...names].map(async (n) => {
      try {
        const v = await this.io.getParam(n);
        if (JSON.stringify(v) !== JSON.stringify(this.#values[n])) {
          this.#values[n] = v;
          changed = true;
        }
      } catch { /* einzelner Wert nicht lesbar: Taste bleibt gedimmt */ }
    }));
    if (changed) this.onChange();
  }

  get context() {
    return this.#ctx;
  }
}
