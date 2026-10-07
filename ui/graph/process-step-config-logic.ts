// Reine Logik für die Schritt-Konfigurationsformulare des Prozess-
// Editors (Nachtrag 270) — DOM-frei, per `deno test` geprüft.
//
// Nutzerauftrag 2026-09-23: "normale User sind mit der Eingabe von JSON
// überfordert … der User weiß ja nicht, welche Variablen oder Werte er
// hier überhaupt eingeben kann." Deshalb:
//   - je Schritt-Typ ein Formular statt JSON (JSON bleibt als "Erweitert"),
//   - ein Variablen-Katalog, der aus dem GRAPHEN abgeleitet wird (nur
//     Schritte, die vor diesem Schritt garantiert gelaufen sein können,
//     mit ihren tatsächlich gelieferten Ausgabefeldern) plus den Feldern
//     des auslösenden Ereignisses,
//   - ein Regel-Baukasten für Bedingungen (Variable/Operator/Wert) statt
//     Ausdruckssyntax,
//   - Vorschlagslisten für Verzweigungs-Namen, die der Vorgänger-Schritt
//     auch wirklich liefert.
//
// Alle Ausgabe-/Konfigurationsfelder spiegeln orchestrator/internal/
// process/executors.go (Config-Structs, Output-Formen) — bei Änderungen
// dort hier mitziehen.
import { t as tt } from "../shell/i18n.ts";
import type { DraftDefinition, DraftStep, RetryPolicy } from "./process-editor-logic.ts";

// ---- Schritt-Typ-Metadaten --------------------------------------------------------------------

export interface StepTypeInfo {
  label: string;
  group: "action" | "flow" | "human";
  help: string;
}

export const STEP_TYPE_INFO: Record<string, StepTypeInfo> = {
  media_function: { label: tt("pscl.edf89b"), group: "action", help: tt("pscl.3ec2a9") },
  service_call: { label: tt("pscl.252f47"), group: "action", help: tt("pscl.be6156") },
  script: { label: tt("pscl.ba264e"), group: "action", help: tt("pscl.50dc19") },
  notification: { label: tt("pscl.490ba3"), group: "action", help: tt("pscl.6b7645") },
  subworkflow: { label: tt("pscl.9da01f"), group: "action", help: tt("pscl.96a4f7") },
  condition: { label: tt("pscl.ae59d5"), group: "flow", help: tt("pscl.1a789c") },
  branch: { label: tt("pscl.a6e3cb"), group: "flow", help: tt("pscl.29f701") },
  parallel: { label: tt("pscl.755c8f"), group: "flow", help: tt("pscl.6f5185") },
  join: { label: tt("pscl.834ac6"), group: "flow", help: tt("pscl.c8f0b4") },
  wait: { label: tt("pscl.f152a5"), group: "flow", help: tt("pscl.402c2d") },
  timer: { label: tt("pscl.efb477"), group: "flow", help: tt("pscl.534969") },
  human_task: { label: tt("pscl.4ca08f"), group: "human", help: tt("pscl.774c40") },
  approval: { label: tt("pscl.c947f6"), group: "human", help: tt("pscl.5f3043") },
  task: { label: tt("pscl.e4fa94"), group: "action", help: tt("pscl.8faa35") },
  loop: { label: tt("pscl.6c5de6"), group: "flow", help: tt("pscl.2b4ae5") },
  event_trigger: { label: tt("pscl.3727f6"), group: "flow", help: tt("pscl.dcc732") },
  compensation: { label: tt("pscl.cec559"), group: "action", help: tt("pscl.2b4ae5") },
};

export function stepTypeLabel(type: string): string {
  return STEP_TYPE_INFO[type]?.label ?? type;
}

// ---- Ausgabefelder je Schritt-Typ (executors.go) ----------------------------------------------

export interface OutputField {
  path: string; // relativ zu outputs.<stepId>
  label: string;
}

export function outputFieldsFor(step: DraftStep): OutputField[] {
  switch (step.type) {
    case "service_call":
      return [
        { path: "status", label: tt("pscl.3e9f80") },
        { path: "body", label: tt("pscl.f385d3") },
      ];
    case "script":
      return [
        { path: "exitCode", label: tt("pscl.0d3958") },
        { path: "stdout", label: tt("pscl.b65498") },
        { path: "stderr", label: tt("pscl.daeec0") },
      ];
    case "human_task":
    case "approval":
      return [
        { path: "decision", label: tt("pscl.7c0760") },
        { path: "comment", label: tt("pscl.cd0559") },
        { path: "assignee", label: tt("pscl.9d885e") },
      ];
    case "condition":
    case "branch":
      return [{ path: "decision", label: tt("pscl.6cf0a2") }];
    case "media_function":
    case "subworkflow":
      return [{ path: "", label: tt("pscl.2f0304") }];
    default:
      return [];
  }
}

// ---- Auslöser (Event-Trigger, A8) -------------------------------------------------------------

export interface TriggerKind {
  id: string;
  label: string;
  subject: string; // NATS-Subject, "*" = beliebiges Asset
  inputFields: OutputField[]; // Felder des Ereignis-Payloads = input.*
}

// Asset-Ereignisse aus orchestrator/internal/asset/store.go (enqueueEvent,
// Subject "omp.asset.<assetId>.<event>"). Status-Wechsel veröffentlichen
// den NEUEN Status als Event-Namen.
const ASSET_STATUS_EVENT_FIELDS: OutputField[] = [
  { path: "assetId", label: tt("pscl.8c7a60") },
  { path: "status", label: tt("pscl.406438") },
  { path: "updatedBy", label: tt("pscl.06464c") },
];

export function triggerKinds(assetStatuses: string[], statusLabel: (s: string) => string): TriggerKind[] {
  const kinds: TriggerKind[] = [
    {
      id: "asset.created",
      label: tt("pscl.a405eb"),
      subject: "omp.asset.*.created",
      inputFields: [
        { path: "id", label: tt("pscl.8c7a60") },
        { path: "title", label: tt("pscl.18a802") },
        { path: "type", label: tt("pscl.c2ea84") },
      ],
    },
    {
      id: "asset.metadata_updated",
      label: tt("pscl.e94273"),
      subject: "omp.asset.*.metadata_updated",
      inputFields: [
        { path: "assetId", label: tt("pscl.8c7a60") },
        { path: "updatedBy", label: tt("pscl.06464c") },
      ],
    },
    {
      id: "asset.version_created",
      label: tt("pscl.481861"),
      subject: "omp.asset.*.version_created",
      inputFields: [
        { path: "id", label: tt("pscl.3ef4be") },
        { path: "assetId", label: tt("pscl.8c7a60") },
        { path: "versionNumber", label: tt("pscl.668bfa") },
      ],
    },
    {
      id: "asset.version_published",
      label: tt("pscl.f87cf1"),
      subject: "omp.asset.*.version_published",
      inputFields: [
        { path: "assetId", label: tt("pscl.8c7a60") },
        { path: "assetVersionId", label: tt("pscl.3ef4be") },
        { path: "versionNumber", label: tt("pscl.668bfa") },
      ],
    },
  ];
  for (const st of assetStatuses) {
    kinds.push({
      id: `asset.status.${st}`,
      label: tt("pscl.e1ed1e", { p0: statusLabel(st) }),
      subject: `omp.asset.*.${st}`,
      inputFields: ASSET_STATUS_EVENT_FIELDS,
    });
  }
  return kinds;
}

export function triggerKindForSubject(kinds: TriggerKind[], subject: string): TriggerKind | undefined {
  return kinds.find((k) => k.subject === subject);
}

// ---- Variablen-Katalog ------------------------------------------------------------------------

export interface VariableOption {
  path: string; // vollständiger Ausdruckspfad, z. B. outputs.probe.exitCode
  label: string;
  group: string;
}

// ancestorsOf: alle Schritte, von denen aus stepId über next/branches
// erreichbar ist — nur deren Ausgaben können beim Ausführen von stepId
// schon existieren (Kompensationskanten zählen bewusst nicht: sie
// laufen nur im Fehlerfall, s. validate.go).
export function ancestorsOf(def: DraftDefinition, stepId: string): string[] {
  const preds = new Map<string, string[]>();
  for (const s of def.steps) {
    for (const t of [...(s.next ?? []), ...Object.values(s.branches ?? {})]) {
      if (!preds.has(t)) preds.set(t, []);
      preds.get(t)!.push(s.id);
    }
  }
  const seen = new Set<string>();
  const stack = [...(preds.get(stepId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || id === stepId) continue;
    seen.add(id);
    stack.push(...(preds.get(id) ?? []));
  }
  // Graph-Reihenfolge beibehalten (lesbarer als Traversierungs-Reihenfolge).
  return def.steps.map((s) => s.id).filter((id) => seen.has(id));
}

// Ausdrucks-Pfad-Segment: expr-lang erlaubt Punkt-Zugriff nur für
// Bezeichner — Schritt-IDs mit "-"/Leerzeichen brauchen ["…"].
function member(base: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

export function variableOptions(def: DraftDefinition, stepId: string, triggerFields: OutputField[]): VariableOption[] {
  const out: VariableOption[] = [];
  const seenInput = new Set<string>();
  for (const f of triggerFields) {
    if (seenInput.has(f.path)) continue;
    seenInput.add(f.path);
    out.push({ path: member("input", f.path), label: f.label, group: tt("pscl.cedbae") });
  }
  for (const id of ancestorsOf(def, stepId)) {
    const step = def.steps.find((s) => s.id === id)!;
    const name = step.name || id;
    for (const f of outputFieldsFor(step)) {
      out.push({
        path: f.path ? member(member("outputs", id), f.path) : member("outputs", id),
        label: f.label,
        group: tt("pscl.0ac1be", { p0: name, p1: stepTypeLabel(step.type) }),
      });
    }
  }
  out.push(
    { path: "workflow.executionId", label: tt("pscl.b74155"), group: tt("pscl.5657ea") },
    { path: "workflow.correlationId", label: tt("pscl.44923c"), group: tt("pscl.5657ea") },
    { path: "workflow.retryCount", label: tt("pscl.a65a49"), group: tt("pscl.5657ea") },
  );
  return out;
}

// Einfügetext je Feldart: Textfelder mit Platzhaltern (${…}, s.
// executors.go interpolate) vs. reine Ausdrucksfelder (Bedingungen).
export function insertionText(path: string, mode: "template" | "expression"): string {
  return mode === "template" ? "${" + path + "}" : path;
}

// ---- Regel-Baukasten für Bedingungen ----------------------------------------------------------

export const RULE_OPERATORS: { op: string; label: string }[] = [
  { op: "==", label: tt("pscl.4ef614") },
  { op: "!=", label: tt("pscl.d83ad5") },
  { op: ">", label: tt("pscl.7b8174") },
  { op: ">=", label: tt("pscl.a113df") },
  { op: "<", label: tt("pscl.d2c8f8") },
  { op: "<=", label: tt("pscl.c64548") },
  { op: "contains", label: tt("pscl.a4aaeb") },
  { op: "startsWith", label: tt("pscl.460b70") },
];

export interface Rule {
  variable: string;
  op: string;
  value: string;
}

// Wert-Literal: Zahlen/true/false/null unverändert, alles andere als
// String in Anführungszeichen — der Nutzer tippt einfach "approved"
// statt "\"approved\"".
export function valueLiteral(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false" || v === "null") return v;
  return JSON.stringify(value);
}

export function ruleToExpression(r: Rule): string {
  return `${r.variable} ${r.op} ${valueLiteral(r.value)}`;
}

// Rückweg: nur exakt die vom Baukasten erzeugte Form — alles andere ist
// ein frei geschriebener Ausdruck und bleibt im Freitext-Modus.
export function parseRule(expression: string): Rule | null {
  const ops = RULE_OPERATORS.map((o) => o.op).sort((a, b) => b.length - a.length).map((o) => o.replace(/[=!<>]/g, "\\$&"));
  const m = new RegExp(`^\\s*([A-Za-z_][\\w.\\[\\]"-]*)\\s+(${ops.join("|")})\\s+(.+?)\\s*$`).exec(expression);
  if (!m) return null;
  const [, variable, op, lit] = m;
  if (/^-?\d+(\.\d+)?$/.test(lit) || lit === "true" || lit === "false" || lit === "null") return { variable, op, value: lit };
  try {
    const v = JSON.parse(lit);
    if (typeof v === "string") return { variable, op, value: v };
  } catch {
    // kein reines Literal → frei geschriebener Ausdruck
  }
  return null;
}

// ---- Verzweigungs-Namen, die ein Schritt tatsächlich liefert ----------------------------------

export function branchLabelsFor(step: DraftStep | undefined): string[] {
  if (!step) return [];
  const cfg = (step.config ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case "condition":
      return [String(cfg.trueLabel || "true"), String(cfg.falseLabel || "false")];
    case "branch": {
      const cases = Array.isArray(cfg.cases) ? (cfg.cases as { label?: string }[]) : [];
      const labels = cases.map((c) => c.label ?? "").filter(Boolean);
      if (cfg.defaultLabel) labels.push(String(cfg.defaultLabel));
      return [...new Set(labels)];
    }
    case "human_task":
    case "approval":
      return ["approved", "rejected", "changes_requested"];
    default:
      return [];
  }
}

export const DECISION_LABELS: Record<string, string> = {
  approved: "freigegeben",
  rejected: "abgelehnt",
  changes_requested: tt("pscl.dd578a"),
  true: "Ja",
  false: tt("pscl.b397ec"),
};

// ---- Dauern (Wartezeit/Timeout/Retry) ---------------------------------------------------------

export type TimeUnit = "s" | "m" | "h";
export const UNIT_SECONDS: Record<TimeUnit, number> = { s: 1, m: 60, h: 3600 };
export const UNIT_LABEL: Record<TimeUnit, string> = { s: tt("pscl.847202"), m: tt("pscl.2006ff"), h: tt("pscl.f45588") };

// Größte glatte Einheit für die Anzeige (90 → 90 s, 120 → 2 min).
export function splitSeconds(total: number | undefined): { value: string; unit: TimeUnit } {
  if (!total) return { value: "", unit: "s" };
  if (total % 3600 === 0) return { value: String(total / 3600), unit: "h" };
  if (total % 60 === 0) return { value: String(total / 60), unit: "m" };
  return { value: String(total), unit: "s" };
}

export function toSeconds(value: string, unit: TimeUnit): number | undefined | null {
  const t = value.trim().replace(",", ".");
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * UNIT_SECONDS[unit]);
}

// Go-Duration-Strings der RetryPolicy ("2s"/"1m30s") ↔ Sekunden. Nur
// ganze Sekunden/Minuten/Stunden-Kombinationen — alles andere (z. B.
// "500ms") liefert null, das Formular zeigt es dann unverändert als
// Rohwert statt es still zu runden.
export function parseGoDuration(d: string | undefined): number | undefined | null {
  if (!d) return undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d);
  if (!m || d === "") return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

export function formatGoDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? h + "h" : ""}${m ? m + "m" : ""}${s ? s + "s" : ""}`;
}

export function describeRetry(r: RetryPolicy | undefined): string {
  if (!r || r.maxAttempts <= 1) return tt("pscl.5f5c5a");
  return tt("pscl.616a18", { p0: r.maxAttempts, p1: r.backoff === "exponential" ? "zunehmender" : "gleicher" });
}

// ---- Script-Vorlagen (ffmpeg/ffprobe) ---------------------------------------------------------

export interface ScriptTemplate {
  id: string;
  label: string;
  command: string;
  args: string[];
  help: string;
}

// Platzhalter sind bewusst input.*-Felder mit sprechenden Namen — der
// Nutzer ersetzt sie per Variablen-Picker oder beim Start durch echte
// Pfade.
export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "probe",
    label: tt("pscl.b987ca"),
    command: "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "${input.path}"],
    help: tt("pscl.4b6338"),
  },
  {
    id: "proxy",
    label: tt("pscl.ebf39e"),
    command: "ffmpeg",
    args: ["-y", "-i", "${input.path}", "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "128k", "${input.proxyPath}"],
    help: tt("pscl.71816a"),
  },
  {
    id: "thumbnail",
    label: tt("pscl.e0f287"),
    command: "ffmpeg",
    args: ["-y", "-ss", "00:00:05", "-i", "${input.path}", "-frames:v", "1", "-vf", "scale=480:-2", "${input.thumbnailPath}"],
    help: tt("pscl.5ad538"),
  },
  {
    id: "audio",
    label: tt("pscl.e33f6d"),
    command: "ffmpeg",
    args: ["-y", "-i", "${input.path}", "-vn", "-c:a", "pcm_s24le", "-ar", "48000", "${input.audioPath}"],
    help: "48 kHz / 24 Bit PCM.",
  },
];

// ---- ffmpeg-Assistent (UMSETZUNG.md Kapitel 22/23) ----------------------------------------------
//
// Baukasten-Prinzip (ARCHITECTURE.md §26.4, UMSETZUNG.md 22.2): die
// Formulare unten bilden allgemeine ffmpeg-Bausteine ab (Container/Codec
// wählen, AVOptions mit Hilfetext statt Freitext) — KEIN
// szenario-spezifischer Sonderpfad. Ein früherer fünfter Intent
// "Mehrspur-Container bauen" (hart auf das MXF-Nutzerbeispiel
// zugeschnitten) wurde in Kapitel 23 wieder ausgebaut, weil er genau der
// Einzelfall-Sonderpfad war, den §26.4 ausschließen wollte — der Ersatz
// (generisches Ausgabespur-Mapping) ist als Kapitel 23, Schritt 2
// geplant, s. UMSETZUNG.md.
//
// Die tatsächlichen Optionswerte/-listen kommen zur Laufzeit von
// `/api/v1/tools/ffmpeg/...` (orchestrator/internal/ffmpegtools, W1) —
// hier nur die reine, DOM-freie Umsetzung "AVOption → Formularfeld-Art"
// und "ausgefüllte Werte → ffmpeg-Argumente".

// `id` ist bewusst ein einfacher `string` (kein geschlossener Union-Typ
// mehr, s. Kapitel 25 R1): ein per GENERIC_SCRIPT_TASKS (unten)
// registriertes generisches Formular braucht hier nur einen zusätzlichen
// Array-Eintrag, keine Typ-Erweiterung. Die drei weiterhin fest verdrahteten
// Aufgaben (convert/concat/overlay, s. R1-Entscheidung) bleiben eigene
// String-Literale, auf die process-step-config.ts's `switch` reagiert.
export interface ScriptIntent {
  id: string;
  label: string;
  help: string;
}

export const SCRIPT_INTENTS: ScriptIntent[] = [
  { id: "probe", label: tt("pscl.b987ca"), help: tt("pscl.4b6338") },
  { id: "thumbnail", label: tt("pscl.e0f287"), help: tt("pscl.272a13") },
  { id: "convert", label: tt("pscl.44038d"), help: tt("pscl.fef9af") },
  { id: "extract_audio", label: tt("pscl.1d7d40"), help: tt("pscl.7faa8d") },
  { id: "concat", label: tt("pscl.b1e82a"), help: tt("pscl.8f2c02") },
  { id: "overlay", label: tt("pscl.02bf41"), help: tt("pscl.ca9a47") },
  {
    id: "loudnorm",
    label: tt("pscl.c974f8"),
    help: tt("pscl.7cfc14"),
  },
  { id: "remux_copy", label: tt("pscl.eee8e9"), help: tt("pscl.853c91") },
  {
    id: "hls_ladder",
    label: tt("pscl.dcd50a"),
    help: tt("pscl.9e4fd7"),
  },
];

export function scriptIntentById(id: string): ScriptIntent | undefined {
  return SCRIPT_INTENTS.find((i) => i.id === id);
}

// ---- Generische Aufgaben-Registry (Kapitel 25 R1, 2026-09-28) ----------------------------------
//
// Nutzerauftrag: die ffmpeg-Aufgabenliste war "zu hardcoded" — jede neue
// Aufgabe brauchte bisher Änderungen an drei Stellen (Union-Typ, eigene
// `build<X>Args()`-Funktion, eigener DOM-Zweig in process-step-config.ts).
// Ab hier beschreibt sich eine einfache, formularfeld-basierte Aufgabe
// selbst: ein `GenericScriptTask` bündelt seine Formularfelder (deklarativ,
// von einer einzigen generischen Rendering-Funktion — process-step-
// config.ts#buildGenericScriptForm — interpretiert) mit einer reinen
// `toArgs`-Funktion. Eine neue einfache Aufgabe ist damit EIN neuer
// Array-Eintrag unten, keine Änderung an der Rendering-Logik.
//
// Bewusst NICHT hier: `convert`/`concat`/`overlay`. Das sind keine
// "Vorlagen" im eigentlichen Sinn — `convert` ist der generische
// Baukasten-Fluchtweg selbst (Audio-Matrix, Filter-Graph, Ausgabespur-
// Mapping, s. Kapitel 23), `concat`/`overlay` brauchen wiederholbare
// Unterformular-Gruppen mit Sichtbarkeits-Kopplung zwischen Zeilen (Text-
// vs. Bild-Ereignis, Verlustfrei-Häkchen blendet Beschnitt-Felder aus) —
// ein generischer "Gruppen"-Feldtyp dafür ist als eigener Schritt (Kapitel
// 25 R1b) vorgesehen, sobald er an einem zweiten/dritten echten Fall
// (z. B. einer Streaming-Ausgabeleiter mit mehreren Renditionen)
// verifiziert werden kann statt vorab geraten zu sein.
export interface GenericScriptFieldBase {
  id: string;
  label: string;
  help?: string;
  required?: boolean;
}

export interface GenericScriptTemplateTextField extends GenericScriptFieldBase {
  kind: "template-text";
  defaultValue?: string;
  placeholder?: string;
}

export interface GenericScriptTextField extends GenericScriptFieldBase {
  kind: "text";
  defaultValue?: string;
  placeholder?: string;
  numeric?: boolean;
}

export interface GenericScriptCodecPickerField extends GenericScriptFieldBase {
  kind: "codec-picker";
  mediaType: "video" | "audio";
  withOptions?: boolean;
}

export interface GenericScriptFormatPickerField extends GenericScriptFieldBase {
  kind: "format-picker";
  withOptions?: boolean;
}

// "Gruppen"-Feldtyp (Kapitel 25 R4, 2026-09-28) — die in R1 bewusst
// zurückgestellte Erweiterung: eine wiederholbare Liste von Unterzeilen,
// jede Zeile selbst eine flache Liste von Feldern (kein verschachteltes
// `group` — hält den Interpreter einfach, für den ersten echten Anwendungs-
// fall, eine Streaming-Ausgabeleiter mit mehreren Renditionen, reicht
// eine Ebene). Bewusst NICHT für `concat`/`overlay` nachgerüstet — deren
// zeilenübergreifende Sichtbarkeitskopplung (Verlustfrei-Häkchen,
// Text-/Bild-Umschaltung) bräuchte mehr als dieses einfache Wiederholen,
// s. R1-Notiz oben.
export interface GenericScriptGroupField extends GenericScriptFieldBase {
  kind: "group";
  itemFields: GenericScriptField[];
  minItems?: number; // Standard 1
  addLabel: string;
  itemLabel(index: number): string;
}

export type GenericScriptField =
  | GenericScriptTemplateTextField
  | GenericScriptTextField
  | GenericScriptCodecPickerField
  | GenericScriptFormatPickerField
  | GenericScriptGroupField;

// Skalare Feldwerte (template-text/text) sind immer roher, ungetrimmter
// Text — Trimmen/Parsen ist Sache der jeweiligen `toArgs`, dieselbe
// Verantwortungsteilung wie bei den bisherigen `build<X>Args`-Aufrufern.
// Picker-Felder (codec-picker/format-picker) liefern kein einfaches
// String — sie werden separat unter `pickers` geführt statt eine
// Einheitlichkeit vorzutäuschen, die es nicht gibt. `groups` hält je
// `group`-Feld eine Liste von Unterzeilen-Werten (rekursiv derselbe Typ).
export interface GenericScriptFormValues {
  scalars: Record<string, string>;
  pickers: Record<string, { codec?: string; format?: string; options: Record<string, string> }>;
  groups: Record<string, GenericScriptFormValues[]>;
}

export type GenericScriptArgsResult = { ok: true; args: string[] } | { ok: false; error: string };

export interface GenericScriptTask {
  id: string;
  command: "ffmpeg" | "ffprobe";
  fields: GenericScriptField[];
  toArgs(values: GenericScriptFormValues): GenericScriptArgsResult;
}

export const GENERIC_SCRIPT_TASKS: GenericScriptTask[] = [
  {
    id: "probe",
    command: "ffprobe",
    fields: [{ kind: "template-text", id: "inputPath", label: tt("pscl.be80be"), required: true, defaultValue: "${input.path}" }],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      if (!p) return { ok: false, error: tt("pscl.7d7927") };
      return { ok: true, args: buildProbeArgs({ inputPath: p }) };
    },
  },
  {
    id: "thumbnail",
    command: "ffmpeg",
    fields: [
      { kind: "template-text", id: "inputPath", label: tt("pscl.7ddbbe"), required: true, defaultValue: "${input.path}" },
      { kind: "template-text", id: "outputPath", label: tt("pscl.70f1da"), required: true, defaultValue: "${input.thumbnailPath}" },
      { kind: "text", id: "atTime", label: tt("pscl.a0ef65"), defaultValue: "00:00:05", placeholder: "hh:mm:ss", help: "hh:mm:ss, z. B. 00:00:05." },
      { kind: "text", id: "widthPixels", label: tt("pscl.86b066"), defaultValue: "480", placeholder: tt("pscl.08822b"), numeric: true, help: tt("pscl.969a03") },
    ],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      const o = v.scalars.outputPath?.trim();
      const w = Number(v.scalars.widthPixels);
      if (!p || !o) return { ok: false, error: tt("pscl.9205c3") };
      if (!Number.isFinite(w) || w <= 0) return { ok: false, error: tt("pscl.f6dd2b") };
      return { ok: true, args: buildThumbnailArgs({ inputPath: p, outputPath: o, atTime: v.scalars.atTime?.trim() || "00:00:05", widthPixels: w }) };
    },
  },
  {
    id: "extract_audio",
    command: "ffmpeg",
    fields: [
      { kind: "template-text", id: "inputPath", label: tt("pscl.7ddbbe"), required: true, defaultValue: "${input.path}" },
      { kind: "template-text", id: "outputPath", label: tt("pscl.8adabd"), required: true, defaultValue: "${input.audioPath}" },
      { kind: "codec-picker", id: "audio", mediaType: "audio", label: tt("pscl.16202d"), help: tt("pscl.1ea5b7") },
    ],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      const o = v.scalars.outputPath?.trim();
      if (!p || !o) return { ok: false, error: tt("pscl.9205c3") };
      const a = v.pickers.audio;
      return { ok: true, args: buildExtractAudioArgs({ inputPath: p, outputPath: o, audioCodec: a?.codec || undefined, audioOptions: a?.options ?? {} }) };
    },
  },
  {
    id: "loudnorm",
    command: "ffmpeg",
    fields: [
      { kind: "template-text", id: "inputPath", label: tt("pscl.7ddbbe"), required: true, defaultValue: "${input.path}" },
      { kind: "template-text", id: "outputPath", label: tt("pscl.8adabd"), required: true, defaultValue: "${input.outputPath}" },
      {
        kind: "text",
        id: "targetLufs",
        label: tt("pscl.0b9820"),
        defaultValue: "-23",
        numeric: true,
        help: tt("pscl.85ee17"),
      },
      { kind: "text", id: "truePeak", label: tt("pscl.475054"), defaultValue: "-2", numeric: true, help: tt("pscl.d7f1ac") },
      { kind: "text", id: "loudnessRange", label: tt("pscl.0c605b"), defaultValue: "7", numeric: true },
      { kind: "codec-picker", id: "audio", mediaType: "audio", label: tt("pscl.16202d"), help: tt("pscl.749393") },
    ],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      const o = v.scalars.outputPath?.trim();
      if (!p || !o) return { ok: false, error: tt("pscl.9205c3") };
      const lufs = Number(v.scalars.targetLufs);
      const tp = Number(v.scalars.truePeak);
      const lra = Number(v.scalars.loudnessRange);
      if (!Number.isFinite(lufs)) return { ok: false, error: tt("pscl.738fb5") };
      if (!Number.isFinite(tp)) return { ok: false, error: tt("pscl.b46f8d") };
      if (!Number.isFinite(lra) || lra <= 0) return { ok: false, error: tt("pscl.b2cee1") };
      const a = v.pickers.audio;
      return {
        ok: true,
        args: buildLoudnormArgs({ inputPath: p, outputPath: o, targetLufs: lufs, truePeakDb: tp, loudnessRangeLu: lra, audioCodec: a?.codec || undefined, audioOptions: a?.options ?? {} }),
      };
    },
  },
  {
    id: "remux_copy",
    command: "ffmpeg",
    fields: [
      { kind: "template-text", id: "inputPath", label: tt("pscl.7ddbbe"), required: true, defaultValue: "${input.path}" },
      { kind: "template-text", id: "outputPath", label: tt("pscl.8adabd"), required: true, defaultValue: "${input.outputPath}" },
      { kind: "format-picker", id: "format", label: tt("pscl.6bbca5"), withOptions: false, help: tt("pscl.74d4bd") },
    ],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      const o = v.scalars.outputPath?.trim();
      if (!p || !o) return { ok: false, error: tt("pscl.9205c3") };
      const f = v.pickers.format;
      return { ok: true, args: buildRemuxCopyArgs({ inputPath: p, outputPath: o, format: f?.format || undefined }) };
    },
  },
  {
    id: "hls_ladder",
    command: "ffmpeg",
    fields: [
      { kind: "template-text", id: "inputPath", label: tt("pscl.7ddbbe"), required: true, defaultValue: "${input.path}" },
      {
        kind: "template-text",
        id: "outputDir",
        label: tt("pscl.4c7e15"),
        required: true,
        defaultValue: "${input.outputDir}",
        help: tt("pscl.94a565"),
      },
      { kind: "text", id: "segmentSeconds", label: tt("pscl.c93db4"), defaultValue: "6", numeric: true },
      {
        kind: "group",
        id: "renditions",
        label: tt("pscl.f59f69"),
        help: tt("pscl.4cba27"),
        minItems: 2,
        addLabel: "+ weitere Rendition",
        itemLabel: (i) => tt("pscl.475096", { p0: i + 1 }),
        itemFields: [
          { kind: "text", id: "label", label: tt("pscl.49ee30"), defaultValue: "", placeholder: "z. B. 1080p", required: true },
          { kind: "text", id: "width", label: tt("pscl.9a9491"), defaultValue: "1280", numeric: true, required: true },
          { kind: "text", id: "height", label: tt("pscl.cd2da5"), defaultValue: "720", numeric: true, required: true },
          { kind: "text", id: "videoBitrateKbps", label: tt("pscl.64153c"), defaultValue: "2500", numeric: true, required: true },
          { kind: "text", id: "audioBitrateKbps", label: tt("pscl.45845d"), defaultValue: "128", numeric: true, required: true },
        ],
      },
    ],
    toArgs: (v) => {
      const p = v.scalars.inputPath?.trim();
      const dir = v.scalars.outputDir?.trim();
      if (!p || !dir) return { ok: false, error: tt("pscl.d99ff6") };
      const seg = Number(v.scalars.segmentSeconds);
      if (!Number.isFinite(seg) || seg <= 0) return { ok: false, error: tt("pscl.98a492") };
      const rows = v.groups.renditions ?? [];
      if (rows.length === 0) return { ok: false, error: tt("pscl.138685") };
      const renditions: HlsRendition[] = [];
      for (const row of rows) {
        const label = row.scalars.label?.trim();
        const width = Number(row.scalars.width);
        const height = Number(row.scalars.height);
        const videoBitrateKbps = Number(row.scalars.videoBitrateKbps);
        const audioBitrateKbps = Number(row.scalars.audioBitrateKbps);
        if (!label) return { ok: false, error: tt("pscl.cf38a8") };
        if (!/^[A-Za-z0-9-]+$/.test(label)) return { ok: false, error: tt("pscl.d1865d", { p0: label }) };
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return { ok: false, error: tt("pscl.67d2c0", { p0: label }) };
        if (!Number.isFinite(videoBitrateKbps) || videoBitrateKbps <= 0) return { ok: false, error: tt("pscl.754226", { p0: label }) };
        if (!Number.isFinite(audioBitrateKbps) || audioBitrateKbps <= 0) return { ok: false, error: tt("pscl.202bf1", { p0: label }) };
        renditions.push({ label, width, height, videoBitrateKbps, audioBitrateKbps });
      }
      const labels = renditions.map((r) => r.label);
      if (new Set(labels).size !== labels.length) return { ok: false, error: tt("pscl.73802f") };
      return { ok: true, args: buildHlsLadderArgs({ inputPath: p, outputDir: dir, segmentSeconds: seg, renditions }) };
    },
  },
];

export function genericScriptTaskById(id: string): GenericScriptTask | undefined {
  return GENERIC_SCRIPT_TASKS.find((t) => t.id === id);
}

// ---- ffmpeg-Introspektionsdaten (Formen von orchestrator/internal/ffmpegtools) -----------------

export interface FFCodecEntry {
  name: string;
  description: string;
  mediaType: "video" | "audio" | "subtitle" | "";
  flags: string;
}

export interface FFFormatEntry {
  name: string;
  description: string;
  demuxing: boolean;
  muxing: boolean;
}

// Ein Filter aus `/api/v1/tools/ffmpeg/filters` (W1) — `io` ist ffmpegs
// eigene Kurzform ("V->V", "AA->A", "N->N", "|->A"), s.
// `filter-graph-logic.ts::parseFilterIO` (W3).
export interface FFFilterEntry {
  name: string;
  description: string;
  io: string;
  timelineSupport: boolean;
  sliceThreading: boolean;
  commandSupport: boolean;
}

export interface FFOptionChoice {
  name: string;
  value?: string;
  description?: string;
}

export interface FFOption {
  name: string;
  type: string;
  flags: string;
  description?: string;
  default?: string;
  min?: string;
  max?: string;
  choices?: FFOptionChoice[];
}

export interface FFDetail {
  name: string;
  description?: string;
  options: FFOption[];
}

// ---- AVOption → Formularfeld-Art ---------------------------------------------------------------

export type OptionControlKind = "select" | "checkbox" | "number" | "range" | "text";

const NUMERIC_OPTION_TYPES = new Set(["int", "int64", "float", "double", "rational"]);

function isFiniteNumberString(v: string | undefined): v is string {
  return v !== undefined && v !== "" && Number.isFinite(Number(v));
}

export interface OptionRangeBounds {
  min: number;
  max: number;
  step: number;
}

// Nur wenn BEIDE Grenzen von ffmpeg geliefert werden, ergibt ein
// Schieberegler Sinn (Kapitel 23, Schritt 1 — vorher landeten begrenzte
// Zahlenoptionen wie unbegrenzte in einem reinen Textfeld). Schrittweite
// 1 für ganzzahlige Typen, sonst ein feines Hundertstel des Bereichs
// (mind. 0.01) — grob genug für die HTML-Regler-Auflösung, fein genug,
// dass Fließkomma-Bereiche nicht auf ganze Zahlen einrasten.
export function optionRangeBounds(opt: FFOption): OptionRangeBounds | null {
  if (!NUMERIC_OPTION_TYPES.has(opt.type)) return null;
  if (!isFiniteNumberString(opt.min) || !isFiniteNumberString(opt.max)) return null;
  const min = Number(opt.min);
  const max = Number(opt.max);
  if (!(max > min)) return null;
  const step = opt.type === "int" || opt.type === "int64" ? 1 : Math.max((max - min) / 100, 0.01);
  return { min, max, step };
}

// `flags`-Typ-Optionen (Bitmasken, z. B. "+global_header") lassen sich
// KOMBINIEREN ("+"-getrennt) — dafür passt kein exklusives <select>,
// bleibt bewusst Freitext (die Choices erscheinen trotzdem als
// Hilfetext, s. optionHelpText).
export function ffOptionControlKind(opt: FFOption): OptionControlKind {
  if (opt.choices && opt.choices.length > 0 && opt.type !== "flags") return "select";
  if (opt.type === "boolean") return "checkbox";
  if (NUMERIC_OPTION_TYPES.has(opt.type)) return optionRangeBounds(opt) ? "range" : "number";
  return "text";
}

// Zusammengesetzter Hilfetext: Beschreibung + Bereich + Default + (bei
// `flags`-Optionen) die möglichen Werte, da dort kein <select> hilft.
export function optionHelpText(opt: FFOption): string {
  const parts: string[] = [];
  if (opt.description) parts.push(opt.description);
  if (opt.min || opt.max) parts.push(tt("pscl.bf4c3c", { p0: opt.min ?? "…", p1: opt.max ?? "…" }));
  if (opt.default) parts.push(tt("pscl.440a36", { p0: opt.default }));
  if (opt.type === "flags" && opt.choices?.length) {
    parts.push(tt("pscl.cce2fa", { p0: opt.choices[0].name, p1: opt.choices[1]?.name ?? opt.choices[0].name, p2: opt.choices.map((c) => c.name).join(", ") }));
  }
  return parts.join(" — ");
}

// ---- Ausgefüllte Optionswerte → ffmpeg-Argumente -----------------------------------------------
//
// Leer gelassene Felder werden ÜBERSPRUNGEN (kein `-name ""`) — ein
// Wizard-Nutzer, der ein Feld nicht anfasst, bekommt ffmpegs eigenen
// Standardwert, nicht einen künstlich erzwungenen.

export function optionEntriesToArgs(entries: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value === "") continue;
    args.push(name, value);
  }
  return args;
}

export interface ConvertInput {
  inputPath: string;
  outputPath: string;
  format?: string;
  videoCodec?: string;
  videoOptions?: Record<string, string>;
  audioCodec?: string;
  audioOptions?: Record<string, string>;
  // Aus dem visuellen Filter-Builder (Kapitel 22, W3) — `filterComplex`
  // ist die fertige `-filter_complex`-Zeichenkette, `filterOutputLabels`
  // je ein `-map "[label]"` für jeden Ausgang-Knoten des Graphen.
  filterComplex?: string;
  filterOutputLabels?: string[];
  // Ein Filter-Graph kann mehrere Eingänge referenzieren (z. B. `amix`
  // mit drei echten Quelldateien als "0:a"/"1:a"/"2:a") — `inputPath`
  // allein deckt nur Eingabe-Index 0 ab. `additionalInputPaths[0]` wird
  // Index 1, `[1]` Index 2 usw. (W4-Härtetest-Fund: ohne dieses Feld
  // hätte ein Mehrfach-Eingang-Filter-Graph nie echt laufen können, der
  // Assistent hätte stillschweigend ungültige `ffmpeg`-Aufrufe erzeugt).
  additionalInputPaths?: string[];
  // Generisches Ausgabespur-Mapping (Kapitel 23, Schritt 2) — ersetzt
  // inhaltlich, was die in Schritt 1 ausgebaute "Mehrspur-Container
  // bauen"-Sonderfunktion konnte, aber als allgemeiner Baustein:
  // beliebig viele UNABHÄNGIGE Ausgabespuren, deren Quelle ein roher
  // Stream-Spezifizierer ("0:a:0") ODER ein Filter-Graph-/Audio-Matrix-
  // Ausgang ("[mxout0]") sein kann, mit generischer Schlüssel/Wert-
  // Metadaten-Liste (ffmpeg erlaubt beliebige Metadaten-Schlüssel, nicht
  // nur title/language). Wenn gesetzt, ÜBERNIMMT dieses Feld die
  // Stream-Zuordnung VOLLSTÄNDIG (auch von `filterOutputLabels`, s. u.)
  // — kein Vermischen von impliziter und expliziter Zuordnung, das wäre
  // eine der klassischen ffmpeg-Stolperfallen (sobald IRGENDEIN `-map`
  // gesetzt ist, mappt ffmpeg NUR noch explizit angegebene Streams).
  outputTracks?: OutputTrack[];
}

export interface OutputTrack {
  source: string; // z. B. "0:a:0" (roher Stream-Spezifizierer) oder "[mxout0]" (Filter-/Matrix-Ausgang, bereits in eckigen Klammern)
  mediaType: "video" | "audio" | "subtitle";
  codec?: string;
  options?: Record<string, string>;
  metadata?: Record<string, string>;
}

// AVOption-Flags sind ohne Stream-Spezifizierer mehrdeutig, sobald es
// mehr als eine Spur desselben Medientyps gibt (z. B. zwei `-b:a`-Werte
// für zwei Tonspuren) — der Suffix ":<typ>:<n>" ist auch bei nur EINER
// Spur gültige ffmpeg-Syntax, deshalb hier immer angehängt (keine
// Fallunterscheidung nötig).
function trackOptionArgs(options: Record<string, string> | undefined, typeFlag: string, index: number): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === "") continue;
    args.push(`${name}:${typeFlag}:${index}`, value);
  }
  return args;
}

const TRACK_TYPE_FLAG: Record<OutputTrack["mediaType"], string> = { video: "v", audio: "a", subtitle: "s" };

export function buildConvertArgs(input: ConvertInput): string[] {
  const args = ["-y", "-i", input.inputPath];
  for (const p of input.additionalInputPaths ?? []) args.push("-i", p);
  const hasOutputTracks = (input.outputTracks?.length ?? 0) > 0;
  if (input.filterComplex) {
    args.push("-filter_complex", input.filterComplex);
    // Bei aktiven Ausgabespuren übernehmen DEREN `source`-Felder die
    // Zuordnung (auch zu Filter-/Matrix-Ausgängen) — das automatische
    // "jeder Filter-Ausgang wird gemappt" gilt nur im einfachen Modus.
    if (!hasOutputTracks) {
      for (const label of input.filterOutputLabels ?? []) args.push("-map", `[${label}]`);
    }
  }
  if (hasOutputTracks) {
    const counters: Record<string, number> = {};
    for (const t of input.outputTracks!) {
      const typeFlag = TRACK_TYPE_FLAG[t.mediaType];
      const index = counters[typeFlag] ?? 0;
      counters[typeFlag] = index + 1;
      args.push("-map", t.source);
      if (t.codec) args.push(`-c:${typeFlag}:${index}`, t.codec);
      args.push(...trackOptionArgs(t.options, typeFlag, index));
      for (const [key, value] of Object.entries(t.metadata ?? {})) {
        if (!key.trim()) continue;
        args.push(`-metadata:s:${typeFlag}:${index}`, `${key}=${value}`);
      }
    }
  } else {
    if (input.videoCodec) args.push("-c:v", input.videoCodec);
    args.push(...optionEntriesToArgs(input.videoOptions ?? {}));
    if (input.audioCodec) args.push("-c:a", input.audioCodec);
    args.push(...optionEntriesToArgs(input.audioOptions ?? {}));
  }
  if (input.format) args.push("-f", input.format);
  args.push(input.outputPath);
  return args;
}

export interface ExtractAudioInput {
  inputPath: string;
  outputPath: string;
  audioCodec?: string;
  audioOptions?: Record<string, string>;
}

export function buildExtractAudioArgs(input: ExtractAudioInput): string[] {
  const args = ["-y", "-i", input.inputPath, "-vn"];
  if (input.audioCodec) args.push("-c:a", input.audioCodec);
  args.push(...optionEntriesToArgs(input.audioOptions ?? {}));
  args.push(input.outputPath);
  return args;
}

// "Technische Metadaten auslesen"/"Vorschaubild erzeugen" brauchen keine
// ffmpeg-Introspektion (ffprobes JSON-Ausgabe bzw. ein Einzelbild sind
// immer dieselben paar Flags) — trotzdem eigene, strukturierte Felder
// statt freier Argumentliste, damit auch diese beiden Fälle im
// Assistenten (nicht nur im Erweitert-Modus) bedienbar sind.
export interface ProbeInput {
  inputPath: string;
}

export function buildProbeArgs(input: ProbeInput): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input.inputPath];
}

export interface ThumbnailInput {
  inputPath: string;
  outputPath: string;
  atTime: string;
  widthPixels: number;
}

export function buildThumbnailArgs(input: ThumbnailInput): string[] {
  return ["-y", "-ss", input.atTime, "-i", input.inputPath, "-frames:v", "1", "-vf", `scale=${input.widthPixels}:-2`, input.outputPath];
}

// ---- Clips aneinanderhängen (Schnittliste, Kapitel 23 Schritt 2) --------------------------------
//
// Allgemeiner Baustein ("N Dateien in fester Reihenfolge zu einer
// zusammenfügen, je Clip optional beschnitten") — keine Szenario-
// Bindung (kein "Sendungs-Schnittliste"-Sonderformular, funktioniert
// für jede Abfolge beliebiger Clips). Nutzt den `concat`-FILTER (nicht
// den `concat`-Demuxer, der eine separate Listendatei bräuchte, die
// dieser Browser-SPA-Unterbau nicht schreiben kann) — jeder Clip wird
// per `trim`/`atrim` beschnitten und per `setpts`/`asetpts` neu
// referenziert (ffmpegs eigene Empfehlung für den concat-Filter, auch
// ohne expliziten Beschnitt, da sonst Zeitstempel zwischen Segmenten
// nicht sauber anschließen).

export interface ConcatClip {
  inputPath: string;
  trimStart?: string; // ffmpegs Dauer-Syntax, z. B. "5" oder "00:00:05.5"
  trimEnd?: string;
}

export interface ConcatInput {
  outputPath: string;
  format?: string;
  videoCodec?: string;
  videoOptions?: Record<string, string>;
  audioCodec?: string;
  audioOptions?: Record<string, string>;
  clips: ConcatClip[];
  // Verlustfrei (Nachtrag Kapitel 23, Nutzerauftrag "verlustfreies
  // concat"): reines Stream-Copy über ffmpegs concat-PROTOKOLL
  // (`-i "concat:a|b|c" -c copy`) statt der Filterkette oben — kein
  // Neukodieren, keine Qualitätsverluste, aber echte ffmpeg-Grenzen:
  // (1) nur für Container/Codecs zuverlässig, die das concat-Protokoll
  // unterstützt (laut ffmpeg-Doku vor allem MPEG-1/2-PS/VOB und
  // MPEG-TS — NICHT generell MP4/MOV/MKV), (2) das Protokoll kennt
  // KEINEN Beschnitt — pro-Clip `trimStart`/`trimEnd` werden in diesem
  // Modus bewusst ignoriert (Beschnitt + Verlustfreiheit gleichzeitig
  // bräuchte einen zweistufigen Trim-dann-Concat-Ablauf mit
  // Keyframe-genauem Vor-Schnitt je Clip, das ist ein eigener, größerer
  // Baustein — hier bewusst nicht mitgebaut, s. UMSETZUNG.md). Ebenso
  // werden Video-/Audio-Codec-Felder ignoriert (das WÄRE Neukodieren).
  lossless?: boolean;
}

export function buildConcatArgs(input: ConcatInput): string[] {
  if (input.lossless) {
    const args: string[] = ["-y", "-i", `concat:${input.clips.map((c) => c.inputPath).join("|")}`, "-c", "copy"];
    if (input.format) args.push("-f", input.format);
    args.push(input.outputPath);
    return args;
  }
  const args: string[] = ["-y"];
  for (const c of input.clips) args.push("-i", c.inputPath);
  const filterParts: string[] = [];
  input.clips.forEach((c, i) => {
    const trimOpts = [c.trimStart ? `start=${c.trimStart}` : "", c.trimEnd ? `end=${c.trimEnd}` : ""].filter(Boolean).join(":");
    const vTrim = trimOpts ? `trim=${trimOpts},` : "";
    const aTrim = trimOpts ? `atrim=${trimOpts},` : "";
    filterParts.push(`[${i}:v]${vTrim}setpts=PTS-STARTPTS[v${i}]`);
    filterParts.push(`[${i}:a]${aTrim}asetpts=PTS-STARTPTS[a${i}]`);
  });
  const concatInputs = input.clips.map((_, i) => `[v${i}][a${i}]`).join("");
  filterParts.push(`${concatInputs}concat=n=${input.clips.length}:v=1:a=1[outv][outa]`);
  args.push("-filter_complex", filterParts.join(";"), "-map", "[outv]", "-map", "[outa]");
  if (input.videoCodec) args.push("-c:v", input.videoCodec);
  args.push(...optionEntriesToArgs(input.videoOptions ?? {}));
  if (input.audioCodec) args.push("-c:a", input.audioCodec);
  args.push(...optionEntriesToArgs(input.audioOptions ?? {}));
  if (input.format) args.push("-f", input.format);
  args.push(input.outputPath);
  return args;
}

// ---- Zeitgesteuerte Overlays (Senderkennung/Bauchbinde/Abspann, Kapitel 23 Schritt 4) -----------
//
// Allgemeiner Baustein ("N Text-/Bild-Ereignisse, je mit eigenem
// Start/Ende, über ein Video legen") — Text nutzt `drawtext`, ein Bild
// (z. B. Senderlogo) `overlay` mit einer eigenen Bild-Eingabedatei je
// Ereignis; beide über ffmpegs `enable='between(t,start,end)'`
// zeitlich begrenzt. Ereignisse werden der Reihe nach verkettet (jedes
// baut auf dem Video-Label des vorherigen auf), Reihenfolge in der
// Liste = Reihenfolge im Filtergraph (bei Überlappung "zuletzt
// gewinnt oben").

function escapeDrawtextValue(v: string): string {
  // ffmpegs Escaping für drawtext-Optionswerte: Backslash zuerst, dann
  // Doppelpunkt (Optionstrenner) und Hochkomma (String-Begrenzer).
  return v.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface OverlayTextEvent {
  kind: "text";
  text: string;
  startSeconds: number;
  endSeconds: number;
  x?: string;
  y?: string;
  fontSize?: number;
  fontColor?: string;
}

export interface OverlayImageEvent {
  kind: "image";
  imagePath: string;
  startSeconds: number;
  endSeconds: number;
  x?: string;
  y?: string;
}

export type OverlayEvent = OverlayTextEvent | OverlayImageEvent;

export interface OverlayInput {
  inputPath: string;
  outputPath: string;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  events: OverlayEvent[];
}

export function buildOverlayArgs(input: OverlayInput): string[] {
  const args: string[] = ["-y", "-i", input.inputPath];
  const imageInputIndex = new Map<number, number>();
  let nextInputIndex = 1;
  input.events.forEach((e, i) => {
    if (e.kind === "image") {
      args.push("-i", e.imagePath);
      imageInputIndex.set(i, nextInputIndex++);
    }
  });

  let currentLabel = "0:v";
  const filterParts: string[] = [];
  input.events.forEach((e, i) => {
    const outLabel = `v${i}`;
    const enable = `enable='between(t,${e.startSeconds},${e.endSeconds})'`;
    if (e.kind === "text") {
      const parts = [`text='${escapeDrawtextValue(e.text)}'`, `x=${e.x || "(w-text_w)/2"}`, `y=${e.y || "h-text_h-20"}`];
      if (e.fontSize) parts.push(`fontsize=${e.fontSize}`);
      if (e.fontColor) parts.push(`fontcolor=${e.fontColor}`);
      parts.push(enable);
      filterParts.push(`[${currentLabel}]drawtext=${parts.join(":")}[${outLabel}]`);
    } else {
      const imgIdx = imageInputIndex.get(i)!;
      filterParts.push(`[${currentLabel}][${imgIdx}:v]overlay=x=${e.x || "0"}:y=${e.y || "0"}:${enable}[${outLabel}]`);
    }
    currentLabel = outLabel;
  });

  args.push("-filter_complex", filterParts.join(";"), "-map", `[${currentLabel}]`, "-map", "0:a?");
  if (input.videoCodec) args.push("-c:v", input.videoCodec);
  if (input.audioCodec) args.push("-c:a", input.audioCodec);
  if (input.format) args.push("-f", input.format);
  args.push(input.outputPath);
  return args;
}

// ---- Radio/TV/Online-Vorlagen (Kapitel 25 R4, 2026-09-28) --------------------------------------

// Lautheit-Normalisierung (EBU R128 `loudnorm`-Filter) — Pflicht bei
// praktisch jeder Sendeabnahme. Bewusst EINPASS-Modus (dynamisch, misst
// und korrigiert im selben Durchlauf): der präzisere ZWEIPASS-Modus
// bräuchte einen ersten Messlauf, dessen JSON-Ausgabe geparst und als
// `measured_*`-Parameter in einen zweiten Lauf eingespeist wird — ein
// mehrstufiger Ablauf, den ein einzelner `script`-Schritt nicht abbilden
// kann (dieselbe Art Grenze wie beim bewusst nicht gebauten pro-Clip-
// Beschnitt+Verlustfreiheit-Fall, s. Kapitel 23 Nachtrag). Bild wird
// immer unverändert durchgereicht (`-c:v copy`) — der Filter ändert
// ohnehin nur den Ton.
export interface LoudnormInput {
  inputPath: string;
  outputPath: string;
  targetLufs: number;
  truePeakDb: number;
  loudnessRangeLu: number;
  audioCodec?: string;
  audioOptions?: Record<string, string>;
}

export function buildLoudnormArgs(input: LoudnormInput): string[] {
  const args = ["-y", "-i", input.inputPath, "-af", `loudnorm=I=${input.targetLufs}:TP=${input.truePeakDb}:LRA=${input.loudnessRangeLu}`, "-c:v", "copy"];
  if (input.audioCodec) args.push("-c:a", input.audioCodec);
  args.push(...optionEntriesToArgs(input.audioOptions ?? {}));
  args.push(input.outputPath);
  return args;
}

// Verlustfreier Passthrough/Remux — reiner Container-Wechsel ohne
// Neukodierung, der einfachste aller Bausteine hier (`-c copy`).
export interface RemuxCopyInput {
  inputPath: string;
  outputPath: string;
  format?: string;
}

export function buildRemuxCopyArgs(input: RemuxCopyInput): string[] {
  const args = ["-y", "-i", input.inputPath, "-c", "copy"];
  if (input.format) args.push("-f", input.format);
  args.push(input.outputPath);
  return args;
}

// Streaming-Ausgabeleiter (Multi-Bitrate-HLS) — erster echter Anwendungsfall
// des "Gruppen"-Feldtyps (s. GenericScriptGroupField oben). Struktur (Split
// pro Rendition + `-var_stream_map` + `-master_pl_name`) live gegen den
// echten Host-ffmpeg verifiziert (Kapitel 25 R4 unten), nicht geraten.
// Video-Codec `libx264`/Audio-Codec `aac` bewusst fest (nicht je Rendition
// wählbar) — der universell kompatible HLS-Standardfall; wer etwas anderes
// braucht, nutzt den Filter-Graph-Builder/Experten-Modus.
export interface HlsRendition {
  label: string; // wird 1:1 als HLS-Variant-Name UND %v-Verzeichnisname verwendet
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

export interface HlsLadderInput {
  inputPath: string;
  outputDir: string;
  segmentSeconds: number;
  renditions: HlsRendition[];
}

export function buildHlsLadderArgs(input: HlsLadderInput): string[] {
  const n = input.renditions.length;
  const splitLabels = input.renditions.map((_, i) => `v${i}`);
  const filterParts = [`[0:v]split=${n}${splitLabels.map((l) => `[${l}]`).join("")}`];
  input.renditions.forEach((r, i) => {
    filterParts.push(`[v${i}]scale=w=${r.width}:h=${r.height}[v${i}out]`);
  });

  const args = ["-y", "-i", input.inputPath, "-filter_complex", filterParts.join(";")];
  input.renditions.forEach((r, i) => {
    args.push("-map", `[v${i}out]`, `-c:v:${i}`, "libx264", `-b:v:${i}`, `${r.videoBitrateKbps}k`);
  });
  input.renditions.forEach((r, i) => {
    args.push("-map", "0:a", `-c:a:${i}`, "aac", `-b:a:${i}`, `${r.audioBitrateKbps}k`);
  });
  args.push(
    "-var_stream_map",
    input.renditions.map((r, i) => `v:${i},a:${i},name:${r.label}`).join(" "),
    "-master_pl_name",
    "master.m3u8",
    "-f",
    "hls",
    "-hls_time",
    String(input.segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    `${input.outputDir}/%v/seg_%03d.ts`,
    `${input.outputDir}/%v/stream.m3u8`,
  );
  return args;
}

// ---- Pro-Modus: globale ffmpeg-Flags + Validierung/Autovervollständigung (Kapitel 23 Schritt 5) -
//
// `ffmpegtools` (W1) parst bewusst NICHT `-h full` (Scope-Schnitt,
// s. UMSETZUNG.md) — die kleine, stabile Menge global gültiger
// CLI-Flags (nicht codec-/muxer-spezifisch) ist hier deshalb von Hand
// gepflegt, exakt der Teil, den W1 als "klein und stabil" eingestuft
// hatte. Codec-/Muxer-/Filter-spezifische Flags kommen weiterhin
// live von `ffmpegtools` (s. FLAG-Explorer in process-step-config.ts).
export type GlobalFlagType = "boolean" | "time" | "number" | "text" | "select";

export interface GlobalFlagDef {
  name: string;
  type: GlobalFlagType;
  description: string;
  choices?: string[];
}

export const GLOBAL_FFMPEG_FLAGS: GlobalFlagDef[] = [
  { name: "-y", type: "boolean", description: tt("pscl.c55048") },
  { name: "-n", type: "boolean", description: tt("pscl.f464ad") },
  { name: "-hide_banner", type: "boolean", description: tt("pscl.72cb7c") },
  { name: "-loglevel", type: "select", description: tt("pscl.7d0ede"), choices: ["quiet", "panic", "fatal", "error", "warning", "info", "verbose", "debug", "trace"] },
  { name: "-ss", type: "time", description: tt("pscl.041552") },
  { name: "-t", type: "time", description: tt("pscl.3cb7b9") },
  { name: "-to", type: "time", description: tt("pscl.1085b1") },
  { name: "-f", type: "text", description: tt("pscl.f32cca") },
  { name: "-map", type: "text", description: tt("pscl.847d4a") },
  { name: "-vn", type: "boolean", description: tt("pscl.0230a4") },
  { name: "-an", type: "boolean", description: tt("pscl.36692c") },
  { name: "-sn", type: "boolean", description: tt("pscl.39341f") },
  { name: "-dn", type: "boolean", description: tt("pscl.a81aa9") },
  { name: "-c", type: "text", description: tt("pscl.aaf04a") },
  { name: "-c:v", type: "text", description: tt("pscl.748b37") },
  { name: "-c:a", type: "text", description: tt("pscl.76a00d") },
  { name: "-c:s", type: "text", description: tt("pscl.eb5986") },
  { name: "-b:v", type: "text", description: tt("pscl.97d5ed") },
  { name: "-b:a", type: "text", description: tt("pscl.5608df") },
  { name: "-ar", type: "number", description: tt("pscl.93946f") },
  { name: "-ac", type: "number", description: tt("pscl.118fc3") },
  { name: "-r", type: "number", description: tt("pscl.579128") },
  { name: "-s", type: "text", description: tt("pscl.f2e288") },
  { name: "-aspect", type: "text", description: tt("pscl.cce5db") },
  { name: "-vf", type: "text", description: tt("pscl.a86942") },
  { name: "-af", type: "text", description: tt("pscl.1f23d9") },
  { name: "-filter_complex", type: "text", description: tt("pscl.21909e") },
  { name: "-metadata", type: "text", description: tt("pscl.044b6e") },
  { name: "-threads", type: "number", description: tt("pscl.503bf8") },
  { name: "-shortest", type: "boolean", description: tt("pscl.046953") },
  { name: "-movflags", type: "text", description: "MOV/MP4-Muxer-Flags, z. B. \"+faststart\"." },
  { name: "-g", type: "number", description: tt("pscl.03361f") },
  { name: "-bf", type: "number", description: tt("pscl.b70c5f") },
  { name: "-vsync", type: "select", description: tt("pscl.b74742"), choices: ["passthrough", "cfr", "vfr", "drop"] },
];

export function globalFlagByName(name: string): GlobalFlagDef | undefined {
  return GLOBAL_FFMPEG_FLAGS.find((f) => f.name === name);
}

// ---- `-h full`: vollständige globale CLI-Flags vom Server (Kapitel 23, Schritt 5) ---------------
//
// `GLOBAL_FFMPEG_FLAGS` oben ist von Hand kuratiert (~34 Einträge) und
// kennt echte Typen/Auswahllisten (z. B. `-loglevel`s 9 Werte) — Wissen,
// das reiner `-h full`-Fließtext nicht hergibt. Diese Form
// (orchestrator/internal/ffmpegtools::GlobalOption, aus dem in W1
// bewusst ausgelassenen Teil von `-h full`) liefert dafür ALLE
// ~165 globalen/dateiübergreifenden Flags des tatsächlich installierten
// ffmpeg — als Fallback für alles, was die kuratierte Tabelle nicht
// kennt, nicht als deren Ersatz.
export interface FFGlobalOptionEntry {
  name: string;
  arg?: string;
  description?: string;
  section: string;
  hasArg: boolean;
}

export function globalOptionEntryToFlagDef(entry: FFGlobalOptionEntry): GlobalFlagDef {
  return { name: entry.name, type: entry.hasArg ? "text" : "boolean", description: entry.description ?? "" };
}

export interface ArgValidation {
  ok: boolean;
  message?: string;
}

// Validiert EIN Argument-Paar (Flag + evtl. folgender Wert) gegen die
// bekannte Definition — global (Tabelle oben) oder eine im laufenden
// Editor bereits nachgeschlagene AVOption (dynamicOptions, s.
// Parameter-Explorer in process-step-config.ts). Unbekannte Flags
// werden NICHT als Fehler markiert (roher Modus bleibt frei — nicht
// jedes gültige ffmpeg-Flag ist hier oder in ffmpegtools erfasst),
// nur bekannte Flags werden tatsächlich geprüft.
export function validateArgValue(flag: string, value: string, dynamicOptions?: Map<string, FFOption>, globalOverrides?: GlobalFlagDef[]): ArgValidation {
  const dynamic = dynamicOptions?.get(flag);
  if (dynamic) {
    if (value === "") return { ok: true };
    if (dynamic.choices?.length && dynamic.type !== "flags") {
      const ok = dynamic.choices.some((c) => (c.value || c.name) === value);
      return ok ? { ok: true } : { ok: false, message: tt("pscl.53e1fb", { p0: dynamic.choices.map((c) => c.name).join(", ") }) };
    }
    if (dynamic.type === "boolean") {
      return value === "true" || value === "false" ? { ok: true } : { ok: false, message: tt("pscl.9b0b40") };
    }
    const bounds = optionRangeBounds(dynamic);
    if (bounds) {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, message: tt("pscl.13a83c") };
      return n >= bounds.min && n <= bounds.max ? { ok: true } : { ok: false, message: tt("pscl.e2bc00", { p0: bounds.min, p1: bounds.max }) };
    }
    if (dynamic.type === "int" || dynamic.type === "int64" || dynamic.type === "float" || dynamic.type === "double" || dynamic.type === "rational") {
      return Number.isFinite(Number(value)) ? { ok: true } : { ok: false, message: tt("pscl.13a83c") };
    }
    return { ok: true };
  }
  const global = globalFlagByName(flag) ?? globalOverrides?.find((f) => f.name === flag);
  if (!global) return { ok: true };
  if (global.type === "boolean") return value === "" ? { ok: true } : { ok: false, message: tt("pscl.d2383a", { p0: flag }) };
  if (value === "") return { ok: true };
  switch (global.type) {
    case "select":
      return global.choices?.includes(value) ? { ok: true } : { ok: false, message: tt("pscl.53e1fb", { p0: global.choices?.join(", ") }) };
    case "number":
      return Number.isFinite(Number(value)) ? { ok: true } : { ok: false, message: tt("pscl.13a83c") };
    case "time":
      return /^-?(\d+:)?\d{1,2}:\d{1,2}(\.\d+)?$|^-?\d+(\.\d+)?$/.test(value) ? { ok: true } : { ok: false, message: tt("pscl.29c387") };
    default:
      return { ok: true };
  }
}

// ---- Parameter-Suche: Tippfehler-Toleranz (Kapitel 25 R5, 2026-09-28) --------------------------
//
// Der bestehende Parameter-Explorer (process-step-config.ts) fand bisher
// nur exakte Teilzeichenketten-Treffer (`.includes(q)`) — ein einziger
// Tippfehler in einem Flag-/Encoder-Namen (z. B. "libx264" als "libx265"
// vertippt, oder Buchstaben vertauscht wie "sacle" statt "scale") zeigte
// gar keinen Treffer. Fuzzy-Matching gilt bewusst NUR für kurze
// Bezeichner (Flag-/Encoder-/Filter-Namen), nicht für Fließtext-
// Beschreibungen — dort liefert die bestehende Substring-Suche bereits
// sinnvolle Treffer, ein Tippfehler-Abgleich gegen ganze Sätze wäre nur
// Rauschen.
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Editierbudget wächst mit der Anfragelänge, aber begrenzt auf 2 — kurze
// Anfragen (z. B. "-y", "-i") sollen nicht beliebig viele zufällige
// 1-Zeichen-Namen treffen, ein vertipptes 5+-Zeichen-Wort (Transposition
// = 2 Edits in reinem Levenshtein) soll aber gefunden werden.
export function isFuzzyMatch(query: string, candidateName: string, maxDistanceOverride?: number): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const name = candidateName.toLowerCase();
  if (name.includes(q)) return true;
  const maxDistance = maxDistanceOverride ?? (q.length <= 3 ? 1 : 2);
  // Grobe Vorabprüfung erspart den DP-Lauf für offensichtlich zu
  // unterschiedliche Längen (eine Levenshtein-Distanz kann nie kleiner
  // sein als der Längenunterschied).
  if (Math.abs(name.length - q.length) > maxDistance) return false;
  return levenshteinDistance(q, name) <= maxDistance;
}

export interface SearchableEntry<T> {
  name: string;
  description: string;
  value: T;
}

export interface SearchMatch<T> {
  entry: SearchableEntry<T>;
  // true = nur per Tippfehler-Toleranz gefunden (kein exakter Substring-
  // Treffer in Name ODER Beschreibung) — die DOM-Seite markiert das
  // sichtbar (Kapitel 25 R5: "≈"-Badge), damit ein Treffer, der den
  // eingegebenen Text gar nicht enthält, nicht wie ein normaler
  // Substring-Treffer aussieht.
  fuzzy: boolean;
}

// Exakte Substring-Treffer (Name ODER Beschreibung, wie bisher) zuerst,
// danach reine Tippfehler-Treffer (nur Name) — hält das bisherige
// Ranking-Verhalten für alle bestehenden Suchen unverändert und hängt
// Tippfehler-Ergebnisse nur zusätzlich an.
export function searchEntries<T>(query: string, entries: SearchableEntry<T>[], limit?: number): SearchMatch<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: SearchMatch<T>[] = [];
  const fuzzy: SearchMatch<T>[] = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q)) {
      exact.push({ entry, fuzzy: false });
    } else if (isFuzzyMatch(q, entry.name)) {
      fuzzy.push({ entry, fuzzy: true });
    }
  }
  const combined = [...exact, ...fuzzy];
  return limit ? combined.slice(0, limit) : combined;
}

// ---- Schlüssel/Wert-Objekte (Header, Payload, Eingaben) ---------------------------------------

// flatStringObject: nur wenn ALLE Werte Strings sind, lässt sich ein
// Objekt verlustfrei als Schlüssel/Wert-Liste bearbeiten; sonst null
// (das Formular zeigt dann den Erweitert/JSON-Weg).
export function flatStringObject(v: unknown): [string, string][] | null {
  if (v === undefined || v === null) return [];
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.some(([, val]) => typeof val !== "string")) return null;
  return entries as [string, string][];
}

export function pairsToObject(pairs: [string, string][]): Record<string, string> | undefined {
  const obj: Record<string, string> = {};
  for (const [k, v] of pairs) {
    if (k.trim()) obj[k.trim()] = v;
  }
  return Object.keys(obj).length ? obj : undefined;
}

// ---- Vollständigkeit (vor dem Speichern sichtbar machen) --------------------------------------

// Pflichtfelder je Typ, exakt die Fälle, in denen der Executor mit
// "invalid … config" abbricht — ein unvollständiger Schritt wird auf
// der Kachel markiert, statt erst zur Laufzeit zu scheitern.
export function missingConfig(step: DraftStep): string | null {
  const c = (step.config ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case "service_call":
      return c.url ? null : tt("pscl.3c326c");
    case "script":
      return c.command ? null : tt("pscl.4423d3");
    case "media_function":
      return c.instanceId && c.method ? null : tt("pscl.a400c0");
    case "notification":
      return c.subject ? null : tt("pscl.d92700");
    case "condition":
      return c.expression ? null : tt("pscl.bf4504");
    case "branch":
      return Array.isArray(c.cases) && c.cases.length > 0 ? null : tt("pscl.131bec");
    case "subworkflow":
      return c.processDefinitionId ? null : tt("pscl.a9dca0");
    case "wait":
    case "timer":
      return typeof c.seconds === "number" && c.seconds > 0 ? null : tt("pscl.d60d5c");
    default:
      return null;
  }
}
