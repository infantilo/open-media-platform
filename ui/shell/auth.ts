import { fetchBuildInfo, formatFirmware, formatFirmwareLong } from "./version.ts";
import { buildLangSelect, t } from "./i18n.ts";
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
const TOKEN_KEY = "omp-auth-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function shouldAttachToken(url: string): boolean {
  return url.startsWith("/api/v1/");
}

(function installFetchAuth() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : "";
    const token = getToken();
    if (token && shouldAttachToken(url)) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
})();

export interface WhoamiResponse {
  authRequired: boolean;
  authenticated: boolean;
  username?: string;
  // Kapitel 11 Teil 1 (docs/END-GOAL-FEATURES.md §11.4): true bei
  // admin-Verb ODER im Bootstrap-Modus (noch kein Nutzer angelegt) —
  // steuert, ob app-shell.ts den Administration-Tab zeigt.
  isAdmin?: boolean;
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
  const body = (await res.json()) as { token: string };
  setToken(body.token);
}

export function logout() {
  clearToken();
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
    '<p class="omp-login-lead">Eine offene Plattform für softwaredefinierte Medien- und ' +
    "Broadcast-Infrastrukturen – entwickelt für Interoperabilität, Flexibilität und " +
    "die Anforderungen von morgen.</p>" +
    '<div class="omp-login-rule"></div>' +
    '<div class="omp-login-tag">Standards. Technologie. Freiheit.</div>' +
    '<div class="omp-login-chips">' +
    ["SDI", "ST 2110", "AES67", "MXL", "NMOS", "BPMN"].map((c) => `<span class="omp-login-chip">${c}</span>`).join("") +
    "</div>";

  const panel = document.createElement("div");
  panel.className = "omp-login-panel";

  const form = document.createElement("form");
  form.className = "omp-login-card";

  const title = document.createElement("h2");
  title.textContent = "Anmelden";
  const sub = document.createElement("p");
  sub.className = "omp-login-sub";
  sub.textContent = "Zugang zur Control Plane";

  const userInput = document.createElement("input");
  userInput.placeholder = "Nutzername";
  userInput.autocomplete = "username";
  const userLabel = document.createElement("label");
  userLabel.append("Nutzername", userInput);

  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.placeholder = "Passwort";
  passInput.autocomplete = "current-password";
  const passLabel = document.createElement("label");
  passLabel.append("Passwort", passInput);

  const error = document.createElement("div");
  error.className = "omp-login-error";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Anmelden";
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

  form.append(title, sub, userLabel, passLabel, error, submit, foot, firmware);
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
      error.textContent = "Anmeldung fehlgeschlagen.";
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
export function buildUserWidget(username: string, homeHref?: string): HTMLElement {
  const widget = document.createElement("div");
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
    homeLink.textContent = t("auth.switchWorkflow");
    homeLink.title = t("auth.switchWorkflowTitle");
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
