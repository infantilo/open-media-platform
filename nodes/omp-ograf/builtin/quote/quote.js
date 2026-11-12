/**
 * Zitat — Zitat mit Urheber im unteren Drittel auf halbtransparentem Grund.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"text":"„Zitat.“","author":"","accentColor":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:8vw;right:8vw;bottom:9vh;background:color-mix(in srgb,var(--bg) 88%,transparent);color:var(--fg);border-left:1.2vh solid var(--accent);padding:3vh 4vh;opacity:0;transform:translateY(6vh);transition:opacity 500ms,transform 500ms}.in .box{opacity:1;transform:none}
.q{font:600 5vh/1.25 Georgia,serif;font-style:italic}.a{margin-top:1.8vh;font:700 2.8vh/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);filter:brightness(1.5)}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="q">${e(d.text)}</div>${d.author ? `<div class="a">${e(d.author)}</div>` : ""}</div>`;
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
