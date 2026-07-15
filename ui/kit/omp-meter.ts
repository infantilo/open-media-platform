// <omp-meter> — vertikaler Pegel-Balken (ARCHITECTURE.md §22.2,
// docs/END-GOAL-FEATURES.md §4.3c: "grün/gelb/rot-Segmente,
// Peak-Hold-Strich"). Rein anzeigend, keine Interaktion. Property/
// Attribut `value` (0..1 RMS-Näherung) und `peak` (0..1) — der
// aufrufende Node-UI-Code bildet die Umrechnung von dBFS/LUFS o. ä. auf
// 0..1 selbst ab (kein Skalen-Wissen im Baustein, bleibt Node-agnostisch
// wie der Rest von `ui/kit`). Peak-Hold verfällt nach `peak-hold-ms`
// (Default 1500 ms) beim jeweils nächsten `peak`-Attribut-Update, kein
// eigener Animationsloop/Timer nötig — der aufrufende Code aktualisiert
// `peak` ohnehin in kurzen Abständen (Metering-Poll/SSE).

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: inline-block;
      width: 10px;
      height: 160px;
    }
    .track {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 2px;
      overflow: hidden;
      border: 1px solid var(--omp-border, #2e3338);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6) inset;
      /* Zwei Ebenen: LED-Segment-Fugen oben drüber, Farbskala darunter —
         macht aus dem Farbverlauf einen Block-Meter statt einer glatten
         Fläche (Referenzvergleich §12.3, "Bildmeister"-Layout). */
      background:
        repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 3px,
          rgba(0, 0, 0, 0.55) 3px,
          rgba(0, 0, 0, 0.55) 4px
        ),
        linear-gradient(
          to top,
          var(--omp-preset, #43a047) 0%,
          var(--omp-preset, #43a047) 70%,
          #d4a017 70%,
          #d4a017 88%,
          var(--omp-error, #ef5350) 88%,
          var(--omp-error, #ef5350) 100%
        );
    }
    .mask {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      background: var(--omp-bg, #101214);
      transition: height 0.06s linear;
    }
    .peak {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      background: #fff;
    }
  </style>
  <div class="track" part="track">
    <div class="mask" part="mask"></div>
    <div class="peak" part="peak"></div>
  </div>
`;

export class OmpMeter extends HTMLElement {
  static get observedAttributes() {
    return ["value", "peak"];
  }

  #mask: HTMLElement;
  #peakEl: HTMLElement;
  #peakDisplay = 0;
  #peakSetAt = 0;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#mask = shadow.querySelector(".mask")!;
    this.#peakEl = shadow.querySelector(".peak")!;
  }

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback(name: string) {
    if (name === "peak") {
      const p = this.peak;
      if (p >= this.#peakDisplay) {
        this.#peakDisplay = p;
        this.#peakSetAt = performance.now();
      }
    }
    this.#render();
  }

  get value(): number {
    return Number(this.getAttribute("value") ?? "0");
  }
  set value(v: number) {
    this.setAttribute("value", String(Math.min(1, Math.max(0, v))));
  }
  get peak(): number {
    return Number(this.getAttribute("peak") ?? "0");
  }
  set peak(v: number) {
    this.setAttribute("peak", String(Math.min(1, Math.max(0, v))));
  }
  get peakHoldMs(): number {
    return Number(this.getAttribute("peak-hold-ms") ?? "1500");
  }

  #render() {
    const held = performance.now() - this.#peakSetAt < this.peakHoldMs;
    const peakPct = held ? this.#peakDisplay : this.value;
    this.#mask.style.height = `${(1 - this.value) * 100}%`;
    this.#peakEl.style.bottom = `${peakPct * 100}%`;
    this.#peakEl.style.opacity = peakPct > 0 ? "1" : "0";
  }
}

if (!customElements.get("omp-meter")) {
  customElements.define("omp-meter", OmpMeter);
}
