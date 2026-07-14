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
  overlay.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
    "background:#111;font-family:sans-serif;z-index:2000;";

  const form = document.createElement("form");
  form.style.cssText =
    "display:flex;flex-direction:column;gap:8px;background:#1c1c1c;padding:24px;" +
    "border-radius:8px;border:1px solid #333;min-width:220px;";

  const title = document.createElement("h2");
  title.textContent = "OpenMediaPlatform";
  title.style.cssText = "color:#eee;font-size:15px;margin:0 0 8px;";

  const userInput = document.createElement("input");
  userInput.placeholder = "Nutzername";
  userInput.autocomplete = "username";
  userInput.style.cssText = "padding:6px;font-size:13px;";

  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.placeholder = "Passwort";
  passInput.autocomplete = "current-password";
  passInput.style.cssText = "padding:6px;font-size:13px;";

  const error = document.createElement("div");
  error.style.cssText = "color:#e66;font-size:12px;min-height:14px;";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Anmelden";
  submit.style.cssText = "padding:6px;font-size:13px;cursor:pointer;";

  form.append(title, userInput, passInput, error, submit);
  overlay.append(form);
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

// buildUserWidget zeigt den angemeldeten Nutzer + Abmelden-Button — nur
// aufgerufen, wenn authRequired true ist (s. shell.ts), damit der
// Bootstrap-/Dev-Modus ohne angelegte Nutzer optisch unverändert bleibt.
export function buildUserWidget(username: string): HTMLElement {
  const widget = document.createElement("div");
  widget.style.cssText =
    "position:fixed;bottom:6px;right:6px;z-index:1000;font-family:sans-serif;" +
    "font-size:11px;color:#999;background:#111;padding:4px 6px;border-radius:4px;" +
    "border:1px solid #333;display:flex;gap:6px;align-items:center;";
  const label = document.createElement("span");
  label.textContent = `Angemeldet als ${username}`;
  const logoutButton = document.createElement("button");
  logoutButton.textContent = "Abmelden";
  logoutButton.style.cssText = "font-size:11px;cursor:pointer;";
  logoutButton.addEventListener("click", logout);
  widget.append(label, logoutButton);
  return widget;
}
