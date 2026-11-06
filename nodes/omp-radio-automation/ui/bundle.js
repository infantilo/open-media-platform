// Bedienfeld der Radio-Automation (Kapitel 89/RB4): Ziel wählen, Log bearbeiten und laden, Übergänge als Zeitleiste sehen, starten/stoppen.
// Gleiche generische Node-Proxy-API wie alle Bundles: /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>.
// Eigenes Mini-t() (Node-Bundles können keine Shell-Module importieren); Sprache aus <html lang>.
const T = (() => {
  const D = {
    de: {
      addSpot: "+ Spot (Werbeblock)", target: "Segue-Player (Ziel)", noTarget: "— kein Ziel —", lookahead: "Vorlauf (s)", state: "Zustand",
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
      colTitle: "Titel", colBlock: "Block", colTime: "Zeit", drag: "ziehen zum Sortieren", dup: "Duplizieren", insertAbove: "Element davor einfügen",
      blockTarget: "Soll (s)", blockSum: "Summe", blockDiff: "Differenz", blockOver: "zu lang", blockUnder: "zu kurz", blockOk: "passt", blockFill: "Füller anhängen", noFiller: "Kein Füller passt (Füller im JSON unter „fillers“)",
      now: "Jetzt", next: "Nächstes", remain: "Rest", nothing: "—", notRunning: "Kein Log läuft.",
      hot: "Hotkeys", hotEdit: "Bearbeiten", hotDone: "Fertig", hotAdd: "+ Taste", hotSave: "Speichern", hotDel: "Taste löschen", hotLabel: "Beschriftung", hotColor: "Farbe", hotFile: "Datei", hotDur: "Dauer (ms)", hotGain: "Pegel (dB)", hotEmpty: "Keine Tasten. „Bearbeiten“ → „+ Taste“.", hotNoTarget: "Erst oben einen Segue-Player als Ziel wählen.", hotSaved: "Hotkeys gespeichert.",
      "col.red": "Rot", "col.green": "Grün", "col.blue": "Blau", "col.orange": "Orange", "col.purple": "Violett", "col.teal": "Türkis", "col.grey": "Grau",
      show: "Sendung", showNone: "— keine Sendung geöffnet —", showOpen: "Öffnen", showNew: "Neue Sendung", showFromTpl: "Aus Vorlage", showSave: "Speichern", showSaveTpl: "Als Vorlage speichern",
      showTitle: "Titel", showStart: "Beginn", showEnd: "Ende", showPres: "Moderation (Benutzernamen, Komma)", showDesc: "Beschreibung", showTpl: "Vorlage", showStatus: "Status",
      "ss.draft": "in Vorbereitung", "ss.ready": "freigegeben", "ss.live": "auf Sendung", "ss.done": "gesendet", "ss.archived": "abgelegt",
      showRelease: "Freigeben", showUnrelease: "Zurück in Vorbereitung", showGoLive: "Auf Sendung laden", showFinish: "Sendung abschließen", showArchive: "Ablegen", showDelete: "Löschen",
      showDeleteAsk: "Sendung „{t}“ mit allen Versionen löschen?", showDeleteGo: "Löschen", showSaved: "Sendung gespeichert (Version {v}).", showCreated: "Sendung angelegt.", showLoaded: "Sendung geladen: Log, Hotkeys und Karten.",
      showConflict: "Die Sendung wurde inzwischen von jemand anderem geändert. Neu öffnen (eigene Änderungen gehen verloren) oder als Kopie speichern.", showReason: "Vermerk zur Version (optional)",
      showVersions: "Verlauf", showRestore: "Wiederherstellen", showUnsaved: "Sendung hat ungespeicherte Änderungen", showNeedTarget: "Erst oben einen Segue-Player als Ziel wählen.", showNotReady: "Nur freigegebene Sendungen werden auf Sendung geladen.",
      showTplName: "Name der neuen Sendung", showPick: "Sendung wählen …",
      cards: "Moderationskarten", cardAdd: "+ Karte", cardTitle: "Überschrift", cardText: "Text", cardAt: "Bei Element", cardAtStart: "Sendungsbeginn", cardMin: "Min.", cardEmpty: "Keine Karten. „+ Karte“ legt eine an; sie erscheint während des gewählten Elements unter „Jetzt“.",
      notes: "Notizen zur Sendung", cardNow: "Moderation", cardNext: "Als Nächstes",
      hint: "Eine harte Marke (Uhrzeit) lässt das Element zu dieser Zeit einsetzen: beim Start werden Füller weggelassen/eingefügt und Segue-Punkte verschoben (Entscheidungen im As-Run). Der Segue-Punkt ist die Stelle in der Datei, ab der der Nachfolger starten darf; ohne Angabe 3 s vor Dateiende. Der Log wird erst mit „Log laden“ übernommen.",
    },
    en: {
      addSpot: "+ Spot (ad block)", target: "Segue player (target)", noTarget: "— no target —", lookahead: "Lead time (s)", state: "State",
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
      colTitle: "Title", colBlock: "Block", colTime: "Time", drag: "drag to reorder", dup: "Duplicate", insertAbove: "Insert item above",
      blockTarget: "Target (s)", blockSum: "Total", blockDiff: "Difference", blockOver: "too long", blockUnder: "too short", blockOk: "fits", blockFill: "Append filler", noFiller: "No filler fits (fillers in the JSON under “fillers”)",
      now: "Now", next: "Next", remain: "Remaining", nothing: "—", notRunning: "No log running.",
      hot: "Hotkeys", hotEdit: "Edit", hotDone: "Done", hotAdd: "+ Key", hotSave: "Save", hotDel: "Delete key", hotLabel: "Label", hotColor: "Colour", hotFile: "File", hotDur: "Duration (ms)", hotGain: "Level (dB)", hotEmpty: "No keys. “Edit” → “+ Key”.", hotNoTarget: "Choose a segue player as target above first.", hotSaved: "Hotkeys saved.",
      "col.red": "Red", "col.green": "Green", "col.blue": "Blue", "col.orange": "Orange", "col.purple": "Purple", "col.teal": "Teal", "col.grey": "Grey",
      show: "Show", showNone: "— no show open —", showOpen: "Open", showNew: "New show", showFromTpl: "From template", showSave: "Save", showSaveTpl: "Save as template",
      showTitle: "Title", showStart: "Start", showEnd: "End", showPres: "Presenters (usernames, comma)", showDesc: "Description", showTpl: "Template", showStatus: "Status",
      "ss.draft": "in preparation", "ss.ready": "released", "ss.live": "on air", "ss.done": "aired", "ss.archived": "archived",
      showRelease: "Release", showUnrelease: "Back to preparation", showGoLive: "Load on air", showFinish: "Finish show", showArchive: "Archive", showDelete: "Delete",
      showDeleteAsk: "Delete show “{t}” with all versions?", showDeleteGo: "Delete", showSaved: "Show saved (version {v}).", showCreated: "Show created.", showLoaded: "Show loaded: log, hotkeys and cards.",
      showConflict: "The show has been changed by someone else in the meantime. Reopen (your changes are lost) or save as a copy.", showReason: "Version note (optional)",
      showVersions: "History", showRestore: "Restore", showUnsaved: "The show has unsaved changes", showNeedTarget: "Choose a segue player as target above first.", showNotReady: "Only released shows can be loaded on air.",
      showTplName: "Name of the new show", showPick: "Choose a show …",
      cards: "Presenter cards", cardAdd: "+ Card", cardTitle: "Heading", cardText: "Text", cardAt: "At item", cardAtStart: "Start of show", cardMin: "Min.", cardEmpty: "No cards. “+ Card” adds one; it appears under “Now” while the chosen item plays.",
      notes: "Show notes", cardNow: "Presenter", cardNext: "Next up",
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
  tr.blockhead td { background: #3a2f1c; font-weight: 600; padding: 4px 6px; } tr.blockhead input { width: 70px; }
  tr.dragover td { border-top: 2px solid var(--acc); } td.handle { cursor: grab; color: var(--mut); user-select: none; } tr.cur td { background: #1f3a24; } tr.done td { opacity: .55; }
  .ok { color: var(--ok); } .bad { color: var(--err); } .nowbar { display: flex; gap: 18px; align-items: center; padding: 8px 10px; background: var(--bg2); border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; }
  .nowbar .big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; } .nowbar .grow { flex: 1; min-width: 0; } .nowbar .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nowprog { height: 5px; background: var(--bg3); border-radius: 3px; margin-top: 4px; } .nowprog > div { height: 100%; background: var(--acc); border-radius: 3px; }
  .showbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; } .showbar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); } .showmeta { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin-top: 8px; }
  .sstat { padding: 2px 10px; border-radius: 10px; background: var(--bg3); font-weight: 600; } .sstat.ready { background: #2a5a8f; } .sstat.live { background: var(--ok); color: #fff; } .sstat.done, .sstat.archived { color: var(--mut); }
  .card { border: 1px solid var(--bd); border-radius: 5px; padding: 6px; margin-bottom: 6px; display: grid; grid-template-columns: 1fr 180px 70px auto; gap: 6px; align-items: start; } .card textarea { grid-column: 1 / -1; min-height: 70px; font-family: inherit; }
  .cardlive { background: var(--bg2); border: 1px solid var(--acc); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; display: none; } .cardlive.show { display: block; } .cardlive h4 { margin: 0 0 4px; } .cardlive .tx { white-space: pre-wrap; font-size: 15px; line-height: 1.45; }
  .hk { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
  .hkkey { position: relative; min-height: 58px; padding: 6px 8px; border-radius: 5px; border: 1px solid rgba(255,255,255,.2); color: #fff; text-align: left; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; }
  .hkkey .nm { font-weight: 700; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.6); } .hkkey .tm { font-variant-numeric: tabular-nums; font-size: 11px; opacity: .9; }
  .hkkey .pr { position: absolute; left: 0; bottom: 0; height: 4px; background: #fff; opacity: .85; } .hkkey.playing { box-shadow: 0 0 0 2px #fff; }
  .hkkey.c-red { background: #b03030; } .hkkey.c-green { background: #2f8a3e; } .hkkey.c-blue { background: #2f5fb0; } .hkkey.c-orange { background: #c7731d; } .hkkey.c-purple { background: #7a3fa0; } .hkkey.c-teal { background: #1f8a86; } .hkkey.c-grey { background: #55555c; }
  .hked { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; align-items: end; padding: 6px; border: 1px solid var(--bd); border-radius: 5px; margin-bottom: 6px; } .hked label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
`;

const fmtMs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const blankItem = () => ({ id: "", kind: "song", file: "", durationMs: 180000, somMs: 0, introMs: null, outroMs: null, gainDb: 0, optional: false, fixText: "", title: "", block: "" });
const fixToUnix = (text) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim()); if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null; const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); };
const unixToFix = (ms) => (ms ? new Date(ms).toLocaleTimeString("de-DE") : "");

class OmpRadioAutomationPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    let rows = [];
    let logId = "log1";
    let fillers = [];
    let blockTargets = {};
    let cartsEdit = null; // null = Anzeige folgt dem Node; sonst lokale Bearbeitung
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
        title: r.title && r.title.trim() ? r.title.trim() : null, block: r.block && r.block.trim() ? r.block.trim() : null,
      })),
      fillers,
      blocks: Object.entries(blockTargets).filter(([n]) => rows.some((r) => (r.block || "").trim() === n)).map(([name, targetMs]) => ({ name, targetMs })),
    });
    const fromWire = (l) => { logId = l.logId || "log"; fillers = l.fillers || []; blockTargets = Object.fromEntries((l.blocks || []).map((b) => [b.name, b.targetMs])); rows = (l.items || []).map((i) => ({ ...blankItem(), ...i, introMs: i.introMs ?? null, outroMs: i.outroMs ?? null, fixText: unixToFix(i.fixAtUnixMs), title: i.title || "", block: i.block || "" })); };

    // ---- Kopf ----
    const stateChip = h("span", { class: "chip" });
    const targetSel = h("select", { onchange: () => setParam("target", targetSel.value) });
    const lookInput = h("input", { type: "number", min: "2", max: "300", style: "width:70px", onchange: () => setParam("lookaheadMs", Math.round(Number(lookInput.value) * 1000)).then((r) => { if (!r.ok) show(T("fail", { m: "lookahead", d: r.status })); }) });
    const head = h("div", { class: "bar" }, h("label", {}, T("state"), stateChip), h("label", {}, T("target"), targetSel), h("label", {}, T("lookahead"), lookInput));

    // ---- Log-Editor ----
    const logIdInput = h("input", { style: "width:160px", oninput: () => { logId = logIdInput.value; markDirty(); } });
    const dirtyEl = h("span", { class: "dirty" });
    const markDirty = () => { dirty = true; dirtyEl.textContent = T("dirty"); if (typeof markShow === "function") markShow(); };
    const tbody = h("tbody");
    const cell = (cls, el) => h("td", { class: cls }, el);
    let timeCells = [];
    let dragFrom = null;
    const blockSum = (name) => rows.filter((r) => (r.block || "").trim() === name).reduce((a, r) => a + (Number(r.durationMs) || 0), 0);
    const renderRows = () => {
      timeCells = [];
      const out = [];
      rows.forEach((r, i) => {
        const bn = (r.block || "").trim();
        const prevBn = i > 0 ? (rows[i - 1].block || "").trim() : "";
        if (bn && bn !== prevBn) out.push(blockHead(bn, i));
        const inp = (key, type) => h("input", { type, value: r[key] ?? "", oninput: (e) => { r[key] = type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value; markDirty(); }, onchange: () => { if (key === "block" || key === "durationMs") renderRows(); } });
        const kind = h("select", { onchange: (e) => { r.kind = e.target.value; markDirty(); } }, ...["song", "jingle", "speech"].map((k) => h("option", { value: k }, T("kind." + k))));
        kind.value = r.kind;
        const timeCell = h("td", { class: "muted" }); timeCells.push([i, timeCell]);
        const tr = h("tr", { draggable: "true",
          ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); },
          ondragover: (e) => { if (dragFrom === null) return; e.preventDefault(); tr.classList.add("dragover"); },
          ondragleave: () => tr.classList.remove("dragover"),
          ondrop: (e) => { e.preventDefault(); tr.classList.remove("dragover"); if (dragFrom === null || dragFrom === i) { dragFrom = null; return; } const [m] = rows.splice(dragFrom, 1); rows.splice(i, 0, m); dragFrom = null; markDirty(); renderRows(); },
          ondragend: () => { dragFrom = null; } },
          h("td", { class: "handle", title: T("drag") }, "⠿"), h("td", { class: "muted" }, i + 1), cell("", inp("id", "text")), cell("", inp("title", "text")), cell("", kind), cell("", inp("block", "text")), cell("file", inp("file", "text")), cell("num", inp("durationMs", "number")), cell("num", inp("introMs", "number")), cell("num", inp("outroMs", "number")), cell("num", inp("somMs", "number")), cell("num", inp("gainDb", "number")), cell("", inp("fixText", "text")),
          cell("", h("input", { type: "checkbox", style: "width:auto", checked: !!r.optional, onchange: (e) => { r.optional = e.target.checked; markDirty(); } })),
          timeCell,
          cell("act", [h("button", { title: T("insertAbove"), onclick: () => { const n = blankItem(); n.block = r.block; rows.splice(i, 0, n); markDirty(); renderRows(); } }, "＋"), h("button", { title: T("dup"), onclick: () => { rows.splice(i + 1, 0, { ...r, id: r.id ? r.id + "-2" : "" }); markDirty(); renderRows(); } }, "⧉"), h("button", { title: T("del"), onclick: () => { rows.splice(i, 1); markDirty(); renderRows(); } }, "✕")]));
        out.push(tr);
      });
      tbody.replaceChildren(...out);
      updateTimes();
    };
    // Blockkopf: Summe gegen Soll-Länge, Füller-Vorschlag
    const blockHead = (name, startIdx) => {
      const sum = blockSum(name);
      const target = blockTargets[name];
      const diff = target ? sum - target : null;
      const verdict = diff === null ? "" : Math.abs(diff) <= 500 ? T("blockOk") : diff > 0 ? T("blockOver") : T("blockUnder");
      const tin = h("input", { type: "number", min: "0", value: target ? target / 1000 : "", onchange: (e) => { const v = Number(e.target.value); if (v > 0) blockTargets[name] = Math.round(v * 1000); else delete blockTargets[name]; markDirty(); renderRows(); } });
      const fillBtn = h("button", { onclick: () => {
        const gap = (target || 0) - sum;
        const fit = fillers.filter((f) => f.durationMs <= gap).sort((a, b) => b.durationMs - a.durationMs)[0];
        if (!fit) return show(T("noFiller"));
        let last = startIdx; while (last + 1 < rows.length && (rows[last + 1].block || "").trim() === name) last++;
        rows.splice(last + 1, 0, { ...blankItem(), ...fit, block: name, introMs: fit.introMs ?? null, outroMs: fit.outroMs ?? null, fixText: "" }); markDirty(); renderRows();
      } }, T("blockFill"));
      return h("tr", { class: "blockhead" }, h("td", { colspan: "16" }, `▣ ${name}   ·   ${T("blockSum")} ${fmtMs(sum)}   ·   ${T("blockTarget")} `, tin,
        target ? h("span", { class: diff !== null && Math.abs(diff) <= 500 ? "ok" : "bad" }, `   ${T("blockDiff")} ${diff > 0 ? "+" : ""}${(diff / 1000).toFixed(1)} s ${verdict}   `) : null, target && diff < -500 ? fillBtn : null));
    };
    // Zeitspalte: geplanter Beginn je Zeile (nur wenn der geladene Log zur Tabelle passt), laufende/vergangene Zeilen markiert
    const updateTimes = () => {
      const its = view.items || [];
      const valid = !dirty && its.length === rows.length;
      const trs = [...tbody.querySelectorAll("tr:not(.blockhead)")];
      for (const [i, td] of timeCells) {
        const it = valid ? its[i] : null;
        if (!it) { td.textContent = ""; trs[i]?.classList.remove("cur", "done"); continue; }
        const running = view.startUnixMs > 0;
        td.textContent = running ? new Date(view.startUnixMs + it.startMs).toLocaleTimeString(LOCALE) : `+${fmtMs(it.startMs)}`;
        const el = running ? view.nowUnixMs - view.startUnixMs : null;
        trs[i]?.classList.toggle("cur", el !== null && el >= it.startMs && el < it.endMs);
        trs[i]?.classList.toggle("done", el !== null && el >= it.endMs);
      }
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
        h("div", { class: "bar" }, h("label", {}, T("logId"), logIdInput), h("button", { onclick: () => { rows.push(blankItem()); markDirty(); renderRows(); } }, T("add")), h("button", { onclick: () => { const n = blankItem(); n.kind = "jingle"; n.block = "Werbeblock"; n.durationMs = 30000; rows.push(n); markDirty(); renderRows(); } }, T("addSpot")),
          loadBtn, h("button", { onclick: () => { jsonArea.value = JSON.stringify(toWire(), null, 2); jsonBox.style.display = ""; } }, T("export")),
          h("button", { onclick: () => { jsonArea.value = ""; jsonBox.style.display = ""; } }, T("import")), dirtyEl),
        h("table", {}, h("thead", {}, h("tr", {}, h("th"), h("th", {}, "#"), ...["colId", "colTitle", "colKind", "colBlock", "colFile", "colDur", "colIntro", "colOutro", "colSom", "colGain", "colFix", "colOpt", "colTime"].map((k) => h("th", {}, T(k))), h("th"))), tbody),
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

    // ---- Sendung (Vorbereitung und Live) ----
    // Das Sendungsdokument fasst Log, Hotkeys, Karten und Notizen zusammen; es wird auf dem Server gespeichert (Modul „radio“) und zur
    // Sendezeit mit „Auf Sendung laden“ in die Automation übernommen. Bis dahin ist es reine Vorbereitung.
    let curShow = null, shows = [], templates = [], showDirty = false, showCarts = [], cards = [], notesText = "", versions = [];
    const API = "/api/v1/radio/shows";
    const api = async (method, path, body) => {
      const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch { /* leer */ }
      if (!r.ok) { const e = new Error((j && (j.error || (j.problems || []).join("; "))) || r.status); e.status = r.status; e.code = j && j.code; show_err(e); return null; }
      return j === null ? {} : j;
    };
    const show_err = (e) => { if (e.code === "revision_conflict") showMsg(T("showConflict")); else showMsg(T("fail", { m: "Sendung", d: e.message })); };
    const showMsg = (t) => show_(t);
    const show_ = (t, note) => { banner.textContent = t; banner.className = `banner show${note ? " note" : ""}`; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 8000); };
    const isoToLocal = (iso) => { if (!iso) return ""; const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
    const localToIso = (v) => (v ? new Date(v).toISOString() : null);
    const fmtSlot = (sh) => (sh.slotStart ? new Date(sh.slotStart).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" }) : "—");

    const showSel = h("select", { style: "min-width:240px" });
    const tplSel = h("select");
    const refreshShows = async () => {
      const l = await api("GET", API); if (!l) return;
      shows = l.filter((x) => !x.template && x.status !== "archived"); templates = l.filter((x) => x.template);
      showSel.replaceChildren(h("option", { value: "" }, T("showPick")), ...shows.map((x) => h("option", { value: x.id }, `${fmtSlot(x)} · ${x.title} · ${T("ss." + x.status)}`)));
      tplSel.replaceChildren(h("option", { value: "" }, T("showFromTpl")), ...templates.map((x) => h("option", { value: x.id }, x.title)));
      if (curShow) showSel.value = curShow.id;
    };
    const f_title = h("input", { type: "text", oninput: () => markShow() }), f_desc = h("input", { type: "text", oninput: () => markShow() }), f_pres = h("input", { type: "text", oninput: () => markShow() });
    const f_start = h("input", { type: "datetime-local", onchange: () => markShow() }), f_end = h("input", { type: "datetime-local", onchange: () => markShow() });
    const f_tpl = h("input", { type: "checkbox", style: "width:auto", onchange: () => markShow() });
    const f_reason = h("input", { type: "text", placeholder: T("showReason"), style: "width:220px" });
    const statChip = h("span", { class: "sstat" }), unsavedEl = h("span", { class: "dirty" });
    const markShow = () => { if (!curShow) return; showDirty = true; unsavedEl.textContent = T("showUnsaved"); };
    const clearShowDirty = () => { showDirty = false; unsavedEl.textContent = ""; };
    const verSel = h("select");
    const docFromState = () => ({ log: toWire(), carts: showCarts, cards, notes: notesText.trim() ? [{ id: "n1", text: notesText }] : [] });
    const applyDoc = (c) => {
      const doc = c || {};
      if (doc.log && doc.log.items) fromWire(doc.log); else { rows = []; fillers = []; blockTargets = {}; }
      logIdInput.value = logId; showCarts = (doc.carts || []).map((x) => ({ ...x })); cards = (doc.cards || []).map((x) => ({ ...x }));
      notesText = (doc.notes && doc.notes[0] && doc.notes[0].text) || ""; notesArea.value = notesText;
      renderRows(); renderCards(); renderShowBar(); cartsEdit = null; hkEditBtn.textContent = T("hotEdit"); renderCarts();
    };
    const renderShowBar = () => {
      const open = !!curShow;
      f_title.value = curShow ? curShow.title : ""; f_desc.value = curShow ? curShow.description || "" : ""; f_pres.value = curShow ? (curShow.presenters || []).join(", ") : "";
      f_start.value = curShow ? isoToLocal(curShow.slotStart) : ""; f_end.value = curShow ? isoToLocal(curShow.slotEnd) : ""; f_tpl.checked = curShow ? !!curShow.template : false;
      statChip.textContent = curShow ? (curShow.template ? T("showTpl") : T("ss." + curShow.status)) : T("showNone"); statChip.className = `sstat ${curShow ? curShow.status : ""}`;
      const st = curShow ? curShow.status : "";
      const editable = open && (st === "draft" || st === "ready");
      for (const el of [f_title, f_desc, f_pres, f_start, f_end, f_tpl, f_reason]) el.disabled = !editable;
      saveBtn.disabled = !editable; saveTplBtn.disabled = !open;
      relBtn.style.display = open && !curShow.template && st === "draft" ? "" : "none";
      unrelBtn.style.display = open && !curShow.template && st === "ready" ? "" : "none";
      liveBtn.style.display = open && !curShow.template && (st === "ready" || st === "live") ? "" : "none";
      finBtn.style.display = open && st === "live" ? "" : "none";
      archBtn.style.display = open && !curShow.template && (st === "draft" || st === "done" || st === "ready") ? "" : "none";
      delBtn.style.display = open && st !== "live" ? "" : "none";
      verBox.style.display = open ? "" : "none";
    };
    const loadVersions = async () => { if (!curShow) return; const v = await api("GET", `${API}/${curShow.id}/versions`); if (!v) return; versions = v;
      verSel.replaceChildren(...v.map((x) => h("option", { value: x.version }, `v${x.version} · ${new Date(x.createdAt).toLocaleString(LOCALE)} · ${x.createdBy}${x.reason ? " · " + x.reason : ""}`))); };
    const openShow = async (id) => {
      if (!id) { curShow = null; applyDoc(null); clearShowDirty(); return; }
      const sh = await api("GET", `${API}/${id}`); if (!sh) return;
      curShow = sh; applyDoc(sh.content); if (sh.status !== "live") markDirty(); else { dirty = false; dirtyEl.textContent = ""; } clearShowDirty(); await loadVersions(); renderShowBar();
    };
    const needSaved = async () => { if (showDirty) { show_(T("showUnsaved")); return false; } return true; };
    const saveShow = async (reason) => {
      if (!curShow) return false;
      const bad = rows.find((r) => r.fixText && r.fixText.trim() && fixToUnix(r.fixText) === null); if (bad) { show_(T("badFix", { v: bad.fixText })); return false; }
      const body = { title: f_title.value.trim(), description: f_desc.value, template: f_tpl.checked, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value),
        presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean), tags: curShow.tags || [], content: docFromState(), rowVersion: curShow.rowVersion, reason: reason ?? f_reason.value };
      const r = await api("PUT", `${API}/${curShow.id}`, body); if (!r) return false;
      curShow = r; clearShowDirty(); f_reason.value = ""; show_(T("showSaved", { v: r.rowVersion }), true); await refreshShows(); await loadVersions(); renderShowBar(); return true;
    };
    const saveBtn = h("button", { class: "primary", onclick: () => saveShow() }, T("showSave"));
    const newBtn = h("button", { onclick: async () => {
      const t = f_title.value.trim() || "Neue Sendung";
      const r = await api("POST", API, { title: t, description: f_desc.value, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value), presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean), content: docFromState(), template: false }); if (!r) return;
      curShow = r; clearShowDirty(); show_(T("showCreated"), true); await refreshShows(); showSel.value = r.id; await loadVersions(); renderShowBar();
    } }, T("showNew"));
    const saveTplBtn = h("button", { onclick: async () => {
      if (!curShow) return; const name = f_title.value.trim() || curShow.title;
      const r = await api("POST", API, { title: name + " (Vorlage)", template: true, presenters: [], content: docFromState() }); if (!r) return;
      show_(T("showCreated"), true); await refreshShows();
    } }, T("showSaveTpl"));
    const relBtn = h("button", { onclick: async () => { if (!(await needSaved())) return; const r = await api("POST", `${API}/${curShow.id}/status`, { status: "ready" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showRelease"));
    const unrelBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "draft" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showUnrelease"));
    const finBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "done" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showFinish"));
    const archBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "archived" }); if (r) { curShow = null; applyDoc(null); await refreshShows(); renderShowBar(); } } }, T("showArchive"));
    const delBtn = h("button", { class: "danger", onclick: async () => { if (!curShow || !(await confirmDialog(T("showDeleteAsk", { t: curShow.title }), T("showDeleteGo")))) return; const r = await api("DELETE", `${API}/${curShow.id}`); if (r) { curShow = null; applyDoc(null); clearShowDirty(); await refreshShows(); renderShowBar(); } } }, T("showDelete"));
    // Auf Sendung laden: Log und Hotkeys der freigegebenen Sendung gehen in die Automation, die Sendung wird „live“
    const liveBtn = h("button", { class: "primary", onclick: async () => {
      if (!curShow || !(await needSaved())) return;
      if (curShow.status !== "ready" && curShow.status !== "live") return show_(T("showNotReady"));
      if (!target) return show_(T("showNeedTarget"));
      const w = toWire(); if (!w.items.length) return show_(T("badLog", { e: "—" }));
      if (!(await call("load", { log: JSON.stringify(w) }))) return;
      if (!(await call("setCarts", { carts: JSON.stringify(showCarts) }))) return;
      dirty = false; dirtyEl.textContent = "";
      if (curShow.status === "ready") { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "live" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); } }
      renderShowBar(); show_(T("showLoaded"), true); poll();
    } }, T("showGoLive"));
    const restoreBtn = h("button", { onclick: async () => { if (!curShow || !verSel.value) return; const r = await api("POST", `${API}/${curShow.id}/versions/${verSel.value}/restore`); if (r) { curShow = r; applyDoc(r.content); markDirty(); clearShowDirty(); await loadVersions(); renderShowBar(); } } }, T("showRestore"));
    const verBox = h("span", { class: "bar", style: "margin:0" }, h("label", {}, T("showVersions"), verSel), restoreBtn);
    showSel.onchange = async () => { if (showDirty && !(await confirmDialog(T("showUnsaved") + " — " + T("showOpen") + "?", T("showOpen")))) { showSel.value = curShow ? curShow.id : ""; return; } await openShow(showSel.value); };
    tplSel.onchange = async () => {
      const id = tplSel.value; if (!id) return; tplSel.value = "";
      const title = f_title.value.trim() || "Neue Sendung";
      const r = await api("POST", `${API}/${id}/duplicate`, { title, template: false, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value), presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean) });
      if (!r) return; show_(T("showCreated"), true); await refreshShows(); showSel.value = r.id; await openShow(r.id);
    };
    const showSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("show")),
      h("div", { class: "body" }, h("div", { class: "showbar" }, h("label", {}, T("show"), showSel), tplSel, newBtn, statChip, unsavedEl),
        h("div", { class: "showmeta" }, h("label", {}, T("showTitle"), f_title), h("label", {}, T("showStart"), f_start), h("label", {}, T("showEnd"), f_end), h("label", {}, T("showPres"), f_pres), h("label", {}, T("showDesc"), f_desc), h("label", {}, T("showTpl"), f_tpl)),
        h("div", { class: "showbar", style: "margin-top:8px" }, f_reason, saveBtn, saveTplBtn, relBtn, unrelBtn, liveBtn, finBtn, archBtn, delBtn, verBox)));

    // ---- Moderationskarten und Notizen (je Sendung) ----
    const cardsEl = h("div");
    const notesArea = h("textarea", { style: "min-height:80px", oninput: () => { notesText = notesArea.value; markShow(); } });
    const renderCards = () => {
      if (!cards.length) { cardsEl.replaceChildren(h("span", { class: "muted" }, T("cardEmpty"))); return; }
      cardsEl.replaceChildren(...cards.map((c, i) => {
        const at = h("select", { onchange: (e) => { c.atItem = e.target.value; markShow(); } }, h("option", { value: "" }, T("cardAtStart")), ...rows.map((r, k) => h("option", { value: r.id || `e${k + 1}` }, (r.title && r.title.trim()) || r.id || `#${k + 1}`)));
        at.value = c.atItem || "";
        return h("div", { class: "card" },
          h("input", { type: "text", value: c.title || "", placeholder: T("cardTitle"), oninput: (e) => { c.title = e.target.value; markShow(); } }), at,
          h("input", { type: "number", min: "0", value: c.minutes ?? "", placeholder: T("cardMin"), oninput: (e) => { c.minutes = e.target.value === "" ? null : Number(e.target.value); markShow(); } }),
          h("span", {}, h("button", { onclick: () => { if (i > 0) { [cards[i - 1], cards[i]] = [cards[i], cards[i - 1]]; markShow(); renderCards(); } } }, "↑"), h("button", { onclick: () => { if (i < cards.length - 1) { [cards[i + 1], cards[i]] = [cards[i], cards[i + 1]]; markShow(); renderCards(); } } }, "↓"), h("button", { onclick: () => { cards.splice(i, 1); markShow(); renderCards(); } }, "✕")),
          h("textarea", { placeholder: T("cardText"), oninput: (e) => { c.text = e.target.value; markShow(); } }, c.text || ""));
      }));
    };
    const cardsSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("cards")),
      h("div", { class: "body" }, h("div", { class: "bar" }, h("button", { onclick: () => { cards.push({ id: "c" + Date.now().toString(36), title: "", text: "", atItem: "", minutes: null }); markShow(); renderCards(); } }, T("cardAdd"))), cardsEl,
        h("div", { class: "muted", style: "margin:8px 0 2px" }, T("notes")), notesArea));
    // Live: Karten zum laufenden bzw. nächsten Element, groß lesbar
    const cardLive = h("div", { class: "cardlive" });
    const renderCardLive = (curId, nextId, running) => {
      const pick = (id) => cards.filter((c) => (c.atItem || "") === (id || ""));
      const now = running && curId !== null ? pick(curId) : pick("");
      const nxt = running && nextId ? pick(nextId) : [];
      if (!now.length && !nxt.length) { cardLive.classList.remove("show"); return; }
      cardLive.classList.add("show");
      cardLive.replaceChildren(...now.flatMap((c) => [h("h4", {}, `${T("cardNow")}: ${c.title || ""}${c.minutes ? ` (${c.minutes} ${T("cardMin")})` : ""}`), h("div", { class: "tx" }, c.text || "")]),
        ...nxt.flatMap((c) => [h("h4", { class: "muted" }, `${T("cardNext")}: ${c.title || ""}`), h("div", { class: "tx muted" }, c.text || "")]));
    };

    // ---- Jetzt-Leiste ----
    const nowTitle = h("div", { class: "t big" }), nowSub = h("div", { class: "muted t" }), nowProg = h("div"), nowRemain = h("div", { class: "big" }), nextEl = h("div", { class: "t" }), clockEl = h("div", { class: "big" });
    const nowBar = h("div", { class: "nowbar" },
      h("div", { class: "grow" }, h("div", { class: "muted" }, T("now")), nowTitle, h("div", { class: "nowprog" }, nowProg), nowSub),
      h("div", {}, h("div", { class: "muted" }, T("remain")), nowRemain),
      h("div", { class: "grow" }, h("div", { class: "muted" }, T("next")), nextEl), clockEl);
    const nameOf = (i) => { const r = rows[i]; const it = (view.items || [])[i]; return (r && r.title && r.title.trim()) || (r && r.id) || (it && it.id) || ""; };
    const renderNow = () => {
      clockEl.textContent = new Date(view.nowUnixMs || Date.now()).toLocaleTimeString(LOCALE);
      const its = view.items || [];
      const el = view.startUnixMs > 0 ? view.nowUnixMs - view.startUnixMs : null;
      const idx = el === null ? -1 : its.findIndex((i) => el >= i.startMs && el < i.endMs);
      renderCardLive(idx >= 0 ? its[idx].id : null, idx >= 0 && its[idx + 1] ? its[idx + 1].id : (idx < 0 && its.length && el !== null ? (its.find((i) => i.startMs > el) || {}).id : null), el !== null);
      if (idx < 0) { nowTitle.textContent = T("nothing"); nowSub.textContent = T("notRunning"); nowProg.style.width = "0"; nowRemain.textContent = "0:00"; const upcoming = its.length && el !== null ? its.find((i) => i.startMs > el) : null; nextEl.textContent = upcoming ? upcoming.id : T("nothing"); return; }
      const it = its[idx];
      nowTitle.textContent = nameOf(idx) || it.id; nowSub.textContent = `${it.file || ""}`;
      nowProg.style.width = `${Math.min(100, ((el - it.startMs) / Math.max(1, it.endMs - it.startMs)) * 100)}%`;
      nowRemain.textContent = fmtMs(it.endMs - el);
      nextEl.textContent = its[idx + 1] ? (nameOf(idx + 1) || its[idx + 1].id) : T("nothing");
    };

    // ---- Hotkeys ----
    let hkSig = "", hkKeys = [];
    const COLORS = ["red", "green", "blue", "orange", "purple", "teal", "grey"];
    const hkGrid = h("div", { class: "hk" }), hkEdit = h("div");
    const hkEditBtn = h("button", { onclick: () => { if (cartsEdit) { cartsEdit = null; hkEditBtn.textContent = T("hotEdit"); } else { cartsEdit = (curShow ? showCarts : (view.carts || [])).map((c) => ({ label: c.label, color: c.color, file: c.file, durationMs: c.durationMs, gainDb: c.gainDb })); hkEditBtn.textContent = T("hotDone"); } renderCarts(); } }, T("hotEdit"));
    const hkAdd = h("button", { onclick: () => { if (!cartsEdit) return; cartsEdit.push({ label: "", color: COLORS[cartsEdit.length % COLORS.length], file: "", durationMs: 5000, gainDb: 0 }); renderCarts(); } }, T("hotAdd"));
    const hkSave = h("button", { class: "primary", onclick: async () => { if (cartsEdit && curShow) { showCarts = cartsEdit; cartsEdit = null; hkEditBtn.textContent = T("hotEdit"); markShow(); renderCarts(); show_(T("hotSaved") + " (" + T("showSave") + "!)", true); return; } if (cartsEdit && await call("setCarts", { carts: JSON.stringify(cartsEdit) })) { show(T("hotSaved"), true); cartsEdit = null; hkEditBtn.textContent = T("hotEdit"); await poll(); renderCarts(); } } }, T("hotSave"));
    const renderCarts = () => {
      hkAdd.style.display = hkSave.style.display = cartsEdit ? "" : "none";
      if (cartsEdit) {
        hkSig = "";
        hkEdit.replaceChildren(...cartsEdit.map((c, i) => {
          const f = (key, type, label) => h("label", {}, label, h("input", { type, value: c[key] ?? "", oninput: (e) => { c[key] = type === "number" ? Number(e.target.value) : e.target.value; } }));
          const col = h("select", { onchange: (e) => { c.color = e.target.value; } }, ...COLORS.map((k) => h("option", { value: k }, T("col." + k)))); col.value = c.color || "grey";
          return h("div", { class: "hked" }, f("label", "text", T("hotLabel")), h("label", {}, T("hotColor"), col), f("file", "text", T("hotFile")), f("durationMs", "number", T("hotDur")), f("gainDb", "number", T("hotGain")), h("button", { onclick: () => { cartsEdit.splice(i, 1); renderCarts(); } }, T("hotDel")));
        }));
        hkGrid.replaceChildren();
        return;
      }
      hkEdit.replaceChildren();
      const cs = view.carts || [];
      if (!cs.length) { hkGrid.replaceChildren(h("span", { class: "muted" }, T("hotEmpty"))); hkSig = ""; return; }
      // Tasten nur bei geänderter Belegung neu bauen; sonst an Ort und Stelle aktualisieren (ein Klick geht nicht durch Neuaufbau verloren)
      const sig = JSON.stringify(cs.map((c) => [c.label, c.color, c.durationMs]));
      if (sig !== hkSig) {
        hkSig = sig; hkKeys = [];
        hkGrid.replaceChildren(...cs.map((c) => {
          const nm = h("span", { class: "nm" }, c.label || `#${c.index + 1}`), tm = h("span", { class: "tm" }), pr = h("span", { class: "pr" });
          const btn = h("button", { class: `hkkey c-${COLORS.includes(c.color) ? c.color : "grey"}`, onclick: async () => {
            const cur = (view.carts || [])[c.index];
            if (!target) return show(T("hotNoTarget"));
            if (await call(cur && cur.playing ? "stopCart" : "fireCart", { index: c.index })) poll();
          } }, nm, tm, pr);
          hkKeys.push({ btn, tm, pr });
          return btn;
        }));
      }
      cs.forEach((c, i) => {
        const k = hkKeys[i]; if (!k) return;
        k.btn.classList.toggle("playing", !!c.playing);
        k.tm.textContent = c.playing ? fmtMs(Math.max(0, c.durationMs - c.elapsedMs)) : c.durationMs ? fmtMs(c.durationMs) : "";
        k.pr.style.width = c.playing && c.durationMs ? `${Math.min(100, (c.elapsedMs / c.durationMs) * 100)}%` : "0";
      });
    };
    const cartSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("hot")), h("div", { class: "body" }, h("div", { class: "bar" }, hkEditBtn, hkAdd, hkSave), hkEdit, hkGrid));

    shadow.append(h("style", {}, STYLE), banner, head, showSec, nowBar, cardLive, cartSec, cardsSec, logSec, planSec, asRunSec);
    renderRows(); renderPlan(); renderAsRun(); renderNow(); renderCarts(); renderCards(); renderShowBar(); refreshShows().then(async () => { const c = await api("GET", API + "/current"); if (c && c.show && c.show.status === "live" && !curShow) { showSel.value = c.show.id; await openShow(c.show.id); } });

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
        fillTargets(); renderPlan(); renderAsRun(); renderNow(); updateTimes(); if (!cartsEdit) renderCarts();
      } catch { /* nächster Takt */ }
    };
    loadTargets().then(poll);
    this._i1 = setInterval(poll, 1000);
    this._i2 = setInterval(loadTargets, 15000);
  }
  disconnectedCallback() { clearInterval(this._i1); clearInterval(this._i2); }
}
if (!customElements.get("omp-radio-automation-panel")) customElements.define("omp-radio-automation-panel", OmpRadioAutomationPanel);
