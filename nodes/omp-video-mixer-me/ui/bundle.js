// Node-UI-Bundle des Bildmischers (UMSETZUNG.md C10/K3-Teil-1,
// ARCHITECTURE.md §4.5, docs/END-GOAL-FEATURES.md §3.3/§3.4) — Hardware-
// Pult-Optik statt generischer Button-Liste — PGM/PST-Doppelreihe,
// CUT/AUTO, Keyer/PIP als beleuchtete Tasten, alles auf
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
// PGM-Reihe: Hot-Cut (K3-Teil-2, §3.5 offene Frage 1 entschieden
// 2026-07-16 — Projektinhaber-Feedback). Ruft `crosspoint.take`
// (Node-seitig neu), NICHT `crosspoint.select` — schaltet das Programm
// direkt um, ohne die gestagte Preset-Auswahl anzurühren (die PST-Reihe
// bleibt unverändert, s. `pipeline.rs::Command::Take`-Doku).
//
// Mehrere M/E-Ebenen (Nutzerwunsch 2026-08-14): Ebenenzahl wird aus dem
// generischen `GET .../descriptor` abgeleitet (höchster gefundene
// `levelN.`-Präfix unter allen Param-/Methodennamen, main.rs::level_name
// präfigiert bei `level_count>1` AUSNAHMSLOS jeden Namen).
//
// **Konsole verschmolzen (Nutzerauftrag 2026-09-04, "die einzelnen Reihen
// an Buttons der Mischerebenen müssen unmittelbar übereinander sein"):**
// vorher baute `buildBank(level)` je Ebene eine eigene `<omp-panel-
// section>` mit eigenem Kartenrahmen/Kopfzeile — bei mehreren Ebenen sah
// das wie N unabhängige Widgets aus, nicht wie ein durchgängiges
// Hardware-Pult mit mehreren M/E-Bänken. Jetzt liefert `buildBank`
// stattdessen ein Fragment (`bankRow`), das in EINE gemeinsame
// `<omp-panel-section label="Video Mixer M/E">` gehängt wird
// (`.console-list`); zwischen den Bänken nur eine dünne `border-top` +
// eine schmale Ebenen-Nummer im linken Gutter (`.bank-gutter`), kein
// Kartenrahmen/Padding pro Bank mehr. Bei `levelCount<=1` bleibt der
// Gutter leer (kein Sonderfall-Code nötig, nur CSS/eine leere Zelle).
//
// **Quellen/DSK/PIP-Auswahl in Dialoge verschoben (Nutzerauftrag
// 2026-09-04, "um neue Quellen hinzuzufügen... sollte es ein Tab/Menü/
// Modal-Dialog geben"):** die frühere Inline-SRC-Reihe (+/×-Chips) und
// das nackte DSK-`<select>` sind jetzt in einem Dialog
// (`openSourcesModal`, Punkt "Quellen"-Taste je Bank) — das Hauptpanel
// zeigt nur noch PGM/PST/DSK-Toggle/Rate/PIP-Presets/Transition, keine
// dauerhaft sichtbaren Formularfelder mehr (kompakter + touch-tauglicher,
// da weniger kleine Klickziele permanent im Weg stehen). `openModal()`
// unten ist ein Node-lokales, eigenständiges Overlay (an `document.body`
// gehängt, analog `ui/kit/omp-confirm.ts`, aber ohne eigenen `ui/kit`-
// Export, da dieses Bundle bereits vollständig eigenständig ist).
//
// **PIP-Presets statt einem einzelnen PIP-Button (Nutzerauftrag
// 2026-09-04):** PIP kannte bis hierhin genau eine feste Box (`PIP_BOX`)
// + eine Quellauswahl + einen Ein/Aus-Button. Jetzt gibt es einen
// visuellen Editor (`openPipEditor`, Drag-Move + Resize-Handle, exakt
// dasselbe Interaktionsmuster wie `nodes/omp-multiviewer-custom/ui/
// bundle.js#_onPipPointerDown/_onPointerMove/_onPointerUp`, hier nur mit
// einer einzigen Box statt einer Liste) für Position/Größe/Quelle;
// „Speichern" ruft die neue Methode `pip.savePreset` (main.rs) und
// zeigt das Ergebnis sofort per `pip.applyPreset`. Je gespeichertem
// Preset erscheint ein eigener „Mixer"-Button (`renderPipRow`),
// Klick aktiviert es (`pip.applyPreset`) bzw. deaktiviert PIP bei
// erneutem Klick auf das bereits aktive Preset (`pip.setEnabled`) —
// exakt das Toggle-Verhalten des vormals einzelnen `pipBtn`. Alles
// dynamisch: beliebig viele Presets, keine feste Obergrenze.
//
// **Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2, endlich
// umgesetzt 2026-09-04, Nutzerauftrag "der Mixer Transition Fader lässt
// sich nicht händisch bedienen"):** `tBar` (`<omp-fader>`) ist nicht mehr
// `disabled`/`pointer-events:none` — sein `input`-Event (läuft während
// des Drags) sendet die Position roh per `sendTransitionPosition()` an
// die neue Node-Methode `crosspoint.setTransitionPosition` (main.rs/
// pipeline.rs), OHNE über das gemeinsame `call()` (das nach jedem Aufruf
// ein volles `refresh()` anstößt — bei pointermove-Takt würde das
// spürbar ruckeln). `refresh()` selbst überschreibt `tBar.value` nur,
// wenn gerade WEDER von Hand gezogen (`tBarDragging`) NOCH die
// AUTO-Kosmetik-Animation aktiv ist (`tBarAnimation`, s. u.) — sonst
// würde der 2-s-Poll den Wert unter dem Finger/der laufenden Animation
// wegreißen. Rate-Wahl (6f/12f/25f/50f, seit Bug 4 real) unverändert.
//
// AUTO-Klick bleibt weiterhin rein client-seitig kosmetisch animiert
// (`animateTBar`, folgt der echten `crosspoint.transRate`) — bewusst
// KEIN server-getriebener Positions-Push während einer AUTO-Rampe für
// andere, gleichzeitig zuschauende Browser-Tabs (Scope-Entscheidung,
// s. `pipeline.rs`-Moduldoku zu `spawn_autotrans`); der neue readonly
// Param `crosspoint.transitionPosition` dient nur als Ausgangswert beim
// Laden/Reconnect (server setzt ihn nach Cut/Take/AutoTrans-Ende auf 0,
// die "Ruheposition" für den nächsten manuellen Zug).
const WIDTH = 640;
const HEIGHT = 480;
// Default-Box für ein NEU angelegtes PIP-Preset (vormals die einzige,
// feste `PIP_BOX`-Konstante) — der Editor erlaubt danach freies Ziehen.
const PIP_BOX_DEFAULT = { width: Math.round(WIDTH / 3), height: Math.round(HEIGHT / 3) };
PIP_BOX_DEFAULT.x = WIDTH - PIP_BOX_DEFAULT.width - 16;
PIP_BOX_DEFAULT.y = HEIGHT - PIP_BOX_DEFAULT.height - 16;
const PIP_MIN_SIZE = 32; // wie nodes/omp-multiviewer-custom/ui/bundle.js::MIN_PIP_SIZE, hier dupliziert (kein Framework-Zwang, s. Moduldoku).
const PIP_EDITOR_WIDTH = 260; // skalierte Editor-Canvas-Breite im Modal, Höhe folgt aus WIDTH/HEIGHT-Verhältnis.

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

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Wie `nodes/omp-multiviewer-custom/ui/bundle.js::newPipId` — bewusst
// KEIN `crypto.randomUUID()` (dieselbe Begründung dort: einfacher,
// framework-freier Kollisions-arm genug für eine Handvoll Presets pro
// Ebene, kein Secure-Context-Vorbehalt).
function newPresetId() {
  return "pip-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

// Gemeinsames Overlay-Modal (Nutzerauftrag 2026-09-04, s. Moduldoku) —
// eigenständig, an `document.body` gehängt (analog `ui/kit/
// omp-confirm.ts`, aber ohne eigenen `ui/kit`-Export). Schließen per
// Hintergrund-Klick, Escape oder dem "Schließen"-Button; `opts.onClose`
// läuft in jedem Fall genau einmal.
function openModal(titleText, opts) {
  opts = opts || {};
  const overlay = document.createElement("div");
  overlay.className = "omp-vmix-modal";
  overlay.innerHTML = `
    <style>
      .omp-vmix-modal {
        position: fixed; inset: 0; z-index: 1100;
        display: flex; align-items: center; justify-content: center;
        font-family: var(--omp-font, system-ui, sans-serif);
        font-size: var(--omp-font-size-sm, 12px);
        color: var(--omp-text, #e8eaed);
      }
      .omp-vmix-modal .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
      .omp-vmix-modal .dialog {
        position: relative; box-sizing: border-box;
        background: var(--omp-surface, #1a1d21);
        border: 1px solid var(--omp-border, #2e3338);
        border-radius: var(--omp-radius, 6px);
        padding: var(--omp-space-4, 16px);
        width: min(92vw, 420px); max-height: 86vh; overflow-y: auto;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        display: flex; flex-direction: column; gap: var(--omp-space-3, 12px);
      }
      .omp-vmix-modal h3 {
        margin: 0; font-size: var(--omp-font-size-xs, 11px); font-weight: 700;
        letter-spacing: 0.06em; text-transform: uppercase;
        color: var(--omp-text-dim, #9aa0a6);
      }
      .omp-vmix-modal .field { display: flex; flex-direction: column; gap: 4px; }
      .omp-vmix-modal .field label {
        font-size: var(--omp-font-size-xs, 11px); color: var(--omp-text-dim, #9aa0a6);
        text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700;
      }
      .omp-vmix-modal select, .omp-vmix-modal input[type="text"] {
        min-width: 0; height: 40px; font-size: 12px; box-sizing: border-box;
        font-family: var(--omp-font, system-ui, sans-serif);
        color: var(--omp-text, #e8eaed);
        background: linear-gradient(to bottom, var(--omp-metal-light, #3d434b) 0%, var(--omp-metal-mid, #2b2f34) 100%);
        border: 1px solid var(--omp-metal-dark, #1a1c1f);
        border-radius: var(--omp-radius, 6px);
        padding: 0 10px;
      }
      .omp-vmix-modal select {
        appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 26px;
        background-image:
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='6'%3E%3Cpath d='M0 0l4.5 6L9 0z' fill='%239aa0a6'/%3E%3C/svg%3E"),
          linear-gradient(to bottom, var(--omp-metal-light, #3d434b) 0%, var(--omp-metal-mid, #2b2f34) 100%);
        background-repeat: no-repeat, no-repeat;
        background-position: right 8px center, center;
      }
      .omp-vmix-modal select option { background: var(--omp-surface-raised, #22262b); color: var(--omp-text, #e8eaed); }
      .omp-vmix-modal .row { display: flex; gap: var(--omp-space-2, 8px); align-items: center; flex-wrap: wrap; }
      .omp-vmix-modal .actions { display: flex; justify-content: flex-end; gap: var(--omp-space-2, 8px); margin-top: var(--omp-space-1, 4px); }
      .omp-vmix-modal .actions omp-button { height: 40px; padding: 0 var(--omp-space-3, 12px) !important; width: auto !important; }
      .omp-vmix-modal .actions .spacer { flex: 1; }
      .omp-vmix-modal .list { display: flex; flex-direction: column; gap: 6px; }
      .omp-vmix-modal .chip {
        display: flex; align-items: center; gap: 8px; height: 40px;
        padding: 0 4px 0 10px; background: var(--omp-surface-raised, #22262b);
        border: 1px solid var(--omp-border, #2e3338); border-radius: var(--omp-radius, 6px);
      }
      .omp-vmix-modal .chip .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .omp-vmix-modal .chip omp-button { width: 32px !important; height: 32px !important; font-size: 13px; padding: 0; }
      .omp-vmix-modal p.empty { font-size: var(--omp-font-size-xs, 11px); font-style: italic; color: var(--omp-text-dim, #9aa0a6); margin: 0; }

      /* PIP-Editor: Drag-Box-Canvas, gleiches Muster wie
         nodes/omp-multiviewer-custom/ui/bundle.js (dort ausführlicher
         kommentiert), hier auf eine einzige Box vereinfacht. MUSS hier im
         Modal-Overlay-Stylesheet stehen, nicht im Panel-Shadow-Root-Style
         weiter oben — das Modal hängt an document.body, außerhalb der
         Shadow-DOM-Grenze des Panels, dessen Style also gar nicht
         erreicht (live gefunden: Canvas/Box blieben unsichtbar/ungestylt,
         obwohl die Drag-Logik selbst schon funktionierte). */
      .omp-vmix-modal .pip-editor-canvas-outer {
        background: var(--omp-bg, #101214); border: 2px solid var(--omp-info, #4285f4);
        border-radius: var(--omp-radius, 6px); padding: 4px; align-self: center;
      }
      .omp-vmix-modal .pip-editor-canvas {
        position: relative; outline: 1px solid var(--omp-info, #4285f4);
        background: repeating-conic-gradient(#1c1f23 0% 25%, #16181b 0% 50%) 0 0 / 16px 16px;
        overflow: hidden; touch-action: none;
      }
      .omp-vmix-modal .pip-editor-box {
        position: absolute; box-sizing: border-box; border: 2px solid var(--omp-preset, #43a047);
        background: rgba(67, 160, 71, 0.25); cursor: move;
      }
      .omp-vmix-modal .pip-editor-resize {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, var(--omp-text-dim, #9aa0a6) 50%);
        touch-action: none;
      }
    </style>
    <div class="backdrop" part="backdrop"></div>
    <div class="dialog" role="dialog" aria-label="${titleText}">
      <h3>${titleText}</h3>
      <div class="body"></div>
    </div>
  `;
  const bodyEl = overlay.querySelector(".body");
  const onKeyDown = (ev) => {
    if (ev.key === "Escape") close();
  };
  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (opts.onClose) opts.onClose();
  };
  document.addEventListener("keydown", onKeyDown);
  overlay.querySelector(".backdrop").addEventListener("click", close);
  document.body.appendChild(overlay);
  return { bodyEl, close };
}

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
      /* Konsole verschmolzen (s. Moduldoku): EINE Liste von Bank-Reihen
         statt N einzelner Kartenwidgets. */
      .console-list { display: flex; flex-direction: column; }
      .bank-row { display: flex; gap: var(--omp-space-2, 8px); padding: var(--omp-space-2, 8px) 0; }
      .bank-row + .bank-row { border-top: 1px solid var(--omp-border, #2e3338); margin-top: var(--omp-space-1, 4px); }
      .bank-gutter {
        width: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 700; color: var(--omp-text-dim, #9aa0a6);
      }
      .bank-content { flex: 1; min-width: 0; }

      .console { display: grid; grid-template-columns: 1fr 116px; gap: var(--omp-space-3, 12px); }
      .buses { display: flex; flex-direction: column; gap: var(--omp-space-2, 8px); min-width: 0; }
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

      /* Kompakte Werkzeugleiste (Nutzerauftrag 2026-09-04: "kompakter,
         touch-tauglicher") — ersetzt die frühere Inline-SRC-Reihe +
         DSK-<select>: nur noch je ein Knopf für "Quellen" (öffnet den
         Pin/Unpin+DSK-Dialog), der DSK-Toggle selbst, und die
         Rate-Wahl. */
      .toolbar-row {
        margin-top: var(--omp-space-1, 4px);
        padding-top: var(--omp-space-2, 8px);
        border-top: 1px solid var(--omp-border, #2e3338);
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
      }
      .toolbar-row omp-button { height: 36px; }
      .toolbar-row .sources-btn { padding: 0 var(--omp-space-3, 12px) !important; width: auto !important; font-size: 10px; }
      .toolbar-row .dsk-btn { padding: 0 var(--omp-space-3, 12px) !important; width: auto !important; font-size: 10px; }
      .rate-row { display: flex; gap: 4px; }
      .rate-row omp-button { width: 32px; height: 28px; font-size: 10px; }

      /* Dynamische PIP-Preset-Reihe (Nutzerauftrag 2026-09-04, ersetzt
         den vormals einzelnen PIP-Button) — je Preset ein "Mixer"-Knopf
         + ein kleiner Stift zum Bearbeiten, plus "+" für ein neues. */
      .pip-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .pip-chip { display: inline-flex; align-items: center; gap: 2px; }
      .pip-chip omp-button.pip-name {
        min-width: 60px; max-width: 120px; height: 36px; font-size: 10px;
        padding: 0 8px !important; width: auto !important;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pip-chip omp-button.pip-edit { width: 26px !important; height: 26px !important; font-size: 11px; padding: 0; }
      .pip-row omp-button.pip-add { width: 36px !important; height: 36px !important; font-size: 16px; padding: 0; }

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
        display: inline-flex; align-items: center; gap: 3px; height: 40px;
        padding: 0 4px 0 10px; font-size: 11px;
        background: var(--omp-surface-raised, #22262b);
        border: 1px solid var(--omp-border, #2e3338); border-radius: var(--omp-radius, 6px);
      }
      .pin-chip .label { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pin-chip omp-button { width: 32px !important; height: 32px !important; font-size: 13px; padding: 0; }
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
    // — eigene PGM/PST/Quellen/Keyer/PIP/Transition-Konsole. Gibt
    // `{ bankRow, refresh }` zurück (`bankRow` ist ein Fragment, s.
    // Moduldoku "Konsole verschmolzen" — kein eigenes `<omp-panel-
    // section>` mehr); `refresh` erwartet `workflowOwnSenderIds`/
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

      // Manueller T-Bar (s. Moduldoku): eigener, schlanker Aufruf OHNE
      // automatisches `refresh()` danach — bei pointermove-Takt würde
      // das gemeinsame `call()` das ganze Panel unnötig oft neu
      // aufbauen und den Fader dabei sichtbar ruckeln lassen.
      const sendTransitionPosition = (pos) =>
        fetch(`/api/v1/nodes/${nodeId}/methods/${prefixed("crosspoint.setTransitionPosition")}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: pos }),
        });

      const bankRow = document.createElement("div");
      bankRow.className = "bank-row";
      const gutter = document.createElement("div");
      gutter.className = "bank-gutter";
      if (levelCount > 1) gutter.textContent = String(level + 1);
      const content = document.createElement("div");
      content.className = "bank-content";
      bankRow.append(gutter, content);

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

      // Kompakte Werkzeugleiste (s. Moduldoku "Quellen/DSK/PIP-Auswahl in
      // Dialoge verschoben"): "Quellen"-Taste öffnet Pin/Unpin + DSK-Wahl,
      // DSK-Toggle bleibt als Ein/Aus-Taste direkt sichtbar (kein Grund,
      // die Häufigkeit "DSK an/aus" hinter einem Dialog zu verstecken),
      // Rate-Wahl unverändert.
      const toolbarRow = document.createElement("div");
      toolbarRow.className = "toolbar-row";
      const sourcesBtn = document.createElement("omp-button");
      sourcesBtn.className = "sources-btn";
      sourcesBtn.textContent = "Quellen";
      sourcesBtn.title = "Quellen anpinnen/entfernen, DSK-Quelle wählen";
      const keyerBtn = document.createElement("omp-button");
      keyerBtn.className = "dsk-btn";
      keyerBtn.textContent = "DSK";
      keyerBtn.setAttribute("color", "onair");
      const rateRow = document.createElement("div");
      rateRow.className = "rate-row";
      toolbarRow.append(sourcesBtn, keyerBtn, rateRow);

      const pipRow = document.createElement("div");
      pipRow.className = "pip-row";
      const pipAddBtn = document.createElement("omp-button");
      pipAddBtn.className = "pip-add";
      pipAddBtn.textContent = "+";
      pipAddBtn.title = "Neues PIP-Preset anlegen";

      buses.append(pgmRow, pstRow, toolbarRow, pipRow);

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
      content.append(console_);

      cutBtn.addEventListener("click", () => call("crosspoint.cut"));
      autoBtn.addEventListener("click", () => {
        call("crosspoint.autoTrans");
        animateTBar();
      });

      // Manueller T-Bar (s. Moduldoku): `tBarDragging` verhindert, dass
      // `refresh()`s 2-s-Poll den Wert unter dem gerade ziehenden Finger
      // wegreißt; `tBarAnimation` (unten) schützt zusätzlich während der
      // rein kosmetischen AUTO-Animation.
      let tBarDragging = false;
      tBar.addEventListener("input", () => {
        tBarDragging = true;
        sendTransitionPosition(tBar.value);
      });
      tBar.addEventListener("change", () => {
        // Letzter Wert nochmal senden (Pointer-Up kann exakt zwischen
        // zwei `input`-Events liegen), danach erst wieder für
        // Server-Updates öffnen.
        sendTransitionPosition(tBar.value).finally(() => {
          tBarDragging = false;
          refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds);
        });
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

      let keyerEnabled = false;
      keyerBtn.addEventListener("click", () => call("keyer.setEnabled", { enabled: !keyerEnabled }));

      // Laufender Stand für den "Quellen"-Dialog + den PIP-Editor —
      // `refresh()` hält diese aktuell, die Dialoge lesen sie beim
      // Öffnen (kein eigener Fetch nötig, gleicher Cache-Gedanke wie
      // beim vormaligen Inline-"+"-Picker).
      let latestInputs = [];
      let latestPinned = [];
      let latestKeyerInputs = [];
      let latestKeyerSource = "";
      let latestPipPresets = [];
      let latestActivePipPresetId = "";
      let latestPipEnabled = false;
      let lastWorkflowOwnSenderIds = new Set();
      let lastOtherLevelSenderIds = new Set();

      // "Quellen"-Dialog (Nutzerauftrag 2026-09-04, s. Moduldoku):
      // ersetzt die frühere Inline-SRC-Reihe (+/×) + das nackte
      // DSK-<select> — identische Logik, nur jetzt in einem Modal.
      sourcesBtn.addEventListener("click", () => {
        const { bodyEl } = openModal("Quellen & DSK");

        const pinnedSection = document.createElement("div");
        pinnedSection.className = "field";
        const pinnedLabel = document.createElement("label");
        pinnedLabel.textContent = "Angepinnte Quellen (PGM/PST-Kreuzschiene)";
        const pinnedList = document.createElement("div");
        pinnedList.className = "list";
        pinnedSection.append(pinnedLabel, pinnedList);

        const renderPinnedList = () => {
          pinnedList.innerHTML = "";
          if (latestPinned.length === 0) {
            const hint = document.createElement("p");
            hint.className = "empty";
            hint.textContent = "keine Quellen angeheftet";
            pinnedList.append(hint);
          }
          for (const senderId of latestPinned) {
            const input = latestInputs.find((i) => i.senderId === senderId);
            const chip = document.createElement("div");
            chip.className = "chip";
            const label = document.createElement("span");
            label.className = "label";
            label.textContent = input ? input.label : "unbekannt";
            label.title = senderId;
            const removeBtn = document.createElement("omp-button");
            removeBtn.textContent = "×";
            removeBtn.title = "Quelle entfernen";
            removeBtn.addEventListener("click", async () => {
              await call("crosspoint.unpin", { senderId });
              latestPinned = latestPinned.filter((s) => s !== senderId);
              renderPinnedList();
            });
            chip.append(label, removeBtn);
            pinnedList.append(chip);
          }
          const addRow = document.createElement("div");
          addRow.className = "row";
          const available = latestInputs
            .filter((i) => !latestPinned.includes(i.senderId))
            .map((i) => ({ label: i.label, senderId: i.senderId }));
          const picker = document.createElement("select");
          buildGroupedOptions(picker, available, lastWorkflowOwnSenderIds, "Quelle hinzufügen…");
          picker.addEventListener("change", async () => {
            if (!picker.value) return;
            await call("crosspoint.pin", { senderId: picker.value });
            latestPinned = [...latestPinned, picker.value];
            renderPinnedList();
          });
          addRow.append(picker);
          pinnedList.append(addRow);
        };
        renderPinnedList();

        const dskSection = document.createElement("div");
        dskSection.className = "field";
        const dskLabel = document.createElement("label");
        dskLabel.textContent = "DSK-Quelle (Fill+Key)";
        const dskSelect = document.createElement("select");
        buildGroupedOptions(dskSelect, latestKeyerInputs, lastWorkflowOwnSenderIds, "Testfarbe");
        dskSelect.value = latestKeyerSource;
        dskSelect.addEventListener("change", () => {
          call("keyer.setSource", { senderId: dskSelect.value });
          latestKeyerSource = dskSelect.value;
        });
        dskSection.append(dskLabel, dskSelect);

        bodyEl.append(pinnedSection, dskSection);
      });

      // PIP-Editor (Nutzerauftrag 2026-09-04, s. Moduldoku) — `preset`
      // ist entweder ein bestehendes Preset (Bearbeiten) oder `null`
      // (Neuanlage mit `PIP_BOX_DEFAULT`).
      const openPipEditor = (preset) => {
        const draft = preset
          ? { id: preset.id, name: preset.name, senderId: preset.senderId || "", box: { ...preset.box } }
          : {
              id: newPresetId(),
              name: `PIP ${latestPipPresets.length + 1}`,
              senderId: "",
              box: { ...PIP_BOX_DEFAULT },
            };

        // `onClose` (statt nur `close`s Aufrufer) fängt JEDEN Schließweg
        // ab — Backdrop-Klick/Escape rufen intern `close()` selbst auf,
        // "Abbrechen"/"Speichern"/"Löschen" unten rufen das zurückgegebene
        // `close` — beide Wege müssen die window-Listener unten abräumen.
        const { bodyEl, close } = openModal(preset ? "PIP-Preset bearbeiten" : "Neues PIP-Preset", {
          onClose: () => cleanup(),
        });

        const nameField = document.createElement("div");
        nameField.className = "field";
        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = draft.name;
        nameInput.addEventListener("input", () => (draft.name = nameInput.value));
        nameField.append(nameLabel, nameInput);

        const sourceField = document.createElement("div");
        sourceField.className = "field";
        const sourceLabel = document.createElement("label");
        sourceLabel.textContent = "Quelle";
        const sourceSelect = document.createElement("select");
        const pipInputEntries = latestInputs.map((i) => ({ label: i.label, senderId: i.senderId }));
        buildGroupedOptions(sourceSelect, pipInputEntries, lastWorkflowOwnSenderIds, "Schwarz");
        sourceSelect.value = draft.senderId;
        sourceSelect.addEventListener("change", () => (draft.senderId = sourceSelect.value));
        sourceField.append(sourceLabel, sourceSelect);

        const editorField = document.createElement("div");
        editorField.className = "field";
        const editorLabel = document.createElement("label");
        editorLabel.textContent = "Größe & Position (ziehen zum Verschieben, Ecke zum Skalieren)";
        const canvasOuter = document.createElement("div");
        canvasOuter.className = "pip-editor-canvas-outer";
        const scale = PIP_EDITOR_WIDTH / WIDTH;
        const editorHeight = Math.round(HEIGHT * scale);
        const canvas = document.createElement("div");
        canvas.className = "pip-editor-canvas";
        canvas.style.width = `${PIP_EDITOR_WIDTH}px`;
        canvas.style.height = `${editorHeight}px`;
        const box = document.createElement("div");
        box.className = "pip-editor-box";
        const resizeHandle = document.createElement("div");
        resizeHandle.className = "pip-editor-resize";
        box.append(resizeHandle);
        canvas.append(box);
        canvasOuter.append(canvas);
        editorField.append(editorLabel, canvasOuter);

        const renderBox = () => {
          box.style.left = `${Math.round(draft.box.x * scale)}px`;
          box.style.top = `${Math.round(draft.box.y * scale)}px`;
          box.style.width = `${Math.round(draft.box.width * scale)}px`;
          box.style.height = `${Math.round(draft.box.height * scale)}px`;
        };
        renderBox();

        // Drag/Resize — gleiches Muster wie
        // nodes/omp-multiviewer-custom/ui/bundle.js#_onPipPointerDown/
        // _onPointerMove/_onPointerUp (dort ausführlicher kommentiert),
        // hier auf eine einzige Box vereinfacht; Listener nur, solange
        // dieses Modal offen ist (`close()` unten räumt sie ab).
        let drag = null;
        const onPointerDown = (mode) => (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          drag = {
            mode,
            startScreenX: ev.clientX,
            startScreenY: ev.clientY,
            startX: draft.box.x,
            startY: draft.box.y,
            startWidth: draft.box.width,
            startHeight: draft.box.height,
          };
        };
        const onPointerMove = (ev) => {
          if (!drag) return;
          const dx = Math.round((ev.clientX - drag.startScreenX) / scale);
          const dy = Math.round((ev.clientY - drag.startScreenY) / scale);
          if (drag.mode === "move") {
            draft.box.x = clamp(drag.startX + dx, 0, Math.max(0, WIDTH - draft.box.width));
            draft.box.y = clamp(drag.startY + dy, 0, Math.max(0, HEIGHT - draft.box.height));
          } else {
            draft.box.width = clamp(drag.startWidth + dx, PIP_MIN_SIZE, WIDTH - draft.box.x);
            draft.box.height = clamp(drag.startHeight + dy, PIP_MIN_SIZE, HEIGHT - draft.box.y);
          }
          renderBox();
        };
        const onPointerUp = () => {
          drag = null;
        };
        box.addEventListener("pointerdown", onPointerDown("move"));
        resizeHandle.addEventListener("pointerdown", onPointerDown("resize"));
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);

        const actions = document.createElement("div");
        actions.className = "actions";
        if (preset) {
          const deleteBtn = document.createElement("omp-button");
          deleteBtn.textContent = "Löschen";
          deleteBtn.addEventListener("click", async () => {
            if (!confirm(`PIP-Preset "${preset.name}" wirklich löschen?`)) return;
            await call("pip.deletePreset", { id: preset.id });
            close();
          });
          actions.append(deleteBtn);
        }
        const spacer = document.createElement("div");
        spacer.className = "spacer";
        const cancelBtn = document.createElement("omp-button");
        cancelBtn.textContent = "Abbrechen";
        cancelBtn.addEventListener("click", close);
        const saveBtn = document.createElement("omp-button");
        saveBtn.textContent = "Speichern & Anzeigen";
        saveBtn.addEventListener("click", async () => {
          const name = draft.name.trim() || `PIP ${latestPipPresets.length + 1}`;
          await call("pip.savePreset", {
            id: draft.id,
            name,
            senderId: draft.senderId,
            x: draft.box.x,
            y: draft.box.y,
            width: draft.box.width,
            height: draft.box.height,
          });
          await call("pip.applyPreset", { id: draft.id });
          close();
        });
        actions.append(spacer, cancelBtn, saveBtn);

        bodyEl.append(nameField, sourceField, editorField, actions);

        // Läuft über `openModal`s `onClose`-Hook oben, egal auf welchem
        // Weg das Modal schließt (Backdrop/Escape/Abbrechen/Speichern/
        // Löschen) — sonst blieben die window-Listener nach dem
        // Schließen aktiv (Leck + Doppel-Drag beim nächsten Öffnen).
        const cleanup = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
        };
      };

      pipAddBtn.addEventListener("click", () => openPipEditor(null));

      const renderPipRow = () => {
        pipRow.innerHTML = "";
        for (const preset of latestPipPresets) {
          const chip = document.createElement("span");
          chip.className = "pip-chip";
          const nameBtn = document.createElement("omp-button");
          nameBtn.className = "pip-name";
          nameBtn.textContent = preset.name;
          const isActive = latestPipEnabled && preset.id === latestActivePipPresetId;
          nameBtn.active = isActive;
          nameBtn.setAttribute("color", "preset");
          nameBtn.addEventListener("click", () => {
            if (isActive) call("pip.setEnabled", { enabled: false });
            else call("pip.applyPreset", { id: preset.id });
          });
          const editBtn = document.createElement("omp-button");
          editBtn.className = "pip-edit";
          editBtn.textContent = "✎";
          editBtn.title = "Preset bearbeiten";
          editBtn.addEventListener("click", () => openPipEditor(preset));
          chip.append(nameBtn, editBtn);
          pipRow.append(chip);
        }
        pipRow.append(pipAddBtn);
      };

      const refresh = async (workflowOwnSenderIds, otherLevelSenderIds) => {
        lastWorkflowOwnSenderIds = workflowOwnSenderIds;
        lastOtherLevelSenderIds = otherLevelSenderIds;
        const [
          inputsRes, programRes, presetRes, keyerRes, keyerInputsRes, keyerSourceRes,
          pipEnabledRes, pipPresetsRes, pipActivePresetRes, pinnedRes, transRateRes, transitionPositionRes,
        ] = await Promise.all([
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.inputs")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.programInput")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.presetInput")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.enabled")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.inputs")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("keyer.source")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.enabled")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.presets")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.activePresetId")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.pinnedSenderIds")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.transRate")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.transitionPosition")}`),
        ]);
        if (!inputsRes.ok || !programRes.ok || !presetRes.ok) return;
        const inputs = (await inputsRes.json()).value || [];
        const program = (await programRes.json()).value || "";
        const preset = (await presetRes.json()).value || "";
        keyerEnabled = keyerRes.ok ? (await keyerRes.json()).value === true : false;
        const keyerInputs = keyerInputsRes.ok ? (await keyerInputsRes.json()).value || [] : [];
        const keyerSource = keyerSourceRes.ok ? (await keyerSourceRes.json()).value || "" : "";
        latestPipEnabled = pipEnabledRes.ok ? (await pipEnabledRes.json()).value === true : false;
        latestPipPresets = pipPresetsRes.ok ? (await pipPresetsRes.json()).value || [] : [];
        latestActivePipPresetId = pipActivePresetRes.ok ? (await pipActivePresetRes.json()).value || "" : "";
        const pinned = pinnedRes.ok ? (await pinnedRes.json()).value || [] : [];
        const transRateFrames = transRateRes.ok ? (await transRateRes.json()).value || 0 : 0;
        const transitionPosition = transitionPositionRes.ok ? (await transitionPositionRes.json()).value || 0 : 0;
        if (transRateFrames > 0) {
          currentTransRateMs = transRateFrames * MS_PER_TRANS_FRAME;
          for (const [frames, btn] of rateButtons) btn.active = frames === transRateFrames;
        }
        // Server-Rückstellung (s. Moduldoku "Manueller T-Bar") — nur
        // übernehmen, wenn gerade WEDER von Hand gezogen NOCH die
        // AUTO-Kosmetik-Animation läuft (sonst reißt der 2-s-Poll den
        // sichtbaren Wert weg).
        if (!tBarDragging && !tBarAnimation) tBar.value = transitionPosition;
        latestInputs = inputs;
        latestPinned = pinned;
        latestKeyerInputs = keyerInputs;
        latestKeyerSource = keyerSource;

        renderPipRow();

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
          empty.textContent = "keine Quellen angeheftet — über den Quellen-Dialog hinzufügen";
          pstButtons.append(empty);
        }
        const levelOutputSenderIds = level === 0 ? otherLevelSenderIds : undefined;
        renderBusRow(call, pgmButtons, entries, workflowOwnSenderIds, true, program, "onair", levelOutputSenderIds);
        renderBusRow(call, pstButtons, entries, workflowOwnSenderIds, false, preset, "preset", levelOutputSenderIds);

        keyerBtn.active = keyerEnabled;
      };

      return { bankRow, refresh };
    };

    const banks = [];
    for (let level = 0; level < levelCount; level++) banks.push(buildBank(level));

    const consoleList = document.createElement("div");
    consoleList.className = "console-list";
    for (const b of banks) consoleList.append(b.bankRow);
    const consoleSection = document.createElement("omp-panel-section");
    consoleSection.setAttribute("label", "Video Mixer M/E");
    consoleSection.append(consoleList);

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
    // Bank — bleibt daher außerhalb der Ebenen-Schleife oben. Nimmt seit
    // 2026-09-04 auch die PIP-Presets jeder Ebene mit (main.rs::
    // capture_level_state).
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
      consoleSection,
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
