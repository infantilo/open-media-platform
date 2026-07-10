// Node-UI-Bundle des Viewers (UMSETZUNG.md C6, ARCHITECTURE.md §4.5):
// zeigt den MJPEG-Preview-Stream direkt als <img>, dessen Quelle der
// eigene, node-eigene Preview-HTTP-Listener ist (OMP_VIEWER_PREVIEW_PORT,
// preview.rs) — nicht über den Orchestrator-Proxy, der nur kurzlebige
// JSON-Antworten weiterreicht, keine dauerhaft offenen Streams. Die
// previewUrl selbst kommt aus dem generischen Parameter-Proxy
// (/api/v1/nodes/<id>/params/previewUrl), damit dieses Bundle kein
// Sonderwissen über Host/Port des Nodes braucht.
class OmpViewerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      img {
        display: block; max-width: 100%; background: #000;
        border: 1px solid #444;
      }
      p { font-size: 12px; color: #888; }
    `;

    const img = document.createElement("img");
    img.alt = "Vorschau";
    img.width = 320;

    const status = document.createElement("p");
    status.textContent = "lade Vorschau …";

    shadow.append(style, img, status);

    fetch(`/api/v1/nodes/${nodeId}/params/previewUrl`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body && body.value) {
          img.src = body.value;
          status.remove();
        } else {
          status.textContent = "keine Vorschau-URL verfügbar";
        }
      })
      .catch(() => {
        status.textContent = "Vorschau-URL konnte nicht geladen werden";
      });
  }
}

if (!customElements.get("omp-viewer-panel")) {
  customElements.define("omp-viewer-panel", OmpViewerPanel);
}
