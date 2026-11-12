/**
 * Trenner „Wipe“ für den Wechsel zwischen Playlist-Events: ein roter Verlaufsbalken fährt über die linke Bildhälfte
 * von oben nach unten, einer über die rechte von unten nach oben. Bei 50 % der Dauer ist das Bild vollständig
 * verdeckt (dort liegt der Schnitt: Clip-/Event-Wechsel), danach fahren die Balken weiter hinaus und geben das neue Bild frei.
 * playAction startet die ganze Fahrt und beendet sie selbst (kein stopAction nötig). Einheiten in vh/vw: auflösungsunabhängig.
 */
const DEF = { duration: 1800, color: "#d90012", softness: 30, hold: 30, reverse: false };
const STYLE = `
:host { position: fixed; inset: 0; display: block; pointer-events: none; overflow: hidden; }
.bar { position: absolute; top: 0; width: 50.2vw; will-change: transform; transform: translateY(-400vh); }
.l { left: 0; } .r { right: 0; }
`;
export default class WipeDivider extends HTMLElement {
  constructor() {
    super();
    this._d = { ...DEF };
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this._l = document.createElement("div"); this._l.className = "bar l";
    this._r = document.createElement("div"); this._r.className = "bar r";
    root.append(style, this._l, this._r);
    this._anims = [];
  }
  _layout() {
    const { color, softness, hold } = this._d;
    const s = Math.max(0, +softness) , h = Math.max(0, +hold);
    this._B = 100 + 2 * s + h; // Balkenhöhe in vh
    const a = (s / this._B) * 100, b = 100 - a;
    const g = `linear-gradient(to bottom, transparent 0, ${color} ${a}%, ${color} ${b}%, transparent 100%)`;
    for (const el of [this._l, this._r]) { el.style.height = `${this._B}vh`; el.style.background = g; }
  }
  _cancel() { this._anims.forEach((x) => x.cancel()); this._anims = []; }
  async load(p) { this._d = { ...DEF, ...(p?.data || {}) }; this._layout(); return { statusCode: 200 }; }
  async dispose() { this._cancel(); this.shadowRoot.innerHTML = ""; return { statusCode: 200 }; }
  async updateAction(p) { this._d = { ...this._d, ...(p?.data || {}) }; this._layout(); return { statusCode: 200 }; }
  async playAction() {
    this._cancel();
    this._layout();
    const dur = Math.max(200, +this._d.duration || DEF.duration), B = this._B;
    const down = [`translateY(${-B}vh)`, `translateY(100vh)`], up = [`translateY(100vh)`, `translateY(${-B}vh)`];
    const [left, right] = this._d.reverse ? [up, down] : [down, up];
    const opt = { duration: dur, easing: "linear", fill: "both" };
    this._anims = [this._l.animate({ transform: left }, opt), this._r.animate({ transform: right }, opt)];
    return { statusCode: 200, currentStep: 0 };
  }
  async stopAction() { this._cancel(); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
