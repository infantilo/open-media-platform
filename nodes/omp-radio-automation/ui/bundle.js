// Bedienfeld der Radio-Automation (Kapitel 89/RB4): Ziel wählen, Log bearbeiten und laden, Übergänge als Zeitleiste sehen, starten/stoppen.
// Gleiche generische Node-Proxy-API wie alle Bundles: /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>.
// Eigenes Mini-t() (Node-Bundles können keine Shell-Module importieren); Sprache aus <html lang>.
const T = (() => {
  const D = {
    de: {
      target: "Segue-Player (Ziel)", noTarget: "— kein Ziel —", lookahead: "Vorlauf (s)", state: "Zustand",
      "st.empty": "leer", "st.loaded": "geladen", "st.running": "läuft", "st.finished": "beendet",
      log: "Log", logId: "Log-Name", add: "+ Element", load: "Log laden", dirty: "ungeladene Änderungen", import: "JSON einfügen …", export: "Als JSON anzeigen", apply: "Übernehmen",
      colId: "Name", colKind: "Art", colFile: "Datei", colDur: "Dauer (ms)", colIntro: "Intro (ms)", colOutro: "Segue-Punkt (ms)", colSom: "Start in Datei (ms)", colGain: "Pegel (dB)", colFix: "Harte Marke (HH:MM:SS)", colOpt: "Füller",
      "kind.song": "Titel", "kind.jingle": "Jingle", "kind.speech": "Gesprochenes",
      up: "nach oben", down: "nach unten", del: "Entfernen",
      plan: "Ablauf", now: "jetzt", noPlan: "Noch kein Log geladen.",
      start: "Start", startIn: "in {n} s", startAt: "um (HH:MM:SS)", startBtn: "Starten", stop: "Stoppen", stopAsk: "Sendung stoppen? Laufende Stimmen werden ausgeblendet.", stopGo: "Stoppen",
      sent: "gesendet", waiting: "wartet", playing: "läuft", done: "vorbei", elapsed: "Zeit",
      asRun: "As-Run", noAsRun: "Noch keine Einträge.", evSched: "geplant", evStop: "Stopp", evBack: "Backtiming", evBackRes: "Backtiming-Ergebnis: Rest {ms} ms", badFix: "Marke ungültig (HH:MM[:SS]): {v}", lead: "Vorlauf {s} s",
      loaded: "Log geladen.", started: "Gestartet.", stopped: "Gestoppt.", badTime: "Uhrzeit ungültig (HH:MM[:SS]).", badLog: "Log ungültig: {e}", fail: "{m} fehlgeschlagen: {d}",
      hint: "Eine harte Marke (Uhrzeit) lässt das Element zu dieser Zeit einsetzen: beim Start werden Füller weggelassen/eingefügt und Segue-Punkte verschoben (Entscheidungen im As-Run). Der Segue-Punkt ist die Stelle in der Datei, ab der der Nachfolger starten darf; ohne Angabe 3 s vor Dateiende. Der Log wird erst mit „Log laden“ übernommen.",
    },
    en: {
      target: "Segue player (target)", noTarget: "— no target —", lookahead: "Lead time (s)", state: "State",
      "st.empty": "empty", "st.loaded": "loaded", "st.running": "running", "st.finished": "finished",
      log: "Log", logId: "Log name", add: "+ Item", load: "Load log", dirty: "unloaded changes", import: "Paste JSON …", export: "Show as JSON", apply: "Apply",
      colId: "Name", colKind: "Kind", colFile: "File", colDur: "Duration (ms)", colIntro: "Intro (ms)", colOutro: "Segue point (ms)", colSom: "Start in file (ms)", colGain: "Level (dB)", colFix: "Hard mark (HH:MM:SS)", colOpt: "Filler",
      "kind.song": "Track", "kind.jingle": "Jingle", "kind.speech": "Speech",
      up: "move up", down: "move down", del: "Remove",
      plan: "Schedule", now: "now", noPlan: "No log loaded yet.",
      start: "Start", startIn: "in {n} s", startAt: "at (HH:MM:SS)", startBtn: "Start", stop: "Stop", stopAsk: "Stop the broadcast? Running voices are faded out.", stopGo: "Stop",
      sent: "sent", waiting: "waiting", playing: "playing", done: "done", elapsed: "Time",
      asRun: "As-run", noAsRun: "No entries yet.", evSched: "scheduled", evStop: "stop", evBack: "Backtiming", evBackRes: "Backtiming result: remainder {ms} ms", badFix: "Invalid mark (HH:MM[:SS]): {v}", lead: "lead {s} s",
      loaded: "Log loaded.", started: "Started.", stopped: "Stopped.", badTime: "Invalid time (HH:MM[:SS]).", badLog: "Invalid log: {e}", fail: "{m} failed: {d}",
      hint: "A hard mark (time of day) makes the item start at that time: at start, fillers are dropped/inserted and segue points are moved (decisions in the as-run). The segue point is the position in the file from which the next item may start; without it, 3 s before the end. The log only takes effect with “Load log”.",
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
  if (!customElements.get("omp-confirm")) return Promise.resolve(false); // nie window.confirm
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (confirmLabel) el.setAttribute("confirm-label", confirmLabel);
    el.addEventListener("resolve", (ev) => { resolve(ev.detail); el.remove(); }, { once: true });
    document.body.appendChild(el);
  });
}

const STYLE = `
  :host { display: block; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --warn: #e0a030; --err: #e05050; }
  * { box-sizing: border-box; }
  button, select, input, textarea { font: inherit; color: inherit; }
  input, select, textarea { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 4px 9px; }
  button:hover:not(:disabled) { border-color: var(--acc); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #2a5a8f; border-color: var(--acc); }
  button.danger { background: #6a2a2a; border-color: var(--err); }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { padding: 2px 10px; border-radius: 10px; background: var(--bg3); font-weight: 600; }
  .chip.running { background: var(--ok); color: #fff; } .chip.finished { color: var(--mut); }
  .banner { display: none; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; margin-bottom: 6px; }
  .banner.show { display: block; } .banner.note { background: #2a5a8f; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 4px; }
  td { padding: 2px 3px; } td input, td select { width: 100%; } td.num input { width: 84px; text-align: right; }
  td.file input { min-width: 200px; } td.act { white-space: nowrap; } td.act button { padding: 2px 6px; }
  .hint, .muted { color: var(--mut); } .dirty { color: var(--warn); margin-left: 8px; }
  .tl { position: relative; margin-top: 6px; }
  .tlrow { position: relative; height: 22px; margin-bottom: 3px; background: var(--bg); border-radius: 3px; }
  .tlbar { position: absolute; top: 2px; height: 18px; border-radius: 3px; background: #2a5a8f; color: #fff; font-size: 10px; line-height: 18px; padding: 0 5px; overflow: hidden; white-space: nowrap; }
  .tlbar.jingle { background: #8f5a2a; } .tlbar.speech { background: #5a2a8f; } .tlbar.sent { outline: 1px solid var(--ok); } .tlbar.cur { box-shadow: 0 0 0 2px #fff; }
  .tlnow { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--err); z-index: 2; }
  .tlfade { position: absolute; top: 2px; height: 18px; background: repeating-linear-gradient(135deg, rgba(255,255,255,.28) 0 3px, transparent 3px 6px); border-radius: 3px; }
  .ev { font-variant-numeric: tabular-nums; padding: 1px 0; }
  textarea { width: 100%; min-height: 120px; font-family: monospace; }
`;

const fmtMs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const blankItem = () => ({ id: "", kind: "song", file: "", durationMs: 180000, somMs: 0, introMs: null, outroMs: null, gainDb: 0, optional: false, fixText: "" });
const fixToUnix = (text) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim()); if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null; const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); };
const unixToFix = (ms) => (ms ? new Date(ms).toLocaleTimeString("de-DE") : "");

class OmpRadioAutomationPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    let rows = [];
    let logId = "log1";
    let fillers = [];
    let dirty = false;
    let view = { state: "empty", items: [], startUnixMs: 0, nowUnixMs: 0 };
    let asRun = [];
    let lastError = "";
    let targets = [];
    let target = "";
    let startMode = "in";
    let initialised = false;

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

    const toWire = () => ({
      logId: logId.trim() || "log",
      items: rows.map((r, i) => ({
        id: r.id.trim() || `e${i + 1}`, kind: r.kind, file: r.file.trim(), durationMs: Number(r.durationMs) || 0,
        somMs: Number(r.somMs) || 0, introMs: r.introMs === null || r.introMs === "" ? null : Number(r.introMs),
        outroMs: r.outroMs === null || r.outroMs === "" ? null : Number(r.outroMs), gainDb: Number(r.gainDb) || 0,
        optional: !!r.optional, fixAtUnixMs: r.fixText && r.fixText.trim() ? fixToUnix(r.fixText) : null,
      })),
      fillers,
    });
    const fromWire = (l) => { logId = l.logId || "log"; fillers = l.fillers || []; rows = (l.items || []).map((i) => ({ ...blankItem(), ...i, introMs: i.introMs ?? null, outroMs: i.outroMs ?? null, fixText: unixToFix(i.fixAtUnixMs) })); };

    // ---- Kopf ----
    const stateChip = h("span", { class: "chip" });
    const targetSel = h("select", { onchange: () => setParam("target", targetSel.value) });
    const lookInput = h("input", { type: "number", min: "2", max: "300", style: "width:70px", onchange: () => setParam("lookaheadMs", Math.round(Number(lookInput.value) * 1000)).then((r) => { if (!r.ok) show(T("fail", { m: "lookahead", d: r.status })); }) });
    const head = h("div", { class: "bar" }, h("label", {}, T("state"), stateChip), h("label", {}, T("target"), targetSel), h("label", {}, T("lookahead"), lookInput));

    // ---- Log-Editor ----
    const logIdInput = h("input", { style: "width:160px", oninput: () => { logId = logIdInput.value; markDirty(); } });
    const dirtyEl = h("span", { class: "dirty" });
    const markDirty = () => { dirty = true; dirtyEl.textContent = T("dirty"); };
    const tbody = h("tbody");
    const cell = (cls, el) => h("td", { class: cls }, el);
    const renderRows = () => {
      tbody.replaceChildren(...rows.map((r, i) => {
        const inp = (key, type, cls) => h("input", { type, value: r[key] ?? "", oninput: (e) => { r[key] = type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value; markDirty(); } });
        const kind = h("select", { onchange: (e) => { r.kind = e.target.value; markDirty(); } }, ...["song", "jingle", "speech"].map((k) => h("option", { value: k }, T("kind." + k))));
        kind.value = r.kind;
        const move = (d) => () => { const j = i + d; if (j < 0 || j >= rows.length) return; [rows[i], rows[j]] = [rows[j], rows[i]]; markDirty(); renderRows(); };
        return h("tr", {}, cell("", inp("id", "text")), cell("", kind), cell("file", inp("file", "text")), cell("num", inp("durationMs", "number")), cell("num", inp("introMs", "number")), cell("num", inp("outroMs", "number")), cell("num", inp("somMs", "number")), cell("num", inp("gainDb", "number")), cell("", inp("fixText", "text")),
          cell("", h("input", { type: "checkbox", style: "width:auto", checked: !!r.optional, onchange: (e) => { r.optional = e.target.checked; markDirty(); } })),
          cell("act", [h("button", { title: T("up"), onclick: move(-1) }, "↑"), h("button", { title: T("down"), onclick: move(1) }, "↓"), h("button", { title: T("del"), onclick: () => { rows.splice(i, 1); markDirty(); renderRows(); } }, "✕")]));
      }));
    };
    const loadBtn = h("button", { class: "primary", onclick: async () => {
      const w = toWire();
      if (!w.items.length) return show(T("badLog", { e: "—" }));
      const badFix = rows.find((r) => r.fixText && r.fixText.trim() && fixToUnix(r.fixText) === null);
      if (badFix) return show(T("badFix", { v: badFix.fixText }));
      if (w.items.some((x) => !x.file || x.durationMs <= 0)) return show(T("badLog", { e: `${T("colFile")} / ${T("colDur")}` }));
      if (await call("load", { log: JSON.stringify(w) })) { dirty = false; dirtyEl.textContent = ""; show(T("loaded"), true); poll(); }
    } }, T("load"));
    const jsonArea = h("textarea", { spellcheck: "false" });
    const jsonBox = h("div", { style: "display:none;margin-top:6px" }, jsonArea,
      h("button", { onclick: () => { try { fromWire(JSON.parse(jsonArea.value)); logIdInput.value = logId; markDirty(); renderRows(); jsonBox.style.display = "none"; } catch (e) { show(T("badLog", { e: e.message })); } } }, T("apply")));
    const logSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("log")),
      h("div", { class: "body" },
        h("div", { class: "bar" }, h("label", {}, T("logId"), logIdInput), h("button", { onclick: () => { rows.push(blankItem()); markDirty(); renderRows(); } }, T("add")),
          loadBtn, h("button", { onclick: () => { jsonArea.value = JSON.stringify(toWire(), null, 2); jsonBox.style.display = ""; } }, T("export")),
          h("button", { onclick: () => { jsonArea.value = ""; jsonBox.style.display = ""; } }, T("import")), dirtyEl),
        h("table", {}, h("thead", {}, h("tr", {}, ...["colId", "colKind", "colFile", "colDur", "colIntro", "colOutro", "colSom", "colGain", "colFix", "colOpt"].map((k) => h("th", {}, T(k))), h("th"))), tbody),
        jsonBox, h("p", { class: "hint" }, T("hint"))));

    // ---- Ablauf (Zeitleiste) ----
    const tl = h("div", { class: "tl" });
    const timeEl = h("span", { class: "muted" });
    const startInput = h("input", { type: "number", min: "1", value: "5", style: "width:70px" });
    const atInput = h("input", { type: "text", placeholder: "HH:MM:SS", style: "width:90px;display:none" });
    const modeSel = h("select", { onchange: () => { startMode = modeSel.value; startInput.style.display = startMode === "in" ? "" : "none"; atInput.style.display = startMode === "at" ? "" : "none"; } },
      h("option", { value: "in" }, T("startIn", { n: "…" })), h("option", { value: "at" }, T("startAt")));
    const startBtn = h("button", { class: "primary", onclick: async () => {
      if (dirty) return show(T("dirty"));
      let body;
      if (startMode === "in") body = { delayMs: Math.max(1, Number(startInput.value) || 5) * 1000 };
      else {
        const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(atInput.value.trim());
        if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return show(T("badTime"));
        const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
        if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
        body = { atUnixMs: d.getTime() };
      }
      if (await call("start", body)) { show(T("started"), true); poll(); }
    } }, T("startBtn"));
    const stopBtn = h("button", { class: "danger", onclick: async () => { if (await confirmDialog(T("stopAsk"), T("stopGo"))) { if (await call("stop", { fadeMs: 1000 })) { show(T("stopped"), true); poll(); } } } }, T("stop"));
    const planSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("plan")),
      h("div", { class: "body" }, h("div", { class: "bar" }, modeSel, startInput, atInput, startBtn, stopBtn, timeEl), tl));
    const renderPlan = () => {
      const its = view.items || [];
      if (!its.length) { tl.replaceChildren(h("p", { class: "muted" }, T("noPlan"))); return; }
      const total = Math.max(...its.map((i) => i.endMs), 1);
      const running = view.startUnixMs > 0;
      const el = running ? view.nowUnixMs - view.startUnixMs : null;
      const pct = (ms) => `${(ms / total) * 100}%`;
      const rowsEl = its.map((i) => {
        const cur = el !== null && el >= i.startMs && el < i.endMs;
        const state = el === null ? "" : el >= i.endMs ? T("done") : cur ? T("playing") : i.sent ? T("sent") : T("waiting");
        const kind = i.kind || "song";
        const fade = i.fadeOutMs ? h("div", { class: "tlfade", style: `left:${pct(i.nextStartMs)};width:${(i.fadeOutMs / total) * 100}%` }) : null;
        return h("div", { class: "tlrow" }, h("div", { class: `tlbar ${kind}${i.sent ? " sent" : ""}${cur ? " cur" : ""}`, style: `left:${pct(i.startMs)};width:${Math.max(((i.endMs - i.startMs) / total) * 100, 0.5)}%`, title: `${i.id} · ${fmtMs(i.startMs)}–${fmtMs(i.endMs)} ${state}` }, `${i.id} ${state}`), fade);
      });
      const now = el !== null && el >= 0 && el <= total ? h("div", { class: "tlnow", style: `left:${pct(el)}` }) : null;
      const first = running ? new Date(view.startUnixMs).toLocaleTimeString(LOCALE) : "";
      timeEl.textContent = running ? `${T("start")} ${first} · ${T("elapsed")} ${el !== null ? fmtMs(Math.max(0, el)) : ""} / ${fmtMs(total)}` : `${fmtMs(total)}`;
      tl.replaceChildren(...rowsEl, now);
    };

    // ---- As-Run ----
    const asRunEl = h("div");
    const asRunSec = h("details", { class: "sec" }, h("summary", {}, T("asRun")), h("div", { class: "body" }, asRunEl));
    const renderAsRun = () => {
      if (!asRun.length) { asRunEl.replaceChildren(h("span", { class: "muted" }, T("noAsRun"))); return; }
      asRunEl.replaceChildren(...asRun.slice().reverse().slice(0, 100).map((e) => {
        if (e.event === "backtiming") return h("div", { class: "ev" }, `${T("evBack")}: ${e.text}`);
        if (e.event === "backtiming-result") return h("div", { class: "ev" }, T("evBackRes", { ms: e.residualMs }));
        return h("div", { class: "ev" }, e.event === "stop" ? T("evStop") : `${T("evSched")} #${e.index + 1} ${e.id}`, e.leadMs !== undefined ? ` — ${T("lead", { s: (e.leadMs / 1000).toFixed(1) })}` : "");
      }));
    };

    shadow.append(h("style", {}, STYLE), banner, head, logSec, planSec, asRunSec);
    renderRows(); renderPlan(); renderAsRun();

    const loadTargets = async () => {
      try {
        const r = await fetch("/api/v1/nodes"); if (!r.ok) return;
        const j = await r.json();
        targets = (Array.isArray(j) ? j : j.nodes || []).filter((n) => n.id !== nodeId).map((n) => n.label).sort();
      } catch { /* Liste bleibt */ }
    };
    const fillTargets = () => {
      const opts = ["", ...new Set([...targets, ...(target && !targets.includes(target) ? [target] : [])])];
      if (targetSel.options.length === opts.length && [...targetSel.options].every((o, i) => o.value === opts[i])) { targetSel.value = target; return; }
      targetSel.replaceChildren(...opts.map((v) => h("option", { value: v }, v || T("noTarget"))));
      targetSel.value = target;
    };
    const poll = async () => {
      try {
        const [v, a, e, t, la, lg] = await Promise.all(["view", "asRun", "lastError", "target", "lookaheadMs", "log"].map(getParam));
        if (v !== undefined) view = JSON.parse(v);
        if (a) asRun = JSON.parse(a);
        lastError = e || "";
        target = t || "";
        if (document.activeElement !== lookInput && la) lookInput.value = String(la / 1000);
        if (!initialised) {
          initialised = true;
          if (lg) { try { fromWire(JSON.parse(lg)); logIdInput.value = logId; renderRows(); } catch { /* leer */ } }
          else logIdInput.value = logId;
        }
        stateChip.textContent = T("st." + view.state); stateChip.className = `chip ${view.state}`;
        const running = view.state === "running";
        startBtn.disabled = running || view.state === "empty" || dirty; stopBtn.disabled = !running; loadBtn.disabled = running;
        if (lastError) { banner.textContent = lastError; banner.className = "banner show"; }
        else if (banner.className === "banner show") banner.className = "banner";
        fillTargets(); renderPlan(); renderAsRun();
      } catch { /* nächster Takt */ }
    };
    loadTargets().then(poll);
    this._i1 = setInterval(poll, 1000);
    this._i2 = setInterval(loadTargets, 15000);
  }
  disconnectedCallback() { clearInterval(this._i1); clearInterval(this._i2); }
}
if (!customElements.get("omp-radio-automation-panel")) customElements.define("omp-radio-automation-panel", OmpRadioAutomationPanel);
