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
      .targets input[type="text"] { width: 120px; }
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
      .progress { height: 4px; background: #333; border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
      .progress .bar { height: 100%; background: #4caf50; width: 0%; }
      .add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .add-row input[type="text"] { width: 100px; }
      .add-row input[type="number"] { width: 64px; }
      .add-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      .item {
        border: 1px solid #444; border-radius: 4px; padding: 6px 8px;
        margin-bottom: 4px; display: flex; align-items: center; gap: 8px;
      }
      .item.onair { border-color: #4caf50; background: #16281a; }
      .item.cued { border-color: #b8860b; background: #2a2210; }
      .item .label { flex: 1; }
      .item button { cursor: pointer; padding: 4px 8px; border-radius: 3px; border: 1px solid #555; background: #222; color: #eee; }
      .item button.cue-active { background: #b8860b; border-color: #d4a017; }
      p.empty { font-size: 12px; color: #888; }
    `;

    const targetsRow = document.createElement("div");
    targetsRow.className = "targets";
    const playerLabelInput = document.createElement("input");
    playerLabelInput.type = "text";
    playerLabelInput.placeholder = "Player-Label";
    const mixerLabelInput = document.createElement("input");
    mixerLabelInput.type = "text";
    mixerLabelInput.placeholder = "Mixer-Label";
    const connectedEl = document.createElement("span");
    connectedEl.className = "connected";
    connectedEl.textContent = "nicht verbunden";
    const playerLabelWrap = document.createElement("label");
    playerLabelWrap.append("Player: ", playerLabelInput);
    const mixerLabelWrap = document.createElement("label");
    mixerLabelWrap.append("Mixer: ", mixerLabelInput);
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
    statusRow.append(modeBadge, modeSelect, takeBtn);

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
    const patternSelect = document.createElement("select");
    for (const p of ["smpte", "ball", "snow", "circular", "checkers-1", "solid-color"]) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      patternSelect.append(opt);
    }
    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.placeholder = "Dauer (ms)";
    durationInput.value = "5000";
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Item";
    addBtn.addEventListener("click", () => {
      call("append", {
        label: labelInput.value.trim() || "Item",
        pattern: patternSelect.value,
        toneFrequency: 0,
        durationMs: parseFloat(durationInput.value) || 5000,
      }).then(() => {
        labelInput.value = "";
        poll();
      });
    });
    addRow.append(labelInput, patternSelect, durationInput, addBtn);

    const list = document.createElement("div");
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = '"+ Item" zum Anlegen des Rundowns';
    shadow.append(style, targetsRow, statusRow, progress, addRow, list, empty);

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

    let editingTargets = false;
    playerLabelInput.addEventListener("focus", () => (editingTargets = true));
    mixerLabelInput.addEventListener("focus", () => (editingTargets = true));
    playerLabelInput.addEventListener("blur", () => {
      editingTargets = false;
      setParam("targetPlayerLabel", playerLabelInput.value.trim());
    });
    mixerLabelInput.addEventListener("blur", () => {
      editingTargets = false;
      setParam("targetMixerLabel", mixerLabelInput.value.trim());
    });
    modeSelect.addEventListener("change", () => setParam("mode", modeSelect.value));

    // itemId -> { el, labelEl, cueBtn, removeBtn }
    const itemEls = new Map();

    const createItemElement = (item) => {
      const el = document.createElement("div");
      el.className = "item";

      const labelEl = document.createElement("span");
      labelEl.className = "label";

      const cueBtn = document.createElement("button");
      cueBtn.addEventListener("click", () => call("cue", { itemId: item.id }).then(poll));

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Entfernen";
      removeBtn.addEventListener("click", () => call("remove", { itemId: item.id }).then(poll));

      el.append(labelEl, cueBtn, removeBtn);
      return { el, labelEl, cueBtn, removeBtn };
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
      ] = await Promise.all([
        getParam("items"),
        getParam("currentItemId"),
        getParam("cuedItemId"),
        getParam("mode"),
        getParam("connected"),
        getParam("playheadPositionMs"),
        getParam("currentDurationMs"),
      ]);
      const items = itemsValue || [];
      const currentIds = new Set(items.map((it) => it.id));

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
      if (!editingTargets && document.activeElement !== modeSelect) {
        if (document.activeElement !== playerLabelInput) {
          playerLabelInput.value = (await getParam("targetPlayerLabel")) || "";
        }
        if (document.activeElement !== mixerLabelInput) {
          mixerLabelInput.value = (await getParam("targetMixerLabel")) || "";
        }
      }
      if (mode) modeSelect.value = mode;
      progressBar.style.width = durationMs > 0 ? `${Math.min(100, (100 * (playheadMs || 0)) / durationMs)}%` : "0%";

      for (const item of items) {
        let refs = itemEls.get(item.id);
        if (!refs) {
          refs = createItemElement(item);
          itemEls.set(item.id, refs);
          list.append(refs.el);
        }
        refs.labelEl.textContent = `${item.label} (${item.pattern}, ${item.durationMs}ms)`;
        const isOnair = item.id === currentItemId;
        const isCued = item.id === cuedItemId;
        refs.el.className = isOnair ? "item onair" : isCued ? "item cued" : "item";
        refs.cueBtn.textContent = isCued ? "Gecued" : "Cue";
        refs.cueBtn.className = isCued ? "cue-active" : "";
        refs.cueBtn.disabled = isOnair;
        refs.removeBtn.disabled = isOnair || isCued;
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
