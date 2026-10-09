// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
      "thumbnails": "Vorschaubilder",
      "sources": "Quellen",
      "mismatch": "Abweichendes Format: {format} — Switcher: {own}",
      "noPicture": "kein Bild",
      "black": "Schwarz",
      "ownWorkflow": "Dieser Workflow",
      "otherSources": "Andere Quellen",
      "noSources": "keine Quellen entdeckt",
      "back": "Zurück",
      "scopeOwn": "Nur eigene Gruppe",
      "scopeOwnTitle": "Nur Quellen der Gruppe/des Workflows anzeigen, in der dieser Switcher liegt (inkl. Untergruppen)"
  },
    en: {
      "thumbnails": "Thumbnails",
      "sources": "Sources",
      "mismatch": "Different format: {format} — switcher: {own}",
      "noPicture": "no picture",
      "black": "Black",
      "ownWorkflow": "This workflow",
      "otherSources": "Other sources",
      "noSources": "no sources discovered",
      "back": "Back",
      "scopeOwn": "Own group only",
      "scopeOwnTitle": "Only show sources in the group/workflow this switcher belongs to (including subgroups)"
  },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

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
    // Menü-Navigation (Workflows/Gruppen -> Untergruppen -> Quellen):
    // aktueller Pfad (Schlüsselliste) und "nur eigene Gruppe" pro Switcher.
    const NAV_KEY = `omp-switcher-nav-${nodeId}`;
    const SCOPE_KEY = `omp-switcher-scope-${nodeId}`;
    let scopeOwn = localStorage.getItem(SCOPE_KEY) === "1";
    let navPath = [];
    try {
      const saved = JSON.parse(localStorage.getItem(NAV_KEY) || "[]");
      if (Array.isArray(saved)) navPath = saved.filter((k) => typeof k === "string");
    } catch { /* kaputter Eintrag -> Wurzel */ }
    const setNavPath = (path) => {
      navPath = path;
      localStorage.setItem(NAV_KEY, JSON.stringify(path));
      refresh();
    };

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
      omp-button.folder { min-width: 92px; height: 40px; font-size: 11px; line-height: 1.15; padding: 0 6px; }
      .navrow {
        flex-basis: 100%; display: flex; align-items: center; gap: 8px;
        font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6);
      }
      .crumb { font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      p.empty {
        font-size: var(--omp-font-size-xs, 11px); font-style: italic;
        color: var(--omp-text-dim, #9aa0a6); margin: 4px 0 0;
      }
    `;

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const toolbarLabel = document.createElement("span");
    toolbarLabel.className = "toolbar-label";
    toolbarLabel.textContent = T("sources");
    const thumbsToggle = document.createElement("label");
    thumbsToggle.className = "thumbs-toggle";
    const thumbsCheckbox = document.createElement("input");
    thumbsCheckbox.type = "checkbox";
    thumbsCheckbox.checked = thumbsEnabled;
    thumbsToggle.append(thumbsCheckbox, document.createTextNode(T("thumbnails")));
    thumbsCheckbox.addEventListener("change", () => {
      thumbsEnabled = thumbsCheckbox.checked;
      localStorage.setItem(THUMBS_KEY, thumbsEnabled ? "1" : "0");
      refresh();
    });
    const scopeToggle = document.createElement("label");
    scopeToggle.className = "thumbs-toggle";
    scopeToggle.title = T("scopeOwnTitle");
    const scopeCheckbox = document.createElement("input");
    scopeCheckbox.type = "checkbox";
    scopeCheckbox.checked = scopeOwn;
    scopeToggle.append(scopeCheckbox, document.createTextNode(T("scopeOwn")));
    scopeCheckbox.addEventListener("change", () => {
      scopeOwn = scopeCheckbox.checked;
      localStorage.setItem(SCOPE_KEY, scopeOwn ? "1" : "0");
      navPath = [];
      localStorage.setItem(NAV_KEY, "[]");
      refresh();
    });
    const toolbarRight = document.createElement("span");
    toolbarRight.style.cssText = "display:flex;gap:12px;align-items:center";
    toolbarRight.append(scopeToggle, thumbsToggle);
    toolbar.append(toolbarLabel, toolbarRight);

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
    // Gruppenbaum des Flow-Editors (Layout "default"): ändert sich selten,
    // deshalb höchstens alle 10 s neu laden statt bei jedem 2-s-Poll.
    let groupTreeCache = { at: 0, groups: {} };
    const loadGroupTree = async () => {
      if (Date.now() - groupTreeCache.at < 10000) return groupTreeCache.groups;
      try {
        const res = await fetch("/api/v1/layouts/default");
        if (res.ok) {
          const blob = await res.json();
          groupTreeCache = { at: Date.now(), groups: blob.groups?.groups || {} };
        } else {
          groupTreeCache.at = Date.now();
        }
      } catch {
        groupTreeCache.at = Date.now();
      }
      return groupTreeCache.groups;
    };

    const senderWorkflowLabel = async () => {
      const [graphRes, workflowsRes, groupTree] = await Promise.all([
        fetch("/api/v1/graph"),
        fetch("/api/v1/workflows"),
        loadGroupTree(),
      ]);
      const senderNodeId = new Map();
      if (graphRes.ok) {
        const graph = await graphRes.json();
        for (const n of graph.nodes || []) {
          for (const out of n.outputs || []) senderNodeId.set(out.id, n.id);
        }
      }
      const workflowNodes = new Map(); // workflowId -> { label, nodeIds }
      let ownWorkflowId = null;
      if (workflowsRes.ok) {
        const workflows = await workflowsRes.json();
        for (const wf of workflows) {
          const nodeIds = [];
          for (const role of Object.values(wf.runtime || {})) {
            if (!role.nodeId) continue;
            nodeIds.push(role.nodeId);
            if (role.nodeId === nodeId) ownWorkflowId = wf.id;
          }
          workflowNodes.set(wf.id, { label: wf.definition?.title || wf.name || wf.id, nodeIds });
        }
      }
      return { senderNodeId, groupTree, workflowNodes, ownWorkflowId };
    };

    // Menübaum aus Gruppenbaum + Workflows. Ein Eintrag: { key, label,
    // folders: [Eintrag], senders: [Input], own }. Leere Zweige entfallen.
    const buildMenu = (inputs, ctx) => {
      const { senderNodeId, groupTree, workflowNodes, ownWorkflowId } = ctx;
      const byNode = new Map();
      const unresolved = [];
      for (const input of inputs) {
        const nId = senderNodeId.get(input.senderId);
        if (!nId) { unresolved.push(input); continue; }
        if (!byNode.has(nId)) byNode.set(nId, []);
        byNode.get(nId).push(input);
      }
      const used = new Set();
      const sendersOf = (nodeIds) => {
        const list = [];
        for (const id of nodeIds) for (const input of byNode.get(id) || []) { list.push(input); used.add(input.senderId); }
        return list;
      };
      const count = (e) => e.senders.length + e.folders.reduce((n, f) => n + f.count, 0);
      const finish = (e) => { e.count = count(e); return e; };

      let ownGroupId = null;
      for (const g of Object.values(groupTree)) if ((g.nodeIds || []).includes(nodeId)) ownGroupId = g.id;
      const groupEntry = (gid, seen) => {
        const g = groupTree[gid];
        if (!g || seen.has(gid)) return null;
        seen.add(gid);
        const folders = (g.groupIds || []).map((c) => groupEntry(c, seen)).filter((f) => f && f.count > 0);
        const e = finish({ key: `g:${gid}`, label: g.label || gid, folders, senders: sendersOf(g.nodeIds || []), own: false });
        // Eigener Zweig: enthält den Switcher selbst (direkt oder darunter).
        e.own = gid === ownGroupId || folders.some((f) => f.own);
        e.workflowId = g.workflowId;
        return e;
      };
      const seen = new Set();
      const roots = [];
      for (const g of Object.values(groupTree)) {
        if (g.parentId !== null && g.parentId !== undefined && groupTree[g.parentId]) continue;
        const e = groupEntry(g.id, seen);
        if (e && e.count > 0) roots.push(e);
      }
      const referenced = new Set(Object.values(groupTree).map((g) => g.workflowId).filter(Boolean));
      for (const [wfId, wf] of workflowNodes) {
        if (referenced.has(wfId)) continue;
        const e = finish({ key: `w:${wfId}`, label: wf.label, folders: [], senders: sendersOf(wf.nodeIds), own: wfId === ownWorkflowId });
        if (e.count > 0) roots.push(e);
      }
      const other = inputs.filter((i) => !used.has(i.senderId));
      const rest = finish({ key: "o:", label: T("otherSources"), folders: [], senders: other, own: false });
      if (rest.count > 0) roots.push(rest);
      roots.sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0));

      // Optional nur der eigene Zweig (Gruppe bzw. Workflow des Switchers).
      let scopeEntry = null;
      if (scopeOwn) {
        const find = (list) => {
          for (const e of list) {
            if (e.key === `g:${ownGroupId}`) return e;
            const inner = find(e.folders);
            if (inner) return inner;
          }
          return null;
        };
        scopeEntry = (ownGroupId && find(roots)) || roots.find((e) => e.key === `w:${ownWorkflowId}`) || null;
      }
      return scopeEntry ?? { key: "", label: T("sources"), folders: roots, senders: [], count: inputs.length };
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

    // Bugfund 2026-09-28 Teil 2 (identisch zu omp-video-mixer-me, gleiche
    // Ursache — dort ausführlich dokumentiert): live per Pixel-genauem
    // Sampling bestätigt, dass ein direktes `img.src = neueURL` kurz
    // durch `complete=false`/`naturalWidth=0` läuft (Netzwerk-Ladezeit),
    // NICHT durchgehend das alte Bild zeigt — die schwarze `.thumb`-
    // Hintergrundfarbe scheint in diesem Moment durch. Server setzt
    // bewusst `Cache-Control: no-store`, ein "vorab laden, dieselbe URL
    // zuweisen"-Trick löst deshalb einen zweiten echten Roundtrip aus.
    // Fix: als Blob laden + Object-URL zuweisen (keine Netzwerk-Wartezeit
    // mehr beim Zuweisen). `img._previewToken` verhindert, dass eine
    // ältere, langsamere Anfrage eine bereits fertige neuere überschreibt.
    const loadPreviewImage = async (img, noSignal, url) => {
      const token = (img._previewToken = (img._previewToken || 0) + 1);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (img._previewToken !== token) return;
        const objectUrl = URL.createObjectURL(blob);
        const oldObjectUrl = img.dataset.blobUrl;
        img.src = objectUrl;
        img.dataset.blobUrl = objectUrl;
        img.style.display = "";
        noSignal.style.display = "none";
        if (oldObjectUrl) URL.revokeObjectURL(oldObjectUrl);
      } catch {
        if (img._previewToken !== token) return;
        img.style.display = "none";
        noSignal.style.display = "";
      }
    };

    // Formatabweichung (Nutzerwunsch 2026-09-30): Warnsymbol + Tooltip.
    const shownLabel = (input) => (input.mismatch ? `⚠ ${input.label}` : input.label);
    const setMismatchTitle = (btn, input) => {
      if (input.mismatch) btn.title = T("mismatch", { format: input.format || "?", own: input.ownFormat || "?" });
      else btn.removeAttribute("title");
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
          img.style.display = "none"; // erst sichtbar, sobald das erste Bild wirklich geladen ist
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = T("noPicture");
          // `.hidden` toggeln reicht hier NICHT: `.thumb .no-signal {
          // display:flex; }` (Klassen-Selektor) überstimmt die UA-Regel
          // `[hidden]{display:none}` (Attribut-Selektor) immer. Inline
          // `style.display` hat Spezifität 1000 und schlägt jede externe
          // Regel zuverlässig.
          noSignal.style.display = "none";
          void loadPreviewImage(img, noSignal, previewSnapshotUrl(sourceNodeId));
          thumb.append(img, noSignal);
        } else {
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = T("noPicture");
          thumb.append(noSignal);
        }
        const label = document.createElement("div");
        label.className = "thumb-label";
        label.textContent = shownLabel(input);
        btn.append(thumb, label);
        setMismatchTitle(btn, input);
      } else {
        btn.textContent = shownLabel(input);
        setMismatchTitle(btn, input);
      }
      return btn;
    };

    // Bugliste 2026-09-25 Nachtrag ("Thumbnail-Flicker", s. gleiches
    // Muster in omp-video-mixer-me/ui/bundle.js#updateBusButton):
    // aktualisiert einen bereits vorhandenen Knopf statt ihn (und damit
    // sein `<img>`) neu zu erzeugen. Bild-Neuladen selbst läuft über
    // `loadPreviewImage` oben (s. dortige Doku für den 2026-09-28
    // gefundenen zweiten Teil desselben Symptoms).
    const updateInputButton = (btn, input, sourceNodeId) => {
      if (thumbsEnabled) {
        const img = btn.querySelector("img");
        const noSignal = btn.querySelector(".no-signal");
        if (img && noSignal && sourceNodeId) void loadPreviewImage(img, noSignal, previewSnapshotUrl(sourceNodeId));
        const label = btn.querySelector(".thumb-label");
        if (label) label.textContent = shownLabel(input);
        setMismatchTitle(btn, input);
      } else {
        btn.textContent = shownLabel(input);
        setMismatchTitle(btn, input);
      }
      return btn;
    };

    const refresh = async () => {
      if (document.hidden) return; // im Hintergrund-Tab nichts pollen
      const [inputsRes, activeRes, ctx] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/activeInput`),
        senderWorkflowLabel(),
      ]);
      if (!inputsRes.ok || !activeRes.ok) return;
      const { senderNodeId } = ctx;
      const inputs = (await inputsRes.json()).value || [];
      const active = (await activeRes.json()).value || "";

      // Menü-Ebene auflösen: navPath von der (ggf. eingegrenzten) Wurzel
      // aus abgehen; verschwundene Schlüssel kappen den Pfad.
      const menuRoot = buildMenu(inputs, ctx);
      const trail = [menuRoot];
      for (const key of navPath) {
        const next = trail[trail.length - 1].folders.find((f) => f.key === key);
        if (!next) break;
        trail.push(next);
      }
      if (trail.length - 1 !== navPath.length) {
        navPath = trail.slice(1).map((e) => e.key);
        localStorage.setItem(NAV_KEY, JSON.stringify(navPath));
      }
      const level = trail[trail.length - 1];
      const hasActive = (e) => e.senders.some((i) => i.senderId === active) || e.folders.some(hasActive);

      // Bestehende Quellen-Knöpfe per `senderId` einsammeln, BEVOR sie
      // entfernt werden — wiederverwendbare Kandidaten für unten, statt
      // eines pauschalen `buttons.innerHTML = ""`, das jedes Mal auch noch
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
        blackBtn.textContent = T("black");
        blackBtn.setAttribute("color", "onair");
        blackBtn.addEventListener("click", () => select(""));
        return blackBtn;
      }, false, undefined, (btn) => btn).active = active === "";

      // Zurück-/Breadcrumb-Zeile (nur unterhalb der Wurzel).
      if (trail.length > 1) {
        const row = document.createElement("div");
        row.className = "navrow";
        const back = document.createElement("omp-button");
        back.className = "folder";
        back.textContent = `◂ ${T("back")}`;
        back.addEventListener("click", () => setNavPath(navPath.slice(0, -1)));
        const crumb = document.createElement("span");
        crumb.className = "crumb";
        crumb.textContent = trail.map((e, i) => (i === 0 && !e.key ? T("sources") : e.label)).join(" › ");
        row.append(back, crumb);
        fragment.append(row);
      }

      for (const folder of level.folders) {
        const btn = document.createElement("omp-button");
        btn.className = "folder";
        btn.textContent = `${hasActive(folder) ? "● " : ""}▸ ${folder.label} (${folder.count})`;
        btn.addEventListener("click", () => setNavPath([...navPath, folder.key]));
        fragment.append(btn);
      }

      for (const input of level.senders) {
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

      if (inputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = T("noSources");
        fragment.append(empty);
      }

      buttons.append(fragment);

      // Übrig gebliebene, NICHT wiederverwendete Knöpfe geben ihre
      // Object-URL frei (s. `loadPreviewImage` oben) — sonst häuft sich
      // über eine lange Sitzung mit wechselnden Quellen ungenutzter
      // Blob-Speicher an.
      for (const orphan of existingButtons.values()) {
        const blobUrl = orphan.querySelector("img")?.dataset.blobUrl;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
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
