// Gemeinsame Bausteine für Dialoge der Verwaltungsansichten (Overlay mit Karte, beschriftete Listen, Haken, Knopfzeile).
import { t } from "./i18n.ts";

// Einfacher Dialog (Overlay + Karte) für Export, Import und Duplizieren: `build` füllt den Inhalt und ruft `done(wert)` auf;
// Abbrechen/Escape/Klick daneben liefert null. Hängt an document.body, nicht an die Ansicht — die baut sich bei jedem
// Neuzeichnen neu auf und würde den offenen Dialog mitreißen.
export function showDialog<T>(title: string, build: (body: HTMLElement, done: (v: T | null) => void) => void, wide = false): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = wide ? "680px" : "560px";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-3);";
    const h = document.createElement("span");
    h.className = "omp-h1";
    h.textContent = title;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.setAttribute("aria-label", t("wf.8311b9"));
    head.append(h, x);
    const body = document.createElement("div");
    modal.append(head, body);
    overlay.appendChild(modal);
    let closed = false;
    const done = (v: T | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") done(null);
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) done(null);
    });
    x.addEventListener("click", () => done(null));
    build(body, done);
    document.body.appendChild(overlay);
    queueMicrotask(() => (body.querySelector("input[type=text]") as HTMLInputElement | null)?.focus());
  });
}

/** Eine beschriftete Liste (Überschrift mit Zähler + Zeilen); leer → Hinweis „keine“. */
export function listBlock(title: string, rows: string[], emptyText: string): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText = "margin-bottom:var(--omp-space-3);";
  const h = document.createElement("div");
  h.style.cssText = "font-size:12px;font-weight:600;margin-bottom:4px;";
  h.textContent = `${title} (${rows.length})`;
  box.appendChild(h);
  const list = document.createElement("div");
  list.style.cssText =
    "max-height:130px;overflow:auto;border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 8px;font-size:12px;background:var(--omp-bg);";
  if (rows.length === 0) {
    list.style.color = "var(--omp-text-dim)";
    list.textContent = emptyText;
  } else {
    for (const r of rows) {
      const line = document.createElement("div");
      line.style.cssText = "padding:1px 0;overflow-wrap:anywhere;";
      line.textContent = r;
      list.appendChild(line);
    }
  }
  box.appendChild(list);
  return box;
}

export function checkRow(label: string, checked: boolean, disabled: boolean): { row: HTMLElement; box: HTMLInputElement } {
  const row = document.createElement("label");
  row.style.cssText = `display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 6px;${disabled ? "opacity:.5;" : "cursor:pointer;"}`;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked && !disabled;
  box.disabled = disabled;
  row.append(box, label);
  return { row, box };
}

export function buttonRow(confirmLabel: string, onOk: () => void, onCancel: () => void): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:var(--omp-space-3);";
  const cancel = document.createElement("button");
  cancel.textContent = t("kit.cancel");
  cancel.addEventListener("click", onCancel);
  const ok = document.createElement("button");
  ok.className = "omp-btn-primary";
  ok.textContent = confirmLabel;
  ok.addEventListener("click", onOk);
  row.append(cancel, ok);
  return row;
}

