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
// Bewusst NICHT übernommen: PIPELINE CONTROLLERs "Continue"/"Update"-
// Knöpfe (mehrstufige Templates live weiterschalten bzw. Daten
// nachträglich aktualisieren) — omp-ograf hat serverseitig aktuell nur
// `show`/`hide` (main.rs), kein `continue`/`update`. Wäre eine
// eigenständige Backend-Erweiterung, kein UI-only-Fix.
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
      .actions { display: flex; gap: 6px; margin-bottom: 6px; }
      .actions omp-button { flex: 1; height: 30px; }
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
    const hideBtn = document.createElement("omp-button");
    hideBtn.textContent = "■ Aus";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(showBtn, hideBtn);

    const status = document.createElement("div");
    status.className = "status";
    const statusDot = document.createElement("span");
    statusDot.className = "dot";
    const statusText = document.createElement("span");
    statusText.textContent = "Aus";
    status.append(statusDot, statusText);

    const section = document.createElement("omp-panel-section");
    section.setAttribute("label", "OGraf Grafik");
    section.append(search, select, fields, actions, status);

    shadow.append(style, section);

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(refresh);

    let templates = [];
    let current = null;

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

    select.addEventListener("change", () => renderFields(selectedTemplate()));

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const keep = select.value;
      select.innerHTML = "";
      for (const t of templates) {
        if (q && !t.label.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) continue;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.id === current ? `● ${t.label}` : t.label;
        select.appendChild(opt);
      }
      if ([...select.options].some((o) => o.value === keep)) select.value = keep;
      else renderFields(selectedTemplate());
    });

    showBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (!tpl) return;
      call("show", { templateId: tpl.id, data: readFieldData() });
    });
    hideBtn.addEventListener("click", () => call("hide", {}));

    const refresh = async () => {
      const [templatesRes, currentRes] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/templates`),
        fetch(`/api/v1/nodes/${nodeId}/params/current`),
      ]);
      if (!templatesRes.ok) return;
      templates = (await templatesRes.json()).value || [];
      current = currentRes.ok ? (await currentRes.json()).value || null : null;

      // Optionen nur neu bauen, wenn sich Template-Liste oder On-Air-
      // Status tatsächlich geändert haben (sonst würde ein offenes
      // Dropdown bei jedem 2s-Poll unter dem Cursor zuklappen — gleiches
      // Muster wie omp-video-mixer-me/ui/bundle.js#keyerSourceSelect).
      const optionsKey = JSON.stringify({ ids: templates.map((t) => t.id), current });
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
          opt.textContent = t.id === current ? `● ${t.label}` : t.label;
          select.appendChild(opt);
        }
        if ([...select.options].some((o) => o.value === keep)) {
          select.value = keep;
        } else {
          renderFields(selectedTemplate());
        }
      }

      const isLive = !!current;
      statusDot.className = isLive ? "dot live" : "dot";
      const liveTpl = isLive ? templates.find((t) => t.id === current) : null;
      statusText.textContent = isLive ? `On Air: ${liveTpl ? liveTpl.label : current}` : "Aus";
      hideBtn.disabled = !isLive;
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
