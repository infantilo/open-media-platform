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
