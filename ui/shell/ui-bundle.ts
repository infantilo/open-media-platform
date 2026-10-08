// Lädt das node-eigene UI-Bundle (ARCHITECTURE.md §4.5): liefert der Node
// <apiBase>/ui/manifest.json + <apiBase>/ui/bundle.js, wird dessen Custom
// Element per nativem import() geladen statt eines generischen Panels.
// Liefert false, wenn der Node kein Bundle hat (404 o. Ä.).
//
// `apiBase` ist der Node-Proxy-Pfad `/api/v1/nodes/<nodeId>` — sowohl vom
// Engineering-Panel (flow-canvas.ts) als auch von der Console-Ansicht
// (UMSETZUNG.md C13, aus `/api/v1/me/consoles`s `uiBundleUrl`) genutzt,
// damit die Bundle-Lade-Logik nicht zweimal existiert.
//
// Live-Test-Fund (K3/K4-Teil-1-Sitzung): natives `import()` läuft über den
// Browser-eigenen Modul-Lader, nicht über das in `auth.ts` gepatchte
// `window.fetch` — der Authorization-Header fehlt dabei, jeder Node-UI-
// Bundle-Import schlug unter echter Auth (also außerhalb des Zero-User-
// Bootstrap-Zustands) mit 401 fehl und fiel still (dieses catch) auf das
// generische Parameter-Panel zurück. Fix nach demselben, bereits für SSE
// etablierten Muster (`docs/decisions.md` D3-2, `bearerToken()` im
// Orchestrator akzeptiert `?access_token=` für jede Route generisch):
// Token als Query-Param an die Bundle-URL anhängen.
const TOKEN_KEY = "omp-auth-token";

import { t } from "./i18n.ts";

const PROBE_INTERVAL_MS = 3000;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_FAILS_FOR_OVERLAY = 2;

// Nutzerfund 2026-10-08: wird ein Node im Betrieb beendet, fror sein UI
// kommentarlos ein (die Bundles pollen still weiter und verwerfen Fehler).
// Der Wächter fragt daher das (billige, statische) Manifest des Nodes ab und
// legt bei zwei Fehlschlägen in Folge eine "Dienst nicht verfügbar"-Schicht
// über das Bundle; kehrt der Node zurück, verschwindet sie wieder (das
// Bundle pollt ohnehin weiter). 401/403 gelten nicht als Ausfall.
function watchAvailability(container: HTMLElement, el: HTMLElement, apiBase: string) {
  let fails = 0;
  let overlay: HTMLDivElement | undefined;
  const timer = setInterval(async () => {
    if (!el.isConnected) {
      clearInterval(timer);
      overlay?.remove();
      return;
    }
    let up: boolean;
    try {
      const res = await fetch(`${apiBase}/ui/manifest.json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store" });
      up = res.ok || res.status === 401 || res.status === 403;
    } catch {
      up = false;
    }
    fails = up ? 0 : fails + 1;
    if (fails >= PROBE_FAILS_FOR_OVERLAY && !overlay) {
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      overlay = document.createElement("div");
      overlay.setAttribute("role", "alert");
      overlay.dataset.ompUnavailable = "1";
      overlay.style.cssText =
        "position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
        "text-align:center;padding:16px;background:color-mix(in srgb, var(--omp-bg, #111) 85%, transparent);" +
        "color:var(--omp-error, #e55);font-family:var(--omp-font, sans-serif);font-weight:600;";
      overlay.textContent = t("console.unavailable");
      container.appendChild(overlay);
    } else if (up && overlay) {
      overlay.remove();
      overlay = undefined;
    }
  }, PROBE_INTERVAL_MS);
}

export async function mountUIBundle(container: HTMLElement, apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/ui/manifest.json`);
    if (!res.ok) return false;
    const manifest = (await res.json()) as { tag?: string };
    if (!manifest.tag) return false;

    const token = localStorage.getItem(TOKEN_KEY);
    const bundleUrl = token
      ? `${apiBase}/ui/bundle.js?access_token=${encodeURIComponent(token)}`
      : `${apiBase}/ui/bundle.js`;
    await import(/* webpackIgnore: true */ bundleUrl);

    const nodeId = apiBase.split("/").pop() ?? "";
    container.replaceChildren();
    const el = document.createElement(manifest.tag);
    el.setAttribute("node-id", nodeId);
    container.appendChild(el);
    watchAvailability(container, el, apiBase);
    return true;
  } catch {
    return false;
  }
}
