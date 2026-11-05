/**
 * Paternoster-Rahmen: deckende Fläche mit durchsichtigem Fenster in der Mitte.
 * Das Fenster ist ein Element mit data-ograf-zone="window"; sein großer Schlagschatten (box-shadow) bildet die deckende
 * Rahmenfläche, so bleibt alles außerhalb des Fensters verdeckt (auch der Überstand der fahrenden Bilder).
 * Kein oGraf-Standard: nur die Zone ist eine Erweiterung dieses Projekts.
 */
const STYLE_TEXT = `
:host { position: fixed; inset: 0; display: block; pointer-events: none; opacity: 0; transition: opacity 300ms ease; }
:host(.in) { opacity: 1; }
.window {
  position: absolute; left: 20%; top: 20%; width: 60%; height: 60%;
  box-shadow: 0 0 0 4000px var(--frame, #10151f);
  outline: 6px solid var(--accent, #00c8ff); outline-offset: 0;
}
.title {
  position: absolute; left: 20%; top: 8%; width: 60%;
  font: 600 44px/1.2 system-ui, sans-serif; color: #fff; letter-spacing: 0.04em;
}
`;
export default class PaternosterFrame extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    this._window = document.createElement("div");
    this._window.className = "window";
    this._window.setAttribute("data-ograf-zone", "window");
    this._title = document.createElement("div");
    this._title.className = "title";
    root.append(style, this._window, this._title);
  }
  _apply(d) {
    if (d.title !== undefined) this._title.textContent = d.title;
    if (d.frameColor) this.style.setProperty("--frame", d.frameColor);
    if (d.accentColor) this.style.setProperty("--accent", d.accentColor);
  }
  async load(p) { this._apply(p?.data || {}); return { statusCode: 200 }; }
  async dispose() { this.shadowRoot.innerHTML = ""; return { statusCode: 200 }; }
  async playAction() { this.classList.add("in"); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this.classList.remove("in"); return { statusCode: 200 }; }
  async updateAction(p) { this._apply(p?.data || {}); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
