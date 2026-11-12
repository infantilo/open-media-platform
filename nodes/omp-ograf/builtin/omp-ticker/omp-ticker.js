/**
 * Newsticker (Laufband) — Laufband am unteren Rand mit Label; Text läuft endlos von rechts nach links. Mehrere Meldungen mit Trennzeichen „  •  “ im Textfeld.
 * OGraf v1, Einheiten in vh/vw (auflösungsunabhängig). Farben als Parameter.
 */
const DEF = {"label":"NEWS","text":"Erste Meldung  •  Zweite Meldung  •  Dritte Meldung","speed":14,"labelColor":"#d90012","bgColor":"#101826","textColor":"#ffffff"};
const STYLE = `
:host{position:fixed;inset:0;display:block;pointer-events:none;overflow:hidden;font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;}
.box{position:absolute;left:0;right:0;bottom:0;height:7vh;display:flex;background:var(--bg);transform:translateY(100%);transition:transform 400ms ease}
.in .box{transform:none}.l{background:var(--accent);color:#fff;font:800 3vh/7vh system-ui,sans-serif;padding:0 3vh;letter-spacing:.1em;z-index:1}
.v{flex:1;overflow:hidden;position:relative}.m{position:absolute;white-space:nowrap;font:600 3.6vh/7vh system-ui,sans-serif;color:var(--fg);left:100%;animation:run var(--dur) linear infinite}
@keyframes run{from{transform:translateX(0)}to{transform:translateX(-100%) translateX(-100vw)}}
`;
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (d, e) => `<div class="box"><div class="l">${e(d.label)}</div><div class="v"><div class="m">${e(d.text)}</div></div></div>`;
const vars = (d) => ({ accent: d.labelColor, dur: `${Math.max(2, d.speed) * Math.max(1, String(d.text).length) / 100 + 6}s` });
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
