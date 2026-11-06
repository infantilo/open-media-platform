// Bedienfeld der Studio-Logik (Kapitel 89/RC2): Mikrofongruppen (auf Sendung, Rotlicht), Cough per Haltetaste, Studio-Übergabe, Regeln bearbeiten.
// Generische Node-Proxy-API: /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>. Eigenes Mini-t() (Sprache aus <html lang>).
const T = (() => {
  const D = {
    de: {
      mixer: "Mischer (Ziel)", gpio: "GPIO (Ziel)", noTarget: "— keiner —", groups: "Mikrofongruppen", onAir: "auf Sendung", off: "zu", cough: "Cough (halten)", coughOn: "Cough aktiv", light: "Rotlicht", lightPin: "Pin {n}", noLight: "kein Rotlicht",
      handover: "Studio-Übergabe", from: "Von", to: "Nach", at: "Zeitpunkt", inSec: "in {n} s", atTime: "um (HH:MM:SS)", offer: "Anbieten", accept: "Annehmen", abort: "Abbrechen", active: "Aktives Studio", noHandover: "Keine Übergabe offen.",
      offered: "angeboten", accepted: "angenommen", countdown: "Schaltpunkt in {s} s", audit: "Audit", noAudit: "Noch keine Einträge.",
      rules: "Regeln", gName: "Gruppe", gChannels: "Mischerkanäle (Komma)", gLight: "Rotlicht-Pin", gCough: "Cough-Pin", gSpeakers: "Lautsprecher stumm (kind:id, Komma)", addGroup: "+ Gruppe", sName: "Studio", sChannels: "Mikrofonkanäle (Komma)", addStudio: "+ Studio", studios: "Studios",
      maxCough: "Cough höchstens (s)", lightHold: "Rotlicht-Haltezeit (s)", save: "Speichern", dirty: "ungespeicherte Änderungen", del: "Entfernen", saved: "Regeln gespeichert.", fail: "{m} fehlgeschlagen: {d}", badTime: "Uhrzeit ungültig (HH:MM[:SS]).",
      hintCough: "Taste halten = Gruppe stumm; Loslassen öffnet wieder (auch bei Fokusverlust). Ohne Loslassen endet es nach der Höchstdauer.", hintRules: "Lautsprecher: z. B. channel:ch2, group:spk oder aux:a1 — sie sind stumm, solange die Gruppe auf Sendung ist. Pins zählen ab 1.", noGroups: "Keine Gruppen. Unter „Regeln“ anlegen.",
    },
    en: {
      mixer: "Mixer (target)", gpio: "GPIO (target)", noTarget: "— none —", groups: "Microphone groups", onAir: "on air", off: "closed", cough: "Cough (hold)", coughOn: "Cough active", light: "On-air light", lightPin: "Pin {n}", noLight: "no light",
      handover: "Studio handover", from: "From", to: "To", at: "Time", inSec: "in {n} s", atTime: "at (HH:MM:SS)", offer: "Offer", accept: "Accept", abort: "Abort", active: "Active studio", noHandover: "No handover open.",
      offered: "offered", accepted: "accepted", countdown: "Switch in {s} s", audit: "Audit", noAudit: "No entries yet.",
      rules: "Rules", gName: "Group", gChannels: "Mixer channels (comma)", gLight: "Light pin", gCough: "Cough pin", gSpeakers: "Speakers muted (kind:id, comma)", addGroup: "+ Group", sName: "Studio", sChannels: "Microphone channels (comma)", addStudio: "+ Studio", studios: "Studios",
      maxCough: "Cough at most (s)", lightHold: "Light hold time (s)", save: "Save", dirty: "unsaved changes", del: "Remove", saved: "Rules saved.", fail: "{m} failed: {d}", badTime: "Invalid time (HH:MM[:SS]).",
      hintCough: "Hold the key = group muted; release reopens (also on focus loss). Without release it ends after the maximum duration.", hintRules: "Speakers: e.g. channel:ch2, group:spk or aux:a1 — they are muted while the group is on air. Pins count from 1.", noGroups: "No groups. Create them under “Rules”.",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const STYLE = `
  :host { display: block; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --warn: #e0a030; --err: #e05050; }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; color: inherit; }
  input, select { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 5px 10px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #2a5a8f; border-color: var(--acc); } button.danger { background: #6a2a2a; border-color: var(--err); }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 8px; } .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .banner { display: none; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; margin-bottom: 6px; } .banner.show { display: block; } .banner.note { background: #2a5a8f; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); } details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
  .grp { border: 1px solid var(--bd); border-radius: 6px; padding: 10px; background: var(--bg); display: flex; flex-direction: column; gap: 8px; } .grp.air { border-color: var(--err); box-shadow: 0 0 0 1px var(--err); }
  .grp .nm { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .lamp { width: 14px; height: 14px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--bd); } .lamp.on { background: var(--err); border-color: var(--err); box-shadow: 0 0 8px var(--err); }
  .chip { padding: 1px 8px; border-radius: 10px; background: var(--bg3); font-size: 11px; } .chip.air { background: var(--err); color: #fff; } .chip.cough { background: var(--warn); color: #000; }
  .cough { min-height: 56px; font-size: 14px; font-weight: 700; user-select: none; touch-action: none; } .cough.hold { background: var(--warn); color: #000; border-color: var(--warn); }
  table { border-collapse: collapse; width: 100%; } th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 4px; } td { padding: 2px 3px; } td input { width: 100%; min-width: 70px; }
  .muted, .hint { color: var(--mut); } .dirty { color: var(--warn); margin-left: 8px; } .ev { font-variant-numeric: tabular-nums; font-family: monospace; padding: 1px 0; }
  .big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
`;

const parseSpeakers = (t) => t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [kind, id] = x.includes(":") ? x.split(":") : ["channel", x]; return { kind: kind.trim(), id: (id || "").trim() }; });
const fmtSpeakers = (a) => (a || []).map((x) => `${x.kind}:${x.id}`).join(", ");
const csv = (t) => t.split(",").map((x) => x.trim()).filter(Boolean);

class OmpStudioLogicPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const base = `/api/v1/nodes/${nodeId}`;
    let view = { groups: [], studios: [], activeStudio: null, handover: null, nowTaiNs: 0 };
    let cfg = { groups: [], studios: [], maxCoughMs: 15000, lightHoldMs: 3000 };
    let cfgDirty = false, initialised = false, audit = [], lastError = "", mixer = "", gpio = "", targets = [], chans = [];
    const coughDown = new Set();

    const banner = h("div", { class: "banner" });
    let bt = null;
    const show = (text, note) => { banner.textContent = text; banner.className = `banner show${note ? " note" : ""}`; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 6000); };
    const getParam = async (name) => { const r = await fetch(`${base}/params/${name}`); return r.ok ? (await r.json()).value : undefined; };
    const setParam = (name, value) => fetch(`${base}/params/${name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    const call = async (method, body, quiet) => {
      const r = await fetch(`${base}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      if (r.ok) return true;
      let d = await r.text().catch(() => ""); try { d = JSON.parse(d).error || d; } catch { /* Klartext */ }
      if (!quiet) show(T("fail", { m: method, d: d || r.status })); return false;
    };

    // ---- Ziele ----
    const mixerSel = h("select", { onchange: () => { setParam("mixer", mixerSel.value); mixer = mixerSel.value; loadChannels(); } });
    const gpioSel = h("select", { onchange: () => { setParam("gpio", gpioSel.value); gpio = gpioSel.value; } });
    const head = h("div", { class: "bar" }, h("label", {}, T("mixer"), mixerSel), h("label", {}, T("gpio"), gpioSel));
    const fill = (sel, cur) => { const opts = ["", ...new Set([...targets, ...(cur && !targets.includes(cur) ? [cur] : [])])]; if (sel.options.length !== opts.length || ![...sel.options].every((o, i) => o.value === opts[i])) sel.replaceChildren(...opts.map((v) => h("option", { value: v }, v || T("noTarget")))); sel.value = cur; };

    // ---- Gruppen (Live) ----
    const grid = h("div", { class: "grid" });
    const groupsSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("groups")), h("div", { class: "body" }, grid, h("p", { class: "hint" }, T("hintCough"))));
    let gSig = "", gEls = [];
    const releaseAll = () => { for (const name of [...coughDown]) { coughDown.delete(name); call("cough", { group: name, on: false }, true); } };
    const renderGroups = () => {
      const gs = view.groups || [];
      if (!gs.length) { grid.replaceChildren(h("span", { class: "muted" }, T("noGroups"))); gSig = ""; return; }
      const sig = JSON.stringify(gs.map((g) => [g.name, g.light]));
      if (sig !== gSig) {
        gSig = sig; gEls = [];
        grid.replaceChildren(...gs.map((g) => {
          const lamp = h("span", { class: "lamp" }), chip = h("span", { class: "chip" }), cb = h("button", { class: "cough" }, T("cough"));
          const down = (e) => { e.preventDefault(); try { cb.setPointerCapture(e.pointerId); } catch { /* ohne Capture */ } if (coughDown.has(g.name)) return; coughDown.add(g.name); cb.classList.add("hold"); call("cough", { group: g.name, on: true }); };
          const up = () => { if (!coughDown.has(g.name)) return; coughDown.delete(g.name); cb.classList.remove("hold"); call("cough", { group: g.name, on: false }).then(poll); };
          cb.addEventListener("pointerdown", down); cb.addEventListener("pointerup", up); cb.addEventListener("pointercancel", up); cb.addEventListener("lostpointercapture", up);
          const card = h("div", { class: "grp" }, h("div", { class: "nm" }, lamp, g.name, chip), h("div", { class: "muted" }, `${(g.channels || []).join(", ")} · ${g.light ? T("lightPin", { n: g.light }) : T("noLight")}`), cb);
          gEls.push({ card, lamp, chip, cb }); return card;
        }));
      }
      gs.forEach((g, i) => { const e = gEls[i]; if (!e) return;
        e.card.classList.toggle("air", !!g.onAir); e.lamp.classList.toggle("on", !!g.onAir);
        e.chip.textContent = g.cough ? T("coughOn") : g.onAir ? T("onAir") : T("off"); e.chip.className = `chip${g.cough ? " cough" : g.onAir ? " air" : ""}`; });
    };
    addEventListener("blur", releaseAll); addEventListener("pagehide", releaseAll);

    // ---- Übergabe ----
    const hFrom = h("select"), hTo = h("select"), hMode = h("select", { onchange: () => { hIn.style.display = hMode.value === "in" ? "" : "none"; hAt.style.display = hMode.value === "at" ? "" : "none"; } }, h("option", { value: "in" }, T("inSec", { n: "…" })), h("option", { value: "at" }, T("atTime")));
    const hIn = h("input", { type: "number", min: "3", value: "10", style: "width:70px" }), hAt = h("input", { type: "text", placeholder: "HH:MM:SS", style: "width:90px;display:none" });
    const hState = h("div"), activeEl = h("span", { class: "big" }), auditEl = h("div");
    const offerBtn = h("button", { class: "primary", onclick: async () => {
      let body = { from: hFrom.value, to: hTo.value };
      if (hMode.value === "in") body.delayMs = Math.max(3, Number(hIn.value) || 10) * 1000;
      else { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hAt.value.trim()); if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return show(T("badTime")); const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); body.atUnixMs = d.getTime(); }
      if (await call("offerHandover", body)) poll();
    } }, T("offer"));
    const acceptBtn = h("button", { onclick: async () => { if (await call("acceptHandover")) poll(); } }, T("accept"));
    const abortBtn = h("button", { class: "danger", onclick: async () => { if (await call("abortHandover")) poll(); } }, T("abort"));
    const handSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("handover")),
      h("div", { class: "body" }, h("div", { class: "bar" }, h("label", {}, T("active"), activeEl), h("label", {}, T("from"), hFrom), h("label", {}, T("to"), hTo), h("label", {}, T("at"), h("span", {}, hMode, hIn, hAt)), offerBtn, acceptBtn, abortBtn), hState,
        h("div", { class: "muted", style: "margin:8px 0 2px" }, T("audit")), auditEl));
    const renderHandover = () => {
      const st = view.studios || [];
      const fillStudio = (sel) => { const cur = sel.value; if (sel.options.length !== st.length || ![...sel.options].every((o, i) => o.value === st[i])) { sel.replaceChildren(...st.map((n) => h("option", { value: n }, n))); if (st.includes(cur)) sel.value = cur; } };
      if (document.activeElement !== hFrom) fillStudio(hFrom); if (document.activeElement !== hTo) { fillStudio(hTo); if (st.length > 1 && hTo.value === hFrom.value && !hTo._touched) hTo.value = st.find((n) => n !== hFrom.value); }
      activeEl.textContent = view.activeStudio || "—";
      const ho = view.handover;
      offerBtn.disabled = !!ho || st.length < 2; acceptBtn.disabled = !ho || ho.state !== "offered"; abortBtn.disabled = !ho;
      if (!ho) hState.replaceChildren(h("span", { class: "muted" }, T("noHandover")));
      else { const left = Math.max(0, Math.round((ho.atTaiNs - view.nowTaiNs) / 1e9)); hState.replaceChildren(h("div", { class: "big" }, `${ho.from} → ${ho.to} · ${T(ho.state)} · ${T("countdown", { s: left })}`)); }
      auditEl.replaceChildren(...(audit.length ? audit.slice().reverse().slice(0, 30).map((t) => h("div", { class: "ev" }, t)) : [h("span", { class: "muted" }, T("noAudit"))]));
    };

    // ---- Regeln bearbeiten (explizites Speichern) ----
    const dirtyEl = h("span", { class: "dirty" }), markDirty = () => { cfgDirty = true; dirtyEl.textContent = T("dirty"); };
    const gBody = h("tbody"), sBody = h("tbody"), chanList = h("datalist", { id: "chans" });
    const inp = (obj, key, opts = {}) => h("input", { type: opts.type || "text", list: opts.list, value: opts.get ? opts.get(obj[key]) : (obj[key] ?? ""), oninput: (e) => { obj[key] = opts.set ? opts.set(e.target.value) : e.target.value; markDirty(); } });
    const renderCfg = () => {
      gBody.replaceChildren(...cfg.groups.map((g, i) => h("tr", {}, h("td", {}, inp(g, "name")), h("td", {}, inp(g, "channels", { list: "chans", get: (v) => (v || []).join(", "), set: csv })),
        h("td", {}, inp(g, "light", { type: "number", get: (v) => v ?? "", set: (v) => (v === "" ? null : Number(v)) })), h("td", {}, inp(g, "coughInput", { type: "number", get: (v) => v ?? "", set: (v) => (v === "" ? null : Number(v)) })),
        h("td", {}, inp(g, "speakers", { get: fmtSpeakers, set: parseSpeakers })), h("td", {}, h("button", { title: T("del"), onclick: () => { cfg.groups.splice(i, 1); markDirty(); renderCfg(); } }, "✕")))));
      sBody.replaceChildren(...cfg.studios.map((x, i) => h("tr", {}, h("td", {}, inp(x, "name")), h("td", {}, inp(x, "channels", { list: "chans", get: (v) => (v || []).join(", "), set: csv })), h("td", {}, h("button", { title: T("del"), onclick: () => { cfg.studios.splice(i, 1); markDirty(); renderCfg(); } }, "✕")))));
      chanList.replaceChildren(...chans.map((c) => h("option", { value: c.id }, c.label || c.id)));
    };
    const maxC = h("input", { type: "number", min: "1", style: "width:80px", oninput: () => { cfg.maxCoughMs = Math.round(Number(maxC.value) * 1000); markDirty(); } });
    const holdC = h("input", { type: "number", min: "0.5", step: "0.5", style: "width:80px", oninput: () => { cfg.lightHoldMs = Math.round(Number(holdC.value) * 1000); markDirty(); } });
    const saveBtn = h("button", { class: "primary", onclick: async () => {
      const r = await setParam("config", JSON.stringify(cfg));
      if (r.ok) { cfgDirty = false; dirtyEl.textContent = ""; show(T("saved"), true); poll(); } else show(T("fail", { m: "config", d: r.status }));
    } }, T("save"));
    const th = (...c) => h("thead", {}, h("tr", {}, c.map((x) => h("th", {}, x)), h("th")));
    const rulesSec = h("details", { class: "sec" }, h("summary", {}, T("rules")), h("div", { class: "body" },
      h("table", {}, th(T("gName"), T("gChannels"), T("gLight"), T("gCough"), T("gSpeakers")), gBody), h("div", { class: "bar", style: "margin-top:6px" }, h("button", { onclick: () => { cfg.groups.push({ name: "", channels: [], light: null, speakers: [], coughInput: null }); markDirty(); renderCfg(); } }, T("addGroup"))),
      h("div", { class: "muted", style: "margin:8px 0 2px" }, T("studios")), h("table", {}, th(T("sName"), T("sChannels")), sBody), h("div", { class: "bar", style: "margin-top:6px" }, h("button", { onclick: () => { cfg.studios.push({ name: "", channels: [] }); markDirty(); renderCfg(); } }, T("addStudio"))),
      h("div", { class: "bar" }, h("label", {}, T("maxCough"), maxC), h("label", {}, T("lightHold"), holdC), saveBtn, dirtyEl), chanList, h("p", { class: "hint" }, T("hintRules"))));

    shadow.append(h("style", {}, STYLE), banner, head, groupsSec, handSec, rulesSec);
    renderGroups(); renderHandover(); renderCfg();

    const loadTargets = async () => {
      try { const r = await fetch("/api/v1/nodes"); if (!r.ok) return; const j = await r.json(); const l = (Array.isArray(j) ? j : j.nodes || []); targets = l.filter((n) => n.id !== nodeId).map((n) => n.label).sort(); window.__omp_nodes = l; } catch { /* Liste bleibt */ }
    };
    // Kanäle des gewählten Mischers für die Auswahl (nur Vorschläge; Eingabe bleibt frei)
    const loadChannels = async () => {
      chans = [];
      try {
        const l = window.__omp_nodes || []; const n = l.find((x) => x.label === mixer);
        if (n) {
          const [c, g, a] = await Promise.all(["channels", "groups", "auxBuses"].map(async (p) => { const r = await fetch(`/api/v1/nodes/${n.id}/params/${p}`); return r.ok ? (await r.json()).value : []; }));
          chans = (c || []).map((x) => ({ id: x.id, label: `${x.id} — ${x.label || ""}` }));
        }
      } catch { /* keine Vorschläge */ }
      renderCfg();
    };
    const poll = async () => {
      try {
        const [v, a, e, c, mx, gp] = await Promise.all(["view", "audit", "lastError", "config", "mixer", "gpio"].map(getParam));
        if (v) view = JSON.parse(v);
        if (a) audit = JSON.parse(a);
        lastError = e || ""; mixer = mx || ""; gpio = gp || "";
        if (c && (!initialised || !cfgDirty)) { try { cfg = { maxCoughMs: 15000, lightHoldMs: 3000, ...JSON.parse(c) }; cfg.groups = cfg.groups || []; cfg.studios = cfg.studios || []; maxC.value = cfg.maxCoughMs / 1000; holdC.value = cfg.lightHoldMs / 1000; if (!initialised) { initialised = true; renderCfg(); loadChannels(); } } catch { /* ungültig */ } }
        if (document.activeElement !== mixerSel) fill(mixerSel, mixer); if (document.activeElement !== gpioSel) fill(gpioSel, gpio);
        if (lastError) { banner.textContent = lastError; banner.className = "banner show"; } else if (banner.className === "banner show") banner.className = "banner";
        renderGroups(); renderHandover();
      } catch { /* nächster Takt */ }
    };
    loadTargets().then(poll);
    this._i1 = setInterval(poll, 500); this._i2 = setInterval(loadTargets, 15000);
  }
  disconnectedCallback() { clearInterval(this._i1); clearInterval(this._i2); }
}
if (!customElements.get("omp-studio-logic-panel")) customElements.define("omp-studio-logic-panel", OmpStudioLogicPanel);
