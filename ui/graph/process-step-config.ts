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
import { apiFetch } from "../shell/connection.ts";
import { showToast } from "../kit/omp-toast.ts";
import type { DraftDefinition, DraftStep, RetryPolicy } from "./process-editor-logic.ts";
import {
  DECISION_LABELS,
  flatStringObject,
  formatGoDuration,
  insertionText,
  pairsToObject,
  parseGoDuration,
  parseRule,
  RULE_OPERATORS,
  ruleToExpression,
  SCRIPT_TEMPLATES,
  splitSeconds,
  STEP_TYPE_INFO,
  stepTypeLabel,
  type TimeUnit,
  toSeconds,
  UNIT_LABEL,
  type VariableOption,
  variableOptions,
  type OutputField,
} from "./process-step-config-logic.ts";

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
  btn.title = "Einen Wert aus dem Prozesslauf einsetzen (Start-Eingabe, Ergebnis eines vorherigen Schritts …)";
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

  const search = textInput("", "Suchen …");
  pop.appendChild(search);
  const list = h("div", "margin-top:4px;");
  pop.appendChild(list);

  const custom = h("div", "display:flex;gap:4px;margin-top:6px;padding-top:6px;border-top:1px solid var(--omp-border);");
  const customInput = textInput("", "eigenes Eingabefeld, z. B. path");
  const customBtn = h("button", "", "input.… einfügen");
  customBtn.type = "button";
  customBtn.addEventListener("click", () => {
    const k = customInput.value.trim();
    if (!k) return;
    close();
    onPick(/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k) ? `input.${k}` : `input[${JSON.stringify(k)}]`);
  });
  custom.append(customInput, customBtn);
  pop.appendChild(custom);
  pop.appendChild(h("div", HELP_CSS + "margin-top:4px;", "Start-Eingabe-Felder werden beim manuellen Start (JSON) oder vom auslösenden Ereignis geliefert."));

  const render = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    let lastGroup = "";
    const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.path.toLowerCase().includes(q));
    if (shown.length === 0) list.appendChild(h("div", HELP_CSS, "Keine passenden Werte."));
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
    rm.title = "Entfernen";
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
    [{ value: "", label: "– Wert wählen –" }, ...vars.map((v) => ({ value: v.path, label: `${v.label} (${v.group})` }))],
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
  const valIn = textInput(parsed?.value ?? "", "Wert, z. B. approved oder 0", `${name}-value`);
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
    toggle.textContent = free ? "Einfache Regel verwenden" : "Eigener Ausdruck (erweitert)";
  };
  toggle.addEventListener("click", () => {
    if (!free && varSel.value) freeIn.value = ruleToExpression({ variable: varSel.value, op: opSel.value, value: valIn.value });
    if (free) {
      const p = parseRule(freeIn.value);
      if (!p && freeIn.value.trim()) {
        showToast("Dieser Ausdruck passt nicht in eine einfache Regel — bleibt als eigener Ausdruck.", { variant: "info" });
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
  el.appendChild(field("Wartezeit", d.el, "Danach geht der Ablauf automatisch weiter.", true));
  return {
    el,
    read: () => {
      const s = d.read();
      if (s === null) return { ok: false, error: "Wartezeit: keine gültige Zahl." };
      const out = { ...cfg };
      setOrDelete(out, "seconds", s);
      return { ok: true, config: out };
    },
  };
}

function buildHumanTask(cfg: Record<string, unknown>, isApproval: boolean): FormPart {
  const el = h("div", "");
  const title = textInput(String(cfg.title ?? ""), isApproval ? "z. B. Beitrag freigeben" : "z. B. Untertitel prüfen", "title");
  const desc = h("textarea", "width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;");
  desc.name = "description";
  desc.rows = 3;
  desc.value = String(cfg.description ?? "");
  const assignee = textInput(String(cfg.assignee ?? ""), "leer = jeder darf übernehmen", "assignee");
  assignee.setAttribute("list", "omp-process-users");
  void loadUsersDatalist();
  const role = textInput(String(cfg.role ?? ""), "optional, z. B. redaktion", "role");
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
    field("Titel der Aufgabe", title, "Erscheint im Prozesse-Tab unter „Human Tasks“. Leer = Schrittname."),
    field("Beschreibung / Anweisung", desc),
    field("Zuständige Person", assignee),
    field("Rolle", role),
    field("Priorität", prio),
  );
  if (isApproval) {
    el.appendChild(h(
      "div",
      HELP_CSS + "margin-top:8px;",
      "Ergebnis: „freigegeben“, „abgelehnt“ oder „Änderungen angefordert“ — ziehe je Ergebnis eine Verbindung zum passenden nächsten Schritt.",
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
  labels.append(field("Name des Ja-Wegs", trueL), field("Name des Nein-Wegs", falseL));
  el.append(
    field("Regel", rule.el, "Trifft die Regel zu, nimmt der Ablauf den Ja-Weg, sonst den Nein-Weg.", true),
    labels,
    h("div", HELP_CSS + "margin-top:6px;", "Die Wege entstehen, indem du vom Ausgang dieses Schritts zum nächsten Schritt ziehst und den Weg auswählst."),
  );
  return {
    el,
    read: () => {
      const expression = rule.read();
      if (!expression) return { ok: false, error: "Regel: bitte einen Wert wählen oder einen Ausdruck eingeben." };
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
    const label = textInput(c.label ?? "", "Name des Wegs, z. B. hd", "case-label");
    const rule = ruleEditor(c.expression ?? "", vars, `case${rows.length}`);
    const entry = { label, rule };
    rows.push(entry);
    const rm = h("button", "margin-top:4px;", "Fall entfernen");
    rm.type = "button";
    rm.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      box.remove();
    });
    box.append(field("Weg", label), field("Wenn", rule.el), rm);
    list.appendChild(box);
  };
  for (const c of cases) addCase(c);
  if (cases.length === 0) addCase();
  const add = h("button", "margin-top:6px;", "+ Fall");
  add.type = "button";
  add.setAttribute("data-role", "branch-add-case");
  add.addEventListener("click", () => addCase());
  const def = textInput(String(cfg.defaultLabel ?? ""), "optional, z. B. sonst", "defaultLabel");
  el.append(
    h("div", HELP_CSS, "Die Fälle werden von oben nach unten geprüft; der erste zutreffende bestimmt den Weg."),
    list,
    add,
    field("Weg, wenn kein Fall zutrifft", def, "Leer = der Prozess schlägt fehl, wenn kein Fall passt."),
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
        if (!expression || !label) return { ok: false, error: "Jeder Fall braucht einen Weg-Namen und eine Regel." };
        cs.push({ expression, label });
      }
      if (cs.length === 0) return { ok: false, error: "Mindestens ein Fall ist nötig." };
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
  const headers = keyValueEditor(headerPairs, { keyPlaceholder: "Header, z. B. Authorization", valuePlaceholder: "Wert", vars, name: "headers" });
  const bodyPairs = flatStringObject(cfg.body);
  const bodyWrap = h("div", "");
  let bodyEditor: { read(): [string, string][] } | null = null;
  if (bodyPairs !== null) {
    const kv = keyValueEditor(bodyPairs, { keyPlaceholder: "Feld", valuePlaceholder: "Wert (Text)", name: "body" });
    bodyEditor = kv;
    bodyWrap.appendChild(field("Gesendete Daten", kv.el, "Wird als JSON-Objekt gesendet (nur bei POST/PUT/PATCH). Verschachtelte Daten: „Erweitert (JSON)“."));
  } else {
    bodyWrap.appendChild(h("div", HELP_CSS + "margin-top:8px;", "Gesendete Daten sind verschachtelt — bearbeitbar unter „Erweitert (JSON)“."));
  }
  const syncBody = () => (bodyWrap.style.display = method.value === "GET" || method.value === "DELETE" ? "none" : "block");
  method.addEventListener("change", syncBody);
  syncBody();
  const timeout = durationInput(typeof cfg.timeoutSeconds === "number" ? cfg.timeoutSeconds : undefined);
  el.append(
    field("Methode", method),
    field("Adresse (URL)", url.el, "Mit „{x} Variable“ Werte aus dem Prozesslauf einsetzen.", true),
    field("Header", headers.el),
    bodyWrap,
    field("Zeitlimit für die Antwort", timeout.el, "Leer = 30 Sekunden."),
    h("div", HELP_CSS + "margin-top:6px;", "Antworten außerhalb 200–299 gelten als Fehler (→ Wiederholung/Fehlerbehandlung unten)."),
  );
  return {
    el,
    read: () => {
      if (!url.input.value.trim()) return { ok: false, error: "Adresse (URL) fehlt." };
      const t = timeout.read();
      if (t === null) return { ok: false, error: "Zeitlimit: keine gültige Zahl." };
      const out = { ...cfg, url: url.input.value.trim() };
      setOrDelete(out, "method", method.value === "GET" ? undefined : method.value);
      setOrDelete(out, "headers", pairsToObject(headers.read()));
      if (bodyEditor) setOrDelete(out, "body", method.value === "GET" || method.value === "DELETE" ? undefined : pairsToObject(bodyEditor.read()));
      setOrDelete(out, "timeoutSeconds", t);
      return { ok: true, config: out };
    },
  };
}

function buildScript(cfg: Record<string, unknown>, vars: VariableOption[], commands: string[]): FormPart {
  const el = h("div", "");
  const current = String(cfg.command ?? "");
  const cmdOpts = [{ value: "", label: "– Werkzeug wählen –" }, ...commands.map((c) => ({ value: c, label: c }))];
  if (current && !commands.includes(current)) cmdOpts.push({ value: current, label: `${current} (auf diesem Server nicht verfügbar!)` });
  const cmd = select(cmdOpts, current, "command");

  const tpl = select(
    [{ value: "", label: "– Vorlage übernehmen (optional) –" }, ...SCRIPT_TEMPLATES.filter((t) => commands.includes(t.command)).map((t) => ({ value: t.id, label: t.label }))],
    "",
    "template",
  );
  const tplHelp = h("span", HELP_CSS);

  const argsList = h("div", "");
  const argInputs: HTMLInputElement[] = [];
  const addArg = (v = "", after?: HTMLElement) => {
    const line = h("div", "display:grid;grid-template-columns:1fr auto auto;gap:4px;margin-top:4px;");
    const i = textInput(v, "Argument", "arg");
    i.style.fontFamily = "ui-monospace,monospace";
    argInputs.push(i);
    const rm = h("button", "", "✕");
    rm.type = "button";
    rm.addEventListener("click", () => {
      argInputs.splice(argInputs.indexOf(i), 1);
      line.remove();
    });
    line.append(i, variableButton(vars, "template", () => i), rm);
    if (after) after.after(line);
    else argsList.appendChild(line);
  };
  const setArgs = (args: string[]) => {
    argInputs.length = 0;
    argsList.replaceChildren();
    for (const a of args) addArg(a);
  };
  setArgs(Array.isArray(cfg.args) ? (cfg.args as string[]) : []);
  tpl.addEventListener("change", () => {
    const t = SCRIPT_TEMPLATES.find((x) => x.id === tpl.value);
    if (!t) return;
    cmd.value = t.command;
    setArgs(t.args);
    tplHelp.textContent = t.help + " Die Platzhalter input.path usw. per „{x} Variable“ durch echte Werte ersetzen oder beim Start mitgeben.";
  });
  const addBtn = h("button", "margin-top:4px;", "+ Argument");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => addArg());
  const pasteBtn = h("button", "margin-top:4px;margin-left:4px;", "Befehlszeile einfügen …");
  pasteBtn.type = "button";
  pasteBtn.title = "Eine komplette Argumentzeile einfügen (z. B. aus einer Anleitung) — wird an Leerzeichen getrennt, \"…\" hält zusammen.";
  pasteBtn.addEventListener("click", () => {
    const line = window.prompt("Argumente (ohne Programmname):", "");
    if (line === null) return;
    const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const p of parts) addArg(p.replace(/^["']|["']$/g, ""));
  });
  const timeout = durationInput(typeof cfg.timeoutSeconds === "number" ? cfg.timeoutSeconds : undefined);
  el.append(
    field("Werkzeug", cmd, commands.length ? `Auf diesem Server freigegeben: ${commands.join(", ")}.` : "Auf diesem Server ist kein Werkzeug freigegeben.", true),
    field("Vorlage", tpl),
    tplHelp,
    field("Argumente", argsList, "Je Zeile ein Argument — Leerzeichen innerhalb einer Zeile bleiben erhalten (kein Anführungszeichen-Problem)."),
    addBtn,
    pasteBtn,
    field("Zeitlimit", timeout.el, "Leer = 5 Minuten."),
  );
  return {
    el,
    read: () => {
      if (!cmd.value) return { ok: false, error: "Werkzeug fehlt." };
      const t = timeout.read();
      if (t === null) return { ok: false, error: "Zeitlimit: keine gültige Zahl." };
      const out = { ...cfg, command: cmd.value };
      setOrDelete(out, "args", argInputs.map((i) => i.value).filter((v) => v !== ""));
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
  const meth = select([{ value: "", label: "– zuerst Microservice wählen –" }], "", "method");
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
      argsBox.appendChild(h("div", HELP_CSS + "margin-top:8px;", "Diese Funktion braucht keine Angaben."));
      return;
    }
    for (const a of m.args) {
      const prev = origArgs[a.name];
      let input: HTMLInputElement | HTMLSelectElement;
      if (a.type === "boolean") {
        input = select([{ value: "true", label: "ja" }, { value: "false", label: "nein" }], prev === false ? "false" : "true");
      } else {
        input = textInput(prev === undefined ? "" : String(prev), a.type === "number" ? "Zahl" : "Text");
      }
      input.name = `arg-${a.name}`;
      argsIn[a.name] = { input, type: a.type };
      argsBox.appendChild(field(a.name, input, `Typ: ${a.type}`));
    }
  };

  const loadMethods = async () => {
    methods = [];
    meth.replaceChildren();
    const node = nodes.find((n) => n.instance_id === inst.value);
    if (!node) {
      meth.appendChild(new Option("– zuerst Microservice wählen –", ""));
      if (cfg.method) meth.appendChild(new Option(`${cfg.method} (Microservice läuft gerade nicht)`, String(cfg.method)));
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
    meth.appendChild(new Option(methods.length ? "– Funktion wählen –" : "dieser Microservice bietet keine Funktionen an", ""));
    for (const m of methods) meth.appendChild(new Option(m.name, m.name));
    if (cfg.method && !methods.some((m) => m.name === cfg.method)) meth.appendChild(new Option(`${cfg.method} (nicht mehr angeboten)`, String(cfg.method)));
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
    inst.replaceChildren(new Option(nodes.length ? "– Microservice wählen –" : "keine laufenden Microservices gefunden", ""));
    for (const n of nodes) inst.appendChild(new Option(`${n.label || n.instance_id}${n.online ? "" : " (offline)"}`, n.instance_id!));
    if (cfg.instanceId && !nodes.some((n) => n.instance_id === cfg.instanceId)) {
      inst.appendChild(new Option(`${cfg.instanceId} (läuft gerade nicht)`, String(cfg.instanceId)));
    }
    inst.value = String(cfg.instanceId ?? "");
    await loadMethods();
  })();
  inst.addEventListener("change", () => void loadMethods());
  meth.addEventListener("change", renderArgs);

  el.append(
    field("Microservice", inst, "Nur laufende Instanzen werden angeboten. Der Prozess ruft genau diese Instanz auf.", true),
    field("Funktion", meth, undefined, true),
    argsBox,
  );
  return {
    el,
    read: () => {
      if (!inst.value || !meth.value) return { ok: false, error: "Microservice und Funktion wählen." };
      const out = { ...cfg, instanceId: inst.value, method: meth.value };
      const args: Record<string, unknown> = {};
      for (const [k, { input, type }] of Object.entries(argsIn)) {
        const v = input.value.trim();
        if (v === "") continue;
        if (type === "number") {
          const n = Number(v.replace(",", "."));
          if (!Number.isFinite(n)) return { ok: false, error: `${k}: keine gültige Zahl.` };
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
  const verSel = select([{ value: "", label: "immer die neueste veröffentlichte Version" }], "", "processVersionId");
  const inputPairs = flatStringObject(cfg.input);
  const inputKv = inputPairs !== null ? keyValueEditor(inputPairs, { keyPlaceholder: "Feld", valuePlaceholder: "Wert (Text)", name: "subinput" }) : null;
  const loadVersions = async () => {
    verSel.replaceChildren(new Option("immer die neueste veröffentlichte Version", ""));
    if (!defSel.value) return;
    try {
      const res = await apiFetch(`/api/v1/process-definitions/${defSel.value}/versions`);
      const versions = res.ok ? ((await res.json()) as { id: string; versionNumber: number; status: string }[]) : [];
      for (const v of versions.filter((v) => v.status === "published").sort((a, b) => b.versionNumber - a.versionNumber)) {
        verSel.appendChild(new Option(`genau v${v.versionNumber}`, v.id));
      }
    } catch {
      // nur "neueste" anbieten
    }
    if (cfg.processVersionId && ![...verSel.options].some((o) => o.value === cfg.processVersionId)) {
      verSel.appendChild(new Option("festgelegte Version (nicht mehr veröffentlicht)", String(cfg.processVersionId)));
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
    defSel.replaceChildren(new Option("– Prozess wählen –", ""));
    for (const d of defs) defSel.appendChild(new Option(d.name, d.id));
    defSel.value = String(cfg.processDefinitionId ?? "");
    await loadVersions();
  })();
  defSel.addEventListener("change", () => void loadVersions());
  el.append(field("Prozess", defSel, "Läuft als eigener Prozesslauf; dieser Schritt wartet, bis er fertig ist.", true), field("Version", verSel));
  if (inputKv) el.appendChild(field("Start-Eingabe für den Unterprozess", inputKv.el));
  else el.appendChild(h("div", HELP_CSS + "margin-top:8px;", "Die Start-Eingabe ist verschachtelt — bearbeitbar unter „Erweitert (JSON)“."));
  return {
    el,
    read: () => {
      if (!defSel.value) return { ok: false, error: "Prozess wählen." };
      const out = { ...cfg, processDefinitionId: defSel.value };
      setOrDelete(out, "processVersionId", verSel.value);
      if (inputKv) setOrDelete(out, "input", pairsToObject(inputKv.read()));
      return { ok: true, config: out };
    },
  };
}

function buildNotification(cfg: Record<string, unknown>): FormPart {
  const el = h("div", "");
  const subject = textInput(String(cfg.subject ?? ""), "z. B. omp.process.beitrag.fertig", "subject");
  const payloadPairs = flatStringObject(cfg.payload);
  const kv = payloadPairs !== null ? keyValueEditor(payloadPairs, { keyPlaceholder: "Feld", valuePlaceholder: "Wert (Text)", name: "payload" }) : null;
  el.append(field("Kanal (Subject)", subject, "Name, unter dem andere Systeme diese Nachricht abonnieren. Punkte trennen Ebenen.", true));
  if (kv) el.appendChild(field("Inhalt", kv.el));
  else el.appendChild(h("div", HELP_CSS + "margin-top:8px;", "Der Inhalt ist verschachtelt — bearbeitbar unter „Erweitert (JSON)“."));
  return {
    el,
    read: () => {
      if (!subject.value.trim()) return { ok: false, error: "Kanal (Subject) fehlt." };
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
      return buildInfoOnly("Keine Einstellungen nötig — verbinde diesen Schritt mit allen Schritten, die gleichzeitig laufen sollen.", cfg);
    case "join":
      return buildInfoOnly("Keine Einstellungen nötig — der Ablauf geht weiter, sobald ALLE eingehenden Wege angekommen sind.", cfg);
    default:
      return buildInfoOnly("Für diesen Schritt-Typ gibt es kein Formular — Einstellungen ggf. unter „Erweitert (JSON)“.", cfg);
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

  const nameInput = textInput(step.name ?? "", "z. B. Proxy erzeugen", "name");
  modal.appendChild(field("Anzeigename", nameInput, "Erscheint auf der Kachel und im Variablen-Picker nachfolgender Schritte."));

  const form = buildForm(step, ctx, vars);
  const formWrap = h("div", "");
  formWrap.appendChild(form.el);
  modal.appendChild(formWrap);

  // Fehlerbehandlung: Wiederholen / Zeitlimit / Kompensation.
  const errSec = section("Wenn etwas schiefgeht");
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
  growLabel.append(growing, document.createTextNode("Abstand jedes Mal verdoppeln"));
  retryBox.append(field("Versuche insgesamt", attempts), field("Pause zwischen Versuchen", delay.el), growLabel);
  const retryLabel = h("label", "display:flex;align-items:center;gap:4px;margin-top:6px;");
  retryLabel.append(retryOn, document.createTextNode("Bei Fehler automatisch wiederholen"));
  const syncRetry = () => (retryBox.style.display = retryOn.checked ? "grid" : "none");
  retryOn.addEventListener("change", syncRetry);
  syncRetry();

  const timeout = durationInput(step.timeoutSeconds, "timeout");
  const comp = select(
    [{ value: "", label: "– nichts rückgängig machen –" }, ...ctx.def.steps.filter((s) => s.id !== step.id).map((s) => ({ value: s.id, label: s.name || s.id }))],
    step.compensationStepId ?? "",
    "compensation",
  );
  errSec.append(
    retryLabel,
    retryBox,
    field("Maximale Laufzeit dieses Schritts", timeout.el, "Leer = unbegrenzt. Bei Überschreitung gilt der Schritt als fehlgeschlagen."),
    field("Rückgängig machen mit", comp, "Schlägt der Prozess später fehl, läuft dieser Schritt, um die Wirkung hier aufzuheben (z. B. Datei wieder löschen)."),
  );
  modal.appendChild(errSec);

  // Erweitert (JSON) — bewusst am Ende und zugeklappt.
  const adv = h("details", "margin-top:14px;");
  const advSum = h("summary", "cursor:pointer;" + HELP_CSS, "Erweitert: Einstellungen als JSON");
  adv.appendChild(advSum);
  const advNote = h("div", HELP_CSS + "margin:4px 0;", "Solange dieser Bereich geöffnet ist, gilt das JSON unten statt des Formulars.");
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
  const cancel = h("button", "", "Abbrechen");
  cancel.addEventListener("click", () => overlay.remove());
  const save = h("button", "", "Übernehmen");
  save.className = "omp-btn-primary";
  save.setAttribute("data-role", "step-config-apply");
  save.addEventListener("click", () => {
    let config: unknown;
    if (adv.open) {
      if (advArea.value.trim()) {
        try {
          config = JSON.parse(advArea.value);
        } catch (err) {
          showToast(`Ungültiges JSON: ${err instanceof Error ? err.message : String(err)}`, { variant: "error" });
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
        showToast("Versuche insgesamt: mindestens 2.", { variant: "error" });
        return;
      }
      if (d === null) {
        showToast("Pause zwischen Versuchen: keine gültige Zahl.", { variant: "error" });
        return;
      }
      retry = { ...(step.retry ?? {}), maxAttempts: n, backoff: growing.checked ? "exponential" : "fixed" } as RetryPolicy;
      if (d !== undefined) retry.initialDelay = formatGoDuration(d);
      else if (initialParsed !== null) delete retry.initialDelay; // Rohwert wie "500ms" sonst behalten
    }
    const t = timeout.read();
    if (t === null) {
      showToast("Maximale Laufzeit: keine gültige Zahl.", { variant: "error" });
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
