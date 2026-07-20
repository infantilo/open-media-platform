// Node-UI-Bundle des Audiomischers (UMSETZUNG.md C11/K4-Teil-1,
// ARCHITECTURE.md §13.2, docs/END-GOAL-FEATURES.md §4.3c/§4.4 Teil 1,
// §4.6 Teil 2 2026-07-17): vertikale Kanalzüge auf ui/kit (<omp-fader>
// für Gain, <omp-knob> für die 3 EQ-Bänder + Kompressor + Freq/Q,
// <omp-button> für Mute/AFV/Override/Comp-Enable, <omp-meter> für
// Pegel), gruppiert unter <omp-panel-section label="Audio Mixer">
// (K3/K4-Feinschliff, §12.3-Referenzvergleich) statt Zahlenfeldern +
// "EQ setzen"-Button. Gleiche generische
// Node-Proxy-API wie zuvor (/api/v1/nodes/<id>/params/<name>,
// /methods/<name>) — reines UI-Bundle + der in `pipeline.rs`/`levels.rs`
// neu hinzugekommene Metering-Pfad (`levelsUrl`-SSE). Kompressor pro
// Kanal + Master-Limiter (§4.6 Teil 2) sind neu, in eigenen
// aufklappbaren `<details>`-Abschnitten (gleiches Muster wie AFV) statt
// dauerhaft sichtbarer Knopfreihen — Aux/Gruppen bleiben weiterhin
// spätere Teile.
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
      details.afv, details.eq-detail, details.dynamics { width: 100%; font-size: 10px; }
      details.afv summary, details.eq-detail summary, details.dynamics summary,
      details.master-limiter summary {
        cursor: pointer; color: var(--omp-text-dim, #9aa0a6);
      }
      details.afv .row { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
      details.afv input, details.afv select { width: 100%; font-size: 10px; }
      details.eq-detail .band-row, details.dynamics .knob-row, details.master-limiter .knob-row {
        display: flex; gap: 4px; margin-top: 4px; justify-content: center;
      }
      details.eq-detail .band-label { font-size: 9px; color: var(--omp-text-dim, #9aa0a6); text-align: center; margin-top: 2px; }
      details.dynamics omp-button, details.master-limiter omp-button { width: 100%; height: 20px; font-size: 9px; margin-top: 2px; }
      details.master-limiter { width: 100%; font-size: 10px; margin-top: 6px; }
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

    // §4.6 Teil 2: Master-Limiter — gleiches Muster wie der
    // Kanal-Kompressor, aber nur einmal (kein `channel.<id>.`-Namensraum).
    const masterLimiterDetail = document.createElement("details");
    masterLimiterDetail.className = "master-limiter";
    const masterLimiterSummary = document.createElement("summary");
    masterLimiterSummary.textContent = "Limiter";
    const masterLimiterEnableBtn = document.createElement("omp-button");
    masterLimiterEnableBtn.textContent = "Limiter Ein";
    masterLimiterEnableBtn.setAttribute("color", "preset");
    let masterLimiterEnabled = false;
    const masterLimiterRow = document.createElement("div");
    masterLimiterRow.className = "knob-row";
    const masterThresholdKnob = document.createElement("omp-knob");
    masterThresholdKnob.setAttribute("min", "-60");
    masterThresholdKnob.setAttribute("max", "0");
    masterThresholdKnob.setAttribute("default-value", "-6");
    masterThresholdKnob.textContent = "Thr";
    const masterRatioKnob = document.createElement("omp-knob");
    masterRatioKnob.setAttribute("min", "1");
    masterRatioKnob.setAttribute("max", "20");
    masterRatioKnob.setAttribute("default-value", "10");
    masterRatioKnob.textContent = "Ratio";
    const masterMakeupKnob = document.createElement("omp-knob");
    masterMakeupKnob.setAttribute("min", "0");
    masterMakeupKnob.setAttribute("max", "24");
    masterMakeupKnob.setAttribute("default-value", "0");
    masterMakeupKnob.textContent = "Makeup";
    masterLimiterRow.append(masterThresholdKnob, masterRatioKnob, masterMakeupKnob);
    const applyMasterLimiter = () =>
      call("setMasterLimiter", {
        enabled: masterLimiterEnabled,
        thresholdDb: masterThresholdKnob.value,
        ratio: masterRatioKnob.value,
        makeupDb: masterMakeupKnob.value,
      });
    masterLimiterEnableBtn.addEventListener("click", () => {
      masterLimiterEnabled = !masterLimiterEnabled;
      applyMasterLimiter().then(pollMaster);
    });
    masterThresholdKnob.addEventListener("change", applyMasterLimiter);
    masterRatioKnob.addEventListener("change", applyMasterLimiter);
    masterMakeupKnob.addEventListener("change", applyMasterLimiter);
    masterLimiterDetail.append(masterLimiterSummary, masterLimiterEnableBtn, masterLimiterRow);

    master.append(masterLabel, masterMeter, masterLimiterDetail);

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

    // §4.6 Punkt 4 (docs/END-GOAL-FEATURES.md, "Mixer-Presets",
    // docs/decisions.md Nachtrag 40): derselbe generische Snapshot-
    // Mechanismus wie die Flow-Editor-Szenenleiste (UMSETZUNG.md B7,
    // ui/graph/flow-canvas.ts), per `nodeIds:[nodeId]` auf genau diesen
    // Node eingeschränkt. Erfasst hier über `GET/POST /state`
    // (main.rs::capture_state/restore_state), nicht über PATCH — alle
    // Kanalparameter sind bewusst readonly:true (s. main.rs), der
    // generische Parameter-Proxy allein hätte nichts erfasst.
    const presetSaveBtn = document.createElement("omp-button");
    presetSaveBtn.textContent = "Preset speichern";
    const presetList = document.createElement("div");
    presetList.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:var(--omp-space-2, 8px);";

    const renderPresets = async () => {
      presetList.replaceChildren();
      const res = await fetch("/api/v1/snapshots");
      if (!res.ok) return;
      const snaps = await res.json();
      const mine = snaps.filter(
        (s) => Array.isArray(s.nodeIds) && s.nodeIds.length === 1 && s.nodeIds[0] === nodeId,
      );
      if (mine.length === 0) {
        const empty_ = document.createElement("span");
        empty_.textContent = "keine Presets gespeichert";
        empty_.style.cssText = "color:var(--omp-text-dim, #9aa0a6);font-size:11px;";
        presetList.appendChild(empty_);
        return;
      }
      for (const snap of mine) {
        const chip = document.createElement("omp-button");
        chip.textContent = snap.label || snap.id.slice(0, 8);
        chip.title = "Preset anwenden";
        chip.addEventListener("click", async () => {
          await fetch(`/api/v1/snapshots/${snap.id}/apply`, { method: "POST" });
          // Sofort sichtbar statt bis zum nächsten Poll zu warten
          // (`poll`/`pollMaster` unten deklariert, aber zum Zeitpunkt
          // eines tatsächlichen Klicks längst verfügbar).
          await Promise.all([poll(), pollMaster()]);
        });
        presetList.appendChild(chip);
      }
    };

    presetSaveBtn.addEventListener("click", async () => {
      const label = prompt("Name des Presets:", "Neues Preset");
      if (!label) return;
      await fetch("/api/v1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, nodeIds: [nodeId] }),
      });
      await renderPresets();
    });

    const presetSection = document.createElement("omp-panel-section");
    presetSection.setAttribute("label", "Presets");
    presetSection.append(presetSaveBtn, presetList);

    shadow.append(style, section, presetSection);
    renderPresets();

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

      // §4.6: Frequenz+Bandbreite je Band, aufklappbar (nicht dauerhaft
      // sichtbar wie die Gain-Knöpfe oben — drei zusätzliche Regler pro
      // Band wären für den Normalfall "kurz am Gain drehen" zu viel).
      const eqDetail = document.createElement("details");
      eqDetail.className = "eq-detail";
      const eqSummary = document.createElement("summary");
      eqSummary.textContent = "EQ Freq/Q";
      const makeBandFreqWidth = (bandLabel) => {
        const row = document.createElement("div");
        row.className = "band-row";
        const freqKnob = document.createElement("omp-knob");
        freqKnob.setAttribute("min", "20");
        freqKnob.setAttribute("max", "20000");
        freqKnob.textContent = "Freq";
        const widthKnob = document.createElement("omp-knob");
        widthKnob.setAttribute("min", "10");
        widthKnob.setAttribute("max", "20000");
        widthKnob.textContent = "Q";
        trackDrag(freqKnob);
        trackDrag(widthKnob);
        row.append(freqKnob, widthKnob);
        const label = document.createElement("div");
        label.className = "band-label";
        label.textContent = bandLabel;
        const apply = () =>
          call(`channel.${id}.setEqBand`, {
            band: bandLabel === "Lo" ? "low" : bandLabel === "Mid" ? "mid" : "high",
            freq: freqKnob.value,
            width: widthKnob.value,
          });
        freqKnob.addEventListener("change", apply);
        widthKnob.addEventListener("change", apply);
        eqDetail.append(row, label);
        return { freqKnob, widthKnob };
      };
      const eqLowBand = makeBandFreqWidth("Lo");
      const eqMidBand = makeBandFreqWidth("Mid");
      const eqHighBand = makeBandFreqWidth("High");
      eqDetail.prepend(eqSummary);

      // §4.6 Teil 2: Kompressor pro Kanal, ebenfalls aufklappbar.
      const compDetail = document.createElement("details");
      compDetail.className = "dynamics";
      const compSummary = document.createElement("summary");
      compSummary.textContent = "Comp";
      const compEnableBtn = document.createElement("omp-button");
      compEnableBtn.textContent = "Comp Ein";
      compEnableBtn.setAttribute("color", "preset");
      let compEnabled = false;
      const compRow = document.createElement("div");
      compRow.className = "knob-row";
      const compThresholdKnob = document.createElement("omp-knob");
      compThresholdKnob.setAttribute("min", "-60");
      compThresholdKnob.setAttribute("max", "0");
      compThresholdKnob.setAttribute("default-value", "-20");
      compThresholdKnob.textContent = "Thr";
      const compRatioKnob = document.createElement("omp-knob");
      compRatioKnob.setAttribute("min", "1");
      compRatioKnob.setAttribute("max", "20");
      compRatioKnob.setAttribute("default-value", "2");
      compRatioKnob.textContent = "Ratio";
      const compMakeupKnob = document.createElement("omp-knob");
      compMakeupKnob.setAttribute("min", "0");
      compMakeupKnob.setAttribute("max", "24");
      compMakeupKnob.setAttribute("default-value", "0");
      compMakeupKnob.textContent = "Makeup";
      trackDrag(compThresholdKnob);
      trackDrag(compRatioKnob);
      trackDrag(compMakeupKnob);
      compRow.append(compThresholdKnob, compRatioKnob, compMakeupKnob);
      const applyComp = () =>
        call(`channel.${id}.setComp`, {
          enabled: compEnabled,
          thresholdDb: compThresholdKnob.value,
          ratio: compRatioKnob.value,
          makeupDb: compMakeupKnob.value,
        });
      compEnableBtn.addEventListener("click", () => {
        compEnabled = !compEnabled;
        applyComp().then(poll);
      });
      compThresholdKnob.addEventListener("change", applyComp);
      compRatioKnob.addEventListener("change", applyComp);
      compMakeupKnob.addEventListener("change", applyComp);
      compDetail.append(compSummary, compEnableBtn, compRow);

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

      // §4.6 Nachtrag Punkt 3 (Audio-Follow-Video-Pegel): "Stumm"
      // (Default, unverändertes Verhalten — regulärer Fader bleibt
      // maßgeblich) oder eigenständige An-/Aus-Pegel + Transition-Zeit
      // (Fader wird währenddessen ignoriert, s. ChannelState-Doku in
      // main.rs).
      const followLevelsRow = document.createElement("div");
      followLevelsRow.className = "row";
      const followMuteLabel = document.createElement("label");
      const followMuteCheckbox = document.createElement("input");
      followMuteCheckbox.type = "checkbox";
      followMuteCheckbox.checked = true;
      followMuteLabel.append(followMuteCheckbox, " Stumm");
      const followOnLevelInput = document.createElement("input");
      followOnLevelInput.type = "number";
      followOnLevelInput.step = "1";
      followOnLevelInput.placeholder = "An-Pegel dB";
      const followOffLevelInput = document.createElement("input");
      followOffLevelInput.type = "number";
      followOffLevelInput.step = "1";
      followOffLevelInput.placeholder = "Off-Pegel dB";
      const followTransitionInput = document.createElement("input");
      followTransitionInput.type = "number";
      followTransitionInput.step = "50";
      followTransitionInput.min = "0";
      followTransitionInput.placeholder = "Transition ms";
      const setLevelInputsDisabled = (disabled) => {
        followOnLevelInput.disabled = disabled;
        followOffLevelInput.disabled = disabled;
        followTransitionInput.disabled = disabled;
      };
      setLevelInputsDisabled(true);
      followMuteCheckbox.addEventListener("change", () => setLevelInputsDisabled(followMuteCheckbox.checked));
      const followLevelsApply = document.createElement("omp-button");
      followLevelsApply.textContent = "AFV-Pegel setzen";
      followLevelsApply.addEventListener("click", () =>
        call(`channel.${id}.setFollowLevels`, {
          useMute: followMuteCheckbox.checked,
          onLevelDb: followOnLevelInput.value === "" ? 0 : Number(followOnLevelInput.value),
          offLevelDb: followOffLevelInput.value === "" ? -20 : Number(followOffLevelInput.value),
          transitionMs: followTransitionInput.value === "" ? 500 : Number(followTransitionInput.value),
        }),
      );
      followLevelsRow.append(
        followMuteLabel,
        followOnLevelInput,
        followOffLevelInput,
        followTransitionInput,
        followLevelsApply,
      );

      afvRow.append(followInput, modeSelect, followApply, overrideBtn);
      afv.append(summary, afvRow, followLevelsRow);

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "entfernen";
      removeBtn.addEventListener("click", () => call("removeChannel", { channelId: id }).then(poll));

      el.append(labelEl, sourceSelect, eqRow, eqDetail, compDetail, faderRow, muteBtn, afv, removeBtn);

      return {
        el,
        meter,
        sourceSelect,
        eqLowKnob,
        eqMidKnob,
        eqHighKnob,
        eqLowBand,
        eqMidBand,
        eqHighBand,
        compEnableBtn,
        compThresholdKnob,
        compRatioKnob,
        compMakeupKnob,
        set compEnabled(v) {
          compEnabled = v;
        },
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
        followMuteCheckbox,
        followOnLevelInput,
        followOffLevelInput,
        followTransitionInput,
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
      if (!dragging.has(refs.eqLowBand.freqKnob)) refs.eqLowBand.freqKnob.value = data.eqLowFreq ?? 100;
      if (!dragging.has(refs.eqLowBand.widthKnob)) refs.eqLowBand.widthKnob.value = data.eqLowWidth ?? 200;
      if (!dragging.has(refs.eqMidBand.freqKnob)) refs.eqMidBand.freqKnob.value = data.eqMidFreq ?? 1000;
      if (!dragging.has(refs.eqMidBand.widthKnob)) refs.eqMidBand.widthKnob.value = data.eqMidWidth ?? 1000;
      if (!dragging.has(refs.eqHighBand.freqKnob)) refs.eqHighBand.freqKnob.value = data.eqHighFreq ?? 8000;
      if (!dragging.has(refs.eqHighBand.widthKnob)) refs.eqHighBand.widthKnob.value = data.eqHighWidth ?? 4000;
      refs.compEnableBtn.active = !!data.compEnabled;
      refs.compEnabled = !!data.compEnabled;
      if (!dragging.has(refs.compThresholdKnob)) refs.compThresholdKnob.value = data.compThreshold ?? -20;
      if (!dragging.has(refs.compRatioKnob)) refs.compRatioKnob.value = data.compRatio ?? 2;
      if (!dragging.has(refs.compMakeupKnob)) refs.compMakeupKnob.value = data.compMakeup ?? 0;
      if (refs.followInput !== shadow.activeElement) refs.followInput.value = data.followTarget || "";
      refs.modeSelect.value = data.followMode || "off";
      refs.overrideBtn.active = !!data.overrideEnabled;
      refs.overrideOn = !!data.overrideEnabled;
      if (refs.followMuteCheckbox !== shadow.activeElement) {
        const useMute = data.followUseMute ?? true;
        refs.followMuteCheckbox.checked = useMute;
        refs.followOnLevelInput.disabled = useMute;
        refs.followOffLevelInput.disabled = useMute;
        refs.followTransitionInput.disabled = useMute;
      }
      if (refs.followOnLevelInput !== shadow.activeElement) {
        refs.followOnLevelInput.value = data.followOnLevelDb ?? 0;
      }
      if (refs.followOffLevelInput !== shadow.activeElement) {
        refs.followOffLevelInput.value = data.followOffLevelDb ?? -20;
      }
      if (refs.followTransitionInput !== shadow.activeElement) {
        refs.followTransitionInput.value = data.followTransitionMs ?? 500;
      }
    };

    const fetchChannelData = async (id) => {
      const [
        source,
        gain,
        mute,
        eqLow,
        eqMid,
        eqHigh,
        eqLowFreq,
        eqLowWidth,
        eqMidFreq,
        eqMidWidth,
        eqHighFreq,
        eqHighWidth,
        compEnabled,
        compThreshold,
        compRatio,
        compMakeup,
        followTarget,
        followMode,
        overrideEnabled,
        followUseMute,
        followOnLevelDb,
        followOffLevelDb,
        followTransitionMs,
      ] = await Promise.all([
        getParam(`channel.${id}.source`),
        getParam(`channel.${id}.gain`),
        getParam(`channel.${id}.mute`),
        getParam(`channel.${id}.eqLow`),
        getParam(`channel.${id}.eqMid`),
        getParam(`channel.${id}.eqHigh`),
        getParam(`channel.${id}.eqLowFreq`),
        getParam(`channel.${id}.eqLowWidth`),
        getParam(`channel.${id}.eqMidFreq`),
        getParam(`channel.${id}.eqMidWidth`),
        getParam(`channel.${id}.eqHighFreq`),
        getParam(`channel.${id}.eqHighWidth`),
        getParam(`channel.${id}.compEnabled`),
        getParam(`channel.${id}.compThreshold`),
        getParam(`channel.${id}.compRatio`),
        getParam(`channel.${id}.compMakeup`),
        getParam(`channel.${id}.followTarget`),
        getParam(`channel.${id}.followMode`),
        getParam(`channel.${id}.overrideEnabled`),
        getParam(`channel.${id}.followUseMute`),
        getParam(`channel.${id}.followOnLevelDb`),
        getParam(`channel.${id}.followOffLevelDb`),
        getParam(`channel.${id}.followTransitionMs`),
      ]);
      return {
        source,
        gain,
        mute,
        eqLow,
        eqMid,
        eqHigh,
        eqLowFreq,
        eqLowWidth,
        eqMidFreq,
        eqMidWidth,
        eqHighFreq,
        eqHighWidth,
        compEnabled,
        compThreshold,
        compRatio,
        compMakeup,
        followTarget,
        followMode,
        overrideEnabled,
        followUseMute,
        followOnLevelDb,
        followOffLevelDb,
        followTransitionMs,
      };
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

    // §4.6 Teil 2: Master-Limiter-Zustand separat gepollt (kein
    // channel.<id>-Namensraum, passt nicht in fetchChannelData/poll).
    const pollMaster = async () => {
      const [enabled, threshold, ratio, makeup] = await Promise.all([
        getParam("masterLimiterEnabled"),
        getParam("masterLimiterThreshold"),
        getParam("masterLimiterRatio"),
        getParam("masterLimiterMakeup"),
      ]);
      masterLimiterEnableBtn.active = !!enabled;
      masterLimiterEnabled = !!enabled;
      if (!dragging.has(masterThresholdKnob)) masterThresholdKnob.value = threshold ?? -6;
      if (!dragging.has(masterRatioKnob)) masterRatioKnob.value = ratio ?? 10;
      if (!dragging.has(masterMakeupKnob)) masterMakeupKnob.value = makeup ?? 0;
    };
    trackDrag(masterThresholdKnob);
    trackDrag(masterRatioKnob);
    trackDrag(masterMakeupKnob);

    poll();
    pollMaster();
    this._interval = setInterval(poll, 2000);
    this._masterInterval = setInterval(pollMaster, 2000);

    // K4-Teil-1 Metering: eigene EventSource, unabhängig vom Shell-SSE-
    // Stream (`/api/v1/events`) — anderer Zweck (Pegel, nicht
    // Tally/Graph) und anderer Server (levels.rs, eigener Port, s.
    // dortige Moduldoku). Seit K4 (docs/END-GOAL-FEATURES.md Kapitel 10
    // Entscheidungssitzung Punkt 5) über den generischen Orchestrator-
    // Stream-Proxy statt direkt gegen den node-eigenen levelsUrl-Port —
    // derselbe Auth-Schutz wie jeder andere `/api/v1`-Endpunkt, kein
    // direkter Browser-Zugriff auf den Node-Host mehr nötig. `getParam`
    // dient hier nur noch als Existenz-Check (Node ohne Metering-Pfad
    // liefert kein/leeres `levelsUrl`), der tatsächliche Wert wird nicht
    // mehr als URL verwendet. `EventSource` kann wie `<img src>` keinen
    // `Authorization`-Header setzen (Web-Plattform-Einschränkung) —
    // derselbe `?access_token=`-Fallback wie bei der Shell-eigenen
    // SSE-Verbindung (ui/shell/connection.ts), sonst bricht die
    // Verbindung mit einem stillen 401 ab, sobald ein echter Nutzer
    // angemeldet ist (live per CDP gefunden).
    getParam("levelsUrl").then((url) => {
      if (!url) return;
      const token = localStorage.getItem("omp-auth-token");
      const streamUrl = token
        ? `/api/v1/nodes/${nodeId}/stream/levelsUrl?access_token=${encodeURIComponent(token)}`
        : `/api/v1/nodes/${nodeId}/stream/levelsUrl`;
      this._levelsSource = new EventSource(streamUrl);
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
    clearInterval(this._masterInterval);
    if (this._levelsSource) this._levelsSource.close();
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
