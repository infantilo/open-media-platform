// Gemeinsame Formular-Bausteine des Eingangs (Einstellungsdialog und Editor der QC-Profile): beschriftetes Feld, Zahl, Text, Liste, Auswahl,
// Häkchen, Raster und einklappbarer Abschnitt. Alle schreiben direkt in das übergebene Objekt (Arbeitskopie).
import { type Cfg, joinList, splitList } from "./settings-logic.ts";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  optional?: boolean; // leer = Feld entfällt (z. B. „nicht prüfen“)
  help?: string;
}

export const field = (text: string, ctl: HTMLElement, help = "", wide = false): HTMLElement => {
  const w = el("label", `display:flex;flex-direction:column;gap:2px;${wide ? "grid-column:1/-1;" : ""}`);
  w.append(el("span", "font-size:11px;color:var(--omp-text-dim);", text));
  w.append(ctl);
  if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", help));
  return w;
};
export const num = (obj: Cfg, key: string, o2: NumOpts = {}): HTMLElement => {
  const wrap = el("span", "display:inline-flex;align-items:center;gap:4px;");
  const i = el("input") as HTMLInputElement;
  i.type = "number";
  i.style.width = "100%";
  if (o2.min !== undefined) i.min = String(o2.min);
  if (o2.max !== undefined) i.max = String(o2.max);
  i.step = String(o2.step ?? "any");
  i.value = obj[key] === undefined || obj[key] === null ? "" : String(obj[key]);
  i.addEventListener("input", () => {
    const t = i.value.trim().replace(",", ".");
    const n = Number(t);
    if (t === "" || !Number.isFinite(n)) {
      if (o2.optional) delete obj[key];
      else obj[key] = 0;
    } else obj[key] = n;
  });
  wrap.append(i);
  if (o2.suffix) wrap.append(el("span", "font-size:11px;color:var(--omp-text-dim);white-space:nowrap;", o2.suffix));
  return wrap;
};
export const text = (obj: Cfg, key: string, ph = "", optional = false): HTMLInputElement => {
  const i = el("input") as HTMLInputElement;
  i.value = obj[key] ?? "";
  i.placeholder = ph;
  i.addEventListener("input", () => {
    if (optional && i.value === "") delete obj[key];
    else obj[key] = i.value;
  });
  return i;
};
export const listInput = (obj: Cfg, key: string, ph = ""): HTMLInputElement => {
  const i = el("input") as HTMLInputElement;
  i.value = joinList(obj[key]);
  i.placeholder = ph;
  i.addEventListener("input", () => {
    const l = splitList(i.value);
    if (l.length) obj[key] = l;
    else delete obj[key];
  });
  return i;
};
export const select = (obj: Cfg, key: string, opts: [string, string][]): HTMLSelectElement => {
  const s = el("select") as HTMLSelectElement;
  for (const [v, l] of opts) {
    const op = el("option", "", l);
    op.value = v;
    s.append(op);
  }
  s.value = obj[key] ?? "";
  s.addEventListener("change", () => {
    if (s.value === "" && key === "fieldOrder") delete obj[key];
    else obj[key] = s.value;
  });
  return s;
};
export const check = (txt: string, obj: Cfg, key: string, help = ""): HTMLElement => {
  const w = el("div", "display:flex;flex-direction:column;");
  const l = el("label", "display:flex;align-items:center;gap:6px;font-size:12px;");
  const i = el("input") as HTMLInputElement;
  i.type = "checkbox";
  i.checked = !!obj[key];
  i.addEventListener("change", () => {
    if (i.checked) obj[key] = true;
    else if (key === "captions") delete obj[key];
    else obj[key] = false;
  });
  l.append(i, document.createTextNode(txt));
  w.append(l);
  if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);margin-left:22px;", help));
  return w;
};
export const grid = (cols = 2): HTMLElement => el("div", `display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px 14px;`);
export const section = (title: string, hint: string, open = false): { box: HTMLDetailsElement; content: HTMLElement } => {
  const box = el("details", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 10px;") as HTMLDetailsElement;
  box.open = open;
  box.append(el("summary", "cursor:pointer;font-weight:600;", title));
  const content = el("div", "display:flex;flex-direction:column;gap:8px;margin-top:8px;");
  if (hint) content.append(el("div", "font-size:11px;color:var(--omp-text-dim);", hint));
  box.append(content);
  return { box, content };
};
export const sub = (title: string): HTMLElement => el("div", "font-weight:600;font-size:12px;margin-top:4px;", title);
