// Node-UI-Bundle des Videoplayers (UMSETZUNG.md C12, ARCHITECTURE.md
// §13.3): kompakte Cue/Take-Ansicht — Playlist als Liste, "Cue"-Button
// pro Item legt es in den Standby-Slot, ein einzelner großer "Take"-Button
// schaltet den zuletzt gecuten Slot auf Programm. Gleiche generische
// Node-Proxy-API wie omp-video-mixer-me/omp-audio-mixer (C10/C11):
// /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>.
//
// Wie C11s Panel: pro Item wird das DOM-Element genau einmal gebaut und
// danach nur noch aktualisiert (kein Rebuild bei jedem 2s-Poll), sonst
// flackert die Liste und ein gerade fokussiertes Eingabefeld verliert den
// Fokus.
class OmpPlayerVideoPanel extends HTMLElement {
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
      label { color: #999; }
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
    empty.textContent = '"+ Item" zum Anlegen der Playlist';
    shadow.append(style, statusRow, addRow, list, empty);

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
      const [itemsValue, currentItemId, cuedItemId, mode, playheadMs] = await Promise.all([
        getParam("items"),
        getParam("currentItemId"),
        getParam("cuedItemId"),
        getParam("mode"),
        getParam("playheadPositionMs"),
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
      modeEl.textContent = mode === "onair" ? "ON AIR" : "SCHWARZ";
      modeEl.className = mode === "onair" ? "mode onair" : "mode";
      playheadEl.textContent = mode === "onair" ? `${Math.round((playheadMs || 0) / 1000)}s` : "";
      takeBtn.disabled = !cuedItemId;

      for (const item of items) {
        let refs = itemEls.get(item.id);
        if (!refs) {
          refs = createItemElement(item);
          itemEls.set(item.id, refs);
          list.append(refs.el);
        }
        refs.labelEl.textContent = `${item.label} (${item.pattern})`;
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
    this._interval = setInterval(poll, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-player-video-panel")) {
  customElements.define("omp-player-video-panel", OmpPlayerVideoPanel);
}
