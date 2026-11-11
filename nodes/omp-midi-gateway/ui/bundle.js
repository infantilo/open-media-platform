// Bedienfeld von omp-midi-gateway (Kapitel 93): Status der Pulte, Einheiten einrichten (USB-Rohgerät, RTP-MIDI, Simulator), Mischer wählen,
// Profil (Betriebsart „profile“), Simulator-Bedienung, letzte Ereignisse. Generische Node-Proxy-API; eigenes Mini-t() (Sprache aus <html lang>).
const T = (() => {
  const D = {
    de: {
      status: "Status", running: "läuft", stopped: "nicht gestartet", mode: "Betriebsart", modeMcu: "Mackie Control (Mischpult)", modeProfile: "Generisches Profil",
      mixer: "Audiomischer (Anzeigename)", masterAux: "Master-Fader führt Aux-Bus (ID)", mixerFound: "Mischer gefunden", mixerMissing: "Mischer nicht gefunden",
      bank: "Bank {n} · {c} Kanäle", units: "Einheiten", colUnit: "Nr.", colType: "Art", colName: "Name", colUp: "Anschluss", colOnline: "Pult meldet sich",
      up: "ja", down: "nein", add: "Einheit hinzufügen", remove: "Entfernen", raw: "USB (Rohgerät)", rtpListen: "Netzwerk: Gerät lädt uns ein (Port)", rtpConnect: "Netzwerk: wir laden ein (Host:Port)", sim: "Simulator",
      detected: "Erkannte USB-MIDI-Geräte", noneDetected: "Keine Rohgeräte unter /dev/snd gefunden (Gerät eingesteckt? Gruppe „audio“?).", save: "Speichern und neu starten", saved: "Gespeichert.",
      profile: "Profil (JSON)", events: "Letzte Ereignisse", noEvents: "Noch keine Ereignisse.", sim_title: "Simulator-Pult {n}", strip: "Kanalzug", touch: "Berühren", release: "Loslassen",
      press: "Taste", turn: "Drehgeber +1", turnBack: "Drehgeber −1", linkDrop: "Verbindung trennen/herstellen", fail: "{m} fehlgeschlagen: {d}", lastMidi: "Zuletzt erkannt",
      keys: "Tasten, Funktionsfeld und Jog (JSON, leer = Standardbelegung)", keysHint: "Standard: F1–F8 wirken auf den gewählten Kanal (Mute, PFL, Phase, EQ-Bypass, Comp, Gate, Main, Alle Mute aus), Pfeile wählen Kanal / ±1 dB, „Solo“ löscht das Vorhören, Scrub schaltet das Jog-Rad, die acht Ansichtstasten wählen Seiten. Nicht belegte Tasten (Play, Stop …) kommen als Ereignis „button.<Name>“.", fkeys: "Funktionstasten, Seiten, Jog", example: "Beispiel einfügen",
      hint: "USB-Pulte erscheinen als Rohgerät; Netzwerk-Pulte sprechen RTP-MIDI (AppleMIDI). Ohne Gerät lässt sich alles mit dem Simulator prüfen.",
    },
    en: {
      status: "Status", running: "running", stopped: "not started", mode: "Mode", modeMcu: "Mackie Control (mixing console)", modeProfile: "Generic profile",
      mixer: "Audio mixer (display name)", masterAux: "Master fader drives aux bus (ID)", mixerFound: "Mixer found", mixerMissing: "Mixer not found",
      bank: "Bank {n} · {c} channels", units: "Units", colUnit: "No.", colType: "Type", colName: "Name", colUp: "Port", colOnline: "Surface responding",
      up: "yes", down: "no", add: "Add unit", remove: "Remove", raw: "USB (raw device)", rtpListen: "Network: device invites us (port)", rtpConnect: "Network: we invite (host:port)", sim: "Simulator",
      detected: "Detected USB MIDI devices", noneDetected: "No raw devices under /dev/snd (device plugged in? group “audio”?).", save: "Save and restart", saved: "Saved.",
      profile: "Profile (JSON)", events: "Recent events", noEvents: "No events yet.", sim_title: "Simulated surface {n}", strip: "Channel strip", touch: "Touch", release: "Release",
      press: "Key", turn: "Knob +1", turnBack: "Knob −1", linkDrop: "Drop/restore link", fail: "{m} failed: {d}", lastMidi: "Last seen",
      keys: "Keys, function field and jog (JSON, empty = default mapping)", keysHint: "Default: F1–F8 act on the selected channel (mute, PFL, phase, EQ bypass, comp, gate, main, clear mutes), arrows select channel / ±1 dB, “Solo” clears listening, Scrub switches the jog wheel, the eight view keys choose pages. Unmapped keys (play, stop …) arrive as event “button.<name>”.", fkeys: "Function keys, pages, jog", example: "Insert example",
      hint: "USB surfaces appear as raw devices; network surfaces speak RTP-MIDI (AppleMIDI). Everything can be checked with the simulator when no device is at hand.",
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
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; }
  * { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; color: inherit; }
  input, select, textarea { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 4px 9px; -webkit-user-select: none; user-select: none; }
  button:hover { border-color: var(--acc); }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 10px; background: var(--ok); color: #fff; font-weight: 600; white-space: nowrap; }
  .chip.down { background: var(--err); } .chip.idle { background: var(--bg3); color: var(--mut); }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; }
  .banner.show { display: block; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; } th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 4px; } td { padding: 2px 4px; }
  textarea { width: 100%; min-height: 140px; font-family: monospace; font-size: 11px; }
  .hint, .muted { color: var(--mut); } .ev { font-variant-numeric: tabular-nums; padding: 1px 0; font-family: monospace; }
  .lcd { font-family: monospace; background: #1b2a1b; color: #9f9; padding: 2px 5px; border-radius: 3px; white-space: pre; margin: 2px 0; }
  .strips { display: flex; gap: 6px; margin: 6px 0; align-items: flex-end; }
  .sfd { display: flex; flex-direction: column; align-items: center; width: 46px; }
  .fader { position: relative; width: 34px; height: 128px; user-select: none; -webkit-user-select: none; touch-action: none; outline: none; }
  .fader:focus-visible { outline: 1px solid var(--acc); }
  .ftrack { position: absolute; left: 50%; top: 6px; bottom: 6px; width: 4px; margin-left: -2px; background: #020202; border: 1px solid #333; border-radius: 3px; }
  .fzero { position: absolute; left: 3px; right: 3px; height: 1px; background: #777; }
  .fthumb { position: absolute; left: 50%; width: 26px; height: 14px; margin-left: -13px; border-radius: 3px; border: 1px solid #000;
    background: repeating-linear-gradient(#bdbdbd 0 2px, #7c7c7c 2px 3px), linear-gradient(90deg, #6a6a6a, #d8d8d8 40%, #9c9c9c 60%, #5a5a5a); box-shadow: 0 2px 4px #000c, 0 1px 0 #fff6 inset; }
  .fader.drag .fthumb { filter: brightness(1.15); } .fader.fine .fthumb { outline: 2px dashed #e8a33a; }
  .fread { font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--acc); white-space: nowrap; margin-top: 2px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
`;

// Fader im Stil der Audiomischer-Fader (nodes/omp-audio-mixer/ui/00-core.js): gleiche Kennlinie, Griff, Nullmarke, dB-Anzeige,
// Ziehen (seitlich weg oder Shift = fein), Doppelklick = 0 dB. Berühren/Ziehen/Loslassen gehen als simulateTouch/simulateMove an das Pult.
const FADER_POINTS = [[0, -60], [0.15, -40], [0.35, -20], [0.55, -10], [0.75, 0], [1, 12]];
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const posToDb = (p) => { p = clampN(p, 0, 1); for (let i = 1; i < FADER_POINTS.length; i++) { const [p0, d0] = FADER_POINTS[i - 1], [p1, d1] = FADER_POINTS[i]; if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0); } return 12; };
const dbToPos = (db) => { db = clampN(db, -60, 12); for (let i = 1; i < FADER_POINTS.length; i++) { const [p0, d0] = FADER_POINTS[i - 1], [p1, d1] = FADER_POINTS[i]; if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0); } return 1; };
const fmtDbSigned = (v) => (v > 0.0001 ? "+" : v < -0.0001 ? "−" : "") + Math.abs(v).toFixed(1);

class SimFader {
  constructor({ onTouch, onMove }) {
    this.onTouch = onTouch; this.onMove = onMove; this.v = 0; this.dragging = false; this.fine = false; this.lastTap = 0; this.lastSend = 0;
    this.root = h("div", { class: "fader", tabindex: "0", role: "slider", "aria-valuemin": "-60", "aria-valuemax": "12" });
    this.track = h("div", { class: "ftrack" }); this.zero = h("i", { class: "fzero" }); this.thumb = h("div", { class: "fthumb" });
    this.track.append(this.zero, this.thumb); this.root.append(this.track);
    this.read = h("span", { class: "fread" }); this.wrap = h("div", { class: "sfd" }, this.root, this.read);
    this.root.addEventListener("pointerdown", (e) => this.down(e)); this.root.addEventListener("pointermove", (e) => this.move(e));
    this.root.addEventListener("pointerup", (e) => this.up(e)); this.root.addEventListener("pointercancel", (e) => this.up(e));
    this.root.addEventListener("keydown", (e) => this.key(e));
    this.render();
  }
  setValue(v14) { if (this.dragging) return; this.v = clampN(v14, 0, 16383); this.render(); }
  db() { return Math.round(posToDb(this.v / 16383) * 10) / 10; }
  render() {
    this.thumb.style.bottom = `calc(${(this.v / 16383) * 100}% - 7px)`;
    this.zero.style.bottom = `${dbToPos(0) * 100}%`;
    const db = this.db(); this.read.textContent = db <= -59.5 ? "−∞" : fmtDbSigned(db) + " dB";
  }
  pos(e) { const r = this.track.getBoundingClientRect(); return clampN(1 - (e.clientY - r.top) / r.height, 0, 1); }
  emit(pos, force) {
    let db = posToDb(pos); if (Math.abs(db) < 0.4) db = 0;
    this.v = Math.round(dbToPos(db) * 16383); this.render();
    const now = performance.now(); if (force || now - this.lastSend > 60) { this.lastSend = now; this.onMove(this.v); } else this.pendingSend = true;
  }
  down(e) {
    if (e.button !== 0) return;
    const now = performance.now();
    if (now - this.lastTap < 320) { this.lastTap = 0; this.onTouch(true); this.emit(dbToPos(0), true); this.onTouch(false); e.preventDefault(); return; }
    this.lastTap = now;
    try { this.root.setPointerCapture(e.pointerId); } catch { /* künstliches Ereignis */ }
    this.dragging = true; this.fine = false; this.root.classList.add("drag"); this.onTouch(true);
    const start = this.pos(e), tr = this.thumb.getBoundingClientRect();
    const onThumb = e.clientX >= tr.left - 8 && e.clientX <= tr.right + 8 && e.clientY >= tr.top - 8 && e.clientY <= tr.bottom + 8;
    this.anchorPos = onThumb ? this.v / 16383 : start; this.anchorPtr = start;
    if (!onThumb) this.emit(start, true);
    e.preventDefault();
  }
  move(e) {
    if (!this.dragging) return;
    const r = this.root.getBoundingClientRect(), off = Math.abs(e.clientX - (r.left + r.width / 2)), fine = e.shiftKey || off > 70;
    if (fine !== this.fine) { this.fine = fine; this.anchorPos = this.v / 16383; this.anchorPtr = this.pos(e); this.root.classList.toggle("fine", fine); }
    this.emit(clampN(this.anchorPos + (this.pos(e) - this.anchorPtr) * (fine ? 0.2 : 1), 0, 1), false);
  }
  up(e) {
    if (!this.dragging) return;
    this.dragging = false; this.root.classList.remove("drag", "fine");
    try { this.root.releasePointerCapture(e.pointerId); } catch { /* schon frei */ }
    this.onMove(this.v); this.onTouch(false);
  }
  key(e) {
    const step = e.shiftKey ? 0.1 : 0.5, db = this.db(); let n = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") n = db + step; else if (e.key === "ArrowDown" || e.key === "ArrowLeft") n = db - step;
    else if (e.key === "PageUp") n = db + 3; else if (e.key === "PageDown") n = db - 3; else if (e.key === "Home") n = 0;
    if (n === null) return; e.preventDefault(); this.onTouch(true); this.emit(dbToPos(clampN(n, -60, 12)), true); this.onTouch(false);
  }
}

class OmpMidiGatewayPanel extends HTMLElement {
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

    let status = { running: false }, cfg = { mixer: "", masterAux: "", mode: "mcu", units: [], profile: null }, ports = [], events = [];
    let editing = false; // Formular wird gerade bearbeitet → nicht überschreiben

    const chipEl = h("span", { class: "chip idle" });
    const infoEl = h("span", { class: "muted" });
    const head = h("div", { class: "bar" }, h("label", {}, T("status"), chipEl), infoEl);

    // Einrichtung
    const mixerIn = h("input", { type: "text", style: "min-width:180px" });
    const auxIn = h("input", { type: "text", style: "width:90px" });
    const modeSel = h("select", {}, h("option", { value: "mcu" }, T("modeMcu")), h("option", { value: "profile" }, T("modeProfile")));
    const profArea = h("textarea", { spellcheck: "false" });
    const profLabel = h("div", {}, h("div", { class: "muted" }, T("profile")), profArea);
    const keysArea = h("textarea", { spellcheck: "false", style: "min-height:110px" });
    const EXAMPLE_KEYS = { pages: [{ name: "Kanal", keys: { f1: { label: "Mute", action: "toggle", method: "channel.{ch}.setMute", arg: "muted", led: "mute" }, f3: { label: "Phase", action: "toggle", method: "channel.{ch}.setPhase", arg: "invert", led: "proc.phaseInvert" } } }, { name: "Wiedergabe", keys: { f1: { label: "Play", action: "call", node: "Player", method: "play" } } }], global: { play: { label: "Play", action: "call", node: "Player", method: "play" } }, jog: [{ name: "Pegel", kind: "gain" }, { name: "Wahl", kind: "select" }] };
    const keysLabel = h("div", {}, h("div", { class: "muted" }, T("keys")), keysArea, h("div", { class: "row" }, h("button", { onclick: () => { editing = true; keysArea.value = JSON.stringify(EXAMPLE_KEYS, null, 2); } }, T("example"))), h("p", { class: "hint" }, T("keysHint")));
    const unitBody = h("tbody");
    const typeSel = h("select", {}, h("option", { value: "raw" }, T("raw")), h("option", { value: "rtpListen" }, T("rtpListen")), h("option", { value: "rtpConnect" }, T("rtpConnect")), h("option", { value: "sim" }, T("sim")));
    const valIn = h("input", { type: "text", style: "min-width:200px", placeholder: "/dev/snd/midiC1D0 | 5004 | 192.168.1.20:5004" });
    const portList = h("div");
    for (const el of [mixerIn, auxIn, modeSel, profArea, keysArea, valIn]) el.addEventListener("input", () => { editing = true; });
    const syncProf = () => { profLabel.style.display = modeSel.value === "profile" ? "" : "none"; keysLabel.style.display = modeSel.value === "profile" ? "none" : ""; };
    modeSel.addEventListener("change", syncProf);

    const unitCfgOf = () => {
      const t = typeSel.value, v = valIn.value.trim();
      if (t === "raw") return { type: "raw", path: v };
      if (t === "rtpListen") return { type: "rtp", listen: Number(v) };
      if (t === "rtpConnect") return { type: "rtp", connect: v };
      return { type: "sim" };
    };
    const describeUnit = (u) => (u.type === "raw" ? u.path : u.type === "rtp" ? (u.listen ? `RTP :${u.listen}` : `RTP → ${u.connect}`) : T("sim"));
    const renderUnits = () => unitBody.replaceChildren(...cfg.units.map((u, i) => h("tr", {}, h("td", {}, i + 1), h("td", {}, describeUnit(u)),
      h("td", {}, h("button", { onclick: () => { editing = true; cfg.units.splice(i, 1); renderUnits(); } }, T("remove"))))));
    const add = h("button", { onclick: () => { editing = true; cfg.units.push(unitCfgOf()); valIn.value = ""; renderUnits(); } }, T("add"));
    const saveBtn = h("button", { onclick: async () => {
      let profile = null;
      if (modeSel.value === "profile") { try { profile = JSON.parse(profArea.value); } catch (e) { show(String(e.message)); return; } }
      let keys = null;
      if (modeSel.value === "mcu" && keysArea.value.trim()) { try { keys = JSON.parse(keysArea.value); } catch (e) { show(String(e.message)); return; } }
      const next = { mixer: mixerIn.value.trim(), masterAux: auxIn.value.trim(), mode: modeSel.value, units: cfg.units, profile, keys };
      if (await call("setConfig", { config: JSON.stringify(next) })) { editing = false; show(T("saved")); poll(true); }
    } }, T("save"));
    const setupSec = h("details", { class: "sec", open: true }, h("summary", {}, T("units")), h("div", { class: "body" },
      h("div", { class: "bar" }, h("label", {}, T("mode"), modeSel), h("label", {}, T("mixer"), mixerIn), h("label", {}, T("masterAux"), auxIn)),
      h("table", {}, h("thead", {}, h("tr", {}, [T("colUnit"), T("colName"), ""].map((x) => h("th", {}, x)))), unitBody),
      h("div", { class: "row" }, typeSel, valIn, add), profLabel, keysLabel, h("div", { class: "row" }, saveBtn), h("p", { class: "hint" }, T("hint"))));
    const detSec = h("details", { class: "sec" }, h("summary", {}, T("detected")), h("div", { class: "body" }, portList));

    // Betrieb
    const liveBody = h("tbody");
    const liveSec = h("details", { class: "sec", open: true }, h("summary", {}, T("status")), h("div", { class: "body" },
      h("table", {}, h("thead", {}, h("tr", {}, [T("colUnit"), T("colType"), T("colName"), T("colUp"), T("colOnline")].map((x) => h("th", {}, x)))), liveBody)));
    const simBox = h("div");
    const evEl = h("div");
    const evSec = h("details", { class: "sec" }, h("summary", {}, T("events")), h("div", { class: "body" }, evEl));
    shadow.append(h("style", {}, STYLE), banner, head, liveSec, simBox, setupSec, detSec, evSec);

    const simSel = { strip: "1" }; // überlebt das Neuzeichnen
    const faders = {}; // Fader bleiben beim Neuzeichnen erhalten (ein Zug am Fader wird nicht unterbrochen)
    const simUnit = (u) => {
      const n = u.unit;
      const stripIn = h("input", { type: "number", min: "1", max: "9", value: simSel.strip, style: "width:60px", oninput: (e) => { simSel.strip = e.target.value; } });
      const strip = () => Math.max(0, Math.min(8, (Number(stripIn.value) || 1) - 1));
      const keys = ["mute", "solo", "select", "rec"];
      return h("details", { class: "sec", open: true }, h("summary", {}, T("sim_title", { n })), h("div", { class: "body" },
        h("div", { class: "lcd" }, u.sim.lcd[0]), h("div", { class: "lcd" }, u.sim.lcd[1]),
        h("div", { class: "strips" }, ...u.sim.faders.map((v, i) => {
          const f = faders[`${n}:${i}`] ??= new SimFader({ onTouch: (d) => call("simulateTouch", { unit: n, strip: i, down: d }), onMove: (x) => call("simulateMove", { unit: n, strip: i, value: x }) });
          f.setValue(v);
          return f.wrap;
        })),
        h("div", { class: "row" }, h("label", {}, T("strip"), stripIn),
          h("button", { onclick: () => call("simulateTurn", { unit: n, strip: Math.min(7, strip()), steps: 1 }) }, T("turn")), h("button", { onclick: () => call("simulateTurn", { unit: n, strip: Math.min(7, strip()), steps: -1 }) }, T("turnBack"))),
        h("div", { class: "row" }, ...keys.map((k) => h("button", { onclick: () => call("simulatePress", { unit: n, name: k + (strip() + 1) }) }, `${k} ${T("press")}`)),
          ...["bankLeft", "bankRight", "channelLeft", "channelRight", "nameValue", "play", "f1"].map((k) => h("button", { onclick: () => call("simulatePress", { unit: n, name: k }) }, k)),
          h("button", { onclick: () => call("simulateLink", { unit: n, up: !u.up }) }, T("linkDrop"))),
        h("div", { class: "muted" }, T("fkeys")),
        h("div", { class: "row" }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => h("button", { onclick: () => call("simulatePress", { unit: n, name: "f" + i }) }, "F" + i)),
          ...["midiTracks", "inputs", "audioTracks", "audioInstruments", "aux", "busses", "outputs", "user"].map((k, i) => h("button", { title: k, onclick: () => call("simulatePress", { unit: n, name: k }) }, "P" + (i + 1)))),
        h("div", { class: "row" }, h("button", { onclick: () => call("simulateJog", { unit: n, steps: -1 }) }, "Jog ⟲"), h("button", { onclick: () => call("simulateJog", { unit: n, steps: 1 }) }, "Jog ⟳"),
          ...["scrub", "soloGlobal", "left", "right", "up", "down", "play", "stop"].map((k) => h("button", { onclick: () => call("simulatePress", { unit: n, name: k }) }, k)))));
    };

    const render = () => {
      chipEl.textContent = status.running ? T("running") : T("stopped");
      chipEl.className = `chip${status.running ? "" : " idle"}`;
      const bits = [];
      if (status.mode === "mcu") bits.push(status.mixerFound ? T("mixerFound") : T("mixerMissing"), T("bank", { n: Math.floor((status.bank || 0) / Math.max(1, status.strips || 8)) + 1, c: status.channels || 0 }));
      if (status.mode === "profile" && status.lastMidi) bits.push(`${T("lastMidi")}: ${status.lastMidi}`);
      if (status.error) bits.push(status.error);
      infoEl.textContent = bits.join(" · ");
      liveBody.replaceChildren(...(status.units || []).map((u) => h("tr", {}, h("td", {}, u.unit), h("td", {}, u.type), h("td", {}, u.name + (u.version ? ` (${u.version})` : "")),
        h("td", {}, u.up ? T("up") : T("down")), h("td", {}, u.online ? T("up") : T("down")))));
      simBox.replaceChildren(...(status.units || []).filter((u) => u.sim).map(simUnit));
      evEl.replaceChildren(...(events.length ? events.slice().reverse().map((e) => h("div", { class: "ev" }, `#${e.event.seq} ${e.subject} ${JSON.stringify({ name: e.event.name, down: e.event.down, up: e.event.up, value: e.event.value })}`)) : [h("span", { class: "muted" }, T("noEvents"))]));
      portList.replaceChildren(...(ports.length ? ports.map((p) => h("div", { class: "row" }, h("code", {}, p.path), h("span", { class: "muted" }, p.name + (p.hint ? ` — ${p.hint}` : "")),
        h("button", { onclick: () => { editing = true; cfg.units.push({ type: "raw", path: p.path }); renderUnits(); } }, T("add")))) : [h("span", { class: "muted" }, T("noneDetected"))]));
    };

    const poll = async (force) => {
      try {
        const [s, c, p, r] = await Promise.all(["status", "config", "ports", "recent"].map(getParam));
        if (s) status = JSON.parse(s);
        if (p) ports = JSON.parse(p);
        if (r) events = JSON.parse(r);
        if (c && (!editing || force)) {
          cfg = JSON.parse(c);
          mixerIn.value = cfg.mixer || ""; auxIn.value = cfg.masterAux || ""; modeSel.value = cfg.mode || "mcu";
          profArea.value = cfg.profile ? JSON.stringify(cfg.profile, null, 2) : "";
          keysArea.value = cfg.keys ? JSON.stringify(cfg.keys, null, 2) : "";
          syncProf(); renderUnits();
        }
        // Eingabefelder behalten den Fokus; die Statusanzeige läuft weiter
        if (!Object.values(faders).some((f) => f.dragging)) render();
      } catch { /* nächster Takt */ }
    };
    shadow.addEventListener("contextmenu", (e) => { if (e.target && e.target.closest && e.target.closest("button")) e.preventDefault(); });
    poll(true);
    this._i = setInterval(poll, 700);
  }
  disconnectedCallback() { clearInterval(this._i); }
}
if (!customElements.get("omp-midi-gateway-panel")) customElements.define("omp-midi-gateway-panel", OmpMidiGatewayPanel);
