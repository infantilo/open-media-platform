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
// PGM-Reihe bewusst nur Anzeige, kein Hot-Cut: §3.5 offene Frage 1 ist
// nicht entschieden, und ein Hot-Cut wäre ohne Node-Änderung nur über
// einen impliziten "select+cut"-Umweg lösbar, der nebenbei die
// gestagte Preset-Auswahl verwirft — zu überraschendes Verhalten für
// einen Live-Schnitt, um es ungefragt zu implementieren.
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
      .fx-row { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
      .fx-row omp-button { flex: 1; height: 34px; }
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

    const fxRow = document.createElement("div");
    fxRow.className = "fx-row";
    const rateRow = document.createElement("div");
    rateRow.className = "rate-row";

    buses.append(pgmRow, pstRow, fxRow, rateRow);

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

    shadow.append(style, section);

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

    const dveBtn = document.createElement("omp-button");
    dveBtn.textContent = "PIP";
    dveBtn.setAttribute("color", "preset");
    let dvePipActive = false;
    dveBtn.addEventListener("click", () => (dvePipActive ? call("dve.reset") : call("dve.setBox", PIP_BOX)));

    fxRow.append(keyerBtn, dveBtn);

    const makeBusButton = (label, senderId, isProgram) => {
      const btn = document.createElement("omp-button");
      btn.textContent = label;
      if (!isProgram) {
        btn.addEventListener("click", () => call("crosspoint.select", { senderId }));
      }
      return btn;
    };

    const refresh = async () => {
      const [inputsRes, programRes, presetRes, keyerRes, dveRes] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.programInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.presetInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/keyer.enabled`),
        fetch(`/api/v1/nodes/${nodeId}/params/dve.box`),
      ]);
      if (!inputsRes.ok || !programRes.ok || !presetRes.ok) return;
      const inputs = (await inputsRes.json()).value || [];
      const program = (await programRes.json()).value || "";
      const preset = (await presetRes.json()).value || "";
      keyerEnabled = keyerRes.ok ? (await keyerRes.json()).value === true : false;
      const dveBox = dveRes.ok ? (await dveRes.json()).value : null;
      dvePipActive = !!dveBox && dveBox.width < WIDTH;

      pgmButtons.innerHTML = "";
      pstButtons.innerHTML = "";

      const entries = [{ label: "BLK", senderId: "" }, ...inputs.map((i) => ({ label: i.label, senderId: i.senderId }))];
      if (inputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Quellen entdeckt";
        pstButtons.append(empty);
      }
      for (const entry of entries) {
        const pgmBtn = makeBusButton(entry.label, entry.senderId, true);
        pgmBtn.active = entry.senderId === program;
        pgmBtn.setAttribute("color", "onair");
        pgmButtons.append(pgmBtn);

        const pstBtn = makeBusButton(entry.label, entry.senderId, false);
        pstBtn.active = entry.senderId === preset;
        pstBtn.setAttribute("color", "preset");
        pstButtons.append(pstBtn);
      }

      keyerBtn.active = keyerEnabled;
      dveBtn.active = dvePipActive;
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
