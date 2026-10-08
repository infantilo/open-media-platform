// Admin → Audio-Ausgabe (Kapitel 27 / A5, docs/ENTWURF-AUDIO-REGELN.md): ein Editor für das Dokument
// `audio-rules` — Ausgabegruppen, Spurschemata, Zuordnungsvorlagen (Klick-Matrix) und Ersatzregeln.
//
// Bewusst Ganz-Speichern (Nutzerregel „Editoren brauchen ein explizites Speichern“) statt PUT je Klick;
// Eingabefelder ändern nur den Entwurf (kein Neuaufbau, sonst ginge der Fokus verloren), strukturelle
// Schaltflächen (Zeile hinzufügen/löschen) zeichnen neu. Der Server prüft das Dokument erneut und
// liefert Fehler zeilenweise zurück.

import { apiFetch, confirmDialog, t as tt } from "../host.ts";
import {
  type Action, actionKind, type AudioRulesDoc, channelNames, cleanDoc, hasBitExact, joinTags, knownTags, LAYOUTS, type Mapping, monoTracks, moveItem,
  newRule, chainParam, planRows, simulatedSource, type AudioPlan, setChainParam, parseSourceText, parseTags, type Rule, setBitExact, type SourceSpec, sourceText, specSummary, toggleTrack, trackRowCount, type TrackSchema,
  uniqueId, VIA_OPTIONS,
} from "./audio-rules-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
const BOX = "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;margin-bottom:16px;";

function field(label: string, input: HTMLElement, width = ""): HTMLElement {
  const w = el("label", `display:flex;flex-direction:column;gap:2px;${width ? `width:${width};` : ""}`);
  w.append(el("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);", label), input);
  return w;
}

function textInput(value: string, onInput: (v: string) => void, opts: { width?: string; placeholder?: string; list?: string; mono?: boolean } = {}): HTMLInputElement {
  const i = el("input", `padding:3px 6px;${opts.width ? `width:${opts.width};` : ""}${opts.mono ? "font-family:monospace;" : ""}`);
  i.value = value;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  if (opts.list) i.setAttribute("list", opts.list);
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function select(options: [string, string][], value: string, onChange: (v: string) => void, width = ""): HTMLSelectElement {
  const s = el("select", `padding:3px 6px;${width ? `width:${width};` : ""}`);
  for (const [v, t] of options) {
    const o = el("option", "", t);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function button(text: string, onClick: () => void, cls = "", title = ""): HTMLButtonElement {
  const b = el("button", "padding:3px 10px;", text);
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

class AudioRulesView extends HTMLElement {
  #doc: AudioRulesDoc | null = null;
  #dirty = false;
  #error = "";
  #message = "";
  #mappingIdx = 0;
  #schemaIdx = 0;
  #loaded = false;
  #sim = { kind: "schema", count: 8, schemaIdx: 0, mapping: "" };
  #simResult: { plan?: AudioPlan; errors?: string[] } | null = null;

  connectedCallback() {
    this.style.cssText = "display:block;";
    if (this.#loaded) this.#render();
    else {
      this.#loaded = true;
      void this.#load("/api/v1/audio-rules");
    }
  }

  async #load(url: string, markDirty = false) {
    try {
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(String(res.status));
      this.#doc = (await res.json()) as AudioRulesDoc;
      this.#dirty = markDirty;
      this.#error = "";
      this.#mappingIdx = Math.min(this.#mappingIdx, Math.max(0, this.#doc.mappings.length - 1));
      this.#schemaIdx = Math.min(this.#schemaIdx, Math.max(0, this.#doc.trackSchemas.length - 1));
    } catch {
      this.#error = tt("arv.2aeae0");
    }
    this.#render();
  }

  async #save() {
    if (!this.#doc) return;
    this.#message = "";
    try {
      const res = await apiFetch("/api/v1/audio-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanDoc(this.#doc)),
      });
      if (!res.ok) {
        this.#error = (await res.text()) || tt("arv.48b84d", { p0: res.status });
      } else {
        this.#doc = (await res.json()) as AudioRulesDoc;
        this.#dirty = false;
        this.#error = "";
        this.#message = tt("arv.b01c7b");
      }
    } catch {
      this.#error = tt("arv.bbebf9");
    }
    this.#render();
  }

  #touch() {
    this.#dirty = true;
    const bar = this.querySelector<HTMLElement>('[data-role="dirty"]');
    if (bar) bar.style.display = "";
  }

  #render() {
    this.replaceChildren();
    const title = el("div", "", tt("arv.89810d"));
    title.className = "omp-h1";
    this.append(title);
    this.append(el("div", `${DIM}max-width:900px;margin:6px 0 12px;`,
      tt("arv.6fe920") +
        tt("arv.3beb81")));
    if (this.#error) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:8px;white-space:pre-wrap;", this.#error));
    if (this.#message) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:8px;max-width:900px;", this.#message));
    if (!this.#doc) return;

    const bar = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:12px;position:sticky;top:0;z-index:3;padding:6px 0;background:var(--omp-bg);");
    const save = button(tt("arv.b97d23"), () => void this.#save(), "omp-btn-primary");
    const reload = button(tt("arv.878028"), () => void this.#load("/api/v1/audio-rules"));
    const reset = button(tt("arv.79101c"), async () => {
      if (await confirmDialog(tt("arv.4b1885"), { confirmLabel: tt("arv.3a6cf4") })) {
        await this.#load("/api/v1/audio-rules/default", true);
      }
    });
    const dirty = el("span", "color:var(--omp-warn,#b8860b);font-size:12px;", tt("arv.80a9b8"));
    dirty.dataset.role = "dirty";
    dirty.style.display = this.#dirty ? "" : "none";
    bar.append(save, reload, reset, dirty);
    this.append(bar);

    const tags = el("datalist");
    tags.id = "omp-audio-tags";
    for (const t of knownTags(this.#doc)) {
      const o = el("option");
      o.value = t;
      tags.append(o);
    }
    this.append(tags, this.#renderGroups(), this.#renderSchemas(), this.#renderMappings(), this.#renderRules(), this.#renderSimulator());
  }

  // ---- 1. Ausgabegruppen -------------------------------------------------------------------------------
  #renderGroups(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", tt("y.grp1")));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      tt("arv.3c3493")));
    const rows = el("div", "display:flex;flex-direction:column;gap:6px;");
    doc.outputProfile.groups.forEach((g, i) => {
      const row = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);");
      const idIn = textInput(g.id, (v) => { g.id = v; this.#touch(); }, { width: "90px", mono: true });
      const label = textInput(g.label, (v) => { g.label = v; this.#touch(); }, { width: "150px" });
      const layout = select(LAYOUTS, g.layout || "stereo", (v) => { g.layout = v; this.#touch(); this.#render(); }, "120px");
      row.append(field("ID", idIn), field(tt("arv.49ee30"), label), field(tt("arv.ebd9be"), layout));
      if (g.layout === "custom") row.append(field(tt("arv.2a3519"), textInput((g.channels ?? []).join(", "), (v) => { g.channels = parseTags(v); this.#touch(); }, { width: "150px", placeholder: "A, B, C" })));
      else row.append(field(tt("arv.45cef4"), el("span", `${DIM}padding:4px 0;font-size:12px;`, channelNames(g.layout || "stereo", undefined).join(" "))));
      const bit = el("input");
      bit.type = "checkbox";
      bit.checked = hasBitExact(g.tags);
      bit.addEventListener("change", () => { g.tags = setBitExact(g.tags, bit.checked); this.#touch(); this.#render(); });
      const tagIn = textInput(joinTags((g.tags ?? []).filter((t) => t.toLowerCase() !== "bitexact")), (v) => { g.tags = [...parseTags(v), ...(hasBitExact(g.tags) ? ["bitexact"] : [])]; this.#touch(); }, { width: "170px", placeholder: tt("arv.c11819") });
      row.append(field(tt("arv.189f63"), tagIn), field("bit-exakt", bit));
      row.append(field(tt("arv.2cb50e"), textInput(sourceText(g.default), (v) => { g.default = parseSourceText(v); this.#touch(); }, { width: "190px", placeholder: tt("arv.96e76c"), list: "omp-audio-tags", mono: true })));
      const up = button("↑", () => { doc.outputProfile.groups = moveItem(doc.outputProfile.groups, i, -1); this.#touch(); this.#render(); }, "", tt("arv.62196b"));
      const down = button("↓", () => { doc.outputProfile.groups = moveItem(doc.outputProfile.groups, i, 1); this.#touch(); this.#render(); });
      const del = button(tt("arv.1010b0"), async () => {
        if (await confirmDialog(tt("arv.c8ef93", { p0: g.label || g.id }), { confirmLabel: tt("arv.1010b0") })) {
          doc.outputProfile.groups.splice(i, 1);
          this.#touch();
          this.#render();
        }
      }, "omp-btn-danger");
      row.append(up, down, del);
      rows.append(row);
    });
    sec.append(rows);
    sec.append(button(tt("arv.4210f1"), () => {
      const id = uniqueId("gruppe", doc.outputProfile.groups.map((g) => g.id));
      doc.outputProfile.groups.push({ id, label: tt("arv.14466a"), layout: "stereo", tags: [] });
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    return sec;
  }

  // ---- 2. Spurschemata ---------------------------------------------------------------------------------
  #renderSchemas(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", tt("arv.b0eb7a")));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      tt("arv.ede46d")));
    const sel = select(doc.trackSchemas.map((s, i): [string, string] => [String(i), s.id || tt("arv.24941e")]), String(this.#schemaIdx), (v) => { this.#schemaIdx = Number(v); this.#render(); }, "220px");
    const top = el("div", "display:flex;gap:8px;align-items:end;margin-bottom:8px;flex-wrap:wrap;");
    top.append(field(tt("arv.7146a6"), sel));
    top.append(button(tt("y.addSchema"), () => {
      const id = uniqueId("schema", doc.trackSchemas.map((s) => s.id));
      doc.trackSchemas.push({ id, match: { format: "mxf", tracks: 8 }, tracks: monoTracks(8) });
      this.#schemaIdx = doc.trackSchemas.length - 1;
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    sec.append(top);
    const s: TrackSchema | undefined = doc.trackSchemas[this.#schemaIdx];
    if (!s) {
      sec.append(el("div", DIM, tt("arv.b6924a")));
      return sec;
    }
    const head = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:8px;");
    head.append(
      field("ID", textInput(s.id, (v) => { s.id = v; this.#touch(); }, { width: "150px", mono: true })),
      field(tt("arv.7ea53d"), textInput(s.match.format ?? "", (v) => { s.match.format = v; this.#touch(); }, { width: "90px", placeholder: "mxf" })),
      field(tt("arv.f8e47d"), textInput(s.match.tracks ? String(s.match.tracks) : "", (v) => { s.match.tracks = Number(v) || undefined; this.#touch(); }, { width: "70px", placeholder: "8" })),
      field(tt("arv.1c2839"), textInput(s.match.path ?? "", (v) => { s.match.path = v; this.#touch(); }, { width: "190px", placeholder: "/media/orf/*.mxf" })),
    );
    const gen = el("div", "display:flex;gap:6px;align-items:end;");
    const nIn = textInput("8", () => {}, { width: "50px" });
    gen.append(field(tt("arv.454ae2"), nIn), button(tt("arv.0ddc4f"), () => {
      s.tracks = monoTracks(Math.max(1, Math.min(64, Number(nIn.value) || 8)));
      s.match.tracks = s.tracks.length;
      this.#touch();
      this.#render();
    }, "", tt("arv.7ce0af")));
    head.append(gen, button(tt("arv.1a542c"), async () => {
      if (await confirmDialog(tt("arv.a8f9af", { p0: s.id }), { confirmLabel: tt("arv.1010b0") })) {
        doc.trackSchemas.splice(this.#schemaIdx, 1);
        this.#schemaIdx = 0;
        this.#touch();
        this.#render();
      }
    }, "omp-btn-danger"));
    sec.append(head);
    const t = el("table", "border-collapse:collapse;font-size:12px;");
    const hr = el("tr", `${DIM}text-align:left;`);
    for (const h of [tt("arv.f3ad21"), tt("arv.ebd9be"), tt("arv.189f63"), ""]) hr.append(el("th", "padding:2px 12px 2px 0;font-weight:500;", h));
    t.append(hr);
    s.tracks.forEach((tr, i) => {
      const r = el("tr", "border-top:1px solid rgba(255,255,255,.06);");
      const cell = (child: HTMLElement) => { const c = el("td", "padding:2px 12px 2px 0;"); c.append(child); return c; };
      const n = textInput(String(tr.n), (v) => { tr.n = Number(v) || 0; this.#touch(); }, { width: "50px" });
      r.append(cell(n),
        cell(select(LAYOUTS.filter(([v]) => v !== "custom"), tr.layout || "mono", (v) => { tr.layout = v; this.#touch(); }, "90px")),
        cell(textInput(joinTags(tr.tags), (v) => { tr.tags = parseTags(v); this.#touch(); }, { width: "330px", list: "omp-audio-tags", placeholder: tt("arv.d4cbc0") })),
        cell(button("✕", () => { s.tracks.splice(i, 1); this.#touch(); this.#render(); }, "omp-btn-danger", tt("arv.e9da74"))));
      t.append(r);
    });
    sec.append(t, button(tt("y.addTrk"), () => {
      s.tracks.push({ n: Math.max(0, ...s.tracks.map((x) => x.n)) + 1, layout: "mono", tags: [] });
      this.#touch();
      this.#render();
    }));
    sec.append(el("div", `${DIM}font-size:11px;margin-top:6px;`, tt("arv.6c0730")));
    return sec;
  }

  // ---- 3. Zuordnungsvorlagen ----------------------------------------------------------------------------
  #renderMappings(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", tt("arv.a931ff")));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      tt("arv.086094") +
        tt("arv.6e1177")));
    const sel = select(doc.mappings.map((m, i): [string, string] => [String(i), m.label || m.id]), String(this.#mappingIdx), (v) => { this.#mappingIdx = Number(v); this.#render(); }, "260px");
    const top = el("div", "display:flex;gap:8px;align-items:end;margin-bottom:8px;flex-wrap:wrap;");
    top.append(field(tt("arv.07411f"), sel));
    top.append(button(tt("arv.548828"), () => {
      const id = uniqueId("vorlage", doc.mappings.map((m) => m.id));
      doc.mappings.push({ id, label: tt("arv.d96362"), groups: {} });
      this.#mappingIdx = doc.mappings.length - 1;
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    const cur: Mapping | undefined = doc.mappings[this.#mappingIdx];
    if (cur) {
      top.append(button(tt("arv.529fdd"), () => {
        const copy: Mapping = JSON.parse(JSON.stringify(cur));
        copy.id = uniqueId(cur.id, doc.mappings.map((m) => m.id));
        copy.label = tt("y.copy", { p0: cur.label || cur.id });
        doc.mappings.push(copy);
        this.#mappingIdx = doc.mappings.length - 1;
        this.#touch();
        this.#render();
      }), button(tt("arv.1010b0"), async () => {
        if (await confirmDialog(tt("arv.903235", { p0: cur.label || cur.id }), { confirmLabel: tt("arv.1010b0") })) {
          doc.mappings.splice(this.#mappingIdx, 1);
          this.#mappingIdx = 0;
          this.#touch();
          this.#render();
        }
      }, "omp-btn-danger"));
    }
    sec.append(top);
    if (!cur) {
      sec.append(el("div", DIM, tt("arv.587ad1")));
      return sec;
    }
    sec.append(el("div", "display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;"));
    (sec.lastChild as HTMLElement).append(
      field("ID", textInput(cur.id, (v) => { cur.id = v; this.#touch(); }, { width: "190px", mono: true })),
      field(tt("arv.49ee30"), textInput(cur.label ?? "", (v) => { cur.label = v; this.#touch(); }, { width: "230px" })),
    );
    const schemaTracks = Math.max(0, ...doc.trackSchemas.map((s) => s.tracks.length));
    const rowsN = trackRowCount(schemaTracks, cur);
    for (const g of doc.outputProfile.groups) sec.append(this.#renderGroupMapping(cur, g.id, g.label || g.id, channelNames(g.layout || "stereo", g.channels), rowsN));
    return sec;
  }

  #renderGroupMapping(m: Mapping, gid: string, label: string, chans: string[], rowsN: number): HTMLElement {
    const box = el("div", "border-top:1px solid rgba(255,255,255,.06);padding:8px 0;");
    const spec: SourceSpec | undefined = m.groups[gid];
    const useTags = !!spec && spec.select !== undefined && !spec.tracks;
    const head = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;");
    head.append(el("b", "min-width:130px;", label), el("span", `${DIM}font-size:12px;`, specSummary(spec)));
    const mode = select([["none", tt("arv.42ca29")], ["tracks", tt("arv.4b525f")], ["select", tt("arv.92a9de")]], !spec ? "none" : useTags ? "select" : "tracks", (v) => {
      if (v === "none") delete m.groups[gid];
      else if (v === "tracks") m.groups[gid] = { tracks: Array(chans.length).fill(0), ...(spec?.via ? { via: spec.via } : {}) };
      else m.groups[gid] = { select: "", ...(spec?.via ? { via: spec.via } : {}) };
      this.#touch();
      this.#render();
    }, "230px");
    head.append(mode);
    if (spec) head.append(select(VIA_OPTIONS, spec.via ?? "", (v) => { spec.via = v || undefined; this.#touch(); this.#render(); }, "260px"), ...this.#processingFields(spec));
    box.append(head);
    if (spec && useTags) {
      box.append(textInput(spec.select ?? "", (v) => { spec.select = v; this.#touch(); }, { width: "420px", list: "omp-audio-tags", placeholder: tt("arv.963ece"), mono: true }));
    } else if (spec) {
      const t = el("table", "border-collapse:collapse;font-size:12px;");
      const hr = el("tr");
      hr.append(el("th", `${DIM}padding:1px 8px;font-weight:500;text-align:left;`, tt("arv.16bad1")));
      chans.forEach((c) => hr.append(el("th", `${DIM}padding:1px 6px;font-weight:600;`, c)));
      t.append(hr);
      for (let n = 1; n <= rowsN; n++) {
        const tr = el("tr");
        tr.append(el("td", `${DIM}padding:1px 8px;`, tt("arv.d8b559", { p0: n })));
        chans.forEach((_, c) => {
          const on = spec.tracks?.[c] === n;
          const cellBtn = el("button", `width:26px;height:20px;padding:0;border-radius:4px;border:1px solid var(--omp-border);${on ? "background:var(--omp-accent-cyan,#19d3f3);" : "background:transparent;"}`, on ? "●" : "");
          cellBtn.title = on ? tt("arv.7aef65") : tt("arv.67c872", { p0: n, p1: chans[c] });
          cellBtn.addEventListener("click", () => {
            m.groups[gid] = toggleTrack(spec, c, n, chans.length);
            this.#touch();
            this.#render();
          });
          const td = el("td", "padding:1px 4px;text-align:center;");
          td.append(cellBtn);
          tr.append(td);
        });
        t.append(tr);
      }
      box.append(t);
    }
    return box;
  }

  // ---- 5. Testwerkzeug ----------------------------------------------------------------------------------
  #renderSimulator(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", tt("arv.39dd5c")));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      tt("arv.a7c551")));
    const kinds: [string, string][] = [
      ["schema", tt("arv.411d64")], ["mono-n", tt("arv.eb8fde")],
      ["live-stereo", tt("arv.c81a61")], ["live-mono", tt("arv.81b210")], ["live-51", tt("arv.2ed0b4")],
    ];
    const row = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:8px;");
    row.append(field(tt("arv.d3402e"), select(kinds, this.#sim.kind, (v) => { this.#sim.kind = v; this.#render(); }, "270px")));
    if (this.#sim.kind === "schema") {
      row.append(field(tt("arv.7146a6"), select(doc.trackSchemas.map((s, i): [string, string] => [String(i), s.id]), String(this.#sim.schemaIdx), (v) => { this.#sim.schemaIdx = Number(v); }, "180px")));
    }
    if (this.#sim.kind === "mono-n") row.append(field(tt("arv.a313d8"), textInput(String(this.#sim.count), (v) => { this.#sim.count = Number(v) || 1; }, { width: "60px" })));
    row.append(field(tt("arv.f605ec"), select([["", tt("arv.a29835")], ...doc.mappings.map((m): [string, string] => [m.id, m.label || m.id])], this.#sim.mapping, (v) => { this.#sim.mapping = v; }, "260px")));
    row.append(button(tt("arv.8d5015"), () => void this.#simulate(), "omp-btn-primary"));
    sec.append(row);
    const out = el("div", "font-size:13px;");
    const r = this.#simResult;
    if (r?.errors) for (const e of r.errors) out.append(el("div", "color:var(--omp-danger,#d33);", e));
    if (r?.plan) {
      const label = (id: string) => doc.outputProfile.groups.find((g) => g.id === id)?.label || id;
      const colors = { ok: "", rule: "color:var(--omp-warn,#b8860b);", silent: `${DIM}`, failed: "color:var(--omp-danger,#d33);" };
      for (const pr of planRows(r.plan, label)) {
        const line = el("div", `padding:2px 0;${colors[pr.tone]}`);
        line.append(el("b", "display:inline-block;min-width:150px;", pr.label), document.createTextNode(pr.text));
        out.append(line);
      }
      for (const w of r.plan.warnings) out.append(el("div", "color:var(--omp-warn,#b8860b);padding-top:2px;", `⚠ ${w}`));
    }
    sec.append(out);
    return sec;
  }

  async #simulate() {
    const doc = this.#doc;
    if (!doc) return;
    const source = simulatedSource(this.#sim.kind, this.#sim.count, doc.trackSchemas[this.#sim.schemaIdx]);
    try {
      const res = await apiFetch("/api/v1/audio-rules/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: cleanDoc(doc), source, mapping: this.#sim.mapping || null }),
      });
      if (!res.ok) this.#simResult = { errors: [(await res.text()) || tt("arv.435a5a", { p0: res.status })] };
      else this.#simResult = (await res.json()) as { plan?: AudioPlan; errors?: string[] } & AudioPlan;
      if (this.#simResult && !("errors" in this.#simResult) && "groups" in this.#simResult) this.#simResult = { plan: this.#simResult as unknown as AudioPlan };
    } catch {
      this.#simResult = { errors: [tt("arv.bcb198")] };
    }
    this.#render();
  }

  /** Eingabefelder für die ausführbaren Verarbeitungsschritte Gain (dB) und Delay (ms) einer Quellvorgabe. */
  #processingFields(spec: SourceSpec): HTMLElement[] {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(",", ".")));
    return [
      field(tt("arv.d47ceb"), textInput(String(chainParam(spec, "gain", "db") ?? ""), (v) => { setChainParam(spec, "gain", "db", num(v)); this.#touch(); }, { width: "70px", placeholder: "0" })),
      field(tt("arv.b8ec21"), textInput(String(chainParam(spec, "loudness", "target") ?? ""), (v) => { setChainParam(spec, "loudness", "target", num(v)); this.#touch(); }, { width: "90px", placeholder: tt("arv.e2d832") })),
      field(tt("arv.712a42"), textInput(String(chainParam(spec, "delay", "ms") ?? ""), (v) => { setChainParam(spec, "delay", "ms", num(v)); this.#touch(); }, { width: "90px", placeholder: "0" })),
    ];
  }

  // ---- 4. Ersatzregeln ----------------------------------------------------------------------------------
  #renderRules(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", tt("arv.411cb2")));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      tt("arv.dbbcd0") +
        tt("arv.e44c07")));
    const groupOpts: [string, string][] = [["*", tt("arv.d893b7")], ...doc.outputProfile.groups.map((g): [string, string] => [g.id, g.label || g.id])];
    doc.ruleSet.rules.forEach((r, i) => sec.append(this.#renderRule(r, i, groupOpts)));
    sec.append(button(tt("y.addRule"), () => {
      doc.ruleSet.rules.push(newRule(doc.outputProfile.groups[0]?.id ?? "*"));
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    return sec;
  }

  #renderRule(r: Rule, i: number, groupOpts: [string, string][]): HTMLElement {
    const doc = this.#doc!;
    const box = el("div", "border-top:1px solid rgba(255,255,255,.06);padding:8px 0;");
    const head = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;");
    head.append(
      field(tt("arv.49ee30"), textInput(r.id ?? "", (v) => { r.id = v; this.#touch(); }, { width: "150px", mono: true, placeholder: tt("arv.055cf7") })),
      field(tt("arv.74ae9f"), select(groupOpts, r.group, (v) => { r.group = v; this.#touch(); }, "170px")),
      field(tt("arv.dc543e"), textInput(r.when.missing ?? "", (v) => { r.when.missing = v; this.#touch(); }, { width: "190px", list: "omp-audio-tags", mono: true, placeholder: tt("arv.f2a548") })),
      field(tt("arv.c383bc"), textInput(r.when.has ?? "", (v) => { r.when.has = v; this.#touch(); }, { width: "190px", list: "omp-audio-tags", mono: true, placeholder: tt("arv.f2a548") })),
      field(tt("arv.d3402e"), select([["", tt("arv.56d062")], ["file", tt("arv.3b74f9")], ["live", tt("arv.f71b32")]], r.when.source ?? "", (v) => { r.when.source = v || undefined; this.#touch(); }, "130px")),
      button("↑", () => { doc.ruleSet.rules = moveItem(doc.ruleSet.rules, i, -1); this.#touch(); this.#render(); }, "", tt("arv.120646")),
      button("↓", () => { doc.ruleSet.rules = moveItem(doc.ruleSet.rules, i, 1); this.#touch(); this.#render(); }),
      button(tt("arv.3bf75c"), () => { doc.ruleSet.rules.splice(i, 1); this.#touch(); this.#render(); }, "omp-btn-danger"),
    );
    box.append(head);
    const acts = el("div", "margin:6px 0 0 14px;display:flex;flex-direction:column;gap:5px;");
    r.then.forEach((a, ai) => acts.append(this.#renderAction(r, a, ai)));
    acts.append(button(tt("arv.fdc6bc"), () => { r.then.push({ use: { select: "" } }); this.#touch(); this.#render(); }));
    box.append(acts);
    return box;
  }

  #renderAction(r: Rule, a: Action, ai: number): HTMLElement {
    const row = el("div", "display:flex;gap:8px;align-items:end;flex-wrap:wrap;");
    row.append(el("span", `${DIM}font-size:12px;align-self:center;min-width:42px;`, ai === 0 ? "dann" : "sonst"));
    const kind = select([["use", tt("arv.7e2d2d")], ["silence", tt("arv.a0a083")], ["fail", tt("arv.a784f7")]], actionKind(a), (v) => {
      delete a.use; delete a.silence; delete a.fail;
      if (v === "use") a.use = { select: "" };
      else if (v === "silence") a.silence = true;
      else a.fail = true;
      this.#touch();
      this.#render();
    }, "210px");
    row.append(kind);
    if (a.use) {
      const u = a.use;
      row.append(
        field(tt("arv.5b3013"), textInput(u.select ?? "", (v) => { u.select = v; this.#touch(); }, { width: "260px", list: "omp-audio-tags", mono: true, placeholder: tt("arv.dae4ad") })),
        field(tt("arv.860828"), select(VIA_OPTIONS, u.via ?? "", (v) => { u.via = v || undefined; this.#touch(); }, "250px")),
        ...this.#processingFields(u),
      );
    }
    row.append(field(tt("arv.987451"), textInput(a.warn ?? "", (v) => { a.warn = v; this.#touch(); }, { width: "220px", placeholder: tt("arv.38ed45") })),
      button("✕", () => { r.then.splice(ai, 1); this.#touch(); this.#render(); }, "omp-btn-danger", tt("arv.7c58e1")));
    return row;
  }
}

customElements.define("omp-audio-rules", AudioRulesView);
