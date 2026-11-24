// Node-UI des Automatic Multiviewers: zeigt das Kachelbild (previewUrl) groß im Property-Panel,
// wie der Viewer, plus Untertitel-Overlay. Eigenes Mini-t(): Node-Bundles nutzen keine Shell-Imports.
const T = (() => {
  const D = { de: { loading: "lade Vorschau …", notConnected: "keine Quellen" }, en: { loading: "loading preview …", notConnected: "no sources" } };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
})();

class OmpMultiviewerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      .wrap { position: relative; container-type: inline-size; aspect-ratio: 16 / 9; background: #000; border: 1px solid #444; box-sizing: border-box; }
      img { display: block; width: 100%; height: 100%; object-fit: contain; }
      .sub { position: absolute; left: 4%; right: 4%; bottom: 8%; text-align: center; color: #fff; font-size: 4.4cqw; font-weight: 600;
        white-space: pre-line; pointer-events: none; text-shadow: 0 0 3px #000, 1px 1px 2px #000; }
      .sub:empty { display: none; }
      p { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #888; }
    `;
    const token = localStorage.getItem("omp-auth-token");
    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      return res.ok ? (await res.json()).value : undefined;
    };
    const url = () => {
      const base = `/api/v1/nodes/${nodeId}/stream/previewUrl`;
      const withToken = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
      return `${withToken}${withToken.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const img = document.createElement("img");
    img.alt = "Vorschau";
    img.style.display = "none";
    const status = document.createElement("p");
    status.textContent = T("loading");
    const sub = document.createElement("div");
    sub.className = "sub";
    wrap.append(img, status, sub);
    img.addEventListener("load", () => { img.style.display = ""; status.style.display = "none"; });
    img.addEventListener("error", () => { img.style.display = "none"; status.textContent = T("notConnected"); status.style.display = ""; });
    img.src = url();
    // Einzelbild-Polling (Chromium rendert multipart/x-mixed-replace nicht); erst weiter, wenn das vorige Bild fertig ist.
    this._previewInterval = setInterval(() => { if (img.complete) img.src = url(); }, 500);
    const refreshSubtitle = async () => { sub.textContent = (await getParam("subtitle")) || ""; };
    refreshSubtitle();
    this._subInterval = setInterval(refreshSubtitle, 500);
    shadow.append(style, wrap);
  }
  disconnectedCallback() {
    clearInterval(this._previewInterval);
    clearInterval(this._subInterval);
  }
}

if (!customElements.get("omp-multiviewer-panel")) {
  customElements.define("omp-multiviewer-panel", OmpMultiviewerPanel);
}
