// Wellenform auf der Zeitleiste des Review-Players: je Bild und Tonspur ein Spitzenwert (0–255, 0 = ≤ −60 dBFS, 255 = 0 dBFS;
// Server: `GET …/peaks/{track}`). Gezeichnet wird das Maximum der gerade hörbaren Spuren — Ton-Ein- und Ausstiege sind so
// vor dem Abhören zu sehen (Stille = flache Linie).

/** Spitzenwert je Bildschirmspalte: Maximum über alle Bilder der Spalte und alle hörbaren, geladenen Spuren. */
export function reduceColumns(peaks: Array<Uint8Array | null>, audible: boolean[], width: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, width));
  const frames = peaks.find((p) => p)?.length ?? 0;
  if (!frames || width <= 0) return out;
  for (let c = 0; c < width; c++) {
    const a = Math.floor((c * frames) / width);
    const b = Math.max(a + 1, Math.floor(((c + 1) * frames) / width));
    let m = 0;
    for (let t = 0; t < peaks.length; t++) {
      const p = peaks[t];
      if (!p || !audible[t]) continue;
      for (let f = a; f < b && f < p.length; f++) if (p[f] > m) m = p[f];
    }
    out[c] = m;
  }
  return out;
}

export class Waveform {
  readonly canvas: HTMLCanvasElement;
  #peaks: Array<Uint8Array | null>;
  #audible: boolean[];
  #urlFor: (track: number) => string;
  #ro?: ResizeObserver;

  constructor(tracks: number, urlFor: (track: number) => string) {
    this.#peaks = Array.from({ length: tracks }, () => null);
    this.#audible = Array.from({ length: tracks }, () => true);
    this.#urlFor = urlFor;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    this.canvas.dataset.role = "waveform";
    if (typeof ResizeObserver !== "undefined") {
      this.#ro = new ResizeObserver(() => this.draw());
      this.#ro.observe(this.canvas);
    }
  }

  /** Spuren nacheinander laden (zuerst die hörbaren); Fehler einer Spur lassen die anderen unberührt. */
  async load(): Promise<void> {
    for (let t = 0; t < this.#peaks.length; t++) {
      try {
        const res = await fetch(this.#urlFor(t));
        if (!res.ok) continue;
        this.#peaks[t] = new Uint8Array(await res.arrayBuffer());
        this.draw();
      } catch { /* Wellenform ist Zusatz — ohne sie bleibt der Player voll bedienbar */ }
    }
  }

  setAudible(a: boolean[]): void {
    this.#audible = a;
    this.draw();
  }

  draw(): void {
    const cv = this.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr);
    const h = Math.round(cv.clientHeight * dpr);
    if (w <= 0 || h <= 0) return;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const g = cv.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const cols = reduceColumns(this.#peaks, this.#audible, w);
    g.fillStyle = "rgba(147,161,186,0.55)";
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const a = (cols[x] / 255) * mid * 0.95;
      g.fillRect(x, mid - Math.max(0.5 * dpr, a), 1, Math.max(1 * dpr, 2 * a));
    }
  }

  destroy(): void {
    this.#ro?.disconnect();
  }
}
