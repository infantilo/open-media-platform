// Node-UI-Bundle des Audiomischers (UMSETZUNG.md C11/K4-Teil-1,
// ARCHITECTURE.md §13.2, docs/END-GOAL-FEATURES.md §4.3c/§4.4 Teil 1):
// vertikale Kanalzüge auf ui/kit (<omp-fader> für Gain, <omp-knob> für
// die 3 EQ-Bänder, <omp-button> für Mute/AFV/Override, <omp-meter> für
// Pegel), gruppiert unter <omp-panel-section label="Audio Mixer">
// (K3/K4-Feinschliff, §12.3-Referenzvergleich) statt Zahlenfeldern +
// "EQ setzen"-Button. Gleiche generische
// Node-Proxy-API wie zuvor (/api/v1/nodes/<id>/params/<name>,
// /methods/<name>) — reines UI-Bundle + der in `pipeline.rs`/`levels.rs`
// neu hinzugekommene Metering-Pfad (`levelsUrl`-SSE), sonst KEIN neues
// Routing (Aux/Gruppen/Kompressor/Limiter sind Teil 2/3).
//
// Gleiches Flacker-Vermeidungsmuster wie vorher: pro Kanal wird das
// Element genau einmal gebaut (`createChannelElement`), Polls schreiben
// nur noch Werte (`updateChannelElement`) — Kit-Elemente reflektieren
// Werte über Attribute (`value`), das passt direkt in dieses Muster.
// Ein gerade gedraggtes Fader/Knob wird beim Poll nicht überschrieben
// (analog zum bisherigen "fokussiertes Input nicht überschreiben",
// `dragging`-Set statt `activeElement`-Vergleich, weil Kit-Elemente die
// eigentliche Eingabe in ihrem eigenen Shadow-DOM kapseln).
class OmpAudioMixerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        font-family: var(--omp-font, system-ui, sans-serif);
        color: var(--omp-text, #e8eaed);
        font-size: var(--omp-font-size-sm, 12px);
      }
      .console {
        display: flex; gap: var(--omp-space-2, 8px); align-items: flex-start;
        background: var(--omp-surface, #1a1d21);
        border: 1px solid var(--omp-border, #2e3338);
        border-radius: var(--omp-radius, 6px);
        padding: var(--omp-space-3, 12px);
        overflow-x: auto;
      }
      .master {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding-right: var(--omp-space-3, 12px);
        border-right: 1px solid var(--omp-border, #2e3338);
        flex-shrink: 0;
      }
      .master .label { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); text-transform: uppercase; }
      .strip {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        width: 76px; flex-shrink: 0;
        border-right: 1px solid var(--omp-border, #2e3338);
        padding-right: var(--omp-space-2, 8px);
      }
      .strip:last-of-type { border-right: none; }
      .strip .label {
        font-size: 10px; font-weight: 600; text-align: center; max-width: 76px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .strip select { width: 100%; font-size: 10px; background: var(--omp-bg, #101214); color: var(--omp-text, #e8eaed); border: 1px solid var(--omp-border, #2e3338); }
      .eq-row { display: flex; gap: 2px; }
      .fader-row { display: flex; gap: 6px; align-items: flex-end; }
      .strip omp-button { width: 100%; height: 24px; font-size: 10px; }
      .remove-btn { font-size: 9px; color: var(--omp-text-dim, #9aa0a6); background: none; border: none; cursor: pointer; text-decoration: underline; }
      details.afv { width: 100%; font-size: 10px; }
      details.afv summary { cursor: pointer; color: var(--omp-text-dim, #9aa0a6); }
      details.afv .row { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
      details.afv input, details.afv select { width: 100%; font-size: 10px; }
      .add-btn { align-self: flex-start; margin-bottom: var(--omp-space-2, 8px); }
      p.empty { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); }
    `;

    const addBtn = document.createElement("omp-button");
    addBtn.className = "add-btn";
    addBtn.textContent = "+ Kanal";
    addBtn.addEventListener("click", () => call("addChannel", { label: "" }).then(poll));

    const master = document.createElement("div");
    master.className = "master";
    const masterLabel = document.createElement("span");
    masterLabel.className = "label";
    masterLabel.textContent = "Master";
    const masterMeter = document.createElement("omp-meter");
    masterMeter.style.height = "160px";
    master.append(masterLabel, masterMeter);

    const console_ = document.createElement("div");
    console_.className = "console";
    console_.append(master);

    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = 'keine Kanäle — "+ Kanal" zum Hinzufügen';

    // K3/K4-Feinschliff (§12.3-Referenzvergleich): eine gruppierte
    // Sektion mit Kopfzeile statt loser Bausteine — "+ Kanal" gehört
    // sichtbar zum Pult, nicht davor.
    const section = document.createElement("omp-panel-section");
    section.setAttribute("label", "Audio Mixer");
    section.append(addBtn, console_, empty);

    shadow.append(style, section);

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

    // channelId -> refs + Set von Kit-Elementen, die gerade gedraggt
    // werden (kein Poll-Überschreiben während der Eingabe).
    const channelEls = new Map();
    const dragging = new Set();
    const trackDrag = (el) => {
      el.addEventListener("pointerdown", () => dragging.add(el), true);
      el.addEventListener("change", () => dragging.delete(el));
    };

    const createChannelElement = (id, label) => {
      const el = document.createElement("div");
      el.className = "strip";

      const labelEl = document.createElement("span");
      labelEl.className = "label";
      labelEl.textContent = label;

      const meter = document.createElement("omp-meter");

      const sourceSelect = document.createElement("select");
      sourceSelect.addEventListener("change", () =>
        call(`channel.${id}.setSource`, { senderId: sourceSelect.value }).then(poll),
      );

      const eqRow = document.createElement("div");
      eqRow.className = "eq-row";
      const makeKnob = (bandLabel) => {
        const knob = document.createElement("omp-knob");
        knob.setAttribute("min", "-24");
        knob.setAttribute("max", "12");
        knob.setAttribute("default-value", "0");
        knob.setAttribute("center-detent", "");
        knob.textContent = bandLabel;
        trackDrag(knob);
        eqRow.append(knob);
        return knob;
      };
      const eqLowKnob = makeKnob("Lo");
      const eqMidKnob = makeKnob("Mid");
      const eqHighKnob = makeKnob("Hi");
      const applyEq = () =>
        call(`channel.${id}.setEq`, {
          low: eqLowKnob.value,
          mid: eqMidKnob.value,
          high: eqHighKnob.value,
        });
      eqLowKnob.addEventListener("change", applyEq);
      eqMidKnob.addEventListener("change", applyEq);
      eqHighKnob.addEventListener("change", applyEq);

      const faderRow = document.createElement("div");
      faderRow.className = "fader-row";
      const fader = document.createElement("omp-fader");
      fader.setAttribute("min", "-60");
      fader.setAttribute("max", "12");
      fader.setAttribute("default-value", "0");
      trackDrag(fader);
      fader.addEventListener("change", () => call(`channel.${id}.setGain`, { db: fader.value }));
      faderRow.append(fader, meter);

      const muteBtn = document.createElement("omp-button");
      muteBtn.textContent = "Mute";
      muteBtn.setAttribute("color", "onair");
      let muted = false;
      muteBtn.addEventListener("click", () => call(`channel.${id}.setMute`, { muted: !muted }).then(poll));

      const afv = document.createElement("details");
      afv.className = "afv";
      const summary = document.createElement("summary");
      summary.textContent = "AFV";
      const afvRow = document.createElement("div");
      afvRow.className = "row";
      const followInput = document.createElement("input");
      followInput.type = "text";
      followInput.placeholder = "Follow Node-ID";
      const modeSelect = document.createElement("select");
      for (const m of ["off", "cut", "crossfade"]) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        modeSelect.append(opt);
      }
      const followApply = document.createElement("omp-button");
      followApply.textContent = "Setzen";
      followApply.addEventListener("click", () =>
        call(`channel.${id}.setFollow`, { targetNodeId: followInput.value.trim(), mode: modeSelect.value }),
      );
      const overrideBtn = document.createElement("omp-button");
      overrideBtn.textContent = "Override";
      overrideBtn.setAttribute("color", "cue");
      let overrideOn = false;
      overrideBtn.addEventListener("click", () =>
        call(`channel.${id}.setOverride`, { enabled: !overrideOn }).then(poll),
      );
      afvRow.append(followInput, modeSelect, followApply, overrideBtn);
      afv.append(summary, afvRow);

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "entfernen";
      removeBtn.addEventListener("click", () => call("removeChannel", { channelId: id }).then(poll));

      el.append(labelEl, sourceSelect, eqRow, faderRow, muteBtn, afv, removeBtn);

      return {
        el,
        meter,
        sourceSelect,
        eqLowKnob,
        eqMidKnob,
        eqHighKnob,
        fader,
        muteBtn,
        set muted(v) {
          muted = v;
        },
        followInput,
        modeSelect,
        overrideBtn,
        set overrideOn(v) {
          overrideOn = v;
        },
      };
    };

    let lastSourcesKey = "";
    const rebuildSourceOptions = (sourceSelect, sources) => {
      const current = sourceSelect.value;
      sourceSelect.innerHTML = "";
      const internalOpt = document.createElement("option");
      internalOpt.value = "";
      internalOpt.textContent = "Intern (Testton)";
      sourceSelect.append(internalOpt);
      for (const s of sources) {
        const opt = document.createElement("option");
        opt.value = s.senderId;
        opt.textContent = s.label;
        sourceSelect.append(opt);
      }
      sourceSelect.value = current;
    };

    const updateChannelElement = (refs, data) => {
      if (!dragging.has(refs.sourceSelect)) refs.sourceSelect.value = data.source || "";
      if (!dragging.has(refs.fader)) refs.fader.value = data.gain ?? 0;
      refs.muteBtn.active = !!data.mute;
      refs.muted = !!data.mute;
      if (!dragging.has(refs.eqLowKnob)) refs.eqLowKnob.value = data.eqLow ?? 0;
      if (!dragging.has(refs.eqMidKnob)) refs.eqMidKnob.value = data.eqMid ?? 0;
      if (!dragging.has(refs.eqHighKnob)) refs.eqHighKnob.value = data.eqHigh ?? 0;
      if (refs.followInput !== shadow.activeElement) refs.followInput.value = data.followTarget || "";
      refs.modeSelect.value = data.followMode || "off";
      refs.overrideBtn.active = !!data.overrideEnabled;
      refs.overrideOn = !!data.overrideEnabled;
    };

    const fetchChannelData = async (id) => {
      const [source, gain, mute, eqLow, eqMid, eqHigh, followTarget, followMode, overrideEnabled] =
        await Promise.all([
          getParam(`channel.${id}.source`),
          getParam(`channel.${id}.gain`),
          getParam(`channel.${id}.mute`),
          getParam(`channel.${id}.eqLow`),
          getParam(`channel.${id}.eqMid`),
          getParam(`channel.${id}.eqHigh`),
          getParam(`channel.${id}.followTarget`),
          getParam(`channel.${id}.followMode`),
          getParam(`channel.${id}.overrideEnabled`),
        ]);
      return { source, gain, mute, eqLow, eqMid, eqHigh, followTarget, followMode, overrideEnabled };
    };

    const poll = async () => {
      const [channelsValue, availableSourcesValue] = await Promise.all([
        getParam("channels"),
        getParam("availableSources"),
      ]);
      const channels = channelsValue || [];
      const availableSources = availableSourcesValue || [];
      const currentIds = new Set(channels.map((c) => c.id));

      for (const [id, refs] of channelEls) {
        if (!currentIds.has(id)) {
          refs.el.remove();
          channelEls.delete(id);
        }
      }

      empty.style.display = channels.length === 0 ? "" : "none";

      const sourcesKey = JSON.stringify(availableSources);
      const sourcesChanged = sourcesKey !== lastSourcesKey;
      lastSourcesKey = sourcesKey;

      for (const ch of channels) {
        let refs = channelEls.get(ch.id);
        let isNew = false;
        if (!refs) {
          refs = createChannelElement(ch.id, ch.label);
          channelEls.set(ch.id, refs);
          console_.append(refs.el);
          isNew = true;
        }
        if (isNew || sourcesChanged) {
          rebuildSourceOptions(refs.sourceSelect, availableSources);
        }
        const data = await fetchChannelData(ch.id);
        updateChannelElement(refs, data);
      }
    };

    poll();
    this._interval = setInterval(poll, 2000);

    // K4-Teil-1 Metering: eigene EventSource auf den node-lokalen
    // `/levels`-SSE-Port (levelsUrl), unabhängig vom Shell-SSE-Stream
    // (`/api/v1/events`) — anderer Zweck (Pegel, nicht Tally/Graph) und
    // anderer Server (levels.rs, eigener Port, s. dortige Moduldoku).
    getParam("levelsUrl").then((url) => {
      if (!url) return;
      this._levelsSource = new EventSource(url);
      this._levelsSource.onmessage = (ev) => {
        let parsed;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.channelId == null) {
          masterMeter.value = parsed.rms;
          masterMeter.peak = parsed.peak;
          return;
        }
        const refs = channelEls.get(parsed.channelId);
        if (refs) {
          refs.meter.value = parsed.rms;
          refs.meter.peak = parsed.peak;
        }
      };
    });
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    if (this._levelsSource) this._levelsSource.close();
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
