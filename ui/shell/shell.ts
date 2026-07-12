// Bootstrap der OMP-Shell (ARCHITECTURE.md §4.5/§14, UMSETZUNG.md C13):
// entscheidet zwischen Engineering-Ansicht (<omp-flow-canvas>, voller
// Graph) und Console-Ansicht (<omp-console-view>, nur die zugewiesene(n)
// Node-Rolle(n)) anhand der für den (Stub-)Nutzer aufgelösten
// Rollenbindungen (`GET /api/v1/me/consoles`). Kiosk-Route
// `/console/<workflowId>/<nodeRoleId>` (§14: "direkt verlinkbar/
// bookmarkbar") springt direkt auf eine einzelne Konsole.
//
// **Stub-Nutzer statt echter Anmeldung** (D3 folgt erst später,
// `UMSETZUNG.md` C13: "vereinfachte Rollen-Stub-Prüfung ... echte
// Durchsetzung folgt mit D3"): der "aktuelle Nutzer" wird nur in
// `localStorage` gehalten und per Header an den Orchestrator geschickt —
// trivial spoofbar, reine UX-Weiche für den Browser-Test dieses
// Schritts, keine Zugriffskontrolle. Default "admin" bewahrt das vor
// C13 einzig existierende Verhalten (immer Engineering-Ansicht), solange
// keine Rollenbindungen gepflegt sind.
import "../graph/flow-canvas.ts";
// Getrennter Seiteneffekt-Import nötig: `ConsoleView` wird unten nur in
// Typposition (`as ConsoleView`) verwendet — ein reiner Werte+Typ-Import
// würde vom Bundler als "nur Typ gebraucht" wegoptimiert und damit auch
// das `customElements.define(...)` in console-view.ts stillschweigend
// entfernen (per Browser-Test gefunden: `view.setEntries is not a
// function`, weil das Custom Element nie registriert wurde).
import "./console-view.ts";
import type { ConsoleView, ConsoleEntry } from "./console-view.ts";

const STUB_USER_KEY = "omp-stub-user";
const KIOSK_ROUTE = /^\/console\/([^/]+)\/([^/]+)$/;

interface ConsolesResponse {
  hasEngineeringAccess: boolean;
  consoles: ConsoleEntry[];
}

function stubUser(): string {
  // `?user=`-Query-Param übersteuert/persistiert den Stub-Nutzer (Komfort
  // für Kiosk-Bookmarks/automatisierte Tests, gleiche Idee wie das
  // Widget unten) — sonst der zuletzt über das Widget gewählte Nutzer.
  const fromQuery = new URLSearchParams(location.search).get("user");
  if (fromQuery) {
    localStorage.setItem(STUB_USER_KEY, fromQuery);
    return fromQuery;
  }
  return localStorage.getItem(STUB_USER_KEY) || "admin";
}

function setStubUser(user: string) {
  localStorage.setItem(STUB_USER_KEY, user || "admin");
  location.reload();
}

async function fetchConsoles(): Promise<ConsolesResponse> {
  const res = await fetch("/api/v1/me/consoles", {
    headers: { "X-OMP-Stub-User": stubUser() },
  });
  // Kein erreichbarer Orchestrator/Fehler: auf die vor C13 einzig
  // existierende Ansicht zurückfallen, statt eine leere Seite zu zeigen.
  if (!res.ok) return { hasEngineeringAccess: true, consoles: [] };
  const body = (await res.json()) as ConsolesResponse;
  // Gos `[]ConsoleEntry` serialisiert als JSON `null`, wenn der Slice nie
  // befüllt wurde (kein Treffer für den Nutzer, z. B. weil noch gar
  // keine data/role-bindings.json existiert) — hier einmalig auf `[]`
  // normalisiert, statt an jeder Verwendungsstelle unten gegen `null`
  // absichern zu müssen (per Browser-Test gefunden:
  // "Cannot read properties of null (reading 'length')").
  return { hasEngineeringAccess: body.hasEngineeringAccess, consoles: body.consoles ?? [] };
}

// Kleines, rein für den Dev-/Browser-Test dieses Schritts gedachtes
// Widget zum Wechseln des Stub-Nutzers, ohne DevTools/localStorage von
// Hand zu bearbeiten (UMSETZUNG.md C13 Verifikation: "Browser-Test mit
// Test-Rollenbindung").
function buildStubUserWidget(): HTMLElement {
  const widget = document.createElement("div");
  widget.style.cssText =
    "position:fixed;bottom:6px;right:6px;z-index:1000;font-family:sans-serif;" +
    "font-size:11px;color:#999;background:#111;padding:4px 6px;border-radius:4px;" +
    "border:1px solid #333;";
  const label = document.createElement("span");
  label.textContent = "Stub-Nutzer: ";
  const input = document.createElement("input");
  input.type = "text";
  input.value = stubUser();
  input.style.cssText = "width:90px;font-size:11px;";
  input.addEventListener("change", () => setStubUser(input.value.trim()));
  widget.append(label, input);
  return widget;
}

async function boot() {
  const root = document.getElementById("shell-root");
  if (!root) return;

  const kioskMatch = KIOSK_ROUTE.exec(location.pathname);
  const { hasEngineeringAccess, consoles } = await fetchConsoles();

  if (kioskMatch) {
    const [, , nodeRoleId] = kioskMatch;
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(consoles.filter((c) => c.nodeRoleId === nodeRoleId), nodeRoleId);
  } else if (hasEngineeringAccess || consoles.length === 0) {
    // Kein Rollenbindungs-Treffer überhaupt (typischerweise: noch keine
    // data/role-bindings.json gepflegt) fällt bewusst auf Engineering
    // zurück — das vor C13 einzig existierende Verhalten bleibt der
    // Default, solange niemand Rollenbindungen konfiguriert hat.
    root.replaceChildren(document.createElement("omp-flow-canvas"));
  } else {
    const view = document.createElement("omp-console-view") as ConsoleView;
    root.replaceChildren(view);
    await view.setEntries(consoles);
  }

  document.body.appendChild(buildStubUserWidget());
}

boot();
