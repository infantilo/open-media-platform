// Geräte-Hub-Adapter (Kap. 40): Taste je Gerät schaltet „anbieten“ (setOffered) wie der Schalter im Panel.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import { type Device, type HubLayout, layoutHub } from "./device-hub-logic.ts";

export interface HubIO {
  getParam(name: string): Promise<unknown>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

export function deviceHubAdapter(io: HubIO): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  let devices: Device[] = [];
  let last: HubLayout | null = null;

  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      last = layoutHub(devices, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row: number, col: number, down: boolean) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (!x) return;
      void (async () => {
        try {
          if (x.t === "rescan") {
            await io.call("rescan");
            setTimeout(() => void a.refresh(), 1500);
          } else {
            const d = devices.find((v) => v.id === x.id);
            if (d) d.offered = x.on; // sofort sichtbar, refresh bestätigt
            a.onChange();
            await io.call("setOffered", { id: x.id, on: x.on });
            await a.refresh();
          }
        } catch (e) {
          a.onError(e);
          await a.refresh();
        }
        a.onChange();
      })();
    },
    async refresh() {
      try {
        const raw = await io.getParam("devices");
        const v = typeof raw === "string" ? JSON.parse(raw) : raw;
        devices = (Array.isArray(v) ? v : []).map((d: Record<string, unknown>) => ({
          id: String(d.id),
          name: String(d.name ?? d.id),
          kind: String(d.kind ?? ""),
          direction: String(d.direction ?? "input"),
          offered: d.offered === true,
          present: d.present !== false,
          status: String(d.status ?? ""),
        }));
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    },
  };
  return a;
}
