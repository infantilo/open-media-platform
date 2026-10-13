// Geräte-Hub-Adapter, reine Logik: je Ein-/Ausgangsgerät eine Taste (EIN/AUS = anbieten), grün = an.
// Erste Taste: NEU SUCHEN (rescan). Mehr Geräte als Tasten → Seiten (der Broker belegt die letzte Taste).

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef } from "../render-logic.ts";

export interface Device {
  id: string;
  name: string;
  kind: string; // "video" | "audio"
  direction: string; // "input" | "output"
  offered: boolean;
  present: boolean;
  status: string;
}

export type HubAction = { t: "toggle"; id: string; on: boolean } | { t: "rescan" };

export interface HubLayout extends AdapterLayout {
  act: (HubAction | null)[][];
}

const kindText = (d: Device) => `${d.kind === "video" ? "Video" : "Audio"} ${d.direction === "output" ? "Aus" : "Ein"}`;

export function deviceKey(d: Device): KeyDef {
  const err = d.status.startsWith("error");
  return {
    label: d.name,
    sub: `${kindText(d)} · ${d.offered ? "EIN" : "AUS"}`,
    state: err ? "error" : d.offered ? "preset" : "off",
    dim: !d.present,
  };
}

export function layoutHub(devices: Device[], cols: number, rows: number, dialCount: number, page: number): HubLayout {
  const slots = Math.max(1, rows * cols);
  const items: { key: KeyDef; act: HubAction }[] = [
    { key: { label: "NEU SUCHEN", state: "cue" }, act: { t: "rescan" } },
    ...devices.map((d) => ({ key: deviceKey(d), act: { t: "toggle", id: d.id, on: !d.offered } as HubAction })),
  ];
  const cap = items.length > slots ? Math.max(1, slots - 1) : slots;
  const pages = Math.max(1, Math.ceil(items.length / cap));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (HubAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  items.slice(p * cap, p * cap + cap).forEach((it, i) => {
    keys[Math.floor(i / cols)][i % cols] = it.key;
    act[Math.floor(i / cols)][i % cols] = it.act;
  });
  const on = devices.filter((d) => d.offered).length;
  const dials: DialDef[] = [
    { label: "Angeboten", value: `${on}/${devices.length}`, fill: devices.length ? on / devices.length : 0 },
    { label: "Eingänge", value: String(devices.filter((d) => d.direction === "input" && d.offered).length) },
    { label: "Ausgänge", value: String(devices.filter((d) => d.direction === "output" && d.offered).length) },
    { label: "Fehler", value: String(devices.filter((d) => d.status.startsWith("error")).length), dim: !devices.some((d) => d.status.startsWith("error")) },
  ];
  return { keys, act, dials: dials.slice(0, dialCount), pages };
}
