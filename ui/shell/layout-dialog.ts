// Modaler Dialog für benannte Layouts (Ersatz für prompt(): blockiert den Tab nicht,
// passt optisch zur Shell). Eingabe eines Namens (speichern) oder Auswahl aus einer
// Liste (löschen); löst mit dem Text bzw. dem gewählten Eintrag, bei Abbruch mit null.
import { t } from "./i18n.ts";

interface Options {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  // Mit `choices`: Auswahlliste; ohne: Textfeld (mit `suggestions` als Datalist).
  choices?: string[];
  suggestions?: string[];
}

export function layoutDialog(opts: Options): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,0.5);font-family:var(--omp-font,system-ui,sans-serif);font-size:var(--omp-font-size-sm,12px);";
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.style.cssText =
      "background:var(--omp-surface,#24272b);color:var(--omp-text,#e8eaed);border:1px solid var(--omp-border,#3a3f45);" +
      "border-radius:var(--omp-radius,6px);padding:16px;min-width:280px;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,0.4);" +
      "display:flex;flex-direction:column;gap:12px;";
    const title = document.createElement("div");
    title.textContent = opts.title;
    box.appendChild(title);

    const fieldCss =
      "box-sizing:border-box;width:100%;padding:6px 8px;font:inherit;color:inherit;" +
      "background:var(--omp-surface-raised,#2f3339);border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);";
    let read: () => string;
    let focusEl: HTMLElement;
    if (opts.choices) {
      const sel = document.createElement("select");
      sel.size = Math.min(Math.max(opts.choices.length, 2), 8);
      sel.style.cssText = fieldCss;
      for (const c of opts.choices) sel.add(new Option(c, c));
      sel.selectedIndex = 0;
      sel.addEventListener("dblclick", () => done(read()));
      box.appendChild(sel);
      read = () => sel.value;
      focusEl = sel;
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.style.cssText = fieldCss;
      if (opts.suggestions?.length) {
        const dl = document.createElement("datalist");
        dl.id = `omp-layout-names-${Date.now()}`;
        for (const s of opts.suggestions) dl.appendChild(new Option(s));
        input.setAttribute("list", dl.id);
        box.appendChild(dl);
      }
      box.appendChild(input);
      read = () => input.value.trim();
      focusEl = input;
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const btnCss =
      "cursor:pointer;font:inherit;padding:6px 14px;border-radius:var(--omp-radius,6px);" +
      "border:1px solid var(--omp-border,#3a3f45);background:var(--omp-surface-raised,#2f3339);color:inherit;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("kit.cancel");
    cancel.style.cssText = btnCss;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = opts.confirmLabel;
    ok.style.cssText = btnCss + (opts.danger
      ? "background:var(--omp-error,#e53935);border-color:var(--omp-error,#e53935);color:#fff;"
      : "background:var(--omp-accent,#3b82f6);border-color:var(--omp-accent,#3b82f6);color:#fff;");
    actions.append(cancel, ok);
    box.appendChild(actions);
    overlay.appendChild(box);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") done(null);
      else if (ev.key === "Enter") done(read());
    };
    function done(v: string | null) {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v ? v : null);
    }
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(read()));
    overlay.addEventListener("pointerdown", (ev) => {
      if (ev.target === overlay) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    focusEl.focus();
  });
}
