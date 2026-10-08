// Recorder-Panel (Kap. 33.5): Start/Stopp + MCA-Label-Tabelle für .mxf-Aufnahmen.
// Die Tabelle erzeugt den JSON-Plan für `record.mcaPlan` (Format wie `mxf-mca inject`).
const T = (() => {
  const D = {
    de: {
      name: "Dateiname", start: "Aufnahme starten", stop: "Stoppen", idle: "Leerlauf", recording: "Aufnahme läuft", error: "Fehler",
      mxfHint: "Endung .mxf → MXF (H.264 + PCM 24 Bit); nur dann werden Labels geschrieben.",
      labels: "MCA-Labels (ST 377-4/-41)", add: "+ Soundfield-Gruppe", remove: "Entfernen",
      layout: "Layout", content: "Inhalt", useClass: "Klasse", lang: "Sprache (z. B. de)", attr: "Sprachattribut", group: "Gruppe",
      none: "—", channels: "Kanäle", raw: "Plan (JSON, editierbar)", apply: "Übernehmen", saved: "Plan gespeichert", empty: "Keine Labels (leerer Plan).",
      first: "ab Kanal",
    },
    en: {
      name: "File name", start: "Start recording", stop: "Stop", idle: "Idle", recording: "Recording", error: "Error",
      mxfHint: "Extension .mxf → MXF (H.264 + 24-bit PCM); labels are only written then.",
      labels: "MCA labels (ST 377-4/-41)", add: "+ Soundfield group", remove: "Remove",
      layout: "Layout", content: "Content", useClass: "Use class", lang: "Language (e.g. en)", attr: "Language attribute", group: "Group",
      none: "—", channels: "Channels", raw: "Plan (JSON, editable)", apply: "Apply", saved: "Plan saved", empty: "No labels (empty plan).",
      first: "from channel",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
})();

// Soundfield-Group-Layouts (ST 428-12 / 2067-8): SG-Symbol → Kanal-Symbole in Reihenfolge.
const LAYOUTS = {
  ST: ["L", "R"], DM: ["M1", "M2"], M: ["M1"], LtRt: ["Lt", "Rt"], "30": ["L", "R", "C"],
  "51": ["L", "R", "C", "LFE", "Ls", "Rs"], "71": ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs"],
};
const CONTENTS = ["", "PRM", "SAP", "HI", "DV", "DX", "MX", "FX", "ME", "VO", "VI", "CM", "MOS"];
const USE_CLASSES = ["", "FCMP", "ICMP", "SMPL", "SING"];
const GROUPS = ["", "MPg", "DVS", "Dcm"];

// Reine Funktion: Tabellenzeilen → Plan-Objekt (auch für Tests ohne DOM nutzbar).
function buildPlan(rows) {
  const plan = { replaceExisting: true, channels: [], soundfieldGroups: [], groups: [] };
  const groupIndex = new Map();
  let next = 0;
  rows.forEach((r, si) => {
    const items = {};
    if (r.content) items.content = r.content;
    if (r.useClass) items.useClass = r.useClass;
    if (r.lang) { items.spokenLanguage = r.lang; if (r.attr) items.spokenLanguageAttribute = r.attr; }
    plan.soundfieldGroups.push({ label: r.layout, items });
    for (const sym of LAYOUTS[r.layout]) plan.channels.push({ index: next++, label: sym, soundfieldGroup: si });
    if (r.group) {
      if (!groupIndex.has(r.group)) { groupIndex.set(r.group, plan.groups.length); plan.groups.push({ label: r.group, groups: [] }); }
      plan.groups[groupIndex.get(r.group)].groups.push(si);
    }
  });
  return plan;
}

class OmpRecorderPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      input, select, textarea, button { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 4px 6px; font-size: 12px; }
      button { cursor: pointer; } button.rec { background: #7a1f1f; border-color: #a33; font-weight: bold; }
      button:disabled { opacity: .5; cursor: default; }
      .status { padding: 3px 8px; border-radius: 3px; background: #333; } .status.recording { background: #a33; }
      .hint { opacity: .65; } h4 { margin: 12px 0 6px; font-size: 13px; }
      table { border-collapse: collapse; } td, th { padding: 2px 6px; text-align: left; }
      textarea { width: 100%; box-sizing: border-box; height: 90px; font-family: monospace; }
    `;
    const root = document.createElement("div");
    shadow.append(style, root);

    const nameIn = document.createElement("input");
    nameIn.value = "aufnahme.mxf"; nameIn.size = 24; nameIn.title = T("name");
    const startBtn = document.createElement("button"); startBtn.className = "rec"; startBtn.textContent = T("start");
    const stopBtn = document.createElement("button"); stopBtn.textContent = T("stop");
    const statusEl = document.createElement("span"); statusEl.className = "status";
    const durEl = document.createElement("span");
    const top = document.createElement("div"); top.className = "row"; top.append(nameIn, startBtn, stopBtn, statusEl, durEl);
    const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = T("mxfHint");
    const msg = document.createElement("div"); msg.className = "hint";

    const h = document.createElement("h4"); h.textContent = T("labels");
    const table = document.createElement("table");
    const addBtn = document.createElement("button"); addBtn.textContent = T("add");
    const rawLabel = document.createElement("div"); rawLabel.className = "hint"; rawLabel.textContent = T("raw");
    const raw = document.createElement("textarea");
    const applyBtn = document.createElement("button"); applyBtn.textContent = T("apply");
    root.append(top, hint, msg, h, table, addBtn, rawLabel, raw, applyBtn);

    const call = (method, body) => fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const getParam = async (n) => { const r = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(n)}`); return r.ok ? (await r.json()).value : undefined; };
    const setParam = (n, v) => fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(n)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });

    const rows = [];
    const sel = (opts, value, onChange, labelFn) => {
      const s = document.createElement("select");
      for (const o of opts) { const e = document.createElement("option"); e.value = o; e.textContent = labelFn ? labelFn(o) : (o || T("none")); s.append(e); }
      s.value = value; s.addEventListener("change", () => onChange(s.value)); return s;
    };
    const savePlan = async () => {
      const text = rows.length ? JSON.stringify(buildPlan(rows)) : "";
      raw.value = text ? JSON.stringify(buildPlan(rows), null, 1) : "";
      await setParam("record.mcaPlan", text);
      msg.textContent = text ? T("saved") : T("empty");
    };
    const render = () => {
      table.replaceChildren();
      const head = document.createElement("tr");
      for (const k of ["first", "layout", "content", "useClass", "lang", "attr", "group", ""]) { const th = document.createElement("th"); th.textContent = k ? T(k) : ""; head.append(th); }
      table.append(head);
      let next = 0;
      rows.forEach((r, i) => {
        const tr = document.createElement("tr");
        const cell = (el) => { const td = document.createElement("td"); td.append(el); tr.append(td); };
        const from = document.createElement("span"); from.textContent = `${next + 1}–${next + LAYOUTS[r.layout].length}`; next += LAYOUTS[r.layout].length;
        cell(from);
        cell(sel(Object.keys(LAYOUTS), r.layout, (v) => { r.layout = v; render(); savePlan(); }, (o) => `${o} (${LAYOUTS[o].join(" ")})`));
        cell(sel(CONTENTS, r.content, (v) => { r.content = v; savePlan(); }));
        cell(sel(USE_CLASSES, r.useClass, (v) => { r.useClass = v; savePlan(); }));
        const lang = document.createElement("input"); lang.size = 4; lang.value = r.lang; lang.placeholder = "de";
        lang.addEventListener("change", () => { r.lang = lang.value.trim(); savePlan(); }); cell(lang);
        cell(sel(["", "ORIGINAL", "DUBBED"], r.attr, (v) => { r.attr = v; savePlan(); }));
        cell(sel(GROUPS, r.group, (v) => { r.group = v; savePlan(); }));
        const rm = document.createElement("button"); rm.textContent = "✕"; rm.title = T("remove");
        rm.addEventListener("click", () => { rows.splice(i, 1); render(); savePlan(); }); cell(rm);
        table.append(tr);
      });
    };
    addBtn.addEventListener("click", () => { rows.push({ layout: "ST", content: "PRM", useClass: "FCMP", lang: "", attr: "", group: "" }); render(); savePlan(); });
    applyBtn.addEventListener("click", async () => { await setParam("record.mcaPlan", raw.value.trim()); msg.textContent = T("saved"); });
    startBtn.addEventListener("click", async () => {
      const res = await call("record.start", { fileName: nameIn.value.trim() });
      msg.textContent = res.ok ? "" : ((await res.json().catch(() => ({}))).error || res.statusText);
      poll();
    });
    stopBtn.addEventListener("click", async () => { await call("record.stop"); poll(); });

    const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    const poll = async () => {
      const [status, dur] = await Promise.all([getParam("record.status"), getParam("record.durationMs")]);
      statusEl.textContent = T(status || "idle"); statusEl.className = `status ${status || ""}`;
      durEl.textContent = fmt(dur || 0);
      startBtn.disabled = status === "recording"; stopBtn.disabled = status !== "recording";
      nameIn.disabled = status === "recording";
    };
    getParam("record.mcaPlan").then((p) => { if (p && document.activeElement !== raw) raw.value = p; });
    poll();
    this._interval = setInterval(poll, 1000);
  }
  disconnectedCallback() { clearInterval(this._interval); }
}

if (!customElements.get("omp-recorder-panel")) customElements.define("omp-recorder-panel", OmpRecorderPanel);
