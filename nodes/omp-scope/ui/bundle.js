// Node-UI-Bundle von omp-scope: kombiniertes Waveform/Vektorskop-Bild
// als <img> (identisches Einzelbild-Polling-Muster wie
// omp-viewer/ui/bundle.js — img.complete-Check vor jedem src-Neusetzen,
// s. dortigen Kommentar zum 2026-08-21 per CDP root-caused Chrome-
// multipart/x-mixed-replace-Wegfall), Peak/RMS über <omp-meter> (aus
// ui/kit, global von der Shell registriert) per SSE, EBU-R128-Lautheit
// und Metadaten als einfache Poll-Tabellen (kein SSE-Event für
// monitor.*-artige Werte hier nötig — die Werte selbst ändern sich
// bereits mit jedem GStreamer-Tick, ein 1s-Poll reicht für eine
// Anzeige, die ein Mensch abliest).
class OmpScopePanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      img {
        display: block; max-width: 100%; background: #000;
        border: 1px solid #444;
      }
      p.status { font-size: 12px; color: #888; }
      h4 { margin: 12px 0 6px 0; font-size: 12px; color: #aaa; font-weight: normal; }
      .meter-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .meter-row .label { font-size: 11px; width: 60px; }
      table { border-collapse: collapse; width: 100%; font-size: 11px; }
      table td { padding: 2px 4px; border-bottom: 1px solid #333; }
      table td:first-child { color: #999; white-space: nowrap; }
      table td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
      .lufs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 11px; }
      .lufs-grid .value { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .lufs-grid .caption { color: #999; }
    `;

    const token = localStorage.getItem("omp-auth-token");
    const withToken = (base) => {
      const url = token ? `${base}${base.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : base;
      return url;
    };

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    // --- Scope-Bild (Waveform + Vektorskop) ---
    const img = document.createElement("img");
    img.alt = "Waveform / Vektorskop";
    img.width = 480;
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

    // --- Audio-Pegel ---
    const audioSection = document.createElement("div");
    const audioTitle = document.createElement("h4");
    audioTitle.textContent = "Audio-Pegel";
    const meterRow = document.createElement("div");
    meterRow.className = "meter-row";
    const meterLabel = document.createElement("span");
    meterLabel.className = "label";
    meterLabel.textContent = "Peak/RMS";
    const meter = document.createElement("omp-meter");
    meterRow.append(meterLabel, meter);
    audioSection.append(audioTitle, meterRow);

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

    // --- EBU R128 Lautheit ---
    const lufsSection = document.createElement("div");
    const lufsTitle = document.createElement("h4");
    lufsTitle.textContent = "Lautheit (EBU R128)";
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
    lufsSection.append(lufsTitle, lufsGrid);

    const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "–");

    // --- Metadaten ---
    const metaSection = document.createElement("div");
    const metaTitle = document.createElement("h4");
    metaTitle.textContent = "Metadaten";
    const metaTable = document.createElement("table");
    const metaRows = {};
    const metaRow = (label) => {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = label;
      const td2 = document.createElement("td");
      td2.textContent = "–";
      tr.append(td1, td2);
      metaTable.appendChild(tr);
      metaRows[label] = td2;
      return td2;
    };
    metaRow("Video-Quelle");
    metaRow("Auflösung");
    metaRow("Framerate (Quelle)");
    metaRow("Framerate (gemessen)");
    metaRow("Audio-Quelle");
    metaRow("Abtastrate");
    metaRow("Kanäle");
    metaSection.append(metaTitle, metaTable);

    shadow.append(style, img, status, audioSection, lufsSection, metaSection);

    const refresh = async () => {
      const [
        videoLabel, width, height, framerate, measuredFps,
        audioLabel, sampleRate, channels,
        momentary, shortTerm, integrated, range,
      ] = await Promise.all([
        getParam("videoSourceLabel"), getParam("videoWidth"), getParam("videoHeight"),
        getParam("videoFramerate"), getParam("videoMeasuredFps"),
        getParam("audioSourceLabel"), getParam("audioSampleRate"), getParam("audioChannels"),
        getParam("loudnessMomentaryLufs"), getParam("loudnessShortTermLufs"),
        getParam("loudnessIntegratedLufs"), getParam("loudnessRangeLu"),
      ]);
      metaRows["Video-Quelle"].textContent = videoLabel || "nicht verbunden";
      metaRows["Auflösung"].textContent = width && height ? `${width}×${height}` : "–";
      metaRows["Framerate (Quelle)"].textContent = framerate || "–";
      metaRows["Framerate (gemessen)"].textContent = typeof measuredFps === "number" ? `${measuredFps.toFixed(1)} fps` : "–";
      metaRows["Audio-Quelle"].textContent = audioLabel || "nicht verbunden";
      metaRows["Abtastrate"].textContent = sampleRate ? `${sampleRate} Hz` : "–";
      metaRows["Kanäle"].textContent = channels ?? "–";
      momentaryEl.textContent = fmt(momentary);
      shortTermEl.textContent = fmt(shortTerm);
      integratedEl.textContent = fmt(integrated);
      rangeEl.textContent = fmt(range);
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
