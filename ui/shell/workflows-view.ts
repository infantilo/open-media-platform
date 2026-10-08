// <omp-workflows-view> — Workflow-Bereitstellung & -Verteilung
// (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1): benannte Bündel aus
// Node-Rollen + Rolle→Rolle-Verbindungs-Template anlegen sowie als
// Ganzes starten/stoppen. Bewusst kein eigenes Engineering-Dashboard
// (§17.2 existiert noch nicht) — seit K1-Teil-1 eine Vollansicht im
// App-Bar-Tab "Workflows" (app-shell.ts), vormals ein per Knopf ein-/
// ausblendbares Floating-Panel (gleiches Muster wie hosts-view.ts).
//
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): reagiert
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
const REFRESH_EVENT_TYPES = new Set(["workflow.updated", "lost-events"]);

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
// UI explizit `?includeBindings=true` anfragt (s. #exportWithBindings),
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

class WorkflowsView extends HTMLElement {
  #pollHandle: number | undefined;
  #catalog: CatalogEntry[] = [];
  #hosts: HostEntry[] = [];
  #workflows: Workflow[] = [];
  // Plan-Vorschau je Workflow (Hosts, Bedarf, Engpass-Warnungen), s. workflow-plan-logic.ts.
  #plans = new Map<string, StartPlan>();
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
  #exportWithBindings = false;
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
      const [catalogRes, hostsRes] = await Promise.all([apiFetch("/api/v1/catalog"), apiFetch("/api/v1/hosts")]);
      if (catalogRes.ok) this.#catalog = await catalogRes.json();
      if (hostsRes.ok) this.#hosts = await hostsRes.json();
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

  // Kapitel 12 Teil 3 (§12.3d): lädt die Datei über den normalen
  // Browser-Download-Mechanismus herunter (Blob + <a download>), keine
  // eigene Dialog-UI nötig.
  async #exportWorkflow(wf: Workflow) {
    try {
      const query = this.#exportWithBindings ? "?includeBindings=true" : "";
      const res = await apiFetch(`/api/v1/workflows/${wf.id}/export${query}`);
      if (!res.ok) {
        showToast(tt("wf.43069e", { p0: await res.text() }));
        return;
      }
      const exported = (await res.json()) as ExportedWorkflow;
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

  // Nutzerwunsch 2026-09-11 ("Möglichkeit, einen Workflow zu 'clonen'
  // — ein Workflow wäre z. B. ein Regieplatz, zweiter Regieplatz mit
  // derselben Config"): GET export + POST import intern verkettet,
  // ohne den Umweg über eine heruntergeladene/wieder hochgeladene
  // Datei (#exportWorkflow/#importWorkflowFile). Bewusst OHNE
  // Rollenbindungen (gleicher Default wie ein Export ohne die "inkl.
  // Rollenbindungen"-Option, s. #exportWithBindings) — ein Klon soll
  // erst mal nur dieselbe Definition sein, nicht automatisch dieselben
  // Bedienrechte erben. workflows.Service.Import löst eine
  // Namenskollision bereits selbst auf (uniqueWorkflowName), kein
  // eigener Vorab-Check hier nötig.
  async #duplicateWorkflow(wf: Workflow) {
    try {
      const res = await apiFetch(`/api/v1/workflows/${wf.id}/export`);
      if (!res.ok) {
        showToast(tt("wf.8a7bae", { p0: await res.text() }));
        return;
      }
      const exported = (await res.json()) as ExportedWorkflow;
      const importRes = await apiFetch("/api/v1/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exported),
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

  // Kapitel 12 Teil 3 (§12.3d): liest die vom Nutzer gewählte Datei,
  // schickt sie unverändert an POST /api/v1/workflows/import — die
  // eigentliche Validierung (Katalog-Abgleich, Namenskollision) macht
  // der Orchestrator (workflows.Service.Import).
  async #importWorkflowFile(file: File) {
    let exported: ExportedWorkflow;
    try {
      exported = JSON.parse(await file.text());
    } catch (err) {
      showToast(tt("wf.e7dba3", { p0: err }));
      return;
    }
    try {
      const res = await apiFetch("/api/v1/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exported),
      });
      if (!res.ok) {
        showToast(tt("wf.6cdb17", { p0: await res.text() }));
        return;
      }
      const created = (await res.json()) as Workflow;
      showToast(tt("wf.db21f2", { p0: created.name }));
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
    if (this.#filterStatus && wf.status !== this.#filterStatus) return false;
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

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-3);";
    const headingTitle = document.createElement("span");
    headingTitle.className = "omp-h1";
    headingTitle.textContent = tt("wf.8a9663", { p0: this.#workflows.length });
    heading.appendChild(headingTitle);
    // Nutzerauftrag 2026-09-02 ("Workflows nach demselben Muster"): "+ Neu"
    // öffnet jetzt das Modal (s. #renderFormModal) statt die Form inline
    // aufzuklappen — schließen läuft über #closeWorkflowForm (Modal-×,
    // Backdrop-Klick, Escape), deshalb hier immer ein frischer Start statt
    // eines Umschalt-Zustands mit "Abbrechen"-Beschriftung.
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

    // Kapitel 12 Teil 6 (§22.3 Punkt 1): grafischer Entwurf statt des
    // Text-Formulars — beide erzeugen denselben POST /api/v1/workflows,
    // reine UX-Alternative, kein zweiter Datenpfad.
    const designBtn = document.createElement("button");
    designBtn.textContent = tt("wf.881fa7");
    designBtn.style.cssText = "margin-left:6px;";
    designBtn.addEventListener("click", () => this.#openRoleDesigner(null));
    heading.appendChild(designBtn);

    // Kapitel 12 Teil 3 (§12.3d): <label> um ein verstecktes
    // <input type="file"> — Klick auf das Label öffnet nativ den
    // Datei-Dialog, kein eigener Klick-Handler nötig.
    const importLabel = document.createElement("label");
    importLabel.textContent = tt("wf.5af5fb");
    importLabel.style.cssText =
      "font-size:11px;cursor:pointer;border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:2px 6px;margin-left:6px;";
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

    // Feature-Wunsch 2026-08-13: die Backend-Unterstützung für
    // Rollenbindungen im Export existierte bereits vollständig
    // (Service.Export includeBindings-Parameter), war aber aus der UI
    // heraus nie erreichbar — #exportWorkflow() liest dieses Feld.
    const bindingsLabel = document.createElement("label");
    bindingsLabel.style.cssText = "font-size:11px;cursor:pointer;margin-left:10px;display:inline-flex;align-items:center;gap:4px;";
    bindingsLabel.title =
      tt("wf.b7d029") +
      tt("wf.196e31");
    const bindingsCheckbox = document.createElement("input");
    bindingsCheckbox.type = "checkbox";
    bindingsCheckbox.checked = this.#exportWithBindings;
    bindingsCheckbox.addEventListener("change", () => {
      this.#exportWithBindings = bindingsCheckbox.checked;
    });
    bindingsLabel.append(bindingsCheckbox, tt("wf.937351"));
    heading.appendChild(bindingsLabel);

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
    if (this.#workflows.length > 1) {
      this.appendChild(this.#renderFilterBar());
    }

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
    grid.className = "omp-card-grid";
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
    bar.style.cssText = "display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;";

    const searchWrap = document.createElement("span");
    searchWrap.className = "omp-search-wrap";
    searchWrap.style.cssText = "flex:1;min-width:160px;";
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

    const statusSelect = document.createElement("select");
    const anyStatusOpt = document.createElement("option");
    anyStatusOpt.value = "";
    anyStatusOpt.textContent = tt("wf.bcec0a");
    statusSelect.appendChild(anyStatusOpt);
    for (const value of Object.keys(STATUS_COLORS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      if (value === this.#filterStatus) opt.selected = true;
      statusSelect.appendChild(opt);
    }
    statusSelect.addEventListener("change", () => {
      this.#filterStatus = statusSelect.value;
      this.#render();
    });
    bar.appendChild(statusSelect);

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
    const row = document.createElement("div");
    row.setAttribute("data-role", "workflow-row");
    row.setAttribute("data-workflow-id", wf.id);
    row.className = "omp-card";
    // .omp-card liefert Fläche/Rahmen/Radius — nur der Status-Akzentrand
    // links bleibt hier Inline (variiert pro Workflow, keine Klasse dafür).
    row.style.cssText =
      `padding:var(--omp-space-2) var(--omp-space-3);` +
      `border-left:3px solid ${STATUS_COLORS[wf.status] ?? "var(--omp-text-dim)"};display:flex;flex-direction:column;`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:4px;";
    const title = document.createElement("span");
    title.setAttribute("data-role", "workflow-title");
    // Kachel-Titel: Definition.title (Katalog-Metadaten), leer =
    // Workflow-Name als Fallback (kein Bruch bestehender Workflows ohne
    // Metadaten).
    title.textContent = wf.definition.title || wf.name;
    title.style.fontWeight = "600";
    const status = document.createElement("span");
    status.setAttribute("data-role", "workflow-status");
    status.textContent = wf.status;
    status.className = `omp-badge ${STATUS_BADGE_CLASS[wf.status] ?? ""}`.trim();
    header.append(title, status);
    row.appendChild(header);

    // Kategorie-Icon-Platzhalter (Punkt 6/7): eine Text-Badge statt
    // eines echten Icons — bis auf Weiteres kein Icon-Katalog vorhanden.
    if (wf.definition.category) {
      const categoryBadge = document.createElement("span");
      categoryBadge.className = "omp-badge";
      categoryBadge.style.cssText = "margin-top:2px;align-self:flex-start;";
      categoryBadge.textContent = CATEGORY_LABELS[wf.definition.category] ?? wf.definition.category;
      row.appendChild(categoryBadge);
    }

    if (wf.definition.description) {
      const desc = document.createElement("div");
      desc.style.cssText =
        "font-size:var(--omp-font-size-xs);margin-top:2px;overflow:hidden;text-overflow:ellipsis;" +
        "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;";
      desc.textContent = wf.definition.description;
      row.appendChild(desc);
    }

    if (wf.definition.tags && wf.definition.tags.length > 0) {
      const tagsRow = document.createElement("div");
      tagsRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;margin-top:2px;";
      for (const tag of wf.definition.tags) {
        const pill = document.createElement("span");
        pill.style.cssText =
          "font-size:10px;color:var(--omp-text-dim);background:var(--omp-surface-raised);border-radius:8px;padding:0 6px;";
        pill.textContent = tag;
        tagsRow.appendChild(pill);
      }
      row.appendChild(tagsRow);
    }

    row.appendChild(this.#renderPlan(wf));

    // Kapitel 15: nur anzeigen, wenn tatsächlich gesetzt — die meisten
    // Workflows laufen weiterhin mit den Node-eigenen Defaults.
    const settings = wf.definition.settings;
    if (settings?.programFormat) {
      const res = document.createElement("div");
      res.style.cssText = "color:var(--omp-text-dim);font-size:11px;margin-top:2px;";
      res.textContent = settings.programFormat;
      row.appendChild(res);
    }

    // D7 Teil 2: kompakte Hinweise statt vollem Zeitplan-Text — Details
    // stehen im Formular ("Bearbeiten").
    const badges: string[] = [];
    if (settings?.confirmStop) badges.push(tt("wf.91d470"));
    if (settings?.targetLatencyFrames) badges.push(tt("wf.7b3fe9", { p0: settings.targetLatencyFrames }));
    const scheduleCount = wf.definition.schedules?.length ?? 0;
    if (scheduleCount > 0) badges.push(tt("wf.46f0b8", { p0: scheduleCount, p1: scheduleCount === 1 ? "" : "e" }));
    if (badges.length > 0) {
      const badgeRow = document.createElement("div");
      badgeRow.style.cssText = "color:var(--omp-text-dim);font-size:11px;margin-top:2px;";
      badgeRow.textContent = badges.join(" · ");
      row.appendChild(badgeRow);
    }

    if (wf.error) {
      const err = document.createElement("div");
      err.style.cssText = "color:var(--omp-error);font-size:11px;margin-top:2px;white-space:pre-wrap;";
      err.textContent = wf.error;
      row.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;";
    // "paused" startet identisch zu "stopped"/"failed" (Kapitel 12
    // Teil 3: "Resume = normaler Start").
    const canStart = wf.status === "stopped" || wf.status === "failed" || wf.status === "paused";
    const canStop = wf.status === "started" || wf.status === "failed" || wf.status === "starting";
    // Nur ein laufender Workflow lässt sich pausieren (paus­ieren eines
    // bereits gestoppten/pausierten Workflows ist bedeutungslos).
    const canPause = wf.status === "started" || wf.status === "failed" || wf.status === "starting";
    // Bearbeiten/Löschen: "stopped" und "paused" (Kapitel 12 Teil 3
    // erweitert §12.3c das ausdrücklich).
    const isIdle = wf.status === "stopped" || wf.status === "paused";

    const startBtn = document.createElement("button");
    startBtn.textContent = wf.status === "paused" ? tt("wf.527daf") : tt("wf.a6122a");
    startBtn.disabled = !canStart;
    startBtn.addEventListener("click", () => this.#startWorkflow(wf));
    actions.appendChild(startBtn);

    const stopBtn = document.createElement("button");
    stopBtn.textContent = tt("wf.11a755");
    stopBtn.disabled = !canStop;
    stopBtn.addEventListener("click", () => this.#stopWorkflow(wf));
    actions.appendChild(stopBtn);

    // Kapitel 12 Teil 3 (§12.3c).
    const pauseBtn = document.createElement("button");
    pauseBtn.textContent = tt("wf.d63f99");
    pauseBtn.disabled = !canPause;
    pauseBtn.addEventListener("click", () => this.#pauseWorkflow(wf));
    actions.appendChild(pauseBtn);

    // Kapitel 12 Teil 1 (PUT /api/v1/workflows/{id}): "stopped"/"paused"
    // (s. workflows.Service.Update) — gleiche Begründung wie beim
    // Löschen, kein Umschreiben unter laufenden Prozessen.
    const editBtn = document.createElement("button");
    editBtn.textContent = tt("wf.5ad05d");
    editBtn.disabled = !isIdle;
    editBtn.title = isIdle ? "" : tt("wf.f7bfda");
    editBtn.addEventListener("click", () => this.#editWorkflow(wf));
    actions.appendChild(editBtn);

    // Kapitel 12 Teil 6 (§22.3 Punkt 1): grafisches Bearbeiten derselben
    // Definition — gleiche Zustands-Voraussetzung wie "Bearbeiten"
    // (PUT nur in stopped/paused), reine UX-Alternative.
    const designEditBtn = document.createElement("button");
    designEditBtn.textContent = tt("wf.971a83");
    designEditBtn.disabled = !isIdle;
    designEditBtn.title = isIdle ? "" : tt("wf.f7bfda");
    designEditBtn.addEventListener("click", () => this.#openRoleDesigner(wf.id));
    actions.appendChild(designEditBtn);

    // UX-Überarbeitung 2026-09-07 (Nutzerauftrag "das UI für das
    // Workflow bearbeiten... ist noch absolut nicht intuitiv"): bis
    // hierhin gab es DREI Wege, dieselbe Rollen-/Verbindungs-Definition
    // eines idle Workflows zu bearbeiten — dieses "Im Flow-Editor
    // bearbeiten" (navigierte in `enterWorkflowEditScope`, das für einen
    // idle Workflow laut eigener Doku dort NUR synthetische Rollen-
    // Platzhalter zeigt — exakt dieselbe Aufgabe wie "Grafisch
    // bearbeiten" unten, nur mit einer zweiten, unabhängig gebauten
    // Canvas-Implementierung), "Grafisch bearbeiten"
    // (`<omp-role-designer>`) und die (jetzt entfernte) Rollen-/
    // Verbindungs-Sektion im Text-Formular oben. Alle drei waren
    // `disabled = !isIdle` — identisch gegatet, kein funktionaler
    // Unterschied für den Nutzer erkennbar. Entschieden: `<omp-role-
    // designer>` bleibt der EINE Weg für die idle-Definition (zweckgebaut
    // für genau das, s. dessen eigene Moduldoku "Endausbau"), dieser
    // Button entfällt ersatzlos. `enterWorkflowEditScope`s ANDERER Zweig
    // (echte laufende Nodes eines GESTARTETEN Workflows bearbeiten) bleibt
    // unverändert über einen Doppelklick auf die Workflow-Kachel im
    // Flow-Editor selbst erreichbar — dafür gab es ohnehin nie einen
    // Knopf hier (dieser Button war laut `disabled`-Bedingung nie der
    // Weg dorthin).

    const delBtn = document.createElement("button");
    delBtn.textContent = tt("wf.1010b0");
    delBtn.className = "omp-btn-danger";
    delBtn.disabled = !isIdle;
    delBtn.title = isIdle ? "" : tt("wf.bc9ab0");
    delBtn.addEventListener("click", () => this.#deleteWorkflow(wf));
    actions.appendChild(delBtn);

    // Kapitel 12 Teil 3 (§12.3d): in jedem Zustand exportierbar (der
    // Export beschreibt die Definition, nicht den Laufzeitzustand).
    const exportBtn = document.createElement("button");
    exportBtn.textContent = tt("wf.8721fc");
    exportBtn.addEventListener("click", () => this.#exportWorkflow(wf));
    actions.appendChild(exportBtn);

    // Nutzerwunsch 2026-09-11 ("Möglichkeit, einen Workflow zu 'clonen'
    // — zweiter Regieplatz mit derselben Config"): der Export→Import-
    // Weg konnte das bereits, aber nur über Datei-Download+erneuten
    // Upload. Ein-Klick-Duplizieren (#duplicateWorkflow) verkettet
    // beide API-Aufrufe intern, ohne Datei-Umweg — in jedem Zustand
    // möglich wie Export selbst (Definition, nicht Laufzeitzustand).
    const duplicateBtn = document.createElement("button");
    duplicateBtn.textContent = tt("wf.529fdd");
    duplicateBtn.title = tt("wf.5e9890");
    duplicateBtn.addEventListener("click", () => this.#duplicateWorkflow(wf));
    actions.appendChild(duplicateBtn);

    row.appendChild(actions);
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
