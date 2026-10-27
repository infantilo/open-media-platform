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
  return (await mountUIBundleEl(container, apiBase)) !== null;
}

// Wie mountUIBundle, liefert aber das Custom Element (Kap. 40.4: der
// Stream-Deck-Broker liest daran die optionale `streamDeck`-Eigenschaft).
// Audit 2026-10-23 H1: ist der zweite Ursprung für Node-Oberflächen aktiv (OMP_UI_ORIGIN_LISTEN) und der Node-Typ dafür freigegeben, läuft die Oberfläche in einem iframe auf diesem
// Ursprung (internal/uiorigin): sie sieht weder Shell noch Token und erreicht nur ihren eigenen Node. Sonst unverändert wie bisher in der Shell.
let isolationEnabled: Promise<boolean> | undefined;
function isolationAvailable(): Promise<boolean> {
  isolationEnabled ??= fetch("/api/v1/ui-origin").then((r) => r.ok).catch(() => false);
  return isolationEnabled;
}

async function mountIsolated(container: HTMLElement, apiBase: string): Promise<HTMLElement | null> {
  if (!(await isolationAvailable())) return null;
  let url = "";
  try {
    const res = await fetch(`${apiBase}/ui-grant`, { method: "POST" });
    if (!res.ok) return null;
    const g = (await res.json()) as { isolated?: boolean; url?: string };
    if (!g.isolated || !g.url) return null;
    url = g.url;
  } catch {
    return null;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
  frame.setAttribute("data-role", "isolated-node-ui");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "display:block;width:100%;height:320px;border:0;background:transparent;";
  frame.src = url;
  container.replaceChildren(frame);
  return new Promise<HTMLElement | null>((resolve) => {
    let settled = false;
    const onMessage = (ev: MessageEvent) => {
      if (!frame.isConnected) {
        removeEventListener("message", onMessage);
        return;
      }
      if (ev.source !== frame.contentWindow) return;
      const m = ev.data as { omp?: string; type?: string; height?: number };
      if (m?.omp !== "ui") return;
      if (m.type === "size" && typeof m.height === "number") {
        frame.style.height = `${Math.max(120, Math.min(m.height, 20000))}px`;
      } else if (m.type === "ready" && !settled) {
        settled = true;
        resolve(frame);
      } else if (m.type === "error" && !settled) {
        settled = true;
        removeEventListener("message", onMessage);
        frame.remove();
        resolve(null); // zurück auf den klassischen Weg
      }
    };
    addEventListener("message", onMessage);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        removeEventListener("message", onMessage);
        frame.remove();
        resolve(null);
      }
    }, 15000);
  });
}

export async function mountUIBundleEl(container: HTMLElement, apiBase: string): Promise<HTMLElement | null> {
  const isolated = await mountIsolated(container, apiBase);
  if (isolated) {
    watchAvailability(container, isolated, apiBase);
    return isolated;
  }
  try {
    const res = await fetch(`${apiBase}/ui/manifest.json`);
    if (!res.ok) return null;
    const manifest = (await res.json()) as { tag?: string };
    if (!manifest.tag) return null;

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
    return el;
  } catch {
    return null;
  }
}

// Hat der Node überhaupt ein UI-Bundle (Manifest vorhanden)? Unterscheidet
// "kein Bundle" (z. B. omp-source, kein Fehler) von "Bundle lädt nicht".
export async function hasUIBundle(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/ui/manifest.json`);
    if (!res.ok) return false;
    const manifest = (await res.json()) as { tag?: string };
    return !!manifest.tag;
  } catch {
    return false;
  }
}
