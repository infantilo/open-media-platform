// X/Y-Panel-Adapter (Kap. 40.7): liest Quellen/Senken/Graph über die Kern-API
// und schaltet mit POST/DELETE /api/v1/graph/edges — wie das Panel selbst.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import { apiFetch } from "../../connection.ts";
import {
  type Bouquet,
  compatible,
  layoutXy,
  levelEntry,
  MEDIA_CYCLE,
  type Point,
  sideList,
  stepSelection,
  topEntries,
  validPath,
  type XyAction,
  type XyLayout,
  type XyModel,
  type XyState,
} from "./xy-panel-logic.ts";

// deno-lint-ignore no-explicit-any
const L = () => (globalThis as any).OmpXyLogic;

export interface XyLoad {
  sources: Point[];
  sinks: Point[];
  routes: Record<string, string>;
  /** Für Ebenen/Bouquets; fehlt in einfachen Aufrufen. */
  nodes?: { id: string; label?: string }[];
  groupTree?: unknown;
  workflows?: unknown[];
  bouquets?: Bouquet[];
  /** Darf der Nutzer Bouquets speichern (`configure`)? */
  canSave?: boolean;
}

export interface XyIO {
  load(): Promise<XyLoad>;
  /** Hängt ein Bouquet an die gespeicherte Liste (frisch lesen, anhängen, schreiben). */
  saveBouquet?(b: Bouquet): Promise<void>;
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
  tags?: { tag: string }[];
}

/** Ebenen-/Bouquet-Daten ändern sich selten: höchstens alle 15 s neu holen. */
const SLOW_MS = 15000;

export function coreIO(panelId = ""): XyIO {
  const panelHdr: Record<string, string> = panelId ? { "X-OMP-Panel": panelId } : {};
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
      nodeId: s.nodeId,
      tags: (s.tags || []).map((t) => t.tag),
    }));
  const jgetOpt = async (u: string) => {
    try {
      const r = await apiFetch(u);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  let slow: { at: number; groupTree: unknown; workflows: unknown[]; bouquets: Bouquet[]; canSave: boolean } | null = null;
  return {
    async load() {
      const [graph, sources, sinks] = await Promise.all([jget("/api/v1/graph"), jget("/api/v1/sources"), jget("/api/v1/sinks")]);
      const routes: Record<string, string> = {};
      for (const e of graph.edges || []) routes[e.toReceiver] = e.fromSender;
      if (!slow || Date.now() - slow.at > SLOW_MS) {
        const [layout, workflows, bq, me] = await Promise.all([
          jgetOpt("/api/v1/layouts/default"),
          jgetOpt("/api/v1/workflows"),
          jgetOpt("/api/v1/layouts/xy-bouquets"),
          jgetOpt("/api/v1/auth/whoami"),
        ]);
        slow = {
          at: Date.now(),
          groupTree: (layout && layout.groups) || { groups: {} },
          workflows: Array.isArray(workflows) ? workflows : [],
          bouquets: L()?.parseBouquets(bq) ?? [],
          canSave: !!me && (me.canConfigure ?? me.isAdmin) === true,
        };
      }
      return {
        sources: norm(sources, "senderId"),
        sinks: norm(sinks, "receiverId"),
        routes,
        nodes: graph.nodes || [],
        groupTree: slow.groupTree,
        workflows: slow.workflows,
        bouquets: slow.bouquets,
        canSave: slow.canSave,
      };
    },
    async saveBouquet(b) {
      const blob = (await jgetOpt("/api/v1/layouts/xy-bouquets")) ?? { version: 1, bouquets: [] };
      const list = Array.isArray(blob.bouquets) ? blob.bouquets : [];
      const r = await apiFetch("/api/v1/layouts/xy-bouquets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...blob, version: blob.version ?? 1, bouquets: [...list, b] }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
      slow = null; // nächste Aktualisierung liest die Liste neu
    },
    async connect(from, to) {
      const r = await apiFetch("/api/v1/graph/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...panelHdr },
        body: JSON.stringify({ from, to }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    },
    async disconnect(to) {
      const r = await apiFetch(`/api/v1/graph/edges/${encodeURIComponent(to)}`, { method: "DELETE", headers: panelHdr });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    },
  };
}

const UNDO_MS = 60000;

export function xyPanelAdapter(io: XyIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: XyState = { sources: [], sinks: [], routes: {}, selSrc: null, selDst: null, media: "", auto: true, srcOff: 0, dstOff: 0, srcPath: [], dstPath: [], bouquets: [] };
  let last: XyLayout | null = null;
  /** Rückgängig (60 s): vorherige Quelle je betroffenem Ziel. */
  let undo: { at: number; prev: { to: string; from: string | null }[] } | null = null;
  let lastRunTimer: ReturnType<typeof setTimeout> | undefined;

  const pushUndo = (tos: string[]) => {
    undo = { at: Date.now(), prev: tos.map((to) => ({ to, from: st.routes[to] ?? null })) };
  };
  const undoSecs = () => {
    if (!undo || Date.now() - undo.at > UNDO_MS) return 0;
    return Math.max(1, Math.ceil((UNDO_MS - (Date.now() - undo.at)) / 1000));
  };

  async function take() {
    const from = st.sources.find((x) => x.id === st.selSrc), to = st.sinks.find((x) => x.id === st.selDst);
    if (!from || !to) return;
    if (!compatible(from, to)) return;
    if (st.draft) {
      // Aufzeichnung: Schaltung sammeln statt schalten (wie das Panel).
      if (!st.draft.some((d) => d.from.id === from.id && d.to.id === to.id)) st.draft.push({ from, to });
      st.selDst = null;
      return;
    }
    pushUndo([to.id]);
    await io.connect(from.id, to.id);
    st.selDst = null; // wie das Panel: Ziel nach dem Schalten freigeben
    await a.refresh();
  }

  async function runBouquet(id: string) {
    const b = (st.bouquets ?? []).find((x) => x.id === id);
    if (!b) return;
    const logic = L();
    let plan: { routes: { from: Point; to: Point }[]; missing: string[] };
    if (b.kind === "bundle") {
      // Bündel brauchen einen Ziel-Node: der Node des gewählten Ziels.
      const dst = st.sinks.find((x) => x.id === st.selDst);
      if (!dst) throw new Error(`${b.name}: erst ein Ziel wählen (dessen Node ist das Bündel-Ziel)`);
      plan = logic.planBundle(b, st.sources.map(withTags), st.sinks.filter((x) => x.nodeId === dst.nodeId).map(withTags));
    } else plan = logic.resolveBouquet(b, st.sources.map(withTags), st.sinks.map(withTags));
    if (plan.routes.length) pushUndo(plan.routes.map((r) => r.to.id));
    let ok = 0;
    const bad: string[] = [];
    for (const r of plan.routes) {
      try {
        await io.connect(r.from.id, r.to.id);
        ok++;
      } catch (e) {
        bad.push(`${r.to.label} (${e instanceof Error ? e.message : e})`);
      }
    }
    st.lastRun = { id, ok, bad: bad.length + plan.missing.length };
    clearTimeout(lastRunTimer);
    lastRunTimer = setTimeout(() => {
      st.lastRun = null;
      a.onChange();
    }, 4000);
    await a.refresh();
    if (bad.length || plan.missing.length) {
      a.onError(new Error(`${b.name}: ${ok} geschaltet, nicht auffindbar/nicht schaltbar: ${[...plan.missing, ...bad].join("; ")}`));
    }
  }

  async function saveDraft() {
    const d = st.draft;
    if (!d || !d.length || !io.saveBouquet) return;
    const now = new Date();
    const name = `Deck ${now.toLocaleTimeString("de-DE", { hour12: false })}`;
    await io.saveBouquet(L().routesBouquet(name, d.map(({ from, to }) => ({ from: withTags(from), to: withTags(to) }))));
    st.draft = null;
    await a.refresh();
  }

  async function doUndo() {
    if (!undoSecs() || !undo) return;
    const e = undo;
    undo = null;
    const bad: string[] = [];
    for (const p of e.prev) {
      try {
        if (p.from) await io.connect(p.from, p.to);
        else await io.disconnect(p.to);
      } catch (err) {
        bad.push(err instanceof Error ? err.message : String(err));
      }
    }
    await a.refresh();
    if (bad.length) a.onError(new Error(`Rückgängig fehlgeschlagen: ${bad.join("; ")}`));
  }

  const withTags = (p: Point) => ({ ...p, tags: p.tags ?? [], nodeId: p.nodeId ?? p.nodeLabel });

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
          pushUndo([st.selDst]);
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
      } else if (x.t === "folder") {
        const path = (x.side === "src" ? st.srcPath : st.dstPath) ?? [];
        setSide(x.side, [...path, x.id]);
      } else if (x.t === "up") {
        const path = (x.side === "src" ? st.srcPath : st.dstPath) ?? [];
        setSide(x.side, path.slice(0, -1));
      } else if (x.t === "bq") await runBouquet(x.id);
      else if (x.t === "undo") await doUndo();
      else if (x.t === "rec") st.draft = [];
      else if (x.t === "recDrop") st.draft = null;
      else if (x.t === "recSave") await saveDraft();
      else if (x.t === "more") {
        const w = Math.max(1, Math.floor(((a.cols || 9) - 1) / 2));
        const n = x.what === "cat" ? topEntries(st, x.side).length : sideList(st, x.side).length;
        const key = (x.what === "cat" ? (x.side === "src" ? "srcCatOff" : "dstCatOff") : x.side === "src" ? "srcOff" : "dstOff") as "srcOff" | "dstOff" | "srcCatOff" | "dstCatOff";
        const next = (st[key] ?? 0) + (x.what === "cat" ? Math.max(1, w - 1) : Math.max(1, (a.rows - 1) * w - 1));
        st[key] = next >= n ? 0 : next;
      } else if (x.t === "scroll") {
        const side = x.row;
        const n = sideList(st, side).length;
        const step = Math.max(1, (a.cols || 8) - 1);
        const key = side === "src" ? "srcOff" : "dstOff";
        st[key] = Math.min(Math.max(0, n - 1), Math.max(0, st[key] + x.dir * step));
      }
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }

  /** Ebene wechseln: Kategorie und Versatz zurücksetzen. */
  function setSide(side: "src" | "dst", path: string[]) {
    if (side === "src") (st.srcPath = path, st.srcCat = null, st.srcOff = 0, st.srcCatOff = 0);
    else (st.dstPath = path, st.dstCat = null, st.dstOff = 0, st.dstCatOff = 0);
  }

  const a = {
    cols: 0,
    rows: 0,
    dials: 0,
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      a.cols = ctx.cols;
      a.rows = ctx.rows;
      a.dials = ctx.dials;
      st.undoSecs = undoSecs();
      last = layoutXy(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i: number, delta: number) {
      // Ebenen: eigene Dials (4/5 am „+ XL“) oder Ebenen-Modus (Dial 1/2 am „+“)
      const side = i === 4 ? "src" : i === 5 ? "dst" : st.levelMode && i < 2 ? (i === 0 ? "src" : "dst") : null;
      if (side) {
        const n = topEntries(st, side).length;
        const key = side === "src" ? "srcCur" : "dstCur";
        st[key] = Math.min(Math.max(0, n - 1), Math.max(0, (st[key] ?? 0) + (delta > 0 ? 1 : -1)));
        a.onChange();
        return;
      }
      if (i === 0) st.selSrc = stepSelection(sideList(st, "src"), st.selSrc, delta);
      else if (i === 1) st.selDst = stepSelection(sideList(st, "dst"), st.selDst, delta);
      else if (i === 2) void run({ t: "media" });
      a.onChange();
    },
    onDialPress(i: number, down: boolean) {
      if (!down) return;
      const side = i === 4 ? "src" : i === 5 ? "dst" : st.levelMode && i < 2 ? (i === 0 ? "src" : "dst") : null;
      if (side) {
        const e = levelEntry(st, side);
        if (e) {
          if (side === "src") st.srcCur = 0;
          else st.dstCur = 0;
          void run(e.act);
        }
      } else if (i === 1) void run({ t: "take" });
      else if (i === 2 && a.dials < 6) {
        st.levelMode = !st.levelMode; // „+“: Dial 1/2 zwischen Auswahl und Ebenen umschalten
        a.onChange();
      } else if (i === 3) void run({ t: "auto" });
    },
    dispose() {
      clearTimeout(lastRunTimer);
    },
    async refresh() {
      try {
        const d = await io.load();
        st.sources = d.sources;
        st.sinks = d.sinks;
        st.routes = d.routes;
        if (d.nodes) {
          const model: XyModel = L()?.buildModel({ nodes: d.nodes, groupTree: d.groupTree, workflows: d.workflows });
          st.model = model && model.rootIds.length > 1 ? model : null; // nur „Nicht zugewiesen“ = keine Ebenen
          st.srcPath = validPath(st.model, st.srcPath ?? []);
          st.dstPath = validPath(st.model, st.dstPath ?? []);
        }
        st.bouquets = d.bouquets ?? [];
        st.canSaveBouquets = d.canSave === true && !!io.saveBouquet;
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
