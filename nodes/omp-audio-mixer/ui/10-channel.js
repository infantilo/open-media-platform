// ───────────────────────────── ChannelView ─────────────────────────────
//
// Ein Kanal = ein DOM-Block mit allen Teilen (Name, On-Air, Status-Badges,
// Meter, Fader, Mute/Solo/Select). Die Darstellungsvarianten full | compact |
// dense | grid | touch (und "mit/ohne Fader") sind reines CSS über
// `data-variant` / `data-faders` des Containers — die Logik (Kommandos,
// Statusableitung) ist für alle identisch. Der Fader bleibt auch unsichtbar
// im DOM; sein Wert stammt immer aus dem Mixer-State.

class ChannelView {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.last = {};
    this.root = h("div", { class: "ch", "data-id": id, role: "group" });

    this.nameBtn = h("button", { class: "name", type: "button", "aria-pressed": "false" });
    this.sig = h("i", { class: "sig", title: "Signalaktivität" });
    this.head = h("div", { class: "chead" }, this.sig, this.nameBtn);

    const badge = (cls, label) => h("span", { class: "b " + cls, text: label });
    this.bOnAir = badge("onair", "");
    this.bAuto = badge("auto", "");
    this.bDuck = badge("duck", "");
    this.bManual = badge("manual", "MANUAL");
    this.bMedia = badge("media", "");
    this.bPfl = badge("pfl", "PFL");
    this.badges = h("div", { class: "badges" }, this.bOnAir, this.bAuto, this.bDuck, this.bManual, this.bMedia, this.bPfl);

    this.meter = new Meter();
    this.meterWrap = h("div", { class: "meterwrap" }, this.meter.root);

    this.fader = new Fader({
      label: "Fader",
      onInput: (db) => app.setGainLive(id, db),
      onCommit: (db) => app.setGainCommit(id, db),
    });

    const twoLabel = (s, l) => [h("span", { class: "s", text: s }), h("span", { class: "l", text: l })];
    this.muteBtn = h("button", { class: "tog mute", type: "button", "aria-pressed": "false", title: "Mute" }, twoLabel("M", "MUTE"));
    this.soloBtn = h("button", { class: "tog solo", type: "button", "aria-pressed": "false", title: "Solo/PFL" }, twoLabel("S", "SOLO"));
    this.selBtn = h("button", { class: "tog sel", type: "button", "aria-pressed": "false", title: "Auswählen" }, twoLabel("SEL", "SELECT"));
    this.btns = h("div", { class: "btns" }, this.muteBtn, this.soloBtn, this.selBtn);

    this.root.append(this.head, this.badges, this.meterWrap, this.fader.root, this.btns);

    this.muteBtn.addEventListener("click", () => app.toggleMute(id));
    this.soloBtn.addEventListener("click", () => app.togglePfl(id));
    this.selBtn.addEventListener("click", () => app.select(id, { open: true }));

    // Name: Tippen = auswählen, Doppeltipp/langes Drücken = Center Control öffnen.
    let pressTimer = null;
    let longFired = false;
    this.nameBtn.addEventListener("pointerdown", () => {
      longFired = false;
      pressTimer = setTimeout(() => {
        longFired = true;
        app.select(id, { open: true, focus: true });
      }, 550);
    });
    const cancel = () => clearTimeout(pressTimer);
    this.nameBtn.addEventListener("pointerup", cancel);
    this.nameBtn.addEventListener("pointerleave", cancel);
    this.nameBtn.addEventListener("pointercancel", cancel);
    this.nameBtn.addEventListener("click", (e) => {
      if (longFired) {
        longFired = false;
        e.preventDefault();
        return;
      }
      app.select(id, { open: false });
    });
    this.nameBtn.addEventListener("dblclick", () => app.select(id, { open: true, focus: true }));
  }

  /** Statische Textanteile + Status aus dem Mixer-State. `live` = SSE-Werte. */
  update(ch, live, ctx) {
    const L = this.last;
    const set = (key, val, fn) => {
      if (L[key] === val) return;
      L[key] = val;
      fn(val);
    };
    set("label", ch.label, (v) => {
      this.nameBtn.textContent = v;
      this.nameBtn.title = v;
      this.root.setAttribute("aria-label", "Kanal " + v);
      this.fader.root.setAttribute("aria-label", "Fader " + v);
    });
    this.fader.setValue(ch.gainDb);
    set("mute", ch.mute || ctx.groupMuted, (v) => {
      this.muteBtn.setAttribute("aria-pressed", String(v));
      this.root.dataset.muted = v ? "1" : "0";
    });
    set("groupMuted", ctx.groupMuted, (v) => {
      this.muteBtn.title = v ? "Mute (Gruppe stumm)" : "Mute";
    });
    set("pfl", !!ch.pfl, (v) => {
      this.soloBtn.setAttribute("aria-pressed", String(v));
      this.bPfl.hidden = !v;
    });
    set("sel", ctx.selected, (v) => {
      this.selBtn.setAttribute("aria-pressed", String(v));
      this.nameBtn.setAttribute("aria-pressed", String(v));
      this.root.dataset.selected = v ? "1" : "0";
    });
    set("manual", !!ch.manual, (v) => {
      this.bManual.hidden = !v;
      this.root.dataset.manual = v ? "1" : "0";
    });

    // On-Air kommt vom Node (abgeleitet: Mute, Gruppe, Programm-Routing,
    // Fader, AutoMix/Ducking) — nicht aus `!mute` berechnet.
    const onAir = live ? !!live.onAir : false;
    const muted = ch.mute || ctx.groupMuted;
    const airKey = onAir ? "air" : muted ? "muted" : "off";
    set("air", airKey, (v) => {
      this.root.dataset.onair = v === "air" ? "1" : "0";
      this.bOnAir.textContent = v === "air" ? "● ON AIR" : v === "muted" ? "MUTED" : "OFF AIR";
      this.bOnAir.dataset.state = v;
      this.bOnAir.title = v === "off" ? (ch.mainRoute ? "Nicht hörbar (Fader/AutoMix)" : "Nicht auf Programm geroutet") : "";
    });

    // AutoMix und Ducking getrennt sichtbar (Ursache einer Pegeländerung erkennbar).
    const autoOn = ctx.autoMixActive && !ch.manual;
    const autoDb = live ? live.autoDb : 0;
    const autoTxt = autoOn ? "AUTO " + fmtSigned(autoDb) + " dB" : "";
    set("autoTxt", autoTxt, (v) => {
      this.bAuto.hidden = !v;
      this.bAuto.textContent = v;
      this.root.dataset.auto = v ? "1" : "0";
    });
    const duckDb = live ? live.duckDb : 0;
    const duckTxt = duckDb < -0.3 ? "DUCK " + fmtSigned(duckDb) + " dB" : "";
    set("duckTxt", duckTxt, (v) => {
      this.bDuck.hidden = !v;
      this.bDuck.textContent = v;
      this.root.dataset.duck = v ? "1" : "0";
    });

    const a = ch.automation;
    const ms = ch.mediaStatus;
    const mediaTxt = a && a.enabled && a.rules.length && a.target ? (ms && !ms.ok ? "⚠ MEDIA" : "▶ MEDIA") : "";
    set("mediaTxt", mediaTxt + (ms ? ms.error : ""), () => {
      this.bMedia.hidden = !mediaTxt;
      this.bMedia.textContent = mediaTxt;
      this.bMedia.title = ms ? (ms.ok ? `${ms.action} → ${a.target}` : `Fehler: ${ms.error}`) : `Ziel: ${a ? a.target : ""}`;
    });
  }

  /** Meter + Signalaktivität (aus rAF, nur Transform/Variable). */
  setLevel(rms, peak, now) {
    this.meter.set(rms, peak, now);
    const active = rms > 0.003 ? "1" : "0";
    if (this.last.sigv !== active) {
      this.last.sigv = active;
      this.sig.dataset.on = active;
    }
  }
}
