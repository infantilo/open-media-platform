// <omp-button> — beleuchtete Hardware-Taste (ARCHITECTURE.md §22.2,
// docs/END-GOAL-FEATURES.md §3.3 "Hardware-Look ... 3D-Haptik rein per
// CSS"). Optionaler ui/kit-Baustein (§4.5: kein Framework-Zwang) — ein
// Node-UI-Bundle bindet ihn per reinem `<script type="module">`-
// Seitenimport ein (customElements ist dokumentweit, durchdringt
// Shadow-DOM-Grenzen der einzelnen Bundles) und schreibt danach einfach
// `<omp-button variant="take">Take</omp-button>` in sein eigenes
// Shadow-DOM-Template — kein Import in jedem Bundle nötig, solange
// `ui/kit` einmal von der Shell geladen wurde.
//
// `click` bubbled per Spezifikation composed durch Shadow-DOM-Grenzen —
// bestehender Aufrufcode (`el.addEventListener("click", ...)`) funktioniert
// dadurch unverändert, kein Sonder-Event nötig.

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: inline-block;
    }
    button {
      all: unset;
      box-sizing: border-box;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      cursor: pointer;
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-sm, 12px);
      font-weight: 600;
      color: var(--omp-text, #e8eaed);
      /* Gegossene Metall-Taste statt dunkler-auf-dunkel: helle Kante oben,
         Naht in der Mitte, dunkle Kante unten — "echtes Pult"-Anmutung
         (§3.3), Referenzvergleich §12.3. */
      background: linear-gradient(
        to bottom,
        var(--omp-metal-highlight, #565d66) 0%,
        var(--omp-metal-light, #3d434b) 46%,
        var(--omp-metal-mid, #2b2f34) 54%,
        var(--omp-metal-dark, #1a1c1f) 100%
      );
      border: 1px solid var(--omp-metal-dark, #1a1c1f);
      border-radius: var(--omp-radius, 6px);
      padding: 8px 14px;
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.18) inset,
        0 -1px 0 rgba(0, 0, 0, 0.35) inset,
        0 2px 3px rgba(0, 0, 0, 0.45);
      transition: box-shadow 0.1s ease, transform 0.05s ease, background 0.1s ease;
      width: 100%;
      height: 100%;
      min-height: 32px;
      overflow: hidden;
    }
    /* Glanzlicht-Sheen im oberen Drittel (rein CSS, kein Bild-Asset) —
       macht aus dem Flächen-Gradient eine gewölbt wirkende Kappe. */
    button::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 45%;
      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0));
      pointer-events: none;
    }
    button:hover {
      border-color: var(--omp-text-dim, #9aa0a6);
    }
    button:active,
    :host([pressed]) button {
      transform: translateY(1px);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5) inset;
    }
    button:disabled {
      cursor: default;
      opacity: 0.4;
    }
    :host([variant="take"]) button {
      font-size: var(--omp-font-size-lg, 15px);
      padding: 10px 20px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    :host([active][color="onair"]) button {
      background: linear-gradient(to bottom, #d64540, var(--omp-onair, #e53935));
      border-color: var(--omp-onair, #e53935);
      color: #fff;
      box-shadow: var(--omp-glow-onair, 0 0 6px 1px rgba(229, 57, 53, 0.6));
    }
    :host([active][color="preset"]) button {
      background: linear-gradient(to bottom, #4fb054, var(--omp-preset, #43a047));
      border-color: var(--omp-preset, #43a047);
      color: #fff;
      box-shadow: var(--omp-glow-preset, 0 0 6px 1px rgba(67, 160, 71, 0.6));
    }
    :host([active][color="cue"]) button {
      background: linear-gradient(to bottom, #ff9d2e, var(--omp-cue, #fb8c00));
      border-color: var(--omp-cue, #fb8c00);
      color: #1a1200;
      box-shadow: var(--omp-glow-cue, 0 0 6px 1px rgba(251, 140, 0, 0.6));
    }
    :host([active]:not([color])) button {
      background: linear-gradient(to bottom, #5a9fef, var(--omp-info, #4285f4));
      border-color: var(--omp-info, #4285f4);
      color: #fff;
    }
  </style>
  <button part="button"><slot></slot></button>
`;

export class OmpButton extends HTMLElement {
  static get observedAttributes() {
    return ["disabled"];
  }

  #button: HTMLButtonElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#button = shadow.querySelector("button")!;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === "disabled") {
      this.#button.disabled = value !== null;
    }
  }

  get active(): boolean {
    return this.hasAttribute("active");
  }

  set active(value: boolean) {
    this.toggleAttribute("active", value);
  }
}

if (!customElements.get("omp-button")) {
  customElements.define("omp-button", OmpButton);
}
