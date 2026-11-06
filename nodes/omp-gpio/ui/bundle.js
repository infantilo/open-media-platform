// Bedienfeld von omp-gpio (Kapitel 89/RC1): Eingänge als Lampen, Ausgänge schaltbar, Namen und Fail-Safe-Pegel, Simulator, letzte Ereignisse.
// Generische Node-Proxy-API: /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>. Eigenes Mini-t() (Sprache aus <html lang>).
const T = (() => {
  const D = {
    de: {
      link: "Verbindung zum Gerät", linkUp: "verbunden", linkDown: "getrennt (Ausgänge auf Fail-Safe)", debounce: "Entprellzeit (ms)",
      inputs: "Eingänge", outputs: "Ausgänge", colPin: "Pin", colName: "Name", colLevel: "Pegel", colFs: "Fail-Safe an", colAct: "Schalten",
      on: "an", off: "aus", toggle: "Umschalten", simulate: "Simulator: Eingang umschalten", simLink: "Simulator: Verbindung trennen/herstellen",
      events: "Letzte Ereignisse", noEvents: "Noch keine Ereignisse.", hold: "Haltezeit (ms, 0 = halten)", fail: "{m} fehlgeschlagen: {d}",
      hint: "Ausgänge mit Haltezeit fallen ohne Erneuerung auf den Fail-Safe-Pegel zurück. Beim Trennen der Verbindung gehen alle Ausgänge sofort auf Fail-Safe.",
    },
    en: {
      link: "Device link", linkUp: "connected", linkDown: "disconnected (outputs at fail-safe)", debounce: "Debounce (ms)",
      inputs: "Inputs", outputs: "Outputs", colPin: "Pin", colName: "Name", colLevel: "Level", colFs: "Fail-safe on", colAct: "Switch",
      on: "on", off: "off", toggle: "Toggle", simulate: "Simulator: toggle input", simLink: "Simulator: drop/restore link",
      events: "Recent events", noEvents: "No events yet.", hold: "Hold time (ms, 0 = latch)", fail: "{m} failed: {d}",
      hint: "Outputs with a hold time fall back to the fail-safe level unless renewed. When the link drops, all outputs go to fail-safe at once.",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

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
  :host { display: block; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  input { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 4px 9px; }
  button:hover:not(:disabled) { border-color: var(--acc); }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 10px; background: var(--ok); color: #fff; font-weight: 600; min-width: 190px; white-space: nowrap; }
  .chip.down { background: var(--err); }
  :host { position: relative; }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; }
  .banner.show { display: block; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 4px; }
  td { padding: 2px 4px; } td input[type=text] { width: 100%; min-width: 100px; }
  td.lv { width: 90px; white-space: nowrap; } .led { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--bd); vertical-align: middle; margin-right: 6px; }
  .led.on { background: var(--ok); border-color: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .hint, .muted { color: var(--mut); } .ev { font-variant-numeric: tabular-nums; padding: 1px 0; font-family: monospace; }
`;

class OmpGpioPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
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
    let linkUp = true, ins = [], outs = [], events = [];
    let holdMs = 0;

    const linkChip = h("span", { class: "chip" });
    const linkBtn = h("button", { onclick: async () => { await call("simulateLink", { up: !linkUp }); poll(); } }, T("simLink"));
    const debInput = h("input", { type: "number", min: "0", max: "2000", style: "width:80px", onchange: async () => {
      await fetch(`${base}/params/debounceMs`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: Number(debInput.value) }) });
    } });
    const holdInput = h("input", { type: "number", min: "0", style: "width:90px", value: "0", onchange: () => { holdMs = Math.max(0, Number(holdInput.value) || 0); } });
    const head = h("div", { class: "bar" }, h("label", {}, T("link"), linkChip), linkBtn, h("label", {}, T("debounce"), debInput), h("label", {}, T("hold"), holdInput));

    const inBody = h("tbody"), outBody = h("tbody"), evEl = h("div");
    const th = (...c) => h("thead", {}, h("tr", {}, c.map((x) => h("th", {}, x))));
    const inSec = h("details", { class: "sec", open: true }, h("summary", {}, T("inputs")), h("div", { class: "body" }, h("table", {}, th(T("colPin"), T("colName"), T("colLevel"), T("simulate")), inBody)));
    const outSec = h("details", { class: "sec", open: true }, h("summary", {}, T("outputs")), h("div", { class: "body" }, h("table", {}, th(T("colPin"), T("colName"), T("colLevel"), T("colFs"), T("colAct")), outBody), h("p", { class: "hint" }, T("hint"))));
    const evSec = h("details", { class: "sec" }, h("summary", {}, T("events")), h("div", { class: "body" }, evEl));

    const lvl = (on) => h("span", {}, h("span", { class: `led${on ? " on" : ""}` }), on ? T("on") : T("off"));
    const nameField = (kind, p, focusKey) => h("input", { type: "text", value: p.name, "data-k": focusKey, onchange: async (e) => { await call("configurePin", { kind, pin: p.pin, name: e.target.value }); } });

    // Zeilen werden nur neu gebaut, wenn kein Eingabefeld den Fokus hat (sonst springt die Eingabe)
    const render = () => {
      linkChip.textContent = linkUp ? T("linkUp") : T("linkDown"); linkChip.className = `chip${linkUp ? "" : " down"}`;
      if (shadow.activeElement && shadow.activeElement.tagName === "INPUT" && shadow.activeElement !== debInput) return;
      inBody.replaceChildren(...ins.map((p) => h("tr", {}, h("td", {}, p.pin), h("td", {}, nameField("in", p, "i" + p.pin)), h("td", { class: "lv" }, lvl(p.level)),
        h("td", {}, h("button", { onclick: async () => { await call("simulateInput", { pin: p.pin, level: !p.level }); setTimeout(poll, 120); } }, T("toggle"))))));
      outBody.replaceChildren(...outs.map((p) => h("tr", {}, h("td", {}, p.pin), h("td", {}, nameField("out", p, "o" + p.pin)), h("td", { class: "lv" }, lvl(p.level)),
        h("td", {}, h("input", { type: "checkbox", checked: p.failSafe, onchange: async (e) => { await call("configurePin", { kind: "out", pin: p.pin, failSafe: e.target.checked }); poll(); } })),
        h("td", {}, h("button", { onclick: async () => { await call("setOutput", { pin: p.pin, level: !p.level, holdMs }); poll(); } }, T("toggle"))))));
      evEl.replaceChildren(...(events.length ? events.slice().reverse().map((e) => h("div", { class: "ev" }, `#${e.event.seq} ${e.subject} ${JSON.stringify({ level: e.event.level, up: e.event.up, reason: e.event.reason })}`)) : [h("span", { class: "muted" }, T("noEvents"))]));
    };
    shadow.append(h("style", {}, STYLE), banner, head, inSec, outSec, evSec);

    const poll = async () => {
      try {
        const [l, i, o, r, d] = await Promise.all(["linkUp", "inputs", "outputs", "recent", "debounceMs"].map(getParam));
        if (l !== undefined) linkUp = !!l;
        if (i) ins = JSON.parse(i);
        if (o) outs = JSON.parse(o);
        if (r) events = JSON.parse(r);
        if (document.activeElement !== debInput && d !== undefined) debInput.value = String(d);
        render();
      } catch { /* nächster Takt */ }
    };
    poll();
    this._i = setInterval(poll, 500);
  }
  disconnectedCallback() { clearInterval(this._i); }
}
if (!customElements.get("omp-gpio-panel")) customElements.define("omp-gpio-panel", OmpGpioPanel);
