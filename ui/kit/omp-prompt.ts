import { t } from "../shell/i18n.ts";
// <omp-prompt> + promptDialog() — Ersatz für window.prompt(): modales Overlay mit einer Texteingabe im Stil von
// <omp-confirm>. Löst mit dem Text (OK / Enter) oder null (Abbrechen / Escape / Klick auf den Hintergrund) auf;
// danach entfernt sich das Element selbst. Bundles ohne Shell-Import nutzen das Element per `resolve`-Event
// (detail = string | null), `message` = Textinhalt, `value` = Vorbelegung, `ok-label`/`cancel-label` optional.
const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center;
      font-family: var(--omp-font, system-ui, sans-serif); font-size: var(--omp-font-size-sm, 12px); }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
    .dialog { position: relative; background: var(--omp-surface, #24272b); color: var(--omp-text, #e8eaed);
      border: 1px solid var(--omp-border, #3a3f45); border-radius: var(--omp-radius, 6px);
      padding: var(--omp-space-4, 16px); width: min(92vw, 380px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
    .message { margin-bottom: var(--omp-space-3, 12px); white-space: pre-wrap; }
    input { box-sizing: border-box; width: 100%; margin-bottom: var(--omp-space-3, 12px); padding: 6px 8px;
      font: inherit; color: inherit; background: var(--omp-surface-raised, #2f3339);
      border: 1px solid var(--omp-border, #3a3f45); border-radius: var(--omp-radius, 6px); }
    .actions { display: flex; justify-content: flex-end; gap: var(--omp-space-2, 8px); }
    button { all: unset; box-sizing: border-box; cursor: pointer; font-family: inherit; font-size: inherit; padding: 6px 14px;
      border-radius: var(--omp-radius, 6px); border: 1px solid var(--omp-border, #3a3f45);
      background: var(--omp-surface-raised, #2f3339); color: inherit; text-align: center; }
    button.ok { background: var(--omp-info, #4285f4); border-color: var(--omp-info, #4285f4); color: #fff; }
  </style>
  <div class="backdrop" part="backdrop"></div>
  <div class="dialog" part="dialog" role="dialog">
    <div class="message" part="message"><slot></slot></div>
    <input type="text" autocomplete="off" spellcheck="false" part="input">
    <div class="actions">
      <button class="cancel" type="button" part="cancel"></button>
      <button class="ok" type="button" part="ok"></button>
    </div>
  </div>
`;

export class OmpPrompt extends HTMLElement {
  #input: HTMLInputElement;
  #cancelBtn: HTMLButtonElement;
  #okBtn: HTMLButtonElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#input = shadow.querySelector("input")!;
    this.#cancelBtn = shadow.querySelector("button.cancel")!;
    this.#okBtn = shadow.querySelector("button.ok")!;
    shadow.querySelector(".backdrop")!.addEventListener("click", () => this.#resolve(null));
    this.#cancelBtn.addEventListener("click", () => this.#resolve(null));
    this.#okBtn.addEventListener("click", () => this.#resolve(this.#input.value));
    this.#input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#resolve(this.#input.value);
    });
  }

  connectedCallback() {
    this.#cancelBtn.textContent = this.getAttribute("cancel-label") || t("kit.cancel");
    this.#okBtn.textContent = this.getAttribute("ok-label") || t("kit.ok");
    this.#input.value = this.getAttribute("value") ?? "";
    this.#input.focus();
    this.#input.select();
    document.addEventListener("keydown", this.#onKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
  }

  #onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") this.#resolve(null);
  };

  #resolve(value: string | null) {
    this.dispatchEvent(new CustomEvent<string | null>("resolve", { detail: value }));
  }
}

if (!customElements.get("omp-prompt")) {
  customElements.define("omp-prompt", OmpPrompt);
}

export interface PromptDialogOptions {
  /** Vorbelegung des Eingabefelds. */
  initial?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export function promptDialog(message: string, opts: PromptDialogOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement("omp-prompt");
    el.textContent = message;
    if (opts.initial) el.setAttribute("value", opts.initial);
    if (opts.okLabel) el.setAttribute("ok-label", opts.okLabel);
    if (opts.cancelLabel) el.setAttribute("cancel-label", opts.cancelLabel);
    el.addEventListener(
      "resolve",
      (ev) => {
        resolve((ev as CustomEvent<string | null>).detail);
        el.remove();
      },
      { once: true },
    );
    document.body.appendChild(el);
  });
}
