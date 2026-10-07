// Ausgänge & Routing (Kap. 32.1): ein Dialog statt verstreuter Aux-Reiter-Formulare.
// Oben „Ausgang anlegen“ (Vorlage Mono/Stereo/5.1/7.1/Eigene), darunter die Routing-Matrix
// Kanal × Ausgang (Programm + alle Busse) — ein Kanal kann beliebig viele Ausgänge speisen.

const OUTPUT_TEMPLATES = [
  ["stereo", "Stereo (2.0)", 2],
  ["5.1", "5.1 Surround", 6],
  ["7.1", "7.1 Surround", 8],
  ["mono", "Mono", 1],
  ["custom", "Eigene Kanalzahl", 4],
];

/** Gruppen-Tag aus dem Anzeigenamen: klein, a–z/0–9/-, höchstens 20 Zeichen. */
function slugGroup(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}

class OutputsDialog {
  constructor(app) {
    this.app = app;
    const name = h("input", { class: "text-input", type: "text", placeholder: "Name des Ausgangs (z. B. Hauptton 5.1)", "aria-label": "Name des Ausgangs", maxlength: "30" });
    const tpl = h("select", { class: "sel-input", "aria-label": "Vorlage" }, ...OUTPUT_TEMPLATES.map(([v, t]) => h("option", { value: v, text: t })));
    const cnt = h("input", { class: "text-input", type: "number", min: "1", max: "16", value: "4", "aria-label": "Kanalzahl", style: "width:4.5em" });
    cnt.hidden = true;
    tpl.addEventListener("change", () => { cnt.hidden = tpl.value !== "custom"; });
    this.msg = h("p", { class: "hint" });
    const add = h("button", { class: "tog", type: "button", text: "+ Ausgang anlegen", onclick: () => this.create(name, tpl, cnt) });
    this.matrix = h("div", { class: "omatrix" });
    this.panWrap = h("div", { class: "opan" });
    const close = h("button", { class: "tog", type: "button", text: "Schließen", onclick: () => this.close() });
    this.box = h("div", { class: "box wide" },
      h("h3", { text: "Ausgänge & Routing" }),
      h("div", { class: "row" }, name, tpl, cnt, add),
      this.msg,
      this.matrix,
      this.panWrap,
      h("div", { class: "acts" }, close));
    this.root = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Ausgänge und Routing" }, this.box);
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
    const label = nameEl.value.trim();
    if (!label) { this.msg.textContent = "Bitte einen Namen eingeben."; return; }
    const group = slugGroup(label);
    if (!group) { this.msg.textContent = "Der Name braucht mindestens einen Buchstaben oder eine Ziffer."; return; }
    const st = this.app.state;
    if (st.auxBuses.some((a) => a.kind === "group" && a.group === group)) { this.msg.textContent = `Es gibt schon einen Ausgang mit der Gruppe „${group}“.`; return; }
    if (st.auxFree <= 0) { this.msg.textContent = "Keine freien Ausgänge mehr (max. 10 Busse)."; return; }
    const layout = tplEl.value;
    const channels = layout === "custom" ? Number(cntEl.value) : OUTPUT_TEMPLATES.find((t) => t[0] === layout)[2];
    await this.app.cmd("addAux", { kind: "group", group, layout, channels, label });
    nameEl.value = "";
    this.msg.textContent = `Ausgang „${label}“ angelegt (Sender-Tag role.${group}). Kanäle in der Matrix zuordnen.`;
    await this.app.poll();
    this.render();
  }
  /** Zelle: Programm (mainRoute) oder Send auf einen Bus. */
  cell(ch, bus) {
    const app = this.app;
    if (!bus) {
      const b = h("button", { class: "tog cell", type: "button", "aria-pressed": String(!!ch.mainRoute), "aria-label": `${ch.label} → Programm`, text: ch.mainRoute ? "●" : "○" });
      b.addEventListener("click", () => { ch.mainRoute = !ch.mainRoute; app.sendCh(ch.id, "setMainRoute", { routed: ch.mainRoute }); this.render(); });
      return b;
    }
    const s = ch.sends.find((x) => x.auxId === bus.id);
    const on = !!(s && s.enabled);
    const b = h("button", { class: "tog cell", type: "button", "aria-pressed": String(on), "aria-label": `${ch.label} → ${bus.label}`, text: on ? "●" : "○" });
    if (on && (bus.channels === 6 || bus.channels === 8)) {
      const pb = h("button", { class: "tog cell mini", type: "button", "aria-label": `Panner ${ch.label} → ${bus.label}`, title: "Surround-Panner (Joystick)", text: "⌖", onclick: () => { this.panTarget = { chId: ch.id, auxId: bus.id }; this.render(); } });
      pb.setAttribute("aria-pressed", String(!!(this.panTarget && this.panTarget.chId === ch.id && this.panTarget.auxId === bus.id)));
      b.dataset.hasPan = "1";
      this.pendingPanBtn = this.pendingPanBtn || new Map();
      this.pendingPanBtn.set(b, pb);
    }
    if (s && s.locked) { b.disabled = true; b.title = "Automatisch zugeordnet (Tag-Regel)"; }
    b.addEventListener("click", () => {
      if (!s) return;
      s.enabled = !s.enabled;
      app.sendCh(ch.id, "setSend", { auxId: bus.id, enabled: s.enabled }, "send" + bus.id);
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
      this.panWrap.replaceChildren(h("h4", { text: `Panner: ${ch.label} → ${bus.label}` }), this.panWidget.root);
    }
    if (!this.panWidget.pad.matches(":active")) this.panWidget.setPan(s.pan);
  }
  render() {
    this.pendingPanBtn = new Map();
    const app = this.app;
    const st = app.state;
    const buses = st.auxBuses;
    const head = h("tr", {}, h("th", { text: "Kanal" }), h("th", { text: "Programm" }),
      ...buses.map((a) => {
        const kind = a.kind === "group" ? `${a.layout || ""} · ${a.channels} Kn.` : a.kind === "n1" ? "N-1" : "Aux";
        const rm = h("button", { class: "tog danger mini", type: "button", "aria-label": `Ausgang ${a.label} entfernen`, text: "✕", onclick: async () => { if (await app.confirm(`Ausgang „${a.label}“ entfernen?`)) { await app.cmd("removeAux", { auxId: a.id }); await app.poll(); this.render(); } } });
        return h("th", { title: a.kind === "group" ? `Sender-Tag role.${a.group}` : "" }, h("div", { text: a.label }), h("div", { class: "hint", text: kind }), rm);
      }));
    const rows = st.channels.map((ch) => h("tr", {}, h("td", { class: "rname", text: ch.label }), h("td", {}, this.cell(ch, null)), ...buses.map((a) => h("td", {}, this.cellWithPan(ch, a)))));
    this.matrix.replaceChildren(st.channels.length ? h("table", {}, h("thead", {}, head), h("tbody", {}, ...rows)) : h("p", { class: "hint", text: "Noch keine Kanäle." }));
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
    this.pad = h("div", { class: "ppad", role: "application", tabindex: "0", "aria-label": "Panner: Pfeiltasten bewegen die Position, Pos1 setzt auf vorn Mitte" });
    const mark = (t, x, y) => h("span", { class: "pspk", text: t, style: `left:${x}%;top:${y}%` });
    const spk = channels === 8
      ? [mark("L", 6, 8), mark("R", 94, 8), mark("C", 50, 6), mark("Ls", 4, 50), mark("Rs", 96, 50), mark("Lb", 18, 94), mark("Rb", 82, 94)]
      : [mark("L", 6, 8), mark("R", 94, 8), mark("C", 50, 6), mark("Ls", 10, 92), mark("Rs", 90, 92)];
    this.pad.append(h("i", { class: "pcross h" }), h("i", { class: "pcross v" }), ...spk, this.puck);
    this.center = new Slider({ label: "Center-Anteil", min: 0, max: 100, step: 1, def: 0, unit: "%", fmt: (v) => `${Math.round(v)} %`, onInput: (v) => this.set({ center: v / 100 }) });
    this.lfe = new Slider({ label: "LFE-Pegel", min: PAN_LFE_OFF, max: 6, step: 0.5, def: PAN_LFE_OFF, unit: "dB", fmt: (v) => (v <= PAN_LFE_OFF + 0.01 ? "aus" : `${fmtSigned(v)} dB`), onInput: (v) => this.set({ lfeDb: v }) });
    this.readout = h("output", { class: "hint" });
    this.root = h("div", { class: "panner" }, this.pad, h("div", { class: "pctl" }, this.readout, this.center.root, this.lfe.root, h("button", { class: "tog", type: "button", text: "Zurücksetzen", onclick: () => this.set({ ...PAN_DEFAULT }) })));
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
    this.readout.textContent = `Links/Rechts ${p.x >= 0 ? "+" : ""}${Math.round(p.x * 100)} · Vorn/Hinten ${p.y >= 0 ? "+" : ""}${Math.round(p.y * 100)}`;
    this.pad.setAttribute("aria-valuetext", this.readout.textContent);
  }
}
