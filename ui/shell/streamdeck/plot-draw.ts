// Zeichnet einen PlotSlice (Ausschnitt einer Kurve über mehrere Tasten/Dial-Felder).
import { compOutDb, eqResponseDb, type PlotSlice, type PlotSpec } from "./plot-logic.ts";

export interface Palette {
  bg: string;
  grid: string;
  dim: string;
  line: string;
  accent: string;
  text: string;
}

type Ctx = OffscreenCanvasRenderingContext2D;

function drawEq(g: Ctx, s: Extract<PlotSpec, { kind: "eq" }>, W: number, H: number, p: Palette) {
  const pad = Math.max(4, H * 0.06);
  const X = (f: number) => pad + (Math.log10(f / 20) / 3) * (W - 2 * pad);
  const Y = (db: number) => H / 2 - (db / 18) * (H / 2 - pad);
  g.lineWidth = 1;
  g.strokeStyle = p.grid;
  for (const f of [100, 1000, 10000]) {
    g.beginPath(); g.moveTo(X(f), pad); g.lineTo(X(f), H - pad); g.stroke();
  }
  for (const d of [-12, -6, 6, 12]) {
    g.beginPath(); g.moveTo(pad, Y(d)); g.lineTo(W - pad, Y(d)); g.stroke();
  }
  g.strokeStyle = p.dim;
  g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(W - pad, Y(0)); g.stroke();
  g.lineWidth = Math.max(2, H * 0.025);
  g.strokeStyle = s.bypass ? p.dim : p.accent;
  g.lineJoin = "round";
  g.beginPath();
  const n = Math.max(40, Math.round(W / 4));
  for (let i = 0; i <= n; i++) {
    const f = 20 * Math.pow(1000, i / n);
    const y = Y(Math.max(-18, Math.min(18, eqResponseDb(s, f))));
    if (i) g.lineTo(X(f), y); else g.moveTo(X(f), y);
  }
  g.stroke();
  // Bandpunkte, fokussiertes Band gefüllt
  s.bands.forEach((b, i) => {
    g.beginPath();
    g.arc(X(b.f), Y(Math.max(-18, Math.min(18, b.g))), Math.max(3, H * 0.035), 0, Math.PI * 2);
    g.fillStyle = i === s.focus ? p.text : "transparent";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = p.text;
    g.stroke();
  });
}

function drawDyn(g: Ctx, s: Extract<PlotSpec, { kind: "dyn" }>, W: number, H: number, p: Palette) {
  const pad = Math.max(4, Math.min(W, H) * 0.08);
  const side = Math.min(W - 2 * pad, H - 2 * pad);
  const x0 = (W - side) / 2, y0 = (H - side) / 2;
  const lo = -60, hi = 0; // Eingang −60…0 dB, gleiche Skala für den Ausgang
  const X = (db: number) => x0 + ((Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * side;
  const Y = (db: number) => y0 + side - ((Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * side;
  g.lineWidth = 1;
  g.strokeStyle = p.grid;
  for (const d of [-48, -36, -24, -12]) {
    g.beginPath(); g.moveTo(X(d), y0); g.lineTo(X(d), y0 + side); g.stroke();
    g.beginPath(); g.moveTo(x0, Y(d)); g.lineTo(x0 + side, Y(d)); g.stroke();
  }
  g.strokeStyle = p.dim;
  g.strokeRect(x0, y0, side, side);
  g.beginPath(); g.moveTo(X(lo), Y(lo)); g.lineTo(X(hi), Y(hi)); g.stroke(); // 1:1
  if (s.gateOn && s.gateThr > lo) { // Gate-Schwelle
    g.strokeStyle = p.dim;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(X(s.gateThr), y0); g.lineTo(X(s.gateThr), y0 + side); g.stroke();
    g.setLineDash([]);
  }
  g.lineWidth = Math.max(2, side * 0.03);
  g.strokeStyle = s.on ? p.accent : p.dim;
  g.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = lo + (i / 60) * (hi - lo);
    const y = compOutDb(s, x);
    if (i) g.lineTo(X(x), Y(y)); else g.moveTo(X(x), Y(y));
  }
  g.stroke();
  g.beginPath(); // Schwellenpunkt
  g.arc(X(s.thr), Y(compOutDb(s, s.thr)), Math.max(3, side * 0.035), 0, Math.PI * 2);
  g.fillStyle = p.text;
  g.fill();
}

/** Zeichnet den Ausschnitt `sl` in ein Feld der Größe cellW × cellH (Ursprung 0,0); Block = cw × ch Zellen. */
export function drawPlotSlice(g: Ctx, sl: PlotSlice, cellW: number, cellH: number, p: Palette, alpha = 1) {
  g.save();
  g.beginPath();
  g.rect(0, 0, cellW, cellH);
  g.clip();
  g.translate(-sl.cx * cellW, -sl.cy * cellH);
  g.globalAlpha = alpha;
  const W = sl.cw * cellW, H = sl.ch * cellH;
  if (sl.spec.kind === "eq") drawEq(g, sl.spec, W, H, p);
  else drawDyn(g, sl.spec, W, H, p);
  g.restore();
}
