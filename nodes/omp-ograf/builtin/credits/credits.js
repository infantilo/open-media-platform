/**
 * Abspann zum Event-Beginn (z. B. nach einem Film): das Video beginnt gesqueezt (rechts), links erscheinen Regie, Redaktion,
 * Produktionsjahr und optional Sponsor-Logos; nach `duration` ms zieht das Video wieder auf Vollbild auf und die Vorlage endet.
 * Das Video-Fenster ist die Zone data-ograf-zone="video" (Layout-Kopplung „Bild im Fenster“ im Panel); die deckende Fläche
 * ist der Schlagschatten des Fensters, sie verschwindet daher von selbst, wenn das Fenster aufzieht. Ohne Kopplung zeigt
 * die Vorlage einen Rahmen mit durchsichtigem Fenster. Kein OGraf-Standard: nur die Zone ist eine Erweiterung.
 */
const DEF = {
  duration: 10000, title: "", director: "", directorLabel: "Regie", editor: "", editorLabel: "Redaktion",
  year: "", yearLabel: "Produktionsjahr", extra: "", logos: "", bgColor: "#0b1020", accentColor: "#d90012", expandMs: 1100,
};
const STYLE = `
:host { position: fixed; inset: 0; display: block; pointer-events: none; opacity: 0; }
:host(.in) { opacity: 1; }
.win { position: absolute; left: 55vw; top: calc(50vh - 11.25vw); width: 40vw; height: 22.5vw; box-sizing: border-box;
  box-shadow: 0 0 0 300vmax var(--bg, #0b1020); border: 0.35vh solid var(--accent, #d90012);
  transition: left var(--ex) cubic-bezier(.65,0,.35,1), top var(--ex) cubic-bezier(.65,0,.35,1), width var(--ex) cubic-bezier(.65,0,.35,1), height var(--ex) cubic-bezier(.65,0,.35,1), border-width var(--ex) linear; }
:host(.full) .win { left: 0; top: 0; width: 100vw; height: 100vh; border-width: 0; }
.txt { position: absolute; left: 6vw; top: 0; bottom: 0; width: 44vw; display: flex; flex-direction: column; justify-content: center; gap: 3.2vh;
  font-family: system-ui, sans-serif; color: #fff; transition: opacity 500ms ease; }
:host(.full) .txt { opacity: 0; }
.title { font: 800 6.4vh/1.1 system-ui, sans-serif; letter-spacing: 0.02em; border-left: 0.8vh solid var(--accent, #d90012); padding-left: 2vh; }
.row { opacity: 0; transform: translateY(2vh); transition: opacity 700ms ease, transform 700ms ease; }
.row.show { opacity: 1; transform: none; }
.lab { font: 600 2.4vh/1.2 system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.18em; color: var(--accent, #d90012); filter: brightness(1.5); }
.val { font: 600 4.2vh/1.25 system-ui, sans-serif; white-space: pre-line; }
.logos { position: absolute; left: 55vw; width: 40vw; top: calc(50vh + 11.25vw + 4vh); display: flex; gap: 2.5vw; justify-content: center; align-items: center; opacity: 0; transition: opacity 700ms ease; }
.logos.show { opacity: 1; }
:host(.full) .logos { opacity: 0; }
.logos img { max-height: 9vh; max-width: 11vw; object-fit: contain; }
`;
export default class Credits extends HTMLElement {
  constructor() {
    super();
    this._d = { ...DEF };
    this._t = [];
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this._win = document.createElement("div"); this._win.className = "win"; this._win.setAttribute("data-ograf-zone", "video");
    this._txt = document.createElement("div"); this._txt.className = "txt";
    this._logos = document.createElement("div"); this._logos.className = "logos";
    root.append(style, this._win, this._txt, this._logos);
  }
  _build() {
    const d = this._d;
    this.style.setProperty("--bg", d.bgColor); this.style.setProperty("--accent", d.accentColor);
    this.style.setProperty("--ex", `${Math.max(100, +d.expandMs || 1100)}ms`);
    this._txt.textContent = "";
    if (d.title) { const t = document.createElement("div"); t.className = "title row"; t.textContent = d.title; this._txt.append(t); }
    for (const [lab, val] of [[d.directorLabel, d.director], [d.editorLabel, d.editor], [d.yearLabel, d.year], ["", d.extra]]) {
      if (!val) continue;
      const r = document.createElement("div"); r.className = "row";
      if (lab) { const l = document.createElement("div"); l.className = "lab"; l.textContent = lab; r.append(l); }
      const v = document.createElement("div"); v.className = "val"; v.textContent = val; r.append(v);
      this._txt.append(r);
    }
    this._logos.textContent = "";
    for (const u of String(d.logos || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)) {
      const i = document.createElement("img"); i.src = new URL(u, import.meta.url).href; this._logos.append(i);
    }
  }
  _clear() { this._t.forEach(clearTimeout); this._t = []; }
  async load(p) { this._d = { ...DEF, ...(p?.data || {}) }; this._build(); return { statusCode: 200 }; }
  async dispose() { this._clear(); this.shadowRoot.innerHTML = ""; return { statusCode: 200 }; }
  async updateAction(p) { this._d = { ...this._d, ...(p?.data || {}) }; this._build(); return { statusCode: 200 }; }
  async playAction() {
    this._clear(); this._build();
    const dur = Math.max(2000, +this._d.duration || DEF.duration), ex = Math.max(100, +this._d.expandMs || 1100);
    this.classList.remove("full"); this.classList.add("in"); // beginnt sofort gesqueezt
    const rows = [...this._txt.querySelectorAll(".row")];
    rows.forEach((r, i) => this._t.push(setTimeout(() => r.classList.add("show"), 400 + i * 450)));
    this._t.push(setTimeout(() => this._logos.classList.add("show"), 400 + rows.length * 450));
    this._t.push(setTimeout(() => this.classList.add("full"), Math.max(0, dur - ex))); // Aufziehen endet mit `duration`
    this._t.push(setTimeout(() => { this.classList.remove("in"); this._logos.classList.remove("show"); rows.forEach((r) => r.classList.remove("show")); }, dur + 100));
    return { statusCode: 200, currentStep: 0 };
  }
  async stopAction() { this._clear(); this.classList.remove("in", "full"); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
