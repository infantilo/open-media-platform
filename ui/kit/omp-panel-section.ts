// <omp-panel-section> — gruppierte Konsolen-Sektion mit betonter
// Kopfzeile (ARCHITECTURE.md §22.2, K3/K4-Feinschliff,
// docs/END-GOAL-FEATURES.md §12.3 "Visueller Maßstab", Referenzvergleich
// 2026-07-15 "Bildmeister"-Layout: "gruppierte Sektionen mit betonter
// Kopfzeile + Trennlinie" statt loser Bausteine nebeneinander). Reiner
// Layout-Baustein ohne eigenen Zustand — `label`-Attribut, restlicher
// Inhalt per <slot>, kein Framework-Zwang (§4.5).
const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: block;
      background: var(--omp-surface, #1a1d21);
      border: 1px solid var(--omp-border, #2e3338);
      border-radius: var(--omp-radius, 6px);
      padding: var(--omp-space-3, 12px);
    }
    .header {
      display: flex;
      align-items: center;
      gap: var(--omp-space-2, 8px);
      margin-bottom: var(--omp-space-2, 8px);
    }
    :host(:not([label])) .header {
      display: none;
    }
    .line {
      flex: 1;
      height: 1px;
      background: var(--omp-border, #2e3338);
    }
    .label {
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-xs, 11px);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--omp-text-dim, #9aa0a6);
      white-space: nowrap;
    }
  </style>
  <div class="header" part="header">
    <div class="line" part="line"></div>
    <span class="label" part="label"></span>
    <div class="line" part="line"></div>
  </div>
  <slot></slot>
`;

export class OmpPanelSection extends HTMLElement {
  static get observedAttributes() {
    return ["label"];
  }

  #labelEl: HTMLElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#labelEl = shadow.querySelector(".label")!;
  }

  connectedCallback() {
    this.#labelEl.textContent = this.getAttribute("label") ?? "";
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === "label") this.#labelEl.textContent = value ?? "";
  }
}

if (!customElements.get("omp-panel-section")) {
  customElements.define("omp-panel-section", OmpPanelSection);
}
