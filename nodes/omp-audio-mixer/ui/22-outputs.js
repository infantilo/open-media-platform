// Ausgänge & Routing (Kap. 32.1): ein Dialog statt verstreuter Aux-Reiter-Formulare.
// Oben „Ausgang anlegen“ (Vorlage Mono/Stereo/5.1/7.1/Eigene), darunter die Routing-Matrix
// Kanal × Ausgang (Programm + alle Busse) — ein Kanal kann beliebig viele Ausgänge speisen.

const OUTPUT_TEMPLATES = [
  ["stereo", T("am4.ee9cbd"), 2],
  ["5.1", T("x.s51"), 6],
  ["7.1", T("x.s71"), 8],
  ["mono", T("am4.5d9b47"), 1],
  ["custom", T("am4.6b0c78"), 4],
];

/** Gruppen-Tag aus dem Anzeigenamen: klein, a–z/0–9/-, höchstens 20 Zeichen. */
function slugGroup(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}

/** Legt einen Ausgang (Gruppen-Bus) aus einer Vorlage an — gemeinsam für Dialog und Inline-Formular. */
async function createOutput(app, name, layout, count) {
  const label = String(name || "").trim();
  if (!label) return { ok: false, msg: T("am4.c34761") };
  const group = slugGroup(label);
  if (!group) return { ok: false, msg: T("am4.476823") };
  const st = app.state;
  if (st.auxBuses.some((a) => a.kind === "group" && a.group === group)) return { ok: false, msg: T("am4.ca9c53", { p0: group }) };
  if (st.auxFree <= 0) return { ok: false, msg: T("am4.177261") };
  const channels = layout === "custom" ? Number(count) : OUTPUT_TEMPLATES.find((t) => t[0] === layout)[2];
  await app.cmd("addAux", { kind: "group", group, layout, channels, label });
  await app.poll();
  return { ok: true, msg: T("am4.00a7af", { p0: label, p1: group }) };
}

/** Anzeigename + Art eines Ausgangs für Streifenkopf und Matrix. */
function outputKind(a) {
  if (a.kind === "group") return T("am4.9ca2e9", { p0: { mono: T("am4.5d9b47"), stereo: T("am4.bbc45d"), "5.1": "5.1", "7.1": "7.1" }[a.layout] || `${a.channels} Kn.` });
  return a.kind === "n1" ? "N-1 (Mix-Minus)" : "Aux";
}

/** Ausgangs-Streifen: Pegelanzeige, Master-Fader, Mute — eine Spalte je Ausgang (Kap. 32.4). */
class OutputStrip {
  constructor(app, aux) {
    this.app = app;
    this.id = aux.id;
    this.root = h("div", { class: "ch out", "data-kind": aux.kind, role: "group" });
    this.nameBtn = h("button", { class: "name", type: "button", title: T("am4.08b51b") });
    this.nameBtn.addEventListener("click", () => app.openOutputs());
    this.nameBtn.addEventListener("dblclick", () => {
      const a = app.state.auxBuses.find((x) => x.id === this.id);
      const n = a && window.prompt(T("am4.9897c7"), a.label);
      if (n && n.trim()) app.cmd(`aux.${this.id}.setLabel`, { label: n.trim() }).then(() => app.poll());
    });
    this.kind = h("span", { class: "b outkind" });
    // Reihenfolge ändern: Griff ziehen (wie bei den Kanalzügen).
    this.grip = h("span", { class: "grip", draggable: "true", title: T("am1.e3f9d6"), "aria-hidden": "true", text: "⠿" });
    this.grip.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-omp-aux", this.id); e.dataTransfer.effectAllowed = "move"; this.root.dataset.dragging = "1"; });
    this.grip.addEventListener("dragend", () => { delete this.root.dataset.dragging; });
    this.root.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("text/x-omp-aux")) { e.preventDefault(); this.root.dataset.dropTarget = "1"; } });
    this.root.addEventListener("dragleave", () => { delete this.root.dataset.dropTarget; });
    this.root.addEventListener("drop", (e) => {
      delete this.root.dataset.dropTarget;
      const from = e.dataTransfer.getData("text/x-omp-aux");
      if (from && from !== this.id) { e.preventDefault(); app.moveAuxBefore(from, this.id); }
    });
    this.head = h("div", { class: "chead" }, this.grip, this.nameBtn);
    this.badges = h("div", { class: "badges" }, this.kind);
    this.meter = new Meter();
    this.meterWrap = h("div", { class: "meterwrap" }, this.meter.root);
    this.fader = new Fader({
      label: T("am4.472c1d"),
      onInput: (db) => { const a = app.state.auxBuses.find((x) => x.id === this.id); if (a) a.masterDb = db; app.touchedAt = performance.now(); app.sendNow(`aux.${this.id}.setMaster`, { db }, "am" + this.id); },
      onCommit: () => app.setGainCommit(),
    });
    this.muteBtn = h("button", { class: "tog mute", type: "button", "aria-pressed": "false", title: T("am4.95a9b6") }, h("span", { class: "s", text: "M" }), h("span", { class: "l", text: "MUTE" }));
    this.muteBtn.addEventListener("click", () => { const a = app.state.auxBuses.find((x) => x.id === this.id); if (a) app.cmd(`aux.${this.id}.setMaster`, { muted: !a.mute }).then(() => app.poll()); });
    this.rmBtn = h("button", { class: "tog danger", type: "button", title: T("am4.c28190"), "aria-label": T("am4.c28190") }, h("span", { class: "s", text: "✕" }), h("span", { class: "l", text: "ENTF." }));
    this.rmBtn.addEventListener("click", async () => { const a = app.state.auxBuses.find((x) => x.id === this.id); if (a && (await app.confirm(T("am4.5cee90", { p0: a.label })))) { await app.cmd("removeAux", { auxId: this.id }); app.poll(); } });
    this.btns = h("div", { class: "btns" }, this.muteBtn, this.rmBtn);
    this.root.append(this.head, this.badges, this.meterWrap, this.fader.root, this.btns);
  }
  update(a) {
    this.nameBtn.textContent = a.label;
    this.root.setAttribute("aria-label", T("am4.75f7d9", { p0: a.label }));
    this.kind.textContent = outputKind(a);
    this.kind.title = a.kind === "group" ? T("am4.42738b", { p0: a.group }) : "";
    this.fader.setValue(a.masterDb);
    this.muteBtn.setAttribute("aria-pressed", String(!!a.mute));
    this.root.dataset.muted = a.mute ? "1" : "0";
  }
}

/** Mischgruppen-Streifen (Gruppen-Fader + Mute der AutoMix-/Mischgruppen), Kap. 32.4. */
class GroupStrip {
  constructor(app, g) {
    this.app = app;
    this.id = g.id;
    this.root = h("div", { class: "ch out grp", "data-kind": "mixgroup", role: "group" });
    this.nameBtn = h("button", { class: "name", type: "button", title: T("am4.196eef") });
    this.nameBtn.addEventListener("click", () => { const f = app.state.channels.find((c) => c.group === this.id); if (f) { app.ui.centerTab = "auto"; app.center.setTab("auto"); app.select(f.id, { open: true }); } });
    this.kind = h("span", { class: "b outkind" });
    this.fader = new Fader({
      label: T("am4.c98b09"),
      onInput: (db) => { const x = app.state.groups.find((y) => y.id === this.id); if (x) x.gainDb = db; app.touchedAt = performance.now(); app.sendNow(`group.${this.id}.setGain`, { db }, "gg" + this.id); },
      onCommit: () => app.setGainCommit(),
    });
    this.muteBtn = h("button", { class: "tog mute", type: "button", "aria-pressed": "false", title: T("am4.69467e") }, h("span", { class: "s", text: "M" }), h("span", { class: "l", text: "MUTE" }));
    this.muteBtn.addEventListener("click", () => { const x = app.state.groups.find((y) => y.id === this.id); if (x) app.cmd(`group.${this.id}.setMute`, { muted: !x.mute }).then(() => app.poll()); });
    this.root.append(h("div", { class: "chead" }, this.nameBtn), h("div", { class: "badges" }, this.kind), h("div", { class: "meterwrap grpfill" }), this.fader.root, h("div", { class: "btns" }, this.muteBtn));
  }
  update(g, members) {
    this.nameBtn.textContent = g.label;
    this.kind.textContent = T("am4.cfac66", { p0: members, p1: g.autoMixEnabled ? " · AutoMix" : "" });
    this.fader.setValue(g.gainDb);
    this.muteBtn.setAttribute("aria-pressed", String(!!g.mute));
    this.root.dataset.muted = g.mute ? "1" : "0";
    this.root.setAttribute("aria-label", T("am4.98a213", { p0: g.label }));
  }
}

/** Inline-Karte „+ Neuer Ausgang“ am Ende der Ausgangs-Sektion. */
function buildNewOutputCard(app) {
  const name = h("input", { class: "text-input", type: "text", placeholder: T("am4.a75ba5"), "aria-label": T("am4.0e5a49"), maxlength: "30" });
  const tpl = h("select", { class: "sel-input", "aria-label": T("am4.07411f") }, ...OUTPUT_TEMPLATES.map(([v, t]) => h("option", { value: v, text: t })));
  const cnt = h("input", { class: "text-input", type: "number", min: "1", max: "16", value: "4", "aria-label": T("am4.c3b623"), style: "width:4.5em" });
  cnt.hidden = true;
  tpl.addEventListener("change", () => { cnt.hidden = tpl.value !== "custom"; });
  const msg = h("p", { class: "hint" });
  const go = async () => { const r = await createOutput(app, name.value, tpl.value, cnt.value); msg.textContent = r.msg; if (r.ok) name.value = ""; };
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  const root = h("div", { class: "newout" }, h("strong", { text: T("am4.952529") }), name, tpl, cnt, h("button", { class: "tog", type: "button", text: T("am4.6212ff"), onclick: go }), msg);
  return { root, name };
}

class OutputsDialog {
  constructor(app) {
    this.app = app;
    const name = h("input", { class: "text-input", type: "text", placeholder: T("am4.766f89"), "aria-label": T("am4.9897c7"), maxlength: "30" });
    const tpl = h("select", { class: "sel-input", "aria-label": T("am4.07411f") }, ...OUTPUT_TEMPLATES.map(([v, t]) => h("option", { value: v, text: t })));
    const cnt = h("input", { class: "text-input", type: "number", min: "1", max: "16", value: "4", "aria-label": T("am4.c3b623"), style: "width:4.5em" });
    cnt.hidden = true;
    tpl.addEventListener("change", () => { cnt.hidden = tpl.value !== "custom"; });
    this.msg = h("p", { class: "hint" });
    const add = h("button", { class: "tog", type: "button", text: T("x.addOut"), onclick: () => this.create(name, tpl, cnt) });
    this.matrix = h("div", { class: "omatrix" });
    this.panWrap = h("div", { class: "opan" });
    const close = h("button", { class: "tog", type: "button", text: T("am4.8311b9"), onclick: () => this.close() });
    this.box = h("div", { class: "box wide" },
      h("h3", { text: T("am4.c02941") }),
      h("div", { class: "row" }, name, tpl, cnt, add),
      this.msg,
      this.matrix,
      this.panWrap,
      h("div", { class: "acts" }, close));
    this.root = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": T("am4.2b5618") }, this.box);
    this.root.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }
  open() {
    this.app.shadow.append(this.root);
    this.render();
    this.root.querySelector("input")?.focus();
  }
  close() {
    this.root.remove();
  }
  get isOpen() {
    return this.root.isConnected;
  }
  async create(nameEl, tplEl, cntEl) {
    const r = await createOutput(this.app, nameEl.value, tplEl.value, cntEl.value);
    this.msg.textContent = r.msg;
    if (r.ok) nameEl.value = "";
    this.render();
  }
  /** Zelle: Programm (mainRoute) oder Send auf einen Bus. */
  cell(ch, bus) {
    const app = this.app;
    if (!bus) {
      const b = h("button", { class: "tog cell", type: "button", "aria-pressed": String(!!ch.mainRoute), "aria-label": T("x.toProg", { p0: ch.label }), text: ch.mainRoute ? "●" : "○" });
      b.addEventListener("click", () => { const cur = app.state.channels.find((c) => c.id === ch.id) || ch; app.touchedAt = performance.now(); cur.mainRoute = !cur.mainRoute; app.sendCh(cur.id, "setMainRoute", { routed: cur.mainRoute }); this.render(); });
      return b;
    }
    const s = ch.sends.find((x) => x.auxId === bus.id);
    const on = !!(s && s.enabled);
    const b = h("button", { class: "tog cell", type: "button", "aria-pressed": String(on), "aria-label": `${ch.label} → ${bus.label}`, text: on ? "●" : "○" });
    if (on && (bus.channels === 6 || bus.channels === 8)) {
      const pb = h("button", { class: "tog cell mini", type: "button", "aria-label": T("am4.ce8752", { p0: ch.label, p1: bus.label }), title: T("am4.fe12ae"), text: "⌖", onclick: () => { this.panTarget = { chId: ch.id, auxId: bus.id }; this.render(); } });
      pb.setAttribute("aria-pressed", String(!!(this.panTarget && this.panTarget.chId === ch.id && this.panTarget.auxId === bus.id)));
      b.dataset.hasPan = "1";
      this.pendingPanBtn = this.pendingPanBtn || new Map();
      this.pendingPanBtn.set(b, pb);
    }
    if (s && s.locked) { b.disabled = true; b.title = T("am4.63f3d7"); }
    b.addEventListener("click", () => {
      const cur = app.state.channels.find((c) => c.id === ch.id) || ch;
      const sd = cur.sends.find((x) => x.auxId === bus.id);
      if (!sd) return;
      app.touchedAt = performance.now();
      sd.enabled = !sd.enabled;
      app.sendCh(cur.id, "setSend", { auxId: bus.id, enabled: sd.enabled }, "send" + bus.id);
      this.render();
    });
    return b;
  }
  /** Zelle + ggf. Panner-Knopf. */
  cellWithPan(ch, bus) {
    const b = this.cell(ch, bus);
    const wrap = h("div", { class: "cellwrap" }, b);
    const pb = this.pendingPanBtn && this.pendingPanBtn.get(b);
    if (pb) wrap.append(pb);
    return wrap;
  }
  /** Panner-Bereich für den gewählten Send (Kanal → Ausgang). */
  renderPanner() {
    const t = this.panTarget;
    const st = this.app.state;
    const ch = t && st.channels.find((c) => c.id === t.chId);
    const bus = t && st.auxBuses.find((a) => a.id === t.auxId);
    const s = ch && ch.sends.find((x) => x.auxId === t.auxId);
    if (!ch || !bus || !s || !s.enabled || !(bus.channels === 6 || bus.channels === 8)) { this.panWrap.replaceChildren(); this.panWidget = null; this.panKey = ""; return; }
    const key = `${ch.id}|${bus.id}|${bus.channels}`;
    if (this.panKey !== key) {
      this.panKey = key;
      this.panWidget = new PannerWidget({ channels: bus.channels, onChange: (p) => { s.pan = p; this.app.sendCh(ch.id, "setSendPan", { auxId: bus.id, x: p.x, y: p.y, center: p.center, lfeDb: p.lfeDb }, "pan" + bus.id); } });
      this.panWrap.replaceChildren(h("h4", { text: T("am4.9cd71a", { p0: ch.label, p1: bus.label }) }), this.panWidget.root);
    }
    if (!this.panWidget.pad.matches(":active")) this.panWidget.setPan(s.pan);
  }
  render() {
    this.pendingPanBtn = new Map();
    const app = this.app;
    const st = app.state;
    const buses = st.auxBuses;
    const head = h("tr", {}, h("th", { text: T("am4.84eb86") }), h("th", { text: T("am4.3b0451") }),
      ...buses.map((a) => {
        const kind = outputKind(a);
        const rm = h("button", { class: "tog danger mini", type: "button", "aria-label": T("am4.7a8d57", { p0: a.label }), text: "✕", onclick: async () => { if (await app.confirm(T("am4.5cee90", { p0: a.label }))) { await app.cmd("removeAux", { auxId: a.id }); await app.poll(); this.render(); } } });
        return h("th", { title: a.kind === "group" ? T("am4.42738b", { p0: a.group }) : "" }, h("div", { text: a.label }), h("div", { class: "hint", text: kind }), rm);
      }));
    const rows = st.channels.map((ch) => h("tr", {}, h("td", { class: "rname", text: ch.label }), h("td", {}, this.cell(ch, null)), ...buses.map((a) => h("td", {}, this.cellWithPan(ch, a)))));
    this.matrix.replaceChildren(st.channels.length ? h("table", {}, h("thead", {}, head), h("tbody", {}, ...rows)) : h("p", { class: "hint", text: T("am4.85c7c1") }));
    this.renderPanner();
  }
}

// ───── Surround-Panner (Kap. 32.3) ─────
const PAN_DEFAULT = { x: 0, y: 1, center: 0, lfeDb: -60 };
const PAN_LFE_OFF = -60;

/** Joystick (vorn oben, hinten unten) + Center-/LFE-Regler für einen Send auf einen 5.1-/7.1-Bus. */
class PannerWidget {
  constructor({ onChange, channels = 6 }) {
    this.onChange = onChange;
    this.pan = { ...PAN_DEFAULT };
    this.puck = h("i", { class: "ppuck" });
    this.pad = h("div", { class: "ppad", role: "application", tabindex: "0", "aria-label": T("am4.8dc63f") });
    const mark = (t, x, y) => h("span", { class: "pspk", text: t, style: `left:${x}%;top:${y}%` });
    const spk = channels === 8
      ? [mark("L", 6, 8), mark("R", 94, 8), mark("C", 50, 6), mark("Ls", 4, 50), mark("Rs", 96, 50), mark("Lb", 18, 94), mark("Rb", 82, 94)]
      : [mark("L", 6, 8), mark("R", 94, 8), mark("C", 50, 6), mark("Ls", 10, 92), mark("Rs", 90, 92)];
    this.pad.append(h("i", { class: "pcross h" }), h("i", { class: "pcross v" }), ...spk, this.puck);
    this.center = new Slider({ label: T("am4.2f41fa"), min: 0, max: 100, step: 1, def: 0, unit: "%", fmt: (v) => `${Math.round(v)} %`, onInput: (v) => this.set({ center: v / 100 }) });
    this.lfe = new Slider({ label: "LFE-Pegel", min: PAN_LFE_OFF, max: 6, step: 0.5, def: PAN_LFE_OFF, unit: "dB", fmt: (v) => (v <= PAN_LFE_OFF + 0.01 ? "aus" : `${fmtSigned(v)} dB`), onInput: (v) => this.set({ lfeDb: v }) });
    this.readout = h("output", { class: "hint" });
    this.root = h("div", { class: "panner" }, this.pad, h("div", { class: "pctl" }, this.readout, this.center.root, this.lfe.root, h("button", { class: "tog", type: "button", text: T("am4.02fa34"), onclick: () => this.set({ ...PAN_DEFAULT }) })));
    const at = (e) => {
      const r = this.pad.getBoundingClientRect();
      return { x: Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)), y: Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2)) };
    };
    let drag = false;
    this.pad.addEventListener("pointerdown", (e) => { drag = true; this.pad.setPointerCapture(e.pointerId); this.set(at(e)); e.preventDefault(); });
    this.pad.addEventListener("pointermove", (e) => { if (drag) this.set(at(e)); });
    const up = () => { drag = false; };
    this.pad.addEventListener("pointerup", up);
    this.pad.addEventListener("pointercancel", up);
    this.pad.addEventListener("dblclick", () => this.set({ x: 0, y: 1 }));
    this.pad.addEventListener("keydown", (e) => {
      const st = e.shiftKey ? 0.2 : 0.05;
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
      if (d) { this.set({ x: this.pan.x + d[0], y: this.pan.y + d[1] }); e.preventDefault(); }
      else if (e.key === "Home") { this.set({ x: 0, y: 1 }); e.preventDefault(); }
    });
    this.render();
  }
  set(patch) {
    const p = { ...this.pan, ...patch };
    p.x = Math.max(-1, Math.min(1, p.x));
    p.y = Math.max(-1, Math.min(1, p.y));
    p.center = Math.max(0, Math.min(1, p.center));
    p.lfeDb = Math.max(PAN_LFE_OFF, Math.min(6, p.lfeDb));
    this.pan = p;
    this.render();
    this.onChange({ ...p });
  }
  /** Von außen (Zustand vom Node) setzen, ohne Befehl zu senden. */
  setPan(p) {
    this.pan = { ...PAN_DEFAULT, ...(p || {}) };
    this.render();
  }
  render() {
    const p = this.pan;
    this.puck.style.left = `${((p.x + 1) / 2) * 100}%`;
    this.puck.style.top = `${((1 - p.y) / 2) * 100}%`;
    this.center.setValue(p.center * 100);
    this.lfe.setValue(p.lfeDb);
    this.readout.textContent = T("am4.594205", { p0: p.x >= 0 ? "+" : "", p1: Math.round(p.x * 100), p2: p.y >= 0 ? "+" : "", p3: Math.round(p.y * 100) });
    this.pad.setAttribute("aria-valuetext", this.readout.textContent);
  }
}
