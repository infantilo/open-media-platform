// OGraf-v1-Template „Untertitel“ (P9.4): zentrierte Zeilen unten im Bild mit schwarzer Kontur
// und halbtransparentem Hintergrund. Die Untertitel-Engine setzt per `updateAction` den
// aktuellen Text; leerer Text blendet die Box aus (kein Layer-Wechsel zwischen den Cues).
const DEFAULTS = { text: "", fontSize: 38, bottom: 56 };

class Subtitle extends HTMLElement {
  constructor() {
    super();
    this._state = { ...DEFAULTS };
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { position: absolute; left: 0; right: 0; display: flex; justify-content: center; }
      .box {
        max-width: 80%;
        text-align: center;
        color: #fff;
        font-family: sans-serif;
        font-weight: 600;
        line-height: 1.25;
        padding: 6px 18px;
        background: rgba(0, 0, 0, 0.55);
        text-shadow: 0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000;
        white-space: pre-line;
        border-radius: 4px;
        opacity: 0;
        transition: opacity 0.08s linear;
      }
      .box.visible { opacity: 1; }
    `;
    this._box = document.createElement("div");
    this._box.className = "box";
    root.append(style, this._box);
  }

  _apply() {
    const { text, fontSize, bottom } = this._state;
    this.style.bottom = `${bottom}px`;
    this._box.style.fontSize = `${fontSize}px`;
    this._box.textContent = text || "";
    this._box.classList.toggle("visible", !!text && this._on);
  }

  async load(params) {
    this._state = { ...DEFAULTS, ...(params?.data || {}) };
    this._on = false;
    this._apply();
    return { statusCode: 200 };
  }

  async updateAction(params) {
    this._state = { ...this._state, ...(params?.data || {}) };
    this._apply();
    return { statusCode: 200 };
  }

  async playAction() {
    this._on = true;
    this._apply();
    return { statusCode: 200 };
  }

  async stopAction() {
    this._on = false;
    this._apply();
    return { statusCode: 200 };
  }

  async dispose() {
    return { statusCode: 200 };
  }
}

export default Subtitle;
