// Reiter „Aufnahme-Vergleich“ im Eingang (Kapitel 74.5): die Aufnahme eines Events (zweiter Eingangs-Eintrag) gegen das Original
// vergleichen — Dauer, Bildrate, Auflösung, Codec, Audio und Bildqualität (SSIM auf einer Stichprobe).
import { t as tt } from "../host.ts";
import { call, errText } from "./api.ts";
import { type CompareForm, type CompareReport, compareOptions, sortChecks, STATUS_ICON, statusColor } from "./compare-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

interface ListItem {
  assetId: string;
  fileName: string;
  title?: string;
  state: string;
}

export class ComparePanel {
  readonly el = el("div", "display:flex;flex-direction:column;gap:10px;");
  #id: string;
  #form: CompareForm = { offsetSec: "", durationTolMs: "", ssimMin: "", sampleSec: "", skipQuality: false, autoOffset: true };
  #recorded = "";
  #result = el("div");
  #busy = false;

  constructor(assetId: string) {
    this.#id = assetId;
    this.el.dataset.role = "compare-panel";
    void this.#build();
  }

  async #build(): Promise<void> {
    const r = await call<{ items: ListItem[] }>("GET", "/items?limit=200");
    const others = (r.data.items ?? []).filter((i) => i.assetId !== this.#id);
    const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;");
    box.append(el("div", "color:var(--omp-text-dim);font-size:12px;", tt("rv.cmp.hint")));
    const row = (label: string, ctl: HTMLElement, hint = "") => {
      const r2 = el("label", "display:flex;gap:8px;align-items:center;");
      r2.append(el("span", "min-width:190px;", label), ctl);
      if (hint) r2.append(el("span", "color:var(--omp-text-dim);font-size:11px;", hint));
      return r2;
    };
    const sel = el("select", "min-width:280px;");
    sel.dataset.role = "compare-recorded";
    sel.append(new Option(tt("rv.cmp.choose"), ""));
    for (const i of others) sel.append(new Option(`${i.title || i.fileName}  ·  ${i.fileName}`, i.assetId));
    sel.addEventListener("change", () => (this.#recorded = sel.value));
    const num = (key: "offsetSec" | "durationTolMs" | "ssimMin" | "sampleSec", ph: string) => {
      const i = el("input", "width:90px;");
      i.type = "text";
      i.placeholder = ph;
      i.dataset.field = key;
      i.addEventListener("input", () => (this.#form[key] = i.value));
      return i;
    };
    const auto = el("input");
    auto.type = "checkbox";
    auto.checked = true;
    auto.dataset.field = "autoOffset";
    auto.addEventListener("change", () => (this.#form.autoOffset = auto.checked));
    const skip = el("input");
    skip.type = "checkbox";
    skip.addEventListener("change", () => (this.#form.skipQuality = skip.checked));
    const go = el("button", "align-self:flex-start;padding:4px 16px;", tt("rv.cmp.run"));
    go.dataset.role = "compare-run";
    go.addEventListener("click", () => void this.#run(go));
    box.append(
      row(tt("rv.cmp.recorded"), sel),
      row(tt("rv.cmp.auto"), auto, tt("rv.cmp.autoHint")),
      row(tt("rv.cmp.offset"), num("offsetSec", "0"), tt("rv.cmp.offsetHint")),
      row(tt("rv.cmp.tol"), num("durationTolMs", "40"), tt("rv.cmp.tolHint")),
      row(tt("rv.cmp.ssim"), num("ssimMin", "0.98")),
      row(tt("rv.cmp.sample"), num("sampleSec", "10")),
      row(tt("rv.cmp.skip"), skip),
      go,
    );
    this.el.replaceChildren(box, this.#result);
  }

  async #run(btn: HTMLButtonElement): Promise<void> {
    if (this.#busy) return;
    if (!this.#recorded) {
      this.#result.replaceChildren(el("div", "color:var(--omp-error);", tt("rv.cmp.needRecorded")));
      return;
    }
    this.#busy = true;
    btn.disabled = true;
    this.#result.replaceChildren(el("div", "color:var(--omp-text-dim);", tt("rv.cmp.running")));
    const r = await call<CompareReport & Record<string, unknown>>("POST", `/items/${this.#id}/compare`, {
      recordedAssetId: this.#recorded,
      options: compareOptions(this.#form),
    });
    this.#busy = false;
    btn.disabled = false;
    if (!r.ok) {
      this.#result.replaceChildren(el("div", "color:var(--omp-error);", errText(r.data)));
      return;
    }
    this.#renderResult(r.data);
  }

  #renderResult(rep: CompareReport): void {
    const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:6px;");
    box.dataset.role = "compare-result";
    const color = rep.overall === "pass" ? statusColor("pass") : rep.overall === "fail" ? statusColor("fail") : statusColor("warn");
    box.append(el("div", `font-weight:700;color:${color};`, tt(`rv.cmp.overall.${rep.overall}`)));
    const table = el("table", "border-collapse:collapse;font-size:12px;");
    for (const c of sortChecks(rep.checks)) {
      const tr = el("tr");
      tr.dataset.status = c.status;
      const td = (text: string, css = "") => {
        const x = el("td", `padding:2px 10px 2px 0;vertical-align:top;${css}`, text);
        tr.append(x);
        return x;
      };
      td(STATUS_ICON[c.status] ?? "?", `color:${statusColor(c.status)};font-weight:700;`);
      td(c.label, "font-weight:600;");
      td(`${c.original ?? ""}${c.original || c.recorded ? " ↔ " : ""}${c.recorded ?? ""}`, "color:var(--omp-text-dim);");
      td(c.message);
      table.append(tr);
    }
    box.append(table);
    if (rep.offsetSec !== undefined) {
      box.append(el("div", "color:var(--omp-text-dim);font-size:11px;", tt(rep.offsetAuto ? "rv.cmp.usedAuto" : "rv.cmp.usedManual", { p0: rep.offsetSec.toFixed(2) })));
    }
    this.#result.replaceChildren(box);
  }

  destroy(): void {
    this.el.remove();
  }
}
