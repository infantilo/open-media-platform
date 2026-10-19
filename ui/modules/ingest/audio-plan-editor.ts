// Editor des Kanalplans (Kapitel 45): welche Quelle/welcher Kanal auf welchen Ausgabekanal der Aufnahmedatei kommt.
import { t as tt } from "../host.ts";
import {
  addChannel, addInput, type AudioPlanForm, channelsOf, emptyPlan, identityPlan, MAX_INPUTS, moveChannel, type PlanProblem, removeChannel, removeInput, setChannel, validatePlan,
} from "./audio-plan-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface SourceInfo {
  instanceId: string;
  nodeLabel: string;
  online: boolean;
  senders: { id: string; label: string; format: string; channelCount?: number }[];
}

/** Kanalzahl der Audio-Quelle `key` (`instanceId|senderLabel`) laut Quellenliste; 0 = unbekannt. */
export function channelCountOf(sources: SourceInfo[], key: string): number {
  const [instanceId, senderLabel] = key.split("|");
  const src = sources.find((s) => s.instanceId === instanceId);
  if (!src) return 0;
  const audio = src.senders.filter((s) => s.format.includes("audio") && (!senderLabel || s.label === senderLabel));
  return audio[0]?.channelCount ?? 0;
}

export interface EditorOptions {
  sources: SourceInfo[];
  /** Schlüssel der Hauptquelle des Formulars (kann sich ändern). */
  primaryKey: () => string;
  primaryLabel: () => string;
  /** Dateiendung des gewählten Profils (bestimmt die Kanalgrenze). */
  ext: () => string;
  initial: AudioPlanForm | null;
  onChange: (plan: AudioPlanForm | null) => void;
}

export class AudioPlanEditor {
  readonly el = el("div", "grid-column:1/-1;border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;");
  #plan: AudioPlanForm | null;
  #o: EditorOptions;

  constructor(o: EditorOptions) {
    this.#o = o;
    this.#plan = o.initial;
    this.el.dataset.role = "audio-plan";
    this.#render();
  }

  /** Nach Änderung der Hauptquelle/des Profils: Prüfhinweise und Kanalauswahl neu zeichnen. */
  refresh() {
    // nur neu zeichnen, wenn sich etwas Relevantes geändert hat — sonst würde ein Klick mitten in der Eingabe ins Leere gehen
    const sig = `${this.#o.primaryKey()}|${this.#o.primaryLabel()}|${this.#o.ext()}|${this.#counts().join(",")}`;
    if (sig === this.#sig) return;
    this.#render();
  }
  #sig = "";

  get plan(): AudioPlanForm | null {
    return this.#plan;
  }

  #counts(): number[] {
    const p = this.#plan ?? emptyPlan();
    return [channelCountOf(this.#o.sources, this.#o.primaryKey()), ...p.inputs.map((i) => channelCountOf(this.#o.sources, i.key))];
  }

  #set(p: AudioPlanForm | null) {
    this.#plan = p;
    this.#o.onChange(p);
    this.#render();
  }

  #sourceName(i: number): string {
    if (i === 0) return `${tt("ing.ap.main")}${this.#o.primaryLabel() ? ` (${this.#o.primaryLabel()})` : ""}`;
    const inp = this.#plan?.inputs[i - 1];
    return `${tt("ing.ap.source", { n: i + 1 })}${inp?.label ? ` (${inp.label})` : ""}`;
  }

  #render() {
    this.#sig = `${this.#o.primaryKey()}|${this.#o.primaryLabel()}|${this.#o.ext()}|${this.#counts().join(",")}`;
    this.el.replaceChildren();
    const head = el("label", "display:flex;gap:8px;align-items:center;cursor:pointer;");
    const on = el("input") as HTMLInputElement;
    on.type = "checkbox";
    on.checked = this.#plan !== null;
    on.dataset.role = "audio-plan-toggle";
    on.addEventListener("change", () => {
      if (on.checked) this.#set(identityPlan(this.#counts()[0]));
      else this.#set(null);
    });
    head.append(on, el("b", "", tt("ing.ap.title")));
    this.el.append(head, el("div", "font-size:11px;color:var(--omp-text-dim);margin:2px 0 6px;", tt(this.#plan ? "ing.ap.hint.on" : "ing.ap.hint.off")));
    const plan = this.#plan;
    if (!plan) return;
    const counts = this.#counts();

    // ---- weitere Quellen
    const srcBox = el("div", "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;");
    srcBox.append(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("ing.ap.sources")));
    plan.inputs.forEach((inp, i) => {
      const row = el("div", "display:flex;gap:6px;align-items:center;");
      row.dataset.role = "ap-input";
      row.append(el("span", "min-width:90px;font-size:12px;", tt("ing.ap.source", { n: i + 2 })));
      const sel = el("select", "flex:1;") as HTMLSelectElement;
      for (const s of this.#o.sources.filter((x) => x.senders.some((sn) => sn.format.includes("audio")))) {
        const o = el("option", "", `${s.nodeLabel}${s.online ? "" : " (" + tt("ing.host.offline") + ")"}`);
        o.value = `${s.instanceId}|`;
        o.dataset.label = s.nodeLabel;
        sel.append(o);
      }
      if (![...sel.options].some((o) => o.value === inp.key)) {
        const keep = el("option", "", inp.label || inp.key);
        keep.value = inp.key;
        sel.append(keep);
      }
      sel.value = inp.key;
      sel.addEventListener("change", () => {
        const label = sel.selectedOptions[0]?.dataset.label ?? "";
        this.#set({ ...plan, inputs: plan.inputs.map((x, k) => (k === i ? { key: sel.value, label } : x)) });
      });
      const cnt = counts[i + 1];
      row.append(sel, el("span", "font-size:11px;color:var(--omp-text-dim);min-width:70px;", cnt ? tt("ing.ap.chn", { n: cnt }) : tt("ing.ap.chn.unknown")));
      const rm = el("button", "padding:1px 8px;", "✕");
      rm.title = tt("ing.ap.removeSource");
      rm.dataset.role = "ap-remove-input";
      rm.addEventListener("click", () => this.#set(removeInput(plan, i)));
      row.append(rm);
      srcBox.append(row);
    });
    const add = el("button", "padding:2px 10px;align-self:flex-start;", "＋ " + tt("ing.ap.addSource"));
    add.dataset.role = "ap-add-input";
    add.disabled = plan.inputs.length >= MAX_INPUTS || !this.#o.sources.some((x) => x.senders.some((sn) => sn.format.includes("audio")));
    add.addEventListener("click", () => {
      const first = this.#o.sources.find((x) => x.senders.some((sn) => sn.format.includes("audio")));
      if (first) this.#set(addInput(plan, { key: `${first.instanceId}|`, label: first.nodeLabel }));
    });
    srcBox.append(add);
    this.el.append(srcBox);

    // ---- Ausgabekanäle
    const tb = el("table", "width:100%;border-collapse:collapse;font-size:12px;");
    tb.dataset.role = "ap-channels";
    const hr = el("tr", "text-align:left;color:var(--omp-text-dim);font-size:10px;text-transform:uppercase;");
    for (const k of ["ing.ap.col.out", "ing.ap.col.src", "ing.ap.col.ch", "ing.ap.col.gain", "ing.ap.col.label", ""]) hr.append(el("th", "padding:2px 6px;font-weight:500;", k ? tt(k as never) : ""));
    tb.append(hr);
    plan.channels.forEach((c, n) => {
      const tr = el("tr", "border-top:1px solid var(--omp-border);");
      tr.dataset.role = "ap-row";
      tr.append(el("td", "padding:3px 6px;font-family:var(--omp-font-mono);", String(n + 1)));
      const srcSel = el("select") as HTMLSelectElement;
      srcSel.dataset.role = "ap-src";
      const silence = el("option", "", tt("ing.ap.silence"));
      silence.value = "";
      srcSel.append(silence);
      for (let i = 0; i <= plan.inputs.length; i++) {
        const o = el("option", "", this.#sourceName(i));
        o.value = String(i);
        srcSel.append(o);
      }
      srcSel.value = c.input === null ? "" : String(c.input);
      srcSel.addEventListener("change", () => this.#set(setChannel(plan, n, { input: srcSel.value === "" ? null : Number(srcSel.value), channel: 0 })));
      const srcTd = el("td", "padding:3px 6px;");
      srcTd.append(srcSel);
      tr.append(srcTd);
      const chTd = el("td", "padding:3px 6px;");
      if (c.input !== null) {
        const known = channelsOf(counts, c.input);
        const chSel = el("select") as HTMLSelectElement;
        chSel.dataset.role = "ap-ch";
        const n2 = Math.max(known, c.channel + 1, 1);
        for (let k = 0; k < n2; k++) {
          const o = el("option", "", String(k + 1));
          o.value = String(k);
          chSel.append(o);
        }
        chSel.value = String(c.channel);
        chSel.addEventListener("change", () => this.#set(setChannel(plan, n, { channel: Number(chSel.value) })));
        chTd.append(chSel);
      } else chTd.append(el("span", "color:var(--omp-text-dim);", "—"));
      tr.append(chTd);
      const gainTd = el("td", "padding:3px 6px;");
      if (c.input !== null) {
        const g = el("input", "width:64px;") as HTMLInputElement;
        g.type = "number";
        g.step = "0.5";
        g.value = String(c.gainDb);
        g.dataset.role = "ap-gain";
        g.addEventListener("change", () => this.#set(setChannel(plan, n, { gainDb: Number(g.value) })));
        gainTd.append(g, el("span", "margin-left:3px;color:var(--omp-text-dim);", "dB"));
      }
      tr.append(gainTd);
      const lblTd = el("td", "padding:3px 6px;");
      const lbl = el("input", "width:100%;box-sizing:border-box;") as HTMLInputElement;
      lbl.value = c.label;
      lbl.placeholder = tt("ing.ap.label.ph");
      lbl.dataset.role = "ap-label";
      lbl.addEventListener("change", () => this.#set(setChannel(plan, n, { label: lbl.value })));
      lblTd.append(lbl);
      tr.append(lblTd);
      const act = el("td", "padding:3px 6px;white-space:nowrap;text-align:right;");
      const mk = (txt: string, title: string, fn: () => void, disabled = false): HTMLButtonElement => {
        const b = el("button", "padding:0 6px;margin-left:2px;", txt);
        b.title = title;
        b.disabled = disabled;
        b.addEventListener("click", fn);
        return b;
      };
      act.append(
        mk("↑", tt("ing.ap.up"), () => this.#set(moveChannel(plan, n, -1)), n === 0),
        mk("↓", tt("ing.ap.down"), () => this.#set(moveChannel(plan, n, 1)), n === plan.channels.length - 1),
        mk("✕", tt("ing.ap.removeCh"), () => this.#set(removeChannel(plan, n))),
      );
      tr.append(act);
      tb.append(tr);
    });
    this.el.append(tb);

    const tools = el("div", "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;");
    const addCh = el("button", "padding:2px 10px;", "＋ " + tt("ing.ap.addChannel"));
    addCh.dataset.role = "ap-add-channel";
    addCh.addEventListener("click", () => this.#set(addChannel(plan)));
    const ident = el("button", "padding:2px 10px;", tt("ing.ap.identity"));
    ident.title = tt("ing.ap.identity.hint");
    ident.addEventListener("click", () => this.#set({ ...identityPlan(counts[0]), inputs: plan.inputs }));
    tools.append(addCh, ident);
    this.el.append(tools);

    // ---- Prüfung
    const probs: PlanProblem[] = validatePlan(plan, counts, this.#o.ext());
    const box = el("div", "margin-top:6px;font-size:12px;");
    box.dataset.role = "ap-check";
    if (probs.length) for (const p of probs) box.append(el("div", "color:var(--omp-error);", tt(p.key as never, p.params)));
    else box.append(el("div", "color:var(--omp-preset);", "✔ " + tt("ing.ap.ok", { n: plan.channels.length, s: plan.inputs.length + 1 })));
    this.el.append(box);
  }

  /** Meldungen für das Formular (leer = ok). */
  problems(): string[] {
    return this.#plan ? validatePlan(this.#plan, this.#counts(), this.#o.ext()).map((p) => tt(p.key as never, p.params)) : [];
  }
}
