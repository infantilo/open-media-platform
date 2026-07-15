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
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, var(--omp-surface-raised, #22262b), var(--omp-surface, #1a1d21) 70%);
      border: 1px solid var(--omp-border, #2e3338);
      box-shadow: 0 2px 3px rgba(0, 0, 0, 0.4);
      cursor: grab;
    }
    .dial:active {
      cursor: grabbing;
    }
    .indicator {
      position: absolute;
      top: 3px;
      left: 50%;
      width: 2px;
      height: 11px;
      background: var(--omp-info, #4285f4);
      border-radius: 1px;
      transform-origin: 50% 13px;
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
