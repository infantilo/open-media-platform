// Node-UI-Bundle des Audiomischers (Kapitel 26, docs/AUDIOMIXER-PLAN.md).
// Quelldateien (werden in src/uibundle.rs zu EINEM Bundle zusammengefügt):
//   00-core.js     Helfer, Fader, Slider, Meter
//   10-channel.js  ChannelView (eine Logik, Darstellungsvarianten per data-variant)
//   20-center.js   Center Control (Tabs für Detailparameter des gewählten Kanals)
//   30-panel.js    Custom Element, Layout/Responsive, Daten (mixState + SSE), Prefs
//
// Trennung wie im Zielbild:
//   Mixer-State  = ein Dokument vom Node (`mixState`, ein Poll) + SSE für Live-Werte
//   Commands     = ausschließlich Node-Methoden (`/methods/<name>`); die UI fasst
//                  keinen Audiopfad an und verändert Audio nur durch explizite
//                  Benutzeraktionen
//   UI-Zustand   = Darstellung (Preset, Fader sichtbar, Spalten, Gruppen auf/zu,
//                  Auswahl, Center-Tab) — nur localStorage, NIE Audio-State

"use strict";

// ───────────────────────────── Helfer ─────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Instanz-Kurz-ID ("Source (3f2a1b9c)") ist für den Operator nebensächlich → nur in der Anzeige weglassen.
const shortLabel = (s) => String(s ?? "").replace(/\s*\([0-9a-f]{8}\)/g, "");
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
};

// Fader-Skala: Position 0..1 ↔ dB (piecewise linear, 0 dB bei 75 %, wie bei Pulten).
const FADER_POINTS = [
  [0, -60],
  [0.15, -40],
  [0.35, -20],
  [0.55, -10],
  [0.75, 0],
  [1, 12],
];
function dbToPos(db) {
  db = clamp(db, -60, 12);
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p0, d0] = FADER_POINTS[i - 1];
    const [p1, d1] = FADER_POINTS[i];
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}
function posToDb(p) {
  p = clamp(p, 0, 1);
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p0, d0] = FADER_POINTS[i - 1];
    const [p1, d1] = FADER_POINTS[i];
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return 12;
}
const fmtSigned = (v, d = 1) => (v > 0.0001 ? "+" : v < -0.0001 ? "−" : "") + Math.abs(v).toFixed(d);
const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-6));

// Biquad-Betragsgang (RBJ), nur für die EQ-Kurvenanzeige — dieselbe Formel wie dsp.rs.
function biquadMagDb(kind, f0, q, gainDb, f, fs = 48000) {
  f0 = clamp(f0, 10, fs * 0.45);
  q = clamp(q, 0.1, 20);
  const w0 = (2 * Math.PI * f0) / fs, sw = Math.sin(w0), cw = Math.cos(w0);
  const alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (kind === "peak") { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
  else {
    const s = 2 * Math.sqrt(A) * alpha;
    if (kind === "low") { b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s); a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; }
    else { b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s); a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; }
  }
  const w = (2 * Math.PI * f) / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// ───────────────────────────── Bedienelemente ─────────────────────────────

/**
 * Fader mit Pointer-Events. Eigene große Trefferfläche (nicht nur die sichtbare
 * Spur), `touch-action: none` NUR hier — vertikales Scrollen der Kanalliste
 * bleibt überall sonst möglich. Fine-Modus: seitlich weg vom Fader ziehen oder
 * Shift halten (x0,2). Doppeltipp/Doppelklick = 0 dB. Tastatur: Pfeile ±0,5 dB
 * (Shift ±0,1, PageUp/Down ±3), Home = 0 dB.
 */
class Fader {
  #lastTap = 0;
  constructor({ onInput, onCommit, orientation = "vertical", label = T("am0.e2ab41") }) {
    this.onInput = onInput;
    this.onCommit = onCommit;
    this.orientation = orientation;
    this.value = 0;
    this.dragging = false;
    this.root = h("div", { class: "fader", role: "slider", tabindex: "0", "aria-label": label, "aria-valuemin": "-60", "aria-valuemax": "12", "aria-orientation": orientation });
    this.track = h("div", { class: "ftrack" });
    this.zero = h("i", { class: "fzero" });
    this.thumb = h("div", { class: "fthumb" });
    this.read = h("span", { class: "fread" });
    this.track.append(this.zero, this.thumb);
    this.root.append(this.track, this.read);
    this.root.addEventListener("pointerdown", (e) => this.#down(e));
    this.root.addEventListener("pointermove", (e) => this.#move(e));
    this.root.addEventListener("pointerup", (e) => this.#up(e));
    this.root.addEventListener("pointercancel", (e) => this.#up(e));
    this.root.addEventListener("keydown", (e) => this.#key(e));
  }
  setOrientation(o) {
    if (o === this.orientation) return;
    this.orientation = o;
    this.root.setAttribute("aria-orientation", o);
    this.render();
  }
  setValue(db) {
    if (this.dragging) return;
    this.value = db;
    this.render();
  }
  render() {
    const p = dbToPos(this.value);
    const vert = this.orientation === "vertical";
    this.thumb.style.cssText = vert ? `bottom:calc(${p * 100}% - var(--thumb, 14px)/2);left:0` : `left:calc(${p * 100}% - var(--thumb, 14px)/2);top:0`;
    this.zero.style.cssText = vert ? `bottom:${dbToPos(0) * 100}%` : `left:${dbToPos(0) * 100}%`;
    this.read.textContent = this.value <= -59.5 ? "−∞" : fmtSigned(this.value) + " dB";
    this.root.setAttribute("aria-valuenow", this.value.toFixed(1));
    this.root.setAttribute("aria-valuetext", this.read.textContent);
  }
  #pos(e) {
    const r = this.track.getBoundingClientRect();
    const vert = this.orientation === "vertical";
    return clamp(vert ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width, 0, 1);
  }
  #down(e) {
    if (e.button != null && e.button !== 0) return;
    const now = performance.now();
    if (now - this.#lastTap < 320) {
      // Doppeltipp/-klick: 0 dB
      this.#lastTap = 0;
      this.pend = null;
      this.#set(0, true);
      e.preventDefault();
      return;
    }
    this.#lastTap = now;
    this.root.setPointerCapture(e.pointerId);
    const start = this.#pos(e);
    if (e.pointerType === "touch") {
      // Touch: noch nichts verändern — erst eine Bewegung ENTLANG der Fader-Achse
      // startet das (relative) Ziehen; eine Bewegung quer dazu ist ein Scroll der
      // Kanalliste und darf den Fader nicht berühren. Ein kurzer Tipp springt hin.
      this.pend = { x: e.clientX, y: e.clientY, t: now, pos: start };
      return;
    }
    this.dragging = true;
    this.fine = false;
    this.root.classList.add("drag");
    // Maus: direkt auf die berührte Stelle springen, außer die Berührung beginnt auf dem Thumb.
    const tr = this.thumb.getBoundingClientRect();
    const onThumb = e.clientX >= tr.left - 8 && e.clientX <= tr.right + 8 && e.clientY >= tr.top - 8 && e.clientY <= tr.bottom + 8;
    this.anchorPos = onThumb ? dbToPos(this.value) : start;
    this.anchorPointer = start;
    if (!onThumb) this.#apply(start);
    e.preventDefault();
  }
  #move(e) {
    if (this.pend && !this.dragging) {
      const dx = e.clientX - this.pend.x, dy = e.clientY - this.pend.y;
      const vert = this.orientation === "vertical";
      const along = Math.abs(vert ? dy : dx), cross = Math.abs(vert ? dx : dy);
      if (along > 8 && along > cross) {
        this.dragging = true;
        this.fine = false;
        this.root.classList.add("drag");
        this.anchorPos = dbToPos(this.value);
        this.anchorPointer = this.#pos(e);
        this.pend = null;
      } else return;
    }
    if (!this.dragging) return;
    const r = this.root.getBoundingClientRect();
    const vert = this.orientation === "vertical";
    const off = vert ? Math.abs(e.clientX - (r.left + r.width / 2)) : Math.abs(e.clientY - (r.top + r.height / 2));
    const fine = e.shiftKey || off > 70;
    if (fine !== this.fine) {
      this.fine = fine;
      this.anchorPos = dbToPos(this.value);
      this.anchorPointer = this.#pos(e);
      this.root.classList.toggle("fine", fine);
    }
    const delta = this.#pos(e) - this.anchorPointer;
    this.#apply(this.anchorPos + delta * (fine ? 0.2 : 1));
  }
  #up(e) {
    if (this.pend) {
      // Tipp ohne Bewegung: an die berührte Stelle springen.
      const p = this.pend;
      this.pend = null;
      try { this.root.releasePointerCapture(e.pointerId); } catch {}
      if (e.type === "pointerup" && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8 && performance.now() - p.t < 400) {
        this.#apply(p.pos);
        this.onCommit?.(this.value);
      }
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    this.root.classList.remove("drag", "fine");
    try { this.root.releasePointerCapture(e.pointerId); } catch {}
    this.onCommit?.(this.value);
  }
  #apply(pos) {
    let db = posToDb(pos);
    if (Math.abs(db) < 0.4) db = 0; // Rastpunkt bei 0 dB
    this.#set(Math.round(db * 10) / 10, false);
  }
  #set(db, commit) {
    this.value = clamp(db, -60, 12);
    this.render();
    this.onInput?.(this.value);
    if (commit) this.onCommit?.(this.value);
  }
  #key(e) {
    const step = e.shiftKey ? 0.1 : 0.5;
    let d = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") d = step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") d = -step;
    else if (e.key === "PageUp") d = 3;
    else if (e.key === "PageDown") d = -3;
    else if (e.key === "Home") { this.#set(0, true); e.preventDefault(); e.stopPropagation(); return; }
    if (d == null) return;
    this.#set(this.value + d, true);
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Horizontaler Regler für die Center-Control-Parameter (lin/log, große Trefferfläche). */
class Slider {
  constructor({ label, min, max, step = 0.1, unit = "", scale = "lin", def, fmt, onInput, onCommit, center }) {
    Object.assign(this, { min, max, step, unit, scale, def, fmt, onInput, onCommit, center });
    this.value = def ?? min;
    this.dragging = false;
    this.id = "sl" + Math.random().toString(36).slice(2, 8);
    this.root = h("div", { class: "slider" });
    this.labelEl = h("label", { class: "slabel", for: this.id, text: label });
    this.out = h("output", { class: "sval" });
    this.range = h("div", { class: "srange", role: "slider", tabindex: "0", id: this.id, "aria-label": label, "aria-valuemin": String(min), "aria-valuemax": String(max) });
    this.fill = h("i", { class: "sfill" });
    this.thumb = h("i", { class: "sthumb" });
    this.range.append(this.fill, this.thumb);
    this.root.append(h("div", { class: "shead" }, this.labelEl, this.out), this.range);
    this.range.addEventListener("pointerdown", (e) => this.#down(e));
    this.range.addEventListener("pointermove", (e) => this.#move(e));
    this.range.addEventListener("pointerup", (e) => this.#up(e));
    this.range.addEventListener("pointercancel", (e) => this.#up(e));
    this.range.addEventListener("dblclick", () => def !== undefined && this.#set(def, true));
    this.range.addEventListener("keydown", (e) => this.#key(e));
    this.render();
  }
  #toPos(v) {
    if (this.scale === "log") return (Math.log(clamp(v, this.min, this.max)) - Math.log(this.min)) / (Math.log(this.max) - Math.log(this.min));
    return (clamp(v, this.min, this.max) - this.min) / (this.max - this.min);
  }
  #fromPos(p) {
    p = clamp(p, 0, 1);
    return this.scale === "log" ? Math.exp(Math.log(this.min) + p * (Math.log(this.max) - Math.log(this.min))) : this.min + p * (this.max - this.min);
  }
  setValue(v) {
    if (this.dragging || v === undefined || v === null) return;
    this.value = v;
    this.render();
  }
  render() {
    const p = this.#toPos(this.value);
    if (this.center !== undefined) {
      const c = this.#toPos(this.center);
      this.fill.style.cssText = `left:${Math.min(p, c) * 100}%;width:${Math.abs(p - c) * 100}%`;
    } else this.fill.style.cssText = `left:0;width:${p * 100}%`;
    this.thumb.style.left = `calc(${p * 100}% - var(--thumb, 14px)/2)`;
    this.out.textContent = this.fmt ? this.fmt(this.value) : this.value.toFixed(this.step < 1 ? 1 : 0) + (this.unit ? " " + this.unit : "");
    this.range.setAttribute("aria-valuenow", String(this.value));
    this.range.setAttribute("aria-valuetext", this.out.textContent);
  }
  #posOf(e) {
    const r = this.range.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }
  #snap(v) {
    v = Math.round(v / this.step) * this.step;
    return clamp(Math.round(v * 1e6) / 1e6, this.min, this.max);
  }
  #down(e) {
    if (e.button != null && e.button !== 0) return;
    this.dragging = true;
    this.range.setPointerCapture(e.pointerId);
    this.range.classList.add("drag");
    this.#set(this.#snap(this.#fromPos(this.#posOf(e))), false);
    e.preventDefault();
  }
  #move(e) {
    if (!this.dragging) return;
    this.#set(this.#snap(this.#fromPos(this.#posOf(e))), false);
  }
  #up(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.range.classList.remove("drag");
    try { this.range.releasePointerCapture(e.pointerId); } catch {}
    this.onCommit?.(this.value);
  }
  #set(v, commit) {
    this.value = v;
    this.render();
    this.onInput?.(v);
    if (commit) this.onCommit?.(v);
  }
  #key(e) {
    const big = (this.max - this.min) / 20;
    let d = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") d = e.shiftKey ? this.step : Math.max(this.step, big / 5);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -(e.shiftKey ? this.step : Math.max(this.step, big / 5));
    else if (e.key === "PageUp") d = big;
    else if (e.key === "PageDown") d = -big;
    else if (e.key === "Home" && this.def !== undefined) { this.#set(this.def, true); e.preventDefault(); e.stopPropagation(); return; }
    if (d == null) return;
    this.#set(this.#snap(this.value + d), true);
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Meter: Füllung + Spitzenwert (Peak-Hold), Pegel linear 0..1 vom Node (rms/peak), Anzeige −60…0 dB. */
class Meter {
  constructor() {
    this.root = h("div", { class: "meter", role: "img", "aria-label": T("am0.f23ca0") });
    this.fill = h("i", { class: "mfill" });
    this.peak = h("i", { class: "mpeak" });
    this.root.append(this.fill, this.peak);
    this.v = -1;
    this.p = -1;
    this.hold = 0;
    this.holdAt = 0;
  }
  static pos(lin) {
    return clamp((linToDb(lin) + 60) / 60, 0, 1);
  }
  set(rms, peak, now) {
    const v = Meter.pos(rms);
    let p = Meter.pos(peak);
    if (p >= this.hold || now - this.holdAt > 1500) {
      this.hold = p;
      this.holdAt = now;
    } else p = this.hold;
    if (Math.abs(v - this.v) < 0.004 && Math.abs(p - this.p) < 0.004) return;
    this.v = v;
    this.p = p;
    this.fill.style.setProperty("--v", v.toFixed(3));
    this.peak.style.setProperty("--p", p.toFixed(3));
    this.root.dataset.hot = p > 0.97 ? "1" : "0";
    this.root.setAttribute("aria-valuenow", (v * 60 - 60).toFixed(0));
  }
}
