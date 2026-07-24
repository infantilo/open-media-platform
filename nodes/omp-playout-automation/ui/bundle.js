// Node-UI-Bundle des Playout-Automation-Controllers (UMSETZUNG.md
// C14/C15, ARCHITECTURE.md §13.3/§7.4): Rundown-Liste mit Cue/Take wie
// omp-players Videoplayer-Panel (bundle-video.js, C12), zusätzlich
// Ziel-Player/-Mixer-Label (beschreibbare Parameter, main.rs) und ein
// Auto/Hold-Modeschalter samt Fortschrittsbalken für das on-air Item.
// Gleiche generische Node-Proxy-API wie alle anderen Nodes:
// /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>.
class OmpPlayoutAutomationPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .targets { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .targets label { color: #999; display: flex; gap: 4px; align-items: center; }
      .targets select.target-select {
        width: 180px; background: #222; color: #eee; border: 1px solid #555; border-radius: 3px;
      }
      .connected { padding: 2px 7px; border-radius: 3px; background: #7a1f1f; }
      .connected.ok { background: #2e7d32; }
      .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .status-row .mode-badge { padding: 3px 8px; border-radius: 3px; background: #333; }
      .status-row .mode-badge.onair { background: #2e7d32; }
      select.mode-select { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; }
      button.take {
        cursor: pointer; padding: 8px 18px; border: 1px solid #a33; border-radius: 4px;
        background: #7a1f1f; color: #fff; font-weight: bold; font-size: 14px;
      }
      button.take:disabled { opacity: 0.4; cursor: default; }
      /* Listenansicht-Folgeschritt (PIPELINE-CONTROLLER-Parität, "Playlist
         Control"-Leiste dort): Next/Next-Live/Stop neben TAKE. */
      button.pl-ctrl-btn {
        cursor: pointer; padding: 6px 12px; border-radius: 4px; border: 1px solid #555;
        background: #222; color: #eee; font-size: 12px;
      }
      button.pl-ctrl-btn:disabled { opacity: 0.4; cursor: default; }
      button.pl-ctrl-btn.stop { border-color: #a33; color: #ff8080; }
      .progress { height: 4px; background: #333; border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
      .progress .bar { height: 100%; background: #4caf50; width: 0%; }
      .add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .add-row input[type="text"] { width: 100px; }
      .add-row input[type="number"] { width: 64px; }
      .add-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      /* Listenansicht (PIPELINE-CONTROLLER-Parität, .pl-item/.pl-cell dort):
         Grid-Zeilen statt Karten — Drag-Handle, Nummer/Status, Quell-Icon,
         Titel, Dauer, Zeitplan, Rest+Fortschritt, Aktionen. */
      .pl-grid-cols { grid-template-columns: 18px 24px 20px minmax(0, 1fr) 56px 92px 90px 96px; }
      .pl-hdr-row {
        display: grid; align-items: center; gap: 4px; padding: 2px 6px;
        font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: .04em;
        border-bottom: 1px solid #444; margin-bottom: 2px;
      }
      .pl-row {
        display: grid; align-items: center; gap: 4px; padding: 3px 6px;
        border-bottom: 1px solid #2a2a2a; font-size: 11px;
      }
      .pl-row.onair { background: #16281a; }
      .pl-row.cued { background: #2a2210; }
      .pl-row.drag-over { outline: 1px dashed #888; outline-offset: -1px; }
      .pl-row .pl-drag { cursor: grab; color: #666; text-align: center; }
      .pl-row .pl-num { color: #888; font-variant-numeric: tabular-nums; text-align: right; }
      .pl-row .pl-icon { text-align: center; }
      .pl-row .pl-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pl-row .pl-dur { color: #aaa; font-variant-numeric: tabular-nums; text-align: right; }
      .pl-row .pl-time { color: #888; font-variant-numeric: tabular-nums; }
      .pl-row .pl-rem { display: flex; flex-direction: column; gap: 1px; }
      .pl-row .pl-rem-txt { font-variant-numeric: tabular-nums; color: #4caf50; font-size: 9px; text-align: right; }
      .pl-row .pl-rem-bar { height: 3px; background: #333; border-radius: 2px; overflow: hidden; }
      .pl-row .pl-rem-bar .bar { height: 100%; background: #4caf50; width: 0%; }
      .pl-row .pl-actions { display: flex; gap: 3px; justify-content: flex-end; }
      .pl-row button { cursor: pointer; padding: 3px 6px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee; font-size: 10px; }
      .pl-row button.cue-active { background: #b8860b; border-color: #d4a017; }
      p.empty { font-size: 12px; color: #888; }
      .carts-section { margin-top: 14px; border-top: 1px solid #333; padding-top: 10px; }
      .carts-section h4 { margin: 0 0 6px; font-size: 12px; color: #999; font-weight: normal; }
      .cart-active-banner {
        display: none; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 10px; border-radius: 4px; background: #7a1f1f; margin-bottom: 8px;
      }
      .cart-active-banner.shown { display: flex; }
      .cart-active-banner button {
        cursor: pointer; padding: 4px 10px; border-radius: 3px; border: 1px solid #eee;
        background: #eee; color: #7a1f1f; font-weight: bold;
      }
      .cart {
        border: 1px solid #444; border-radius: 4px; padding: 6px 8px;
        margin-bottom: 4px; display: flex; align-items: center; gap: 8px;
      }
      .cart .label { flex: 1; }
      .cart button { cursor: pointer; padding: 4px 8px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee; }
      .cart button.fire { border-color: #d4a017; }
      .cart button.fire:disabled, .cart button.remove:disabled { opacity: 0.4; cursor: default; }
    `;

    const targetsRow = document.createElement("div");
    targetsRow.className = "targets";
    // Nutzerwunsch 2026-07-22: Player-/Mixer-Ziel wie beim Video-Mixer-
    // DSK aus einer Discovery-Liste wählen statt den exakten Node-Label-
    // Text selbst eintippen zu müssen (main.rs::AutomationState::
    // discovered_labels/availableNodes-Param, remote::list_node_labels).
    const playerLabelSelect = document.createElement("select");
    playerLabelSelect.className = "target-select";
    const mixerLabelSelect = document.createElement("select");
    mixerLabelSelect.className = "target-select";
    const connectedEl = document.createElement("span");
    connectedEl.className = "connected";
    connectedEl.textContent = "nicht verbunden";
    const playerLabelWrap = document.createElement("label");
    playerLabelWrap.append("Player: ", playerLabelSelect);
    const mixerLabelWrap = document.createElement("label");
    mixerLabelWrap.append("Mixer: ", mixerLabelSelect);
    targetsRow.append(playerLabelWrap, mixerLabelWrap, connectedEl);

    const statusRow = document.createElement("div");
    statusRow.className = "status-row";
    const modeBadge = document.createElement("span");
    modeBadge.className = "mode-badge";
    const modeSelect = document.createElement("select");
    modeSelect.className = "mode-select";
    for (const [value, text] of [["auto", "Auto"], ["hold", "Hold"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      modeSelect.append(opt);
    }
    const takeBtn = document.createElement("button");
    takeBtn.className = "take";
    takeBtn.textContent = "TAKE";
    takeBtn.addEventListener("click", () => call("take", {}).then(poll));

    // Listenansicht-Folgeschritt, PIPELINE-CONTROLLER-Parität
    // (`ui.html`s "Playlist Control"-Leiste: ▶▶ Next / ▶ Live / ■ Stop).
    const nextBtn = document.createElement("button");
    nextBtn.className = "pl-ctrl-btn";
    nextBtn.textContent = "▶▶ Next";
    nextBtn.title = "Sofort zum nächsten Rundown-Item (auch im Hold-Modus)";
    nextBtn.addEventListener("click", () => call("next", {}).then(poll));

    const nextLiveBtn = document.createElement("button");
    nextLiveBtn.className = "pl-ctrl-btn";
    nextLiveBtn.textContent = "▶ Live";
    nextLiveBtn.title = "Zum nächsten Live-Quellen-Item springen";
    nextLiveBtn.addEventListener("click", () => call("nextLive", {}).then(poll));

    const stopBtn = document.createElement("button");
    stopBtn.className = "pl-ctrl-btn stop";
    stopBtn.textContent = "■ Stop";
    stopBtn.title = "Hauptkanal sofort auf Schwarzbild schalten (Rundown bleibt erhalten)";
    stopBtn.addEventListener("click", () => {
      if (!confirm("Hauptkanal wirklich auf Schwarzbild schalten?")) return;
      call("stop", {}).then(poll);
    });

    statusRow.append(modeBadge, modeSelect, takeBtn, nextBtn, nextLiveBtn, stopBtn);

    const progress = document.createElement("div");
    progress.className = "progress";
    const progressBar = document.createElement("div");
    progressBar.className = "bar";
    progress.append(progressBar);

    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = "Titel";
    // Rundown-Echtmedien-Folgeschritt: Quelltyp-Wahl statt reinem
    // Testmuster-Dropdown — spiegelt omp-players eigene append/load-
    // Precedence (senderId > file > pattern, s. main.rs-Doku dort).
    const sourceTypeSelect = document.createElement("select");
    for (const [v, t] of [["pattern", "Testmuster"], ["file", "Datei"], ["live", "Live-Quelle"]]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = t;
      sourceTypeSelect.append(opt);
    }
    const patternSelect = document.createElement("select");
    for (const p of ["smpte", "ball", "snow", "circular", "checkers-1", "solid-color"]) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      patternSelect.append(opt);
    }
    const fileSelect = document.createElement("select");
    const liveSelect = document.createElement("select");
    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.placeholder = "Dauer (ms)";
    durationInput.value = "5000";
    const updateSourceTypeVisibility = () => {
      const v = sourceTypeSelect.value;
      patternSelect.style.display = v === "pattern" ? "" : "none";
      fileSelect.style.display = v === "file" ? "" : "none";
      liveSelect.style.display = v === "live" ? "" : "none";
      // Bei Datei-Items probt der Ziel-Player die echte Clip-Dauer und
      // ignoriert ein mitgeschicktes durationMs vollständig (s. main.rs
      // dort) — das Feld hier wäre irreführend.
      durationInput.style.display = v === "file" ? "none" : "";
    };
    sourceTypeSelect.addEventListener("change", updateSourceTypeVisibility);
    updateSourceTypeVisibility();
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Item";
    addBtn.addEventListener("click", () => {
      const body = { label: labelInput.value.trim() || "Item" };
      if (sourceTypeSelect.value === "file") {
        if (!fileSelect.value) return;
        body.file = fileSelect.value;
      } else if (sourceTypeSelect.value === "live") {
        if (!liveSelect.value) return;
        body.senderId = liveSelect.value;
        body.durationMs = parseFloat(durationInput.value) || 5000;
      } else {
        body.pattern = patternSelect.value;
        body.toneFrequency = 0;
        body.durationMs = parseFloat(durationInput.value) || 5000;
      }
      call("append", body).then(() => {
        labelInput.value = "";
        poll();
      });
    });
    addRow.append(labelInput, sourceTypeSelect, patternSelect, fileSelect, liveSelect, durationInput, addBtn);

    // Listenansicht (PIPELINE-CONTROLLER-Parität, .pl-hdr-row dort) —
    // Spaltentitel über den Zeilen, gleiches Grid-Template wie .pl-row.
    const listHdr = document.createElement("div");
    listHdr.className = "pl-hdr-row pl-grid-cols";
    for (const t of ["", "#", "", "Titel", "Dauer", "Zeit", "Rest", ""]) {
      const cell = document.createElement("span");
      cell.textContent = t;
      listHdr.append(cell);
    }

    const list = document.createElement("div");
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = '"+ Item" zum Anlegen des Rundowns';

    // C18 (ARCHITECTURE.md §24.3): Cart-/Interrupt-Assets — eigener
    // Abschnitt unterhalb des Rundowns, gleiches Add-Row-Muster wie
    // oben, plus ein "aktiv"-Banner mit Return-Knopf.
    const cartsSection = document.createElement("div");
    cartsSection.className = "carts-section";
    const cartsHeading = document.createElement("h4");
    cartsHeading.textContent = "Carts / Interrupts";
    const activeCartBanner = document.createElement("div");
    activeCartBanner.className = "cart-active-banner";
    const activeCartLabel = document.createElement("span");
    const returnBtn = document.createElement("button");
    returnBtn.textContent = "RETURN";
    returnBtn.addEventListener("click", () => call("cart.return", {}).then(poll));
    activeCartBanner.append(activeCartLabel, returnBtn);

    const cartAddRow = document.createElement("div");
    cartAddRow.className = "add-row";
    const cartLabelInput = document.createElement("input");
    cartLabelInput.type = "text";
    cartLabelInput.placeholder = "Titel";
    const cartPatternSelect = document.createElement("select");
    for (const p of ["smpte", "ball", "snow", "circular", "checkers-1", "solid-color"]) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      cartPatternSelect.append(opt);
    }
    const cartDurationInput = document.createElement("input");
    cartDurationInput.type = "number";
    cartDurationInput.placeholder = "Dauer (ms), 0 = manuell";
    cartDurationInput.value = "0";
    const cartAddBtn = document.createElement("button");
    cartAddBtn.textContent = "+ Cart";
    cartAddBtn.addEventListener("click", () => {
      call("cart.define", {
        label: cartLabelInput.value.trim() || "Cart",
        pattern: cartPatternSelect.value,
        toneFrequency: 0,
        durationMs: parseFloat(cartDurationInput.value) || 0,
      }).then(() => {
        cartLabelInput.value = "";
        poll();
      });
    });
    cartAddRow.append(cartLabelInput, cartPatternSelect, cartDurationInput, cartAddBtn);

    const cartList = document.createElement("div");
    const cartsEmpty = document.createElement("p");
    cartsEmpty.className = "empty";
    cartsEmpty.textContent = '"+ Cart" zum Anlegen eines Interrupt-Assets (Blackclip, Standby, …)';
    cartsSection.append(cartsHeading, activeCartBanner, cartAddRow, cartList, cartsEmpty);

    shadow.append(style, targetsRow, statusRow, progress, addRow, listHdr, list, empty, cartsSection);

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });

    const setParam = (name, value) =>
      fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    // Sofort-Anwenden bei Auswahl, gleiches Muster wie
    // `omp-video-mixer-me`s DSK-Quellauswahl (`keyerSourceSelect`) —
    // kein separater Übernehmen-Schritt nötig.
    playerLabelSelect.addEventListener("change", () => setParam("targetPlayerLabel", playerLabelSelect.value));
    mixerLabelSelect.addEventListener("change", () => setParam("targetMixerLabel", mixerLabelSelect.value));
    modeSelect.addEventListener("change", () => setParam("mode", modeSelect.value));

    // Baut die Optionsliste eines Ziel-Selects neu auf, nur wenn sich die
    // Discovery-Liste tatsächlich geändert hat (Options-Key-Vergleich,
    // gleiches Muster wie `omp-video-mixer-me::buildGroupedOptions`s
    // Aufrufer) — verhindert, dass ein offener Dropdown unter dem Cursor
    // bei jedem 1s-Poll zuklappt. `currentValue` bleibt auch dann als
    // Option erhalten, wenn der konfigurierte Node gerade nicht (mehr)
    // discovered ist (z. B. kurz offline) — sonst ginge die Konfiguration
    // beim nächsten Poll sichtbar verloren.
    const buildTargetOptions = (selectEl, labels, currentValue) => {
      const allLabels = currentValue && !labels.includes(currentValue) ? [currentValue, ...labels] : labels;
      const optionsKey = JSON.stringify(allLabels);
      if (selectEl.dataset.optionsKey === optionsKey) return;
      selectEl.dataset.optionsKey = optionsKey;
      selectEl.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— wählen —";
      selectEl.append(placeholder);
      for (const label of allLabels) {
        const opt = document.createElement("option");
        opt.value = label;
        opt.textContent = label;
        selectEl.append(opt);
      }
    };

    // Wie `buildTargetOptions`, aber ohne "aktuellen Wert immer erhalten"
    // (Add-Formular-Selects, kein am Node hängender Zielwert) — für die
    // Rundown-Echtmedien-Auswahl (Datei-/Live-Liste vom Ziel-Player).
    const buildSimpleOptions = (selectEl, values, placeholderText) => {
      const optionsKey = JSON.stringify(values);
      if (selectEl.dataset.optionsKey === optionsKey) return;
      selectEl.dataset.optionsKey = optionsKey;
      const prevValue = selectEl.value;
      selectEl.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = placeholderText;
      selectEl.append(placeholder);
      for (const v of values) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        selectEl.append(opt);
      }
      if (values.includes(prevValue)) selectEl.value = prevValue;
    };

    // `entries`: [{value, text}] — für Live-Quellen (senderId != Label).
    const buildKeyedOptions = (selectEl, entries, placeholderText) => {
      const optionsKey = JSON.stringify(entries);
      if (selectEl.dataset.optionsKey === optionsKey) return;
      selectEl.dataset.optionsKey = optionsKey;
      const prevValue = selectEl.value;
      selectEl.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = placeholderText;
      selectEl.append(placeholder);
      for (const entry of entries) {
        const opt = document.createElement("option");
        opt.value = entry.value;
        opt.textContent = entry.text;
        selectEl.append(opt);
      }
      if (entries.some((e) => e.value === prevValue)) selectEl.value = prevValue;
    };

    // itemId -> { el, dragEl, numEl, iconEl, titleEl, durEl, timeEl, remTxt, remBarInner, cueBtn, removeBtn }
    const itemEls = new Map();

    // Listenansicht-Folgeschritt: Icon je nach tatsächlich zugewiesener
    // Quelle (genau eines von pattern/file/senderId ist gesetzt, s.
    // omp-playout-automation main.rs::item_meta_to_json).
    const sourceIcon = (item) => (item.senderId ? "📡" : item.file ? "📁" : "🎨");

    // Drag&Drop-Reorder (Listenansicht-Folgeschritt, PIPELINE-CONTROLLER-
    // Parität — `plDragStart`/`plDragOver`/`plDrop` dort): baut die neue
    // Reihenfolge aus dem zuletzt gepollten `lastItems` und schreibt sie
    // per `load()` komplett neu. Bewusst nur erlaubt, wenn NICHTS gerade
    // on-air ist — `load()` setzt beim Ziel-Player unbedingt beide
    // Pipeline-Slots auf Schwarzbild zurück (s. dessen `main.rs`), ein
    // Reorder während laufender Sendung würde also den Hauptkanal
    // sichtbar kurz schwarz schalten. Anders als im PC-Original (das
    // Array-Reorder ohne Pipeline-Neuaufbau kennt) — dokumentierte
    // Lücke, kein automatisches "wie drüben".
    let lastItems = [];
    let dragSourceId = null;
    const itemToLoadEntry = (item) => {
      const entry = { label: item.label, durationMs: item.durationMs };
      if (item.senderId) entry.senderId = item.senderId;
      else if (item.file) entry.file = item.file;
      else {
        entry.pattern = item.pattern;
        entry.toneFrequency = item.toneFrequency;
      }
      return entry;
    };
    const reorderItems = (draggedId, targetId) => {
      const ids = lastItems.map((it) => it.id);
      const fromIdx = ids.indexOf(draggedId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const reordered = lastItems.slice();
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      call("load", { itemsJson: JSON.stringify(reordered.map(itemToLoadEntry)) }).then(poll);
    };

    const createItemElement = (item) => {
      const el = document.createElement("div");
      el.className = "pl-row pl-grid-cols";

      const dragEl = document.createElement("span");
      dragEl.className = "pl-drag";
      dragEl.textContent = "⠿";

      const numEl = document.createElement("span");
      numEl.className = "pl-num";

      const iconEl = document.createElement("span");
      iconEl.className = "pl-icon";

      const titleEl = document.createElement("span");
      titleEl.className = "pl-title";

      const durEl = document.createElement("span");
      durEl.className = "pl-dur";

      // C20 (ARCHITECTURE.md §24.5): Start-/Endzeit aus dem gefensterten
      // Timeline-Endpunkt, separat vom Titel-Text, damit ein Fetch-
      // Fehlschlag (z. B. während eines Node-Neustarts) nur diese
      // Anzeige leer lässt, nicht den ganzen Zeileninhalt ersetzt.
      const timeEl = document.createElement("span");
      timeEl.className = "pl-time";

      const remWrap = document.createElement("span");
      remWrap.className = "pl-rem";
      const remTxt = document.createElement("span");
      remTxt.className = "pl-rem-txt";
      const remBar = document.createElement("span");
      remBar.className = "pl-rem-bar";
      const remBarInner = document.createElement("span");
      remBarInner.className = "bar";
      remBar.append(remBarInner);
      remWrap.append(remTxt, remBar);

      const actionsEl = document.createElement("span");
      actionsEl.className = "pl-actions";
      const cueBtn = document.createElement("button");
      cueBtn.addEventListener("click", () => call("cue", { itemId: item.id }).then(poll));
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.title = "Entfernen";
      removeBtn.addEventListener("click", () => call("remove", { itemId: item.id }).then(poll));
      actionsEl.append(cueBtn, removeBtn);

      el.addEventListener("dragstart", (ev) => {
        dragSourceId = item.id;
        ev.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragover", (ev) => {
        if (!el.draggable) return;
        ev.preventDefault();
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        el.classList.remove("drag-over");
        if (dragSourceId) reorderItems(dragSourceId, item.id);
        dragSourceId = null;
      });

      el.append(dragEl, numEl, iconEl, titleEl, durEl, timeEl, remWrap, actionsEl);
      return { el, dragEl, numEl, iconEl, titleEl, durEl, timeEl, remTxt, remBarInner, cueBtn, removeBtn };
    };

    // Formatiert Millisekunden als mm:ss (Playlists dieses Nodes sind
    // rundown-lang, nicht tagelang — Stunden wären hier unnötiger Ballast).
    const formatMs = (ms) => {
      const totalSec = Math.floor(ms / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    // Rundown-Echtmedien-Folgeschritt: Item-Beschreibung je nach
    // tatsächlich zugewiesener Quelle (genau eines von pattern/file/
    // senderId ist gesetzt, s. omp-playout-automation main.rs::
    // item_meta_to_json). `liveLabelBySenderId` zeigt bei Live-Quellen den
    // aktuellen Discovery-Namen statt der rohen Sender-ID, wenn bekannt.
    // Listenansicht-Folgeschritt: Quell-Detail als Tooltip auf der
    // Titel-Zelle (eigene Icon-Spalte übernimmt die Kurzform, s.
    // `sourceIcon`) statt eines langen Textsuffixes in der schmalen Spalte.
    const describeItem = (item, liveLabelBySenderId) => {
      if (item.senderId) return `Live: ${liveLabelBySenderId.get(item.senderId) || item.senderId}`;
      if (item.file) return `Datei: ${item.file}`;
      return `Testmuster: ${item.pattern}`;
    };

    // Gefensterte Timeline-Anfrage (C20): nur so viele Einträge wie
    // tatsächlich gerade gerendert werden (count = Item-Anzahl), nicht
    // "alles" oder ein fest verdrahtetes Maximum — bei einer langen
    // Playlist entspricht das genau dem PC-Antipattern-Fix aus §24.5
    // (kein Full-Recompute für Items, die die UI gar nicht zeigt).
    const getTimelineWindow = async (fromIndex, count) => {
      if (count <= 0) return [];
      const res = await fetch(
        `/api/v1/nodes/${nodeId}/timeline/window?fromIndex=${fromIndex}&count=${count}`
      );
      if (!res.ok) return [];
      return await res.json();
    };

    // assetId -> { el, labelEl, fireBtn, removeBtn }
    const cartEls = new Map();

    const createCartElement = (asset) => {
      const el = document.createElement("div");
      el.className = "cart";

      const labelEl = document.createElement("span");
      labelEl.className = "label";

      const fireBtn = document.createElement("button");
      fireBtn.className = "fire";
      fireBtn.textContent = "Fire";
      fireBtn.addEventListener("click", () => call("cart.fire", { assetId: asset.id }).then(poll));

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove";
      removeBtn.textContent = "Entfernen";
      removeBtn.addEventListener("click", () => call("cart.remove", { assetId: asset.id }).then(poll));

      el.append(labelEl, fireBtn, removeBtn);
      return { el, labelEl, fireBtn, removeBtn };
    };

    const poll = async () => {
      const [
        itemsValue,
        currentItemId,
        cuedItemId,
        mode,
        connected,
        playheadMs,
        durationMs,
        assetsValue,
        activeCartId,
        availableNodesValue,
        targetPlayerLabel,
        targetMixerLabel,
        mediaLibraryValue,
        availableSourcesValue,
      ] = await Promise.all([
        getParam("items"),
        getParam("currentItemId"),
        getParam("cuedItemId"),
        getParam("mode"),
        getParam("connected"),
        getParam("playheadPositionMs"),
        getParam("currentDurationMs"),
        getParam("assets"),
        getParam("activeCartId"),
        getParam("availableNodes"),
        getParam("targetPlayerLabel"),
        getParam("targetMixerLabel"),
        getParam("mediaLibrary"),
        getParam("availableSources"),
      ]);
      const items = itemsValue || [];
      const currentIds = new Set(items.map((it) => it.id));
      lastItems = items;

      // Rundown-Echtmedien-Folgeschritt: Add-Formular-Selects aus dem
      // Ziel-Player-Spiegel befüllen.
      const availableSources = availableSourcesValue || [];
      buildSimpleOptions(fileSelect, mediaLibraryValue || [], "— Datei wählen —");
      buildKeyedOptions(
        liveSelect,
        availableSources.map((s) => ({ value: s.senderId, text: s.label })),
        "— Quelle wählen —"
      );
      const liveLabelBySenderId = new Map(availableSources.map((s) => [s.senderId, s.label]));

      for (const [id, refs] of itemEls) {
        if (!currentIds.has(id)) {
          refs.el.remove();
          itemEls.delete(id);
        }
      }

      empty.style.display = items.length === 0 ? "" : "none";
      const onAir = !!currentItemId;
      modeBadge.textContent = onAir ? "ON AIR" : "STANDBY";
      modeBadge.className = onAir ? "mode-badge onair" : "mode-badge";
      takeBtn.disabled = !cuedItemId;
      connectedEl.textContent = connected ? "verbunden" : "nicht verbunden";
      connectedEl.className = connected ? "connected ok" : "connected";

      // Listenansicht-Folgeschritt: Next/Next-Live-Verfügbarkeit
      // (PIPELINE-CONTROLLER-Parität, `ui.html::updateNextLiveBtn` —
      // ohne dessen Fix-Zeit-Blockade, s. `do_next_live`-Doku in main.rs:
      // OMP-Items kennen dieses Konzept noch nicht).
      nextBtn.disabled = items.length === 0;
      const refId = currentItemId || cuedItemId;
      const refIdx = refId ? items.findIndex((it) => it.id === refId) : -1;
      const startFrom = refIdx >= 0 ? refIdx + 1 : 0;
      const hasAnyLive = items.some((it) => it.senderId);
      const hasNextLive = items.slice(startFrom).some((it) => it.senderId);
      nextLiveBtn.style.display = hasAnyLive ? "" : "none";
      nextLiveBtn.disabled = !hasNextLive;

      const availableLabels = availableNodesValue || [];
      buildTargetOptions(playerLabelSelect, availableLabels, targetPlayerLabel);
      buildTargetOptions(mixerLabelSelect, availableLabels, targetMixerLabel);
      if (shadow.activeElement !== playerLabelSelect) playerLabelSelect.value = targetPlayerLabel || "";
      if (shadow.activeElement !== mixerLabelSelect) mixerLabelSelect.value = targetMixerLabel || "";

      if (mode) modeSelect.value = mode;
      progressBar.style.width = durationMs > 0 ? `${Math.min(100, (100 * (playheadMs || 0)) / durationMs)}%` : "0%";

      // C20: nur so viele Einträge anfragen wie tatsächlich gerendert
      // werden — das eigentliche Fenster.
      const timeline = await getTimelineWindow(0, items.length);
      const timeByIndex = new Map(timeline.map((e) => [e.index, e]));

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let refs = itemEls.get(item.id);
        if (!refs) {
          refs = createItemElement(item);
          itemEls.set(item.id, refs);
          list.append(refs.el);
        }
        const isOnair = item.id === currentItemId;
        const isCued = item.id === cuedItemId;

        refs.numEl.textContent = String(i + 1);
        refs.iconEl.textContent = sourceIcon(item);
        refs.titleEl.textContent = item.label;
        refs.titleEl.title = describeItem(item, liveLabelBySenderId);
        refs.durEl.textContent = `${(item.durationMs / 1000).toFixed(1)}s`;
        const t = timeByIndex.get(i);
        refs.timeEl.textContent = t ? `${formatMs(t.startMs)}–${formatMs(t.endMs)}` : "";

        // Rest+Fortschritt nur für das tatsächlich on-air Item bekannt
        // (automation führt nur einen globalen Playhead, kein Pro-Item-
        // Timer) — gleiche Datenquelle wie der globale Fortschrittsbalken
        // oben (playheadMs/durationMs).
        if (isOnair && durationMs > 0) {
          const remMs = Math.max(0, durationMs - (playheadMs || 0));
          refs.remTxt.textContent = `-${(remMs / 1000).toFixed(1)}s`;
          refs.remBarInner.style.width = `${Math.min(100, (100 * (playheadMs || 0)) / durationMs)}%`;
        } else {
          refs.remTxt.textContent = "";
          refs.remBarInner.style.width = "0%";
        }

        // Reorder-Guard (s. `reorderItems`-Doku): Drag nur erlaubt, wenn
        // nichts on-air ist — `load()` würde sonst den Hauptkanal kurz
        // schwarz schalten.
        refs.el.draggable = !onAir;
        refs.dragEl.title = onAir ? "Reorder während laufender Sendung nicht möglich" : "Ziehen zum Umsortieren";

        refs.el.className = `pl-row pl-grid-cols${isOnair ? " onair" : isCued ? " cued" : ""}`;
        refs.cueBtn.textContent = isCued ? "Gecued" : "Cue";
        refs.cueBtn.className = isCued ? "cue-active" : "";
        refs.cueBtn.disabled = isOnair;
        refs.removeBtn.disabled = isOnair || isCued;
      }

      // C18 (ARCHITECTURE.md §24.3): Cart-Liste + aktiv-Banner.
      const assets = assetsValue || [];
      const assetIds = new Set(assets.map((a) => a.id));
      for (const [id, refs] of cartEls) {
        if (!assetIds.has(id)) {
          refs.el.remove();
          cartEls.delete(id);
        }
      }
      cartsEmpty.style.display = assets.length === 0 ? "" : "none";
      const cartActive = !!activeCartId;
      activeCartBanner.classList.toggle("shown", cartActive);
      if (cartActive) {
        const activeAsset = assets.find((a) => a.id === activeCartId);
        activeCartLabel.textContent = `CART ON AIR: ${activeAsset ? activeAsset.label : activeCartId}`;
      }
      for (const asset of assets) {
        let refs = cartEls.get(asset.id);
        if (!refs) {
          refs = createCartElement(asset);
          cartEls.set(asset.id, refs);
          cartList.append(refs.el);
        }
        const durationLabel = asset.durationMs > 0 ? `${asset.durationMs}ms` : "manuell";
        refs.labelEl.textContent = `${asset.label} (${asset.pattern}, ${durationLabel})`;
        const isFiring = asset.id === activeCartId;
        refs.fireBtn.disabled = cartActive;
        refs.fireBtn.textContent = isFiring ? "On Air" : "Fire";
        refs.removeBtn.disabled = cartActive;
      }
    };

    poll();
    this._interval = setInterval(poll, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-playout-automation-panel")) {
  customElements.define("omp-playout-automation-panel", OmpPlayoutAutomationPanel);
}
