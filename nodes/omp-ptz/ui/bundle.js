// Bedienfeld von omp-ptz (Kapitel 104): Joystick (Pan/Tilt), Zoom, Voreinstellungen (abrufen/speichern/löschen), Positionsanzeige.
// Fahrten laufen nur, solange der Zeiger gedrückt ist: das Feld erneuert die Fahrt alle 300 ms (der Node hält sie nur `holdMs`), beim
// Loslassen, Verlassen des Fensters oder Verlust des Fokus wird gestoppt. Generische Node-Proxy-API; eigenes Mini-t() (Sprache aus <html lang>).
const T = (() => {
  const D = {
    de: {
      link: "Kamera", linkUp: "verbunden", linkDown: "nicht erreichbar", sim: "Simulator", target: "Ziel (Adresse[:Port])", apply: "Übernehmen",
      pad: "Pan/Tilt", zoom: "Zoom", tele: "Tele", wide: "Weit", stop: "STOPP", home: "Grundstellung", presets: "Voreinstellungen",
      recall: "Abrufen", store: "Speichern", clear: "Löschen", nameFor: "Name beim Speichern", empty: "leer",
      pos: "Position", speed: "Geschwindigkeit", slow: "langsam", fast: "schnell", events: "Letzte Ereignisse", noEvents: "Noch keine Ereignisse.",
      fail: "{m} fehlgeschlagen: {d}", settings: "Einstellungen", hold: "Haltezeit (ms)", panMax: "Pan, höchste Stufe", tiltMax: "Tilt, höchste Stufe",
      hint: "Die Fahrt läuft nur, solange der Joystick gehalten wird. Reißt die Verbindung zum Bedienfeld ab, stoppt der Node nach der Haltezeit selbst.",
      mode: "Beim Klick auf eine Voreinstellung", errors: "Kamerafehler",
    },
    en: {
      link: "Camera", linkUp: "connected", linkDown: "unreachable", sim: "Simulator", target: "Target (address[:port])", apply: "Apply",
      pad: "Pan/Tilt", zoom: "Zoom", tele: "Tele", wide: "Wide", stop: "STOP", home: "Home", presets: "Presets",
      recall: "Recall", store: "Store", clear: "Clear", nameFor: "Name when storing", empty: "empty",
      pos: "Position", speed: "Speed", slow: "slow", fast: "fast", events: "Recent events", noEvents: "No events yet.",
      fail: "{m} failed: {d}", settings: "Settings", hold: "Hold time (ms)", panMax: "Pan, highest step", tiltMax: "Tilt, highest step",
      hint: "Movement runs only while the joystick is held. If the link to the panel drops, the node stops by itself after the hold time.",
      mode: "Clicking a preset will", errors: "Camera errors",
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
  :host { display: block; position: relative; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; --warn: #d9a02b; }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 6px 10px;
    -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; touch-action: none; }
  button:hover:not(:disabled) { border-color: var(--acc); }
  button.on { background: var(--acc); border-color: var(--acc); color: #fff; }
  button.stop { background: var(--err); border-color: var(--err); color: #fff; font-weight: 700; min-width: 90px; }
  input { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 10px; background: var(--ok); color: #fff; font-weight: 600; min-width: 150px; white-space: nowrap; }
  .chip.down { background: var(--err); } .chip.sim { background: var(--warn); }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; }
  .banner.show { display: block; }
  .ctl { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; margin-bottom: 8px; }
  .box { border: 1px solid var(--bd); border-radius: 6px; background: var(--bg2); padding: 8px 10px; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); font-weight: 600; }
  .pad { position: relative; width: 200px; height: 200px; border-radius: 50%; background: var(--bg); border: 2px solid var(--bd); touch-action: none; cursor: crosshair; }
  .pad::before, .pad::after { content: ""; position: absolute; background: var(--bd); }
  .pad::before { left: 50%; top: 8px; bottom: 8px; width: 1px; } .pad::after { top: 50%; left: 8px; right: 8px; height: 1px; }
  .knob { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; left: 50%; top: 50%; border-radius: 50%; background: var(--acc); border: 2px solid #fff3; pointer-events: none; }
  .zoomcol { display: flex; flex-direction: column; gap: 6px; } .zoomcol button { min-width: 90px; height: 56px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(90px, 1fr)); gap: 6px; }
  .grid button { height: 46px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grid button.empty { color: var(--mut); border-style: dashed; }
  .modes { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; flex-wrap: wrap; }
  .pos { font-variant-numeric: tabular-nums; font-family: monospace; color: var(--mut); }
  .ev { font-variant-numeric: tabular-nums; padding: 1px 0; font-family: monospace; } .muted { color: var(--mut); }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; } details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); }
  .hint { color: var(--mut); margin: 6px 0 0; }
  input[type=range] { width: 160px; padding: 0; }
`;

class OmpPtzPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const base = `/api/v1/nodes/${nodeId}`;
    const banner = h("div", { class: "banner" });
    let bt = null;
    const show = (text) => { banner.textContent = text; banner.className = "banner show"; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 6000); };
    const getParam = async (name) => { const r = await fetch(`${base}/params/${name}`); return r.ok ? (await r.json()).value : undefined; };
    const setParam = (name, value) => fetch(`${base}/params/${name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    const call = async (method, body, quiet) => {
      const r = await fetch(`${base}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      if (r.ok) return true;
      let d = await r.text().catch(() => ""); try { d = JSON.parse(d).error || d; } catch { /* Klartext */ }
      if (!quiet) show(T("fail", { m: method, d: d || r.status })); return false;
    };

    let st = { linkUp: false, simulated: false, target: "", model: "", panPos: null, tiltPos: null, zoomPos: null, presets: [], events: [], errors: 0 };
    let mode = "recall";
    let speedScale = 0.6; // Anteil der höchsten Stufe, den der Joystick am Rand liefert

    // ── Joystick: Zeiger gedrückt → alle 300 ms move; Loslassen/Verlust → move 0,0 + stop
    const knob = h("div", { class: "knob" });
    const pad = h("div", { class: "pad" }, knob);
    let drag = null; // {x, y}
    let sendTimer = null;
    const padVec = (e) => {
      const r = pad.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2 - 17;
      let dx = (e.clientX - cx) / rad, dy = (cy - e.clientY) / rad; // oben = Tilt hoch
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      return { x: dx, y: dy };
    };
    const showKnob = (v) => { knob.style.left = `${50 + v.x * 41}%`; knob.style.top = `${50 - v.y * 41}%`; };
    const sendMove = () => { if (drag) call("move", { pan: drag.x * speedScale, tilt: drag.y * speedScale }, true); };
    const endDrag = () => {
      if (!drag) return;
      drag = null; clearInterval(sendTimer); sendTimer = null; showKnob({ x: 0, y: 0 });
      call("stop", {}, true);
    };
    pad.addEventListener("pointerdown", (e) => { pad.setPointerCapture(e.pointerId); drag = padVec(e); showKnob(drag); sendMove(); sendTimer = setInterval(sendMove, 300); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (drag) { drag = padVec(e); showKnob(drag); } });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) pad.addEventListener(ev, endDrag);

    // ── Zoom: gehaltene Taste
    let zoomHold = null;
    const holdBtn = (label, dir) => {
      const b = h("button", {}, label);
      const stopZoom = () => { if (zoomHold === null) return; clearInterval(zoomHold); zoomHold = null; call("zoom", { speed: 0 }, true); };
      b.addEventListener("pointerdown", (e) => { b.setPointerCapture(e.pointerId); const go = () => call("zoom", { speed: dir * speedScale }, true); go(); zoomHold = setInterval(go, 300); e.preventDefault(); });
      for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, stopZoom);
      return b;
    };
    const stopAll = () => { endDrag(); call("stop", {}, true); };
    window.addEventListener("blur", stopAll);
    this._blur = stopAll;

    const speedInput = h("input", { type: "range", min: "5", max: "100", value: String(speedScale * 100), oninput: (e) => { speedScale = Number(e.target.value) / 100; } });
    const stopBtn = h("button", { class: "stop", onclick: () => call("stop") }, T("stop"));
    const homeBtn = h("button", { onclick: () => call("home") }, T("home"));
    const posEl = h("div", { class: "pos" });

    const padBox = h("div", { class: "box" }, h("h4", {}, T("pad")), pad);
    const zoomBox = h("div", { class: "box" }, h("h4", {}, T("zoom")), h("div", { class: "zoomcol" }, holdBtn(T("tele") + " +", 1), holdBtn(T("wide") + " −", -1)));
    const sideBox = h("div", { class: "box" }, h("h4", {}, T("speed")),
      h("div", {}, T("slow"), " ", speedInput, " ", T("fast")), h("div", { style: "margin:10px 0; display:flex; gap:8px" }, stopBtn, homeBtn),
      h("h4", {}, T("pos")), posEl);

    // ── Voreinstellungen
    const nameInput = h("input", { type: "text", placeholder: T("nameFor"), maxlength: "40", style: "width:180px" });
    const modeBtns = {};
    for (const [k, label] of [["recall", T("recall")], ["store", T("store")], ["clear", T("clear")]]) {
      modeBtns[k] = h("button", { class: k === mode ? "on" : "", onclick: () => { mode = k; for (const [kk, b] of Object.entries(modeBtns)) b.className = kk === mode ? "on" : ""; } }, label);
    }
    const grid = h("div", { class: "grid" });
    const presetClick = async (p) => {
      if (mode === "recall") await call("recall", { preset: p.preset });
      else if (mode === "store") await call("store", { preset: p.preset, name: nameInput.value });
      else await call("clearPreset", { preset: p.preset });
      poll();
    };
    const presetBox = h("div", { class: "box", style: "flex:1; min-width:360px" }, h("h4", {}, T("presets")),
      h("div", { class: "modes" }, h("span", { class: "muted" }, T("mode")), modeBtns.recall, modeBtns.store, modeBtns.clear, nameInput), grid);

    // ── Kopf und Einstellungen
    const linkChip = h("span", { class: "chip" });
    const targetInput = h("input", { type: "text", style: "width:200px" });
    const head = h("div", { class: "bar" }, h("label", {}, T("link"), linkChip),
      h("label", {}, T("target"), h("span", {}, targetInput, " ", h("button", { onclick: async () => { if (await call("setTarget", { target: targetInput.value })) poll(); } }, T("apply")))),
      h("span", { class: "muted", id: "model" }));
    const numField = (param, key) => h("input", { type: "number", style: "width:80px", "data-p": param, onchange: (e) => setParam(param, Number(e.target.value)) });
    const holdIn = numField("holdMs"), panIn = numField("panMax"), tiltIn = numField("tiltMax");
    const evEl = h("div");
    const setSec = h("details", { class: "sec" }, h("summary", {}, T("settings")), h("div", { class: "body" },
      h("div", { class: "bar" }, h("label", {}, T("hold"), holdIn), h("label", {}, T("panMax"), panIn), h("label", {}, T("tiltMax"), tiltIn)), h("p", { class: "hint" }, T("hint"))));
    const evSec = h("details", { class: "sec" }, h("summary", {}, T("events")), h("div", { class: "body" }, evEl));

    const render = () => {
      linkChip.textContent = (st.simulated ? T("sim") + " · " : "") + (st.linkUp ? T("linkUp") : T("linkDown"));
      linkChip.className = `chip${st.linkUp ? (st.simulated ? " sim" : "") : " down"}`;
      shadow.getElementById("model").textContent = st.model || "";
      posEl.textContent = st.panPos === null ? "—" : `pan ${st.panPos}   tilt ${st.tiltPos}   zoom ${st.zoomPos ?? "—"}\n${T("errors")}: ${st.errors}`;
      posEl.style.whiteSpace = "pre";
      const typing = shadow.activeElement && shadow.activeElement.tagName === "INPUT";
      if (!typing || shadow.activeElement === speedInput) {
        grid.replaceChildren(...st.presets.map((p) => h("button", { class: p.stored ? "" : "empty", title: p.stored ? p.name : T("empty"), onclick: () => presetClick(p) }, `${p.preset} · ${p.name}`)));
      }
      evEl.replaceChildren(...(st.events.length ? st.events.slice().reverse().map((e) => h("div", { class: "ev" }, `#${e.event.seq} ${e.subject} ${JSON.stringify({ up: e.event.up, preset: e.event.preset, what: e.event.what, text: e.event.text })}`)) : [h("span", { class: "muted" }, T("noEvents"))]));
    };
    shadow.addEventListener("contextmenu", (e) => { if (e.target && e.target.closest && e.target.closest("button")) e.preventDefault(); });
    shadow.append(h("style", {}, STYLE), banner, head, h("div", { class: "ctl" }, padBox, zoomBox, sideBox, presetBox), setSec, evSec);

    const poll = async () => {
      try {
        const names = ["linkUp", "simulated", "target", "model", "panPos", "tiltPos", "zoomPos", "presets", "recent", "cameraErrors", "holdMs", "panMax", "tiltMax"];
        const v = await Promise.all(names.map(getParam));
        const g = Object.fromEntries(names.map((n, i) => [n, v[i]]));
        st = { linkUp: !!g.linkUp, simulated: !!g.simulated, target: g.target || "", model: g.model || "", panPos: g.panPos ?? null, tiltPos: g.tiltPos ?? null, zoomPos: g.zoomPos ?? null,
          presets: g.presets ? JSON.parse(g.presets) : [], events: g.recent ? JSON.parse(g.recent) : [], errors: g.cameraErrors || 0 };
        if (shadow.activeElement !== targetInput) targetInput.value = st.target;
        for (const [el, val] of [[holdIn, g.holdMs], [panIn, g.panMax], [tiltIn, g.tiltMax]]) if (shadow.activeElement !== el && val !== undefined) el.value = String(val);
        render();
      } catch { /* nächster Takt */ }
    };
    poll();
    this._i = setInterval(poll, 400);
  }
  disconnectedCallback() { clearInterval(this._i); if (this._blur) window.removeEventListener("blur", this._blur); }
}
if (!customElements.get("omp-ptz-panel")) customElements.define("omp-ptz-panel", OmpPtzPanel);
