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
      img { display: block; width: 100%; height: 100%; object-fit: fill; }
      .sub { position: absolute; left: 4%; right: 4%; bottom: 8%; text-align: center; color: #fff; font-size: 4.4cqw; font-weight: 600;
        white-space: pre-line; pointer-events: none; text-shadow: 0 0 3px #000, 1px 1px 2px #000; }
      .sub:empty { display: none; }
      .umds { position: absolute; inset: 0; display: grid; pointer-events: none; }
      .umds > div { position: relative; min-width: 0; }
      .umds span { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; font-size: 13px; font-weight: 600; line-height: 1.3;
        color: #fff; background: rgba(0,0,0,.65); padding: 1px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
    const umds = document.createElement("div");
    umds.className = "umds";
    wrap.append(img, status, umds, sub);
    // Quellenbezeichnung je Kachel als Overlay in fester, lesbarer Größe (gleiche Rasteraufteilung wie die Pipeline:
    // Spalten = aufgerundete Wurzel, Kachel 320×180), unabhängig von der Skalierung des Bildes.
    let lastInputs = "";
    const refreshUmds = async () => {
      const inputs = (await getParam("inputs")) || [];
      const key = JSON.stringify(inputs.map((i) => i.label));
      if (key === lastInputs) return;
      lastInputs = key;
      const n = inputs.length;
      const cols = n ? Math.ceil(Math.sqrt(n)) : 1;
      const rows = n ? Math.ceil(n / cols) : 1;
      wrap.style.aspectRatio = `${cols * 320} / ${rows * 180}`;
      umds.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      umds.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      umds.replaceChildren(...inputs.map((i) => {
        const cell = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = i.label;
        label.title = i.label;
        cell.append(label);
        return cell;
      }));
    };
    refreshUmds();
    this._umdInterval = setInterval(refreshUmds, 2000);
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
    clearInterval(this._umdInterval);
  }
}

if (!customElements.get("omp-multiviewer-panel")) {
  customElements.define("omp-multiviewer-panel", OmpMultiviewerPanel);
}
