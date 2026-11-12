/**
 * Uhr / Countdown — Uhrzeit, Countdown (bis Zeitpunkt oder für n Sekunden ab Einblenden) oder Stoppuhr in einer Bildecke.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"mode":"Uhrzeit","seconds":60,"until":"","label":"","corner":"oben links","bgColor":"#101826","textColor":"#ffffff","accentColor":"#d90012"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;display:flex;align-items:center;background:var(--bg);color:var(--fg);opacity:0;transition:opacity 400ms}.in .box{opacity:1}
.lab{background:var(--accent);padding:1.2vh 2vh;font:800 2.6vh/1 system-ui,sans-serif;letter-spacing:.1em}.tm{padding:1.2vh 2.4vh;font:700 4.6vh/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => { const c = String(d.corner); const pos = (c.includes("unten") ? "bottom:5vh;" : "top:5vh;") + (c.includes("links") ? "left:4vw;" : "right:4vw;");
    return `<div class="box" style="${pos}">${d.label ? `<div class="lab">${e(d.label)}</div>` : ""}<div class="tm">--:--:--</div></div>`; };
const vars = () => ({});
export default class Tpl extends HTMLElement {
  constructor() {
    super();
    this._d = { ...DEF };
    this._root = this.attachShadow({ mode: "open" });
  }
  _render() {
    const d = this._d, v = { accent: d.accentColor, bg: d.bgColor, fg: d.textColor, ...vars(d) };
    for (const [k, x] of Object.entries(v)) if (x !== undefined) this.style.setProperty("--" + k, x);
    const on = this.classList.contains("in");
    this._root.innerHTML = "<style>" + STYLE + "</style><div class='r" + (on ? " in" : "") + "'>" + html(d, e, import.meta.url) + "</div>";
    this._tick && this._tick();
  }
  _tick() {
    const el = this._root.querySelector(".tm"); if (!el) return;
    const p = (n) => String(Math.floor(n)).padStart(2, "0"), hms = (s) => { s = Math.max(0, Math.floor(s)); return p(s / 3600) + ":" + p((s % 3600) / 60) + ":" + p(s % 60); };
    const d = this._d, now = Date.now();
    if (d.mode === "Countdown") { const end = d.until && !isNaN(Date.parse(d.until)) ? Date.parse(d.until) : this._t0 + d.seconds * 1000; el.textContent = hms((end - now) / 1000); }
    else if (d.mode === "Stoppuhr") el.textContent = hms((now - this._t0) / 1000);
    else { const t = new Date(); el.textContent = p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds()); }
  }
  _start() { this._t0 = Date.now(); clearInterval(this._iv); this._iv = setInterval(() => this._tick(), 200); this._tick(); }
  _stopTimer() { clearInterval(this._iv); }
  _set(on) { this._root.querySelector(".r")?.classList.toggle("in", on); this.classList.toggle("in", on); }
  async load(p) { this._d = { ...DEF, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async dispose() { this._stopTimer && this._stopTimer(); this._root.innerHTML = ""; return { statusCode: 200 }; }
  async updateAction(p) { this._d = { ...this._d, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async playAction() { this._start(); requestAnimationFrame(() => requestAnimationFrame(() => this._set(true))); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this._set(false); setTimeout(() => this._stopTimer(), 600); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
