// Auswahl des Workflow-Filters in der App-Bar: Knopf mit aktuellem Wert, darunter Suchfeld + Liste, die beim Tippen filtert
// (Pfeiltasten/Enter/Esc). Ersetzt die einfache Auswahlliste, die bei vielen Workflows unübersichtlich wurde.
import { t as tt } from "./i18n.ts";

export interface PickerOption {
  id: string;
  label: string;
}

/** Filtert nach Teilstrings (ohne Groß-/Kleinschreibung); mehrere Wörter müssen alle vorkommen. */
export function filterOptions(list: PickerOption[], query: string): PickerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((o) => {
    const hay = `${o.label} ${o.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export class WorkflowPicker {
  readonly element: HTMLElement;
  #btn: HTMLButtonElement;
  #pop: HTMLElement;
  #input: HTMLInputElement;
  #listEl: HTMLElement;
  #options: PickerOption[] = [];
  #value = "";
  #shown: PickerOption[] = [];
  #active = 0;
  onChange: (id: string) => void = () => {};

  constructor() {
    this.element = document.createElement("div");
    this.element.setAttribute("data-role", "workflow-picker");
    this.element.style.cssText = "position:relative;font-size:var(--omp-font-size-xs);";
    this.#btn = document.createElement("button");
    this.#btn.setAttribute("data-role", "workflow-filter-select");
    this.#btn.style.cssText =
      "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 8px;border:1px solid var(--omp-border);" +
      "border-radius:var(--omp-radius);background:var(--omp-surface-raised);color:var(--omp-text);cursor:pointer;font-size:inherit;";
    this.#btn.addEventListener("click", () => (this.#pop.style.display === "none" ? this.#open() : this.#close()));
    this.#pop = document.createElement("div");
    this.#pop.style.cssText =
      "display:none;position:absolute;left:0;top:100%;margin-top:4px;z-index:3000;width:280px;background:var(--omp-surface-raised,#1b2233);" +
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);box-shadow:0 6px 24px rgba(0,0,0,.5);padding:6px;box-sizing:border-box;";
    this.#input = document.createElement("input");
    this.#input.type = "search";
    this.#input.setAttribute("data-role", "workflow-filter-search");
    this.#input.placeholder = tt("aps.wfSearch");
    this.#input.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:4px;";
    this.#input.addEventListener("input", () => {
      this.#active = 0;
      this.#renderList();
    });
    this.#input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") this.#active = Math.min(this.#shown.length - 1, this.#active + 1);
      else if (ev.key === "ArrowUp") this.#active = Math.max(0, this.#active - 1);
      else if (ev.key === "Enter") {
        const o = this.#shown[this.#active];
        if (o) this.#choose(o.id);
        return;
      } else if (ev.key === "Escape") {
        this.#close();
        return;
      } else return;
      ev.preventDefault();
      this.#renderList();
    });
    this.#listEl = document.createElement("div");
    this.#listEl.style.cssText = "max-height:320px;overflow-y:auto;";
    this.#pop.append(this.#input, this.#listEl);
    this.element.append(this.#btn, this.#pop);
    document.addEventListener("pointerdown", (ev) => {
      if (this.#pop.style.display !== "none" && !this.element.contains(ev.target as Node)) this.#close();
    }, true);
    this.#updateButton();
  }

  get value(): string {
    return this.#value;
  }

  /** Setzt die Liste ("Alle" kommt von selbst dazu). Gibt false zurück, wenn der bisherige Wert nicht mehr existiert (dann wird auf „Alle“ gesetzt). */
  setOptions(list: PickerOption[]): boolean {
    this.#options = list;
    const still = !this.#value || list.some((o) => o.id === this.#value);
    if (!still) this.#value = "";
    this.#updateButton();
    if (this.#pop.style.display !== "none") this.#renderList();
    return still;
  }

  #all(): PickerOption[] {
    return [{ id: "", label: tt("aps.00a8fd") }, ...this.#options];
  }

  #updateButton() {
    const cur = this.#all().find((o) => o.id === this.#value);
    this.#btn.textContent = (cur?.label ?? tt("aps.00a8fd")) + " ▾";
    this.#btn.title = cur?.label ?? "";
  }

  #open() {
    this.#pop.style.display = "block";
    this.#input.value = "";
    this.#active = Math.max(0, this.#all().findIndex((o) => o.id === this.#value));
    this.#renderList();
    this.#input.focus();
  }

  #close() {
    this.#pop.style.display = "none";
  }

  #choose(id: string) {
    this.#value = id;
    this.#updateButton();
    this.#close();
    this.onChange(id);
  }

  #renderList() {
    this.#shown = filterOptions(this.#all(), this.#input.value);
    this.#active = Math.min(this.#active, Math.max(0, this.#shown.length - 1));
    this.#listEl.replaceChildren();
    if (!this.#shown.length) {
      const e = document.createElement("div");
      e.textContent = tt("aps.wfNone");
      e.style.cssText = "padding:6px;color:var(--omp-text-dim);";
      this.#listEl.append(e);
      return;
    }
    this.#shown.forEach((o, i) => {
      const row = document.createElement("div");
      row.dataset.id = o.id;
      row.textContent = o.label;
      row.style.cssText =
        `padding:4px 8px;cursor:pointer;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
        (i === this.#active ? "background:var(--omp-accent,#2f8cff);color:#fff;" : o.id === this.#value ? "font-weight:600;" : "");
      row.addEventListener("pointerenter", () => {
        this.#active = i;
        this.#renderList();
      });
      row.addEventListener("click", () => this.#choose(o.id));
      this.#listEl.append(row);
    });
    this.#listEl.children[this.#active]?.scrollIntoView?.({ block: "nearest" });
  }
}
