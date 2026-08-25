// Live-Vorschau (previewUrl-Snapshot-Stream) für die Operator-Konsole
// (console-board.ts/console-view.ts) — Nutzerfund 2026-08-25: ein
// Operator mit nur `operate` auf z. B. omp-multiviewer-custom bekam
// bisher ausschließlich dessen eigenes UI-Bundle gemountet (beim
// Multiviewer der PIP-Layout-Editor, KEIN Video), obwohl der
// previewUrl-Stream selbst (`GET /api/v1/nodes/{id}/stream/previewUrl`)
// für jeden authentifizierten Nutzer bereits frei zugänglich ist — "er
// muss ja das Video sehen können" ließ sich also nicht abbilden.
//
// Gleiche Technik/dieselben Nutzerfund-Fixes wie ui/graph/flow-canvas.ts'
// Kachel-Vorschau (Einzelbild-Polling statt multipart/x-mixed-replace,
// `access_token`-Query statt Authorization-Header für <img>, `img.complete`-
// Guard gegen abgebrochene Requests, "nicht verbunden" statt kaputtem
// Icon bis zum ersten Frame). Eigenes, kleines Modul statt Import aus
// flow-canvas.ts, weil dessen Vorschau an SVG-<foreignObject>-Kacheln
// hängt — hier reines HTML (die Operator-Konsole hat keinen SVG-Canvas).
import { apiFetch } from "./connection.ts";

const STREAM_TOKEN_KEY = "omp-auth-token";
const PREVIEW_POLL_INTERVAL_MS = 500;

// apiBase ist derselbe `/api/v1/nodes/<nodeId>`-Basispfad wie bei
// ui-bundle.ts#mountUIBundle (aus ConsoleEntry.uiBundleUrl).
function streamProxyUrl(apiBase: string, paramName: string): string {
  const token = localStorage.getItem(STREAM_TOKEN_KEY);
  const base = `${apiBase}/stream/${paramName}`;
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
}

function previewSnapshotUrl(apiBase: string): string {
  const base = streamProxyUrl(apiBase, "previewUrl");
  return `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

// hasPreviewUrl prüft, ob der Node einen previewUrl-Parameter mit
// nicht-leerem Wert hat (Voraussetzung für eine Live-Vorschau) — gleiche
// Prüfung wie flow-canvas.ts#maybeFetchPreviewUrl.
export async function hasPreviewUrl(apiBase: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${apiBase}/params/previewUrl`);
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body && typeof body.value === "string" && body.value);
  } catch {
    return false;
  }
}

export interface MountedPreview {
  element: HTMLDivElement;
  dispose(): void;
}

// mountNodePreview baut Bild + "nicht verbunden"-Fallback und startet das
// Polling — Aufrufer hängt `element` irgendwo ein und MUSS `dispose()`
// beim Entfernen der Kachel/beim Tab-Wechsel aufrufen, sonst läuft der
// Poll-Timer über die restliche Sitzungsdauer leer weiter (gleiches Leck
// wie in flow-canvas.ts#cleanupStalePreviewState begründet).
export function mountNodePreview(apiBase: string): MountedPreview {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;width:100%;flex-shrink:0;";

  const img = document.createElement("img");
  img.alt = "Vorschau";
  img.style.cssText =
    "display:none;width:100%;aspect-ratio:16/9;object-fit:contain;background:var(--omp-bg,#101214);" +
    "border:1px solid var(--omp-border,#444);border-radius:4px;";

  const notConnected = document.createElement("div");
  notConnected.textContent = "nicht verbunden";
  notConnected.style.cssText =
    "display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;" +
    "background:var(--omp-bg,#101214);border:1px solid var(--omp-border,#444);border-radius:4px;" +
    "color:var(--omp-text-dim,#888);font-size:12px;";

  img.addEventListener("load", () => {
    img.style.display = "block";
    notConnected.style.display = "none";
  });
  img.addEventListener("error", () => {
    img.style.display = "none";
    notConnected.style.display = "flex";
  });

  wrapper.append(img, notConnected);
  img.src = previewSnapshotUrl(apiBase);

  const timer = setInterval(() => {
    // Nur neu anfragen, wenn der vorherige Request fertig ist — sonst
    // reißt ein blindes Neusetzen von `src` einen noch laufenden Request
    // ab, was `error` auslöst wie ein echter Verbindungsabbruch
    // (identischer Fund wie flow-canvas.ts#ensurePreviewPolling).
    if (!img.complete) return;
    img.src = previewSnapshotUrl(apiBase);
  }, PREVIEW_POLL_INTERVAL_MS);

  return {
    element: wrapper,
    dispose() {
      clearInterval(timer);
    },
  };
}
