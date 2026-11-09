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
      colTitle: "Titel", colBlock: "Block", colTime: "Zeit", drag: "ziehen zum Sortieren", dup: "Duplizieren", segueEdit: "Übergang bearbeiten", segueNeedsFiles: "Beide Zeilen brauchen Datei und Dauer", segueLoadFailed: "Übergangs-Editor nicht ladbar", insertAbove: "Element davor einfügen",
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
      cardNone: "Keine Karte zu diesem Element.", notes: "Notizen zur Sendung", cardNow: "Moderation", cardNext: "Als Nächstes",
      tplOpen: "Vorlage öffnen …", week: "Wochenplan", weekPrev: "← Woche", weekNext: "Woche →", weekToday: "Heute", weekAdd: "+ Sendung", weekOverlap: "überschneidet sich mit der vorigen Sendung", weekEmpty: "—",
      "wd.MO": "Mo", "wd.TU": "Di", "wd.WE": "Mi", "wd.TH": "Do", "wd.FR": "Fr", "wd.SA": "Sa", "wd.SU": "So",
      recur: "Wiederkehr (aus dieser Vorlage Sendungen im Voraus anlegen)", recurOn: "Wiederkehr an", recurDays: "Wochentage", recurTime: "Beginn (Uhr)", recurDur: "Dauer (min)", recurTz: "Zeitzone", recurHorizon: "Vorlauf (Tage)", recurUntil: "Bis (Datum, leer = unbegrenzt)", recurBad: "Wiederkehr unvollständig: Wochentage, Beginn und Dauer angeben.",
      autoLive: "Status automatisch nach dem Zeitfenster (live/gesendet)", autoLoad: "Automatisch laden und zum Sendebeginn starten", autoLead: "Vorlauf (min)",
      lockedBy: "{u} bearbeitet diese Sendung gerade — schreibgeschützt.", lockTake: "Bearbeitung übernehmen", lockLost: "Die Bearbeitung wurde von {u} übernommen — schreibgeschützt.", lockMine: "Du bearbeitest",
      tp: "Teleprompter", tpClose: "Schließen", tpMirror: "Spiegeln", tpSpeed: "Auto-Scroll", tpSize: "Schrift", tpEmpty: "Keine Karten in dieser Sendung.", readTime: "Lesezeit ≈ {t}", readOver: "länger als geplant ({m} min)",
      tabLive: "Sendebetrieb", tabPlan: "Planung", tabList: "Playlist", tabMod: "Moderation", tabLog: "Protokoll", tabTrans: "Übergänge", transHint: "Die Übergänge der Playlist: Segue-Punkt, Blenden und Einsatz je Titelpaar. „Bearbeiten“ öffnet den Segue-Editor (auch per Doppelklick auf die Zeit in der Playlist).", transStd: "Standardblende", transEdit: "Bearbeiten", transNone: "Weniger als zwei Zeilen in der Playlist.", transFadeOut: "aus", transFadeIn: "ein", transShift: "Einsatz", tabsLabel: "Bereiche",
      lay: "Layout", layZones: "Bereiche (Reihenfolge, sichtbar)", layListH: "Höhe der Playlist", laySideW: "Breite der rechten Spalte", layCur: "Farbe: läuft", layNext: "Farbe: bereit", layReset: "Standard", layHint: "Gilt für diese Sendung (wird mit „Speichern“ in der Sendung abgelegt) und merkt sich dieser Browser als Vorgabe.", "z.cmd": "Tasten", "z.pfl": "Vorhören", "z.card": "Moderationskarte", "z.hot": "Hotkeys", "z.lib": "Bibliothek",
      lib: "Bibliothek", libSoon: "Die Bibliothek (Suche im Bestand, Ziehen in die Playlist) wird angebunden, sobald die Datenquellen feststehen.", libSearch: "Titel, Interpret …",
      pfl: "Vorhören (PFL)", pflNone: "Zeile in der Playlist wählen", pflLoading: "lädt …", pflFail: "Vorhören nicht möglich: {d}", pflSel: "gewählt",
      bCue: "Cue", bReset: "Reset", bLoad: "Laden", bNav: "Navigator", bEdit: "Bearbeiten", bDiag: "Protokoll", bPlan: "Planung", bMod: "Modtext", bTp: "Teleprompter", bStart: "Start", bStop: "Stopp", bTrans: "Übergang",
      cOnAir: "on air", cOff: "aus", cAuto: "Auto", cNextIn: "Nächstes in", cReady: "bereit", cPlaying: "spielt", cPlayed: "gespielt", cPlan: "Playlist", cNoShow: "Keine Sendung geladen", cEmptyList: "Keine Playlist geladen — Reiter „Playlist“ oder „Planung“.", cIntro: "Intro", cOutro: "Outro", cHard: "feste Zeit", cDeckNext: "Nächster Titel", cDeckNone: "—", cCart: "Hotkeys",
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
      colTitle: "Title", colBlock: "Block", colTime: "Time", drag: "drag to reorder", dup: "Duplicate", segueEdit: "Edit transition", segueNeedsFiles: "Both rows need a file and duration", segueLoadFailed: "Transition editor unavailable", insertAbove: "Insert item above",
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
      cardNone: "No card for this item.", notes: "Show notes", cardNow: "Presenter", cardNext: "Next up",
      tplOpen: "Open template …", week: "Week plan", weekPrev: "← Week", weekNext: "Week →", weekToday: "Today", weekAdd: "+ Show", weekOverlap: "overlaps the previous show", weekEmpty: "—",
      "wd.MO": "Mon", "wd.TU": "Tue", "wd.WE": "Wed", "wd.TH": "Thu", "wd.FR": "Fri", "wd.SA": "Sat", "wd.SU": "Sun",
      recur: "Recurrence (create shows from this template in advance)", recurOn: "Recurrence on", recurDays: "Weekdays", recurTime: "Start (time)", recurDur: "Duration (min)", recurTz: "Time zone", recurHorizon: "Lead (days)", recurUntil: "Until (date, empty = unlimited)", recurBad: "Recurrence incomplete: give weekdays, start and duration.",
      autoLive: "Status automatically after the time window (live/aired)", autoLoad: "Load automatically and start at show start", autoLead: "Lead (min)",
      lockedBy: "{u} is editing this show — read only.", lockTake: "Take over editing", lockLost: "Editing was taken over by {u} — read only.", lockMine: "You are editing",
      tp: "Teleprompter", tpClose: "Close", tpMirror: "Mirror", tpSpeed: "Auto-scroll", tpSize: "Size", tpEmpty: "No cards in this show.", readTime: "Reading time ≈ {t}", readOver: "longer than planned ({m} min)",
      tabLive: "On air", tabPlan: "Planning", tabList: "Playlist", tabMod: "Presenter", tabLog: "Log", tabTrans: "Transitions", transHint: "The playlist transitions: segue point, blends and start per pair. “Edit” opens the segue editor (also by double-clicking the time cell in the playlist).", transStd: "Default blend", transEdit: "Edit", transNone: "Fewer than two playlist rows.", transFadeOut: "out", transFadeIn: "in", transShift: "start", tabsLabel: "Sections",
      lay: "Layout", layZones: "Zones (order, visible)", layListH: "Playlist height", laySideW: "Right column width", layCur: "Colour: playing", layNext: "Colour: ready", layReset: "Default", layHint: "Applies to this show (stored in the show with “Save”) and is remembered by this browser as default.", "z.cmd": "Buttons", "z.pfl": "Pre-listen", "z.card": "Presenter card", "z.hot": "Hotkeys", "z.lib": "Library",
      lib: "Library", libSoon: "The library (search the stock, drag into the playlist) will be connected once the data sources are settled.", libSearch: "Title, artist …",
      pfl: "Pre-listen (PFL)", pflNone: "Select a playlist row", pflLoading: "loading …", pflFail: "Pre-listen failed: {d}", pflSel: "selected",
      bCue: "Cue", bReset: "Reset", bLoad: "Load", bNav: "Navigator", bEdit: "Edit", bDiag: "Log", bPlan: "Planning", bMod: "Presenter", bTp: "Teleprompter", bStart: "Start", bStop: "Stop", bTrans: "Transition",
      cOnAir: "on air", cOff: "off", cAuto: "Auto", cNextIn: "Next in", cReady: "ready", cPlaying: "playing", cPlayed: "played", cPlan: "Playlist", cNoShow: "No show loaded", cEmptyList: "No playlist loaded — see tab “Playlist” or “Planning”.", cIntro: "Intro", cOutro: "Outro", cHard: "fixed time", cDeckNext: "Next track", cDeckNone: "—", cCart: "Hotkeys",
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
  /* Lange Berührung (Handy): kein Kontextmenü/keine Markierung auf Tasten — Hotkeys werden getippt und gehalten */
  button { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .hkkey { touch-action: manipulation; }
  input, select, textarea { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 4px 9px; }
  button:hover:not(:disabled) { border-color: var(--acc); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #2a5a8f; border-color: var(--acc); }
  button.danger { background: #6a2a2a; border-color: var(--err); }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 10px; background: var(--bg3); font-weight: 600; min-width: 84px; text-align: center; white-space: nowrap; }
  .chip.running { background: var(--ok); color: #fff; } .chip.finished { color: var(--mut); }
  .lockbar { padding: 5px 8px; border-radius: 4px; background: #2a5a8f; color: #fff; margin-top: 6px; }
  :host { position: relative; }
  .banner { display: none; position: fixed; top: 6px; left: 50%; transform: translateX(-50%); max-width: 90%; z-index: 100; padding: 6px 12px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.6); pointer-events: none; }
  .banner.show { display: block; } .banner.note { background: #2a5a8f; }
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); text-align: left; padding: 2px 4px; }
  td { padding: 2px 3px; } td input, td select { width: 100%; } td.num input { width: 84px; text-align: right; }
  td.file input { min-width: 200px; } td.act { white-space: nowrap; } td.act button { padding: 2px 6px; }
  .hint, .muted { color: var(--mut); } .dirty { color: var(--warn); margin-left: 8px; display: inline-block; min-width: 180px; }
  .tl { position: relative; margin-top: 6px; }
  .tlrow { position: relative; height: 22px; margin-bottom: 3px; background: var(--bg); border-radius: 3px; }
  .tlbar { position: absolute; top: 2px; height: 18px; border-radius: 3px; background: #2a5a8f; color: #fff; font-size: 10px; line-height: 18px; padding: 0 5px; overflow: hidden; white-space: nowrap; }
  .tlbar.jingle { background: #8f5a2a; } .tlbar.speech { background: #5a2a8f; } .tlbar.sent { outline: 1px solid var(--ok); } .tlbar.cur { box-shadow: 0 0 0 2px #fff; }
  .tlnow { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--err); z-index: 2; }
  .tlfade { position: absolute; top: 2px; height: 18px; background: repeating-linear-gradient(135deg, rgba(255,255,255,.28) 0 3px, transparent 3px 6px); border-radius: 3px; }
  .ev { font-variant-numeric: tabular-nums; padding: 1px 0; }
  textarea { width: 100%; min-height: 120px; font-family: monospace; }
  td.tcol, th.tcol { width: 82px; min-width: 82px; white-space: nowrap; } tr.blockhead td { background: #3a2f1c; font-weight: 600; padding: 4px 6px; } tr.blockhead input { width: 70px; }
  tr.dragover td { border-top: 2px solid var(--acc); } td.handle { cursor: grab; color: var(--mut); user-select: none; } tr.cur td { background: #1f3a24; } tr.done td { opacity: .55; }
  .ok { color: var(--ok); } .bad { color: var(--err); } .nowbar { display: flex; gap: 18px; align-items: center; padding: 8px 10px; background: var(--bg2); border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; }
  .autost { display: inline-block; width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; } .nowbar { min-height: 96px; } .nowbar .big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; } .nowbar .grow { flex: 1; min-width: 0; } .nowbar .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nowprog { height: 5px; background: var(--bg3); border-radius: 3px; margin-top: 4px; } .nowprog > div { height: 100%; background: var(--acc); border-radius: 3px; }
  .showbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; } .showbar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); } .showmeta { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin-top: 8px; }
  .sstat { display: inline-block; padding: 2px 10px; border-radius: 10px; background: var(--bg3); font-weight: 600; min-width: 120px; text-align: center; white-space: nowrap; } .sstat.ready { background: #2a5a8f; } .sstat.live { background: var(--ok); color: #fff; } .sstat.done, .sstat.archived { color: var(--mut); }
  .card { border: 1px solid var(--bd); border-radius: 5px; padding: 6px; margin-bottom: 6px; display: grid; grid-template-columns: 1fr 180px 70px auto; gap: 6px; align-items: start; } .card textarea { grid-column: 1 / -1; min-height: 70px; font-family: inherit; }
  .cardlive { background: var(--bg2); border: 1px solid var(--acc); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; display: none; height: 150px; overflow-y: auto; } .cardlive.show { display: block; } .cardlive.idle { opacity: .45; } .cardlive h4 { margin: 0 0 4px; } .cardlive .tx { white-space: pre-wrap; font-size: 15px; line-height: 1.45; }
  .week { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)); gap: 6px; } .wday { background: var(--bg); border: 1px solid var(--bd); border-radius: 5px; min-height: 90px; padding: 4px; } .wday.today { border-color: var(--acc); }
  .wday h5 { margin: 0 0 4px; font-size: 11px; color: var(--mut); display: flex; justify-content: space-between; align-items: center; } .wday h5 button { padding: 0 6px; font-size: 11px; }
  .wshow { display: block; width: 100%; text-align: left; margin-bottom: 4px; padding: 3px 5px; border-radius: 4px; border: 1px solid var(--bd); background: var(--bg3); font-size: 11px; } .wshow.ready { background: #1f3f66; } .wshow.live { background: #2a6a30; } .wshow.done { opacity: .55; } .wshow.sel { outline: 2px solid #fff; } .wshow.overlap { border-color: var(--err); }
  .wshow .wt { color: var(--mut); font-variant-numeric: tabular-nums; } .recur { margin-top: 8px; padding: 8px; border: 1px dashed var(--bd); border-radius: 5px; display: none; } .recur.show { display: block; } .recur .days { display: flex; gap: 8px; flex-wrap: wrap; } .recur .days label { flex-direction: row; align-items: center; gap: 3px; }
  .card .rt { grid-column: 1 / -1; font-size: 11px; color: var(--mut); } .card .rt.over { color: var(--err); }
  .tp { position: fixed; inset: 0; z-index: 99999; background: #000; color: #fff; display: none; flex-direction: column; font-family: system-ui, sans-serif; } .tp.open { display: flex; }
  .tp .bar2 { display: flex; gap: 14px; align-items: center; padding: 8px 14px; background: #111; border-bottom: 1px solid #333; font-size: 14px; } .tp .bar2 .grow { flex: 1; } .tp .bar2 button, .tp .bar2 input { font-size: 14px; }
  .tp .scroll { flex: 1; overflow-y: auto; padding: 5vh 8vw 40vh; scroll-behavior: smooth; } .tp .scroll.mirror { transform: scaleX(-1); }
  .tp .tc { margin-bottom: 4vh; opacity: .45; } .tp .tc.active { opacity: 1; } .tp .tc h3 { margin: 0 0 1vh; font-size: .55em; color: #8ab4ff; text-transform: uppercase; letter-spacing: .06em; } .tp .tc .tx { white-space: pre-wrap; line-height: 1.5; }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--bd); }
  .tabs button { min-width: 96px; font-weight: 600; } .tabs button.on { background: #2a5a8f; border-color: var(--acc); color: #fff; }
  .tabs .mk { color: var(--warn); margin-left: 4px; display: inline-block; min-width: 10px; } .tabs .cnt { color: var(--mut); margin-left: 4px; display: inline-block; min-width: 18px; } .tabs button.on .cnt { color: #cfe3ff; }
  .hk { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
  .hkkey { position: relative; min-height: 58px; padding: 6px 8px; border-radius: 5px; border: 1px solid rgba(255,255,255,.2); color: #fff; text-align: left; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; }
  .hkkey .nm { font-weight: 700; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.6); } .hkkey .tm { font-variant-numeric: tabular-nums; font-size: 11px; opacity: .9; }
  .hkkey .pr { position: absolute; left: 0; bottom: 0; height: 4px; background: #fff; opacity: .85; } .hkkey.playing { box-shadow: 0 0 0 2px #fff; }
  .hkkey.c-red { background: #b03030; } .hkkey.c-green { background: #2f8a3e; } .hkkey.c-blue { background: #2f5fb0; } .hkkey.c-orange { background: #c7731d; } .hkkey.c-purple { background: #7a3fa0; } .hkkey.c-teal { background: #1f8a86; } .hkkey.c-grey { background: #55555c; }
  /* Sendeplatz (Konsole) — feste Größen, damit nichts springt */
  .cons { display: grid; gap: 10px; margin-bottom: 10px; }
  .c-top { display: grid; grid-template-columns: auto 1fr auto auto; gap: 18px; align-items: center; padding: 10px 14px; background: linear-gradient(90deg, #0f1522, #172033); border: 1px solid #223049; border-radius: 10px; min-height: 64px; }
  .c-clock { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .02em; min-width: 150px; }
  .c-date { color: var(--mut); font-size: 12px; line-height: 1.5; } .c-show { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c-onair { min-width: 96px; text-align: center; padding: 6px 14px; border-radius: 8px; font-size: 20px; font-weight: 800; letter-spacing: .06em; text-transform: lowercase; background: #2c2c30; color: var(--mut); border: 1px solid var(--bd); }
  .c-onair.on { background: #e53935; color: #fff; border-color: #ff8a80; box-shadow: 0 0 12px 2px rgba(229,57,53,.55); }
  .c-auto { min-width: 130px; text-align: center; padding: 6px 10px; border-radius: 8px; background: #0b101b; border: 1px solid #223049; font-size: 13px; }
  .c-main { display: grid; grid-template-columns: minmax(0, 1fr) var(--c-sidew, 380px); gap: 10px; }
  .c-lay { display: none; padding: 10px 14px; border: 1px dashed #3a4a68; border-radius: 10px; gap: 14px; flex-wrap: wrap; align-items: end; } .c-lay.open { display: flex; } .c-lay label { display: flex; flex-direction: column; gap: 3px; color: var(--mut); } .c-lay .zr { display: flex; gap: 4px; align-items: center; color: var(--t, #e6e6e6); } .c-lay .zr span { min-width: 120px; }
  .c-list { height: var(--c-listh, 560px); overflow-y: auto; border: 1px solid #223049; border-radius: 10px; background: #0b101b; padding: 4px; }
  .c-row { display: grid; grid-template-columns: 74px 28px minmax(0, 1fr) 150px 64px 70px; gap: 8px; align-items: center; min-height: 52px; padding: 4px 10px; margin-bottom: 3px; border-radius: 7px; background: #172033; border-left: 6px solid #3a4a68; }
  .c-row.jingle { border-left-color: #c7731d; } .c-row.speech { border-left-color: #7a3fa0; } .c-row.song { border-left-color: #2f8cff; }
  .c-row.fix { box-shadow: inset 0 0 0 1px #e0a030; }
  .c-row.next { background: var(--c-next, #1c5a30); } .c-row.cur { background: var(--c-cur, #b02a2a); box-shadow: 0 0 10px rgba(229,57,53,.45); } .c-row.done { opacity: .5; }
  .c-row .tm { font-variant-numeric: tabular-nums; font-weight: 600; } .c-row .ic { text-align: center; font-size: 15px; }
  .c-row .nm { min-width: 0; } .c-row .nm b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .c-row .nm span { display: block; color: rgba(255,255,255,.65); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c-row .mk { font-size: 11px; line-height: 1.4; color: rgba(255,255,255,.75); font-variant-numeric: tabular-nums; } .c-row .du { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; } .c-row .st { text-align: right; font-size: 11px; color: rgba(255,255,255,.8); }
  .c-hint { padding: 18px; color: var(--mut); }
  .c-side { display: grid; gap: 10px; min-width: 0; align-content: start; }
  .c-deck { display: grid; grid-template-columns: minmax(0, 1fr) 130px minmax(0, 1fr); gap: 10px; }
  .c-pl { border-radius: 10px; padding: 10px 14px; min-height: 150px; border: 1px solid #223049; background: #0f1522; display: grid; grid-template-rows: auto auto auto auto; gap: 4px; }
  .c-pl.m1.live { background: #8f1f1f; border-color: #ff8a80; } .c-pl.m2.live { background: #17613a; border-color: #7bd89a; }
  .c-pl .hd { display: flex; justify-content: space-between; font-weight: 800; font-size: 18px; } .c-pl .ti { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .c-pl .su { font-size: 11px; opacity: .75; }
  .c-pl .bar { height: 8px; background: rgba(0,0,0,.4); border-radius: 4px; overflow: hidden; margin: 0; align-self: end; } .c-pl .bar > div { height: 100%; background: #fff; }
  .c-pl .rem { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
  .c-count { display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 10px; background: #e9e9ee; color: #1b1b1d; min-height: 150px; }
  .c-count small { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: .05em; } .c-count b { font-size: 64px; line-height: 1; font-variant-numeric: tabular-nums; } .c-count.hot b { color: #d32f2f; }
  .c-side .cardlive { height: 150px; margin: 0; } .c-side details.sec { margin: 0; }
  .c-row.sel { background: #f2e24a; color: #1b1b1d; } .c-row.sel .nm span, .c-row.sel .mk, .c-row.sel .st { color: rgba(0,0,0,.65); } .c-row { cursor: pointer; }
  .c-card { border: 1px solid #223049; border-radius: 10px; background: #0f1522; padding: 8px 10px; }
  .c-card h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); } .c-card.soon { opacity: .6; } .c-card.soon p { margin: 6px 0 0; font-size: 11px; }
  .c-pflbar { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center; } .c-pflbar b { font-size: 22px; font-variant-numeric: tabular-nums; min-width: 80px; }
  .c-pflbar span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--mut); }
  canvas.wf { display: block; width: 100%; height: 48px; margin-top: 6px; background: #0b101b; border-radius: 6px; } .c-pl canvas.wf { background: rgba(0,0,0,.35); height: 40px; margin: 0; }
  .c-cmd { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; } .c-cmd button { min-height: 38px; font-weight: 600; background: #26324a; } .c-cmd button.go { background: #17613a; border-color: #7bd89a; } .c-cmd button.stop { background: #8f1f1f; border-color: #ff8a80; } .c-cmd button.cue { background: #b57b1a; color: #fff; }
  @media (max-width: 1100px) { .c-main, .c-deck { grid-template-columns: 1fr; } .c-top { grid-template-columns: 1fr auto; } }
  .hked { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; align-items: end; padding: 6px; border: 1px solid var(--bd); border-radius: 5px; margin-bottom: 6px; } .hked label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
`;

const readSeconds = (text) => { const w = (text || "").trim().split(/\s+/).filter(Boolean).length; return w ? Math.round(w / 2.5) : 0; }; // ≈ 150 Wörter/min (Sprechtempo Moderation)
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
        ...(r.transition && Object.keys(r.transition).length ? { transition: r.transition } : {}),
      })),
      fillers,
      blocks: Object.entries(blockTargets).filter(([n]) => rows.some((r) => (r.block || "").trim() === n)).map(([name, targetMs]) => ({ name, targetMs })),
    });
    const fromWire = (l) => { logId = l.logId || "log"; fillers = l.fillers || []; blockTargets = Object.fromEntries((l.blocks || []).map((b) => [b.name, b.targetMs])); rows = (l.items || []).map((i) => ({ ...blankItem(), ...i, introMs: i.introMs ?? null, outroMs: i.outroMs ?? null, fixText: unixToFix(i.fixAtUnixMs), title: i.title || "", block: i.block || "" })); };

    // ---- Kopf ----
    const stateChip = h("span", { class: "chip" });
    const targetSel = h("select", { onchange: () => setParam("target", targetSel.value) });
    const lookInput = h("input", { type: "number", min: "2", max: "300", style: "width:70px", onchange: () => setParam("lookaheadMs", Math.round(Number(lookInput.value) * 1000)).then((r) => { if (!r.ok) show(T("fail", { m: "lookahead", d: r.status })); }) });
    const autoChk = h("input", { type: "checkbox", style: "width:auto", onchange: () => setParam("autoLoad", autoChk.checked) });
    const autoLead = h("input", { type: "number", min: "1", max: "60", style: "width:60px", onchange: () => setParam("autoLeadMs", Math.round(Number(autoLead.value) * 60000)) });
    const autoSt = h("span", { class: "muted autost" });
    const head = h("div", { class: "bar" }, h("label", {}, T("state"), stateChip), h("label", {}, T("target"), targetSel), h("label", {}, T("lookahead"), lookInput),
      h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, autoChk, T("autoLoad")), h("label", {}, T("autoLead"), autoLead), autoSt);

    // ---- Log-Editor ----
    const logIdInput = h("input", { style: "width:160px", oninput: () => { logId = logIdInput.value; markDirty(); } });
    const dirtyEl = h("span", { class: "dirty" });
    const markDirty = () => { dirty = true; dirtyEl.textContent = T("dirty"); if (typeof markShow === "function") markShow(); if (typeof updTabs === "function") updTabs(); };
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
        const timeCell = h("td", { class: "muted tcol", title: i > 0 ? T("segueEdit") : "", ondblclick: () => { if (i > 0) openSegueEditor(i); } }); timeCells.push([i, timeCell]);
        const tr = h("tr", { draggable: "true",
          ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); },
          ondragover: (e) => { if (dragFrom === null) return; e.preventDefault(); tr.classList.add("dragover"); },
          ondragleave: () => tr.classList.remove("dragover"),
          ondrop: (e) => { e.preventDefault(); tr.classList.remove("dragover"); if (dragFrom === null || dragFrom === i) { dragFrom = null; return; } const [m] = rows.splice(dragFrom, 1); rows.splice(i, 0, m); dragFrom = null; markDirty(); renderRows(); },
          ondragend: () => { dragFrom = null; } },
          h("td", { class: "handle", title: T("drag") }, "⠿"), h("td", { class: "muted" }, i + 1), cell("", inp("id", "text")), cell("", inp("title", "text")), cell("", kind), cell("", inp("block", "text")), cell("file", inp("file", "text")), cell("num", inp("durationMs", "number")), cell("num", inp("introMs", "number")), cell("num", inp("outroMs", "number")), cell("num", inp("somMs", "number")), cell("num", inp("gainDb", "number")), cell("", inp("fixText", "text")),
          cell("", h("input", { type: "checkbox", style: "width:auto", checked: !!r.optional, onchange: (e) => { r.optional = e.target.checked; markDirty(); } })),
          timeCell,
          cell("act", [h("button", { title: T("insertAbove"), onclick: () => { const n = blankItem(); n.block = r.block; rows.splice(i, 0, n); markDirty(); renderRows(); } }, "＋"), h("button", { title: T("dup"), onclick: () => { rows.splice(i + 1, 0, { ...r, id: r.id ? r.id + "-2" : "" }); markDirty(); renderRows(); } }, "⧉"), i > 0 ? h("button", { title: T("segueEdit"), class: "seguebtn", onclick: () => openSegueEditor(i) }, "⇄") : null, h("button", { title: T("del"), onclick: () => { rows.splice(i, 1); markDirty(); renderRows(); } }, "✕")]));
        out.push(tr);
      });
      tbody.replaceChildren(...out);
      updateTimes();
      if (typeof renderTrans === "function") renderTrans();
    };
    // Segue-Editor (RB7): Dialog über der Tabelle; das Element kommt vom Node (`ui/segue-editor.js`), der Editor ändert nur Marken + Übergang
    let segueLoad = null;
    const openSegueEditor = async (i) => {
      const a = rows[i - 1], b = rows[i];
      if (!a.file || !b.file || !(Number(a.durationMs) > 0) || !(Number(b.durationMs) > 0)) return show(T("segueNeedsFiles"));
      if (!customElements.get("omp-segue-editor")) { try { segueLoad = segueLoad || import(`${base}/ui/segue-editor.js`); await segueLoad; } catch { segueLoad = null; return show(T("segueLoadFailed")); } }
      const toEdit = (r) => ({ ...r, durationMs: Number(r.durationMs) || 0, somMs: Number(r.somMs) || 0, introMs: r.introMs === "" ? null : r.introMs ?? null, outroMs: r.outroMs === "" ? null : r.outroMs ?? null });
      const ed = document.createElement("omp-segue-editor");
      ed.base = base;
      const back = h("div", { style: "position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px" }, h("div", { style: "width:min(1100px,100%);max-height:100%;overflow:auto" }, ed));
      const close = () => back.remove();
      ed.addEventListener("cancel", close);
      ed.addEventListener("save", (e) => {
        const { a: na, b: nb } = e.detail;
        Object.assign(a, { somMs: na.somMs, introMs: na.introMs, outroMs: na.outroMs });
        Object.assign(b, { somMs: nb.somMs, introMs: nb.introMs, outroMs: nb.outroMs });
        if (nb.transition) b.transition = nb.transition; else delete b.transition;
        markDirty(); renderRows(); close();
      });
      shadow.append(back);
      ed.load(toEdit(a), toEdit(b));
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
        h("table", {}, h("thead", {}, h("tr", {}, h("th"), h("th", {}, "#"), ...["colId", "colTitle", "colKind", "colBlock", "colFile", "colDur", "colIntro", "colOutro", "colSom", "colGain", "colFix", "colOpt", "colTime"].map((k) => h("th", { class: k === "colTime" ? "tcol" : "" }, T(k))), h("th"))), tbody),
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
        if (e.event === "autoload") return h("div", { class: "ev" }, e.text);
        if (e.event === "backtiming") return h("div", { class: "ev" }, `${T("evBack")}: ${e.text}`);
        if (e.event === "backtiming-result") return h("div", { class: "ev" }, T("evBackRes", { ms: e.residualMs }));
        return h("div", { class: "ev" }, e.event === "stop" ? T("evStop") : `${T("evSched")} #${e.index + 1} ${e.id}`, e.leadMs !== undefined ? ` — ${T("lead", { s: (e.leadMs / 1000).toFixed(1) })}` : "");
      }));
    };

    // ---- Teleprompter (Vollbild): alle Karten als fortlaufender Text, die aktive hervorgehoben und mitgeführt ----
    let tpSize = 48, tpActive = null, tpTimer = null;
    const tpScroll = h("div", { class: "scroll" });
    const tpTitle = h("span", { class: "grow" }), tpClock = h("span", {});
    const tpSpeed = h("input", { type: "range", min: "0", max: "120", value: "0", title: T("tpSpeed") });
    const tpMirror = h("input", { type: "checkbox", onchange: () => tpScroll.classList.toggle("mirror", tpMirror.checked) });
    const tp = h("div", { class: "tp" },
      h("div", { class: "bar2" }, tpTitle, tpClock, h("label", {}, T("tpSpeed") + " ", tpSpeed), h("label", {}, tpMirror, " " + T("tpMirror")),
        h("button", { onclick: () => { tpSize = Math.max(20, tpSize - 4); renderTp(); } }, "A−"), h("button", { onclick: () => { tpSize = Math.min(120, tpSize + 4); renderTp(); } }, "A+"),
        h("button", { onclick: () => closeTp() }, T("tpClose"))), tpScroll);
    const scriptOrder = () => {
      const idx = (c) => { const a = c.atItem || ""; if (!a) return -1; const k = rows.findIndex((r, i) => (r.id || `e${i + 1}`) === a); return k < 0 ? rows.length : k; };
      return cards.map((c, i) => ({ c, i })).sort((a, b) => idx(a.c) - idx(b.c) || a.i - b.i).map((x) => x.c);
    };
    const curItemId = () => { const its = view.items || []; const el = view.startUnixMs > 0 ? view.nowUnixMs - view.startUnixMs : null; const i = el === null ? -1 : its.findIndex((x) => el >= x.startMs && el < x.endMs); return i >= 0 ? its[i].id : (el === null ? "" : null); };
    const renderTp = () => {
      tpScroll.style.fontSize = tpSize + "px"; tpTitle.textContent = curShow ? curShow.title : "";
      tpClock.textContent = new Date(view.nowUnixMs || Date.now()).toLocaleTimeString(LOCALE);
      const list = scriptOrder(); const cur = curItemId();
      if (!list.length) { tpScroll.replaceChildren(h("div", { class: "tc active" }, h("div", { class: "tx" }, T("tpEmpty")))); return; }
      const els = list.map((c) => { const active = cur !== null && (c.atItem || "") === cur; return h("div", { class: `tc${active ? " active" : ""}`, "data-id": c.id }, h("h3", {}, `${c.title || ""}${c.minutes ? ` · ${c.minutes} ${T("cardMin")}` : ""}`), h("div", { class: "tx" }, c.text || "")); });
      const sy = tpScroll.scrollTop; tpScroll.replaceChildren(...els); tpScroll.scrollTop = sy;
      const act = els.find((e) => e.classList.contains("active")); const key = act ? act.dataset.id : null;
      if (key && key !== tpActive) { tpActive = key; act.scrollIntoView({ block: "center" }); }
    };
    const openTp = () => { tp.classList.add("open"); tpActive = null; renderTp(); try { tp.requestFullscreen && tp.requestFullscreen(); } catch { /* ohne Vollbild */ }
      clearInterval(tpTimer); tpTimer = setInterval(() => { renderTp(); if (Number(tpSpeed.value) > 0) tpScroll.scrollBy({ top: Number(tpSpeed.value) / 4 }); }, 250); };
    const closeTp = () => { tp.classList.remove("open"); clearInterval(tpTimer); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    addEventListener("keydown", (e) => { if (e.key === "Escape" && tp.classList.contains("open")) closeTp(); });
    const tpBtn = h("button", { onclick: openTp }, T("tp"));

    // ---- Wochenplan ----
    let weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
    let weekShows = [];
    const weekEl = h("div", { class: "week" }), weekLabel = h("span", { class: "muted" });
    const loadWeek = async () => {
      const to = new Date(weekStart); to.setDate(to.getDate() + 7);
      const l = await api("GET", `${API}?template=0&from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(to.toISOString())}`); if (!l) return;
      weekShows = l.filter((x) => x.slotStart && x.status !== "archived"); renderWeek();
    };
    const renderWeek = () => {
      const end = new Date(weekStart); end.setDate(end.getDate() + 6);
      weekLabel.textContent = `${weekStart.toLocaleDateString(LOCALE)} – ${end.toLocaleDateString(LOCALE)}`;
      const WD = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
      const todayStr = new Date().toDateString();
      weekEl.replaceChildren(...WD.map((wd, i) => {
        const day = new Date(weekStart); day.setDate(day.getDate() + i);
        const list = weekShows.filter((x) => new Date(x.slotStart).toDateString() === day.toDateString()).sort((a, b) => new Date(a.slotStart) - new Date(b.slotStart));
        let prevEnd = 0;
        const chips = list.map((x) => {
          const st = new Date(x.slotStart), en = x.slotEnd ? new Date(x.slotEnd) : null;
          const ov = prevEnd && st.getTime() < prevEnd; prevEnd = Math.max(prevEnd, en ? en.getTime() : st.getTime());
          const tm = (d) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
          return h("button", { class: `wshow ${x.status}${curShow && curShow.id === x.id ? " sel" : ""}${ov ? " overlap" : ""}`, title: ov ? T("weekOverlap") : `${x.title} · ${T("ss." + x.status)}`, onclick: async () => {
            if (showDirty && !(await confirmDialog(T("showUnsaved") + " — " + T("showOpen") + "?", T("showOpen")))) return;
            showSel.value = x.id; await openShow(x.id); loadWeek(); } },
            h("div", { class: "wt" }, `${tm(st)}${en ? "–" + tm(en) : ""}`), h("div", {}, x.title), (x.presenters || []).length ? h("div", { class: "wt" }, x.presenters.join(", ")) : null);
        });
        const add = h("button", { title: T("weekAdd"), onclick: () => {
          if (curShow) { curShow = null; applyDoc(null); clearShowDirty(); showSel.value = ""; }
          const d = new Date(day); d.setHours(8, 0, 0, 0); const e = new Date(d); e.setHours(9);
          f_start.value = isoToLocal(d.toISOString()); f_end.value = isoToLocal(e.toISOString()); f_title.focus();
          for (const el of [f_title, f_desc, f_pres, f_start, f_end, f_tpl, f_reason, f_auto]) el.disabled = false; } }, "+");
        return h("div", { class: `wday${day.toDateString() === todayStr ? " today" : ""}` }, h("h5", {}, h("span", {}, `${T("wd." + wd)} ${day.getDate()}.${day.getMonth() + 1}.`), add), ...(chips.length ? chips : [h("span", { class: "muted" }, T("weekEmpty"))]));
      }));
    };
    const weekSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("week")),
      h("div", { class: "body" }, h("div", { class: "bar" },
        h("button", { onclick: () => { weekStart.setDate(weekStart.getDate() - 7); loadWeek(); } }, T("weekPrev")),
        h("button", { onclick: () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); weekStart = d; loadWeek(); } }, T("weekToday")),
        h("button", { onclick: () => { weekStart.setDate(weekStart.getDate() + 7); loadWeek(); } }, T("weekNext")), weekLabel), weekEl));

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
    const tplSel = h("select"), tplOpenSel = h("select");
    const refreshShows = async () => {
      const l = await api("GET", API); if (!l) return;
      shows = l.filter((x) => !x.template && x.status !== "archived"); templates = l.filter((x) => x.template);
      showSel.replaceChildren(h("option", { value: "" }, T("showPick")), ...shows.map((x) => h("option", { value: x.id }, `${fmtSlot(x)} · ${x.title} · ${T("ss." + x.status)}`)));
      tplSel.replaceChildren(h("option", { value: "" }, T("showFromTpl")), ...templates.map((x) => h("option", { value: x.id }, x.title)));
      tplOpenSel.replaceChildren(h("option", { value: "" }, T("tplOpen")), ...templates.map((x) => h("option", { value: x.id }, x.title)));
      if (curShow) showSel.value = curShow.id;
    };
    const f_title = h("input", { type: "text", oninput: () => markShow() }), f_desc = h("input", { type: "text", oninput: () => markShow() }), f_pres = h("input", { type: "text", oninput: () => markShow() });
    const f_start = h("input", { type: "datetime-local", onchange: () => markShow() }), f_end = h("input", { type: "datetime-local", onchange: () => markShow() });
    const f_tpl = h("input", { type: "checkbox", style: "width:auto", onchange: () => { markShow(); renderRecur(); } });
    const f_auto = h("input", { type: "checkbox", style: "width:auto", checked: true, onchange: () => markShow() });
    // Wiederkehr (nur Vorlagen)
    const WDS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    const r_on = h("input", { type: "checkbox", style: "width:auto", onchange: () => markShow() });
    const r_days = WDS.map((d) => h("input", { type: "checkbox", style: "width:auto", "data-d": d, onchange: () => markShow() }));
    const r_time = h("input", { type: "time", value: "07:00", onchange: () => markShow() });
    const r_dur = h("input", { type: "number", min: "1", max: "1440", value: "180", style: "width:80px", oninput: () => markShow() });
    const r_tz = h("input", { type: "text", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", oninput: () => markShow() });
    const r_hor = h("input", { type: "number", min: "1", max: "90", value: "14", style: "width:70px", oninput: () => markShow() });
    const r_until = h("input", { type: "date", onchange: () => markShow() });
    const recurBox = h("div", { class: "recur" }, h("div", { class: "muted" }, T("recur")),
      h("div", { class: "showmeta" }, h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, r_on, T("recurOn")),
        h("div", {}, h("div", { class: "muted" }, T("recurDays")), h("div", { class: "days" }, ...WDS.map((d, i) => h("label", {}, r_days[i], T("wd." + d))))),
        h("label", {}, T("recurTime"), r_time), h("label", {}, T("recurDur"), r_dur), h("label", {}, T("recurTz"), r_tz), h("label", {}, T("recurHorizon"), r_hor), h("label", {}, T("recurUntil"), r_until)));
    const renderRecur = () => { recurBox.classList.toggle("show", f_tpl.checked); };
    const recurFromShow = (sh) => {
      const r = (sh && sh.recurrence) || {};
      r_on.checked = !!r.enabled; r_days.forEach((c) => { c.checked = (r.byDay || []).includes(c.dataset.d); });
      r_time.value = r.time || "07:00"; r_dur.value = r.durationMin || 180; r_tz.value = r.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin"; r_hor.value = r.horizonDays || 14; r_until.value = r.until || "";
    };
    const recurToBody = () => {
      if (!f_tpl.checked) return null;
      return { enabled: r_on.checked, tz: r_tz.value.trim(), time: r_time.value, durationMin: Number(r_dur.value) || 0, byDay: r_days.filter((c) => c.checked).map((c) => c.dataset.d), horizonDays: Number(r_hor.value) || 14, until: r_until.value || "" };
    };
    const f_reason = h("input", { type: "text", placeholder: T("showReason"), style: "width:220px" });
    const statChip = h("span", { class: "sstat" }), unsavedEl = h("span", { class: "dirty" });
    const markShow = () => { if (!curShow) return; showDirty = true; unsavedEl.textContent = T("showUnsaved"); if (typeof updTabs === "function") updTabs(); };
    const clearShowDirty = () => { showDirty = false; unsavedEl.textContent = ""; if (typeof updTabs === "function") updTabs(); };
    const verSel = h("select");
    const docFromState = () => ({ log: toWire(), carts: showCarts, cards, layout: lay, notes: notesText.trim() ? [{ id: "n1", text: notesText }] : [] });
    const applyDoc = (c) => {
      const doc = c || {};
      if (doc.log && doc.log.items) fromWire(doc.log); else { rows = []; fillers = []; blockTargets = {}; }
      logIdInput.value = logId; showCarts = (doc.carts || []).map((x) => ({ ...x })); cards = (doc.cards || []).map((x) => ({ ...x }));
      notesText = (doc.notes && doc.notes[0] && doc.notes[0].text) || ""; notesArea.value = notesText;
      if (doc.layout && typeof applyLay === "function") { lay = { ...defLay(), ...doc.layout }; applyLay(); renderLay(); }
      renderRows(); renderCards(); renderShowBar(); cartsEdit = null; hkEditBtn.textContent = T("hotEdit"); renderCarts();
    };
    const renderShowBar = () => {
      const open = !!curShow;
      f_title.value = curShow ? curShow.title : ""; f_desc.value = curShow ? curShow.description || "" : ""; f_pres.value = curShow ? (curShow.presenters || []).join(", ") : "";
      f_start.value = curShow ? isoToLocal(curShow.slotStart) : ""; f_end.value = curShow ? isoToLocal(curShow.slotEnd) : ""; f_tpl.checked = curShow ? !!curShow.template : false; f_auto.checked = curShow ? curShow.autoLive !== false : true; recurFromShow(curShow); renderRecur();
      statChip.textContent = curShow ? (curShow.template ? T("showTpl") : T("ss." + curShow.status)) : T("showNone"); statChip.className = `sstat ${curShow ? curShow.status : ""}`;
      const st = curShow ? curShow.status : "";
      const editable = open && (st === "draft" || st === "ready");
      for (const el of [f_title, f_desc, f_pres, f_start, f_end, f_tpl, f_reason, f_auto, r_on, r_time, r_dur, r_tz, r_hor, r_until, ...r_days]) el.disabled = !editable || !!lockedBy;
      saveBtn.disabled = !editable || !!lockedBy; saveTplBtn.disabled = !open;
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
      if (curShow) releaseLock(curShow.id);
      setReadOnly("");
      if (!id) { curShow = null; applyDoc(null); clearShowDirty(); return; }
      const sh = await api("GET", `${API}/${id}`); if (!sh) return;
      curShow = sh; applyDoc(sh.content); if (sh.status !== "live") markDirty(); else { dirty = false; dirtyEl.textContent = ""; } clearShowDirty(); await loadVersions(); renderShowBar(); await acquireLock(false);
    };
    const needSaved = async () => { if (showDirty) { show_(T("showUnsaved")); return false; } return true; };
    const saveShow = async (reason) => {
      if (!curShow) return false;
      const bad = rows.find((r) => r.fixText && r.fixText.trim() && fixToUnix(r.fixText) === null); if (bad) { show_(T("badFix", { v: bad.fixText })); return false; }
      const body = { title: f_title.value.trim(), description: f_desc.value, template: f_tpl.checked, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value),
        presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean), tags: curShow.tags || [], content: docFromState(), recurrence: recurToBody(), autoLive: f_auto.checked, rowVersion: curShow.rowVersion, reason: reason ?? f_reason.value };
      if (body.recurrence && body.recurrence.enabled && (!body.recurrence.byDay.length || !body.recurrence.time || !body.recurrence.durationMin)) { show_(T("recurBad")); return false; }
      const r = await api("PUT", `${API}/${curShow.id}`, body); if (!r) return false;
      curShow = r; clearShowDirty(); f_reason.value = ""; show_(T("showSaved", { v: r.rowVersion }), true); await refreshShows(); loadWeek(); await loadVersions(); renderShowBar(); return true;
    };
    // ---- Bearbeitungssperre (weich): wer bearbeitet gerade ----
    const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let lockedBy = "", lockBeat = null;
    const lockBanner = h("div", { class: "lockbar", style: "display:none" });
    const takeBtn = h("button", { onclick: async () => { if (curShow) await acquireLock(true); } }, T("lockTake"));
    const setReadOnly = (who, lost) => {
      lockedBy = who; logSec.inert = !!who; cardsSec.inert = !!who; hkEditBtn.disabled = !!who;
      lockBanner.style.display = who ? "flex" : "none"; lockBanner.style.gap = "10px"; lockBanner.style.alignItems = "center";
      lockBanner.replaceChildren(h("span", {}, T(lost ? "lockLost" : "lockedBy", { u: who })), takeBtn); renderShowBar();
    };
    const lockUrl = () => `${API}/${curShow.id}/lock`;
    const acquireLock = async (takeover) => {
      if (!curShow || !(curShow.status === "draft" || curShow.status === "ready")) { stopBeat(); setReadOnly(""); return; }
      const r = await fetch(lockUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session, takeover: !!takeover }) });
      if (r.ok) { setReadOnly(""); startBeat(); return true; }
      stopBeat();
      if (r.status === 409) { let j = {}; try { j = await r.json(); } catch { /* leer */ } setReadOnly((j.lock && j.lock.holder) || "?"); return false; }
      if (r.status === 403) { setReadOnly(""); return false; } // kein Bearbeitungsrecht: der Server lehnt das Speichern ohnehin ab
      return false;
    };
    const startBeat = () => { stopBeat(); lockBeat = setInterval(async () => {
      if (!curShow) return stopBeat();
      const r = await fetch(lockUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session }) });
      if (r.status === 409) { let j = {}; try { j = await r.json(); } catch { /* leer */ } stopBeat(); setReadOnly((j.lock && j.lock.holder) || "?", true); }
    }, 10000); };
    const stopBeat = () => { if (lockBeat) { clearInterval(lockBeat); lockBeat = null; } };
    const releaseLock = (id) => { stopBeat(); if (id) fetch(`${API}/${id}/lock`, { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session }) }).catch(() => {}); };
    addEventListener("pagehide", () => { if (curShow) releaseLock(curShow.id); });

    const saveBtn = h("button", { class: "primary", onclick: () => saveShow() }, T("showSave"));
    const newBtn = h("button", { onclick: async () => {
      const t = f_title.value.trim() || "Neue Sendung";
      const r = await api("POST", API, { title: t, description: f_desc.value, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value), presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean), content: docFromState(), template: f_tpl.checked, recurrence: recurToBody(), autoLive: f_auto.checked }); if (!r) return;
      curShow = r; clearShowDirty(); show_(T("showCreated"), true); await refreshShows(); loadWeek(); showSel.value = r.id; await loadVersions(); renderShowBar();
    } }, T("showNew"));
    const saveTplBtn = h("button", { onclick: async () => {
      if (!curShow) return; const name = f_title.value.trim() || curShow.title;
      const r = await api("POST", API, { title: name + " (Vorlage)", template: true, presenters: [], content: docFromState() }); if (!r) return;
      show_(T("showCreated"), true); await refreshShows();
    } }, T("showSaveTpl"));
    const relBtn = h("button", { onclick: async () => { if (!(await needSaved())) return; const r = await api("POST", `${API}/${curShow.id}/status`, { status: "ready" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showRelease"));
    const unrelBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "draft" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showUnrelease"));
    const finBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "done" }); if (r) { curShow = { ...show, ...r, content: curShow.content }; await refreshShows(); renderShowBar(); } } }, T("showFinish"));
    const archBtn = h("button", { onclick: async () => { const r = await api("POST", `${API}/${curShow.id}/status`, { status: "archived" }); if (r) { releaseLock(curShow.id); setReadOnly(""); curShow = null; applyDoc(null); await refreshShows(); renderShowBar(); } } }, T("showArchive"));
    const delBtn = h("button", { class: "danger", onclick: async () => { if (!curShow || !(await confirmDialog(T("showDeleteAsk", { t: curShow.title }), T("showDeleteGo")))) return; const r = await api("DELETE", `${API}/${curShow.id}`); if (r) { releaseLock(curShow.id); setReadOnly(""); curShow = null; applyDoc(null); clearShowDirty(); await refreshShows(); renderShowBar(); } } }, T("showDelete"));
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
    tplOpenSel.onchange = async () => {
      const id = tplOpenSel.value; if (!id) return;
      if (showDirty && !(await confirmDialog(T("showUnsaved") + " — " + T("showOpen") + "?", T("showOpen")))) { tplOpenSel.value = ""; return; }
      await openShow(id); tplOpenSel.value = "";
    };
    tplSel.onchange = async () => {
      const id = tplSel.value; if (!id) return; tplSel.value = "";
      const title = f_title.value.trim() || "Neue Sendung";
      const r = await api("POST", `${API}/${id}/duplicate`, { title, template: false, slotStart: localToIso(f_start.value), slotEnd: localToIso(f_end.value), presenters: f_pres.value.split(",").map((x) => x.trim()).filter(Boolean) });
      if (!r) return; show_(T("showCreated"), true); await refreshShows(); showSel.value = r.id; await openShow(r.id);
    };
    const showSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("show")),
      h("div", { class: "body" }, h("div", { class: "showbar" }, h("label", {}, T("show"), showSel), tplSel, tplOpenSel, newBtn, statChip, unsavedEl),
        h("div", { class: "showmeta" }, h("label", {}, T("showTitle"), f_title), h("label", {}, T("showStart"), f_start), h("label", {}, T("showEnd"), f_end), h("label", {}, T("showPres"), f_pres), h("label", {}, T("showDesc"), f_desc), h("label", {}, T("showTpl"), f_tpl), h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, f_auto, T("autoLive"))), lockBanner, recurBox,
        h("div", { class: "showbar", style: "margin-top:8px" }, f_reason, saveBtn, saveTplBtn, relBtn, unrelBtn, liveBtn, finBtn, archBtn, delBtn, verBox)));

    // ---- Moderationskarten und Notizen (je Sendung) ----
    const cardsEl = h("div");
    const notesArea = h("textarea", { style: "min-height:80px", oninput: () => { notesText = notesArea.value; markShow(); } });
    const renderCards = () => {
      if (!cards.length) { cardsEl.replaceChildren(h("span", { class: "muted" }, T("cardEmpty"))); return; }
      cardsEl.replaceChildren(...cards.map((c, i) => {
        const at = h("select", { onchange: (e) => { c.atItem = e.target.value; markShow(); } }, h("option", { value: "" }, T("cardAtStart")), ...rows.map((r, k) => h("option", { value: r.id || `e${k + 1}` }, (r.title && r.title.trim()) || r.id || `#${k + 1}`)));
        at.value = c.atItem || "";
        const rtEl = h("div", { class: "rt" });
        const updRt = () => { const sec = readSeconds(c.text); rtEl.textContent = sec ? T("readTime", { t: fmtMs(sec * 1000) }) + (c.minutes && sec > c.minutes * 60 ? " — " + T("readOver", { m: c.minutes }) : "") : ""; rtEl.classList.toggle("over", !!(c.minutes && sec > c.minutes * 60)); };
        updRt();
        return h("div", { class: "card" },
          h("input", { type: "text", value: c.title || "", placeholder: T("cardTitle"), oninput: (e) => { c.title = e.target.value; markShow(); } }), at,
          h("input", { type: "number", min: "0", value: c.minutes ?? "", placeholder: T("cardMin"), oninput: (e) => { c.minutes = e.target.value === "" ? null : Number(e.target.value); markShow(); } }),
          h("span", {}, h("button", { onclick: () => { if (i > 0) { [cards[i - 1], cards[i]] = [cards[i], cards[i - 1]]; markShow(); renderCards(); } } }, "↑"), h("button", { onclick: () => { if (i < cards.length - 1) { [cards[i + 1], cards[i]] = [cards[i], cards[i + 1]]; markShow(); renderCards(); } } }, "↓"), h("button", { onclick: () => { cards.splice(i, 1); markShow(); renderCards(); } }, "✕")),
          h("textarea", { placeholder: T("cardText"), oninput: (e) => { c.text = e.target.value; markShow(); updRt(); } }, c.text || ""),
          rtEl);
      }));
    };
    const cardsSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("cards")),
      h("div", { class: "body" }, h("div", { class: "bar" }, tpBtn, h("button", { onclick: () => { cards.push({ id: "c" + Date.now().toString(36), title: "", text: "", atItem: "", minutes: null }); markShow(); renderCards(); } }, T("cardAdd"))), cardsEl,
        h("div", { class: "muted", style: "margin:8px 0 2px" }, T("notes")), notesArea));
    // Live: Karten zum laufenden bzw. nächsten Element, groß lesbar
    const cardLive = h("div", { class: "cardlive" });
    const renderCardLive = (curId, nextId, running) => {
      const pick = (id) => cards.filter((c) => (c.atItem || "") === (id || ""));
      const now = running && curId !== null ? pick(curId) : pick("");
      const nxt = running && nextId ? pick(nextId) : [];
      // Hat die Sendung Karten, bleibt das Feld stehen (feste Höhe) — auch wenn zum aktuellen Element keine passt; sonst schöbe es Hotkeys und Log herunter
      if (!cards.length) { cardLive.classList.remove("show"); return; }
      cardLive.classList.add("show"); cardLive.classList.toggle("idle", !now.length && !nxt.length);
      if (!now.length && !nxt.length) { cardLive.replaceChildren(h("span", { class: "muted" }, T("cardNone"))); return; }
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

    // ---- Sendeplatz (Konsole im Stil klassischer Sendeoberflächen, in unserem Look) ----
    const cClock = h("div", { class: "c-clock" }), cDate = h("div", { class: "c-date" }), cShow = h("div", { class: "c-show" }), cOn = h("div", { class: "c-onair" }), cAuto = h("div", { class: "c-auto" });
    const cList = h("div", { class: "c-list" });
    const mkDeck = (cls, label) => { const ti = h("div", { class: "ti" }), su = h("div", { class: "su" }), rem = h("div", { class: "rem" }), pr = h("div"); const cv = h("canvas", { class: "wf", width: 600, height: 80 }); return { ti, su, rem, pr, cv, key: "", el: h("div", { class: `c-pl ${cls}` }, h("div", { class: "hd" }, h("span", {}, label), rem), h("div", {}, ti, su), cv, h("div", { class: "bar" }, pr)) }; };
    const m1 = mkDeck("m1", "M1"), m2 = mkDeck("m2", "M2");
    const cCountNum = h("b", {}), cCount = h("div", { class: "c-count" }, h("small", {}, T("cNextIn")), cCountNum);
    // Wellenform (Spitzenwerte vom Node, je Datei einmal geholt) und Vorhören im Browser (PFL, nicht im Sendeweg)
    const peakCache = new Map();
    const getPeaks = (file, dur) => { const k = `${file}|${dur}`; if (!peakCache.has(k)) { peakCache.set(k, null); fetch(`${base}/segue/peaks?file=${encodeURIComponent(file)}&durationMs=${dur}&bins=300`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.peaks) { peakCache.set(k, j.peaks); wfDirty = true; } else peakCache.delete(k); }).catch(() => peakCache.delete(k)); } return peakCache.get(k); };
    let wfDirty = false;
    const drawWf = (cv, peaks, frac, color) => {
      const g = cv.getContext("2d"), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
      if (!peaks) return;
      const n = peaks.length, bw = W / n;
      for (let i = 0; i < n; i++) { const v = (peaks[i] / 255) * H * 0.95; g.fillStyle = i / n <= frac ? color : "rgba(255,255,255,.28)"; g.fillRect(i * bw, (H - v) / 2, Math.max(1, bw - 1), Math.max(1, v)); }
      if (frac > 0) { g.fillStyle = "#fff"; g.fillRect(Math.min(W - 2, frac * W), 0, 2, H); }
    };
    let selIdx = -1, pflCtx = null, pflSrc = null, pflStart = 0, pflLen = 0, pflBusy = false;
    const pflTime = h("b", {}, "0:00"), pflName = h("span", {}, T("pflNone")), pflCv = h("canvas", { class: "wf", width: 600, height: 96 });
    const pflStop = () => { try { if (pflSrc) { pflSrc.onended = null; pflSrc.stop(); } } catch { /* schon gestoppt */ } pflSrc = null; if (pflCtx) { pflCtx.close().catch(() => {}); pflCtx = null; } };
    const pflPlay = async () => {
      const it = (view.items || [])[selIdx]; if (!it || pflBusy) return;
      if (pflSrc) { pflStop(); return; }
      pflBusy = true; pflName.textContent = T("pflLoading");
      try {
        const dur = it.endMs - it.startMs, r = (rows[selIdx] && rows[selIdx].somMs) || 0, to = Math.min(dur, r + 120000);
        const res = await fetch(`${base}/segue/audio?file=${encodeURIComponent(it.file)}&fromMs=${r}&toMs=${to}`);
        if (!res.ok) throw new Error(res.status);
        const pcm = new Int16Array(await res.arrayBuffer()), n = pcm.length >> 1;
        pflCtx = new AudioContext({ sampleRate: 48000 }); const buf = pflCtx.createBuffer(2, n, 48000);
        const L = buf.getChannelData(0), R = buf.getChannelData(1); for (let i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768; R[i] = pcm[2 * i + 1] / 32768; }
        pflSrc = pflCtx.createBufferSource(); pflSrc.buffer = buf; pflSrc.connect(pflCtx.destination); const ctx = pflCtx;
        pflSrc.onended = () => { if (pflCtx === ctx) { pflStop(); pflTime.textContent = "0:00"; } };
        pflStart = performance.now(); pflLen = n / 48; pflSrc.start();
      } catch (e) { pflStop(); show(T("pflFail", { d: e.message })); }
      pflBusy = false; renderPfl();
    };
    const renderPfl = () => {
      const it = (view.items || [])[selIdx];
      pflName.textContent = it ? `${nameOf(selIdx) || it.id}` : T("pflNone");
      const play = pflSrc ? Math.min(1, (performance.now() - pflStart) / Math.max(1, pflLen)) : 0;
      pflTime.textContent = it ? `PFL: ${fmtMs(pflSrc ? pflLen - (performance.now() - pflStart) : 0)}` : "PFL: 0:00";
      drawWf(pflCv, it ? getPeaks(it.file, it.endMs - it.startMs) : null, play, "#f2c14a");
    };
    const selectRow = (k) => { if (pflSrc) pflStop(); selIdx = k; cRowEls.forEach((e, i) => e.row.classList.toggle("sel", i === k)); renderPfl(); };
    const jump = (t) => () => selectTab(t);
    const cb = (cls, label, fn) => h("button", { class: cls, onclick: fn }, label);
    const cmdGrid = h("div", { class: "c-cmd" },
      cb("go", T("bStart"), () => startBtn.click()), cb("stop", T("bStop"), () => stopBtn.click()), cb("", T("bLoad"), () => loadBtn.click()),
      cb("cue", T("bCue"), () => pflPlay()), cb("", T("bReset"), () => { pflStop(); renderPfl(); }), cb("", T("bTrans"), () => { if (selIdx > 0) openSegueEditor(selIdx); else show(T("pflNone")); }),
      cb("", T("bNav"), jump("list")), cb("", T("bEdit"), jump("list")), cb("", T("bPlan"), jump("plan")),
      cb("", T("bMod"), jump("mod")), cb("", T("bTp"), () => openTp()), cb("", T("bDiag"), jump("log")));
    const libCard = h("div", { class: "c-card soon" }, h("h4", {}, T("lib")), h("input", { type: "text", disabled: "", placeholder: T("libSearch"), style: "width:100%" }), h("p", {}, T("libSoon")));
    const pflCard = h("div", { class: "c-card" }, h("div", { class: "c-pflbar" }, pflTime, pflName), pflCv);
    addEventListener("pagehide", pflStop);
    let cSig = "", cRowEls = [];
    const absTime = (it) => (view.startUnixMs > 0 ? new Date(view.startUnixMs + it.startMs).toLocaleTimeString(LOCALE) : `+${fmtMs(it.startMs)}`);
    const renderConsole = () => {
      const nowMs = view.nowUnixMs || Date.now(), d = new Date(nowMs);
      cClock.textContent = d.toLocaleTimeString(LOCALE);
      cDate.replaceChildren(d.toLocaleDateString(LOCALE, { weekday: "long" }), h("br"), d.toLocaleDateString(LOCALE));
      cShow.textContent = curShow ? `${curShow.title}${curShow.slotStart ? " · " + new Date(curShow.slotStart).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) : ""}` : T("cNoShow");
      const its = view.items || [], running = view.state === "running" && view.startUnixMs > 0;
      cOn.textContent = T(running ? "cOnAir" : "cOff"); cOn.classList.toggle("on", running);
      cAuto.textContent = autoChk.checked ? `${T("cAuto")} ${autoSt.textContent || ""}`.trim() : T("cAuto") + " —";
      const el = running ? nowMs - view.startUnixMs : null;
      const idx = el === null ? -1 : its.findIndex((i) => el >= i.startMs && el < i.endMs);
      const nxtIdx = el === null ? (its.length ? 0 : -1) : its.findIndex((i, k) => k > idx && i.startMs > (idx >= 0 ? its[idx].startMs : el - 1) && i.startMs >= (idx >= 0 ? 0 : el));
      const valid = !dirty && its.length === rows.length;
      // Struktur nur bei geänderter Playlist neu bauen, sonst an Ort und Stelle aktualisieren (Scroll und Klicks bleiben)
      const sig = JSON.stringify(its.map((i) => [i.id, i.endMs - i.startMs])) + "|" + valid;
      if (sig !== cSig) {
        cSig = sig; cRowEls = [];
        if (!its.length) cList.replaceChildren(h("div", { class: "c-hint" }, T("cEmptyList")));
        else cList.replaceChildren(...its.map((it, k) => {
          const r = valid ? rows[k] : null; const kind = (r && r.kind) || it.kind || "song";
          const tm = h("div", { class: "tm" }), st = h("div", { class: "st" });
          const mk = h("div", { class: "mk" }, r && r.introMs ? h("div", {}, `${T("cIntro")} ${(r.introMs / 1000).toFixed(0)}`) : null, r && r.outroMs ? h("div", {}, `${T("cOutro")} ${(r.outroMs / 1000).toFixed(1)}`) : null);
          const row = h("div", { class: `c-row ${kind}${r && r.fixText ? " fix" : ""}` }, tm, h("div", { class: "ic" }, kind === "jingle" ? "♪" : kind === "speech" ? "🎙" : "♫"),
            h("div", { class: "nm" }, h("b", {}, nameOf(k) || it.id), h("span", {}, [r && r.block, r && r.fixText ? `${T("cHard")} ${r.fixText}` : "", it.file].filter(Boolean).join(" · "))), mk, h("div", { class: "du" }, fmtMs(it.endMs - it.startMs)), st);
          row.addEventListener("click", () => selectRow(k)); cRowEls.push({ row, tm, st }); if (k === selIdx) row.classList.add("sel"); return row;
        }));
      }
      its.forEach((it, k) => {
        const e = cRowEls[k]; if (!e) return;
        const cur = k === idx, done = el !== null && el >= it.endMs, next = k === nxtIdx && !cur && !done;
        e.row.classList.toggle("cur", cur); e.row.classList.toggle("done", done); e.row.classList.toggle("next", next);
        e.tm.textContent = absTime(it); e.st.textContent = cur ? T("cPlaying") : done ? T("cPlayed") : next ? T("cReady") : "";
      });
      const cu = cRowEls[idx >= 0 ? idx : nxtIdx]; if (cu && idx !== cLast) { cLast = idx; const top = cu.row.offsetTop - 60; if (cList.scrollTo) cList.scrollTo({ top: Math.max(0, top) }); }
      const fill = (dk, i, live) => {
        dk.el.classList.toggle("live", !!live);
        if (i < 0 || !its[i]) { dk.ti.textContent = T("cDeckNone"); dk.su.textContent = ""; dk.rem.textContent = ""; dk.pr.style.width = "0"; return; }
        const it = its[i]; dk.ti.textContent = nameOf(i) || it.id; dk.su.textContent = it.file || "";
        if (live) { dk.rem.textContent = fmtMs(it.endMs - el); dk.pr.style.width = `${Math.min(100, ((el - it.startMs) / Math.max(1, it.endMs - it.startMs)) * 100)}%`; }
        else { dk.rem.textContent = fmtMs(it.endMs - it.startMs); dk.pr.style.width = "0"; }
      };
      fill(m1, idx, true); fill(m2, nxtIdx, false);
      for (const [dk, i, live, col] of [[m1, idx, true, "#fff"], [m2, nxtIdx, false, "#fff"]]) {
        const it = its[i]; const key = it ? `${it.file}|${it.endMs - it.startMs}|${live ? Math.round((el - it.startMs) / 500) : 0}` : "";
        if (key !== dk.key || wfDirty) { dk.key = key; drawWf(dk.cv, it ? getPeaks(it.file, it.endMs - it.startMs) : null, live && it ? Math.min(1, (el - it.startMs) / Math.max(1, it.endMs - it.startMs)) : 0, col); }
      }
      wfDirty = false; renderPfl();
      const left = el !== null && its[nxtIdx] ? Math.max(0, Math.ceil((its[nxtIdx].startMs - el) / 1000)) : null;
      cCountNum.textContent = left === null ? "–" : left > 99 ? fmtMs(left * 1000) : String(left); cCountNum.style.fontSize = left !== null && left > 99 ? "40px" : ""; cCount.classList.toggle("hot", left !== null && left <= 10);
    };
    let cLast = -2;
    // ---- Layout dynamisch: Bereiche ein/aus + Reihenfolge, Maße, Farben — je Sendung (im Dokument) und als Browser-Vorgabe ----
    const ZONES = ["cmd", "pfl", "card", "hot", "lib"];
    const defLay = () => ({ side: ZONES.slice(), hidden: [], listH: 560, sideW: 380, cur: "#b02a2a", next: "#1c5a30" });
    const layKey = `omp-radio-layout-${nodeId}`;
    let lay = (() => { try { return { ...defLay(), ...JSON.parse(localStorage.getItem(layKey) || "{}") }; } catch { return defLay(); } })();
    const zoneEl = { cmd: cmdGrid, pfl: pflCard, card: cardLive, hot: cartSec, lib: libCard };
    const zoneWrap = Object.fromEntries(ZONES.map((k) => [k, h("div", { class: "zone" }, zoneEl[k])]));
    const sideEl = h("div", { class: "c-side" });
    const layBox = h("div", { class: "c-lay" });
    const applyLay = () => {
      const order = [...lay.side.filter((k) => ZONES.includes(k)), ...ZONES.filter((k) => !lay.side.includes(k))];
      sideEl.replaceChildren(...order.filter((k) => !lay.hidden.includes(k)).map((k) => zoneWrap[k]));
      cons.style.setProperty("--c-listh", `${lay.listH}px`); cons.style.setProperty("--c-sidew", `${lay.sideW}px`); cons.style.setProperty("--c-cur", lay.cur); cons.style.setProperty("--c-next", lay.next);
      cons.querySelector(".c-main").style.gridTemplateColumns = lay.hidden.length === ZONES.length ? "1fr" : "";
    };
    const changeLay = () => { try { localStorage.setItem(layKey, JSON.stringify(lay)); } catch { /* ohne Speicher */ } applyLay(); renderLay(); markShow(); };
    const renderLay = () => {
      const order = [...lay.side.filter((k) => ZONES.includes(k)), ...ZONES.filter((k) => !lay.side.includes(k))];
      const mv = (i, d) => { const o = order.slice(); const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; lay.side = o; changeLay(); };
      const rng = (key, min, max, label) => h("label", {}, `${label}: ${lay[key]}`, h("input", { type: "range", min, max, step: 10, value: lay[key], onchange: (e) => { lay[key] = Number(e.target.value); changeLay(); } }));
      const col = (key, label) => h("label", {}, label, h("input", { type: "color", value: lay[key], onchange: (e) => { lay[key] = e.target.value; changeLay(); } }));
      layBox.replaceChildren(
        h("div", {}, h("div", { class: "muted" }, T("layZones")), ...order.map((k, i) => h("div", { class: "zr" }, h("input", { type: "checkbox", style: "width:auto", checked: !lay.hidden.includes(k), onchange: (e) => { lay.hidden = e.target.checked ? lay.hidden.filter((x) => x !== k) : [...lay.hidden, k]; changeLay(); } }), h("span", {}, T("z." + k)), h("button", { onclick: () => mv(i, -1) }, "↑"), h("button", { onclick: () => mv(i, 1) }, "↓")))),
        rng("listH", 240, 900, T("layListH")), rng("sideW", 240, 640, T("laySideW")), col("cur", T("layCur")), col("next", T("layNext")),
        h("button", { onclick: () => { lay = defLay(); changeLay(); } }, T("layReset")), h("div", { class: "muted", style: "flex-basis:100%" }, T("layHint")));
    };
    const cons = h("div", { class: "cons" },
      h("div", { class: "c-top" }, cClock, h("div", {}, cShow, cDate), cOn, h("div", {}, cAuto, h("button", { style: "margin-top:4px;width:100%", onclick: () => layBox.classList.toggle("open") }, "⚙ " + T("lay")))),
      layBox,
      h("div", { class: "c-main" }, cList, sideEl),
      h("div", { class: "c-deck" }, m1.el, cCount, m2.el));

    applyLay(); renderLay();
    // ---- Reiter: Sendebetrieb · Planung · Playlist · Moderation · Protokoll ----
    // Oben bleiben Einstellungen, „Jetzt“ und die Live-Karte stehen (immer sichtbar im Betrieb); darunter wechselt der Bereich.
    const mkPane = (...els) => h("div", { class: "pane" }, ...els);
    // Reiter „Übergänge“: Liste der Titelpaare der Playlist mit Kurzfassung des Übergangs; der Segue-Editor öffnet von hier und aus der Playlist
    const transBody = h("div", { class: "body" });
    const renderTrans = () => {
      const fmtS = (v) => (v / 1000).toFixed(1) + " s";
      const sum = (t) => {
        if (!t || !Object.keys(t).length) return T("transStd");
        const parts = [];
        if (t.fadeOutMs !== undefined) parts.push(`${T("transFadeOut")} ${fmtS(t.fadeOutMs)}`);
        if (t.fadeInMs !== undefined) parts.push(`${T("transFadeIn")} ${fmtS(t.fadeInMs)}`);
        if (t.startShiftMs !== undefined) parts.push(`${T("transShift")} ${t.startShiftMs > 0 ? "+" : ""}${fmtS(t.startShiftMs)}`);
        if (t.curveOut || t.curveIn) parts.push([t.curveOut, t.curveIn].filter(Boolean).join("/"));
        return parts.join(" · ");
      };
      const name = (r) => r.title || r.id || r.file.split("/").pop() || "—";
      const list = rows.slice(1).map((r, k) => h("tr", {}, h("td", { class: "muted" }, k + 1), h("td", {}, `${name(rows[k])}  →  ${name(r)}`), h("td", { class: r.transition ? "" : "muted" }, sum(r.transition)),
        h("td", {}, h("button", { onclick: () => openSegueEditor(k + 1) }, T("transEdit")))));
      transBody.replaceChildren(h("p", { class: "hint" }, T("transHint")), rows.length < 2 ? h("p", { class: "muted" }, T("transNone")) : h("table", {}, h("tbody", {}, ...list)));
    };
    const transSec = h("details", { class: "sec", open: "" }, h("summary", {}, T("tabTrans")), transBody);
    const panes = { live: mkPane(cons, planSec), plan: mkPane(weekSec, showSec), list: mkPane(logSec), trans: mkPane(transSec), mod: mkPane(cardsSec), log: mkPane(asRunSec) };
    const TABS = [["live", "tabLive"], ["plan", "tabPlan"], ["list", "tabList"], ["trans", "tabTrans"], ["mod", "tabMod"], ["log", "tabLog"]];
    const tabKey = `omp-radio-tab-${nodeId}`;
    let tab = (() => { try { const v = localStorage.getItem(tabKey); return TABS.some(([k]) => k === v) ? v : "live"; } catch { return "live"; } })();
    const tabBtns = {}, tabMk = {}, tabCnt = {};
    const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": T("tabsLabel") }, ...TABS.map(([k, lab]) => {
      tabMk[k] = h("span", { class: "mk" }); tabCnt[k] = h("span", { class: "cnt" });
      tabBtns[k] = h("button", { role: "tab", onclick: () => selectTab(k) }, T(lab), tabMk[k], tabCnt[k]); return tabBtns[k];
    }));
    const selectTab = (k) => { tab = k; try { localStorage.setItem(tabKey, k); } catch { /* ohne Speicher */ } updTabs(); };
    // Markierungen: ● = ungespeicherte/ungeladene Änderungen, Zahlen = Anzahl (Karten, Protokolleinträge)
    const updTabs = () => {
      for (const [k] of TABS) { const on = k === tab; panes[k].style.display = on ? "" : "none"; tabBtns[k].className = on ? "on" : ""; tabBtns[k].setAttribute("aria-selected", on ? "true" : "false"); }
      tabMk.plan.textContent = typeof showDirty !== "undefined" && showDirty ? "●" : "";
      tabMk.list.textContent = dirty ? "●" : "";
      tabCnt.mod.textContent = cards.length ? String(cards.length) : "";
      tabCnt.log.textContent = asRun.length ? String(asRun.length) : "";
    };
    shadow.addEventListener("contextmenu", (e) => { if (e.target && e.target.closest && e.target.closest("button")) e.preventDefault(); });
    shadow.append(h("style", {}, STYLE), banner, tp, head, tabBar, panes.live, panes.plan, panes.list, panes.trans, panes.mod, panes.log);
    updTabs();
    renderRows(); renderPlan(); renderAsRun(); renderNow(); renderConsole(); renderCarts(); renderCards(); renderShowBar(); loadWeek(); refreshShows().then(async () => { const c = await api("GET", API + "/current"); if (c && c.show && c.show.status === "live" && !curShow) { showSel.value = c.show.id; await openShow(c.show.id); } });

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
        const [v, a, e, t, la, lg, al, alm, als] = await Promise.all(["view", "asRun", "lastError", "target", "lookaheadMs", "log", "autoLoad", "autoLeadMs", "autoStatus"].map(getParam));
        if (al !== undefined) { if (document.activeElement !== autoChk) autoChk.checked = !!al; if (document.activeElement !== autoLead && alm) autoLead.value = String(alm / 60000); autoSt.textContent = als || ""; }
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
        fillTargets(); renderPlan(); renderAsRun(); renderNow(); renderConsole(); updateTimes(); if (!cartsEdit) renderCarts(); updTabs();
      } catch { /* nächster Takt */ }
    };
    loadTargets().then(poll);
    this._i1 = setInterval(poll, 1000);
    this._i2 = setInterval(loadTargets, 15000);
  }
  disconnectedCallback() { clearInterval(this._i1); clearInterval(this._i2); }
}
if (!customElements.get("omp-radio-automation-panel")) customElements.define("omp-radio-automation-panel", OmpRadioAutomationPanel);
