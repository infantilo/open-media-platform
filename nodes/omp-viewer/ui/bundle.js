// Node-UI-Bundle des Viewers (UMSETZUNG.md C6, ARCHITECTURE.md §4.5):
// zeigt den MJPEG-Preview-Stream als <img>. Bis K4 (docs/END-GOAL-
// FEATURES.md Kapitel 10 Entscheidungssitzung Punkt 5) zeigte die Quelle
// direkt auf den node-eigenen, zweiten Preview-HTTP-Listener
// (OMP_VIEWER_PREVIEW_PORT, preview.rs) — das umging die Orchestrator-
// Auth komplett und verlangte, dass der Browser jeden Node-Host direkt
// erreicht. Jetzt läuft der Stream durch den generischen
// Orchestrator-Proxy (`GET /api/v1/nodes/<id>/stream/previewUrl`, löst
// intern denselben previewUrl-Parameter auf und reicht die Antwort
// durch) — derselbe Auth-Schutz wie jeder andere `/api/v1`-Endpunkt,
// der Browser kennt nie Host/Port des zweiten Node-Ports.
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

    img.addEventListener("load", () => status.remove());
    img.addEventListener("error", () => {
      status.textContent = "keine Vorschau verfügbar";
    });
    // `<img src>` kann keinen `Authorization`-Header setzen (Web-
    // Plattform-Einschränkung) — derselbe `?access_token=`-Fallback wie
    // bei der Shell-eigenen SSE-Verbindung (ui/shell/connection.ts),
    // ohne den bekäme jede Vorschau ein stilles 401 statt eines Bildes,
    // sobald ein echter Nutzer angemeldet ist (live per CDP gefunden).
    const token = localStorage.getItem("omp-auth-token");
    img.src = token
      ? `/api/v1/nodes/${nodeId}/stream/previewUrl?access_token=${encodeURIComponent(token)}`
      : `/api/v1/nodes/${nodeId}/stream/previewUrl`;
  }
}

if (!customElements.get("omp-viewer-panel")) {
  customElements.define("omp-viewer-panel", OmpViewerPanel);
}
