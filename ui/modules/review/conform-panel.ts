// Conform-Editor (Kapitel 43): nutzbarer Bereich, mehrere Segmente (Name, In, Out exklusiv, Reihenfolge, Beschreibung,
// Segment-Metadaten) und das redaktionelle Metadatenformular des Assets. Nicht-destruktiv: es werden nur Bereiche und
// Metadaten gespeichert, die Quelldatei bleibt unverändert.
import { t as tt } from "../host.ts";
import {
  addSegment, moveSegment, type Policy, removeSegment, type Segment, type SegProblem, updateSegment, validateSegments,
} from "./review-logic.ts";
import { frameForTimecode, timecodeOf, type Timeline } from "./timecode.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface MetaField {
  id: string;
  label: string;
  type: "text" | "longtext" | "select" | "multiselect" | "tags" | "date" | "number";
  required?: boolean;
  values?: string[];
  segment?: boolean;
  max?: number;
}

export interface Draft {
  usable: { in: number; out: number } | null;
  segments: Segment[];
  assetMetadata: Record<string, unknown>;
}

export interface ConformHost {
  timeline: Timeline;
  policy: Policy;
  fields: MetaField[];
  readOnly: boolean;
  getMarks: () => { in: number | null; out: number | null };
  getFrame: () => number;
  goto: (frame: number) => void;
  preview: (inF: number, outF: number) => void;
  changed: () => void; // Entwurf wurde verändert
  selectionChanged: () => void; // Segmentliste verändert (Zeitleiste neu zeichnen)
}

/** Ein einzelnes Metadatenfeld; schreibt in `values` und ruft `onChange`. */
export function metaInput(f: MetaField, values: Record<string, unknown>, onChange: () => void, readOnly: boolean): HTMLElement {
  const wrap = el("label", "display:flex;flex-direction:column;gap:2px;");
  wrap.append(el("span", "font-size:11px;color:var(--omp-text-dim);", f.label + (f.required ? " *" : "")));
  const set = (v: unknown) => {
    if (v === "" || v === undefined || (Array.isArray(v) && v.length === 0)) delete values[f.id];
    else values[f.id] = v;
    onChange();
  };
  const cur = values[f.id];
  let c: HTMLElement;
  switch (f.type) {
    case "longtext": {
      const i = el("textarea", "min-height:54px;resize:vertical;") as HTMLTextAreaElement;
      i.value = typeof cur === "string" ? cur : "";
      i.disabled = readOnly;
      if (f.max) i.maxLength = f.max;
      i.addEventListener("input", () => set(i.value));
      c = i;
      break;
    }
    case "select": {
      const s = el("select") as HTMLSelectElement;
      const blank = el("option", "", "—");
      blank.value = "";
      s.append(blank);
      for (const v of f.values ?? []) {
        const o = el("option", "", v);
        o.value = v;
        s.append(o);
      }
      s.value = typeof cur === "string" ? cur : "";
      s.disabled = readOnly;
      s.addEventListener("change", () => set(s.value));
      c = s;
      break;
    }
    case "multiselect": {
      const box = el("div", "display:flex;flex-wrap:wrap;gap:8px;");
      const sel = new Set<string>(Array.isArray(cur) ? (cur as string[]) : []);
      for (const v of f.values ?? []) {
        const l = el("label", "display:flex;gap:3px;align-items:center;font-size:12px;");
        const cb = el("input") as HTMLInputElement;
        cb.type = "checkbox";
        cb.checked = sel.has(v);
        cb.disabled = readOnly;
        cb.addEventListener("change", () => {
          if (cb.checked) sel.add(v);
          else sel.delete(v);
          set([...sel]);
        });
        l.append(cb, v);
        box.append(l);
      }
      c = box;
      break;
    }
    case "tags": {
      // Schlagworte: Komma/Enter trennt; wird als Liste gespeichert
      const i = el("input") as HTMLInputElement;
      i.value = Array.isArray(cur) ? (cur as string[]).join(", ") : "";
      i.placeholder = tt("rv.meta.tags.hint");
      i.disabled = readOnly;
      i.addEventListener("input", () => set(i.value.split(",").map((x) => x.trim()).filter(Boolean)));
      c = i;
      break;
    }
    case "date": {
      const i = el("input") as HTMLInputElement;
      i.type = "date";
      i.value = typeof cur === "string" ? cur : "";
      i.disabled = readOnly;
      i.addEventListener("input", () => set(i.value));
      c = i;
      break;
    }
    case "number": {
      const i = el("input") as HTMLInputElement;
      i.type = "number";
      i.value = typeof cur === "number" ? String(cur) : "";
      i.disabled = readOnly;
      i.addEventListener("input", () => set(i.value === "" ? "" : Number(i.value)));
      c = i;
      break;
    }
    default: {
      const i = el("input") as HTMLInputElement;
      i.value = typeof cur === "string" ? cur : "";
      i.disabled = readOnly;
      if (f.max) i.maxLength = f.max;
      i.addEventListener("input", () => set(i.value));
      c = i;
    }
  }
  c.dataset.meta = f.id;
  wrap.append(c);
  return wrap;
}

export class ConformPanel {
  readonly el = el("div", "display:flex;flex-direction:column;gap:12px;");
  #h: ConformHost;
  #d: Draft;
  #problemsEl = el("div", "font-size:12px;color:var(--omp-error);white-space:pre-line;");
  #list = el("div", "display:flex;flex-direction:column;gap:6px;");
  #open = new Set<string>();

  constructor(host: ConformHost, draft: Draft) {
    this.#h = host;
    this.#d = draft;
    this.el.dataset.role = "conform-panel";
    this.#render();
  }

  get draft(): Draft {
    return this.#d;
  }

  setDraft(d: Draft): void {
    this.#d = d;
    this.#render();
  }

  /** Probleme aus der Live-Prüfung (für die Speichern-Taste). */
  problems(): SegProblem[] {
    return validateSegments(this.#d.segments, this.#h.timeline, this.#h.policy, this.#d.usable);
  }

  /** Ein neues Segment aus [in, out) anfügen (z. B. aus den Marken des Players). */
  add(inF: number, outF: number): void {
    this.#d.segments = addSegment(this.#d.segments, inF, outF, "");
    this.#touch(true);
  }

  #touch(structural: boolean): void {
    this.#h.changed();
    this.#h.selectionChanged();
    if (structural) this.#render();
    else this.#renderProblems();
  }

  #tcField(frame: number, onSet: (f: number) => void, title: string): HTMLInputElement {
    const tl = this.#h.timeline;
    const i = el("input", "width:112px;font-family:var(--omp-font-mono);") as HTMLInputElement;
    i.value = timecodeOf(tl, Math.min(frame, tl.durationFrames));
    i.title = title;
    i.disabled = this.#h.readOnly;
    i.addEventListener("change", () => {
      const f = frameForTimecode(tl, i.value);
      if (f === null) {
        i.style.borderColor = "var(--omp-error)";
        return;
      }
      i.style.borderColor = "";
      onSet(f);
      i.value = timecodeOf(tl, f);
    });
    i.addEventListener("keydown", (e) => e.stopPropagation());
    return i;
  }

  #render(): void {
    const h = this.#h;
    const tl = h.timeline;
    const ro = h.readOnly;
    this.el.replaceChildren();
    const btn = (label: string, title: string, fn: () => void, disabled = false): HTMLButtonElement => {
      const b = el("button", "padding:2px 8px;", label);
      b.type = "button";
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", fn);
      return b;
    };

    // ---- Nutzbarer Bereich ----
    const us = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;");
    us.append(el("div", "font-weight:600;margin-bottom:4px;", tt("rv.usable.title")));
    const ur = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center;");
    if (this.#d.usable) {
      const u = this.#d.usable;
      ur.append(
        el("span", "font-size:11px;color:var(--omp-text-dim);", "In"),
        this.#tcField(u.in, (f) => {
          u.in = f;
          this.#touch(false);
        }, tt("rv.in.hint")),
        el("span", "font-size:11px;color:var(--omp-text-dim);", tt("rv.out.excl")),
        this.#tcField(u.out, (f) => {
          u.out = f;
          this.#touch(false);
        }, tt("rv.out.hint")),
        btn("✕", tt("rv.usable.clear"), () => {
          this.#d.usable = null;
          this.#touch(true);
        }, ro),
      );
    } else {
      ur.append(el("span", "color:var(--omp-text-dim);", tt("rv.usable.whole")));
    }
    ur.append(btn(tt("rv.usable.frommarks"), tt("rv.usable.frommarks.hint"), () => {
      const m = h.getMarks();
      if (m.in === null || m.out === null) return;
      this.#d.usable = { in: m.in, out: m.out };
      this.#touch(true);
    }, ro));
    us.append(ur);
    this.el.append(us);

    // ---- Segmente ----
    const sec = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;");
    const head = el("div", "display:flex;align-items:center;gap:8px;margin-bottom:6px;");
    head.append(el("div", "font-weight:600;flex:1;", tt("rv.seg.title", { p0: this.#d.segments.length })));
    head.append(btn("＋ " + tt("rv.seg.add"), tt("rv.seg.add.hint"), () => {
      const m = h.getMarks();
      const f = h.getFrame();
      const a = m.in ?? f;
      const b = m.out ?? Math.min(tl.durationFrames, a + Math.max(1, h.policy.minSegmentFrames));
      this.add(a, Math.max(b, a + Math.max(1, h.policy.minSegmentFrames)));
    }, ro));
    sec.append(head);
    this.#list = el("div", "display:flex;flex-direction:column;gap:6px;");
    this.#d.segments.forEach((s, i) => this.#list.append(this.#segRow(s, i)));
    if (!this.#d.segments.length) this.#list.append(el("div", "color:var(--omp-text-dim);", tt("rv.seg.none")));
    sec.append(this.#list, this.#problemsEl);
    this.el.append(sec);
    this.#renderProblems();

    // ---- Asset-Metadaten ----
    const meta = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;");
    meta.append(el("div", "font-weight:600;", tt("rv.meta.title")));
    meta.append(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("rv.meta.hint")));
    for (const f of h.fields.filter((x) => !x.segment)) meta.append(metaInput(f, this.#d.assetMetadata, () => this.#touch(false), ro));
    this.el.append(meta);
  }

  #segRow(s: Segment, i: number): HTMLElement {
    const h = this.#h;
    const tl = h.timeline;
    const ro = h.readOnly;
    const box = el("div", "border:1px solid var(--omp-border);border-radius:5px;padding:6px 8px;background:var(--omp-surface);");
    box.dataset.role = "segment";
    box.dataset.segIndex = String(i);
    const r1 = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center;");
    const name = el("input", "width:150px;") as HTMLInputElement;
    name.value = s.label;
    name.placeholder = tt("rv.seg.n", { p0: i + 1 });
    name.disabled = ro;
    name.addEventListener("input", () => {
      this.#d.segments = updateSegment(this.#d.segments, s.id, { label: name.value });
      this.#h.changed();
      this.#h.selectionChanged();
    });
    name.addEventListener("keydown", (e) => e.stopPropagation());
    const dur = el("span", "font:11px var(--omp-font-mono);color:var(--omp-text-dim);", `${s.out - s.in} ${tt("rv.frames")}`);
    const inIn = this.#tcField(s.in, (f) => this.#setRange(s.id, { in: f }), tt("rv.in.hint"));
    const outIn = this.#tcField(s.out, (f) => this.#setRange(s.id, { out: f }), tt("rv.out.hint"));
    inIn.dataset.role = "seg-in";
    outIn.dataset.role = "seg-out";
    const b = (label: string, title: string, fn: () => void, dis = false) => {
      const x = el("button", "padding:1px 6px;", label);
      x.type = "button";
      x.title = title;
      x.disabled = dis;
      x.addEventListener("click", fn);
      return x;
    };
    r1.append(
      name, el("span", "font-size:11px;color:var(--omp-text-dim);", "In"), inIn, el("span", "font-size:11px;color:var(--omp-text-dim);", tt("rv.out.excl")), outIn, dur,
      b("◀I", tt("rv.player.gotoin"), () => h.goto(s.in)),
      b("O▶", tt("rv.player.gotoout"), () => h.goto(Math.max(s.in, s.out - 1))),
      b("▶", tt("rv.player.previewrange"), () => h.preview(s.in, s.out)),
      b("◀|I", tt("rv.seg.setin"), () => this.#setRange(s.id, { in: Math.min(h.getFrame(), s.out - 1) }), ro),
      b("O|▶", tt("rv.seg.setout"), () => this.#setRange(s.id, { out: Math.max(h.getFrame() + 1, s.in + 1) }), ro),
      b("↑", tt("rv.seg.up"), () => {
        this.#d.segments = moveSegment(this.#d.segments, s.id, -1);
        this.#touch(true);
      }, ro || i === 0),
      b("↓", tt("rv.seg.down"), () => {
        this.#d.segments = moveSegment(this.#d.segments, s.id, 1);
        this.#touch(true);
      }, ro || i === this.#d.segments.length - 1),
      b("✕", tt("rv.seg.delete"), () => {
        this.#d.segments = removeSegment(this.#d.segments, s.id);
        this.#touch(true);
      }, ro),
    );
    box.append(r1);
    const segFields = h.fields.filter((x) => x.segment);
    const det = el("div", "margin-top:6px;display:flex;flex-direction:column;gap:6px;");
    const desc = el("textarea", "min-height:40px;resize:vertical;width:100%;box-sizing:border-box;") as HTMLTextAreaElement;
    desc.placeholder = tt("rv.seg.desc");
    desc.value = s.description ?? "";
    desc.disabled = ro;
    desc.addEventListener("input", () => {
      this.#d.segments = updateSegment(this.#d.segments, s.id, { description: desc.value });
      this.#h.changed();
    });
    desc.addEventListener("keydown", (e) => e.stopPropagation());
    det.append(desc);
    if (segFields.length) {
      s.metadata = s.metadata ?? {};
      for (const f of segFields) det.append(metaInput(f, s.metadata, () => this.#h.changed(), ro));
    }
    box.append(det);
    return box;
  }

  #setRange(id: string, patch: { in?: number; out?: number }): void {
    this.#d.segments = updateSegment(this.#d.segments, id, patch);
    this.#touch(true);
  }

  #renderProblems(): void {
    const ps = this.problems();
    this.#problemsEl.dataset.role = "seg-problems";
    this.#problemsEl.textContent = ps
      .map((p) => (p.index >= 0 ? `${tt("rv.seg.n", { p0: p.index + 1 })}: ` : "") + tt("rv.seg.err." + p.key, p.params))
      .join("\n");
  }
}
