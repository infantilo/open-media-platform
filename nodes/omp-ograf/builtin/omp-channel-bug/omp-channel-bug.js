/**
 * Senderlogo (Bug) — Senderlogo oder Kurzname in einer Bildecke; Logo als Bilddatei im Paket oder Adresse. Blendet weich ein.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"logo":"","text":"OMP","corner":"oben rechts","size":9,"opacity":85,"textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;opacity:0;transition:opacity 600ms ease}.in .box{opacity:var(--op)}
img{height:var(--h);display:block}.tx{font:800 var(--h)/1 system-ui,sans-serif;color:var(--fg);text-shadow:0 0 .6vh #000}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e, base) => { const c = String(d.corner); const pos = (c.includes("unten") ? "bottom:5vh;" : "top:5vh;") + (c.includes("links") ? "left:4vw;" : "right:4vw;");
    return `<div class="box" style="${pos}">${d.logo ? `<img src="${e(new URL(d.logo, base).href)}">` : `<div class="tx">${e(d.text)}</div>`}</div>`; };
const vars = (d) => ({ h: `${d.size}vh`, op: d.opacity / 100 });
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
