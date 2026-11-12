// Studio-Mischer-Adapter (omp-lowlat-mixer): holt Streifen/Busse/Werte über die Proxy-API und schreibt über die Methode
// `setParam{name,value}` bzw. `bus.N.mixMinus{strip}` — dieselben Wege wie die Bildschirm-Oberfläche. Logik: lowlat-mixer-logic.ts.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import {
  type Action,
  type Item,
  type LowlatLayout,
  type LowlatState,
  extraNames,
  layoutLowlat,
  MODE_PARAMS,
  nudged,
} from "./lowlat-mixer-logic.ts";

export interface MixerIO {
  getParam(name: string): Promise<unknown>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

function items(raw: unknown): Item[] {
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.map((c: Item) => ({ id: String(c.id), label: String(c.label ?? c.id) })) : [];
  } catch {
    return [];
  }
}

export function lowlatMixerAdapter(io: MixerIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: LowlatState = { strips: [], buses: [], values: {}, sel: null, bus: "1", mode: "mix", focus: 0 };
  let last: LowlatLayout | null = null;

  const setValue = (name: string, value: number) => {
    // Schalter lesen wir als Boolean zurück; die Anzeige folgt sofort, der nächste refresh() bestätigt.
    st.values[name] = typeof st.values[name] === "boolean" ? value !== 0 : value;
    a.onChange();
    return io.call("setParam", { name, value });
  };

  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      last = layoutLowlat(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i: number, delta: number) {
      const d = last?.dialAct[i];
      if (!d) return;
      const cur = typeof st.values[d.name] === "number" ? (st.values[d.name] as number) : d.p.min;
      void setValue(d.name, nudged(cur, delta, d.p)).catch(a.onError);
    },
    onDialPress(i: number, down: boolean) {
      const d = last?.dialAct[i];
      if (down && d?.press) void run(d.press);
    },
    async refresh() {
      try {
        st.strips = items(await io.getParam("strips"));
        st.buses = items(await io.getParam("buses"));
        if (st.sel && !st.strips.some((c) => c.id === st.sel)) {
          st.sel = null;
          st.mode = "mix";
        }
        if (!st.buses.some((b) => b.id === st.bus)) st.bus = st.buses[0]?.id ?? "1";
      } catch (e) {
        a.onError(e);
        return;
      }
      const names = new Set<string>();
      for (const c of st.strips) {
        names.add(`strip.${c.id}.gain`);
        names.add(`strip.${c.id}.mute`);
        names.add(`strip.${c.id}.send.${st.bus}`);
      }
      if (st.sel && st.mode !== "mix") {
        const m = MODE_PARAMS[st.mode];
        for (const p of m.params) names.add(p.name(st.sel, st.bus));
        for (const t of m.toggles) names.add(t.name(st.sel, st.bus));
        if (st.mode !== "bus") for (const n of extraNames(st, st.mode)) names.add(n);
      }
      let changed = false;
      await Promise.all([...names].map(async (n) => {
        try {
          const v = await io.getParam(n);
          if (st.values[n] !== v) {
            st.values[n] = v;
            changed = true;
          }
        } catch { /* Wert nicht lesbar → Taste zeigt „–“ */ }
      }));
      if (changed || st.strips.length) a.onChange();
    },
  };

  async function run(x: Action) {
    try {
      switch (x.t) {
        case "select":
          // Ein Druck öffnet direkt die Detailseiten (EQ); „◀ Mix“ führt zurück.
          st.sel = x.id;
          st.mode = "eq";
          st.focus = 0;
          await a.refresh();
          break;
        case "mode":
          st.mode = x.mode;
          st.focus = 0;
          await a.refresh();
          break;
        case "focus":
          st.focus = x.index;
          break;
        case "cycleBus": {
          const i = st.buses.findIndex((b) => b.id === st.bus);
          st.bus = st.buses[(i + 1) % Math.max(1, st.buses.length)]?.id ?? st.bus;
          await a.refresh();
          break;
        }
        case "nudge": {
          if (st.sel && st.mode !== "mix") {
            const m = MODE_PARAMS[st.mode];
            const p = m.params[Math.min(st.focus, m.params.length - 1)];
            const name = p.name(st.sel, st.bus);
            const cur = typeof st.values[name] === "number" ? (st.values[name] as number) : p.min;
            await setValue(name, nudged(cur, x.steps, p));
          }
          break;
        }
        case "mixminus":
          await io.call(`bus.${x.bus}.mixMinus`, { strip: Number(x.strip) });
          await a.refresh();
          return;
        case "set":
          await setValue(x.name, x.value);
          await a.refresh();
          return;
      }
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }
  return a;
}
