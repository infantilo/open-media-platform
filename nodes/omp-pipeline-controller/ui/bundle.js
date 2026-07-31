// Node-UI-Bundle (UMSETZUNG.md, ARCHITECTURE.md §4.5): zeigt PIPELINE
// CONTROLLERs eigenes Web-UI eingebettet als <iframe>. Bewusst kein
// eigenes Steuer-Interface (kein Play/Stop/Cue über OMP) — die komplette
// Bedienung bleibt PIPELINE CONTROLLERs eigene Sache, nur die Anzeige
// zieht in den Flow-Editor um.
class OmpPipelineControllerPanel extends HTMLElement {
  async connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      iframe {
        display: block; width: 100%; height: 480px; border: 1px solid #444;
        background: #000;
      }
      p { font-size: 12px; color: #888; }
    `;

    const status = document.createElement("p");
    status.textContent = "lade PIPELINE CONTROLLER …";
    shadow.append(style, status);

    let url;
    try {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/webUiUrl`);
      const data = await res.json();
      url = data.value;
    } catch {
      status.textContent = "webUiUrl nicht erreichbar";
      return;
    }
    if (!url) {
      status.textContent = "keine Web-UI-Adresse verfügbar";
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.title = "PIPELINE CONTROLLER";
    status.remove();
    shadow.append(iframe);
  }
}

if (!customElements.get("omp-pipeline-controller-panel")) {
  customElements.define("omp-pipeline-controller-panel", OmpPipelineControllerPanel);
}
