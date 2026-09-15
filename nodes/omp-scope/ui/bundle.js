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
    img.alt = "Waveform / Vektorskop";
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
      status.textContent = "kein Video verbunden";
      status.style.display = "";
    });
    const previewUrl = () => withToken(`/api/v1/nodes/${nodeId}/stream/previewUrl?_=${Date.now()}`);
    img.src = previewUrl();
    this._previewInterval = setInterval(() => {
      if (!img.complete) return;
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
    syncSub.textContent = "kein Video-/Audio-Paar verbunden";
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
    for (const label of ["Ton hinkt nach", "0", "Ton eilt vor"]) {
      const span = document.createElement("span");
      span.textContent = label;
      ticks.appendChild(span);
    }
    const syncBadgeWrap = document.createElement("div");
    syncBadgeWrap.className = "center";
    const syncBadge = document.createElement("span");
    syncBadge.className = "badge idle";
    syncBadge.textContent = "unbekannt";
    const groupBadge = document.createElement("span");
    groupBadge.className = "badge idle";
    groupBadge.style.marginLeft = "6px";
    groupBadge.textContent = "Quellgruppe unbekannt";
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
    const blackChip = makeChip("Schwarzbild");
    const freezeChip = makeChip("Standbild");
    const silenceChip = makeChip("Stille");

    // --- Audio-Pegel ---
    const meterRow = document.createElement("div");
    meterRow.className = "meter-row";
    const meterLabel = document.createElement("span");
    meterLabel.className = "label";
    meterLabel.textContent = "Peak/RMS";
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
    const momentaryEl = lufsCell("Momentary (LUFS)");
    const shortTermEl = lufsCell("Short-term (LUFS)");
    const integratedEl = lufsCell("Integrated (LUFS)");
    const rangeEl = lufsCell("Range (LU)");
    const truePeakEl = lufsCell("True Peak (dBTP)");
    const blockPeakEl = lufsCell("Block-Peak (dBFS)");
    const r128Wrap = document.createElement("div");
    r128Wrap.className = "center";
    const r128Badge = document.createElement("span");
    r128Badge.className = "badge idle";
    r128Badge.textContent = "unbekannt";
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

    const transport = twoColTable(["MXL-Transport", "Video", "Audio"]);
    for (const label of ["Latenz (Ist)", "Latenz (Mittel)", "Latenz min/max", "Jitter (Spitze-Spitze)", "Kadenz Ist/Soll", "Grains", "ausgelassen", "Diskontinuitäten"]) {
      transport.row(label, 2);
    }

    const decl = twoColTable(["Flow-Deklaration", "Video", "Audio"]);
    for (const label of ["Media-Type", "Rate", "Bittiefe", "Kanäle", "Farbraum", "Abtastraster", "Grain-Größe", "Datenrate", "Grouphint"]) {
      decl.row(label, 2);
    }

    const measured = twoColTable(["Gemessen", "Wert"]);
    for (const label of ["Video-Quelle", "Auflösung", "Framerate (Quelle)", "Framerate (gemessen)", "Mittleres Luma", "Bilddifferenz", "Audio-Quelle", "Abtastrate", "Kanäle"]) {
      measured.row(label, 1);
    }

    shadow.append(
      style,
      img,
      status,
      section("A/V-Timing (Lipsync)", "· aus MXL-Ursprungszeitstempeln"),
      syncBox,
      section("Signalüberwachung"),
      chips,
      section("Audio-Pegel"),
      meterRow,
      section("Lautheit (EBU R 128)"),
      lufsGrid,
      r128Wrap,
      section("MXL-Transport", "· gemessen am Tap · negativ = Schreiber stempelt in die Zukunft"),
      transport.table,
      section("MXL-Flow", "· wie der Schreiber ihn deklariert"),
      decl.table,
      section("Gemessene Werte"),
      measured.table,
    );

    const setBadge = (el, text, state) => {
      el.textContent = text;
      el.className = `badge ${state}`;
    };
    const setChip = (chip, raised, seconds) => {
      chip.chip.className = raised ? "chip alarm" : "chip";
      if (raised) chip.detail.textContent = `seit ${fmt(seconds, 1, "s")}`;
      else if (num(seconds) !== undefined) chip.detail.textContent = `beobachtet ${fmt(seconds, 1, "s")}`;
      else chip.detail.textContent = "unauffällig";
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
        syncSub.textContent = "kein Video-/Audio-Paar verbunden";
        marker.style.display = "none";
      } else {
        const frames = num(m.avOffsetFrames);
        syncSub.textContent =
          (frames === undefined ? "" : `${signed(frames, 2)} Bilder · `) +
          (offset > 0 ? "Ton eilt dem Bild voraus" : offset < 0 ? "Ton hinkt dem Bild nach" : "deckungsgleich");
        marker.style.display = "";
        marker.style.left = `${pct(offset)}%`;
      }
      const verdict = m.avSyncVerdict || "unbekannt";
      setBadge(syncBadge, verdict, verdict.startsWith("innerhalb") ? "ok" : verdict.startsWith("außerhalb") ? "bad" : "idle");
      const group = m.avSourceGroupMatch || "unbekannt";
      setBadge(
        groupBadge,
        group === "dieselbe Quelle" ? "gleiche Quellgruppe" : group === "verschiedene Quellen" ? "verschiedene Quellgruppen" : "Quellgruppe unbekannt",
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
          ? "Die NMOS-Grouphints der beiden Flows nennen verschiedene Gruppen. Bei OMP-eigenen Quellen ist das derzeit immer so: deren MXL-Schreiber verwenden die jeweilige Flow-ID als Gruppennamen, statt Video und Audio einer Quelle derselben Gruppe zuzuordnen."
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
      setBadge(r128Badge, r128, r128 === "R 128 erfüllt" ? "ok" : r128 === "unbekannt" ? "idle" : "bad");

      // Transport
      const t = transport.rows;
      const pair = (label, fn) => {
        t[label][0].textContent = fn("video");
        t[label][1].textContent = fn("audio");
      };
      pair("Latenz (Ist)", (p) => fmt(m[`${p}TransportLatencyMs`], 2, "ms"));
      pair("Latenz (Mittel)", (p) => fmt(m[`${p}TransportLatencyAvgMs`], 2, "ms"));
      pair("Latenz min/max", (p) => `${fmt(m[`${p}TransportLatencyMinMs`], 2)} / ${fmt(m[`${p}TransportLatencyMaxMs`], 2)}`);
      pair("Jitter (Spitze-Spitze)", (p) => fmt(m[`${p}LatencyJitterMs`], 2, "ms"));
      pair("Kadenz Ist/Soll", (p) => `${fmt(m[`${p}GrainCadenceMs`], 2)} / ${fmt(m[`${p}GrainCadenceNominalMs`], 2)}`);
      pair("Grains", (p) => int(m[`${p}GrainsSeen`]));
      pair("ausgelassen", (p) => int(m[`${p}GrainsDropped`]));
      pair("Diskontinuitäten", (p) => int(m[`${p}Discontinuities`]));

      // Flow-Deklaration
      const d = decl.rows;
      const set2 = (label, v, a) => {
        d[label][0].textContent = v ?? "–";
        d[label][1].textContent = a ?? "–";
      };
      set2("Media-Type", m.videoFlowMediaType, m.audioFlowMediaType);
      set2(
        "Rate",
        m.videoFlowGrainRate ? `${m.videoFlowGrainRate} fps` : undefined,
        num(m.audioFlowSampleRate) === undefined ? undefined : `${int(m.audioFlowSampleRate)} Hz`,
      );
      set2("Bittiefe", num(m.videoFlowBitDepth) === undefined ? undefined : `${m.videoFlowBitDepth} bit`, undefined);
      set2("Kanäle", undefined, m.audioFlowChannelCount ?? undefined);
      set2("Farbraum", m.videoFlowColorspace, undefined);
      set2("Abtastraster", m.videoFlowInterlaceMode, undefined);
      set2("Grain-Größe", num(m.videoFlowGrainBytes) === undefined ? undefined : `${int(Math.round(m.videoFlowGrainBytes / 1024))} KiB`, undefined);
      set2("Datenrate", fmt(m.videoFlowBitrateMbps, 1, "Mbit/s"), fmt(m.audioFlowBitrateMbps, 2, "Mbit/s"));
      set2("Grouphint", m.videoFlowGroupHint, m.audioFlowGroupHint);

      // Gemessene Werte
      const g = measured.rows;
      const set1 = (label, v) => {
        g[label][0].textContent = v ?? "–";
      };
      set1("Video-Quelle", m.videoSourceLabel || "nicht verbunden");
      set1("Auflösung", m.videoWidth && m.videoHeight ? `${m.videoWidth}×${m.videoHeight}` : undefined);
      set1("Framerate (Quelle)", m.videoFramerate);
      set1("Framerate (gemessen)", fmt(m.videoMeasuredFps, 1, "fps"));
      set1("Mittleres Luma", fmt(m.videoMeanLumaPercent, 1, "%"));
      set1("Bilddifferenz", fmt(m.videoFrameDifference, 2));
      set1("Audio-Quelle", m.audioSourceLabel || "nicht verbunden");
      set1("Abtastrate", num(m.audioSampleRate) === undefined ? undefined : `${int(m.audioSampleRate)} Hz`);
      set1("Kanäle", m.audioChannels ?? undefined);
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
