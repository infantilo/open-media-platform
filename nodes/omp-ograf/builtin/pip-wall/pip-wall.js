/**
 * PIP-Wand: Hintergrundbild mit drei durchsichtigen Fenstern (clip-path, even-odd), Rahmen + Beschriftung je Fenster.
 * Jedes Fenster ist ein Element mit data-ograf-zone="pip1".."pip3". Die Pose kommt als Bruchteile "x,y,b,h" per update
 * (vom Layout-Kopplungstyp „follow“ des Grafik-Nodes aus dem PIP-Slot des Mischers); die Seite fährt in `moveMs` linear (ohne Mischerfahrt) oder rechnet die Fahrt des Mischers mit gleicher Kurve nach
 * (der Mischer fährt linear) — so bleiben Rahmen und Bild beim Klick-Vergrößern deckungsgleich.
 * Kein oGraf-Standard: nur die Zonen sind eine Erweiterung dieses Projekts.
 */
const N = 3;
const STYLE_TEXT = `
:host { position: fixed; inset: 0; display: block; pointer-events: none; opacity: 0; transition: opacity 400ms ease; }
:host(.in) { opacity: 1; }
.bg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.stop2 { stop-color: var(--bgc, #0b1530); }
.box { position: absolute; box-sizing: border-box; border-radius: var(--rad, 0px); outline: var(--bw, 6px) solid var(--accent, #e10600); transition: opacity 300ms ease; }
.box.off { opacity: 0; }
.box.dim { opacity: 0; }
.cap { position: absolute; left: 0; bottom: calc(100% + var(--bw, 6px)); display: flex; align-items: center; padding: 0 0.8em 0 0; background: linear-gradient(90deg, var(--accent, #e10600) 0 0.5em, rgba(8,12,24,0.92) 0.5em);
  padding-left: 1em; font: 700 30px/1 system-ui, sans-serif; letter-spacing: 0.03em; color: var(--cap, #fff); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
`;
const DEFAULT = { pip1Box: "0,0.6486,0.3336,0.3333", pip2Box: "0.3422,0.3819,0.3336,0.3333", pip3Box: "0.6617,0.6292,0.3336,0.3333" };
const parseBox = (s) => {
  const v = String(s || "").split(",").map(Number);
  return v.length === 4 && v.every(Number.isFinite) ? v : null;
};
export default class PipWall extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    // Hintergrund als SVG: Verlauf + optionales Bild, durch eine Maske mit den (auch überlappenden) Fenstern ausgeschnitten.
    const NS = "http://www.w3.org/2000/svg";
    this._bg = document.createElementNS(NS, "svg");
    this._bg.setAttribute("class", "bg");
    this._bg.innerHTML = `<defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#1d3b78"/><stop class="stop2" offset="0.7"/></linearGradient>
      <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"><rect x="0" y="0" width="100%" height="100%" fill="#fff"/><g id="holes" fill="#000"></g></mask>
    </defs>
    <g mask="url(#m)"><rect width="100%" height="100%" fill="url(#g)"/><image id="img" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"/></g>`;
    this._holes = this._bg.querySelector("#holes");
    this._img = this._bg.querySelector("#img");
    for (let i = 0; i < N; i++) { const r = document.createElementNS(NS, "rect"); this._holes.append(r); }
    root.append(style, this._bg);
    this._moveMs = 500;
    this._rad = 0;
    this._boxes = [];
    for (let i = 0; i < N; i++) {
      const el = document.createElement("div");
      el.className = "box";
      el.setAttribute("data-ograf-zone", `pip${i + 1}`);
      const cap = document.createElement("div");
      cap.className = "cap";
      el.append(cap);
      root.append(el);
      const b = parseBox(DEFAULT[`pip${i + 1}Box`]);
      cap.textContent = ["LIVE · Washington", "LIVE · London", "LIVE · Berlin"][i];
      this._boxes.push({ el, cap, cur: b.slice(), from: b.slice(), to: b.slice(), t0: 0, on: true, dim: false });
    }
    this._raf = 0;
  }
  _apply(d) {
    if (d.backgroundImage !== undefined) { if (d.backgroundImage) this._img.setAttribute("href", String(d.backgroundImage)); else this._img.removeAttribute("href"); }
    if (d.backgroundColor) this.style.setProperty("--bgc", d.backgroundColor);
    if (d.accentColor) this.style.setProperty("--accent", d.accentColor);
    if (d.captionColor) this.style.setProperty("--cap", d.captionColor);
    if (typeof d.borderWidth === "number") this.style.setProperty("--bw", `${d.borderWidth / 1920 * 100}vw`);
    if (typeof d.cornerRadius === "number") { this._rad = Math.max(0, d.cornerRadius) / 1920; this.style.setProperty("--rad", `${this._rad * 100}vw`); }
    if (typeof d.leadMs === "number") this._leadMs = d.leadMs;
    if (typeof d.moveMs === "number") this._moveMs = Math.max(0, d.moveMs);
    const now0 = performance.now();
    this._boxes.forEach((b, i) => {
      const k = `pip${i + 1}`;
      if (d[`text${i + 1}`] !== undefined) b.cap.textContent = d[`text${i + 1}`];
      if (d[`${k}On`] !== undefined) { b.on = !!d[`${k}On`]; b.el.classList.toggle("off", !b.on); }
      // „Anderes Fenster ist vergrößert“: Ausblenden entscheidet _tick je Bild (nur wenn das Fenster ganz verdeckt ist).
      if (d[`${k}Dim`] !== undefined) b.dimWant = !!d[`${k}Dim`];
      // Fahrt des Mischers (von, nach, Start Unix-ms, Dauer): gleiche Ease-in/out-Kurve und gleiche Uhr wie der Mischer.
      if (d[`${k}Anim`] !== undefined) {
        const a = String(d[`${k}Anim`]).split(",").map(Number);
        b.anim = a.length === 10 && a.every(Number.isFinite) ? { from: a.slice(0, 4), to: a.slice(4, 8), t0: a[8], ms: a[9] } : null;
      }
      const nb = parseBox(d[`${k}Box`]);
      if (b.anim) { b.to = nb || b.to; }
      // Soll mit dem tatsächlich gezeigten Stand vergleichen (nach abgeschlossener Fahrt ist das `cur`): so holt die Seite eine
      // verpasste Fahrt beim nächsten (wiederholten) Update von selbst nach, statt auf der alten Pose stehenzubleiben.
      else if (nb && nb.some((v, j) => Math.abs(v - (now0 - b.t0 < this._moveMs ? b.to : b.cur)[j]) > 1e-6)) {
        b.from = b.cur.slice();
        b.to = nb;
        b.t0 = performance.now();
      }
    });
    this._start();
  }
  _start() { if (!this._raf) this._raf = requestAnimationFrame((t) => this._tick(t)); }
  _tick() {
    this._raf = 0;
    const now = performance.now();
    let moving = false;
    for (const b of this._boxes) {
      if (b.anim) {
        const lead = this._leadMs || 0;
        const u = b.anim.ms <= 0 ? 1 : Math.max(0, Math.min(1, (Date.now() + lead - b.anim.t0) / b.anim.ms));
        const e = u * u * (3 - 2 * u);
        b.cur = b.anim.from.map((f, j) => f + (b.anim.to[j] - f) * e);
        if (u < 1) moving = true; else { b.cur = b.anim.to.slice(); b.from = b.cur.slice(); b.to = b.cur.slice(); }
      } else {
      const t = this._moveMs <= 0 ? 1 : Math.min(1, (now - b.t0) / this._moveMs);
      b.cur = b.from.map((f, j) => f + (b.to[j] - f) * t);
      if (t < 1) moving = true;
      }
      const [x, y, w, h] = b.cur;
      Object.assign(b.el.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      // Beschriftung als Reiter über dem Rahmen (innen läge sie unter dem PIP-Video des Mischers): so hoch wie der Platz erlaubt.
      const Hpx = this._bg.clientHeight || 1080;
      const room = y * Hpx - parseFloat(getComputedStyle(this).getPropertyValue("--bw") || "0") * 0 - 6;
      const th = Math.min(46 * (Hpx / 1080), room);
      b.cap.style.height = `${Math.max(0, th)}px`;
      b.cap.style.fontSize = `${Math.max(0, th * 0.62)}px`;
      b.cap.style.visibility = th < 12 ? "hidden" : "visible";
    }
    // Ein Fenster verschwindet nur, wenn es ganz vom vergrößerten verdeckt ist; ist es teilweise verdeckt, bleibt es stehen und
    // sein Rahmen wird nur dort ausgespart, wo das vergrößerte Fenster darüber liegt.
    const focused = this._boxes.some((b) => b.dimWant) ? this._boxes.find((b) => !b.dimWant && b.on) : null;
    for (const b of this._boxes) {
      let dim = false;
      let clip = "none";
      if (b.dimWant && focused) {
        const [x, y, w, h] = b.cur, [fx, fy, fw, fh] = focused.cur, e = 1e-3;
        dim = x >= fx - e && y >= fy - e && x + w <= fx + fw + e && y + h <= fy + fh + e;
        const ox = Math.max(x, fx), oy = Math.max(y, fy), ox2 = Math.min(x + w, fx + fw), oy2 = Math.min(y + h, fy + fh);
        if (!dim && ox2 > ox && oy2 > oy && w > 0 && h > 0) {
          const px = (v, o, s) => `${((v - o) / s) * 100}%`;
          clip = `polygon(evenodd, -100% -100%, 200% -100%, 200% 200%, -100% 200%, -100% -100%, ` +
            `${px(ox, x, w)} ${px(oy, y, h)}, ${px(ox2, x, w)} ${px(oy, y, h)}, ${px(ox2, x, w)} ${px(oy2, y, h)}, ${px(ox, x, w)} ${px(oy2, y, h)}, ${px(ox, x, w)} ${px(oy, y, h)})`;
        }
      }
      if (b.dim !== dim) { b.dim = dim; b.el.classList.toggle("dim", dim); }
      if (b.clip !== clip) { b.clip = clip; b.el.style.clipPath = clip; }
    }
    // Fenster ausschneiden: ein schwarzes Rechteck je sichtbarem Fenster in der Maske (Überlappung bleibt ein Loch).
    this._boxes.forEach((b, i) => {
      const r = this._holes.children[i];
      const [x, y, w, h] = b.cur;
      r.setAttribute("rx", String(this._rad * (this._bg.clientWidth || 1920)));
      r.setAttribute("x", `${x * 100}%`); r.setAttribute("y", `${y * 100}%`);
      r.setAttribute("width", `${b.on && !b.dim ? w * 100 : 0}%`); r.setAttribute("height", `${b.on && !b.dim ? h * 100 : 0}%`);
    });
    if (moving) this._start();
  }
  async load(p) { this._apply(p?.data || {}); return { statusCode: 200 }; }
  async dispose() { cancelAnimationFrame(this._raf); this.shadowRoot.innerHTML = ""; return { statusCode: 200 }; }
  async playAction() { this.classList.add("in"); this._start(); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this.classList.remove("in"); return { statusCode: 200 }; }
  async updateAction(p) { this._apply(p?.data || {}); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
