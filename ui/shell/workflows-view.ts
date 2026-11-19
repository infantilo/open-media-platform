// <omp-workflows-view> — Workflow-Bereitstellung & -Verteilung
// (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1): benannte Bündel aus
// Node-Rollen + Rolle→Rolle-Verbindungs-Template anlegen sowie als
// Ganzes starten/stoppen. Bewusst kein eigenes Engineering-Dashboard
// (§17.2 existiert noch nicht) — seit K1-Teil-1 eine Vollansicht im
// App-Bar-Tab "Workflows" (app-shell.ts), vormals ein per Knopf ein-/
// ausblendbares Floating-Panel (gleiches Muster wie hosts-view.ts).
//
// SSE-first (S2, docs/berichte/REVIEW-2026-07-17-SKALIERUNG-24-7.md): reagiert
// auf "workflow.updated" (workflows/service.go) statt alle paar Sekunden
// zu pollen — Poll bleibt nur als deutlich langsamerer Reconnect-/
// Fallback-Pfad (POLL_FALLBACK_INTERVAL_MS), falls die SSE-Verbindung
// gerade unterbrochen ist oder ein Event verloren ging ("lost-events",
// s. sse.Hub). Über apiFetch() (connection.ts) statt rohem fetch — ein
// Fehlschlag setzt den geteilten ConnectionMonitor auf "degraded" statt
// still zu bleiben.
import { t as tt } from "./i18n.ts";
import { demandText, groupByHost, loadText, type StartPlan } from "./workflow-plan-logic.ts";
import { apiFetch, connectionMonitor } from "./connection.ts";
import { showToast } from "../kit/omp-toast.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import {
  applyExportChoices,
  describeAlertRoute,
  describeBinding,
  type IoExport,
  proposeRoleNames,
  renameRolesInExport,
  validateRoleNames,
} from "./workflow-io-logic.ts";
// Reiner Seiteneffekt-Import (registriert nur customElements.define,
// gleicher Grund wie bei den übrigen Custom-Element-Importen in
// shell.ts) — Kapitel 12 Teil 6, §22.3 Punkt 1: grafischer
// Rollen-Designer als Alternative zum Text-Formular unten.
import "../graph/role-designer.ts";
import type { RoleDesigner } from "../graph/role-designer.ts";
import { STANDARD_FORMATS } from "../graph/roles.ts";

interface CatalogEntry {
  type: string;
  label: string;
}

interface HostEntry {
  id: string;
  label: string;
}

// hostId (Nachtrag 99): seit dem Auto-Placement nur noch eine
// PRÄFERENZ, kein Zwang mehr — reicht der Host nicht, platziert der
// Orchestrator automatisch anderswo (s. runtime.hostId für den
// tatsächlich gewählten Host). affinityGroup/redundancyGroup: freie,
// globale (nicht workflow-scoped) Tags — Rollen mit demselben
// affinityGroup-Tag werden bevorzugt auf denselben Host gezogen
// (Latenz-/DMA-Kopplung), Rollen mit demselben redundancyGroup-Tag
// bevorzugt AUSEINANDER gehalten (Redundanzpaare, typischerweise in
// zwei verschiedenen Workflows).
interface Role {
  name: string;
  nodeType: string;
  hostId?: string;
  affinityGroup?: string;
  redundancyGroup?: string;
  format?: string;
  mixerLevels?: number;
}

// Kapitel 12 Teil 1 (docs/END-GOAL-FEATURES.md §12.3a): fromSender/
// toReceiver sind optionale IS-04-Port-Labels — leer = Kompatibilitäts-
// Fallback auf den jeweils ersten Sender/Receiver der Rolle (Backend-
// Verhalten unverändert). Freitext statt Dropdown: die verfügbaren
// Labels eines Node-Typs sind heute nirgends als Katalog-Metadaten
// abgelegt (nur im jeweiligen Rust-Quelltext, z. B. omp-ograf "Fill"/
// "Key") — ein Label-Katalog ist dokumentierte Folgearbeit.
interface Connection {
  fromRole: string;
  fromSender?: string;
  toRole: string;
  toReceiver?: string;
}

// Settings (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c, 2026-07-17):
// pro Workflow konfigurierbare, node-übergreifende Werte — aktuell das
// Programm-Format sowie (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 2) die
// Stop-Sicherheitsabfrage. Leer/undefined = Node behält ihren eigenen
// Default (heute meist 640×480 fest verdrahtet).
interface Settings {
  // programFormat (Nutzerwunsch 2026-09-11, vormals zwei getrennte
  // Rohwerte programWidth/programHeight ohne Framerate-Bezug):
  // benanntes Preset aus STANDARD_FORMATS (ui/graph/roles.ts), exakt
  // wie Role.format — s. dortige Doku.
  programFormat?: string;
  // domain (Kap. 103): getrennte MXL-Domain für alle Rollen; leer = Standarddomain.
  domain?: string;
  confirmStop?: boolean;
  // targetLatencyFrames (D8 Teil 2, ARCHITECTURE.md §15.1 Punkt 2):
  // Latenzbudget in Video-Frames — 0/undefined = nicht gesetzt (kein
  // Preflight-Check beim Start, unverändertes Verhalten).
  targetLatencyFrames?: number;
}

// Schedule (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 1, orchestrator/
// internal/workflows/types.go) — lastFiredAt wird ausschließlich vom
// Scheduler geschrieben; das Formular übernimmt ihn beim Bearbeiten
// unverändert (s. #editWorkflow), sonst könnte ein bereits gefeuertes
// "once"-Schedule beim Speichern erneut feuern.
interface Schedule {
  id: string;
  kind: "once" | "daily" | "weekly";
  action: "start" | "stop";
  at?: string;
  timeOfDay?: string;
  weekday?: number;
  lastFiredAt?: string;
}

const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Kapitel 12 Teil 6 (docs/END-GOAL-FEATURES.md §12.3g, ARCHITECTURE.md
// §22.3 Punkte 4/7): additive, rein darstellungsbezogene Metadaten für
// den Workflow-Katalog — Teil der Definition (nicht des Workflow-
// Objekts selbst), s. orchestrator/internal/workflows/types.go.
interface Workflow {
  id: string;
  name: string;
  definition: {
    roles: Role[];
    connections: Connection[];
    settings?: Settings;
    schedules?: Schedule[];
    title?: string;
    description?: string;
    tags?: string[];
    category?: string;
  };
  status: string;
  error?: string;
  runtime?: Record<string, { instanceId: string; nodeId?: string; hostId?: string }>;
}

// Erweitert den §13.5-Node-Kategorien-Enum um "regieplatz" (§22.3
// Punkt 7) — gleiche Werte wie im Backend, dort bewusst nicht
// serverseitig validiert (freies Textfeld, robust gegen ältere/fremde
// Einträge); die Auswahl hier ist reiner UI-Komfort.
const CATEGORY_LABELS: Record<string, string> = {
  regieplatz: tt("wf.dd4edc"),
  input: tt("wf.324118"),
  output: tt("wf.29c2c0"),
  audio: tt("wf.b22f04"),
  video: tt("wf.34e2d1"),
  graphics: tt("wf.e64b29"),
  data: tt("wf.81c1cc"),
  control: tt("wf.9090e4"),
};

// Fallback/Reconnect-Intervall (S2) — der Normalfall ist SSE-getrieben
// (#onSseMessage), dieser Poll fängt nur eine unterbrochene SSE-
// Verbindung oder ein verpasstes Event auf (lost-events triggert
// ohnehin sofort ein gezieltes #poll(), dieses Intervall ist das
// zusätzliche Sicherheitsnetz für den Fall, dass sogar das
// lost-events-Signal selbst nicht ankam).
const POLL_FALLBACK_INTERVAL_MS = 30000;

// Event-Typen, bei denen die Workflow-Liste neu geladen wird.
const REFRESH_EVENT_TYPES = new Set(["workflow.updated", "workflow.statehold", "lost-events"]);

// Nutzerauftrag 2026-09-02 ("Workflows nach demselben Muster"): Design-
// Tokens statt roher Hex-Werte, gleiche Farbsemantik wie überall sonst
// im Projekt (preset=grün/aktiv-gut, cue=orange/Übergang, error=rot,
// info=blau für einen eigenständigen Zustand, text-dim=grau/inaktiv).
const STATUS_COLORS: Record<string, string> = {
  stopped: "var(--omp-text-dim)",
  starting: "var(--omp-cue)",
  started: "var(--omp-preset)",
  stopping: "var(--omp-cue)",
  failed: "var(--omp-error)",
  // Kapitel 12 Teil 3: eigene Farbe statt "stopped" grau — visuell klar
  // unterscheidbar, dass hier bewusst pausiert statt (endgültig)
  // gestoppt wurde.
  paused: "var(--omp-info)",
  pausing: "var(--omp-cue)",
};

// Badge-Modifier-Klasse (design-tokens.css) je Status — dieselbe
// Farbzuordnung wie STATUS_COLORS oben, als CSS-Klasse statt Inline-Farbe
// für die Status-Badges in #renderWorkflowRow.
const STATUS_BADGE_CLASS: Record<string, string> = {
  stopped: "",
  starting: "omp-badge-cue",
  started: "omp-badge-running",
  stopping: "omp-badge-cue",
  failed: "omp-badge-error",
  paused: "omp-badge-info",
  pausing: "omp-badge-cue",
};

// ExportedWorkflow (Kapitel 12 Teil 3, §12.3d) — Wire-Format identisch
// zu workflows.ExportedWorkflow. Bewusst nur Definition, s. Backend-Doku
// (orchestrator/internal/workflows/types.go).
// Bindings (Nutzerwunsch 2026-07-28, orchestrator/internal/workflows/
// types.go ExportedWorkflow.Bindings-Doku): bewusst NICHT Teil des
// portablen Standard-Exports (der Grundfall — ein Regieplatz wandert
// zwischen Systemen mit potenziell anderen Nutzerkonten) — nur wenn die
// UI explizit `?includeBindings=true` anfragt (Export-Dialog, #askWhatGoesAlong),
// für den engeren "gleiches System"-Fall (Export→Löschen→Import mit
// denselben Rechten).
interface ExportedBinding {
  subject: string;
  role: string;
  verb: string;
}

interface ExportedWorkflow {
  version: number;
  name: string;
  definition: Workflow["definition"];
  bindings?: ExportedBinding[];
}

// Überarbeitung 2026-11-19 (Nutzerwunsch: die Knöpfe je Workflow sprangen je nach Zahl der Rollen): jede Karte hat
// feste Bänder — Kopf, Kennzahlen, Inhalt mit fester Höhe (der Plan klappt auf, statt die Karte zu strecken) und einen
// Fuß, der immer unten steht: Start/Stop/Pause in drei gleich breiten Feldern, darunter fünf feste Werkzeugfelder.
// Deaktivierte Knöpfe bleiben an ihrem Platz. Status → Gruppe für die Filter-Pillen.
type StatusGroup = "running" | "stopped" | "paused" | "failed";
function statusGroup(status: string): StatusGroup {
  if (status === "started" || status === "starting" || status === "stopping") return "running";
  if (status === "paused" || status === "pausing") return "paused";
  if (status === "failed") return "failed";
  return "stopped";
}

const STATUS_GROUP_ORDER: StatusGroup[] = ["running", "stopped", "paused", "failed"];
const GROUP_COLORS: Record<StatusGroup, string> = {
  running: "var(--omp-preset)",
  stopped: "var(--omp-text-dim)",
  paused: "var(--omp-info)",
  failed: "var(--omp-error)",
};

const WF_STYLE_ID = "omp-wf-style";
const WF_CSS = `
.wf-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:var(--omp-space-2); margin-bottom:var(--omp-space-3); }
.wf-toolbar .wf-title { display:flex; align-items:baseline; gap:10px; margin-right:auto; }
.wf-toolbar .wf-count { font-size:var(--omp-font-size-sm); color:var(--omp-text-dim); }
.wf-toolbar label.wf-import { font-size:12px; cursor:pointer; border:1px solid var(--omp-border); border-radius:var(--omp-radius); padding:5px 10px; background:var(--omp-surface-raised); }
.wf-toolbar label.wf-import:hover { border-color:var(--omp-info); }
.wf-options { display:flex; flex-wrap:wrap; align-items:center; gap:var(--omp-space-2); margin-bottom:var(--omp-space-3); }
.wf-options .wf-bind { font-size:11px; color:var(--omp-text-dim); cursor:pointer; display:inline-flex; align-items:center; gap:4px; margin-left:auto; }
.wf-pills { display:inline-flex; gap:6px; flex-wrap:wrap; }
.wf-pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:3px 10px; border-radius:999px; cursor:pointer;
  background:var(--omp-surface-raised); border:1px solid var(--omp-border); color:var(--omp-text-dim); }
.wf-pill b { font-weight:700; color:var(--omp-text); }
.wf-pill .wf-dot { width:8px; height:8px; border-radius:50%; background:var(--wf-c, var(--omp-text-dim)); }
.wf-pill[aria-pressed="true"] { border-color:var(--wf-c, var(--omp-info)); color:var(--omp-text); box-shadow:0 0 0 1px var(--wf-c, var(--omp-info)) inset; }
.wf-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:var(--omp-space-3); align-items:stretch; }
.wf-card { --wf-c:var(--omp-text-dim); position:relative; display:flex; flex-direction:column; gap:10px; padding:14px 16px 12px; min-height:300px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--wf-c) 9%, var(--omp-surface)) 0, var(--omp-surface) 120px);
  border:1px solid var(--omp-border); border-top:3px solid var(--wf-c); border-radius:calc(var(--omp-radius) + 4px);
  box-shadow:0 1px 2px rgba(0,0,0,.25); transition:box-shadow .15s, transform .15s, border-color .15s; }
.wf-card:hover { box-shadow:0 8px 26px rgba(0,0,0,.35); transform:translateY(-1px); border-color:color-mix(in srgb, var(--wf-c) 45%, var(--omp-border)); }
.wf-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; min-height:44px; }
.wf-head .wf-name { font-size:15px; font-weight:650; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word; }
.wf-state { flex:none; display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
  padding:3px 10px; border-radius:999px; color:var(--wf-c); border:1px solid color-mix(in srgb, var(--wf-c) 55%, transparent); background:color-mix(in srgb, var(--wf-c) 12%, transparent); }
.wf-state i { width:8px; height:8px; border-radius:50%; background:var(--wf-c); }
.wf-state.wf-live i { animation:wf-pulse 1.4s ease-in-out infinite; }
@keyframes wf-pulse { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--wf-c) 70%, transparent); } 50% { box-shadow:0 0 0 5px transparent; } }
.wf-facts { display:flex; flex-wrap:wrap; gap:6px; min-height:24px; align-content:flex-start; }
.wf-chip { font-size:11px; padding:2px 9px; border-radius:999px; background:var(--omp-surface-raised); border:1px solid var(--omp-border); color:var(--omp-text-dim); white-space:nowrap; }
.wf-chip.wf-strong { color:var(--omp-text); }
.wf-desc { font-size:12px; color:var(--omp-text-dim); line-height:1.4; min-height:34px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.wf-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:8px; }
.wf-plan > summary { cursor:pointer; font-size:12px; font-weight:600; color:var(--omp-text-dim); list-style:none; display:flex; align-items:center; gap:6px; padding:4px 0; user-select:none; }
.wf-plan > summary::-webkit-details-marker { display:none; }
.wf-plan > summary::before { content:"▸"; transition:transform .15s; display:inline-block; }
.wf-plan[open] > summary::before { transform:rotate(90deg); }
.wf-plan[open] > summary { color:var(--omp-text); }
.wf-plan .wf-plan-inner { max-height:230px; overflow:auto; padding-top:4px; }
.wf-err { color:var(--omp-error); font-size:11px; white-space:pre-wrap; border-left:3px solid var(--omp-error); padding:3px 8px; background:rgba(239,83,80,.08); border-radius:0 4px 4px 0; max-height:80px; overflow:auto; }
.wf-foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; padding-top:10px; border-top:1px solid var(--omp-border); }
.wf-run { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.wf-run button { height:38px; font-weight:650; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.wf-run .wf-start:not(:disabled) { background:linear-gradient(180deg, #43a047, #2e7d32); border-color:#2e7d32; color:#fff; box-shadow:0 4px 14px rgba(67,160,71,.3); }
.wf-run .wf-stop:not(:disabled) { background:transparent; border-color:var(--omp-error); color:var(--omp-error); }
.wf-run .wf-stop:not(:disabled):hover { background:rgba(239,83,80,.14); }
.wf-run .wf-pause:not(:disabled) { border-color:var(--omp-info); color:var(--omp-info); }
.wf-tools { display:grid; grid-template-columns:repeat(5, 1fr); gap:6px; }
.wf-tools button { height:50px; padding:4px 2px; font-size:10.5px; display:inline-flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; white-space:nowrap; overflow:hidden; }
.wf-tools button .wf-ic, .wf-run button .wf-ic { font-size:15px; line-height:1; }
.wf-tools .wf-del:not(:disabled) { color:var(--omp-error); border-color:color-mix(in srgb, var(--omp-error) 55%, var(--omp-border)); background:transparent; }
.wf-tools .wf-del:not(:disabled):hover { background:rgba(239,83,80,.12); }
@media (max-width: 520px) { .wf-grid { grid-template-columns:1fr; } }
`;

function ensureWorkflowStyles() {
  if (document.getElementById(WF_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = WF_STYLE_ID;
  style.textContent = WF_CSS;
  document.head.appendChild(style);
}

// Einfacher Dialog (Overlay + Karte) für Export, Import und Duplizieren: `build` füllt den Inhalt und ruft `done(wert)` auf;
// Abbrechen/Escape/Klick daneben liefert null. Hängt an document.body, nicht an die Ansicht — die baut sich bei jedem
// Neuzeichnen neu auf und würde den offenen Dialog mitreißen.
function showDialog<T>(title: string, build: (body: HTMLElement, done: (v: T | null) => void) => void, wide = false): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = wide ? "680px" : "560px";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-3);";
    const h = document.createElement("span");
    h.className = "omp-h1";
    h.textContent = title;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.setAttribute("aria-label", tt("wf.8311b9"));
    head.append(h, x);
    const body = document.createElement("div");
    modal.append(head, body);
    overlay.appendChild(modal);
    let closed = false;
    const done = (v: T | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") done(null);
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) done(null);
    });
    x.addEventListener("click", () => done(null));
    build(body, done);
    document.body.appendChild(overlay);
    queueMicrotask(() => (body.querySelector("input[type=text]") as HTMLInputElement | null)?.focus());
  });
}

/** Eine beschriftete Liste (Überschrift mit Zähler + Zeilen); leer → Hinweis „keine“. */
function listBlock(title: string, rows: string[], emptyText: string): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText = "margin-bottom:var(--omp-space-3);";
  const h = document.createElement("div");
  h.style.cssText = "font-size:12px;font-weight:600;margin-bottom:4px;";
  h.textContent = `${title} (${rows.length})`;
  box.appendChild(h);
  const list = document.createElement("div");
  list.style.cssText =
    "max-height:130px;overflow:auto;border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 8px;font-size:12px;background:var(--omp-bg);";
  if (rows.length === 0) {
    list.style.color = "var(--omp-text-dim)";
    list.textContent = emptyText;
  } else {
    for (const r of rows) {
      const line = document.createElement("div");
      line.style.cssText = "padding:1px 0;overflow-wrap:anywhere;";
      line.textContent = r;
      list.appendChild(line);
    }
  }
  box.appendChild(list);
  return box;
}

function checkRow(label: string, checked: boolean, disabled: boolean): { row: HTMLElement; box: HTMLInputElement } {
  const row = document.createElement("label");
  row.style.cssText = `display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 6px;${disabled ? "opacity:.5;" : "cursor:pointer;"}`;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked && !disabled;
  box.disabled = disabled;
  row.append(box, label);
  return { row, box };
}

function buttonRow(confirmLabel: string, onOk: () => void, onCancel: () => void): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:var(--omp-space-3);";
  const cancel = document.createElement("button");
  cancel.textContent = tt("kit.cancel");
  cancel.addEventListener("click", onCancel);
  const ok = document.createElement("button");
  ok.className = "omp-btn-primary";
  ok.textContent = confirmLabel;
  ok.addEventListener("click", onOk);
  row.append(cancel, ok);
  return row;
}

class WorkflowsView extends HTMLElement {
  #pollHandle: number | undefined;
  #catalog: CatalogEntry[] = [];
  #hosts: HostEntry[] = [];
  #workflows: Workflow[] = [];
  // Plan-Vorschau je Workflow (Hosts, Bedarf, Engpass-Warnungen), s. workflow-plan-logic.ts.
  #plans = new Map<string, StartPlan>();
  // Rollen je Workflow, deren gesicherter Stand nach einem Absturz-Neustart gehalten wird (GET …/state-holds).
  #holds = new Map<string, string[]>();
  #formRoles: Role[] = [{ name: "", nodeType: "", hostId: "" }];
  #formConnections: Connection[] = [];
  #formName = "";
  // Feature-Wunsch 2026-08-13: globaler Schalter statt einer Checkbox
  // pro Zeile (eine pro Workflow-Karte wäre reine Wiederholung derselben
  // Entscheidung) — gilt für den nächsten Klick auf irgendeine
  // "Exportieren"-Karte. Absichtlich nicht persistiert (localStorage o. ä.):
  // der "gleiches System"-Fall (s. ExportedBinding-Doku) ist die
  // Ausnahme, portabler Export ohne Bindungen soll der unauffällige
  // Default bleiben, auch nach einem Seiten-Reload.
  // Aufgeklappte Pläne (je Workflow-ID) — überleben jedes Neuzeichnen (SSE/Poll baut die Karten neu).
  #openPlans = new Set<string>();
  // Kapitel 12 Teil 6 (§22.3 Punkte 4/7): rein darstellungsbezogen,
  // s. Definition-Doku im Backend. #formTags als Komma-getrennter
  // Freitext (einfachste Eingabe, keine eigene Tag-Chip-UI nötig für
  // die erwartete Größenordnung von ein paar Schlagworten).
  #formTitle = "";
  #formDescription = "";
  #formTags = "";
  #formCategory = "";
  // Kapitel 15: leer gelassen = kein settings-Feld im Request, Nodes
  // laufen mit ihrem eigenen Default (keine erzwungene Auflösung).
  #formProgramFormat = "";
  // Kap. 103: MXL-Domain des Workflows (leer = Standard) und die angelegten Domainnamen für die Auswahl.
  #formDomain = "";
  #domainNames: string[] = [];
  // D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 1/2).
  #formSchedules: Schedule[] = [];
  #formConfirmStop = false;
  // D8 Teil 2 (ARCHITECTURE.md §15.1 Punkt 2): leer = kein
  // targetLatencyFrames im Request, gleiche Konvention wie
  // #formProgramFormat oben.
  #formTargetLatencyFrames = "";
  #showForm = false;
  // Kapitel 12 Teil 1 (PUT /api/v1/workflows/{id}, §22.3 Punkt 2): gesetzt
  // während "Bearbeiten" eines bestehenden (gestoppten) Workflows —
  // #submitForm() unterscheidet daran POST (Anlegen) von PUT (Update),
  // das Formular selbst ist identisch.
  #editingId: string | null = null;
  // Kapitel 12 Teil 6, Unterteil 2 (§22.3 Punkt 8: "Volltext über
  // title/description/tags[] ... Postgres-Volltextsuche/ILIKE reicht
  // für die erwartete Größenordnung ... plus Facetten (Kategorie,
  // Status)"). Bewusst clientseitig statt eines neuen Backend-Such-
  // Endpunkts: die Liste ist ohnehin schon vollständig geladen (SSE-
  // getrieben, kein Pagination-Konzept für Workflows), ein serverseitiger
  // ILIKE-Query wäre für "Dutzende bis wenige Hunderte" Workflows
  // (Dokument wörtlich) reiner Zusatzaufwand ohne Mehrwert.
  #searchQuery = "";
  #filterCategory = "";
  #filterStatus = "";

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    // Sofort synchron rendern (leere Liste, "+ Neu" bereits klickbar) —
    // sonst bliebe das Panel bis zum ersten aufgelösten Poll komplett
    // leer (per CDP-Test gefunden: kurzzeitig kein einziges Kind-Element,
    // "+ Neu" nicht anklickbar).
    this.#render();
    this.#loadStatic();
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (REFRESH_EVENT_TYPES.has(parsed.type)) this.#poll();
  };

  async #loadStatic() {
    try {
      const [catalogRes, hostsRes, domainsRes] = await Promise.all([
        apiFetch("/api/v1/catalog"),
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/admin/mxl/domains").catch(() => null),
      ]);
      if (catalogRes.ok) this.#catalog = await catalogRes.json();
      if (hostsRes.ok) this.#hosts = await hostsRes.json();
      if (domainsRes?.ok) {
        const d = (await domainsRes.json()) as { domains?: { name: string; default?: boolean }[] };
        this.#domainNames = (d.domains ?? []).filter((x) => !x.default).map((x) => x.name);
      }
      // Neu rendern, falls das Anlegen-Formular schon offen ist, bevor
      // dieser Fetch zurückkam — sonst bliebe die Node-Typ-Auswahl leer
      // (nur die "Node-Typ …"-Leeroption), falls jemand "+ Neu" schneller
      // klickt, als der Katalog-Request braucht (per CDP-Test gefunden).
      if (this.#showForm) this.#render();
    } catch {
      // Katalog/Hosts optional für die Anzeige laufender Workflows —
      // nur das Anlegen neuer Workflows braucht sie tatsächlich.
    }
  }

  async #poll() {
    try {
      const res = await apiFetch("/api/v1/workflows");
      if (!res.ok) return;
      this.#workflows = await res.json();
      await this.#loadPlans();
      this.#render();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  async #loadPlans() {
    const results = await Promise.all(
      this.#workflows.map(async (wf): Promise<[string, StartPlan | null]> => {
        try {
          const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(wf.id)}/plan`);
          return [wf.id, res.ok ? ((await res.json()) as StartPlan) : null];
        } catch {
          return [wf.id, null];
        }
      }),
    );
    this.#plans = new Map(results.filter((r): r is [string, StartPlan] => r[1] !== null));
    await this.#loadHolds();
  }

  async #loadHolds() {
    const results = await Promise.all(
      this.#workflows
        .filter((wf) => wf.status === "started" || wf.status === "paused")
        .map(async (wf): Promise<[string, string[]]> => {
          try {
            const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(wf.id)}/state-holds`);
            return [wf.id, res.ok ? (((await res.json()) as { roles?: string[] }).roles ?? []) : []];
          } catch {
            return [wf.id, []];
          }
        }),
    );
    this.#holds = new Map(results.filter(([, roles]) => roles.length > 0));
  }

  // Nach einem Absturz-Neustart kommt eine Rolle leer hoch; ihr gesicherter Stand wird gehalten, bis jemand entscheidet.
  async #holdAction(wf: Workflow, role: string, action: "restore" | "discard") {
    if (action === "discard") {
      const ok = await confirmDialog(tt("wf.hold.confirmDiscard", { p0: role }), { confirmLabel: tt("wf.hold.discard") });
      if (!ok) return;
    }
    try {
      const res = await apiFetch(`/api/v1/workflows/${encodeURIComponent(wf.id)}/roles/${encodeURIComponent(role)}/state-hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        showToast(tt(action === "restore" ? "wf.hold.restored" : "wf.hold.discarded", { p0: role }));
      } else {
        showToast(tt("wf.hold.failed", { p0: role, p1: (await res.text()).trim() }));
      }
    } catch (err) {
      showToast(tt("wf.hold.failed", { p0: role, p1: String(err) }));
    }
    await this.#poll();
  }

  #renderHolds(wf: Workflow): HTMLElement | null {
    const roles = this.#holds.get(wf.id);
    if (!roles || roles.length === 0) return null;
    const box = document.createElement("div");
    box.setAttribute("data-role", "workflow-state-holds");
    box.style.cssText =
      "font-size:11px;padding:6px 8px;border-radius:4px;border:1px solid var(--omp-cue,#fb8c00);background:rgba(251,140,0,.08);display:flex;flex-direction:column;gap:6px;";
    for (const role of roles) {
      const line = document.createElement("div");
      line.setAttribute("data-role", "workflow-state-hold");
      line.setAttribute("data-hold-role", role);
      line.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;";
      const text = document.createElement("span");
      text.style.cssText = "flex:1 1 220px;";
      text.textContent = `⚠ ${tt("wf.hold.text", { p0: role })}`;
      const restore = document.createElement("button");
      restore.className = "omp-btn-primary";
      restore.setAttribute("data-action", "hold-restore");
      restore.textContent = tt("wf.hold.restore");
      restore.addEventListener("click", () => void this.#holdAction(wf, role, "restore"));
      const discard = document.createElement("button");
      discard.setAttribute("data-action", "hold-discard");
      discard.textContent = tt("wf.hold.discard");
      discard.addEventListener("click", () => void this.#holdAction(wf, role, "discard"));
      line.append(text, restore, discard);
      box.appendChild(line);
    }
    return box;
  }

  // Rollen und Hosts eines Workflows: je Host ein Block mit den Rollen, die dort laufen (würden), dem erwarteten
  // Bedarf und der Auslastung; Warnungen (Engpass, Host nicht erreichbar, fehlendes Messprofil) stehen oben.
  // Ersetzt die frühere Topologie-Miniatur, die bei mehr als wenigen Rollen unlesbar war.
  #renderPlan(wf: Workflow): HTMLElement {
    const box = document.createElement("div");
    box.setAttribute("data-role", "workflow-plan");
    box.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:6px;";
    const plan = this.#plans.get(wf.id);
    if (!plan) {
      const fallback = document.createElement("div");
      fallback.style.cssText = "color:var(--omp-text-dim);font-size:11px;";
      fallback.textContent = wf.definition.roles.map((r) => r.name).join(", ");
      box.appendChild(fallback);
      return box;
    }
    const SEV_COLOR: Record<string, string> = {
      ok: "var(--omp-preset, #43a047)", warn: "var(--omp-cue, #fb8c00)", bad: "var(--omp-error, #ef5350)", unknown: "var(--omp-text-dim)",
    };
    if (plan.warnings.length > 0 && !plan.running) {
      const warn = document.createElement("div");
      warn.setAttribute("data-role", "workflow-plan-warnings");
      warn.style.cssText =
        "font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid var(--omp-cue,#fb8c00);background:rgba(251,140,0,.08);";
      for (const w of plan.warnings) {
        const line = document.createElement("div");
        line.textContent = `⚠ ${w}`;
        warn.appendChild(line);
      }
      box.appendChild(warn);
    }
    for (const group of groupByHost(plan)) {
      const block = document.createElement("div");
      block.setAttribute("data-role", "workflow-plan-host");
      block.style.cssText = `border-left:3px solid ${SEV_COLOR[group.severity]};padding:2px 0 2px 8px;`;
      const name = document.createElement("div");
      name.style.cssText = "font-size:12px;font-weight:600;";
      name.textContent = group.host.label;
      const load = document.createElement("div");
      load.style.cssText = `font-size:11px;margin-bottom:3px;color:${group.severity === "bad" ? SEV_COLOR.bad : "var(--omp-text-dim)"};`;
      load.textContent = loadText(group.host, plan.running);
      block.append(name, load);
      for (const r of group.roles) {
        const line = document.createElement("div");
        line.style.cssText = "margin-bottom:2px;";
        const title = document.createElement("div");
        title.style.cssText = "font-size:11px;";
        title.textContent = r.role;
        const detail = document.createElement("div");
        detail.style.cssText = "font-size:10px;color:var(--omp-text-dim);";
        const parts = [r.nodeType];
        if (!plan.running) parts.push(r.fixed ? tt("wf.2dc84a") : "automatisch", demandText(r));
        detail.textContent = parts.join(" · ");
        line.append(title, detail);
        if (r.reason && !plan.running) line.title = r.reason;
        block.appendChild(line);
      }
      box.appendChild(block);
    }
    return box;
  }

  // Anlegen (POST) und Bearbeiten (PUT, Kapitel 12 Teil 1) teilen sich
  // Formular und Validierung — nur Methode/URL/Fehlertext unterscheiden
  // sich, je nachdem ob #editingId gesetzt ist.
  async #submitForm() {
    // UX-Überarbeitung 2026-09-07: vorher `!this.#formName || roles.length
    // === 0` — seit die Rollen-Zeilen aus diesem Formular entfernt sind
    // (s. #renderForm-Doku, Rollen/Verbindungen jetzt ausschließlich im
    // Rollen-Designer), hätte JEDER neue Workflow diesen Guard
    // unweigerlich gerissen: `#formRoles` startet leer, es gibt hier
    // keine UI mehr, die es füllen könnte. Das Backend lehnt einen
    // Workflow ohne Rolle ohnehin mit einer klaren Meldung ab
    // (`service.go`: "at least one role required") — dieser Fall
    // erreicht jetzt bewusst den `!res.ok`-Zweig unten (echter Toast)
    // statt hier lautlos (kein Toast!) zu verpuffen, wie es VOR dieser
    // Überarbeitung bei einer leeren Rollen-Liste bereits der Fall war.
    const roles = this.#formRoles.filter((r) => r.name && r.nodeType);
    if (!this.#formName) {
      showToast(tt("wf.24eb99"));
      return;
    }
    const settings: Settings = {};
    if (this.#formProgramFormat) settings.programFormat = this.#formProgramFormat;
    if (this.#formDomain) settings.domain = this.#formDomain;
    if (this.#formConfirmStop) settings.confirmStop = true;
    const targetLatencyFrames = parseInt(this.#formTargetLatencyFrames, 10);
    if (Number.isFinite(targetLatencyFrames) && targetLatencyFrames > 0) {
      settings.targetLatencyFrames = targetLatencyFrames;
    }
    // Nur vollständig ausgefüllte Zeilen mitschicken (gleiche Haltung
    // wie roles/connections oben) — die Backend-Validierung (D7 Teil 2)
    // lehnt eine unvollständige Zeile ohnehin mit einem verständlichen
    // Fehler ab, hier nur ein Filter gegen offensichtlich leere Zeilen.
    const schedules = this.#formSchedules.filter((s) => {
      if (s.kind === "once") return !!s.at;
      if (s.kind === "weekly") return !!s.timeOfDay && s.weekday !== undefined;
      return !!s.timeOfDay;
    });
    const tags = this.#formTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const body = {
      name: this.#formName,
      definition: {
        roles: roles.map((r) => ({
          name: r.name,
          nodeType: r.nodeType,
          hostId: r.hostId || undefined,
          affinityGroup: r.affinityGroup || undefined,
          redundancyGroup: r.redundancyGroup || undefined,
          format: r.format || undefined,
          mixerLevels: r.mixerLevels || undefined,
        })),
        connections: this.#formConnections.filter((c) => c.fromRole && c.toRole),
        settings: Object.keys(settings).length > 0 ? settings : undefined,
        schedules: schedules.length > 0 ? schedules : undefined,
        title: this.#formTitle || undefined,
        description: this.#formDescription || undefined,
        tags: tags.length > 0 ? tags : undefined,
        category: this.#formCategory || undefined,
      },
    };
    const editingId = this.#editingId;
    const verb = editingId ? tt("wf.b97d23") : tt("wf.6212ff");
    // try/catch statt nur !res.ok: apiFetch() wirft bei einem
    // Netzwerkfehler (z. B. Orchestrator gestoppt), nicht nur bei einer
    // abgeschlossenen Antwort mit Fehlerstatus — beide Fälle sollen als
    // Toast sichtbar werden, nicht als stiller Absturz (S10-
    // Verifikationsfall "Orchestrator gestoppt → Toast statt alert").
    try {
      const res = await apiFetch(editingId ? `/api/v1/workflows/${editingId}` : "/api/v1/workflows", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        showToast(tt("misc.failedWith", { p0: verb, p1: await res.text() }));
        return;
      }
    } catch (err) {
      showToast(tt("misc.failedWith", { p0: verb, p1: err }));
      return;
    }
    this.#resetForm();
    this.#showForm = false;
    this.#editingId = null;
    await this.#poll();
  }

  #resetForm() {
    this.#formName = "";
    this.#formRoles = [{ name: "", nodeType: "", hostId: "" }];
    this.#formConnections = [];
    this.#formProgramFormat = "";
    this.#formDomain = "";
    this.#formSchedules = [];
    this.#formConfirmStop = false;
    this.#formTargetLatencyFrames = "";
    this.#formTitle = "";
    this.#formDescription = "";
    this.#formTags = "";
    this.#formCategory = "";
  }

  // Öffnet das Formular vorbefüllt mit der bestehenden Definition eines
  // gestoppten Workflows (Kapitel 12 Teil 1) — #submitForm() sendet dann
  // ein PUT statt eines POST.
  #editWorkflow(wf: Workflow) {
    this.#editingId = wf.id;
    this.#formName = wf.name;
    this.#formRoles = wf.definition.roles.map((r) => ({ ...r, hostId: r.hostId ?? "" }));
    this.#formConnections = wf.definition.connections.map((c) => ({ ...c }));
    this.#formProgramFormat = wf.definition.settings?.programFormat ?? "";
    this.#formDomain = wf.definition.settings?.domain ?? "";
    this.#formConfirmStop = wf.definition.settings?.confirmStop ?? false;
    this.#formTargetLatencyFrames = wf.definition.settings?.targetLatencyFrames
      ? String(wf.definition.settings.targetLatencyFrames)
      : "";
    // lastFiredAt unverändert übernehmen (s. Schedule-Doku oben) — sonst
    // könnte ein bereits gefeuertes "once"-Schedule beim Speichern erneut
    // feuern.
    this.#formSchedules = (wf.definition.schedules ?? []).map((s) => ({ ...s }));
    this.#formTitle = wf.definition.title ?? "";
    this.#formDescription = wf.definition.description ?? "";
    this.#formTags = (wf.definition.tags ?? []).join(", ");
    this.#formCategory = wf.definition.category ?? "";
    this.#showForm = true;
    this.#render();
  }

  async #startWorkflow(wf: Workflow) {
    if (!(await confirmDialog(tt("wf.confirmStart", { p0: wf.name }), { confirmLabel: tt("wf.confirmStartLabel") }))) return;
    const id = wf.id;
    await apiFetch(`/api/v1/workflows/${id}/start`, { method: "POST" });
    await this.#poll();
  }

  // confirm wird immer mitgeschickt — der Orchestrator wertet ihn nur
  // aus, wenn der Workflow settings.confirmStop gesetzt hat (D7 Teil 2),
  // sonst unverändertes Verhalten wie vor diesem Feld.
  async #stopWorkflow(wf: Workflow) {
    // Immer nachfragen (Nutzerwunsch 2026-10-09), unabhängig von
    // settings.confirmStop (das steuert nur die serverseitige Prüfung).
    {
      const ok = await confirmDialog(tt("wf.b5f13f", { p0: wf.name }), { confirmLabel: tt("wf.4c4650") });
      if (!ok) return;
    }
    // Nutzerfund 2026-11-10: gepinnte Rollen starten mit dem GESPEICHERTEN Stand; Live-Änderungen seit dem Speichern
    // gingen beim Stop still verloren. Vorher warnen (nur lesend; Fehler hier verhindern den Stop nicht).
    try {
      const dr = await apiFetch(`/api/v1/workflows/${wf.id}/drift`);
      if (dr.ok) {
        const roles: string[] = (await dr.json()).roles ?? [];
        if (roles.length > 0) {
          const go = await confirmDialog(tt("wf.drift1", { p0: roles.join(", ") }), { confirmLabel: tt("wf.drift2") });
          if (!go) return;
        }
      }
    } catch {
      /* Prüfung nicht möglich — Stop wie bisher */
    }
    try {
      const res = await apiFetch(`/api/v1/workflows/${wf.id}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        showToast(tt("wf.2fcdd3", { p0: await res.text() }));
        return;
      }
    } catch (err) {
      showToast(tt("wf.2fcdd3", { p0: err }));
      return;
    }
    await this.#poll();
  }

  // Kapitel 12 Teil 3 (§12.3c): technisch identisch zu #stopWorkflow
  // (gleiche Ressourcen-Wirkung, gleiche confirm_stop-Regel), landet nur
  // in "paused" statt "stopped".
  async #pauseWorkflow(wf: Workflow) {
    if (wf.definition.settings?.confirmStop) {
      const ok = await confirmDialog(tt("wf.a85624", { p0: wf.name }), { confirmLabel: tt("wf.d63f99") });
      if (!ok) return;
    }
    try {
      const res = await apiFetch(`/api/v1/workflows/${wf.id}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        showToast(tt("wf.a73f32", { p0: await res.text() }));
        return;
      }
    } catch (err) {
      showToast(tt("wf.a73f32", { p0: err }));
      return;
    }
    await this.#poll();
  }

  // Holt den vollständigen Export (mit Rollenbindungen und Alarmregeln, soweit das Konto sie sehen darf) für die
  // Anzeige im Dialog; fehlt das Recht, kommt der Standard-Export ohne beides.
  async #fetchFullExport(wf: Workflow): Promise<IoExport> {
    let res = await apiFetch(`/api/v1/workflows/${wf.id}/export?includeBindings=true`);
    if (!res.ok) res = await apiFetch(`/api/v1/workflows/${wf.id}/export`);
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as IoExport;
  }

  // Zeigt Rollen, Rollenbindungen und Alarmregeln einer Datei und fragt, was davon mitgehen soll. `verb`: Beschriftung des
  // Bestätigen-Knopfs, `intro`: erster Satz. Liefert die Wahl oder null bei Abbruch.
  #askWhatGoesAlong(exp: IoExport, title: string, verb: string, intro: string): Promise<{ bindings: boolean; alerts: boolean } | null> {
    return showDialog<{ bindings: boolean; alerts: boolean }>(title, (body, done) => {
      const p = document.createElement("div");
      p.style.cssText = "font-size:13px;margin-bottom:var(--omp-space-3);";
      p.textContent = intro;
      body.appendChild(p);
      const roles = exp.definition.roles.map((r) => `${r.name} — ${r.nodeType}`);
      const bindings = (exp.bindings ?? []).map((b) => describeBinding(b, tt("wf.io.wholeWorkflow"), tt("wf.io.group"), tt("wf.io.user")));
      const alerts = (exp.alertRules ?? []).map(describeAlertRoute);
      body.appendChild(listBlock(tt("wf.io.roles"), roles, tt("wf.io.none")));
      body.appendChild(listBlock(tt("wf.io.bindings"), bindings, tt("wf.io.noneBindings")));
      const bindRow = checkRow(tt("wf.io.withBindings"), true, bindings.length === 0);
      body.appendChild(bindRow.row);
      body.appendChild(listBlock(tt("wf.io.alerts"), alerts, tt("wf.io.noneAlerts")));
      const alertRow = checkRow(tt("wf.io.withAlerts"), true, alerts.length === 0);
      body.appendChild(alertRow.row);
      const note = document.createElement("div");
      note.style.cssText = "font-size:11px;color:var(--omp-text-dim);";
      note.textContent = tt("wf.io.note");
      body.appendChild(note);
      body.appendChild(buttonRow(verb, () => done({ bindings: bindRow.box.checked, alerts: alertRow.box.checked }), () => done(null)));
    }, true);
  }

  // Kapitel 12 Teil 3 (§12.3d): lädt die Datei über den normalen Browser-Download-Mechanismus herunter (Blob + <a download>).
  // Vorher fragt ein Dialog, ob Rollenbindungen und/oder Alarmregeln mitgehen sollen (ersetzt die frühere Checkbox oben im Tab).
  async #exportWorkflow(wf: Workflow) {
    try {
      const full = await this.#fetchFullExport(wf);
      const choice = await this.#askWhatGoesAlong(full, tt("wf.io.exportTitle", { p0: wf.name }), tt("wf.8721fc"), tt("wf.io.exportIntro"));
      if (!choice) return;
      const exported = applyExportChoices(full, choice);
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const safeName = wf.name.replace(/[^\w\-]+/g, "_") || "workflow";
      link.download = `${safeName}.omp-workflow.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(tt("wf.43069e", { p0: err }));
    }
  }

  // Nutzerwunsch 2026-09-11: Ein-Klick-Klon, jetzt mit Dialog (Nutzerwunsch 2026-11-19): neuer Name und die Frage, ob die
  // Rollen (= Nodes) entsprechend umbenannt werden. Die Rollenliste steht mit den vorgeschlagenen neuen Namen im Dialog und
  // lässt sich Zeile für Zeile ändern. Ohne Rollenbindungen/Alarmregeln (ein Klon erbt keine Rechte).
  // workflows.Service.Import löst eine Namenskollision selbst auf (uniqueWorkflowName).
  async #duplicateWorkflow(wf: Workflow) {
    let exported: IoExport;
    try {
      const res = await apiFetch(`/api/v1/workflows/${wf.id}/export`);
      if (!res.ok) {
        showToast(tt("wf.8a7bae", { p0: await res.text() }));
        return;
      }
      exported = (await res.json()) as IoExport;
    } catch (err) {
      showToast(tt("wf.8a7bae", { p0: err }));
      return;
    }
    const picked = await showDialog<{ name: string; map: Record<string, string> }>(tt("wf.io.dupTitle", { p0: wf.name }), (body, done) => {
      const roles = exported.definition.roles;
      const nameLabel = document.createElement("label");
      nameLabel.style.cssText = "display:block;font-size:12px;font-weight:600;margin-bottom:4px;";
      nameLabel.textContent = tt("wf.io.newName");
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = tt("wf.io.copyOf", { p0: wf.name });
      nameInput.style.cssText = "width:100%;box-sizing:border-box;margin-bottom:var(--omp-space-3);";
      body.append(nameLabel, nameInput);

      const renameRow = checkRow(tt("wf.io.renameRoles"), true, roles.length === 0);
      body.appendChild(renameRow.row);
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:11px;color:var(--omp-text-dim);margin-bottom:6px;";
      hint.textContent = tt("wf.io.renameHint");
      body.appendChild(hint);

      const table = document.createElement("div");
      table.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;max-height:220px;overflow:auto;align-items:center;margin-bottom:6px;";
      body.appendChild(table);
      const err = document.createElement("div");
      err.style.cssText = "color:var(--omp-error);font-size:12px;min-height:16px;";
      body.appendChild(err);

      // Zeilen: alter Name (nur Anzeige) und neuer Name (änderbar). `touched`: der Nutzer hat die Zeile selbst geändert —
      // ein späterer Wechsel des Workflow-Namens überschreibt sie dann nicht mehr.
      const inputs = new Map<string, HTMLInputElement>();
      const touched = new Set<string>();
      for (const r of roles) {
        const old = document.createElement("span");
        old.style.cssText = "font-size:12px;color:var(--omp-text-dim);overflow-wrap:anywhere;";
        old.textContent = r.name;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.style.cssText = "width:100%;box-sizing:border-box;";
        inp.addEventListener("input", () => touched.add(r.name));
        inputs.set(r.name, inp);
        table.append(old, inp);
      }
      const refill = () => {
        const prop = proposeRoleNames(roles, wf.name, nameInput.value, renameRow.box.checked);
        for (const r of roles) {
          const inp = inputs.get(r.name)!;
          if (!touched.has(r.name) || !renameRow.box.checked) inp.value = prop[r.name];
          inp.disabled = !renameRow.box.checked;
        }
      };
      nameInput.addEventListener("input", refill);
      renameRow.box.addEventListener("change", () => {
        if (!renameRow.box.checked) touched.clear();
        refill();
      });
      refill();

      body.appendChild(
        buttonRow(tt("wf.529fdd"), () => {
          const name = nameInput.value.trim();
          if (!name) {
            err.textContent = tt("wf.io.errName");
            return;
          }
          const map: Record<string, string> = {};
          for (const r of roles) map[r.name] = inputs.get(r.name)!.value.trim() || r.name;
          const bad = validateRoleNames(map);
          if (bad) {
            err.textContent = bad === "empty" ? tt("wf.io.errEmpty") : tt("wf.io.errDup");
            return;
          }
          done({ name, map });
        }, () => done(null)),
      );
    }, true);
    if (!picked) return;
    try {
      const renamed = renameRolesInExport({ ...exported, name: picked.name }, picked.map);
      const importRes = await apiFetch("/api/v1/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(renamed),
      });
      if (!importRes.ok) {
        showToast(tt("wf.8a7bae", { p0: await importRes.text() }));
        return;
      }
      const created = (await importRes.json()) as Workflow;
      showToast(tt("wf.7d5095", { p0: created.name }));
    } catch (err) {
      showToast(tt("wf.8a7bae", { p0: err }));
      return;
    }
    await this.#poll();
  }

  // Kapitel 12 Teil 3 (§12.3d): liest die vom Nutzer gewählte Datei. Enthält sie Rollenbindungen oder Alarmregeln, zeigt ein
  // Dialog sie an und fragt, ob sie mit angelegt werden sollen; die eigentliche Validierung (Katalog-Abgleich,
  // Namenskollision) macht der Orchestrator (workflows.Service.Import).
  async #importWorkflowFile(file: File) {
    let exported: IoExport;
    try {
      exported = JSON.parse(await file.text());
    } catch (err) {
      showToast(tt("wf.e7dba3", { p0: err }));
      return;
    }
    if (!exported?.definition?.roles) {
      showToast(tt("wf.e7dba3", { p0: tt("wf.io.notAWorkflow") }));
      return;
    }
    const choice = await this.#askWhatGoesAlong(
      exported,
      tt("wf.io.importTitle", { p0: exported.name ?? file.name }),
      tt("wf.5af5fb"),
      tt("wf.io.importIntro"),
    );
    if (!choice) return;
    try {
      const res = await apiFetch("/api/v1/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applyExportChoices(exported, choice)),
      });
      if (!res.ok) {
        showToast(tt("wf.6cdb17", { p0: await res.text() }));
        return;
      }
      const created = (await res.json()) as Workflow & { importNotes?: string[] };
      showToast(tt("wf.db21f2", { p0: created.name }));
      if (created.importNotes?.length) showToast(tt("wf.importNotes", { p0: created.importNotes.join("; ") }));
    } catch (err) {
      showToast(tt("wf.6cdb17", { p0: err }));
      return;
    }
    await this.#poll();
  }

  async #deleteWorkflow(wf: Workflow) {
    if (!(await confirmDialog(tt("wf.confirmDelete", { p0: wf.name }), { confirmLabel: tt("wf.confirmDeleteLabel") }))) return;
    const id = wf.id;
    try {
      const res = await apiFetch(`/api/v1/workflows/${id}`, { method: "DELETE" });
      if (!res.ok) {
        showToast(tt("wf.05f6da", { p0: await res.text() }));
        return;
      }
    } catch (err) {
      showToast(tt("wf.05f6da", { p0: err }));
      return;
    }
    await this.#poll();
  }

  // Kapitel 12 Teil 6 (§22.3 Punkt 1): Vollbild-Overlay mit dem
  // grafischen Designer — gleiches Overlay-Muster wie
  // ui/shell/auth.ts#showLoginOverlay (position:fixed;inset:0, hoher
  // z-index), hier lokal statt als geteilte Hilfsfunktion, weil nur
  // dieser eine Aufrufer ihn braucht. workflowId=null öffnet einen
  // leeren Entwurf, sonst die bestehende (stopped/paused) Definition
  // zum Bearbeiten.
  #openRoleDesigner(workflowId: string | null) {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-role", "role-designer-overlay");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2000;background:var(--omp-bg);";

    const designer = document.createElement("omp-role-designer") as RoleDesigner;
    overlay.appendChild(designer);
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
    };
    designer.addEventListener("designer-closed", close);
    designer.addEventListener("designer-saved", () => {
      close();
      void this.#poll();
    });

    void designer.open(workflowId);
  }

  // Kapitel 12 Teil 6, Unterteil 2 (§22.3 Punkt 8) — Volltext über
  // Titel/Name (Fallback)/Beschreibung/Tags, plus die zwei Facetten
  // Kategorie und Status. Leerer Filter = alles (unverändertes
  // Verhalten für den bisherigen Anwendungsfall ohne aktiven Filter).
  #matchesFilter(wf: Workflow): boolean {
    if (this.#filterCategory && wf.definition.category !== this.#filterCategory) return false;
    if (this.#filterStatus && statusGroup(wf.status) !== this.#filterStatus) return false;
    const q = this.#searchQuery.trim().toLowerCase();
    if (!q) return true;
    const haystack = [wf.definition.title, wf.name, wf.definition.description, ...(wf.definition.tags ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  #render() {
    this.replaceChildren();

    ensureWorkflowStyles();
    const heading = document.createElement("div");
    heading.className = "wf-toolbar";
    const titleBox = document.createElement("div");
    titleBox.className = "wf-title";
    const headingTitle = document.createElement("span");
    headingTitle.className = "omp-h1";
    headingTitle.textContent = tt("wf.ui.heading");
    const countEl = document.createElement("span");
    countEl.className = "wf-count";
    countEl.textContent = tt("wf.ui.count", { p0: this.#workflows.length, p1: this.#workflows.filter((w) => statusGroup(w.status) === "running").length });
    titleBox.append(headingTitle, countEl);
    heading.appendChild(titleBox);

    // Kapitel 12 Teil 3 (§12.3d): <label> um ein verstecktes <input type="file"> — Klick auf das Label öffnet nativ
    // den Datei-Dialog, kein eigener Klick-Handler nötig.
    const importLabel = document.createElement("label");
    importLabel.className = "wf-import";
    importLabel.textContent = "⇧ " + tt("wf.5af5fb");
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json";
    importInput.style.display = "none";
    importInput.addEventListener("change", () => {
      const file = importInput.files?.[0];
      if (file) void this.#importWorkflowFile(file);
      importInput.value = ""; // dieselbe Datei später erneut wählbar machen
    });
    importLabel.appendChild(importInput);
    heading.appendChild(importLabel);

    // Kapitel 12 Teil 6 (§22.3 Punkt 1): grafischer Entwurf statt des Text-Formulars — beide erzeugen denselben POST
    // /api/v1/workflows, reine UX-Alternative, kein zweiter Datenpfad.
    const designBtn = document.createElement("button");
    designBtn.textContent = "✎ " + tt("wf.881fa7");
    designBtn.addEventListener("click", () => this.#openRoleDesigner(null));
    heading.appendChild(designBtn);

    // "+ Neu" öffnet das Modal (s. #renderFormModal); schließen läuft über #closeWorkflowForm.
    const newBtn = document.createElement("button");
    newBtn.className = "omp-btn-primary";
    newBtn.textContent = tt("wf.8df699");
    newBtn.addEventListener("click", () => {
      this.#editingId = null;
      this.#resetForm();
      this.#showForm = true;
      this.#render();
    });
    heading.appendChild(newBtn);

    this.appendChild(heading);

    if (this.#showForm) {
      this.appendChild(this.#renderFormModal());
    }

    if (this.#workflows.length === 0 && !this.#showForm) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = tt("wf.ad8902");
      this.appendChild(empty);
      return;
    }

    // Kapitel 12 Teil 6, Unterteil 2 (§22.3 Punkt 8) — Such-/Filterleiste
    // nur anzeigen, wenn es überhaupt etwas zu filtern gibt (bei einem
    // einzelnen Workflow wäre sie reiner Leerraum).
    this.appendChild(this.#renderFilterBar());

    const filtered = this.#workflows.filter((wf) => this.#matchesFilter(wf));

    // Leer-Hinweis und Grid immer beide (auch leer) rendern, mit
    // data-role markiert — #refreshGrid() (Such-Eingabe, s. o.)
    // aktualisiert danach nur noch ihren Inhalt statt eines vollen
    // #render(), sonst würde das Suchfeld bei jedem Tastendruck den
    // Fokus verlieren.
    const empty = document.createElement("div");
    empty.setAttribute("data-role", "workflow-filter-empty");
    empty.className = "omp-empty";
    empty.textContent = filtered.length === 0 ? tt("wf.bd4e9e") : "";
    this.appendChild(empty);

    // Kapitel 12 Teil 6 (§22.3 Punkt 6): Katalog-Übersicht als
    // Kachel-Grid mit Topologie-Vorschau, Titel, gekürzter Beschreibung,
    // Status-Badge, Kategorie-Icon.
    const grid = document.createElement("div");
    grid.setAttribute("data-role", "workflow-grid");
    grid.className = "wf-grid";
    for (const wf of filtered) {
      grid.appendChild(this.#renderWorkflowRow(wf));
    }
    this.appendChild(grid);
  }

  // Kapitel 12 Teil 6, Unterteil 2 (§22.3 Punkt 8). "input"-Events lösen
  // hier bewusst nur eine gezielte Grid-Neuberechnung aus (nicht das
  // volle #render()), damit das Suchfeld beim Tippen den Fokus behält —
  // gleicher Grund wie bei den Rollennamen-Feldern im Formular
  // ("change" statt "input" für ein Voll-Rerender, s. #renderForm).
  #renderFilterBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "wf-options";

    // Suche nur bei mehr als einem Workflow sinnvoll (sonst reiner Leerraum).
    if (this.#workflows.length > 1) {
      const searchWrap = document.createElement("span");
      searchWrap.className = "omp-search-wrap";
      searchWrap.style.cssText = "flex:1;min-width:180px;max-width:320px;";
      const searchInput = document.createElement("input");
      searchInput.className = "omp-search-input";
      searchInput.type = "search";
      searchInput.placeholder = tt("wf.4d0c9d");
      searchInput.value = this.#searchQuery;
      searchInput.style.cssText = "width:100%;box-sizing:border-box;";
      searchInput.addEventListener("input", () => {
        this.#searchQuery = searchInput.value;
        this.#refreshGrid();
      });
      searchWrap.appendChild(searchInput);
      bar.appendChild(searchWrap);

      // Status als Pillen mit Zähler statt eines Auswahlfelds: ein Klick, der Stand ist auf einen Blick sichtbar.
      const pills = document.createElement("div");
      pills.className = "wf-pills";
      const mkPill = (group: StatusGroup | "", color: string, label: string, count: number) => {
        const b = document.createElement("button");
        b.className = "wf-pill";
        b.style.setProperty("--wf-c", color);
        b.setAttribute("aria-pressed", this.#filterStatus === group ? "true" : "false");
        const dot = document.createElement("span");
        dot.className = "wf-dot";
        const strong = document.createElement("b");
        strong.textContent = String(count);
        b.append(dot, label + " ", strong);
        b.addEventListener("click", () => {
          this.#filterStatus = this.#filterStatus === group ? "" : group;
          this.#render();
        });
        return b;
      };
      pills.appendChild(mkPill("", "var(--omp-info)", tt("wf.ui.f.all"), this.#workflows.length));
      for (const g of STATUS_GROUP_ORDER) {
        const n = this.#workflows.filter((w) => statusGroup(w.status) === g).length;
        if (n === 0 && this.#filterStatus !== g) continue;
        pills.appendChild(mkPill(g, GROUP_COLORS[g], tt(`wf.ui.g.${g}`), n));
      }
      bar.appendChild(pills);

      const categorySelect = document.createElement("select");
      const anyCategoryOpt = document.createElement("option");
      anyCategoryOpt.value = "";
      anyCategoryOpt.textContent = tt("wf.111336");
      categorySelect.appendChild(anyCategoryOpt);
      for (const [value, label] of Object.entries(CATEGORY_LABELS)) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        if (value === this.#filterCategory) opt.selected = true;
        categorySelect.appendChild(opt);
      }
      categorySelect.addEventListener("change", () => {
        this.#filterCategory = categorySelect.value;
        this.#render();
      });
      bar.appendChild(categorySelect);
    }

    return bar;
  }

  // Neuberechnet nur das Grid (nicht Suchfeld/Filterleiste selbst) —
  // s. #renderFilterBar-Kommentar zum Fokus-Verlust bei vollem Rerender.
  #refreshGrid() {
    const grid = this.querySelector('[data-role="workflow-grid"]');
    const empty = this.querySelector('[data-role="workflow-filter-empty"]');
    const filtered = this.#workflows.filter((wf) => this.#matchesFilter(wf));
    if (grid) {
      grid.replaceChildren(...filtered.map((wf) => this.#renderWorkflowRow(wf)));
    }
    if (empty) {
      empty.textContent = filtered.length === 0 ? tt("wf.bd4e9e") : "";
    }
  }

  #renderWorkflowRow(wf: Workflow): HTMLElement {
    const color = STATUS_COLORS[wf.status] ?? "var(--omp-text-dim)";
    const live = wf.status === "started" || wf.status === "starting" || wf.status === "stopping" || wf.status === "pausing";
    const row = document.createElement("div");
    row.setAttribute("data-role", "workflow-row");
    row.setAttribute("data-workflow-id", wf.id);
    row.className = "wf-card";
    row.style.setProperty("--wf-c", color);

    // --- Kopf: Titel (Definition.title, sonst Name) und Status ------------------------------------------------
    const head = document.createElement("div");
    head.className = "wf-head";
    const title = document.createElement("span");
    title.setAttribute("data-role", "workflow-title");
    title.className = "wf-name";
    title.textContent = wf.definition.title || wf.name;
    title.title = wf.definition.title || wf.name;
    const status = document.createElement("span");
    status.setAttribute("data-role", "workflow-status");
    status.className = "wf-state" + (live ? " wf-live" : "");
    const dot = document.createElement("i");
    status.append(dot, wf.status);
    head.append(title, status);
    row.appendChild(head);

    // --- Kennzahlen: Rollen, Hosts, Format, Zeitpläne, Kategorie, Tags ---------------------------------------
    const settings = wf.definition.settings;
    const plan = this.#plans.get(wf.id);
    const facts = document.createElement("div");
    facts.className = "wf-facts";
    const addChip = (text: string, strong = false, tip = "") => {
      const c = document.createElement("span");
      c.className = "wf-chip" + (strong ? " wf-strong" : "");
      c.textContent = text;
      if (tip) c.title = tip;
      facts.appendChild(c);
    };
    const roleCount = wf.definition.roles.length;
    addChip(tt("wf.ui.roles", { p0: roleCount }), true);
    if (plan) {
      const hostCount = groupByHost(plan).length;
      if (hostCount > 0) addChip(tt("wf.ui.hosts", { p0: hostCount }), true);
    }
    if (wf.definition.category) addChip(CATEGORY_LABELS[wf.definition.category] ?? wf.definition.category);
    if (settings?.programFormat) addChip(settings.programFormat);
    if (settings?.domain) addChip(`⬡ ${settings.domain}`);
    if (settings?.confirmStop) addChip(tt("wf.91d470"));
    if (settings?.targetLatencyFrames) addChip(tt("wf.7b3fe9", { p0: settings.targetLatencyFrames }));
    const scheduleCount = wf.definition.schedules?.length ?? 0;
    if (scheduleCount > 0) addChip("⏱ " + tt("wf.46f0b8", { p0: scheduleCount, p1: scheduleCount === 1 ? "" : "e" }));
    for (const tag of wf.definition.tags ?? []) addChip("#" + tag);
    row.appendChild(facts);

    // --- Beschreibung: immer zwei Zeilen Platz, damit Karten gleich hoch beginnen ------------------------
    const desc = document.createElement("div");
    desc.className = "wf-desc";
    desc.textContent = wf.definition.description ?? "";
    row.appendChild(desc);

    // --- Inhalt: Fehler, gehaltene Rollen, Plan (eingeklappt — er streckt die Karte nicht) ----------------
    const body = document.createElement("div");
    body.className = "wf-body";
    if (wf.error) {
      const err = document.createElement("div");
      err.className = "wf-err";
      err.textContent = wf.error;
      body.appendChild(err);
    }
    const holds = this.#renderHolds(wf);
    if (holds) body.appendChild(holds);
    const details = document.createElement("details");
    details.className = "wf-plan";
    details.open = this.#openPlans.has(wf.id);
    const summary = document.createElement("summary");
    summary.textContent = tt("wf.ui.plan", { p0: roleCount });
    const inner = document.createElement("div");
    inner.className = "wf-plan-inner";
    inner.appendChild(this.#renderPlan(wf));
    details.append(summary, inner);
    details.addEventListener("toggle", () => {
      if (details.open) this.#openPlans.add(wf.id);
      else this.#openPlans.delete(wf.id);
    });
    body.appendChild(details);
    row.appendChild(body);

    // --- Fuß: feste Felder, immer unten, immer an derselben Stelle ----------------------------------------
    // "paused" startet identisch zu "stopped"/"failed" (Kapitel 12 Teil 3: "Resume = normaler Start").
    const canStart = wf.status === "stopped" || wf.status === "failed" || wf.status === "paused";
    const canStop = wf.status === "started" || wf.status === "failed" || wf.status === "starting";
    const canPause = wf.status === "started" || wf.status === "failed" || wf.status === "starting";
    // Bearbeiten/Löschen: "stopped" und "paused" (Kapitel 12 Teil 3 erweitert §12.3c das ausdrücklich).
    const isIdle = wf.status === "stopped" || wf.status === "paused";

    const mkBtn = (cls: string, icon: string, label: string, onClick: () => void, opts: { disabled?: boolean; title?: string } = {}) => {
      const b = document.createElement("button");
      if (cls) b.className = cls;
      const ic = document.createElement("span");
      ic.className = "wf-ic";
      ic.textContent = icon;
      const lb = document.createElement("span");
      lb.className = "wf-lbl";
      lb.textContent = label;
      b.append(ic, lb);
      b.disabled = !!opts.disabled;
      b.title = opts.title ?? label;
      b.addEventListener("click", onClick);
      return b;
    };

    const foot = document.createElement("div");
    foot.className = "wf-foot";
    const run = document.createElement("div");
    run.className = "wf-run";
    run.append(
      mkBtn("wf-start", "▶", wf.status === "paused" ? tt("wf.527daf") : tt("wf.a6122a"), () => this.#startWorkflow(wf), { disabled: !canStart }),
      mkBtn("wf-stop", "■", tt("wf.11a755"), () => this.#stopWorkflow(wf), { disabled: !canStop }),
      mkBtn("wf-pause", "❚❚", tt("wf.d63f99"), () => this.#pauseWorkflow(wf), { disabled: !canPause }),
    );
    const tools = document.createElement("div");
    tools.className = "wf-tools";
    const idleHint = isIdle ? undefined : tt("wf.f7bfda");
    tools.append(
      // Kapitel 12 Teil 1 (PUT /api/v1/workflows/{id}): nur "stopped"/"paused" (s. workflows.Service.Update).
      mkBtn("", "✎", tt("wf.5ad05d"), () => this.#editWorkflow(wf), { disabled: !isIdle, title: idleHint ?? tt("wf.5ad05d") }),
      // Kapitel 12 Teil 6 (§22.3 Punkt 1): grafisches Bearbeiten derselben Definition, gleiche Voraussetzung.
      // (Der frühere dritte Weg "Im Flow-Editor bearbeiten" entfiel am 2026-09-07 ersatzlos, s. Git-Historie.)
      mkBtn("", "◫", tt("wf.ui.designShort"), () => this.#openRoleDesigner(wf.id), { disabled: !isIdle, title: idleHint ?? tt("wf.971a83") }),
      // Nutzerwunsch 2026-09-11: Ein-Klick-Duplizieren (#duplicateWorkflow), in jedem Zustand möglich.
      mkBtn("", "⧉", tt("wf.529fdd"), () => this.#duplicateWorkflow(wf), { title: tt("wf.5e9890") }),
      // Kapitel 12 Teil 3 (§12.3d): in jedem Zustand exportierbar (Definition, nicht Laufzeitzustand).
      mkBtn("", "⇩", tt("wf.8721fc"), () => this.#exportWorkflow(wf)),
      mkBtn("wf-del", "🗑", tt("wf.1010b0"), () => this.#deleteWorkflow(wf), { disabled: !isIdle, title: isIdle ? tt("wf.1010b0") : tt("wf.bc9ab0") }),
    );
    foot.append(run, tools);
    row.appendChild(foot);
    return row;
  }

  #closeWorkflowForm() {
    this.#showForm = false;
    this.#editingId = null;
    this.#resetForm();
    this.#render();
  }

  // Backdrop-Klick/Escape schließen das Modal — gleiche Formel wie
  // admin-view.ts' #renderCatalogModal (Node-Katalog-Redesign
  // 2026-09-02), hier wiederverwendet statt neu erfunden. Deutlich
  // größeres Formular als beim Node-Katalog (Rollen/Verbindungen/
  // Zeitpläne) — eigene max-width statt der .omp-modal-Vorgabe.
  #renderFormModal(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) this.#closeWorkflowForm();
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.#closeWorkflowForm();
    });

    const modal = document.createElement("div");
    modal.className = "omp-modal";
    // Die 880px-Verbreiterung (für die frühere sechsspaltige Rollen-
    // Zeile) ist mit deren Entfernung 2026-09-07 hinfällig — das
    // Formular enthält jetzt nur noch Name/Beschreibung, die
    // Rollen/Verbindungen-Zusammenfassung und Zeitpläne, alles bei der
    // .omp-modal-Vorgabe (560px) unproblematisch.

    const modalHeading = document.createElement("div");
    modalHeading.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-3);";
    const modalTitle = document.createElement("span");
    modalTitle.className = "omp-h1";
    modalTitle.textContent = this.#editingId ? tt("wf.a12710") : tt("wf.dfb7da");
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", tt("wf.8311b9"));
    closeBtn.addEventListener("click", () => this.#closeWorkflowForm());
    modalHeading.append(modalTitle, closeBtn);
    modal.appendChild(modalHeading);

    modal.appendChild(this.#renderForm());

    overlay.appendChild(modal);
    queueMicrotask(() => modal.querySelector("input")?.focus());
    return overlay;
  }

  #renderForm(): HTMLElement {
    // Kein eigener Rahmen/Hintergrund mehr — dieses Formular steckt jetzt
    // in .omp-modal (s. #renderFormModal), das beides bereits liefert.
    // Kein flex/gap hier: die einzelnen Felder/Reihen unten tragen bereits
    // je eigene margin-bottom-Werte (unverändert) — ein zusätzliches Gap
    // würde sich damit addieren, nicht ersetzen.
    const form = document.createElement("div");

    const nameInput = document.createElement("input");
    nameInput.placeholder = tt("wf.b2d236");
    nameInput.value = this.#formName;
    nameInput.style.cssText = "width:100%;margin-bottom:6px;box-sizing:border-box;";
    nameInput.addEventListener("input", () => {
      this.#formName = nameInput.value;
    });
    form.appendChild(nameInput);

    // Kapitel 12 Teil 6 (§22.3 Punkte 4/7): rein darstellungsbezogene
    // Katalog-Metadaten, alle optional — leer gelassen zeigt der
    // Katalog den Namen als Titel-Fallback und keine Beschreibung/Tags.
    const metaHeading = document.createElement("div");
    metaHeading.textContent = tt("wf.3b82d6");
    metaHeading.style.cssText = "color:var(--omp-text-dim);margin-bottom:2px;";
    form.appendChild(metaHeading);

    const titleInput = document.createElement("input");
    titleInput.placeholder = tt("wf.a964f6");
    titleInput.value = this.#formTitle;
    titleInput.style.cssText = "width:100%;margin-bottom:4px;box-sizing:border-box;";
    titleInput.addEventListener("input", () => {
      this.#formTitle = titleInput.value;
    });
    form.appendChild(titleInput);

    const descInput = document.createElement("textarea");
    descInput.placeholder = tt("wf.35bedb");
    descInput.value = this.#formDescription;
    descInput.rows = 2;
    descInput.style.cssText = "width:100%;margin-bottom:4px;box-sizing:border-box;resize:vertical;font-family:inherit;";
    descInput.addEventListener("input", () => {
      this.#formDescription = descInput.value;
    });
    form.appendChild(descInput);

    const metaRow = document.createElement("div");
    metaRow.style.cssText = "display:flex;gap:4px;margin-bottom:8px;";

    const tagsInput = document.createElement("input");
    tagsInput.placeholder = tt("wf.ed8a68");
    tagsInput.value = this.#formTags;
    tagsInput.style.cssText = "width:65%;";
    tagsInput.addEventListener("input", () => {
      this.#formTags = tagsInput.value;
    });

    const categorySelect = document.createElement("select");
    categorySelect.style.cssText = "width:35%;";
    const emptyCategoryOpt = document.createElement("option");
    emptyCategoryOpt.value = "";
    emptyCategoryOpt.textContent = tt("wf.f8c1f7");
    categorySelect.appendChild(emptyCategoryOpt);
    for (const [value, label] of Object.entries(CATEGORY_LABELS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === this.#formCategory) opt.selected = true;
      categorySelect.appendChild(opt);
    }
    categorySelect.addEventListener("change", () => {
      this.#formCategory = categorySelect.value;
    });

    metaRow.append(tagsInput, categorySelect);
    form.appendChild(metaRow);

    // UX-Überarbeitung 2026-09-07 (Nutzerauftrag "das UI für das Workflow
    // bearbeiten... ist noch absolut nicht intuitiv"): dieser komplette
    // Block (vorher ~215 Zeilen, ein dichtes Sechs-Spalten-Gitter aus
    // Name/Typ/Host/Affinität/Redundanz/Format PRO Rolle plus eine
    // weitere Zeile pro Verbindung, alle Spalten ohne eigene Beschriftung
    // außer der einen Section-Überschrift) entfernt — Rollen/
    // Verbindungen werden jetzt AUSSCHLIESSLICH grafisch bearbeitet
    // (`<omp-role-designer>`, "Grafisch bearbeiten"/"Grafisch entwerfen"
    // auf der Karten-/Übersichtsebene). Vorher gab es DREI Wege, dieselbe
    // Daten zu editieren (dieses Gitter, den Designer, UND "Im
    // Flow-Editor bearbeiten" — letzterer ebenfalls entfernt, s.
    // #renderWorkflowCard-Doku) — das war der Kern der Beschwerde, nicht
    // eine einzelne unklare Beschriftung. `#formRoles`/`#formConnections`
    // bleiben als reiner Datenträger bestehen (von `#editWorkflow()` aus
    // der bestehenden Definition befüllt, hier nur noch gelesen für die
    // Zusammenfassung unten) — ein Speichern aus DIESEM Formular sendet
    // die vorhandene Definition dadurch unverändert mit, ändert sie aber
    // nie mehr selbst (s. #submitForm-Doku zum jetzt entschärften
    // Leer-Rollen-Guard).
    const rolesSummary = document.createElement("div");
    rolesSummary.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px 10px;margin-bottom:8px;" +
      "display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;";
    const roleCount = this.#formRoles.filter((r) => r.name && r.nodeType).length;
    const connCount = this.#formConnections.filter((c) => c.fromRole && c.toRole).length;
    const summaryText = document.createElement("span");
    summaryText.textContent =
      roleCount > 0
        ? tt("wf.bbef58", { p0: roleCount, p1: connCount })
        : tt("wf.6d7c2c");
    summaryText.style.color = "var(--omp-text-dim)";
    const openDesignerBtn = document.createElement("button");
    openDesignerBtn.textContent = tt("wf.276af7");
    openDesignerBtn.addEventListener("click", () => {
      const workflowId = this.#editingId;
      this.#closeWorkflowForm();
      this.#openRoleDesigner(workflowId);
    });
    rolesSummary.append(summaryText, openDesignerBtn);
    form.appendChild(rolesSummary);

    // Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c): pro-Workflow
    // Programm-Auflösung, optional — leer gelassen behalten die Nodes
    // ihren eigenen Default.
    const settingsHeading = document.createElement("div");
    settingsHeading.textContent = tt("wf.17c01d");
    settingsHeading.style.cssText = "color:var(--omp-text-dim);margin-bottom:2px;";
    form.appendChild(settingsHeading);

    // Nutzerwunsch 2026-09-11 ("elegantere Lösung mit einer global
    // definierbaren Dropdown statt Breite/Höhe, Framerate fehlt auch"):
    // eine benannte Auflösung+Framerate-Preset-Auswahl statt zweier
    // Zahlenfelder ohne Framerate-Bezug — dieselbe STANDARD_FORMATS-
    // Liste und dasselbe Optionsmuster wie der Format-Dropdown im
    // grafischen Role-Designer (ui/graph/role-designer.ts), damit
    // beide nie auseinanderlaufen (einzige Quelle der Wahrheit bleibt
    // orchestrator/internal/workflows/formats.go).
    const settingsRow = document.createElement("div");
    settingsRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:8px;";
    const formatSelect = document.createElement("select");
    formatSelect.title = tt("wf.5be567");
    formatSelect.style.cssText = "width:100%;";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = tt("wf.d6aaa2");
    formatSelect.appendChild(defaultOpt);
    for (const name of STANDARD_FORMATS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === this.#formProgramFormat) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    formatSelect.addEventListener("change", () => {
      this.#formProgramFormat = formatSelect.value;
    });
    settingsRow.appendChild(formatSelect);
    // Kap. 103: MXL-Domain des Workflows — nur anbieten, wenn Domains angelegt sind oder der Workflow schon eine trägt.
    if (this.#domainNames.length > 0 || this.#formDomain) {
      const domainSelect = document.createElement("select");
      domainSelect.title = tt("wf.domain.hint");
      domainSelect.style.cssText = "width:100%;";
      const names = [...new Set(["", ...this.#domainNames, ...(this.#formDomain ? [this.#formDomain] : [])])];
      for (const n of names) {
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = n === "" ? tt("wf.domain.default") : `⬡ ${n}`;
        if (n === this.#formDomain) opt.selected = true;
        domainSelect.appendChild(opt);
      }
      domainSelect.addEventListener("change", () => {
        this.#formDomain = domainSelect.value;
      });
      settingsRow.appendChild(domainSelect);
    }
    form.appendChild(settingsRow);

    // D8 Teil 2 (ARCHITECTURE.md §15.1 Punkt 2): Latenzbudget, optional —
    // leer gelassen startet der Workflow unverändert ohne Preflight-
    // Check (0/undefined = "nicht gesetzt", gleiche Konvention wie
    // Breite/Höhe oben). Bewusst nur Video-Frames (D8 Teil 2-Scope, s.
    // orchestrator/internal/workflows/latencybudget.go).
    const latencyHeading = document.createElement("div");
    latencyHeading.textContent = tt("wf.f64b3f");
    latencyHeading.style.cssText = "color:var(--omp-text-dim);margin-bottom:2px;";
    form.appendChild(latencyHeading);

    const latencyRow = document.createElement("div");
    latencyRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:8px;";
    const latencyInput = document.createElement("input");
    latencyInput.type = "number";
    latencyInput.min = "0";
    latencyInput.placeholder = "z. B. 5";
    latencyInput.value = this.#formTargetLatencyFrames;
    latencyInput.style.cssText = "width:45%;";
    latencyInput.addEventListener("input", () => {
      this.#formTargetLatencyFrames = latencyInput.value;
    });
    latencyRow.append(latencyInput);
    form.appendChild(latencyRow);

    // D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 1): Start/Stop-Zeitpläne.
    const scheduleHeading = document.createElement("div");
    scheduleHeading.textContent = tt("wf.741ee9");
    scheduleHeading.style.cssText = "color:var(--omp-text-dim);margin-bottom:2px;";
    form.appendChild(scheduleHeading);

    this.#formSchedules.forEach((sched, i) => {
      form.appendChild(this.#renderScheduleRow(sched, i));
    });

    const addScheduleBtn = document.createElement("button");
    addScheduleBtn.textContent = tt("wf.ec5db6");
    addScheduleBtn.style.cssText = "font-size:11px;cursor:pointer;margin-bottom:8px;";
    addScheduleBtn.addEventListener("click", () => {
      this.#formSchedules.push({ id: crypto.randomUUID(), kind: "daily", action: "start" });
      this.#render();
    });
    form.appendChild(addScheduleBtn);

    // D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 2): Stop-Sicherheitsabfrage.
    const confirmStopRow = document.createElement("label");
    confirmStopRow.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:8px;cursor:pointer;";
    const confirmStopCheckbox = document.createElement("input");
    confirmStopCheckbox.type = "checkbox";
    confirmStopCheckbox.checked = this.#formConfirmStop;
    confirmStopCheckbox.addEventListener("change", () => {
      this.#formConfirmStop = confirmStopCheckbox.checked;
    });
    const confirmStopLabel = document.createElement("span");
    confirmStopLabel.textContent = tt("wf.b7d530");
    confirmStopRow.append(confirmStopCheckbox, confirmStopLabel);
    form.appendChild(confirmStopRow);

    const createBtn = document.createElement("button");
    createBtn.className = "omp-btn-primary";
    createBtn.textContent = this.#editingId ? tt("wf.b97d23") : tt("wf.6212ff");
    createBtn.style.cssText = "display:block;";
    createBtn.addEventListener("click", () => this.#submitForm());
    form.appendChild(createBtn);

    return form;
  }

  // D7 Teil 2: eine Zeitplan-Zeile — Kind+Aktion immer, dazu je nach Kind
  // ein datetime-local-Feld ("once") oder ein Zeit- (+ bei "weekly"
  // Wochentags-)Feld.
  #renderScheduleRow(sched: Schedule, i: number): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;flex-wrap:wrap;";

    const kindSelect = document.createElement("select");
    (["once", "daily", "weekly"] as const).forEach((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "once" ? "einmalig" : value === "daily" ? tt("wf.0d9d6e") : tt("wf.b7ca91");
      if (value === sched.kind) opt.selected = true;
      kindSelect.appendChild(opt);
    });
    kindSelect.addEventListener("change", () => {
      sched.kind = kindSelect.value as Schedule["kind"];
      this.#render();
    });

    const actionSelect = document.createElement("select");
    (["start", "stop"] as const).forEach((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "start" ? tt("wf.a6122a") : tt("wf.11a755");
      if (value === sched.action) opt.selected = true;
      actionSelect.appendChild(opt);
    });
    actionSelect.addEventListener("change", () => {
      sched.action = actionSelect.value as Schedule["action"];
    });

    row.append(kindSelect, actionSelect);

    if (sched.kind === "once") {
      const dtInput = document.createElement("input");
      dtInput.type = "datetime-local";
      dtInput.value = sched.at ? toDatetimeLocalValue(sched.at) : "";
      dtInput.addEventListener("input", () => {
        sched.at = dtInput.value ? new Date(dtInput.value).toISOString() : undefined;
      });
      row.appendChild(dtInput);
    } else {
      if (sched.kind === "weekly") {
        // Sofort auf "So" (Index 0) festlegen statt nur visuell — sonst
        // zeigt der Select eine Auswahl, die sched.weekday (undefined)
        // nicht widerspiegelt, bis der Nutzer ihn tatsächlich ändert.
        if (sched.weekday === undefined) sched.weekday = 0;
        const weekdaySelect = document.createElement("select");
        WEEKDAY_LABELS.forEach((label, idx) => {
          const opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = label;
          if (sched.weekday === idx) opt.selected = true;
          weekdaySelect.appendChild(opt);
        });
        weekdaySelect.addEventListener("change", () => {
          sched.weekday = Number(weekdaySelect.value);
        });
        row.appendChild(weekdaySelect);
      }
      const timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.value = sched.timeOfDay ?? "";
      timeInput.addEventListener("input", () => {
        sched.timeOfDay = timeInput.value || undefined;
      });
      row.appendChild(timeInput);
    }

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.style.cssText = "cursor:pointer;";
    removeBtn.addEventListener("click", () => {
      this.#formSchedules.splice(i, 1);
      this.#render();
    });
    row.appendChild(removeBtn);

    return row;
  }
}

// Wandelt einen gespeicherten ISO-Zeitstempel in den von
// <input type="datetime-local"> erwarteten lokalen Wert
// ("YYYY-MM-DDTHH:mm") um — bewusst über die lokalen Date-Getter, nicht
// toISOString() (das liefert UTC, nicht die Ortszeit des Browsers).
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

customElements.define("omp-workflows-view", WorkflowsView);
