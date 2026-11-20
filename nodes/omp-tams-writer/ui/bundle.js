function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const STYLE = `
  :host { display: block; position: relative; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; --warn: #d9a02b; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 6px 12px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .5; cursor: default; }
  button.go { background: var(--acc); border-color: var(--acc); color: #fff; } button.stop { background: var(--err); border-color: var(--err); color: #fff; font-weight: 700; }
  input, select { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 12px; border-radius: 10px; background: var(--bg3); font-weight: 600; min-width: 130px; text-align: center; white-space: nowrap; }
  .chip.recording, .chip.playing, .chip.following { background: var(--ok); color: #fff; } .chip.error { background: var(--err); color: #fff; }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; }
  .banner.show { display: block; }
  .box { border: 1px solid var(--bd); border-radius: 6px; background: var(--bg2); padding: 8px 10px; margin-bottom: 8px; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); font-weight: 600; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-variant-numeric: tabular-nums; } .kv span:nth-child(odd) { color: var(--mut); }
  .err { color: var(--err); word-break: break-word; min-height: 1.3em; } .hint { color: var(--mut); margin: 6px 0 0; }
`;
const makeT = (D) => {
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
};
function api(el, T) {
  const nodeId = el.getAttribute("node-id");
  const base = `/api/v1/nodes/${nodeId}`;
  const banner = h("div", { class: "banner" });
  let bt = null;
  const show = (text) => { banner.textContent = text; banner.className = "banner show"; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 6000); };
  const getParam = async (name) => { const r = await fetch(`${base}/params/${name}`); return r.ok ? (await r.json()).value : undefined; };
  const call = async (method, body) => {
    const r = await fetch(`${base}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (r.ok) return true;
    let d = await r.text().catch(() => ""); try { d = JSON.parse(d).error || d; } catch { /* Klartext */ }
    show(T("fail", { m: method, d: d || r.status })); return false;
  };
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem("tams." + nodeId + "." + k) || ""; localStorage.setItem("tams." + nodeId + "." + k, v); } catch { return ""; } return ""; };
  return { banner, getParam, call, store };
}
// Bedienfeld von omp-tams-writer (Kapitel 105): Aufnahme starten/stoppen, Zustand der Warteschlange.
const T = makeT({
  de: { status: "Aufnahme", start: "Aufnahme starten", stop: "Aufnahme stoppen", store: "Speicher", conn: "verbunden", disc: "nicht erreichbar",
    queue: "Warteschlange", registered: "Registriert", written: "Segmente geschrieben", rejected: "Abgelehnt", dropped: "Verworfen (Warteschlange voll)", lag: "Verzug hinter live", errors: "Fehler",
    fail: "{m} fehlgeschlagen: {d}", hint: "Quelle in der Kreuzschiene mit den Eingängen Video und Audio verbinden. Fällt der Speicher aus, puffert der Node auf der Platte und holt nach.",
    idle: "bereit", recording: "nimmt auf", error: "Fehler", seg: "Seg.", s: "s" },
  en: { status: "Recording", start: "Start recording", stop: "Stop recording", store: "Store", conn: "connected", disc: "unreachable",
    queue: "Queue", registered: "Registered", written: "Segments written", rejected: "Rejected", dropped: "Dropped (queue full)", lag: "Lag behind live", errors: "Errors",
    fail: "{m} failed: {d}", hint: "Connect a source to the Video and Audio inputs in the crosspoint. If the store is down the node buffers on disk and catches up.",
    idle: "ready", recording: "recording", error: "error", seg: "seg.", s: "s" },
});
class OmpTamsWriterPanel extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: "open" });
    const { banner, getParam, call } = api(this, T);
    const chip = h("span", { class: "chip" }), conn = h("span", {}), svc = h("span", { class: "hint" });
    const startB = h("button", { class: "go", onclick: () => call("tams.start").then(poll) }, T("start"));
    const stopB = h("button", { class: "stop", onclick: () => call("tams.stop").then(poll) }, T("stop"));
    const kv = h("div", { class: "kv" }), err = h("div", { class: "err" });
    shadow.append(h("style", {}, STYLE), banner,
      h("div", { class: "bar" }, h("label", {}, T("status"), chip), startB, stopB, h("label", {}, T("store"), h("span", {}, conn, " ", svc))),
      h("div", { class: "box" }, kv, err), h("p", { class: "hint" }, T("hint")));
    const poll = async () => {
      try {
        const n = ["tams.status", "tams.connected", "tams.service", "tams.queueSegments", "tams.queueBytes", "tams.registered", "tams.rejected", "tams.droppedOverflow", "tams.segmentsWritten", "tams.errors", "tams.lagMs", "tams.lastError"];
        const v = Object.fromEntries((await Promise.all(n.map(getParam))).map((x, i) => [n[i], x]));
        const s = v["tams.status"] || "idle";
        chip.textContent = T(s); chip.className = "chip " + s;
        conn.textContent = v["tams.connected"] ? T("conn") : T("disc"); svc.textContent = v["tams.service"] || "";
        startB.disabled = s === "recording"; stopB.disabled = s !== "recording";
        const mb = ((v["tams.queueBytes"] || 0) / 1048576).toFixed(1);
        const rows = [[T("queue"), `${v["tams.queueSegments"] ?? 0} ${T("seg")} · ${mb} MB`], [T("written"), v["tams.segmentsWritten"] ?? 0], [T("registered"), v["tams.registered"] ?? 0], [T("rejected"), v["tams.rejected"] ?? 0],
          [T("dropped"), v["tams.droppedOverflow"] ?? 0], [T("lag"), `${((v["tams.lagMs"] || 0) / 1000).toFixed(1)} ${T("s")}`], [T("errors"), v["tams.errors"] ?? 0]];
        kv.replaceChildren(...rows.flatMap(([a, b]) => [h("span", {}, a), h("span", {}, b)]));
        err.textContent = v["tams.lastError"] || "";
      } catch { /* nächster Takt */ }
    };
    poll(); this._i = setInterval(poll, 500);
  }
  disconnectedCallback() { clearInterval(this._i); }
}
if (!customElements.get("omp-tams-writer-panel")) customElements.define("omp-tams-writer-panel", OmpTamsWriterPanel);
