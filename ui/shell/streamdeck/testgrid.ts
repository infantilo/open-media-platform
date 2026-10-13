// Testraster (Kap. 40.2): nummerierte Tasten mit Pfeil nach oben (Drehung
// am Gerät erkennbar), Streifen mit Dial-Nummern. Canvas → JPEG.
// Vollwertige Render-Engine folgt in 40.3.

import type { DeckModel } from "./models.ts";

async function jpeg(c: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob = c instanceof OffscreenCanvas
    ? await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })
    : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => b ? res(b) : rej(new Error("toBlob")), "image/jpeg", 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

/** `rotate180`: Bild vor dem Kodieren drehen (Modelleigenschaft). */
export async function keyTestImage(m: DeckModel, index: number, label = String(index + 1)): Promise<Uint8Array> {
  const s = m.keySize;
  const c = new OffscreenCanvas(s, s);
  const g = c.getContext("2d")!;
  if (m.rotate180) {
    g.translate(s, s);
    g.rotate(Math.PI);
  }
  g.fillStyle = `hsl(${(index * 47) % 360} 55% 30%)`;
  g.fillRect(0, 0, s, s);
  g.fillStyle = "#fff";
  g.beginPath(); // Pfeil „oben“
  g.moveTo(s / 2, s * 0.08);
  g.lineTo(s * 0.62, s * 0.24);
  g.lineTo(s * 0.38, s * 0.24);
  g.fill();
  g.font = `bold ${Math.round(s * 0.42)}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, s / 2, s * 0.6);
  return jpeg(c);
}

export async function stripTestImage(w: number, h: number, text: string): Promise<Uint8Array> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.fillStyle = "#123";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#6af";
  g.strokeRect(1, 1, w - 2, h - 2);
  g.fillStyle = "#fff";
  g.font = `bold ${Math.round(h * 0.4)}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2);
  return jpeg(c);
}

/** Sendet das komplette Raster (Tasten + Streifen-Segmente je Dial). */
export async function sendTestGrid(
  dev: { model: DeckModel; setKeyImage(i: number, j: Uint8Array): Promise<void>; setStripImage(x: number, y: number, w: number, h: number, j: Uint8Array): Promise<void> },
): Promise<void> {
  const m = dev.model;
  for (let i = 0; i < m.cols * m.rows; i++) await dev.setKeyImage(i, await keyTestImage(m, i));
  if (m.strip && m.dials) {
    const w = m.strip.w / m.dials;
    for (let d = 0; d < m.dials; d++) await dev.setStripImage(w * d, 0, w, m.strip.h, await stripTestImage(w, m.strip.h, `D${d + 1}`));
  }
}
