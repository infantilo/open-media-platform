// Node-UI-Bundle von omp-mxf-player-direct (Nutzerauftrag 2026-09-03:
// "mxf player (direkt ohne playliste) braucht noch ein ui zum laden des
// clips, seeking, play, stop... und audioshuffle selection"). Vereinfachter
// Nachbau von omp-mxf-player/ui/bundle.js (gleiche generische Node-Proxy-
// API, /api/v1/nodes/<id>/params/<name>, /methods/<name>) — OHNE dessen
// Playlist/Cue-Take-Mechanik: dieser Node hat immer nur EINEN aktiven
// Clip ("load" wechselt ihn direkt), kein Vorbereiten eines zweiten
// während der erste läuft.

class OmpMxfPlayerDirectPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .status-row .status { padding: 3px 8px; border-radius: 3px; background: #333; }
      .status-row .status.playing { background: #2e7d32; }
      .status-row .file { color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
      .transport-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .transport-row button {
        cursor: pointer; padding: 6px 16px; border-radius: 4px; border: 1px solid #555;
        background: #222; color: #eee; font-weight: bold;
      }
      .transport-row button.play { border-color: #4caf50; background: #1b3a1e; }
      .transport-row button.stop { border-color: #a33; background: #3a1b1b; }
      .transport-row button:disabled { opacity: 0.4; cursor: default; }
      .scrub-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .scrub-row input[type="range"] { flex: 1; min-width: 200px; }
      .scrub-row .time { font-variant-numeric: tabular-nums; color: #aaa; min-width: 90px; }
      .load-row { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
      .load-row input[type="text"] { width: 220px; }
      .load-row select { max-width: 260px; }
      .load-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      .preset-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .preset-row select { max-width: 260px; }
      .preset-row button {
        cursor: pointer; padding: 5px 10px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee;
      }
      label { color: #999; }
      details.reference { margin-top: 14px; border-top: 1px solid #333; padding-top: 8px; }
      details.reference summary { cursor: pointer; color: #9aa0a6; }
      .groups-table, .routes-table { border-collapse: collapse; margin: 6px 0; font-size: 11px; }
      .groups-table td, .groups-table th, .routes-table td, .routes-table th {
        border: 1px solid #333; padding: 3px 8px; text-align: left;
      }
      .groups-table th, .routes-table th { color: #9aa0a6; font-weight: normal; }
      .reference-controls { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
      .reference-controls select { max-width: 260px; }
      .empty-routes { color: #666; font-style: italic; font-size: 11px; }
      .groups-info { font-size: 12px; color: #cfd3d8; }
      .reference button { cursor: pointer; padding: 3px 9px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee; }
    `;

    const statusRow = document.createElement("div");
    statusRow.className = "status-row";
    const statusEl = document.createElement("span");
    statusEl.className = "status";
    const fileEl = document.createElement("span");
    fileEl.className = "file";
    statusRow.append(statusEl, fileEl);

    const transportRow = document.createElement("div");
    transportRow.className = "transport-row";
    const playBtn = document.createElement("button");
    playBtn.className = "play";
    playBtn.textContent = "▶ Play";
    playBtn.addEventListener("click", () => call("play", {}).then(poll));
    const stopBtn = document.createElement("button");
    stopBtn.className = "stop";
    stopBtn.textContent = "■ Stop";
    stopBtn.addEventListener("click", () => call("stop", {}).then(poll));
    transportRow.append(playBtn, stopBtn);

    const scrubRow = document.createElement("div");
    scrubRow.className = "scrub-row";
    const scrubBar = document.createElement("input");
    scrubBar.type = "range";
    scrubBar.min = "0";
    scrubBar.max = "0";
    scrubBar.step = "40"; // 1 Bild bei 25fps (ms) — s. FRAMERATE_* in pipeline.rs.
    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = "0:00 / 0:00";
    // Live-Anzeige während des Ziehens (`input`), tatsächlicher Seek erst
    // beim Loslassen (`change`) — sonst ein Netzwerk-Request pro Pixel
    // (identisches Muster wie omp-mxf-player/ui/bundle.js).
    scrubBar.addEventListener("input", () => {
      timeEl.textContent = `${formatTime(Number(scrubBar.value))} / ${formatTime(Number(scrubBar.max))}`;
    });
    scrubBar.addEventListener("change", () => {
      call("seek", { positionMs: Number(scrubBar.value) }).then(poll);
    });
    scrubRow.append(scrubBar, timeEl);

    const loadRow = document.createElement("div");
    loadRow.className = "load-row";
    const loadLabel = document.createElement("label");
    loadLabel.textContent = "Clip laden:";
    const fileInput = document.createElement("input");
    fileInput.type = "text";
    fileInput.placeholder = "Datei (relativ zu OMP_MEDIA_DIR)";
    fileInput.setAttribute("list", "media-library");
    const mediaLibraryList = document.createElement("datalist");
    mediaLibraryList.id = "media-library";
    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Laden";
    loadBtn.addEventListener("click", () => {
      const file = fileInput.value.trim();
      if (!file) return;
      call("load", { file }).then(() => {
        fileInput.value = "";
        poll();
      });
    });
    loadRow.append(loadLabel, fileInput, mediaLibraryList, loadBtn);

    const presetRow = document.createElement("div");
    presetRow.className = "preset-row";
    const presetLabel = document.createElement("label");
    presetLabel.textContent = "Audio-Shuffle-Preset:";
    const presetSelect = document.createElement("select");
    presetSelect.title = "Legt fest, welche MXF-Tonspur in welche Programmgruppe (Programmton/Hörfilm/Originalton/Dolby E/5.1) geroutet wird.";
    const presetApplyBtn = document.createElement("button");
    presetApplyBtn.textContent = "Anwenden";
    presetApplyBtn.addEventListener("click", () => call("setPreset", { audioPreset: presetSelect.value }).then(poll));
    presetRow.append(presetLabel, presetSelect, presetApplyBtn);

    // Audio-Konfiguration (Ausgangsgruppen = NMOS-Audiosender, Zuordnungsvorlagen) liegt seit Kapitel 27 / A8
    // im gemeinsamen Dokument (Administration → Audio-Ausgabe). Hier nur Anzeige und „Neu laden“.
    const reference = document.createElement("details");
    reference.className = "reference";
    const referenceSummary = document.createElement("summary");
    referenceSummary.textContent = "Ausgangsgruppen (Audio-Konfiguration)";
    const groupsInfo = document.createElement("div");
    groupsInfo.className = "groups-info";
    const reloadRow = document.createElement("div");
    reloadRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Einstellungen neu laden";
    reloadBtn.title = "Holt das Audio-Dokument (Administration → Audio-Ausgabe) neu und wendet Gruppen und Zuordnungen live an.";
    const reloadMsg = document.createElement("span");
    reloadMsg.style.cssText = "font-size:12px;color:#9aa0a6;";
    reloadBtn.addEventListener("click", async () => {
      reloadMsg.style.color = "#9aa0a6";
      reloadMsg.textContent = "lade …";
      const res = await call("reloadSettings", {});
      if (res.ok) {
        reloadMsg.textContent = "übernommen";
      } else {
        reloadMsg.style.color = "#ff6b6b";
        reloadMsg.textContent = (await res.text()).trim() || `Fehler ${res.status}`;
      }
      poll();
    });
    reloadRow.append(reloadBtn, reloadMsg);
    reference.append(referenceSummary, groupsInfo, reloadRow);

    shadow.append(style, statusRow, transportRow, scrubRow, loadRow, presetRow, reference);

    const formatTime = (ms) => {
      const total = Math.max(0, Math.round(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    let groups = [];
    let presets = [];

    // Nutzerfund 2026-08-20 (omp-mxf-player, identisches Gotcha hier):
    // ein offenes <select> klappt sofort zu, sobald seine Optionen neu
    // aufgebaut werden — selbst wenn sich der ausgewählte Wert nicht
    // ändert. Deshalb nur aktualisieren, solange das Element nicht gerade
    // fokussiert ("wird gerade bedient") ist.
    const fillPresetOptions = (select) => {
      if (shadow.activeElement === select) return;
      const previous = select.value;
      select.innerHTML = "";
      for (const p of presets) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        select.append(opt);
      }
      if (presets.some((p) => p.id === previous)) select.value = previous;
    };

    const poll = async () => {
      const [status, file, positionMs, durationMs, audioPreset, mediaLibrary, groupsValue, presetsValue] = await Promise.all([
        getParam("status"),
        getParam("file"),
        getParam("positionMs"),
        getParam("durationMs"),
        getParam("audioPreset"),
        getParam("mediaLibrary"),
        getParam("programGroups"),
        getParam("shufflePresets"),
      ]);
      groups = groupsValue || [];
      presets = presetsValue || [];

      if (shadow.activeElement !== fileInput) {
        mediaLibraryList.replaceChildren(
          ...(mediaLibrary || []).map((f) => {
            const opt = document.createElement("option");
            opt.value = f;
            return opt;
          }),
        );
      }

      fillPresetOptions(presetSelect);
      if (shadow.activeElement !== presetSelect) presetSelect.value = audioPreset || "";
      groupsInfo.replaceChildren(...groups.map((g) => {
        const row = document.createElement("div");
        row.textContent = `${g.label} — ${g.channels} Kanal${g.channels === 1 ? "" : "äle"}`;
        return row;
      }));

      const isPlaying = status === "playing";
      statusEl.textContent = isPlaying ? "PLAYING" : "GESTOPPT";
      statusEl.className = isPlaying ? "status playing" : "status";
      fileEl.textContent = file || "(keine Datei)";
      fileEl.title = file || "";
      playBtn.disabled = isPlaying;
      stopBtn.disabled = !isPlaying;

      // Nicht während des Ziehens überschreiben (gleiches Muster wie
      // `fillPresetOptions`/`mediaLibraryList` oben).
      if (shadow.activeElement !== scrubBar) {
        scrubBar.max = String(durationMs || 0);
        scrubBar.value = String(positionMs || 0);
        timeEl.textContent = `${formatTime(positionMs || 0)} / ${formatTime(durationMs || 0)}`;
      }
    };

    poll();
    this._interval = setInterval(poll, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-mxf-player-direct-panel")) {
  customElements.define("omp-mxf-player-direct-panel", OmpMxfPlayerDirectPanel);
}
