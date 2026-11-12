/**
 * Titelkarte (Vollbild) — Vollbild-Titel mit Untertitel auf farbigem Grund, z. B. Sendungsbeginn, Pausenkarte, Bumper. Blendet weich ein/aus.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"title":"Titel","subtitle":"","bgColor":"#0b1020","accentColor":"#d90012","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;inset:0;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.4vh;opacity:0;transition:opacity 500ms ease}.in .box{opacity:1}
.t{font:800 11vh/1.05 system-ui,sans-serif;text-align:center;padding:0 6vw}.ln{width:14vw;height:.8vh;background:var(--accent)}.s{font:500 4.4vh/1.3 system-ui,sans-serif;opacity:.85;text-align:center;padding:0 8vw}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="t">${e(d.title)}</div><div class="ln"></div>${d.subtitle ? `<div class="s">${e(d.subtitle)}</div>` : ""}</div>`;
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
    
  }
  _set(on) { this._root.querySelector(".r")?.classList.toggle("in", on); this.classList.toggle("in", on); }
  async load(p) { this._d = { ...DEF, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async dispose() { this._root.innerHTML = ""; return { statusCode: 200 }; }
  async updateAction(p) { this._d = { ...this._d, ...(p?.data || {}) }; this._render(); return { statusCode: 200 }; }
  async playAction() {  requestAnimationFrame(() => requestAnimationFrame(() => this._set(true))); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this._set(false);  return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
