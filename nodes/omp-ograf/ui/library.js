// ui/modules/ograf-editor/messages.ts
var messages = {
  de: {
    title: "Vorlagen-Bibliothek",
    back: "\u2039 Zur Sendung",
    openLib: "Vorlagen bearbeiten",
    newTpl: "\uFF0B Neu",
    duplicate: "Duplizieren",
    delete: "L\xF6schen",
    importBtn: "Import\u2026",
    exportBtn: "Export",
    save: "Speichern",
    revert: "Verwerfen",
    dirty: "\u25CF ungespeichert",
    saved: "Gespeichert.",
    none: "Keine Vorlage gew\xE4hlt.",
    empty: "Noch keine Vorlagen.",
    tabGeneral: "Allgemein",
    tabParams: "Parameter",
    tabSource: "Quelltext",
    askName: "Name der neuen Vorlage",
    askCopyName: "Name der Kopie",
    askDelete: "Vorlage \u201E{id}\u201C endg\xFCltig l\xF6schen?",
    valid: "g\xFCltig",
    invalid: "fehlerhaft",
    errors: "Fehler",
    warnings: "Hinweise",
    name: "Name",
    id: "Kennung (ID)",
    version: "Version",
    description: "Beschreibung",
    author: "Autor",
    authorEmail: "E-Mail",
    authorUrl: "Web",
    steps: "Schritte (stepCount, \u22121 = dynamisch)",
    realtime: "Echtzeit (supportsRealTime)",
    nonRealtime: "Nicht-Echtzeit (supportsNonRealTime)",
    resolution: "Renderaufl\xF6sung (0 = keine Angabe)",
    frameRate: "Bildrate (0 = keine Angabe)",
    addField: "\uFF0B Parameter",
    key: "Schl\xFCssel",
    fieldTitle: "Beschriftung",
    kind: "Art",
    def: "Vorgabe",
    choices: "Auswahl (kommagetrennt)",
    required: "Pflicht",
    remove: "Entfernen",
    up: "Nach oben",
    down: "Nach unten",
    kText: "Text",
    kMulti: "Mehrzeilig",
    kNumber: "Zahl",
    kBool: "Ja/Nein",
    kColor: "Farbe",
    kChoice: "Auswahl",
    file: "Datei",
    addFile: "\uFF0B Datei",
    delFile: "Datei l\xF6schen",
    askFile: "Dateiname (z. B. stil.css)",
    importFailed: "Import fehlgeschlagen: {why}",
    importExists: "Vorlage \u201E{id}\u201C gibt es schon. Als \u201E{newId}\u201C importieren?",
    loadFailed: "Laden fehlgeschlagen",
    saveFailed: "Speichern fehlgeschlagen: {why}",
    leaveDirty: "Ungespeicherte \xC4nderungen verwerfen?",
    manifestBroken: "Das Manifest ist kein g\xFCltiges JSON \u2014 bitte im Quelltext reparieren."
  },
  en: {
    title: "Template library",
    back: "\u2039 Back to on-air",
    openLib: "Edit templates",
    newTpl: "\uFF0B New",
    duplicate: "Duplicate",
    delete: "Delete",
    importBtn: "Import\u2026",
    exportBtn: "Export",
    save: "Save",
    revert: "Discard",
    dirty: "\u25CF unsaved",
    saved: "Saved.",
    none: "No template selected.",
    empty: "No templates yet.",
    tabGeneral: "General",
    tabParams: "Parameters",
    tabSource: "Source",
    askName: "Name of the new template",
    askCopyName: "Name of the copy",
    askDelete: "Delete template \u201C{id}\u201D permanently?",
    valid: "valid",
    invalid: "faulty",
    errors: "Errors",
    warnings: "Notes",
    name: "Name",
    id: "Identifier (ID)",
    version: "Version",
    description: "Description",
    author: "Author",
    authorEmail: "E-mail",
    authorUrl: "Web",
    steps: "Steps (stepCount, \u22121 = dynamic)",
    realtime: "Real time (supportsRealTime)",
    nonRealtime: "Non-real time (supportsNonRealTime)",
    resolution: "Render resolution (0 = unspecified)",
    frameRate: "Frame rate (0 = unspecified)",
    addField: "\uFF0B Parameter",
    key: "Key",
    fieldTitle: "Label",
    kind: "Kind",
    def: "Default",
    choices: "Choices (comma-separated)",
    required: "Required",
    remove: "Remove",
    up: "Move up",
    down: "Move down",
    kText: "Text",
    kMulti: "Multi-line",
    kNumber: "Number",
    kBool: "Yes/No",
    kColor: "Colour",
    kChoice: "Choice",
    file: "File",
    addFile: "\uFF0B File",
    delFile: "Delete file",
    askFile: "File name (e.g. style.css)",
    importFailed: "Import failed: {why}",
    importExists: "Template \u201C{id}\u201D already exists. Import as \u201C{newId}\u201D?",
    loadFailed: "Loading failed",
    saveFailed: "Saving failed: {why}",
    leaveDirty: "Discard unsaved changes?",
    manifestBroken: "The manifest is not valid JSON \u2014 please repair it in the source tab."
  }
};

// ui/modules/ograf-editor/logic.ts
var SCHEMA_URL = "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";
var PACKAGE_FORMAT = "omp-ograf-package/1";
function slugify(name) {
  const map = {
    "\xE4": "ae",
    "\xF6": "oe",
    "\xFC": "ue",
    "\xDF": "ss"
  };
  const s = name.toLowerCase().replace(/[äöüß]/g, (c) => map[c]).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return s;
}
function nextFreeId(base, taken) {
  const set = new Set(taken);
  const b = slugify(base) || "vorlage";
  if (!set.has(b)) return b;
  for (let i = 2; i < 1e3; i++) {
    const c = `${b.slice(0, 58)}-${i}`;
    if (!set.has(c)) return c;
  }
  return `${b.slice(0, 50)}-${Date.now() % 1e5}`;
}
function manifestFileName(files) {
  return Object.keys(files).find((n) => n.endsWith(".ograf.json")) ?? null;
}
function parseManifest(files) {
  const n = manifestFileName(files);
  if (!n) return null;
  try {
    const v = JSON.parse(files[n]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
var str = (v) => typeof v === "string" ? v : "";
var num = (v, d = 0) => typeof v === "number" && Number.isFinite(v) ? v : d;
function ideal(c) {
  return c && typeof c === "object" ? num(c.ideal) : 0;
}
function formFromManifest(m) {
  const author = m.author && typeof m.author === "object" ? m.author : {};
  const req = Array.isArray(m.renderRequirements) && m.renderRequirements[0] && typeof m.renderRequirements[0] === "object" ? m.renderRequirements[0] : {};
  const res = req.resolution && typeof req.resolution === "object" ? req.resolution : {};
  return {
    name: str(m.name),
    version: str(m.version),
    description: str(m.description),
    authorName: str(author.name),
    authorEmail: str(author.email),
    authorUrl: str(author.url),
    stepCount: num(m.stepCount, 1),
    supportsRealTime: m.supportsRealTime === true,
    supportsNonRealTime: m.supportsNonRealTime === true,
    width: ideal(res.width),
    height: ideal(res.height),
    frameRate: ideal(req.frameRate)
  };
}
function applyForm(prev, f, id) {
  const m = {
    ...prev,
    $schema: SCHEMA_URL,
    id,
    name: f.name,
    supportsRealTime: f.supportsRealTime,
    supportsNonRealTime: f.supportsNonRealTime
  };
  const opt = (k, v, empty) => {
    if (empty) delete m[k];
    else m[k] = v;
  };
  opt("version", f.version, f.version === "");
  opt("description", f.description, f.description === "");
  m.stepCount = Math.max(-1, Math.round(f.stepCount));
  const oldAuthor = prev.author && typeof prev.author === "object" ? prev.author : {};
  if (f.authorName) {
    const a = {
      ...oldAuthor,
      name: f.authorName
    };
    if (f.authorEmail) a.email = f.authorEmail;
    else delete a.email;
    if (f.authorUrl) a.url = f.authorUrl;
    else delete a.url;
    m.author = a;
  } else delete m.author;
  const reqs = Array.isArray(prev.renderRequirements) ? [
    ...prev.renderRequirements
  ] : [];
  const first = {
    ...reqs[0] ?? {}
  };
  if (f.width > 0 && f.height > 0) first.resolution = {
    width: {
      ideal: f.width
    },
    height: {
      ideal: f.height
    }
  };
  else delete first.resolution;
  if (f.frameRate > 0) first.frameRate = {
    ideal: f.frameRate
  };
  else delete first.frameRate;
  if (Object.keys(first).length) reqs[0] = first;
  else reqs.shift();
  opt("renderRequirements", reqs, reqs.length === 0);
  return m;
}
function stringify(m) {
  return JSON.stringify(m, null, 2) + "\n";
}
var FIELD_KINDS = [
  "text",
  "multiline",
  "number",
  "bool",
  "color",
  "choice"
];
var OWN_PROPS = /* @__PURE__ */ new Set([
  "type",
  "title",
  "default",
  "enum",
  "gddType",
  "pattern"
]);
function kindOf(p) {
  if (Array.isArray(p.enum) && p.enum.length) return "choice";
  if (p.type === "boolean") return "bool";
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.gddType === "color-rrggbb" || p.gddType === "color-rrggbbaa") return "color";
  if (p.gddType === "multi-line") return "multiline";
  return "text";
}
function fieldsFromSchema(schema) {
  const s = schema && typeof schema === "object" ? schema : {};
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.filter((x) => typeof x === "string") : [];
  return Object.entries(props).map(([key, p]) => {
    const prop = p && typeof p === "object" ? p : {};
    const extra = {};
    for (const [k, v] of Object.entries(prop)) if (!OWN_PROPS.has(k)) extra[k] = v;
    return {
      key,
      title: str(prop.title),
      kind: kindOf(prop),
      def: prop.default === void 0 ? "" : String(prop.default),
      choices: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      required: required.includes(key),
      extra
    };
  });
}
function schemaFromFields(fields, prev) {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? {
    ...prev
  } : {};
  const properties = {};
  for (const f of fields) {
    const p = {
      ...f.extra
    };
    if (f.title) p.title = f.title;
    switch (f.kind) {
      case "number":
        p.type = "number";
        if (f.def.trim() !== "" && Number.isFinite(Number(f.def))) p.default = Number(f.def);
        break;
      case "bool":
        p.type = "boolean";
        if (f.def !== "") p.default = f.def === "true";
        break;
      case "color":
        p.type = "string";
        p.gddType = "color-rrggbb";
        p.pattern = "^#[0-9a-fA-F]{6}$";
        if (f.def) p.default = f.def;
        break;
      case "choice":
        p.type = "string";
        p.enum = f.choices;
        if (f.def) p.default = f.def;
        break;
      case "multiline":
        p.type = "string";
        p.gddType = "multi-line";
        if (f.def !== "") p.default = f.def;
        break;
      default:
        p.type = "string";
        if (f.def !== "") p.default = f.def;
    }
    properties[f.key] = p;
  }
  base.type = "object";
  base.properties = properties;
  const required = fields.filter((f) => f.required).map((f) => f.key);
  if (required.length) base.required = required;
  else delete base.required;
  return base;
}
function validateFields(fields) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const f of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) out.push(`Schl\xFCssel \u201E${f.key}\u201C ung\xFCltig (Buchstaben, Ziffern, _; nicht mit Ziffer beginnen)`);
    if (seen.has(f.key)) out.push(`Schl\xFCssel \u201E${f.key}\u201C doppelt`);
    seen.add(f.key);
    if (f.kind === "choice" && f.choices.length === 0) out.push(`\u201E${f.key}\u201C: Auswahl ohne Eintr\xE4ge`);
    if (f.kind === "choice" && f.def && !f.choices.includes(f.def)) out.push(`\u201E${f.key}\u201C: Vorgabe nicht in der Auswahl`);
    if (f.kind === "number" && f.def.trim() !== "" && !Number.isFinite(Number(f.def))) out.push(`\u201E${f.key}\u201C: Vorgabe keine Zahl`);
    if (f.kind === "color" && f.def && !/^#[0-9a-fA-F]{6}$/.test(f.def)) out.push(`\u201E${f.key}\u201C: Farbe als #rrggbb`);
  }
  return out;
}
function exportPackage(id, files) {
  return JSON.stringify({
    format: PACKAGE_FORMAT,
    id,
    files
  }, null, 2) + "\n";
}
function importPackage(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return {
      error: "Datei ist kein g\xFCltiges JSON"
    };
  }
  const o = v;
  if (!o || o.format !== PACKAGE_FORMAT) return {
    error: `Unbekanntes Format (erwartet ${PACKAGE_FORMAT})`
  };
  const files = o.files;
  if (!files || typeof files !== "object") return {
    error: "files fehlt"
  };
  const out = {};
  for (const [k, c] of Object.entries(files)) {
    if (typeof c !== "string") return {
      error: `Datei \u201E${k}\u201C ist kein Text`
    };
    out[k] = c;
  }
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return {
    error: "id fehlt"
  };
  return {
    id,
    files: out
  };
}
function renamePackage(files, from, to) {
  const out = {};
  const m = parseManifest(files) ?? {};
  const oldMain = str(m.main);
  const newMain = oldMain === `${from}.js` ? `${to}.js` : oldMain;
  for (const [n, c] of Object.entries(files)) {
    if (n.endsWith(".ograf.json")) continue;
    out[n === oldMain && newMain !== oldMain ? newMain : n] = c;
  }
  out[`${to}.ograf.json`] = stringify({
    ...m,
    id: to,
    main: newMain
  });
  return out;
}

// ui/modules/ograf-editor/library.ts
var L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
var D = messages[L];
var tr = (k, p) => {
  let s = D[k] ?? messages.de[k] ?? k;
  for (const [a, b] of Object.entries(p ?? {})) s = s.split(`{${a}}`).join(b);
  return s;
};
function authHeaders() {
  let tok = null;
  try {
    tok = localStorage.getItem("omp-auth-token");
  } catch {
  }
  return tok ? {
    Authorization: `Bearer ${tok}`
  } : {};
}
function confirmDialog(message) {
  return new Promise((resolve) => {
    if (!customElements.get("omp-confirm")) return resolve(false);
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    el.addEventListener("resolve", (ev) => {
      resolve(ev.detail);
      el.remove();
    }, {
      once: true
    });
    document.body.appendChild(el);
  });
}
function promptDialog(message, initial = "") {
  return new Promise((resolve) => {
    if (!customElements.get("omp-prompt")) return resolve(null);
    const el = document.createElement("omp-prompt");
    el.textContent = message;
    if (initial) el.setAttribute("value", initial);
    el.addEventListener("resolve", (ev) => {
      resolve(ev.detail);
      el.remove();
    }, {
      once: true
    });
    document.body.appendChild(el);
  });
}
var KIND_LABEL = {
  text: "kText",
  multiline: "kMulti",
  number: "kNumber",
  bool: "kBool",
  color: "kColor",
  choice: "kChoice"
};
var STYLE = `
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
var OmpOgrafLibrary = class extends HTMLElement {
  #nodeId = "";
  #root;
  #list = [];
  #selected = "";
  #files = {};
  #orig = "";
  #origId = "";
  #serverErrors = [];
  #serverWarnings = [];
  #tab = "general";
  #fields = [];
  #sourceFile = "";
  #status = "";
  #statusBad = false;
  connectedCallback() {
    this.#nodeId = this.getAttribute("node-id") ?? "";
    this.#root = this.shadowRoot ?? this.attachShadow({
      mode: "open"
    });
    void this.#loadList().then(() => this.#render());
  }
  // ── Zugriff auf den Node ──
  async #param(name) {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/params/${name}`, {
      headers: authHeaders()
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()).value;
  }
  async #call(method, body) {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/methods/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(body)
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
      this.#list = await this.#param("library");
    } catch {
      this.#list = [];
      this.#say(tr("loadFailed"), true);
    }
  }
  async #open(id) {
    if (this.#dirty() && !await confirmDialog(tr("leaveDirty"))) return;
    try {
      const pkg = await this.#param(`library.${id}`);
      this.#selected = id;
      this.#files = {
        ...pkg.files
      };
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
  #dirty() {
    return this.#selected !== "" && JSON.stringify(this.#files) !== this.#orig;
  }
  #say(msg, bad) {
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
  #writeManifest(mutate) {
    const name = manifestFileName(this.#files);
    const m = parseManifest(this.#files);
    if (!name || !m) return;
    this.#files = {
      ...this.#files,
      [name]: stringify(mutate(m))
    };
    this.#markDirty();
  }
  #markDirty() {
    const d = this.#dirty();
    const dot = this.#root.querySelector(".dirty");
    if (dot) dot.style.display = d ? "" : "none";
    const save = this.#root.querySelector("button.save");
    if (save) save.disabled = !d;
  }
  // ── Aktionen ──
  async #newTemplate() {
    const name = await promptDialog(tr("askName"));
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = await this.#call("library.new", {
      id,
      name: name.trim()
    });
    if (err) return this.#say(tr("saveFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
  }
  async #duplicate() {
    if (!this.#selected) return;
    const name = await promptDialog(tr("askCopyName"), `${this.#selected}-kopie`);
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = await this.#call("library.duplicate", {
      id: this.#selected,
      newId: id
    });
    if (err) return this.#say(tr("saveFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
  }
  async #delete() {
    if (!this.#selected || !await confirmDialog(tr("askDelete", {
      id: this.#selected
    }))) return;
    const err = await this.#call("library.delete", {
      id: this.#selected
    });
    if (err) return this.#say(tr("saveFailed", {
      why: err
    }), true);
    this.#selected = "";
    this.#files = {};
    this.#orig = "";
    await this.#loadList();
    this.#render();
  }
  async #save() {
    const bad = validateFields(this.#fields);
    if (bad.length) return this.#say(bad.join("; "), true);
    const err = await this.#call("library.save", {
      id: this.#selected,
      files: this.#files
    });
    if (err) return this.#say(tr("saveFailed", {
      why: err
    }), true);
    const id = this.#selected;
    await this.#loadList();
    this.#orig = "";
    this.#selected = "";
    await this.#open(id);
    this.#say(tr("saved"), false);
  }
  #export() {
    if (!this.#selected) return;
    const blob = new Blob([
      exportPackage(this.#selected, this.#files)
    ], {
      type: "application/json"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.#selected}.ograf-package.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2e3);
  }
  async #import(file) {
    const r = importPackage(await file.text());
    if ("error" in r) return this.#say(tr("importFailed", {
      why: r.error
    }), true);
    let { id, files } = r;
    const taken = this.#list.map((e) => e.id);
    if (taken.includes(id)) {
      const newId = nextFreeId(id, taken);
      if (!await confirmDialog(tr("importExists", {
        id,
        newId
      }))) return;
      files = renamePackage(files, id, newId);
      id = newId;
    }
    const err = await this.#call("library.save", {
      id,
      files
    });
    if (err) return this.#say(tr("importFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
  }
  // ── Darstellung ──
  #el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  #btn(label, onClick, cls = "", disabled = false) {
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
  #renderSide() {
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
  #renderMain() {
    const main = this.#el("div", "main");
    if (!this.#selected) {
      main.append(this.#el("div", "status", tr("none")), this.#statusEl());
      return main;
    }
    const m = parseManifest(this.#files);
    const head = this.#el("div", "head");
    const valid = this.#serverErrors.length === 0;
    head.append(this.#el("h3", "", String(m?.name ?? this.#selected)), this.#el("span", `pill${valid ? "" : " bad"}`, valid ? tr("valid") : tr("invalid")));
    const dirty = this.#el("span", "dirty", tr("dirty"));
    dirty.style.display = this.#dirty() ? "" : "none";
    head.append(dirty);
    const spacer = this.#el("span");
    spacer.style.flex = "1";
    const save = this.#btn(tr("save"), () => void this.#save(), "primary save", !this.#dirty());
    head.append(spacer, this.#btn(tr("duplicate"), () => void this.#duplicate()), this.#btn(tr("exportBtn"), () => this.#export()), this.#btn(tr("delete"), () => void this.#delete()), this.#btn(tr("revert"), () => this.#revert(), "", false), save);
    main.append(head);
    if (this.#serverErrors.length) main.append(this.#list_("err", tr("errors"), this.#serverErrors));
    if (this.#serverWarnings.length) main.append(this.#list_("warn", tr("warnings"), this.#serverWarnings));
    const tabs = this.#el("div", "tabs");
    for (const [id, label] of [
      [
        "general",
        tr("tabGeneral")
      ],
      [
        "params",
        tr("tabParams")
      ],
      [
        "source",
        tr("tabSource")
      ]
    ]) {
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
    else if (this.#tab === "general") main.append(this.#renderGeneral(m));
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
  #statusEl() {
    return this.#el("div", `status${this.#statusBad ? " bad" : ""}`, this.#status);
  }
  #list_(cls, title, items) {
    const box = this.#el("div");
    box.append(this.#el("strong", "", `${title}:`));
    const ul = this.#el("ul", `msgs ${cls}`);
    for (const i of items) ul.append(this.#el("li", "", i));
    box.append(ul);
    return box;
  }
  #input(value, type, onInput, readonly = false) {
    const i = this.#el("input");
    i.type = type;
    i.value = String(value);
    i.readOnly = readonly;
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }
  #check(value, onChange) {
    const i = this.#el("input");
    i.type = "checkbox";
    i.checked = value;
    i.addEventListener("change", () => onChange(i.checked));
    return i;
  }
  #renderGeneral(m) {
    const f = formFromManifest(m);
    const form = this.#el("div", "form");
    const upd = (patch) => {
      Object.assign(f, patch);
      this.#writeManifest((prev) => applyForm(prev, f, this.#selected));
    };
    const row = (label, el) => form.append(this.#el("label", "k", label), el);
    row(tr("name"), this.#input(f.name, "text", (v) => upd({
      name: v
    })));
    row(tr("id"), this.#input(this.#selected, "text", () => {
    }, true));
    row(tr("version"), this.#input(f.version, "text", (v) => upd({
      version: v
    })));
    const desc = this.#el("textarea");
    desc.style.minHeight = "60px";
    desc.style.whiteSpace = "pre-wrap";
    desc.value = f.description;
    desc.addEventListener("input", () => upd({
      description: desc.value
    }));
    row(tr("description"), desc);
    row(tr("author"), this.#input(f.authorName, "text", (v) => upd({
      authorName: v
    })));
    row(tr("authorEmail"), this.#input(f.authorEmail, "text", (v) => upd({
      authorEmail: v
    })));
    row(tr("authorUrl"), this.#input(f.authorUrl, "text", (v) => upd({
      authorUrl: v
    })));
    row(tr("steps"), this.#input(f.stepCount, "number", (v) => upd({
      stepCount: Number(v) || 1
    })));
    row(tr("realtime"), this.#check(f.supportsRealTime, (v) => upd({
      supportsRealTime: v
    })));
    row(tr("nonRealtime"), this.#check(f.supportsNonRealTime, (v) => upd({
      supportsNonRealTime: v
    })));
    const res = this.#el("div", "row2");
    res.append(this.#input(f.width, "number", (v) => upd({
      width: Number(v) || 0
    })), this.#input(f.height, "number", (v) => upd({
      height: Number(v) || 0
    })));
    row(tr("resolution"), res);
    row(tr("frameRate"), this.#input(f.frameRate, "number", (v) => upd({
      frameRate: Number(v) || 0
    })));
    return form;
  }
  #writeFields() {
    this.#writeManifest((m) => ({
      ...m,
      schema: schemaFromFields(this.#fields, m.schema)
    }));
  }
  #renderParams() {
    const box = this.#el("div", "fields");
    const kinds = FIELD_KINDS;
    this.#fields.forEach((fd, i) => {
      const row = this.#el("div", "field");
      row.append(this.#input(fd.key, "text", (v) => {
        fd.key = v;
        this.#writeFields();
      }), this.#input(fd.title, "text", (v) => {
        fd.title = v;
        this.#writeFields();
      }));
      const sel = this.#el("select");
      for (const k of kinds) {
        const o = this.#el("option", "", tr(KIND_LABEL[k]));
        o.value = k;
        sel.append(o);
      }
      sel.value = fd.kind;
      sel.addEventListener("change", () => {
        fd.kind = sel.value;
        this.#writeFields();
        this.#render();
      });
      row.append(sel, this.#defaultInput(fd));
      const req = this.#el("label");
      req.append(this.#check(fd.required, (v) => {
        fd.required = v;
        this.#writeFields();
      }), document.createTextNode(` ${tr("required")}`));
      const ctl = this.#el("span", "bar");
      ctl.append(this.#btn("\u25B2", () => this.#move(i, -1), "", i === 0), this.#btn("\u25BC", () => this.#move(i, 1), "", i === this.#fields.length - 1), this.#btn("\u2715", () => {
        this.#fields.splice(i, 1);
        this.#writeFields();
        this.#render();
      }));
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
      this.#fields.push({
        key: `feld${n}`,
        title: "",
        kind: "text",
        def: "",
        choices: [],
        required: false,
        extra: {}
      });
      this.#writeFields();
      this.#render();
    }));
    return box;
  }
  #defaultInput(fd) {
    if (fd.kind === "bool") {
      const s = this.#el("select");
      for (const [v, l] of [
        [
          "",
          "\u2013"
        ],
        [
          "true",
          tr("kBool") + ": \u2713"
        ],
        [
          "false",
          tr("kBool") + ": \u2717"
        ]
      ]) {
        const o = this.#el("option", "", l);
        o.value = v;
        s.append(o);
      }
      s.value = fd.def;
      s.addEventListener("change", () => {
        fd.def = s.value;
        this.#writeFields();
      });
      return s;
    }
    if (fd.kind === "color") {
      const c = this.#el("input");
      c.type = "color";
      c.value = /^#[0-9a-fA-F]{6}$/.test(fd.def) ? fd.def : "#000000";
      c.addEventListener("input", () => {
        fd.def = c.value;
        this.#writeFields();
      });
      return c;
    }
    return this.#input(fd.def, fd.kind === "number" ? "number" : "text", (v) => {
      fd.def = v;
      this.#writeFields();
    });
  }
  #move(i, d) {
    const j = i + d;
    if (j < 0 || j >= this.#fields.length) return;
    [this.#fields[i], this.#fields[j]] = [
      this.#fields[j],
      this.#fields[i]
    ];
    this.#writeFields();
    this.#render();
  }
  #renderSource() {
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
    sel.addEventListener("change", () => {
      this.#sourceFile = sel.value;
      this.#render();
    });
    const isManifest = this.#sourceFile.endsWith(".ograf.json");
    bar.append(this.#el("span", "", `${tr("file")}:`), sel, this.#btn(tr("addFile"), () => void this.#addFile()), this.#btn(tr("delFile"), () => {
      const n = this.#sourceFile;
      const { [n]: _gone, ...rest } = this.#files;
      this.#files = rest;
      this.#sourceFile = "";
      this.#markDirty();
      this.#render();
    }, "", isManifest));
    const ta = this.#el("textarea");
    ta.spellcheck = false;
    ta.value = this.#files[this.#sourceFile] ?? "";
    ta.addEventListener("input", () => {
      this.#files = {
        ...this.#files,
        [this.#sourceFile]: ta.value
      };
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
    if (!n || this.#files[n] !== void 0) return;
    this.#files = {
      ...this.#files,
      [n]: ""
    };
    this.#sourceFile = n;
    this.#markDirty();
    this.#render();
  }
};
if (!customElements.get("omp-ograf-library")) customElements.define("omp-ograf-library", OmpOgrafLibrary);
