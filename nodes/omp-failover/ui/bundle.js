// Bedienfeld des Havarieumschalters (Kapitel 89): Zustand, Quellen mit Pegel, manuelle Umschaltung, Automatik, Einstellungen, Protokoll.
// Generische Node-Proxy-API: /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>. Eigenes Mini-t() (Sprache aus <html lang>).
const T = (() => {
  const D = {
    de: {
      st_normal: "NORMAL", st_havarie: "HAVARIE — Notsignal aktiv", st_allDown: "ALLE QUELLEN GESTÖRT", on: "auf Sendung", since: "seit {t}", modeAuto: "AUTOMATIK", modeManual: "MANUELL",
      sources: "Quellen", colPrio: "Prio", colName: "Quelle", colLevel: "Pegel", colState: "Zustand", colAct: "Aufschalten", take: "Aufschalten", live: "● Aktiv", auto: "Automatik einschalten",
      "s.gesund": "gesund", "s.gestoert": "gestört", "s.pruefe": "prüfe …", "s.nichtverbunden": "nicht verbunden", cause: "{c}",
      settings: "Einstellungen", noSignal: "Signal fehlt (s)", silenceDb: "Stille-Schwelle (dBFS)", silenceMs: "Stille (s)", healthy: "gesund nach (s)", returnT: "Rückkehr nach (s)", minHold: "Mindestverweildauer (s)", autoReturn: "Automatische Rückkehr zum Hauptsignal",
      order: "Reihenfolge der Notquellen", orderHint: "Die erste gesunde Quelle von oben übernimmt. Nicht angehakte werden nicht benutzt.", clip: "Notclip (Datei auf dem Host, Schleife)", save: "Speichern", dirty: "ungespeicherte Änderungen", saved: "Einstellungen gespeichert.",
      events: "Protokoll", noEvents: "Noch keine Ereignisse.", fail: "{m} fehlgeschlagen: {d}", up: "nach oben", down: "nach unten",
      askTake: "Hauptsignal ist in Ordnung. Wirklich auf „{n}“ umschalten?", askGo: "Umschalten", hint: "Alle Zeiten sind Eigenwerte (keine Norm). Automatik schaltet nach Ablauf der Haltezeiten auf die erste gesunde Quelle der Reihenfolge und kehrt nach stabiler Rückkehr des Hauptsignals zurück.",
      cNo: "kein Signal", cSi: "Stille", cFr: "Standbild", cBl: "Schwarzbild", freeze: "Standbild (s)", black: "Schwarzbild (s)", still: "Standbild als Notquelle (Bilddatei auf dem Host)",
    },
    en: {
      st_normal: "NORMAL", st_havarie: "EMERGENCY — fallback active", st_allDown: "ALL SOURCES FAILED", on: "on air", since: "for {t}", modeAuto: "AUTO", modeManual: "MANUAL",
      sources: "Sources", colPrio: "Prio", colName: "Source", colLevel: "Level", colState: "State", colAct: "Take", take: "Take", live: "● Active", auto: "Switch to automatic",
      "s.gesund": "healthy", "s.gestoert": "failed", "s.pruefe": "checking …", "s.nichtverbunden": "not connected", cause: "{c}",
      settings: "Settings", noSignal: "No signal (s)", silenceDb: "Silence threshold (dBFS)", silenceMs: "Silence (s)", healthy: "healthy after (s)", returnT: "Return after (s)", minHold: "Minimum hold (s)", autoReturn: "Return to main signal automatically",
      order: "Order of fallback sources", orderHint: "The first healthy source from the top takes over. Unchecked sources are not used.", clip: "Fallback clip (file on the host, loop)", save: "Save", dirty: "unsaved changes", saved: "Settings saved.",
      events: "Log", noEvents: "No events yet.", fail: "{m} failed: {d}", up: "up", down: "down",
      askTake: "The main signal is fine. Really switch to “{n}”?", askGo: "Switch", hint: "All times are our own values (no standard). Automatic mode switches to the first healthy source of the order after the hold times and returns after the main signal has been stable again.",
      cNo: "no signal", cSi: "silence", cFr: "freeze", cBl: "black", freeze: "Freeze (s)", black: "Black (s)", still: "Still image as fallback (image file on the host)",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();
const LOCALE = document.documentElement.lang === "en" ? "en-GB" : "de-DE";

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

function confirmDialog(message, confirmLabel) {
  if (!customElements.get("omp-confirm")) return Promise.resolve(true); // ohne Kit-Element: Bedienung nicht blockieren (kein window.confirm)
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (confirmLabel) el.setAttribute("confirm-label", confirmLabel);
    el.addEventListener("resolve", (ev) => { resolve(ev.detail); el.remove(); }, { once: true });
    document.body.appendChild(el);
  });
}

const STYLE = `
  :host { display: block; position: relative; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --warn: #e0a030; --err: #e05050; }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; color: inherit; }
  input[type=text], input[type=number] { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 5px 10px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #2a5a8f; border-color: var(--acc); }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; } .banner.show { display: block; } .banner.note { background: #2a5a8f; }
  .status { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 72px; padding: 0 16px; border-radius: 8px; margin-bottom: 10px; border: 2px solid var(--bd); background: var(--bg2); }
  .status .big { font-size: 22px; font-weight: 800; letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .status .sub { color: var(--mut); white-space: nowrap; }
  .status.normal { border-color: var(--ok); } .status.normal .big { color: var(--ok); }
  .status.havarie { border-color: var(--err); background: #3a1c1c; } .status.havarie .big { color: #ff8a8a; }
  .status.allDown { border-color: var(--err); background: #5a1414; } .status.allDown .big { color: #fff; }
  .chip { display: inline-block; min-width: 96px; text-align: center; padding: 3px 10px; border-radius: 10px; background: var(--bg3); font-weight: 700; white-space: nowrap; } .chip.manual { background: var(--warn); color: #000; } .chip.auto { background: #2a5a8f; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); } details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; } th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 6px; } td { padding: 5px 6px; vertical-align: middle; }
  tr.act td { background: #1f3a24; } tr.act.bad td { background: #4a1c1c; }
  .st { display: inline-block; width: 116px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st.gesund { color: var(--ok); } .st.gestoert { color: var(--err); font-weight: 700; } .st.nichtverbunden { color: var(--mut); }
  .meter { position: relative; width: 150px; height: 10px; background: var(--bg); border: 1px solid var(--bd); border-radius: 2px; overflow: hidden; } .meter > div { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #1f8f3a, #5fd06a 70%, #e0c030 88%, #e05050); }
  .db { display: inline-block; width: 62px; text-align: right; font-variant-numeric: tabular-nums; color: var(--mut); }
  .take { min-width: 104px; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 8px; } .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .ord { display: flex; flex-direction: column; gap: 3px; max-width: 360px; } .ord .r { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 1px solid var(--bd); border-radius: 4px; background: var(--bg); } .ord .r .n { flex: 1; } .ord .r button { padding: 1px 7px; }
  .dirty { color: var(--warn); margin-left: 8px; display: inline-block; min-width: 150px; } .hint, .muted { color: var(--mut); } .ev { font-variant-numeric: tabular-nums; padding: 2px 0; border-bottom: 1px solid var(--bg3); } .ev .t { color: var(--mut); margin-right: 8px; }
  .evbox { max-height: 260px; overflow-y: auto; }
`;

const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };

class OmpFailoverPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const base = `/api/v1/nodes/${nodeId}`;
    const banner = h("div", { class: "banner" });
    let bt = null;
    const show = (text, note) => { banner.textContent = text; banner.className = `banner show${note ? " note" : ""}`; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 6000); };
    const getParam = async (name) => { const r = await fetch(`${base}/params/${name}`); return r.ok ? (await r.json()).value : undefined; };
    const setParam = (name, value) => fetch(`${base}/params/${name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    const call = async (method, body) => {
      const r = await fetch(`${base}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      if (r.ok) return true;
      let d = await r.text().catch(() => ""); try { d = JSON.parse(d).error || d; } catch { /* Klartext */ }
      show(T("fail", { m: method, d: d || r.status })); return false;
    };
    let st = { status: "normal", mode: "auto", active: "main", activeSinceMs: 0 }, sources = [], events = [];
    let cfg = { noSignalMs: 1500, silenceDb: -60, silenceMs: 5000, freezeMs: 5000, blackMs: 5000, healthyMs: 500, returnMs: 3000, minHoldMs: 2000, autoReturn: true, order: ["n1", "n2", "n3", "clip"], clipFile: "", stillFile: "" };
    let dirty = false, initialised = false;
    const NAMES = { main: "Hauptsignal", n1: "Notquelle 1", n2: "Notquelle 2", n3: "Notquelle 3", clip: "Notclip", still: "Standbild" };
    let videoMode = false;
    const allSources = () => (videoMode ? ["n1", "n2", "n3", "clip", "still"] : ["n1", "n2", "n3", "clip"]);

    // ---- Zustand ----
    const bigEl = h("div", { class: "big" }), subEl = h("div", { class: "sub" }), modeChip = h("span", { class: "chip" });
    const statusEl = h("div", { class: "status normal" }, h("div", {}, bigEl, subEl), modeChip);
    const autoBtn = h("button", { class: "primary", onclick: async () => { if (await call("auto")) poll(); } }, T("auto"));

    // ---- Quellen ----
    const tbody = h("tbody");
    let rowSig = "", rowEls = {};
    const renderSources = () => {
      const shown = sources.filter((s) => s.id !== "still" || videoMode);
      const sig = JSON.stringify(shown.map((s) => [s.id, s.priority]));
      if (sig !== rowSig) {
        rowSig = sig; rowEls = {};
        tbody.replaceChildren(...shown.map((s) => {
          const lvl = h("div"), db = h("span", { class: "db" }), stEl = h("span", { class: "st" });
          const btn = h("button", { class: "take", onclick: async () => {
            const main = sources.find((x) => x.id === "main");
            if (s.id !== "main" && main && main.state === "gesund" && !(await confirmDialog(T("askTake", { n: NAMES[s.id] }), T("askGo")))) return;
            if (await call("select", { source: s.id })) poll();
          } }, T("take"));
          const tr = h("tr", {}, h("td", { class: "muted" }, s.priority ? `${s.priority}` : s.id === "main" ? "★" : "—"), h("td", {}, NAMES[s.id] || s.id), h("td", {}, h("div", { class: "meter" }, lvl), db), h("td", {}, stEl), h("td", {}, btn));
          rowEls[s.id] = { tr, lvl, db, stEl, btn };
          return tr;
        }));
      }
      for (const s of sources) {
        const e = rowEls[s.id]; if (!e) continue;
        e.lvl.style.width = `${Math.max(0, Math.min(100, ((s.levelDb + 60) / 60) * 100))}%`;
        e.db.textContent = s.levelDb <= -119 ? "−∞" : s.levelDb.toFixed(1);
        const cause = s.cause && s.state !== "nichtverbunden" ? ` (${({ "kein Signal": T("cNo"), Stille: T("cSi"), Standbild: T("cFr"), Schwarzbild: T("cBl") })[s.cause] || s.cause})` : "";
        e.stEl.textContent = T("s." + s.state) + cause; e.stEl.className = `st ${s.state}`;
        e.tr.className = `${s.active ? "act" : ""}${s.active && s.state === "gestoert" ? " bad" : ""}`;
        e.btn.textContent = s.active ? T("live") : T("take"); e.btn.disabled = !!s.active || !s.connected;
      }
    };

    // ---- Einstellungen (explizites Speichern) ----
    const dirtyEl = h("span", { class: "dirty" }), markDirty = () => { dirty = true; dirtyEl.textContent = T("dirty"); };
    const num = (key, scale = 1, step = "1", w = "90px") => h("input", { type: "number", step, style: `width:${w}`, "data-k": key, oninput: (e) => { cfg[key] = e.target.value === "" ? 0 : Number(e.target.value) * scale; markDirty(); } });
    const inNo = num("noSignalMs", 1000, "0.1"), inSd = num("silenceDb", 1, "1"), inSm = num("silenceMs", 1000, "0.5"), inHe = num("healthyMs", 1000, "0.1"), inRe = num("returnMs", 1000, "0.5"), inMh = num("minHoldMs", 1000, "0.5");
    const inFr = num("freezeMs", 1000, "0.5"), inBl = num("blackMs", 1000, "0.5");
    const inStill = h("input", { type: "text", style: "width:340px", placeholder: "/pfad/notbild.png", oninput: (e) => { cfg.stillFile = e.target.value; markDirty(); } });
    const inAuto = h("input", { type: "checkbox", style: "width:auto", onchange: (e) => { cfg.autoReturn = e.target.checked; markDirty(); } });
    const inClip = h("input", { type: "text", style: "width:340px", placeholder: "/pfad/notclip.wav", oninput: (e) => { cfg.clipFile = e.target.value; markDirty(); } });
    const ordEl = h("div", { class: "ord" });
    let ordUsed = [];
    const renderOrder = () => {
      const rest = allSources().filter((x) => !ordUsed.includes(x));
      const rows = [...ordUsed.map((id) => [id, true]), ...rest.map((id) => [id, false])];
      ordEl.replaceChildren(...rows.map(([id, used], i) => h("div", { class: "r" },
        h("input", { type: "checkbox", style: "width:auto", checked: used, onchange: (e) => { if (e.target.checked) ordUsed.push(id); else ordUsed = ordUsed.filter((x) => x !== id); cfg.order = [...ordUsed]; markDirty(); renderOrder(); } }),
        h("span", { class: "n" }, NAMES[id]),
        h("button", { title: T("up"), disabled: !used || i === 0, onclick: () => { [ordUsed[i - 1], ordUsed[i]] = [ordUsed[i], ordUsed[i - 1]]; cfg.order = [...ordUsed]; markDirty(); renderOrder(); } }, "↑"),
        h("button", { title: T("down"), disabled: !used || i >= ordUsed.length - 1, onclick: () => { [ordUsed[i + 1], ordUsed[i]] = [ordUsed[i], ordUsed[i + 1]]; cfg.order = [...ordUsed]; markDirty(); renderOrder(); } }, "↓"))));
    };
    const fillCfg = () => {
      inNo.value = cfg.noSignalMs / 1000; inSd.value = cfg.silenceDb; inSm.value = cfg.silenceMs / 1000; inFr.value = cfg.freezeMs / 1000; inBl.value = cfg.blackMs / 1000; inStill.value = cfg.stillFile || ""; inHe.value = cfg.healthyMs / 1000; inRe.value = cfg.returnMs / 1000; inMh.value = cfg.minHoldMs / 1000;
      inAuto.checked = cfg.autoReturn; inClip.value = cfg.clipFile || ""; ordUsed = [...cfg.order]; renderOrder();
    };
    const saveBtn = h("button", { class: "primary", onclick: async () => {
      const w = [["noSignalMs", cfg.noSignalMs], ["silenceDb", cfg.silenceDb], ["silenceMs", cfg.silenceMs], ["freezeMs", cfg.freezeMs], ["blackMs", cfg.blackMs], ["healthyMs", cfg.healthyMs], ["returnMs", cfg.returnMs], ["minHoldMs", cfg.minHoldMs], ["autoReturn", cfg.autoReturn], ["order", JSON.stringify(cfg.order)], ["clipFile", cfg.clipFile || ""]].concat(videoMode ? [["stillFile", cfg.stillFile || ""]] : []);
      for (const [k, v] of w) { const r = await setParam(k, v); if (!r.ok) { show(T("fail", { m: k, d: r.status })); return; } }
      dirty = false; dirtyEl.textContent = ""; show(T("saved"), true); poll();
    } }, T("save"));
    const lab = (txt, el) => h("label", {}, txt, el);
    const videoBar = h("div", { class: "bar", style: "display:none" }, lab(T("freeze"), inFr), lab(T("black"), inBl));
    const stillBar = h("div", { class: "bar", style: "display:none" }, lab(T("still"), inStill));
    const settingsSec = h("details", { class: "sec" }, h("summary", {}, T("settings")), h("div", { class: "body" },
      h("div", { class: "bar" }, lab(T("noSignal"), inNo), lab(T("silenceDb"), inSd), lab(T("silenceMs"), inSm), lab(T("healthy"), inHe), lab(T("returnT"), inRe), lab(T("minHold"), inMh),
        h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, inAuto, T("autoReturn"))),
      h("div", { class: "muted", style: "margin:6px 0 4px" }, T("order")), ordEl, h("p", { class: "hint" }, T("orderHint")),
      h("div", { class: "bar" }, lab(T("clip"), inClip)), videoBar, stillBar, h("div", { class: "bar" }, saveBtn, dirtyEl), h("p", { class: "hint" }, T("hint"))));

    // ---- Protokoll ----
    const evEl = h("div", { class: "evbox" });
    const eventsSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("events")), h("div", { class: "body" }, evEl));
    const renderEvents = () => evEl.replaceChildren(...(events.length ? events.map((e) => h("div", { class: "ev" }, h("span", { class: "t" }, new Date(e.atUnixMs).toLocaleString(LOCALE)), e.text)) : [h("span", { class: "muted" }, T("noEvents"))]));

    const sourcesSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("sources")), h("div", { class: "body" },
      h("table", {}, h("thead", {}, h("tr", {}, ...["colPrio", "colName", "colLevel", "colState", "colAct"].map((k) => h("th", {}, T(k))))), tbody), h("div", { class: "bar", style: "margin-top:8px" }, autoBtn)));
    shadow.addEventListener("contextmenu", (e) => { if (e.target && e.target.closest && e.target.closest("button")) e.preventDefault(); });
    shadow.append(h("style", {}, STYLE), banner, statusEl, sourcesSec, settingsSec, eventsSec);
    renderEvents();

    const poll = async () => {
      try {
        const [stt, mode, active, since, src, ev, no, sd, sm, he, re, mh, ar, ord, clip, vm, fr, bl, stl] = await Promise.all(["status", "mode", "active", "activeSinceMs", "sources", "events", "noSignalMs", "silenceDb", "silenceMs", "healthyMs", "returnMs", "minHoldMs", "autoReturn", "order", "clipFile", "videoMode", "freezeMs", "blackMs", "stillFile"].map(getParam));
        videoMode = !!vm; videoBar.style.display = stillBar.style.display = videoMode ? "" : "none";
        st = { status: stt || "normal", mode: mode || "auto", active: active || "main", activeSinceMs: since || 0 };
        if (src) sources = JSON.parse(src);
        if (ev) events = JSON.parse(ev);
        if (!initialised || !dirty) { cfg = { noSignalMs: no, silenceDb: sd, silenceMs: sm, freezeMs: fr ?? 5000, blackMs: bl ?? 5000, healthyMs: he, returnMs: re, minHoldMs: mh, autoReturn: ar, order: JSON.parse(ord || "[]"), clipFile: clip || "", stillFile: stl || "" }; if (!initialised || !shadow.activeElement) fillCfg(); initialised = true; }
        statusEl.className = `status ${st.status}`;
        bigEl.textContent = T("st_" + st.status);
        subEl.textContent = `${NAMES[st.active] || st.active} — ${T("on")} ${T("since", { t: fmtDur(st.activeSinceMs) })}`;
        modeChip.textContent = st.mode === "auto" ? T("modeAuto") : T("modeManual"); modeChip.className = `chip ${st.mode}`;
        autoBtn.disabled = st.mode === "auto";
        renderSources(); renderEvents();
      } catch { /* nächster Takt */ }
    };
    poll();
    this._i = setInterval(poll, 400);
  }
  disconnectedCallback() { clearInterval(this._i); }
}
if (!customElements.get("omp-failover-panel")) customElements.define("omp-failover-panel", OmpFailoverPanel);
