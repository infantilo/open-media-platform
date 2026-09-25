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
import type { DraftDefinition, DraftStep, RetryPolicy } from "./process-editor-logic.ts";

// ---- Schritt-Typ-Metadaten --------------------------------------------------------------------

export interface StepTypeInfo {
  label: string;
  group: "action" | "flow" | "human";
  help: string;
}

export const STEP_TYPE_INFO: Record<string, StepTypeInfo> = {
  media_function: { label: "Node-Funktion", group: "action", help: "Ruft eine Funktion eines laufenden Microservice auf (z. B. Aufnahme starten, Grafik zeigen)." },
  service_call: { label: "Web-Aufruf (HTTP)", group: "action", help: "Ruft eine Web-Adresse auf (REST-API eines anderen Systems)." },
  script: { label: "Datei-Werkzeug (ffmpeg)", group: "action", help: "Führt ein freigegebenes Werkzeug wie ffmpeg/ffprobe aus — z. B. Proxy erzeugen, Metadaten auslesen." },
  notification: { label: "Benachrichtigung", group: "action", help: "Sendet eine Nachricht auf den Ereignisbus, auf die andere Systeme reagieren können." },
  subworkflow: { label: "Unterprozess", group: "action", help: "Startet einen anderen Prozess und wartet, bis er fertig ist." },
  condition: { label: "Wenn … dann", group: "flow", help: "Prüft eine Regel und verzweigt in einen Ja- oder Nein-Weg." },
  branch: { label: "Verteiler (mehrere Fälle)", group: "flow", help: "Prüft mehrere Regeln der Reihe nach und nimmt den Weg des ersten zutreffenden Falls." },
  parallel: { label: "Parallel aufteilen", group: "flow", help: "Startet alle verbundenen Folgeschritte gleichzeitig." },
  join: { label: "Zusammenführen", group: "flow", help: "Wartet, bis alle eingehenden Wege angekommen sind." },
  wait: { label: "Warten", group: "flow", help: "Pausiert den Ablauf für eine feste Zeit." },
  timer: { label: "Timer", group: "flow", help: "Wie „Warten“: läuft nach Ablauf der Zeit weiter." },
  human_task: { label: "Aufgabe für Person", group: "human", help: "Legt eine Aufgabe an, die eine Person erledigen muss, bevor es weitergeht." },
  approval: { label: "Freigabe", group: "human", help: "Eine Person gibt frei, lehnt ab oder fordert Änderungen an — je Ergebnis ein eigener Weg." },
  task: { label: "Task (generisch)", group: "action", help: "Platzhalter ohne eingebaute Ausführung." },
  loop: { label: "Schleife", group: "flow", help: "Noch nicht ausführbar." },
  event_trigger: { label: "Auf Ereignis warten", group: "flow", help: "Noch nicht ausführbar — Prozess-Start durch Ereignisse über „Auslöser“ in der Werkzeugleiste." },
  compensation: { label: "Kompensation", group: "action", help: "Noch nicht ausführbar." },
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
        { path: "status", label: "HTTP-Status (z. B. 200)" },
        { path: "body", label: "Antwort (Inhalt)" },
      ];
    case "script":
      return [
        { path: "exitCode", label: "Exit-Code (0 = ok)" },
        { path: "stdout", label: "Ausgabe (stdout)" },
        { path: "stderr", label: "Fehlerausgabe (stderr)" },
      ];
    case "human_task":
    case "approval":
      return [
        { path: "decision", label: "Entscheidung" },
        { path: "comment", label: "Kommentar" },
        { path: "assignee", label: "Bearbeitet von" },
      ];
    case "condition":
    case "branch":
      return [{ path: "decision", label: "Gewählter Weg" }];
    case "media_function":
    case "subworkflow":
      return [{ path: "", label: "Ergebnis (gesamt)" }];
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
  { path: "assetId", label: "Asset-ID" },
  { path: "status", label: "Neuer Status" },
  { path: "updatedBy", label: "Geändert von" },
];

export function triggerKinds(assetStatuses: string[], statusLabel: (s: string) => string): TriggerKind[] {
  const kinds: TriggerKind[] = [
    {
      id: "asset.created",
      label: "Asset wurde angelegt",
      subject: "omp.asset.*.created",
      inputFields: [
        { path: "id", label: "Asset-ID" },
        { path: "title", label: "Titel" },
        { path: "type", label: "Typ" },
      ],
    },
    {
      id: "asset.metadata_updated",
      label: "Asset-Metadaten wurden geändert",
      subject: "omp.asset.*.metadata_updated",
      inputFields: [
        { path: "assetId", label: "Asset-ID" },
        { path: "updatedBy", label: "Geändert von" },
      ],
    },
    {
      id: "asset.version_created",
      label: "Asset-Version wurde angelegt",
      subject: "omp.asset.*.version_created",
      inputFields: [
        { path: "id", label: "Versions-ID" },
        { path: "assetId", label: "Asset-ID" },
        { path: "versionNumber", label: "Versionsnummer" },
      ],
    },
    {
      id: "asset.version_published",
      label: "Asset-Version wurde veröffentlicht",
      subject: "omp.asset.*.version_published",
      inputFields: [
        { path: "assetId", label: "Asset-ID" },
        { path: "assetVersionId", label: "Versions-ID" },
        { path: "versionNumber", label: "Versionsnummer" },
      ],
    },
  ];
  for (const st of assetStatuses) {
    kinds.push({
      id: `asset.status.${st}`,
      label: `Asset wechselt auf „${statusLabel(st)}“`,
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
    out.push({ path: member("input", f.path), label: f.label, group: "Start-Eingabe / auslösendes Ereignis" });
  }
  for (const id of ancestorsOf(def, stepId)) {
    const step = def.steps.find((s) => s.id === id)!;
    const name = step.name || id;
    for (const f of outputFieldsFor(step)) {
      out.push({
        path: f.path ? member(member("outputs", id), f.path) : member("outputs", id),
        label: f.label,
        group: `Ergebnis von „${name}“ (${stepTypeLabel(step.type)})`,
      });
    }
  }
  out.push(
    { path: "workflow.executionId", label: "ID dieses Prozesslaufs", group: "Prozesslauf" },
    { path: "workflow.correlationId", label: "Korrelations-ID", group: "Prozesslauf" },
    { path: "workflow.retryCount", label: "Anzahl bisheriger Wiederholungen", group: "Prozesslauf" },
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
  { op: "==", label: "ist gleich" },
  { op: "!=", label: "ist nicht gleich" },
  { op: ">", label: "ist größer als" },
  { op: ">=", label: "ist mindestens" },
  { op: "<", label: "ist kleiner als" },
  { op: "<=", label: "ist höchstens" },
  { op: "contains", label: "enthält" },
  { op: "startsWith", label: "beginnt mit" },
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
  changes_requested: "Änderungen angefordert",
  true: "Ja",
  false: "Nein",
};

// ---- Dauern (Wartezeit/Timeout/Retry) ---------------------------------------------------------

export type TimeUnit = "s" | "m" | "h";
export const UNIT_SECONDS: Record<TimeUnit, number> = { s: 1, m: 60, h: 3600 };
export const UNIT_LABEL: Record<TimeUnit, string> = { s: "Sekunden", m: "Minuten", h: "Stunden" };

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
  if (!r || r.maxAttempts <= 1) return "keine Wiederholung";
  return `bis zu ${r.maxAttempts} Versuche, ${r.backoff === "exponential" ? "zunehmender" : "gleicher"} Abstand`;
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
    label: "Technische Metadaten auslesen",
    command: "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "${input.path}"],
    help: "Liefert Codec, Auflösung, Dauer usw. als JSON im Ergebnis-Feld „Ausgabe (stdout)“.",
  },
  {
    id: "proxy",
    label: "Proxy erzeugen (H.264, 960 px breit)",
    command: "ffmpeg",
    args: ["-y", "-i", "${input.path}", "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "128k", "${input.proxyPath}"],
    help: "Kleine Sichtungskopie der Quelldatei.",
  },
  {
    id: "thumbnail",
    label: "Vorschaubild erzeugen",
    command: "ffmpeg",
    args: ["-y", "-ss", "00:00:05", "-i", "${input.path}", "-frames:v", "1", "-vf", "scale=480:-2", "${input.thumbnailPath}"],
    help: "Einzelbild bei Sekunde 5, 480 px breit.",
  },
  {
    id: "audio",
    label: "Tonspur als WAV extrahieren",
    command: "ffmpeg",
    args: ["-y", "-i", "${input.path}", "-vn", "-c:a", "pcm_s24le", "-ar", "48000", "${input.audioPath}"],
    help: "48 kHz / 24 Bit PCM.",
  },
];

// ---- ffmpeg-Assistent (UMSETZUNG.md Kapitel 22, W2) --------------------------------------------
//
// Baukasten-Prinzip (22.2): die Formulare unten bilden allgemeine
// ffmpeg-Bausteine ab (Container/Codec wählen, AVOptions mit Hilfetext
// statt Freitext, wiederholbare Tonspur-Gruppen) — KEIN
// szenario-spezifischer Sonderpfad. "Mehrspur-Container bauen" deckt
// das Nutzerbeispiel ("MXF mit 8 Tonspuren + TTS-Kennungen je Spur")
// bereits vollständig ab, ohne dass MXF hier irgendwo als Sonderfall
// vorkommt — nur eine von vielen möglichen Container-Wahlen.
//
// Die tatsächlichen Optionswerte/-listen kommen zur Laufzeit von
// `/api/v1/tools/ffmpeg/...` (orchestrator/internal/ffmpegtools, W1) —
// hier nur die reine, DOM-freie Umsetzung "AVOption → Formularfeld-Art"
// und "ausgefüllte Werte → ffmpeg-Argumente".

// `id` verdoppelt bewusst als Diskriminator (kein separates `kind`-Feld)
// — die DOM-Seite (process-step-config.ts) schaltet direkt per `id`
// auf den passenden Unterformular-Baustein.
export interface ScriptIntent {
  id: "probe" | "thumbnail" | "convert" | "extract_audio" | "multitrack";
  label: string;
  help: string;
}

export const SCRIPT_INTENTS: ScriptIntent[] = [
  { id: "probe", label: "Technische Metadaten auslesen", help: "Liefert Codec, Auflösung, Dauer usw. als JSON im Ergebnis-Feld „Ausgabe (stdout)“." },
  { id: "thumbnail", label: "Vorschaubild erzeugen", help: "Einzelbild aus einem Video, z. B. für eine Vorschaukachel." },
  { id: "convert", label: "Format/Codec konvertieren", help: "Container, Video-/Audio-Codec und deren Einstellungen frei wählen — mit echten erlaubten Werten und Hilfetexten von diesem Server." },
  { id: "extract_audio", label: "Tonspur extrahieren", help: "Nur den Ton einer Datei speichern, mit frei wählbarem Audio-Codec." },
  {
    id: "multitrack",
    label: "Mehrspur-Container bauen",
    help: "Mehrere Dateien (z. B. je eine Sprachfassung) zu EINER Ausgabedatei mit mehreren Tonspuren zusammenführen — Container, Codec und Titel/Sprache je Spur frei wählbar.",
  },
];

export function scriptIntentById(id: string): ScriptIntent | undefined {
  return SCRIPT_INTENTS.find((i) => i.id === id);
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

export type OptionControlKind = "select" | "checkbox" | "number" | "text";

// `flags`-Typ-Optionen (Bitmasken, z. B. "+global_header") lassen sich
// KOMBINIEREN ("+"-getrennt) — dafür passt kein exklusives <select>,
// bleibt bewusst Freitext (die Choices erscheinen trotzdem als
// Hilfetext, s. optionHelpText).
export function ffOptionControlKind(opt: FFOption): OptionControlKind {
  if (opt.choices && opt.choices.length > 0 && opt.type !== "flags") return "select";
  if (opt.type === "boolean") return "checkbox";
  if (opt.type === "int" || opt.type === "int64" || opt.type === "float" || opt.type === "double" || opt.type === "rational") return "number";
  return "text";
}

// Zusammengesetzter Hilfetext: Beschreibung + Bereich + Default + (bei
// `flags`-Optionen) die möglichen Werte, da dort kein <select> hilft.
export function optionHelpText(opt: FFOption): string {
  const parts: string[] = [];
  if (opt.description) parts.push(opt.description);
  if (opt.min || opt.max) parts.push(`Bereich: ${opt.min ?? "…"} bis ${opt.max ?? "…"}`);
  if (opt.default) parts.push(`Standard: ${opt.default}`);
  if (opt.type === "flags" && opt.choices?.length) {
    parts.push(`Mögliche Werte (kombinierbar mit "+", z. B. ${opt.choices[0].name}+${opt.choices[1]?.name ?? opt.choices[0].name}): ${opt.choices.map((c) => c.name).join(", ")}`);
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
}

export function buildConvertArgs(input: ConvertInput): string[] {
  const args = ["-y", "-i", input.inputPath];
  for (const p of input.additionalInputPaths ?? []) args.push("-i", p);
  if (input.filterComplex) {
    args.push("-filter_complex", input.filterComplex);
    for (const label of input.filterOutputLabels ?? []) args.push("-map", `[${label}]`);
  }
  if (input.videoCodec) args.push("-c:v", input.videoCodec);
  args.push(...optionEntriesToArgs(input.videoOptions ?? {}));
  if (input.audioCodec) args.push("-c:a", input.audioCodec);
  args.push(...optionEntriesToArgs(input.audioOptions ?? {}));
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

// Eine Tonspur der Mehrspur-Gruppe — bewusst NUR Codec+Titel+Sprache
// (kein volles AVOptions-Panel je Spur, das würde bei z. B. 8 Spuren
// den Assistenten sprengen); tiefere Codec-Einstellungen bleiben "Format
// konvertieren" bzw. dem Erweitert-Modus vorbehalten.
export interface MultitrackTrack {
  inputPath: string;
  codec?: string;
  language?: string;
  title?: string;
}

export interface MultitrackInput {
  outputPath: string;
  format?: string;
  muxerOptions?: Record<string, string>;
  // Eigene, von den Tonspuren UNABHÄNGIGE Bildquelle — z. B. ein
  // Testbild oder eine echte Aufzeichnung. WICHTIG für Container wie
  // MXF, deren OP1a-Muxer zwingend eine Bildspur verlangt (live
  // gefunden, s. UMSETZUNG.md Kapitel 22 W2-Status). Bewusst NICHT
  // "die erste Tonspur liefert auch das Bild" (frühere Fassung, per
  // W4-Härtetest als Baukasten-Lücke gefunden — eine Tonspur ist eine
  // Tonspur, eine Bildquelle ein eigener, unabhängiger Baustein).
  videoSourcePath?: string;
  // Ohne Angabe: `-c:v copy` (unverändert übernehmen). Live per W4-
  // Härtetest gefunden: reines Stream-Copy einer H.264-Quelle in einen
  // MXF-Container schlägt bei diesem ffmpeg-Build fehl ("Received
  // non-video packet before header has been written") — mit einem
  // echten Encoder (z. B. mpeg2video) lief derselbe Aufbau anstandslos.
  // Eine feste Bildquelle ohne wählbaren Codec wäre also KEIN
  // vollständiger Baustein gewesen — genau die Art Lücke, die W4 finden
  // und beheben soll, nicht umgehen.
  videoCodec?: string;
  tracks: MultitrackTrack[];
}

// Jede Spur kommt aus einer EIGENEN Eingabedatei (z. B. acht separate
// Sprachfassungen) statt aus mehreren Kanälen einer einzigen Datei —
// deckt das Nutzerbeispiel direkt ab, ohne einen Sonderfall für "eine
// Mehrkanaldatei aufteilen" zu brauchen (der ließe sich bei Bedarf
// später als zusätzliche Track-Quellart ergänzen, s. UMSETZUNG.md W4).
export function buildMultitrackArgs(input: MultitrackInput): string[] {
  const args: string[] = ["-y"];
  if (input.videoSourcePath) args.push("-i", input.videoSourcePath);
  for (const t of input.tracks) args.push("-i", t.inputPath);
  // Die Bildquelle (falls gesetzt) ist IMMER die erste `-i`-Eingabe —
  // Tonspur-Eingaben rutschen dadurch um eins nach hinten, ihre
  // AUSGANGS-Stream-Indizes (":a:N" für Codec/Metadaten) bleiben davon
  // unberührt, da die nur die Reihenfolge unter den Audio-Streams
  // zählen, nicht die Eingabedatei-Nummer.
  const audioInputOffset = input.videoSourcePath ? 1 : 0;
  if (input.videoSourcePath) args.push("-map", "0:v", "-c:v", input.videoCodec || "copy");
  input.tracks.forEach((_, i) => args.push("-map", `${i + audioInputOffset}:a`));
  input.tracks.forEach((t, i) => {
    if (t.codec) args.push(`-c:a:${i}`, t.codec);
    if (t.title) args.push(`-metadata:s:a:${i}`, `title=${t.title}`);
    if (t.language) args.push(`-metadata:s:a:${i}`, `language=${t.language}`);
  });
  args.push(...optionEntriesToArgs(input.muxerOptions ?? {}));
  if (input.format) args.push("-f", input.format);
  args.push(input.outputPath);
  return args;
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
      return c.url ? null : "Adresse (URL) fehlt";
    case "script":
      return c.command ? null : "Werkzeug fehlt";
    case "media_function":
      return c.instanceId && c.method ? null : "Node/Funktion fehlt";
    case "notification":
      return c.subject ? null : "Kanal fehlt";
    case "condition":
      return c.expression ? null : "Regel fehlt";
    case "branch":
      return Array.isArray(c.cases) && c.cases.length > 0 ? null : "mindestens ein Fall nötig";
    case "subworkflow":
      return c.processDefinitionId ? null : "Prozess fehlt";
    case "wait":
    case "timer":
      return typeof c.seconds === "number" && c.seconds > 0 ? null : "Wartezeit fehlt";
    default:
      return null;
  }
}
