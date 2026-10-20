// „Ton folgt Bild“ (Kap. 46.5): eine Karte je Videoquelle — „Wenn Kamera 1 im Bild ist, sind diese
// Kanäle offen“. Kanäle werden per Klick zugeordnet; ein Knopf übernimmt alle Zuordnungen aus den
// Quellen. Technisch bleibt es die AFV-Einstellung je Kanal (`setFollow`), nur ohne Einzelformulare.

const FOLLOW_I18N = {
  de: {
    "x.afvTitle": "Ton folgt Bild", "x.afvBtn": "Ton folgt Bild", "x.afvBtnTip": "Welche Kanäle öffnen, wenn welche Videoquelle im Bild ist",
    "x.afvIntro": "Ist eine Videoquelle im Programm des Bildmischers, sind die zugeordneten Kanäle offen – sonst geschlossen.",
    "x.afvAuto": "Automatisch aus den Quellen", "x.afvAutoTip": "Jeden Kanal der Videoquelle zuordnen, aus der sein Ton stammt",
    "x.afvWhen": "Wenn", "x.afvInPgm": "im Bild ist, sind offen:", "x.afvLive": "im Bild", "x.afvNot": "nicht im Bild",
    "x.afvCut": "Hart", "x.afvFade": "Weich", "x.afvAdd": "Videoquelle hinzufügen …", "x.afvNone": "Noch keine Zuordnung. „Automatisch aus den Quellen“ legt sie in einem Klick an.",
    "x.afvOther": "gehört zu {p0}", "x.afvDone": "Fertig", "x.afvAutoDone": "{p0} Kanäle zugeordnet.", "x.afvAutoNothing": "Keine Kanäle mit erkennbarer Videoquelle gefunden.",
    "x.afvFree": "Ohne Zuordnung (Ton läuft immer):", "x.afvRemove": "Karte entfernen",
  },
  en: {
    "x.afvTitle": "Audio follows video", "x.afvBtn": "Audio follows video", "x.afvBtnTip": "Which channels open when which video source is on air",
    "x.afvIntro": "When a video source is on the video mixer's program, its assigned channels are open – otherwise closed.",
    "x.afvAuto": "Automatically from sources", "x.afvAutoTip": "Assign each channel to the video source its audio comes from",
    "x.afvWhen": "When", "x.afvInPgm": "is on air, these are open:", "x.afvLive": "on air", "x.afvNot": "not on air",
    "x.afvCut": "Cut", "x.afvFade": "Fade", "x.afvAdd": "Add video source …", "x.afvNone": "No assignments yet. “Automatically from sources” creates them in one click.",
    "x.afvOther": "belongs to {p0}", "x.afvDone": "Done", "x.afvAutoDone": "{p0} channels assigned.", "x.afvAutoNothing": "No channels with a recognizable video source found.",
    "x.afvFree": "Unassigned (audio always on):", "x.afvRemove": "Remove card",
  },
};

/** Fremd-Texte in die vorhandene Tabelle einhängen (Sprache wie T()). */
function tf(key, params) {
  const lang = (document.documentElement.lang || "de").slice(0, 2);
  let s = (FOLLOW_I18N[lang] || FOLLOW_I18N.de)[key] || FOLLOW_I18N.de[key] || key;
  for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, v);
  return s;
}

/** Wirksames Ziel eines Kanals: festes Ziel, sonst der Node, dem sein Quell-Sender gehört. */
function followTarget(ch, senderNode) {
  if (ch.follow.mode === "off") return "";
  return ch.follow.target || senderNode.get(ch.source) || "";
}

class FollowDialog {
  constructor(app) {
    this.app = app;
    this.senderNode = new Map(); // Sender-ID → Node-ID
    this.extraCards = new Set(); // vom Bediener leer hinzugefügte Karten
    this.msg = h("p", { class: "hint" });
    this.cards = h("div", { class: "afvcards" });
    this.auto = h("button", { class: "tog", type: "button", text: tf("x.afvAuto"), title: tf("x.afvAutoTip"), onclick: () => this.autoAssign() });
    this.add = h("select", { class: "sel-input", "aria-label": tf("x.afvAdd") });
    this.add.addEventListener("change", () => { if (this.add.value) { this.extraCards.add(this.add.value); this.add.value = ""; this.render(); } });
    const close = h("button", { class: "tog", type: "button", text: tf("x.afvDone"), onclick: () => this.close() });
    this.box = h("div", { class: "box wide" }, h("h3", { text: tf("x.afvTitle") }), h("p", { class: "hint", text: tf("x.afvIntro") }),
      h("div", { class: "row" }, this.auto, this.add), this.msg, this.cards, h("div", { class: "acts" }, close));
    this.root = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": tf("x.afvTitle") }, this.box);
    this.root.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }
  get isOpen() { return this.root.isConnected; }
  async open() {
    if (this.isOpen) return;
    this.app.shadow.append(this.root);
    await this.loadSenders();
    this.render();
    this.timer = setInterval(() => this.paintLive(), 400);
  }
  close() { clearInterval(this.timer); this.root.remove(); }
  async loadSenders() {
    try {
      const res = await fetch("/api/v1/nodes");
      if (!res.ok) return;
      for (const n of await res.json()) for (const s of n.senders || []) this.senderNode.set(s.id, n.id);
    } catch { /* ohne Senderliste bleibt „Automatisch“ leer, Karten gehen trotzdem */ }
  }
  nodeLabel(id) { return (this.app.nodes.find((n) => n.id === id) || {}).label || id; }
  /** Zuordnung Video-Node → Kanäle (nach aktuellem Zustand). */
  groups() {
    const m = new Map();
    for (const ch of this.app.state.channels) {
      const t = followTarget(ch, this.senderNode);
      if (t && ch.follow.mode !== "off") (m.get(t) || m.set(t, []).get(t)).push(ch);
    }
    for (const id of this.extraCards) if (!m.has(id)) m.set(id, []);
    return m;
  }
  async setFollow(ch, target, mode) {
    ch.follow.target = target;
    ch.follow.mode = mode;
    this.app.touchedAt = performance.now();
    await this.app.cmd(`channel.${ch.id}.setFollow`, { targetNodeId: target, mode });
  }
  async autoAssign() {
    let n = 0;
    for (const ch of this.app.state.channels) {
      const node = this.senderNode.get(ch.source);
      if (node && ch.follow.mode === "off") { await this.setFollow(ch, node, "cut"); n++; }
    }
    this.msg.textContent = n ? tf("x.afvAutoDone", { p0: n }) : tf("x.afvAutoNothing");
    await this.app.poll();
    this.render();
  }
  render() {
    const app = this.app;
    const groups = this.groups();
    this.add.replaceChildren(h("option", { value: "", text: tf("x.afvAdd") }),
      ...app.nodes.filter((n) => !groups.has(n.id)).map((n) => h("option", { value: n.id, text: n.label })));
    this.cardEls = new Map();
    if (!groups.size) { this.cards.replaceChildren(h("p", { class: "hint", text: tf("x.afvNone") })); return; }
    // Zum Zuordnen nur Kanäle ohne Karte anbieten; was auf einer anderen Karte liegt, dort entfernen.
    const free = () => app.state.channels.filter((c) => !followTarget(c, this.senderNode) || c.follow.mode === "off");
    this.cards.replaceChildren(...[...groups].map(([node, members]) => {
      const dot = h("span", { class: "afvdot", "aria-hidden": "true", text: "●" });
      const state = h("span", { class: "afvstate hint" });
      const mode = members[0] ? members[0].follow.mode : "cut";
      const seg = h("div", { class: "seg", role: "group" }, ...[["cut", tf("x.afvCut")], ["crossfade", tf("x.afvFade")]].map(([v, t]) =>
        h("button", { class: "tog", type: "button", "aria-pressed": String(v === mode), text: t, onclick: async () => { for (const m of members) await this.setFollow(m, node, v); await app.poll(); this.render(); } })));
      const rm = h("button", { class: "tog danger mini", type: "button", "aria-label": tf("x.afvRemove"), title: tf("x.afvRemove"), text: "✕", onclick: async () => {
        this.extraCards.delete(node); for (const m of members) await this.setFollow(m, "", "off"); await app.poll(); this.render(); } });
      const chip = (ch, on) => {
        const b = h("button", { class: "tog chipbtn", type: "button", "aria-pressed": String(on), text: (on ? "✓ " : "") + ch.label });
        b.addEventListener("click", async () => { await this.setFollow(ch, on ? "" : node, on ? "off" : (mode === "crossfade" ? "crossfade" : "cut")); await app.poll(); this.render(); });
        return b;
      };
      const el = h("section", { class: "afvcard", "data-node": node },
        h("header", { class: "afvhead" }, dot, h("span", { text: tf("x.afvWhen") + " " }), h("strong", { text: this.nodeLabel(node) }), h("span", { text: " " + tf("x.afvInPgm") }), state, h("span", { class: "spacer" }), seg, rm),
        h("div", { class: "afvchips" }, ...members.map((c) => chip(c, true)), ...free().map((c) => chip(c, false))));
      this.cardEls.set(node, { dot, state });
      return el;
    }));
    this.paintLive();
  }
  /** Live-Anzeige: Kartenpunkt leuchtet, solange die Videoquelle im Programm ist. */
  paintLive() {
    const active = new Set((this.app.state.audioContext || {}).activeSources || []);
    for (const [node, { dot, state }] of this.cardEls || []) {
      const on = active.has(node);
      dot.dataset.on = on ? "1" : "0";
      state.textContent = on ? "— " + tf("x.afvLive") : "— " + tf("x.afvNot");
    }
  }
}
