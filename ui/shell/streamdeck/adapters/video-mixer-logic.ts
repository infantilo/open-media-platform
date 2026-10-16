// Video-Mixer-M/E-Adapter, reine Logik (Kap. 40.5): PGM-/PRE-Zeilen aus den
// Quellen, Steuerzeile (CUT, AUTO, DSK, Typ, Rate, FREEZE, PIP-Presets). Aufrufe sind
// dieselben Methoden wie bei den Bildschirm-Tasten des Bundles.

import type { AdapterLayout } from "../adapter.ts";
import type { KeyDef } from "../render-logic.ts";

export interface MixerState {
  /** inkl. BLK (senderId ""); `problem` = Status der Quell-Node (BCP-008): "error" = Unhealthy, "warn" = PartiallyHealthy. */
  entries: { label: string; senderId: string; problem?: "error" | "warn" }[];
  program: string;
  preset: string;
  keyer: boolean;
  pipEnabled: boolean;
  pipPresets: { id: string; name: string }[];
  activePip: string;
  transType: string;
  transRate: number;
}

export interface MixerAction {
  method: string;
  body?: Record<string, unknown>;
}

export const TRANS_TYPES = ["mix", "vfade", "fadecut", "cutfade"] as const;
export const TRANS_RATES = [6, 12, 25, 50] as const;
const TYPE_LABEL: Record<string, string> = { mix: "MIX", vfade: "V-FADE", fadecut: "FADE-CUT", cutfade: "CUT-FADE" };

/** Tastentitel: „omp-source-2 Sender 1“ → „source-2“ (Tasten sind klein). */
export function deckLabel(label: string): string {
  return label.replace(/^omp-/, "").replace(/\s+Sender\s*\d+$/i, "");
}

export interface MixerLayout extends AdapterLayout {
  act: (MixerAction | null)[][];
}

interface Plan {
  srcCap: number;
  srcPages: number;
  ctrlCap: number;
  ctrlChunks: number;
  pages: number;
}

function plan(entries: number, ctrls: number, cols: number, rows: number, reserve: boolean): Plan {
  const srcCap = Math.max(1, reserve ? cols - 1 : cols);
  const srcPages = Math.max(1, Math.ceil(entries / srcCap));
  const ctrlRows = rows >= 3 ? rows - 2 : rows;
  const ctrlCap = Math.max(1, ctrlRows * cols - (reserve ? 1 : 0));
  const ctrlChunks = Math.max(1, Math.ceil(ctrls / ctrlCap));
  const pages = rows >= 3 ? Math.max(srcPages, ctrlChunks) : rows === 2 ? srcPages + ctrlChunks : 2 * srcPages + ctrlChunks;
  return { srcCap, srcPages, ctrlCap, ctrlChunks, pages };
}

export function controlItems(s: MixerState): { key: KeyDef; act: MixerAction }[] {
  const items: { key: KeyDef; act: MixerAction }[] = [
    { key: { label: "CUT" }, act: { method: "crosspoint.cut" } },
    { key: { label: "AUTO" }, act: { method: "crosspoint.autoTrans" } },
    { key: { label: "DSK", state: s.keyer ? "onair" : "off" }, act: { method: "keyer.setEnabled", body: { enabled: !s.keyer } } },
    {
      key: { label: "Übergang", sub: TYPE_LABEL[s.transType] ?? s.transType },
      act: { method: "crosspoint.setTransType", body: { type: TRANS_TYPES[(TRANS_TYPES.indexOf(s.transType as never) + 1) % TRANS_TYPES.length] } },
    },
    {
      key: { label: "Rate", sub: s.transRate ? `${s.transRate} f` : "–" },
      act: { method: "crosspoint.setTransRate", body: { frames: TRANS_RATES[(TRANS_RATES.indexOf(s.transRate as never) + 1) % TRANS_RATES.length] } },
    },
    // Standbild des PGM-Bildes aufnehmen; es erscheint danach als angeheftete Quelle (auch als Taste).
    { key: { label: "FREEZE", sub: "Standbild" }, act: { method: "freeze.capture" } },
  ];
  for (const p of s.pipPresets) {
    const on = s.pipEnabled && s.activePip === p.id;
    items.push({
      key: { label: p.name || p.id, sub: "PIP", state: on ? "cue" : "off" },
      act: on ? { method: "pip.setEnabled", body: { enabled: false } } : { method: "pip.applyPreset", body: { id: p.id } },
    });
  }
  return items;
}

export function layoutVideoMixer(s: MixerState, cols: number, rows: number, page: number): MixerLayout {
  const ctrls = controlItems(s);
  let pl = plan(s.entries.length, ctrls.length, cols, rows, false);
  const reserve = pl.pages > 1;
  if (reserve) pl = plan(s.entries.length, ctrls.length, cols, rows, true);
  const p = Math.min(Math.max(0, page), pl.pages - 1);

  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (MixerAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));

  const srcRow = (r: number, bus: "pgm" | "pre", sp: number) => {
    const slice = s.entries.slice(sp * pl.srcCap, sp * pl.srcCap + pl.srcCap);
    slice.forEach((e, c) => {
      const cur = bus === "pgm" ? s.program : s.preset;
      const live = e.senderId === cur;
      // Quelle mit Problem: Taste rot (error) bzw. Zusatz „!“ (warn); liegt sie gerade auf dem Bus, bleibt dessen Farbe,
      // damit „auf Sendung“ erkennbar bleibt — der Hinweis steht dann im Untertitel.
      const flag = e.problem ? (e.problem === "error" ? " ✖" : " !") : "";
      keys[r][c] = {
        label: deckLabel(e.label) || "BLK",
        sub: bus.toUpperCase() + flag,
        state: live ? (bus === "pgm" ? "onair" : "preset") : e.problem === "error" ? "error" : "off",
      };
      act[r][c] = { method: bus === "pgm" ? "crosspoint.take" : "crosspoint.select", body: { senderId: e.senderId } };
    });
  };
  const ctrlRows = (from: number, count: number, chunk: number) => {
    ctrls.slice(chunk * pl.ctrlCap, chunk * pl.ctrlCap + pl.ctrlCap).forEach((it, i) => {
      const r = from + Math.floor(i / cols), c = i % cols;
      if (r < from + count) {
        keys[r][c] = it.key;
        act[r][c] = it.act;
      }
    });
  };

  if (rows >= 3) {
    srcRow(0, "pgm", p % pl.srcPages);
    srcRow(1, "pre", p % pl.srcPages);
    ctrlRows(2, rows - 2, p % pl.ctrlChunks);
  } else if (rows === 2) {
    if (p < pl.srcPages) {
      srcRow(0, "pgm", p);
      srcRow(1, "pre", p);
    } else ctrlRows(0, 2, p - pl.srcPages);
  } else if (p < 2 * pl.srcPages) srcRow(0, p % 2 === 0 ? "pgm" : "pre", Math.floor(p / 2));
  else ctrlRows(0, 1, p - 2 * pl.srcPages);

  return { keys, act, pages: pl.pages };
}
