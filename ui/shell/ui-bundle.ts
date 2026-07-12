// Lädt das node-eigene UI-Bundle (ARCHITECTURE.md §4.5): liefert der Node
// <apiBase>/ui/manifest.json + <apiBase>/ui/bundle.js, wird dessen Custom
// Element per nativem import() geladen statt eines generischen Panels.
// Liefert false, wenn der Node kein Bundle hat (404 o. Ä.).
//
// `apiBase` ist der Node-Proxy-Pfad `/api/v1/nodes/<nodeId>` — sowohl vom
// Engineering-Panel (flow-canvas.ts) als auch von der Console-Ansicht
// (UMSETZUNG.md C13, aus `/api/v1/me/consoles`s `uiBundleUrl`) genutzt,
// damit die Bundle-Lade-Logik nicht zweimal existiert.
export async function mountUIBundle(container: HTMLElement, apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/ui/manifest.json`);
    if (!res.ok) return false;
    const manifest = (await res.json()) as { tag?: string };
    if (!manifest.tag) return false;

    await import(/* webpackIgnore: true */ `${apiBase}/ui/bundle.js`);

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
