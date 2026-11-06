// Presets für EQ und Dynamik (Kompressor + Gate): Auswahl (Werkspresets + eigene), Speichern des aktuellen Klangs unter einem Namen,
// Löschen eigener Presets, Export/Import als Datei. Gemeinsam für „Konsole 2“ und die klassische Oberfläche (`presetBar(app, kind)`).
// Der Mischer-Node hält die Presets (`applyPreset`, `savePreset`, `deletePreset`, `importPresets`, Parameter `presetExport`); hier nur Bedienung.

const TP = (() => {
  const D = {
    de: {
      pick: "Preset …", factory: "Werkspresets", mine: "Eigene Presets", save: "Als Preset speichern …", saveTip: "Aktuelle Einstellung als eigenes Preset speichern (gleicher Name überschreibt)",
      del: "Eigenes Preset löschen", delTip: "Das in der Liste gewählte eigene Preset löschen", exp: "Eigene Presets als Datei exportieren", imp: "Presets aus Datei importieren",
      namePrompt: "Name des Presets:", delAsk: "Preset „{n}“ löschen?", delGo: "Löschen", cancel: "Abbrechen", ok: "OK", close: "Schließen", pickFirst: "Zuerst ein eigenes Preset in der Liste wählen.",
      saved: "Preset „{n}“ gespeichert.", deleted: "Preset „{n}“ gelöscht.", imported: "Presets importiert.", exported: "Datei exportiert.", noOwn: "Noch keine eigenen Presets zum Exportieren.",
      failed: "{m} fehlgeschlagen: {d}", noChannel: "Kein Kanal ausgewählt.", kindEq: "EQ", kindDyn: "Dynamik",
    },
    en: {
      pick: "Preset …", factory: "Factory presets", mine: "My presets", save: "Save as preset …", saveTip: "Save the current setting as your own preset (same name overwrites)",
      del: "Delete my preset", delTip: "Delete the own preset chosen in the list", exp: "Export my presets to a file", imp: "Import presets from a file",
      namePrompt: "Preset name:", delAsk: "Delete preset “{n}”?", delGo: "Delete", cancel: "Cancel", ok: "OK", close: "Close", pickFirst: "Choose one of your own presets in the list first.",
      saved: "Preset “{n}” saved.", deleted: "Preset “{n}” deleted.", imported: "Presets imported.", exported: "File exported.", noOwn: "No own presets to export yet.",
      failed: "{m} failed: {d}", noChannel: "No channel selected.", kindEq: "EQ", kindDyn: "Dynamics",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

async function presetCall(app, method, args) {
  try {
    const r = await fetch(`/api/v1/nodes/${app.nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args || {}) });
    if (r.ok) return { ok: true };
    let t = await r.text().catch(() => "");
    try { t = JSON.parse(t).error || t; } catch { /* Klartext */ }
    return { ok: false, msg: String(t || r.status).slice(0, 300) };
  } catch (e) { return { ok: false, msg: String(e && e.message ? e.message : e) }; }
}

// Sichtbare Meldung / Rückfrage als Dialog in der Oberfläche (nie window.alert/confirm)
function presetDialog(app, text, buttons) {
  return new Promise((resolve) => {
    const done = (v) => { m.remove(); resolve(v); };
    const acts = h("div", { class: "acts" }, ...buttons.map(([label, value, primary]) => h("button", { class: "tog" + (primary ? " on" : ""), type: "button", text: label, onclick: () => done(value) })));
    const m = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": text }, h("div", { class: "box" }, h("p", { text }), acts));
    m.addEventListener("keydown", (e) => { if (e.key === "Escape") done(false); });
    app.shadow.append(m);
    const first = acts.querySelector("button.on") || acts.querySelector("button");
    if (first) first.focus();
  });
}
const presetNotice = (app, text) => presetDialog(app, text, [[TP("close"), true, true]]);

function presetBar(app, kind) {
  const label = kind === "eq" ? TP("kindEq") : TP("kindDyn");
  const sel = h("select", { class: "pst-sel", "aria-label": `${label} ${TP("pick")}` });
  const mkBtn = (txt, title, fn) => h("button", { class: "pst-btn", type: "button", text: txt, title, "aria-label": title, onclick: fn });
  const fileIn = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  let sig = "";
  const list = () => (app.state.presets || []).filter((p) => p.kind === kind);
  const render = () => {
    const l = list();
    const s = JSON.stringify(l);
    if (s === sig) return;
    sig = s;
    const opt = (p) => h("option", { value: p.name, text: p.name });
    sel.replaceChildren(h("option", { value: "", text: TP("pick") }),
      h("optgroup", { label: TP("factory") }, ...l.filter((p) => p.builtin).map(opt)),
      ...(l.some((p) => !p.builtin) ? [h("optgroup", { label: TP("mine") }, ...l.filter((p) => !p.builtin).map(opt))] : []));
    sel.value = "";
  };
  const channel = () => app.ui.selected || "";
  const flash = async (r, okText) => { if (r.ok) { if (okText) await presetNotice(app, okText); } else await presetNotice(app, TP("failed", { m: label, d: r.msg })); };
  sel.addEventListener("change", async () => {
    const name = sel.value;
    sel.value = "";
    if (!name) return;
    if (!channel()) return presetNotice(app, TP("noChannel"));
    const r = await presetCall(app, "applyPreset", { channelId: channel(), kind, name });
    if (!r.ok) return flash(r);
    app.touchedAt = -1e9; // Preset ändert Werte am Node: Anzeige sofort neu laden
    await app.poll();
  });
  const saveBtn = mkBtn("＋", TP("saveTip"), async () => {
    if (!channel()) return presetNotice(app, TP("noChannel"));
    const n = await app.prompt(TP("namePrompt"), "");
    if (!n || !n.trim()) return;
    const name = n.trim();
    const r = await presetCall(app, "savePreset", { channelId: channel(), kind, name });
    if (r.ok) { app.touchedAt = -1e9; await app.poll(); }
    await flash(r, r.ok ? TP("saved", { n: name }) : "");
  });
  const delBtn = mkBtn("✕", TP("delTip"), async () => {
    const mine = list().filter((p) => !p.builtin);
    // gelöscht wird das zuletzt aus „Eigene“ gewählte; bei mehreren fragt der Dialog den Namen ab
    const n = mine.length === 1 ? mine[0].name : await app.prompt(TP("pickFirst") + "\n" + mine.map((p) => p.name).join(", "), "");
    const name = n && n.trim();
    if (!name || !mine.some((p) => p.name === name)) return;
    if (!(await presetDialog(app, TP("delAsk", { n: name }), [[TP("cancel"), false], [TP("delGo"), true, true]]))) return;
    const r = await presetCall(app, "deletePreset", { kind, name });
    if (r.ok) { app.touchedAt = -1e9; await app.poll(); }
    await flash(r, r.ok ? TP("deleted", { n: name }) : "");
  });
  const expBtn = mkBtn("⇩", TP("exp"), async () => {
    let doc;
    try { const res = await fetch(`/api/v1/nodes/${app.nodeId}/params/presetExport`); doc = res.ok ? (await res.json()).value : null; } catch { doc = null; }
    if (!doc) return presetNotice(app, TP("failed", { m: TP("exp"), d: "—" }));
    if (!JSON.parse(doc).presets.length) return presetNotice(app, TP("noOwn"));
    const url = URL.createObjectURL(new Blob([doc], { type: "application/json" }));
    const a = h("a", { href: url, download: `omp-audio-presets-${new Date().toISOString().slice(0, 10)}.json` });
    app.shadow.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  const impBtn = mkBtn("⇧", TP("imp"), () => fileIn.click());
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = "";
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return presetNotice(app, TP("failed", { m: TP("imp"), d: "> 2 MB" }));
    const text = await f.text();
    const r = await presetCall(app, "importPresets", { json: text });
    if (r.ok) { app.touchedAt = -1e9; await app.poll(); }
    await flash(r, r.ok ? TP("imported") : "");
  });
  const root = h("span", { class: "pst" }, sel, saveBtn, delBtn, expBtn, impBtn, fileIn);
  (app.presetBars ||= []).push({ render, root, born: performance.now() });
  render();
  return root;
}
