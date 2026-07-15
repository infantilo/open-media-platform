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
    return true;
  } catch {
    return false;
  }
}
