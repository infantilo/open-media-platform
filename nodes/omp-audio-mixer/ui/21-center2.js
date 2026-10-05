// ───────────────────────────── Center Control, Teil 2 ─────────────────────────────
// Routing/Aux/N-1, AutoMix + Gruppen, Ducking, Automation (Media + AFV), Szenen.

/** Liste mit stabilen Zeilen: baut nur bei geänderter ID-Menge um, sonst nur Werte setzen. */
class KeyedList {
  constructor(host, make) {
    this.host = host;
    this.make = make;
    this.rows = new Map();
    this.key = "";
  }
  sync(items, idOf, signature = "") {
    const key = items.map(idOf).join("|") + "#" + signature;
    if (key !== this.key) {
      this.key = key;
      this.rows.clear();
      this.host.replaceChildren();
      for (const it of items) {
        const row = this.make(it);
        this.rows.set(idOf(it), row);
        this.host.append(row.root);
      }
    }
    for (const it of items) this.rows.get(idOf(it))?.update(it);
  }
}

Object.assign(CenterControl.prototype, {
  // ───── AUX / Routing ─────
  tabRoute() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const main = this.grid();
    this.toggle("Auf Programm geroutet", (ch) => ch.mainRoute, (ch, v) => { ch.mainRoute = v; app.sendCh(ch.id, "setMainRoute", { routed: v }); }, main);
    this.toggle("Solo / PFL", (ch) => ch.pfl, (ch) => app.togglePfl(ch.id), main);
    const note = h("p", { class: "hint", text: "ON AIR = hörbar im Programm: nicht stumm, auf Programm geroutet, Fader/AutoMix/Ducking nicht weggeregelt. Aux-Sends bleiben vom Programm-Routing unberührt." });

    const sendHost = h("div", { class: "rows" });
    const sends = new KeyedList(sendHost, (aux) => {
      const name = h("span", { class: "rname" });
      const tgl = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "Send" });
      const lock = h("span", { class: "hint lock", text: "gesperrt" });
      const seg = h("div", { class: "seg" });
      const pre = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "Pre" });
      const post = h("button", { class: "tog", type: "button", "aria-pressed": "true", text: "Post" });
      seg.append(pre, post);
      const sl = new Slider({ label: "Pegel", min: -60, max: 12, step: 0.5, def: 0, unit: "dB", fmt: (v) => fmtSigned(v) + " dB", onInput: (v) => this.setSend(aux.id, { levelDb: v }) });
      const curSend = () => this.cur()?.sends.find((s) => s.auxId === aux.id);
      tgl.addEventListener("click", () => { const s = curSend(); if (s && !s.locked) this.setSend(aux.id, { enabled: !s.enabled }); });
      pre.addEventListener("click", () => { const s = curSend(); if (s && !s.locked) this.setSend(aux.id, { post: false }); });
      post.addEventListener("click", () => { const s = curSend(); if (s && !s.locked) this.setSend(aux.id, { post: true }); });
      const rowRoot = h("div", { class: "row" }, name, tgl, seg, sl.root, lock);
      return {
        root: rowRoot,
        update: (a) => {
          const ch = this.cur();
          const s = ch?.sends.find((x) => x.auxId === aux.id);
          if (!s) return;
          const exName = a.kind === "n1" && a.exclude ? app.state.channels.find((c) => c.id === a.exclude)?.label : "";
          name.textContent = a.label + (a.kind === "n1" ? ` (N-1${exName ? " ohne " + exName : ""})` : "");
          tgl.setAttribute("aria-pressed", String(s.enabled));
          tgl.textContent = s.enabled ? "Send AN" : "Send AUS";
          pre.setAttribute("aria-pressed", String(!s.post));
          post.setAttribute("aria-pressed", String(s.post));
          sl.setValue(s.levelDb);
          lock.hidden = !s.locked;
          rowRoot.dataset.locked = s.locked ? "1" : "0";
          for (const b of [tgl, pre, post]) b.disabled = s.locked;
        },
      };
    });
    this.bind(() => {
      const ch = this.cur();
      if (!ch) return;
      sends.sync(app.state.auxBuses, (a) => a.id, app.state.auxBuses.map((a) => a.kind + a.exclude).join(","));
      sendHost.dataset.empty = app.state.auxBuses.length ? "0" : "1";
    });
    const emptyHint = h("p", { class: "hint", text: "Noch kein Aux-/N-1-Bus angelegt (unten „+ Aux“ / „+ N-1“)." });
    this.bind(() => { emptyHint.hidden = app.state.auxBuses.length > 0; });

    // Busse verwalten
    const mgr = h("div", { class: "rows" });
    const buses = new KeyedList(mgr, (aux) => {
      const name = h("input", { class: "text-input", type: "text", "aria-label": "Busname", maxlength: "30" });
      name.addEventListener("change", () => app.cmd(`aux.${aux.id}.setLabel`, { label: name.value }).then(() => app.poll()));
      const master = new Slider({ label: "Bus-Pegel", min: -60, max: 12, step: 0.5, def: 0, unit: "dB", fmt: (v) => fmtSigned(v) + " dB", onInput: (v) => app.sendNow(`aux.${aux.id}.setMaster`, { db: v }, "am" + aux.id, () => { const a = app.state.auxBuses.find((x) => x.id === aux.id); if (a) a.masterDb = v; }) });
      const mute = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "Mute", onclick: () => { const a = app.state.auxBuses.find((x) => x.id === aux.id); app.cmd(`aux.${aux.id}.setMaster`, { muted: !a.mute }).then(() => app.poll()); } });
      const ex = h("select", { class: "sel-input", "aria-label": "N-1 ohne Kanal" });
      const exWrap = h("label", { class: "field" }, h("span", { text: "N-1: ohne" }), ex);
      ex.addEventListener("change", () => app.cmd(`aux.${aux.id}.setN1`, { exclude: ex.value }).then(() => app.poll()));
      const rm = h("button", { class: "tog danger", type: "button", text: "Entfernen", onclick: async () => { if (await app.confirm(`Bus „${aux.label}“ entfernen?`)) app.cmd("removeAux", { auxId: aux.id }).then(() => app.poll()); } });
      let exKey = "";
      return {
        root: h("div", { class: "row" }, name, master.root, mute, exWrap, rm),
        update: (a) => {
          if (document.activeElement !== name && app.shadow.activeElement !== name) name.value = a.label;
          master.setValue(a.masterDb);
          mute.setAttribute("aria-pressed", String(a.mute));
          exWrap.hidden = a.kind !== "n1";
          const k = app.state.channels.map((c) => c.id + c.label).join("|");
          if (k !== exKey) { exKey = k; ex.replaceChildren(h("option", { value: "", text: "(keiner)" }), ...app.state.channels.map((c) => h("option", { value: c.id, text: c.label }))); }
          ex.value = a.exclude || "";
        },
      };
    });
    this.bind(() => buses.sync(app.state.auxBuses, (a) => a.id));
    const newName = h("input", { class: "text-input", type: "text", placeholder: "Name (z. B. Monitor, IFB, N-1 Kommentator)", "aria-label": "Neuer Bus", maxlength: "30" });
    const addAux = h("button", { class: "tog", type: "button", text: "+ Aux", onclick: () => app.cmd("addAux", { label: newName.value, kind: "aux" }).then(() => { newName.value = ""; app.poll(); }) });
    const addN1 = h("button", { class: "tog", type: "button", text: "+ N-1 für diesen Kanal", title: "Mix-Minus: alles außer diesem Kanal", onclick: async () => {
      const ch = this.cur(); if (!ch) return;
      await app.cmd("addAux", { label: newName.value || "N-1 " + ch.label, kind: "n1" });
      await app.poll();
      const bus = app.state.auxBuses.filter((a) => a.kind === "n1" && !a.exclude).pop();
      if (bus) await app.cmd(`aux.${bus.id}.setN1`, { exclude: ch.id });
      newName.value = "";
      app.poll();
    } });
    const free = h("span", { class: "hint" });
    this.bind(() => { free.textContent = `${app.state.auxFree} Slots frei`; addAux.disabled = addN1.disabled = app.state.auxFree <= 0; });
    root.append(this.section("Programm", main, note), this.section("Aux- und N-1-Sends dieses Kanals", sendHost, emptyHint), this.section("Busse verwalten", mgr, h("div", { class: "rows" }, h("div", { class: "row" }, newName, addAux, addN1, free))));
    return root;
  },
  setSend(auxId, patch) {
    const ch = this.cur();
    if (!ch) return;
    const s = ch.sends.find((x) => x.auxId === auxId);
    if (!s || s.locked) return;
    Object.assign(s, patch);
    this.app.sendCh(ch.id, "setSend", { auxId, ...patch }, "send" + auxId);
    this.refresh();
  },

  // ───── AutoMix + Gruppen ─────
  tabAuto() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const grp = (ch) => app.state.groups.find((g) => g.id === ch.group);
    const chGrid = this.grid();
    this.select("Gruppe", () => [["", "— keine —"], ...app.state.groups.map((g) => [g.id, g.label])], (ch) => ch.group, (ch, v) => { ch.group = v; app.sendCh(ch.id, "setGroup", { groupId: v }).then(() => app.poll()); this.refresh(); }, chGrid);
    const am = (ch) => app.sendCh(ch.id, "setAutoMix", { enabled: ch.autoMix.enabled, weight: ch.autoMix.weight, priority: ch.autoMix.priority, sensitivityDb: ch.autoMix.sensitivityDb }, "am");
    this.toggle("AutoMix-Teilnahme", (ch) => ch.autoMix.enabled, (ch, v) => { ch.autoMix.enabled = v; am(ch); }, chGrid);
    this.toggle("Manual (Automation übersteuern)", (ch) => ch.manual, (ch, v) => { ch.manual = v; app.sendCh(ch.id, "setManual", { manual: v }); }, chGrid, { title: "AutoMix und Ducking wirken nicht auf diesen Kanal; Kontext-Szenen lassen ihn unberührt." });
    this.slider({ label: "Gewicht", min: 0.1, max: 4, step: 0.1, scale: "log", def: 1, fmt: (v) => "×" + v.toFixed(1), get: (ch) => ch.autoMix.weight, set: (ch, v) => { ch.autoMix.weight = v; am(ch); } }, chGrid);
    this.segmented([[0, "Normal"], [1, "Bevorzugt"], [2, "Host"]], (ch) => ch.autoMix.priority, (ch, v) => { ch.autoMix.priority = v; am(ch); }, chGrid, "Priorität");
    this.slider({ label: "Empfindlichkeit (Sprach-Schwelle)", min: -90, max: -10, step: 1, def: -50, unit: "dB", get: (ch) => ch.autoMix.sensitivityDb, set: (ch, v) => { ch.autoMix.sensitivityDb = v; am(ch); } }, chGrid);
    const liveOut = h("output", { class: "livebig", "aria-live": "off" });
    this.live(() => { const l = app.live.get(app.ui.selected); const t = l ? `AUTO ${fmtSigned(l.autoDb)} dB   DUCK ${fmtSigned(l.duckDb)} dB` : ""; if (liveOut.textContent !== t) liveOut.textContent = t; });

    const gSec = h("div");
    const gGrid = this.grid();
    const gset = (fn) => { const g = grp(this.cur()); if (g) { fn(g); app.sendNow(`group.${g.id}.setAutoMix`, { enabled: g.autoMixEnabled, attackMs: g.attackMs, holdMs: g.holdMs, releaseMs: g.releaseMs, maxAttenDb: g.maxAttenDb, sharing: g.sharing, detector: g.detector }, "ga" + g.id); } };
    const gv = (key) => (ch) => grp(ch)?.[key];
    this.bind(() => { gSec.hidden = !grp(this.cur()); });
    const gname = h("input", { class: "text-input", type: "text", "aria-label": "Gruppenname", maxlength: "30" });
    gname.addEventListener("change", () => { const g = grp(this.cur()); if (g && gname.value) app.cmd(`group.${g.id}.setLabel`, { label: gname.value }).then(() => app.poll()); });
    this.bind(() => { const g = grp(this.cur()); if (g && app.shadow.activeElement !== gname) gname.value = g.label; });
    const gs = new Slider({ label: "Gruppen-Fader", min: -60, max: 12, step: 0.5, def: 0, unit: "dB", fmt: (v) => fmtSigned(v) + " dB", onInput: (v) => { const g = grp(this.cur()); if (g) { g.gainDb = v; app.sendNow(`group.${g.id}.setGain`, { db: v }, "gg" + g.id); } } });
    this.bind(() => { const g = grp(this.cur()); if (g) gs.setValue(g.gainDb); });
    gGrid.append(gs.root);
    const gmute = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "Gruppe stumm", onclick: () => { const g = grp(this.cur()); if (g) { g.mute = !g.mute; app.cmd(`group.${g.id}.setMute`, { muted: g.mute }).then(() => app.poll()); this.refresh(); } } });
    this.bind(() => { const g = grp(this.cur()); if (g) gmute.setAttribute("aria-pressed", String(g.mute)); });
    gGrid.append(gmute);
    const gtog = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "AutoMix der Gruppe aktiv", onclick: () => gset((g) => { g.autoMixEnabled = !g.autoMixEnabled; this.refresh(); }) });
    this.bind(() => { const g = grp(this.cur()); if (g) gtog.setAttribute("aria-pressed", String(g.autoMixEnabled)); });
    gGrid.append(gtog);
    const gsl = (label, key, min, max, step, def, unit, scale) => { const s = new Slider({ label, min, max, step, def, unit, scale, onInput: (v) => gset((g) => { g[key] = v; }) }); gGrid.append(s.root); this.bind(() => { const g = grp(this.cur()); if (g) s.setValue(g[key]); }); };
    gsl("Attack", "attackMs", 1, 500, 1, 40, "ms", "log");
    gsl("Hold", "holdMs", 0, 2000, 10, 300, "ms");
    gsl("Release", "releaseMs", 10, 5000, 10, 700, "ms", "log");
    gsl("Max. Absenkung", "maxAttenDb", -60, 0, 1, -18, "dB");
    gsl("Gain-Sharing", "sharing", 0.5, 3, 0.1, 1, "");
    const det = h("select", { class: "sel-input", "aria-label": "Detektor" }, DETECTORS.map(([v, t]) => h("option", { value: v, text: t })));
    det.addEventListener("change", () => gset((g) => { g.detector = det.value; }));
    this.bind(() => { const g = grp(this.cur()); if (g) det.value = g.detector; });
    gGrid.append(h("label", { class: "field" }, h("span", { text: "Detektor" }), det));
    gSec.append(this.section("Gruppe", gname, gGrid));

    const mgr = h("div", { class: "rows" });
    const groups = new KeyedList(mgr, (g) => {
      const name = h("span", { class: "rname" });
      const rm = h("button", { class: "tog danger", type: "button", text: "Löschen", onclick: async () => { if (await app.confirm(`Gruppe „${g.label}“ löschen? Die Kanäle behalten alle Einstellungen.`)) app.cmd("removeGroup", { groupId: g.id }).then(() => app.poll()); } });
      const assign = h("button", { class: "tog", type: "button", text: "Kanal zuordnen", onclick: () => { const ch = this.cur(); if (ch) { ch.group = g.id; app.sendCh(ch.id, "setGroup", { groupId: g.id }).then(() => app.poll()); this.refresh(); } } });
      return { root: h("div", { class: "row" }, name, assign, rm), update: (x) => { const n = app.state.channels.filter((c) => c.group === x.id).length; name.textContent = `${x.label} (${n} Kanäle${x.autoMixEnabled ? ", AutoMix" : ""})`; } };
    });
    this.bind(() => groups.sync(app.state.groups, (g) => g.id));
    const newGroup = h("input", { class: "text-input", type: "text", placeholder: "Neue Gruppe (z. B. Studio Mics)", "aria-label": "Neue Gruppe", maxlength: "30" });
    const addGroup = h("button", { class: "tog", type: "button", text: "+ Gruppe", onclick: () => app.cmd("addGroup", { label: newGroup.value }).then(() => { newGroup.value = ""; app.poll(); }) });
    root.append(this.section("Dieser Kanal", chGrid, liveOut), gSec, this.section("Gruppen", mgr, h("div", { class: "rows" }, h("div", { class: "row" }, newGroup, addGroup))));
    return root;
  },

  // ───── Ducking ─────
  tabDuck() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const top = this.grid();
    this.toggle("Dieser Kanal darf geduckt werden", (ch) => ch.duckable, (ch, v) => { ch.duckable = v; app.sendCh(ch.id, "setDuckable", { enabled: v }); }, top);
    const liveOut = h("output", { class: "livebig" });
    this.live(() => { const l = app.live.get(app.ui.selected); const t = l ? `DUCK ${fmtSigned(l.duckDb)} dB` : ""; if (liveOut.textContent !== t) liveOut.textContent = t; });
    const host = h("div", { class: "rules" });
    const rules = new KeyedList(host, (r) => {
      const send = () => app.sendNow(`duck.${r.id}.set`, (() => { const x = app.state.duckRules.find((d) => d.id === r.id); return { enabled: x.enabled, keys: x.keys.join(","), targets: x.targets.join(","), thresholdDb: x.thresholdDb, hysteresisDb: x.hysteresisDb, amountDb: x.amountDb, maxDb: x.maxDb, attackMs: x.attackMs, holdMs: x.holdMs, releaseMs: x.releaseMs, minTriggerMs: x.minTriggerMs, detector: x.detector }; })(), "dk" + r.id);
      const me = () => app.state.duckRules.find((d) => d.id === r.id);
      const name = h("input", { class: "text-input", type: "text", "aria-label": "Regelname", maxlength: "40" });
      name.addEventListener("change", () => app.cmd(`duck.${r.id}.setLabel`, { label: name.value }).then(() => app.poll()));
      const en = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "Regel aktiv", onclick: () => { const x = me(); x.enabled = !x.enabled; send(); this.refresh(); } });
      const rm = h("button", { class: "tog danger", type: "button", text: "Löschen", onclick: async () => { if (await app.confirm("Ducking-Regel löschen?")) app.cmd("removeDuck", { duckId: r.id }).then(() => app.poll()); } });
      const picker = (title, field) => {
        const box = h("details", { class: "picker" }, h("summary", { text: title }));
        const list = h("div", { class: "checks" });
        box.append(list);
        let key = "";
        return {
          root: box,
          update: (x) => {
            const items = [...app.state.groups.map((g) => ["group:" + g.id, "Gruppe: " + g.label]), ...app.state.channels.map((c) => [c.id, c.label])];
            const k = JSON.stringify(items);
            if (k !== key) {
              key = k;
              list.replaceChildren(...items.map(([v, t]) => { const cb = h("input", { type: "checkbox", value: v }); cb.addEventListener("change", () => { const xr = me(); const set = new Set(xr[field]); cb.checked ? set.add(v) : set.delete(v); xr[field] = [...set]; send(); this.refresh(); }); return h("label", { class: "chk" }, cb, t); }));
            }
            for (const cb of list.querySelectorAll("input")) cb.checked = x[field].includes(cb.value);
            const names = x[field].map((v) => (v.startsWith("group:") ? app.state.groups.find((g) => g.id === v.slice(6))?.label : app.state.channels.find((c) => c.id === v)?.label) || v);
            box.firstChild.textContent = `${title}: ${names.length ? names.join(", ") : "—"}`;
          },
        };
      };
      const keys = picker("Key (Sidechain-Quelle)", "keys");
      const targets = picker("Ziel", "targets");
      const grid = this.grid();
      const sls = [];
      const sl = (label, key, min, max, step, def, unit, scale) => { const s = new Slider({ label, min, max, step, def, unit, scale, onInput: (v) => { me()[key] = v; send(); } }); grid.append(s.root); sls.push(() => s.setValue(me()[key])); };
      sl("Schwelle", "thresholdDb", -90, 0, 0.5, -38, "dB");
      sl("Hysterese", "hysteresisDb", 0, 20, 0.5, 4, "dB");
      sl("Duck-Betrag", "amountDb", -40, 0, 0.5, -8, "dB");
      sl("Max. Absenkung", "maxDb", -60, 0, 0.5, -20, "dB");
      sl("Attack", "attackMs", 1, 2000, 1, 120, "ms", "log");
      sl("Hold", "holdMs", 0, 5000, 10, 500, "ms");
      sl("Release", "releaseMs", 50, 10000, 10, 1500, "ms", "log");
      sl("Min. Auslösedauer", "minTriggerMs", 0, 500, 5, 60, "ms");
      const det = h("select", { class: "sel-input", "aria-label": "Detektor" }, DETECTORS.map(([v, t]) => h("option", { value: v, text: t })));
      det.addEventListener("change", () => { me().detector = det.value; send(); });
      grid.append(h("label", { class: "field" }, h("span", { text: "Detektor" }), det));
      return {
        root: h("div", { class: "card" }, h("div", { class: "row" }, name, en, rm), keys.root, targets.root, grid),
        update: (x) => {
          if (app.shadow.activeElement !== name) name.value = x.label;
          en.setAttribute("aria-pressed", String(x.enabled));
          keys.update(x);
          targets.update(x);
          for (const f of sls) f();
          det.value = x.detector;
        },
      };
    });
    this.bind(() => rules.sync(app.state.duckRules, (r) => r.id));
    const add = h("button", { class: "tog", type: "button", text: "+ Ducking-Regel", onclick: () => app.cmd("addDuck", { label: "" }).then(() => app.poll()) });
    const asKey = h("button", { class: "tog", type: "button", text: "+ Regel mit diesem Kanal als Key", onclick: async () => {
      const ch = this.cur(); if (!ch) return;
      await app.cmd("addDuck", { label: "Ducking " + ch.label }); await app.poll();
      const r = app.state.duckRules[app.state.duckRules.length - 1];
      if (r) await app.cmd(`duck.${r.id}.set`, { keys: ch.id, enabled: false });
      app.poll();
    } });
    root.append(this.section("Dieser Kanal", top, liveOut), this.section("Ducking-Regeln (Key → Ziel)", host, h("div", { class: "rows" }, h("div", { class: "row" }, add, asKey))), h("p", { class: "hint", text: "Ducking ist eine eigene Engine: ein Key-Kanal senkt Ziel-Kanäle um einen festen Betrag ab (keine Kompression), mit Schwelle, Hysterese, Hold und langem Release. Stumme Keys lösen nichts aus." }));
    return root;
  },

  // ───── Automation (Media + AFV) ─────
  tabMedia() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const top = this.grid();
    const cfg = (ch, patch) => { Object.assign(ch.automation, patch); app.sendCh(ch.id, "setAutomation", { enabled: ch.automation.enabled, target: ch.automation.target, rules: JSON.stringify(ch.automation.rules) }, "auto"); };
    this.toggle("Media-Automation aktiv", (ch) => ch.automation.enabled, (ch, v) => cfg(ch, { enabled: v }), top);
    this.select("Ziel (Media Player)", (ch) => [["", "— keins —"], ...[...new Set([...app.state.availableNodes, ch.automation.target].filter(Boolean))].map((n) => [n, n])], (ch) => ch.automation.target, (ch, v) => cfg(ch, { target: v }), top);
    const rows = h("div", { class: "rows" });
    const list = new KeyedList(rows, (idx) => {
      const trig = h("select", { class: "sel-input", "aria-label": "Auslöser" }, TRIGGERS.map(([v, t]) => h("option", { value: v, text: t })));
      const act = h("select", { class: "sel-input", "aria-label": "Aktion" }, ACTIONS.map(([v, t]) => h("option", { value: v, text: t })));
      const scene = h("select", { class: "sel-input", "aria-label": "Szene" });
      const src = h("select", { class: "sel-input", "aria-label": "Videoquelle" });
      const rm = h("button", { class: "tog danger", type: "button", text: "✕", "aria-label": "Regel entfernen" });
      const rule = () => this.cur().automation.rules[idx];
      const save = () => cfg(this.cur(), {});
      trig.addEventListener("change", () => { rule().trigger = trig.value; save(); this.refresh(); });
      act.addEventListener("change", () => { rule().action = act.value; save(); });
      scene.addEventListener("change", () => { rule().scene = scene.value; save(); });
      src.addEventListener("change", () => { rule().source = src.value; save(); });
      rm.addEventListener("click", () => { const ch = this.cur(); ch.automation.rules.splice(idx, 1); save(); this.refresh(); });
      let optKey = "";
      return {
        root: h("div", { class: "row" }, trig, h("span", { class: "arrow", text: "→" }), act, scene, src, rm),
        update: () => {
          const r = rule();
          if (!r) return;
          const sc = [["", "jede Szene"], ...app.state.scenes.map((s) => [s.id, s.label])];
          const nodes = [["", "jede Quelle"], ...app.nodes.map((n) => [n.id, n.label])];
          const k = JSON.stringify([sc, nodes]);
          if (k !== optKey) { optKey = k; scene.replaceChildren(...sc.map(([v, t]) => h("option", { value: v, text: t }))); src.replaceChildren(...nodes.map(([v, t]) => h("option", { value: v, text: t }))); }
          trig.value = r.trigger; act.value = r.action; scene.value = r.scene; src.value = r.source;
          scene.hidden = r.trigger !== "scene_activate";
          src.hidden = !r.trigger.startsWith("video_");
        },
      };
    });
    this.bind(() => { const ch = this.cur(); if (ch) list.sync(ch.automation.rules.map((_, i) => i), (i) => i, ch.automation.rules.map((r) => r.trigger).join(",")); });
    const add = h("button", { class: "tog", type: "button", text: "+ Regel", onclick: () => { const ch = this.cur(); if (!ch) return; ch.automation.rules.push({ trigger: "unmute", action: "play", scene: "", source: "" }); cfg(ch, {}); this.refresh(); } });
    const addDefault = h("button", { class: "tog", type: "button", text: "Beispiel: Entstummen → Play, Stumm → Pause", onclick: () => { const ch = this.cur(); if (!ch) return; ch.automation.rules.push({ trigger: "unmute", action: "play", scene: "", source: "" }, { trigger: "mute", action: "pause", scene: "", source: "" }); cfg(ch, {}); this.refresh(); } });
    const status = h("p", { class: "hint status" });
    this.bind(() => { const ch = this.cur(); const s = ch?.mediaStatus; status.textContent = s ? (s.ok ? `Letzte Aktion: ${s.action} (${s.method}) ✓` : `Letzte Aktion: ${s.action} — Fehler: ${s.error}`) : "Noch keine Aktion ausgeführt."; status.dataset.err = s && !s.ok ? "1" : "0"; });

    // AFV (bestehende Funktion „Audio folgt Video“ bleibt erhalten)
    const afv = this.grid();
    const fo = (ch, patch) => { Object.assign(ch.follow, patch); };
    this.select("AFV-Quelle (Video)", (ch) => [["", "— keine —"], ...app.nodes.map((n) => [n.id, n.label]), ...(ch.follow.target && !app.nodes.some((n) => n.id === ch.follow.target) ? [[ch.follow.target, ch.follow.target]] : [])], (ch) => ch.follow.target, (ch, v) => { fo(ch, { target: v }); app.sendCh(ch.id, "setFollow", { targetNodeId: v, mode: ch.follow.mode }); }, afv);
    this.segmented([["off", "Aus"], ["cut", "Cut"], ["crossfade", "Crossfade"]], (ch) => ch.follow.mode, (ch, v) => { fo(ch, { mode: v }); app.sendCh(ch.id, "setFollow", { targetNodeId: ch.follow.target, mode: v }); }, afv, "AFV-Modus");
    this.toggle("AFV übersteuern (Override)", (ch) => ch.follow.override, (ch, v) => { fo(ch, { override: v }); app.sendCh(ch.id, "setOverride", { enabled: v }); }, afv);
    this.toggle("AFV schaltet stumm (statt Pegel)", (ch) => ch.follow.useMute, (ch, v) => { fo(ch, { useMute: v }); const f = ch.follow; app.sendCh(ch.id, "setFollowLevels", { useMute: v, onLevelDb: f.onLevelDb, offLevelDb: f.offLevelDb, transitionMs: f.transitionMs }, "fl"); }, afv);
    const fl = (label, key, min, max, step, unit) => this.slider({ label, min, max, step, unit, get: (ch) => ch.follow[key], set: (ch, v) => { fo(ch, { [key]: v }); const f = ch.follow; app.sendCh(ch.id, "setFollowLevels", { useMute: f.useMute, onLevelDb: f.onLevelDb, offLevelDb: f.offLevelDb, transitionMs: f.transitionMs }, "fl"); } }, afv);
    fl("AFV An-Pegel", "onLevelDb", -60, 12, 0.5, "dB");
    fl("AFV Aus-Pegel", "offLevelDb", -60, 12, 0.5, "dB");
    fl("AFV Übergang", "transitionMs", 0, 5000, 50, "ms");
    root.append(this.section("Media-Player-Automation", top, rows, h("div", { class: "rows" }, h("div", { class: "row" }, add, addDefault)), status), this.section("Audio folgt Video (AFV)", afv));
    return root;
  },

  // ───── Szenen / Kontext / Presets ─────
  tabScenes() {
    const app = this.app;
    const root = h("div", { class: "ctab" });
    const host = h("div", { class: "rows" });
    const scenes = new KeyedList(host, (s) => {
      const go = h("button", { class: "tog scene-go", type: "button", text: s.label, onclick: () => app.cmd("activateScene", { sceneId: s.id }).then(() => { app.announce(`Szene ${s.label} aktiviert`); app.poll(); }) });
      const upd = h("button", { class: "tog", type: "button", text: "Aktualisieren", title: "Szene mit dem aktuellen Mix überschreiben", onclick: async () => { if (await app.confirm(`Szene „${s.label}“ mit dem aktuellen Mix überschreiben?`)) app.cmd(`scene.${s.id}.update`, { includeProcessing: false }).then(() => app.poll()); } });
      const del = h("button", { class: "tog danger", type: "button", text: "Löschen", onclick: async () => { if (await app.confirm(`Szene „${s.label}“ löschen?`)) app.cmd("removeScene", { sceneId: s.id }).then(() => app.poll()); } });
      // Auslöser direkt an der Szene: „Wenn Videoquelle X im Programm → diese Szene“ (genau eine einfache Regel je Szene).
      const trig = h("select", { class: "sel-input", "aria-label": "Automatisch aktivieren, wenn Videoquelle im Programm", title: "Szene automatisch aktivieren, sobald diese Videoquelle im Programm ist" });
      const ruleOf = () => app.state.contextRules.find((r) => r.scene === s.id);
      trig.addEventListener("change", async () => {
        const r = ruleOf();
        if (!trig.value) { if (r) await app.cmd("removeContext", { contextId: r.id }); }
        else if (r) await app.cmd(`context.${r.id}.set`, { source: trig.value, enabled: true });
        else await app.cmd("addContext", { label: s.label, source: trig.value, scene: s.id });
        app.poll();
      });
      let k0 = "";
      return {
        root: h("div", { class: "row" }, go, h("span", { class: "arrow", text: "automatisch bei" }), trig, upd, del),
        update: (x) => {
          go.textContent = x.label; go.setAttribute("aria-pressed", String(app.state.audioContext.activeScene === x.id));
          const r = ruleOf();
          const n = [["", "— nur manuell —"], ...app.nodes.map((q) => [q.id, q.label]), ...(r && r.source && !app.nodes.some((q) => q.id === r.source) ? [[r.source, r.source]] : [])];
          const k = JSON.stringify(n);
          if (k !== k0) { k0 = k; trig.replaceChildren(...n.map(([v, t]) => h("option", { value: v, text: t }))); }
          trig.value = r ? r.source : "";
        },
      };
    });
    this.bind(() => scenes.sync(app.state.scenes, (s) => s.id, app.state.scenes.map((s) => s.label).join("|") + JSON.stringify(app.state.contextRules.map((r) => [r.scene, r.source]))));
    const nm = h("input", { class: "text-input", type: "text", placeholder: "Name der Szene (z. B. Football)", "aria-label": "Neue Szene", maxlength: "40" });
    const withProc = h("input", { type: "checkbox", "aria-label": "Bearbeitung einschließen" });
    const cap = h("button", { class: "tog", type: "button", text: "● Aktuellen Mix als Szene speichern", onclick: () => app.cmd("captureScene", { label: nm.value, includeProcessing: withProc.checked }).then(() => { nm.value = ""; app.poll(); }) });
    const hint = h("p", { class: "hint", text: "Eine Szene enthält Fader, Mute, Routing, Gruppen, AutoMix, Ducking, Aux-Sends und Media-Automation der vorhandenen Kanäle (optional auch EQ/Dynamik/Delay/Pan). Das Aktivieren ändert keine Kanalstruktur und erzeugt keine Audio-Aussetzer." });

    // Video → Audio-Kontext
    const ctxHost = h("div", { class: "rows" });
    const ctx = new KeyedList(ctxHost, (c) => {
      const en = h("button", { class: "tog", type: "button", "aria-pressed": "false", text: "aktiv" });
      const src = h("select", { class: "sel-input", "aria-label": "Videoquelle" });
      const sc = h("select", { class: "sel-input", "aria-label": "Audio-Szene" });
      const rm = h("button", { class: "tog danger", type: "button", text: "✕", "aria-label": "Zuordnung entfernen" });
      const test = h("button", { class: "tog", type: "button", text: "Test", title: "Videoquelle manuell als aktiv melden" });
      const me = () => app.state.contextRules.find((x) => x.id === c.id);
      const save = (p) => app.cmd(`context.${c.id}.set`, p).then(() => app.poll());
      en.addEventListener("click", () => save({ enabled: !me().enabled }));
      src.addEventListener("change", () => save({ source: src.value }));
      sc.addEventListener("change", () => save({ scene: sc.value }));
      rm.addEventListener("click", () => app.cmd("removeContext", { contextId: c.id }).then(() => app.poll()));
      test.addEventListener("click", () => app.cmd("setVideoContext", { source: me().source, active: true }).then(() => app.poll()));
      let k0 = "";
      return {
        root: h("div", { class: "row" }, h("span", { class: "rname", text: "Wenn" }), src, h("span", { class: "arrow", text: "→ Szene" }), sc, en, test, rm),
        update: (x) => {
          const s = [["", "—"], ...app.state.scenes.map((q) => [q.id, q.label])];
          const n = [["", "—"], ...app.nodes.map((q) => [q.id, q.label]), ...(x.source && !app.nodes.some((q) => q.id === x.source) ? [[x.source, x.source]] : [])];
          const k = JSON.stringify([s, n]);
          if (k !== k0) { k0 = k; sc.replaceChildren(...s.map(([v, t]) => h("option", { value: v, text: t }))); src.replaceChildren(...n.map(([v, t]) => h("option", { value: v, text: t }))); }
          src.value = x.source; sc.value = x.scene; en.setAttribute("aria-pressed", String(x.enabled));
        },
      };
    });
    this.bind(() => ctx.sync(app.state.contextRules, (c) => c.id, app.state.contextRules.map((c) => c.label).join("|")));
    const addCtx = h("button", { class: "tog", type: "button", text: "+ Zuordnung Videoquelle → Szene", onclick: () => app.cmd("addContext", { label: "", source: "", scene: "" }).then(() => app.poll()) });
    const ctxInfo = h("p", { class: "hint" });
    this.bind(() => { const c = app.state.audioContext; const names = c.activeSources.map((id) => app.nodes.find((n) => n.id === id)?.label || id); ctxInfo.textContent = `Audio-Kontext: Videoquellen aktiv: ${names.join(", ") || "—"} · aktive Szene: ${app.state.scenes.find((s) => s.id === c.activeScene)?.label || "—"}`; });
    const ctxHint = h("p", { class: "hint", text: "Das Video-System liefert nur Kontext („Kamera 1 ist im Programm“); die Zuordnung aktiviert eine Audio-Szene. Kanäle im Manual-Override bleiben dabei unberührt." });

    // Presets (gesamter Mixer-Zustand inkl. Kanalstruktur, über den Snapshot-Dienst)
    const presetHost = h("div", { class: "rows" });
    const pn = h("input", { class: "text-input", type: "text", placeholder: "Name des Presets", "aria-label": "Preset-Name", maxlength: "40" });
    const savePreset = h("button", { class: "tog", type: "button", text: "Preset speichern", onclick: async () => { if (!pn.value.trim()) return; await fetch("/api/v1/snapshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: pn.value.trim(), nodeIds: [app.nodeId] }) }); pn.value = ""; this.loadPresets(presetHost); } });
    this.bind(() => this.loadPresets(presetHost));
    root.append(
      this.section("Szenen & Automatik: 1. Mix einstellen → 2. speichern → 3. optional Videoquelle zuordnen", host, h("div", { class: "rows" }, h("div", { class: "row" }, nm, h("label", { class: "chk" }, withProc, "inkl. Bearbeitung"), cap)), hint),
      this.advanced("Erweitert: freie Video → Audio-Zuordnungen", ctxHost, h("div", { class: "rows" }, h("div", { class: "row" }, addCtx)), ctxInfo, ctxHint),
      this.section("Presets (ganzer Mixer, ersetzt die Kanalliste)", presetHost, h("div", { class: "rows" }, h("div", { class: "row" }, pn, savePreset))),
    );
    return root;
  },
  async loadPresets(host) {
    const now = Date.now();
    if (this._presetAt && now - this._presetAt < 5000) return;
    this._presetAt = now;
    try {
      const res = await fetch("/api/v1/snapshots");
      if (!res.ok) { host.replaceChildren(h("p", { class: "hint", text: "Preset-Dienst nicht erreichbar." })); return; }
      const snaps = (await res.json()).filter((s) => Array.isArray(s.nodeIds) && s.nodeIds.length === 1 && s.nodeIds[0] === this.app.nodeId);
      host.replaceChildren(...(snaps.length ? snaps.map((s) => h("div", { class: "row" }, h("button", { class: "tog", type: "button", text: s.label || s.id.slice(0, 8), onclick: async () => { if (await this.app.confirm(`Preset „${s.label}“ anwenden? Die Kanalliste wird ersetzt.`)) { await fetch(`/api/v1/snapshots/${s.id}/apply`, { method: "POST" }); this.app.poll(); } } }))) : [h("p", { class: "hint", text: "Keine Presets gespeichert." })]));
    } catch {
      host.replaceChildren(h("p", { class: "hint", text: "Preset-Dienst nicht erreichbar." }));
    }
  },
});
