// Node-UI-Bundle des Audiomischers (UMSETZUNG.md C11, ARCHITECTURE.md
// §4.5): "+ Kanal"-Button (addChannel), pro Kanal Gain/Mute/EQ/Audio-
// Follow-Video-Konfiguration. Gleiche generische Node-Proxy-API wie
// omp-video-mixer-me (C10): /api/v1/nodes/<id>/params/<name>,
// /api/v1/nodes/<id>/methods/<name>. Pollt alle 2s (Kanalliste ändert
// sich per addChannel/removeChannel zur Laufzeit, ARCHITECTURE.md §13.2:
// "B6 muss Descriptor-Änderungen ohnehin schon per Re-Fetch vertragen").
//
// Wichtig: jeder Poll baut NICHT das komplette DOM neu (führte zu
// sichtbarem Flackern, da Buttons/Inputs bei jedem Tick verworfen und
// neu erzeugt wurden, inkl. Fokusverlust während der Eingabe) — pro
// Kanal wird das Element genau einmal erzeugt und danach nur noch in
// Werten aktualisiert (`updateChannelElement`); gerade fokussierte
// Inputs werden beim Aktualisieren übersprungen.
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
    addBtn.addEventListener("click", () => call("addChannel", { label: "" }).then(poll));
    addRow.append(addBtn);

    const list = document.createElement("div");
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = 'keine Kanäle — "+ Kanal" zum Hinzufügen';
    shadow.append(style, addRow, list, empty);

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

    // channelId -> { el, gainInput, muteBtn, eqLow/Mid/HighInput,
    //                followInput, modeSelect, overrideBtn }
    const channelEls = new Map();

    // Element wird genau einmal pro Kanal gebaut (beim ersten Sichten);
    // danach nur noch über `updateChannelElement` mit frischen Werten
    // befüllt, nie neu erzeugt — das ist der eigentliche Flacker-Fix.
    const createChannelElement = (id, label) => {
      const el = document.createElement("div");
      el.className = "channel";

      const head = document.createElement("div");
      head.className = "channel-head";
      const title = document.createElement("strong");
      title.textContent = label;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Entfernen";
      removeBtn.addEventListener("click", () =>
        call("removeChannel", { channelId: id }).then(poll),
      );
      head.append(title, removeBtn);

      const gainRow = document.createElement("div");
      gainRow.className = "row";
      const gainLabel = document.createElement("label");
      gainLabel.textContent = "Gain (dB)";
      const gainInput = document.createElement("input");
      gainInput.type = "number";
      gainInput.step = "0.5";
      gainInput.addEventListener("change", () =>
        call(`channel.${id}.setGain`, { db: parseFloat(gainInput.value) || 0 }),
      );
      const muteBtn = document.createElement("button");
      muteBtn.addEventListener("click", () => {
        const nowMuted = muteBtn.dataset.muted === "true";
        call(`channel.${id}.setMute`, { muted: !nowMuted }).then(poll);
      });
      gainRow.append(gainLabel, gainInput, muteBtn);

      const eqRow = document.createElement("div");
      eqRow.className = "row";
      const makeEqInput = (bandLabel) => {
        const l = document.createElement("label");
        l.textContent = bandLabel;
        const i = document.createElement("input");
        i.type = "number";
        i.step = "1";
        eqRow.append(l, i);
        return i;
      };
      const eqLowInput = makeEqInput("Low");
      const eqMidInput = makeEqInput("Mid");
      const eqHighInput = makeEqInput("High");
      const eqApply = document.createElement("button");
      eqApply.textContent = "EQ setzen";
      eqApply.addEventListener("click", () =>
        call(`channel.${id}.setEq`, {
          low: parseFloat(eqLowInput.value) || 0,
          mid: parseFloat(eqMidInput.value) || 0,
          high: parseFloat(eqHighInput.value) || 0,
        }),
      );
      eqRow.append(eqApply);

      const followRow = document.createElement("div");
      followRow.className = "row";
      const followLabel = document.createElement("label");
      followLabel.textContent = "Follow Node-ID";
      const followInput = document.createElement("input");
      followInput.type = "text";
      const modeSelect = document.createElement("select");
      for (const m of ["off", "cut", "crossfade"]) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
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
      overrideBtn.addEventListener("click", () => {
        const nowOn = overrideBtn.dataset.on === "true";
        call(`channel.${id}.setOverride`, { enabled: !nowOn }).then(poll);
      });
      followRow.append(followLabel, followInput, modeSelect, followApply, overrideBtn);

      el.append(head, gainRow, eqRow, followRow);

      return {
        el,
        gainInput,
        muteBtn,
        eqLowInput,
        eqMidInput,
        eqHighInput,
        followInput,
        modeSelect,
        overrideBtn,
      };
    };

    // Nur Werte setzen, keine Elemente neu bauen. Ein gerade fokussierter
    // Input (Nutzer tippt) wird nicht überschrieben, sonst würde der
    // nächste Poll mitten in der Eingabe den Wert zurücksetzen.
    const updateChannelElement = (refs, data) => {
      const active = refs.el.getRootNode().activeElement;
      if (refs.gainInput !== active) refs.gainInput.value = data.gain ?? 0;
      refs.muteBtn.dataset.muted = String(!!data.mute);
      refs.muteBtn.textContent = data.mute ? "Muted" : "Mute";
      refs.muteBtn.className = data.mute ? "mute-on" : "";
      if (refs.eqLowInput !== active) refs.eqLowInput.value = data.eqLow ?? 0;
      if (refs.eqMidInput !== active) refs.eqMidInput.value = data.eqMid ?? 0;
      if (refs.eqHighInput !== active) refs.eqHighInput.value = data.eqHigh ?? 0;
      if (refs.followInput !== active) refs.followInput.value = data.followTarget || "";
      if (refs.modeSelect !== active) refs.modeSelect.value = data.followMode || "off";
      refs.overrideBtn.dataset.on = String(!!data.overrideEnabled);
      refs.overrideBtn.textContent = data.overrideEnabled ? "Override an" : "Override aus";
      refs.overrideBtn.className = data.overrideEnabled ? "override-on" : "";
    };

    const fetchChannelData = async (id) => {
      const [gain, mute, eqLow, eqMid, eqHigh, followTarget, followMode, overrideEnabled] =
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
      return { gain, mute, eqLow, eqMid, eqHigh, followTarget, followMode, overrideEnabled };
    };

    const poll = async () => {
      const channelsValue = await getParam("channels");
      const channels = channelsValue || [];
      const currentIds = new Set(channels.map((c) => c.id));

      for (const [id, refs] of channelEls) {
        if (!currentIds.has(id)) {
          refs.el.remove();
          channelEls.delete(id);
        }
      }

      empty.style.display = channels.length === 0 ? "" : "none";

      for (const ch of channels) {
        let refs = channelEls.get(ch.id);
        if (!refs) {
          refs = createChannelElement(ch.id, ch.label);
          channelEls.set(ch.id, refs);
          list.append(refs.el);
        }
        const data = await fetchChannelData(ch.id);
        updateChannelElement(refs, data);
      }
    };

    poll();
    this._interval = setInterval(poll, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
