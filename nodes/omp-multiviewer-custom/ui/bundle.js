// Node-UI-Bundle des manuell konfigurierten Multiviewers (Nutzerauftrag
// 2026-08-20: "layout editor, selektierbare quellen, dynamische anzahl an
// pip's. tally und umd pro pip"). Gleiches Muster wie
// omp-video-mixer-me/omp-audio-mixer: eigenständiges Custom-Element-
// Bundle, kein Framework/Import (ui/kit/design-tokens.css sind bereits
// von der Shell geladen, `var(--omp-*)` durchdringt die Shadow-DOM-
// Grenze, s. dortiger Kommentar), generische Node-Proxy-API
// (`/api/v1/nodes/<id>/state`, `/params/<name>`).
//
// **Explizites Speichern statt Live-Apply pro Drag-Schritt** (Nutzer-
// Feedback aus einer früheren Sitzung, Flow-Editor-Workflow-Bearbeitung:
// "Editoren brauchen ein explizites Speichern, kein PUT pro Klick") —
// Drag/Resize/Formularänderungen ändern nur den lokalen Entwurf
// (`this._layout`), erst der "Speichern"-Klick sendet `POST .../state`.
// Zusätzlicher praktischer Grund hier: jede Layout-Änderung baut auf dem
// Node die GESAMTE GStreamer-Pipeline neu auf (`pipeline.rs`-Moduldoku)
// — ein Rebuild pro Drag-Pixel wäre nicht nur unnötig, sondern sichtbar
// ruckelig.
//
// Layout-Koordinaten sind Pixel der konfigurierten Leinwand
// (canvasWidth/canvasHeight, Default 1920×1080) — die Editor-Fläche
// selbst ist nur eine skalierte Voransicht (EDITOR_WIDTH fest, Höhe
// ergibt sich aus dem Seitenverhältnis).

const EDITOR_WIDTH = 720;
const MIN_PIP_SIZE = 32; // muss zu pipeline::MIN_PIP_SIZE passen (Rust-Konstante, hier dupliziert wie MS_PER_TRANS_FRAME im Mixer-Bundle — kein Framework-Zwang, s. Moduldoku).
const RESIZE_HANDLE_PX = 14;

function defaultLayout() {
  return { canvasWidth: 1920, canvasHeight: 1080, pips: [] };
}

function newPipId() {
  return "pip-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

class OmpMultiviewerCustomPanel extends HTMLElement {
  async connectedCallback() {
    this._nodeId = this.getAttribute("node-id");
    this._layout = defaultLayout();
    this._sources = [];
    this._selectedPipId = null;
    this._dirty = false;
    this._loadError = null;
    this._saveStatus = "";
    this._drag = null;

    const shadow = this.attachShadow({ mode: "open" });
    this._shadow = shadow;
    shadow.innerHTML = `
      <style>${this._css()}</style>
      <div class="wrap">
        <div class="toolbar">
          <label>Leinwand
            <input type="number" class="canvas-w" min="${MIN_PIP_SIZE}" max="7680" step="1"> ×
            <input type="number" class="canvas-h" min="${MIN_PIP_SIZE}" max="4320" step="1">
          </label>
          <button class="add-pip">+ PIP</button>
          <label class="keep-ratio-label" title="Beim Ziehen der Größenänderungs-Ecke bleibt das aktuelle Breite/Höhe-Verhältnis der Kachel erhalten, statt frei verzerrbar zu sein.">
            <input type="checkbox" class="keep-ratio"> Seitenverhältnis beim Ziehen beibehalten
          </label>
          <span class="spacer"></span>
          <span class="status"></span>
          <button class="reload">Neu laden</button>
          <button class="save omp-btn-primary">Speichern</button>
        </div>
        <div class="toolbar layouts-toolbar">
          <label>Gespeicherte Layouts
            <select class="layout-select"><option value="">— auswählen —</option></select>
          </label>
          <button class="layout-apply" title="Das ausgewählte gespeicherte Layout als aktuelles Layout übernehmen und sofort anwenden.">Anwenden</button>
          <button class="layout-delete omp-btn-danger" title="Das ausgewählte gespeicherte Layout endgültig löschen.">Löschen</button>
          <button class="layout-export" title="Das ausgewählte gespeicherte Layout als JSON-Datei herunterladen.">Export</button>
          <span class="toolbar-sep"></span>
          <input type="text" class="layout-save-as-name" placeholder="Name für neues Layout">
          <button class="layout-save-as" title="Das aktuell im Editor angezeigte Layout unter diesem Namen ablegen (überschreibt einen gleichnamigen Eintrag).">Speichern als …</button>
          <label class="layout-import-label" title="Eine zuvor exportierte Layout-Datei (.json) importieren.">
            Import
            <input type="file" class="layout-import-file" accept="application/json,.json">
          </label>
        </div>
        <div class="body">
          <div class="canvas-outer">
            <div class="canvas"></div>
          </div>
          <div class="inspector"></div>
        </div>
      </div>
    `;

    this._el = {
      canvasW: shadow.querySelector(".canvas-w"),
      canvasH: shadow.querySelector(".canvas-h"),
      addPip: shadow.querySelector(".add-pip"),
      keepRatio: shadow.querySelector(".keep-ratio"),
      reload: shadow.querySelector(".reload"),
      save: shadow.querySelector(".save"),
      status: shadow.querySelector(".status"),
      canvas: shadow.querySelector(".canvas"),
      inspector: shadow.querySelector(".inspector"),
      layoutSelect: shadow.querySelector(".layout-select"),
      layoutApply: shadow.querySelector(".layout-apply"),
      layoutDelete: shadow.querySelector(".layout-delete"),
      layoutExport: shadow.querySelector(".layout-export"),
      layoutSaveAsName: shadow.querySelector(".layout-save-as-name"),
      layoutSaveAs: shadow.querySelector(".layout-save-as"),
      layoutImportFile: shadow.querySelector(".layout-import-file"),
    };
    // Nutzerauftrag 2026-08-20: "mehrere layouts pro multiviewer
    // anlegbar/aufrufbar machen, layouts export/import" — zusätzlich zum
    // EINEN aktuell aktiven Layout (oben) beliebig viele benannte,
    // gespeicherte Layouts (`GET/POST /layouts`, `.../<name>/apply`,
    // DELETE `.../<name>` — s. main.rs NamedLayout-Doku).
    this._savedLayouts = [];
    this._el.layoutApply.addEventListener("click", () => this._applySelectedLayout());
    this._el.layoutDelete.addEventListener("click", () => this._deleteSelectedLayout());
    this._el.layoutExport.addEventListener("click", () => this._exportSelectedLayout());
    this._el.layoutSaveAs.addEventListener("click", () => this._saveAsNamedLayout());
    this._el.layoutImportFile.addEventListener("change", () => this._importLayoutFile());
    this._el.layoutSelect.addEventListener("change", () => {
      const hasSelection = !!this._el.layoutSelect.value;
      this._el.layoutApply.disabled = !hasSelection;
      this._el.layoutDelete.disabled = !hasSelection;
      this._el.layoutExport.disabled = !hasSelection;
    });
    // Nutzerauftrag 2026-08-20: "preserve aspect ratio (optional) bei
    // drag&drop" — ein einziger, session-weiter Umschalter (kein
    // Modifier-Key wie Shift, damit es auch ohne Tastatur/in
    // Touch-Umgebungen bedienbar bleibt) statt pro-Kachel-Zustand: gilt
    // für JEDEN Resize-Drag, solange aktiviert. Bewusst NICHT Teil von
    // `this._layout` — reine Editor-Sitzungseinstellung, kein
    // Node-Zustand, der mitgespeichert werden müsste.
    this._keepAspectRatio = false;
    this._el.keepRatio.addEventListener("change", () => {
      this._keepAspectRatio = this._el.keepRatio.checked;
    });

    this._el.canvasW.addEventListener("change", () => {
      this._layout.canvasWidth = clamp(parseInt(this._el.canvasW.value, 10) || this._layout.canvasWidth, MIN_PIP_SIZE, 7680);
      this._dirty = true;
      this._render();
    });
    this._el.canvasH.addEventListener("change", () => {
      this._layout.canvasHeight = clamp(parseInt(this._el.canvasH.value, 10) || this._layout.canvasHeight, MIN_PIP_SIZE, 4320);
      this._dirty = true;
      this._render();
    });
    this._el.addPip.addEventListener("click", () => this._addPip());
    this._el.reload.addEventListener("click", () => this._reload());
    this._el.save.addEventListener("click", () => this._save());

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);

    await this._reload();
  }

  disconnectedCallback() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
  }

  _css() {
    return `
      :host { display:block; font-family: var(--omp-font, system-ui); color: var(--omp-text, #e8eaed); }
      .wrap { display:flex; flex-direction:column; gap: var(--omp-space-3, 12px); padding: var(--omp-space-3, 12px); box-sizing:border-box; }
      .toolbar { display:flex; align-items:center; gap: var(--omp-space-3, 12px); flex-wrap:wrap; }
      .toolbar label { display:flex; align-items:center; gap:4px; font-size: var(--omp-font-size-sm, 12px); color: var(--omp-text-dim, #9aa0a6); }
      .toolbar input[type="number"] { width:70px; }
      .spacer { flex:1; }
      .layouts-toolbar { padding-top: var(--omp-space-2, 8px); border-top: 1px solid var(--omp-border, #2e3338); }
      .layouts-toolbar select { max-width:160px; }
      .layout-save-as-name { width:150px; }
      .toolbar-sep { width:1px; align-self:stretch; background: var(--omp-border, #2e3338); }
      .layout-import-label { display:inline-flex; align-items:center; gap:4px; font-size: var(--omp-font-size-sm, 12px); color: var(--omp-text, #e8eaed); background: var(--omp-surface-raised, #22262b); border:1px solid var(--omp-border, #2e3338); border-radius: var(--omp-radius, 6px); padding: var(--omp-space-1, 4px) var(--omp-space-2, 8px); cursor:pointer; }
      .layout-import-label:hover { background: var(--omp-surface, #1a1d21); }
      .layout-import-file { display:none; }
      .status { font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); min-width:120px; }
      .status.dirty { color: var(--omp-cue, #fb8c00); }
      .status.error { color: var(--omp-error, #ef5350); }
      .status.ok { color: var(--omp-preset, #43a047); }
      .body { display:flex; gap: var(--omp-space-4, 16px); align-items:flex-start; flex-wrap:wrap; }
      /* Nutzerfund 2026-08-20: "im ui editor sind die leinwand grenzen
         nicht sichtbar" — ein einzelner 1px-Rand in Border-Farbe ging
         gegen den fast gleich dunklen Seitenhintergrund unter, vor allem
         dort, wo eine Kachel bis an den Rand reicht. Deutlich hellerer/
         dickerer Rahmen + Glow auf BEIDEN verschachtelten Elementen
         (Außenrahmen UND das Leinwand-Rechteck selbst), damit die
         Leinwandgrenze auch bei angrenzenden Kacheln eindeutig erkennbar
         bleibt. */
      .canvas-outer { background: var(--omp-bg, #101214); border:2px solid var(--omp-info, #4285f4); border-radius: var(--omp-radius, 6px); padding:4px; box-shadow: 0 0 0 1px rgba(66,133,244,0.35), 0 0 12px rgba(66,133,244,0.25); }
      .canvas { position:relative; outline:1px solid var(--omp-info, #4285f4); background:
        repeating-conic-gradient(#1c1f23 0% 25%, #16181b 0% 50%) 0 0 / 20px 20px;
        overflow:hidden; }
      .pip { position:absolute; box-sizing:border-box; border:2px solid var(--omp-border, #2e3338); background: rgba(30,33,37,0.9); cursor:move; display:flex; flex-direction:column; }
      .pip.selected { border-color: var(--omp-info, #4285f4); box-shadow: 0 0 0 1px var(--omp-info, #4285f4); }
      .pip .label { font-size:10px; color: var(--omp-text-dim, #9aa0a6); padding:2px 4px; pointer-events:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .pip .umd { margin-top:auto; font-size:10px; color: var(--omp-text, #e8eaed); background:rgba(0,0,0,0.55); padding:2px 4px; text-align:center; pointer-events:none; }
      .pip .no-source { flex:1; display:flex; align-items:center; justify-content:center; font-size:10px; color: var(--omp-text-disabled, #5f6368); pointer-events:none; }
      .pip .remove { position:absolute; top:1px; right:1px; width:14px; height:14px; line-height:12px; text-align:center; font-size:11px; background: var(--omp-error, #ef5350); color:#fff; border-radius:2px; cursor:pointer; }
      .pip .resize { position:absolute; right:0; bottom:0; width:${RESIZE_HANDLE_PX}px; height:${RESIZE_HANDLE_PX}px; cursor:nwse-resize; background: linear-gradient(135deg, transparent 50%, var(--omp-text-dim, #9aa0a6) 50%); }
      .inspector { min-width:220px; display:flex; flex-direction:column; gap: var(--omp-space-2, 8px); }
      .inspector .field { display:flex; flex-direction:column; gap:2px; font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6); }
      .inspector .row { display:flex; gap:6px; }
      .inspector .row .field { flex:1; }
      .empty-hint { color: var(--omp-text-disabled, #5f6368); font-size: var(--omp-font-size-sm, 12px); }
    `;
  }

  async _reload() {
    this._setStatus("Lädt …", "");
    try {
      const [stateRes, sourcesRes, layoutsRes] = await Promise.all([
        fetch(`/api/v1/nodes/${this._nodeId}/state`),
        fetch(`/api/v1/nodes/${this._nodeId}/params/sources`),
        fetch(`/api/v1/nodes/${this._nodeId}/layouts`),
      ]);
      if (stateRes.ok) {
        const body = await stateRes.json();
        if (body.state) this._layout = body.state;
      }
      if (sourcesRes.ok) {
        const body = await sourcesRes.json();
        this._sources = Array.isArray(body.value) ? body.value : [];
      }
      if (layoutsRes.ok) {
        const body = await layoutsRes.json();
        this._savedLayouts = Array.isArray(body.layouts) ? body.layouts : [];
      }
      this._dirty = false;
      this._setStatus("", "");
    } catch (err) {
      this._setStatus(`Laden fehlgeschlagen: ${err}`, "error");
    }
    this._render();
  }

  async _save() {
    this._setStatus("Speichert …", "");
    try {
      const res = await fetch(`/api/v1/nodes/${this._nodeId}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: this._layout }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this._setStatus(`Speichern fehlgeschlagen: ${body.error || res.status}`, "error");
        return;
      }
      this._dirty = false;
      this._setStatus("Gespeichert.", "ok");
    } catch (err) {
      this._setStatus(`Speichern fehlgeschlagen: ${err}`, "error");
    }
    this._render();
  }

  // --- Benannte, gespeicherte Layouts (Nutzerauftrag 2026-08-20) ---

  _selectedSavedLayoutName() {
    return this._el.layoutSelect.value || null;
  }

  async _applySelectedLayout() {
    const name = this._selectedSavedLayoutName();
    if (!name) {
      this._setStatus("Kein gespeichertes Layout ausgewählt.", "error");
      return;
    }
    this._setStatus("Wendet an …", "");
    try {
      const res = await fetch(`/api/v1/nodes/${this._nodeId}/layouts/${encodeURIComponent(name)}/apply`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this._setStatus(`Anwenden fehlgeschlagen: ${body.error || res.status}`, "error");
        return;
      }
      // Serverseitig ist das benannte Layout jetzt das aktive — lokalen
      // Entwurf synchron nachziehen, ohne den kompletten Reload-Umweg
      // (Quellen/gespeicherte Layouts ändern sich durch einen reinen
      // Apply-Aufruf nicht).
      const applied = this._savedLayouts.find((l) => l.name === name);
      if (applied) this._layout = JSON.parse(JSON.stringify(applied.layout));
      this._selectedPipId = null;
      this._dirty = false;
      this._setStatus(`Layout „${name}" angewendet.`, "ok");
    } catch (err) {
      this._setStatus(`Anwenden fehlgeschlagen: ${err}`, "error");
    }
    this._render();
  }

  async _deleteSelectedLayout() {
    const name = this._selectedSavedLayoutName();
    if (!name) {
      this._setStatus("Kein gespeichertes Layout ausgewählt.", "error");
      return;
    }
    if (!confirm(`Gespeichertes Layout „${name}" wirklich löschen?`)) return;
    this._setStatus("Löscht …", "");
    try {
      const res = await fetch(`/api/v1/nodes/${this._nodeId}/layouts/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this._setStatus(`Löschen fehlgeschlagen: ${body.error || res.status}`, "error");
        return;
      }
      this._savedLayouts = this._savedLayouts.filter((l) => l.name !== name);
      this._setStatus(`Layout „${name}" gelöscht.`, "ok");
    } catch (err) {
      this._setStatus(`Löschen fehlgeschlagen: ${err}`, "error");
    }
    this._render();
  }

  // Export braucht keine eigene Backend-Route (s. main.rs NamedLayout-
  // Doku): `GET /layouts` liefert bereits die vollen Dokumente, ein
  // Klick baut daraus lokal eine herunterladbare JSON-Datei — Standard-
  // Blob+Objekt-URL-Muster, funktioniert in jedem echten Browser-Tab
  // (anders als z. B. eine Artifact-Sandbox gibt es hier keine
  // Download-Einschränkung, dies ist die reguläre Orchestrator-Shell).
  _exportSelectedLayout() {
    const name = this._selectedSavedLayoutName();
    const entry = this._savedLayouts.find((l) => l.name === name);
    if (!entry) {
      this._setStatus("Kein gespeichertes Layout zum Exportieren ausgewählt.", "error");
      return;
    }
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entry.name.replace(/[^\w\- ]+/g, "_")}.multiviewer-layout.json`;
    this._shadow.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this._setStatus(`Layout „${name}" exportiert.`, "ok");
  }

  async _saveAsNamedLayout() {
    const name = this._el.layoutSaveAsName.value.trim();
    if (!name) {
      this._setStatus('Name für "Speichern als …" fehlt.', "error");
      return;
    }
    if (this._savedLayouts.some((l) => l.name === name) && !confirm(`Layout „${name}" existiert bereits — überschreiben?`)) {
      return;
    }
    await this._postNamedLayout(name, this._layout);
  }

  // Gemeinsamer POST /layouts-Aufruf für "Speichern als …" UND Import
  // (Nutzerauftrag "layouts export/import") — Import ist funktional
  // nichts anderes als ein Speichern-als mit dem Inhalt einer
  // hochgeladenen Datei statt des aktuellen Editor-Entwurfs.
  async _postNamedLayout(name, layout) {
    this._setStatus("Speichert …", "");
    try {
      const res = await fetch(`/api/v1/nodes/${this._nodeId}/layouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, layout }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this._setStatus(`Speichern fehlgeschlagen: ${body.error || res.status}`, "error");
        return;
      }
      const existing = this._savedLayouts.find((l) => l.name === name);
      if (existing) {
        existing.layout = layout;
      } else {
        this._savedLayouts.push({ name, layout });
      }
      this._el.layoutSaveAsName.value = "";
      this._setStatus(`Layout „${name}" gespeichert.`, "ok");
    } catch (err) {
      this._setStatus(`Speichern fehlgeschlagen: ${err}`, "error");
    }
    this._render();
  }

  async _importLayoutFile() {
    const file = this._el.layoutImportFile.files[0];
    this._el.layoutImportFile.value = "";
    if (!file) return;
    let doc;
    try {
      doc = JSON.parse(await file.text());
    } catch (err) {
      this._setStatus(`Import fehlgeschlagen: Datei ist kein gültiges JSON (${err})`, "error");
      return;
    }
    // Exportierte Dateien haben die Form {name, layout:{...}} (s.
    // _exportSelectedLayout) — akzeptiert wird aber auch ein reines
    // Layout-Dokument ({canvasWidth,canvasHeight,pips}) ohne Namen, dann
    // wird nach einem Namen gefragt (z. B. eine von Hand gebaute Datei).
    const layout = doc && typeof doc === "object" && doc.layout ? doc.layout : doc;
    if (!layout || !Array.isArray(layout.pips)) {
      this._setStatus("Import fehlgeschlagen: Datei enthält kein gültiges Layout-Dokument.", "error");
      return;
    }
    const suggestedName = (doc && doc.name) || file.name.replace(/\.multiviewer-layout\.json$|\.json$/i, "");
    const name = prompt("Name für das importierte Layout:", suggestedName);
    if (!name || !name.trim()) return;
    await this._postNamedLayout(name.trim(), layout);
  }

  _setStatus(text, cls) {
    this._saveStatus = text;
    this._saveStatusClass = cls;
    if (this._el && this._el.status) {
      this._el.status.textContent = text;
      this._el.status.className = "status" + (cls ? ` ${cls}` : "");
    }
  }

  _addPip() {
    const w = Math.max(MIN_PIP_SIZE, Math.round(this._layout.canvasWidth / 4));
    const h = Math.max(MIN_PIP_SIZE, Math.round(this._layout.canvasHeight / 4));
    const cascade = (this._layout.pips.length % 6) * Math.round(this._layout.canvasWidth * 0.02);
    this._layout.pips.push({
      id: newPipId(),
      senderId: null,
      x: clamp(cascade, 0, Math.max(0, this._layout.canvasWidth - w)),
      y: clamp(cascade, 0, Math.max(0, this._layout.canvasHeight - h)),
      width: w,
      height: h,
      umd: "",
    });
    this._selectedPipId = this._layout.pips[this._layout.pips.length - 1].id;
    this._dirty = true;
    this._setStatus("Ungespeicherte Änderungen.", "dirty");
    this._render();
  }

  _removePip(id) {
    this._layout.pips = this._layout.pips.filter((p) => p.id !== id);
    if (this._selectedPipId === id) this._selectedPipId = null;
    this._dirty = true;
    this._setStatus("Ungespeicherte Änderungen.", "dirty");
    this._render();
  }

  _pip(id) {
    return this._layout.pips.find((p) => p.id === id) || null;
  }

  _scale() {
    return EDITOR_WIDTH / Math.max(1, this._layout.canvasWidth);
  }

  // --- Drag/Resize: ändert nur das In-Memory-Modell + die Box-Inline-
  // Styles direkt (kein voller _render() pro Pointer-Move, s. Moduldoku)
  // — ein _render() am Ende synchronisiert die Zahleneingaben im
  // Inspector einmalig.

  _onPipPointerDown(ev, pip, mode) {
    ev.preventDefault();
    ev.stopPropagation();
    this._selectedPipId = pip.id;
    this._drag = {
      mode, // "move" | "resize"
      pipId: pip.id,
      startScreenX: ev.clientX,
      startScreenY: ev.clientY,
      startX: pip.x,
      startY: pip.y,
      startWidth: pip.width,
      startHeight: pip.height,
    };
    this._render();
  }

  _onPointerMove(ev) {
    if (!this._drag) return;
    const pip = this._pip(this._drag.pipId);
    if (!pip) return;
    const scale = this._scale();
    const dx = Math.round((ev.clientX - this._drag.startScreenX) / scale);
    const dy = Math.round((ev.clientY - this._drag.startScreenY) / scale);

    if (this._drag.mode === "move") {
      pip.x = clamp(this._drag.startX + dx, 0, Math.max(0, this._layout.canvasWidth - pip.width));
      pip.y = clamp(this._drag.startY + dy, 0, Math.max(0, this._layout.canvasHeight - pip.height));
    } else if (this._keepAspectRatio) {
      // Nutzerauftrag 2026-08-20: "preserve aspect ratio (optional) bei
      // drag&drop" — Breite folgt dx (der Ecke, an der gezogen wird),
      // Höhe wird aus dem beim Drag-Start erfassten Verhältnis abgeleitet
      // statt frei aus dy. An der Leinwandgrenze wird zuerst die Höhe
      // geklemmt und die Breite danach ERNEUT aus dem Verhältnis
      // zurückgerechnet — sonst würde eine Kachel direkt am Rand leicht
      // verzerrt wirken, statt exakt proportional zu bleiben.
      const ratio = this._drag.startWidth / this._drag.startHeight;
      const maxWidth = this._layout.canvasWidth - pip.x;
      const maxHeight = this._layout.canvasHeight - pip.y;
      let newWidth = Math.min(Math.max(MIN_PIP_SIZE, this._drag.startWidth + dx), maxWidth);
      let newHeight = Math.round(newWidth / ratio);
      if (newHeight > maxHeight) {
        newHeight = maxHeight;
        newWidth = Math.round(newHeight * ratio);
      }
      pip.width = clamp(newWidth, MIN_PIP_SIZE, maxWidth);
      pip.height = clamp(newHeight, MIN_PIP_SIZE, maxHeight);
    } else {
      pip.width = clamp(this._drag.startWidth + dx, MIN_PIP_SIZE, this._layout.canvasWidth - pip.x);
      pip.height = clamp(this._drag.startHeight + dy, MIN_PIP_SIZE, this._layout.canvasHeight - pip.y);
    }

    const box = this._el.canvas.querySelector(`[data-pip-id="${cssEscape(pip.id)}"]`);
    if (box) {
      box.style.left = `${Math.round(pip.x * scale)}px`;
      box.style.top = `${Math.round(pip.y * scale)}px`;
      box.style.width = `${Math.round(pip.width * scale)}px`;
      box.style.height = `${Math.round(pip.height * scale)}px`;
    }
    this._dirty = true;
  }

  _onPointerUp() {
    if (!this._drag) return;
    this._drag = null;
    this._setStatus("Ungespeicherte Änderungen.", "dirty");
    this._render();
  }

  _sourceLabel(senderId) {
    if (!senderId) return null;
    const src = this._sources.find((s) => s.senderId === senderId);
    return src ? src.label : `${senderId} (nicht gefunden)`;
  }

  _renderLayoutSelect() {
    const previousValue = this._el.layoutSelect.value;
    this._el.layoutSelect.innerHTML = '<option value="">— auswählen —</option>';
    for (const entry of this._savedLayouts) {
      const opt = document.createElement("option");
      opt.value = entry.name;
      opt.textContent = entry.name;
      this._el.layoutSelect.appendChild(opt);
    }
    if (this._savedLayouts.some((l) => l.name === previousValue)) {
      this._el.layoutSelect.value = previousValue;
    }
    const hasSelection = !!this._el.layoutSelect.value;
    this._el.layoutApply.disabled = !hasSelection;
    this._el.layoutDelete.disabled = !hasSelection;
    this._el.layoutExport.disabled = !hasSelection;
  }

  _render() {
    const scale = this._scale();
    this._el.canvasW.value = this._layout.canvasWidth;
    this._el.canvasH.value = this._layout.canvasHeight;
    this._el.canvas.style.width = `${Math.round(this._layout.canvasWidth * scale)}px`;
    this._el.canvas.style.height = `${Math.round(this._layout.canvasHeight * scale)}px`;
    this._renderLayoutSelect();
    if (this._saveStatus) {
      this._el.status.textContent = this._saveStatus;
      this._el.status.className = "status" + (this._saveStatusClass ? ` ${this._saveStatusClass}` : "");
    }

    this._el.canvas.innerHTML = "";
    for (const pip of this._layout.pips) {
      const box = document.createElement("div");
      box.className = "pip" + (pip.id === this._selectedPipId ? " selected" : "");
      box.dataset.pipId = pip.id;
      box.style.left = `${Math.round(pip.x * scale)}px`;
      box.style.top = `${Math.round(pip.y * scale)}px`;
      box.style.width = `${Math.round(pip.width * scale)}px`;
      box.style.height = `${Math.round(pip.height * scale)}px`;
      box.addEventListener("pointerdown", (ev) => this._onPipPointerDown(ev, pip, "move"));

      const label = document.createElement("div");
      label.className = "label";
      const sourceLabel = this._sourceLabel(pip.senderId);
      label.textContent = sourceLabel || "— keine Quelle —";
      box.appendChild(label);

      if (!pip.senderId) {
        const hint = document.createElement("div");
        hint.className = "no-source";
        hint.textContent = "kein Signal";
        box.appendChild(hint);
      }

      if (pip.umd) {
        const umd = document.createElement("div");
        umd.className = "umd";
        umd.textContent = pip.umd;
        box.appendChild(umd);
      }

      const remove = document.createElement("div");
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = "Kachel entfernen";
      remove.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._removePip(pip.id);
      });
      box.appendChild(remove);

      const resize = document.createElement("div");
      resize.className = "resize";
      resize.title = "Größe ändern";
      resize.addEventListener("pointerdown", (ev) => this._onPipPointerDown(ev, pip, "resize"));
      box.appendChild(resize);

      this._el.canvas.appendChild(box);
    }

    this._renderInspector();
  }

  _renderInspector() {
    const inspector = this._el.inspector;
    inspector.innerHTML = "";
    const pip = this._pip(this._selectedPipId);
    if (!pip) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = this._layout.pips.length === 0 ? 'Noch keine Kachel — "+ PIP" anklicken.' : "Kachel anklicken, um sie zu bearbeiten.";
      inspector.appendChild(hint);
      return;
    }

    const sourceField = this._field("Quelle");
    const select = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— keine Quelle —";
    select.appendChild(noneOpt);
    for (const src of this._sources) {
      const opt = document.createElement("option");
      opt.value = src.senderId;
      opt.textContent = src.label || src.senderId;
      if (src.senderId === pip.senderId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      pip.senderId = select.value || null;
      this._dirty = true;
      this._setStatus("Ungespeicherte Änderungen.", "dirty");
      this._render();
    });
    sourceField.appendChild(select);
    inspector.appendChild(sourceField);

    const umdField = this._field("UMD-Text");
    const umdInput = document.createElement("input");
    umdInput.type = "text";
    umdInput.maxLength = 32;
    umdInput.placeholder = "z. B. CAM 1";
    umdInput.value = pip.umd || "";
    umdInput.addEventListener("change", () => {
      pip.umd = umdInput.value;
      this._dirty = true;
      this._setStatus("Ungespeicherte Änderungen.", "dirty");
      this._render();
    });
    umdField.appendChild(umdInput);
    inspector.appendChild(umdField);

    const row1 = document.createElement("div");
    row1.className = "row";
    row1.appendChild(this._numberField("X", pip.x, (v) => {
      pip.x = clamp(v, 0, Math.max(0, this._layout.canvasWidth - pip.width));
    }));
    row1.appendChild(this._numberField("Y", pip.y, (v) => {
      pip.y = clamp(v, 0, Math.max(0, this._layout.canvasHeight - pip.height));
    }));
    inspector.appendChild(row1);

    const row2 = document.createElement("div");
    row2.className = "row";
    row2.appendChild(this._numberField("Breite", pip.width, (v) => {
      pip.width = clamp(v, MIN_PIP_SIZE, this._layout.canvasWidth - pip.x);
    }));
    row2.appendChild(this._numberField("Höhe", pip.height, (v) => {
      pip.height = clamp(v, MIN_PIP_SIZE, this._layout.canvasHeight - pip.y);
    }));
    inspector.appendChild(row2);
  }

  _field(labelText) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    field.appendChild(label);
    return field;
  }

  _numberField(labelText, value, onChange) {
    const field = this._field(labelText);
    const input = document.createElement("input");
    input.type = "number";
    input.value = value;
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) onChange(v);
      this._dirty = true;
      this._setStatus("Ungespeicherte Änderungen.", "dirty");
      this._render();
    });
    field.appendChild(input);
    return field;
  }
}

// `querySelector`s Attribut-Selektor bricht bei Sonderzeichen in
// `data-pip-id` (unsere eigenen IDs enthalten nur [a-z0-9-], aber robust
// gegen künftige ID-Formate) — minimaler Ersatz für `CSS.escape` ohne
// Browser-Kompatibilitätsannahmen.
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

customElements.define("omp-multiviewer-custom-panel", OmpMultiviewerCustomPanel);
