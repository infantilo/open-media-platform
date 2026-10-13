// Video-Mixer-M/E-Adapter (Kap. 40.5). Das Bundle bietet nur `deckApi`
// (Zustand lesen, Methode aufrufen); Layout/Eingabe liegen hier (testbar).

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../adapter.ts";
import { layoutVideoMixer, type MixerAction, type MixerLayout, type MixerState } from "./video-mixer-logic.ts";

export interface VideoMixerApi {
  state(): MixerState | null;
  call(method: string, body?: Record<string, unknown>): Promise<unknown>;
}

export function videoMixerAdapter(api: VideoMixerApi): StreamDeckAdapter {
  let last: MixerLayout | null = null;
  return {
    getLayout(ctx: LayoutContext): AdapterLayout {
      const s = api.state();
      if (!s) return { keys: [[{ label: "…", dim: true }]] };
      last = layoutVideoMixer(s, ctx.cols, ctx.rows, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const a: MixerAction | null | undefined = last?.act[row]?.[col];
      if (a) void api.call(a.method, a.body);
    },
  };
}
