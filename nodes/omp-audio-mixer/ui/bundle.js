// Node-UI-Bundle des Audiomischers (UMSETZUNG.md C11, ARCHITECTURE.md
// §4.5): "+ Kanal"-Button (addChannel), pro Kanal Gain/Mute/EQ/Audio-
// Follow-Video-Konfiguration. Gleiche generische Node-Proxy-API wie
// omp-video-mixer-me (C10): /api/v1/nodes/<id>/params/<name>,
// /api/v1/nodes/<id>/methods/<name>. Pollt alle 2s (Kanalliste ändert
// sich per addChannel/removeChannel zur Laufzeit, ARCHITECTURE.md §13.2:
// "B6 muss Descriptor-Änderungen ohnehin schon per Re-Fetch vertragen").
class OmpAudioMixerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .add-row { margin-bottom: 8px; }
      .add-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      .channel {
        border: 1px solid #444; border-radius: 4px; padding: 6px 8px;
        margin-bottom: 6px; display: grid; gap: 4px;
      }
      .channel-head { display: flex; justify-content: space-between; align-items: center; }
      .channel-head strong { font-size: 13px; }
      .channel-head button { cursor: pointer; background: #5a1a1a; color: #eee; border: 1px solid #a33; border-radius: 3px; }
      .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      label { color: #999; }
      input[type="number"] { width: 56px; }
      input[type="text"] { width: 140px; }
      button.mute-on { background: #a33; }
      button.override-on { background: #b8860b; }
      p.empty { font-size: 12px; color: #888; }
    `;

    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Kanal";
    addBtn.addEventListener("click", () =>
      call("addChannel", { label: "" }).then(refresh),
    );
    addRow.append(addBtn);

    const list = document.createElement("div");
    shadow.append(style, addRow, list);

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

    const renderChannel = async (ch) => {
      const id = ch.id;
      const [gain, mute, eqLow, eqMid, eqHigh, followTarget, followMode, override] =
        await Promise.all([
          getParam(`channel.${id}.gain`),
          getParam(`channel.${id}.mute`),
          getParam(`channel.${id}.eqLow`),
          getParam(`channel.${id}.eqMid`),
          getParam(`channel.${id}.eqHigh`),
          getParam(`channel.${id}.followTarget`),
          getParam(`channel.${id}.followMode`),
          getParam(`channel.${id}.overrideEnabled`),
        ]);

      const el = document.createElement("div");
      el.className = "channel";

      const head = document.createElement("div");
      head.className = "channel-head";
      const title = document.createElement("strong");
      title.textContent = ch.label;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Entfernen";
      removeBtn.addEventListener("click", () =>
        call("removeChannel", { channelId: id }).then(refresh),
      );
      head.append(title, removeBtn);

      const gainRow = document.createElement("div");
      gainRow.className = "row";
      const gainLabel = document.createElement("label");
      gainLabel.textContent = "Gain (dB)";
      const gainInput = document.createElement("input");
      gainInput.type = "number";
      gainInput.step = "0.5";
      gainInput.value = gain ?? 0;
      gainInput.addEventListener("change", () =>
        call(`channel.${id}.setGain`, { db: parseFloat(gainInput.value) || 0 }),
      );
      const muteBtn = document.createElement("button");
      muteBtn.textContent = mute ? "Muted" : "Mute";
      muteBtn.className = mute ? "mute-on" : "";
      muteBtn.addEventListener("click", () =>
        call(`channel.${id}.setMute`, { muted: !mute }).then(refresh),
      );
      gainRow.append(gainLabel, gainInput, muteBtn);

      const eqRow = document.createElement("div");
      eqRow.className = "row";
      const eqInputs = [];
      for (const [bandLabel, val] of [
        ["Low", eqLow],
        ["Mid", eqMid],
        ["High", eqHigh],
      ]) {
        const l = document.createElement("label");
        l.textContent = bandLabel;
        const i = document.createElement("input");
        i.type = "number";
        i.step = "1";
        i.value = val ?? 0;
        eqInputs.push(i);
        eqRow.append(l, i);
      }
      const eqApply = document.createElement("button");
      eqApply.textContent = "EQ setzen";
      eqApply.addEventListener("click", () =>
        call(`channel.${id}.setEq`, {
          low: parseFloat(eqInputs[0].value) || 0,
          mid: parseFloat(eqInputs[1].value) || 0,
          high: parseFloat(eqInputs[2].value) || 0,
        }),
      );
      eqRow.append(eqApply);

      const followRow = document.createElement("div");
      followRow.className = "row";
      const followLabel = document.createElement("label");
      followLabel.textContent = "Follow Node-ID";
      const followInput = document.createElement("input");
      followInput.type = "text";
      followInput.value = followTarget || "";
      const modeSelect = document.createElement("select");
      for (const m of ["off", "cut", "crossfade"]) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        if (m === followMode) opt.selected = true;
        modeSelect.append(opt);
      }
      const followApply = document.createElement("button");
      followApply.textContent = "Follow setzen";
      followApply.addEventListener("click", () =>
        call(`channel.${id}.setFollow`, {
          targetNodeId: followInput.value.trim(),
          mode: modeSelect.value,
        }),
      );
      const overrideBtn = document.createElement("button");
      overrideBtn.textContent = override ? "Override an" : "Override aus";
      overrideBtn.className = override ? "override-on" : "";
      overrideBtn.addEventListener("click", () =>
        call(`channel.${id}.setOverride`, { enabled: !override }).then(refresh),
      );
      followRow.append(followLabel, followInput, modeSelect, followApply, overrideBtn);

      el.append(head, gainRow, eqRow, followRow);
      return el;
    };

    const refresh = async () => {
      const channelsValue = await getParam("channels");
      const channels = channelsValue || [];
      list.innerHTML = "";
      if (channels.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Kanäle — \"+ Kanal\" zum Hinzufügen";
        list.append(empty);
        return;
      }
      for (const ch of channels) {
        list.append(await renderChannel(ch));
      }
    };

    refresh();
    this._interval = setInterval(refresh, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
