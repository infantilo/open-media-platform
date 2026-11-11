// Die eine MIDI-Sitzung der Seite (Kap. 93) mit den echten Abhängigkeiten: Node-Proxy-API, Live-Strom per EventSource.

import { apiFetch } from "../connection.ts";
import { getToken } from "../auth.ts";
import { proxyIO } from "../streamdeck/autoraster.ts";
import { MidiSession } from "./session.ts";

export const midiSession = new MidiSession({
  ioFor: (id) => proxyIO(id),
  openStream: (nodeId, param, onMessage) => {
    const token = getToken();
    const url = `/api/v1/nodes/${nodeId}/stream/${param}` + (token ? `?access_token=${encodeURIComponent(token)}` : "");
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch { /* kaputte Zeile überspringen */ }
    };
    return () => es.close();
  },
  resolveNode: async (label) => {
    const r = await apiFetch("/api/v1/nodes");
    if (!r.ok) return null;
    const nodes = (await r.json()) as { id: string; label: string; online?: boolean }[];
    return nodes.find((n) => n.label === label && n.online !== false)?.id ?? null;
  },
});

// Seite schließen: Pulte sauber loslassen (Anzeige leer, Fader bleiben stehen).
globalThis.addEventListener?.("pagehide", () => midiSession.stop());

/** Beispielprofil für das Eingabefeld: ein Fader, eine Stumm-Taste, ein Drehgeber. */
export const EXAMPLE_PROFILE = {
  name: "Beispiel",
  controls: [
    { id: "fader1", label: "Fader 1", in: { type: "cc", channel: 1, num: 7 }, to: { method: "channel.<kanal-id>.setGain", arg: "db", min: -60, max: 12 } },
    { id: "mute1", label: "Stumm 1", in: { type: "note", channel: 1, num: 36 }, mode: "toggle", to: { method: "channel.<kanal-id>.setMute", arg: "muted" } },
    { id: "knob1", label: "Drehgeber 1", in: { type: "cc", channel: 1, num: 16 }, mode: "relative", to: { method: "channel.<kanal-id>.setGain", arg: "db", readParam: "channel.<kanal-id>.gainDb", step: 0.5, min: -60, max: 12 } },
  ],
};
