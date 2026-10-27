import { fetchBuildInfo, formatFirmware, formatFirmwareLong } from "./version.ts";
import { buildLangSelect, getLang, t } from "./i18n.ts";
// Echte Anmeldung (ARCHITECTURE.md §12, UMSETZUNG.md D3 Teil 2) — löst
// den bisherigen, trivial spoofbaren Stub-Nutzer (X-OMP-Stub-User-Header,
// s. docs/decisions.md C13/D3 Teil 2) ab. Tokens sind Bearer-Tokens
// (NMOS IS-10/BCP-003-02-Transportkonvention), in localStorage gehalten.
//
// Globaler fetch()-Wrapper statt Anpassung jedes einzelnen Aufrufers:
// flow-canvas.ts/console-view.ts/ui-bundle.ts rufen `fetch(...)` an >15
// Stellen direkt auf (bare global, kein gemeinsamer API-Client). Diesen
// einen Einstiegspunkt hier zu patchen ist der mit Abstand kleinste Diff,
// der alle bestehenden Aufrufer ohne Änderung mit dem Authorization-
// Header versorgt — ausdrücklich dokumentiert, damit es nicht wie ein
// Versehen aussieht.
// Audit 2026-10-23 H1: die Sitzung trägt ein HttpOnly-Cookie (`omp_session`, vom Orchestrator beim Anmelden gesetzt) — das Token liegt nicht mehr in
// localStorage und ist für Skripte (auch die der Node-Oberflächen im selben Ursprung) unsichtbar. Das Cookie geht bei jeder Anfrage an denselben Ursprung
// automatisch mit, auch bei `<img>`, `EventSource` und `import()`; die `?access_token=`-Umwege entfallen damit.
const TOKEN_KEY = "omp-auth-token";

// Altbestand: eine vor der Umstellung gespeicherte Anmeldung wird einmalig gegen das Cookie getauscht und dann aus localStorage gelöscht.
let legacyToken: string | null = null;
try {
  legacyToken = localStorage.getItem(TOKEN_KEY);
} catch { /* Speicher gesperrt: es gibt nichts umzustellen */ }

/** Nur für Altbestand und Skripte, die ein Token als Query anhängen würden: nach der Umstellung immer `null` (das Cookie genügt). */
export function getToken(): string | null {
  return legacyToken;
}

export function clearToken() {
  legacyToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* egal */ }
}

function shouldAttachToken(url: string): boolean {
  return url.startsWith("/api/v1/");
}

const originalFetch = window.fetch.bind(window);

(function installFetchAuth() {
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : "";
    if (shouldAttachToken(url)) {
      const headers = new Headers(init?.headers);
      // Bis zur Umstellung des Altbestands (unten) noch per Header; danach trägt das Cookie die Anmeldung.
      if (legacyToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${legacyToken}`);
      // Sprache für serverseitig lokalisierte Texte (Katalog, Node-Optionen).
      headers.set("Accept-Language", getLang());
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
})();

/** Wird beim Laden einmal ausgeführt; wer die Anmeldung braucht, wartet darauf (`sessionReady`). */
export const sessionReady: Promise<void> = (async () => {
  if (!legacyToken) return;
  try {
    const res = await originalFetch("/api/v1/auth/session", { method: "POST", headers: { Authorization: `Bearer ${legacyToken}` } });
    if (res.ok) clearToken(); // Cookie ist gesetzt
    else if (res.status === 401) clearToken(); // abgelaufen: ohnehin ungültig
  } catch { /* Orchestrator kurz weg: beim nächsten Laden erneut */ }
})();

export interface WhoamiResponse {
  authRequired: boolean;
  authenticated: boolean;
  username?: string;
  // Kapitel 11 Teil 1 (docs/END-GOAL-FEATURES.md §11.4): true bei
  // admin-Verb ODER im Bootstrap-Modus (noch kein Nutzer angelegt) —
  // steuert, ob app-shell.ts den Administration-Tab zeigt.
  isAdmin?: boolean;
  // true bei global `configure` (Engineering) — Stream-Deck-Anbindung des Flow-Editors.
  canConfigure?: boolean;
}

export async function whoami(): Promise<WhoamiResponse> {
  const res = await fetch("/api/v1/auth/whoami");
  if (!res.ok) return { authRequired: false, authenticated: false };
  return (await res.json()) as WhoamiResponse;
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("invalid credentials");
  // Der Orchestrator hat das Sitzungs-Cookie gesetzt; das Token in der Antwort ist für API-Clients gedacht und wird hier nicht aufbewahrt.
}

export async function logout() {
  clearToken();
  try {
    await fetch("/api/v1/auth/logout", { method: "POST" });
  } catch { /* egal */ }
  location.reload();
}

// showLoginOverlay blendet ein minimales Anmelde-Formular über root ein
// und ruft onSuccess erst, wenn login() ohne Fehler durchläuft — root
// bleibt bis dahin unangetastet (kein Teil-Rendering der Shell dahinter).
export function showLoginOverlay(root: HTMLElement, onSuccess: () => void) {
  const overlay = document.createElement("div");
  overlay.className = "omp-login";

  // Linke Seite: Markenbotschaft im Stil des Hero-Bilds.
  const brand = document.createElement("div");
  brand.className = "omp-login-brand";
  brand.innerHTML =
    '<div class="omp-login-eyebrow">Open Media Platform</div>' +
    '<h1 class="omp-login-headline">Open <span class="c">· Modular</span><br><span class="v">· Interoperable</span></h1>' +
    '<p class="omp-login-lead">' +
    t("login.lead") + "</p>" +
    '<div class="omp-login-rule"></div>' +
    '<div class="omp-login-tag">' + t("login.tag") + "</div>" +
    '<div class="omp-login-chips">' +
    ["SDI", "ST 2110", "AES67", "MXL", "NMOS", "BPMN"].map((c) => `<span class="omp-login-chip">${c}</span>`).join("") +
    "</div>";

  const panel = document.createElement("div");
  panel.className = "omp-login-panel";

  const form = document.createElement("form");
  form.className = "omp-login-card";

  const title = document.createElement("h2");
  title.textContent = t("login.title");
  const sub = document.createElement("p");
  sub.className = "omp-login-sub";
  sub.textContent = t("login.sub");

  const userInput = document.createElement("input");
  userInput.placeholder = t("login.user");
  userInput.autocomplete = "username";
  const userLabel = document.createElement("label");
  userLabel.append(t("login.user"), userInput);

  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.placeholder = t("login.password");
  passInput.autocomplete = "current-password";
  const passLabel = document.createElement("label");
  passLabel.append(t("login.password"), passInput);

  const error = document.createElement("div");
  error.className = "omp-login-error";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = t("login.title");
  submit.className = "omp-btn-primary";

  const foot = document.createElement("div");
  foot.className = "omp-login-foot";
  foot.textContent = "OpenMediaPlatform";
  // Firmware-Version aus dem öffentlichen Versions-Endpunkt (auch ohne Anmeldung lesbar).
  const firmware = document.createElement("div");
  firmware.className = "omp-login-firmware";
  void fetchBuildInfo().then((info) => {
    firmware.textContent = formatFirmware(info);
    firmware.title = formatFirmwareLong(info);
  });

  const langRow = document.createElement("div");
  langRow.style.cssText = "display:flex;justify-content:flex-end;";
  langRow.appendChild(buildLangSelect());
  form.append(title, sub, userLabel, passLabel, error, submit, foot, firmware, langRow);
  panel.append(form);
  overlay.append(brand, panel);
  root.replaceChildren(overlay);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      await login(userInput.value.trim(), passInput.value);
      onSuccess();
    } catch {
      error.textContent = t("login.failed");
    } finally {
      submit.disabled = false;
    }
  });

  userInput.focus();
}

const USER_WIDGET_GAP_PX = 6;

// buildUserWidget zeigt den angemeldeten Nutzer + Abmelden-Button — nur
// aufgerufen, wenn authRequired true ist (s. shell.ts), damit der
// Bootstrap-/Dev-Modus ohne angelegte Nutzer optisch unverändert bleibt.
//
// Nutzerreport 2026-09-24: überlappte die globale Alarmleiste
// (<omp-alert-bar>, alert-bar.ts) — beide sitzen unabhängig voneinander
// in der unteren rechten Bildschirmecke (Widget `position:fixed`,
// Alarmleiste ein normaler, aber dynamisch ein-/ausblendender
// Footer-Block in der App-Shell). Bewusst KEINE feste Kopplung
// zwischen den beiden Dateien (auth.ts wird auch von console-view.ts/
// console-board.ts genutzt, die gar keine Alarmleiste haben) — stattdessen
// beobachtet dieses Widget per ResizeObserver die tatsächliche Höhe
// eines evtl. vorhandenen <omp-alert-bar>-Elements und weicht ihr
// automatisch nach oben aus, egal ob/wann sie sich ein-/ausblendet.
// homeHref (Nutzerwunsch 2026-09-24: "wenn ein Operator mehrere
// Workflows/Prozesse bedienen darf, muss er ... einen Home-Button
// haben, um wieder dorthin zu navigieren" — "dorthin" = die
// Workflow-Auswahl aus Kapitel 12 Teil 5, s. shell.ts#renderWorkflowPicker.
// Bewusst "Workflow" statt "Regieplatz" in Label/Tooltip — Nutzerfund
// 2026-09-24: "es sind nicht immer Regieplätze", der Begriff passt nur
// für Live-Schaltplätze, nicht für jeden Operator-Anwendungsfall):
// nur gesetzt, wenn shell.ts ermittelt hat, dass für DIESEN Nutzer
// gerade eine Workflow-Auswahl existiert, zu der es sich lohnt
// zurückzuspringen (reiner Operator, >1 zugewiesener Workflow, aktuell
// innerhalb einer einzelnen Konsole) — ein Admin/Engineering-Nutzer
// oder ein Operator mit nur einem Workflow bekommt keinen Button ohne
// Ziel. Echte `<a>`-Navigation statt SPA-Routing (gleiches Muster wie
// die Kacheln selbst, s. renderWorkflowPicker-Doku: der Orchestrator
// liefert index.html für "/" ohnehin aus).
export function buildUserWidget(username: string, homeHref?: string, workstation = false): HTMLElement {
  const widget = document.createElement("div");
  widget.dataset.ompUserWidget = "1";
  widget.style.cssText =
    "position:fixed;bottom:var(--omp-space-2);right:var(--omp-space-2);z-index:1000;" +
    "font-family:var(--omp-font);font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);" +
    "background:var(--omp-surface);padding:var(--omp-space-1) var(--omp-space-2);" +
    "border-radius:var(--omp-radius);border:1px solid var(--omp-border);" +
    "display:flex;gap:var(--omp-space-2);align-items:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);" +
    "transition:bottom 0.15s ease;";
  const label = document.createElement("span");
  label.textContent = t("auth.loggedInAs", { user: username });
  widget.appendChild(label);

  if (homeHref) {
    const homeLink = document.createElement("a");
    homeLink.href = homeHref;
    homeLink.textContent = t(workstation ? "auth.home" : "auth.switchWorkflow");
    homeLink.title = t(workstation ? "auth.homeTitle" : "auth.switchWorkflowTitle");
    homeLink.dataset.role = "home-link";
    homeLink.style.cssText =
      "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);text-decoration:none;" +
      "color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);";
    widget.appendChild(homeLink);
  }

  const logoutButton = document.createElement("button");
  logoutButton.textContent = t("auth.logout");
  logoutButton.style.cssText = "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);";
  logoutButton.addEventListener("click", logout);
  widget.appendChild(logoutButton);
  widget.appendChild(buildLangSelect());

  const alertBar = document.querySelector("omp-alert-bar");
  if (alertBar) {
    const observer = new ResizeObserver(([entry]) => {
      const barHeight = entry.contentRect.height;
      widget.style.bottom =
        barHeight > 0 ? `calc(var(--omp-space-2) + ${barHeight + USER_WIDGET_GAP_PX}px)` : "var(--omp-space-2)";
    });
    observer.observe(alertBar);
  }

  return widget;
}
