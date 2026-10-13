// X/Y-Panel-Adapter (Kap. 40.7): liest Quellen/Senken/Graph über die Kern-API
// und schaltet mit POST/DELETE /api/v1/graph/edges — wie das Panel selbst.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import { apiFetch } from "../../connection.ts";
import {
  compatible,
  filtered,
  layoutXy,
  MEDIA_CYCLE,
  type Point,
  stepSelection,
  visible,
  type XyAction,
  type XyLayout,
  type XyState,
} from "./xy-panel-logic.ts";

export interface XyIO {
  load(): Promise<{ sources: Point[]; sinks: Point[]; routes: Record<string, string> }>;
  connect(from: string, to: string): Promise<void>;
  disconnect(to: string): Promise<void>;
}

interface RawPoint {
  senderId?: string;
  receiverId?: string;
  label?: string;
  nodeLabel?: string;
  nodeId?: string;
  mediaType?: string;
  online?: boolean;
}

export function coreIO(): XyIO {
  const jget = async (u: string) => {
    const r = await apiFetch(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    return r.json();
  };
  const norm = (list: RawPoint[], idKey: "senderId" | "receiverId"): Point[] =>
    (list || []).map((s) => ({
      id: String(s[idKey]),
      label: s.label || String(s[idKey]),
      nodeLabel: s.nodeLabel || s.nodeId || "",
      mediaType: s.mediaType || "",
      online: s.online !== false,
    }));
  return {
    async load() {
      const [graph, sources, sinks] = await Promise.all([jget("/api/v1/graph"), jget("/api/v1/sources"), jget("/api/v1/sinks")]);
      const routes: Record<string, string> = {};
      for (const e of graph.edges || []) routes[e.toReceiver] = e.fromSender;
      return { sources: norm(sources, "senderId"), sinks: norm(sinks, "receiverId"), routes };
    },
    async connect(from, to) {
      const r = await apiFetch("/api/v1/graph/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    },
    async disconnect(to) {
      const r = await apiFetch(`/api/v1/graph/edges/${encodeURIComponent(to)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    },
  };
}

export function xyPanelAdapter(io: XyIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: XyState = { sources: [], sinks: [], routes: {}, selSrc: null, selDst: null, media: "", auto: true, srcOff: 0, dstOff: 0 };
  let last: XyLayout | null = null;

  async function take() {
    const from = st.sources.find((x) => x.id === st.selSrc), to = st.sinks.find((x) => x.id === st.selDst);
    if (!from || !to) return;
    if (!compatible(from, to)) return;
    await io.connect(from.id, to.id);
    st.selDst = null; // wie das Panel: Ziel nach dem Schalten freigeben
    await a.refresh();
  }

  async function run(x: XyAction) {
    try {
      if (x.t === "src") {
        st.selSrc = x.id;
        if (st.auto && st.selDst && st.routes[st.selDst] !== x.id) await take();
      } else if (x.t === "dst") {
        st.selDst = x.id;
        // Ziel hängt schon an der gewählten Quelle: nur auswählen (z. B. um es zu trennen).
        if (st.auto && st.selSrc && st.routes[x.id] !== st.selSrc) await take();
      } else if (x.t === "take") await take();
      else if (x.t === "disc") {
        if (st.selDst) {
          await io.disconnect(st.selDst);
          st.selDst = null;
          await a.refresh();
        }
      } else if (x.t === "auto") st.auto = !st.auto;
      else if (x.t === "media") {
        st.media = MEDIA_CYCLE[(MEDIA_CYCLE.indexOf(st.media) + 1) % MEDIA_CYCLE.length];
        st.srcOff = st.dstOff = st.srcCatOff = st.dstCatOff = 0;
        st.srcCat = st.dstCat = null;
      } else if (x.t === "cat") {
        if (x.side === "src") (st.srcCat = x.name, st.srcOff = 0);
        else (st.dstCat = x.name, st.dstOff = 0);
      } else if (x.t === "more") {
        const w = Math.max(1, Math.floor(((a.cols || 9) - 1) / 2));
        const n = x.what === "cat" ? 1 + new Set(visible(x.side === "src" ? st.sources : st.sinks, st.media).map((p) => p.nodeLabel)).size : filtered(x.side === "src" ? st.sources : st.sinks, st.media, x.side === "src" ? st.srcCat : st.dstCat).length;
        const key = (x.what === "cat" ? (x.side === "src" ? "srcCatOff" : "dstCatOff") : x.side === "src" ? "srcOff" : "dstOff") as "srcOff" | "dstOff" | "srcCatOff" | "dstCatOff";
        const next = (st[key] ?? 0) + (x.what === "cat" ? Math.max(1, w - 1) : Math.max(1, (a.rows - 1) * w - 1));
        st[key] = next >= n ? 0 : next;
      } else if (x.t === "scroll") {
        const n = x.row === "src" ? visible(st.sources, st.media).length : visible(st.sinks, st.media).length;
        const step = Math.max(1, (a.cols || 8) - 1);
        const key = x.row === "src" ? "srcOff" : "dstOff";
        st[key] = Math.min(Math.max(0, n - 1), Math.max(0, st[key] + x.dir * step));
      }
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }

  const a = {
    cols: 0,
    rows: 0,
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      a.cols = ctx.cols;
      a.rows = ctx.rows;
      last = layoutXy(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i: number, delta: number) {
      if (i === 0) st.selSrc = stepSelection(filtered(st.sources, st.media, st.srcCat), st.selSrc, delta);
      else if (i === 1) st.selDst = stepSelection(filtered(st.sinks, st.media, st.dstCat), st.selDst, delta);
      else if (i === 2) void run({ t: "media" });
      a.onChange();
    },
    onDialPress(i: number, down: boolean) {
      if (!down) return;
      if (i === 1) void run({ t: "take" });
      else if (i === 3) void run({ t: "auto" });
    },
    async refresh() {
      try {
        const d = await io.load();
        st.sources = d.sources;
        st.sinks = d.sinks;
        st.routes = d.routes;
        if (st.selSrc && !st.sources.some((x) => x.id === st.selSrc)) st.selSrc = null;
        if (st.selDst && !st.sinks.some((x) => x.id === st.selDst)) st.selDst = null;
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    },
  };
  return a;
}
