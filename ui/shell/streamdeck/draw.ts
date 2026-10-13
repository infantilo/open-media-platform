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

type Ctx = OffscreenCanvasRenderingContext2D;

/** Umbruch an Wortgrenzen; zu lange Wörter werden zeichenweise getrennt (ohne Auslassungspunkte). */
function wrapHard(g: Ctx, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) lines.push(cur);
    cur = "";
  };
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW) {
      cur = next;
      continue;
    }
    push();
    if (g.measureText(w).width <= maxW) {
      cur = w;
      continue;
    }
    for (const ch of w) { // überlanges Wort
      if (g.measureText(cur + ch).width > maxW && cur) push();
      cur += ch;
    }
  }
  push();
  return lines;
}

/** Größte Schrift (maxFs…minFs), bei der der umbrochene Text in die Box passt; sonst kleinste mit „…“ in der letzten Zeile. */
function fitText(g: Ctx, text: string, maxW: number, maxH: number, maxFs: number, minFs: number, weight: string): { lines: string[]; fs: number } {
  let lines: string[] = [];
  let fs = maxFs;
  // 1. Durchgang: größte Schrift, bei der kein Wort getrennt werden muss; 2.: Wörter zeichenweise trennen.
  for (const noSplit of [true, false]) {
    for (fs = maxFs; fs >= minFs; fs -= 1) {
      g.font = `${weight} ${fs}px sans-serif`;
      if (noSplit && text.split(/\s+/).some((w) => g.measureText(w).width > maxW)) continue;
      lines = wrapHard(g, text, maxW);
      if (lines.length * fs * 1.12 <= maxH) return { lines, fs };
    }
  }
  fs = minFs;
  g.font = `${weight} ${fs}px sans-serif`;
  lines = wrapHard(g, text, maxW);
  const n = Math.max(1, Math.floor(maxH / (fs * 1.12)));
  if (lines.length > n) {
    lines.length = n;
    let l = lines[n - 1];
    while (l.length > 1 && g.measureText(`${l}…`).width > maxW) l = l.slice(0, -1);
    lines[n - 1] = `${l}…`;
  }
  return { lines, fs };
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
  g.fillStyle = resolveColor("--omp-text");
  const maxW = s - 10;
  let top = 6;
  let bottom = s - 6;
  if (def.icon) {
    g.font = `${Math.round(s * 0.3)}px sans-serif`;
    g.fillText(def.icon, s / 2, top + s * 0.16);
    top += s * 0.3;
  }
  if (def.sub) {
    const sub = fitText(g, def.sub, maxW, s * 0.2, Math.round(s * 0.15), Math.round(s * 0.1), "");
    g.fillStyle = lit ? "rgba(255,255,255,0.85)" : resolveColor("--omp-text-dim");
    const lh = sub.fs * 1.12;
    sub.lines.forEach((l, i) => g.fillText(l, s / 2, bottom - (sub.lines.length - i - 0.5) * lh));
    bottom -= sub.lines.length * lh + 2;
  }
  if (def.label) {
    g.fillStyle = resolveColor("--omp-text");
    const lab = fitText(g, def.label, maxW, Math.max(s * 0.2, bottom - top), Math.round(s * (def.icon ? 0.19 : 0.24)), Math.round(s * 0.11), "bold");
    const lh = lab.fs * 1.12;
    const y0 = top + (bottom - top - lab.lines.length * lh) / 2 + lh / 2;
    lab.lines.forEach((l, i) => g.fillText(l, s / 2, y0 + i * lh));
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
