// Schritt-Konfigurations-Dialog des Prozess-Editors (Nachtrag 270) —
// ersetzt das frühere "Config als JSON"-Textfeld durch ein Formular je
// Schritt-Typ. Nutzerauftrag 2026-09-23: JSON nur noch als Ausnahme/
// erweiterte Eingabe; der Nutzer soll sehen, welche Werte und Variablen
// es überhaupt gibt.
//
// Aufbau: ein Formular-Baustein je Typ (#build…), jeder liefert
// read() → {ok, config} und startet von einer KOPIE der bisherigen
// Config — unbekannte, per JSON gesetzte Zusatzfelder bleiben so beim
// Speichern über das Formular erhalten. "Erweitert (JSON)" am Ende zeigt
// die aktuelle Formular-Config als JSON; solange es geöffnet ist, gilt
// das JSON (explizit angezeigt, kein stilles Zusammenführen).
//
// Die gesamte Fachlogik (Variablen-Katalog, Regel-Baukasten, Dauern,
// Pflichtfelder) liegt DOM-frei in process-step-config-logic.ts.
import { t as tt } from "../shell/i18n.ts";
import { apiFetch } from "../shell/connection.ts";
import { fetchFFmpegDetail, fetchFFmpegList } from "./ffmpeg-client.ts";
import { showToast } from "../kit/omp-toast.ts";
import type { DraftDefinition, DraftStep, RetryPolicy } from "./process-editor-logic.ts";
import type { Point } from "./geometry.ts";
import type { FilterGraph } from "./filter-graph-logic.ts";
import { openFilterGraphEditor } from "./filter-graph.ts";
import { openAudioMatrixEditor } from "./audio-matrix.ts";
import type { AudioMatrixCell } from "./audio-matrix-logic.ts";
import {
  buildConcatArgs,
  buildConvertArgs,
  buildOverlayArgs,
  DECISION_LABELS,
  ffOptionControlKind,
  type FFCodecEntry,
  type FFDetail,
  type FFFormatEntry,
  type FFFilterEntry,
  type FFOption,
  type FFGlobalOptionEntry,
  flatStringObject,
  formatGoDuration,
  genericScriptTaskById,
  type GenericScriptField,
  type GenericScriptFormValues,
  type GenericScriptTask,
  GLOBAL_FFMPEG_FLAGS,
  globalFlagByName,
  type GlobalFlagDef,
  globalOptionEntryToFlagDef,
  insertionText,
  optionHelpText,
  optionRangeBounds,
  type OutputTrack,
  type OverlayEvent,
  pairsToObject,
  parseGoDuration,
  parseRule,
  RULE_OPERATORS,
  ruleToExpression,
  searchEntries,
  SCRIPT_INTENTS,
  SCRIPT_TEMPLATES,
  splitSeconds,
  STEP_TYPE_INFO,
  stepTypeLabel,
  type TimeUnit,
  toSeconds,
  UNIT_LABEL,
  validateArgValue,
  type VariableOption,
  variableOptions,
  type OutputField,
} from "./process-step-config-logic.ts";

// ---- Pro-Modus: vollständiger Parameter-Index (Kapitel 23, Schritt 5) --------------------------
//
// "Jeder Parameter muss im Pro-Modus suchbar sein" — Suche nur über die
// Encoder-/Decoder-/Muxer-/Demuxer-/Filter-NAMEN (wie in `codecPicker`/
// `formatPicker`) fände z. B. "-crf" nicht, solange niemand `libx264`
// vorher aufgeklappt hat. Deshalb hier ein EINMALIGER (nicht pro
// Dialog-Öffnung), progressiver Hintergrund-Import aller AVOptions
// aller Encoder/Decoder/Muxer/Demuxer/Filter dieses Servers — Modul-
// weiter Zustand (überlebt Schließen/Neuöffnen des Dialogs innerhalb
// derselben Seite), begrenzte Nebenläufigkeit (kein Ansturm von
// hunderten gleichzeitigen Anfragen), `onProgress` lässt eine offene
// Suche live nachziehen, während der Index noch wächst. Der Server
// selbst cacht jede Detail-Antwort ohnehin pro Prozesslaufzeit
// (`ffmpegtools`, W1) — dieser Import macht daraus einmalig einen
// vollständig DURCHSUCHBAREN Katalog statt nur einzeln abrufbarer
// Einträge.
interface IndexedOption {
  flag: string;
  description: string;
  source: string; // z. B. "libx264 (Encoder)"
  opt: FFOption;
}
let fullOptionIndex: IndexedOption[] = [];
let fullOptionIndexReady = false;
let fullOptionIndexStarted = false;

async function ensureFullOptionIndex(onProgress: () => void): Promise<void> {
  if (fullOptionIndexStarted) return;
  fullOptionIndexStarted = true;
  const [encoders, decoders, formats, filters] = await Promise.all([
    fetchFFmpegList<FFCodecEntry>("encoders"),
    fetchFFmpegList<FFCodecEntry>("decoders"),
    fetchFFmpegList<FFFormatEntry>("formats"),
    fetchFFmpegList<FFFilterEntry>("filters"),
  ]);
  const entities: { kind: "encoder" | "decoder" | "muxer" | "demuxer" | "filter"; name: string; label: string }[] = [
    ...encoders.map((c) => ({ kind: "encoder" as const, name: c.name, label: `${c.name} (Encoder)` })),
    ...decoders.map((c) => ({ kind: "decoder" as const, name: c.name, label: `${c.name} (Decoder)` })),
    ...formats.filter((f) => f.muxing).map((f) => ({ kind: "muxer" as const, name: f.name, label: `${f.name} (Muxer)` })),
    ...formats.filter((f) => f.demuxing).map((f) => ({ kind: "demuxer" as const, name: f.name, label: `${f.name} (Demuxer)` })),
    ...filters.map((f) => ({ kind: "filter" as const, name: f.name, label: `${f.name} (Filter)` })),
  ];
  const CONCURRENCY = 8;
  let cursor = 0;
  let processedSinceProgress = 0;
  const worker = async () => {
    while (cursor < entities.length) {
      const entity = entities[cursor++];
      const detail = await fetchFFmpegDetail(entity.kind, entity.name);
      for (const opt of detail?.options ?? []) {
        fullOptionIndex.push({ flag: opt.name, description: opt.description ?? "", source: entity.label, opt });
      }
      processedSinceProgress++;
      if (processedSinceProgress >= 15) {
        processedSinceProgress = 0;
        onProgress();
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  fullOptionIndexReady = true;
  onProgress();
}

// Globale/dateiübergreifende CLI-Flags aus `ffmpeg -h full` (Kapitel
// 23, Schritt 5 — der in W1 bewusst ausgelassene Scope-Schnitt, jetzt
// nachgezogen). Nur EIN Listen-Request (nicht hunderte wie beim
// AVOption-Index oben) — `fetchFFmpegList` cacht ohnehin je `which`,
// dieses Modul hält zusätzlich die schon in `GlobalFlagDef` konvertierte
// Form vor, damit `validateArgValue`/die Autovervollständigung sie ohne
// erneute Konvertierung nutzen können.
let fetchedGlobalFlagDefs: GlobalFlagDef[] = [];
let globalFlagsLoaded = false;

async function ensureGlobalFlags(onLoaded: () => void): Promise<void> {
  if (globalFlagsLoaded) return;
  const entries = await fetchFFmpegList<FFGlobalOptionEntry>("global-options");
  fetchedGlobalFlagDefs = entries.map(globalOptionEntryToFlagDef);
  globalFlagsLoaded = true;
  onLoaded();
}

// Nachschlagen über BEIDE Quellen — kuratiert (bessere Typisierung,
// z. B. `-loglevel`s Auswahlliste) zuerst, der vollständige `-h full`-
// Import als Fallback für alles, was die kuratierte Tabelle nicht kennt.
function lookupGlobalFlag(name: string): GlobalFlagDef | undefined {
  return globalFlagByName(name) ?? fetchedGlobalFlagDefs.find((f) => f.name === name);
}

export interface StepConfigContext {
  def: DraftDefinition;
  stepId: string;
  scriptCommands: string[];
  triggerFields: OutputField[]; // Felder der konfigurierten Auslöser → input.*
}

export interface StepConfigResult {
  name?: string;
  config?: unknown;
  retry?: RetryPolicy;
  timeoutSeconds?: number;
  compensationStepId?: string;
}

type ReadResult = { ok: true; config: Record<string, unknown> | undefined } | { ok: false; error: string };

interface FormPart {
  el: HTMLElement;
  read(): ReadResult;
}

// ---- kleine DOM-Helfer --------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const HELP_CSS = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";

function field(label: string, control: HTMLElement, help?: string, required = false): HTMLElement {
  const wrap = h("label", "display:flex;flex-direction:column;gap:2px;margin-top:8px;");
  const l = h("span", HELP_CSS + "font-weight:600;", label + (required ? " *" : ""));
  wrap.append(l, control);
  if (help) wrap.appendChild(h("span", HELP_CSS, help));
  return wrap;
}

// Kleine Pill-Badge (Kapitel 25 R5) — ersetzt die bisherigen
// Klartext-Suffixe wie "(Encoder)" im Parameter-Explorer durch das
// bereits bestehende `.omp-badge`-System (design-tokens.css), statt
// erneut Ad-hoc-Inline-Farben zu erfinden. `variant: "cue"` markiert
// einen reinen Tippfehler-Treffer (kein exakter Substring) sichtbar.
function categoryBadge(text: string, variant?: "cue"): HTMLElement {
  const b = h("span", "margin-left:6px;", text);
  b.className = variant === "cue" ? "omp-badge omp-badge-cue" : "omp-badge";
  return b;
}

function textInput(value = "", placeholder = "", name = ""): HTMLInputElement {
  const i = h("input", "width:100%;box-sizing:border-box;");
  i.value = value;
  i.placeholder = placeholder;
  if (name) i.name = name;
  return i;
}

function select(options: { value: string; label: string }[], value = "", name = ""): HTMLSelectElement {
  const s = h("select", "width:100%;box-sizing:border-box;");
  if (name) s.name = name;
  for (const o of options) {
    const opt = h("option", "", o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  s.value = value;
  return s;
}

function section(title: string): HTMLElement {
  const sec = h("div", "margin-top:14px;padding-top:8px;border-top:1px solid var(--omp-border);");
  sec.appendChild(h("div", "font-weight:600;", title));
  return sec;
}

function setOrDelete(obj: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete obj[key];
  else obj[key] = value;
}

// ---- Variablen-Picker -------------------------------------------------------------------------

// Knopf "{x} Variable", öffnet eine durchsuchbare, gruppierte Liste der
// an dieser Stelle tatsächlich verfügbaren Werte; fügt an der
// Cursorposition des Zielfelds ein (Textfelder: ${…}, Regeln: nackter Pfad).
function variableButton(
  options: VariableOption[],
  mode: "template" | "expression",
  target: () => HTMLInputElement | HTMLTextAreaElement,
  onInserted?: () => void,
): HTMLButtonElement {
  const btn = h("button", "white-space:nowrap;", "{x} Variable");
  btn.type = "button";
  btn.title = tt("psc.a03494");
  btn.setAttribute("data-role", "variable-picker");
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    openVariablePopover(btn, options, (path) => {
      const input = target();
      const text = insertionText(path, mode);
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + text.length, start + text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      onInserted?.();
    });
  });
  return btn;
}

function openVariablePopover(anchor: HTMLElement, options: VariableOption[], onPick: (path: string) => void) {
  document.querySelector("[data-role=variable-popover]")?.remove();
  const pop = h(
    "div",
    "position:fixed;z-index:3000;width:380px;max-height:360px;overflow:auto;padding:6px;",
  );
  pop.className = "omp-popover";
  pop.setAttribute("data-role", "variable-popover");
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 390))}px`;
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 370)}px`;

  const search = textInput("", tt("psc.98ceeb"));
  pop.appendChild(search);
  const list = h("div", "margin-top:4px;");
  pop.appendChild(list);

  const custom = h("div", "display:flex;gap:4px;margin-top:6px;padding-top:6px;border-top:1px solid var(--omp-border);");
  const customInput = textInput("", tt("psc.3c50c3"));
  const customBtn = h("button", "", tt("psc.b5e41b"));
  customBtn.type = "button";
  customBtn.addEventListener("click", () => {
    const k = customInput.value.trim();
    if (!k) return;
    close();
    onPick(/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k) ? `input.${k}` : `input[${JSON.stringify(k)}]`);
  });
  custom.append(customInput, customBtn);
  pop.appendChild(custom);
  pop.appendChild(h("div", HELP_CSS + "margin-top:4px;", tt("psc.60a1f1")));

  const render = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    let lastGroup = "";
    const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.path.toLowerCase().includes(q));
    if (shown.length === 0) list.appendChild(h("div", HELP_CSS, tt("psc.6e2c9a")));
    for (const o of shown) {
      if (o.group !== lastGroup) {
        list.appendChild(h("div", HELP_CSS + "margin-top:6px;text-transform:uppercase;letter-spacing:0.04em;", o.group));
        lastGroup = o.group;
      }
      const item = h("div", "padding:3px 6px;cursor:pointer;border-radius:3px;");
      item.setAttribute("data-variable-path", o.path);
      item.innerHTML = "";
      item.append(h("span", "", o.label), h("span", HELP_CSS + "margin-left:6px;font-family:ui-monospace,monospace;", o.path));
      item.addEventListener("mouseenter", () => (item.style.background = "var(--omp-surface-raised)"));
      item.addEventListener("mouseleave", () => (item.style.background = ""));
      item.addEventListener("click", () => {
        close();
        onPick(o.path);
      });
      list.appendChild(item);
    }
  };
  search.addEventListener("input", render);
  render();

  const onDocDown = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== anchor) close();
  };
  const close = () => {
    pop.remove();
    document.removeEventListener("mousedown", onDocDown, true);
  };
  document.addEventListener("mousedown", onDocDown, true);
  document.body.appendChild(pop);
  queueMicrotask(() => search.focus());
}

// Textfeld + Variablen-Knopf in einer Zeile.
function templateInput(value: string, placeholder: string, vars: VariableOption[], name = ""): { el: HTMLElement; input: HTMLInputElement } {
  const row = h("div", "display:flex;gap:4px;");
  const input = textInput(value, placeholder, name);
  row.append(input, variableButton(vars, "template", () => input));
  return { el: row, input };
}

// ---- Dauer-Eingabe ----------------------------------------------------------------------------

function durationInput(seconds: number | undefined, name = ""): { el: HTMLElement; read(): number | undefined | null } {
  const { value, unit } = splitSeconds(seconds);
  const row = h("div", "display:flex;gap:4px;");
  const num = textInput(value, "", name);
  num.inputMode = "decimal";
  num.style.width = "120px";
  const u = select((Object.keys(UNIT_LABEL) as TimeUnit[]).map((k) => ({ value: k, label: UNIT_LABEL[k] })), unit);
  u.style.width = "140px";
  row.append(num, u);
  return { el: row, read: () => toSeconds(num.value, u.value as TimeUnit) };
}

// ---- Schlüssel/Wert-Liste ---------------------------------------------------------------------

function keyValueEditor(
  pairs: [string, string][],
  opts: { keyPlaceholder: string; valuePlaceholder: string; vars?: VariableOption[]; name: string },
): { el: HTMLElement; read(): [string, string][] } {
  const wrap = h("div", "");
  const rows: { k: HTMLInputElement; v: HTMLInputElement }[] = [];
  const list = h("div", "");
  const addRow = (k = "", v = "") => {
    const line = h("div", "display:grid;grid-template-columns:1fr 2fr auto auto;gap:4px;margin-top:4px;");
    const ki = textInput(k, opts.keyPlaceholder);
    ki.setAttribute("data-kv-key", opts.name);
    const vi = textInput(v, opts.valuePlaceholder);
    vi.setAttribute("data-kv-value", opts.name);
    const entry = { k: ki, v: vi };
    rows.push(entry);
    const rm = h("button", "", "✕");
    rm.type = "button";
    rm.title = tt("psc.513d30");
    rm.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      line.remove();
    });
    line.append(ki, vi, opts.vars ? variableButton(opts.vars, "template", () => vi) : h("span"), rm);
    list.appendChild(line);
  };
  for (const [k, v] of pairs) addRow(k, v);
  const add = h("button", "margin-top:4px;", "+ Eintrag");
  add.type = "button";
  add.setAttribute("data-kv-add", opts.name);
  add.addEventListener("click", () => addRow());
  wrap.append(list, add);
  return { el: wrap, read: () => rows.map((r) => [r.k.value, r.v.value] as [string, string]) };
}

// ---- Regel (Bedingung) ------------------------------------------------------------------------

// Baukasten "Variable · Operator · Wert" für Nicht-Techniker; "Eigener
// Ausdruck" für alles, was darüber hinausgeht. Ein bestehender Ausdruck,
// der nicht exakt in den Baukasten passt, öffnet im Freitext-Modus.
function ruleEditor(expression: string, vars: VariableOption[], name: string): { el: HTMLElement; read(): string } {
  const wrap = h("div", "");
  const parsed = expression ? parseRule(expression) : { variable: "", op: "==", value: "" };
  let free = parsed === null;

  const builder = h("div", "display:grid;grid-template-columns:2fr 1fr 1fr;gap:4px;");
  const varSel = select(
    [{ value: "", label: tt("psc.8fef4a") }, ...vars.map((v) => ({ value: v.path, label: `${v.label} (${v.group})` }))],
    parsed?.variable ?? "",
    `${name}-variable`,
  );
  if (parsed?.variable && !vars.some((v) => v.path === parsed.variable)) {
    const opt = h("option", "", parsed.variable);
    opt.value = parsed.variable;
    varSel.appendChild(opt);
    varSel.value = parsed.variable;
  }
  const opSel = select(RULE_OPERATORS.map((o) => ({ value: o.op, label: o.label })), parsed?.op ?? "==", `${name}-op`);
  const valIn = textInput(parsed?.value ?? "", tt("psc.edfa2f"), `${name}-value`);
  builder.append(varSel, opSel, valIn);

  const freeRow = h("div", "display:flex;gap:4px;");
  const freeIn = textInput(expression, 'z. B. outputs.qc.score >= 0.95 && input.type == "video"', `${name}-expression`);
  freeIn.style.fontFamily = "ui-monospace,monospace";
  freeRow.append(freeIn, variableButton(vars, "expression", () => freeIn));

  const toggle = h("button", "margin-top:4px;");
  toggle.type = "button";
  toggle.setAttribute("data-role", "rule-mode-toggle");
  const sync = () => {
    builder.style.display = free ? "none" : "grid";
    freeRow.style.display = free ? "flex" : "none";
    toggle.textContent = free ? tt("psc.1c5e10") : tt("psc.d26d26");
  };
  toggle.addEventListener("click", () => {
    if (!free && varSel.value) freeIn.value = ruleToExpression({ variable: varSel.value, op: opSel.value, value: valIn.value });
    if (free) {
      const p = parseRule(freeIn.value);
      if (!p && freeIn.value.trim()) {
        showToast(tt("psc.b8865a"), { variant: "info" });
        return;
      }
      if (p) {
        if (![...varSel.options].some((o) => o.value === p.variable)) {
          const opt = h("option", "", p.variable);
          opt.value = p.variable;
          varSel.appendChild(opt);
        }
        varSel.value = p.variable;
        opSel.value = p.op;
        valIn.value = p.value;
      }
    }
    free = !free;
    sync();
  });
  sync();
  wrap.append(builder, freeRow, toggle);
  return {
    el: wrap,
    read: () => free ? freeIn.value.trim() : (varSel.value ? ruleToExpression({ variable: varSel.value, op: opSel.value, value: valIn.value }) : ""),
  };
}

// ---- Formulare je Schritt-Typ -----------------------------------------------------------------

function buildWait(cfg: Record<string, unknown>): FormPart {
  const el = h("div", "");
  const d = durationInput(typeof cfg.seconds === "number" ? cfg.seconds : undefined, "seconds");
  el.appendChild(field(tt("psc.00760a"), d.el, tt("psc.b4b8e1"), true));
  return {
    el,
    read: () => {
      const s = d.read();
      if (s === null) return { ok: false, error: tt("psc.b950fb") };
      const out = { ...cfg };
      setOrDelete(out, "seconds", s);
      return { ok: true, config: out };
    },
  };
}

function buildHumanTask(cfg: Record<string, unknown>, isApproval: boolean): FormPart {
  const el = h("div", "");
  const title = textInput(String(cfg.title ?? ""), isApproval ? tt("psc.60e9f0") : tt("psc.1f0172"), "title");
  const desc = h("textarea", "width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;");
  desc.name = "description";
  desc.rows = 3;
  desc.value = String(cfg.description ?? "");
  const assignee = textInput(String(cfg.assignee ?? ""), tt("psc.9d735f"), "assignee");
  assignee.setAttribute("list", "omp-process-users");
  void loadUsersDatalist();
  const role = textInput(String(cfg.role ?? ""), tt("psc.01daf3"), "role");
  const prio = select(
    [
      { value: "low", label: "niedrig" },
      { value: "normal", label: "normal" },
      { value: "high", label: "hoch" },
      { value: "urgent", label: "dringend" },
    ],
    String(cfg.priority ?? "normal"),
    "priority",
  );
  el.append(
    field(tt("psc.68dd6f"), title, tt("psc.01531f")),
    field(tt("psc.49f6db"), desc),
    field(tt("psc.c1ebd6"), assignee),
    field(tt("psc.e897f3"), role),
    field(tt("psc.c30f58"), prio),
  );
  if (isApproval) {
    el.appendChild(h(
      "div",
      HELP_CSS + "margin-top:8px;",
      tt("psc.bea463"),
    ));
  }
  return {
    el,
    read: () => {
      const out = { ...cfg };
      setOrDelete(out, "title", title.value.trim());
      setOrDelete(out, "description", desc.value.trim());
      setOrDelete(out, "assignee", assignee.value.trim());
      setOrDelete(out, "role", role.value.trim());
      setOrDelete(out, "priority", prio.value === "normal" ? undefined : prio.value);
      return { ok: true, config: Object.keys(out).length ? out : undefined };
    },
  };
}

let usersLoaded = false;
async function loadUsersDatalist() {
  if (usersLoaded) return;
  usersLoaded = true;
  try {
    const res = await apiFetch("/api/v1/auth/users");
    if (!res.ok) return; // nur für Admins sichtbar — dann eben Freitext
    const users = (await res.json()) as { username: string }[];
    const dl = document.createElement("datalist");
    dl.id = "omp-process-users";
    for (const u of users) {
      const o = document.createElement("option");
      o.value = u.username;
      dl.appendChild(o);
    }
    document.body.appendChild(dl);
  } catch {
    // Freitext bleibt möglich
  }
}

function buildCondition(cfg: Record<string, unknown>, vars: VariableOption[]): FormPart {
  const el = h("div", "");
  const rule = ruleEditor(String(cfg.expression ?? ""), vars, "condition");
  const trueL = textInput(String(cfg.trueLabel ?? ""), "true", "trueLabel");
  const falseL = textInput(String(cfg.falseLabel ?? ""), "false", "falseLabel");
  const labels = h("div", "display:grid;grid-template-columns:1fr 1fr;gap:8px;");
  labels.append(field(tt("psc.ad8b47"), trueL), field(tt("psc.254c6b"), falseL));
  el.append(
    field(tt("psc.9e5c87"), rule.el, tt("psc.9c21c3"), true),
    labels,
    h("div", HELP_CSS + "margin-top:6px;", tt("psc.92f762")),
  );
  return {
    el,
    read: () => {
      const expression = rule.read();
      if (!expression) return { ok: false, error: tt("psc.f07dc2") };
      const out = { ...cfg, expression };
      setOrDelete(out, "trueLabel", trueL.value.trim());
      setOrDelete(out, "falseLabel", falseL.value.trim());
      return { ok: true, config: out };
    },
  };
}

function buildBranch(cfg: Record<string, unknown>, vars: VariableOption[]): FormPart {
  const el = h("div", "");
  const cases = Array.isArray(cfg.cases) ? (cfg.cases as { expression?: string; label?: string }[]) : [];
  const rows: { label: HTMLInputElement; rule: { read(): string } }[] = [];
  const list = h("div", "");
  const addCase = (c: { expression?: string; label?: string } = {}) => {
    const box = h("div", "border:1px solid var(--omp-border);border-radius:4px;padding:6px;margin-top:6px;");
    const label = textInput(c.label ?? "", tt("psc.65e89f"), "case-label");
    const rule = ruleEditor(c.expression ?? "", vars, `case${rows.length}`);
    const entry = { label, rule };
    rows.push(entry);
    const rm = h("button", "margin-top:4px;", tt("psc.cd850a"));
    rm.type = "button";
    rm.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      box.remove();
    });
    box.append(field("Weg", label), field(tt("psc.9242d7"), rule.el), rm);
    list.appendChild(box);
  };
  for (const c of cases) addCase(c);
  if (cases.length === 0) addCase();
  const add = h("button", "margin-top:6px;", "+ Fall");
  add.type = "button";
  add.setAttribute("data-role", "branch-add-case");
  add.addEventListener("click", () => addCase());
  const def = textInput(String(cfg.defaultLabel ?? ""), tt("psc.12a29c"), "defaultLabel");
  el.append(
    h("div", HELP_CSS, tt("psc.919f43")),
    list,
    add,
    field(tt("psc.22fd61"), def, tt("psc.f22388")),
  );
  return {
    el,
    read: () => {
      const out = { ...cfg };
      const cs: { expression: string; label: string }[] = [];
      for (const r of rows) {
        const expression = r.rule.read();
        const label = r.label.value.trim();
        if (!expression && !label) continue;
        if (!expression || !label) return { ok: false, error: tt("psc.31c191") };
        cs.push({ expression, label });
      }
      if (cs.length === 0) return { ok: false, error: tt("psc.541b6d") };
      out.cases = cs;
      setOrDelete(out, "defaultLabel", def.value.trim());
      return { ok: true, config: out };
    },
  };
}

function buildServiceCall(cfg: Record<string, unknown>, vars: VariableOption[]): FormPart {
  const el = h("div", "");
  const method = select(["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })), String(cfg.method ?? "GET"), "method");
  const url = templateInput(String(cfg.url ?? ""), "https://system.example/api/items/${input.assetId}", vars, "url");
  const headerPairs = flatStringObject(cfg.headers) ?? [];
  const headers = keyValueEditor(headerPairs, { keyPlaceholder: tt("psc.f00a7d"), valuePlaceholder: tt("psc.5a597b"), vars, name: "headers" });
  const bodyPairs = flatStringObject(cfg.body);
  const bodyWrap = h("div", "");
  let bodyEditor: { read(): [string, string][] } | null = null;
  if (bodyPairs !== null) {
    const kv = keyValueEditor(bodyPairs, { keyPlaceholder: tt("psc.144d62"), valuePlaceholder: tt("psc.7b71ec"), name: "body" });
    bodyEditor = kv;
    bodyWrap.appendChild(field(tt("psc.d38e8c"), kv.el, tt("psc.02fbcf")));
  } else {
    bodyWrap.appendChild(h("div", HELP_CSS + "margin-top:8px;", tt("psc.decdc1")));
  }
  const syncBody = () => (bodyWrap.style.display = method.value === "GET" || method.value === "DELETE" ? "none" : "block");
  method.addEventListener("change", syncBody);
  syncBody();
  const timeout = durationInput(typeof cfg.timeoutSeconds === "number" ? cfg.timeoutSeconds : undefined);
  el.append(
    field(tt("psc.41aa69"), method),
    field(tt("psc.8f2cbd"), url.el, tt("psc.e6ea93"), true),
    field(tt("psc.bf50d5"), headers.el),
    bodyWrap,
    field(tt("psc.755b1d"), timeout.el, tt("psc.fc9b98")),
    h("div", HELP_CSS + "margin-top:6px;", tt("psc.61a248")),
  );
  return {
    el,
    read: () => {
      if (!url.input.value.trim()) return { ok: false, error: tt("psc.d494fb") };
      const t = timeout.read();
      if (t === null) return { ok: false, error: tt("psc.de6fc7") };
      const out = { ...cfg, url: url.input.value.trim() };
      setOrDelete(out, "method", method.value === "GET" ? undefined : method.value);
      setOrDelete(out, "headers", pairsToObject(headers.read()));
      if (bodyEditor) setOrDelete(out, "body", method.value === "GET" || method.value === "DELETE" ? undefined : pairsToObject(bodyEditor.read()));
      setOrDelete(out, "timeoutSeconds", t);
      return { ok: true, config: out };
    },
  };
}

// ---- ffmpeg-Assistent (UMSETZUNG.md Kapitel 22, W2) --------------------------------------------
//
// Ersetzt/erweitert die bisherige "eine Vorlage + rohe Argumentliste"-
// Ansicht um einen Assistenten, der ECHTE, auf diesem Server per W1
// (`orchestrator/internal/ffmpegtools`) introspizierte Encoder/Formate/
// AVOptions samt Hilfetext zeigt, statt dass der Nutzer die ffmpeg-CLI
// auswendig kennen muss. "Erweitert (Rohargumente)" bleibt unverändert
// als Experten-/Fallback-Pfad erhalten ("nicht raten"-Prinzip, s.
// CLAUDE.md/UMSETZUNG.md §0) — wer will, tippt weiterhin freie Flags.

// Fetch+Cache liegt in `ffmpeg-client.ts` (W3 nutzt denselben Client für
// den Filter-Builder, keine doppelte Introspektions-Anfrage/Cache).

// Schieberegler für AVOptions mit bekannten Ober-/Untergrenzen (Kapitel
// 23, Schritt 1 — vorher liefen begrenzte Zahlenoptionen wie unbegrenzte
// in ein reines Textfeld). Der Regler bleibt bis zur ersten Berührung
// unberührt (kein künstlich erzwungener Wert, gleiches Prinzip wie beim
// Freitext-"number"-Feld: leer gelassen → ffmpegs eigener Standard) —
// `touched` hält das fest, `read()` liefert dann "" statt eines Werts.
type RangeFieldElement = HTMLElement & { read(): string };

function rangeField(opt: FFOption, initial: string): RangeFieldElement {
  const bounds = optionRangeBounds(opt)!;
  const defaultNum = Number(opt.default);
  const startNum = initial !== "" ? Number(initial) : Number.isFinite(defaultNum) && defaultNum >= bounds.min && defaultNum <= bounds.max ? defaultNum : bounds.min;
  let touched = initial !== "";

  const wrap = h("div", "display:flex;align-items:center;gap:8px;") as unknown as RangeFieldElement;
  const range = h("input", "flex:1;");
  range.type = "range";
  range.min = String(bounds.min);
  range.max = String(bounds.max);
  range.step = String(bounds.step);
  range.value = String(startNum);
  const numberOut = textInput(String(startNum));
  numberOut.style.width = "84px";
  numberOut.inputMode = "decimal";

  range.addEventListener("input", () => {
    numberOut.value = range.value;
    touched = true;
  });
  numberOut.addEventListener("input", () => {
    const n = Number(numberOut.value);
    if (Number.isFinite(n)) range.value = String(Math.min(bounds.max, Math.max(bounds.min, n)));
    touched = true;
  });

  wrap.append(range, numberOut);
  wrap.read = () => (touched ? numberOut.value.trim() : "");
  return wrap;
}

// Rendert die AVOptions eines Encoders/Muxers als Formularfelder (Art
// je Typ, s. ffOptionControlKind — bool als Ja/Nein-<select>, gleiches
// Muster wie buildMediaFunctions boolesche Node-Argumente). Suchfeld
// erst ab zweistelliger Optionsanzahl (z. B. libx264 hat ~47) — bei
// wenigen Optionen wäre es nur Ballast.
function ffmpegOptionsList(vars: VariableOption[]): { el: HTMLElement; setOptions(options: FFOption[], initialValues: Record<string, string>): void; read(): Record<string, string> } {
  const el = h("div", "margin-top:4px;");
  const search = textInput("", tt("psc.81d089"));
  search.style.display = "none";
  const list = h("div", "max-height:340px;overflow:auto;margin-top:4px;");
  el.append(search, list);
  let fields: { row: HTMLElement; searchText: string; name: string; read(): string }[] = [];

  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    // "" statt "flex" würde `display` komplett entfernen und `field()`s
    // `display:flex` (Voraussetzung für die eigene column-Anordnung von
    // Name/Steuerelement/Hilfetext) auf den Browser-Standard für
    // <label> (inline) zurückfallen lassen — dann verschmelzen alle
    // sichtbaren Zeilen optisch zu einer Textwurst (live per
    // Dokumentations-Screenshot gefunden, s. UMSETZUNG.md Kapitel 22).
    for (const f of fields) f.row.style.display = !q || f.searchText.includes(q) ? "flex" : "none";
  };
  search.addEventListener("input", applyFilter);

  return {
    el,
    setOptions(options, initialValues) {
      list.replaceChildren();
      fields = [];
      search.style.display = options.length > 12 ? "" : "none";
      search.value = "";
      for (const opt of options) {
        const kind = ffOptionControlKind(opt);
        const initial = initialValues[opt.name] ?? "";
        let control: HTMLElement;
        let read: () => string;
        if (kind === "select") {
          const s = select(
            [{ value: "", label: "– ffmpeg-Standard –" }, ...(opt.choices ?? []).map((c) => ({ value: c.value || c.name, label: c.description ? `${c.name} — ${c.description}` : c.name }))],
            initial,
          );
          control = s;
          read = () => s.value;
        } else if (kind === "checkbox") {
          const s = select([{ value: "", label: "– ffmpeg-Standard –" }, { value: "true", label: "ja" }, { value: "false", label: "nein" }], initial);
          control = s;
          read = () => s.value;
        } else if (kind === "number") {
          const i = textInput(initial, opt.default ? tt("psc.440a36", { p0: opt.default }) : "");
          i.inputMode = "decimal";
          control = i;
          read = () => i.value.trim();
        } else if (kind === "range") {
          control = rangeField(opt, initial);
          read = (control as RangeFieldElement).read;
        } else {
          const t = templateInput(initial, opt.default ? tt("psc.440a36", { p0: opt.default }) : "", vars);
          control = t.el;
          read = () => t.input.value.trim();
        }
        const row = field(opt.name, control, optionHelpText(opt));
        list.appendChild(row);
        fields.push({ row, name: opt.name, searchText: (opt.name + " " + (opt.description ?? "")).toLowerCase(), read });
      }
      applyFilter();
    },
    read: () => Object.fromEntries(fields.map((f) => [f.name, f.read()])),
  };
}

function codecPicker(
  mediaType: "video" | "audio",
  vars: VariableOption[],
  withOptions = true,
): { el: HTMLElement; read(): { codec: string; options: Record<string, string> } } {
  const wrap = h("div", "");
  const sel = select([{ value: "", label: "lade Codecs …" }], "");
  const panel = withOptions ? ffmpegOptionsList(vars) : null;
  wrap.append(sel);
  if (panel) wrap.append(panel.el);
  const loadDetail = async () => {
    if (!panel) return;
    if (!sel.value) {
      panel.setOptions([], {});
      return;
    }
    const detail = await fetchFFmpegDetail("encoder", sel.value);
    panel.setOptions(detail?.options ?? [], {});
  };
  (async () => {
    const list = await fetchFFmpegList<FFCodecEntry>("encoders");
    const filtered = list.filter((c) => c.mediaType === mediaType);
    sel.replaceChildren(new Option(tt("psc.f86918"), ""));
    for (const c of filtered) sel.appendChild(new Option(`${c.name} — ${c.description}`, c.name));
  })();
  sel.addEventListener("change", () => void loadDetail());
  return { el: wrap, read: () => ({ codec: sel.value, options: panel ? panel.read() : {} }) };
}

function formatPicker(vars: VariableOption[], withOptions: boolean): { el: HTMLElement; read(): { format: string; options: Record<string, string> } } {
  const wrap = h("div", "");
  const sel = select([{ value: "", label: "lade Container …" }], "");
  const panel = withOptions ? ffmpegOptionsList(vars) : null;
  wrap.append(sel);
  if (panel) wrap.append(panel.el);
  const loadDetail = async () => {
    if (!panel) return;
    if (!sel.value) {
      panel.setOptions([], {});
      return;
    }
    const detail = await fetchFFmpegDetail("muxer", sel.value);
    panel.setOptions(detail?.options ?? [], {});
  };
  (async () => {
    const list = await fetchFFmpegList<FFFormatEntry>("formats");
    const muxers = list.filter((f) => f.muxing);
    sel.replaceChildren(new Option(tt("psc.a8f960"), ""));
    for (const f of muxers) sel.appendChild(new Option(`${f.name} — ${f.description}`, f.name));
  })();
  sel.addEventListener("change", () => void loadDetail());
  return { el: wrap, read: () => ({ format: sel.value, options: panel ? panel.read() : {} }) };
}

type ScriptCompileResult = { ok: true; command: string; args: string[] } | { ok: false; error: string };
interface ScriptWizardForm {
  el: HTMLElement;
  read(): ScriptCompileResult;
}

// Generische Aufgaben-Registry (Kapitel 25 R1): EINE Rendering-Funktion
// für jede in GENERIC_SCRIPT_TASKS registrierte einfache Aufgabe —
// interpretiert deren deklarative `fields`-Liste, baut daraus dieselben
// Bausteine, die bisher jede Aufgabe einzeln von Hand zusammensetzte
// (templateInput/textInput/codecPicker/formatPicker), und übergibt die
// eingesammelten Werte an `task.toArgs()`. Eine neue einfache Aufgabe
// braucht damit NUR einen neuen GENERIC_SCRIPT_TASKS-Eintrag — dieser
// Code hier ändert sich nicht.
// Ein Satz Leser-Funktionen für eine Feldliste (Kapitel 25 R4) —
// `collectGenericValues` liest sie in die `GenericScriptFormValues`-Form
// ein, die `GenericScriptTask.toArgs()` erwartet. Getrennt von
// `renderGenericFields` selbst, damit eine `group`-Zeile (rekursiv
// dieselbe Feldliste wie das Top-Level-Formular) ihre eigenen Leser
// bekommt, ohne mit denen anderer Zeilen/des äußeren Formulars zu
// kollidieren.
interface GenericFieldReaders {
  scalarReaders: Record<string, () => string>;
  pickerReaders: Record<string, () => { codec?: string; format?: string; options: Record<string, string> }>;
  groupReaders: Record<string, () => GenericScriptFormValues[]>;
}

function collectGenericValues(readers: GenericFieldReaders): GenericScriptFormValues {
  return {
    scalars: Object.fromEntries(Object.entries(readers.scalarReaders).map(([k, r]) => [k, r()])),
    pickers: Object.fromEntries(Object.entries(readers.pickerReaders).map(([k, r]) => [k, r()])),
    groups: Object.fromEntries(Object.entries(readers.groupReaders).map(([k, r]) => [k, r()])),
  };
}

// Rendert eine Feldliste in `container` — vom Top-Level-Aufruf
// (`buildGenericScriptForm`) UND rekursiv für jede Zeile eines
// `group`-Felds (Kapitel 25 R4, s. GenericScriptGroupField-Doku in
// process-step-config-logic.ts: bewusst nur eine Ebene tief genutzt,
// der Interpreter selbst schränkt Verschachtelung aber nicht künstlich
// ein).
function renderGenericFields(container: HTMLElement, fields: GenericScriptField[], vars: VariableOption[]): GenericFieldReaders {
  const scalarReaders: GenericFieldReaders["scalarReaders"] = {};
  const pickerReaders: GenericFieldReaders["pickerReaders"] = {};
  const groupReaders: GenericFieldReaders["groupReaders"] = {};

  for (const spec of fields) {
    if (spec.kind === "group") {
      const minItems = spec.minItems ?? 1;
      const rows: { rowEl: HTMLElement; heading: HTMLElement; readers: GenericFieldReaders }[] = [];
      const list = h("div", "");
      const renumber = () => rows.forEach((r, i) => (r.heading.textContent = spec.itemLabel(i)));
      const addRow = () => {
        const rowEl = h("div", "border:1px solid var(--omp-border);border-radius:4px;padding:6px;margin-top:6px;");
        const heading = h("div", "font-weight:600;");
        const rowFieldsWrap = h("div", "");
        const readers = renderGenericFields(rowFieldsWrap, spec.itemFields, vars);
        const rmBtn = h("button", "margin-top:4px;", tt("psc.513d30"));
        rmBtn.type = "button";
        rmBtn.addEventListener("click", () => {
          if (rows.length <= minItems) return;
          const idx = rows.findIndex((r) => r.rowEl === rowEl);
          if (idx >= 0) rows.splice(idx, 1);
          rowEl.remove();
          renumber();
        });
        rowEl.append(heading, rowFieldsWrap, rmBtn);
        rows.push({ rowEl, heading, readers });
        list.appendChild(rowEl);
        renumber();
      };
      for (let i = 0; i < minItems; i++) addRow();
      const addBtn = h("button", "margin-top:6px;", spec.addLabel);
      addBtn.type = "button";
      addBtn.addEventListener("click", addRow);

      const wrap = h("div", "display:flex;flex-direction:column;gap:2px;margin-top:8px;");
      wrap.appendChild(h("span", HELP_CSS + "font-weight:600;", spec.label));
      if (spec.help) wrap.appendChild(h("span", HELP_CSS, spec.help));
      wrap.append(list, addBtn);
      container.appendChild(wrap);

      groupReaders[spec.id] = () => rows.map((r) => collectGenericValues(r.readers));
      continue;
    }

    let control: HTMLElement;
    if (spec.kind === "template-text") {
      const t = templateInput(spec.defaultValue ?? "", spec.placeholder ?? spec.defaultValue ?? "", vars);
      control = t.el;
      scalarReaders[spec.id] = () => t.input.value.trim();
    } else if (spec.kind === "text") {
      const i = textInput(spec.defaultValue ?? "", spec.placeholder ?? "");
      if (spec.numeric) i.inputMode = "numeric";
      control = i;
      scalarReaders[spec.id] = () => i.value.trim();
    } else if (spec.kind === "codec-picker") {
      const cp = codecPicker(spec.mediaType, vars, spec.withOptions ?? true);
      control = cp.el;
      pickerReaders[spec.id] = () => {
        const r = cp.read();
        return { codec: r.codec, options: r.options };
      };
    } else {
      const fp = formatPicker(vars, spec.withOptions ?? true);
      control = fp.el;
      pickerReaders[spec.id] = () => {
        const r = fp.read();
        return { format: r.format, options: r.options };
      };
    }
    container.appendChild(field(spec.label, control, spec.help, spec.required));
  }

  return { scalarReaders, pickerReaders, groupReaders };
}

function buildGenericScriptForm(task: GenericScriptTask, vars: VariableOption[]): ScriptWizardForm {
  const el = h("div", "");
  const readers = renderGenericFields(el, task.fields, vars);
  return {
    el,
    read: () => {
      const result = task.toArgs(collectGenericValues(readers));
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, command: task.command, args: result.args };
    },
  };
}

function buildScriptWizardConvert(vars: VariableOption[]): ScriptWizardForm {
  const el = h("div", "");
  const input = templateInput("${input.path}", "${input.path}", vars);
  const output = templateInput("${input.outputPath}", "${input.outputPath}", vars);
  const fmt = formatPicker(vars, false);
  const video = codecPicker("video", vars);
  const audio = codecPicker("audio", vars);

  // Visueller Filter-Builder (Kapitel 22, W3) — bewusst nur innerhalb
  // dieser einen Modal-Sitzung im Speicher gehalten (kein Persistieren
  // über ein Schließen/Neuöffnen hinaus), gleiche Abwägung wie der
  // Assistent insgesamt: neue Schritte starten im Assistenten, bereits
  // konfigurierte im Erweitert-Modus (kein stilles Reinterpretieren).
  let filterGraph: FilterGraph | null = null;
  let filterPositions: Record<string, Point> | null = null;
  let filterComplex = "";
  let filterOutputLabels: string[] = [];
  const filterSummary = h("div", HELP_CSS + "margin-top:2px;", tt("psc.95b1db"));
  const filterBtn = h("button", "margin-top:4px;", tt("psc.0a42fd"));
  filterBtn.type = "button";
  const filterClearBtn = h("button", "margin-top:4px;margin-left:4px;", tt("psc.a09a38"));
  filterClearBtn.type = "button";
  filterClearBtn.style.display = "none";
  const syncFilterSummary = () => {
    filterSummary.textContent = filterComplex ? tt("psc.cb4d72", { p0: filterGraph?.nodes.filter((n) => n.kind === "filter").length ?? 0 }) : tt("psc.95b1db");
    filterClearBtn.style.display = filterComplex ? "" : "none";
  };
  filterBtn.addEventListener("click", () => {
    openFilterGraphEditor(document.body, filterGraph, filterPositions, (graph, positions, expr, labels) => {
      filterGraph = graph;
      filterPositions = positions;
      filterComplex = expr;
      filterOutputLabels = labels;
      syncFilterSummary();
      refreshAllQuickLabels();
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  filterClearBtn.addEventListener("click", () => {
    filterGraph = null;
    filterPositions = null;
    filterComplex = "";
    filterOutputLabels = [];
    audioMatrixCells = [];
    syncFilterSummary();
    refreshAllQuickLabels();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Grafische Audio-Matrix (Kapitel 23, Schritt 3) — ALTERNATIVE
  // Bedienoberfläche für dieselben zwei Felder (filterComplex/
  // filterOutputLabels) wie der manuelle Filter-Graph-Editor oben,
  // nicht gleichzeitig aktiv (die zuletzt benutzte gewinnt, wie bei
  // "Filter-Kette bearbeiten" auch — kein Zusammenführen zweier
  // unabhängiger Filtergraphen). audioMatrixCells/-OutputCount bleiben
  // erhalten, damit ein erneutes Öffnen die letzte Matrix zeigt.
  let audioMatrixCells: AudioMatrixCell[] = [];
  let audioMatrixOutputCount = 2;
  const matrixBtn = h("button", "margin-top:4px;margin-left:4px;", tt("psc.f15630"));
  matrixBtn.type = "button";
  matrixBtn.title = tt("psc.3309b0");
  matrixBtn.addEventListener("click", () => {
    openAudioMatrixEditor(
      document.body,
      input.input.value.trim(),
      additionalInputs.map((e) => e.input.value.trim()),
      audioMatrixOutputCount,
      audioMatrixCells,
      (additionalPaths, expr, labels, cells, outputCount) => {
        filterGraph = null;
        filterPositions = null;
        filterComplex = expr;
        filterOutputLabels = labels;
        audioMatrixCells = cells;
        audioMatrixOutputCount = outputCount;
        additionalInputs.splice(0, additionalInputs.length);
        additionalInputsList.replaceChildren();
        for (const p of additionalPaths) addAdditionalInput(p);
        syncFilterSummary();
        refreshAllQuickLabels();
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
    );
  });

  // Weitere Eingabedateien (W4-Härtetest-Fund): ein Filter-Graph kann
  // mehrere Quellen referenzieren (z. B. `amix` mit drei echten
  // Tondateien als "0:a"/"1:a"/"2:a") — "Eingabedatei" oben deckt nur
  // Index 0 ab. Ohne dieses Feld hätte ein Mehrfach-Eingang-Filter-Graph
  // nie wirklich laufen können.
  const additionalInputs: { input: HTMLInputElement; row: HTMLElement }[] = [];
  const additionalInputsList = h("div", "");
  const addAdditionalInput = (value = "") => {
    const t = templateInput(value, tt("psc.2668ce"), vars);
    const row = h("div", "display:flex;gap:4px;margin-top:4px;");
    const rm = h("button", "", "✕");
    rm.type = "button";
    const entry = { input: t.input, row };
    rm.addEventListener("click", () => {
      additionalInputs.splice(additionalInputs.indexOf(entry), 1);
      row.remove();
    });
    row.append(t.el, rm);
    additionalInputs.push(entry);
    additionalInputsList.appendChild(row);
  };
  const addAdditionalInputBtn = h("button", "margin-top:4px;", "+ weitere Eingabedatei");
  addAdditionalInputBtn.type = "button";
  addAdditionalInputBtn.addEventListener("click", () => addAdditionalInput());

  // ---- Ausgabespuren (Kapitel 23, Schritt 2) --------------------------
  //
  // Generischer Ersatz für die in Schritt 1 ausgebaute "Mehrspur-
  // Container bauen"-Sonderfunktion: beliebig viele UNABHÄNGIGE
  // Ausgabespuren, Quelle wahlweise ein roher Stream-Spezifizierer
  // ("0:a:0") oder ein Filter-Graph-/Audio-Matrix-Ausgang ("[mxout0]").
  // Sobald mindestens eine Spur konfiguriert ist, übernimmt diese Liste
  // die Zuordnung VOLLSTÄNDIG (s. buildConvertArgs-Moduldoku) — die
  // einfachen Video-/Audio-Codec-Felder oben werden dann ausgeblendet,
  // damit nie zwei widersprüchliche Zuordnungen gleichzeitig sichtbar
  // sind.
  interface OutputTrackRow {
    box: HTMLElement;
    heading: HTMLElement;
    source: HTMLInputElement;
    mediaTypeSel: HTMLSelectElement;
    codecSel: HTMLSelectElement;
    optionsPanel: ReturnType<typeof ffmpegOptionsList>;
    metadataEditor: ReturnType<typeof keyValueEditor>;
  }
  const outputTrackRows: OutputTrackRow[] = [];
  const outputTracksList = h("div", "");
  const renumberTracks = () => outputTrackRows.forEach((r, i) => (r.heading.textContent = tt("psc.b2cbf0", { p0: i + 1 })));
  // Die Schnelleinfüge-Knöpfe je Zeile ("[label] einfügen") hängen vom
  // AKTUELLEN filterOutputLabels ab, das sich ändert, wann immer
  // Filter-Kette oder Audio-Matrix bearbeitet werden — jede Zeile
  // registriert hier ihre eigene Neuaufbau-Funktion, damit alle
  // gemeinsam aktualisiert werden können (statt nur die Zeile, die
  // gerade existierte, als die Labels sich das letzte Mal änderten).
  const quickLabelRefreshers: (() => void)[] = [];
  const refreshAllQuickLabels = () => quickLabelRefreshers.forEach((fn) => fn());
  const syncSimpleCodecVisibility = () => {
    const hide = outputTrackRows.length > 0;
    for (const el2 of simpleCodecEls) el2.style.display = hide ? "none" : "";
    simpleCodecNote.style.display = hide ? "" : "none";
  };
  const loadTrackCodecs = async (row: OutputTrackRow) => {
    const list = await fetchFFmpegList<FFCodecEntry>("encoders");
    const filtered = list.filter((c) => c.mediaType === row.mediaTypeSel.value);
    row.codecSel.replaceChildren(new Option("– ffmpeg-Standard –", ""));
    for (const c of filtered) row.codecSel.appendChild(new Option(`${c.name} — ${c.description}`, c.name));
  };
  const addOutputTrack = () => {
    const box = h("div", "border:1px solid var(--omp-border);border-radius:4px;padding:6px;margin-top:6px;");
    const heading = h("div", "font-weight:600;", tt("psc.b2cbf0", { p0: outputTrackRows.length + 1 }));
    const source = templateInput("", tt("psc.a56112"), vars);
    const quickLabels = h("div", "display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;");
    const syncQuickLabels = () => {
      quickLabels.replaceChildren();
      for (const label of filterOutputLabels) {
        const btn = h("button", "font-size:var(--omp-font-size-xs);", tt("psc.4b1725", { p0: label }));
        btn.type = "button";
        btn.addEventListener("click", () => {
          source.input.value = `[${label}]`;
          source.input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        quickLabels.appendChild(btn);
      }
    };
    syncQuickLabels();
    quickLabelRefreshers.push(syncQuickLabels);
    const mediaTypeSel = select([{ value: "audio", label: tt("psc.b22f04") }, { value: "video", label: tt("psc.34e2d1") }, { value: "subtitle", label: tt("psc.b5b672") }], "audio");
    const codecSel = select([{ value: "", label: "lade Codecs …" }], "");
    const optionsPanel = ffmpegOptionsList(vars);
    const metadataEditor = keyValueEditor([], { keyPlaceholder: "z. B. title, language, …", valuePlaceholder: tt("psc.5a597b"), name: `track-meta-${outputTrackRows.length}` });
    const rm = h("button", "margin-top:4px;", tt("psc.e9da74"));
    rm.type = "button";
    const entry: OutputTrackRow = { box, heading, source: source.input, mediaTypeSel, codecSel, optionsPanel, metadataEditor };
    mediaTypeSel.addEventListener("change", () => void loadTrackCodecs(entry));
    codecSel.addEventListener("change", async () => {
      if (!codecSel.value) {
        optionsPanel.setOptions([], {});
        return;
      }
      const detail = await fetchFFmpegDetail("encoder", codecSel.value);
      optionsPanel.setOptions(detail?.options ?? [], {});
    });
    void loadTrackCodecs(entry);
    rm.addEventListener("click", () => {
      outputTrackRows.splice(outputTrackRows.indexOf(entry), 1);
      quickLabelRefreshers.splice(quickLabelRefreshers.indexOf(syncQuickLabels), 1);
      box.remove();
      renumberTracks();
      syncSimpleCodecVisibility();
    });
    box.append(
      heading,
      field(tt("psc.d3402e"), source.el, tt("psc.d0636b"), true),
      quickLabels,
      field(tt("psc.913302"), mediaTypeSel),
      field(tt("psc.8ca990"), codecSel, tt("psc.8a0483")),
      optionsPanel.el,
      field(tt("psc.e8a64f"), metadataEditor.el, tt("psc.ae9836")),
      rm,
    );
    outputTrackRows.push(entry);
    outputTracksList.appendChild(box);
    syncSimpleCodecVisibility();
  };
  const addOutputTrackBtn = h("button", "margin-top:6px;", "+ Ausgabespur");
  addOutputTrackBtn.type = "button";
  addOutputTrackBtn.addEventListener("click", addOutputTrack);

  const simpleCodecEls: HTMLElement[] = [];
  const simpleCodecNote = h(
    "div",
    HELP_CSS + "margin-top:4px;",
    tt("psc.095815"),
  );
  simpleCodecNote.style.display = "none";
  const videoSection = section(tt("psc.34e2d1"));
  const videoField = field(tt("psc.2c6327"), video.el, tt("psc.24f9d3"));
  const audioSection = section(tt("psc.b22f04"));
  const audioField = field(tt("psc.16202d"), audio.el, tt("psc.24f9d3"));
  simpleCodecEls.push(videoSection, videoField, audioSection, audioField);

  el.append(
    field(tt("psc.7ddbbe"), input.el, undefined, true),
    field(tt("psc.8adabd"), output.el, undefined, true),
    field(tt("psc.6bbca5"), fmt.el, tt("psc.74d4bd")),
    videoSection,
    videoField,
    audioSection,
    audioField,
    simpleCodecNote,
    section(tt("psc.f92383")),
    filterSummary,
    filterBtn,
    matrixBtn,
    filterClearBtn,
    field(
      tt("psc.99d757"),
      additionalInputsList,
      tt("psc.82095d"),
    ),
    addAdditionalInputBtn,
    section(tt("psc.5bfab8")),
    outputTracksList,
    addOutputTrackBtn,
  );
  return {
    el,
    read: () => {
      const p = input.input.value.trim();
      const o = output.input.value.trim();
      if (!p || !o) return { ok: false, error: tt("psc.9205c3") };
      const additionalPaths: string[] = [];
      for (const entry of additionalInputs) {
        const v = entry.input.value.trim();
        if (!v) return { ok: false, error: tt("psc.328a1f") };
        additionalPaths.push(v);
      }
      const outputTracks: OutputTrack[] = [];
      for (const row of outputTrackRows) {
        const src = row.source.value.trim();
        if (!src) return { ok: false, error: tt("psc.a3017d") };
        outputTracks.push({
          source: src,
          mediaType: row.mediaTypeSel.value as OutputTrack["mediaType"],
          codec: row.codecSel.value || undefined,
          options: row.optionsPanel.read(),
          metadata: pairsToObject(row.metadataEditor.read()),
        });
      }
      const v = video.read();
      const a = audio.read();
      const f = fmt.read();
      return {
        ok: true,
        command: "ffmpeg",
        args: buildConvertArgs({
          inputPath: p,
          outputPath: o,
          format: f.format || undefined,
          videoCodec: v.codec || undefined,
          videoOptions: v.options,
          audioCodec: a.codec || undefined,
          audioOptions: a.options,
          filterComplex: filterComplex || undefined,
          filterOutputLabels: filterComplex ? filterOutputLabels : undefined,
          additionalInputPaths: additionalPaths.length ? additionalPaths : undefined,
          outputTracks: outputTracks.length ? outputTracks : undefined,
        }),
      };
    },
  };
}

// ---- Clips aneinanderhängen (Schnittliste, Kapitel 23 Schritt 2) -------------------------------
//
// Wiederholbare, per Pfeil-Tasten umsortierbare Clip-Liste — die
// Reihenfolge in der Liste IST die Reihenfolge im Ergebnis (kein
// separates "Position"-Feld nötig). Reines DOM-Umordnen von
// Kind-Elementen, kein Drag&Drop (robuster per CDP/Tastatur bedienbar,
// gleiche Überlegung wie beim bereits vorhandenen Auf/Ab in anderen
// Listen dieses Editors).
function buildScriptWizardConcat(vars: VariableOption[]): ScriptWizardForm {
  const el = h("div", "");
  const output = templateInput("${input.outputPath}", "${input.outputPath}", vars);
  const fmt = formatPicker(vars, false);
  const video = codecPicker("video", vars);
  const audio = codecPicker("audio", vars);

  interface ClipRow {
    box: HTMLElement;
    heading: HTMLElement;
    path: HTMLInputElement;
    trimStart: HTMLInputElement;
    trimEnd: HTMLInputElement;
  }
  const rows: ClipRow[] = [];
  const list = h("div", "");
  // Verlustfrei-Häkchen (weiter unten definiert) blendet pro-Clip
  // Beschnitt-Felder aus — jede addClip()-Zeile trägt ihre beiden
  // Feld-Wrapper hier ein, damit auch NACHTRÄGLICH per "+ weiterer Clip"
  // hinzugefügte Zeilen sofort den aktuellen Sichtbarkeits-Zustand
  // bekommen (s. syncLosslessVisibility).
  const trimFieldsEls: HTMLElement[] = [];
  let losslessActive = () => false; // durch die Checkbox weiter unten ersetzt
  const renumber = () => rows.forEach((r, i) => (r.heading.textContent = tt("psc.6b4c3c", { p0: i + 1 })));
  const reorder = () => {
    list.replaceChildren(...rows.map((r) => r.box));
    renumber();
  };
  const addClip = () => {
    const box = h("div", "border:1px solid var(--omp-border);border-radius:4px;padding:6px;margin-top:6px;");
    const heading = h("div", "font-weight:600;", tt("psc.6b4c3c", { p0: rows.length + 1 }));
    const path = templateInput("", tt("psc.2668ce"), vars);
    const trimStart = textInput("", tt("psc.b153d1"));
    const trimEnd = textInput("", tt("psc.c7c6db"));
    const btnRow = h("div", "display:flex;gap:4px;margin-top:4px;");
    const up = h("button", "", "↑");
    const down = h("button", "", "↓");
    const rm = h("button", "", tt("psc.fb36dc"));
    up.type = down.type = rm.type = "button";
    const entry: ClipRow = { box, heading, path: path.input, trimStart, trimEnd };
    up.addEventListener("click", () => {
      const i = rows.indexOf(entry);
      if (i > 0) {
        [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        reorder();
      }
    });
    down.addEventListener("click", () => {
      const i = rows.indexOf(entry);
      if (i >= 0 && i < rows.length - 1) {
        [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
        reorder();
      }
    });
    rm.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      reorder();
    });
    btnRow.append(up, down, rm);
    const trimStartField = field(tt("psc.e2eaea"), trimStart, tt("psc.4e75ed"));
    const trimEndField = field(tt("psc.1f0b03"), trimEnd, tt("psc.410164"));
    trimStartField.style.display = trimEndField.style.display = losslessActive() ? "none" : "";
    trimFieldsEls.push(trimStartField, trimEndField);
    box.append(heading, field(tt("psc.c3115f"), path.el, undefined, true), trimStartField, trimEndField, btnRow);
    rows.push(entry);
    reorder();
  };
  addClip();
  addClip();
  const addBtn = h("button", "margin-top:6px;", "+ weiterer Clip");
  addBtn.type = "button";
  addBtn.addEventListener("click", addClip);

  // Verlustfrei (Nutzerauftrag "verlustfreies concat", Nachtrag Kapitel
  // 23): Stream-Copy über ffmpegs concat-PROTOKOLL statt der Filterkette
  // — kein Neukodieren, aber ohne Beschnitt-Unterstützung (das Protokoll
  // kennt keinen Trim) und nur für bestimmte Container zuverlässig (laut
  // ffmpeg-Doku vor allem MPEG-TS/-PS, NICHT generell MP4/MOV/MKV).
  // Beschnitt-Felder + Codec-Wahl werden bei aktivem Häkchen ausgeblendet
  // statt nur ignoriert, damit nie ein Feld sichtbar bleibt, dessen Wert
  // in diesem Modus wirkungslos wäre.
  const losslessCheckbox = h("input", "");
  losslessCheckbox.type = "checkbox";
  losslessActive = () => losslessCheckbox.checked;
  const losslessNote = h(
    "div",
    HELP_CSS,
    tt("psc.318be7"),
  );
  losslessNote.style.display = "none";
  const codecFieldsEls: HTMLElement[] = [];
  const syncLosslessVisibility = () => {
    const lossless = losslessCheckbox.checked;
    losslessNote.style.display = lossless ? "" : "none";
    for (const el2 of trimFieldsEls) el2.style.display = lossless ? "none" : "";
    for (const el2 of codecFieldsEls) el2.style.display = lossless ? "none" : "";
  };
  losslessCheckbox.addEventListener("change", syncLosslessVisibility);

  const videoField = field(tt("psc.2c6327"), video.el, tt("psc.965445"));
  const audioField = field(tt("psc.16202d"), audio.el);
  codecFieldsEls.push(videoField, audioField);

  el.append(
    h("div", HELP_CSS + "margin-bottom:4px;", tt("psc.71259a")),
    list,
    addBtn,
    field(tt("psc.8adabd"), output.el, undefined, true),
    field(tt("psc.6bbca5"), fmt.el, tt("psc.74d4bd")),
    field(tt("psc.b81bfe"), losslessCheckbox),
    losslessNote,
    videoField,
    audioField,
  );
  return {
    el,
    read: () => {
      const o = output.input.value.trim();
      if (!o) return { ok: false, error: tt("psc.82b994") };
      if (rows.length < 2) return { ok: false, error: tt("psc.9fd8eb") };
      for (const r of rows) {
        if (!r.path.value.trim()) return { ok: false, error: tt("psc.aecc0d") };
      }
      const f = fmt.read();
      const v = video.read();
      const a = audio.read();
      const lossless = losslessCheckbox.checked;
      return {
        ok: true,
        command: "ffmpeg",
        args: buildConcatArgs({
          outputPath: o,
          format: f.format || undefined,
          videoCodec: lossless ? undefined : v.codec || undefined,
          videoOptions: lossless ? undefined : v.options,
          audioCodec: lossless ? undefined : a.codec || undefined,
          audioOptions: lossless ? undefined : a.options,
          lossless,
          clips: rows.map((r) => ({
            inputPath: r.path.value.trim(),
            trimStart: lossless ? undefined : r.trimStart.value.trim() || undefined,
            trimEnd: lossless ? undefined : r.trimEnd.value.trim() || undefined,
          })),
        }),
      };
    },
  };
}

// ---- Zeitgesteuerte Overlays (Senderkennung/Bauchbinde/Abspann, Kapitel 23 Schritt 4) -----------
//
// Jedes Ereignis (Text ODER Bild) hat einen eigenen Start-/End-
// Zeitpunkt in Sekunden — zusätzlich zu den Zahlenfeldern eine rein
// visuelle, nicht-interaktive Zeitleiste zur Orientierung (Balken
// proportional zur Gesamtdauer), im Stil der Balkendarstellung aus
// ui/shell/scheduler-view.ts, aber bewusst ohne deren Zieh-Mechanik
// (eigene, unabhängige Umsetzung — Zeitachse hier ist Sekunden über
// die Medien-Gesamtdauer, nicht Uhrzeit über einen Kalendertag).
function buildScriptWizardOverlay(vars: VariableOption[]): ScriptWizardForm {
  const el = h("div", "");
  const input = templateInput("${input.path}", "${input.path}", vars);
  const output = templateInput("${input.outputPath}", "${input.outputPath}", vars);
  const duration = textInput("60", tt("psc.07a093"));
  duration.inputMode = "decimal";
  const video = codecPicker("video", vars, false);
  const audio = codecPicker("audio", vars, false);

  const timeline = h("div", "position:relative;height:22px;background:var(--omp-surface-raised);border-radius:3px;margin:6px 0;overflow:hidden;");

  interface EventRow {
    box: HTMLElement;
    heading: HTMLElement;
    kindSel: HTMLSelectElement;
    textInput: HTMLInputElement;
    imagePath: HTMLInputElement;
    imageField: HTMLElement;
    textField: HTMLElement;
    start: HTMLInputElement;
    end: HTMLInputElement;
    x: HTMLInputElement;
    y: HTMLInputElement;
    bar: HTMLElement;
  }
  const rows: EventRow[] = [];
  const list = h("div", "");
  const renumber = () => rows.forEach((r, i) => (r.heading.textContent = tt("psc.4ff54c", { p0: i + 1 })));
  const redrawTimeline = () => {
    const total = Math.max(Number(duration.value) || 0, 0.001);
    for (const r of rows) {
      const s = Math.max(Number(r.start.value) || 0, 0);
      const e = Math.max(Number(r.end.value) || 0, s);
      r.bar.style.left = `${Math.min((s / total) * 100, 100)}%`;
      r.bar.style.width = `${Math.max(Math.min(((e - s) / total) * 100, 100), 0.5)}%`;
    }
  };
  duration.addEventListener("input", redrawTimeline);
  const addEvent = () => {
    const box = h("div", "border:1px solid var(--omp-border);border-radius:4px;padding:6px;margin-top:6px;");
    const heading = h("div", "font-weight:600;", tt("psc.4ff54c", { p0: rows.length + 1 }));
    const kindSel = select([{ value: "text", label: tt("psc.6e4c80") }, { value: "image", label: tt("psc.fe1905") }], "text");
    const text = textInput("", "z. B. © Mein Sender 2026");
    const imagePath = templateInput("", tt("psc.d43301"), vars);
    const start = textInput("0", tt("psc.d01e32"));
    const end = textInput("5", tt("psc.d01e32"));
    start.inputMode = end.inputMode = "decimal";
    const x = textInput("", tt("psc.28d341"));
    const y = textInput("", tt("psc.c8421f"));
    const textField = field(tt("psc.9dffbf"), text, tt("psc.ed95ac"));
    const imageField = field(tt("psc.aa69ac"), imagePath.el, undefined, true);
    imageField.style.display = "none";
    const bar = h("div", "position:absolute;top:2px;bottom:2px;background:var(--omp-info);border-radius:2px;min-width:2px;");
    bar.title = "";
    timeline.appendChild(bar);
    const syncKind = () => {
      const isText = kindSel.value === "text";
      textField.style.display = isText ? "" : "none";
      imageField.style.display = isText ? "none" : "";
    };
    kindSel.addEventListener("change", syncKind);
    syncKind();
    [start, end].forEach((i) => i.addEventListener("input", redrawTimeline));
    const btnRow = h("div", "display:flex;gap:4px;margin-top:4px;");
    const rm = h("button", "", tt("psc.3795c7"));
    rm.type = "button";
    const entry: EventRow = { box, heading, kindSel, textInput: text, imagePath: imagePath.input, imageField, textField, start, end, x, y, bar };
    rm.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      bar.remove();
      box.remove();
      renumber();
      redrawTimeline();
    });
    btnRow.append(rm);
    box.append(
      heading,
      field("Art", kindSel),
      textField,
      imageField,
      field(tt("psc.9563fc"), start, undefined, true),
      field(tt("psc.5381b9"), end, undefined, true),
      field(tt("psc.8ef81c"), x, tt("psc.8f4463")),
      field(tt("psc.ec97a1"), y, tt("psc.edfec0")),
      btnRow,
    );
    rows.push(entry);
    list.appendChild(box);
    redrawTimeline();
  };
  addEvent();
  const addBtn = h("button", "margin-top:6px;", "+ weiteres Ereignis");
  addBtn.type = "button";
  addBtn.addEventListener("click", addEvent);

  el.append(
    field(tt("psc.37ba1f"), input.el, undefined, true),
    field(tt("psc.8adabd"), output.el, undefined, true),
    field(tt("psc.2c6327"), video.el, tt("psc.406613")),
    field(tt("psc.16202d"), audio.el, tt("psc.fc2ebc")),
    field(tt("psc.f46020"), duration),
    h("div", HELP_CSS, tt("psc.26d291")),
    timeline,
    list,
    addBtn,
  );
  return {
    el,
    read: () => {
      const p = input.input.value.trim();
      const o = output.input.value.trim();
      if (!p || !o) return { ok: false, error: tt("psc.9205c3") };
      if (rows.length === 0) return { ok: false, error: tt("psc.4aaf16") };
      const events: OverlayEvent[] = [];
      for (const r of rows) {
        const s = Number(r.start.value);
        const e = Number(r.end.value);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return { ok: false, error: tt("psc.5f5f22") };
        if (r.kindSel.value === "text") {
          if (!r.textInput.value.trim()) return { ok: false, error: tt("psc.9c9479") };
          events.push({ kind: "text", text: r.textInput.value, startSeconds: s, endSeconds: e, x: r.x.value.trim() || undefined, y: r.y.value.trim() || undefined });
        } else {
          if (!r.imagePath.value.trim()) return { ok: false, error: tt("psc.049b05") };
          events.push({ kind: "image", imagePath: r.imagePath.value.trim(), startSeconds: s, endSeconds: e, x: r.x.value.trim() || undefined, y: r.y.value.trim() || undefined });
        }
      }
      const v = video.read();
      const a = audio.read();
      return {
        ok: true,
        command: "ffmpeg",
        args: buildOverlayArgs({ inputPath: p, outputPath: o, videoCodec: v.codec || undefined, audioCodec: a.codec || undefined, events }),
      };
    },
  };
}

function buildScript(cfg: Record<string, unknown>, vars: VariableOption[], commands: string[]): FormPart {
  const el = h("div", "");
  const hasFFmpeg = commands.includes("ffmpeg");
  const hasFFprobe = commands.includes("ffprobe");
  let mode: "wizard" | "advanced" = cfg.command ? "advanced" : "wizard";

  // ---- Erweitert (Rohargumente) — unverändert gegenüber vorher, bleibt
  // der garantierte Experten-/Fallback-Weg. ----------------------------
  const advancedWrap = h("div", "");
  const current = String(cfg.command ?? "");
  const cmdOpts = [{ value: "", label: tt("psc.6646ff") }, ...commands.map((c) => ({ value: c, label: c }))];
  if (current && !commands.includes(current)) cmdOpts.push({ value: current, label: tt("psc.a59b9d", { p0: current }) });
  const cmd = select(cmdOpts, current, "command");
  const tpl = select(
    [{ value: "", label: tt("psc.2c4740") }, ...SCRIPT_TEMPLATES.filter((t) => commands.includes(t.command)).map((t) => ({ value: t.id, label: t.label }))],
    "",
    "template",
  );
  const tplHelp = h("span", HELP_CSS);
  const argsList = h("div", "");
  const argInputs: HTMLInputElement[] = [];
  const argStatuses: HTMLElement[] = [];

  // ---- Pro-Modus: Validierung + Autovervollständigung (Kapitel 23,
  // Schritt 5) -----------------------------------------------------
  //
  // Jedes bekannte Flag wird geprüft (global aus GLOBAL_FFMPEG_FLAGS
  // ODER eine per Parameter-Explorer bereits nachgeschlagene AVOption,
  // s. dynamicOptions) — unbekannte Flags bleiben absichtlich
  // unbewertet (roher Modus bleibt frei, s. Moduldoku zu
  // validateArgValue). Einfache Nachbarschafts-Heuristik statt vollem
  // ffmpeg-Grammatik-Parser: Zeile i gilt als WERT von Zeile i-1, wenn
  // Zeile i-1 ein bekanntes, wertbehaftetes Flag ist.
  const dynamicOptions = new Map<string, FFOption>();
  const flagCandidates = (): { name: string; description: string }[] => [
    ...GLOBAL_FFMPEG_FLAGS.map((f) => ({ name: f.name, description: f.description })),
    ...fetchedGlobalFlagDefs.filter((f) => !GLOBAL_FFMPEG_FLAGS.some((g) => g.name === f.name)).map((f) => ({ name: f.name, description: f.description })),
    ...[...dynamicOptions.entries()].map(([name, opt]) => ({ name, description: opt.description ?? "" })),
  ];

  const revalidateArgs = () => {
    argStatuses.forEach((s) => {
      s.textContent = "";
      s.style.display = "none";
    });
    argInputs.forEach((input, i) => input.style.borderColor = "");
    for (let i = 1; i < argInputs.length; i++) {
      const flag = argInputs[i - 1].value.trim();
      if (!flag.startsWith("-")) continue;
      const isKnownValueFlag = dynamicOptions.has(flag) || (lookupGlobalFlag(flag)?.type !== "boolean" && lookupGlobalFlag(flag) !== undefined);
      if (!isKnownValueFlag) continue;
      const v = validateArgValue(flag, argInputs[i].value.trim(), dynamicOptions, fetchedGlobalFlagDefs);
      if (!v.ok) {
        argStatuses[i].textContent = `⚠ ${flag}: ${v.message ?? tt("psc.d1762c")}`;
        argStatuses[i].style.display = "block";
        argInputs[i].style.borderColor = "var(--omp-error)";
      }
    }
    // Bekannte, wertlose (boolean-)Flags mit versehentlich gesetztem
    // Wert in der EIGENEN Zeile markieren (z. B. "-y" gefolgt von
    // "true" in derselben Zeile kommt nicht vor, da Flags/Werte immer
    // eigene Zeilen sind — hier geht es um ein bekanntes Flag, dessen
    // NÄCHSTE Zeile fälschlich wie ein Wert aussieht, obwohl es keinen
    // nimmt; das wird oben bereits übersprungen, da isKnownValueFlag
    // dafür false ist — kein weiterer Check nötig).
  };

  let autocompleteBox: HTMLElement | null = null;
  const closeAutocomplete = () => {
    autocompleteBox?.remove();
    autocompleteBox = null;
  };
  const openAutocomplete = (forInput: HTMLInputElement) => {
    closeAutocomplete();
    const q = forInput.value.trim();
    if (!q.startsWith("-") || q.length < 1) return;
    // Tippfehler-Toleranz (Kapitel 25 R5) auch hier: ein vertipptes Flag
    // (z. B. "-crg" statt "-crf") bleibt in der Vorschlagsliste, nicht
    // nur im großen Parameter-Explorer.
    const matches = searchEntries(
      q,
      flagCandidates().map((c) => ({ name: c.name, description: c.description, value: c })),
      12,
    );
    if (matches.length === 0) return;
    const rect = forInput.getBoundingClientRect();
    const box = h(
      "div",
      `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${Math.max(rect.width, 260)}px;` +
        "max-height:220px;overflow:auto;background:var(--omp-surface-raised);border:1px solid var(--omp-border);" +
        "border-radius:4px;z-index:3000;box-shadow:0 4px 12px rgba(0,0,0,0.35);",
    );
    for (const m of matches) {
      const c = m.entry.value;
      const row = h("div", "padding:4px 6px;cursor:pointer;font-size:var(--omp-font-size-xs);border-bottom:1px solid var(--omp-border);");
      row.innerHTML =
        `<div style="font-family:ui-monospace,monospace;font-weight:600;">${m.fuzzy ? "≈ " : ""}${c.name}</div>` + (c.description ? `<div style="color:var(--omp-text-dim);">${c.description}</div>` : "");
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        forInput.value = c.name;
        forInput.dispatchEvent(new Event("input", { bubbles: true }));
        closeAutocomplete();
      });
      box.appendChild(row);
    }
    autocompleteBox = box;
    document.body.appendChild(box);
  };

  const addArg = (v = "") => {
    const line = h("div", "display:grid;grid-template-columns:1fr auto auto;gap:4px;margin-top:4px;");
    const i = textInput(v, tt("psc.574722"), "arg");
    i.style.fontFamily = "ui-monospace,monospace";
    argInputs.push(i);
    const status = h("div", "grid-column:1;font-size:var(--omp-font-size-xs);color:var(--omp-error);display:none;");
    argStatuses.push(status);
    i.addEventListener("input", () => {
      openAutocomplete(i);
      revalidateArgs();
    });
    i.addEventListener("blur", () => window.setTimeout(closeAutocomplete, 150));
    const rm = h("button", "", "✕");
    rm.type = "button";
    rm.addEventListener("click", () => {
      const idx = argInputs.indexOf(i);
      argInputs.splice(idx, 1);
      argStatuses.splice(idx, 1);
      line.remove();
      status.remove();
      revalidateArgs();
    });
    line.append(i, variableButton(vars, "template", () => i), rm);
    argsList.append(line, status);
    revalidateArgs();
    return i;
  };
  const setArgs = (args: string[]) => {
    argInputs.length = 0;
    argStatuses.length = 0;
    argsList.replaceChildren();
    for (const a of args) addArg(a);
  };
  setArgs(Array.isArray(cfg.args) ? (cfg.args as string[]) : []);

  // ---- Parameter-Explorer: nach Encoder-/Decoder-/Muxer-/Demuxer-/
  // Filter-Optionen suchen, per Klick als neues Argument einfügen
  // (und für Validierung/Autovervollständigung merken) — deckt "jeder
  // Parameter muss suchbar/adressierbar sein" auch im Experten-Modus
  // ab, ohne beim Öffnen hunderte AVOption-Detailabfragen auf einmal
  // auszulösen (nur Listen sind vorab bekannt, Details erst on-demand
  // je angeklicktem Treffer — dasselbe Cache-Prinzip wie ffmpeg-client.ts).
  const explorerToggle = h("button", "margin-top:8px;", tt("psc.6940ee"));
  explorerToggle.type = "button";
  const explorerPanel = h("div", "margin-top:4px;border:1px solid var(--omp-border);border-radius:4px;padding:6px;display:none;");
  const explorerSearch = textInput("", "z. B. crf, libx264, scale, loglevel …");
  const explorerIndexStatus = h("div", HELP_CSS + "margin-top:2px;");
  const explorerResults = h("div", "max-height:260px;overflow:auto;margin-top:4px;");
  let explorerCatalog: { name: string; kind: "encoder" | "decoder" | "muxer" | "demuxer" | "filter"; description: string }[] | null = null;
  const loadExplorerCatalog = async () => {
    if (explorerCatalog) return explorerCatalog;
    const [encoders, decoders, formats, filters] = await Promise.all([
      fetchFFmpegList<FFCodecEntry>("encoders"),
      fetchFFmpegList<FFCodecEntry>("decoders"),
      fetchFFmpegList<FFFormatEntry>("formats"),
      fetchFFmpegList<FFFilterEntry>("filters"),
    ]);
    explorerCatalog = [
      ...encoders.map((c) => ({ name: c.name, kind: "encoder" as const, description: c.description })),
      ...decoders.map((c) => ({ name: c.name, kind: "decoder" as const, description: c.description })),
      ...formats.filter((f) => f.muxing).map((f) => ({ name: f.name, kind: "muxer" as const, description: f.description })),
      ...formats.filter((f) => f.demuxing).map((f) => ({ name: f.name, kind: "demuxer" as const, description: f.description })),
      ...filters.map((f) => ({ name: f.name, kind: "filter" as const, description: f.description })),
    ];
    return explorerCatalog;
  };
  const kindLabel: Record<string, string> = { encoder: "Encoder", decoder: "Decoder", muxer: "Muxer/Container", demuxer: "Demuxer", filter: "Filter" };
  const insertGlobalFlag = (name: string) => {
    addArg(name);
    const def = lookupGlobalFlag(name);
    if (def && def.type !== "boolean") addArg().focus();
  };
  const insertOption = (flagName: string, opt: FFOption) => {
    dynamicOptions.set(flagName, opt);
    addArg(flagName);
    addArg().focus();
  };
  const updateExplorerIndexStatus = () => {
    const globalPart = globalFlagsLoaded ? tt("psc.a6eb55", { p0: fetchedGlobalFlagDefs.length }) : "globale Flags laden …";
    const paramPart = fullOptionIndexReady
      ? tt("psc.345b00", { p0: fullOptionIndex.length })
      : fullOptionIndexStarted
      ? tt("psc.a96ba4", { p0: fullOptionIndex.length })
      : tt("psc.d79ecf");
    explorerIndexStatus.textContent = `${globalPart} · ${paramPart} durchsuchbar.`;
  };
  // Tastatur-Navigation über alle Top-Level-Treffer hinweg (Kapitel 25
  // R5) — bewusst NICHT auf die dynamisch nachgeladenen Unteroptionen
  // eines aufgeklappten Katalog-Eintrags ausgeweitet (die erscheinen erst
  // nach einem eigenen Klick/Enter auf den Katalog-Kopf, bleiben also
  // weiterhin nur per Maus erreichbar) — hält die erste Umsetzung einfach
  // und kollidiert nicht mit normaler Text-Cursor-Navigation im Suchfeld.
  let navigableRows: { el: HTMLElement; activate: () => void }[] = [];
  let activeIndex = -1;
  const ACTIVE_ROW_BG = "color-mix(in srgb, var(--omp-info) 18%, transparent)";
  const setActiveIndex = (i: number) => {
    if (navigableRows[activeIndex]) navigableRows[activeIndex].el.style.background = "";
    activeIndex = navigableRows.length === 0 ? -1 : Math.max(0, Math.min(i, navigableRows.length - 1));
    const row = navigableRows[activeIndex];
    if (row) {
      row.el.style.background = ACTIVE_ROW_BG;
      row.el.scrollIntoView({ block: "nearest" });
    }
  };
  const addNavigableRow = (el: HTMLElement, activate: () => void) => {
    const index = navigableRows.length;
    el.addEventListener("mouseenter", () => setActiveIndex(index));
    navigableRows.push({ el, activate });
  };

  const runExplorerSearch = async () => {
    const q = explorerSearch.value.trim();
    explorerResults.replaceChildren();
    navigableRows = [];
    activeIndex = -1;
    if (!q) return;

    const globalEntries = GLOBAL_FFMPEG_FLAGS.map((f) => ({ name: f.name, description: f.description, value: f }));
    for (const m of searchEntries(q, globalEntries)) {
      const row = h("div", "padding:4px;cursor:pointer;border-bottom:1px solid var(--omp-border);");
      const head = h("div", "");
      head.append(h("b", "", m.entry.value.name), categoryBadge(tt("psc.cbb958")));
      if (m.fuzzy) head.appendChild(categoryBadge("≈ Tippfehler?", "cue"));
      row.append(head, h("div", HELP_CSS, m.entry.value.description));
      const activate = () => insertGlobalFlag(m.entry.value.name);
      row.addEventListener("click", activate);
      addNavigableRow(row, activate);
      explorerResults.appendChild(row);
    }

    // Der vollständige `-h full`-Import (Kapitel 23, Schritt 5) — nur
    // Treffer, die die kuratierte Tabelle oben nicht schon zeigte.
    const curatedNames = new Set(GLOBAL_FFMPEG_FLAGS.map((f) => f.name));
    const fetchedEntries = fetchedGlobalFlagDefs.filter((f) => !curatedNames.has(f.name)).map((f) => ({ name: f.name, description: f.description, value: f }));
    for (const m of searchEntries(q, fetchedEntries)) {
      const row = h("div", "padding:4px;cursor:pointer;border-bottom:1px solid var(--omp-border);");
      const head = h("div", "");
      head.append(h("b", "", m.entry.value.name), categoryBadge(tt("psc.a0f383")));
      if (m.fuzzy) head.appendChild(categoryBadge("≈ Tippfehler?", "cue"));
      row.append(head, h("div", HELP_CSS, m.entry.value.description));
      const activate = () => insertGlobalFlag(m.entry.value.name);
      row.addEventListener("click", activate);
      addNavigableRow(row, activate);
      explorerResults.appendChild(row);
    }

    // Direkter Parameter-Treffer (z. B. "-crf" findet libx264, ohne dass
    // der Encoder vorher von Hand aufgeklappt wurde) — der eigentliche
    // Kern von "jeder Parameter muss suchbar sein". Auf 30 EINDEUTIGE
    // Treffer begrenzt (nicht 30 rohe, dann dedupliziert — sonst könnten
    // Duplikate die sichtbare Trefferzahl unter 30 drücken).
    const paramEntries = fullOptionIndex.map((p) => ({ name: p.flag, description: p.description, value: p }));
    const seen = new Set<string>();
    let paramShown = 0;
    for (const m of searchEntries(q, paramEntries)) {
      if (paramShown >= 30) break;
      const key = `${m.entry.value.flag}@${m.entry.value.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      paramShown++;
      const row = h("div", "padding:4px;cursor:pointer;border-bottom:1px solid var(--omp-border);");
      const head = h("div", "");
      head.append(h("span", "font-family:ui-monospace,monospace;font-weight:600;", m.entry.value.flag), categoryBadge(m.entry.value.source));
      if (m.fuzzy) head.appendChild(categoryBadge("≈ Tippfehler?", "cue"));
      row.append(head, h("div", HELP_CSS, optionHelpText(m.entry.value.opt)));
      const activate = () => insertOption(m.entry.value.flag, m.entry.value.opt);
      row.addEventListener("click", activate);
      addNavigableRow(row, activate);
      explorerResults.appendChild(row);
    }

    const catalog = await loadExplorerCatalog();
    const catEntries = catalog.map((c) => ({ name: c.name, description: c.description, value: c }));
    for (const m of searchEntries(q, catEntries, 25)) {
      const c = m.entry.value;
      const row = h("div", "padding:4px;border-bottom:1px solid var(--omp-border);");
      const head = h("div", "cursor:pointer;");
      const headText = h("div", "");
      headText.append(h("b", "", c.name), categoryBadge(kindLabel[c.kind]));
      if (m.fuzzy) headText.appendChild(categoryBadge("≈ Tippfehler?", "cue"));
      head.append(headText, h("div", HELP_CSS, c.description));
      const sub = h("div", "margin-left:10px;display:none;");
      const toggle = async () => {
        if (sub.style.display === "none") {
          sub.style.display = "block";
          if (!sub.dataset.loaded) {
            sub.dataset.loaded = "1";
            const detail = await fetchFFmpegDetail(c.kind, c.name);
            sub.replaceChildren();
            for (const opt of detail?.options ?? []) {
              const optRow = h("div", "padding:2px 4px;cursor:pointer;");
              optRow.innerHTML = `<span style="font-family:ui-monospace,monospace;">${opt.name}</span> <span style="${HELP_CSS}">${optionHelpText(opt)}</span>`;
              optRow.addEventListener("click", (ev) => {
                ev.stopPropagation();
                insertOption(opt.name, opt);
              });
              sub.appendChild(optRow);
            }
            if (!detail?.options?.length) sub.appendChild(h("div", HELP_CSS, tt("psc.cbc4b0")));
          }
        } else {
          sub.style.display = "none";
        }
      };
      head.addEventListener("click", () => void toggle());
      addNavigableRow(head, () => void toggle());
      row.append(head, sub);
      explorerResults.appendChild(row);
    }
  };
  explorerSearch.addEventListener("input", () => void runExplorerSearch());
  explorerSearch.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIndex(activeIndex + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIndex(activeIndex - 1);
    } else if (ev.key === "Enter") {
      if (activeIndex >= 0 && navigableRows[activeIndex]) {
        ev.preventDefault();
        navigableRows[activeIndex].activate();
      }
    } else if (ev.key === "Escape") {
      explorerSearch.value = "";
      void runExplorerSearch();
    }
  });
  explorerToggle.addEventListener("click", () => {
    const opening = explorerPanel.style.display === "none";
    explorerPanel.style.display = opening ? "block" : "none";
    if (opening) {
      updateExplorerIndexStatus();
      void ensureGlobalFlags(() => {
        updateExplorerIndexStatus();
        void runExplorerSearch();
      });
      void ensureFullOptionIndex(() => {
        updateExplorerIndexStatus();
        void runExplorerSearch();
      });
    }
  });
  explorerPanel.append(
    field(
      tt("psc.89cdb8"),
      explorerSearch,
      tt("psc.8c458f"),
    ),
    explorerIndexStatus,
    explorerResults,
  );
  tpl.addEventListener("change", () => {
    const t = SCRIPT_TEMPLATES.find((x) => x.id === tpl.value);
    if (!t) return;
    cmd.value = t.command;
    setArgs(t.args);
    tplHelp.textContent = t.help + tt("psc.cd6dbf");
  });
  const addBtn = h("button", "margin-top:4px;", "+ Argument");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => addArg());
  const pasteBtn = h("button", "margin-top:4px;margin-left:4px;", tt("psc.a7b058"));
  pasteBtn.type = "button";
  pasteBtn.title = tt("psc.e91a0f");
  pasteBtn.addEventListener("click", () => {
    const line = window.prompt(tt("psc.4eb447"), "");
    if (line === null) return;
    const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const p of parts) addArg(p.replace(/^["']|["']$/g, ""));
  });
  advancedWrap.append(
    field(tt("psc.40c573"), cmd, commands.length ? tt("psc.819ee1", { p0: commands.join(", ") }) : tt("psc.8330a3"), true),
    field(tt("psc.07411f"), tpl),
    tplHelp,
    field(tt("psc.c9d7f8"), argsList, tt("psc.8584a0")),
    addBtn,
    pasteBtn,
    explorerToggle,
    explorerPanel,
  );

  // ---- Assistent (aus W1 gespeist) ------------------------------------
  const wizardWrap = h("div", "");
  const intentOptions = SCRIPT_INTENTS.filter((i) => (i.id === "probe" ? hasFFprobe : hasFFmpeg));
  const intentSel = select(intentOptions.map((i) => ({ value: i.id, label: i.label })), intentOptions[0]?.id ?? "");
  const intentHelp = h("div", HELP_CSS + "margin-top:2px;");
  const dynamicArea = h("div", "");
  let activeForm: ScriptWizardForm | null = null;
  const previewLabel = h("div", HELP_CSS + "font-weight:600;margin-top:8px;", tt("psc.ffd103"));
  const preview = h("pre", "background:var(--omp-surface-raised);padding:6px;border-radius:4px;font-size:var(--omp-font-size-xs);white-space:pre-wrap;word-break:break-all;margin-top:2px;");
  const updatePreview = () => {
    if (!activeForm) return;
    const r = activeForm.read();
    preview.textContent = r.ok ? `${r.command} ${r.args.join(" ")}` : `(${r.error})`;
  };
  const renderIntent = () => {
    dynamicArea.replaceChildren();
    const intent = SCRIPT_INTENTS.find((i) => i.id === intentSel.value);
    intentHelp.textContent = intent?.help ?? "";
    switch (intentSel.value) {
      case "convert":
        activeForm = buildScriptWizardConvert(vars);
        break;
      case "concat":
        activeForm = buildScriptWizardConcat(vars);
        break;
      case "overlay":
        activeForm = buildScriptWizardOverlay(vars);
        break;
      default: {
        // Kapitel 25 R1: jede sonstige (einfache) Aufgabe kommt aus der
        // generischen Registry statt einem eigenen `case` — neue solche
        // Aufgaben brauchen hier keine Änderung mehr.
        const task = genericScriptTaskById(intentSel.value);
        activeForm = task ? buildGenericScriptForm(task, vars) : null;
      }
    }
    if (activeForm) dynamicArea.appendChild(activeForm.el);
    updatePreview();
  };
  intentSel.addEventListener("change", renderIntent);
  dynamicArea.addEventListener("input", updatePreview);
  dynamicArea.addEventListener("change", updatePreview);
  if (intentOptions.length === 0) {
    wizardWrap.appendChild(h("div", HELP_CSS + "margin-top:8px;", tt("psc.3ce979")));
  } else {
    wizardWrap.append(field(tt("psc.8c5713"), intentSel), intentHelp, dynamicArea, previewLabel, preview);
    renderIntent();
  }

  // ---- Moduswechsel -----------------------------------------------------
  const modeToggle = h("button", "margin-top:10px;");
  modeToggle.type = "button";
  const syncMode = () => {
    wizardWrap.style.display = mode === "wizard" ? "block" : "none";
    advancedWrap.style.display = mode === "advanced" ? "block" : "none";
    modeToggle.textContent = mode === "wizard" ? tt("psc.443b5b") : tt("psc.df82e3");
  };
  modeToggle.addEventListener("click", () => {
    mode = mode === "wizard" ? "advanced" : "wizard";
    syncMode();
  });
  if (intentOptions.length === 0) mode = "advanced";
  syncMode();

  const timeout = durationInput(typeof cfg.timeoutSeconds === "number" ? cfg.timeoutSeconds : undefined);
  el.append(wizardWrap, advancedWrap, modeToggle, field(tt("psc.31b5c0"), timeout.el, tt("psc.733355")));

  return {
    el,
    read: () => {
      const t = timeout.read();
      if (t === null) return { ok: false, error: tt("psc.de6fc7") };
      if (mode === "advanced") {
        if (!cmd.value) return { ok: false, error: tt("psc.305b37") };
        const out = { ...cfg, command: cmd.value };
        setOrDelete(out, "args", argInputs.map((i) => i.value).filter((v) => v !== ""));
        setOrDelete(out, "timeoutSeconds", t);
        return { ok: true, config: out };
      }
      if (!activeForm) return { ok: false, error: tt("psc.05b4e5") };
      const r = activeForm.read();
      if (!r.ok) return { ok: false, error: r.error };
      const out = { ...cfg, command: r.command, args: r.args };
      setOrDelete(out, "timeoutSeconds", t);
      return { ok: true, config: out };
    },
  };
}

interface NodeInfo {
  id: string;
  label: string;
  online: boolean;
  instance_id?: string;
}
interface MethodSpec {
  name: string;
  args: { name: string; type: string }[];
}

function buildMediaFunction(cfg: Record<string, unknown>): FormPart {
  const el = h("div", "");
  const inst = select([{ value: "", label: "lade laufende Microservices …" }], "", "instanceId");
  const meth = select([{ value: "", label: tt("psc.d8e721") }], "", "method");
  const argsBox = h("div", "");
  const argsIn: Record<string, { input: HTMLInputElement | HTMLSelectElement; type: string }> = {};
  const origArgs = (cfg.args && typeof cfg.args === "object" && !Array.isArray(cfg.args)) ? cfg.args as Record<string, unknown> : {};
  let methods: MethodSpec[] = [];
  let nodes: NodeInfo[] = [];

  const renderArgs = () => {
    argsBox.replaceChildren();
    for (const k of Object.keys(argsIn)) delete argsIn[k];
    const m = methods.find((x) => x.name === meth.value);
    if (!m) return;
    if (m.args.length === 0) {
      argsBox.appendChild(h("div", HELP_CSS + "margin-top:8px;", tt("psc.1b1539")));
      return;
    }
    for (const a of m.args) {
      const prev = origArgs[a.name];
      let input: HTMLInputElement | HTMLSelectElement;
      if (a.type === "boolean") {
        input = select([{ value: "true", label: "ja" }, { value: "false", label: "nein" }], prev === false ? "false" : "true");
      } else {
        input = textInput(prev === undefined ? "" : String(prev), a.type === "number" ? tt("psc.e9716b") : tt("psc.9dffbf"));
      }
      input.name = `arg-${a.name}`;
      argsIn[a.name] = { input, type: a.type };
      argsBox.appendChild(field(a.name, input, tt("psc.074e19", { p0: a.type })));
    }
  };

  const loadMethods = async () => {
    methods = [];
    meth.replaceChildren();
    const node = nodes.find((n) => n.instance_id === inst.value);
    if (!node) {
      meth.appendChild(new Option(tt("psc.d8e721"), ""));
      if (cfg.method) meth.appendChild(new Option(tt("psc.5d2bfb", { p0: cfg.method }), String(cfg.method)));
      meth.value = String(cfg.method ?? "");
      renderArgs();
      return;
    }
    try {
      const res = await apiFetch(`/api/v1/nodes/${node.id}/descriptor`);
      if (res.ok) methods = ((await res.json()) as { methods?: MethodSpec[] }).methods ?? [];
    } catch {
      // s. u.
    }
    meth.appendChild(new Option(methods.length ? tt("psc.5eea30") : tt("psc.6bf2f0"), ""));
    for (const m of methods) meth.appendChild(new Option(m.name, m.name));
    if (cfg.method && !methods.some((m) => m.name === cfg.method)) meth.appendChild(new Option(tt("psc.edb0ba", { p0: cfg.method }), String(cfg.method)));
    meth.value = String(cfg.method ?? "");
    renderArgs();
  };

  (async () => {
    try {
      const res = await apiFetch("/api/v1/nodes");
      nodes = res.ok ? ((await res.json()) as NodeInfo[]).filter((n) => n.instance_id) : [];
    } catch {
      nodes = [];
    }
    inst.replaceChildren(new Option(nodes.length ? tt("psc.4bc1ca") : tt("psc.882bf5"), ""));
    for (const n of nodes) inst.appendChild(new Option(`${n.label || n.instance_id}${n.online ? "" : tt("psc.e54b72")}`, n.instance_id!));
    if (cfg.instanceId && !nodes.some((n) => n.instance_id === cfg.instanceId)) {
      inst.appendChild(new Option(tt("psc.bd2472", { p0: cfg.instanceId }), String(cfg.instanceId)));
    }
    inst.value = String(cfg.instanceId ?? "");
    await loadMethods();
  })();
  inst.addEventListener("change", () => void loadMethods());
  meth.addEventListener("change", renderArgs);

  el.append(
    field(tt("psc.b1a5f2"), inst, tt("psc.cf6708"), true),
    field(tt("psc.b104f8"), meth, undefined, true),
    argsBox,
  );
  return {
    el,
    read: () => {
      if (!inst.value || !meth.value) return { ok: false, error: tt("psc.ce7b6e") };
      const out = { ...cfg, instanceId: inst.value, method: meth.value };
      const args: Record<string, unknown> = {};
      for (const [k, { input, type }] of Object.entries(argsIn)) {
        const v = input.value.trim();
        if (v === "") continue;
        if (type === "number") {
          const n = Number(v.replace(",", "."));
          if (!Number.isFinite(n)) return { ok: false, error: tt("psc.bb7773", { p0: k }) };
          args[k] = n;
        } else if (type === "boolean") args[k] = v === "true";
        else args[k] = v;
      }
      // Methode ohne bekannte Argumentliste (Microservice offline): alte Argumente behalten.
      if (Object.keys(argsIn).length === 0 && meth.value === cfg.method) setOrDelete(out, "args", cfg.args);
      else setOrDelete(out, "args", Object.keys(args).length ? args : undefined);
      return { ok: true, config: out };
    },
  };
}

function buildSubworkflow(cfg: Record<string, unknown>): FormPart {
  const el = h("div", "");
  const defSel = select([{ value: "", label: "lade Prozesse …" }], "", "processDefinitionId");
  const verSel = select([{ value: "", label: tt("psc.249a28") }], "", "processVersionId");
  const inputPairs = flatStringObject(cfg.input);
  const inputKv = inputPairs !== null ? keyValueEditor(inputPairs, { keyPlaceholder: tt("psc.144d62"), valuePlaceholder: tt("psc.7b71ec"), name: "subinput" }) : null;
  const loadVersions = async () => {
    verSel.replaceChildren(new Option(tt("psc.249a28"), ""));
    if (!defSel.value) return;
    try {
      const res = await apiFetch(`/api/v1/process-definitions/${defSel.value}/versions`);
      const versions = res.ok ? ((await res.json()) as { id: string; versionNumber: number; status: string }[]) : [];
      for (const v of versions.filter((v) => v.status === "published").sort((a, b) => b.versionNumber - a.versionNumber)) {
        verSel.appendChild(new Option(tt("psc.4b6924", { p0: v.versionNumber }), v.id));
      }
    } catch {
      // nur "neueste" anbieten
    }
    if (cfg.processVersionId && ![...verSel.options].some((o) => o.value === cfg.processVersionId)) {
      verSel.appendChild(new Option(tt("psc.4d0aaf"), String(cfg.processVersionId)));
    }
    verSel.value = defSel.value === cfg.processDefinitionId ? String(cfg.processVersionId ?? "") : "";
  };
  (async () => {
    let defs: { id: string; name: string }[] = [];
    try {
      const res = await apiFetch("/api/v1/process-definitions");
      defs = res.ok ? await res.json() : [];
    } catch {
      // leer
    }
    defSel.replaceChildren(new Option(tt("psc.729570"), ""));
    for (const d of defs) defSel.appendChild(new Option(d.name, d.id));
    defSel.value = String(cfg.processDefinitionId ?? "");
    await loadVersions();
  })();
  defSel.addEventListener("change", () => void loadVersions());
  el.append(field(tt("psc.d6e26f"), defSel, tt("psc.5d56b7"), true), field(tt("psc.34b6cd"), verSel));
  if (inputKv) el.appendChild(field(tt("psc.96b30c"), inputKv.el));
  else el.appendChild(h("div", HELP_CSS + "margin-top:8px;", tt("psc.be6e5d")));
  return {
    el,
    read: () => {
      if (!defSel.value) return { ok: false, error: tt("psc.78f7d8") };
      const out = { ...cfg, processDefinitionId: defSel.value };
      setOrDelete(out, "processVersionId", verSel.value);
      if (inputKv) setOrDelete(out, "input", pairsToObject(inputKv.read()));
      return { ok: true, config: out };
    },
  };
}

function buildNotification(cfg: Record<string, unknown>): FormPart {
  const el = h("div", "");
  const subject = textInput(String(cfg.subject ?? ""), tt("psc.980d97"), "subject");
  const payloadPairs = flatStringObject(cfg.payload);
  const kv = payloadPairs !== null ? keyValueEditor(payloadPairs, { keyPlaceholder: tt("psc.144d62"), valuePlaceholder: tt("psc.7b71ec"), name: "payload" }) : null;
  el.append(field(tt("psc.3a9d26"), subject, tt("psc.da13c4"), true));
  if (kv) el.appendChild(field(tt("psc.c2df59"), kv.el));
  else el.appendChild(h("div", HELP_CSS + "margin-top:8px;", tt("psc.16e638")));
  return {
    el,
    read: () => {
      if (!subject.value.trim()) return { ok: false, error: tt("psc.8b8a99") };
      const out = { ...cfg, subject: subject.value.trim() };
      if (kv) setOrDelete(out, "payload", pairsToObject(kv.read()));
      return { ok: true, config: out };
    },
  };
}

function buildInfoOnly(text: string, cfg: Record<string, unknown>): FormPart {
  const el = h("div", HELP_CSS + "margin-top:8px;", text);
  return { el, read: () => ({ ok: true, config: Object.keys(cfg).length ? cfg : undefined }) };
}

function buildForm(step: DraftStep, ctx: StepConfigContext, vars: VariableOption[]): FormPart {
  const raw = step.config;
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  switch (step.type) {
    case "wait":
    case "timer":
      return buildWait(cfg);
    case "human_task":
      return buildHumanTask(cfg, false);
    case "approval":
      return buildHumanTask(cfg, true);
    case "condition":
      return buildCondition(cfg, vars);
    case "branch":
      return buildBranch(cfg, vars);
    case "service_call":
      return buildServiceCall(cfg, vars);
    case "script":
      return buildScript(cfg, vars, ctx.scriptCommands);
    case "media_function":
      return buildMediaFunction(cfg);
    case "subworkflow":
      return buildSubworkflow(cfg);
    case "notification":
      return buildNotification(cfg);
    case "parallel":
      return buildInfoOnly(tt("psc.1a58bf"), cfg);
    case "join":
      return buildInfoOnly(tt("psc.3ee9be"), cfg);
    default:
      return buildInfoOnly(tt("psc.7cc481"), cfg);
  }
}

// ---- Dialog -----------------------------------------------------------------------------------

export function openStepConfigModal(host: HTMLElement, ctx: StepConfigContext, onApply: (r: StepConfigResult) => void) {
  const step = ctx.def.steps.find((s) => s.id === ctx.stepId);
  if (!step) return;
  const vars = variableOptions(ctx.def, ctx.stepId, ctx.triggerFields);
  const info = STEP_TYPE_INFO[step.type];

  const overlay = h("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.zIndex = "2100";
  const modal = h("div", "max-width:640px;max-height:88vh;overflow-y:auto;font-family:var(--omp-font);font-size:var(--omp-font-size-sm);");
  modal.className = "omp-modal";
  modal.setAttribute("data-role", "step-config-modal");
  const title = h("div", "margin-bottom:2px;", `${stepTypeLabel(step.type)}: ${step.name || step.id}`);
  title.className = "omp-h1";
  modal.append(title, h("div", HELP_CSS, info?.help ?? ""));

  const nameInput = textInput(step.name ?? "", tt("psc.441f14"), "name");
  modal.appendChild(field(tt("psc.2eb6eb"), nameInput, tt("psc.f0ab2e")));

  const form = buildForm(step, ctx, vars);
  const formWrap = h("div", "");
  formWrap.appendChild(form.el);
  modal.appendChild(formWrap);

  // Fehlerbehandlung: Wiederholen / Zeitlimit / Kompensation.
  const errSec = section(tt("psc.69794d"));
  const retryOn = h("input");
  retryOn.type = "checkbox";
  retryOn.name = "retry-enabled";
  retryOn.checked = !!step.retry && step.retry.maxAttempts > 1;
  const retryBox = h("div", "display:grid;grid-template-columns:1fr 1fr;gap:8px;");
  const attempts = textInput(String(step.retry?.maxAttempts ?? 3), "", "retry-attempts");
  attempts.inputMode = "numeric";
  const initialParsed = parseGoDuration(step.retry?.initialDelay);
  // Neue Wiederholung: 5 s vorbelegt; bestehende ohne eigene Pause bleibt
  // leer (= Backend-Standard), statt still "5s" hineinzuschreiben.
  const delay = durationInput(initialParsed === null ? undefined : (initialParsed ?? (step.retry ? undefined : 5)), "retry-delay");
  const growing = h("input");
  growing.type = "checkbox";
  growing.checked = step.retry?.backoff === "exponential";
  const growLabel = h("label", "display:flex;align-items:center;gap:4px;margin-top:8px;");
  growLabel.append(growing, document.createTextNode(tt("psc.d6ea9c")));
  retryBox.append(field(tt("psc.cb3186"), attempts), field(tt("psc.877b38"), delay.el), growLabel);
  const retryLabel = h("label", "display:flex;align-items:center;gap:4px;margin-top:6px;");
  retryLabel.append(retryOn, document.createTextNode(tt("psc.f39ab3")));
  const syncRetry = () => (retryBox.style.display = retryOn.checked ? "grid" : "none");
  retryOn.addEventListener("change", syncRetry);
  syncRetry();

  const timeout = durationInput(step.timeoutSeconds, "timeout");
  const comp = select(
    [{ value: "", label: tt("psc.7abaf8") }, ...ctx.def.steps.filter((s) => s.id !== step.id).map((s) => ({ value: s.id, label: s.name || s.id }))],
    step.compensationStepId ?? "",
    "compensation",
  );
  errSec.append(
    retryLabel,
    retryBox,
    field(tt("psc.c288c7"), timeout.el, tt("psc.faa307")),
    field(tt("psc.d8dc39"), comp, tt("psc.a92403")),
  );
  modal.appendChild(errSec);

  // Erweitert (JSON) — bewusst am Ende und zugeklappt.
  const adv = h("details", "margin-top:14px;");
  const advSum = h("summary", "cursor:pointer;" + HELP_CSS, tt("psc.9b0008"));
  adv.appendChild(advSum);
  const advNote = h("div", HELP_CSS + "margin:4px 0;", tt("psc.3404a3"));
  const advArea = h("textarea", "width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);resize:vertical;");
  advArea.rows = 8;
  advArea.name = "advanced-json";
  adv.append(advNote, advArea);
  adv.addEventListener("toggle", () => {
    if (!adv.open) return;
    const r = form.read();
    advArea.value = JSON.stringify(r.ok ? r.config ?? {} : step.config ?? {}, null, 2);
    formWrap.style.opacity = "0.5";
    formWrap.style.pointerEvents = "none";
  });
  adv.addEventListener("toggle", () => {
    if (adv.open) return;
    formWrap.style.opacity = "";
    formWrap.style.pointerEvents = "";
  });
  modal.appendChild(adv);

  // Knopfleiste klebt am unteren Rand des (scrollbaren) Dialogs — bei
  // langen Formularen (Vorlagen mit vielen Argumenten) sonst erst nach
  // Scrollen sichtbar (im Live-Klicktest aufgefallen).
  const actions = h(
    "div",
    "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;position:sticky;bottom:calc(-1 * var(--omp-space-4, 16px));" +
      "background:var(--omp-surface);padding:8px 0;border-top:1px solid var(--omp-border);",
  );
  const cancel = h("button", "", tt("psc.4b9727"));
  cancel.addEventListener("click", () => overlay.remove());
  const save = h("button", "", tt("psc.bf8310"));
  save.className = "omp-btn-primary";
  save.setAttribute("data-role", "step-config-apply");
  save.addEventListener("click", () => {
    let config: unknown;
    if (adv.open) {
      if (advArea.value.trim()) {
        try {
          config = JSON.parse(advArea.value);
        } catch (err) {
          showToast(tt("psc.291226", { p0: err instanceof Error ? err.message : String(err) }), { variant: "error" });
          return;
        }
      }
    } else {
      const r = form.read();
      if (!r.ok) {
        showToast(r.error, { variant: "error" });
        return;
      }
      config = r.config;
    }
    let retry: RetryPolicy | undefined;
    if (retryOn.checked) {
      const n = Number(attempts.value);
      const d = delay.read();
      if (!Number.isInteger(n) || n < 2) {
        showToast(tt("psc.51e448"), { variant: "error" });
        return;
      }
      if (d === null) {
        showToast(tt("psc.d0fee9"), { variant: "error" });
        return;
      }
      retry = { ...(step.retry ?? {}), maxAttempts: n, backoff: growing.checked ? "exponential" : "fixed" } as RetryPolicy;
      if (d !== undefined) retry.initialDelay = formatGoDuration(d);
      else if (initialParsed !== null) delete retry.initialDelay; // Rohwert wie "500ms" sonst behalten
    }
    const t = timeout.read();
    if (t === null) {
      showToast(tt("psc.3328a4"), { variant: "error" });
      return;
    }
    onApply({
      name: nameInput.value.trim() || undefined,
      config,
      retry,
      timeoutSeconds: t || undefined,
      compensationStepId: comp.value || undefined,
    });
    overlay.remove();
  });
  actions.append(cancel, save);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  host.appendChild(overlay);
  queueMicrotask(() => nameInput.focus());
}

// Entscheidungs-Label menschenlesbar (Kanten-Beschriftung/Dialoge).
export function decisionLabel(label: string): string {
  return DECISION_LABELS[label] ? `${DECISION_LABELS[label]} (${label})` : label;
}
