// Bedienfeld von `omp-audio-matrix` (Kapitel 107.3): Kreuzschiene (Zeilen = Eingangskanäle, Spalten = Ausgangskanäle), Kanal-Labels,
// Ein-/Ausgänge anlegen, Gain, Schnellaktionen. Arbeitet auf einer Entwurfskopie; erst „Speichern“ schreibt `matrix.config` (der Node
// prüft und wendet live an). Layout mit festen Zellgrößen und festen Zeilen für Meldungen, damit nichts springt. Kein confirm/alert:
// Löschen verlangt einen zweiten Klick auf dieselbe Taste.
import {
  addPort, clearOutput, clickCell, clone, combineAll, findRoute, gainText, kindOf, monoToAll, normalize, removePort, renamePort, routeStraight, routesOf,
  sameConfig, setChannel, setChannelCount, setGain, splitInput, SYMBOLS, validate, type MatrixConfig, type Port,
} from "./matrix-logic.ts";

const D: Record<string, Record<string, string>> = {
  de: {
    save: "Speichern", discard: "Verwerfen", dirty: "Ungespeicherte Änderungen", clean: "Gespeichert", saved: "Gespeichert und angewendet.", saveFail: "Speichern fehlgeschlagen: {d}",
    invalid: "Ungültig: {d}", inputs: "Eingänge", outputs: "Ausgänge", addIn: "+ Eingang", addOut: "+ Ausgang", name: "Name", chans: "Kanäle", remove: "Löschen", sure: "Wirklich?",
    labels: "Kanal-Labels", label: "Label", symbol: "Symbol", none: "—", quick: "Schnellaktionen", straight: "1:1", monoAll: "Mono auf alle", splitMono: "In Einzelkanäle teilen",
    splitPairs: "In Paare teilen", combine: "Alle Eingänge zusammensetzen", clearOut: "Ausgang leeren", fromIn: "Eingang", toOut: "Ausgang", inChan: "Kanal", apply: "Anwenden",
    xpoint: "Kreuzpunkt", xHint: "Klick: Kopie (ersetzt andere Quellen) · Strg/Alt-Klick: zusätzliche Quelle (Summe) · Rechtsklick: Kreuzpunkt wählen",
    gain: "Gain (dB)", noPoint: "Kein Kreuzpunkt gewählt.", noRoute: "Hier liegt kein Kreuzpunkt (zuerst setzen).", copy: "Kopie (bitgleich)", mix: "Mischen (Gain/Summe)",
    src: "Quelle", to: "Ziel", live: "Signal", silent: "kein Signal", unconnected: "nicht verbunden", empty: "Noch keine Eingänge oder Ausgänge — mit „+ Eingang“ und „+ Ausgang“ beginnen.",
    senderId: "Sender", flow: "Flow", overs: "Übersteuerungen (Blöcke)", unreachable: "Node nicht erreichbar", limitHint: "Grenzen: 16 Eingänge, 32 Ausgänge, 64 Kanäle, 16 Quellen je Kanal.",
  },
  en: {
    save: "Save", discard: "Discard", dirty: "Unsaved changes", clean: "Saved", saved: "Saved and applied.", saveFail: "Saving failed: {d}",
    invalid: "Invalid: {d}", inputs: "Inputs", outputs: "Outputs", addIn: "+ Input", addOut: "+ Output", name: "Name", chans: "Channels", remove: "Delete", sure: "Sure?",
    labels: "Channel labels", label: "Label", symbol: "Symbol", none: "—", quick: "Quick actions", straight: "1:1", monoAll: "Mono to all", splitMono: "Split into single channels",
    splitPairs: "Split into pairs", combine: "Combine all inputs", clearOut: "Clear output", fromIn: "Input", toOut: "Output", inChan: "Channel", apply: "Apply",
    xpoint: "Crosspoint", xHint: "Click: copy (replaces other sources) · Ctrl/Alt-click: add source (sum) · Right-click: select crosspoint",
    gain: "Gain (dB)", noPoint: "No crosspoint selected.", noRoute: "No crosspoint here (set it first).", copy: "Copy (bit-exact)", mix: "Mix (gain/sum)",
    src: "Source", to: "Target", live: "Signal", silent: "no signal", unconnected: "not connected", empty: "No inputs or outputs yet — start with “+ Input” and “+ Output”.",
    senderId: "Sender", flow: "Flow", overs: "Overloads (blocks)", unreachable: "Node unreachable", limitHint: "Limits: 16 inputs, 32 outputs, 64 channels, 16 sources per channel.",
  },
};
const lang = document.documentElement.lang === "en" ? "en" : "de";
const T = (k: string, p?: Record<string, string>): string => {
  let s = D[lang][k] ?? D.de[k] ?? k;
  if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
  return s;
};

// deno-lint-ignore no-explicit-any
function h(tag: string, attrs?: Record<string, any> | null, ...kids: any[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") (el as HTMLInputElement).value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const STYLE = `
  :host { display: block; position: relative; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; --warn: #d9a02b; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 5px 10px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--acc); border-color: var(--acc); color: #fff; } button.warn { background: var(--err); border-color: var(--err); color: #fff; }
  input, select { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 3px 5px; }
  input.num { width: 64px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
  .msg { height: 20px; line-height: 20px; margin-bottom: 6px; padding: 0 8px; border-radius: 4px; background: var(--bg2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .msg.err { background: var(--err); color: #fff; } .msg.ok { color: var(--ok); } .msg.dirty { color: var(--warn); }
  .mut { color: var(--mut); }
  .box { border: 1px solid var(--bd); border-radius: 6px; background: var(--bg2); padding: 6px 8px; margin-bottom: 8px; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); font-weight: 600; }
  .gridwrap { overflow: auto; max-height: 56vh; border: 1px solid var(--bd); border-radius: 6px; background: var(--bg); margin-bottom: 8px; }
  table.mx { border-collapse: separate; border-spacing: 0; }
  table.mx th, table.mx td { border-right: 1px solid var(--bd); border-bottom: 1px solid var(--bd); padding: 0; text-align: center; }
  table.mx th { background: var(--bg2); font-weight: 600; }
  table.mx thead th { position: sticky; top: 0; z-index: 2; height: 22px; }
  table.mx thead tr.r2 th { top: 22px; font-weight: 400; color: var(--mut); width: 28px; min-width: 28px; max-width: 28px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
  table.mx th.row { position: sticky; left: 0; z-index: 1; width: 150px; min-width: 150px; max-width: 150px; text-align: left; padding: 0 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; height: 22px; font-weight: 400; }
  table.mx th.corner { position: sticky; left: 0; z-index: 3; }
  table.mx th.grp { text-align: left; padding: 0 6px; height: 22px; background: var(--bg3); position: sticky; left: 0; z-index: 1; }
  table.mx th.grp.top { text-align: center; }
  td.c { width: 28px; min-width: 28px; max-width: 28px; height: 22px; cursor: pointer; color: var(--mut); font-size: 10px; overflow: hidden; }
  td.c:hover { background: var(--bg3); }
  td.c.copy { background: #2a4a2c; color: #9fe6a4; } td.c.mix { background: #4a3d1c; color: #f0cf7a; } td.c.sel { outline: 2px solid var(--acc); outline-offset: -2px; }
  td.c.hint { background: #26262b; }
  .chip { display: inline-block; padding: 0 8px; border-radius: 9px; font-size: 10px; background: var(--bg); color: var(--mut); margin-left: 0; min-width: 90px; text-align: center; }
  .chip.live { background: var(--ok); color: #fff; } .chip.silent { background: var(--err); color: #fff; }
  .xp { height: 30px; display: flex; gap: 10px; align-items: center; }
  .port { display: grid; grid-template-columns: 170px 70px 1fr; gap: 6px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--bd); }
  .port input.name { width: 100%; }
  details.chs > summary { cursor: pointer; color: var(--mut); }
  .chrow { display: grid; grid-template-columns: 28px 160px 120px; gap: 6px; align-items: center; padding: 1px 0; }
  .qa { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .qa .grp { display: flex; gap: 4px; align-items: center; padding-right: 10px; border-right: 1px solid var(--bd); }
`;

interface Status {
  inputs: { id: string; connected: boolean; live: boolean; receiverId?: string }[];
  outputs: { id: string; senderId?: string; flowId?: string }[];
  overs: number;
}

class OmpAudioMatrixPanel extends HTMLElement {
  #timers: number[] = [];
  #applied: MatrixConfig = { inputs: [], outputs: [], routes: [] };
  #draft: MatrixConfig = { inputs: [], outputs: [], routes: [] };
  #sel: { out: string; ch: number; in: string; inCh: number } | null = null;
  #status: Status | null = null;
  #armed = "";
  #note: { kind: "ok" | "err"; text: string; until: number } | null = null;
  #qa = { inId: "", outId: "", inCh: 1 };

  #base = "";
  #root!: ShadowRoot;
  #msg!: HTMLElement;
  #body!: HTMLElement;
  #saveBtn!: HTMLButtonElement;
  #discardBtn!: HTMLButtonElement;
  #chips = new Map<string, HTMLElement>();
  #info!: HTMLElement;

  connectedCallback() {
    this.#base = `/api/v1/nodes/${this.getAttribute("node-id")}`;
    this.#root = this.attachShadow({ mode: "open" });
    this.#msg = h("div", { class: "msg" });
    this.#body = h("div");
    this.#info = h("div", { class: "mut", style: "margin-top:4px;height:16px;overflow:hidden;white-space:nowrap" });
    this.#saveBtn = h("button", { class: "primary", onclick: () => void this.#save() }, T("save")) as HTMLButtonElement;
    this.#discardBtn = h("button", { onclick: () => { this.#draft = clone(this.#applied); this.#sel = null; this.#render(); } }, T("discard")) as HTMLButtonElement;
    this.#root.append(
      h("style", {}, STYLE),
      h("div", { class: "bar" }, this.#saveBtn, this.#discardBtn, h("span", { class: "mut" }, T("limitHint"))),
      this.#msg,
      this.#body,
      this.#info,
      h("datalist", { id: "syms" }, SYMBOLS.map((s) => h("option", { value: s }))),
    );
    this.#render();
    void this.#loadConfig(true);
    void this.#loadStatus();
    this.#timers.push(setInterval(() => void this.#loadStatus(), 1000) as unknown as number);
    this.#timers.push(setInterval(() => void this.#loadConfig(false), 3000) as unknown as number);
  }
  disconnectedCallback() {
    for (const t of this.#timers) clearInterval(t);
  }

  async #param(name: string): Promise<string | undefined> {
    const r = await fetch(`${this.#base}/params/${name}`);
    return r.ok ? String((await r.json()).value ?? "") : undefined;
  }

  get #dirty(): boolean {
    return !sameConfig(this.#draft, this.#applied);
  }

  async #loadConfig(force: boolean) {
    try {
      const v = await this.#param("matrix.config");
      if (v === undefined) return;
      const cfg = normalize(v);
      const was = this.#dirty;
      this.#applied = cfg;
      if (force || !was) {
        if (!sameConfig(cfg, this.#draft)) {
          this.#draft = clone(cfg);
          this.#render();
        }
      }
      this.#updateMsg();
    } catch { /* nächster Takt */ }
  }

  async #loadStatus() {
    try {
      const v = await this.#param("matrix.status");
      if (v === undefined) return;
      this.#status = JSON.parse(v) as Status;
      for (const i of this.#status.inputs) {
        const chip = this.#chips.get(i.id);
        if (!chip) continue;
        chip.className = "chip" + (i.live ? " live" : i.connected ? " silent" : "");
        chip.textContent = i.live ? T("live") : i.connected ? T("silent") : T("unconnected");
      }
      this.#info.textContent = `${T("overs")}: ${this.#status.overs}`;
    } catch {
      this.#info.textContent = T("unreachable");
    }
  }

  async #save() {
    const bad = validate(this.#draft);
    if (bad) return this.#flash("err", T("invalid", { d: bad }));
    const r = await fetch(`${this.#base}/params/matrix.config`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: JSON.stringify(this.#draft) }) });
    if (!r.ok) {
      const why = (await this.#param("matrix.error").catch(() => "")) || String(r.status);
      return this.#flash("err", T("saveFail", { d: why }));
    }
    this.#applied = clone(this.#draft);
    this.#flash("ok", T("saved"));
    this.#render();
    setTimeout(() => void this.#loadStatus(), 1500);
  }

  #flash(kind: "ok" | "err", text: string) {
    this.#note = { kind, text, until: Date.now() + 6000 };
    this.#updateMsg();
    setTimeout(() => this.#updateMsg(), 6100);
  }

  #updateMsg() {
    const dirty = this.#dirty;
    this.#saveBtn.disabled = !dirty;
    this.#discardBtn.disabled = !dirty;
    if (this.#note && Date.now() < this.#note.until) {
      this.#msg.className = "msg " + this.#note.kind;
      this.#msg.textContent = this.#note.text;
    } else if (dirty) {
      const bad = validate(this.#draft);
      this.#msg.className = "msg " + (bad ? "err" : "dirty");
      this.#msg.textContent = bad ? T("invalid", { d: bad }) : T("dirty");
    } else {
      this.#msg.className = "msg mut";
      this.#msg.textContent = T("clean");
    }
  }

  #edit(next: MatrixConfig) {
    this.#draft = next;
    this.#armed = "";
    this.#render();
  }

  // ── Darstellung ──────────────────────────────────────────────────────────────────────────────────────────────

  #render() {
    this.#chips.clear();
    const c = this.#draft;
    const empty = c.inputs.length === 0 || c.outputs.length === 0;
    this.#body.replaceChildren(...[
      h("div", { class: "bar" }, h("button", { onclick: () => this.#edit(addPort(c, "in", 2)) }, T("addIn")), h("button", { onclick: () => this.#edit(addPort(c, "out", 2)) }, T("addOut")),
        empty ? h("span", { class: "mut" }, T("empty")) : null),
      empty ? null : this.#grid(),
      empty ? null : this.#crosspoint(),
      this.#quick(),
      this.#ports("in"),
      this.#ports("out"),
    ].filter((x): x is HTMLElement => x !== null));
    this.#updateMsg();
    if (this.#status) void this.#loadStatus();
  }

  #grid(): HTMLElement {
    const c = this.#draft;
    const hdr1 = h("tr", {}, h("th", { class: "corner row", rowspan: 2 }, `${T("src")} ↓ / ${T("to")} →`));
    const hdr2 = h("tr", { class: "r2" });
    for (const o of c.outputs) {
      hdr1.append(h("th", { class: "grp top", colspan: o.channels.length, title: o.name }, o.name));
      o.channels.forEach((ch, i) => hdr2.append(h("th", { title: `${o.name} · ${i + 1} ${ch.label}` }, ch.label || String(i + 1))));
    }
    hdr1.firstElementChild?.setAttribute("class", "corner row");
    const rows: HTMLElement[] = [];
    for (const p of c.inputs) {
      const chip = h("span", { class: "chip" }, T("unconnected"));
      this.#chips.set(p.id, chip);
      rows.push(h("tr", {}, h("th", { class: "grp row", title: p.name }, p.name), h("th", { class: "grp", style: "position:static;text-align:left", colspan: c.outputs.reduce((s, o) => s + o.channels.length, 0) }, chip)));
      p.channels.forEach((ch, ci) => {
        const tr = h("tr", {}, h("th", { class: "row", title: `${p.name} · ${ci + 1} ${ch.label}` }, `${ci + 1} ${ch.label}`));
        for (const o of c.outputs) {
          for (let k = 1; k <= o.channels.length; k++) {
            const r = findRoute(c, o.id, k, p.id, ci + 1);
            const kind = kindOf(c, o.id, k);
            const sel = this.#sel && this.#sel.out === o.id && this.#sel.ch === k && this.#sel.in === p.id && this.#sel.inCh === ci + 1;
            const cls = "c" + (r ? (kind === "copy" ? " copy" : " mix") : kind !== "none" ? " hint" : "") + (sel ? " sel" : "");
            const text = r ? (kind === "copy" ? "●" : r.gainDb ? gainText(r.gainDb) : "Σ") : "";
            tr.append(h("td", {
              class: cls,
              onclick: (e: MouseEvent) => this.#edit(clickCell(this.#draft, o.id, k, p.id, ci + 1, e.ctrlKey || e.altKey || e.metaKey)),
              oncontextmenu: (e: Event) => { e.preventDefault(); this.#sel = { out: o.id, ch: k, in: p.id, inCh: ci + 1 }; this.#render(); },
            }, text));
          }
        }
        rows.push(tr);
      });
    }
    return h("div", {}, h("div", { class: "gridwrap" }, h("table", { class: "mx" }, h("thead", {}, hdr1, hdr2), h("tbody", {}, rows))), h("div", { class: "mut", style: "margin:-4px 0 8px" }, T("xHint")));
  }

  #crosspoint(): HTMLElement {
    const s = this.#sel;
    const c = this.#draft;
    const r = s ? findRoute(c, s.out, s.ch, s.in, s.inCh) : undefined;
    const i = s ? c.inputs.find((p) => p.id === s.in) : undefined;
    const o = s ? c.outputs.find((p) => p.id === s.out) : undefined;
    let body: (HTMLElement | string)[];
    if (!s || !i || !o) body = [h("span", { class: "mut" }, T("noPoint"))];
    else if (!r) body = [`${i.name} · ${s.inCh} → ${o.name} · ${s.ch}`, h("span", { class: "mut" }, T("noRoute"))];
    else {
      const input = h("input", { class: "num", type: "number", step: "0.5", min: "-120", max: "24", value: r.gainDb ?? 0 }) as HTMLInputElement;
      const n = routesOf(c, s.out, s.ch).length;
      body = [`${i.name} · ${s.inCh} → ${o.name} · ${s.ch}`, h("span", { class: "mut" }, T("gain")), input,
        h("button", { onclick: () => this.#edit(setGain(this.#draft, s.out, s.ch, s.in, s.inCh, Number(input.value))) }, T("apply")),
        h("span", { class: "mut" }, kindOf(c, s.out, s.ch) === "copy" ? T("copy") : `${T("mix")}${n > 1 ? ` · ${n} ${T("src")}` : ""}`)];
    }
    return h("div", { class: "box xp" }, h("b", {}, T("xpoint")), ...body);
  }

  #sel2(id: string, items: { id: string; name: string }[], value: string, on: (v: string) => void): HTMLElement {
    const sel = h("select", { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    for (const it of items) sel.append(h("option", { value: it.id, selected: it.id === value }, it.name));
    sel.value = value;
    sel.id = id;
    return sel;
  }

  #quick(): HTMLElement {
    const c = this.#draft;
    if (!c.inputs.length && !c.outputs.length) return h("div");
    const q = this.#qa;
    if (!c.inputs.some((p) => p.id === q.inId)) q.inId = c.inputs[0]?.id ?? "";
    if (!c.outputs.some((p) => p.id === q.outId)) q.outId = c.outputs[0]?.id ?? "";
    const inp = c.inputs.find((p) => p.id === q.inId);
    const chSel = h("select", { onchange: (e: Event) => { q.inCh = Number((e.target as HTMLSelectElement).value); } }) as HTMLSelectElement;
    inp?.channels.forEach((ch, i) => chSel.append(h("option", { value: i + 1 }, `${i + 1} ${ch.label}`)));
    chSel.value = String(Math.min(q.inCh, inp?.channels.length ?? 1));
    const act = (f: () => MatrixConfig) => () => this.#edit(f());
    return h("div", { class: "box" }, h("h4", {}, T("quick")), h("div", { class: "qa" },
      h("span", { class: "grp" }, T("fromIn"), this.#sel2("qin", c.inputs, q.inId, (v) => { q.inId = v; this.#render(); }), T("toOut"), this.#sel2("qout", c.outputs, q.outId, (v) => { q.outId = v; }),
        h("button", { onclick: act(() => routeStraight(this.#draft, q.inId, q.outId)) }, T("straight")),
        h("button", { onclick: act(() => clearOutput(this.#draft, q.outId)) }, T("clearOut"))),
      h("span", { class: "grp" }, T("inChan"), chSel, h("button", { onclick: act(() => monoToAll(this.#draft, q.inId, q.inCh, q.outId)) }, T("monoAll"))),
      h("span", { class: "grp" }, h("button", { onclick: act(() => splitInput(this.#draft, q.inId, 1)) }, T("splitMono")), h("button", { onclick: act(() => splitInput(this.#draft, q.inId, 2)) }, T("splitPairs"))),
      h("button", { onclick: act(() => combineAll(this.#draft)) }, T("combine"))));
  }

  #ports(kind: "in" | "out"): HTMLElement {
    const c = this.#draft;
    const list: Port[] = kind === "in" ? c.inputs : c.outputs;
    const st = this.#status;
    const rows = list.map((p) => {
      const key = `${kind}:${p.id}`;
      const name = h("input", { class: "name", type: "text", maxlength: 40, value: p.name, onchange: (e: Event) => this.#edit(renamePort(this.#draft, kind, p.id, (e.target as HTMLInputElement).value)) });
      const count = h("input", { class: "num", type: "number", min: 1, max: 64, value: p.channels.length, title: T("chans"), onchange: (e: Event) => this.#edit(setChannelCount(this.#draft, kind, p.id, Number((e.target as HTMLInputElement).value))) });
      const del = h("button", { class: this.#armed === key ? "warn" : "", onclick: () => {
        if (this.#armed === key) this.#edit(removePort(this.#draft, kind, p.id));
        else { this.#armed = key; this.#render(); setTimeout(() => { if (this.#armed === key) { this.#armed = ""; this.#render(); } }, 3000); }
      } }, this.#armed === key ? T("sure") : T("remove"));
      const ids = kind === "in" ? st?.inputs.find((x) => x.id === p.id)?.receiverId : st?.outputs.find((x) => x.id === p.id)?.senderId;
      const chs = h("details", { class: "chs" }, h("summary", {}, `${T("labels")} (${p.channels.length})`),
        p.channels.map((ch, i) => h("div", { class: "chrow" }, h("span", { class: "mut" }, i + 1),
          h("input", { type: "text", maxlength: 40, value: ch.label, placeholder: T("label"), onchange: (e: Event) => this.#edit(setChannel(this.#draft, kind, p.id, i + 1, { label: (e.target as HTMLInputElement).value })) }),
          h("input", { type: "text", list: "syms", value: ch.symbol ?? "", placeholder: T("symbol"), onchange: (e: Event) => this.#edit(setChannel(this.#draft, kind, p.id, i + 1, { symbol: (e.target as HTMLInputElement).value.trim() })) }))));
      const open = this.#root?.querySelector?.(`details[data-k="${key}"]`)?.hasAttribute("open");
      chs.setAttribute("data-k", key);
      if (open) chs.setAttribute("open", "");
      return h("div", {}, h("div", { class: "port" }, name, count, h("span", {}, del, ids ? h("span", { class: "mut", style: "margin-left:8px", title: ids }, ` ${kind === "in" ? "Receiver" : T("senderId")} ${ids.slice(0, 8)}`) : null)), chs);
    });
    return h("div", { class: "box" }, h("h4", {}, kind === "in" ? T("inputs") : T("outputs")), ...rows);
  }
}

if (!customElements.get("omp-audio-matrix-panel")) customElements.define("omp-audio-matrix-panel", OmpAudioMatrixPanel);
