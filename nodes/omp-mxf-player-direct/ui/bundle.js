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
      .editor h4 { margin: 12px 0 4px; color: #9aa0a6; font-weight: normal; }
      .editor input[type="text"], .editor input[type="number"] {
        background: #1a1a1a; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 3px 6px;
      }
      .editor input[type="number"] { width: 56px; }
      .editor button {
        cursor: pointer; padding: 3px 9px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee;
      }
      .editor button.danger { border-color: #a33; }
      .editor button.save { border-color: #4caf50; background: #2e7d32; font-weight: bold; }
      .editor button:disabled { opacity: 0.4; cursor: default; }
      .editor .bar { display: flex; gap: 6px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
      .editor .dirty { color: #f0b429; }
      .editor .err { color: #ff6b6b; }
      .xp { border-collapse: collapse; margin: 6px 0; font-size: 11px; }
      .xp th, .xp td { border: 1px solid #333; padding: 0; text-align: center; }
      .xp th { color: #9aa0a6; font-weight: normal; padding: 2px 6px; }
      .xp th.grp { border-bottom: 2px solid #555; }
      .xp td.trk { padding: 2px 8px; color: #9aa0a6; text-align: left; white-space: nowrap; }
      .xp td.cell { width: 26px; height: 22px; cursor: pointer; }
      .xp td.cell:hover { background: #2a2a2a; }
      .xp td.cell.on { background: #2e7d32; }
      .xp td.cell.on::after { content: "●"; color: #eee; }
      .xp td.gsep, .xp th.gsep { border-left: 2px solid #555; }
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

    // Editor (Nutzerwunsch 2026-09-30): Ausgangsgruppen (= NMOS-Audiosender)
    // und Shuffle-Presets dynamisch anlegen/löschen; Presets per
    // Crosspoint-Matrix (Zeilen = MXF-Tonspuren, Spalten = Gruppenkanäle).
    // Expliziter Speichern-Knopf (kein PUT pro Klick) — "Speichern" baut die
    // Pipeline neu auf und meldet Sender live an/ab.
    const reference = document.createElement("details");
    reference.className = "reference editor";
    const referenceSummary = document.createElement("summary");
    referenceSummary.textContent = "Ausgangsgruppen & Shuffle-Presets bearbeiten";
    const editorBody = document.createElement("div");
    reference.append(referenceSummary, editorBody);

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

    // --- Editor-Entwurf (Kopie, unabhängig vom Poll) ---
    let draft = null; // { groups, presets }
    let dirty = false;
    let selectedPresetId = null;
    let errorText = "";
    let shownTracks = 8; // Zeilenzahl der Matrix (Standard: 8 MXF-Tonspuren)

    const clone = (x) => JSON.parse(JSON.stringify(x));
    const slug = (text, taken) => {
      const base = (text || "x").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      return id;
    };
    const markDirty = () => { dirty = true; renderEditor(); };

    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };

    const trackCount = () => {
      let max = shownTracks;
      for (const p of draft.presets) for (const r of p.routes) max = Math.max(max, r.srcTrack);
      return max;
    };

    const renderEditor = () => {
      if (!draft) return;
      editorBody.replaceChildren();

      // Gruppen
      editorBody.append(el("h4", { textContent: "Ausgangsgruppen (je ein Audio-Sender)" }));
      const gt = el("table", { className: "groups-table" });
      gt.append(el("tr", {}, ...["Name", "Kanäle", ""].map((h) => el("th", { textContent: h }))));
      draft.groups.forEach((g, gi) => {
        const nameIn = el("input", { type: "text", value: g.label });
        nameIn.addEventListener("input", () => { g.label = nameIn.value; dirty = true; refreshBar(); });
        nameIn.addEventListener("change", renderEditor);
        const chIn = el("input", { type: "number", min: 1, max: 64, value: g.channels });
        chIn.addEventListener("change", () => {
          g.channels = Math.min(64, Math.max(1, Number(chIn.value) || 1));
          for (const p of draft.presets) p.routes = p.routes.filter((r) => r.group !== g.id || r.groupChannel < g.channels);
          markDirty();
        });
        const del = el("button", { className: "danger", textContent: "Löschen", disabled: draft.groups.length <= 1 });
        del.addEventListener("click", () => {
          draft.groups.splice(gi, 1);
          for (const p of draft.presets) p.routes = p.routes.filter((r) => r.group !== g.id);
          markDirty();
        });
        gt.append(el("tr", {}, el("td", {}, nameIn), el("td", {}, chIn), el("td", {}, del)));
      });
      editorBody.append(gt);
      const addGroup = el("button", { textContent: "+ Gruppe" });
      addGroup.addEventListener("click", () => {
        const taken = new Set(draft.groups.map((g) => g.id));
        const label = `Gruppe ${draft.groups.length + 1}`;
        draft.groups.push({ id: slug(label, taken), label, channels: 2 });
        markDirty();
      });
      editorBody.append(addGroup);

      // Presets
      editorBody.append(el("h4", { textContent: "Shuffle-Presets (Crosspoints)" }));
      if (!draft.presets.some((p) => p.id === selectedPresetId)) selectedPresetId = draft.presets[0]?.id ?? null;
      const preset = draft.presets.find((p) => p.id === selectedPresetId);

      const presetSel = el("select");
      for (const p of draft.presets) presetSel.append(el("option", { value: p.id, textContent: p.label }));
      presetSel.value = selectedPresetId || "";
      presetSel.addEventListener("change", () => { selectedPresetId = presetSel.value; renderEditor(); });
      const nameIn = el("input", { type: "text", value: preset ? preset.label : "" });
      nameIn.addEventListener("input", () => { if (preset) { preset.label = nameIn.value; dirty = true; refreshBar(); } });
      nameIn.addEventListener("change", renderEditor);
      const newBtn = el("button", { textContent: "+ Preset" });
      newBtn.addEventListener("click", () => {
        const taken = new Set(draft.presets.map((p) => p.id));
        const label = `Preset ${draft.presets.length + 1}`;
        const id = slug(label, taken);
        draft.presets.push({ id, label, routes: [] });
        selectedPresetId = id;
        markDirty();
      });
      const dupBtn = el("button", { textContent: "Duplizieren", disabled: !preset });
      dupBtn.addEventListener("click", () => {
        const taken = new Set(draft.presets.map((p) => p.id));
        const label = `${preset.label} Kopie`;
        const id = slug(label, taken);
        draft.presets.push({ id, label, routes: clone(preset.routes) });
        selectedPresetId = id;
        markDirty();
      });
      const delBtn = el("button", { className: "danger", textContent: "Löschen", disabled: !preset || draft.presets.length <= 1 });
      delBtn.addEventListener("click", () => {
        draft.presets = draft.presets.filter((p) => p.id !== selectedPresetId);
        markDirty();
      });
      editorBody.append(el("div", { className: "bar" }, presetSel, nameIn, newBtn, dupBtn, delBtn));

      if (preset) {
        const tracks = trackCount();
        const xp = el("table", { className: "xp" });
        const head1 = el("tr", {}, el("th", { textContent: "Tonspur ↓ / Ausgang →" }));
        const head2 = el("tr", {}, el("th"));
        for (const g of draft.groups) {
          head1.append(el("th", { className: "grp gsep", colSpan: g.channels, textContent: g.label }));
          for (let c = 0; c < g.channels; c++) head2.append(el("th", { className: c === 0 ? "gsep" : "", textContent: String(c + 1) }));
        }
        xp.append(head1, head2);
        for (let t = 1; t <= tracks; t++) {
          const row = el("tr", {}, el("td", { className: "trk", textContent: `Tonspur ${t}` }));
          for (const g of draft.groups) {
            for (let c = 0; c < g.channels; c++) {
              const idx = preset.routes.findIndex((r) => r.srcTrack === t && r.group === g.id && r.groupChannel === c);
              const cell = el("td", { className: `cell${idx >= 0 ? " on" : ""}${c === 0 ? " gsep" : ""}` });
              cell.title = `Tonspur ${t} → ${g.label} ${c + 1}`;
              cell.addEventListener("click", () => {
                if (idx >= 0) preset.routes.splice(idx, 1);
                else preset.routes.push({ srcTrack: t, group: g.id, groupChannel: c });
                markDirty();
              });
              row.append(cell);
            }
          }
          xp.append(row);
        }
        editorBody.append(xp);
        const moreTracks = el("button", { textContent: "+ Tonspur-Zeile" });
        moreTracks.addEventListener("click", () => { shownTracks = Math.min(trackCount() + 1, 64); renderEditor(); });
        editorBody.append(moreTracks);
      }

      const saveBtn = el("button", { className: "save", textContent: "Speichern & anwenden", disabled: !dirty });
      saveBtn.addEventListener("click", save);
      const revertBtn = el("button", { textContent: "Verwerfen", disabled: !dirty });
      revertBtn.addEventListener("click", () => { dirty = false; errorText = ""; draft = clone({ groups, presets }); renderEditor(); });
      const status = el("span", { className: "dirtystate" });
      status.id = "editor-state";
      editorBody.append(el("div", { className: "bar" }, saveBtn, revertBtn, status));
      refreshBar();
    };

    const refreshBar = () => {
      const st = editorBody.querySelector("#editor-state");
      if (!st) return;
      st.className = errorText ? "err" : dirty ? "dirty" : "";
      st.textContent = errorText || (dirty ? "Ungespeicherte Änderungen" : "");
    };

    const save = async () => {
      errorText = "";
      const res = await call("applySettings", { settings: JSON.stringify({ groups: draft.groups, presets: draft.presets }) });
      if (!res.ok) {
        errorText = `Speichern fehlgeschlagen: ${(await res.text()).trim()}`;
        renderEditor();
        return;
      }
      dirty = false;
      draft = null;
      await poll();
    };

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
      // Entwurf nur aus dem Poll übernehmen, solange nichts ungespeichert
      // ist (sonst würde der Poll Änderungen des Bedieners überschreiben).
      if (!dirty && !editorBody.contains(shadow.activeElement)) {
        const fresh = clone({ groups, presets });
        if (!draft || JSON.stringify(draft) !== JSON.stringify(fresh)) {
          draft = fresh;
          renderEditor();
        }
      }

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
