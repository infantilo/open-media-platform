/**
 * Bauchbinde (Name + Funktion) — Klassische Bauchbinde unten links: Name und Funktion/Ort, schiebt von links ein.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"name":"Name Nachname","role":"Funktion","accentColor":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:6vw;bottom:11vh;display:flex;transform:translateX(-120vw);transition:transform 600ms cubic-bezier(.2,.8,.2,1)}
.in .box{transform:none}.bar{width:1.2vh;background:var(--accent)}
.t{background:var(--bg);color:var(--fg);padding:1.6vh 3vh 1.6vh 2.4vh;min-width:22vw}
.n{font:800 4.4vh/1.15 system-ui,sans-serif}.r{font:500 2.8vh/1.3 system-ui,sans-serif;opacity:.85;margin-top:.4vh}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="bar"></div><div class="t"><div class="n">${e(d.name)}</div><div class="r">${e(d.role)}</div></div></div>`;
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
