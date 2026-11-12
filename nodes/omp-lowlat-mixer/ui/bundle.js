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
      "ll.err": "Keine Verbindung zum Node", "ll.aes": "AES67", "ll.lost": "verloren", "ll.pkts": "Pakete", "ll.alsain": "ALSA-Eingang",
    },
    en: {
      "ll.strips": "Inputs", "ll.buses": "Buses", "ll.mute": "Mute", "ll.source": "Source", "ll.sends": "Sends (dB)",
      "ll.clock": "Clock", "ll.block": "Block", "ll.rt": "Real-time", "ll.rt.no": "no (privileges missing)", "ll.rt.yes": "yes",
      "ll.proc": "Processing", "ll.misses": "missed ticks", "ll.under": "underruns", "ll.slips": "Drift correction",
      "ll.grown": "Reserve grown", "ll.xruns": "ALSA dropouts", "ll.alsaout": "ALSA output (channel)", "ll.off": "off",
      "ll.mixminus": "Mix-minus for …", "ll.mixminus.do": "apply", "ll.clear": "Clear sends", "ll.buf": "Reserve",
      "ll.help": "Source: off, mxl (NMOS connection), alsa:K or alsa:K-L (card), aes:K or aes:K-L (AES67). Mix-minus: the bus gets every strip except the chosen one.",
      "ll.err": "No connection to the node", "ll.aes": "AES67", "ll.lost": "lost", "ll.pkts": "packets", "ll.alsain": "ALSA input",
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
`;

const MIN_DB = -90, MAX_DB = 12;
const meterPct = (db) => Math.max(0, Math.min(100, ((Number(db) + 60) / 60) * 100));
const fmtDb = (v) => (Number(v) <= MIN_DB ? "−∞" : (Number(v) >= 0 ? "+" : "") + Number(v).toFixed(1));

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
      const res = await fetch(`/api/v1/nodes/${this.nodeId}/measurements`);
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
      col.append(label, src, fw, db, mute);
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
      this.els.strips.push({ label, src, fader, db, mi, mute, state, sendEls });
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
      col.append(label, fw, db, mute, alsaCap, alsa, mm, clear);
      buses.append(col);
      this.els.buses.push({ label, fader, db, mi, mute, alsa });
    }
    const help = document.createElement("div");
    help.className = "help";
    help.textContent = T("ll.help");
    r.append(help);
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
      e.state.textContent = `${s.state} · ${T("ll.buf")} ${Number(s.bufferMs).toFixed(1)} ms`;
      e.state.classList.toggle("ok", s.state === "ok");
      s.sends.forEach((v, k) => {
        if (free(`sn${s.n}_${k}`)) { e.sendEls[k].sl.value = v; e.sendEls[k].val.textContent = fmtDb(v); }
      });
    });
    snap.buses.forEach((b, i) => {
      const e = this.els.buses[i];
      if (!e) return;
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
