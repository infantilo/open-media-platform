// Audio-Mixer-Adapter (Kap. 40.6): holt Kanäle/Werte über die Proxy-API,
// schreibt über die `channel.<id>.set*`-Methoden (wie die Bildschirm-UI).

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import {
  type AudioAction,
  type AudioLayout,
  type AudioState,
  type Chan,
  layoutAudioMixer,
  EXTRA_PROPS,
  MODE_PARAMS,
  nudged,
} from "./audio-mixer-logic.ts";

export interface MixerIO {
  getParam(name: string): Promise<unknown>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

const BASE_PROPS = ["gain", "mute", "pfl"];

export function audioMixerAdapter(io: MixerIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: AudioState = { channels: [], values: {}, sel: null, mode: "mix", focus: 0 };
  let last: AudioLayout | null = null;
  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      last = layoutAudioMixer(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
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
      const key = `${d.id}.${d.p.prop}`;
      const cur = typeof st.values[key] === "number" ? (st.values[key] as number) : d.p.min;
      const v = nudged(cur, delta, d.p);
      st.values[key] = v;
      a.onChange();
      const c = d.p.set(v);
      io.call(`channel.${d.id}.${c.method}`, c.body).catch(a.onError);
    },
    onDialPress(i: number, down: boolean) {
      const d = last?.dialAct[i];
      if (down && d?.press) void run(d.press);
    },
    async refresh() {
      try {
        const raw = await io.getParam("channels");
        const list: Chan[] = typeof raw === "string" ? JSON.parse(raw) : (raw as Chan[]) ?? [];
        st.channels = list.map((c) => ({ id: c.id, label: c.label }));
        if (st.sel && !st.channels.some((c) => c.id === st.sel)) {
          st.sel = null;
          st.mode = "mix";
        }
      } catch (e) {
        a.onError(e);
        return;
      }
      const props = new Map<string, string[]>();
      for (const c of st.channels) props.set(c.id, [...BASE_PROPS]);
      if (st.sel && st.mode !== "mix") {
        const m = MODE_PARAMS[st.mode];
        props.set(st.sel, [...BASE_PROPS, ...m.params.map((p) => p.prop), ...m.toggles.map((t) => t.prop), ...(st.mode === "pan" ? [] : EXTRA_PROPS[st.mode])]);
      }
      let changed = false;
      await Promise.all([...props].flatMap(([id, ps]) => ps.map(async (p) => {
        try {
          const v = await io.getParam(`channel.${id}.${p}`);
          if (st.values[`${id}.${p}`] !== v) {
            st.values[`${id}.${p}`] = v;
            changed = true;
          }
        } catch { /* Wert nicht lesbar → Taste zeigt „–“ */ }
      })));
      if (changed || st.channels.length) a.onChange();
    },
  };

  async function run(x: AudioAction) {
    try {
      if (x.t === "select") {
        // Ein Druck öffnet direkt die Detailseiten (EQ); „◀ Mix“ führt zurück.
        st.sel = x.id;
        st.mode = "eq";
        st.focus = 0;
        await a.refresh();
      } else if (x.t === "mode") {
        st.mode = x.mode;
        st.focus = 0;
        await a.refresh();
      } else if (x.t === "focus") {
        st.focus = x.index;
      } else if (x.t === "nudge") {
        if (st.sel && st.mode !== "mix") {
          const p = MODE_PARAMS[st.mode].params[Math.min(st.focus, MODE_PARAMS[st.mode].params.length - 1)];
          const key = `${st.sel}.${p.prop}`;
          const cur = typeof st.values[key] === "number" ? (st.values[key] as number) : p.min;
          const v = nudged(cur, x.steps, p);
          st.values[key] = v;
          const c = p.set(v);
          a.onChange();
          await io.call(`channel.${st.sel}.${c.method}`, c.body);
        }
      } else {
        await io.call(`channel.${x.id}.${x.method}`, x.body);
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
