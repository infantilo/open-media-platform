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
// Auto-Trans-Klicks, kein echtes Server-Feedback — die Dauer folgt aber
// seit Bug 4 der echten `crosspoint.transRate` (nicht mehr einer festen
// Heuristik), s. `animateTBar`/`RATES` unten. Wipe bleibt ausgegraut mit
// Tooltip (außerhalb des aktuellen Scopes) statt weggelassen — "gehört
// zur 'echtes Pult'-Anmutung" (§3.3); Rate-Wahl ist seit Bug 4
// (`main.rs::crosspoint.setTransRate`, `pipeline.rs::frames_to_ms`) real.
//
// PGM-Reihe: Hot-Cut (K3-Teil-2, §3.5 offene Frage 1 entschieden
// 2026-07-16 — Projektinhaber-Feedback). Ruft `crosspoint.take`
// (Node-seitig neu), NICHT `crosspoint.select` — schaltet das Programm
// direkt um, ohne die gestagte Preset-Auswahl anzurühren (die PST-Reihe
// bleibt unverändert, s. `pipeline.rs::Command::Take`-Doku).
//
// Mehrere M/E-Ebenen (Nutzerwunsch 2026-08-14, Nachtrag: "die multiplen
// Mischerebenen sollten im UI übereinander wie bei einem Hardware-
// Bildmischer sein"): Ebenenzahl wird aus dem generischen
// `GET .../descriptor` abgeleitet (höchster gefundene `levelN.`-Präfix
// unter allen Param-/Methodennamen, main.rs::level_name präfigiert bei
// `level_count>1` AUSNAHMSLOS jeden Namen). Statt eines Tab-Umschalters
// baut `buildBank(level)` unten JE Ebene eine vollständige, unabhängige
// Konsole (PGM/PST/SRC/Keyer/PIP/Transition) — alle Ebenen sind
// gleichzeitig sichtbar, direkt übereinander gestapelt (eigene
// `omp-panel-section` je Bank), wie mehrere physische M/E-Bänke.
//
// Mastereben-Routing (Nachtrag 2026-08-14): die Mastereben (Ebene 1,
// `level===0`) zeigt in PGM/PST zusätzlich feste, immer sichtbare
// Tasten für die Ausgänge ALLER anderen Ebenen (analog zu einem
// Hardware-Bildmischer, bei dem eine Sub-M/E-Bank fest als Quelle der
// Master-Bank verdrahtet ist) — kein manuelles Anpinnen nötig, anders
// als bei externen Quellen. Backend-seitig liefert `crosspoint.inputs`
// seit main.rs's Nachtrag 2026-08-14 den eigenen PGM-Ausgang JEDER
// anderen Ebene mit (nur die Selbstreferenz einer Ebene auf sich selbst
// bleibt gesperrt) — dieses Bundle muss die "eigene Ausgänge"-Menge
// daher selbst ermitteln (`graphContext()` unten, aus `/api/v1/graph`,
// Zuordnung Sender→Ebene über das Label "PGM {n}" — NICHT über die
// Array-Reihenfolge in `n.outputs`, die live nachweislich NICHT der
// Registrierungsreihenfolge folgt (`graphContext()`-Doku unten) — und
// nur in der Mastereben als feste Tasten
// rendern (`renderBusRow`s `levelOutputSenderIds`-Parameter).
//
// Ebenenzahl live ändern (Nutzerwunsch 2026-08-24: "im laufenden Betrieb
// im property panel, mit restart aber reconnect aller zuvor aufgelegten
// quellen"): OMP_ME_LEVELS ist bei main.rs::main() fest für die
// gesamte Prozess-Laufzeit — ein Ebenenwechsel braucht daher denselben
// Restart-Mechanismus, den `flow-canvas.ts#buildRoleFormatSection` seit
// 2026-07-29 für role.Format nutzt (POST .../roles/{role}/restart, s.
// orchestrator/internal/workflows/service.go RestartRole-Doku): alte
// Instanz stoppen, neue mit dem neuen OMP_ME_LEVELS starten, auf
// Registrierung warten, alle Connections dieser Rolle neu anwenden (also
// exakt "restart aber reconnect aller zuvor aufgelegten Quellen"). Da
// dieser Node ein eigenes UI-Bundle hat, landet er NIE in
// flow-canvas.ts' generischem Panel (`mountUIBundle` gewinnt, s. dortige
// Doku) — die Ebenen-Sektion unten ist deshalb die einzige Stelle, an
// der das für omp-video-mixer-me überhaupt zugänglich ist, und lebt
// bewusst hier statt dort. `mixerLevels` ist server-seitig `*int` (nil
// = unverändert lassen, s. handleRestartWorkflowRole-Doku) — `format`
// dagegen bleibt ein normaler String, der bei JEDEM Restart-Aufruf
// (unabhängig von der Quelle) übernommen wird, ein fehlendes Feld zählt
// dort weiterhin als "auf Node-Standard zurücksetzen" (unverändertes
// Verhalten der Format-Sektion in flow-canvas.ts). Diese Ebenen-Sektion
// muss das aktuelle `format` deshalb selbst mitschicken (aus
// `findRunningRole()` unten), sonst würde ein reiner Ebenenwechsel ein
// separat gesetztes role.Format stillschweigend zurücksetzen.
const WIDTH = 640;
const HEIGHT = 480;
const PIP_BOX = { width: Math.round(WIDTH / 3), height: Math.round(HEIGHT / 3) };
PIP_BOX.x = WIDTH - PIP_BOX.width - 16;
PIP_BOX.y = HEIGHT - PIP_BOX.height - 16;

// 1000ms Default (25 Frames @25fps) — überschrieben, sobald `refresh()`
// die echte `crosspoint.transRate` gelesen hat (s. `currentTransRateMs`
// je Bank). Bleibt als Fallback, falls der erste Poll noch nicht
// zurückkam, wenn `autoBtn` schon geklickt wird.
const DEFAULT_AUTO_TRANS_VISUAL_MS = 1000;
// Muss zu `pipeline.rs::FRAMERATE_NUMERATOR`/`frames_to_ms` passen (25fps
// ⇒ 40ms/Frame) — eigenständiges UI-Bundle ohne Zugriff auf die Rust-
// Konstante (s. Moduldoku oben "kein Framework-Zwang"), daher hier
// dupliziert statt importiert.
const MS_PER_TRANS_FRAME = 40;

class OmpVideoMixerMePanel extends HTMLElement {
  async connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    // Ebenenzahl VOR dem Aufbau der Bedienoberfläche ermitteln (s.
    // Moduldoku oben) — ein `async connectedCallback` ist zulässig
    // (der Rückgabewert wird vom Custom-Elements-Lifecycle ignoriert);
    // `disconnectedCallback` bleibt sicher, falls das Element vor
    // Abschluss dieses Fetches wieder entfernt wird (`clearInterval`/
    // das `if (this._es)` unten greifen auch bei noch undefinierten
    // Feldern).
    let levelCount = 1;
    try {
      const descRes = await fetch(`/api/v1/nodes/${nodeId}/descriptor`);
      if (descRes.ok) {
        const desc = await descRes.json();
        const levelPrefix = /^level(\d+)\./;
        for (const spec of [...(desc.parameters || []), ...(desc.methods || [])]) {
          const m = levelPrefix.exec(spec.name);
          if (m) levelCount = Math.max(levelCount, parseInt(m[1], 10));
        }
      }
    } catch {
      // levelCount bleibt 1 — gleicher Fallback wie ein fehlgeschlagener
      // Parameter-Poll andernorts in diesem Bundle (kein Absturz, nur
      // reduzierte Funktionalität).
    }

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
        grid-template-columns: 1fr 116px;
        gap: var(--omp-space-3, 12px);
      }
      .buses { display: flex; flex-direction: column; gap: var(--omp-space-3, 12px); min-width: 0; }
      .bus-row { display: flex; align-items: flex-start; gap: 8px; }
      .bus-label {
        width: 30px; flex-shrink: 0; padding-top: 8px; font-size: var(--omp-font-size-xs, 11px);
        color: var(--omp-text-dim, #9aa0a6); text-transform: uppercase; font-weight: 700;
        letter-spacing: 0.04em;
      }
      .bus-buttons { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 5px; min-width: 0; }
      .bus-buttons omp-button {
        width: 68px; height: 34px; font-size: 10px; line-height: 1.15;
      }
      .bus-buttons .group-label {
        flex-basis: 100%; font-size: 9px; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--omp-text-dim, #9aa0a6);
        margin: 6px 0 -1px; padding-left: 2px;
        border-left: 2px solid var(--omp-border, #2e3338);
      }
      .bus-buttons .group-label:first-child { margin-top: 0; }
      .bus-buttons p.empty { flex-basis: 100%; margin: 2px 0 3px; }

      /* Klare Untergruppierung innerhalb einer Bank (Nutzerauftrag
         2026-09-03: "muss viel professioneller werden") — vorher
         verschwammen Kreuzschiene (PGM/PST/SRC) und Compositing-Reihen
         (DSK/PIP/KEY/PIP/Rate) optisch ineinander, nur durch
         margin-top:4px getrennt. Eine dünne Trennlinie + Label macht aus
         zwei fachlich unterschiedlichen Bereichen auch zwei sichtbare. */
      .fx-group {
        margin-top: var(--omp-space-1, 4px);
        padding-top: var(--omp-space-2, 8px);
        border-top: 1px solid var(--omp-border, #2e3338);
        display: flex; flex-direction: column; gap: var(--omp-space-2, 8px);
      }
      .fx-row { display: flex; gap: 6px; align-items: center; }
      .fx-row omp-button { flex: 1; height: 34px; }
      .keyer-row { display: flex; gap: 8px; align-items: center; }

      /* Ausgewachsene Metall-Optik für <select> statt des nackten
         Browser-Standard-Dropdowns (bislang der mit Abstand größte Bruch
         mit der Hardware-Pult-Anmutung der restigen Tasten). */
      .keyer-row select, .add-picker {
        min-width: 0; height: 34px; font-size: 10.5px;
        font-family: var(--omp-font, system-ui, sans-serif);
        color: var(--omp-text, #e8eaed);
        border: 1px solid var(--omp-metal-dark, #1a1c1f);
        border-radius: var(--omp-radius, 6px);
        padding: 0 24px 0 8px;
        appearance: none; -webkit-appearance: none; cursor: pointer;
        box-shadow: 0 1px 0 rgba(255, 255, 255, 0.1) inset, 0 1px 2px rgba(0, 0, 0, 0.4);
        /* Zwei Ebenen in EINER background-image-Deklaration (Pfeil-SVG
           oben, Metall-Gradient darunter) — eine ZWEITE, separate
           background-image-Zeile hätte die erste einfach überschrieben
           (live gefundener Bug beim ersten Anlauf dieses Redesigns: die
           Gradient-Fläche verschwand spurlos, nur appearance:none und
           der Rahmen blieben sichtbar). */
        background-image:
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='6'%3E%3Cpath d='M0 0l4.5 6L9 0z' fill='%239aa0a6'/%3E%3C/svg%3E"),
          linear-gradient(to bottom, var(--omp-metal-light, #3d434b) 0%, var(--omp-metal-mid, #2b2f34) 100%);
        background-repeat: no-repeat, no-repeat;
        background-position: right 8px center, center;
      }
      .keyer-row select { flex: 1; }
      .keyer-row select:hover, .add-picker:hover { border-color: var(--omp-text-dim, #9aa0a6); }
      .keyer-row select:focus, .add-picker:focus {
        outline: 2px solid var(--omp-info, #4285f4); outline-offset: 1px;
      }
      .keyer-row select option, .add-picker option {
        background: var(--omp-surface-raised, #22262b); color: var(--omp-text, #e8eaed);
      }

      .rate-row { display: flex; gap: 4px; }
      .rate-row omp-button { width: 34px; height: 26px; font-size: 10px; }
      .transition {
        display: flex; flex-direction: column; align-items: center; gap: var(--omp-space-2, 8px);
        border-left: 1px solid var(--omp-border, #2e3338); padding-left: var(--omp-space-3, 12px);
      }
      .transition omp-button.cut { width: 100%; }
      .transition omp-button.auto { width: 100%; }
      .mix-wipe { display: flex; gap: 4px; width: 100%; }
      .mix-wipe omp-button { flex: 1; height: 26px; font-size: 10px; }
      p.empty {
        font-size: var(--omp-font-size-xs, 11px); font-style: italic;
        color: var(--omp-text-dim, #9aa0a6); margin: 0;
      }
      .pin-chip {
        display: inline-flex; align-items: center; gap: 3px; height: 34px;
        padding: 0 4px 0 8px; font-size: 10px;
        background: var(--omp-surface, #1a1d21);
        border: 1px solid var(--omp-border, #2e3338); border-radius: var(--omp-radius, 6px);
      }
      .pin-chip .label { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pin-chip omp-button { width: 20px !important; height: 20px !important; font-size: 11px; padding: 0; }
      [disabled] { opacity: 0.4; }
    `;

    // Geteilte, ebenenunabhängige Hilfsfunktionen — je einmal definiert,
    // von jeder Bank (buildBank unten) mit ihrem eigenen `call()`
    // aufgerufen, statt N-fach dupliziert zu werden.
    const makeBusButton = (call, label, senderId, isProgram) => {
      const btn = document.createElement("omp-button");
      btn.textContent = label;
      const method = isProgram ? "crosspoint.take" : "crosspoint.select";
      btn.addEventListener("click", () => call(method, { senderId }));
      return btn;
    };

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

    // Baut eine Bus-Reihe (PGM oder PST) auf: BLK zuerst, dann (nur
    // Mastereben) die festen Tasten für andere Ebenen-Ausgänge
    // (`levelOutputSenderIds`, s. Moduldoku oben), dann die kuratierte
    // Kreuzschiene gruppiert nach `ownSenderIds` (Workflow-Zugehörigkeit)
    // — nur, wenn tatsächlich beide Gruppen (eigener Workflow + Rest)
    // nicht leer sind, sonst bleibt es bei der bisherigen flachen Liste.
    const renderBusRow = (call, container, entries, ownSenderIds, isProgram, activeId, color, levelOutputSenderIds) => {
      const [blk, ...rest] = entries;
      const appendEntry = (entry) => {
        const btn = makeBusButton(call, entry.label, entry.senderId, isProgram);
        btn.active = entry.senderId === activeId;
        btn.setAttribute("color", color);
        container.append(btn);
      };
      appendEntry(blk);

      let remaining = rest;
      if (levelOutputSenderIds && levelOutputSenderIds.size > 0) {
        const levelEntries = rest.filter((e) => levelOutputSenderIds.has(e.senderId));
        remaining = rest.filter((e) => !levelOutputSenderIds.has(e.senderId));
        if (levelEntries.length > 0) {
          const levelLabel = document.createElement("div");
          levelLabel.className = "group-label";
          levelLabel.textContent = "Mischerebenen";
          container.append(levelLabel);
          for (const entry of levelEntries) appendEntry(entry);
        }
      }

      const own = remaining.filter((e) => ownSenderIds.has(e.senderId));
      const others = remaining.filter((e) => !ownSenderIds.has(e.senderId));
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
        for (const entry of remaining) appendEntry(entry);
      }
    };

    // Skalierungs-Review D5/Nutzerwunsch (docs/REVIEW-2026-07-17-
    // SKALIERUNG-24-7.md, präzisiert 2026-07-22): PGM/PST-Quellen nach
    // Workflow-Zugehörigkeit gruppieren, gleiches Muster wie
    // omp-switcher/ui/bundle.js (dort ausführlicher kommentiert) und wie
    // omp-audio-mixer/ui/bundle.js#loadFollowTargets (AFV-Ziel-Dropdown).
    // Liefert zusätzlich die eigenen Ausgangs-Sender-IDs dieses Nodes,
    // aufgeschlüsselt nach Ebene (Nachtrag 2026-08-14 fürs Mastereben-
    // Routing oben) — EIN gemeinsamer `/api/v1/graph`-Fetch für beides
    // statt zweier getrennter Aufrufe. Die Ebenen-Zuordnung läuft über
    // das Label ("PGM {n}", main.rs::main()s `SenderSpec.label`), NICHT
    // über die Array-Reihenfolge in `n.outputs` — live gefunden
    // (2026-08-14): die Reihenfolge dort folgt NICHT der Registrierung
    // (z. B. "PGM 2" vor "PGM 1"), Label-Parsing ist die einzige robuste
    // Zuordnung ohne einen neuen dedizierten Node-Parameter.
    const graphContext = async () => {
      const [graphRes, workflowsRes] = await Promise.all([
        fetch("/api/v1/graph"),
        fetch("/api/v1/workflows"),
      ]);
      const senderNodeId = new Map();
      const ownSenderIdByLevel = new Map(); // 1-basierte Ebenennummer -> senderId
      const pgmLabelPattern = /^PGM (\d+)$/;
      if (graphRes.ok) {
        const graph = await graphRes.json();
        for (const n of graph.nodes || []) {
          for (const out of n.outputs || []) senderNodeId.set(out.id, n.id);
          if (n.id === nodeId) {
            for (const out of n.outputs || []) {
              const m = pgmLabelPattern.exec(out.label || "");
              if (m) ownSenderIdByLevel.set(parseInt(m[1], 10), out.id);
            }
          }
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
      const workflowOwnSenderIds = new Set();
      for (const [senderId, nId] of senderNodeId) {
        if (nodeWorkflow.get(nId) === ownWorkflowId && ownWorkflowId) workflowOwnSenderIds.add(senderId);
      }
      return { workflowOwnSenderIds, ownSenderIdByLevel };
    };

    // Baut EINE vollständige, unabhängige M/E-Bank für `level` (0-basiert)
    // — eigene PGM/PST/SRC/Keyer/PIP/Transition-Konsole, exakt wie vor
    // Teil 4 (dieselbe Optik/Verhalten bei `levelCount<=1`, dann
    // unpräfigierte Param-/Methodennamen). Gibt `{ section, refresh }`
    // zurück; `refresh` erwartet `workflowOwnSenderIds`/
    // `otherLevelSenderIds` von außen (s. `graphContext()`), damit der
    // Graph/Workflows-Fetch nicht je Bank dupliziert wird.
    const buildBank = (level) => {
      const prefixed = (base) => (levelCount > 1 ? `level${level + 1}.${base}` : base);

      const call = (method, body) =>
        fetch(`/api/v1/nodes/${nodeId}/methods/${prefixed(method)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(() => refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds));

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

      // Sichtbare Untergruppierung (s. Moduldoku/CSS oben): Kreuzschiene
      // (PGM/PST/SRC) bleibt eine Gruppe, Compositing/Keyer/Rate eine
      // zweite — eine Trennlinie macht den fachlichen Unterschied auch
      // optisch sichtbar statt nur durch Abstand angedeutet.
      const fxGroup = document.createElement("div");
      fxGroup.className = "fx-group";
      fxGroup.append(fxRow, keyerRow, pipRow, rateRow);

      buses.append(pgmRow, pstRow, srcRow, fxGroup);

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
      section.setAttribute(
        "label",
        levelCount <= 1 ? "Video Mixer M/E" : level === 0 ? `M/E 1 (Master)` : `M/E ${level + 1}`,
      );
      section.append(console_);

      cutBtn.addEventListener("click", () => call("crosspoint.cut"));
      autoBtn.addEventListener("click", () => {
        call("crosspoint.autoTrans");
        animateTBar();
      });

      // Bug 4: folgt seit `refresh()`s erstem erfolgreichen Poll der echten
      // `crosspoint.transRate` statt der festen `DEFAULT_AUTO_TRANS_VISUAL_MS`
      // (s. dortige Doku).
      let currentTransRateMs = DEFAULT_AUTO_TRANS_VISUAL_MS;

      let tBarAnimation = null;
      const animateTBar = () => {
        if (tBarAnimation) cancelAnimationFrame(tBarAnimation);
        const durationMs = currentTransRateMs;
        const start = performance.now();
        const tick = (now) => {
          const pct = Math.min(1, (now - start) / durationMs);
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

      // Bug 4 (vormals ausgegraut, "K3-Teil-2"): jetzt echte Rate-Wahl-
      // Tasten, `crosspoint.setTransRate` (main.rs) wirkt ab dem nächsten
      // `autoTrans()`-Aufruf (pipeline.rs::PipelineHandle::set_trans_rate).
      const RATES = [6, 12, 25, 50];
      const rateButtons = new Map();
      for (const frames of RATES) {
        const btn = document.createElement("omp-button");
        btn.textContent = `${frames}f`;
        btn.title = `Rampendauer: ${frames} Frames (${frames * MS_PER_TRANS_FRAME}ms)`;
        btn.addEventListener("click", () => call("crosspoint.setTransRate", { frames }));
        rateButtons.set(frames, btn);
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
      addSourceBtn.style.cssText = "width:34px !important; height:34px !important; font-size:16px; padding:0;";
      let addPickerOpen = false;
      let latestInputs = [];
      let latestPinned = [];
      let lastWorkflowOwnSenderIds = new Set();
      let lastOtherLevelSenderIds = new Set();

      const closeAddPicker = () => {
        addPickerOpen = false;
        refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds);
      };

      addSourceBtn.addEventListener("click", () => {
        addPickerOpen = true;
        const available = latestInputs
          .filter((i) => !latestPinned.includes(i.senderId))
          .map((i) => ({ label: i.label, senderId: i.senderId }));
        const picker = document.createElement("select");
        picker.className = "add-picker";
        picker.style.width = "160px";
        buildGroupedOptions(picker, available, lastWorkflowOwnSenderIds, "Quelle wählen…");
        picker.addEventListener("change", async () => {
          if (picker.value) await call("crosspoint.pin", { senderId: picker.value });
          closeAddPicker();
        });
        picker.addEventListener("blur", closeAddPicker);
        srcButtons.replaceChild(picker, addSourceBtn);
        picker.focus();
      });

      const refresh = async (workflowOwnSenderIds, otherLevelSenderIds) => {
        lastWorkflowOwnSenderIds = workflowOwnSenderIds;
        lastOtherLevelSenderIds = otherLevelSenderIds;
        const [
          inputsRes, programRes, presetRes, keyerRes, keyerInputsRes, keyerSourceRes,
          pipEnabledRes, pipSourceRes, pinnedRes, transRateRes,
        ] = await Promise.all([
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.inputs")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.programInput")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.presetInput")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.enabled")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.inputs")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.source")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.enabled")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.source")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.pinnedSenderIds")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.transRate")}`),
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
        const transRateFrames = transRateRes.ok ? (await transRateRes.json()).value || 0 : 0;
        if (transRateFrames > 0) {
          currentTransRateMs = transRateFrames * MS_PER_TRANS_FRAME;
          for (const [frames, btn] of rateButtons) btn.active = frames === transRateFrames;
        }
        latestInputs = inputs;
        latestPinned = pinned;

        // Dropdown nur neu bauen, wenn sich die Optionen tatsächlich
        // geändert haben (sonst würde ein offenes Dropdown bei jedem
        // 2s-Poll unter dem Cursor zuklappen) — Vergleich per JSON-String
        // reicht hier, die Liste ist klein und ändert sich selten.
        const keyerOptionsKey = JSON.stringify([...keyerInputs.map((k) => k.senderId), ...workflowOwnSenderIds]);
        if (keyerSourceSelect.dataset.optionsKey !== keyerOptionsKey) {
          keyerSourceSelect.dataset.optionsKey = keyerOptionsKey;
          buildGroupedOptions(keyerSourceSelect, keyerInputs, workflowOwnSenderIds, "Testfarbe");
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
        const pipOptionsKey = JSON.stringify([...pipInputEntries.map((e) => e.senderId), ...workflowOwnSenderIds]);
        if (pipSourceSelect.dataset.optionsKey !== pipOptionsKey) {
          pipSourceSelect.dataset.optionsKey = pipOptionsKey;
          buildGroupedOptions(pipSourceSelect, pipInputEntries, workflowOwnSenderIds, "Schwarz");
        }
        if (pipSourceSelect !== shadow.activeElement) pipSourceSelect.value = pipSource;

        // Kuratierte Kreuzschiene: SRC-Reihe zeigt die angepinnten Quellen
        // (+ Entfernen-Taste) plus die "+"-Taste — außer der Add-Picker ist
        // gerade offen (sonst würde der laufende Poll ihn wegrendern, bevor
        // der Operator eine Auswahl treffen konnte).
        if (!addPickerOpen) {
          srcButtons.innerHTML = "";
          if (pinned.length === 0) {
            const hint = document.createElement("p");
            hint.className = "empty";
            hint.textContent = "keine Quellen angeheftet";
            srcButtons.append(hint);
          }
          for (const senderId of pinned) {
            const input = inputs.find((i) => i.senderId === senderId);
            // Nutzerfund 2026-08-14: fiel bislang auf ein Präfix der rohen
            // senderId zurück (z. B. "4749d606") — unübersichtlich, sah wie
            // ein UI-Bug statt einer erklärten Quelle aus. Eine angepinnte
            // Quelle, die gerade nicht im Discovery-Snapshot auftaucht
            // (Neustart-Race, entfernt, …), hat schlicht keinen bekannten
            // Namen mehr — das sagt die Taste jetzt auch so, volle
            // senderId bleibt übers Tooltip (`tag.title` unten) erreichbar.
            const label = input ? input.label : "unbekannt";
            const wrap = document.createElement("span");
            wrap.className = "pin-chip";
            const tag = document.createElement("span");
            tag.className = "label";
            tag.textContent = label;
            tag.title = senderId;
            const removeBtn = document.createElement("omp-button");
            removeBtn.textContent = "×";
            removeBtn.title = "Quelle entfernen";
            removeBtn.addEventListener("click", () => call("crosspoint.unpin", { senderId }));
            wrap.append(tag, removeBtn);
            srcButtons.append(wrap);
          }
          srcButtons.append(addSourceBtn);
        }

        pgmButtons.innerHTML = "";
        pstButtons.innerHTML = "";

        // Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): PGM/PST zeigen
        // nur noch BLK + angepinnte Quellen (+ in der Mastereben die festen
        // Ebenen-Ausgänge, s. Moduldoku oben) — plus, als Sicherheitsnetz,
        // das jeweils aktuell aufgeschaltete Programm/Preset auch dann,
        // wenn es (z. B. nach einem Unpin) nicht mehr in der Pin-Liste
        // steht, damit der Operator nie "blind" auf eine unbenannte Taste
        // schaut.
        const alwaysVisible = new Set(pinned);
        if (program) alwaysVisible.add(program);
        if (preset) alwaysVisible.add(preset);
        if (level === 0) for (const id of otherLevelSenderIds) alwaysVisible.add(id);
        const visibleInputs = inputs.filter((i) => alwaysVisible.has(i.senderId));
        const entries = [{ label: "BLK", senderId: "" }, ...visibleInputs.map((i) => ({ label: i.label, senderId: i.senderId }))];
        if (visibleInputs.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = "keine Quellen angeheftet — über SRC „+“ hinzufügen";
          pstButtons.append(empty);
        }
        const levelOutputSenderIds = level === 0 ? otherLevelSenderIds : undefined;
        renderBusRow(call, pgmButtons, entries, workflowOwnSenderIds, true, program, "onair", levelOutputSenderIds);
        renderBusRow(call, pstButtons, entries, workflowOwnSenderIds, false, preset, "preset", levelOutputSenderIds);

        keyerBtn.active = keyerEnabled;
        pipBtn.active = pipEnabled;
      };

      return { section, refresh };
    };

    const banks = [];
    for (let level = 0; level < levelCount; level++) banks.push(buildBank(level));

    // Ebenen-Restart-Sektion (s. Moduldoku oben zu "Ebenenzahl live
    // ändern") — ermittelt Workflow/Rolle/aktuelles Format über einen
    // eigenen `/api/v1/workflows`-Fetch (kleiner, einmaliger Aufruf beim
    // Panel-Aufbau, anders geformt als `graphContext()`s Poll-Rückgabe
    // oben, daher nicht wiederverwendet). `null`, wenn dieser Node
    // keiner gestarteten Workflow-Rolle zugeordnet ist — die Sektion
    // bleibt dann einfach weg, gleiches Verhalten wie
    // `flow-canvas.ts#findRunningRoleForNode`.
    const findRunningRole = async () => {
      try {
        const res = await fetch("/api/v1/workflows");
        if (!res.ok) return null;
        const list = await res.json();
        for (const wf of list) {
          if (wf.status !== "started") continue;
          for (const [roleName, rt] of Object.entries(wf.runtime || {})) {
            if (rt.nodeId !== nodeId) continue;
            const role = (wf.definition.roles || []).find((r) => r.name === roleName);
            return { workflowId: wf.id, roleName, format: role?.format || "" };
          }
        }
      } catch {
        // Sektion bleibt weg — kein harter Fehler fürs übrige Panel.
      }
      return null;
    };

    let levelsSection = null;
    const roleInfo = await findRunningRole();
    if (roleInfo) {
      levelsSection = document.createElement("omp-panel-section");
      levelsSection.setAttribute("label", "Mischerebenen");

      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-2, 8px);flex-wrap:wrap;";
      const label = document.createElement("span");
      label.textContent = "Ebenen";
      label.style.cssText =
        "font-size:var(--omp-font-size-xs, 11px);color:var(--omp-text-dim, #9aa0a6);" +
        "text-transform:uppercase;letter-spacing:0.04em;font-weight:700;";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "8";
      input.value = String(levelCount);
      input.style.cssText =
        "width:52px;height:34px;font-size:12px;text-align:center;border-radius:var(--omp-radius, 6px);" +
        "background:linear-gradient(to bottom, var(--omp-metal-light, #3d434b) 0%, var(--omp-metal-mid, #2b2f34) 100%);" +
        "color:var(--omp-text, #e8eaed);border:1px solid var(--omp-metal-dark, #1a1c1f);" +
        "box-shadow:0 1px 0 rgba(255,255,255,0.1) inset, 0 1px 2px rgba(0,0,0,0.4);box-sizing:border-box;";
      const applyBtn = document.createElement("omp-button");
      applyBtn.textContent = "Übernehmen";
      applyBtn.title = "Node neu starten — kurz nicht erreichbar, zuvor aufgelegte Quellen werden danach automatisch wieder verbunden.";
      applyBtn.style.cssText = "height:34px !important; padding:0 var(--omp-space-3, 12px) !important;";

      // Sendet `roleInfo.format` unverändert mit (s. Moduldoku oben) —
      // nur `mixerLevels` ist die eigentlich gewollte Änderung dieses
      // Buttons, `format` bleibt server-seitig sonst nicht "unangetastet"
      // wie ein fehlendes `mixerLevels`-Feld, sondern würde auf den
      // Node-Standard zurückgesetzt.
      applyBtn.addEventListener("click", async () => {
        const n = Math.max(1, Math.min(8, parseInt(input.value, 10) || 1));
        const ok = confirm(
          `Rolle "${roleInfo.roleName}" mit ${n} Ebene(n) neu starten? Der Node ist dabei kurz nicht erreichbar, ` +
            `zuvor aufgelegte Quellen werden danach automatisch wieder verbunden.`,
        );
        if (!ok) return;
        applyBtn.setAttribute("disabled", "");
        try {
          const res = await fetch(
            `/api/v1/workflows/${roleInfo.workflowId}/roles/${encodeURIComponent(roleInfo.roleName)}/restart`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ format: roleInfo.format, mixerLevels: n }),
            },
          );
          if (!res.ok) alert(`Neustart fehlgeschlagen: ${await res.text()}`);
        } catch (err) {
          alert(`Neustart fehlgeschlagen: ${err}`);
        } finally {
          applyBtn.removeAttribute("disabled");
        }
      });

      row.append(label, input, applyBtn);
      levelsSection.append(row);
    }

    // §4.6 Punkt 4 (docs/END-GOAL-FEATURES.md, "Mixer-Presets",
    // docs/decisions.md Nachtrag 40): UI-Anschluss des Backend-seitig
    // bereits vorhandenen `GET`/`POST /state` (main.rs::capture_state/
    // restore_state) — identisches Muster wie omp-audio-mixer/ui/
    // bundle.js (derselbe generische Snapshot-Mechanismus, per
    // `nodeIds:[nodeId]` auf genau diesen Node eingeschränkt). EIN
    // Preset-Satz für den ganzen Node (main.rs liefert bei
    // `level_count>1` automatisch ein `{levels:[...]}`-Array), nicht je
    // Bank — bleibt daher außerhalb der Ebenen-Schleife oben.
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
          await refreshAll();
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

    shadow.append(
      style,
      ...banks.map((b) => b.section),
      ...(levelsSection ? [levelsSection] : []),
      presetSection,
    );
    renderPresets();

    // Ein gemeinsamer Graph/Workflows-Fetch je Poll für alle Banken (s.
    // `graphContext()`-Doku oben) statt N-facher Redundanz.
    const refreshAll = async () => {
      const { workflowOwnSenderIds, ownSenderIdByLevel } = await graphContext();
      // Mastereben = Ebene 1 (1-basiert, `level===0` intern) — deren
      // eigener Sender bleibt ausgeschlossen, alle anderen Ebenen-
      // Ausgänge werden feste PGM/PST-Tasten (s. Moduldoku oben).
      const otherLevelSenderIds = new Set(
        [...ownSenderIdByLevel.entries()].filter(([lvl]) => lvl !== 1).map(([, id]) => id),
      );
      await Promise.all(banks.map((b) => b.refresh(workflowOwnSenderIds, otherLevelSenderIds)));
    };

    refreshAll();
    this._interval = setInterval(refreshAll, 2000);

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
      if (parsed.type === `omp.tally.${nodeId}`) refreshAll();
    };

    this._refresh = refreshAll;
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    if (this._es) this._es.close();
  }
}

if (!customElements.get("omp-video-mixer-me-panel")) {
  customElements.define("omp-video-mixer-me-panel", OmpVideoMixerMePanel);
}
