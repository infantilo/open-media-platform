// <omp-confirm> + confirmDialog() — Ersatz für window.confirm() (S10,
// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): synchrones confirm()
// blockiert den ganzen Tab (inkl. der SSE-Verbindung im Hintergrund) und
// sieht je nach Browser wie eine Fremdkörper-Systemmeldung aus statt Teil
// der Shell — hier ein modales, per Promise<boolean> auswertbares Overlay
// im gleichen visuellen Stil wie der Rest von ui/kit.
//
// Bedienung: Klick auf "Bestätigen" löst true, Klick auf "Abbrechen"/
// Klick auf den Hintergrund/Escape-Taste löst false aus — danach entfernt
// sich das Element selbst (confirmDialog()s Aufrufer muss nichts
// aufräumen).
const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-sm, 12px);
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
    }
    .dialog {
      position: relative;
      background: var(--omp-surface, #24272b);
      color: var(--omp-text, #e8eaed);
      border: 1px solid var(--omp-border, #3a3f45);
      border-radius: var(--omp-radius, 6px);
      padding: var(--omp-space-4, 16px);
      max-width: 360px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .message {
      margin-bottom: var(--omp-space-3, 12px);
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--omp-space-2, 8px);
    }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      border-radius: var(--omp-radius, 6px);
      border: 1px solid var(--omp-border, #3a3f45);
      background: var(--omp-surface-raised, #2f3339);
      color: inherit;
      text-align: center;
    }
    button.confirm {
      background: var(--omp-error, #e53935);
      border-color: var(--omp-error, #e53935);
      color: #fff;
    }
  </style>
  <div class="backdrop" part="backdrop"></div>
  <div class="dialog" part="dialog" role="alertdialog">
    <div class="message" part="message"><slot></slot></div>
    <div class="actions">
      <button class="cancel" type="button" part="cancel"></button>
      <button class="confirm" type="button" part="confirm"></button>
    </div>
  </div>
`;

export class OmpConfirm extends HTMLElement {
  #cancelBtn: HTMLButtonElement;
  #confirmBtn: HTMLButtonElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#cancelBtn = shadow.querySelector("button.cancel")!;
    this.#confirmBtn = shadow.querySelector("button.confirm")!;
    shadow.querySelector(".backdrop")!.addEventListener("click", () => this.#resolve(false));
    this.#cancelBtn.addEventListener("click", () => this.#resolve(false));
    this.#confirmBtn.addEventListener("click", () => this.#resolve(true));
  }

  connectedCallback() {
    this.#cancelBtn.textContent = this.getAttribute("cancel-label") || "Abbrechen";
    this.#confirmBtn.textContent = this.getAttribute("confirm-label") || "Löschen";
    // Direkt fokussieren, nicht die bestätigende Aktion — ein versehentlicher
    // Enter-Druck (z. B. Fokus kam von einem Formular-Feld) soll nicht
    // sofort löschen.
    this.#cancelBtn.focus();
    document.addEventListener("keydown", this.#onKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
  }

  #onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") this.#resolve(false);
  };

  #resolve(value: boolean) {
    this.dispatchEvent(new CustomEvent<boolean>("resolve", { detail: value }));
  }
}

if (!customElements.get("omp-confirm")) {
  customElements.define("omp-confirm", OmpConfirm);
}

export interface ConfirmDialogOptions {
  confirmLabel?: string;
  cancelLabel?: string;
}

export function confirmDialog(message: string, opts: ConfirmDialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (opts.confirmLabel) el.setAttribute("confirm-label", opts.confirmLabel);
    if (opts.cancelLabel) el.setAttribute("cancel-label", opts.cancelLabel);
    el.addEventListener(
      "resolve",
      (ev) => {
        resolve((ev as CustomEvent<boolean>).detail);
        el.remove();
      },
      { once: true },
    );
    document.body.appendChild(el);
  });
}
