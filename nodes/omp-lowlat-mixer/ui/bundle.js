// Studio-Mischer (niedrige Latenz) — Bedienfeld. i18n (de/en): Sprache aus <html lang>, Fallback Deutsch.
// Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
      "ll.strips": "Eingänge", "ll.buses": "Busse", "ll.mute": "Mute", "ll.source": "Quelle", "ll.sends": "Sends (dB)",
      "ll.clock": "Takt", "ll.block": "Block", "ll.rt": "Echtzeit", "ll.rt.no": "nein (Rechte fehlen)", "ll.rt.yes": "ja",
      "ll.proc": "Rechenzeit", "ll.misses": "verpasste Takte", "ll.under": "Unterläufe", "ll.slips": "Driftausgleich",
      "ll.grown": "Reserve gewachsen", "ll.xruns": "ALSA-Aussetzer", "ll.alsaout": "ALSA-Ausgang (Kanal)", "ll.off": "aus",
      "ll.mixminus": "Mix-minus für …", "ll.mixminus.do": "setzen", "ll.clear": "Sends leeren", "ll.buf": "Reserve",
      "ll.help": "Quelle: off, mxl (NMOS-Verbindung), alsa:K oder alsa:K-L (Karte), aes:K oder aes:K-L (AES67). Mix-minus: Bus bekommt alle Streifen außer dem gewählten.",
      "ll.err": "Keine Verbindung zum Node", "ll.detail": "EQ / Dynamik", "ll.eq": "EQ", "ll.hp": "Hochpass", "ll.on": "an", "ll.comp": "Kompressor",
      "ll.gate": "Gate / Expander", "ll.phase": "Phase drehen", "ll.bypass": "EQ Bypass", "ll.band": "Band", "ll.freq": "Frequenz", "ll.q": "Güte", "ll.gain": "Pegel",
      "ll.thr": "Schwelle", "ll.ratio": "Verhältnis", "ll.attack": "Attack", "ll.release": "Release", "ll.knee": "Knie", "ll.makeup": "Makeup", "ll.rms": "RMS",
      "ll.range": "Bereich", "ll.hold": "Halten", "ll.hyst": "Hysterese", "ll.close": "schließen", "ll.limiter": "Limiter", "ll.ceiling": "Obergrenze",
      "ll.nolat": "EQ, Gate, Kompressor und Limiter arbeiten ohne Vorausschau — sie fügen keine Latenz hinzu.", "ll.gr": "Absenkung", "ll.aes": "AES67", "ll.lost": "verloren", "ll.pkts": "Pakete", "ll.alsain": "ALSA-Eingang",
    },
    en: {
      "ll.strips": "Inputs", "ll.buses": "Buses", "ll.mute": "Mute", "ll.source": "Source", "ll.sends": "Sends (dB)",
      "ll.clock": "Clock", "ll.block": "Block", "ll.rt": "Real-time", "ll.rt.no": "no (privileges missing)", "ll.rt.yes": "yes",
      "ll.proc": "Processing", "ll.misses": "missed ticks", "ll.under": "underruns", "ll.slips": "Drift correction",
      "ll.grown": "Reserve grown", "ll.xruns": "ALSA dropouts", "ll.alsaout": "ALSA output (channel)", "ll.off": "off",
      "ll.mixminus": "Mix-minus for …", "ll.mixminus.do": "apply", "ll.clear": "Clear sends", "ll.buf": "Reserve",
      "ll.help": "Source: off, mxl (NMOS connection), alsa:K or alsa:K-L (card), aes:K or aes:K-L (AES67). Mix-minus: the bus gets every strip except the chosen one.",
      "ll.err": "No connection to the node", "ll.detail": "EQ / Dynamics", "ll.eq": "EQ", "ll.hp": "High-pass", "ll.on": "on", "ll.comp": "Compressor",
      "ll.gate": "Gate / expander", "ll.phase": "Invert phase", "ll.bypass": "EQ bypass", "ll.band": "Band", "ll.freq": "Frequency", "ll.q": "Q", "ll.gain": "Gain",
      "ll.thr": "Threshold", "ll.ratio": "Ratio", "ll.attack": "Attack", "ll.release": "Release", "ll.knee": "Knee", "ll.makeup": "Makeup", "ll.rms": "RMS",
      "ll.range": "Range", "ll.hold": "Hold", "ll.hyst": "Hysteresis", "ll.close": "close", "ll.limiter": "Limiter", "ll.ceiling": "Ceiling",
      "ll.nolat": "EQ, gate, compressor and limiter work without lookahead — they add no latency.", "ll.gr": "Reduction", "ll.aes": "AES67", "ll.lost": "lost", "ll.pkts": "packets", "ll.alsain": "ALSA input",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
})();

const CSS = `
  :host { display: block; font: 11px/1.25 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; color: #d8dde2;
    background: #111; padding: 8px; user-select: none; }
  h4 { margin: 8px 0 4px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #7d848c; font-weight: 700; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 5px 8px; background: #181818; border: 1px solid #000; border-radius: 2px; color: #aab2b9; }
  .stats b { color: #d8dde2; font-weight: 600; }
  .stats .bad b { color: #ff7a6b; }
  .row { display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap; }
  .col { width: 118px; background: linear-gradient(#1d1d1d, #151515); border: 1px solid #000; border-radius: 2px; padding: 6px; display: flex; flex-direction: column; gap: 5px; }
  .col.bus { width: 132px; }
  input[type=text], input[type=number] { width: 100%; box-sizing: border-box; background: #0b0b0b; color: #d8dde2; border: 1px solid #2a2a2a; border-radius: 2px;
    font: inherit; padding: 3px 4px; user-select: text; }
  .name { font-weight: 700; }
  .faderwrap { display: flex; gap: 6px; height: 150px; align-items: stretch; }
  .meter { width: 8px; background: #0a0a0a; border: 1px solid #000; position: relative; border-radius: 1px; overflow: hidden; }
  .meter i { position: absolute; left: 0; right: 0; bottom: 0; background: linear-gradient(to top, #2bb673 0%, #2bb673 70%, #e6c229 85%, #e64a3a 100%); transition: height .08s linear; }
  input[type=range].v { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 100%; margin: 0; accent-color: #32b6c6; }
  .db { text-align: right; color: #aab2b9; min-height: 12px; }
  button { font-family: inherit; font-weight: 700; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #d8dde2;
    background: linear-gradient(#3a3a3a, #262626); border: 1px solid #060606; border-radius: 2px; cursor: pointer; padding: 4px 8px;
    box-shadow: 0 1px 0 rgba(255,255,255,.12) inset, 0 1px 2px rgba(0,0,0,.5); }
  button:hover { background: linear-gradient(#444, #2d2d2d); }
  button.mute.on { background: linear-gradient(#e0533f, #a52f20); border-color: #ff8a78; color: #fff; }
  .send { display: grid; grid-template-columns: 22px 1fr 34px; gap: 3px; align-items: center; }
  .send input[type=range] { width: 100%; margin: 0; height: 10px; accent-color: #8a8cff; }
  .state { color: #7d848c; min-height: 12px; }
  .state.ok { color: #2bb673; }
  .help { margin-top: 8px; color: #7d848c; font-size: 10px; }
  select { background: #0b0b0b; color: #d8dde2; border: 1px solid #2a2a2a; font: inherit; border-radius: 2px; width: 100%; }
  .err { color: #ff7a6b; padding: 4px 0; }
  .detail { margin-top: 8px; background: #151515; border: 1px solid #000; border-radius: 2px; padding: 8px; }
  .detail .top { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
  .detail .grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .detail .sect { background: #1a1a1a; border: 1px solid #000; border-radius: 2px; padding: 6px; min-width: 190px; }
  .detail .sect h5 { margin: 0 0 4px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #7d848c; }
  .detail .p { display: grid; grid-template-columns: 78px 1fr 34px; gap: 4px; align-items: center; margin: 2px 0; }
  .detail .p input[type=number] { width: 100%; }
  .detail .p span.u { color: #7d848c; }
  .detail .bandrow { display: grid; grid-template-columns: 22px 1fr 1fr 1fr; gap: 4px; align-items: center; margin: 2px 0; }
  .detail .cap { color: #7d848c; font-size: 10px; margin-top: 4px; }
  svg.curve { background: #0b0b0b; border: 1px solid #000; border-radius: 2px; }
  button.on { background: linear-gradient(#32b6c6, #168593); color: #001a1f; border-color: #46e6f6; }
  .gr { color: #e6c229; }
`;

const MIN_DB = -90, MAX_DB = 12;
const meterPct = (db) => Math.max(0, Math.min(100, ((Number(db) + 60) / 60) * 100));
const fmtDb = (v) => (Number(v) <= MIN_DB ? "−∞" : (Number(v) >= 0 ? "+" : "") + Number(v).toFixed(1));

// Betragsgang der EQ-Bänder (RBJ-Audio-EQ-Cookbook, gleiche Formeln wie im Node) und Kennlinie des Kompressors
const FS = 48000;
function biquad(kind, f0, q, gdb) {
  const w0 = (2 * Math.PI * Math.min(Math.max(f0, 10), FS * 0.45)) / FS, sw = Math.sin(w0), cw = Math.cos(w0);
  const Q = Math.min(Math.max(q, 0.1), 20), alpha = sw / (2 * Q), A = Math.pow(10, gdb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (kind === "peak") { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
  else {
    const sq = 2 * Math.sqrt(A) * alpha;
    if (kind === "low") { b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq); a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq; }
    else { b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq); a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq; }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function respDb(c, f) {
  const w = (2 * Math.PI * f) / FS, [b0, b1, b2, a1, a2] = c;
  const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function drawEq(svg, p) {
  if (!svg) return;
  const W = 300, H = 100, KINDS = ["low", "peak", "peak", "high"];
  const coefs = [];
  if (!p["eq.bypass"]) {
    if (p["eq.hp.enabled"]) coefs.push(biquad("hp", p["eq.hp.freq"], Math.SQRT1_2, 0));
    for (let b = 1; b <= 4; b++) if (Math.abs(p[`eq.b${b}.gain`]) > 0.01) coefs.push(biquad(KINDS[b - 1], p[`eq.b${b}.freq`], p[`eq.b${b}.q`], p[`eq.b${b}.gain`]));
  }
  const x = (f) => (Math.log10(f / 20) / 3) * W, y = (db) => H / 2 - (db / 18) * (H / 2);
  let path = "";
  for (let i = 0; i <= 120; i++) {
    const f = 20 * Math.pow(1000, i / 120);
    const db = Math.max(-18, Math.min(18, coefs.reduce((a, c) => a + respDb(c, f), 0)));
    path += `${i ? "L" : "M"}${((i / 120) * W).toFixed(1)},${y(db).toFixed(1)}`;
  }
  const grid = [100, 1000, 10000].map((f) => `<line x1="${x(f)}" x2="${x(f)}" y1="0" y2="${H}" stroke="#222"/>`).join("") + [-12, -6, 0, 6, 12].map((g) => `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="${g === 0 ? "#333" : "#1c1c1c"}"/>`).join("");
  const dots = [1, 2, 3, 4].map((b) => `<circle cx="${x(p[`eq.b${b}.freq`]).toFixed(1)}" cy="${y(p[`eq.b${b}.gain`]).toFixed(1)}" r="3" fill="${p["eq.bypass"] ? "#555" : "#32b6c6"}"/>`).join("");
  svg.innerHTML = grid + `<path d="${path}" fill="none" stroke="${p["eq.bypass"] ? "#555" : "#46e6f6"}" stroke-width="1.5"/>` + dots;
}
function drawDyn(svg, p) {
  if (!svg) return;
  const S = 120, lo = -60, hi = 0, pos = (db) => ((db - lo) / (hi - lo)) * S;
  const thr = p["comp.threshold"], r = Math.max(p["comp.ratio"], 1), w = Math.max(p["comp.knee"], 0), mk = p["comp.makeup"], on = p["comp.enabled"];
  const out = (inDb) => {
    if (!on) return inDb;
    const over = inDb - thr;
    let o;
    if (2 * over < -w) o = inDb; else if (2 * Math.abs(over) <= w) o = inDb + ((1 / r - 1) * Math.pow(over + w / 2, 2)) / (2 * Math.max(w, 1e-9)); else o = thr + over / r;
    return o + mk;
  };
  let path = "";
  for (let i = 0; i <= 60; i++) {
    const inDb = lo + (i / 60) * (hi - lo), o = Math.max(lo, Math.min(hi + 12, out(inDb)));
    path += `${i ? "L" : "M"}${pos(inDb).toFixed(1)},${(S - pos(o)).toFixed(1)}`;
  }
  const gt = p["gate.enabled"] ? `<line x1="${pos(p["gate.threshold"])}" x2="${pos(p["gate.threshold"])}" y1="0" y2="${S}" stroke="#e6c229" stroke-dasharray="3 3"/>` : "";
  svg.innerHTML = `<line x1="0" y1="${S}" x2="${S}" y2="0" stroke="#222"/>` + gt + `<path d="${path}" fill="none" stroke="${on ? "#46e6f6" : "#555"}" stroke-width="1.5"/>`;
}

class OmpLowlatMixerPanel extends HTMLElement {
  connectedCallback() {
    this.nodeId = this.getAttribute("node-id");
    this.shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.root = document.createElement("div");
    this.shadow.append(style, this.root);
    this.shape = "";
    this.els = { strips: [], buses: [] };
    this.detail = 0; // Streifen, dessen EQ/Dynamik gezeigt wird (0 = keiner)
    this.busy = new Set(); // Bedienelemente, die gerade angefasst werden (nicht überschreiben)
    this.tick = this.tick.bind(this);
    this.timer = setInterval(this.tick, 200);
    this.tick();
  }

  disconnectedCallback() {
    clearInterval(this.timer);
  }

  async write(name, value) {
    try {
      await fetch(`/api/v1/nodes/${this.nodeId}/params/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    } catch (_) { /* nächste Abfrage zeigt den tatsächlichen Stand */ }
  }

  async call(method, body) {
    try {
      await fetch(`/api/v1/nodes/${this.nodeId}/methods/${encodeURIComponent(method)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    } catch (_) { /* s. o. */ }
  }

  async tick() {
    if (this._inflight) return;
    this._inflight = true;
    try {
      const res = await fetch(`/api/v1/nodes/${this.nodeId}/measurements${this.detail ? `?detail=${this.detail}` : ""}`);
      if (!res.ok) throw new Error(String(res.status));
      const snap = await res.json();
      this.build(snap);
      this.paint(snap);
    } catch (_) {
      if (!this.root.querySelector(".stats")) this.root.innerHTML = `<div class="err">${T("ll.err")}</div>`;
    } finally {
      this._inflight = false;
    }
  }

  /** Bedienelement mit „angefasst“-Markierung (Wert wird dann nicht von der Abfrage überschrieben). */
  guard(el, key) {
    el.addEventListener("pointerdown", () => this.busy.add(key));
    el.addEventListener("focus", () => this.busy.add(key));
    const free = () => setTimeout(() => this.busy.delete(key), 400);
    el.addEventListener("pointerup", free);
    el.addEventListener("blur", free);
    el.addEventListener("change", free);
  }

  build(snap) {
    const shape = `${snap.strips.length}x${snap.buses.length}`;
    if (shape === this.shape) return;
    this.shape = shape;
    this.els = { strips: [], buses: [] };
    this.busy.clear();
    const r = this.root;
    r.innerHTML = "";
    const stats = document.createElement("div");
    stats.className = "stats";
    r.append(stats);
    this.els.stats = stats;

    const h1 = document.createElement("h4");
    h1.textContent = T("ll.strips");
    const strips = document.createElement("div");
    strips.className = "row";
    r.append(h1, strips);
    for (const s of snap.strips) {
      const col = document.createElement("div");
      col.className = "col";
      const label = document.createElement("input");
      label.type = "text"; label.className = "name"; label.maxLength = 40;
      label.addEventListener("change", () => this.write(`strip.${s.n}.label`, label.value));
      this.guard(label, `sl${s.n}`);
      const src = document.createElement("input");
      src.type = "text"; src.title = T("ll.source"); src.placeholder = T("ll.source");
      src.addEventListener("change", () => this.write(`strip.${s.n}.source`, src.value.trim()));
      this.guard(src, `ss${s.n}`);
      const fw = document.createElement("div");
      fw.className = "faderwrap";
      const meter = document.createElement("div");
      meter.className = "meter";
      const mi = document.createElement("i");
      meter.append(mi);
      const fader = document.createElement("input");
      fader.type = "range"; fader.className = "v"; fader.min = MIN_DB; fader.max = MAX_DB; fader.step = 0.5;
      const db = document.createElement("div");
      db.className = "db";
      fader.addEventListener("input", () => { db.textContent = fmtDb(fader.value); this.write(`strip.${s.n}.gain`, Number(fader.value)); });
      this.guard(fader, `sg${s.n}`);
      fw.append(meter, fader);
      const mute = document.createElement("button");
      mute.className = "mute"; mute.textContent = T("ll.mute");
      mute.addEventListener("click", () => { const on = !mute.classList.contains("on"); mute.classList.toggle("on", on); this.write(`strip.${s.n}.mute`, on); });
      const state = document.createElement("div");
      state.className = "state";
      const dbtn = document.createElement("button");
      dbtn.textContent = T("ll.detail");
      dbtn.addEventListener("click", () => { this.detail = this.detail === s.n ? 0 : s.n; this.shape = ""; this.tick(); });
      col.append(label, src, fw, db, mute, dbtn);
      const sendEls = [];
      snap.buses.forEach((b, i) => {
        const row = document.createElement("div");
        row.className = "send";
        const nm = document.createElement("span");
        nm.textContent = `B${b.n}`;
        const sl = document.createElement("input");
        sl.type = "range"; sl.min = MIN_DB; sl.max = MAX_DB; sl.step = 0.5;
        const val = document.createElement("span");
        val.className = "db";
        sl.addEventListener("input", () => { val.textContent = fmtDb(sl.value); this.write(`strip.${s.n}.send.${b.n}`, Number(sl.value)); });
        this.guard(sl, `sn${s.n}_${i}`);
        row.append(nm, sl, val);
        col.append(row);
        sendEls.push({ sl, val });
      });
      col.append(state);
      strips.append(col);
      this.els.strips.push({ label, src, fader, db, mi, mute, state, sendEls, dbtn });
    }

    const h2 = document.createElement("h4");
    h2.textContent = T("ll.buses");
    const buses = document.createElement("div");
    buses.className = "row";
    r.append(h2, buses);
    for (const b of snap.buses) {
      const col = document.createElement("div");
      col.className = "col bus";
      const label = document.createElement("input");
      label.type = "text"; label.className = "name"; label.maxLength = 40;
      label.addEventListener("change", () => this.write(`bus.${b.n}.label`, label.value));
      this.guard(label, `bl${b.n}`);
      const fw = document.createElement("div");
      fw.className = "faderwrap";
      const meter = document.createElement("div");
      meter.className = "meter";
      const mi = document.createElement("i");
      meter.append(mi);
      const fader = document.createElement("input");
      fader.type = "range"; fader.className = "v"; fader.min = MIN_DB; fader.max = MAX_DB; fader.step = 0.5;
      const db = document.createElement("div");
      db.className = "db";
      fader.addEventListener("input", () => { db.textContent = fmtDb(fader.value); this.write(`bus.${b.n}.gain`, Number(fader.value)); });
      this.guard(fader, `bg${b.n}`);
      fw.append(meter, fader);
      const mute = document.createElement("button");
      mute.className = "mute"; mute.textContent = T("ll.mute");
      mute.addEventListener("click", () => { const on = !mute.classList.contains("on"); mute.classList.toggle("on", on); this.write(`bus.${b.n}.mute`, on); });
      const alsa = document.createElement("input");
      alsa.type = "number"; alsa.min = 0; alsa.max = 64; alsa.title = T("ll.alsaout"); alsa.placeholder = T("ll.alsaout");
      alsa.addEventListener("change", () => this.write(`bus.${b.n}.alsaOut`, Number(alsa.value)));
      this.guard(alsa, `ba${b.n}`);
      // Mix-minus: Bus bekommt alle Streifen außer dem gewählten (Gast, dessen Rückweg das ist)
      const mm = document.createElement("select");
      mm.title = T("ll.mixminus");
      const o0 = document.createElement("option");
      o0.value = ""; o0.textContent = T("ll.mixminus");
      mm.append(o0);
      for (const s of snap.strips) {
        const o = document.createElement("option");
        o.value = String(s.n); o.textContent = `${s.n}`;
        mm.append(o);
      }
      mm.addEventListener("change", () => { if (mm.value) this.call(`bus.${b.n}.mixMinus`, { strip: Number(mm.value) }); mm.value = ""; });
      const clear = document.createElement("button");
      clear.textContent = T("ll.clear");
      clear.addEventListener("click", () => this.call(`bus.${b.n}.clearSends`));
      const alsaCap = document.createElement("div");
      alsaCap.className = "state";
      alsaCap.textContent = T("ll.alsaout");
      const limRow = document.createElement("div");
      limRow.className = "send";
      const limBtn = document.createElement("button");
      limBtn.textContent = T("ll.limiter");
      limBtn.addEventListener("click", () => this.write(`bus.${b.n}.limiter.enabled`, !limBtn.classList.contains("on")));
      const ceil = document.createElement("input");
      ceil.type = "number"; ceil.min = -24; ceil.max = 0; ceil.step = 0.5; ceil.title = T("ll.ceiling");
      ceil.addEventListener("change", () => this.write(`bus.${b.n}.limiter.ceiling`, Number(ceil.value)));
      this.guard(ceil, `bc${b.n}`);
      const limGr = document.createElement("div");
      limGr.className = "state gr";
      limRow.style.gridTemplateColumns = "1fr 56px";
      limRow.append(limBtn, ceil);
      col.append(label, fw, db, mute, alsaCap, alsa, mm, clear, limRow, limGr);
      buses.append(col);
      this.els.buses.push({ label, fader, db, mi, mute, alsa, limBtn, ceil, limGr });
    }
    this.els.detail = null;
    if (this.detail) {
      this.buildDetail(r, this.detail);
      r.insertBefore(r.lastChild, h2); // Detail direkt unter den Streifen, vor den Bussen
    }
    const help = document.createElement("div");
    help.className = "help";
    help.textContent = T("ll.help") + " " + T("ll.nolat");
    r.append(help);
  }

  /** Eingabefeld für einen Parameter des gewählten Streifens. */
  pnum(parent, key, label, unit, min, max, step) {
    const row = document.createElement("div");
    row.className = "p";
    const lb = document.createElement("span");
    lb.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
    inp.addEventListener("change", () => this.write(`strip.${this.detail}.${key}`, Number(inp.value)));
    this.guard(inp, `d${key}`);
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = unit;
    row.append(lb, inp, u);
    parent.append(row);
    this.els.detail.nums[key] = inp;
  }

  ptoggle(parent, key, label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => this.write(`strip.${this.detail}.${key}`, !b.classList.contains("on")));
    parent.append(b);
    this.els.detail.tog[key] = b;
    return b;
  }

  buildDetail(root, n) {
    const box = document.createElement("div");
    box.className = "detail";
    const d = (this.els.detail = { nums: {}, tog: {}, eq: null, dyn: null, title: null });
    const top = document.createElement("div");
    top.className = "top";
    const title = document.createElement("b");
    d.title = title;
    const close = document.createElement("button");
    close.textContent = T("ll.close");
    close.addEventListener("click", () => { this.detail = 0; this.shape = ""; this.tick(); });
    top.append(title);
    this.ptoggle(top, "phase", T("ll.phase"));
    top.append(close);
    box.append(top);
    const grid = document.createElement("div");
    grid.className = "grid";
    // EQ
    const eq = document.createElement("div");
    eq.className = "sect";
    eq.innerHTML = `<h5>${T("ll.eq")}</h5>`;
    const eqTop = document.createElement("div");
    eqTop.className = "top";
    this.ptoggle(eqTop, "eq.bypass", T("ll.bypass"));
    this.ptoggle(eqTop, "eq.hp.enabled", T("ll.hp"));
    eq.append(eqTop);
    this.pnum(eq, "eq.hp.freq", T("ll.hp"), "Hz", 20, 400, 1);
    for (let b = 1; b <= 4; b++) {
      const row = document.createElement("div");
      row.className = "bandrow";
      const nm = document.createElement("span");
      nm.textContent = `B${b}`;
      row.append(nm);
      for (const [k, ttl, mn, mx, st] of [["freq", T("ll.freq"), 20, 20000, 1], ["q", T("ll.q"), 0.1, 20, 0.1], ["gain", T("ll.gain"), -24, 12, 0.5]]) {
        const inp = document.createElement("input");
        inp.type = "number"; inp.min = mn; inp.max = mx; inp.step = st; inp.title = ttl;
        const key = `eq.b${b}.${k}`;
        inp.addEventListener("change", () => this.write(`strip.${this.detail}.${key}`, Number(inp.value)));
        this.guard(inp, `d${key}`);
        d.nums[key] = inp;
        row.append(inp);
      }
      eq.append(row);
    }
    const eqSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    eqSvg.setAttribute("class", "curve"); eqSvg.setAttribute("viewBox", "0 0 300 100"); eqSvg.setAttribute("width", "300"); eqSvg.setAttribute("height", "100");
    eq.append(eqSvg);
    d.eq = eqSvg;
    // Kompressor
    const comp = document.createElement("div");
    comp.className = "sect";
    comp.innerHTML = `<h5>${T("ll.comp")}</h5>`;
    const cTop = document.createElement("div");
    cTop.className = "top";
    this.ptoggle(cTop, "comp.enabled", T("ll.on"));
    this.ptoggle(cTop, "comp.rms", T("ll.rms"));
    comp.append(cTop);
    this.pnum(comp, "comp.threshold", T("ll.thr"), "dB", -60, 0, 1);
    this.pnum(comp, "comp.ratio", T("ll.ratio"), ":1", 1, 20, 0.5);
    this.pnum(comp, "comp.attack", T("ll.attack"), "ms", 0.1, 200, 0.5);
    this.pnum(comp, "comp.release", T("ll.release"), "ms", 10, 2000, 10);
    this.pnum(comp, "comp.knee", T("ll.knee"), "dB", 0, 24, 1);
    this.pnum(comp, "comp.makeup", T("ll.makeup"), "dB", 0, 24, 0.5);
    const dynSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dynSvg.setAttribute("class", "curve"); dynSvg.setAttribute("viewBox", "0 0 120 120"); dynSvg.setAttribute("width", "120"); dynSvg.setAttribute("height", "120");
    comp.append(dynSvg);
    d.dyn = dynSvg;
    // Gate
    const gate = document.createElement("div");
    gate.className = "sect";
    gate.innerHTML = `<h5>${T("ll.gate")}</h5>`;
    const gTop = document.createElement("div");
    gTop.className = "top";
    this.ptoggle(gTop, "gate.enabled", T("ll.on"));
    gate.append(gTop);
    this.pnum(gate, "gate.threshold", T("ll.thr"), "dB", -90, 0, 1);
    this.pnum(gate, "gate.range", T("ll.range"), "dB", -90, 0, 1);
    this.pnum(gate, "gate.ratio", T("ll.ratio"), ":1", 1, 20, 0.5);
    this.pnum(gate, "gate.attack", T("ll.attack"), "ms", 0.1, 100, 0.5);
    this.pnum(gate, "gate.hold", T("ll.hold"), "ms", 0, 1000, 10);
    this.pnum(gate, "gate.release", T("ll.release"), "ms", 10, 2000, 10);
    this.pnum(gate, "gate.hysteresis", T("ll.hyst"), "dB", 0, 20, 1);
    grid.append(eq, comp, gate);
    box.append(grid);
    root.append(box);
  }

  paintDetail(det) {
    const d = this.els.detail;
    if (!d || !det || det.strip !== this.detail) return;
    const p = det.proc;
    d.title.textContent = `${T("ll.detail")} — ${this.lastLabel || det.strip}`;
    for (const [k, inp] of Object.entries(d.nums)) {
      if (!this.busy.has(`d${k}`) && p[k] !== undefined && document.activeElement !== inp && this.shadow.activeElement !== inp) inp.value = p[k];
    }
    for (const [k, b] of Object.entries(d.tog)) b.classList.toggle("on", !!p[k]);
    drawEq(d.eq, p);
    drawDyn(d.dyn, p);
  }

  paint(snap) {
    const st = snap.stats;
    const bad = (v) => (Number(v) > 0 ? "bad" : "");
    this.els.stats.innerHTML =
      `<span>${T("ll.clock")} <b>${st.clockMaster}</b></span><span>${T("ll.block")} <b>${st.blockMs} ms</b></span>` +
      `<span class="${st.realtime ? "" : "bad"}">${T("ll.rt")} <b>${st.realtime ? T("ll.rt.yes") : T("ll.rt.no")}</b></span>` +
      `<span>${T("ll.proc")} <b>${st.processUsAvg} / ${st.processUsMax} µs</b></span>` +
      `<span class="${bad(st.deadlineMisses)}">${T("ll.misses")} <b>${st.deadlineMisses}</b></span>` +
      `<span class="${bad(st.ringUnderruns)}">${T("ll.under")} <b>${st.ringUnderruns}</b></span>` +
      `<span>${T("ll.slips")} <b>${st.ringSlips}</b></span><span>${T("ll.grown")} <b>${st.ringGrown}</b></span>` +
      (st.alsaIn !== "aus" ? `<span>${T("ll.alsain")} <b>${st.alsaIn}</b></span><span class="${bad(st.alsaXruns)}">${T("ll.xruns")} <b>${st.alsaXruns}</b></span>` : "") +
      (st.aesRx !== "aus" ? `<span>${T("ll.aes")} RX <b>${st.aesRx}</b> · ${st.aesRxPackets} ${T("ll.pkts")} · <span class="${bad(st.aesRxLost)}">${st.aesRxLost} ${T("ll.lost")}</span></span>` : "") +
      (st.aesTx !== "aus" ? `<span>${T("ll.aes")} TX <b>${st.aesTx}</b> · ${st.aesTxPackets} ${T("ll.pkts")}</span>` : "");
    const free = (key) => !this.busy.has(key);
    snap.strips.forEach((s, i) => {
      const e = this.els.strips[i];
      if (!e) return;
      if (free(`sl${s.n}`)) e.label.value = s.label;
      if (free(`ss${s.n}`)) e.src.value = s.source;
      if (free(`sg${s.n}`)) { e.fader.value = s.gain; e.db.textContent = fmtDb(s.gain); }
      e.mute.classList.toggle("on", !!s.mute);
      e.mi.style.height = meterPct(s.level) + "%";
      const gr = [];
      if (Number(s.gateGr) < -0.5) gr.push(`Gate ${Number(s.gateGr).toFixed(0)}`);
      if (Number(s.compGr) < -0.5) gr.push(`Comp ${Number(s.compGr).toFixed(0)}`);
      e.state.textContent = `${s.state} · ${T("ll.buf")} ${Number(s.bufferMs).toFixed(1)} ms` + (gr.length ? ` · ${gr.join(" ")} dB` : "");
      e.dbtn.classList.toggle("on", this.detail === s.n);
      e.state.classList.toggle("ok", s.state === "ok");
      s.sends.forEach((v, k) => {
        if (free(`sn${s.n}_${k}`)) { e.sendEls[k].sl.value = v; e.sendEls[k].val.textContent = fmtDb(v); }
      });
    });
    if (this.detail) {
      const cur = snap.strips[this.detail - 1];
      this.lastLabel = cur ? cur.label : "";
      this.paintDetail(snap.detail);
    }
    snap.buses.forEach((b, i) => {
      const e = this.els.buses[i];
      if (!e) return;
      e.limBtn.classList.toggle("on", !!b.limiter);
      if (free(`bc${b.n}`)) e.ceil.value = b.ceiling;
      e.limGr.textContent = b.limiter && Number(b.limiterGr) < -0.1 ? `${T("ll.gr")} ${Number(b.limiterGr).toFixed(1)} dB` : "";
      if (free(`bl${b.n}`)) e.label.value = b.label;
      if (free(`bg${b.n}`)) { e.fader.value = b.gain; e.db.textContent = fmtDb(b.gain); }
      e.mute.classList.toggle("on", !!b.mute);
      if (free(`ba${b.n}`)) e.alsa.value = b.alsaOut;
      e.mi.style.height = meterPct(b.level) + "%";
    });
  }
}

if (!customElements.get("omp-lowlat-mixer-panel")) {
  customElements.define("omp-lowlat-mixer-panel", OmpLowlatMixerPanel);
}
