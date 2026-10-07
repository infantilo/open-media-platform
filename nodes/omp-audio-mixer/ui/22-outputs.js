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
    const close = h("button", { class: "tog", type: "button", text: "Schließen", onclick: () => this.close() });
    this.box = h("div", { class: "box wide" },
      h("h3", { text: "Ausgänge & Routing" }),
      h("div", { class: "row" }, name, tpl, cnt, add),
      this.msg,
      this.matrix,
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
    if (s && s.locked) { b.disabled = true; b.title = "Automatisch zugeordnet (Tag-Regel)"; }
    b.addEventListener("click", () => {
      if (!s) return;
      s.enabled = !s.enabled;
      app.sendCh(ch.id, "setSend", { auxId: bus.id, enabled: s.enabled }, "send" + bus.id);
      this.render();
    });
    return b;
  }
  render() {
    const app = this.app;
    const st = app.state;
    const buses = st.auxBuses;
    const head = h("tr", {}, h("th", { text: "Kanal" }), h("th", { text: "Programm" }),
      ...buses.map((a) => {
        const kind = a.kind === "group" ? `${a.layout || ""} · ${a.channels} Kn.` : a.kind === "n1" ? "N-1" : "Aux";
        const rm = h("button", { class: "tog danger mini", type: "button", "aria-label": `Ausgang ${a.label} entfernen`, text: "✕", onclick: async () => { if (await app.confirm(`Ausgang „${a.label}“ entfernen?`)) { await app.cmd("removeAux", { auxId: a.id }); await app.poll(); this.render(); } } });
        return h("th", { title: a.kind === "group" ? `Sender-Tag role.${a.group}` : "" }, h("div", { text: a.label }), h("div", { class: "hint", text: kind }), rm);
      }));
    const rows = st.channels.map((ch) => h("tr", {}, h("td", { class: "rname", text: ch.label }), h("td", {}, this.cell(ch, null)), ...buses.map((a) => h("td", {}, this.cell(ch, a)))));
    this.matrix.replaceChildren(st.channels.length ? h("table", {}, h("thead", {}, head), h("tbody", {}, ...rows)) : h("p", { class: "hint", text: "Noch keine Kanäle." }));
  }
}
