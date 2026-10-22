// „Szenen & Automation“: globale Einstellungen des Mischers an EINER Stelle, unabhängig vom gewählten
// Kanal — Szenen (anlegen, abrufen, umbenennen, Auslöser), Video→Audio-Kontext, Ducking-Regeln,
// Ton folgt Bild, Presets. Kanalgebundenes (Medien-Automation je Kanal, „Duckable“, AutoMix-Gewicht)
// bleibt im Detailbereich des Kanals.

Object.assign(FOLLOW_I18N.de, {
  "x.gBtn": "⚙ Szenen & Automation", "x.gBtnTip": "Szenen verwalten, Ducking, Video→Audio-Kontext, Ton folgt Bild",
  "x.gTitle": "Szenen & Automation", "x.gScenes": "Szenen", "x.gContext": "Video → Audio", "x.gDuck": "Ducking", "x.gFollow": "Ton folgt Bild",
  "x.gClose": "Fertig", "x.gRename": "Szene umbenennen", "x.gAllDuck": "Alle Ducking-Regeln …",
  "x.gDuckHint": "Hier gilt nur der gewählte Kanal. Regeln, die mehrere Kanäle betreffen, stehen unter „Szenen & Automation → Ducking“.",
  "x.gIntro": "Gilt für den ganzen Mischer, nicht für einen einzelnen Kanal.",
  "x.gFollowText": "Welche Kanäle öffnen, wenn welche Videoquelle im Programm ist.", "x.gFollowOpen": "Zuordnung bearbeiten …",
});
Object.assign(FOLLOW_I18N.en, {
  "x.gBtn": "⚙ Scenes & automation", "x.gBtnTip": "Manage scenes, ducking, video→audio context, audio follows video",
  "x.gTitle": "Scenes & automation", "x.gScenes": "Scenes", "x.gContext": "Video → audio", "x.gDuck": "Ducking", "x.gFollow": "Audio follows video",
  "x.gClose": "Done", "x.gRename": "Rename scene", "x.gAllDuck": "All ducking rules …",
  "x.gDuckHint": "This only covers the selected channel. Rules involving several channels are under “Scenes & automation → Ducking”.",
  "x.gIntro": "Applies to the whole mixer, not to a single channel.",
  "x.gFollowText": "Which channels open when which video source is on the program.", "x.gFollowOpen": "Edit assignment …",
});

class GlobalDialog {
  constructor(app) {
    this.app = app;
    // Die Bausteine der Tab-Inhalte stammen aus CenterControl; hier nur ohne Kanalbezug gebaut.
    this.cc = new CenterControl(app);
    this.cc.refresh = () => this.refresh();
    this.tabId = "scenes";
    this.built = new Map();
    this.tabs = [
      ["scenes", tf("x.gScenes"), () => this.cc.tabScenes("scenes")],
      ["duck", tf("x.gDuck"), () => this.cc.tabDuck(true)],
      ["context", tf("x.gContext"), () => this.cc.tabScenes("context")],
      ["follow", tf("x.gFollow"), () => this.followTab()],
    ];
    this.tabBar = h("div", { class: "tabs gtabs", role: "tablist", "aria-label": tf("x.gTitle") });
    this.tabBtns = new Map();
    for (const [id, label] of this.tabs) {
      const b = h("button", { class: "tab", type: "button", role: "tab", "aria-selected": "false", text: label, onclick: () => this.setTab(id) });
      this.tabBtns.set(id, b);
      this.tabBar.append(b);
    }
    this.body = h("div", { class: "cbody", role: "tabpanel" });
    const close = h("button", { class: "tog", type: "button", text: tf("x.gClose"), onclick: () => this.close() });
    this.box = h("div", { class: "box wide" }, h("h3", { text: tf("x.gTitle") }), h("p", { class: "hint", text: tf("x.gIntro") }), this.tabBar, this.body, h("div", { class: "acts" }, close));
    this.root = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": tf("x.gTitle") }, this.box);
    this.root.addEventListener("keydown", (e) => { if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) this.close(); });
    this.root.addEventListener("pointerdown", (e) => { if (e.target === this.root) this.close(); });
  }
  get isOpen() { return this.root.isConnected; }
  open(tab) {
    if (tab) this.tabId = tab;
    if (!this.isOpen) this.app.shadow.append(this.root);
    this.mount();
    this.tabBtns.get(this.tabId)?.focus();
  }
  close() { this.root.remove(); }
  setTab(id) { this.tabId = id; this.mount(); }
  followTab() {
    const app = this.app;
    return h("div", { class: "ctab" }, this.cc.section(tf("x.gFollow"), h("p", { class: "hint", text: tf("x.gFollowText") }),
      h("div", { class: "rows" }, h("div", { class: "row" }, h("button", { class: "tog", type: "button", text: tf("x.gFollowOpen"), onclick: () => { this.close(); app.openFollow(); } })))));
  }
  mount() {
    for (const [id, b] of this.tabBtns) b.setAttribute("aria-selected", String(id === this.tabId));
    let panel = this.built.get(this.tabId);
    if (!panel) {
      this.cc.binds = [];
      this.cc.liveBinds = [];
      const root = this.tabs.find((t) => t[0] === this.tabId)[2]();
      panel = { root, binds: this.cc.binds, live: this.cc.liveBinds };
      this.built.set(this.tabId, panel);
    }
    this.cur = panel;
    this.cc.currentPanel = panel;
    this.body.replaceChildren(panel.root);
    this.refresh();
  }
  refresh() {
    if (this.cur) for (const fn of this.cur.binds) fn();
  }
}
