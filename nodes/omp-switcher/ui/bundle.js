// Node-UI-Bundle des Switchers (UMSETZUNG.md C7, ARCHITECTURE.md §4.5):
// ein Button pro entdeckter Quelle (aus dem readonly "inputs"-Parameter)
// plus ein Schwarzbild-Button, aktiver Button hervorgehoben. Nutzt
// dieselbe generische Node-Proxy-API wie das Shell-Panel
// (/api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>)
// — kein Sonderprotokoll. Pollt alle 2s, weil "inputs" sich außerhalb
// dieses Nodes ändert (neue omp-source-Instanzen erscheinen/verschwinden)
// und es dafür (anders als bei einzelnen Parametern) keinen SSE-Kanal
// gibt.
//
// Skalierungs-Review D5/Nutzerwunsch (docs/REVIEW-2026-07-17-SKALIERUNG-
// 24-7.md, "Source-Katalog-UI modernisieren", präzisiert 2026-07-22:
// analog zur bereits verbesserten AFV-Ziel-Auswahl im Audio-Mixer,
// s. dortiges `rebuildFollowOptions`/`loadFollowTargets`): Quellen
// werden nach Workflow-Zugehörigkeit gruppiert (eigener Workflow zuerst,
// sichtbare Zwischenüberschrift), sobald mehr als eine Gruppe existiert
// — bei fehlender Workflow-Nutzung (kein Workflow oder alle Quellen im
// selben) bleibt die Liste unverändert flach, wie zuvor.
//
// Bugliste 2026-09-25 #6 ("switcher ... braucht ein professionelleres
// design, unseres wirkt wie eine kindliche Lösung"): Vergleich mit
// `omp-video-mixer-me/ui/bundle.js` (Screenshot-Vergleich, per Headless-
// Chromium/CDP bestätigt) zeigte den Unterschied konkret — der Mixer
// nutzt bereits `<omp-button>` (`ui/kit`, von der Shell geladen, s.
// dortiger Moduldoku-Kommentar) mit dessen "gegossene Metall-Taste"-
// Optik + `color="onair"/"preset"`-Tallys, der Switcher bisher rohe,
// ungestylte `<button>`-Elemente mit fest verdrahteten Ad-hoc-Farben.
// Fix: dieselbe `<omp-button>`-Komponente + dieselben `--omp-*`-Design-
// Tokens wie der Mixer — kein neues Design erfunden, sondern das
// bereits bewährte übernommen (`color="onair"`, da der Switcher direkt
// PGM schneidet, keinen separaten Preset-Bus hat — passendste Semantik
// von `ui/design-tokens.css`s Signalfarben). Zusätzlich (Nutzerwunsch
// "optional einstellbar ... vorschaubild ... der Operator drückt auf
// das Bild, das er auf PGM sehen will"): ein Umschalter blendet ein
// kleines Live-Vorschaubild pro Quelle ein — nur für Quellen, deren
// Node tatsächlich einen `previewUrl`-Stream anbietet (nicht jeder
// Node-Typ hat das, s. `ui/shell/node-preview.ts`-Moduldoku; ohne
// Vorschaubild bleibt es bei einem sauber gestylten, rein
// beschrifteten Knopf statt eines kaputten Bild-Icons).
class OmpSwitcherPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const THUMBS_KEY = `omp-switcher-thumbs-${nodeId}`;
    const STREAM_TOKEN_KEY = "omp-auth-token";
    let thumbsEnabled = localStorage.getItem(THUMBS_KEY) === "1";

    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        font-family: var(--omp-font, system-ui, sans-serif);
        color: var(--omp-text, #e8eaed);
        font-size: var(--omp-font-size-sm, 12px);
      }
      .toolbar {
        display: flex; align-items: center; justify-content: space-between;
        gap: var(--omp-space-2, 8px); margin-bottom: var(--omp-space-2, 8px);
      }
      .toolbar-label {
        font-size: var(--omp-font-size-xs, 11px); font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--omp-text-dim, #9aa0a6);
      }
      .thumbs-toggle {
        display: flex; align-items: center; gap: 5px; cursor: pointer;
        color: var(--omp-text-dim, #9aa0a6); font-size: var(--omp-font-size-xs, 11px);
        user-select: none;
      }
      .thumbs-toggle input { width: 14px; height: 14px; accent-color: var(--omp-info, #4285f4); cursor: pointer; }
      .buttons { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
      .group-label {
        flex-basis: 100%; font-size: var(--omp-font-size-xs, 11px); font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--omp-text-dim, #9aa0a6); margin: 6px 0 -1px; padding-left: 2px;
        border-left: 2px solid var(--omp-border, #2e3338);
      }
      .group-label:first-child { margin-top: 0; }

      /* Ohne Vorschaubilder: kompakte Pille, exakt wie omp-video-mixer-
         mes Bus-Tasten dimensioniert. */
      omp-button.source { width: 92px; height: 40px; font-size: 11px; line-height: 1.15; }

      /* Mit Vorschaubildern: Karte mit 16:9-Bild + Beschriftung darunter
         — der Operator "drückt auf das Bild" (Nutzerwunsch), Text bleibt
         als eindeutiger Anker daneben, falls zwei Quellen ähnlich aussehen. */
      omp-button.source.with-thumb { width: 120px; height: auto; padding: 0 !important; }
      omp-button.source.with-thumb::part(button) { flex-direction: column; padding: 4px !important; gap: 4px; }
      .thumb {
        width: 100%; aspect-ratio: 16/9; border-radius: 3px; overflow: hidden;
        background: #000; position: relative; flex-shrink: 0;
      }
      .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .thumb .no-signal {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: var(--omp-text-disabled, #5f6368); text-transform: uppercase; letter-spacing: 0.05em;
      }
      .thumb-label {
        font-size: 10px; line-height: 1.2; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; max-width: 100%;
      }
      p.empty {
        font-size: var(--omp-font-size-xs, 11px); font-style: italic;
        color: var(--omp-text-dim, #9aa0a6); margin: 4px 0 0;
      }
    `;

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const toolbarLabel = document.createElement("span");
    toolbarLabel.className = "toolbar-label";
    toolbarLabel.textContent = "Quellen";
    const thumbsToggle = document.createElement("label");
    thumbsToggle.className = "thumbs-toggle";
    const thumbsCheckbox = document.createElement("input");
    thumbsCheckbox.type = "checkbox";
    thumbsCheckbox.checked = thumbsEnabled;
    thumbsToggle.append(thumbsCheckbox, document.createTextNode("Vorschaubilder"));
    thumbsCheckbox.addEventListener("change", () => {
      thumbsEnabled = thumbsCheckbox.checked;
      localStorage.setItem(THUMBS_KEY, thumbsEnabled ? "1" : "0");
      refresh();
    });
    toolbar.append(toolbarLabel, thumbsToggle);

    const buttons = document.createElement("div");
    buttons.className = "buttons";
    shadow.append(style, toolbar, buttons);

    const select = (senderId) => {
      fetch(`/api/v1/nodes/${nodeId}/methods/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderId || "" }),
      }).then(refresh);
    };

    // Sender->Workflow-Auflösung, gleiches Muster wie omp-audio-mixer/
    // ui/bundle.js#loadFollowTargets: GET /api/v1/graph liefert
    // senderId->nodeId (node.outputs[].id), GET /api/v1/workflows liefert
    // nodeId->workflowId (wf.runtime[role].nodeId) + workflowId->Label.
    // Liefert zusätzlich `senderNodeId` selbst zurück (Bugliste #6:
    // Grundlage für die Vorschaubild-URLs — derselbe Node, der den
    // Sender veröffentlicht, liefert auch dessen `previewUrl`-Stream,
    // falls vorhanden).
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
      let workflowLabel = new Map();
      if (workflowsRes.ok) {
        const workflows = await workflowsRes.json();
        for (const wf of workflows) {
          workflowLabel.set(wf.id, wf.definition?.title || wf.name);
          for (const role of Object.values(wf.runtime || {})) {
            if (!role.nodeId) continue;
            nodeWorkflow.set(role.nodeId, wf.id);
            if (role.nodeId === nodeId) ownWorkflowId = wf.id;
          }
        }
      }
      const workflowBySender = new Map();
      for (const [senderId, nId] of senderNodeId) {
        const wfId = nodeWorkflow.get(nId);
        if (wfId) workflowBySender.set(senderId, { id: wfId, label: workflowLabel.get(wfId) || wfId, own: wfId === ownWorkflowId });
      }
      return { workflowBySender, senderNodeId };
    };

    // Vorschaubild-Snapshot-URL — identisches Muster zu `ui/shell/node-
    // preview.ts#previewSnapshotUrl` (eigenes, kleines Modul statt Import:
    // Node-UI-Bundles sind eigenständig gebaut, kein Zugriff auf die
    // Shell-eigenen TS-Module).
    const previewSnapshotUrl = (sourceNodeId) => {
      const token = localStorage.getItem(STREAM_TOKEN_KEY);
      const base = `/api/v1/nodes/${sourceNodeId}/stream/previewUrl`;
      const withToken = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
      return `${withToken}${withToken.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };

    const makeInputButton = (input, active, sourceNodeId) => {
      const btn = document.createElement("omp-button");
      btn.className = thumbsEnabled ? "source with-thumb" : "source";
      btn.active = active;
      btn.setAttribute("color", "onair");
      btn.addEventListener("click", () => select(input.senderId));

      if (thumbsEnabled) {
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        if (sourceNodeId) {
          const img = document.createElement("img");
          img.alt = input.label;
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = "kein Bild";
          noSignal.hidden = true;
          img.addEventListener("load", () => { img.hidden = false; noSignal.hidden = true; });
          img.addEventListener("error", () => { img.hidden = true; noSignal.hidden = false; });
          img.src = previewSnapshotUrl(sourceNodeId);
          thumb.append(img, noSignal);
        } else {
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = "kein Bild";
          thumb.append(noSignal);
        }
        const label = document.createElement("div");
        label.className = "thumb-label";
        label.textContent = input.label;
        btn.append(thumb, label);
      } else {
        btn.textContent = input.label;
      }
      return btn;
    };

    // Bugliste 2026-09-25 Nachtrag ("Thumbnail-Flicker", s. gleiches
    // Muster in omp-video-mixer-me/ui/bundle.js#updateBusButton):
    // aktualisiert einen bereits vorhandenen Knopf statt ihn (und damit
    // sein `<img>`) neu zu erzeugen — nur `img.src` wird neu gesetzt,
    // der Browser zeigt dabei von selbst das alte Bild weiter, bis das
    // neue fertig geladen ist.
    const updateInputButton = (btn, input, sourceNodeId) => {
      if (thumbsEnabled) {
        const img = btn.querySelector("img");
        if (img && sourceNodeId) img.src = previewSnapshotUrl(sourceNodeId);
        const label = btn.querySelector(".thumb-label");
        if (label) label.textContent = input.label;
      } else {
        btn.textContent = input.label;
      }
      return btn;
    };

    const refresh = async () => {
      const [inputsRes, activeRes, { workflowBySender, senderNodeId }] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/activeInput`),
        senderWorkflowLabel(),
      ]);
      if (!inputsRes.ok || !activeRes.ok) return;
      const inputs = (await inputsRes.json()).value || [];
      const active = (await activeRes.json()).value || "";

      // Bestehende Knöpfe per `senderId` einsammeln, BEVOR sie entfernt
      // werden — wiederverwendbare Kandidaten für unten, statt eines
      // pauschalen `buttons.innerHTML = ""`, das jedes Mal auch noch
      // gültige Vorschaubild-`<img>`s zerstören würde.
      const existingButtons = new Map();
      for (const el of Array.from(buttons.children)) {
        if (el.tagName === "OMP-BUTTON" && el.dataset.senderId !== undefined) {
          existingButtons.set(el.dataset.senderId, el);
        }
        el.remove();
      }

      const fragment = document.createDocumentFragment();

      const appendButton = (senderId, makeNew, wantsThumb, sourceNodeId, updateFn) => {
        const reused = existingButtons.get(senderId);
        const hasImg = !!reused?.querySelector("img");
        const reusable = reused
          && reused.classList.contains("with-thumb") === wantsThumb
          && hasImg === !!(wantsThumb && sourceNodeId);
        const btn = reusable ? updateFn(reused) : makeNew();
        if (reused) existingButtons.delete(senderId);
        btn.dataset.senderId = senderId;
        fragment.append(btn);
        return btn;
      };

      appendButton("", () => {
        const blackBtn = document.createElement("omp-button");
        blackBtn.className = "source";
        blackBtn.textContent = "Schwarz";
        blackBtn.setAttribute("color", "onair");
        blackBtn.addEventListener("click", () => select(""));
        return blackBtn;
      }, false, undefined, (btn) => btn).active = active === "";

      const own = inputs.filter((i) => workflowBySender.get(i.senderId)?.own);
      const rest = inputs.filter((i) => !workflowBySender.get(i.senderId)?.own);
      const appendGroup = (list) => {
        for (const input of list) {
          const sourceNodeId = senderNodeId.get(input.senderId);
          const wantsThumb = thumbsEnabled;
          const btn = appendButton(
            input.senderId,
            () => makeInputButton(input, input.senderId === active, sourceNodeId),
            wantsThumb,
            sourceNodeId,
            (reused) => updateInputButton(reused, input, sourceNodeId),
          );
          btn.active = input.senderId === active;
        }
      };
      if (own.length > 0 && rest.length > 0) {
        const ownLabel = document.createElement("div");
        ownLabel.className = "group-label";
        ownLabel.textContent = "Dieser Workflow";
        fragment.append(ownLabel);
        appendGroup(own);

        const restLabel = document.createElement("div");
        restLabel.className = "group-label";
        restLabel.textContent = "Andere Quellen";
        fragment.append(restLabel);
        appendGroup(rest);
      } else {
        appendGroup(inputs);
      }

      if (inputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Quellen entdeckt";
        fragment.append(empty);
      }

      buttons.append(fragment);
    };

    refresh();
    this._interval = setInterval(refresh, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-switcher-panel")) {
  customElements.define("omp-switcher-panel", OmpSwitcherPanel);
}
