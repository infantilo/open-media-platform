// Canvas-Rasterizer (Kap. 40.3): KeyDef/DialDef → JPEG. Farben aus den
// `--omp-*`-Tokens (design-tokens.css), Drehung je Modell, Text mit Umbruch.

import { type DeckModel, type Rotation, rotatedSize, rotationMatrix } from "./models.ts";
import type { DialDef, KeyDef, KeyState, Rasterizer } from "./render-logic.ts";

const STATE_TOKEN: Record<KeyState, string> = {
  onair: "--omp-onair",
  preset: "--omp-preset",
  cue: "--omp-cue",
  off: "--omp-surface-raised",
  error: "--omp-error",
};
const FALLBACK: Record<string, string> = {
  "--omp-onair": "#e53935",
  "--omp-preset": "#43a047",
  "--omp-cue": "#fb8c00",
  "--omp-error": "#ef5350",
  "--omp-surface": "#0f1522",
  "--omp-surface-raised": "#172033",
  "--omp-bg": "#080c16",
  "--omp-text": "#eaf0fa",
  "--omp-text-dim": "#93a1ba",
  "--omp-accent-cyan": "#19d3f3",
};

/** Token (`--omp-x`) oder Farbwert → Farbstring; Tokens aus dem Dokument, sonst Rückfall. */
export function resolveColor(c: string): string {
  if (!c.startsWith("--")) return c;
  const v = typeof document !== "undefined"
    ? getComputedStyle(document.documentElement).getPropertyValue(c).trim()
    : "";
  return v || FALLBACK[c] || "#000";
}

function wrap(g: OffscreenCanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let l = lines[maxLines - 1];
    while (l.length > 1 && g.measureText(`${l}…`).width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = `${l}…`;
  }
  // Einzelnes überlanges Wort hart kürzen.
  return lines.map((l) => {
    while (l.length > 1 && g.measureText(l).width > maxW) l = l.slice(0, -2) + "…";
    return l;
  });
}

async function toJpeg(c: OffscreenCanvas): Promise<Uint8Array> {
  const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return new Uint8Array(await b.arrayBuffer());
}

export function drawKey(def: KeyDef | null, m: DeckModel): OffscreenCanvas {
  const s = m.keySize;
  const c = new OffscreenCanvas(s, s);
  const g = c.getContext("2d")!;
  g.setTransform(...rotationMatrix(m.rotation, s, s));
  g.fillStyle = resolveColor("--omp-bg");
  g.fillRect(0, 0, s, s);
  if (!def) return c;
  const accent = def.color ? resolveColor(def.color) : def.state ? resolveColor(STATE_TOKEN[def.state]) : "";
  const lit = def.state === "onair" || def.state === "preset" || def.state === "cue" || def.state === "error";
  g.fillStyle = lit && accent ? accent : resolveColor("--omp-surface-raised");
  g.fillRect(2, 2, s - 4, s - 4);
  if (!lit && accent) { // Zustandsbalken oben
    g.fillStyle = accent;
    g.fillRect(2, 2, s - 4, Math.max(4, Math.round(s * 0.06)));
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = resolveColor("--omp-text");
  let y = s * 0.5;
  if (def.icon) {
    g.font = `${Math.round(s * 0.34)}px sans-serif`;
    g.fillText(def.icon, s / 2, s * 0.3);
    y = s * 0.66;
  }
  if (def.label) {
    const fs = Math.round(s * (def.icon ? 0.17 : 0.2));
    g.font = `bold ${fs}px sans-serif`;
    const lines = wrap(g, def.label, s - 10, def.icon ? 2 : 3);
    const top = y - ((lines.length - 1) * fs * 1.1) / 2 - (def.sub ? fs * 0.5 : 0);
    lines.forEach((l, i) => g.fillText(l, s / 2, top + i * fs * 1.1));
    if (def.sub) {
      g.font = `${Math.round(s * 0.14)}px sans-serif`;
      g.fillStyle = lit ? "rgba(255,255,255,0.85)" : resolveColor("--omp-text-dim");
      const sub = wrap(g, def.sub, s - 10, 1)[0] ?? "";
      g.fillText(sub, s / 2, top + lines.length * fs * 1.1 + fs * 0.1);
    }
  }
  if (def.dim) {
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, 0, s, s);
  }
  return c;
}

export function drawDial(def: DialDef | null, w: number, h: number, rotation: Rotation = 0): OffscreenCanvas {
  const [cw, ch] = rotatedSize(rotation, w, h);
  const c = new OffscreenCanvas(cw, ch);
  const g = c.getContext("2d")!;
  g.setTransform(...rotationMatrix(rotation, w, h));
  g.fillStyle = resolveColor("--omp-surface");
  g.fillRect(0, 0, w, h);
  if (!def) return c;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = resolveColor("--omp-text-dim");
  g.font = `${Math.round(h * 0.2)}px sans-serif`;
  g.fillText(wrap(g, def.label, w - 12, 1)[0] ?? "", w / 2, h * 0.2);
  g.fillStyle = resolveColor("--omp-text");
  g.font = `bold ${Math.round(h * 0.3)}px sans-serif`;
  g.fillText(wrap(g, def.value, w - 12, 1)[0] ?? "", w / 2, h * 0.52);
  if (def.fill !== undefined) {
    const f = Math.max(0, Math.min(1, def.fill));
    g.fillStyle = resolveColor("--omp-surface-raised");
    g.fillRect(12, h * 0.8, w - 24, h * 0.1);
    g.fillStyle = resolveColor("--omp-accent-cyan");
    g.fillRect(12, h * 0.8, (w - 24) * f, h * 0.1);
  }
  if (def.dim) {
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, 0, w, h);
  }
  return c;
}

export const canvasRasterizer: Rasterizer = {
  key: (d, m) => toJpeg(drawKey(d, m)),
  dial: (d, w, h, rot) => toJpeg(drawDial(d, w, h, rot)),
};
