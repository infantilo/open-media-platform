// OGraf-Adapter (Kap. 40.9): liest `templates`/`layers` über die Proxy-API und ruft
// dieselben Methoden wie das Panel (show/hide/continue). Daten: Standardwerte der Vorlage.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import {
  continueTarget,
  type Layer,
  layoutOgraf,
  type OgrafAction,
  type OgrafLayout,
  type OgrafState,
  stepTemplate,
  type Template,
} from "./ograf-logic.ts";

export interface OgrafIO {
  getParam(name: string): Promise<unknown>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

const arr = <T>(raw: unknown): T[] => {
  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(v) ? (v as T[]) : [];
};

export function ografAdapter(io: OgrafIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: OgrafState = { templates: [], layers: [], sel: null };
  let last: OgrafLayout | null = null;

  async function run(x: OgrafAction) {
    try {
      if (x.t === "pick") st.sel = x.id;
      else if (x.t === "take") {
        if (st.sel && !st.layers.some((l) => l.id === st.sel)) await io.call("show", { templateId: st.sel, data: {} });
      } else if (x.t === "out") {
        if (st.sel && st.layers.some((l) => l.id === st.sel)) await io.call("hide", { layerId: st.sel });
      } else if (x.t === "cont") {
        const c = continueTarget(st);
        if (c?.canContinue) await io.call("continue", { layerId: c.id });
      } else if (x.t === "clear") {
        if (st.layers.length) await io.call("hide", {});
      }
      if (x.t !== "pick") await a.refresh();
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }

  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      last = layoutOgraf(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i: number, delta: number) {
      if (i !== 0) return;
      st.sel = stepTemplate(st, delta);
      a.onChange();
    },
    onDialPress(i: number, down: boolean) {
      const x = last?.dialAct[i];
      if (down && x) void run(x);
    },
    async refresh() {
      try {
        const [tpl, lay] = await Promise.all([io.getParam("templates"), io.getParam("layers")]);
        st.templates = arr<Template>(tpl).map((t) => ({ id: t.id, label: t.label || t.id, stepCount: t.stepCount ?? 1 }));
        st.layers = arr<Layer>(lay);
        if (st.sel && !st.templates.some((t) => t.id === st.sel)) st.sel = null;
        st.sel ??= st.layers[0]?.id ?? st.templates[0]?.id ?? null;
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    },
  };
  return a;
}
