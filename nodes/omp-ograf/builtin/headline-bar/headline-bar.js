/**
 * Schlagzeile / Eilmeldung — Balken unten mit farbigem Label (z. B. EILMELDUNG) und Schlagzeile; fährt von unten ein.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"label":"EILMELDUNG","text":"Schlagzeile","labelColor":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:4vw;right:4vw;bottom:7vh;display:flex;align-items:stretch;transform:translateY(30vh);opacity:0;transition:transform 500ms cubic-bezier(.2,.8,.2,1),opacity 300ms}
.in .box{transform:none;opacity:1}.l{background:var(--accent);color:#fff;font:800 3.4vh/1 system-ui,sans-serif;letter-spacing:.08em;padding:2.2vh 2.6vh;display:flex;align-items:center}
.t{flex:1;background:var(--bg);color:var(--fg);font:700 4vh/1.2 system-ui,sans-serif;padding:2vh 3vh;display:flex;align-items:center}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="l">${e(d.label)}</div><div class="t">${e(d.text)}</div></div>`;
const vars = (d) => ({ accent: d.labelColor });
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
