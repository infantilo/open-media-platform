// Adapter-Auflösung (Kap. 40.4–40.6): eigener `streamDeck`-Adapter des Elements
// → shell-seitige Fabrik nach Elementname (Video-Mixer: Bundle bietet `deckApi`;
// Audio-Mixer: reine Proxy-API; X/Y-Panel: Kern-API Quellen/Senken/Graph) → keiner (Broker nimmt dann das Auto-Raster).

import { adapterOf, type StreamDeckAdapter } from "../adapter.ts";
import { proxyIO } from "../autoraster.ts";
import { audioMixerAdapter } from "./audio-mixer.ts";
import { deviceHubAdapter } from "./device-hub.ts";
import { ografAdapter } from "./ograf.ts";
import { coreIO, xyPanelAdapter } from "./xy-panel.ts";
import { videoMixerAdapter, type VideoMixerApi } from "./video-mixer.ts";

type Factory = (el: Element, nodeId: string) => StreamDeckAdapter | null;

const FACTORIES: Record<string, Factory | undefined> = {
  "omp-video-mixer-me-panel": (el) => {
    const api = (el as unknown as { deckApi?: VideoMixerApi }).deckApi;
    return api ? videoMixerAdapter(api) : null;
  },
  "omp-xy-panel": (_el, nodeId) => xyPanelAdapter(coreIO(nodeId)),
  "omp-ograf-panel": (_el, nodeId) => ografAdapter(proxyIO(nodeId)),
  "omp-device-hub-panel": (_el, nodeId) => deviceHubAdapter(proxyIO(nodeId)),
  "omp-audio-mixer-panel": (_el, nodeId) => audioMixerAdapter(proxyIO(nodeId)),
};

export function adapterFor(el: Element, nodeId: string): StreamDeckAdapter | null {
  return adapterOf(el) ?? FACTORIES[el.localName]?.(el, nodeId) ?? null;
}
