// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
      "v:unbekannt": "unbekannt",
      "v:innerhalb EBU R 37": "innerhalb EBU R 37",
      "v:außerhalb EBU R 37": "außerhalb EBU R 37",
      "v:R 128 erfüllt": "R 128 erfüllt",
      "v:True Peak über −1 dBTP": "True Peak über −1 dBTP",
      "v:Lautheit außerhalb −23 ±0,5 LUFS": "Lautheit außerhalb −23 ±0,5 LUFS",
        "scp.d7607a": "Waveform / Vektorskop",
        "scp.a00fa5": "kein Video verbunden",
        "scp.18f42a": "kein Video-/Audio-Paar verbunden",
        "scp.30b199": "Ton hinkt nach",
        "scp.dede84": "Ton eilt vor",
        "scp.3203b1": "Quellgruppe unbekannt",
        "scp.003b20": "Schwarzbild",
        "scp.bdaf0f": "Standbild",
        "scp.a0a083": "Stille",
        "scp.c0483b": "Peak/RMS",
        "scp.be6369": "Momentary (LUFS)",
        "scp.1b4389": "Short-term (LUFS)",
        "scp.2c93be": "Integrated (LUFS)",
        "scp.fb92f2": "Range (LU)",
        "scp.4dcc6f": "True Peak (dBTP)",
        "scp.f696ab": "Block-Peak (dBFS)",
        "scp.34e2d1": "Video",
        "scp.b22f04": "Audio",
        "scp.d7b569": "Latenz (Ist)",
        "scp.84ac4b": "Latenz (Mittel)",
        "scp.acf986": "Latenz min/max",
        "scp.3c813e": "Jitter (Spitze-Spitze)",
        "scp.9c043c": "Kadenz Ist/Soll",
        "scp.281d47": "Grains",
        "scp.72355f": "Diskontinuitäten",
        "scp.653c19": "Flow-Deklaration",
        "scp.5f23a4": "Media-Type",
        "scp.dcb66f": "Rate",
        "scp.30507b": "Bittiefe",
        "scp.45cef4": "Kanäle",
        "scp.e32d85": "Farbraum",
        "scp.85069b": "Abtastraster",
        "scp.2d0160": "Grain-Größe",
        "scp.ebace4": "Datenrate",
        "scp.75d289": "Grouphint",
        "scp.01ef6b": "Gemessen",
        "scp.5a597b": "Wert",
        "scp.faeae5": "Video-Quelle",
        "scp.711cd6": "Auflösung",
        "scp.04a23f": "Framerate (Quelle)",
        "scp.e666a2": "Framerate (gemessen)",
        "scp.e3246d": "Mittleres Luma",
        "scp.97b764": "Bilddifferenz",
        "scp.6d7bfd": "Audio-Quelle",
        "scp.0ab6cb": "Abtastrate",
        "scp.f488c4": "· aus MXL-Ursprungszeitstempeln",
        "scp.ee42eb": "Signalüberwachung",
        "scp.e71d24": "Audio-Pegel",
        "scp.00f47c": "Lautheit (EBU R 128)",
        "scp.d00749": "· gemessen am Tap · negativ = Schreiber stempelt in die Zukunft",
        "scp.42889b": "· wie der Schreiber ihn deklariert",
        "scp.4a876b": "Gemessene Werte",
        "scp.060af1": "unauffällig",
        "scp.ac4b1a": "{p0} Bilder · ",
        "scp.4b686e": "Ton eilt dem Bild voraus",
        "scp.3e11ba": "Ton hinkt dem Bild nach",
        "scp.caca19": "gleiche Quellgruppe",
        "scp.086fb1": "verschiedene Quellgruppen",
        "scp.0a6161": "Die NMOS-Grouphints der beiden Flows nennen verschiedene Gruppen. Bei OMP-eigenen Quellen ist das derzeit immer so: deren MXL-Schreiber verwenden die jeweilige Flow-ID als Gruppennamen, statt Video und Audio einer Quelle derselben Gruppe zuzuordnen.",
        "scp.08fd3e": "nicht verbunden",
        "scp.tab.ov": "Übersicht",
        "scp.tab.video": "Video",
        "scp.tab.audio": "Audio",
        "scp.tab.timing": "Timing",
        "scp.tab.flow": "Flow",
        "scp.tab.anc": "ANC",
        "scp.tab.scte": "SCTE",
        "scp.ov.sources": "Quellen",
        "scp.ov.alarms": "Signalüberwachung",
        "scp.ov.checks": "Prüfungen",
        "scp.ov.lipsync": "Lipsync",
        "scp.ov.loud": "Lautheit",
        "scp.ov.anc": "ANC-Daten",
        "scp.ov.scte": "SCTE-Marker",
        "scp.ov.go": "Details",
        "scp.src.video": "Video",
        "scp.src.audio": "Audio",
        "scp.src.anc": "ANC / SCTE",
        "scp.src.none": "nicht verbunden",
        "scp.hint.video": "Kein Video verbunden. Im Flow-Editor einen Video-Sender auf den Empfänger „Video“ dieses Messgeräts ziehen.",
        "scp.hint.audio": "Kein Audio verbunden. Im Flow-Editor einen Audio-Sender auf den Empfänger „Audio“ ziehen.",
        "scp.hint.anc": "Kein ANC-Flow verbunden. Einen Daten-Sender (Untertitel, SCTE 104) auf den Empfänger „ANC / SCTE“ ziehen.",
        "scp.hint.timing": "Lipsync braucht Video und Audio. Transportwerte erscheinen, sobald der jeweilige Flow läuft.",
        "scp.scte.all": "Alle",
        "scp.scte.in": "SCTE-35-Abschnitt von Hand prüfen",
        "scp.scte.udp": "Rohe SCTE-35-Abschnitte per UDP: Option „SCTE-35-Eingang (UDP)“ des Messgeräts.",
        "scp.ok": "in Ordnung",
        "scp.alarm": "Alarm",
        "scp.messages": "Nachrichten",
        "scp.anc.title": "ANC / Daten",
        "scp.anc.hint": "· jeder Pakettyp, SCTE 104/35",
        "scp.anc.none": "kein ANC-Flow verbunden",
        "scp.anc.status": "{p0} Bilder · {p1} Pakete · {p2} Pakete/s",
        "scp.anc.empty": "leere Bilder",
        "scp.anc.gaps": "Lücken", "scp.anc.tc": "Zeitcode", "scp.anc.tcjumps": "Sprünge", "scp.anc.tcinvalid": "ungültig",
        "scp.anc.typ": "Typ",
        "scp.anc.count": "Anzahl",
        "scp.anc.rate": "/s",
        "scp.anc.pos": "Zeile/Offset",
        "scp.anc.err": "Fehler",
        "scp.anc.errors": "Fehler und Warnungen",
        "scp.anc.noerr": "keine",
        "scp.anc.scte": "SCTE-Ablauf",
        "scp.anc.scteNone": "noch keine SCTE-Nachricht",
        "scp.anc.scteIn": "SCTE-35-Abschnitt prüfen (Hex oder Base64)",
        "scp.anc.decode": "Prüfen",
        "scp.anc.dup": "Duplikat",
        "scp.anc.bad": "Eingabe ist weder Hex noch Base64",
        "scp.anc.recent": "Letzte Pakete"
    },
    en: {
      "v:unbekannt": "unknown",
      "v:innerhalb EBU R 37": "within EBU R 37",
      "v:außerhalb EBU R 37": "outside EBU R 37",
      "v:R 128 erfüllt": "R 128 met",
      "v:True Peak über −1 dBTP": "True peak above −1 dBTP",
      "v:Lautheit außerhalb −23 ±0,5 LUFS": "Loudness outside −23 ±0.5 LUFS",
        "scp.d7607a": "Waveform / Vectorscope",
        "scp.a00fa5": "no video connected",
        "scp.18f42a": "no video/audio pair connected",
        "scp.30b199": "Audio lags",
        "scp.dede84": "Audio leads",
        "scp.3203b1": "Source group unknown",
        "scp.003b20": "Black picture",
        "scp.bdaf0f": "Frozen picture",
        "scp.a0a083": "Silence",
        "scp.c0483b": "Peak/RMS",
        "scp.be6369": "Momentary (LUFS)",
        "scp.1b4389": "Short-term (LUFS)",
        "scp.2c93be": "Integrated (LUFS)",
        "scp.fb92f2": "Range (LU)",
        "scp.4dcc6f": "True Peak (dBTP)",
        "scp.f696ab": "Block peak (dBFS)",
        "scp.34e2d1": "Video",
        "scp.b22f04": "Audio",
        "scp.d7b569": "Latency (actual)",
        "scp.84ac4b": "Latency (mean)",
        "scp.acf986": "Latency min/max",
        "scp.3c813e": "Jitter (peak-to-peak)",
        "scp.9c043c": "Cadence actual/target",
        "scp.281d47": "Grains",
        "scp.72355f": "Discontinuities",
        "scp.653c19": "Flow declaration",
        "scp.5f23a4": "Media type",
        "scp.dcb66f": "Rate",
        "scp.30507b": "Bit depth",
        "scp.45cef4": "Channels",
        "scp.e32d85": "Colour space",
        "scp.85069b": "Sampling raster",
        "scp.2d0160": "Grain size",
        "scp.ebace4": "Data rate",
        "scp.75d289": "Group hint",
        "scp.01ef6b": "Measured",
        "scp.5a597b": "Value",
        "scp.faeae5": "Video source",
        "scp.711cd6": "Resolution",
        "scp.04a23f": "Frame rate (source)",
        "scp.e666a2": "Frame rate (measured)",
        "scp.e3246d": "Mean luma",
        "scp.97b764": "Picture difference",
        "scp.6d7bfd": "Audio source",
        "scp.0ab6cb": "Sample rate",
        "scp.f488c4": "· from MXL origin timestamps",
        "scp.ee42eb": "Signal monitoring",
        "scp.e71d24": "Audio level",
        "scp.00f47c": "Loudness (EBU R 128)",
        "scp.d00749": "· measured at the tap · negative = writer stamps into the future",
        "scp.42889b": "· as declared by the writer",
        "scp.4a876b": "Measured values",
        "scp.060af1": "unremarkable",
        "scp.ac4b1a": "{p0} frames · ",
        "scp.4b686e": "Audio leads the picture",
        "scp.3e11ba": "Audio lags the picture",
        "scp.caca19": "same source group",
        "scp.086fb1": "different source groups",
        "scp.0a6161": "The NMOS group hints of the two flows name different groups. For OMP's own sources this is currently always the case: their MXL writers use the respective flow ID as group name instead of assigning video and audio of a source to the same group.",
        "scp.08fd3e": "not connected",
        "scp.tab.ov": "Overview",
        "scp.tab.video": "Video",
        "scp.tab.audio": "Audio",
        "scp.tab.timing": "Timing",
        "scp.tab.flow": "Flow",
        "scp.tab.anc": "ANC",
        "scp.tab.scte": "SCTE",
        "scp.ov.sources": "Sources",
        "scp.ov.alarms": "Signal monitoring",
        "scp.ov.checks": "Checks",
        "scp.ov.lipsync": "Lip sync",
        "scp.ov.loud": "Loudness",
        "scp.ov.anc": "ANC data",
        "scp.ov.scte": "SCTE markers",
        "scp.ov.go": "Details",
        "scp.src.video": "Video",
        "scp.src.audio": "Audio",
        "scp.src.anc": "ANC / SCTE",
        "scp.src.none": "not connected",
        "scp.hint.video": "No video connected. In the flow editor, drag a video sender onto this meter's “Video” receiver.",
        "scp.hint.audio": "No audio connected. In the flow editor, drag an audio sender onto the “Audio” receiver.",
        "scp.hint.anc": "No ANC flow connected. Drag a data sender (subtitles, SCTE 104) onto the “ANC / SCTE” receiver.",
        "scp.hint.timing": "Lip sync needs video and audio. Transport values appear as soon as the respective flow runs.",
        "scp.scte.all": "All",
        "scp.scte.in": "Check an SCTE-35 section by hand",
        "scp.scte.udp": "Raw SCTE-35 sections via UDP: meter option “SCTE-35 input (UDP)”.",
        "scp.ok": "ok",
        "scp.alarm": "alarm",
        "scp.messages": "messages",
        "scp.anc.title": "ANC / data",
        "scp.anc.hint": "· every packet type, SCTE 104/35",
        "scp.anc.none": "no ANC flow connected",
        "scp.anc.status": "{p0} frames · {p1} packets · {p2} packets/s",
        "scp.anc.empty": "empty frames",
        "scp.anc.gaps": "gaps", "scp.anc.tc": "Timecode", "scp.anc.tcjumps": "jumps", "scp.anc.tcinvalid": "invalid",
        "scp.anc.typ": "Type",
        "scp.anc.count": "Count",
        "scp.anc.rate": "/s",
        "scp.anc.pos": "Line/offset",
        "scp.anc.err": "Errors",
        "scp.anc.errors": "Errors and warnings",
        "scp.anc.noerr": "none",
        "scp.anc.scte": "SCTE log",
        "scp.anc.scteNone": "no SCTE message yet",
        "scp.anc.scteIn": "Check an SCTE-35 section (hex or base64)",
        "scp.anc.decode": "Check",
        "scp.anc.dup": "duplicate",
        "scp.anc.bad": "input is neither hex nor base64",
        "scp.anc.recent": "Latest packets"
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();
// Urteile kommen deutsch aus dem Rust-Backend (qc.rs/timing.rs) — hier nur die Anzeige übersetzen.
const vt = (v) => { const k = "v:" + v; const r = T(k); return r === k ? v : r; };
const LOCALE = document.documentElement.lang === "en" ? "en-GB" : "de-DE";

// Node-UI-Bundle von omp-scope: kombiniertes Waveform/Vektorskop-Bild
// als <img> (identisches Einzelbild-Polling-Muster wie
// omp-viewer/ui/bundle.js — img.complete-Check vor jedem src-Neusetzen,
// s. dortigen Kommentar zum 2026-08-21 per CDP root-caused Chrome-
// multipart/x-mixed-replace-Wegfall), Peak/RMS über <omp-meter> (aus
// ui/kit, global von der Shell registriert) per SSE — und alle übrigen
// Messwerte aus EINEM Sammel-Abruf pro Sekunde.
//
// Warum der Sammel-Abruf (GET /api/v1/nodes/<id>/measurements, seit
// Nachtrag 226): dieser Node beschreibt über 50 Messparameter. Die
// vorige Fassung holte 12 davon einzeln per GET /params/<name>; mit
// Timing-, QC- und Flow-Werten wären daraus über 50 HTTP-Anfragen pro
// Sekunde und geöffnetem Panel geworden. Der Sammel-Endpunkt liefert
// dieselben Werte (er wird im Node aus genau denselben get()-Aufrufen
// erzeugt) in einer Anfrage. Die Einzelparameter bleiben unangetastet,
// dieses Panel nutzt sie nur nicht mehr.
class OmpScopePanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      img {
        display: block; width: 100%; max-width: 480px; background: #000;
        border: 1px solid #444;
      }
      p.status { font-size: 12px; color: #888; }
      h4 {
        margin: 14px 0 6px 0; font-size: 11px; color: #9aa; font-weight: 600;
        text-transform: uppercase; letter-spacing: .06em;
      }
      h4 .hint { text-transform: none; letter-spacing: 0; color: #666; font-weight: 400; }
      .meter-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .meter-row .label { font-size: 11px; width: 60px; }
      /* Das Kit-Meter bringt 160px Eigenhöhe mit (ui/kit/omp-meter.ts).
         In einer 420px schmalen Node-Panel-Spalte ist das eine sehr hohe,
         fast leere Säule zwischen zwei dichten Messblöcken — hier auf
         110px gekürzt. Eine Regel von außen auf das Element schlägt
         dessen :host-Regel, ohne das Kit-Element selbst zu ändern (das
         wird an anderer Stelle in voller Höhe gebraucht). */
      omp-meter { height: 110px; }
      table { border-collapse: collapse; width: 100%; font-size: 11px; }
      table td, table th { padding: 2px 4px; border-bottom: 1px solid #333; }
      table td:first-child, table th:first-child { color: #999; white-space: nowrap; text-align: left; font-weight: 400; }
      table td:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
      table th:not(:first-child) { text-align: right; color: #9aa; font-size: 10px; }
      .lufs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 11px; }
      .lufs-grid .value { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .lufs-grid .caption { color: #999; }

      /* Lipsync-Block */
      .sync { background: #16181d; border: 1px solid #2a2f37; border-radius: 6px; padding: 10px; }
      .sync .big {
        font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums;
        line-height: 1.05; text-align: center;
      }
      .sync .sub { text-align: center; font-size: 11px; color: #9aa; margin-top: 2px; }
      .sync .scale {
        position: relative; height: 16px; margin: 12px 2px 4px 2px;
        background: #3a1d1f; border-radius: 3px; overflow: hidden;
      }
      .sync .inspec { position: absolute; top: 0; bottom: 0; background: #1d3a24; }
      .sync .zero { position: absolute; top: 0; bottom: 0; width: 1px; background: #666; }
      .sync .marker {
        position: absolute; top: -3px; width: 3px; height: 22px; border-radius: 2px;
        background: #eee; box-shadow: 0 0 4px #000; transition: left .25s ease-out;
      }
      .sync .ticks { display: flex; justify-content: space-between; font-size: 9px; color: #777; }
      .badge {
        display: inline-block; padding: 2px 7px; border-radius: 10px;
        font-size: 10px; font-weight: 600;
      }
      .badge.ok { background: #16301d; color: #4ec36f; border: 1px solid #2c5a38; }
      .badge.bad { background: #3a1d1f; color: #ff7b72; border: 1px solid #6b2c2f; }
      .badge.idle { background: #23262c; color: #9aa; border: 1px solid #343941; }
      .badge.warn { background: #33280f; color: #e3b341; border: 1px solid #6b5420; }
      .center { text-align: center; margin-top: 8px; }

      /* QC-Alarme */
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        flex: 1 1 110px; padding: 6px 8px; border-radius: 5px; font-size: 11px;
        border: 1px solid #343941; background: #23262c; color: #9aa;
      }
      .chip.alarm { border-color: #6b2c2f; background: #3a1d1f; color: #ff7b72; }
      .chip .title { font-weight: 600; display: block; }
      .chip .detail { font-size: 10px; opacity: .85; font-variant-numeric: tabular-nums; }

      /* ANC / SCTE */
      .anc-status { font-size: 11px; color: #9aa; margin: 2px 0 6px 0; }
      table.anc td, table.anc th { white-space: normal; }
      table.anc tr.sel td { background: #1c2230; }
      table.anc tr.type { cursor: pointer; }
      table.anc td.name { text-align: left; color: #ddd; }
      table.anc .std { color: #777; font-size: 9px; display: block; }
      table.anc .bad { color: #ff7b72; }
      .anc-detail, .scte-event { background: #16181d; border: 1px solid #2a2f37; border-radius: 5px; padding: 6px 8px; margin: 4px 0; font-size: 11px; }
      .anc-detail .t, .scte-event .t { font-weight: 600; color: #cdd; }
      .anc-detail .kv, .scte-event .kv { display: grid; grid-template-columns: max-content 1fr; gap: 1px 10px; margin: 3px 0 3px 8px; }
      .anc-detail .kv span:nth-child(odd), .scte-event .kv span:nth-child(odd) { color: #8a9; }
      .anc-detail .kv span:nth-child(even), .scte-event .kv span:nth-child(even) { word-break: break-word; font-variant-numeric: tabular-nums; }
      .scte-event .op { margin: 4px 0 2px 10px; padding-left: 8px; border-left: 2px solid #345; }
      .scte-event .warn, .anc-detail .warn { color: #e3b341; }
      .scte-event .src { color: #789; font-size: 10px; }
      .anc-errors { font-size: 11px; color: #e3b341; margin: 2px 0; }
      .anc-errors span.n { color: #999; }
      .scte-in { display: flex; gap: 4px; margin-top: 6px; }
      .scte-in input { flex: 1; min-width: 0; background: #0f1115; color: #eee; border: 1px solid #343941; border-radius: 4px; padding: 3px 6px; font-size: 11px; }
      .scte-in button { background: #23262c; color: #ddd; border: 1px solid #343941; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; }

      /* Tabs */
      .tabs {
        display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid #2a2f37;
        position: sticky; top: 0; background: #101216; z-index: 2; margin-bottom: 8px;
      }
      .tab {
        padding: 7px 10px; font-size: 12px; cursor: pointer; color: #9aa; background: none; border: none;
        border-bottom: 2px solid transparent; font-family: inherit;
      }
      .tab:hover { color: #dde; }
      .tab.active { color: #fff; border-bottom-color: #4ec3ff; font-weight: 600; }
      .tab .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 5px; vertical-align: middle; }
      .tab .dot.bad { background: #e5534b; }
      .tab .dot.warn { background: #e3b341; }
      .tab .dot.ok { background: #3fb950; }
      .pane[hidden] { display: none; }
      .hintbox { font-size: 11px; color: #9aa; background: #16181d; border: 1px dashed #343941; border-radius: 5px; padding: 8px 10px; margin: 6px 0; }
      .srcrow { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid #2a2f37; border-radius: 5px; margin: 3px 0; background: #16181d; font-size: 12px; }
      .srcrow .led { width: 9px; height: 9px; border-radius: 50%; background: #555; flex: none; }
      .srcrow.on .led { background: #3fb950; box-shadow: 0 0 5px #3fb95099; }
      .srcrow .k { color: #9aa; width: 78px; flex: none; }
      .srcrow .v { color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .card { border: 1px solid #343941; background: #23262c; border-radius: 5px; padding: 7px 9px; font-size: 11px; cursor: pointer; }
      .card .t { color: #9aa; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
      .card .v { font-size: 14px; font-weight: 600; color: #ddd; margin-top: 2px; }
      .card.ok { border-color: #2c5a38; background: #16301d; }
      .card.ok .v { color: #4ec36f; }
      .card.bad { border-color: #6b2c2f; background: #3a1d1f; }
      .card.bad .v { color: #ff7b72; }
      .card.warn { border-color: #6b5420; background: #33280f; }
      .card.warn .v { color: #e3b341; }
      .filters { display: flex; gap: 4px; margin: 4px 0 6px; }
      .filters button { background: #23262c; color: #aab; border: 1px solid #343941; border-radius: 12px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
      .filters button.on { background: #1d3050; color: #fff; border-color: #3b6ea8; }
      details.scte-event > summary { cursor: pointer; list-style: none; }
      details.scte-event > summary::-webkit-details-marker { display: none; }
      details.scte-event > summary .sum { color: #cdd; font-weight: 600; }
      details.scte-event > summary .brief { color: #9ab; font-size: 10px; display: block; margin-top: 1px; }
    `;

    const token = localStorage.getItem("omp-auth-token");
    const withToken = (base) => (token ? `${base}${base.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : base);

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    // --- Scope-Bild (Waveform + Vektorskop) ---
    const img = document.createElement("img");
    img.alt = T("scp.d7607a");
    img.style.display = "none";
    const status = document.createElement("p");
    status.className = "status";
    status.textContent = "lade Messbild …";
    img.addEventListener("load", () => {
      status.style.display = "none";
      img.style.display = "";
    });
    img.addEventListener("error", () => {
      img.style.display = "none";
      status.textContent = T("scp.a00fa5");
      status.style.display = "";
    });
    const previewUrl = () => withToken(`/api/v1/nodes/${nodeId}/stream/previewUrl?_=${Date.now()}`);
    img.src = previewUrl();
    this._previewInterval = setInterval(() => {
      // Das Messbild wird nur geholt, solange der Tab „Video“ offen ist (spart Last auf Node und Orchestrator).
      if (!img.complete || this._tab !== "video") return;
      img.src = previewUrl();
    }, 200);

    // --- Hilfsfunktionen ---
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const fmt = (v, digits = 1, unit = "") => {
      const n = num(v);
      return n === undefined ? "–" : `${n.toFixed(digits)}${unit ? " " + unit : ""}`;
    };
    const signed = (v, digits = 1, unit = "") => {
      const n = num(v);
      if (n === undefined) return "–";
      return `${n > 0 ? "+" : ""}${n.toFixed(digits)}${unit ? " " + unit : ""}`;
    };
    const int = (v) => (typeof v === "number" ? v.toLocaleString("de-DE") : "–");
    const section = (title, hint) => {
      const h = document.createElement("h4");
      h.textContent = title;
      if (hint) {
        const span = document.createElement("span");
        span.className = "hint";
        span.textContent = ` ${hint}`;
        h.appendChild(span);
      }
      return h;
    };

    // --- A/V-Timing (Lipsync) ---
    // Skala: −150 … +150 ms, mit dem nach EBU R 37 zulässigen Fenster
    // (Ton höchstens 40 ms vor, höchstens 60 ms nach dem Bild) als
    // grünem Band. Bewusst asymmetrisch gezeichnet, weil die Norm es ist.
    const SCALE_MIN = -150;
    const SCALE_MAX = 150;
    const SPEC_LEAD = 40;
    const SPEC_LAG = -60;
    const pct = (ms) => ((Math.min(SCALE_MAX, Math.max(SCALE_MIN, ms)) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;

    const syncBox = document.createElement("div");
    syncBox.className = "sync";
    const syncBig = document.createElement("div");
    syncBig.className = "big";
    syncBig.textContent = "–";
    const syncSub = document.createElement("div");
    syncSub.className = "sub";
    syncSub.textContent = T("scp.18f42a");
    const scale = document.createElement("div");
    scale.className = "scale";
    const inspec = document.createElement("div");
    inspec.className = "inspec";
    inspec.style.left = `${pct(SPEC_LAG)}%`;
    inspec.style.width = `${pct(SPEC_LEAD) - pct(SPEC_LAG)}%`;
    const zero = document.createElement("div");
    zero.className = "zero";
    zero.style.left = `${pct(0)}%`;
    const marker = document.createElement("div");
    marker.className = "marker";
    marker.style.left = `${pct(0)}%`;
    marker.style.display = "none";
    scale.append(inspec, zero, marker);
    const ticks = document.createElement("div");
    ticks.className = "ticks";
    for (const label of [T("scp.30b199"), "0", T("scp.dede84")]) {
      const span = document.createElement("span");
      span.textContent = label;
      ticks.appendChild(span);
    }
    const syncBadgeWrap = document.createElement("div");
    syncBadgeWrap.className = "center";
    const syncBadge = document.createElement("span");
    syncBadge.className = "badge idle";
    syncBadge.textContent = vt("unbekannt");
    const groupBadge = document.createElement("span");
    groupBadge.className = "badge idle";
    groupBadge.style.marginLeft = "6px";
    groupBadge.textContent = T("scp.3203b1");
    syncBadgeWrap.append(syncBadge, groupBadge);
    syncBox.append(syncBig, syncSub, scale, ticks, syncBadgeWrap);

    // --- QC-Alarme ---
    const chips = document.createElement("div");
    chips.className = "chips";
    const makeChip = (title) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      const t = document.createElement("span");
      t.className = "title";
      t.textContent = title;
      const d = document.createElement("span");
      d.className = "detail";
      d.textContent = "–";
      chip.append(t, d);
      chips.appendChild(chip);
      return { chip, detail: d };
    };
    const blackChip = makeChip(T("scp.003b20"));
    const freezeChip = makeChip(T("scp.bdaf0f"));
    const silenceChip = makeChip(T("scp.a0a083"));

    // --- Audio-Pegel ---
    const meterRow = document.createElement("div");
    meterRow.className = "meter-row";
    const meterLabel = document.createElement("span");
    meterLabel.className = "label";
    meterLabel.textContent = T("scp.c0483b");
    const meter = document.createElement("omp-meter");
    meterRow.append(meterLabel, meter);

    getParam("levelsUrl").then((url) => {
      if (!url) return;
      this._levelsSource = new EventSource(withToken(`/api/v1/nodes/${nodeId}/stream/levelsUrl`));
      this._levelsSource.onmessage = (ev) => {
        let parsed;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        meter.value = parsed.rms;
        meter.peak = parsed.peak;
      };
    });

    // --- EBU R 128 Lautheit ---
    const lufsGrid = document.createElement("div");
    lufsGrid.className = "lufs-grid";
    const lufsCell = (caption) => {
      const wrap = document.createElement("div");
      const value = document.createElement("div");
      value.className = "value";
      value.textContent = "–";
      const cap = document.createElement("div");
      cap.className = "caption";
      cap.textContent = caption;
      wrap.append(value, cap);
      lufsGrid.appendChild(wrap);
      return value;
    };
    const momentaryEl = lufsCell(T("scp.be6369"));
    const shortTermEl = lufsCell(T("scp.1b4389"));
    const integratedEl = lufsCell(T("scp.2c93be"));
    const rangeEl = lufsCell(T("scp.fb92f2"));
    const truePeakEl = lufsCell(T("scp.4dcc6f"));
    const blockPeakEl = lufsCell(T("scp.f696ab"));
    const r128Wrap = document.createElement("div");
    r128Wrap.className = "center";
    const r128Badge = document.createElement("span");
    r128Badge.className = "badge idle";
    r128Badge.textContent = vt("unbekannt");
    r128Wrap.appendChild(r128Badge);

    // --- Tabellen (Transport / Flow-Deklaration / gemessene Werte) ---
    const twoColTable = (headers) => {
      const table = document.createElement("table");
      const head = document.createElement("tr");
      for (const h of headers) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
      }
      table.appendChild(head);
      const rows = {};
      const row = (label, count) => {
        const tr = document.createElement("tr");
        const td1 = document.createElement("td");
        td1.textContent = label;
        tr.appendChild(td1);
        const cells = [];
        for (let i = 0; i < count; i++) {
          const td = document.createElement("td");
          td.textContent = "–";
          tr.appendChild(td);
          cells.push(td);
        }
        table.appendChild(tr);
        rows[label] = cells;
      };
      return { table, rows, row };
    };

    const transport = twoColTable(["MXL-Transport", T("scp.34e2d1"), T("scp.b22f04")]);
    for (const label of [T("scp.d7b569"), T("scp.84ac4b"), T("scp.acf986"), T("scp.3c813e"), T("scp.9c043c"), T("scp.281d47"), "ausgelassen", T("scp.72355f")]) {
      transport.row(label, 2);
    }

    const decl = twoColTable([T("scp.653c19"), T("scp.34e2d1"), T("scp.b22f04")]);
    for (const label of [T("scp.5f23a4"), T("scp.dcb66f"), T("scp.30507b"), T("scp.45cef4"), T("scp.e32d85"), T("scp.85069b"), T("scp.2d0160"), T("scp.ebace4"), T("scp.75d289")]) {
      decl.row(label, 2);
    }

    const measured = twoColTable([T("scp.01ef6b"), T("scp.5a597b")]);
    for (const label of [T("scp.faeae5"), T("scp.711cd6"), T("scp.04a23f"), T("scp.e666a2"), T("scp.e3246d"), T("scp.97b764"), T("scp.6d7bfd"), T("scp.0ab6cb"), T("scp.45cef4")]) {
      measured.row(label, 1);
    }

    // --- ANC / SCTE ---
    const ancTc = document.createElement("div");
    ancTc.style.cssText = "font:600 28px monospace;letter-spacing:1px;margin:4px 0;display:none";
    const ancStatus = document.createElement("div");
    ancStatus.className = "anc-status";
    const ancTable = document.createElement("table");
    ancTable.className = "anc";
    const ancDetail = document.createElement("div");
    const ancErrors = document.createElement("div");
    ancErrors.className = "anc-errors";
    const scteLog = document.createElement("div");
    const scteIn = document.createElement("div");
    scteIn.className = "scte-in";
    const scteInput = document.createElement("input");
    scteInput.placeholder = T("scp.anc.scteIn");
    const scteBtn = document.createElement("button");
    scteBtn.textContent = T("scp.anc.decode");
    scteIn.append(scteInput, scteBtn);
    scteBtn.addEventListener("click", async () => {
      const text = scteInput.value.trim();
      if (!text) return;
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/scte35Input`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: text }),
      });
      if (!res.ok) scteInput.title = T("scp.anc.bad");
      else scteInput.value = "";
      refresh();
    });
    let ancSelected = null;
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const scteStat = el("div", "anc-status");
    let scteFilter = "all";
    const filters = el("div", "filters");
    const filterBtns = {};
    for (const [k, label] of [["all", T("scp.scte.all")], ["104", "SCTE 104"], ["35", "SCTE 35"]]) {
      const b = el("button", k === "all" ? "on" : "", label);
      b.addEventListener("click", () => {
        scteFilter = k;
        for (const [kk, bb] of Object.entries(filterBtns)) bb.className = kk === k ? "on" : "";
        if (lastAnc) renderAnc(lastAnc);
      });
      filterBtns[k] = b;
      filters.appendChild(b);
    }
    const collectWarnings = (d) => d.warnings.concat(...d.children.map(collectWarnings));
    const shortTitle = (d) => d.title.replace("SCTE 104 ", "").replace("SCTE 35 ", "").replace("multiple_operation_message", "multiple operation").replace("splice_info_section", "splice info");
    const BRIEF_KEYS = ["splice_insert_type", "out_of_network_indicator", "splice_event_id", "segmentation_type_id", "pre_roll_time", "break_duration", "segmentation_duration", "pts_time"];
    const briefOf = (d) => {
      const found = {};
      const walk = (x) => {
        for (const [k, v] of x.fields) if (BRIEF_KEYS.includes(k) && !(k in found)) found[k] = v;
        x.children.forEach(walk);
      };
      walk(d);
      return BRIEF_KEYS.filter((k) => k in found).map((k) => `${found[k]}`.replace(/ \(.*$/, (m) => (k === "segmentation_type_id" || k === "splice_insert_type" || k === "out_of_network_indicator" ? m : ""))).join(" · ");
    };
    const renderDecoded = (d, container, top) => {
      const box = el("div", top ? "" : "op");
      box.appendChild(el("div", "t", d.title));
      if (d.fields.length) {
        const kv = el("div", "kv");
        for (const [k, v] of d.fields) kv.append(el("span", "", k), el("span", "", v));
        box.appendChild(kv);
      }
      for (const w of d.warnings) box.appendChild(el("div", "warn", "⚠ " + w));
      for (const c of d.children) renderDecoded(c, box, false);
      container.appendChild(box);
    };
    const hex2 = (n) => "0x" + Number(n).toString(16).toUpperCase().padStart(2, "0");
    const renderAnc = (r) => {
      if (!r) return;
      if (!r.connected) ancStatus.textContent = T("scp.anc.none");
      else {
        ancStatus.textContent = T("scp.anc.status", { p0: int(r.frames), p1: int(r.packets), p2: fmt(r.packetsPerSec, 1) }) +
          ` · ${T("scp.anc.empty")} ${int(r.emptyFrames)} · ${T("scp.anc.gaps")} ${int(r.indexGaps)}`;
      }
      // Zeitcode (ST 12-2): große Anzeige, Sprünge/ungültig in Rot
      const tc = r.timecode;
      if (tc && tc.present) {
        ancTc.style.display = "";
        ancTc.dataset.role = "anc-timecode";
        ancTc.replaceChildren(`${T("scp.anc.tc")} ${tc.value}`);
        if (tc.jumps || tc.invalid) {
          const w = el("span", "warn", ` ⚠ ${T("scp.anc.tcjumps")} ${int(tc.jumps)} · ${T("scp.anc.tcinvalid")} ${int(tc.invalid)}`);
          w.style.fontSize = "12px";
          ancTc.appendChild(w);
        }
      } else ancTc.style.display = "none";
      // Typ-Tabelle
      ancTable.replaceChildren();
      const head = el("tr");
      for (const h of [T("scp.anc.typ"), "DID/SDID", T("scp.anc.count"), T("scp.anc.rate"), T("scp.anc.pos"), "DC", T("scp.anc.err")]) head.appendChild(el("th", "", h));
      ancTable.appendChild(head);
      for (const t of r.types) {
        const tr = el("tr", "type" + (ancSelected === `${t.did}/${t.sdid}` ? " sel" : ""));
        const name = el("td", "name", t.name);
        name.appendChild(el("span", "std", t.standard));
        const errs = t.parityErrors + t.checksumErrors + (t.seqGaps || 0);
        const e = el("td", errs ? "bad" : "", errs ? `${t.parityErrors}P ${t.checksumErrors}C${t.seqGaps ? " " + t.seqGaps + "S" : ""}` : "0");
        tr.append(name, el("td", "", `${hex2(t.did)}/${hex2(t.sdid)}`), el("td", "", int(t.count)), el("td", "", t.active ? fmt(t.perSec, 1) : "–"),
          el("td", "", `${t.line}/${t.offset} ${t.channel[0]}`), el("td", "", t.dcMin === t.dcMax ? `${t.dcMax}` : `${t.dcMin}–${t.dcMax}`), e);
        tr.addEventListener("click", () => { ancSelected = ancSelected === `${t.did}/${t.sdid}` ? null : `${t.did}/${t.sdid}`; renderAnc(lastAnc); });
        ancTable.appendChild(tr);
      }
      // Detail des gewählten Typs
      ancDetail.replaceChildren();
      const sel = r.types.find((t) => `${t.did}/${t.sdid}` === ancSelected);
      if (sel && sel.decoded) {
        const box = el("div", "anc-detail");
        renderDecoded(sel.decoded, box, true);
        ancDetail.appendChild(box);
      }
      // Fehler
      ancErrors.replaceChildren();
      if (r.errors.length) for (const e of r.errors) {
        const line = el("div", "", "⚠ " + e.message + " ");
        line.appendChild(el("span", "n", `×${e.count}`));
        ancErrors.appendChild(line);
      }
      // SCTE-Ablauf
      scteLog.replaceChildren();
      const sc = r.scte;
      scteStat.textContent = `SCTE 104: ${int(sc.messages104)} · SCTE 35: ${int(sc.sections35)} · ${T("scp.anc.err")}: ${int(sc.errors104 + sc.errors35)}`;
      const evs = sc.events.filter((ev) => scteFilter === "all" || (scteFilter === "104" ? ev.source.includes("104") : ev.source.includes("35")));
      if (!evs.length) scteLog.appendChild(el("div", "hintbox", T("scp.anc.scteNone")));
      evs.forEach((ev, i) => {
        const box = el("details", "scte-event");
        if (i < 2) box.open = true;
        const sum = el("summary");
        const when = new Date(ev.atMs).toLocaleTimeString(LOCALE) + "." + String(ev.atMs % 1000).padStart(3, "0");
        sum.appendChild(el("div", "src", `${when} · ${ev.source}${ev.duplicate ? " · " + T("scp.anc.dup") : ""}${ev.line != null ? " · L" + ev.line : ""}`));
        const warnN = collectWarnings(ev.decoded).length;
        sum.appendChild(el("span", "sum", (warnN ? "⚠ " : "") + shortTitle(ev.decoded)));
        const brief = briefOf(ev.decoded);
        if (brief) sum.appendChild(el("span", "brief", brief));
        box.appendChild(sum);
        renderDecoded(ev.decoded, box, true);
        scteLog.appendChild(box);
      });
    };
    let lastAnc = null;

    // --- Tabs ---------------------------------------------------------------
    const hintBox = (key) => el("div", "hintbox", T(key));
    const hintVideo = hintBox("scp.hint.video");
    const hintAudio = hintBox("scp.hint.audio");
    const hintAnc = hintBox("scp.hint.anc");
    const hintScte = hintBox("scp.hint.anc");
    const hintTiming = hintBox("scp.hint.timing");

    // Übersicht: Quellen, Alarme, Kurzurteile mit Sprung in den passenden Tab
    const mkSrc = (labelKey) => {
      const row = el("div", "srcrow");
      const led = el("span", "led");
      const k = el("span", "k", T(labelKey));
      const v = el("span", "v", T("scp.src.none"));
      row.append(led, k, v);
      return { row, v };
    };
    const srcVideo = mkSrc("scp.src.video");
    const srcAudio = mkSrc("scp.src.audio");
    const srcAnc = mkSrc("scp.src.anc");
    const mkCard = (titleKey, tab) => {
      const c = el("div", "card idle");
      const t = el("div", "t", T(titleKey));
      const v = el("div", "v", "–");
      c.append(t, v);
      c.addEventListener("click", () => selectTab(tab));
      c.title = T("scp.ov.go");
      return { c, v };
    };
    const cardSync = mkCard("scp.ov.lipsync", "timing");
    const cardLoud = mkCard("scp.ov.loud", "audio");
    const cardAnc = mkCard("scp.ov.anc", "anc");
    const cardScte = mkCard("scp.ov.scte", "scte");
    const cards = el("div", "cards");
    cards.append(cardSync.c, cardLoud.c, cardAnc.c, cardScte.c);

    const TABS = [
      ["ov", "scp.tab.ov"],
      ["video", "scp.tab.video"],
      ["audio", "scp.tab.audio"],
      ["timing", "scp.tab.timing"],
      ["flow", "scp.tab.flow"],
      ["anc", "scp.tab.anc"],
      ["scte", "scp.tab.scte"],
    ];
    const panes = {
      ov: [section(T("scp.ov.sources")), srcVideo.row, srcAudio.row, srcAnc.row, section(T("scp.ov.alarms")), chips, section(T("scp.ov.checks")), cards],
      video: [hintVideo, img, status],
      audio: [hintAudio, section(T("scp.e71d24")), meterRow, section(T("scp.00f47c")), lufsGrid, r128Wrap],
      timing: [hintTiming, section("A/V-Timing (Lipsync)", T("scp.f488c4")), syncBox, section("MXL-Transport", T("scp.d00749")), transport.table],
      flow: [section("MXL-Flow", T("scp.42889b")), decl.table, section(T("scp.4a876b")), measured.table],
      anc: [hintAnc, ancTc, ancStatus, ancTable, ancDetail, section(T("scp.anc.errors")), ancErrors],
      scte: [hintScte, scteStat, filters, section(T("scp.scte.in")), scteIn, el("div", "anc-status", T("scp.scte.udp")), section(T("scp.anc.scte")), scteLog],
    };
    const tabBar = el("div", "tabs");
    const tabBtn = {};
    const tabDot = {};
    const paneEl = {};
    for (const [id, key] of TABS) {
      const b = el("button", "tab");
      b.append(document.createTextNode(T(key)));
      const dot = el("span", "dot");
      dot.style.display = "none";
      b.appendChild(dot);
      b.addEventListener("click", () => selectTab(id));
      tabBtn[id] = b;
      tabDot[id] = dot;
      tabBar.appendChild(b);
      const pane = el("div", "pane");
      for (const node of panes[id]) pane.appendChild(node);
      paneEl[id] = pane;
    }
    const selectTab = (id) => {
      if (!paneEl[id]) id = "ov";
      this._tab = id;
      try { localStorage.setItem("omp-scope-tab", id); } catch { /* ohne Speicher: nur nicht merken */ }
      for (const [k, pane] of Object.entries(paneEl)) {
        pane.hidden = k !== id;
        tabBtn[k].classList.toggle("active", k === id);
      }
      if (id === "video") img.src = previewUrl();
    };
    let stored = "ov";
    try { stored = localStorage.getItem("omp-scope-tab") || "ov"; } catch { /* egal */ }
    this._tab = paneEl[stored] ? stored : "ov";

    shadow.append(style, tabBar, ...Object.values(paneEl));
    selectTab(this._tab);

    // Alarm-Punkt an einem Tab: "bad" rot, "warn" gelb, "ok" grün, leer = nichts
    const setDot = (id, state) => {
      tabDot[id].style.display = state ? "" : "none";
      tabDot[id].className = "dot" + (state ? " " + state : "");
    };
    const setCard = (card, text, state) => {
      card.v.textContent = text;
      card.c.className = "card " + state;
    };
    const setSrc = (src, connected, text) => {
      src.row.classList.toggle("on", connected);
      src.v.textContent = connected ? text : T("scp.src.none");
    };

    const setBadge = (el, text, state) => {
      el.textContent = text;
      el.className = `badge ${state}`;
    };
    const setChip = (chip, raised, seconds) => {
      chip.chip.className = raised ? "chip alarm" : "chip";
      if (raised) chip.detail.textContent = `seit ${fmt(seconds, 1, "s")}`;
      else if (num(seconds) !== undefined) chip.detail.textContent = `beobachtet ${fmt(seconds, 1, "s")}`;
      else chip.detail.textContent = T("scp.060af1");
    };

    const refresh = async () => {
      let m;
      try {
        const res = await fetch(`/api/v1/nodes/${nodeId}/measurements`);
        if (!res.ok) return;
        m = await res.json();
      } catch {
        return;
      }

      // Lipsync
      const offset = num(m.avOffsetMs);
      syncBig.textContent = offset === undefined ? "–" : signed(offset, 1, "ms");
      if (offset === undefined) {
        syncSub.textContent = T("scp.18f42a");
        marker.style.display = "none";
      } else {
        const frames = num(m.avOffsetFrames);
        syncSub.textContent =
          (frames === undefined ? "" : T("scp.ac4b1a", { p0: signed(frames, 2) })) +
          (offset > 0 ? T("scp.4b686e") : offset < 0 ? T("scp.3e11ba") : "deckungsgleich");
        marker.style.display = "";
        marker.style.left = `${pct(offset)}%`;
      }
      const verdict = m.avSyncVerdict || "unbekannt";
      setBadge(syncBadge, vt(verdict), verdict.startsWith("innerhalb") ? "ok" : verdict.startsWith("außerhalb") ? "bad" : "idle");
      const group = m.avSourceGroupMatch || "unbekannt";
      setBadge(
        groupBadge,
        group === "dieselbe Quelle" ? T("scp.caca19") : group === "verschiedene Quellen" ? T("scp.086fb1") : T("scp.3203b1"),
        group === "dieselbe Quelle" ? "ok" : group === "verschiedene Quellen" ? "warn" : "idle",
      );
      // Warn- statt Fehlerstil, und der Grund steht im Tooltip: OMPs
      // eigene MXL-Schreiber setzen als Grouphint-Gruppennamen die
      // Flow-ID des jeweiligen Flows (omp_mediaio::mxl::video_flow_def/
      // audio_flow_def) — Video und Audio derselben Quelle bekommen
      // damit systematisch verschiedene Gruppen. Der Befund ist echt
      // (der Tag sagt wirklich nichts über Zusammengehörigkeit aus),
      // aber er zeigt eine Plattform-Lücke an, keinen Bedienfehler.
      groupBadge.title =
        group === "verschiedene Quellen"
          ? T("scp.0a6161")
          : "";

      // QC
      setChip(blackChip, m.videoBlackDetected === true, m.videoBlackSeconds);
      setChip(freezeChip, m.videoFreezeDetected === true, m.videoFreezeSeconds);
      setChip(silenceChip, m.audioSilenceDetected === true, m.audioSilenceSeconds);

      // Lautheit
      momentaryEl.textContent = fmt(m.loudnessMomentaryLufs);
      shortTermEl.textContent = fmt(m.loudnessShortTermLufs);
      integratedEl.textContent = fmt(m.loudnessIntegratedLufs);
      rangeEl.textContent = fmt(m.loudnessRangeLu);
      // Digitale Stille ergibt einen Pegel von exakt 0 → −∞ dBFS, und
      // −∞ ist keine gültige JSON-Zahl, kommt also als null an (s.
      // opt_f64_json im Node). Das ist vom Fall "noch nichts gemessen"
      // nur am Kontext zu unterscheiden: fließen Grains, ist null echte
      // Stille und wird als −∞ gezeigt statt als "–". Live gefunden
      // (2026-09-15, stummgeschalteter Mixer als Testquelle): ohne das
      // stand bei exakter Stille überall "–", als wäre die Messung
      // ausgefallen — genau dann, wenn sie am eindeutigsten ist.
      const audioFlowing = (num(m.audioGrainsSeen) ?? 0) > 0;
      const peakText = (v) => (num(v) === undefined && audioFlowing ? "−∞" : fmt(v));
      truePeakEl.textContent = peakText(m.loudnessTruePeakDbtp);
      blockPeakEl.textContent = peakText(m.audioBlockPeakDbfs);
      const r128 = m.loudnessR128Verdict || "unbekannt";
      setBadge(r128Badge, vt(r128), r128 === "R 128 erfüllt" ? "ok" : r128 === "unbekannt" ? "idle" : "bad");

      // Transport
      const t = transport.rows;
      const pair = (label, fn) => {
        t[label][0].textContent = fn("video");
        t[label][1].textContent = fn("audio");
      };
      pair(T("scp.d7b569"), (p) => fmt(m[`${p}TransportLatencyMs`], 2, "ms"));
      pair(T("scp.84ac4b"), (p) => fmt(m[`${p}TransportLatencyAvgMs`], 2, "ms"));
      pair(T("scp.acf986"), (p) => `${fmt(m[`${p}TransportLatencyMinMs`], 2)} / ${fmt(m[`${p}TransportLatencyMaxMs`], 2)}`);
      pair(T("scp.3c813e"), (p) => fmt(m[`${p}LatencyJitterMs`], 2, "ms"));
      pair(T("scp.9c043c"), (p) => `${fmt(m[`${p}GrainCadenceMs`], 2)} / ${fmt(m[`${p}GrainCadenceNominalMs`], 2)}`);
      pair(T("scp.281d47"), (p) => int(m[`${p}GrainsSeen`]));
      pair("ausgelassen", (p) => int(m[`${p}GrainsDropped`]));
      pair(T("scp.72355f"), (p) => int(m[`${p}Discontinuities`]));

      // Flow-Deklaration
      const d = decl.rows;
      const set2 = (label, v, a) => {
        d[label][0].textContent = v ?? "–";
        d[label][1].textContent = a ?? "–";
      };
      set2(T("scp.5f23a4"), m.videoFlowMediaType, m.audioFlowMediaType);
      set2(
        T("scp.dcb66f"),
        m.videoFlowGrainRate ? `${m.videoFlowGrainRate} fps` : undefined,
        num(m.audioFlowSampleRate) === undefined ? undefined : `${int(m.audioFlowSampleRate)} Hz`,
      );
      set2(T("scp.30507b"), num(m.videoFlowBitDepth) === undefined ? undefined : `${m.videoFlowBitDepth} bit`, undefined);
      set2(T("scp.45cef4"), undefined, m.audioFlowChannelCount ?? undefined);
      set2(T("scp.e32d85"), m.videoFlowColorspace, undefined);
      set2(T("scp.85069b"), m.videoFlowInterlaceMode, undefined);
      set2(T("scp.2d0160"), num(m.videoFlowGrainBytes) === undefined ? undefined : `${int(Math.round(m.videoFlowGrainBytes / 1024))} KiB`, undefined);
      set2(T("scp.ebace4"), fmt(m.videoFlowBitrateMbps, 1, "Mbit/s"), fmt(m.audioFlowBitrateMbps, 2, "Mbit/s"));
      set2(T("scp.75d289"), m.videoFlowGroupHint, m.audioFlowGroupHint);

      // Gemessene Werte
      const g = measured.rows;
      const set1 = (label, v) => {
        g[label][0].textContent = v ?? "–";
      };
      set1(T("scp.faeae5"), m.videoSourceLabel || T("scp.08fd3e"));
      set1(T("scp.711cd6"), m.videoWidth && m.videoHeight ? `${m.videoWidth}×${m.videoHeight}` : undefined);
      set1(T("scp.04a23f"), m.videoFramerate);
      set1(T("scp.e666a2"), fmt(m.videoMeasuredFps, 1, "fps"));
      set1(T("scp.e3246d"), fmt(m.videoMeanLumaPercent, 1, "%"));
      set1(T("scp.97b764"), fmt(m.videoFrameDifference, 2));
      set1(T("scp.6d7bfd"), m.audioSourceLabel || T("scp.08fd3e"));
      set1(T("scp.0ab6cb"), num(m.audioSampleRate) === undefined ? undefined : `${int(m.audioSampleRate)} Hz`);
      set1(T("scp.45cef4"), m.audioChannels ?? undefined);

      // ANC / SCTE
      if (typeof m.ancReport === "string") {
        try {
          lastAnc = JSON.parse(m.ancReport);
          renderAnc(lastAnc);
        } catch {
          /* unvollständige Antwort: beim nächsten Takt wieder */
        }
      }

      // Übersicht, Hinweise und Alarm-Punkte
      const hasV = !!m.videoConnectedFlowId, hasA = !!m.audioConnectedFlowId, hasN = !!m.ancConnectedFlowId;
      setSrc(srcVideo, hasV, `${m.videoSourceLabel || m.videoConnectedFlowId}${m.videoWidth ? " · " + m.videoWidth + "×" + m.videoHeight : ""}${m.videoFramerate ? " @ " + m.videoFramerate : ""}`);
      setSrc(srcAudio, hasA, `${m.audioSourceLabel || m.audioConnectedFlowId}${num(m.audioSampleRate) ? " · " + int(m.audioSampleRate) + " Hz" : ""}${m.audioChannels ? " · " + m.audioChannels + " ch" : ""}`);
      setSrc(srcAnc, hasN, `${(m.ancConnectedFlowId || "").slice(0, 8)}…${lastAnc ? " · " + int(lastAnc.packets) + " pkt" : ""}`);
      hintVideo.style.display = hasV ? "none" : "";
      hintAudio.style.display = hasA ? "none" : "";
      hintAnc.style.display = hasN ? "none" : "";
      hintScte.style.display = hasN || (lastAnc && lastAnc.scte.sections35 > 0) ? "none" : "";
      hintTiming.style.display = hasV && hasA ? "none" : "";

      const vBad = m.videoBlackDetected === true || m.videoFreezeDetected === true;
      const aBad = m.audioSilenceDetected === true;
      const syncBad = (m.avSyncVerdict || "").startsWith("außerhalb");
      const r128Bad = !["unbekannt", "R 128 erfüllt"].includes(m.loudnessR128Verdict || "unbekannt");
      setDot("video", vBad ? "bad" : "");
      setDot("audio", aBad ? "bad" : r128Bad ? "warn" : "");
      setDot("timing", syncBad ? "bad" : "");
      const ancErr = lastAnc ? lastAnc.errors.filter((e) => !e.message.startsWith("SCTE")).reduce((n, e) => n + e.count, 0) + (lastAnc.indexGaps || 0) : 0;
      setDot("anc", ancErr ? "warn" : "");
      const scteErr = lastAnc ? lastAnc.scte.errors104 + lastAnc.scte.errors35 : 0;
      setDot("scte", scteErr ? "warn" : lastAnc && lastAnc.scte.events.length ? "ok" : "");
      setDot("ov", vBad || aBad || syncBad ? "bad" : "");

      const sv = m.avSyncVerdict || "unbekannt";
      setCard(cardSync, vt(sv), sv.startsWith("innerhalb") ? "ok" : sv.startsWith("außerhalb") ? "bad" : "idle");
      const lv = m.loudnessR128Verdict || "unbekannt";
      setCard(cardLoud, vt(lv), lv === "R 128 erfüllt" ? "ok" : lv === "unbekannt" ? "idle" : "bad");
      if (lastAnc) {
        setCard(cardAnc, hasN ? `${lastAnc.types.length} · ${fmt(lastAnc.packetsPerSec, 1)}/s${ancErr ? " ⚠" : ""}` : "–", !hasN ? "idle" : ancErr ? "warn" : "ok");
        const n = lastAnc.scte.messages104 + lastAnc.scte.sections35;
        setCard(cardScte, n ? `${int(n)} ${T("scp.messages")}${scteErr ? " ⚠" : ""}` : "–", scteErr ? "warn" : n ? "ok" : "idle");
      }
    };
    refresh();
    this._metaInterval = setInterval(refresh, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._previewInterval);
    clearInterval(this._metaInterval);
    if (this._levelsSource) this._levelsSource.close();
  }
}

if (!customElements.get("omp-scope-panel")) {
  customElements.define("omp-scope-panel", OmpScopePanel);
}
