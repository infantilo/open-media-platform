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
    // solange niemand Rollenbindungen konfiguriert hat. Seit K1-Teil-1
    // ist die Engineering-Ansicht die App-Bar-Shell (Tabs Flow-Editor/
    // Workflows/Hosts) statt des nackten <omp-flow-canvas> + zwei
    // Floating-Toggle-Buttons.
    root.replaceChildren(document.createElement("omp-app-shell"));
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
