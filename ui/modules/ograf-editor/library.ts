// Vorlagen-Bibliothek des OGraf-Editors (Kapitel 90.4): Liste, Anlegen/Duplizieren/Löschen/Import/Export, Manifest-Formular,
// Parameter-Schema und Quelltext. Eigenständiges Bundle (kein Shell-Import, wie die anderen Node-Oberflächen): kommt vom Node
// `omp-ograf` mit seinem Panel (`/ui/bundle.js`) und spricht dessen Descriptor-API über den Orchestrator an
// (`GET /api/v1/nodes/{id}/params/library[.<id>]`, `POST …/methods/library.*`).
import { messages } from "./messages.ts";
import {
  applyForm, exportPackage, type Field, FIELD_KINDS, type FieldKind, fieldsFromSchema, type Files, formFromManifest,
  importPackage, manifestFileName, type ManifestForm, nextFreeId, parseManifest, renamePackage, schemaFromFields,
  stringify, validateFields,
} from "./logic.ts";

const L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
const D = messages[L] as Record<string, string>;
const tr = (k: string, p?: Record<string, string>): string => {
  let s = D[k] ?? (messages.de as Record<string, string>)[k] ?? k;
  for (const [a, b] of Object.entries(p ?? {})) s = s.split(`{${a}}`).join(b);
  return s;
};

interface ListEntry {
  id: string;
  label: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  files: string[];
}
type Tab = "general" | "params" | "source";

function authHeaders(): Record<string, string> {
  let tok: string | null = null;
  try {
    tok = localStorage.getItem("omp-auth-token");
  } catch { /* ohne Speicher: ohne Anmeldung */ }
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!customElements.get("omp-confirm")) return resolve(false); // nie window.confirm
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    el.addEventListener("resolve", (ev) => {
      resolve((ev as CustomEvent<boolean>).detail);
      el.remove();
    }, { once: true });
    document.body.appendChild(el);
  });
}
function promptDialog(message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    if (!customElements.get("omp-prompt")) return resolve(null);
    const el = document.createElement("omp-prompt");
    el.textContent = message;
    if (initial) el.setAttribute("value", initial);
    el.addEventListener("resolve", (ev) => {
      resolve((ev as CustomEvent<string | null>).detail);
      el.remove();
    }, { once: true });
    document.body.appendChild(el);
  });
}

const KIND_LABEL: Record<FieldKind, string> = {
  text: "kText", multiline: "kMulti", number: "kNumber", bool: "kBool", color: "kColor", choice: "kChoice",
};

const STYLE = `
:host { display: block; font-family: var(--omp-font, system-ui, sans-serif); color: var(--omp-text, #e8eaed); font-size: var(--omp-font-size-sm, 12px); }
* { box-sizing: border-box; }
.wrap { display: grid; grid-template-columns: 220px 1fr; gap: 10px; min-height: 420px; }
.side { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.list { display: flex; flex-direction: column; gap: 2px; overflow: auto; max-height: 60vh; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; }
.item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; }
.item:hover { background: var(--omp-bg-2, #1c1f22); }
.item.sel { background: var(--omp-info, #4285f4); color: #fff; }
.item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex: none; }
.dot.bad { background: #f85149; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
button.b, label.b { cursor: pointer; font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--omp-border, #3a3f45); background: var(--omp-surface-raised, #2f3339); color: inherit; }
button.b:hover { filter: brightness(1.15); }
button.b.primary { background: var(--omp-info, #4285f4); border-color: var(--omp-info, #4285f4); color: #fff; }
button.b:disabled { opacity: .45; cursor: default; }
.main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.head h3 { margin: 0; font-size: 14px; }
.pill { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: #1f6f3a; }
.pill.bad { background: #8b2a26; }
.dirty { color: #e3b341; font-size: 11px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--omp-border, #2e3338); }
.tab { cursor: pointer; padding: 5px 12px; border: 0; background: transparent; color: var(--omp-text-dim, #9aa0a6); font: inherit; border-bottom: 2px solid transparent; }
.tab.on { color: var(--omp-text, #e8eaed); border-bottom-color: var(--omp-info, #4285f4); }
.form { display: grid; grid-template-columns: 200px 1fr; gap: 6px 10px; align-items: center; max-width: 720px; }
.form label.k { color: var(--omp-text-dim, #9aa0a6); }
input[type=text], input[type=number], textarea, select { width: 100%; font: inherit; padding: 3px 6px; border-radius: 4px; background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed); border: 1px solid var(--omp-border, #2e3338); }
textarea { font-family: var(--omp-mono, monospace); min-height: 300px; resize: vertical; white-space: pre; tab-size: 2; }
.row2 { display: flex; gap: 6px; }
.msgs { margin: 0; padding-left: 18px; }
.msgs.err { color: #ff7b72; }
.msgs.warn { color: #e3b341; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.field { display: grid; grid-template-columns: 130px 150px 110px 1fr 70px auto; gap: 6px; align-items: center; padding: 6px; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; }
.field .ch { grid-column: 1 / -1; }
.status { min-height: 16px; color: var(--omp-text-dim, #9aa0a6); }
.status.bad { color: #ff7b72; }
.fileBar { display: flex; gap: 6px; align-items: center; }
.fileBar select { width: auto; min-width: 200px; }
`;

class OmpOgrafLibrary extends HTMLElement {
  #nodeId = "";
  #root!: ShadowRoot;
  #list: ListEntry[] = [];
  #selected = "";
  #files: Files = {};
  #orig = "";
  #origId = "";
  #serverErrors: string[] = [];
  #serverWarnings: string[] = [];
  #tab: Tab = "general";
  #fields: Field[] = [];
  #sourceFile = "";
  #status = "";
  #statusBad = false;

  connectedCallback() {
    this.#nodeId = this.getAttribute("node-id") ?? "";
    this.#root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    void this.#loadList().then(() => this.#render());
  }

  // ── Zugriff auf den Node ──
  async #param(name: string): Promise<unknown> {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/params/${name}`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()).value;
  }
  async #call(method: string, body: Record<string, unknown>): Promise<string | null> {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/methods/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    try {
      const j = await r.json();
      return String(j.error ?? j.message ?? r.status);
    } catch {
      return String(r.status);
    }
  }
  async #loadList() {
    try {
      this.#list = (await this.#param("library")) as ListEntry[];
    } catch {
      this.#list = [];
      this.#say(tr("loadFailed"), true);
    }
  }
  async #open(id: string) {
    if (this.#dirty() && !(await confirmDialog(tr("leaveDirty")))) return;
    try {
      const pkg = (await this.#param(`library.${id}`)) as { files: Files; errors: string[]; warnings: string[] };
      this.#selected = id;
      this.#files = { ...pkg.files };
      this.#serverErrors = pkg.errors;
      this.#serverWarnings = pkg.warnings;
      this.#origId = id;
      this.#orig = JSON.stringify(this.#files);
      this.#syncFields();
      this.#sourceFile = Object.keys(this.#files).find((n) => !n.endsWith(".ograf.json")) ?? "";
      this.#say("", false);
    } catch {
      this.#say(tr("loadFailed"), true);
    }
    this.#render();
  }
  #dirty(): boolean {
    return this.#selected !== "" && JSON.stringify(this.#files) !== this.#orig;
  }
  #say(msg: string, bad: boolean) {
    this.#status = msg;
    this.#statusBad = bad;
    const el = this.#root?.querySelector(".status");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("bad", bad);
    }
  }
  #syncFields() {
    const m = parseManifest(this.#files);
    this.#fields = fieldsFromSchema(m?.schema);
  }
  /** Feldliste und Formular in `files` zurückschreiben (Manifest ist die einzige Quelle der Wahrheit). */
  #writeManifest(mutate: (m: Record<string, unknown>) => Record<string, unknown>) {
    const name = manifestFileName(this.#files);
    const m = parseManifest(this.#files);
    if (!name || !m) return;
    this.#files = { ...this.#files, [name]: stringify(mutate(m)) };
    this.#markDirty();
  }
  #markDirty() {
    const d = this.#dirty();
    const dot = this.#root.querySelector(".dirty") as HTMLElement | null;
    if (dot) dot.style.display = d ? "" : "none";
    const save = this.#root.querySelector("button.save") as HTMLButtonElement | null;
    if (save) save.disabled = !d;
  }

  // ── Aktionen ──
  async #newTemplate() {
    const name = await promptDialog(tr("askName"));
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = await this.#call("library.new", { id, name: name.trim() });
    if (err) return this.#say(tr("saveFailed", { why: err }), true);
    await this.#loadList();
    await this.#open(id);
  }
  async #duplicate() {
    if (!this.#selected) return;
    const name = await promptDialog(tr("askCopyName"), `${this.#selected}-kopie`);
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = await this.#call("library.duplicate", { id: this.#selected, newId: id });
    if (err) return this.#say(tr("saveFailed", { why: err }), true);
    await this.#loadList();
    await this.#open(id);
  }
  async #delete() {
    if (!this.#selected || !(await confirmDialog(tr("askDelete", { id: this.#selected })))) return;
    const err = await this.#call("library.delete", { id: this.#selected });
    if (err) return this.#say(tr("saveFailed", { why: err }), true);
    this.#selected = "";
    this.#files = {};
    this.#orig = "";
    await this.#loadList();
    this.#render();
  }
  async #save() {
    const bad = validateFields(this.#fields);
    if (bad.length) return this.#say(bad.join("; "), true);
    const err = await this.#call("library.save", { id: this.#selected, files: this.#files });
    if (err) return this.#say(tr("saveFailed", { why: err }), true);
    const id = this.#selected;
    await this.#loadList();
    this.#orig = "";
    this.#selected = "";
    await this.#open(id);
    this.#say(tr("saved"), false);
  }
  #export() {
    if (!this.#selected) return;
    const blob = new Blob([exportPackage(this.#selected, this.#files)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.#selected}.ograf-package.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async #import(file: File) {
    const r = importPackage(await file.text());
    if ("error" in r) return this.#say(tr("importFailed", { why: r.error }), true);
    let { id, files } = r;
    const taken = this.#list.map((e) => e.id);
    if (taken.includes(id)) {
      const newId = nextFreeId(id, taken);
      if (!(await confirmDialog(tr("importExists", { id, newId })))) return;
      files = renamePackage(files, id, newId);
      id = newId;
    }
    const err = await this.#call("library.save", { id, files });
    if (err) return this.#say(tr("importFailed", { why: err }), true);
    await this.#loadList();
    await this.#open(id);
  }

  // ── Darstellung ──
  #el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  #btn(label: string, onClick: () => void, cls = "", disabled = false): HTMLButtonElement {
    const b = this.#el("button", `b ${cls}`.trim(), label);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }
  #render() {
    const root = this.#root;
    root.innerHTML = "";
    const style = this.#el("style");
    style.textContent = STYLE;
    const wrap = this.#el("div", "wrap");
    wrap.append(this.#renderSide(), this.#renderMain());
    root.append(style, wrap);
  }
  #renderSide(): HTMLElement {
    const side = this.#el("div", "side");
    const bar = this.#el("div", "bar");
    const imp = this.#el("label", "b", tr("importBtn"));
    const input = this.#el("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      input.value = "";
      if (f) void this.#import(f);
    });
    imp.append(input);
    bar.append(this.#btn(tr("newTpl"), () => void this.#newTemplate(), "primary"), imp);
    const list = this.#el("div", "list");
    if (!this.#list.length) list.append(this.#el("div", "status", tr("empty")));
    for (const e of this.#list) {
      const it = this.#el("button", `item${e.id === this.#selected ? " sel" : ""}`);
      it.type = "button";
      it.title = e.errors.join("\n") || e.id;
      const dot = this.#el("span", `dot${e.valid ? "" : " bad"}`);
      it.append(dot, this.#el("span", "lbl", e.label));
      it.addEventListener("click", () => void this.#open(e.id));
      list.append(it);
    }
    side.append(bar, list);
    return side;
  }
  #renderMain(): HTMLElement {
    const main = this.#el("div", "main");
    if (!this.#selected) {
      main.append(this.#el("div", "status", tr("none")), this.#statusEl());
      return main;
    }
    const m = parseManifest(this.#files);
    const head = this.#el("div", "head");
    const valid = this.#serverErrors.length === 0;
    head.append(
      this.#el("h3", "", String(m?.name ?? this.#selected)),
      this.#el("span", `pill${valid ? "" : " bad"}`, valid ? tr("valid") : tr("invalid")),
    );
    const dirty = this.#el("span", "dirty", tr("dirty"));
    dirty.style.display = this.#dirty() ? "" : "none";
    head.append(dirty);
    const spacer = this.#el("span");
    spacer.style.flex = "1";
    const save = this.#btn(tr("save"), () => void this.#save(), "primary save", !this.#dirty());
    head.append(
      spacer,
      this.#btn(tr("duplicate"), () => void this.#duplicate()),
      this.#btn(tr("exportBtn"), () => this.#export()),
      this.#btn(tr("delete"), () => void this.#delete()),
      this.#btn(tr("revert"), () => this.#revert(), "", false),
      save,
    );
    main.append(head);
    if (this.#serverErrors.length) main.append(this.#list_("err", tr("errors"), this.#serverErrors));
    if (this.#serverWarnings.length) main.append(this.#list_("warn", tr("warnings"), this.#serverWarnings));
    const tabs = this.#el("div", "tabs");
    for (const [id, label] of [["general", tr("tabGeneral")], ["params", tr("tabParams")], ["source", tr("tabSource")]] as [Tab, string][]) {
      const t = this.#el("button", `tab${this.#tab === id ? " on" : ""}`, label);
      t.type = "button";
      t.addEventListener("click", () => {
        if (this.#tab === "source") this.#syncFields();
        this.#tab = id;
        this.#render();
      });
      tabs.append(t);
    }
    main.append(tabs);
    if (!m && this.#tab !== "source") main.append(this.#el("div", "status bad", tr("manifestBroken")));
    else if (this.#tab === "general") main.append(this.#renderGeneral(m!));
    else if (this.#tab === "params") main.append(this.#renderParams());
    else main.append(this.#renderSource());
    main.append(this.#statusEl());
    return main;
  }
  #revert() {
    if (!this.#dirty()) return;
    this.#files = JSON.parse(this.#orig);
    this.#syncFields();
    this.#render();
  }
  #statusEl(): HTMLElement {
    return this.#el("div", `status${this.#statusBad ? " bad" : ""}`, this.#status);
  }
  #list_(cls: string, title: string, items: string[]): HTMLElement {
    const box = this.#el("div");
    box.append(this.#el("strong", "", `${title}:`));
    const ul = this.#el("ul", `msgs ${cls}`);
    for (const i of items) ul.append(this.#el("li", "", i));
    box.append(ul);
    return box;
  }
  #input(value: string | number, type: "text" | "number", onInput: (v: string) => void, readonly = false): HTMLInputElement {
    const i = this.#el("input");
    i.type = type;
    i.value = String(value);
    i.readOnly = readonly;
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }
  #check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const i = this.#el("input");
    i.type = "checkbox";
    i.checked = value;
    i.addEventListener("change", () => onChange(i.checked));
    return i;
  }
  #renderGeneral(m: Record<string, unknown>): HTMLElement {
    const f = formFromManifest(m);
    const form = this.#el("div", "form");
    const upd = (patch: Partial<ManifestForm>) => {
      Object.assign(f, patch);
      this.#writeManifest((prev) => applyForm(prev, f, this.#selected));
    };
    const row = (label: string, el: HTMLElement) => form.append(this.#el("label", "k", label), el);
    row(tr("name"), this.#input(f.name, "text", (v) => upd({ name: v })));
    row(tr("id"), this.#input(this.#selected, "text", () => {}, true));
    row(tr("version"), this.#input(f.version, "text", (v) => upd({ version: v })));
    const desc = this.#el("textarea");
    desc.style.minHeight = "60px";
    desc.style.whiteSpace = "pre-wrap";
    desc.value = f.description;
    desc.addEventListener("input", () => upd({ description: desc.value }));
    row(tr("description"), desc);
    row(tr("author"), this.#input(f.authorName, "text", (v) => upd({ authorName: v })));
    row(tr("authorEmail"), this.#input(f.authorEmail, "text", (v) => upd({ authorEmail: v })));
    row(tr("authorUrl"), this.#input(f.authorUrl, "text", (v) => upd({ authorUrl: v })));
    row(tr("steps"), this.#input(f.stepCount, "number", (v) => upd({ stepCount: Number(v) || 1 })));
    row(tr("realtime"), this.#check(f.supportsRealTime, (v) => upd({ supportsRealTime: v })));
    row(tr("nonRealtime"), this.#check(f.supportsNonRealTime, (v) => upd({ supportsNonRealTime: v })));
    const res = this.#el("div", "row2");
    res.append(
      this.#input(f.width, "number", (v) => upd({ width: Number(v) || 0 })),
      this.#input(f.height, "number", (v) => upd({ height: Number(v) || 0 })),
    );
    row(tr("resolution"), res);
    row(tr("frameRate"), this.#input(f.frameRate, "number", (v) => upd({ frameRate: Number(v) || 0 })));
    return form;
  }
  #writeFields() {
    this.#writeManifest((m) => ({ ...m, schema: schemaFromFields(this.#fields, m.schema) }));
  }
  #renderParams(): HTMLElement {
    const box = this.#el("div", "fields");
    const kinds = FIELD_KINDS;
    this.#fields.forEach((fd, i) => {
      const row = this.#el("div", "field");
      row.append(
        this.#input(fd.key, "text", (v) => { fd.key = v; this.#writeFields(); }),
        this.#input(fd.title, "text", (v) => { fd.title = v; this.#writeFields(); }),
      );
      const sel = this.#el("select");
      for (const k of kinds) {
        const o = this.#el("option", "", tr(KIND_LABEL[k]));
        o.value = k;
        sel.append(o);
      }
      sel.value = fd.kind;
      sel.addEventListener("change", () => {
        fd.kind = sel.value as FieldKind;
        this.#writeFields();
        this.#render();
      });
      row.append(sel, this.#defaultInput(fd));
      const req = this.#el("label");
      req.append(this.#check(fd.required, (v) => { fd.required = v; this.#writeFields(); }), document.createTextNode(` ${tr("required")}`));
      const ctl = this.#el("span", "bar");
      ctl.append(
        this.#btn("▲", () => this.#move(i, -1), "", i === 0),
        this.#btn("▼", () => this.#move(i, 1), "", i === this.#fields.length - 1),
        this.#btn("✕", () => { this.#fields.splice(i, 1); this.#writeFields(); this.#render(); }),
      );
      ctl.title = `${tr("up")} / ${tr("down")} / ${tr("remove")}`;
      row.append(req, ctl);
      if (fd.kind === "choice") {
        const ch = this.#el("div", "ch");
        ch.append(this.#el("span", "", `${tr("choices")}: `));
        ch.append(this.#input(fd.choices.join(", "), "text", (v) => {
          fd.choices = v.split(",").map((s) => s.trim()).filter(Boolean);
          this.#writeFields();
        }));
        row.append(ch);
      }
      box.append(row);
    });
    const issues = validateFields(this.#fields);
    if (issues.length) box.append(this.#list_("err", tr("errors"), issues));
    box.append(this.#btn(tr("addField"), () => {
      let n = 1;
      while (this.#fields.some((f) => f.key === `feld${n}`)) n++;
      this.#fields.push({ key: `feld${n}`, title: "", kind: "text", def: "", choices: [], required: false, extra: {} });
      this.#writeFields();
      this.#render();
    }));
    return box;
  }
  #defaultInput(fd: Field): HTMLElement {
    if (fd.kind === "bool") {
      const s = this.#el("select");
      for (const [v, l] of [["", "–"], ["true", tr("kBool") + ": ✓"], ["false", tr("kBool") + ": ✗"]]) {
        const o = this.#el("option", "", l);
        o.value = v;
        s.append(o);
      }
      s.value = fd.def;
      s.addEventListener("change", () => { fd.def = s.value; this.#writeFields(); });
      return s;
    }
    if (fd.kind === "color") {
      const c = this.#el("input");
      c.type = "color";
      c.value = /^#[0-9a-fA-F]{6}$/.test(fd.def) ? fd.def : "#000000";
      c.addEventListener("input", () => { fd.def = c.value; this.#writeFields(); });
      return c;
    }
    return this.#input(fd.def, fd.kind === "number" ? "number" : "text", (v) => { fd.def = v; this.#writeFields(); });
  }
  #move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= this.#fields.length) return;
    [this.#fields[i], this.#fields[j]] = [this.#fields[j], this.#fields[i]];
    this.#writeFields();
    this.#render();
  }
  #renderSource(): HTMLElement {
    const box = this.#el("div", "fields");
    const bar = this.#el("div", "fileBar");
    const sel = this.#el("select");
    for (const n of Object.keys(this.#files)) {
      const o = this.#el("option", "", n);
      o.value = n;
      sel.append(o);
    }
    if (!this.#files[this.#sourceFile]) this.#sourceFile = Object.keys(this.#files)[0] ?? "";
    sel.value = this.#sourceFile;
    sel.addEventListener("change", () => { this.#sourceFile = sel.value; this.#render(); });
    const isManifest = this.#sourceFile.endsWith(".ograf.json");
    bar.append(
      this.#el("span", "", `${tr("file")}:`), sel,
      this.#btn(tr("addFile"), () => void this.#addFile()),
      this.#btn(tr("delFile"), () => {
        const n = this.#sourceFile;
        const { [n]: _gone, ...rest } = this.#files;
        this.#files = rest;
        this.#sourceFile = "";
        this.#markDirty();
        this.#render();
      }, "", isManifest),
    );
    const ta = this.#el("textarea");
    ta.spellcheck = false;
    ta.value = this.#files[this.#sourceFile] ?? "";
    ta.addEventListener("input", () => {
      this.#files = { ...this.#files, [this.#sourceFile]: ta.value };
      this.#markDirty();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText("  ", s, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      }
    });
    box.append(bar, ta);
    return box;
  }
  async #addFile() {
    const name = await promptDialog(tr("askFile"));
    const n = (name ?? "").trim();
    if (!n || this.#files[n] !== undefined) return;
    this.#files = { ...this.#files, [n]: "" };
    this.#sourceFile = n;
    this.#markDirty();
    this.#render();
  }
}

if (!customElements.get("omp-ograf-library")) customElements.define("omp-ograf-library", OmpOgrafLibrary);
