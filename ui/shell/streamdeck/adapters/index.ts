// Adapter-Auflösung (Kap. 40.4/40.5): eigener `streamDeck`-Adapter des Elements
// → shell-seitige Fabrik nach Elementname (Bundle bietet `deckApi`) → keiner
// (Broker nimmt dann das Auto-Raster).

import { adapterOf, type StreamDeckAdapter } from "../adapter.ts";
import { videoMixerAdapter, type VideoMixerApi } from "./video-mixer.ts";

const FACTORIES: Record<string, ((api: never) => StreamDeckAdapter) | undefined> = {
  "omp-video-mixer-me-panel": videoMixerAdapter as (api: never) => StreamDeckAdapter,
};

export function adapterFor(el: Element): StreamDeckAdapter | null {
  const own = adapterOf(el);
  if (own) return own;
  const f = FACTORIES[el.localName];
  const api = (el as unknown as { deckApi?: VideoMixerApi }).deckApi;
  return f && api ? f(api as never) : null;
}
