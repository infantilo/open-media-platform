// ───────────────────────────── Center Control ─────────────────────────────
//
// Detailsteuerung des gewählten Kanals in Tabs (EQ, COMP, GATE, …). Jeder Regler
// ruft direkt die zugehörige Node-Methode auf (gedrosselt, letzter Wert gewinnt);
// nichts hier ist reine Optik. Pro Tab werden die Controls EINMAL gebaut und bei
// Kanalwechsel/Poll nur mit Werten befüllt (kein Neuaufbau, kein Flackern).

const EQ_BANDS = [
  { key: "low", name: "LOW", gain: "eqLow", freq: "eqLowFreq", width: "eqLowWidth", kind: "low", defF: 100 },
  { key: "mid", name: "MID 1", gain: "eqMid", freq: "eqMidFreq", width: "eqMidWidth", kind: "peak", defF: 1000 },
  { key: "mid2", name: "MID 2", gain: "eqMid2", freq: "eqMid2Freq", width: "eqMid2Width", kind: "peak", defF: 3500 },
  { key: "high", name: "HIGH", gain: "eqHigh", freq: "eqHighFreq", width: "eqHighWidth", kind: "high", defF: 8000 },
];
const TRIGGERS = [
  ["unmute", T("am2.e1b587")],
  ["mute", T("am2.e1bd52")],
  ["fader_open", T("am2.08a722")],
  ["fader_close", T("am2.880483")],
  ["scene_activate", T("am2.134d3e")],
  ["video_active", T("am2.6b78f7")],
  ["video_inactive", T("am2.539cb7")],
];
const ACTIONS = [
  ["none", T("am2.ab87cc")],
  ["play", T("am2.de3c73")],
  ["resume", T("am2.f1cefe")],
  ["pause", T("am2.105b29")],
  ["stop", T("am2.11a755")],
];
const DETECTORS = [
  ["speech", T("am2.28810f")],
  ["rms", "RMS"],
  ["short", T("am2.31fd4a")],
  ["peak", T("am2.a21e60")],
];

class CenterControl {
  constructor(app) {
    this.app = app;
    this.binds = [];
    this.liveBinds = [];
    this.tabId = "in";
    this.built = new Map();

    this.title = h("div", { class: "ctitle" });
    this.prevBtn = h("button", { class: "nav", type: "button", "aria-label": T("am2.8a1533"), text: "◀", onclick: () => app.step(-1) });
    this.nextBtn = h("button", { class: "nav", type: "button", "aria-label": T("am2.f8baf8"), text: "▶", onclick: () => app.step(1) });
    this.closeBtn = h("button", { class: "nav close", type: "button", "aria-label": T("am2.781460"), text: "✕", onclick: () => app.closeCenter() });
    this.head = h("div", { class: "chead2" }, this.prevBtn, this.title, this.nextBtn, this.closeBtn);
    this.tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": T("am2.c18a6f") });
    this.body = h("div", { class: "cbody", role: "tabpanel" });
    this.empty = h("p", { class: "empty", text: T("am2.9e0322") });
    this.root = h("div", { class: "center-inner" }, this.head, this.tabBar, this.body, this.empty);

    this.tabs = [
      ["in", "IN", () => this.tabIn()],
      ["eq", "EQ", () => this.tabEq()],
      ["comp", "COMP", () => this.tabComp()],
      ["gate", "GATE", () => this.tabGate()],
      ["delay", "DELAY", () => this.tabDelay()],
      ["pan", "PAN", () => this.tabPan()],
      ["route", "AUX", () => this.tabRoute()],
      ["auto", "AUTOMIX", () => this.tabAuto()],
      ["duck", "DUCK", () => this.tabDuck()],
      ["media", "AUTOMATION", () => this.tabMedia()],
      ["scenes", "SZENEN", () => this.tabScenes()],
    ];
    this.tabBtns = new Map();
    for (const [id, label] of this.tabs) {
      const b = h("button", { class: "tab", type: "button", role: "tab", "aria-selected": "false", text: label, onclick: () => this.setTab(id) });
      this.tabBtns.set(id, b);
      this.tabBar.append(b);
    }
  }

  // ───── Bausteine ─────
  cur() {
    return this.app.cur();
  }
  bind(fn) {
    this.binds.push(fn);
  }
  /** Parameter-Regler: get(ch) → Wert, set(ch, v) → mutiert lokal + sendet. */
  slider(cfg, host) {
    const s = new Slider({
      ...cfg,
      onInput: (v) => {
        const ch = this.cur();
        if (ch) cfg.set(ch, v);
      },
    });
    host.append(s.root);
    this.bind(() => {
      const ch = this.cur();
      if (ch) s.setValue(cfg.get(ch));
    });
    return s;
  }
  toggle(label, get, set, host, { title } = {}) {
    const b = h("button", { class: "tog wide", type: "button", "aria-pressed": "false", title: title || label, text: label });
    b.addEventListener("click", () => {
      const ch = this.cur();
      if (!ch) return;
      set(ch, !get(ch));
      this.refresh();
    });
    host.append(b);
    this.bind(() => {
      const ch = this.cur();
      if (ch) b.setAttribute("aria-pressed", String(!!get(ch)));
    });
    return b;
  }
  segmented(options, get, set, host, label) {
    const wrap = h("div", { class: "seg", role: "group", "aria-label": label || "" });
    const btns = options.map(([val, text]) => {
      const b = h("button", { class: "tog", type: "button", "aria-pressed": "false", text, onclick: () => { const ch = this.cur(); if (ch) { set(ch, val); this.refresh(); } } });
      wrap.append(b);
      return [val, b];
    });
    host.append(wrap);
    this.bind(() => {
      const ch = this.cur();
      if (!ch) return;
      const v = get(ch);
      for (const [val, b] of btns) b.setAttribute("aria-pressed", String(val === v));
    });
    return wrap;
  }
  select(label, getOptions, get, set, host) {
    const sel = h("select", { class: "sel-input", "aria-label": label });
    const wrap = h("label", { class: "field" }, h("span", { text: label }), sel);
    host.append(wrap);
    let key = "";
    this.bind(() => {
      const ch = this.cur();
      if (!ch) return;
      const opts = getOptions(ch);
      const k = JSON.stringify(opts);
      if (k !== key) {
        key = k;
        sel.replaceChildren(...opts.map(([v, t]) => h("option", { value: v, text: t })));
      }
      sel.value = get(ch);
    });
    sel.addEventListener("change", () => {
      const ch = this.cur();
      if (ch) set(ch, sel.value);
    });
    return sel;
  }
  section(title, ...kids) {
    return h("section", { class: "csec" }, title ? h("h3", { text: title }) : null, ...kids);
  }
  advanced(title, ...kids) {
    return h("details", { class: "csec" }, h("summary", { text: title }), ...kids);
  }
  grid(cls = "cgrid") {
    return h("div", { class: cls });
  }

  // ───── Tabs ─────
  setTab(id) {
    this.tabId = id;
    this.app.ui.centerTab = id;
    this.app.saveUi();
    this.mount();
  }
  mount() {
    for (const [id, b] of this.tabBtns) b.setAttribute("aria-selected", String(id === this.tabId));
    let panel = this.built.get(this.tabId);
    if (!panel) {
      this.binds = [];
      this.liveBinds = [];
      const def = this.tabs.find((t) => t[0] === this.tabId);
      const root = def[2]();
      panel = { root, binds: this.binds, live: this.liveBinds };
      this.built.set(this.tabId, panel);
    }
    this.currentPanel = panel;
    this.body.replaceChildren(panel.root);
    this.refresh();
  }
  refresh() {
    const ch = this.cur();
    this.empty.hidden = !!ch;
    this.body.hidden = !ch;
    this.tabBar.hidden = !ch;
    if (!ch) {
      this.title.textContent = "—";
      return;
    }
    const nameNew = ch.label;
    if (this.title.dataset.n !== nameNew) {
      this.title.dataset.n = nameNew;
      this.title.textContent = nameNew;
    }
    if (this.currentPanel) for (const fn of this.currentPanel.binds) fn();
  }
  /** Aus der rAF-Schleife: Live-Anzeigen (GR-Balken, Auto-/Duck-Werte). */
  tickLive(now) {
    if (this.currentPanel) for (const fn of this.currentPanel.live) fn(now);
  }
  /** Live-Binding registrieren (gehört zum Tab, der gerade gebaut wird). */
  live(fn) {
    this.liveBinds.push(fn);
  }
  /** Tab-Inhalt bauen (binds/liveBinds sind von mount() bereits zurückgesetzt). */
  buildTab(fn) {
    return fn();
  }

  // IN: Quelle, Gain, Phase, Solo, Name
  tabIn() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const src = this.section(T("am2.4bf36f"));
    this.select(T("am2.d3402e"), () => [["", T("am2.3621e8")], ...app.state.availableSources.map((s) => [s.senderId, shortLabel(s.label)])], (ch) => ch.source || "", (ch, v) => { ch.source = v; app.sendCh(ch.id, "setSource", { senderId: v }); }, src);
    const g = this.grid();
    this.slider({ label: T("am2.d9a3ff"), min: -60, max: 12, step: 0.1, def: 0, unit: "dB", get: (ch) => ch.gainDb, set: (ch, v) => app.setGainLive(ch.id, v), fmt: (v) => fmtSigned(v) + " dB" }, g);
    this.toggle(T("am2.5a8536"), (ch) => ch.proc.phaseInvert, (ch, v) => { ch.proc.phaseInvert = v; app.sendCh(ch.id, "setPhase", { invert: v }); }, g);
    this.toggle(T("am2.b8ffb3"), (ch) => ch.pfl, (ch) => app.togglePfl(ch.id), g);
    const name = h("input", { class: "text-input", type: "text", "aria-label": T("am2.459cc4"), maxlength: "40" });
    name.addEventListener("change", () => {
      const ch = this.cur();
      if (ch && name.value.trim()) { ch.label = name.value.trim(); app.sendCh(ch.id, "setLabel", { label: ch.label }); app.renderChannels(); this.refresh(); }
    });
    this.bind(() => { const ch = this.cur(); if (ch && document.activeElement !== name && app.shadow.activeElement !== name) name.value = ch.label; });
    const rm = h("button", { class: "tog danger", type: "button", text: T("am2.efc04e"), onclick: async () => { const ch = this.cur(); if (ch && (await app.confirm(T("am2.fcd23f", { p0: ch.label })))) app.cmd("removeChannel", { channelId: ch.id }).then(() => app.poll()); } });
    const mv = (d) => () => { const ch = this.cur(); if (!ch) return; const i = app.state.channels.findIndex((c) => c.id === ch.id); app.moveChannelTo(ch.id, i + d); };
    const left = h("button", { class: "tog", type: "button", text: T("x.left"), title: T("am2.abb6e2"), onclick: mv(-1) });
    const right = h("button", { class: "tog", type: "button", text: T("am2.90cf6b"), title: T("am2.300a10"), onclick: mv(1) });
    root.append(src, this.section(T("am2.f23ca0"), g), this.section(T("am2.49ee30"), name, rm), this.section(T("am2.29c5cb"), h("div", { class: "row" }, left, right)));
    return root;
  }

  // EQ: Kurve (Handles ziehbar) + Regler je Band
  tabEq() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const canvas = h("canvas", { class: "eqplot", "aria-label": "EQ-Frequenzgang. Punkte ziehen: waagerecht Frequenz, senkrecht Gain." });
    const top = this.grid("cgrid");
    this.toggle("EQ Bypass", (ch) => ch.proc.eqBypass, (ch, v) => { ch.proc.eqBypass = v; app.sendCh(ch.id, "setEqBypass", { bypass: v }); }, top);
    this.toggle(T("am2.db3c8f"), (ch) => ch.proc.eqHpEnabled, (ch, v) => { ch.proc.eqHpEnabled = v; app.sendCh(ch.id, "setEqHp", { enabled: v, freq: ch.proc.eqHpFreq }); }, top);
    this.slider({ label: "HP-Frequenz", min: 20, max: 500, step: 1, scale: "log", def: 80, unit: "Hz", get: (ch) => ch.proc.eqHpFreq, set: (ch, v) => { ch.proc.eqHpFreq = v; app.sendCh(ch.id, "setEqHp", { enabled: ch.proc.eqHpEnabled, freq: v }, "hp"); } }, top);

    const draw = () => {
      const ch = this.cur();
      if (!ch) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      if (!w || !hgt) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      const c = canvas.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cs = getComputedStyle(canvas);
      const fg = cs.getPropertyValue("--c-text").trim() || "#ddd", dim = cs.getPropertyValue("--c-dim").trim() || "#888", acc = cs.getPropertyValue("--c-accent").trim() || "#4aa3ff", grid = cs.getPropertyValue("--c-border").trim() || "#333";
      c.clearRect(0, 0, w, hgt);
      const X = (f) => (Math.log10(f / 20) / 3) * w;
      const Y = (db) => hgt / 2 - (db / 18) * (hgt / 2 - 6);
      c.lineWidth = 1;
      c.strokeStyle = grid;
      c.fillStyle = dim;
      c.font = "10px sans-serif";
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) { c.beginPath(); c.moveTo(X(f), 0); c.lineTo(X(f), hgt); c.stroke(); c.fillText(f >= 1000 ? f / 1000 + "k" : String(f), X(f) + 2, hgt - 3); }
      for (const d of [-12, -6, 0, 6, 12]) { c.beginPath(); c.moveTo(0, Y(d)); c.lineTo(w, Y(d)); c.strokeStyle = d === 0 ? dim : grid; c.stroke(); c.fillStyle = dim; c.fillText(String(d), 2, Y(d) - 2); }
      const P = ch.proc;
      const resp = (f) => {
        let db = 0;
        if (P.eqHpEnabled) db += biquadMagDb("hp", P.eqHpFreq, Math.SQRT1_2, 0, f);
        for (const b of EQ_BANDS) if (Math.abs(P[b.gain]) > 0.01) db += biquadMagDb(b.kind, P[b.freq], P[b.freq] / Math.max(P[b.width], 1), P[b.gain], f);
        return db;
      };
      c.beginPath();
      for (let i = 0; i <= 160; i++) { const f = 20 * Math.pow(1000, i / 160); const y = Y(clamp(resp(f), -18, 18)); i ? c.lineTo(X(f), y) : c.moveTo(X(f), y); }
      c.strokeStyle = P.eqBypass ? dim : acc;
      c.lineWidth = 2;
      c.stroke();
      c.lineWidth = 1;
      this.handles = EQ_BANDS.map((b) => ({ b, x: X(P[b.freq]), y: Y(P[b.gain]) }));
      for (const hd of this.handles) {
        c.beginPath(); c.arc(hd.x, hd.y, 8, 0, 7); c.fillStyle = hd.b === this.dragBand ? acc : "transparent"; c.fill(); c.strokeStyle = fg; c.stroke();
        c.fillStyle = fg; c.fillText(hd.b.name.replace("MID ", "M"), hd.x - 5, hd.y + 3);
      }
    };
    this.bind(draw);
    new ResizeObserver(() => draw()).observe(canvas);
    canvas.style.touchAction = "none";
    const toFg = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    canvas.addEventListener("pointerdown", (e) => {
      const p = toFg(e);
      let best = null, bd = 28;
      for (const hd of this.handles || []) { const d = Math.hypot(hd.x - p.x, hd.y - p.y); if (d < bd) { bd = d; best = hd; } }
      if (!best) return;
      this.dragBand = best.b;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragBand) return;
      const ch = this.cur(); if (!ch) return;
      const p = toFg(e), b = this.dragBand;
      const f = clamp(Math.round(20 * Math.pow(1000, clamp(p.x / p.w, 0, 1))), 20, 20000);
      const g = clamp(Math.round(((p.h / 2 - p.y) / (p.h / 2 - 6)) * 18 * 2) / 2, -24, 12);
      const q = ch.proc[b.freq] / Math.max(ch.proc[b.width], 1);
      ch.proc[b.freq] = f; ch.proc[b.width] = f / q; ch.proc[b.gain] = g;
      app.sendCh(ch.id, "setEqGain", { band: b.key, gainDb: g }, "g" + b.key);
      app.sendCh(ch.id, "setEqBand", { band: b.key, freq: f, width: f / q }, "f" + b.key);
      this.refresh();
    });
    const end = () => { this.dragBand = null; draw(); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    const bands = h("div", { class: "bands" });
    for (const b of EQ_BANDS) {
      const col = h("div", { class: "band" }, h("h4", { text: b.name }));
      this.slider({ label: T("am2.35d72f"), min: -24, max: 12, step: 0.5, def: 0, center: 0, unit: "dB", fmt: (v) => fmtSigned(v) + " dB", get: (ch) => ch.proc[b.gain], set: (ch, v) => { ch.proc[b.gain] = v; app.sendCh(ch.id, "setEqGain", { band: b.key, gainDb: v }, "g" + b.key); draw(); } }, col);
      this.slider({ label: T("am2.0c4b5d"), min: 20, max: 20000, step: 1, scale: "log", def: b.defF, fmt: (v) => (v >= 1000 ? (v / 1000).toFixed(2) + " kHz" : Math.round(v) + " Hz"), get: (ch) => ch.proc[b.freq], set: (ch, v) => { const q = ch.proc[b.freq] / Math.max(ch.proc[b.width], 1); ch.proc[b.freq] = v; ch.proc[b.width] = v / q; app.sendCh(ch.id, "setEqBand", { band: b.key, freq: v, width: v / q }, "f" + b.key); draw(); } }, col);
      this.slider({ label: "Q", min: 0.1, max: 20, step: 0.1, scale: "log", def: 1, fmt: (v) => v.toFixed(1), get: (ch) => ch.proc[b.freq] / Math.max(ch.proc[b.width], 1), set: (ch, v) => { ch.proc[b.width] = ch.proc[b.freq] / v; app.sendCh(ch.id, "setEqBand", { band: b.key, freq: ch.proc[b.freq], width: ch.proc[b.width] }, "f" + b.key); draw(); } }, col);
      bands.append(col);
    }
    root.append(this.section(T("am2.cffd09"), canvas), this.section(T("am2.d7778d"), top), this.section(T("am2.79946f"), bands));
    return root;
  }

  grMeter(label, key) {
    const bar = h("i", { class: "grfill" });
    const val = h("output", { class: "grval", text: "0.0 dB" });
    const root = h("div", { class: "grm", role: "img", "aria-label": label }, h("span", { class: "grl", text: label }), h("div", { class: "grbar" }, bar), val);
    let last = "";
    this.live((now) => {
      const l = this.app.live.get(this.app.ui.selected);
      const gr = l ? l[key] : 0;
      const t = fmtSigned(gr) + " dB";
      if (t === last) return;
      last = t;
      val.textContent = t;
      bar.style.setProperty("--g", String(clamp(-gr / 24, 0, 1)));
    });
    return root;
  }

  tabComp() {
    return this.buildTab(() => {
      const app = this.app;
      const root = h("div", { class: "ctab" });
      const g = this.grid();
      const send = (ch) => app.sendCh(ch.id, "setComp", { enabled: ch.proc.compEnabled, thresholdDb: ch.proc.compThreshold, ratio: ch.proc.compRatio, makeupDb: ch.proc.compMakeup, attackMs: ch.proc.compAttack, releaseMs: ch.proc.compRelease, kneeDb: ch.proc.compKnee, rms: ch.proc.compRms }, "comp");
      this.toggle(T("am2.6627c9"), (ch) => ch.proc.compEnabled, (ch, v) => { ch.proc.compEnabled = v; send(ch); }, g);
      this.segmented([[true, "RMS"], [false, T("am2.a21e60")]], (ch) => ch.proc.compRms, (ch, v) => { ch.proc.compRms = v; send(ch); }, g, T("am2.98babc"));
      const s = (label, key, min, max, step, def, unit, scale) => this.slider({ label, min, max, step, def, unit, scale, get: (ch) => ch.proc[key], set: (ch, v) => { ch.proc[key] = v; send(ch); } }, g);
      s(T("am2.2a63f5"), "compThreshold", -60, 0, 0.5, -20, "dB");
      s(T("am2.8334a1"), "compRatio", 1, 20, 0.1, 2, ":1");
      s(T("am2.dcfafc"), "compAttack", 0.1, 200, 0.1, 15, "ms", "log");
      s(T("am2.b8e7b4"), "compRelease", 5, 2000, 1, 150, "ms", "log");
      s(T("am2.e50c79"), "compKnee", 0, 24, 0.5, 6, "dB");
      s(T("am2.2ae04b"), "compMakeup", 0, 24, 0.5, 0, "dB");
      root.append(this.section(T("am2.9cd246"), g), this.section(T("am2.b117c1"), this.grMeter(T("am2.5be5d1"), "compGr")));
      return root;
    });
  }

  tabGate() {
    return this.buildTab(() => {
      const app = this.app;
      const root = h("div", { class: "ctab" });
      const g = this.grid();
      const send = (ch) => app.sendCh(ch.id, "setGate", { enabled: ch.proc.gateEnabled, thresholdDb: ch.proc.gateThreshold, rangeDb: ch.proc.gateRange, ratio: ch.proc.gateRatio, attackMs: ch.proc.gateAttack, holdMs: ch.proc.gateHold, releaseMs: ch.proc.gateRelease, hysteresisDb: ch.proc.gateHysteresis }, "gate");
      this.toggle(T("am2.f4019c"), (ch) => ch.proc.gateEnabled, (ch, v) => { ch.proc.gateEnabled = v; send(ch); }, g);
      this.segmented([[false, T("am2.77d9bb")], [true, T("am2.fa1bac")]], (ch) => ch.proc.gateRatio >= 20, (ch, v) => { ch.proc.gateRatio = v ? 100 : 2; send(ch); }, g, T("am2.1aecce"));
      const s = (label, key, min, max, step, def, unit, scale) => this.slider({ label, min, max, step, def, unit, scale, get: (ch) => ch.proc[key], set: (ch, v) => { ch.proc[key] = v; send(ch); } }, g);
      s(T("am2.2a63f5"), "gateThreshold", -90, 0, 0.5, -55, "dB");
      s(T("am2.87ba2e"), "gateRange", -90, 0, 1, -30, "dB");
      this.slider({ label: T("am2.d913ce"), min: 1, max: 19, step: 0.1, def: 2, unit: ":1", get: (ch) => Math.min(ch.proc.gateRatio, 19), set: (ch, v) => { ch.proc.gateRatio = v; send(ch); } }, g);
      s(T("am2.dcfafc"), "gateAttack", 0.1, 200, 0.1, 5, "ms", "log");
      s(T("am2.bcd8db"), "gateHold", 0, 2000, 5, 80, "ms");
      s(T("am2.b8e7b4"), "gateRelease", 5, 4000, 5, 300, "ms", "log");
      s(T("am2.dfc2d5"), "gateHysteresis", 0, 20, 0.5, 4, "dB");
      root.append(this.section(T("am2.96f8f1"), g), this.section(T("am2.b117c1"), this.grMeter(T("am2.d25b4b"), "gateGr")));
      return root;
    });
  }

  tabDelay() {
    return this.buildTab(() => {
      const app = this.app;
      const root = h("div", { class: "ctab" });
      const g = this.grid();
      const send = (ch) => app.sendCh(ch.id, "setDelay", { enabled: ch.proc.delayEnabled, ms: ch.proc.delayMs }, "delay");
      this.toggle(T("am2.7695f4"), (ch) => ch.proc.delayEnabled, (ch, v) => { ch.proc.delayEnabled = v; send(ch); }, g);
      this.slider({ label: T("am2.1ee99c"), min: 0, max: 500, step: 0.5, def: 0, unit: "ms", get: (ch) => ch.proc.delayMs, set: (ch, v) => { ch.proc.delayMs = v; send(ch); } }, g);
      const quick = h("div", { class: "seg" });
      for (const [t, ms] of [["0", 0], [T("x.m1f"), -20], [T("x.p1f"), 20], ["+10 ms", 10], ["+100 ms", 100]]) {
        quick.append(h("button", { class: "tog", type: "button", text: t, onclick: () => { const ch = this.cur(); if (!ch) return; ch.proc.delayMs = ms === 0 ? 0 : clamp(ch.proc.delayMs + ms, 0, 2000); send(ch); this.refresh(); } }));
      }
      root.append(this.section(T("am2.9e0422"), g, quick));
      return root;
    });
  }

  tabPan() {
    return this.buildTab(() => {
      const app = this.app;
      const root = h("div", { class: "ctab" });
      const g = this.grid();
      const send = (ch) => app.sendCh(ch.id, "setPan", { pan: ch.proc.pan }, "pan");
      this.slider({ label: T("am2.ac31b0"), min: -1, max: 1, step: 0.01, def: 0, center: 0, fmt: (v) => (Math.abs(v) < 0.005 ? T("am2.28c13c") : v < 0 ? "L " + Math.round(-v * 100) : "R " + Math.round(v * 100)), get: (ch) => ch.proc.pan, set: (ch, v) => { ch.proc.pan = Math.abs(v) < 0.03 ? 0 : v; send(ch); } }, g);
      const seg = h("div", { class: "seg" });
      for (const [t, v] of [["L", -1], [T("am2.28c13c"), 0], ["R", 1]]) seg.append(h("button", { class: "tog", type: "button", text: t, onclick: () => { const ch = this.cur(); if (ch) { ch.proc.pan = v; send(ch); this.refresh(); } } }));
      root.append(this.section("Pan", g, seg), h("p", { class: "hint", text: T("am2.9ea071") }));
      return root;
    });
  }
}
