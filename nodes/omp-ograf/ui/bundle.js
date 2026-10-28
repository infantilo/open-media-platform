// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
        "x.onair": "● On Air",
        "x.step": " · Schritt ",
        "x.off": "○ Aus",
        "ogr.c25756": "Template suchen…",
        "ogr.069330": "Update",
        "ogr.83988d": "Geänderte Felder live in die laufende Grafik übernehmen",
        "ogr.c39838": "Weiter",
        "ogr.9090e4": "Steuerung",
        "ogr.25406b": "Auf Sendung / Vorlage",
        "ogr.344a7f": "Editor",
        "ogr.98b54b": "keine Vorlage gewählt",
        "ogr.79eed3": "Auf Sendung (",
        "ogr.25b279": "Klick: im Editor öffnen (Live-Update)",
        "ogr.398d8a": "Schritt ",
        "ogr.419ff4": "Diese Grafik ausblenden",
        "ogr.e8bc14": "keine Templates gefunden",
        "kv.text": "Text", "kv.number": "Zahl", "kv.bool": "Ja/Nein", "kv.list": "Liste", "kv.object": "Gruppe",
        "kv.remove": "Entfernen", "kv.addItem": "＋ Eintrag", "kv.addField": "＋ Feld", "kv.name": "Name"
    },
    en: {
        "x.onair": "● On air",
        "x.step": " · step ",
        "x.off": "○ Off",
        "ogr.c25756": "Search template…",
        "ogr.069330": "Update",
        "ogr.83988d": "Apply changed fields live to the running graphic",
        "ogr.c39838": "Next",
        "ogr.9090e4": "Control",
        "ogr.25406b": "On air / template",
        "ogr.344a7f": "Editor",
        "ogr.98b54b": "no template chosen",
        "ogr.79eed3": "On air (",
        "ogr.25b279": "Click: open in the editor (live update)",
        "ogr.398d8a": "Step ",
        "ogr.419ff4": "Hide this graphic",
        "ogr.e8bc14": "no templates found",
        "kv.text": "Text", "kv.number": "Number", "kv.bool": "Yes/No", "kv.list": "List", "kv.object": "Group",
        "kv.remove": "Remove", "kv.addItem": "＋ Item", "kv.addField": "＋ Field", "kv.name": "Name"
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();
const LOCALE = document.documentElement.lang === "en" ? "en-GB" : "de-DE";

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
      /* Steuerung: feste Geometrie, damit die Knöpfe im Live-Betrieb NIE ihre
         Position ändern — vier gleich breite Spalten, feste Höhe, und der
         Weiter-Knopf behält auch bei einstufigen Templates seinen Platz
         (dann nur unsichtbar). Die Steuerung steht ganz oben, der Editor
         (variable Höhe) darunter. */
      .actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 6px; }
      .actions omp-button { height: 34px; min-width: 0; }
      .ctl-target {
        display: flex; align-items: center; gap: 6px; height: 22px; margin-bottom: 6px; overflow: hidden;
        font-size: var(--omp-font-size-sm, 12px); white-space: nowrap;
      }
      .ctl-target .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
      .ctl-target .badge { flex-shrink: 0; font-size: var(--omp-font-size-xs, 11px); padding: 1px 6px; border-radius: 8px;
        border: 1px solid var(--omp-border, #2e3338); color: var(--omp-text-dim, #9aa0a6); }
      .status { min-width: 0; height: 18px; overflow: hidden; }
      .status span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .actions omp-button { white-space: nowrap; }
      .ctl-target .badge.live { border-color: #34a853; color: #34a853; }
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
    search.placeholder = T("ogr.c25756");

    const select = document.createElement("select");
    select.className = "tpl-select";

    const fields = document.createElement("div");
    fields.className = "fields";

    const showBtn = document.createElement("omp-button");
    showBtn.textContent = "▶ Ein";
    showBtn.setAttribute("color", "onair");
    const updateBtn = document.createElement("omp-button");
    updateBtn.textContent = T("ogr.069330");
    updateBtn.title = T("ogr.83988d");
    // Nur sichtbar bei Templates mit mehreren Schritten.
    const continueBtn = document.createElement("omp-button");
    continueBtn.textContent = T("ogr.c39838");
    continueBtn.style.visibility = "hidden";
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

    // Welche Grafik die Knöpfe gerade steuern, und ob sie on air ist.
    const target = document.createElement("div");
    target.className = "ctl-target";
    const targetName = document.createElement("span");
    targetName.className = "name";
    const targetBadge = document.createElement("span");
    targetBadge.className = "badge";
    target.append(targetName, targetBadge);

    // Drei Teile: Steuerung (fest, oben), Auswahl (On-Air-Liste + Vorlage),
    // Editor (Felder, variable Höhe).
    const controlSection = document.createElement("omp-panel-section");
    controlSection.setAttribute("label", T("ogr.9090e4"));
    controlSection.append(target, actions, status);

    const pickSection = document.createElement("omp-panel-section");
    pickSection.setAttribute("label", T("ogr.25406b"));
    pickSection.append(onair, search, select);

    const editSection = document.createElement("omp-panel-section");
    editSection.setAttribute("label", T("ogr.344a7f"));
    editSection.append(fields);

    shadow.append(style, controlSection, pickSection, editSection);

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

    // Strukturierter Editor für Listen/Objekte (statt JSON-Text): folgt dem Schema (properties/items), ohne Schema allgemeine
    // Felder (Name, Typ, Wert). `get()` liefert den Wert, `set(v)` füllt den Editor — die Werte leben in den Feldern selbst.
    const KINDS = ["text", "number", "bool", "list", "object"];
    const kindOf = (v) => (Array.isArray(v) ? "list" : v !== null && typeof v === "object" ? "object" : typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "text");
    const smallBtn = (label, title, onclick) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title || ""; b.addEventListener("click", onclick);
      b.style.cssText = "cursor:pointer;font-size:11px;padding:1px 6px;border-radius:3px;border:1px solid var(--omp-border,#2e3338);background:var(--omp-bg-2,#1c1f22);color:var(--omp-text,#e8eaed);";
      return b;
    };
    function makeEditor(schema, initial) {
      const sc = schema || {};
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;";
      const type = sc.type || (sc.properties ? "object" : sc.items ? "array" : null);
      if (Array.isArray(sc.enum) && sc.enum.length) {
        const sel = document.createElement("select");
        sc.enum.forEach((v, i) => { const o = document.createElement("option"); o.value = v; o.textContent = (sc.enumNames && sc.enumNames[i]) || v; sel.appendChild(o); });
        sel.value = initial ?? sc.default ?? sc.enum[0];
        wrap.appendChild(sel);
        return { el: wrap, get: () => (type === "integer" || type === "number" ? Number(sel.value) : sel.value), set: (v) => { sel.value = v ?? sc.enum[0]; } };
      }
      if (type === "boolean") {
        const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!(initial ?? sc.default);
        wrap.appendChild(c);
        return { el: wrap, get: () => c.checked, set: (v) => { c.checked = !!v; } };
      }
      if (type === "integer" || type === "number") {
        const n = document.createElement("input"); n.type = "number"; n.step = type === "integer" ? "1" : "any";
        if (typeof sc.minimum === "number") n.min = String(sc.minimum);
        if (typeof sc.maximum === "number") n.max = String(sc.maximum);
        n.value = initial ?? sc.default ?? "";
        wrap.appendChild(n);
        return { el: wrap, get: () => (n.value === "" ? 0 : Number(n.value)), set: (v) => { n.value = v ?? ""; } };
      }
      if (type === "string") {
        const t = document.createElement("input"); t.type = "text"; t.value = initial ?? sc.default ?? "";
        wrap.appendChild(t);
        return { el: wrap, get: () => t.value, set: (v) => { t.value = v ?? ""; } };
      }
      if (type === "array") {
        const rows = [];
        const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:3px;";
        const addRow = (v) => {
          const row = document.createElement("div"); row.style.cssText = "display:flex;gap:4px;align-items:flex-start;";
          const ed = makeEditor(sc.items || null, v);
          const rec = { row, ed };
          row.appendChild(ed.el);
          row.appendChild(smallBtn("✕", T("kv.remove"), () => { rows.splice(rows.indexOf(rec), 1); row.remove(); }));
          rows.push(rec); list.appendChild(row);
        };
        const set = (arr) => { rows.length = 0; list.innerHTML = ""; (Array.isArray(arr) ? arr : []).forEach(addRow); };
        wrap.append(list, smallBtn(T("kv.addItem"), "", () => addRow(undefined)));
        set(initial ?? sc.default ?? []);
        return { el: wrap, get: () => rows.map((r) => r.ed.get()), set };
      }
      if (type === "object" && sc.properties) {
        const parts = [];
        const box = document.createElement("div"); box.style.cssText = "display:flex;flex-direction:column;gap:3px;border-left:2px solid var(--omp-border,#2e3338);padding-left:6px;";
        for (const [k, p] of Object.entries(sc.properties)) {
          const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:flex-start;";
          const lab = document.createElement("span"); lab.className = "field-label"; lab.textContent = (p && p.title) || k; lab.title = (p && p.description) || k;
          const ed = makeEditor(p, initial && initial[k]);
          row.append(lab, ed.el); box.appendChild(row); parts.push([k, ed]);
        }
        wrap.appendChild(box);
        return { el: wrap, get: () => Object.fromEntries(parts.map(([k, ed]) => [k, ed.get()])), set: (v) => parts.forEach(([k, ed]) => ed.set(v ? v[k] : undefined)) };
      }
      // Ohne Schema (frei): Felder bzw. Einträge mit Typwahl
      return makeFreeEditor(type === "array" ? "list" : "object", initial);
    }
    function makeFreeValue(kind, v) {
      if (kind === "number") { const n = document.createElement("input"); n.type = "number"; n.step = "any"; n.value = v ?? 0; return { el: n, get: () => Number(n.value || 0), set: (x) => { n.value = x ?? 0; } }; }
      if (kind === "bool") { const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!v; return { el: c, get: () => c.checked, set: (x) => { c.checked = !!x; } }; }
      if (kind === "list" || kind === "object") return makeFreeEditor(kind, v);
      const t = document.createElement("input"); t.type = "text"; t.value = v ?? ""; return { el: t, get: () => t.value, set: (x) => { t.value = x ?? ""; } };
    }
    function makeFreeEditor(kind, initial) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;border-left:2px solid var(--omp-border,#2e3338);padding-left:6px;";
      const rows = [];
      const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:3px;";
      const addRow = (name, v) => {
        const row = document.createElement("div"); row.style.cssText = "display:flex;gap:4px;align-items:flex-start;";
        let nameIn = null;
        if (kind === "object") { nameIn = document.createElement("input"); nameIn.type = "text"; nameIn.placeholder = T("kv.name"); nameIn.value = name; nameIn.style.cssText = "width:30%;"; row.appendChild(nameIn); }
        const sel = document.createElement("select");
        KINDS.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = T(`kv.${k}`); sel.appendChild(o); });
        sel.value = kindOf(v);
        const rec = { row, nameIn, sel, val: makeFreeValue(sel.value, v) };
        const slot = document.createElement("div"); slot.style.cssText = "flex:1;min-width:0;display:flex;"; slot.appendChild(rec.val.el);
        sel.addEventListener("change", () => { rec.val = makeFreeValue(sel.value, undefined); slot.replaceChildren(rec.val.el); });
        row.append(sel, slot, smallBtn("✕", T("kv.remove"), () => { rows.splice(rows.indexOf(rec), 1); row.remove(); }));
        rows.push(rec); list.appendChild(row);
      };
      const set = (v) => {
        rows.length = 0; list.innerHTML = "";
        if (kind === "object") Object.entries(v && typeof v === "object" && !Array.isArray(v) ? v : {}).forEach(([k, x]) => addRow(k, x));
        else (Array.isArray(v) ? v : []).forEach((x) => addRow("", x));
      };
      wrap.append(list, smallBtn(kind === "object" ? T("kv.addField") : T("kv.addItem"), "", () => addRow(kind === "object" ? `${T("kv.name")}${rows.length + 1}` : "", "")));
      set(initial);
      const get = () => {
        if (kind === "object") return Object.fromEntries(rows.filter((r) => r.nameIn.value.trim()).map((r) => [r.nameIn.value.trim(), r.val.get()]));
        return rows.map((r) => r.val.get());
      };
      return { el: wrap, get, set };
    }


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
        const ed = makeEditor(prop, prop.default);
        row.appendChild(ed.el);
        activeFieldEls.set(key, { el: ed.el, type: prop.type, gddType, editor: ed });
        return row;
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
      for (const [key, { el, type, editor }] of activeFieldEls) {
        if (editor) data[key] = editor.get();
        else if (type === "boolean") data[key] = el.checked;
        else if (type === "integer" || type === "number") {
          const n = Number(el.value);
          data[key] = Number.isNaN(n) ? el.value : n;
        } else data[key] = el.value;
      }
      return data;
    }

    // Feldwerte aus gespeicherten Ebenen-Daten setzen (Editor öffnen).
    function applyFieldData(data) {
      for (const [key, { el, type, editor }] of activeFieldEls) {
        if (!data || !(key in data)) continue;
        const v = data[key];
        if (editor) editor.set(v);
        else if (type === "boolean") el.checked = !!v;
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
      if (!tpl || isOff(showBtn)) return;
      call("show", { templateId: tpl.id, data: readFieldData() });
    });
    updateBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (!tpl || !layerOf(tpl.id) || isOff(updateBtn)) return;
      call("update", { layerId: tpl.id, data: readFieldData() });
    });
    continueBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (tpl && layerOf(tpl.id) && !isOff(continueBtn)) call("continue", { layerId: tpl.id });
    });
    hideBtn.addEventListener("click", () => {
      const tpl = selectedTemplate();
      if (tpl && layerOf(tpl.id) && !isOff(hideBtn)) call("hide", { layerId: tpl.id });
    });

    const setDisabled = (btn, off) => btn.toggleAttribute("disabled", !!off);
    const isOff = (btn) => btn.hasAttribute("disabled");

    // Knöpfe je nach Zustand des gewählten Templates: Ein nur wenn nicht on
    // air; Update/Aus nur wenn on air; Weiter nur bei mehrstufigen Templates.
    function renderControls() {
      const tpl = selectedTemplate();
      const layer = tpl ? layerOf(tpl.id) : null;
      // omp-button kennt nur das ATTRIBUT disabled (keine Property) — ein
      // "btn.disabled = true" würde wirkungslos auf dem Host landen.
      setDisabled(showBtn, !tpl || !!layer);
      setDisabled(updateBtn, !layer);
      setDisabled(hideBtn, !layer);
      // Weiter: nur bei mehrstufigen Templates vorhanden (sonst unsichtbar, der
      // Platz bleibt erhalten) und nur bedienbar, solange on air und noch ein
      // weiterer Schritt existiert.
      const multi = !!tpl && (tpl.stepCount ?? 1) > 1;
      continueBtn.style.visibility = multi ? "visible" : "hidden";
      setDisabled(continueBtn, !layer || !layer.canContinue);
      // Beschriftung bleibt konstant (feste Knopfbreite); der Schritt steht im Zustands-Badge.
      targetName.textContent = tpl ? tpl.label : T("ogr.98b54b");
      targetBadge.textContent = layer ? T("x.onair") + (multi ? T("x.step") + (layer.step + 1) + "/" + layer.stepCount : "") : T("x.off");
      targetBadge.className = layer ? "badge live" : "badge";
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
      title.textContent = T("ogr.79eed3") + layers.length + ")";
      onair.appendChild(title);
      for (const l of layers) {
        const row = document.createElement("div");
        row.className = "layer-row" + (l.id === select.value ? " selected" : "");
        row.title = T("ogr.25b279");
        const dot = document.createElement("span");
        dot.className = "dot";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = l.label;
        row.append(dot, name);
        if (l.stepCount > 1) {
          const st = document.createElement("span");
          st.className = "step";
          st.textContent = T("ogr.398d8a") + (l.step + 1) + "/" + l.stepCount;
          row.appendChild(st);
        }
        const off = document.createElement("button");
        off.textContent = "■";
        off.title = T("ogr.419ff4");
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
          empty.textContent = T("ogr.e8bc14");
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
