// Node-UI-Bundle des Viewers (UMSETZUNG.md C6, ARCHITECTURE.md §4.5):
// zeigt den MJPEG-Preview-Stream als <img>. Bis K4 (docs/END-GOAL-
// FEATURES.md Kapitel 10 Entscheidungssitzung Punkt 5) zeigte die Quelle
// direkt auf den node-eigenen, zweiten Preview-HTTP-Listener
// (OMP_VIEWER_PREVIEW_PORT, preview.rs) — das umging die Orchestrator-
// Auth komplett und verlangte, dass der Browser jeden Node-Host direkt
// erreicht. Jetzt läuft der Stream durch den generischen
// Orchestrator-Proxy (`GET /api/v1/nodes/<id>/stream/previewUrl`, löst
// intern denselben previewUrl-Parameter auf und reicht die Antwort
// durch) — derselbe Auth-Schutz wie jeder andere `/api/v1`-Endpunkt,
// der Browser kennt nie Host/Port des zweiten Node-Ports.
//
// 2026-08-06 (Nutzerwunsch: "dynamische Anzahl an Eingängen ... damit
// ich zb den mxf player hinrouten kann und alle Gruppen sehe"): zeigt
// jetzt zusätzlich `<omp-meter>`-Pegelbalken für beliebig viele, zur
// Laufzeit hinzufügbare Audio-Eingänge — jeder ein eigener,
// NMOS-discoverbarer IS-05-Receiver (`main.rs`s `addAudioInput`/
// `removeAudioInput`, `omp_node_sdk::NodeHandle::add_receiver`, erste
// Nutzung dieser SDK-Fähigkeit). `<omp-meter>` selbst kommt aus
// `ui/kit` (global von der Shell registriert, s. `ui/kit/index.ts`) —
// hier direkt per `document.createElement`, kein eigener Import nötig.
class OmpViewerPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      img {
        display: block; max-width: 100%; background: #000;
        border: 1px solid #444;
      }
      p { font-size: 12px; color: #888; }
      .audio-inputs { margin-top: 10px; }
      .audio-inputs h4 { margin: 0 0 6px 0; font-size: 12px; color: #aaa; font-weight: normal; }
      .input-row {
        display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
      }
      .input-row .label { font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .input-row button {
        background: #333; color: #eee; border: 1px solid #555; border-radius: 3px;
        cursor: pointer; font-size: 11px; padding: 2px 6px;
      }
      .add-btn {
        margin-top: 4px; background: #2d4a2d; color: #eee; border: 1px solid #4a7a4a;
        border-radius: 3px; cursor: pointer; font-size: 11px; padding: 4px 8px;
      }
    `;

    const img = document.createElement("img");
    img.alt = "Vorschau";
    img.width = 320;
    // Bis zum ersten erfolgreichen Frame (oder dauerhaft, falls nie
    // verbunden) versteckt — sonst zeigt der Browser sein natives
    // "broken image"-Icon an, sobald `/preview` mangels verbundenem
    // Sender mit 503 statt echtem JPEG antwortet (Nutzerfund
    // 2026-08-21: "wenn viewer nicht connected, dann wird ein broken
    // image angezeigt, stattdessen sollte 'not connected' stehen").
    img.style.display = "none";

    const status = document.createElement("p");
    status.textContent = "lade Vorschau …";

    const audioSection = document.createElement("div");
    audioSection.className = "audio-inputs";
    const audioTitle = document.createElement("h4");
    audioTitle.textContent = "Audio-Eingänge";
    const rowsContainer = document.createElement("div");
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.textContent = "+ Audio-Eingang";
    audioSection.append(audioTitle, rowsContainer, addBtn);

    shadow.append(style, img, status, audioSection);

    // Bewusst per `style.display` statt `status.remove()` umgeschaltet
    // (vormaliger Bug: nach dem ersten erfolgreichen Frame war `status`
    // dauerhaft aus dem DOM entfernt — trennte sich der Sender SPÄTER
    // wieder, lief der `error`-Handler zwar noch, änderte aber nur noch
    // ein bereits entferntes, unsichtbares Element; das Bild blieb als
    // Browser-natives "broken image"-Icon sichtbar, ohne jeden Text).
    img.addEventListener("load", () => {
      status.style.display = "none";
      img.style.display = "";
    });
    img.addEventListener("error", () => {
      img.style.display = "none";
      status.textContent = "nicht verbunden";
      status.style.display = "";
    });
    // Einzelbild-Polling statt `multipart/x-mixed-replace` (2026-08-21
    // per CDP root-caused, s. `nodes/omp-mediaio/src/preview.rs`-
    // Moduldoku — aktuelles Chromium rendert die Multipart-Technik gar
    // nicht mehr, weder hier noch in der Flow-Editor-Kachel-Vorschau,
    // `ui/graph/flow-canvas.ts`s `previewSnapshotUrl`).
    const previewUrl = () => {
      const token = localStorage.getItem("omp-auth-token");
      const base = `/api/v1/nodes/${nodeId}/stream/previewUrl`;
      const withToken = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
      return `${withToken}${withToken.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };
    img.src = previewUrl();
    // S. `ui/graph/flow-canvas.ts`s `#ensurePreviewPolling`-Kommentar
    // (Nutzerfund 2026-08-21, "not connected" für einzelne Frames): erst
    // neu pollen, wenn der vorherige Request wirklich abgeschlossen ist
    // (`img.complete`) — sonst reißt ein blindes Neusetzen von `src`
    // einen bloß etwas langsamen (aber sonst intakten) Request ab, was
    // der Browser als `error` meldet, ununterscheidbar von einer echten
    // Verbindungsstörung.
    this._previewInterval = setInterval(() => {
      if (!img.complete) return;
      img.src = previewUrl();
    }, 500);

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

    // id -> {row, meter}. Neu ankommende `inputId`s aus dem SSE-Strom,
    // die (noch) keine Zeile haben (Race zwischen `addAudioInput`-Antwort
    // und dem nächsten `renderInputs()`-Poll), werden einfach verworfen —
    // der nächste Poll holt sie nach.
    const meterEls = new Map();

    const renderInputs = async () => {
      const inputs = (await getParam("audioInputs")) || [];
      const currentIds = new Set(inputs.map((i) => i.id));
      for (const id of meterEls.keys()) {
        if (!currentIds.has(id)) {
          meterEls.get(id).row.remove();
          meterEls.delete(id);
        }
      }
      for (const input of inputs) {
        if (meterEls.has(input.id)) {
          meterEls.get(input.id).row.querySelector(".label").textContent = input.label;
          continue;
        }
        const row = document.createElement("div");
        row.className = "input-row";
        const meter = document.createElement("omp-meter");
        const labelEl = document.createElement("span");
        labelEl.className = "label";
        labelEl.textContent = input.label;
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", () => call("removeAudioInput", { id: input.id }).then(renderInputs));
        row.append(meter, labelEl, removeBtn);
        rowsContainer.appendChild(row);
        meterEls.set(input.id, { row, meter });
      }
    };

    addBtn.addEventListener("click", () => {
      // Drag & Drop im Flow-Editor verbindet die Quelle danach wie bei
      // jedem anderen Receiver auch (IS-05-PATCH, `AudioInputControl`
      // in `main.rs`) — dieser Button legt nur den leeren Empfänger an.
      call("addAudioInput", {}).then(() => setTimeout(renderInputs, 500));
    });

    renderInputs();
    this._inputsInterval = setInterval(renderInputs, 3000);

    // Ein SSE-Strom für ALLE Audio-Eingänge (`inputId`-markiert), s.
    // `main.rs`/`audio_meters.rs`-Moduldoku — gleiches Muster wie
    // `omp-audio-mixer`s `/levels`.
    getParam("levelsUrl").then((url) => {
      if (!url) return;
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
        const refs = meterEls.get(parsed.inputId);
        if (refs) {
          refs.meter.value = parsed.rms;
          refs.meter.peak = parsed.peak;
        }
      };
    });
  }

  disconnectedCallback() {
    clearInterval(this._inputsInterval);
    clearInterval(this._previewInterval);
    if (this._levelsSource) this._levelsSource.close();
  }
}

if (!customElements.get("omp-viewer-panel")) {
  customElements.define("omp-viewer-panel", OmpViewerPanel);
}
