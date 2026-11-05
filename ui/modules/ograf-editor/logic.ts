// Logik des OGraf-Editors (Kapitel 90.4): Manifest-Formular, Parameter-Schema als Feldliste, Paket-Austausch. Rein und ohne
// DOM, damit sie unter Deno getestet werden kann. Die Regeln für das Manifest prüft der Node (`omp-ograf/src/library.rs`,
// gleiche Quelle: offizielles Schema https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json); hier steht nur,
// was das Formular braucht, um ein Manifest zu lesen und zu schreiben, **ohne unbekannte Felder zu verlieren**.

export type Files = Record<string, string>;
export const SCHEMA_URL = "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";
export const PACKAGE_FORMAT = "omp-ograf-package/1";

type Json = Record<string, unknown>;

/** Paket-ID aus einem Namen: Kleinbuchstaben, Ziffern, Bindestrich (Umlaute aufgelöst), höchstens 63 Zeichen. */
export function slugify(name: string): string {
  const map: Record<string, string> = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" };
  const s = name.toLowerCase().replace(/[äöüß]/g, (c) => map[c]).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return s;
}

/** Erste freie ID `base`, `base-2`, `base-3` … */
export function nextFreeId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const b = slugify(base) || "vorlage";
  if (!set.has(b)) return b;
  for (let i = 2; i < 1000; i++) {
    const c = `${b.slice(0, 58)}-${i}`;
    if (!set.has(c)) return c;
  }
  return `${b.slice(0, 50)}-${Date.now() % 100000}`;
}

export function manifestFileName(files: Files): string | null {
  return Object.keys(files).find((n) => n.endsWith(".ograf.json")) ?? null;
}

export function parseManifest(files: Files): Json | null {
  const n = manifestFileName(files);
  if (!n) return null;
  try {
    const v = JSON.parse(files[n]);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
  } catch {
    return null;
  }
}

export interface ManifestForm {
  name: string;
  version: string;
  description: string;
  authorName: string;
  authorEmail: string;
  authorUrl: string;
  stepCount: number;
  supportsRealTime: boolean;
  supportsNonRealTime: boolean;
  /** Gewünschte Renderauflösung (0 = keine Angabe) und Bildrate (0 = keine Angabe). */
  width: number;
  height: number;
  frameRate: number;
  /** Vorschaubild (Datei im Paket) oder leer. */
  thumbnail: string;
}

const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown, d = 0): number => typeof v === "number" && Number.isFinite(v) ? v : d;

function ideal(c: unknown): number {
  return c && typeof c === "object" ? num((c as Json).ideal) : 0;
}

export function formFromManifest(m: Json): ManifestForm {
  const author = (m.author && typeof m.author === "object" ? m.author : {}) as Json;
  const req = Array.isArray(m.renderRequirements) && m.renderRequirements[0] && typeof m.renderRequirements[0] === "object"
    ? m.renderRequirements[0] as Json
    : {};
  const res = (req.resolution && typeof req.resolution === "object" ? req.resolution : {}) as Json;
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
    frameRate: ideal(req.frameRate),
    thumbnail: Array.isArray(m.thumbnails) && m.thumbnails[0] && typeof m.thumbnails[0] === "object" ? str((m.thumbnails[0] as Json).file) : "",
  };
}

/** Schreibt das Formular in ein Manifest; alle Felder, die das Formular nicht kennt, bleiben unverändert. */
export function applyForm(prev: Json, f: ManifestForm, id: string): Json {
  const m: Json = { ...prev, $schema: SCHEMA_URL, id, name: f.name, supportsRealTime: f.supportsRealTime, supportsNonRealTime: f.supportsNonRealTime };
  const opt = (k: string, v: unknown, empty: boolean) => {
    if (empty) delete m[k];
    else m[k] = v;
  };
  opt("version", f.version, f.version === "");
  opt("description", f.description, f.description === "");
  m.stepCount = Math.max(-1, Math.round(f.stepCount));
  const oldAuthor = (prev.author && typeof prev.author === "object" ? prev.author : {}) as Json;
  if (f.authorName) {
    const a: Json = { ...oldAuthor, name: f.authorName };
    if (f.authorEmail) a.email = f.authorEmail;
    else delete a.email;
    if (f.authorUrl) a.url = f.authorUrl;
    else delete a.url;
    m.author = a;
  } else delete m.author;
  const reqs = Array.isArray(prev.renderRequirements) ? [...prev.renderRequirements] as Json[] : [];
  const first: Json = { ...(reqs[0] ?? {}) };
  if (f.width > 0 && f.height > 0) first.resolution = { width: { ideal: f.width }, height: { ideal: f.height } };
  else delete first.resolution;
  if (f.frameRate > 0) first.frameRate = { ideal: f.frameRate };
  else delete first.frameRate;
  if (Object.keys(first).length) reqs[0] = first;
  else reqs.shift();
  opt("renderRequirements", reqs, reqs.length === 0);
  const thumbs = Array.isArray(prev.thumbnails) ? [...prev.thumbnails] as Json[] : [];
  if (f.thumbnail) thumbs[0] = { ...(thumbs[0] ?? {}), file: f.thumbnail };
  else thumbs.shift();
  opt("thumbnails", thumbs, thumbs.length === 0);
  return m;
}

export function stringify(m: Json): string {
  return JSON.stringify(m, null, 2) + "\n";
}

// ── Parameter-Schema als Feldliste ────────────────────────────────────────────────────────────────────────

export type FieldKind = "text" | "multiline" | "number" | "bool" | "color" | "choice" | "raw";
/** Bearbeitbare Arten (`raw` = Eigenschaft mit Aufbau, den das Formular nicht kennt; bleibt unverändert, Bearbeitung im Quelltext). */
export const FIELD_KINDS: FieldKind[] = ["text", "multiline", "number", "bool", "color", "choice"];
/** Farbmuster laut `gdd/gdd-types.json` (Kleinbuchstaben). */
export const COLOR_PATTERN = "^#[0-9a-f]{6}$";

export interface Field {
  key: string;
  title: string;
  kind: FieldKind;
  /** Vorgabewert als Text (bei Zahl/Ja-Nein wird beim Schreiben umgewandelt). */
  def: string;
  choices: string[];
  required: boolean;
  /** Alle übrigen Eigenschaften dieses Feldes im Schema (gehen beim Bearbeiten nicht verloren). */
  extra: Json;
}

const OWN_PROPS = new Set(["type", "title", "default", "enum", "pattern"]);
/** gddType-Werte, die eine Art des Formulars selbst festlegt (alle anderen bleiben in `extra`). */
const KIND_GDD = new Set(["color-rrggbb", "multi-line"]);

function kindOf(p: Json): FieldKind {
  if (p.type === "array" || p.type === "object" || p.gddType === "select" || p.gddType === "select-multiple" || p.gddType === "color-rrggbbaa") return "raw";
  if (Array.isArray(p.enum) && p.enum.length) return "choice";
  if (p.type === "boolean") return "bool";
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.gddType === "color-rrggbb" || p.gddType === "color-rrggbbaa") return "color";
  if (p.gddType === "multi-line") return "multiline";
  return "text";
}

export function fieldsFromSchema(schema: unknown): Field[] {
  const s = (schema && typeof schema === "object" ? schema : {}) as Json;
  const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, Json>;
  const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : [];
  return Object.entries(props).map(([key, p]) => {
    const prop = (p && typeof p === "object" ? p : {}) as Json;
    const kind = kindOf(prop);
    const extra: Json = {};
    for (const [k, v] of Object.entries(prop)) {
      if (kind === "raw") extra[k] = v;
      else if (!OWN_PROPS.has(k) && !(k === "gddType" && KIND_GDD.has(String(v)))) extra[k] = v;
    }
    return {
      key,
      title: str(prop.title),
      kind,
      def: kind === "raw" || prop.default === undefined ? "" : String(prop.default),
      choices: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      required: required.includes(key),
      extra,
    };
  });
}

/** Feldliste → JSON-Schema (Objekt mit `properties`); unbekannte Schema-Felder auf Objektebene bleiben aus `prev` erhalten. */
export function schemaFromFields(fields: Field[], prev: unknown): Json {
  const base = (prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Json) } : {}) as Json;
  const properties: Record<string, Json> = {};
  for (const f of fields) {
    if (f.kind === "raw") {
      properties[f.key] = { ...f.extra, ...(f.title ? { title: f.title } : {}) };
      continue;
    }
    const p: Json = { ...f.extra };
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
        p.pattern = COLOR_PATTERN;
        if (f.def) p.default = f.def.toLowerCase();
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

/** Meldungen zu einer Feldliste (leer = in Ordnung). */
export function validateFields(fields: Field[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) out.push(`Schlüssel „${f.key}“ ungültig (Buchstaben, Ziffern, _; nicht mit Ziffer beginnen)`);
    if (seen.has(f.key)) out.push(`Schlüssel „${f.key}“ doppelt`);
    seen.add(f.key);
    if (f.kind === "choice" && f.choices.length === 0) out.push(`„${f.key}“: Auswahl ohne Einträge`);
    if (f.kind === "choice" && f.def && !f.choices.includes(f.def)) out.push(`„${f.key}“: Vorgabe nicht in der Auswahl`);
    if (f.kind === "number" && f.def.trim() !== "" && !Number.isFinite(Number(f.def))) out.push(`„${f.key}“: Vorgabe keine Zahl`);
    if (f.kind === "color" && f.def && !/^#[0-9a-fA-F]{6}$/.test(f.def)) out.push(`„${f.key}“: Farbe als #rrggbb`);
    if (f.kind === "raw") continue;
  }
  return out;
}

/** Vorgabewerte für die Vorschau/den Test (wie `schema_defaults` im Node). */
export function defaultsOf(fields: Field[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.def === "" || f.kind === "raw") continue;
    o[f.key] = f.kind === "number" ? Number(f.def) : f.kind === "bool" ? f.def === "true" : f.def;
  }
  return o;
}

// ── Paket-Austausch ───────────────────────────────────────────────────────────────────────────────────────────

export function exportPackage(id: string, files: Files): string {
  return JSON.stringify({ format: PACKAGE_FORMAT, id, files }, null, 2) + "\n";
}

export function importPackage(text: string): { id: string; files: Files } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "Datei ist kein gültiges JSON" };
  }
  const o = v as Json;
  if (!o || o.format !== PACKAGE_FORMAT) return { error: `Unbekanntes Format (erwartet ${PACKAGE_FORMAT})` };
  const files = o.files as Json | undefined;
  if (!files || typeof files !== "object") return { error: "files fehlt" };
  const out: Files = {};
  for (const [k, c] of Object.entries(files)) {
    if (typeof c !== "string") return { error: `Datei „${k}“ ist kein Text` };
    out[k] = c;
  }
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return { error: "id fehlt" };
  return { id, files: out };
}

/** Gibt ein Paket unter neuer ID zurück: Manifest-Dateiname, `id` und `main` (wenn es `<alt>.js` hieß) ziehen mit um. */
export function renamePackage(files: Files, from: string, to: string): Files {
  const out: Files = {};
  const m = parseManifest(files) ?? {};
  const oldMain = str(m.main);
  const newMain = oldMain === `${from}.js` ? `${to}.js` : oldMain;
  for (const [n, c] of Object.entries(files)) {
    if (n.endsWith(".ograf.json")) continue;
    out[n === oldMain && newMain !== oldMain ? newMain : n] = c;
  }
  out[`${to}.ograf.json`] = stringify({ ...m, id: to, main: newMain });
  return out;
}
