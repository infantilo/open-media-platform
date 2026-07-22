// Node-UI-Bundle des Bildmischers (UMSETZUNG.md C10/K3-Teil-1,
// ARCHITECTURE.md §4.5, docs/END-GOAL-FEATURES.md §3.3/§3.4 Teil 1):
// Hardware-Pult-Optik statt generischer Button-Liste — PGM/PST-
// Doppelreihe, CUT/AUTO, Keyer/DVE als beleuchtete Tasten, alles auf
// ui/design-tokens.css + ui/kit (<omp-button>, geladen von der Shell,
// s. ui/kit/index.ts). Gleiche generische Node-Proxy-API wie zuvor
// (/api/v1/nodes/<id>/params/<name>, /methods/<name>) — reines
// UI-Bundle, KEINE Node-/Pipeline-Änderung in diesem Teil.
//
// Reaktionszeit: eigene `EventSource("/api/v1/events")` statt Wieder-
// verwendung des Shell-internen ConnectionMonitor (der ist in
// ui/shell/connection.ts gekapselt und für dynamisch nachgeladene
// Node-Bundles wie dieses hier nicht adressierbar — jedes Bundle bleibt
// bewusst eigenständig, §4.5 "kein Framework-Zwang"). Tally-Events
// (`omp.tally.<nodeId>`, SSE-Payload-Schema `{type, data}` wie in
// flow-canvas.ts#handleServerEvent) lösen ein sofortiges Refresh aus;
// 2-s-Poll bleibt als Fallback (Verbindungsabbruch, verpasste Events).
//
// T-Bar (Teil 2: `crosspoint.transitionPosition`/`setTransitionPosition`
// existieren noch nicht): rein kosmetisch, animiert nur während eines
// Auto-Trans-Klicks über eine feste Heuristik-Dauer, kein echtes
// Server-Feedback. Rate-Wahl/Wipe sind ausgegraut mit Tooltip (Teil 2 /
// außerhalb des aktuellen Scopes) statt weggelassen — "gehört zur
// 'echtes Pult'-Anmutung" (§3.3).
//
// PGM-Reihe: Hot-Cut (K3-Teil-2, §3.5 offene Frage 1 entschieden
// 2026-07-16 — Projektinhaber-Feedback). Ruft `crosspoint.take`
// (Node-seitig neu), NICHT `crosspoint.select` — schaltet das Programm
// direkt um, ohne die gestagte Preset-Auswahl anzurühren (die PST-Reihe
// bleibt unverändert, s. `pipeline.rs::Command::Take`-Doku).
const WIDTH = 640;
const HEIGHT = 480;
const PIP_BOX = { width: Math.round(WIDTH / 3), height: Math.round(HEIGHT / 3) };
PIP_BOX.x = WIDTH - PIP_BOX.width - 16;
PIP_BOX.y = HEIGHT - PIP_BOX.height - 16;

const AUTO_TRANS_VISUAL_MS = 1000;

class OmpVideoMixerMePanel extends HTMLElement {
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
        display: grid;
        grid-template-columns: 1fr 108px;
        gap: var(--omp-space-2, 8px);
      }
      .buses { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .bus-row { display: flex; align-items: center; gap: 6px; }
      .bus-label {
        width: 28px; flex-shrink: 0; font-size: var(--omp-font-size-xs, 11px);
        color: var(--omp-text-dim, #9aa0a6); text-transform: uppercase; font-weight: 700;
      }
      .bus-buttons { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
      .bus-buttons omp-button { width: 58px; height: 36px; font-size: 10px; }
      .bus-buttons .group-label {
        flex-basis: 100%; font-size: 9px; text-transform: uppercase;
        color: var(--omp-text-dim, #9aa0a6); margin: 2px 0 -2px;
      }
      .bus-buttons .group-label:first-child { margin-top: 0; }
      .fx-row { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
      .fx-row omp-button { flex: 1; height: 34px; }
      .keyer-row { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
      .keyer-row select {
        flex: 1; height: 26px; font-size: 10px; border-radius: 4px;
        background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed);
        border: 1px solid var(--omp-border, #2e3338);
      }
      .rate-row { display: flex; gap: 4px; margin-top: 6px; }
      .rate-row omp-button { width: 34px; height: 26px; font-size: 10px; }
      .transition {
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        border-left: 1px solid var(--omp-border, #2e3338); padding-left: var(--omp-space-2, 8px);
      }
      .transition omp-button.cut { width: 100%; }
      .transition omp-button.auto { width: 100%; }
      .mix-wipe { display: flex; gap: 4px; width: 100%; }
      .mix-wipe omp-button { flex: 1; height: 26px; font-size: 10px; }
      p.empty { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); margin: 4px 0 0; }
      [disabled] { opacity: 0.4; }
    `;

    const console_ = document.createElement("div");
    console_.className = "console";

    const buses = document.createElement("div");
    buses.className = "buses";
    const pgmRow = document.createElement("div");
    pgmRow.className = "bus-row";
    const pgmLabel = document.createElement("span");
    pgmLabel.className = "bus-label";
    pgmLabel.textContent = "PGM";
    const pgmButtons = document.createElement("div");
    pgmButtons.className = "bus-buttons";
    pgmRow.append(pgmLabel, pgmButtons);

    const pstRow = document.createElement("div");
    pstRow.className = "bus-row";
    const pstLabel = document.createElement("span");
    pstLabel.className = "bus-label";
    pstLabel.textContent = "PST";
    const pstButtons = document.createElement("div");
    pstButtons.className = "bus-buttons";
    pstRow.append(pstLabel, pstButtons);

    // Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22, Feinschliff zur
    // Skalierungs-Review): PGM/PST legen nicht mehr automatisch jede
    // entdeckte Quelle als Taste auf — stattdessen wählt der Operator per
    // "+"-Button (gleiches Grundprinzip wie omp-audio-mixers "+ Kanal")
    // dauerhafte, entfernbare Quellen aus. Backend-Zustand ist rein
    // buchhalterisch (main.rs::pinned, s. dortige Moduldoku) — welche
    // `senderId`s der Operator sich angelegt hat, unabhängig davon, ob sie
    // gerade auf PGM/PST liegen.
    const srcRow = document.createElement("div");
    srcRow.className = "bus-row";
    const srcLabel = document.createElement("span");
    srcLabel.className = "bus-label";
    srcLabel.textContent = "SRC";
    const srcButtons = document.createElement("div");
    srcButtons.className = "bus-buttons";
    srcRow.append(srcLabel, srcButtons);

    const fxRow = document.createElement("div");
    fxRow.className = "fx-row";
    const keyerRow = document.createElement("div");
    keyerRow.className = "keyer-row";
    const keyerSourceLabel = document.createElement("span");
    keyerSourceLabel.className = "bus-label";
    keyerSourceLabel.textContent = "KEY";
    const keyerSourceSelect = document.createElement("select");
    keyerRow.append(keyerSourceLabel, keyerSourceSelect);

    // PIP-Quellauswahl (Nutzerwunsch 2026-07-22): PIP ist jetzt ein
    // eigenständiger Compositor-Layer mit frei wählbarer Quelle, genau wie
    // der DSK/KEY-Eingang oben — gleiches Dropdown-Muster, aber gespeist
    // aus dem vollen `crosspoint.inputs`-Katalog (nicht der kuratierten
    // SRC-Liste), da Kap. „wie bei DSK" ausdrücklich die ungefilterte,
    // workflow-gruppierte Liste meint.
    const pipRow = document.createElement("div");
    pipRow.className = "keyer-row";
    const pipSourceLabel = document.createElement("span");
    pipSourceLabel.className = "bus-label";
    pipSourceLabel.textContent = "PIP";
    const pipSourceSelect = document.createElement("select");
    pipRow.append(pipSourceLabel, pipSourceSelect);

    const rateRow = document.createElement("div");
    rateRow.className = "rate-row";

    buses.append(pgmRow, pstRow, srcRow, fxRow, keyerRow, pipRow, rateRow);

    const transition = document.createElement("div");
    transition.className = "transition";
    const cutBtn = document.createElement("omp-button");
    cutBtn.className = "cut";
    cutBtn.setAttribute("variant", "take");
    cutBtn.textContent = "Cut";
    const autoBtn = document.createElement("omp-button");
    autoBtn.className = "auto";
    autoBtn.setAttribute("variant", "take");
    autoBtn.textContent = "Auto";
    const tBar = document.createElement("omp-fader");
    tBar.setAttribute("min", "0");
    tBar.setAttribute("max", "1");
    tBar.setAttribute("value", "0");
    tBar.setAttribute("disabled", "");
    tBar.style.pointerEvents = "none";
    const mixWipe = document.createElement("div");
    mixWipe.className = "mix-wipe";
    const mixBtn = document.createElement("omp-button");
    mixBtn.textContent = "MIX";
    mixBtn.active = true;
    mixBtn.setAttribute("color", "cue");
    const wipeBtn = document.createElement("omp-button");
    wipeBtn.textContent = "WIPE";
    wipeBtn.setAttribute("disabled", "");
    wipeBtn.title = "Wipe-Muster: außerhalb des aktuellen Scopes (ARCHITECTURE.md §13.1)";
    mixWipe.append(mixBtn, wipeBtn);
    transition.append(cutBtn, autoBtn, tBar, mixWipe);

    console_.append(buses, transition);

    // K3/K4-Feinschliff (§12.3-Referenzvergleich, "Bildmeister"-Layout):
    // eine gruppierte Sektion mit Kopfzeile um das ganze Pult — zwei
    // verschachtelte Sektionen (Bus/Transition einzeln) sprengten im
    // 280px-Parameter-Panel die verfügbare Breite (per Live-Test
    // gefunden: Transition-Spalte fiel aus dem sichtbaren Bereich,
    // Seite bekam einen ungewollten horizontalen Scrollbalken). Die
    // bestehende `border-left` zwischen Bus und Transition bleibt als
    // leichte interne Trennung.
    const section = document.createElement("omp-panel-section");
    section.setAttribute("label", "Video Mixer M/E");
    section.append(console_);

    // §4.6 Punkt 4 (docs/END-GOAL-FEATURES.md, "Mixer-Presets",
    // docs/decisions.md Nachtrag 40): UI-Anschluss des Backend-seitig
    // bereits vorhandenen `GET`/`POST /state` (main.rs::capture_state/
    // restore_state) — identisches Muster wie omp-audio-mixer/ui/
    // bundle.js (derselbe generische Snapshot-Mechanismus, per
    // `nodeIds:[nodeId]` auf genau diesen Node eingeschränkt).
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
          // `refresh` unten deklariert, zum Zeitpunkt eines
          // tatsächlichen Klicks längst verfügbar (gleiches Muster wie
          // cutBtn/autoBtn oben, die refresh() ebenfalls vor dessen
          // textueller Deklaration referenzieren).
          await refresh();
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
      }).then(refresh);

    cutBtn.addEventListener("click", () => call("crosspoint.cut"));
    autoBtn.addEventListener("click", () => {
      call("crosspoint.autoTrans");
      animateTBar();
    });

    let tBarAnimation = null;
    const animateTBar = () => {
      if (tBarAnimation) cancelAnimationFrame(tBarAnimation);
      const start = performance.now();
      const tick = (now) => {
        const pct = Math.min(1, (now - start) / AUTO_TRANS_VISUAL_MS);
        tBar.value = pct;
        if (pct < 1) {
          tBarAnimation = requestAnimationFrame(tick);
        } else {
          tBarAnimation = null;
          setTimeout(() => (tBar.value = 0), 200);
        }
      };
      tBarAnimation = requestAnimationFrame(tick);
    };

    const RATES = [6, 12, 25, 50];
    for (const frames of RATES) {
      const btn = document.createElement("omp-button");
      btn.textContent = `${frames}f`;
      btn.setAttribute("disabled", "");
      btn.title = "Rate-Wahl (crosspoint.transRate): K3-Teil-2";
      rateRow.append(btn);
    }

    const keyerBtn = document.createElement("omp-button");
    keyerBtn.textContent = "DSK";
    keyerBtn.setAttribute("color", "onair");
    let keyerEnabled = false;
    keyerBtn.addEventListener("click", () => call("keyer.setEnabled", { enabled: !keyerEnabled }));

    // Fill+Key-Quelle für den Keyer (z. B. `omp-ograf`, s. `pipeline.rs::
    // DiscoveredKeyFill`-Doku) — leerer Wert = synthetische Test-
    // Farbfläche (Default, kein echtes Downstream-Key).
    keyerSourceSelect.addEventListener("change", () => call("keyer.setSource", { senderId: keyerSourceSelect.value }));

    // PIP ist jetzt ein eigenständiger Compositor-Layer (main.rs::
    // pip.setEnabled/pip.setSource, pipeline.rs `comp_pip_pad`/§Nachtrag
    // "PIP als eigenständiger Layer") statt einer PGM-Verkleinerung übers
    // DVE-Feld — `dve.setBox`/`dve.reset` positionieren nur noch diesen
    // Layer innerhalb des Frames (feste Ecke, s. PIP_BOX oben), die
    // Sichtbarkeit selbst hängt an `pipEnabled`.
    const pipBtn = document.createElement("omp-button");
    pipBtn.textContent = "PIP";
    pipBtn.setAttribute("color", "preset");
    let pipEnabled = false;
    pipBtn.addEventListener("click", async () => {
      if (pipEnabled) {
        await call("pip.setEnabled", { enabled: false });
      } else {
        await call("dve.setBox", PIP_BOX);
        await call("pip.setEnabled", { enabled: true });
      }
    });

    fxRow.append(keyerBtn, pipBtn);

    // Gemeinsame Aufbau-Logik für workflow-gruppierte Dropdowns (KEY, PIP)
    // — identisches Gruppierungsprinzip wie `renderBusRow` für PGM/PST,
    // hier als Options-Builder statt Button-Liste.
    const buildGroupedOptions = (selectEl, entries, ownSenderIds, placeholderLabel) => {
      selectEl.innerHTML = "";
      const placeholderOpt = document.createElement("option");
      placeholderOpt.value = "";
      placeholderOpt.textContent = placeholderLabel;
      selectEl.append(placeholderOpt);

      const appendOption = (parent, e) => {
        const opt = document.createElement("option");
        opt.value = e.senderId;
        opt.textContent = e.label;
        parent.append(opt);
      };
      const own = entries.filter((e) => ownSenderIds.has(e.senderId));
      const others = entries.filter((e) => !ownSenderIds.has(e.senderId));
      if (own.length > 0 && others.length > 0) {
        const ownGroup = document.createElement("optgroup");
        ownGroup.label = "Dieser Workflow";
        for (const e of own) appendOption(ownGroup, e);
        selectEl.append(ownGroup);

        const otherGroup = document.createElement("optgroup");
        otherGroup.label = "Andere Quellen";
        for (const e of others) appendOption(otherGroup, e);
        selectEl.append(otherGroup);
      } else {
        for (const e of entries) appendOption(selectEl, e);
      }
    };

    pipSourceSelect.addEventListener("change", () => call("pip.setSource", { senderId: pipSourceSelect.value }));

    // Kuratierte Kreuzschiene: "+"-Button öffnet an Ort und Stelle ein
    // workflow-gruppiertes Auswahl-Dropdown (gleiches Prinzip wie KEY/PIP),
    // das nach Auswahl sofort `crosspoint.pin` aufruft und wieder zur
    // "+"-Taste zurückkehrt. `addPickerOpen` verhindert, dass der laufende
    // 2s-Poll das offene Dropdown währenddessen wegrendert (gleicher Schutz
    // wie beim fokussierten KEY-/PIP-Select).
    const addSourceBtn = document.createElement("omp-button");
    addSourceBtn.textContent = "+";
    addSourceBtn.title = "Quelle zur Kreuzschiene hinzufügen";
    addSourceBtn.style.cssText = "width:28px !important; height:26px !important; font-size:14px; padding:0;";
    let addPickerOpen = false;
    let latestInputs = [];
    let latestPinned = [];
    let latestOwnSenderIds = new Set();

    const closeAddPicker = () => {
      addPickerOpen = false;
      refresh();
    };

    addSourceBtn.addEventListener("click", () => {
      addPickerOpen = true;
      const available = latestInputs
        .filter((i) => !latestPinned.includes(i.senderId))
        .map((i) => ({ label: i.label, senderId: i.senderId }));
      const picker = document.createElement("select");
      picker.style.cssText = "height:26px; font-size:10px; border-radius:4px; background:var(--omp-bg-2, #1c1f22); color:var(--omp-text, #e8eaed); border:1px solid var(--omp-border, #2e3338);";
      buildGroupedOptions(picker, available, latestOwnSenderIds, "Quelle wählen…");
      picker.addEventListener("change", async () => {
        if (picker.value) await call("crosspoint.pin", { senderId: picker.value });
        closeAddPicker();
      });
      picker.addEventListener("blur", closeAddPicker);
      srcButtons.replaceChild(picker, addSourceBtn);
      picker.focus();
    });

    const makeBusButton = (label, senderId, isProgram) => {
      const btn = document.createElement("omp-button");
      btn.textContent = label;
      const method = isProgram ? "crosspoint.take" : "crosspoint.select";
      btn.addEventListener("click", () => call(method, { senderId }));
      return btn;
    };

    // Skalierungs-Review D5/Nutzerwunsch (docs/REVIEW-2026-07-17-
    // SKALIERUNG-24-7.md, präzisiert 2026-07-22): PGM/PST-Quellen nach
    // Workflow-Zugehörigkeit gruppieren, gleiches Muster wie
    // omp-switcher/ui/bundle.js (dort ausführlicher kommentiert) und wie
    // omp-audio-mixer/ui/bundle.js#loadFollowTargets (AFV-Ziel-Dropdown).
    const senderWorkflowLabel = async () => {
      const [graphRes, workflowsRes] = await Promise.all([
        fetch("/api/v1/graph"),
        fetch("/api/v1/workflows"),
      ]);
      const senderNodeId = new Map();
      if (graphRes.ok) {
        const graph = await graphRes.json();
        for (const n of graph.nodes || []) {
          for (const out of n.outputs || []) senderNodeId.set(out.id, n.id);
        }
      }
      const nodeWorkflow = new Map();
      let ownWorkflowId = null;
      if (workflowsRes.ok) {
        const workflows = await workflowsRes.json();
        for (const wf of workflows) {
          for (const role of Object.values(wf.runtime || {})) {
            if (!role.nodeId) continue;
            nodeWorkflow.set(role.nodeId, wf.id);
            if (role.nodeId === nodeId) ownWorkflowId = wf.id;
          }
        }
      }
      const own = new Set();
      for (const [senderId, nId] of senderNodeId) {
        if (nodeWorkflow.get(nId) === ownWorkflowId && ownWorkflowId) own.add(senderId);
      }
      return own;
    };

    // Baut eine Bus-Reihe (PGM oder PST) gruppiert nach `ownSenderIds`
    // auf — nur, wenn tatsächlich beide Gruppen (eigener Workflow + Rest)
    // nicht leer sind, sonst bleibt es bei der bisherigen flachen Liste
    // (BLK zählt nie zu "eigener Workflow", bleibt also immer ungruppiert
    // vorangestellt).
    const renderBusRow = (container, entries, ownSenderIds, isProgram, activeId, color) => {
      const [blk, ...rest] = entries;
      const appendEntry = (entry) => {
        const btn = makeBusButton(entry.label, entry.senderId, isProgram);
        btn.active = entry.senderId === activeId;
        btn.setAttribute("color", color);
        container.append(btn);
      };
      appendEntry(blk);

      const own = rest.filter((e) => ownSenderIds.has(e.senderId));
      const others = rest.filter((e) => !ownSenderIds.has(e.senderId));
      if (own.length > 0 && others.length > 0) {
        const ownLabel = document.createElement("div");
        ownLabel.className = "group-label";
        ownLabel.textContent = "Dieser Workflow";
        container.append(ownLabel);
        for (const entry of own) appendEntry(entry);

        const otherLabel = document.createElement("div");
        otherLabel.className = "group-label";
        otherLabel.textContent = "Andere Quellen";
        container.append(otherLabel);
        for (const entry of others) appendEntry(entry);
      } else {
        for (const entry of rest) appendEntry(entry);
      }
    };

    const refresh = async () => {
      const [
        inputsRes, programRes, presetRes, keyerRes, keyerInputsRes, keyerSourceRes,
        pipEnabledRes, pipSourceRes, pinnedRes, ownSenderIds,
      ] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.programInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.presetInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/keyer.enabled`),
        fetch(`/api/v1/nodes/${nodeId}/params/keyer.inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/keyer.source`),
        fetch(`/api/v1/nodes/${nodeId}/params/pip.enabled`),
        fetch(`/api/v1/nodes/${nodeId}/params/pip.source`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.pinnedSenderIds`),
        senderWorkflowLabel(),
      ]);
      if (!inputsRes.ok || !programRes.ok || !presetRes.ok) return;
      const inputs = (await inputsRes.json()).value || [];
      const program = (await programRes.json()).value || "";
      const preset = (await presetRes.json()).value || "";
      keyerEnabled = keyerRes.ok ? (await keyerRes.json()).value === true : false;
      const keyerInputs = keyerInputsRes.ok ? (await keyerInputsRes.json()).value || [] : [];
      const keyerSource = keyerSourceRes.ok ? (await keyerSourceRes.json()).value || "" : "";
      pipEnabled = pipEnabledRes.ok ? (await pipEnabledRes.json()).value === true : false;
      const pipSource = pipSourceRes.ok ? (await pipSourceRes.json()).value || "" : "";
      const pinned = pinnedRes.ok ? (await pinnedRes.json()).value || [] : [];
      latestInputs = inputs;
      latestPinned = pinned;
      latestOwnSenderIds = ownSenderIds;

      // Dropdown nur neu bauen, wenn sich die Optionen tatsächlich
      // geändert haben (sonst würde ein offenes Dropdown bei jedem
      // 2s-Poll unter dem Cursor zuklappen) — Vergleich per JSON-String
      // reicht hier, die Liste ist klein und ändert sich selten.
      const keyerOptionsKey = JSON.stringify([...keyerInputs.map((k) => k.senderId), ...ownSenderIds]);
      if (keyerSourceSelect.dataset.optionsKey !== keyerOptionsKey) {
        keyerSourceSelect.dataset.optionsKey = keyerOptionsKey;
        buildGroupedOptions(keyerSourceSelect, keyerInputs, ownSenderIds, "Testfarbe");
      }
      // Nutzerfund: dieser Wert wurde bisher bei jedem 2s-Poll
      // bedingungslos überschrieben — eine gerade getroffene Auswahl
      // wurde sichtbar wieder zurückgesetzt, sobald der Select den Fokus
      // verliert (z. B. weil `change` zwar sofort serverseitig anwendet,
      // aber ein zeitgleich schon laufender Poll noch den alten Wert
      // zurückliefert). Gleicher Schutz wie bei den übrigen Feldern:
      // während der Select fokussiert ist, nicht überschreiben.
      if (keyerSourceSelect !== shadow.activeElement) keyerSourceSelect.value = keyerSource;

      // PIP-Quelle: gleiches Muster wie KEY, aber gespeist aus dem vollen
      // Quellkatalog (`inputs`), nicht `keyerInputs` — "wie bei DSK"
      // bezieht sich auf die Gruppierung, nicht auf die Fill+Key-Liste.
      const pipInputEntries = inputs.map((i) => ({ label: i.label, senderId: i.senderId }));
      const pipOptionsKey = JSON.stringify([...pipInputEntries.map((e) => e.senderId), ...ownSenderIds]);
      if (pipSourceSelect.dataset.optionsKey !== pipOptionsKey) {
        pipSourceSelect.dataset.optionsKey = pipOptionsKey;
        buildGroupedOptions(pipSourceSelect, pipInputEntries, ownSenderIds, "Schwarz");
      }
      if (pipSourceSelect !== shadow.activeElement) pipSourceSelect.value = pipSource;

      // Kuratierte Kreuzschiene: SRC-Reihe zeigt die angepinnten Quellen
      // (+ Entfernen-Taste) plus die "+"-Taste — außer der Add-Picker ist
      // gerade offen (sonst würde der laufende Poll ihn wegrendern, bevor
      // der Operator eine Auswahl treffen konnte).
      if (!addPickerOpen) {
        srcButtons.innerHTML = "";
        if (pinned.length === 0) {
          const hint = document.createElement("span");
          hint.textContent = "keine Quellen angeheftet";
          hint.style.cssText = "color:var(--omp-text-dim, #9aa0a6);font-size:10px;align-self:center;";
          srcButtons.append(hint);
        }
        for (const senderId of pinned) {
          const input = inputs.find((i) => i.senderId === senderId);
          const label = input ? input.label : senderId.slice(0, 8);
          const wrap = document.createElement("span");
          wrap.style.cssText = "display:inline-flex; align-items:center; gap:2px;";
          const tag = document.createElement("span");
          tag.textContent = label;
          tag.title = senderId;
          tag.style.cssText = "font-size:10px; padding:2px 4px; border:1px solid var(--omp-border, #2e3338); border-radius:4px;";
          const removeBtn = document.createElement("omp-button");
          removeBtn.textContent = "×";
          removeBtn.title = "Quelle entfernen";
          removeBtn.style.cssText = "width:18px !important; height:18px !important; font-size:10px; padding:0;";
          removeBtn.addEventListener("click", () => call("crosspoint.unpin", { senderId }));
          wrap.append(tag, removeBtn);
          srcButtons.append(wrap);
        }
        srcButtons.append(addSourceBtn);
      }

      pgmButtons.innerHTML = "";
      pstButtons.innerHTML = "";

      // Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): PGM/PST zeigen
      // nur noch BLK + angepinnte Quellen — plus, als Sicherheitsnetz, das
      // jeweils aktuell aufgeschaltete Programm/Preset auch dann, wenn es
      // (z. B. nach einem Unpin) nicht mehr in der Pin-Liste steht, damit
      // der Operator nie "blind" auf eine unbenannte Taste schaut.
      const alwaysVisible = new Set(pinned);
      if (program) alwaysVisible.add(program);
      if (preset) alwaysVisible.add(preset);
      const visibleInputs = inputs.filter((i) => alwaysVisible.has(i.senderId));
      const entries = [{ label: "BLK", senderId: "" }, ...visibleInputs.map((i) => ({ label: i.label, senderId: i.senderId }))];
      if (visibleInputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Quellen angeheftet — über SRC „+“ hinzufügen";
        pstButtons.append(empty);
      }
      renderBusRow(pgmButtons, entries, ownSenderIds, true, program, "onair");
      renderBusRow(pstButtons, entries, ownSenderIds, false, preset, "preset");

      keyerBtn.active = keyerEnabled;
      pipBtn.active = pipEnabled;
    };

    refresh();
    this._interval = setInterval(refresh, 2000);

    // Live-Test-Fund (K3/K4-Feinschliff-Sitzung, gleicher Bug wie
    // ui/shell/connection.ts, s. UMSETZUNG.md K3/K4-1): Browser-
    // EventSource kann keine Header setzen, ohne ?access_token= liefert
    // der Server unter echter Auth 401 und dieses Bundle bekommt nie
    // ein Tally-Refresh (fällt nur auf den 2s-Poll zurück, kein Absturz,
    // aber unnötig träge). Gleicher ?access_token=-Fallback wie dort.
    const ssePath = (() => {
      const token = localStorage.getItem("omp-auth-token");
      return token ? `/api/v1/events?access_token=${encodeURIComponent(token)}` : "/api/v1/events";
    })();
    this._es = new EventSource(ssePath);
    this._es.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (parsed.type === `omp.tally.${nodeId}`) refresh();
    };

    this._refresh = refresh;
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    if (this._es) this._es.close();
  }
}

if (!customElements.get("omp-video-mixer-me-panel")) {
  customElements.define("omp-video-mixer-me-panel", OmpVideoMixerMePanel);
}
