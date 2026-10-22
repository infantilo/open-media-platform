// Bedienoberfläche des Intercom-Nodes in der Operator-Konsole (Kapitel 47): bettet die eigene Sprechstelle ein
// (Panel-Link vom Orchestrator-Modul `intercom`) und meldet der Shell per `deckParty`, welche Sprechstelle das
// Stream Deck fernbedienen soll (Adapter `omp-intercom-panel`). Das Mikrofon bleibt im eingebetteten Panel.
const L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
const D = {
  de: { pick: "Sprechstelle", newTab: "In neuem Tab öffnen", none: "Für Sie ist keine Sprechstelle eingerichtet (Administration → Produktion → Intercom).", err: "Sprechstellen laden fehlgeschlagen", cert: "Zeigt das Panel nichts an: einmal „In neuem Tab öffnen“ und das Zertifikat bestätigen.", online: "online" },
  en: { pick: "Station", newTab: "Open in new tab", none: "No station is set up for you (Administration → Production → Intercom).", err: "Loading stations failed", cert: "If the panel shows nothing: open it once in a new tab and accept the certificate.", online: "online" },
}[L];

class OmpIntercomPanel extends HTMLElement {
  constructor() {
    super();
    this.deckParty = null; // Stream-Deck-Adapter liest die eigene Sprechstelle von hier
    this._panels = [];
    this._current = 0;
    this._timer = 0;
  }

  connectedCallback() {
    this.style.cssText = "display:block;padding:8px;font:13px system-ui,sans-serif;";
    this._nodeId = this.getAttribute("node-id");
    this._load();
    this._timer = setInterval(() => this._status(), 3000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  async _load() {
    try {
      const r = await fetch("/api/v1/intercom/panels");
      if (!r.ok) throw new Error(String(r.status));
      this._panels = (await r.json()).panels || [];
    } catch (e) {
      this._error = `${D.err} (${e.message})`;
    }
    const saved = Number(sessionStorage.getItem("omp-intercom-party") ?? "");
    const idx = this._panels.findIndex((p) => p.party_id === saved);
    this._current = idx >= 0 ? idx : 0;
    this._render();
  }

  async _status() {
    const el = this.querySelector("[data-status]");
    if (!el || !this._nodeId) return;
    try {
      const r = await fetch(`/api/v1/nodes/${this._nodeId}/params/partiesOnline`);
      const j = await r.json();
      el.textContent = `${j && typeof j === "object" && "value" in j ? j.value : j} ${D.online}`;
    } catch (_) { /* Anzeige bleibt */ }
  }

  _render() {
    this.replaceChildren();
    if (this._error) {
      const e = document.createElement("div");
      e.style.color = "#e57373";
      e.textContent = this._error;
      this.append(e);
    }
    if (!this._panels.length) {
      this.deckParty = null;
      if (!this._error) {
        const n = document.createElement("div");
        n.style.opacity = "0.7";
        n.textContent = D.none;
        this.append(n);
      }
      return;
    }
    const p = this._panels[Math.min(this._current, this._panels.length - 1)];
    this.deckParty = p.party_id;
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;";
    if (this._panels.length > 1) {
      const lab = document.createElement("span");
      lab.textContent = D.pick;
      const sel = document.createElement("select");
      this._panels.forEach((x, i) => sel.add(new Option(x.name, String(i))));
      sel.value = String(this._current);
      sel.onchange = () => {
        this._current = Number(sel.value);
        sessionStorage.setItem("omp-intercom-party", String(this._panels[this._current].party_id));
        this._render();
      };
      bar.append(lab, sel);
    } else {
      const s = document.createElement("strong");
      s.textContent = p.name;
      bar.append(s);
    }
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = D.newTab;
    const st = document.createElement("span");
    st.dataset.status = "1";
    st.style.opacity = "0.7";
    const hint = document.createElement("span");
    hint.style.cssText = "opacity:.6;font-size:11px;";
    hint.textContent = D.cert;
    bar.append(a, st, hint);
    const f = document.createElement("iframe");
    f.src = p.url;
    f.title = p.name;
    f.setAttribute("allow", "microphone; autoplay");
    f.style.cssText = "width:100%;max-width:980px;height:calc(100% - 40px);min-height:420px;border:1px solid var(--omp-border,#223049);border-radius:8px;background:var(--omp-bg,#080c16);";
    this.append(bar, f);
    this._status();
  }
}
if (!customElements.get("omp-intercom-panel")) customElements.define("omp-intercom-panel", OmpIntercomPanel);
