// Fader der Simulator-Ansicht im Stil der Audiomischer-Fader (nodes/omp-audio-mixer/ui/00-core.js `Fader`): dunkle Spur, geriffelter Griff,
// Nullmarke, Anzeige in dB, Ziehen mit Zeiger (seitlich weg oder Shift = fein ×0,2), Doppelklick = 0 dB, Pfeiltasten ±0,5 dB, Raste bei 0 dB.
// Geliefert wird die Stellung als 14-Bit-Wert, so wie ein Fahrfader sie meldet; Berühren/Loslassen wie am Gerät.

import { dbToFader, FADER_MAX, faderToDb } from "./fader-law.ts";

export const SIM_FADER_CSS = `
.fader{position:relative;width:34px;height:128px;user-select:none;-webkit-user-select:none;touch-action:none;outline:none}
.fader:focus-visible{outline:1px solid var(--omp-accent,#4a90d9)}
.ftrack{position:absolute;left:50%;top:6px;bottom:6px;width:4px;margin-left:-2px;background:#020202;border:1px solid #333;border-radius:3px}
.fzero{position:absolute;left:3px;right:3px;height:1px;background:#777}
.fthumb{position:absolute;left:50%;width:26px;height:14px;margin-left:-13px;border-radius:3px;border:1px solid #000;
  background:repeating-linear-gradient(#bdbdbd 0 2px,#7c7c7c 2px 3px),linear-gradient(90deg,#6a6a6a,#d8d8d8 40%,#9c9c9c 60%,#5a5a5a);
  box-shadow:0 2px 4px #000c,0 1px 0 #fff6 inset}
.fader.drag .fthumb{filter:brightness(1.15)}
.fader.fine .fthumb{outline:2px dashed #e8a33a}
.fread{display:block;text-align:center;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--omp-accent,#4a90d9);white-space:nowrap;margin-top:2px}
`;

export interface SimFaderOptions {
  onTouch(down: boolean): void;
  /** Neue Stellung 0…16383 (während des Ziehens, mehrfach). */
  onMove(value14: number): void;
}

const fmtSigned = (v: number) => (v > 0.0001 ? "+" : v < -0.0001 ? "−" : "") + Math.abs(v).toFixed(1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class SimFader {
  readonly root = document.createElement("div");
  readonly read = document.createElement("span");
  readonly wrap = document.createElement("div");
  #track = document.createElement("div");
  #thumb = document.createElement("div");
  #zero = document.createElement("i");
  #value = 0;
  #dragging = false;
  #fine = false;
  #anchorPos = 0;
  #anchorPtr = 0;
  #lastTap = 0;

  constructor(private o: SimFaderOptions) {
    this.root.className = "fader";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "slider");
    this.root.setAttribute("aria-valuemin", "-60");
    this.root.setAttribute("aria-valuemax", "12");
    this.root.setAttribute("aria-orientation", "vertical");
    this.#track.className = "ftrack";
    this.#zero.className = "fzero";
    this.#thumb.className = "fthumb";
    this.#track.append(this.#zero, this.#thumb);
    this.root.append(this.#track);
    this.read.className = "fread";
    this.wrap.append(this.root, this.read);
    this.root.addEventListener("pointerdown", (e) => this.#down(e));
    this.root.addEventListener("pointermove", (e) => this.#move(e));
    this.root.addEventListener("pointerup", (e) => this.#up(e));
    this.root.addEventListener("pointercancel", (e) => this.#up(e));
    this.root.addEventListener("keydown", (e) => this.#key(e));
    this.render();
  }

  /** Stellung vom Gerät/Motor (wird beim Ziehen ignoriert). */
  setValue14(v: number) {
    if (this.#dragging) return;
    this.#value = clamp(v, 0, FADER_MAX);
    this.render();
  }

  render() {
    const p = this.#value / FADER_MAX;
    this.#thumb.style.bottom = `calc(${p * 100}% - 7px)`;
    this.#zero.style.bottom = `${(dbToFader(0) / FADER_MAX) * 100}%`;
    const db = faderToDb(this.#value);
    this.read.textContent = db <= -59.5 ? "−∞" : `${fmtSigned(db)} dB`;
    this.root.setAttribute("aria-valuenow", db.toFixed(1));
    this.root.setAttribute("aria-valuetext", this.read.textContent);
  }

  #pos(e: PointerEvent): number {
    const r = this.#track.getBoundingClientRect();
    return clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
  }

  #emit(v14: number) {
    // Raste bei 0 dB wie am Bildschirm
    const db = faderToDb(v14);
    this.#value = Math.abs(db) < 0.4 ? dbToFader(0) : clamp(v14, 0, FADER_MAX);
    this.render();
    this.o.onMove(Math.round(this.#value));
  }

  #down(e: PointerEvent) {
    if (e.button !== 0) return;
    const now = performance.now();
    if (now - this.#lastTap < 320) {
      // Doppelklick: 0 dB
      this.#lastTap = 0;
      this.o.onTouch(true);
      this.#emit(dbToFader(0));
      this.o.onTouch(false);
      e.preventDefault();
      return;
    }
    this.#lastTap = now;
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch { /* ohne Zeigerfang (z. B. künstliche Ereignisse) weiterarbeiten */ }
    this.#dragging = true;
    this.#fine = false;
    this.root.classList.add("drag");
    this.o.onTouch(true);
    const start = this.#pos(e);
    const tr = this.#thumb.getBoundingClientRect();
    const onThumb = e.clientX >= tr.left - 8 && e.clientX <= tr.right + 8 && e.clientY >= tr.top - 8 && e.clientY <= tr.bottom + 8;
    this.#anchorPos = onThumb ? this.#value / FADER_MAX : start;
    this.#anchorPtr = start;
    if (!onThumb) this.#emit(start * FADER_MAX);
    e.preventDefault();
  }

  #move(e: PointerEvent) {
    if (!this.#dragging) return;
    const r = this.root.getBoundingClientRect();
    const off = Math.abs(e.clientX - (r.left + r.width / 2));
    const fine = e.shiftKey || off > 70;
    if (fine !== this.#fine) {
      this.#fine = fine;
      this.#anchorPos = this.#value / FADER_MAX;
      this.#anchorPtr = this.#pos(e);
      this.root.classList.toggle("fine", fine);
    }
    const delta = this.#pos(e) - this.#anchorPtr;
    this.#emit(clamp(this.#anchorPos + delta * (fine ? 0.2 : 1), 0, 1) * FADER_MAX);
  }

  #up(e: PointerEvent) {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.root.classList.remove("drag", "fine");
    try {
      this.root.releasePointerCapture(e.pointerId);
    } catch { /* schon losgelassen */ }
    this.o.onTouch(false);
  }

  #key(e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.5;
    const db = faderToDb(this.#value);
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = db + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = db - step;
    else if (e.key === "PageUp") next = db + 3;
    else if (e.key === "PageDown") next = db - 3;
    else if (e.key === "Home") next = 0;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    this.o.onTouch(true);
    this.#emit(dbToFader(clamp(next, -60, 12)));
    this.o.onTouch(false);
  }
}
