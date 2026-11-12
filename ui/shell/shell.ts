// Bootstrap der OMP-Shell (ARCHITECTURE.md §4.5/§14, UMSETZUNG.md C13):
// entscheidet zwischen Engineering-Ansicht (<omp-flow-canvas>, voller
// Graph) und Console-Ansicht (<omp-console-view>, nur die zugewiesene(n)
// Node-Rolle(n)) anhand der für den angemeldeten Nutzer aufgelösten
// Rollenbindungen (`GET /api/v1/me/consoles`). Kiosk-Route
// `/console/<workflowId>/<nodeRoleId>` (§14: "direkt verlinkbar/
// bookmarkbar") springt direkt auf eine einzelne Konsole.
//
// Echte Anmeldung (UMSETZUNG.md D3 Teil 2, s. ./auth.ts) löst den
// bisherigen, trivial spoofbaren Stub-Nutzer-Header ab (docs/decisions.md
// C13/D3 Teil 2). Solange kein Nutzer im System existiert (Bootstrap-
// Modus, s. authGate im Orchestrator), liefert whoami() authRequired
// false — die Shell verhält sich dann exakt wie vor D3 Teil 2 (kein
// Login-Screen, immer Engineering-Ansicht als Default).
// Getrennter Seiteneffekt-Import nötig: `ConsoleView` wird unten nur in
// Typposition (`as ConsoleView`) verwendet — ein reiner Werte+Typ-Import
// würde vom Bundler als "nur Typ gebraucht" wegoptimiert und damit auch
// das `customElements.define(...)` in console-view.ts stillschweigend
// entfernen (per Browser-Test gefunden: `view.setEntries is not a
// function`, weil das Custom Element nie registriert wurde).
import "./touch-guard.ts"; // Berührungsschutz (Kontextmenü auf Tasten) vor allen Elementen installieren
import { t } from "./i18n.ts";
import { installToastCodes } from "./errorcodes.ts";
import "./upcoming.ts";
import "./console-view.ts";
import type { ConsoleView, ConsoleEntry } from "./console-view.ts";
// Gleicher Grund wie beim console-view.ts-Import oben (sonst optimiert der
// Bundler das customElements.define(...) in console-board.ts weg).
import "./console-board.ts";
import "./channel-desk.ts";
// Test-/Simulator-Seite Stream Deck (Kap. 40.2); Seiteneffekt-Import wie oben.
import "./streamdeck/sim.ts";
import type { ConsoleBoard } from "./console-board.ts";
import type { ChannelDesk } from "./channel-desk.ts";
import { whoami, showLoginOverlay, buildUserWidget, redeemSupportLink } from "./auth.ts";
import { attachTaskBadge, landingButton, landingCard, landingGrid, loadWorkTiles, renderLanding, renderTileView } from "./operator-home.ts";
import type { OperatorHome } from "./operator-home.ts";
import type { WorkTile } from "./modules-logic.ts";
import { installListenService } from "./listen.ts";
import { createDeckToggle } from "./streamdeck/panel.ts";
import { createMidiToggle } from "./midi/panel.ts";
import { connectionMonitor } from "./connection.ts";
// Reiner Seiteneffekt-Import (registriert nur customElements.define) —
// gleicher Grund wie beim console-view.ts-Fall oben. app-shell.ts
// importiert seinerseits flow-canvas.ts/hosts-view.ts/workflows-view.ts
// (UMSETZUNG.md K1-Teil-1: App-Bar mit Tabs statt Floating-Panels).
import "./app-shell.ts";
// ui/kit-Bausteine (ARCHITECTURE.md §22.2) einmal global registrieren —
// s. ui/kit/index.ts für die Begründung (Node-UI-Bundles nutzen sie
// danach ohne eigenen Import).
import "../kit/index.ts";

const KIOSK_ROUTE = /^\/console\/([^/]+)\/([^/]+)$/;
// Kapitel 12 Teil 5 (docs/END-GOAL-FEATURES.md §12.3f): die
// Mehr-Rollen-Konsolen-Route eines Workflows, ohne feste Rolle (anders
// als KIOSK_ROUTE) — "alle operate-Rollen dieses Nutzers in diesem
// Workflow als Tab-Leiste". Muss NACH KIOSK_ROUTE geprüft werden (s.
// renderShell), sonst würde .../<workflowId>/<nodeRoleId> hier schon
// (falsch) matchen.
const WORKFLOW_CONSOLE_ROUTE = /^\/console\/([^/]+)$/;

interface ConsolesResponse {
  hasEngineeringAccess: boolean;
  // hasOperateBindings (Bugfix 2026-07-27): unabhängig von consoles —
  // true, sobald der Nutzer IRGENDEINE operate-Bindung besitzt, auch
  // wenn gerade nichts läuft, das dazu passt. consoles selbst enthält
  // nur die aktuell LAUFENDE Teilmenge (orchestrator/internal/consoles/
  // resolve.go) — ohne dieses Signal ließe sich "hat Bindungen, aber
  // gerade läuft nichts" nicht von "hat gar keine Bindungen" unterscheiden,
  // beides ergab bislang identisch consoles.length===0 und fiel deshalb
  // fälschlich auf die volle Engineering-Ansicht zurück (Nutzerfund:
  // operator1 landete mit scheinbar vollem Zugriff im Flow-Editor).
  hasOperateBindings: boolean;
  consoles: ConsoleEntry[];
}

// Kapitel 13 Teil 4 (Nutzerfund 2026-08-13: "im Regieplatz expandiert ist
// nicht ersichtlich, welcher Node wo gehostet ist"): reiner Client-Join,
// gleiches Muster wie ui/graph/flow-canvas.ts §13.1 ("graph.instanceId →
// instances.hostId → hosts.label ist reine Client-Arbeit, kein neuer
// Endpunkt nötig") — GET /api/v1/instances und /api/v1/hosts sind beide
// nur hinter requireAuth (kein Konfigurations-/Admin-Recht nötig, s.
// orchestrator/internal/httpapi/server.go), ein reiner Operator (der
// einzige Aufrufer dieses Codepfads) kann beide also lesen.
// `nodeRoleId` einer ConsoleEntry IST die Launcher-Instanz-ID
// (orchestrator/internal/consoles/resolve.go NodeRoleID), identisch zum
// `id`-Feld von GET /api/v1/instances.
interface InstanceEntry {
  id: string;
  hostId?: string;
}
interface HostEntry {
  id: string;
  label: string;
}

async function fetchHostLabelsByInstanceId(): Promise<Map<string, string>> {
  const byInstance = new Map<string, string>();
  try {
    const [instancesRes, hostsRes] = await Promise.all([
      fetch("/api/v1/instances"),
      fetch("/api/v1/hosts"),
    ]);
    if (!instancesRes.ok || !hostsRes.ok) return byInstance;
    const instances = (await instancesRes.json()) as InstanceEntry[] | null;
    const hosts = (await hostsRes.json()) as HostEntry[] | null;
    const hostLabelById = new Map((hosts ?? []).map((h) => [h.id, h.label]));
    for (const inst of instances ?? []) {
      byInstance.set(inst.id, inst.hostId ? hostLabelById.get(inst.hostId) ?? inst.hostId : t("op.hostLocal"));
    }
  } catch {
    // Best effort — eine fehlgeschlagene Anreicherung lässt die Konsole
    // selbst unberührt, es fehlt dann nur die Host-Anzeige (s.
    // ConsoleEntry.hostLabel-Doku), kein Grund den ganzen Refresh
    // abzubrechen.
  }
  return byInstance;
}

async function fetchConsoles(): Promise<ConsolesResponse> {
  const res = await fetch("/api/v1/me/consoles");
  // Kein erreichbarer Orchestrator/Fehler: auf die vor C13 einzig
  // existierende Ansicht zurückfallen, statt eine leere Seite zu zeigen.
  if (!res.ok) return { hasEngineeringAccess: true, hasOperateBindings: false, consoles: [] };
  const body = (await res.json()) as ConsolesResponse;
  // Gos `[]ConsoleEntry` serialisiert als JSON `null`, wenn der Slice nie
  // befüllt wurde (kein Treffer für den Nutzer, z. B. weil noch keine
  // Rollenbindungen existieren) — hier einmalig auf `[]` normalisiert,
  // statt an jeder Verwendungsstelle unten gegen `null` absichern zu
  // müssen (per Browser-Test gefunden: "Cannot read properties of null
  // (reading 'length')").
  const consoles = body.consoles ?? [];
  if (consoles.length > 0) {
    const hostLabelByInstance = await fetchHostLabelsByInstanceId();
    for (const entry of consoles) {
      entry.hostLabel = hostLabelByInstance.get(entry.nodeRoleId);
    }
  }
  return {
    hasEngineeringAccess: body.hasEngineeringAccess,
    hasOperateBindings: body.hasOperateBindings,
    consoles,
  };
}

// §7.6-Ergänzung (docs/END-GOAL-FEATURES.md, 2026-07-17: "Operator-UI
// muss der Übernahme unmerklich folgen"): eine bereits offene Kiosk-
// Konsole hielt vor diesem Schritt für immer die beim Seitenaufbau
// aufgelöste `uiBundleUrl` — nach einem Prozess-Neustart (K7-Teil-1,
// gleiche Rollen-/Instanz-ID, aber neue NMOS-Node-ID) zeigte sie
// unbemerkt weiter auf den toten alten Node, bis jemand von Hand neu
// lud. watchConsoleEntries() löst `/api/v1/me/consoles` deshalb erneut
// auf, sobald sich das Node-Inventar ändert (SSE) bzw. spätestens alle
// 30s (Poll-Fallback, falls SSE gerade "degraded"/"disconnected" ist) —
// dieselbe SSE-first-mit-Poll-Fallback-Kadenz wie hosts-view.ts/
// alarm-view.ts. `console-view.ts#setEntries` selbst erkennt eine
// geänderte `uiBundleUrl` für die aktive Rolle und remountet nur dann
// (kein sichtbarer Effekt bei einem Refresh ohne echte Änderung).
// Bewusst NICHT Teil dieses Schritts: ein Wechsel des ganzen
// Ansicht-Modus (Engineering↔Console, Ein-↔Mehr-Workflow-Auswahl) durch
// geänderte Rollenbindungen selbst — das behandelt §7.6 nicht, hier
// geht es nur um "dieselbe schon offene Konsolen-Rolle folgt einem
// Prozesswechsel", nicht um Autorisierungsänderungen mitten in der
// Sitzung.
const CONSOLE_REFRESH_EVENT_TYPES = new Set(["node.added", "node.removed", "lost-events"]);
const CONSOLE_POLL_FALLBACK_INTERVAL_MS = 30000;

// Gemeinsames Interface für <omp-console-view> (Tab-Leiste, ein aktiver
// Eintrag) und <omp-console-board> (Kachel-Board, Kapitel 12 Teil 5
// Ergänzung 2026-07-22: alle Einträge gleichzeitig sichtbar) — beide werden
// von watchConsoleEntries() identisch aktualisiert. `preselectNodeRoleId`
// ergibt für das Board keinen Sinn (nichts ist dort "aktiv"), wird von
// dessen setEntries() einfach ignoriert.
interface ConsoleHost {
  setEntries(entries: ConsoleEntry[], preselectNodeRoleId?: string): void | Promise<void>;
}

// Wählt die passende Konsolen-Darstellung: bei genau einem Eintrag die
// bisherige Vollbild-Ansicht (kein unnötiges Kachel-Chrome für ein
// einzelnes Panel), bei mehreren das Kachel-Board — echter Live-Betrieb
// braucht mehrere Instrumente gleichzeitig im Blick, nicht nacheinander
// weggetabbt (Nutzerwunsch 2026-07-22, docs/decisions.md Nachtrag 77).
function createConsoleHost(entries: ConsoleEntry[], workflowId: string): ConsoleView | ConsoleBoard {
  if (entries.length > 1) {
    const board = document.createElement("omp-console-board") as ConsoleBoard;
    board.setWorkflowId(workflowId);
    return board;
  }
  return document.createElement("omp-console-view") as ConsoleView;
}

// Kapitel 96: Betreut ein Operator mehrere Playout-Channels, gibt es neben der Konsolen-Ansicht die Mehrkanal-
// Übersicht (Kacheln mit Zeitleiste, Gruppen-Start, schneller Wechsel). Der Umschalter erscheint nur dann; die
// Wahl bleibt im Browser. Beide Ansichten bekommen dieselbe, live nachgeführte Konsolen-Liste.
const DESK_PREF_KEY = "omp-console-desk";
function withChannelDesk(host: ConsoleHost & HTMLElement): ConsoleHost {
  const desk = document.createElement("omp-channel-desk") as ChannelDesk;
  const toggle = document.createElement("button");
  toggle.dataset.role = "desk-toggle";
  toggle.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:50;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4)";
  let on = false;
  try { on = localStorage.getItem(DESK_PREF_KEY) === "1"; } catch { /* Standard: Konsolen */ }
  const apply = () => {
    const usable = desk.channelCount > 1;
    const showDesk = usable && on;
    host.style.display = showDesk ? "none" : "";
    desk.style.display = showDesk ? "" : "none";
    toggle.style.display = usable ? "" : "none";
    toggle.textContent = showDesk ? t("mc.toggle.consoles") : t("mc.toggle.desk");
  };
  toggle.addEventListener("click", () => {
    on = !on;
    try { localStorage.setItem(DESK_PREF_KEY, on ? "1" : "0"); } catch { /* egal */ }
    apply();
  });
  host.after(desk, toggle);
  desk.style.display = "none";
  return {
    async setEntries(entries, preselect) {
      await host.setEntries(entries, preselect);
      await desk.setEntries(entries);
      apply();
    },
  };
}

function watchConsoleEntries(
  view: ConsoleHost,
  selectEntries: (consoles: ConsoleEntry[]) => ConsoleEntry[],
  preselectNodeRoleId?: string,
) {
  const refresh = async () => {
    const { consoles } = await fetchConsoles();
    await view.setEntries(selectEntries(consoles), preselectNodeRoleId);
  };

  connectionMonitor.addEventListener("sse-message", (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (CONSOLE_REFRESH_EVENT_TYPES.has(parsed.type)) void refresh();
  });
  // Kein disconnectedCallback-Äquivalent nötig: die Kiosk-Route ist kein
  // SPA-Router-Ziel (jeder Routenwechsel ist ein echter Seitenwechsel,
  // s. Datei-Kommentar oben zu spaFallback) — Listener/Intervall leben
  // ohnehin nur so lange wie die Seite selbst.
  window.setInterval(() => void refresh(), CONSOLE_POLL_FALLBACK_INTERVAL_MS);
}

interface ShellContext {
  homeHref?: string;
  /** Arbeitsplatz-Modus (Kapitel 44): Home-Knopf heißt „Arbeitsplatz“, das Widget zeigt das Aufgaben-Badge. */
  workstation: boolean;
  tiles: WorkTile[];
}

// Benutzer-Widget unten rechts samt Stream-Deck-Knopf. Gemeinsam für den normalen Start und den Login ohne Reload —
// sonst fehlte der Knopf nach dem Login (dort wurde das Widget früher ohne ihn gebaut).
function mountUserWidget(root: HTMLElement, username: string, homeHref: string | undefined, workstation: boolean, tiles: Parameters<typeof attachTaskBadge>[1]) {
  const widget = buildUserWidget(username, homeHref, workstation);
  attachTaskBadge(widget, tiles);
  // Die Engineering-Ansicht (omp-app-shell) hat den Stream-Deck-Knopf in der App-Leiste; reine
  // Operator-Ansichten haben keine App-Leiste, dort sitzt er im Benutzer-Widget.
  if (!root.querySelector("omp-app-shell")) {
    const deck = createDeckToggle(
      "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);border:1px solid var(--omp-border);" +
        "border-radius:var(--omp-radius);background:var(--omp-surface-raised);color:var(--omp-text);cursor:pointer;",
    );
    deck.button.setAttribute("data-role", "deck-toggle");
    widget.insertBefore(deck.button, widget.firstChild);
    document.body.appendChild(deck.panel);
    const midi = createMidiToggle(deck.button.style.cssText);
    midi.button.setAttribute("data-role", "midi-toggle");
    widget.insertBefore(midi.button, deck.button.nextSibling);
    document.body.appendChild(midi.panel);
  }
  document.body.appendChild(widget);
}

async function renderShell(root: HTMLElement, username: string | null): Promise<ShellContext> {
  const kioskMatch = KIOSK_ROUTE.exec(location.pathname);
  const workflowMatch = kioskMatch ? null : WORKFLOW_CONSOLE_ROUTE.exec(location.pathname);
  const { hasEngineeringAccess, hasOperateBindings, consoles } = await fetchConsoles();
  // Nutzerwunsch 2026-09-24 ("Home-Button ... um wieder dorthin zu
  // navigieren"): "dorthin" ist renderWorkflowPicker unten — die gibt es
  // nur für einen reinen Operator mit >1 zugewiesenem Workflow.
  // workflowIds hier hochgezogen (statt nur lokal im else-Zweig unten,
  // wie vor diesem Schritt), weil auch die Kiosk-Route (/console/<wf>/
  // <role>) wissen muss, ob ein Zurück-Ziel existiert.
  const workflowIds = [...new Set(consoles.map((c) => c.workflowId))];
  let homeHref: string | undefined;
  // Kapitel 44: Arbeitsplatz-Kacheln (Aufnahmen, Eingang/QC …) für Personen ohne Engineering-Zugang, die dafür
  // Funktionsrechte haben. Engineering-Nutzer haben dieselben Ansichten als Tabs in der App-Leiste.
  // Ein vorübergehend fehlgeschlagenes Laden der Kacheln darf NIE still zum Flow-Editor führen (Nutzerfund 2026-10-28:
  // Klick auf eine Aufgabe landete im Editor): erst mehrfach versuchen, dann Fehlerseite mit „Erneut versuchen“.
  let tiles: WorkTile[] = [];
  let tilesFailed = false;
  if (!hasEngineeringAccess) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        tiles = await loadWorkTiles();
        tilesFailed = false;
        break;
      } catch {
        tilesFailed = true;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  const workstation = tiles.length > 0;
  const tileId = new URLSearchParams(location.search).get("tile");
  const activeTile = tileId ? tiles.find((x) => x.id === tileId) : undefined;

  if (tilesFailed && !kioskMatch && !workflowMatch) {
    renderTilesUnavailable(root);
  } else if (kioskMatch) {
    const [, , nodeRoleId] = kioskMatch;
    const selectEntries = (cs: ConsoleEntry[]) => cs.filter((c) => c.nodeRoleId === nodeRoleId);
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(selectEntries(consoles), nodeRoleId);
    watchConsoleEntries(view, selectEntries, nodeRoleId);
    if (workflowIds.length > 1 || workstation) homeHref = "/";
  } else if (workstation && !workflowMatch) {
    if (activeTile) {
      await renderTileView(root, activeTile, new URLSearchParams(location.search).get("ref"));
    } else {
      const home = document.createElement("omp-operator-home") as OperatorHome;
      root.replaceChildren(home);
      home.setup(consoles, tiles);
    }
    homeHref = activeTile ? "/" : undefined;
  } else if (hasEngineeringAccess || (!hasOperateBindings && consoles.length === 0)) {
    // Kein Rollenbindungs-Treffer überhaupt (typischerweise: noch keine
    // Rollenbindungen angelegt) fällt bewusst auf Engineering zurück —
    // das vor C13 einzig existierende Verhalten bleibt der Default,
    // solange niemand Rollenbindungen konfiguriert hat. Seit K1-Teil-1
    // ist die Engineering-Ansicht die App-Bar-Shell (Tabs Flow-Editor/
    // Workflows/Hosts) statt des nackten <omp-flow-canvas> + zwei
    // Floating-Toggle-Buttons. Bugfix 2026-07-27: `hasOperateBindings`
    // grenzt das jetzt sauber von "hat echte operate-Bindungen, aber
    // gerade läuft nichts" ab (s. u.) — vorher fielen beide Fälle
    // identisch hierher, ein reiner Operator landete dadurch mit
    // scheinbar vollem Zugriff im Flow-Editor, sobald sein zugewiesener
    // Workflow gerade gestoppt war.
    root.replaceChildren(document.createElement("omp-app-shell"));
  } else if (consoles.length === 0) {
    // Bugfix 2026-07-27: reiner Operator MIT echten Bindungen, aber
    // aktuell läuft keine davon — weder Engineering (er hat dafür keine
    // Rechte) noch die Workflow-Auswahl (die hätte nichts zum Auflisten)
    // sind hier richtig. Eigener, expliziter Leerzustand statt eines der
    // beiden falschen Rückfälle.
    renderNoActiveConsole(root);
  } else {
    // Kapitel 12 Teil 5 (docs/END-GOAL-FEATURES.md §12.3f): reiner
    // Operator (kein configure/admin) — "landet nach dem Login auf
    // einer Workflow-Auswahl … nach Auswahl auf /console/<workflowId>:
    // alle operate-Rollen dieses Nutzers in diesem Workflow als
    // Tab-Leiste". Filterung rein clientseitig (§12 Punkt 3: die
    // Durchsetzung selbst ist längst im Orchestrator passiert —
    // `consoles` enthält ohnehin nur bereits autorisierte Einträge).
    const scoped = workflowMatch ? consoles.filter((c) => c.workflowId === workflowMatch[1]) : [];

    if (workflowMatch && scoped.length > 0) {
      const selectEntries = (cs: ConsoleEntry[]) => cs.filter((c) => c.workflowId === workflowMatch[1]);
      const host = createConsoleHost(scoped, workflowMatch[1]);
      root.replaceChildren(host);
      const both = withChannelDesk(host);
      await both.setEntries(selectEntries(consoles));
      watchConsoleEntries(both, selectEntries);
      if (workflowIds.length > 1 || workstation) homeHref = "/";
    } else if (workflowIds.length <= 1) {
      // Genau ein (oder gar kein) Workflow unter den zugewiesenen
      // Rollen — die Auswahl-Kachel wäre ein unnötiger Umweg zu genau
      // einem Ziel, direkt hinein (Bookmark-fähige
      // /console/<workflowId>-Route bleibt trotzdem gültig, falls sich
      // das später ändert).
      const host = createConsoleHost(consoles, workflowIds[0]);
      root.replaceChildren(host);
      const both = withChannelDesk(host);
      await both.setEntries(consoles);
      watchConsoleEntries(both, (cs) => cs);
    } else {
      // §12.5 offene Frage 5 ("Kachel-Auswahl nach jedem Login (Vorschlag)
      // oder automatisch der zuletzt benutzte Workflow mit Umschalter?"):
      // Vorschlag umgesetzt — Kachel-Auswahl bei jedem Einstieg mit
      // mehreren zugewiesenen Workflows, kein Persistieren einer
      // zuletzt genutzten Wahl.
      renderWorkflowPicker(root, consoles, workflowIds);
    }
  }

  if (username) mountUserWidget(root, username, homeHref, workstation, tiles);
  return { homeHref, workstation, tiles };
}

// Bugfix 2026-07-27: eigener Leerzustand für einen reinen Operator mit
// echten Bindungen, dessen zugewiesene(r) Workflow(s) aktuell nicht
// laufen — weder Engineering noch Workflow-Auswahl passen hier (s.
// renderShell). Kein Live-Refresh (bewusst dasselbe, bereits
// bestehende Muster wie renderWorkflowPicker direkt darunter — auch
// die Workflow-Auswahl aktualisiert sich nicht selbst, falls währenddessen
// ein weiterer Workflow startet; ein manueller Neu-laden-Knopf reicht,
// symmetrisch zum Nachbar-Screen statt eines Alleingangs nur hier).
function renderTilesUnavailable(root: HTMLElement) {
  const retry = document.createElement("a");
  retry.href = location.href;
  retry.textContent = t("op.tiles.retry");
  retry.className = "oh-btn";
  const center = renderLanding(root, { title: t("op.home.title"), icon: "⚠", body: [retry] });
  const msg = document.createElement("p");
  msg.textContent = t("op.tiles.unavailable");
  msg.className = "oh-text";
  msg.dataset.role = "tiles-unavailable";
  center.insertBefore(msg, retry);
}

function renderNoActiveConsole(root: HTMLElement) {
  // Countdown bis zum nächsten geplanten Start eines bedienbaren Workflows (blendet sich ohne Plan aus).
  const upcoming = document.createElement("omp-upcoming-start");
  upcoming.style.color = "var(--omp-text)";
  renderLanding(root, {
    title: t("op.noWorkflow.title"),
    text: t("op.noWorkflow.text"),
    icon: "⏳",
    body: [upcoming, landingButton(t("op.reload"), () => location.reload())],
  });
  // Sobald ein zugewiesener Workflow läuft, die Seite selbst neu laden statt auf „Neu laden“ zu warten.
  window.setInterval(async () => {
    try {
      const { consoles } = await fetchConsoles();
      if (consoles.length > 0) location.reload();
    } catch {
      // nächster Versuch in 10 s
    }
  }, 10_000);
}

// Kapitel 12 Teil 5: "Workflow-Auswahl (nur gebundene Workflows, als
// Kachel-Liste — die schmale Vorstufe des §22.3-Katalog-Grids)". Reine
// <a href>-Navigation (kein Client-Router nötig): der Orchestrator
// liefert index.html für jede /console/*-Route bereits per SPA-Fallback
// (httpapi.spaFallback), ein normaler Seitenwechsel reicht.
function renderWorkflowPicker(root: HTMLElement, consoles: ConsoleEntry[], workflowIds: string[]) {
  const grid = landingGrid();
  for (const workflowId of workflowIds) {
    const entriesForWorkflow = consoles.filter((c) => c.workflowId === workflowId);
    const label = entriesForWorkflow[0]?.workflowLabel ?? workflowId;
    grid.append(
      landingCard(`/console/${encodeURIComponent(workflowId)}`, "▣", label, entriesForWorkflow.length === 1 ? t("op.roles.one") : t("op.roles.many", { n: entriesForWorkflow.length }), true),
    );
  }
  renderLanding(root, { title: t("op.pickWorkflow"), body: [grid] });
}

// Einlösen eines Support-Links fehlgeschlagen (abgelaufen, widerrufen, falsch): kurze Meldung über der Anmeldung.
function alert_support_error(root: HTMLElement, message: string) {
  const note = document.createElement("div");
  note.setAttribute("data-role", "support-link-error");
  note.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:5000;padding:10px 16px;background:#7a2a2a;color:#fff;font:14px system-ui,sans-serif;text-align:center;";
  note.textContent = `${t("sup.access.linkFailed")}: ${message}`;
  document.body.append(note);
  setTimeout(() => note.remove(), 12000);
  void root;
}

async function boot() {
  const root = document.getElementById("shell-root");
  if (!root) return;

  // Abhör-Dienst gehört der Shell, nicht dem Panel (s. listen.ts).
  installListenService();

  // Kap. 40.2: Stream-Deck-Test/Simulator, Seite ohne Konsolen-Kontext.
  if (location.pathname === "/streamdeck-sim") {
    root.replaceChildren(document.createElement("omp-streamdeck-sim"));
    return;
  }

  // Support-Link (#support=…): vor der Anmeldeprüfung einlösen, damit der Zugang gleich gilt.
  const supportError = await redeemSupportLink();
  if (supportError) alert_support_error(root, supportError);
  const { authRequired, authenticated, username } = await whoami();
  if (!authRequired || authenticated) installToastCodes();

  if (authRequired && !authenticated) {
    showLoginOverlay(root, () => {
      installToastCodes();
      renderShell(root, null).then(({ homeHref, workstation, tiles }) => {
        // Nutzername erst nach dem Login bekannt — ein zweiter,
        // günstiger whoami()-Aufruf statt den Login-Response-Body
        // durchzureichen, hält showLoginOverlay von Shell-Kenntnis frei.
        whoami().then(({ username }) => {
          if (username) mountUserWidget(root, username, homeHref, workstation, tiles);
        });
      });
    });
    return;
  }

  await renderShell(root, authRequired ? (username ?? null) : null);
}

boot();
