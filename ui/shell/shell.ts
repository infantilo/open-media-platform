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
import "./console-view.ts";
import type { ConsoleView, ConsoleEntry } from "./console-view.ts";
import { whoami, showLoginOverlay, buildUserWidget } from "./auth.ts";
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
  consoles: ConsoleEntry[];
}

async function fetchConsoles(): Promise<ConsolesResponse> {
  const res = await fetch("/api/v1/me/consoles");
  // Kein erreichbarer Orchestrator/Fehler: auf die vor C13 einzig
  // existierende Ansicht zurückfallen, statt eine leere Seite zu zeigen.
  if (!res.ok) return { hasEngineeringAccess: true, consoles: [] };
  const body = (await res.json()) as ConsolesResponse;
  // Gos `[]ConsoleEntry` serialisiert als JSON `null`, wenn der Slice nie
  // befüllt wurde (kein Treffer für den Nutzer, z. B. weil noch keine
  // Rollenbindungen existieren) — hier einmalig auf `[]` normalisiert,
  // statt an jeder Verwendungsstelle unten gegen `null` absichern zu
  // müssen (per Browser-Test gefunden: "Cannot read properties of null
  // (reading 'length')").
  return { hasEngineeringAccess: body.hasEngineeringAccess, consoles: body.consoles ?? [] };
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

function watchConsoleEntries(
  view: ConsoleView,
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

async function renderShell(root: HTMLElement, username: string | null) {
  const kioskMatch = KIOSK_ROUTE.exec(location.pathname);
  const workflowMatch = kioskMatch ? null : WORKFLOW_CONSOLE_ROUTE.exec(location.pathname);
  const { hasEngineeringAccess, consoles } = await fetchConsoles();

  if (kioskMatch) {
    const [, , nodeRoleId] = kioskMatch;
    const selectEntries = (cs: ConsoleEntry[]) => cs.filter((c) => c.nodeRoleId === nodeRoleId);
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(selectEntries(consoles), nodeRoleId);
    watchConsoleEntries(view, selectEntries, nodeRoleId);
  } else if (hasEngineeringAccess || consoles.length === 0) {
    // Kein Rollenbindungs-Treffer überhaupt (typischerweise: noch keine
    // Rollenbindungen angelegt) fällt bewusst auf Engineering zurück —
    // das vor C13 einzig existierende Verhalten bleibt der Default,
    // solange niemand Rollenbindungen konfiguriert hat. Seit K1-Teil-1
    // ist die Engineering-Ansicht die App-Bar-Shell (Tabs Flow-Editor/
    // Workflows/Hosts) statt des nackten <omp-flow-canvas> + zwei
    // Floating-Toggle-Buttons.
    root.replaceChildren(document.createElement("omp-app-shell"));
  } else {
    // Kapitel 12 Teil 5 (docs/END-GOAL-FEATURES.md §12.3f): reiner
    // Operator (kein configure/admin) — "landet nach dem Login auf
    // einer Workflow-Auswahl … nach Auswahl auf /console/<workflowId>:
    // alle operate-Rollen dieses Nutzers in diesem Workflow als
    // Tab-Leiste". Filterung rein clientseitig (§12 Punkt 3: die
    // Durchsetzung selbst ist längst im Orchestrator passiert —
    // `consoles` enthält ohnehin nur bereits autorisierte Einträge).
    const workflowIds = [...new Set(consoles.map((c) => c.workflowId))];
    const scoped = workflowMatch ? consoles.filter((c) => c.workflowId === workflowMatch[1]) : [];

    if (workflowMatch && scoped.length > 0) {
      const selectEntries = (cs: ConsoleEntry[]) => cs.filter((c) => c.workflowId === workflowMatch[1]);
      const view = document.createElement("omp-console-view") as ConsoleView;
      root.replaceChildren(view);
      await view.setEntries(selectEntries(consoles));
      watchConsoleEntries(view, selectEntries);
    } else if (workflowIds.length <= 1) {
      // Genau ein (oder gar kein) Workflow unter den zugewiesenen
      // Rollen — die Auswahl-Kachel wäre ein unnötiger Umweg zu genau
      // einem Ziel, direkt hinein (Bookmark-fähige
      // /console/<workflowId>-Route bleibt trotzdem gültig, falls sich
      // das später ändert).
      const view = document.createElement("omp-console-view") as ConsoleView;
      root.replaceChildren(view);
      await view.setEntries(consoles);
      watchConsoleEntries(view, (cs) => cs);
    } else {
      // §12.5 offene Frage 5 ("Kachel-Auswahl nach jedem Login (Vorschlag)
      // oder automatisch der zuletzt benutzte Workflow mit Umschalter?"):
      // Vorschlag umgesetzt — Kachel-Auswahl bei jedem Einstieg mit
      // mehreren zugewiesenen Workflows, kein Persistieren einer
      // zuletzt genutzten Wahl.
      renderWorkflowPicker(root, consoles, workflowIds);
    }
  }

  if (username) {
    document.body.appendChild(buildUserWidget(username));
  }
}

// Kapitel 12 Teil 5: "Workflow-Auswahl (nur gebundene Workflows, als
// Kachel-Liste — die schmale Vorstufe des §22.3-Katalog-Grids)". Reine
// <a href>-Navigation (kein Client-Router nötig): der Orchestrator
// liefert index.html für jede /console/*-Route bereits per SPA-Fallback
// (httpapi.spaFallback), ein normaler Seitenwechsel reicht.
function renderWorkflowPicker(root: HTMLElement, consoles: ConsoleEntry[], workflowIds: string[]) {
  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "width:100%;height:100%;background:#181818;color:#eee;font-family:sans-serif;gap:20px;box-sizing:border-box;padding:24px;";

  const heading = document.createElement("h1");
  heading.textContent = "Regieplatz wählen";
  heading.style.cssText = "font-size:20px;font-weight:600;margin:0;";
  container.appendChild(heading);

  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;justify-content:center;max-width:900px;";

  for (const workflowId of workflowIds) {
    const entriesForWorkflow = consoles.filter((c) => c.workflowId === workflowId);
    const label = entriesForWorkflow[0]?.workflowLabel ?? workflowId;

    const tile = document.createElement("a");
    tile.href = `/console/${encodeURIComponent(workflowId)}`;
    tile.style.cssText =
      "display:block;padding:20px 28px;border:1px solid #444;border-radius:8px;background:#232323;" +
      "color:#eee;text-decoration:none;min-width:180px;text-align:center;cursor:pointer;";

    const title = document.createElement("div");
    title.style.cssText = "font-size:16px;font-weight:600;margin-bottom:4px;";
    title.textContent = label;

    const sub = document.createElement("div");
    sub.style.cssText = "font-size:12px;color:#999;";
    sub.textContent = `${entriesForWorkflow.length} Rolle${entriesForWorkflow.length === 1 ? "" : "n"}`;

    tile.append(title, sub);
    grid.appendChild(tile);
  }
  container.appendChild(grid);
  root.replaceChildren(container);
}

async function boot() {
  const root = document.getElementById("shell-root");
  if (!root) return;

  const { authRequired, authenticated, username } = await whoami();

  if (authRequired && !authenticated) {
    showLoginOverlay(root, () => {
      renderShell(root, null).then(() => {
        // Nutzername erst nach dem Login bekannt — ein zweiter,
        // günstiger whoami()-Aufruf statt den Login-Response-Body
        // durchzureichen, hält showLoginOverlay von Shell-Kenntnis frei.
        whoami().then(({ username }) => {
          if (username) document.body.appendChild(buildUserWidget(username));
        });
      });
    });
    return;
  }

  await renderShell(root, authRequired ? (username ?? null) : null);
}

boot();
