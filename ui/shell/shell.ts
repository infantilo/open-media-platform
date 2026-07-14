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
import "../graph/flow-canvas.ts";
// Getrennter Seiteneffekt-Import nötig: `ConsoleView` wird unten nur in
// Typposition (`as ConsoleView`) verwendet — ein reiner Werte+Typ-Import
// würde vom Bundler als "nur Typ gebraucht" wegoptimiert und damit auch
// das `customElements.define(...)` in console-view.ts stillschweigend
// entfernen (per Browser-Test gefunden: `view.setEntries is not a
// function`, weil das Custom Element nie registriert wurde).
import "./console-view.ts";
import type { ConsoleView, ConsoleEntry } from "./console-view.ts";
import { whoami, showLoginOverlay, buildUserWidget } from "./auth.ts";
// Reiner Seiteneffekt-Import (registriert nur customElements.define) —
// hier unproblematisch, da shell.ts keine benannten Bindings daraus
// braucht (anders als beim console-view.ts-Fall oben).
import "./hosts-view.ts";
// Reiner Seiteneffekt-Import, gleicher Grund wie bei hosts-view.ts oben.
import "./workflows-view.ts";

const KIOSK_ROUTE = /^\/console\/([^/]+)\/([^/]+)$/;

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

// buildHostsToggle blendet ein <omp-hosts-view>-Panel (ARCHITECTURE.md
// §18.7) per Knopf ein/aus — nur in der Engineering-Ansicht sichtbar,
// Host-Verwaltung ist kein Operator-Konsolen-Anliegen (§14).
function buildHostsToggle(): HTMLElement {
  const button = document.createElement("button");
  button.textContent = "Hosts";
  button.style.cssText =
    "position:fixed;bottom:6px;left:6px;z-index:1000;font-size:11px;padding:4px 8px;cursor:pointer;";

  let panel: HTMLElement | null = null;
  button.addEventListener("click", () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = document.createElement("omp-hosts-view");
    panel.style.cssText = "position:fixed;bottom:32px;left:6px;z-index:1000;";
    document.body.appendChild(panel);
  });
  return button;
}

// buildWorkflowsToggle blendet ein <omp-workflows-view>-Panel
// (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1) per Knopf ein/aus —
// gleiches Muster wie buildHostsToggle, nur in der Engineering-Ansicht
// sichtbar (Workflow-Verwaltung ist kein Operator-Konsolen-Anliegen,
// §14 — ein laufender Workflow zeigt sich Operator:innen indirekt über
// die dadurch erscheinenden Node-Kacheln/Konsolen, nicht über dieses
// Panel selbst).
function buildWorkflowsToggle(): HTMLElement {
  const button = document.createElement("button");
  button.textContent = "Workflows";
  button.style.cssText =
    "position:fixed;bottom:6px;left:70px;z-index:1000;font-size:11px;padding:4px 8px;cursor:pointer;";

  let panel: HTMLElement | null = null;
  button.addEventListener("click", () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = document.createElement("omp-workflows-view");
    panel.style.cssText = "position:fixed;bottom:32px;left:70px;z-index:1000;";
    document.body.appendChild(panel);
  });
  return button;
}

async function renderShell(root: HTMLElement, username: string | null) {
  const kioskMatch = KIOSK_ROUTE.exec(location.pathname);
  const { hasEngineeringAccess, consoles } = await fetchConsoles();

  if (kioskMatch) {
    const [, , nodeRoleId] = kioskMatch;
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(consoles.filter((c) => c.nodeRoleId === nodeRoleId), nodeRoleId);
  } else if (hasEngineeringAccess || consoles.length === 0) {
    // Kein Rollenbindungs-Treffer überhaupt (typischerweise: noch keine
    // Rollenbindungen angelegt) fällt bewusst auf Engineering zurück —
    // das vor C13 einzig existierende Verhalten bleibt der Default,
    // solange niemand Rollenbindungen konfiguriert hat.
    root.replaceChildren(document.createElement("omp-flow-canvas"));
    document.body.appendChild(buildHostsToggle());
    document.body.appendChild(buildWorkflowsToggle());
  } else {
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(consoles);
  }

  if (username) {
    document.body.appendChild(buildUserWidget(username));
  }
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
