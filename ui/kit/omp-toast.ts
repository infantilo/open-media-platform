// <omp-toast> + showToast() — Ersatz für alert() bei Fehlermeldungen/
// Statushinweisen (S10, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md):
// Stil 1:1 aus dem bisherigen `#showToast()` in `ui/graph/flow-canvas.ts`
// extrahiert (fixed unten mittig, Fehlerfarbe, 4s Auto-Dismiss), hier als
// wiederverwendbarer ui/kit-Baustein statt einer pro-View duplizierten
// Methode. flow-canvas.ts selbst bleibt unverändert (kein Teil dieses
// Schritts, s. docs/decisions.md) — nur workflows-view.ts/admin-view.ts
// (die bisher `alert()` nutzten) wechseln auf `showToast()`.
//
// Kein Framework/State-Management: `showToast()` erzeugt bei jedem Aufruf
// ein neues `<omp-toast>`-Element, hängt es an `host` (Default
// `document.body`) und entfernt es nach `durationMs` selbst wieder — der
// Aufrufer muss sich um nichts kümmern (kein manuelles Cleanup, kein
// gehaltenes Element-Handle).
const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      display: block;
    }
    div {
      background: var(--omp-error, #e53935);
      color: #fff;
      padding: var(--omp-space-2, 8px) var(--omp-space-4, 16px);
      border-radius: var(--omp-radius, 6px);
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-md, 14px);
      opacity: 0.95;
      white-space: pre-wrap;
      max-width: 60vw;
    }
    :host([variant="info"]) div {
      background: var(--omp-info, #4285f4);
    }
  </style>
  <div part="message"><slot></slot></div>
`;

const DEFAULT_DURATION_MS = 4000;

export class OmpToast extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
  }
}

if (!customElements.get("omp-toast")) {
  customElements.define("omp-toast", OmpToast);
}

export interface ShowToastOptions {
  /** "error" (Default, rot) oder "info" (blau) — s. flow-canvas.ts-Vorbild, das nur den Fehlerfall kannte. */
  variant?: "error" | "info";
  /** Wohin gehängt wird — Default document.body (view-unabhängig, immer sichtbar). */
  host?: ParentNode;
  durationMs?: number;
}

export function showToast(message: string, opts: ShowToastOptions = {}): void {
  const toast = document.createElement("omp-toast");
  toast.setAttribute("data-role", "toast");
  toast.textContent = message;
  if (opts.variant) toast.setAttribute("variant", opts.variant);
  (opts.host ?? document.body).appendChild(toast);
  setTimeout(() => toast.remove(), opts.durationMs ?? DEFAULT_DURATION_MS);
}
