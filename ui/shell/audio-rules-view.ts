// Admin → Audio-Ausgabe (Kapitel 27 / A5, docs/ENTWURF-AUDIO-REGELN.md): ein Editor für das Dokument
// `audio-rules` — Ausgabegruppen, Spurschemata, Zuordnungsvorlagen (Klick-Matrix) und Ersatzregeln.
//
// Bewusst Ganz-Speichern (Nutzerregel „Editoren brauchen ein explizites Speichern“) statt PUT je Klick;
// Eingabefelder ändern nur den Entwurf (kein Neuaufbau, sonst ginge der Fokus verloren), strukturelle
// Schaltflächen (Zeile hinzufügen/löschen) zeichnen neu. Der Server prüft das Dokument erneut und
// liefert Fehler zeilenweise zurück.

import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
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
      this.#error = "Audio-Einstellungen konnten nicht geladen werden.";
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
        this.#error = (await res.text()) || `Speichern fehlgeschlagen (${res.status})`;
      } else {
        this.#doc = (await res.json()) as AudioRulesDoc;
        this.#dirty = false;
        this.#error = "";
        this.#message = "Gespeichert. Neue oder geänderte Ausgabegruppen wirken nach einem Neustart der Player-Instanzen; Vorlagen und Regeln gelten ab dem nächsten Laden eines Events nach dem Neustart der Instanz.";
      }
    } catch {
      this.#error = "Speichern fehlgeschlagen (keine Verbindung).";
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
    const title = el("div", "", "Audio-Ausgabe");
    title.className = "omp-h1";
    this.append(title);
    this.append(el("div", `${DIM}max-width:900px;margin:6px 0 12px;`,
      "Hier legst du fest, welche Audio-Ausgänge die Player erzeugen (Ausgabegruppen), was die Spuren einer Quelle bedeuten (Spurschemata), " +
        "welche Spuren in welche Gruppe gehen (Vorlagen, pro Event wählbar) und was passiert, wenn eine Spur fehlt (Ersatzregeln)."));
    if (this.#error) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:8px;white-space:pre-wrap;", this.#error));
    if (this.#message) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:8px;max-width:900px;", this.#message));
    if (!this.#doc) return;

    const bar = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:12px;position:sticky;top:0;z-index:3;padding:6px 0;background:var(--omp-bg);");
    const save = button("Speichern", () => void this.#save(), "omp-btn-primary");
    const reload = button("Verwerfen / neu laden", () => void this.#load("/api/v1/audio-rules"));
    const reset = button("Auf Standard zurücksetzen", async () => {
      if (await confirmDialog("Alle Gruppen, Schemata, Vorlagen und Regeln im Editor durch die Standardwerte ersetzen? (Erst „Speichern“ übernimmt sie.)", { confirmLabel: "Ersetzen" })) {
        await this.#load("/api/v1/audio-rules/default", true);
      }
    });
    const dirty = el("span", "color:var(--omp-warn,#b8860b);font-size:12px;", "● ungespeicherte Änderungen");
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
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "1 · Ausgabegruppen"));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      "Jede Gruppe wird ein eigener Audio-Sender der Player (z. B. Programmton, Hörfilm, 5.1). Tags helfen dem Mischer beim Finden; „bit-exakt“ erlaubt nur reine 1:1-Auswahl (Dolby E)."));
    const rows = el("div", "display:flex;flex-direction:column;gap:6px;");
    doc.outputProfile.groups.forEach((g, i) => {
      const row = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);");
      const idIn = textInput(g.id, (v) => { g.id = v; this.#touch(); }, { width: "90px", mono: true });
      const label = textInput(g.label, (v) => { g.label = v; this.#touch(); }, { width: "150px" });
      const layout = select(LAYOUTS, g.layout || "stereo", (v) => { g.layout = v; this.#touch(); this.#render(); }, "120px");
      row.append(field("ID", idIn), field("Name", label), field("Layout", layout));
      if (g.layout === "custom") row.append(field("Kanalnamen", textInput((g.channels ?? []).join(", "), (v) => { g.channels = parseTags(v); this.#touch(); }, { width: "150px", placeholder: "A, B, C" })));
      else row.append(field("Kanäle", el("span", `${DIM}padding:4px 0;font-size:12px;`, channelNames(g.layout || "stereo", undefined).join(" "))));
      const bit = el("input");
      bit.type = "checkbox";
      bit.checked = hasBitExact(g.tags);
      bit.addEventListener("change", () => { g.tags = setBitExact(g.tags, bit.checked); this.#touch(); this.#render(); });
      const tagIn = textInput(joinTags((g.tags ?? []).filter((t) => t.toLowerCase() !== "bitexact")), (v) => { g.tags = [...parseTags(v), ...(hasBitExact(g.tags) ? ["bitexact"] : [])]; this.#touch(); }, { width: "170px", placeholder: "role:pt, lang:de" });
      row.append(field("Tags", tagIn), field("bit-exakt", bit));
      row.append(field("Vorgabe ohne Zuordnung", textInput(sourceText(g.default), (v) => { g.default = parseSourceText(v); this.#touch(); }, { width: "190px", placeholder: "Spuren (1, 2) oder Tag-Ausdruck", list: "omp-audio-tags", mono: true })));
      const up = button("↑", () => { doc.outputProfile.groups = moveItem(doc.outputProfile.groups, i, -1); this.#touch(); this.#render(); }, "", "Nach oben (die erste Gruppe behält den Sendernamen „… Audio“)");
      const down = button("↓", () => { doc.outputProfile.groups = moveItem(doc.outputProfile.groups, i, 1); this.#touch(); this.#render(); });
      const del = button("Löschen", async () => {
        if (await confirmDialog(`Gruppe „${g.label || g.id}“ löschen? Vorlagen und Regeln, die sie nennen, werden beim Speichern abgelehnt, bis sie bereinigt sind.`, { confirmLabel: "Löschen" })) {
          doc.outputProfile.groups.splice(i, 1);
          this.#touch();
          this.#render();
        }
      }, "omp-btn-danger");
      row.append(up, down, del);
      rows.append(row);
    });
    sec.append(rows);
    sec.append(button("+ Gruppe", () => {
      const id = uniqueId("gruppe", doc.outputProfile.groups.map((g) => g.id));
      doc.outputProfile.groups.push({ id, label: "Neue Gruppe", layout: "stereo", tags: [] });
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    return sec;
  }

  // ---- 2. Spurschemata ---------------------------------------------------------------------------------
  #renderSchemas(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "2 · Spurschemata (was die Spuren einer Quelle bedeuten)"));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      "Das passende Schema wird je Datei automatisch nach Format, Spurzahl und Dateipfad gewählt (das genauere gewinnt). Tags beschreiben die Spur, z. B. role:pt oder lang:de."));
    const sel = select(doc.trackSchemas.map((s, i): [string, string] => [String(i), s.id || "(ohne ID)"]), String(this.#schemaIdx), (v) => { this.#schemaIdx = Number(v); this.#render(); }, "220px");
    const top = el("div", "display:flex;gap:8px;align-items:end;margin-bottom:8px;flex-wrap:wrap;");
    top.append(field("Schema", sel));
    top.append(button("+ Schema", () => {
      const id = uniqueId("schema", doc.trackSchemas.map((s) => s.id));
      doc.trackSchemas.push({ id, match: { format: "mxf", tracks: 8 }, tracks: monoTracks(8) });
      this.#schemaIdx = doc.trackSchemas.length - 1;
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    sec.append(top);
    const s: TrackSchema | undefined = doc.trackSchemas[this.#schemaIdx];
    if (!s) {
      sec.append(el("div", DIM, "Noch kein Schema. Ohne Schema gelten Mehrspur-Dateien als N Mono-Spuren mit den Tags pos:1…N."));
      return sec;
    }
    const head = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:8px;");
    head.append(
      field("ID", textInput(s.id, (v) => { s.id = v; this.#touch(); }, { width: "150px", mono: true })),
      field("Format (Datei)", textInput(s.match.format ?? "", (v) => { s.match.format = v; this.#touch(); }, { width: "90px", placeholder: "mxf" })),
      field("Spurzahl", textInput(s.match.tracks ? String(s.match.tracks) : "", (v) => { s.match.tracks = Number(v) || undefined; this.#touch(); }, { width: "70px", placeholder: "8" })),
      field("Pfadmuster", textInput(s.match.path ?? "", (v) => { s.match.path = v; this.#touch(); }, { width: "190px", placeholder: "/media/orf/*.mxf" })),
    );
    const gen = el("div", "display:flex;gap:6px;align-items:end;");
    const nIn = textInput("8", () => {}, { width: "50px" });
    gen.append(field("Spuren erzeugen", nIn), button("Als Mono-Spuren", () => {
      s.tracks = monoTracks(Math.max(1, Math.min(64, Number(nIn.value) || 8)));
      s.match.tracks = s.tracks.length;
      this.#touch();
      this.#render();
    }, "", "Ersetzt die Spurliste durch N Mono-Spuren mit den Tags pos:1…N"));
    head.append(gen, button("Schema löschen", async () => {
      if (await confirmDialog(`Schema „${s.id}“ löschen?`, { confirmLabel: "Löschen" })) {
        doc.trackSchemas.splice(this.#schemaIdx, 1);
        this.#schemaIdx = 0;
        this.#touch();
        this.#render();
      }
    }, "omp-btn-danger"));
    sec.append(head);
    const t = el("table", "border-collapse:collapse;font-size:12px;");
    const hr = el("tr", `${DIM}text-align:left;`);
    for (const h of ["Spur", "Layout", "Tags", ""]) hr.append(el("th", "padding:2px 12px 2px 0;font-weight:500;", h));
    t.append(hr);
    s.tracks.forEach((tr, i) => {
      const r = el("tr", "border-top:1px solid rgba(255,255,255,.06);");
      const cell = (child: HTMLElement) => { const c = el("td", "padding:2px 12px 2px 0;"); c.append(child); return c; };
      const n = textInput(String(tr.n), (v) => { tr.n = Number(v) || 0; this.#touch(); }, { width: "50px" });
      r.append(cell(n),
        cell(select(LAYOUTS.filter(([v]) => v !== "custom"), tr.layout || "mono", (v) => { tr.layout = v; this.#touch(); }, "90px")),
        cell(textInput(joinTags(tr.tags), (v) => { tr.tags = parseTags(v); this.#touch(); }, { width: "330px", list: "omp-audio-tags", placeholder: "role:pt, lang:de, ch:L" })),
        cell(button("✕", () => { s.tracks.splice(i, 1); this.#touch(); this.#render(); }, "omp-btn-danger", "Spur entfernen")));
      t.append(r);
    });
    sec.append(t, button("+ Spur", () => {
      s.tracks.push({ n: Math.max(0, ...s.tracks.map((x) => x.n)) + 1, layout: "mono", tags: [] });
      this.#touch();
      this.#render();
    }));
    sec.append(el("div", `${DIM}font-size:11px;margin-top:6px;`, "Tipp: Ein Tag ch:L / ch:R / ch:C … weist einer Spur einen Zielkanal zu — damit gilt der Name statt der Reihenfolge, wenn eine Gruppe per Tag-Ausdruck gewählt wird."));
    return sec;
  }

  // ---- 3. Zuordnungsvorlagen ----------------------------------------------------------------------------
  #renderMappings(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "3 · Zuordnungsvorlagen (welche Spuren in welche Gruppe)"));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      "Pro Event wählbar. Zeilen sind Quellspuren, Spalten die Kanäle der Ausgabegruppe — ein Klick weist die Spur dem Kanal zu, ein zweiter Klick macht den Kanal still. " +
        "Alternativ per Tag-Ausdruck („Tags statt Spuren“). Gruppen ohne Eintrag werden von den Ersatzregeln bedient."));
    const sel = select(doc.mappings.map((m, i): [string, string] => [String(i), m.label || m.id]), String(this.#mappingIdx), (v) => { this.#mappingIdx = Number(v); this.#render(); }, "260px");
    const top = el("div", "display:flex;gap:8px;align-items:end;margin-bottom:8px;flex-wrap:wrap;");
    top.append(field("Vorlage", sel));
    top.append(button("+ Neue Vorlage", () => {
      const id = uniqueId("vorlage", doc.mappings.map((m) => m.id));
      doc.mappings.push({ id, label: "Neue Vorlage", groups: {} });
      this.#mappingIdx = doc.mappings.length - 1;
      this.#touch();
      this.#render();
    }, "omp-btn-primary"));
    const cur: Mapping | undefined = doc.mappings[this.#mappingIdx];
    if (cur) {
      top.append(button("Duplizieren", () => {
        const copy: Mapping = JSON.parse(JSON.stringify(cur));
        copy.id = uniqueId(cur.id, doc.mappings.map((m) => m.id));
        copy.label = `${cur.label || cur.id} (Kopie)`;
        doc.mappings.push(copy);
        this.#mappingIdx = doc.mappings.length - 1;
        this.#touch();
        this.#render();
      }), button("Löschen", async () => {
        if (await confirmDialog(`Vorlage „${cur.label || cur.id}“ löschen? Events, die sie nennen, fallen auf den Standard zurück.`, { confirmLabel: "Löschen" })) {
          doc.mappings.splice(this.#mappingIdx, 1);
          this.#mappingIdx = 0;
          this.#touch();
          this.#render();
        }
      }, "omp-btn-danger"));
    }
    sec.append(top);
    if (!cur) {
      sec.append(el("div", DIM, "Noch keine Vorlage."));
      return sec;
    }
    sec.append(el("div", "display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;"));
    (sec.lastChild as HTMLElement).append(
      field("ID", textInput(cur.id, (v) => { cur.id = v; this.#touch(); }, { width: "190px", mono: true })),
      field("Name", textInput(cur.label ?? "", (v) => { cur.label = v; this.#touch(); }, { width: "230px" })),
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
    const mode = select([["none", "nicht belegt (Regeln / Vorgabe)"], ["tracks", "Spuren (Matrix)"], ["select", "Tags statt Spuren"]], !spec ? "none" : useTags ? "select" : "tracks", (v) => {
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
      box.append(textInput(spec.select ?? "", (v) => { spec.select = v; this.#touch(); }, { width: "420px", list: "omp-audio-tags", placeholder: "z. B. role:ad AND layout:stereo", mono: true }));
    } else if (spec) {
      const t = el("table", "border-collapse:collapse;font-size:12px;");
      const hr = el("tr");
      hr.append(el("th", `${DIM}padding:1px 8px;font-weight:500;text-align:left;`, "Spur \\ Kanal"));
      chans.forEach((c) => hr.append(el("th", `${DIM}padding:1px 6px;font-weight:600;`, c)));
      t.append(hr);
      for (let n = 1; n <= rowsN; n++) {
        const tr = el("tr");
        tr.append(el("td", `${DIM}padding:1px 8px;`, `Spur ${n}`));
        chans.forEach((_, c) => {
          const on = spec.tracks?.[c] === n;
          const cellBtn = el("button", `width:26px;height:20px;padding:0;border-radius:4px;border:1px solid var(--omp-border);${on ? "background:var(--omp-accent-cyan,#19d3f3);" : "background:transparent;"}`, on ? "●" : "");
          cellBtn.title = on ? "Klick: Kanal still schalten" : `Spur ${n} → ${chans[c]}`;
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
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "5 · Testen (Quelle simulieren)"));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      "Rechnet mit dem Entwurf, der oben im Editor steht (auch ungespeichert), und zeigt, was mit einer Quelle passieren würde — ohne Medien. Dieselbe Logik wie in den Playern."));
    const kinds: [string, string][] = [
      ["schema", "Datei laut Spurschema"], ["mono-n", "Datei mit N Mono-Spuren (ohne Schema)"],
      ["live-stereo", "Live: Stereo-Programmton"], ["live-mono", "Live: Mono-Programmton"], ["live-51", "Live: 5.1-Programmton"],
    ];
    const row = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:8px;");
    row.append(field("Quelle", select(kinds, this.#sim.kind, (v) => { this.#sim.kind = v; this.#render(); }, "270px")));
    if (this.#sim.kind === "schema") {
      row.append(field("Schema", select(doc.trackSchemas.map((s, i): [string, string] => [String(i), s.id]), String(this.#sim.schemaIdx), (v) => { this.#sim.schemaIdx = Number(v); }, "180px")));
    }
    if (this.#sim.kind === "mono-n") row.append(field("Spuren", textInput(String(this.#sim.count), (v) => { this.#sim.count = Number(v) || 1; }, { width: "60px" })));
    row.append(field("Zuordnung", select([["", "keine (Vorgaben/Regeln)"], ...doc.mappings.map((m): [string, string] => [m.id, m.label || m.id])], this.#sim.mapping, (v) => { this.#sim.mapping = v; }, "260px")));
    row.append(button("Berechnen", () => void this.#simulate(), "omp-btn-primary"));
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
      if (!res.ok) this.#simResult = { errors: [(await res.text()) || `Fehler ${res.status}`] };
      else this.#simResult = (await res.json()) as { plan?: AudioPlan; errors?: string[] } & AudioPlan;
      if (this.#simResult && !("errors" in this.#simResult) && "groups" in this.#simResult) this.#simResult = { plan: this.#simResult as unknown as AudioPlan };
    } catch {
      this.#simResult = { errors: ["Keine Verbindung zum Server."] };
    }
    this.#render();
  }

  /** Eingabefelder für die ausführbaren Verarbeitungsschritte Gain (dB) und Delay (ms) einer Quellvorgabe. */
  #processingFields(spec: SourceSpec): HTMLElement[] {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(",", ".")));
    return [
      field("Gain (dB)", textInput(String(chainParam(spec, "gain", "db") ?? ""), (v) => { setChainParam(spec, "gain", "db", num(v)); this.#touch(); }, { width: "70px", placeholder: "0" })),
      field("Loudness-Ziel (LUFS)", textInput(String(chainParam(spec, "loudness", "target") ?? ""), (v) => { setChainParam(spec, "loudness", "target", num(v)); this.#touch(); }, { width: "90px", placeholder: "aus (z. B. -23)" })),
      field("Verzögerung (ms)", textInput(String(chainParam(spec, "delay", "ms") ?? ""), (v) => { setChainParam(spec, "delay", "ms", num(v)); this.#touch(); }, { width: "90px", placeholder: "0" })),
    ];
  }

  // ---- 4. Ersatzregeln ----------------------------------------------------------------------------------
  #renderRules(): HTMLElement {
    const doc = this.#doc!;
    const sec = el("div", BOX);
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "4 · Ersatzregeln (wenn eine Spur fehlt)"));
    sec.append(el("div", `${DIM}font-size:12px;margin-bottom:8px;`,
      "Greifen nur, wenn die Zuordnung einer Gruppe nicht erfüllbar ist. Von oben nach unten: die erste Regel, die eine Quelle findet, gewinnt; innerhalb einer Regel die erste Aktion, die klappt. " +
        "Beispiel: Gruppe 5.1 → „nimm role:pt AND layout:stereo über Upmix“, sonst Stille."));
    const groupOpts: [string, string][] = [["*", "alle Gruppen"], ...doc.outputProfile.groups.map((g): [string, string] => [g.id, g.label || g.id])];
    doc.ruleSet.rules.forEach((r, i) => sec.append(this.#renderRule(r, i, groupOpts)));
    sec.append(button("+ Regel", () => {
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
      field("Name", textInput(r.id ?? "", (v) => { r.id = v; this.#touch(); }, { width: "150px", mono: true, placeholder: "z. B. 51-aus-stereo" })),
      field("Für Gruppe", select(groupOpts, r.group, (v) => { r.group = v; this.#touch(); }, "170px")),
      field("nur wenn Spur fehlt", textInput(r.when.missing ?? "", (v) => { r.when.missing = v; this.#touch(); }, { width: "190px", list: "omp-audio-tags", mono: true, placeholder: "Tag-Ausdruck (optional)" })),
      field("nur wenn Spur da ist", textInput(r.when.has ?? "", (v) => { r.when.has = v; this.#touch(); }, { width: "190px", list: "omp-audio-tags", mono: true, placeholder: "Tag-Ausdruck (optional)" })),
      field("Quelle", select([["", "Datei oder Live"], ["file", "nur Datei"], ["live", "nur Live"]], r.when.source ?? "", (v) => { r.when.source = v || undefined; this.#touch(); }, "130px")),
      button("↑", () => { doc.ruleSet.rules = moveItem(doc.ruleSet.rules, i, -1); this.#touch(); this.#render(); }, "", "Regel früher prüfen"),
      button("↓", () => { doc.ruleSet.rules = moveItem(doc.ruleSet.rules, i, 1); this.#touch(); this.#render(); }),
      button("Regel löschen", () => { doc.ruleSet.rules.splice(i, 1); this.#touch(); this.#render(); }, "omp-btn-danger"),
    );
    box.append(head);
    const acts = el("div", "margin:6px 0 0 14px;display:flex;flex-direction:column;gap:5px;");
    r.then.forEach((a, ai) => acts.append(this.#renderAction(r, a, ai)));
    acts.append(button("+ Aktion", () => { r.then.push({ use: { select: "" } }); this.#touch(); this.#render(); }));
    box.append(acts);
    return box;
  }

  #renderAction(r: Rule, a: Action, ai: number): HTMLElement {
    const row = el("div", "display:flex;gap:8px;align-items:end;flex-wrap:wrap;");
    row.append(el("span", `${DIM}font-size:12px;align-self:center;min-width:42px;`, ai === 0 ? "dann" : "sonst"));
    const kind = select([["use", "Quelle nehmen"], ["silence", "Stille"], ["fail", "Event nicht senden (Alarm)"]], actionKind(a), (v) => {
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
        field("Tag-Ausdruck", textInput(u.select ?? "", (v) => { u.select = v; this.#touch(); }, { width: "260px", list: "omp-audio-tags", mono: true, placeholder: "role:pt AND layout:stereo" })),
        field("über", select(VIA_OPTIONS, u.via ?? "", (v) => { u.via = v || undefined; this.#touch(); }, "250px")),
        ...this.#processingFields(u),
      );
    }
    row.append(field("Hinweis", textInput(a.warn ?? "", (v) => { a.warn = v; this.#touch(); }, { width: "220px", placeholder: "erscheint als Warnung am Event" })),
      button("✕", () => { r.then.splice(ai, 1); this.#touch(); this.#render(); }, "omp-btn-danger", "Aktion entfernen"));
    return row;
  }
}

customElements.define("omp-audio-rules", AudioRulesView);
