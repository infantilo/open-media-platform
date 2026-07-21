// <omp-knob> — Drehregler (ARCHITECTURE.md §22.2, docs/END-GOAL-
// FEATURES.md §4.3c: "EQ-Sektion (3 <omp-knob> LO/MID/HI mit
// Mittenrastung)"). Bedienung wie an echten Pulten üblich: vertikaler
// Drag ändert den Wert (hoch = größer), keine Kreisgeste nötig — das ist
// Konvention bei digitalen Konsolen-UIs, nicht nur hier erfunden.
// Attribute `min`/`max`/`value`/`default-value`/`center-detent`
// (boolean: Wert nahe der Mitte rastet beim Loslassen leicht ein, für
// Pan/EQ-Gain-typische Regler um 0). Events `input`/`change` wie
// `<omp-fader>`.

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 44px;
      touch-action: none;
      user-select: none;
    }
    .dial {
      position: relative;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      /* Gewölbte Metallkugel statt flacher Kreis: Glanzpunkt oben-links,
         dunkler Rand — dazu ein Chrom-Bezel-Ring per doppeltem
         box-shadow (Hintergrundfarbe + Rahmenfarbe), kein Bild-Asset. */
      background: radial-gradient(
        circle at 32% 26%,
        var(--omp-metal-highlight, #565d66) 0%,
        var(--omp-metal-light, #3d434b) 40%,
        var(--omp-metal-mid, #2b2f34) 72%,
        var(--omp-metal-dark, #1a1c1f) 100%
      );
      border: 1px solid var(--omp-metal-dark, #1a1c1f);
      box-shadow:
        0 0 0 2px var(--omp-bg, #101214),
        0 0 0 3px var(--omp-border, #2e3338),
        0 2px 4px rgba(0, 0, 0, 0.5);
      cursor: grab;
    }
    .dial:active {
      cursor: grabbing;
    }
    /* Mittenschraube — kleiner dunkler Punkt, wie bei einem echten
       Potiknopf mit Zeiger statt einer nackten Kugel. */
    .dial::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--omp-metal-dark, #1a1c1f);
      transform: translate(-50%, -50%);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .indicator {
      position: absolute;
      top: 3px;
      left: 50%;
      width: 2px;
      height: 12px;
      background: linear-gradient(to bottom, #fff, var(--omp-text-dim, #9aa0a6));
      border-radius: 1px;
      box-shadow: 0 0 2px rgba(255, 255, 255, 0.5);
      transform-origin: 50% 14px;
    }
    .label {
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: 9px;
      color: var(--omp-text-dim, #9aa0a6);
      text-transform: uppercase;
    }
    .value {
      font-family: var(--omp-font-mono, monospace);
      font-size: 10px;
      color: var(--omp-text, #e8eaed);
    }
  </style>
  <div class="dial" part="dial"><div class="indicator" part="indicator"></div></div>
  <div class="value" part="value"></div>
  <div class="label" part="label"><slot></slot></div>
`;

const MIN_ANGLE = -135;
const MAX_ANGLE = 135;

export class OmpKnob extends HTMLElement {
  static get observedAttributes() {
    return ["value", "min", "max"];
  }

  #dial: HTMLElement;
  #indicator: HTMLElement;
  #valueLabel: HTMLElement;
  #dragging = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#dial = shadow.querySelector(".dial")!;
    this.#indicator = shadow.querySelector(".indicator")!;
    this.#valueLabel = shadow.querySelector(".value")!;
    this.#dial.addEventListener("pointerdown", this.#onPointerDown);
    this.#dial.addEventListener("dblclick", () => {
      this.value = this.defaultValue;
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
  }

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback() {
    if (!this.#dragging) this.#render();
  }

  get min(): number {
    return Number(this.getAttribute("min") ?? "0");
  }
  get max(): number {
    return Number(this.getAttribute("max") ?? "1");
  }
  get value(): number {
    return Number(this.getAttribute("value") ?? "0");
  }
  set value(v: number) {
    let clamped = Math.min(this.max, Math.max(this.min, v));
    if (this.hasAttribute("center-detent")) {
      const center = (this.max + this.min) / 2;
      const detentWindow = (this.max - this.min) * 0.015;
      if (Math.abs(clamped - center) < detentWindow) clamped = center;
    }
    this.setAttribute("value", String(clamped));
  }
  get defaultValue(): number {
    return Number(this.getAttribute("default-value") ?? String((this.max + this.min) / 2));
  }

  #render() {
    const pct = this.max === this.min ? 0.5 : (this.value - this.min) / (this.max - this.min);
    const angle = MIN_ANGLE + pct * (MAX_ANGLE - MIN_ANGLE);
    this.#indicator.style.transform = `rotate(${angle}deg)`;
    this.#valueLabel.textContent = this.value.toFixed(1);
  }

  #onPointerDown = (ev: PointerEvent) => {
    this.#dragging = true;
    this.#dial.setPointerCapture(ev.pointerId);
    const startY = ev.clientY;
    const startValue = this.value;
    const range = this.max - this.min;

    const onMove = (moveEv: PointerEvent) => {
      const fine = moveEv.shiftKey ? 4 : 1;
      const deltaPx = startY - moveEv.clientY;
      const deltaValue = (deltaPx / (120 * fine)) * range;
      this.value = startValue + deltaValue;
      // s. omp-fader.ts#onPointerDown-Doku: attributeChangedCallbacks
      // #dragging-Guard blockiert externe Updates während des Drags,
      // muss aber die eigene drag-getriebene Anzeige nicht mit
      // aufhalten — sonst friert der Zeiger während des Drags ein.
      this.#render();
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };
    const onUp = (upEv: PointerEvent) => {
      this.#dragging = false;
      this.#dial.releasePointerCapture(upEv.pointerId);
      this.#dial.removeEventListener("pointermove", onMove);
      this.#dial.removeEventListener("pointerup", onUp);
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    this.#dial.addEventListener("pointermove", onMove);
    this.#dial.addEventListener("pointerup", onUp);
  };
}

if (!customElements.get("omp-knob")) {
  customElements.define("omp-knob", OmpKnob);
}
