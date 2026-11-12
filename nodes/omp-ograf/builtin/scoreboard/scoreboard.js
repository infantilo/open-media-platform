/**
 * Ergebnis-Tafel (Sport) — Spielstand oben links: zwei Teams, Tore, Spielzeit/Abschnitt.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"teamA":"HEIM","teamB":"GAST","scoreA":0,"scoreB":0,"time":"00:00","period":"1. HZ","colorA":"#0b5ed7","colorB":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:4vw;top:5vh;display:flex;align-items:stretch;background:var(--bg);color:var(--fg);transform:translateY(-20vh);transition:transform 500ms cubic-bezier(.2,.8,.2,1)}.in .box{transform:none}
.c{display:flex;align-items:center}.tm{font:700 3vh/1 system-ui,sans-serif;padding:0 2vh;flex-direction:column;justify-content:center;gap:.5vh;background:#000}.tm small{font-size:2.2vh;opacity:.8}
.n{font:800 3.6vh/1 system-ui,sans-serif;padding:1.8vh 2vh;letter-spacing:.06em}.s{font:800 4.6vh/1 system-ui,sans-serif;padding:1.6vh 2vh;min-width:3vh;text-align:center}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="c"><div class="n" style="border-left:1vh solid ${e(d.colorA)}">${e(d.teamA)}</div><div class="s">${e(d.scoreA)}</div></div><div class="c"><div class="s">${e(d.scoreB)}</div><div class="n" style="border-right:1vh solid ${e(d.colorB)}">${e(d.teamB)}</div></div><div class="c tm"><span>${e(d.time)}</span><small>${e(d.period)}</small></div></div>`;
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
