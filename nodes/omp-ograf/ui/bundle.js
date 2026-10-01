// Node-UI-Bundle von omp-ograf (ARCHITECTURE.md §4.5, gleiches Muster wie
// omp-video-mixer-me/omp-switcher, s. dortige uibundle.rs-Doku): das
// generische, aus dem Descriptor erzeugte Panel kann `templates` (ein
// JSON-Array von {id,label,stepCount,schema}) nicht sinnvoll darstellen
// (v0-Descriptor-Schema kennt keinen Array-Typ, `main.rs` deklariert es
// pragmatisch als String wie bei den anderen Nodes dieser Art) — das
// readonly-Feld landete im generischen Panel bisher als `String(value)`
// auf dem Wert eines Objekt-Arrays, sichtbar als "[object Object]"
// (gemeldeter Bug). Ersetzt das komplett durch einen echten, aus dem
// realen EBU-OGraf-JSON-Schema (`schema.properties`) generierten
// Template-Picker + Editor — Look&Feel/Funktionsumfang angelehnt an
// PIPELINE CONTROLLERs "oGraf"-Panel (Template-Suche, Dropdown,
// schema-getriebenes Formular, Ein/Aus), aber DOM-API statt
// HTML-String-Interpolation (keine manuelle Attribut-Escaping-Fummelei)
// und ohne die dortigen playlist-spezifischen {{…}}-Variablen (kein
// Playlist-Konzept in OMP).
//
// Mehrere Ebenen (Nutzerwunsch 2026-10-01, wie in PIPELINE CONTROLLER):
// oben die Liste der gerade on air stehenden Grafiken (Klick öffnet sie im
// Editor darunter, dort Live-Update, Weiter und Aus), "Weiter" erscheint nur
// bei Templates mit mehreren Schritten (stepCount > 1). Pro Template gibt es
// eine Ebene (Ebenen-ID = Template-ID), mehrere verschiedene Templates
// stehen gleichzeitig on air.
class OmpOgrafPanel extends HTMLElement {
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
      .search {
        width: 100%; box-sizing: border-box; height: 26px; font-size: 11px;
        border-radius: 4px; margin-bottom: 6px; padding: 0 6px;
        background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed);
        border: 1px solid var(--omp-border, #2e3338);
      }
      select.tpl-select {
        width: 100%; box-sizing: border-box; height: 26px; font-size: 11px;
        border-radius: 4px; margin-bottom: 8px;
        background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed);
        border: 1px solid var(--omp-border, #2e3338);
      }
      .fields { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
      .field-row { display: flex; align-items: center; gap: 6px; }
      .field-label {
        width: 84px; flex-shrink: 0; font-size: var(--omp-font-size-xs, 11px);
        color: var(--omp-text-dim, #9aa0a6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .field-row input[type="text"], .field-row input[type="number"], .field-row select, .field-row textarea {
        flex: 1; min-width: 0; box-sizing: border-box; font-size: 11px; border-radius: 4px;
        background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed);
        border: 1px solid var(--omp-border, #2e3338); padding: 3px 5px;
      }
      .field-row input[type="color"] {
        flex: 1; height: 22px; padding: 0 2px; border-radius: 4px; border: 1px solid var(--omp-border, #2e3338);
        background: var(--omp-bg-2, #1c1f22);
      }
      .field-row textarea { font-family: var(--omp-mono, monospace); resize: vertical; }
      .field-row input[type="checkbox"] { width: 16px; height: 16px; }
      .actions { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
      .actions omp-button { flex: 1; height: 30px; min-width: 64px; }
      .onair { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
      .onair-title { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); margin-bottom: 2px; }
      .layer-row {
        display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; cursor: pointer;
        background: var(--omp-bg-2, #1c1f22); border: 1px solid var(--omp-border, #2e3338);
      }
      .layer-row.selected { border-color: var(--omp-onair, #34a853); }
      .layer-row .dot { width: 8px; height: 8px; border-radius: 50%; background: #34a853; flex-shrink: 0; }
      .layer-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .layer-row .step { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); }
      .layer-row button {
        border: 1px solid var(--omp-border, #2e3338); background: transparent; color: var(--omp-text, #e8eaed);
        border-radius: 4px; cursor: pointer; font-size: 11px; padding: 1px 6px;
      }
      .status { display: flex; align-items: center; gap: 6px; font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); }
      .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--omp-border, #2e3338); flex-shrink: 0; }
      .status .dot.live { background: #34a853; }
      p.empty { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); margin: 4px 0 0; }
    `;

    const search = document.createElement("input");
    search.type = "text";
    search.className = "search";
    search.placeholder = "Template suchen…";

    const select = document.createElement("select");
    select.className = "tpl-select";

    const fields = document.createElement("div");
    fields.className = "fields";

    const showBtn = document.createElement("omp-button");
    showBtn.textContent = "▶ Ein";
    showBtn.setAttribute("color", "onair");
    const updateBtn = document.createElement("omp-button");
    updateBtn.textContent = "Update";
    updateBtn.title = "Geänderte Felder live in die laufende Grafik übernehmen";
    // Nur sichtbar bei Templates mit mehreren Schritten.
    const continueBtn = document.createElement("omp-button");
    continueBtn.textContent = "Weiter";
    continueBtn.style.display = "none";
    const hideBtn = document.createElement("omp-button");
    hideBtn.textContent = "■ Aus";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(showBtn, updateBtn, continueBtn, hideBtn);

    const onair = document.createElement("div");
    onair.className = "onair";

    const status = document.createElement("div");
    status.className = "status";
    const statusDot = document.createElement("span");
    statusDot.className = "dot";
    const statusText = document.createElement("span");
    statusText.textContent = "Aus";
    status.append(statusDot, statusText);

    const section = document.createElement("omp-panel-section");
    section.setAttribute("label", "OGraf Grafik");
    section.append(onair, search, select, fields, actions, status);

    shadow.append(style, section);

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(refresh);

    let templates = [];
    // Alle on-air stehenden Ebenen (Param "layers"); Ebenen-ID = Template-ID.
    let layers = [];
    const layerOf = (templateId) => layers.find((l) => l.id === templateId) || null;

    // Property-Key -> {el, type, gddType}, für Show/Hide-Auslesen ohne
    // erneute Schema-Suche (gleiches Muster wie PIPELINE CONTROLLERs
    // grafikShow: Werte werden erst beim Klick aus den echten DOM-
    // Elementen gelesen, nicht separat mitgeführt — vermeidet
    // Sync-Bugs zwischen zwei Kopien desselben Zustands).
    let activeFieldEls = new Map();

    const selectedTemplate = () => templates.find((t) => t.id === select.value) || null;

    function buildFieldRow(key, prop) {
      const row = document.createElement("div");
      row.className = "field-row";
      const label = document.createElement("span");
      label.className = "field-label";
      label.textContent = prop.title || key;
      label.title = prop.description || key;
      row.appendChild(label);

      const gddType = prop.gddType;
      const hasEnum = Array.isArray(prop.enum) && prop.enum.length > 0;
      let input;

      if (hasEnum) {
        input = document.createElement("select");
        const labels = prop.enumNames;
        prop.enum.forEach((v, i) => {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = (labels && labels[i]) || v;
          input.appendChild(opt);
        });
        input.value = prop.default ?? prop.enum[0];
      } else if (gddType === "color-rrggbb") {
        input = document.createElement("input");
        input.type = "color";
        input.value = prop.default || "#000000";
      } else if (prop.type === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!prop.default;
      } else if (prop.type === "integer" || prop.type === "number") {
        input = document.createElement("input");
        input.type = "number";
        if (prop.type === "integer") input.step = "1";
        if (typeof prop.minimum === "number") input.min = String(prop.minimum);
        if (typeof prop.maximum === "number") input.max = String(prop.maximum);
        input.value = prop.default ?? "";
      } else if (prop.type === "array" || prop.type === "object") {
        input = document.createElement("textarea");
        input.rows = 3;
        input.value = JSON.stringify(prop.default ?? (prop.type === "array" ? [] : {}), null, 2);
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = prop.default ?? "";
      }
      row.appendChild(input);
      activeFieldEls.set(key, { el: input, type: prop.type, gddType });
      return row;
    }

    function renderFields(tpl) {
      fields.innerHTML = "";
      activeFieldEls = new Map();
      if (!tpl) return;
      const props = (tpl.schema && tpl.schema.properties) || {};
      for (const [key, prop] of Object.entries(props)) {
        fields.appendChild(buildFieldRow(key, prop));
      }
    }

    function readFieldData() {
      const data = {};
      for (const [key, { el, type }] of activeFieldEls) {
        if (type === "boolean") data[key] = el.checked;
        else if (type === "integer" || type === "number") {
          const n = Number(el.value);
          data[key] = Number.isNaN(n) ? el.value : n;
        } else if (type === "array" || type === "object") {
          try {
            data[key] = JSON.parse(el.value);
          } catch {
            data[key] = el.value;
          }
        } else data[key] = el.value;
      }
      return data;
    }

    // Feldwerte aus gespeicherten Ebenen-Daten setzen (Editor öffnen).
    function applyFieldData(data) {
      for (const [key, { el, type }] of activeFieldEls) {
        if (!data || !(key in data)) continue;
        const v = data[key];
        if (type === "boolean") el.checked = !!v;
        else if (type === "array" || type === "object") el.value = JSON.stringify(v, null, 2);
        else el.value = v ?? "";
      }
    }

    // Ist das gewählte Template on air, zeigt der Editor dessen laufende Daten.
    function loadSelected() {
      const tpl = selectedTemplate();
      renderFields(tpl);
      const layer = tpl ? layerOf(tpl.id) : null;
      if (layer) applyFieldData(layer.data);
      renderControls();
    }

    select.addEventListener("change", loadSelected);

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const keep = select.value;
      select.innerHTML = "";
      for (const t of templates) {
        if (q && !t.label.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) continue;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = layerOf(t.id) ? `● ${t.label}` : t.label;
        select.appendChild(opt);
      }
      if ([...select.options].some((o) => o.value === keep)) select.value = keep;
      else loadSelected();
    });

    showBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (!tpl) return;
      call("show", { templateId: tpl.id, data: readFieldData() });
    });
    updateBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (!tpl || !layerOf(tpl.id)) return;
      call("update", { layerId: tpl.id, data: readFieldData() });
    });
    continueBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (tpl && layerOf(tpl.id)) call("continue", { layerId: tpl.id });
    });
    hideBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (tpl && layerOf(tpl.id)) call("hide", { layerId: tpl.id });
    });

    // Knöpfe je nach Zustand des gewählten Templates: Ein nur wenn nicht on
    // air; Update/Aus nur wenn on air; Weiter nur bei mehrstufigen Templates.
    function renderControls() {
      const tpl = selectedTemplate();
      const layer = tpl ? layerOf(tpl.id) : null;
      showBtn.disabled = !tpl || !!layer;
      updateBtn.disabled = !layer;
      hideBtn.disabled = !layer;
      const multi = !!tpl && (tpl.stepCount ?? 1) > 1;
      continueBtn.style.display = multi ? "" : "none";
      continueBtn.disabled = !layer || !layer.canContinue;
      continueBtn.textContent = layer && multi ? "Weiter " + (layer.step + 1) + "/" + layer.stepCount : "Weiter";
    }

    // On-Air-Liste: Klick auf eine Zeile öffnet die Grafik im Editor.
    function renderOnAir() {
      const key = JSON.stringify(layers.map((l) => [l.id, l.step, l.stepCount]));
      if (onair.dataset.key === key + "|" + select.value) return;
      onair.dataset.key = key + "|" + select.value;
      onair.innerHTML = "";
      if (layers.length === 0) return;
      const title = document.createElement("div");
      title.className = "onair-title";
      title.textContent = "Auf Sendung (" + layers.length + ")";
      onair.appendChild(title);
      for (const l of layers) {
        const row = document.createElement("div");
        row.className = "layer-row" + (l.id === select.value ? " selected" : "");
        row.title = "Klick: im Editor öffnen (Live-Update)";
        const dot = document.createElement("span");
        dot.className = "dot";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = l.label;
        row.append(dot, name);
        if (l.stepCount > 1) {
          const st = document.createElement("span");
          st.className = "step";
          st.textContent = "Schritt " + (l.step + 1) + "/" + l.stepCount;
          row.appendChild(st);
        }
        const off = document.createElement("button");
        off.textContent = "■";
        off.title = "Diese Grafik ausblenden";
        off.addEventListener("click", (ev) => {
          ev.stopPropagation();
          call("hide", { layerId: l.id });
        });
        row.appendChild(off);
        row.addEventListener("click", () => {
          if (![...select.options].some((o) => o.value === l.templateId)) {
            search.value = "";
          }
          select.value = l.templateId;
          loadSelected();
          renderOnAir();
        });
        onair.appendChild(row);
      }
    }

    const refresh = async () => {
      const [templatesRes, layersRes] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/templates`),
        fetch(`/api/v1/nodes/${nodeId}/params/layers`),
      ]);
      if (!templatesRes.ok) return;
      templates = (await templatesRes.json()).value || [];
      layers = layersRes.ok ? (await layersRes.json()).value || [] : [];

      // Optionen nur neu bauen, wenn sich Template-Liste oder On-Air-
      // Status tatsächlich geändert haben (sonst würde ein offenes
      // Dropdown bei jedem 2s-Poll unter dem Cursor zuklappen — gleiches
      // Muster wie omp-video-mixer-me/ui/bundle.js#keyerSourceSelect).
      const onAirIds = layers.map((l) => l.id);
      const optionsKey = JSON.stringify({ ids: templates.map((t) => t.id), onAirIds });
      if (select.dataset.optionsKey !== optionsKey) {
        select.dataset.optionsKey = optionsKey;
        const keep = select.value;
        select.innerHTML = "";
        if (templates.length === 0) {
          const empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "keine Templates gefunden";
          select.appendChild(empty);
        }
        for (const t of templates) {
          const opt = document.createElement("option");
          opt.value = t.id;
          opt.textContent = onAirIds.includes(t.id) ? `● ${t.label}` : t.label;
          select.appendChild(opt);
        }
        if ([...select.options].some((o) => o.value === keep)) {
          select.value = keep;
          // Wurde die Grafik gerade erst gezeigt oder ausgeblendet, passen
          // nur die Knöpfe an — die Felder gehören dem Bediener.
        } else {
          loadSelected();
        }
      }

      const isLive = layers.length > 0;
      statusDot.className = isLive ? "dot live" : "dot";
      statusText.textContent = isLive ? "On Air: " + layers.map((l) => l.label).join(", ") : "Aus";
      renderControls();
      renderOnAir();
    };

    refresh();
    this._interval = setInterval(refresh, 2000);

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
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    if (this._es) this._es.close();
  }
}

if (!customElements.get("omp-ograf-panel")) {
  customElements.define("omp-ograf-panel", OmpOgrafPanel);
}
