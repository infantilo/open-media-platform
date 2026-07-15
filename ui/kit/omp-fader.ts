// <omp-fader> — vertikaler Kanalzug-Fader (ARCHITECTURE.md §22.2,
// docs/END-GOAL-FEATURES.md §4.3c: "vertikale Bahn ~160 px, dB-Skala-
// Ticks, Doppelklick = 0 dB, Shift = Feinmodus"). Attribute `min`/`max`/
// `value`/`default-value` (numerisch, z. B. dB); Events `input`
// (laufend während des Drags, gleiche Semantik wie natives
// `<input type="range">`) und `change` (bei Pointer-Up) — bestehender
// Aufrufcode kann beide wie beim nativen Element behandeln.
//
// Pointer-Capture-Drag statt `<input type="range">`, weil eine echte
// Pult-Optik (Kappen-Breite, dB-Ticks, Griffigkeit) mit dem nativen
// Element nicht erreichbar ist — funktional bleibt es aber ein
// einfacher 1D-Wertregler, kein neues Interaktionsmodell.

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      width: 44px;
      height: 180px;
      touch-action: none;
      user-select: none;
    }
    .track {
      position: relative;
      flex: 1;
      width: 6px;
      background: var(--omp-bg, #101214);
      border: 1px solid var(--omp-border, #2e3338);
      border-radius: 3px;
      margin: 4px 0 4px 10px;
      /* Eingelassene Bahn (recessed channel), wie bei einem echten
         Fader-Schlitz — kein Bild-Asset, reiner inset-Schatten. */
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6) inset;
    }
    /* Skalen-Ticks links neben der Bahn (§4.3c "dB-Skala-Ticks") — rein
       dekorativ in Teil 1 (keine dB-Beschriftung pro Tick), macht aus der
       Bahn spürbar eine Pult-Skala statt eines nackten Sliders. */
    .track::before {
      content: "";
      position: absolute;
      left: -7px;
      top: 0;
      bottom: 0;
      width: 4px;
      background-image: repeating-linear-gradient(
        to bottom,
        var(--omp-text-dim, #9aa0a6) 0,
        var(--omp-text-dim, #9aa0a6) 1px,
        transparent 1px,
        transparent 11px
      );
      opacity: 0.45;
    }
    .fill {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--omp-info, #4285f4);
      border-radius: 3px;
      opacity: 0.35;
    }
    .thumb {
      position: absolute;
      left: 50%;
      width: 28px;
      height: 15px;
      /* Metall-Kappe mit Mittelnaht, wie ein echter Fader-Griff — hell
         oben/dunkel unten, dünne dunkle Rille in der Mitte. */
      background: linear-gradient(
        to bottom,
        var(--omp-metal-highlight, #565d66) 0%,
        var(--omp-metal-light, #3d434b) 44%,
        #050607 50%,
        var(--omp-metal-mid, #2b2f34) 56%,
        var(--omp-metal-dark, #1a1c1f) 100%
      );
      border: 1px solid var(--omp-metal-dark, #1a1c1f);
      border-radius: 2px;
      transform: translate(-50%, 50%);
      cursor: grab;
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.15) inset,
        0 2px 3px rgba(0, 0, 0, 0.5);
    }
    :host(:active) .thumb,
    .thumb:active {
      cursor: grabbing;
      border-color: var(--omp-info, #4285f4);
    }
    .value {
      font-family: var(--omp-font-mono, monospace);
      font-size: 10px;
      color: var(--omp-text-dim, #9aa0a6);
      height: 14px;
    }
  </style>
  <div class="value" part="value"></div>
  <div class="track" part="track">
    <div class="fill" part="fill"></div>
    <div class="thumb" part="thumb"></div>
  </div>
`;

export class OmpFader extends HTMLElement {
  static get observedAttributes() {
    return ["value", "min", "max"];
  }

  #track: HTMLElement;
  #fill: HTMLElement;
  #thumb: HTMLElement;
  #valueLabel: HTMLElement;
  #dragging = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#track = shadow.querySelector(".track")!;
    this.#fill = shadow.querySelector(".fill")!;
    this.#thumb = shadow.querySelector(".thumb")!;
    this.#valueLabel = shadow.querySelector(".value")!;
    this.#thumb.addEventListener("pointerdown", this.#onPointerDown);
    this.#track.addEventListener("dblclick", () => {
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
    const clamped = Math.min(this.max, Math.max(this.min, v));
    this.setAttribute("value", String(clamped));
  }
  get defaultValue(): number {
    return Number(this.getAttribute("default-value") ?? "0");
  }

  #render() {
    const pct = this.max === this.min ? 0 : (this.value - this.min) / (this.max - this.min);
    this.#thumb.style.bottom = `${pct * 100}%`;
    this.#fill.style.height = `${pct * 100}%`;
    this.#valueLabel.textContent = this.value.toFixed(1);
  }

  #onPointerDown = (ev: PointerEvent) => {
    this.#dragging = true;
    this.#thumb.setPointerCapture(ev.pointerId);
    const trackRect = this.#track.getBoundingClientRect();
    const startY = ev.clientY;
    const startValue = this.value;
    const range = this.max - this.min;
    const sensitivity = trackRect.height || 1;

    const onMove = (moveEv: PointerEvent) => {
      const fine = moveEv.shiftKey ? 4 : 1;
      const deltaPx = startY - moveEv.clientY;
      const deltaValue = (deltaPx / (sensitivity * fine)) * range;
      this.value = startValue + deltaValue;
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };
    const onUp = (upEv: PointerEvent) => {
      this.#dragging = false;
      this.#thumb.releasePointerCapture(upEv.pointerId);
      this.#thumb.removeEventListener("pointermove", onMove);
      this.#thumb.removeEventListener("pointerup", onUp);
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    this.#thumb.addEventListener("pointermove", onMove);
    this.#thumb.addEventListener("pointerup", onUp);
  };
}

if (!customElements.get("omp-fader")) {
  customElements.define("omp-fader", OmpFader);
}
