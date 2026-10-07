// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
        "pcb.c6e6ba": "webUiUrl nicht erreichbar",
        "pcb.3ce9c3": "keine Web-UI-Adresse verfügbar"
    },
    en: {
        "pcb.c6e6ba": "webUiUrl not reachable",
        "pcb.3ce9c3": "no web UI address available"
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();
const LOCALE = document.documentElement.lang === "en" ? "en-GB" : "de-DE";

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
      status.textContent = T("pcb.c6e6ba");
      return;
    }
    if (!url) {
      status.textContent = T("pcb.3ce9c3");
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
