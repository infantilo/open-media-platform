// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
        "x.item": "+ Item",
        "x.tonspur": "MXF-Tonspur",
        "x.toGroup": "→ Programmgruppe",
        "mxfp.181e1c": "Shuttle {p0}×",
        "mxfp.ecc34a": "10 Bilder zurück (Jog)",
        "mxfp.a27056": "1 Bild zurück (Jog)",
        "mxfp.b5782b": "1 Bild vor (Jog)",
        "mxfp.4c41f9": "10 Bilder vor (Jog)",
        "mxfp.18a802": "Titel",
        "mxfp.252c6d": "Datei (relativ zu OMP_MEDIA_DIR)",
        "mxfp.76dfbe": "Audio-Shuffle-Preset dieses Items — legt fest, welche MXF-Tonspur in welche Programmgruppe (Programmton/Hörfilm/Originalton/Dolby E/5.1) geroutet wird.",
        "mxfp.7ca717": "Dauer (ms, optional)",
        "mxfp.94f9d4": "Datei wählen und \"+ Item\" anklicken, um die Playlist zu füllen.",
        "mxfp.68f4f2": "Programmgruppen & Shuffle-Presets",
        "mxfp.331b62": "Routing anzeigen für:",
        "mxfp.982e11": "Kein Preset ausgewählt.",
        "mxfp.815f10": "Programmgruppe",
        "mxfp.45cef4": "Kanäle",
        "mxfp.84eb86": "Kanal",
        "mxfp.ed808c": "Tonspur {p0}",
        "mxfp.1c2876": "Audio-Shuffle-Preset dieses Items ändern.",
        "mxfp.513d30": "Entfernen",
        "mxfp.96c237": "„{p0}\" wirklich aus der Playlist entfernen?",
        "mxfp.0888a6": "Gecued"
    },
    en: {
        "x.item": "+ Item",
        "x.tonspur": "MXF audio track",
        "x.toGroup": "→ Programme group",
        "mxfp.181e1c": "Shuttle {p0}×",
        "mxfp.ecc34a": "10 frames back (jog)",
        "mxfp.a27056": "1 frame back (jog)",
        "mxfp.b5782b": "1 frame forward (jog)",
        "mxfp.4c41f9": "10 frames forward (jog)",
        "mxfp.18a802": "Title",
        "mxfp.252c6d": "File (relative to OMP_MEDIA_DIR)",
        "mxfp.76dfbe": "Audio shuffle preset of this item — determines which MXF audio track is routed into which programme group (programme sound/audio description/original sound/Dolby E/5.1)",
        "mxfp.7ca717": "Duration (ms, optional)",
        "mxfp.94f9d4": "Choose a file and click \"+ Item\" to fill the playlist.",
        "mxfp.68f4f2": "Programme groups & shuffle presets",
        "mxfp.331b62": "Show routing for:",
        "mxfp.982e11": "No preset selected.",
        "mxfp.815f10": "Programme group",
        "mxfp.45cef4": "Channels",
        "mxfp.84eb86": "Channel",
        "mxfp.ed808c": "Audio track {p0}",
        "mxfp.1c2876": "Change the audio shuffle preset of this item.",
        "mxfp.513d30": "Remove",
        "mxfp.96c237": "Really remove “{p0}” from the playlist?",
        "mxfp.0888a6": "Cued"
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

// Node-UI-Bundle des MXF-Players (Nutzerauftrag 2026-08-20: "mxf player
// muss vernünftige gui haben um clip auszuwählen, shuffeling zu
// editieren"). Direkter Nachbau von omp-player/ui/bundle-video.js (gleiche
// Cue/Take-Playlist-Mechanik, gleiche generische Node-Proxy-API,
// /api/v1/nodes/<id>/params/<name>, /methods/<name>), erweitert um das,
// was diesen Node von omp-player unterscheidet: ein Audio-Shuffle-Preset
// je Playlist-Item (append/setItemPreset) und ein Referenz-Panel, das die
// tatsächliche Track→Programmgruppe-Zuordnung eines Presets aufklappt
// (main.rs main.rs' "routes"-Feld in "shufflePresets") — ein Preset-Name
// wie "stereo-dolbye-hoerfilm" wäre für den Bedienenden sonst reine
// Rateerei.
//
// Wie omp-player: pro Item wird das DOM-Element genau einmal gebaut und
// danach nur noch aktualisiert (kein Rebuild bei jedem 2s-Poll), sonst
// flackert die Liste und ein gerade fokussiertes Eingabefeld verliert den
// Fokus.

// Vanille-Nachbau von `ui/kit/omp-confirm.ts`s `confirmDialog()` (UX-Audit
// 2026-08-07) — dieses eigenständige Bundle (`include_str!`, kein
// TS-Import möglich) kann das global registrierte `<omp-confirm>`
// trotzdem verwenden, sobald die Shell geladen hat (`ui/kit/index.ts`).
function confirmDialog(message, confirmLabel) {
  if (!customElements.get("omp-confirm")) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (confirmLabel) el.setAttribute("confirm-label", confirmLabel);
    el.addEventListener(
      "resolve",
      (ev) => {
        resolve(ev.detail);
        el.remove();
      },
      { once: true },
    );
    document.body.appendChild(el);
  });
}

class OmpMxfPlayerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .status-row .mode { padding: 3px 8px; border-radius: 3px; background: #333; }
      .status-row .mode.onair { background: #2e7d32; }
      button.take {
        cursor: pointer; padding: 8px 18px; border: 1px solid #a33; border-radius: 4px;
        background: #7a1f1f; color: #fff; font-weight: bold; font-size: 14px;
      }
      button.take:disabled { opacity: 0.4; cursor: default; }
      .transport-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
      .transport-row.disabled { opacity: 0.4; pointer-events: none; }
      .scrub-row { display: flex; align-items: center; gap: 8px; }
      .scrub-row input[type="range"] { flex: 1; min-width: 200px; }
      .scrub-row .time { font-variant-numeric: tabular-nums; color: #aaa; min-width: 90px; }
      .jog-shuttle { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .jog-shuttle button {
        cursor: pointer; padding: 4px 8px; border-radius: 3px; border: 1px solid #555;
        background: #222; color: #eee; font-variant-numeric: tabular-nums;
      }
      .jog-shuttle button.rate-active { background: #1565c0; border-color: #42a5f5; }
      .jog-shuttle .sep { width: 1px; align-self: stretch; background: #444; margin: 0 2px; }
      .add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .add-row input[type="text"] { width: 130px; }
      .add-row input[type="number"] { width: 64px; }
      .add-row select { max-width: 220px; }
      .add-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      .item {
        border: 1px solid #444; border-radius: 4px; padding: 6px 8px;
        margin-bottom: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .item.onair { border-color: #4caf50; background: #16281a; }
      .item.cued { border-color: #b8860b; background: #2a2210; }
      .item .label { flex: 1; min-width: 160px; }
      .item select { max-width: 210px; font-size: 11px; }
      .item button { cursor: pointer; padding: 4px 8px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee; }
      .item button.cue-active { background: #b8860b; border-color: #d4a017; }
      p.empty { font-size: 12px; color: #888; }
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
    `;

    const statusRow = document.createElement("div");
    statusRow.className = "status-row";
    const modeEl = document.createElement("span");
    modeEl.className = "mode";
    const playheadEl = document.createElement("span");
    const takeBtn = document.createElement("button");
    takeBtn.className = "take";
    takeBtn.textContent = "TAKE";
    takeBtn.addEventListener("click", () => call("take", {}).then(poll));
    statusRow.append(modeEl, playheadEl, takeBtn);

    // Jog/Shuttle/Seek (Nutzerauftrag 2026-08-21: "mxf player braucht
    // zusätzlich jog/shuttel/seek") — nur relevant/bedienbar, solange ein
    // Item on-air ist (`transport-row.disabled` unten in `poll()`), wirkt
    // serverseitig immer auf den On-Air-Zweig (s. `pipeline::Command`-Doku
    // in `nodes/omp-mxf-player/src/pipeline.rs`).
    const transportRow = document.createElement("div");
    transportRow.className = "transport-row";

    const scrubRow = document.createElement("div");
    scrubRow.className = "scrub-row";
    const scrubBar = document.createElement("input");
    scrubBar.type = "range";
    scrubBar.min = "0";
    scrubBar.max = "0";
    scrubBar.step = "40"; // 1 Frame bei 25fps (ms) — s. FRAMERATE_* in pipeline.rs.
    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = "0:00 / 0:00";
    // Live-Anzeige während des Ziehens (`input`), tatsächlicher Seek erst
    // beim Loslassen (`change`) — sonst ein Netzwerk-Request pro Pixel.
    scrubBar.addEventListener("input", () => {
      timeEl.textContent = `${formatTime(Number(scrubBar.value))} / ${formatTime(Number(scrubBar.max))}`;
    });
    scrubBar.addEventListener("change", () => {
      call("seek", { positionMs: Number(scrubBar.value) });
    });
    scrubRow.append(scrubBar, timeEl);

    const jogShuttle = document.createElement("div");
    jogShuttle.className = "jog-shuttle";
    const jogBtn = (label, title, onClick) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", onClick);
      return btn;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "sep";
      return s;
    };
    const rateButtons = [];
    const shuttleBtn = (rate) => {
      const btn = jogBtn(
        rate === 1 ? "▶ 1×" : `${rate > 0 ? "▶▶" : "◀◀"} ${Math.abs(rate)}×`,
        T("mxfp.181e1c", { p0: rate }),
        () => call("setRate", { rate }),
      );
      btn.dataset.rate = String(rate);
      rateButtons.push(btn);
      return btn;
    };
    jogShuttle.append(
      jogBtn("⏮ -10", T("mxfp.ecc34a"), () => call("step", { frames: -10 })),
      jogBtn("◀ -1", T("mxfp.a27056"), () => call("step", { frames: -1 })),
      sep(),
      shuttleBtn(-8),
      shuttleBtn(-2),
      shuttleBtn(1),
      shuttleBtn(2),
      shuttleBtn(8),
      sep(),
      jogBtn("+1 ▶", T("mxfp.b5782b"), () => call("step", { frames: 1 })),
      jogBtn("+10 ⏭", T("mxfp.4c41f9"), () => call("step", { frames: 10 })),
    );

    transportRow.append(scrubRow, jogShuttle);

    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = T("mxfp.18a802");
    // K2-Teil-1-Muster (omp-player): Datei relativ zu OMP_MEDIA_DIR, ein
    // <datalist> aus dem "mediaLibrary"-Param spart Tipparbeit.
    const fileInput = document.createElement("input");
    fileInput.type = "text";
    fileInput.placeholder = T("mxfp.252c6d");
    fileInput.setAttribute("list", "media-library");
    const mediaLibraryList = document.createElement("datalist");
    mediaLibraryList.id = "media-library";
    // Audio-Shuffle-Preset je NEUEM Item — das eigentliche "shuffeling
    // editieren" aus dem Nutzerauftrag: welche der 8 MXF-Tonspuren in
    // welche Programmgruppe geroutet wird, s. Referenz-Panel unten.
    const presetSelect = document.createElement("select");
    presetSelect.title = T("mxfp.76dfbe");
    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.placeholder = T("mxfp.7ca717");
    const addBtn = document.createElement("button");
    addBtn.textContent = T("x.item");
    addBtn.addEventListener("click", () => {
      const file = fileInput.value.trim();
      if (!file) return;
      const body = {
        label: labelInput.value.trim() || file,
        file,
        audioPreset: presetSelect.value,
        durationMs: parseFloat(durationInput.value) || 0,
      };
      call("append", body).then(() => {
        labelInput.value = "";
        fileInput.value = "";
        durationInput.value = "";
        poll();
      });
    });
    addRow.append(labelInput, fileInput, mediaLibraryList, presetSelect, durationInput, addBtn);

    const list = document.createElement("div");
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = T("mxfp.94f9d4");

    // Referenz-Panel (Nutzerauftrag: Shuffle-Presets müssen nachvollziehbar
    // sein, nicht nur namentlich wählbar) — Programmgruppen-Tabelle immer
    // sichtbar, Preset-Routing-Tabelle auf Wunsch aufklappbar.
    const reference = document.createElement("details");
    reference.className = "reference";
    const referenceSummary = document.createElement("summary");
    referenceSummary.textContent = T("mxfp.68f4f2");
    const groupsTable = document.createElement("table");
    groupsTable.className = "groups-table";
    const referenceControls = document.createElement("div");
    referenceControls.className = "reference-controls";
    const referenceLabel = document.createElement("label");
    referenceLabel.textContent = T("mxfp.331b62");
    const referencePresetSelect = document.createElement("select");
    referenceControls.append(referenceLabel, referencePresetSelect);
    const routesTable = document.createElement("table");
    routesTable.className = "routes-table";
    const routesEmpty = document.createElement("div");
    routesEmpty.className = "empty-routes";
    routesEmpty.textContent = T("mxfp.982e11");
    reference.append(referenceSummary, groupsTable, referenceControls, routesTable, routesEmpty);

    shadow.append(style, statusRow, transportRow, addRow, list, empty, reference);

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

    const renderGroupsTable = () => {
      groupsTable.innerHTML = "";
      const headerRow = document.createElement("tr");
      for (const h of [T("mxfp.815f10"), T("mxfp.45cef4")]) {
        const th = document.createElement("th");
        th.textContent = h;
        headerRow.append(th);
      }
      groupsTable.append(headerRow);
      for (const g of groups) {
        const row = document.createElement("tr");
        const labelCell = document.createElement("td");
        labelCell.textContent = g.label;
        const channelsCell = document.createElement("td");
        channelsCell.textContent = g.channels;
        row.append(labelCell, channelsCell);
        groupsTable.append(row);
      }
    };

    const renderRoutesTable = () => {
      const presetId = referencePresetSelect.value;
      const preset = presets.find((p) => p.id === presetId);
      routesTable.innerHTML = "";
      if (!preset || !preset.routes || preset.routes.length === 0) {
        routesEmpty.style.display = "";
        return;
      }
      routesEmpty.style.display = "none";
      const headerRow = document.createElement("tr");
      for (const h of [T("x.tonspur"), T("x.toGroup"), T("mxfp.84eb86")]) {
        const th = document.createElement("th");
        th.textContent = h;
        headerRow.append(th);
      }
      routesTable.append(headerRow);
      for (const route of preset.routes) {
        const group = groups.find((g) => g.id === route.group);
        const row = document.createElement("tr");
        const trackCell = document.createElement("td");
        trackCell.textContent = T("mxfp.ed808c", { p0: route.srcTrack });
        const groupCell = document.createElement("td");
        groupCell.textContent = group ? group.label : route.group;
        const channelCell = document.createElement("td");
        channelCell.textContent = route.groupChannel;
        row.append(trackCell, groupCell, channelCell);
        routesTable.append(row);
      }
    };
    referencePresetSelect.addEventListener("change", renderRoutesTable);

    // Preset-<select>-Optionen an EINER Stelle gebaut, für Add-Zeile,
    // Referenz-Panel und jede Item-Zeile identisch wiederverwendet.
    //
    // Nutzerfund 2026-08-20: ein offenes <select> (bzw. bei fileInput die
    // native Datalist-Vorschlagsliste) klappt sofort zu, sobald seine
    // Optionen neu aufgebaut werden — selbst wenn sich der ausgewählte
    // Wert nicht ändert. Der 2s-Poll baute bislang JEDES <select> bei
    // JEDEM Durchlauf neu, wodurch die Auswahl fast nie zum Abschluss
    // kam ("klappt sich immer wieder ein bevor man etwas auswählt").
    // Gleiches Muster wie der shadow.activeElement-Fix in
    // omp-media-library/ui/bundle.js: solange das Element fokussiert
    // ist, gilt es als "wird gerade bedient" und bleibt unangetastet.
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

    // itemId -> { el, labelEl, presetSelect, cueBtn, removeBtn }
    const itemEls = new Map();

    const createItemElement = (item) => {
      const el = document.createElement("div");
      el.className = "item";

      const labelEl = document.createElement("span");
      labelEl.className = "label";

      const presetSel = document.createElement("select");
      presetSel.title = T("mxfp.1c2876");
      presetSel.addEventListener("change", () => {
        call("setItemPreset", { itemId: item.id, audioPreset: presetSel.value }).then(poll);
      });

      const cueBtn = document.createElement("button");
      cueBtn.addEventListener("click", () => call("cue", { itemId: item.id }).then(poll));

      const removeBtn = document.createElement("button");
      removeBtn.textContent = T("mxfp.513d30");
      removeBtn.addEventListener("click", async () => {
        if (!(await confirmDialog(T("mxfp.96c237", { p0: item.label }), T("mxfp.513d30")))) return;
        call("remove", { itemId: item.id }).then(poll);
      });

      el.append(labelEl, presetSel, cueBtn, removeBtn);
      return { el, labelEl, presetSelect: presetSel, cueBtn, removeBtn };
    };

    const poll = async () => {
      const [itemsValue, currentItemId, cuedItemId, mode, playheadMs, shuttleRate, mediaLibrary, groupsValue, presetsValue] =
        await Promise.all([
          getParam("items"),
          getParam("currentItemId"),
          getParam("cuedItemId"),
          getParam("mode"),
          getParam("playheadPositionMs"),
          getParam("shuttleRate"),
          getParam("mediaLibrary"),
          getParam("programGroups"),
          getParam("shufflePresets"),
        ]);
      const items = itemsValue || [];
      groups = groupsValue || [];
      presets = presetsValue || [];

      // Gleicher Grund wie fillPresetOptions oben: die native
      // Vorschlagsliste des <datalist> klappt beim Neuaufbau ihrer
      // <option>s zu, auch wenn fileInput fokussiert bleibt — also nur
      // aktualisieren, solange nicht gerade darin getippt/ausgewählt wird.
      if (shadow.activeElement !== fileInput) {
        mediaLibraryList.replaceChildren(
          ...(mediaLibrary || []).map((file) => {
            const opt = document.createElement("option");
            opt.value = file;
            return opt;
          }),
        );
      }

      fillPresetOptions(presetSelect);
      const previousReferenceSelection = referencePresetSelect.value;
      fillPresetOptions(referencePresetSelect);
      if (!referencePresetSelect.value && presets.length > 0) referencePresetSelect.value = presets[0].id;
      if (presets.some((p) => p.id === previousReferenceSelection)) referencePresetSelect.value = previousReferenceSelection;
      renderGroupsTable();
      renderRoutesTable();

      const currentIds = new Set(items.map((it) => it.id));

      for (const [id, refs] of itemEls) {
        if (!currentIds.has(id)) {
          refs.el.remove();
          itemEls.delete(id);
        }
      }

      empty.style.display = items.length === 0 ? "" : "none";
      modeEl.textContent = mode === "onair" ? "ON AIR" : "SCHWARZ";
      modeEl.className = mode === "onair" ? "mode onair" : "mode";
      playheadEl.textContent = mode === "onair" ? `${Math.round((playheadMs || 0) / 1000)}s` : "";
      takeBtn.disabled = !cuedItemId;

      const onairItem = items.find((it) => it.id === currentItemId);
      transportRow.classList.toggle("disabled", mode !== "onair" || !onairItem);
      // Nicht während des Ziehens überschreiben (gleiches Muster wie
      // `fillPresetOptions`/`mediaLibraryList` oben: `shadow.activeElement`
      // markiert "wird gerade bedient").
      if (shadow.activeElement !== scrubBar) {
        scrubBar.max = String(onairItem ? onairItem.durationMs : 0);
        scrubBar.value = String(playheadMs || 0);
        timeEl.textContent = `${formatTime(playheadMs || 0)} / ${formatTime(onairItem ? onairItem.durationMs : 0)}`;
      }
      for (const btn of rateButtons) {
        btn.classList.toggle("rate-active", Number(btn.dataset.rate) === (shuttleRate ?? 1));
      }

      for (const item of items) {
        let refs = itemEls.get(item.id);
        if (!refs) {
          refs = createItemElement(item);
          itemEls.set(item.id, refs);
          list.append(refs.el);
        }
        refs.labelEl.textContent = `${item.label} (${item.file}, ${(item.durationMs / 1000).toFixed(1)}s)`;
        fillPresetOptions(refs.presetSelect);
        refs.presetSelect.value = item.audioPreset;

        const isOnair = item.id === currentItemId;
        const isCued = item.id === cuedItemId;
        refs.el.className = isOnair ? "item onair" : isCued ? "item cued" : "item";
        refs.cueBtn.textContent = isCued ? T("mxfp.0888a6") : "Cue";
        refs.cueBtn.className = isCued ? "cue-active" : "";
        refs.cueBtn.disabled = isOnair;
        refs.removeBtn.disabled = isOnair || isCued;
      }
    };

    poll();
    this._interval = setInterval(poll, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-mxf-player-panel")) {
  customElements.define("omp-mxf-player-panel", OmpMxfPlayerPanel);
}
