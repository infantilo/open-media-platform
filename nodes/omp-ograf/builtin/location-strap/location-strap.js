/**
 * Ortsmarke (LIVE · Ort) — Kleine Marke oben links: LIVE-Kennung, Ort und optional Uhrzeit/Zusatz.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"tag":"LIVE","place":"Berlin","extra":"","tagColor":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:4vw;top:5vh;display:flex;opacity:0;transform:translateX(-4vw);transition:opacity 400ms,transform 400ms}.in .box{opacity:1;transform:none}
.g{background:var(--accent);color:#fff;font:800 3vh/1 system-ui,sans-serif;padding:1.4vh 2vh;letter-spacing:.1em}.p{background:var(--bg);color:var(--fg);font:700 3.4vh/1 system-ui,sans-serif;padding:1.4vh 2.4vh}.x{opacity:.7;margin-left:1.6vh;font-weight:500}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="g">${e(d.tag)}</div><div class="p">${e(d.place)}${d.extra ? `<span class="x">${e(d.extra)}</span>` : ""}</div></div>`;
const vars = (d) => ({ accent: d.tagColor });
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
    
  }
  _set(on) { this._root.querySelector(".r")?.classList.toggle("in", on); this.classList.toggle("in", on); }
  async load(p) { this._d = { ...DEF, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async dispose() { this._root.innerHTML = ""; return { statusCode: 200 }; }
  async updateAction(p) { this._d = { ...this._d, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async playAction() {  requestAnimationFrame(() => requestAnimationFrame(() => this._set(true))); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this._set(false);  return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
