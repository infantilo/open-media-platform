// MCR-Adapter (Hauptkontrollraum): dieselben API-Wege wie die MCR-Ansicht. Der Adapter gehört zur Ansicht `omp-mcr-view`
// (Tab am Gerät, solange die Ansicht geöffnet ist). Logik: mcr-logic.ts.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import { apiFetch } from "../../connection.ts";
import type { Graph } from "../../../modules/mcr/mcr-logic.ts";
import { type DeckEvent, layoutMcr, type McrAction, type McrLayout, type McrState, nextAct } from "./mcr-logic.ts";

export interface McrIO {
  load(): Promise<{ events: DeckEvent[]; graph: Graph }>;
  /** Passt die Kapazität für den Start? (false = Warnung, Bediener muss bestätigen.) */
  precheck(eventId: string): Promise<boolean>;
  transition(eventId: string, to: string): Promise<void>;
  ack(eventId: string, alarmId: string): Promise<void>;
  station(eventId: string, lineId: string, action: "listen" | "meter"): Promise<void>;
  pipLock(eventId: string, lineId: string): Promise<void>;
}

/** Zeit, in der der zweite Druck einen riskanten Wechsel bestätigt. */
export const ARM_MS = 4000;

type Obj = Record<string, any>;

export function mcrIO(): McrIO {
  const call = async (method: string, path: string, body?: unknown): Promise<Obj> => {
    const r = await apiFetch(`/api/v1/mcr${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: Obj = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.problems as string[] | undefined)?.join("; ") || String(data.error ?? r.status));
    return data;
  };
  return {
    async load() {
      const [list, wall] = await Promise.all([call("GET", "/events"), call("GET", "/monitor").catch(() => ({ events: [] }))]);
      const byId = new Map<string, Obj>((wall.events as Obj[] ?? []).map((e) => [String(e.id), e]));
      const events: DeckEvent[] = (list.events as Obj[] ?? []).filter((e) => e.state !== "done" && e.state !== "cancelled").map((e) => {
        const w = byId.get(String(e.id));
        const lines = ((w?.lines as Obj[] | undefined) ?? (e.lines as Obj[] | undefined) ?? []).map((l) => ({
          id: String(l.id),
          name: String(l.name ?? l.id),
          level: String(l.level ?? ""),
          alarms: ((l.alarmItems as Obj[] | undefined) ?? []).map((a) => ({ id: String(a.id), kind: String(a.kind ?? ""), severity: String(a.severity ?? "") })),
        }));
        return { id: String(e.id), name: String(e.name ?? e.id), state: String(e.state), level: String(w?.level ?? ""), access: (w?.access ?? e.access) as DeckEvent["access"], lines };
      });
      return { events, graph: (list.lifecycle ?? {}) as Graph };
    },
    async precheck(id) {
      try {
        return (await call("GET", `/events/${id}/precheck`)).ok !== false;
      } catch {
        return true; // Vorprüfung nicht erreichbar: der Server entscheidet beim Wechsel
      }
    },
    async transition(id, to) {
      await call("POST", `/events/${id}/transition`, { to, confirm: true });
    },
    async ack(id, alarmId) {
      await call("POST", `/events/${id}/alarms/${alarmId}/ack`, {});
    },
    async station(id, lineId, action) {
      await call("POST", `/events/${id}/lines/${lineId}/monitor`, { action });
    },
    async pipLock(id, lineId) {
      await call("POST", `/events/${id}/alarm-pip`, { lock: lineId });
    },
  };
}

export function mcrAdapter(io: McrIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  const st: McrState = { events: [], graph: {}, sel: null, act: "listen", armed: null, warn: null };
  let last: McrLayout | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(armTimer);
    st.armed = null;
  };

  async function run(x: McrAction) {
    const ev = st.sel ? st.events.find((e) => e.id === st.sel) : undefined;
    switch (x.t) {
      case "open":
        disarm();
        st.sel = x.id;
        st.warn = null;
        a.onChange();
        return;
      case "back":
        disarm();
        st.sel = null;
        a.onChange();
        return;
      case "cycleAct":
        st.act = nextAct(st.act);
        a.onChange();
        return;
      case "step": {
        if (!ev) return;
        if (x.confirm) {
          // Erster Druck: Vorprüfung (nur Wechsel nach „Test“), dann scharf stellen.
          st.warn = x.to === "testing" ? ((await io.precheck(ev.id)) ? null : "capacity") : null;
          st.armed = x.to;
          clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            st.armed = null;
            a.onChange();
          }, ARM_MS);
          a.onChange();
          return;
        }
        disarm();
        await io.transition(ev.id, x.to);
        st.warn = null;
        await a.refresh();
        return;
      }
      case "ackAll": {
        if (!ev) return;
        for (const l of ev.lines) for (const al of l.alarms) await io.ack(ev.id, al.id);
        await a.refresh();
        return;
      }
      case "line": {
        const l = ev?.lines.find((v) => v.id === x.id);
        if (!ev || !l) return;
        if (st.act === "ack") for (const al of l.alarms) await io.ack(ev.id, al.id);
        else if (st.act === "pip") await io.pipLock(ev.id, l.id);
        else await io.station(ev.id, l.id, st.act);
        await a.refresh();
      }
    }
  }

  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      last = layoutMcr(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (!x) return;
      void run(x).catch((e) => {
        disarm();
        a.onError(e);
        a.onChange();
      });
    },
    async refresh() {
      try {
        const r = await io.load();
        st.events = r.events;
        st.graph = r.graph;
        if (st.sel && !st.events.some((e) => e.id === st.sel)) st.sel = null; // Event gelöscht/abgeschlossen
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    },
    dispose() {
      clearTimeout(armTimer);
    },
  };
  return a;
}
