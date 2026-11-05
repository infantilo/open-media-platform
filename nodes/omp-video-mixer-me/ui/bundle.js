// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
// Instanz-Kurz-ID ("Source (3f2a1b9c)") ist für den Operator nebensächlich → nur in der Anzeige weglassen.
// Bestätigung immer über das Kit-Element <omp-confirm> (nie window.confirm/alert/prompt); ohne Element: ablehnen.
const confirmDialog = (message, confirmLabel) => new Promise((resolve) => {
  if (!customElements.get("omp-confirm")) return resolve(false);
  const el = document.createElement("omp-confirm");
  el.textContent = message;
  if (confirmLabel) el.setAttribute("confirm-label", confirmLabel);
  el.addEventListener("resolve", (ev) => { resolve(ev.detail); el.remove(); }, { once: true });
  document.body.appendChild(el);
});
// Texteingabe als Modal (nie window.prompt): löst mit dem Text oder null (Abbrechen/Esc/Hintergrund) auf.
const promptDialog = (title, initial, okLabel, cancelLabel) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const { bodyEl, close } = openModal(title, { onClose: () => finish(null) });
  const input = document.createElement("input");
  input.type = "text";
  input.value = initial || "";
  input.style.cssText = "width:100%;box-sizing:border-box;";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
  const cancel = document.createElement("omp-button");
  cancel.textContent = cancelLabel;
  cancel.addEventListener("click", () => close());
  const ok = document.createElement("omp-button");
  ok.textContent = okLabel;
  const submit = () => { const v = input.value.trim(); if (!v) return; finish(v); close(); };
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
  row.append(cancel, ok);
  bodyEl.append(input, row);
  input.focus();
  input.select();
});
// Fehlermeldung als <omp-toast> (nie window.alert).
const toastError = (message) => {
  const el = document.createElement("omp-toast");
  el.setAttribute("data-role", "toast");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
};
const shortLabel = (s) => String(s ?? "").replace(/\s*\([0-9a-f]{8}\)/g, "");
const T = (() => {
  const D = {
    de: {
      "close": "Schließen (Esc)",
      "closeAria": "Schließen",
      "noPicture": "kein Bild",
      "mismatch": "Abweichendes Format: {format} — Mixer: {own}",
      "takeAnyway": "Trotzdem schalten",
      "groupSources": "Quellen",
      "groupPip": "PIP-Szenen",
      "pipNew": "Neue Szene",
      "freezeLabel": "❄ FREEZE",
      "freezeTitle": "Aktuelles PGM-Bild als Standbild aufnehmen (erscheint als Quelle, auch für PIP)",
      "freezes": "Freezes (Standbilder)",
      "noFreezes": "Noch keine Freezes — mit ❄ FREEZE das PGM-Bild aufnehmen.",
      "rename": "Umbenennen",
      "freezeName": "Name des Freezes",
      "confirmDeleteFreeze": "Freeze „{name}“ löschen?",
      "pstOfLevel": "PST Ebene {n}",
      "pstGroup": "Mischer-Preset (folgt dem Preset-Bus)",
      "sourceProblem": "Quelle meldet ein Problem: {text}",
      "confirmTake": "Die Quelle „{label}“ meldet ein Problem: {text} — Trotzdem auf Programm schalten?",
      "mixerLevels": "Mischerebenen",
      "ownWorkflow": "Dieser Workflow",
      "otherSources": "Andere Quellen",
      "sources": "Quellen",
      "sourcesTitle": "Quellen anpinnen/entfernen, DSK-Quelle wählen",
      "pipAddTitle": "Neues PIP-Preset anlegen",
      "swapLabel": "⇄ PGM/PST",
      "swapTitle": "Nach CUT/AUTO/T-Bar tauschen PGM und PST: das bisherige Programm wird zum Preset (Hot-Take auf PGM lässt das Preset unverändert)",
      "kindMix": "Überblendung",
      "kindVfade": "Über Schwarz (ausgehendes Bild blendet ab, neues auf)",
      "kindFadecut": "Ausgehendes Bild blendet auf Schwarz, dann steht das neue hart da",
      "kindCutfade": "Hart auf Schwarz, das neue Bild blendet auf",
      "slideWhat": "Slide: neues Bild fährt über das alte,",
      "pushWhat": "Push: neues Bild schiebt das alte hinaus,",
      "dirRight": "nach rechts",
      "dirLeft": "nach links",
      "dirDown": "nach unten",
      "dirUp": "nach oben",
      "rampTitle": "Rampendauer: {frames} Frames ({ms}ms)",
      "pinned": "Angepinnte Quellen (PGM/PST-Kreuzschiene)",
      "nonePinned": "keine Quellen angeheftet",
      "removeSource": "Quelle entfernen",
      "moveFront": "Nach vorn (links)",
      "moveBack": "Nach hinten (rechts)",
      "addSource": "Quelle hinzufügen…",
      "dskSource": "DSK-Quelle (Fill+Key)",
      "name": "Name",
      "source": "Quelle",
      "black": "Schwarz",
      "pipPoints": "Fahrt: Start → Halten → Ende (+ Fokus)",
      "ptStart": "Start",
      "ptHold": "Halten",
      "ptEnd": "Ende",
      "usePosition": "{text}-Position verwenden",
      "slideIn": "Einfahrt ",
      "slideOut": "Ausfahrt ",
      "outside": "Außerhalb:",
      "edgeLeft": "◀ links",
      "edgeRight": "rechts ▶",
      "edgeTop": "▲ oben",
      "edgeBottom": "unten ▼",
      "editorHint": "Ziehen zum Verschieben, Quadrat unten rechts zum Skalieren, Kreise zum Verzerren (2D-Slots)",
      "hint0": "Ohne Start/Ende erscheint PIP direkt an der Haltposition.",
      "hint3": "3 Punkte: fährt von Start nach Halten; beim Ausschalten von Halten nach Ende.",
      "hint2s": "2 Punkte: fährt von Start nach Halten; beim Ausschalten zurück nach Start.",
      "hint2e": "Beim Ausschalten fährt PIP von Halten nach Ende.",
      "delete": "Löschen",
      "cancel": "Abbrechen",
      "confirmDelete": "PIP-Preset \"{name}\" wirklich löschen?",
      "saveOnly": "Nur speichern",
      "saveOnlyTitle": "Preset speichern, ohne es zu aktivieren",
      "saveShow": "Speichern & Anzeigen",
      "saveShowTitle": "Preset speichern und sofort einfahren",
      "editPreset": "Preset bearbeiten",
      "editTitle": "PIP-Szene bearbeiten",
      "newTitle": "Neue PIP-Szene",
      "emptyPinned": "keine Quellen angeheftet — über den Quellen-Dialog hinzufügen",
      "slotN": "Slot {n}",
      "addSlot": "Weiteren PIP-Slot zur Szene hinzufügen",
      "removeSlot": "Diesen Slot aus der Szene entfernen",
      "zLabel": "Ebene (z)",
      "zTitle": "Höhere Zahl liegt weiter vorn",
      "ptFocus": "Fokus",
      "rotation": "Drehung",
      "resetCorners": "Ecken zurücksetzen",
      "resetCornersTitle": "Wieder ein gerades Rechteck (umschließender Rahmen)",
      "twoDHint": "Ecken ziehen = Trapez/Perspektive",
      "noTwoD": "Dieser Slot kann nur gerade Rechtecke (Drehung/Trapez nur in 2D-Slots)",
      "monitor": "PGM-Monitor",
      "groupMonitor": "Monitor",
      "monitorTitle": "PGM-Bild anzeigen: Klick auf ein PIP fährt es in den Fokus, erneuter Klick zurück",
      "monitorEmpty": "kein Bild",
      "focusHint": "Klick auf ein PIP = Fokus an/aus",
      "levels": "Ebenen",
      "apply": "Übernehmen",
      "applyTitle": "Node neu starten — kurz nicht erreichbar, zuvor aufgelegte Quellen werden danach automatisch wieder verbunden.",
      "confirmRestart": "Rolle \"{role}\" mit {n} Ebene(n) neu starten? Der Node ist dabei kurz nicht erreichbar, zuvor aufgelegte Quellen werden danach automatisch wieder verbunden.",
      "restartFailed": "Neustart fehlgeschlagen: {err}",
      "savePreset": "Preset speichern",
      "noPresets": "keine Presets gespeichert",
      "applyPreset": "Preset anwenden",
      "promptName": "Name des Presets:",
      "newPresetName": "Neues Preset",
      "thumbnails": "Vorschaubilder",
      "skinNew": "Konsole 2 ▸",
      "skinClassic": "◂ Klassisch",
      "skinTip": "Optik umschalten (nur Darstellung)"
  },
    en: {
      "close": "Close (Esc)",
      "closeAria": "Close",
      "noPicture": "no picture",
      "mismatch": "Different format: {format} — mixer: {own}",
      "takeAnyway": "Take anyway",
      "groupSources": "Sources",
      "groupPip": "PIP scenes",
      "pipNew": "New scene",
      "freezeLabel": "❄ FREEZE",
      "freezeTitle": "Capture the current program picture as a still (appears as a source, also for PIP)",
      "freezes": "Freezes (stills)",
      "noFreezes": "No freezes yet — use ❄ FREEZE to capture the program picture.",
      "rename": "Rename",
      "freezeName": "Freeze name",
      "confirmDeleteFreeze": "Delete freeze \"{name}\"?",
      "pstOfLevel": "PST level {n}",
      "pstGroup": "Mixer preset (follows the preset bus)",
      "sourceProblem": "Source reports a problem: {text}",
      "confirmTake": "The source \"{label}\" reports a problem: {text} — Take it to program anyway?",
      "mixerLevels": "Mixer levels",
      "ownWorkflow": "This workflow",
      "otherSources": "Other sources",
      "sources": "Sources",
      "sourcesTitle": "Pin/remove sources, choose DSK source",
      "pipAddTitle": "Create a new PIP preset",
      "swapLabel": "⇄ PGM/PST",
      "swapTitle": "After CUT/AUTO/T-bar, PGM and PST swap: the previous programme becomes the preset (a hot take on PGM leaves the preset unchanged)",
      "kindMix": "Dissolve",
      "kindVfade": "Via black (outgoing picture fades out, new one fades in)",
      "kindFadecut": "Outgoing picture fades to black, then the new one cuts in",
      "kindCutfade": "Hard cut to black, the new picture fades in",
      "slideWhat": "Slide: new picture slides over the old one,",
      "pushWhat": "Push: new picture pushes the old one out,",
      "dirRight": "to the right",
      "dirLeft": "to the left",
      "dirDown": "downwards",
      "dirUp": "upwards",
      "rampTitle": "Ramp duration: {frames} frames ({ms}ms)",
      "pinned": "Pinned sources (PGM/PST crosspoint)",
      "nonePinned": "no sources pinned",
      "removeSource": "Remove source",
      "moveFront": "Move forward (left)",
      "moveBack": "Move back (right)",
      "addSource": "Add source…",
      "dskSource": "DSK source (fill+key)",
      "name": "Name",
      "source": "Source",
      "black": "Black",
      "pipPoints": "Move: start → hold → end (+ focus)",
      "ptStart": "Start",
      "ptHold": "Hold",
      "ptEnd": "End",
      "usePosition": "Use {text} position",
      "slideIn": "Slide in ",
      "slideOut": "Slide out ",
      "outside": "Outside:",
      "edgeLeft": "◀ left",
      "edgeRight": "right ▶",
      "edgeTop": "▲ top",
      "edgeBottom": "bottom ▼",
      "editorHint": "Drag to move, square bottom right to resize, circles to distort (2D slots)",
      "hint0": "Without start/end the PIP appears directly at the hold position.",
      "hint3": "3 points: moves from start to hold; when switched off from hold to end.",
      "hint2s": "2 points: moves from start to hold; when switched off back to start.",
      "hint2e": "When switched off the PIP moves from hold to end.",
      "delete": "Delete",
      "cancel": "Cancel",
      "confirmDelete": "Really delete PIP preset \"{name}\"?",
      "saveOnly": "Save only",
      "saveOnlyTitle": "Save the preset without activating it",
      "saveShow": "Save & show",
      "saveShowTitle": "Save the preset and show it immediately",
      "editPreset": "Edit preset",
      "editTitle": "Edit PIP scene",
      "newTitle": "New PIP scene",
      "emptyPinned": "no sources pinned — add them via the sources dialog",
      "slotN": "Slot {n}",
      "addSlot": "Add another PiP slot to the scene",
      "removeSlot": "Remove this slot from the scene",
      "zLabel": "Layer (z)",
      "zTitle": "Higher numbers sit in front",
      "ptFocus": "Focus",
      "rotation": "Rotation",
      "resetCorners": "Reset corners",
      "resetCornersTitle": "Back to a straight rectangle (bounding frame)",
      "twoDHint": "Drag corners = trapezoid/perspective",
      "noTwoD": "This slot only does straight rectangles (rotation/trapezoid need a 2D slot)",
      "monitor": "PGM monitor",
      "groupMonitor": "Monitor",
      "monitorTitle": "Show the PGM picture: click a PiP to bring it into focus, click again to send it back",
      "monitorEmpty": "no picture",
      "focusHint": "Click a PiP = focus on/off",
      "levels": "Levels",
      "apply": "Apply",
      "applyTitle": "Restarts the node — briefly unreachable; sources patched in before are reconnected automatically afterwards.",
      "confirmRestart": "Restart role \"{role}\" with {n} level(s)? The node is briefly unreachable; sources patched in before are reconnected automatically afterwards.",
      "restartFailed": "Restart failed: {err}",
      "savePreset": "Save preset",
      "noPresets": "no presets saved",
      "applyPreset": "Apply preset",
      "promptName": "Preset name:",
      "newPresetName": "New preset",
      "thumbnails": "Thumbnails",
      "skinNew": "Console 2 ▸",
      "skinClassic": "◂ Classic",
      "skinTip": "Switch look (display only)"
  },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

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
// Mischer-Auflösung (Koordinatenraum aller PIP-Positionen). Vor Kapitel 87 stand hier fest 640×480, obwohl der Mischer
// meist 1280×720 rechnet — `setCanvas` übernimmt jetzt die echte Größe vom Node (`pip.canvas`).
let WIDTH = 1280;
let HEIGHT = 720;
function setCanvas(w, h) {
  if (w > 0 && h > 0) { WIDTH = w; HEIGHT = h; }
}
const PIP_MIN_SIZE = 32; // wie nodes/omp-multiviewer-custom/ui/bundle.js::MIN_PIP_SIZE, hier dupliziert (kein Framework-Zwang, s. Moduldoku).
const PIP_EDITOR_WIDTH = 340;
const PIP_DEFAULT_MS = 500; // Standarddauer Ein-/Ausfahrt im Editor
// Start/Ende dürfen außerhalb des Bildes liegen (Einfliegen von außen): der
// Editor zeigt deshalb um das Bild einen Rand von PIP_STAGE_MARGIN (Anteil
// von WIDTH/HEIGHT).
const PIP_STAGE_MARGIN = 0.4; // skalierte Editor-Canvas-Breite im Modal, Höhe folgt aus WIDTH/HEIGHT-Verhältnis.

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

// ── Viereck-Geometrie (Kapitel 87): vier Ecken [[x,y]…], oben-links, oben-rechts, unten-rechts, unten-links.
function quadFromBox(b) {
  return [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]];
}
function boundsOf(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
function moveQuad(q, dx, dy) {
  return q.map((p) => [p[0] + dx, p[1] + dy]);
}
// Winkel der Oberkante in Grad (0 = waagerecht, im Uhrzeigersinn positiv).
function quadAngle(q) {
  return (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
}
function rotateQuad(q, deg) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  const s = Math.sin((deg * Math.PI) / 180), c = Math.cos((deg * Math.PI) / 180);
  return q.map((p) => [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c]);
}
function isRect(q) {
  const t = 0.5;
  return Math.abs(q[0][0] - q[3][0]) < t && Math.abs(q[1][0] - q[2][0]) < t && Math.abs(q[0][1] - q[1][1]) < t && Math.abs(q[3][1] - q[2][1]) < t;
}
// Punkt im Viereck (Strahlverfahren) — derselbe Test wie `pip.rs::PipPose::contains`.
function pointInQuad(q, x, y) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    if ((q[i][1] > y) !== (q[j][1] > y) && x < ((q[j][0] - q[i][0]) * (y - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) inside = !inside;
  }
  return inside;
}
// Vorgabe-Fokusposition wie `pip.rs::default_focus_pose`: 94 % des Bildes, mittig, gerade Maße.
function focusBox() {
  const even = (v) => Math.round(v / 2) * 2;
  const w = even(WIDTH * 0.94), h = even(HEIGHT * 0.94);
  return { x: Math.floor((WIDTH - w) / 2), y: Math.floor((HEIGHT - h) / 2), width: w, height: h };
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
// Hintergrund-Klick, Escape oder dem ✕-Button oben rechts; `opts.onClose`
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
      .omp-vmix-modal .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .omp-vmix-modal .close {
        all: unset; cursor: pointer; width: 28px; height: 28px; line-height: 28px; text-align: center;
        border-radius: var(--omp-radius, 6px); color: var(--omp-text-dim, #9aa0a6); font-size: 14px;
      }
      .omp-vmix-modal .close:hover { background: var(--omp-surface-raised, #22262b); color: var(--omp-text, #e8eaed); }
      .omp-vmix-modal .close:focus-visible { outline: 2px solid var(--omp-info, #4285f4); }
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
      .omp-vmix-modal omp-source-selector { display: block; width: 100%; font-size: inherit; }
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
      .omp-vmix-modal .pip-editor-frame {
        position: absolute; box-sizing: border-box; border: 1px dashed var(--omp-text-dim, #9aa0a6);
        background: rgba(255, 255, 255, 0.04); pointer-events: none;
      }
      .omp-vmix-modal .pip-editor-path { position: absolute; left: 0; top: 0; pointer-events: none; }
      .omp-vmix-modal .pip-editor-path polyline { fill: none; stroke: var(--omp-text-dim, #9aa0a6); stroke-width: 1.5; stroke-dasharray: 4 3; }
      .omp-vmix-modal .pip-editor-box {
        position: absolute; box-sizing: border-box; border: 2px solid var(--pt, #43a047);
        background: color-mix(in srgb, var(--pt, #43a047) 22%, transparent); cursor: move; opacity: 0.75;
      }
      .omp-vmix-modal .pip-editor-box.active { opacity: 1; z-index: 2; }
      .omp-vmix-modal .pip-editor-tag {
        position: absolute; left: 2px; top: 1px; font-size: 9px; font-weight: 700; color: var(--pt, #43a047);
        pointer-events: none;
      }
      .omp-vmix-modal .pip-points { gap: 12px; }
      .omp-vmix-modal .pip-point { display: flex; align-items: center; gap: 4px; }
      .omp-vmix-modal .pip-point input[type="checkbox"] { margin: 0; }
      .omp-vmix-modal .pip-point button, .omp-vmix-modal .row button {
        all: unset; cursor: pointer; padding: 6px 10px; border-radius: var(--omp-radius, 6px);
        border: 1px solid var(--omp-border, #2e3338); background: var(--omp-surface-raised, #22262b);
        font-size: 11px;
      }
      .omp-vmix-modal .pip-point button.active { border-color: var(--pt); box-shadow: inset 0 0 0 1px var(--pt); font-weight: 700; }
      .omp-vmix-modal .pip-point button:disabled { opacity: 0.4; cursor: default; }
      .omp-vmix-modal .pip-ms { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--omp-text-dim, #9aa0a6); }
      .omp-vmix-modal .pip-ms input {
        width: 70px; height: 30px; box-sizing: border-box; padding: 0 6px; font-size: 12px;
        color: var(--omp-text, #e8eaed); background: var(--omp-surface-raised, #22262b);
        border: 1px solid var(--omp-border, #2e3338); border-radius: var(--omp-radius, 6px);
      }
      .omp-vmix-modal .pip-edge-label { font-size: 11px; color: var(--omp-text-dim, #9aa0a6); }
      .omp-vmix-modal .pip-tabs { gap: 4px; flex-wrap: wrap; }
      .omp-vmix-modal .pip-tab { display: inline-flex; }
      .omp-vmix-modal .pip-tabs button { padding: 3px 8px; font-size: 11px; cursor: pointer; }
      .omp-vmix-modal .pip-tab button.active { border-color: var(--omp-info, #4285f4); font-weight: 700; }
      .omp-vmix-modal .pip-2d { gap: 10px; align-items: center; flex-wrap: wrap; }
      .omp-vmix-modal .pip-editor-svg { position: absolute; left: 0; top: 0; touch-action: none; }
      .omp-vmix-modal .pip-editor-pathline { fill: none; stroke: var(--omp-text-dim, #9aa0a6); stroke-width: 1.5; stroke-dasharray: 4 3; pointer-events: none; }
      .omp-vmix-modal .pip-editor-resize {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, var(--omp-text-dim, #9aa0a6) 50%);
        touch-action: none;
      }
    </style>
    <div class="backdrop" part="backdrop"></div>
    <div class="dialog" role="dialog" aria-label="${titleText}">
      <div class="head"><h3>${titleText}</h3><button class="close" type="button" title="${T("close")}" aria-label="${T("closeAria")}">✕</button></div>
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
  overlay.querySelector(".close").addEventListener("click", close);
  document.body.appendChild(overlay);
  return { bodyEl, close };
}


// ───── Konsole 2: dichte Pult-Optik (gleicher Stil wie die Audiomischer-Konsole 2) ─────
// Reine Darstellung: Logik, DOM und Kommandos bleiben unverändert. Umschaltbar (Kopf des Panels),
// Wahl in localStorage `omp-mixer-skin` (gemeinsam mit dem Audiomischer: Standard "v2" = neue Optik, "classic" = alt).
const SKIN_KEY = "omp-mixer-skin";
const SKIN_C2_CSS = `
  :host([data-skin="c2"]) {
    --omp-bg: #111; --omp-surface: #1a1a1a; --omp-surface-raised: #222; --omp-border: #2c2c2c;
    --omp-text: #d8dde2; --omp-text-dim: #7d848c; --omp-text-disabled: #555;
    --omp-font: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    --omp-font-size-xs: 10px; --omp-font-size-sm: 11px; --omp-radius: 3px;
    --omp-metal-highlight: #4a4a4a; --omp-metal-light: #383838; --omp-metal-mid: #262626; --omp-metal-dark: #131313;
    --omp-onair: #ff4040; --omp-preset: #25d366; --omp-cue: #ff9f1c; --omp-info: #27e0f0;
    --omp-glow-onair: 0 0 8px 1px rgba(255, 64, 64, 0.55); --omp-glow-preset: 0 0 8px 1px rgba(37, 211, 102, 0.5);
    background: #111; padding: 6px; font-size: 11px; line-height: 1.2; user-select: none;
  }
  :host([data-skin="c2"]) omp-button::part(button) { text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; font-weight: 700; }
  :host([data-skin="c2"]) omp-button[active]:not([color])::part(button) { color: #001a1f; border-color: #46e6f6; }
  :host([data-skin="c2"]) omp-button[active][color="preset"]::part(button) { color: #02150a; }
  :host([data-skin="c2"]) omp-button[active][color="cue"]::part(button) { color: #2a1500; }
  :host([data-skin="c2"]) .bank-row { background: #161616; border: 1px solid #060606; border-radius: 2px; padding: 5px; }
  :host([data-skin="c2"]) .bank-row + .bank-row { margin-top: 4px; border-top: 1px solid #060606; }
  :host([data-skin="c2"]) .bank-gutter { background: #2a2a2a; color: #cfd6dc; border-radius: 2px; width: 16px; }
  :host([data-skin="c2"]) .bus-label {
    width: 38px; height: 22px; padding: 0; margin-top: 4px; display: flex; align-items: center; justify-content: center;
    border-radius: 2px; font-weight: 800; color: #1a0606; background: #ff4040; text-shadow: 0 1px 0 #fff4;
  }
  :host([data-skin="c2"]) .bus-row:nth-child(2) .bus-label { background: #25d366; color: #02150a; }
  :host([data-skin="c2"]) .bus-buttons omp-button { height: 32px; min-width: 64px; }
  :host([data-skin="c2"]) .bus-thumb { border: 1px solid #000; background: #050505; }
  :host([data-skin="c2"]) .bus-buttons .group-label, :host([data-skin="c2"]) .tool-label {
    color: #9aa3ad; letter-spacing: 0.14em; border-left-color: #333; font-weight: 800;
  }
  :host([data-skin="c2"]) .toolbar-row { border-top: 1px solid #2c2c2c; margin-top: 2px; }
  :host([data-skin="c2"]) .tool-group + .tool-group { border-left-color: #2c2c2c; }
  :host([data-skin="c2"]) .transition { border-left: 1px solid #2c2c2c; background: linear-gradient(#202020, #161616); padding: 6px; border-radius: 2px; }
  :host([data-skin="c2"]) .transition omp-button.cut::part(button) { background: linear-gradient(#ff5a5a, #c01f1f); border-color: #000; color: #fff; }
  :host([data-skin="c2"]) .transition omp-button.auto::part(button) { background: linear-gradient(#ffb64d, #d77d00); border-color: #000; color: #241300; }
  :host([data-skin="c2"]) .pin-chip { background: #202020; border-color: #333; }
  :host([data-skin="c2"]) .thumbs-toggle { color: #9aa3ad; }
  .skin-toggle {
    margin-left: auto; height: 22px; padding: 0 9px; border: 1px solid #3a3a3a; border-radius: 3px; cursor: pointer;
    background: linear-gradient(#3a3a3a, #262626); color: #d8dde2; font: 700 10px ui-monospace, Menlo, Consolas, monospace;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .skin-toggle:hover { background: linear-gradient(#444, #2d2d2d); }
  .skin-bar { display: flex; align-items: center; gap: 10px; }
`;
class OmpVideoMixerMePanel extends HTMLElement {
  async connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    // Bugliste 2026-09-25 #6 ("optional einstellbar ... Vorschaubild ...
    // der Operator drückt auf das Bild, das er auf PGM sehen will"):
    // gleiches Muster wie `omp-switcher/ui/bundle.js` (dort ausführlicher
    // kommentiert) — nur für Quellen, deren Node tatsächlich einen
    // `previewUrl`-Stream anbietet, sonst bleibt es beim reinen
    // beschrifteten Knopf.
    const THUMBS_KEY = `omp-vmix-thumbs-${nodeId}`;
    const STREAM_TOKEN_KEY = "omp-auth-token";
    let thumbsEnabled = localStorage.getItem(THUMBS_KEY) === "1";
    const previewSnapshotUrl = (sourceNodeId) => {
      const token = localStorage.getItem(STREAM_TOKEN_KEY);
      const base = `/api/v1/nodes/${sourceNodeId}/stream/previewUrl`;
      const withToken = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
      return `${withToken}${withToken.includes("?") ? "&" : "?"}_=${Date.now()}`;
    };

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
      .bank-row { display: flex; gap: 6px; padding: 4px 0; }
      .bank-row + .bank-row { border-top: 1px solid var(--omp-border, #2e3338); margin-top: 2px; }
      .bank-gutter {
        width: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 700; color: var(--omp-text-dim, #9aa0a6);
      }
      .bank-content { flex: 1; min-width: 0; container-type: inline-size; }

      .console { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 8px; }
      .buses { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .bus-row { display: flex; align-items: flex-start; gap: 4px; }
      .bus-label {
        width: 26px; flex-shrink: 0; padding-top: 7px; font-size: var(--omp-font-size-xs, 11px);
        color: var(--omp-text-dim, #9aa0a6); text-transform: uppercase; font-weight: 700;
        letter-spacing: 0.04em;
      }
      .bus-buttons { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px; min-width: 0; }
      .bus-buttons omp-button {
        min-width: 60px; width: auto; height: 30px; font-size: 10px; line-height: 1.15;
      }
      .bus-buttons omp-button::part(button), .toolbar-row omp-button::part(button),
      .rate-row omp-button::part(button), .transition omp-button::part(button) { padding: 0 6px; }
      /* Bugliste 2026-09-25 #6: Vorschaubild-Karte statt reiner Text-
         Pille — der Operator "drückt auf das Bild" (Nutzerwunsch). */
      .bus-buttons omp-button.with-thumb { width: 88px; height: auto; padding: 0 !important; }
      .bus-buttons omp-button.with-thumb::part(button) { flex-direction: column; padding: 3px !important; gap: 3px; }
      .bus-thumb {
        width: 100%; aspect-ratio: 16/9; border-radius: 3px; overflow: hidden;
        background: #000; position: relative; flex-shrink: 0;
      }
      .bus-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .bus-thumb .no-signal {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 8px; color: var(--omp-text-disabled, #5f6368); text-transform: uppercase; letter-spacing: 0.04em;
      }
      .bus-thumb-label {
        font-size: 9px; line-height: 1.15; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; max-width: 100%;
      }
      .thumbs-toggle {
        display: flex; align-items: center; gap: 5px; cursor: pointer;
        color: var(--omp-text-dim, #9aa0a6); font-size: var(--omp-font-size-xs, 11px);
        user-select: none; margin-bottom: 2px;
      }
      .thumbs-toggle input { width: 14px; height: 14px; accent-color: var(--omp-info, #4285f4); cursor: pointer; }
      .bus-buttons .group-label {
        align-self: center; font-size: 8px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase; color: var(--omp-text-dim, #9aa0a6);
        margin: 0 0 0 4px; padding-left: 3px;
        border-left: 2px solid var(--omp-border, #2e3338);
      }
      .bus-buttons .group-label:first-child { margin-left: 0; }
      .bus-buttons p.empty { align-self: center; margin: 0 0 0 4px; order: 99; } /* Hinweis hinter BLK, nicht davor */

      /* Kompakte Werkzeugleiste (Nutzerauftrag 2026-09-04: "kompakter,
         touch-tauglicher") — ersetzt die frühere Inline-SRC-Reihe +
         DSK-<select>: nur noch je ein Knopf für "Quellen" (öffnet den
         Pin/Unpin+DSK-Dialog), der DSK-Toggle selbst, und die
         Rate-Wahl. */
      .toolbar-row {
        padding-top: 4px;
        border-top: 1px solid var(--omp-border, #2e3338);
        display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;
      }
      /* Drei klar getrennte Gruppen mit Überschrift: Quellen | DSK | PIP-Szenen. */
      .tool-group { display: flex; flex-direction: column; gap: 3px; }
      .tool-group + .tool-group { border-left: 1px solid var(--omp-border, #2e3338); padding-left: 12px; }
      .tool-label {
        font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
        color: var(--omp-text-dim, #9aa0a6);
      }
      .tool-items { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px; }
      /* DSK, PIP-Szenen und "+" sehen aus wie Quellentasten (Pille bzw. Vorschaukarte). */
      .tool-items omp-button.card { min-width: 60px; width: auto; height: 30px; font-size: 10px; line-height: 1.15; }
      .tool-items omp-button.card::part(button) { padding: 0 6px; }
      .tool-items omp-button.card.with-thumb { width: 88px; height: auto; padding: 0 !important; }
      .tool-items omp-button.card.with-thumb::part(button) { flex-direction: column; padding: 3px !important; gap: 3px; }
      .tool-items omp-button.sources-btn { height: 30px; padding: 0 8px !important; width: auto !important; font-size: 10px; }
      .card-thumb-text {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; color: var(--omp-text-dim, #9aa0a6); letter-spacing: 0.04em;
      }
      .pip-box { position: absolute; box-sizing: border-box; border: 1px solid var(--omp-preset, #43a047); background: rgba(67,160,71,0.45); }
      .pip-box.ghost { background: transparent; border-style: dashed; opacity: 0.8; }
      .rate-row { grid-column: 1 / -1; display: flex; gap: 2px; width: 100%; }
      .rate-row omp-button { flex: 1 1 0; min-width: 0; height: 24px; font-size: 10px; }
      .rate-row omp-button::part(button) { padding: 0 1px; }

      /* Dynamische PIP-Preset-Reihe (Nutzerauftrag 2026-09-04, ersetzt
         den vormals einzelnen PIP-Button) — je Preset ein "Mixer"-Knopf
         + ein kleiner Stift zum Bearbeiten, plus "+" für ein neues. */
      .pip-row { display: contents; }
      .pgm-monitor { margin-top: 6px; max-width: 480px; }
      .pgm-monitor-inner { position: relative; width: 100%; background: #000; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; overflow: hidden; user-select: none; }
      .pgm-monitor-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
      .pgm-monitor-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
      .pgm-monitor-overlay .mon-slot { fill: transparent; stroke: rgba(255,255,255,0.35); stroke-width: 3; stroke-dasharray: 10 8; vector-effect: non-scaling-stroke; }
      .pgm-monitor-overlay .mon-slot.hover { stroke: #ffd54f; stroke-dasharray: none; fill: rgba(255,213,79,0.12); }
      .pgm-monitor-overlay .mon-slot.focused { stroke: #ab47bc; }
      .pgm-monitor-hint { font-size: 10px; color: var(--omp-text-dim, #9aa0a6); margin-top: 2px; }
      .pip-chip { display: inline-flex; align-items: flex-start; gap: 2px; }
      .pip-chip omp-button.pip-edit { width: 22px !important; height: 22px !important; font-size: 11px; padding: 0; }

      /* Übergangsblock kompakt (Nutzerauftrag 2026-10-15: "viel kompakter,
         vor allem auf kleineren Bildschirmen"): breit = schmale Spalte
         rechts (CUT|AUTO nebeneinander, kurzer T-Bar, Typ-Tasten in
         dichten Reihen); schmal (Container < 520px) = unter den Bussen,
         T-Bar links neben CUT/AUTO + Typ-Tasten. */
      .transition {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; align-content: start; min-width: 0;
        border-left: 1px solid var(--omp-border, #2e3338); padding-left: 8px;
      }
      .transition omp-button.cut, .transition omp-button.auto { width: 100%; height: 34px; }
      .transition omp-fader { grid-column: 1 / -1; justify-self: center; height: 84px; }
      .mix-wipe { grid-column: 1 / -1; display: flex; gap: 2px; width: 100%; }
      .mix-wipe omp-button { flex: 1 1 0; min-width: 0; height: 24px; font-size: 9px; }
      .mix-wipe omp-button { min-width: 0; }
      .mix-wipe omp-button::part(button) { padding: 0 1px; }
      .transition .swap-btn { grid-column: 1 / -1; height: 24px; font-size: 9px; }
      .wipe-caption { grid-column: 1 / -1; font-size: 8px; line-height: 1; letter-spacing: 0.08em; color: var(--omp-text-dim, #9aa0a6); text-align: center; }
      @container (max-width: 520px) {
        .console { grid-template-columns: 1fr; gap: 4px; }
        .transition {
          grid-template-columns: 44px repeat(2, minmax(0, 1fr)); border-left: 0; padding-left: 0;
          border-top: 1px solid var(--omp-border, #2e3338); padding-top: 4px;
        }
        .transition omp-fader { grid-column: 1; grid-row: 1 / span 7; height: 150px; }
        .transition omp-button.cut, .transition omp-button.auto { grid-column: auto; }
        .mix-wipe, .wipe-caption, .rate-row, .transition .swap-btn { grid-column: 2 / -1; }
      }
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
    style.textContent += SKIN_C2_CSS;

    // Bugfund 2026-09-28 Teil 2 (Nutzermeldung: T("noPicture")-Text ist weg,
    // aber es blitzt weiterhin zyklisch schwarz durch): live per
    // Pixel-genauem `requestAnimationFrame`-Sampling bestätigt (nicht
    // geraten) — direkt nach JEDER `img.src = neueURL`-Zuweisung lief das
    // `<img>` tatsächlich kurz durch `complete=false`/`naturalWidth=0`
    // (Netzwerk-Ladezeit), NICHT durchgehend das alte Bild weiter, wie
    // der bisherige Kommentar unten annahm — die schwarze
    // `.bus-thumb`-Hintergrundfarbe scheint in genau diesem Moment durch,
    // unabhängig davon, dass derselbe `<img>`-Knoten wiederverwendet wird
    // (Nachtrag-295-Fix betraf ein ANDERES, bereits behobenes Problem:
    // Knoten-Neuerzeugung, nicht diesen Lade-Zwischenzustand). Ein
    // simples "Bild vorab laden, dann dieselbe URL zuweisen" hilft NICHT
    // — der Server setzt bewusst `Cache-Control: no-store` (kein
    // veraltetes Bild einer anderen Instanz), eine zweite Zuweisung
    // derselben URL löst deshalb einen zweiten echten Netzwerk-Roundtrip
    // aus. Fix: als Blob laden + Object-URL zuweisen — die Object-URL
    // zeigt auf bereits vollständig im Speicher liegende Daten, das
    // Zuweisen an `img.src` braucht keinen Netzwerk-Wartezustand mehr
    // (das Decodieren eines kleinen Vorschaubilds ist praktisch
    // augenblicklich). `img._previewToken` verhindert, dass eine
    // langsamere ältere Anfrage eine währenddessen bereits fertige
    // neuere überschreibt (z. B. wenn Tally-Events refreshAll() öfter als
    // alle 2s auslösen).
    const loadPreviewImage = async (img, noSignal, url) => {
      const token = (img._previewToken = (img._previewToken || 0) + 1);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (img._previewToken !== token) return; // durch eine neuere Anfrage überholt
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

    // Geteilte, ebenenunabhängige Hilfsfunktionen — je einmal definiert,
    // von jeder Bank (buildBank unten) mit ihrem eigenen `call()`
    // aufgerufen, statt N-fach dupliziert zu werden.
    // Quellen-Gesundheit (BCP-008 `monitor.overallStatus` der Quell-Node): Taste markieren, PGM-Take nachfragen.
    // Cache je Node; Nodes ohne Monitor werden nur selten erneut gefragt.
    const sourceHealth = new Map(); // nodeId -> { severity: "error"|"warn", text } | null
    const sourceHealthAt = new Map(); // nodeId -> { at, hasMonitor }
    const touchSourceHealth = (nodeIds) => {
      for (const id of nodeIds) {
        if (!id || id === nodeId) continue;
        const seen = sourceHealthAt.get(id);
        if (seen && Date.now() - seen.at < (seen.hasMonitor ? 5000 : 60000)) continue;
        sourceHealthAt.set(id, { at: Date.now(), hasMonitor: seen ? seen.hasMonitor : true });
        void (async () => {
          const read = async (p) => {
            try {
              const r = await fetch(`/api/v1/nodes/${id}/params/${p}`);
              return r.ok ? (await r.json()).value : undefined;
            } catch { return undefined; }
          };
          const status = await read("monitor.overallStatus");
          if (typeof status !== "string") {
            sourceHealthAt.set(id, { at: Date.now(), hasMonitor: false });
            sourceHealth.delete(id);
            return;
          }
          sourceHealthAt.set(id, { at: Date.now(), hasMonitor: true });
          if (status !== "Unhealthy" && status !== "PartiallyHealthy") { sourceHealth.set(id, null); return; }
          const texts = [];
          const overall = await read("monitor.overallStatusMessage");
          if (typeof overall === "string" && overall) texts.push(overall);
          else {
            await Promise.all(["transmission", "connection", "essence", "stream", "link"].map(async (d) => {
              const st = await read(`monitor.${d}Status`);
              if (st === undefined || ["Healthy", "AllUp", "Inactive", "NotUsed"].includes(st)) return;
              const m = await read(`monitor.${d}StatusMessage`);
              if (typeof m === "string" && m && !texts.includes(m)) texts.push(m);
            }));
          }
          sourceHealth.set(id, { severity: status === "Unhealthy" ? "error" : "warn", text: texts.join("; ") || status });
        })();
      }
    };

    // Gemeinsame Optik für Quellentaste, DSK und PIP-Szenen: mit Vorschau-Option eine Karte (Thumb + Name), sonst Pille.
    const paintCard = (btn, label, thumbContent) => {
      btn.textContent = "";
      if (thumbsEnabled) {
        btn.classList.add("with-thumb");
        const thumb = document.createElement("div");
        thumb.className = "bus-thumb";
        if (thumbContent) thumb.append(thumbContent);
        const lab = document.createElement("div");
        lab.className = "bus-thumb-label";
        lab.textContent = label;
        btn.append(thumb, lab);
      } else {
        btn.classList.remove("with-thumb");
        btn.textContent = label;
      }
    };
    const cardText = (text) => {
      const d = document.createElement("div");
      d.className = "card-thumb-text";
      d.textContent = text;
      return d;
    };

    const makeBusButton = (call, label, senderId, isProgram, sourceNodeId) => {
      const btn = document.createElement("omp-button");
      const method = isProgram ? "crosspoint.take" : "crosspoint.select";
      btn.addEventListener("click", async () => {
        const h = isProgram && sourceNodeId ? sourceHealth.get(sourceNodeId) : null;
        if (h && h.severity === "error" && !(await confirmDialog(T("confirmTake", { label: shortLabel(label).replace(/^[⛔⚠] /, ""), text: h.text }), T("takeAnyway")))) return;
        call(method, { senderId });
      });

      // BLK (`senderId === ""`) hat kein Bild, bekommt aber bei aktiven
      // Vorschaubildern dieselbe Karte (schwarze Fläche ohne Text), damit
      // alle Tasten der Reihe gleich groß sind (Nutzerwunsch 2026-10-15).
      if (thumbsEnabled) {
        btn.className = "with-thumb";
        const thumb = document.createElement("div");
        thumb.className = "bus-thumb";
        if (sourceNodeId) {
          const img = document.createElement("img");
          img.alt = label;
          img.style.display = "none"; // erst sichtbar, sobald das erste Bild wirklich geladen ist
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = T("noPicture");
          // `.hidden` toggeln reicht hier NICHT (s. Bugfund 2026-09-28
          // Teil 1 oben in der Moduldoku): `.bus-thumb .no-signal {
          // display:flex; }` (Klassen-Selektor) überstimmt die UA-Regel
          // `[hidden]{display:none}` (Attribut-Selektor) immer. Inline
          // `style.display` hat Spezifität 1000 und schlägt jede externe
          // Regel zuverlässig.
          noSignal.style.display = "none";
          void loadPreviewImage(img, noSignal, previewSnapshotUrl(sourceNodeId));
          thumb.append(img, noSignal);
        } else if (senderId) {
          const noSignal = document.createElement("div");
          noSignal.className = "no-signal";
          noSignal.textContent = T("noPicture");
          thumb.append(noSignal);
        }
        const thumbLabel = document.createElement("div");
        thumbLabel.className = "bus-thumb-label";
        thumbLabel.textContent = label;
        btn.append(thumb, thumbLabel);
      } else {
        btn.textContent = label;
      }
      return btn;
    };

    // Bugliste 2026-09-25 Nachtrag ("Thumbnail-Flicker"): `refresh()`
    // pollt alle 2s und rief früher für JEDEN Knopf `makeBusButton` neu
    // auf, was das `<img>` jedes Mal zerstörte und frisch (ohne Bild)
    // neu erzeugte. Fix: ein bestehender Knopf mit gleicher `senderId`
    // wird wiederverwendet, nur das Bild wird neu geladen (s.
    // `loadPreviewImage` oben für den zweiten, 2026-09-28 gefundenen
    // Teil desselben Symptoms — der eigentliche Lade-Zwischenzustand).
    const updateBusButton = (btn, label, senderId, sourceNodeId) => {
      const wantsThumb = thumbsEnabled;
      if (wantsThumb) {
        const img = btn.querySelector("img");
        const noSignal = btn.querySelector(".no-signal");
        if (img && noSignal && sourceNodeId) void loadPreviewImage(img, noSignal, previewSnapshotUrl(sourceNodeId));
        const thumbLabel = btn.querySelector(".bus-thumb-label");
        if (thumbLabel) thumbLabel.textContent = label;
      } else {
        btn.textContent = label;
      }
      return btn;
    };

    // Hierarchischer Quellen-Picker (ui/kit/omp-source-selector.ts) für die
    // Dialog-Dropdowns (Pin-Liste, DSK, PIP): Wert = Sender-ID wie zuvor.
    // `entries` = [{label, senderId}] (die vom Node angebotenen Eingänge);
    // Workflow/Node/grouphint kommen aus einem kurz gecachten Katalog
    // (2 GETs), nicht je Dialog-Öffnung/Neuaufbau.
    let sourceCatalogCache = null; // { at, promise }
    const sourceCatalog = () => {
      if (!sourceCatalogCache || Date.now() - sourceCatalogCache.at > 5000) {
        sourceCatalogCache = {
          at: Date.now(),
          promise: customElements.get("omp-source-selector").loadCatalog(nodeId),
        };
      }
      return sourceCatalogCache.promise;
    };
    const buildSourceSelector = (entries, placeholderLabel) => {
      const el = document.createElement("omp-source-selector");
      el.emptyLabel = placeholderLabel;
      el.accepts = ["video"];
      el.excludeRoles = ["low"];
      // Sofort mit Label-only-Einträgen (kein "nicht verfügbar"-Flackern), dann mit Metadaten.
      // Virtuelle Quellen (`virtual`): vom Mischer selbst aufgelöst (z. B. "pst:N" = Preset-Bus der Ebene N), nicht im Katalog.
      const virt = (e, wf) => ({ id: e.senderId, label: e.label, mediaType: "video", nodeId: "omp-virtual", nodeName: T("pstGroup"), workflowId: wf });
      el.entries = entries.map((e) => (e.virtual ? virt(e) : { id: e.senderId, label: e.label }));
      sourceCatalog().then((catalog) => {
        const byId = new Map(catalog.entries.map((c) => [c.id, c]));
        el.currentWorkflowId = catalog.currentWorkflowId;
        el.entries = entries.map((e) => (e.virtual ? virt(e, catalog.currentWorkflowId) : { ...(byId.get(e.senderId) || { id: e.senderId }), label: e.label }));
      });
      return el;
    };

    // Baut eine Bus-Reihe (PGM oder PST) auf: BLK zuerst, dann (nur
    // Mastereben) die festen Tasten für andere Ebenen-Ausgänge
    // (`levelOutputSenderIds`, s. Moduldoku oben), dann die kuratierte
    // Kreuzschiene gruppiert nach `ownSenderIds` (Workflow-Zugehörigkeit)
    // — nur, wenn tatsächlich beide Gruppen (eigener Workflow + Rest)
    // nicht leer sind, sonst bleibt es bei der bisherigen flachen Liste.
    const renderBusRow = (call, container, entries, ownSenderIds, isProgram, activeId, color, levelOutputSenderIds, senderNodeId) => {
      // Bugliste 2026-09-25 Nachtrag: nur die Knöpfe/Gruppen-Labels
      // dieser Funktion einsammeln+entfernen (NICHT per `container.
      // innerHTML = ""` von außen, s. `refresh()` oben) — so bleiben
      // Knöpfe mit gleicher `senderId` als wiederverwendbare Kandidaten
      // erhalten, bevor sie unten neu einsortiert werden.
      const existingButtons = new Map();
      for (const el of Array.from(container.children)) {
        if (el.tagName === "OMP-BUTTON" && el.dataset.senderId !== undefined) {
          existingButtons.set(el.dataset.senderId, el);
        }
        if (el.tagName === "OMP-BUTTON" || el.classList.contains("group-label")) {
          el.remove();
        }
      }

      const fragment = document.createDocumentFragment();
      const [blk, ...rest] = entries;
      const appendEntry = (entry) => {
        const sourceNodeId = senderNodeId?.get(entry.senderId);
        const reused = existingButtons.get(entry.senderId);
        const wantsThumb = thumbsEnabled;
        const hasImg = !!reused?.querySelector("img");
        const reusable = reused
          && reused.classList.contains("with-thumb") === wantsThumb
          && hasImg === !!(wantsThumb && sourceNodeId);
        // Formatabweichung (Nutzerwunsch 2026-09-30): Quelle hat andere
        // Auflösung/Bildrate als der Mixer — Warnsymbol + Tooltip.
        const health = sourceNodeId ? sourceHealth.get(sourceNodeId) : null;
        const shownLabel = health ? `${health.severity === "error" ? "⛔" : "⚠"} ${entry.label}` : entry.mismatch ? `⚠ ${entry.label}` : entry.label;
        const btn = reusable
          ? updateBusButton(reused, shownLabel, entry.senderId, sourceNodeId)
          : makeBusButton(call, shownLabel, entry.senderId, isProgram, sourceNodeId);
        const tips = [];
        if (health) tips.push(T("sourceProblem", { text: health.text }));
        if (entry.mismatch) tips.push(T("mismatch", { format: entry.format || "?", own: entry.mixerFormat || "?" }));
        if (tips.length) btn.title = tips.join("\n");
        else btn.removeAttribute("title");
        btn.style.boxShadow = health ? `inset 0 0 0 2px ${health.severity === "error" ? "#e74c3c" : "#e0a030"}` : "";
        if (reused) existingButtons.delete(entry.senderId);
        btn.dataset.senderId = entry.senderId;
        btn.active = entry.senderId === activeId;
        btn.setAttribute("color", color);
        fragment.append(btn);
      };
      appendEntry(blk);

      let remaining = rest;
      if (levelOutputSenderIds && levelOutputSenderIds.size > 0) {
        const levelEntries = rest.filter((e) => levelOutputSenderIds.has(e.senderId));
        remaining = rest.filter((e) => !levelOutputSenderIds.has(e.senderId));
        if (levelEntries.length > 0) {
          const levelLabel = document.createElement("div");
          levelLabel.className = "group-label";
          levelLabel.textContent = T("mixerLevels");
          fragment.append(levelLabel);
          for (const entry of levelEntries) appendEntry(entry);
        }
      }

      const own = remaining.filter((e) => ownSenderIds.has(e.senderId));
      const others = remaining.filter((e) => !ownSenderIds.has(e.senderId));
      if (own.length > 0 && others.length > 0) {
        const ownLabel = document.createElement("div");
        ownLabel.className = "group-label";
        ownLabel.textContent = T("ownWorkflow");
        fragment.append(ownLabel);
        for (const entry of own) appendEntry(entry);

        const otherLabel = document.createElement("div");
        otherLabel.className = "group-label";
        otherLabel.textContent = T("otherSources");
        fragment.append(otherLabel);
        for (const entry of others) appendEntry(entry);
      } else {
        for (const entry of remaining) appendEntry(entry);
      }
      container.append(fragment);

      // Übrig gebliebene, NICHT wiederverwendete Knöpfe (ihre `senderId`
      // ist nicht mehr in `entries`) geben ihre Object-URL frei (s.
      // `loadPreviewImage` oben) — sonst häuft sich über eine lange
      // Regie-Sitzung mit wechselnden Quellen langsam ungenutzter
      // Blob-Speicher an, den der Garbage Collector allein NICHT
      // freigibt (Object-URLs sind bis zum expliziten `revokeObjectURL`
      // gültig).
      for (const orphan of existingButtons.values()) {
        const blobUrl = orphan.querySelector("img")?.dataset.blobUrl;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
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
      return { workflowOwnSenderIds, ownSenderIdByLevel, senderNodeId };
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

      // Nicht ebenen-präfigierte Methoden (Freeze verwalten) — gelten für den ganzen Mischer.
      const callGlobal = async (method, body) => {
        await fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        await refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds, lastSenderNodeId);
      };
      const call = (method, body) =>
        fetch(`/api/v1/nodes/${nodeId}/methods/${prefixed(method)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(() => refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds, lastSenderNodeId));

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
      sourcesBtn.textContent = T("sources");
      sourcesBtn.title = T("sourcesTitle");
      const keyerBtn = document.createElement("omp-button");
      keyerBtn.className = "card dsk-btn";
      keyerBtn.setAttribute("color", "onair");
      const rateRow = document.createElement("div"); // Rampendauer-Tasten wohnen in der Übergangseinheit
      rateRow.className = "rate-row";
      const toolGroup = (labelText, ...items) => {
        const g = document.createElement("div");
        g.className = "tool-group";
        const l = document.createElement("span");
        l.className = "tool-label";
        l.textContent = labelText;
        const box = document.createElement("div");
        box.className = "tool-items";
        box.append(...items);
        g.append(l, box);
        return [g, box];
      };

      const pipRow = document.createElement("div");
      pipRow.className = "pip-row";
      const pipAddBtn = document.createElement("omp-button");
      pipAddBtn.className = "card pip-add";
      pipAddBtn.title = T("pipAddTitle");

      const [sourcesGroup] = toolGroup(T("groupSources"), sourcesBtn);
      const [dskGroup] = toolGroup("DSK", keyerBtn);
      const [pipGroup] = toolGroup(T("groupPip"), pipRow);

      // PGM-Monitor (Kapitel 87): kleines PGM-Bild; Klick auf ein PIP schaltet dessen Fokus (Fahrt auf die
      // Fokusposition bzw. zurück). Die Trefferprüfung rechnet der Node (`pip.clickAt`), hier wird nur umgerechnet.
      const MON_KEY = `omp-vmix-monitor-${nodeId}-${level}`;
      let monitorOn = localStorage.getItem(MON_KEY) === "1";
      const monBtn = document.createElement("omp-button");
      monBtn.className = "mon-btn";
      monBtn.textContent = T("monitor");
      monBtn.title = T("monitorTitle");
      const [monGroup] = toolGroup(T("groupMonitor"), monBtn);
      const monWrap = document.createElement("div");
      monWrap.className = "pgm-monitor";
      const monInner = document.createElement("div");
      monInner.className = "pgm-monitor-inner";
      const monImg = document.createElement("img");
      monImg.className = "pgm-monitor-img";
      monImg.alt = "";
      monImg.draggable = false;
      const monSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      monSvg.setAttribute("class", "pgm-monitor-overlay");
      const monHint = document.createElement("div");
      monHint.className = "pgm-monitor-hint";
      monHint.textContent = T("focusHint");
      monInner.append(monImg, monSvg);
      monWrap.append(monInner, monHint);
      monWrap.style.display = "none";
      let monHover = -1;
      const monSlots = () => (latestPipSlots || []).filter((s) => s.enabled);
      // Oberster getroffener Slot in Mischer-Pixeln (höchstes z, bei Gleichstand der höhere Slot; Fokus liegt immer oben)
      const monHit = (x, y) => {
        let best = null;
        for (const s of monSlots()) {
          if (!s.pose || !s.pose.corners || !pointInQuad(s.pose.corners, x, y)) continue;
          const z = s.focused ? 1e6 : s.z;
          if (!best || z > best.z || (z === best.z && s.slot > best.slot)) best = { slot: s.slot, z };
        }
        return best ? best.slot : -1;
      };
      const monCoords = (ev) => {
        const r = monInner.getBoundingClientRect();
        return { x: ((ev.clientX - r.left) / r.width) * WIDTH, y: ((ev.clientY - r.top) / r.height) * HEIGHT };
      };
      const renderMonOverlay = () => {
        monSvg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
        monSvg.textContent = "";
        const ns = "http://www.w3.org/2000/svg";
        for (const s of monSlots()) {
          if (!s.pose || !s.pose.corners) continue;
          const poly = document.createElementNS(ns, "polygon");
          poly.setAttribute("points", s.pose.corners.map((p) => `${p[0]},${p[1]}`).join(" "));
          poly.setAttribute("class", "mon-slot" + (s.focused ? " focused" : "") + (s.slot === monHover ? " hover" : ""));
          monSvg.append(poly);
        }
      };
      monInner.addEventListener("pointermove", (ev) => {
        const { x, y } = monCoords(ev);
        const hit = monHit(x, y);
        if (hit !== monHover) { monHover = hit; renderMonOverlay(); }
        monInner.style.cursor = hit >= 0 ? "pointer" : "default";
      });
      monInner.addEventListener("pointerleave", () => { if (monHover !== -1) { monHover = -1; renderMonOverlay(); } });
      monInner.addEventListener("click", async (ev) => {
        const { x, y } = monCoords(ev);
        if (monHit(x, y) < 0) return;
        await call("pip.clickAt", { x: Math.round(x), y: Math.round(y) });
        setTimeout(() => this._refresh?.(), 150);
        setTimeout(() => this._refresh?.(), 800);
      });
      const monUrl = () => {
        const token = localStorage.getItem(STREAM_TOKEN_KEY);
        const base = `/api/v1/nodes/${nodeId}/stream/${prefixed("pgmPreviewUrl")}`;
        const withToken = token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
        return `${withToken}${withToken.includes("?") ? "&" : "?"}_=${Date.now()}`;
      };
      let monBusy = false;
      const monTick = async () => {
        if (monBusy || !monitorOn || !latestPgmPreview) return;
        monBusy = true;
        try {
          const res = await fetch(monUrl(), { cache: "no-store" });
          if (res.ok) {
            const url = URL.createObjectURL(await res.blob());
            const old = monImg.dataset.blobUrl;
            monImg.src = url;
            monImg.dataset.blobUrl = url;
            if (old) URL.revokeObjectURL(old);
          }
        } catch { /* nächster Takt */ }
        monBusy = false;
      };
      const renderMonitor = () => {
        monGroup.style.display = latestPgmPreview ? "" : "none";
        monBtn.active = monitorOn;
        monWrap.style.display = monitorOn && latestPgmPreview ? "" : "none";
        monInner.style.aspectRatio = `${WIDTH} / ${HEIGHT}`;
        if (monitorOn && latestPgmPreview) {
          renderMonOverlay();
          if (!this._monTimers) this._monTimers = new Set();
          if (!monImg._timer) {
            monImg._timer = setInterval(monTick, 250);
            this._monTimers.add(monImg._timer);
            monTick();
          }
        } else if (monImg._timer) {
          clearInterval(monImg._timer);
          this._monTimers?.delete(monImg._timer);
          monImg._timer = null;
        }
      };
      monBtn.addEventListener("click", () => {
        monitorOn = !monitorOn;
        localStorage.setItem(MON_KEY, monitorOn ? "1" : "0");
        renderMonitor();
      });
      toolbarRow.append(sourcesGroup, dskGroup, pipGroup, monGroup);
      buses.append(pgmRow, pstRow, toolbarRow, monWrap);

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
      // Transitionsart (Nutzerauftrag 2026-09-29): MIX, V-FADE (über
      // Schwarz), SLIDE und PUSH in vier Richtungen. Gilt für AUTO und T-Bar;
      // Auswahl per `crosspoint.setTransType`, Readback per
      // `crosspoint.transType`.
      const kindButtons = new Map();
      const makeKindButton = (type, text, title) => {
        const btn = document.createElement("omp-button");
        btn.textContent = text;
        btn.title = title;
        btn.setAttribute("color", "cue");
        btn.addEventListener("click", () => {
          setKindActive(type);
          call("crosspoint.setTransType", { type });
        });
        kindButtons.set(type, btn);
        return btn;
      };
      const setKindActive = (type) => {
        for (const [t, btn] of kindButtons) btn.active = t === type;
      };
      const mixWipe = document.createElement("div");
      mixWipe.className = "mix-wipe";
      mixWipe.append(
        makeKindButton("mix", "MIX", T("kindMix")),
        makeKindButton("vfade", "V-FD", T("kindVfade")),
        makeKindButton("fadecut", "F→C", T("kindFadecut")),
        makeKindButton("cutfade", "C→F", T("kindCutfade")),
      );
      // Slide: neues Bild fährt über das alte; Push: es schiebt das alte hinaus.
      // Pfeil = Bewegungsrichtung. Bewusst keine Crop-Wipes (s. pipeline.rs-Moduldoku).
      const makeKindRow = (caption, prefix, what) => {
        const cap = document.createElement("div");
        cap.className = "wipe-caption";
        cap.textContent = caption;
        const row = document.createElement("div");
        row.className = "mix-wipe";
        for (const [suffix, arrow, dir] of [
          ["R", "▶", T("dirRight")],
          ["L", "◀", T("dirLeft")],
          ["D", "▼", T("dirDown")],
          ["U", "▲", T("dirUp")],
        ]) {
          row.append(makeKindButton(prefix + suffix, arrow, `${what} ${dir}`));
        }
        return [cap, row];
      };
      const slideRow = makeKindRow("SLIDE", "slide", T("slideWhat"));
      const pushRow = makeKindRow("PUSH", "push", T("pushWhat"));
      setKindActive("mix");
      // Option "PGM/PST nach Übergang tauschen" (Nutzerwunsch 2026-10-15),
      // serverseitig je Ebene (`crosspoint.swapOnTransition`).
      const swapBtn = document.createElement("omp-button");
      swapBtn.className = "swap-btn";
      swapBtn.textContent = T("swapLabel");
      swapBtn.title = T("swapTitle");
      swapBtn.setAttribute("color", "cue");
      swapBtn.addEventListener("click", () => {
        swapBtn.active = !swapBtn.active;
        call("crosspoint.setSwapOnTransition", { enabled: swapBtn.active });
      });
      // Freeze: aktuelles PGM-Bild dieser Ebene als Standbild aufnehmen; erscheint als angeheftete Quelle.
      const freezeBtn = document.createElement("omp-button");
      freezeBtn.className = "swap-btn";
      freezeBtn.textContent = T("freezeLabel");
      freezeBtn.title = T("freezeTitle");
      freezeBtn.addEventListener("click", () => call("freeze.capture", {}));
      transition.append(cutBtn, autoBtn, rateRow, tBar, mixWipe, ...slideRow, ...pushRow, swapBtn, freezeBtn);

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
          refresh(lastWorkflowOwnSenderIds, lastOtherLevelSenderIds, lastSenderNodeId);
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
        btn.title = T("rampTitle", { frames, ms: frames * MS_PER_TRANS_FRAME });
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
      let latestPipSlots = [];
      let latestPgmPreview = false;
      let latestFreezes = [];
      let lastWorkflowOwnSenderIds = new Set();
      let lastOtherLevelSenderIds = new Set();
      let lastSenderNodeId = new Map();

      // "Quellen"-Dialog (Nutzerauftrag 2026-09-04, s. Moduldoku):
      // ersetzt die frühere Inline-SRC-Reihe (+/×) + das nackte
      // DSK-<select> — identische Logik, nur jetzt in einem Modal.
      sourcesBtn.addEventListener("click", () => {
        const { bodyEl } = openModal("Quellen & DSK");

        const pinnedSection = document.createElement("div");
        pinnedSection.className = "field";
        const pinnedLabel = document.createElement("label");
        pinnedLabel.textContent = T("pinned");
        const pinnedList = document.createElement("div");
        pinnedList.className = "list";
        pinnedSection.append(pinnedLabel, pinnedList);

        const renderPinnedList = () => {
          pinnedList.innerHTML = "";
          if (latestPinned.length === 0) {
            const hint = document.createElement("p");
            hint.className = "empty";
            hint.textContent = T("nonePinned");
            pinnedList.append(hint);
          }
          for (const senderId of latestPinned) {
            const input = latestInputs.find((i) => i.senderId === senderId);
            const chip = document.createElement("div");
            chip.className = "chip";
            const label = document.createElement("span");
            label.className = "label";
            label.textContent = input ? shortLabel(input.label) : "unbekannt";
            label.title = input ? input.label : senderId;
            const removeBtn = document.createElement("omp-button");
            removeBtn.textContent = "×";
            removeBtn.title = T("removeSource");
            removeBtn.addEventListener("click", async () => {
              await call("crosspoint.unpin", { senderId });
              latestPinned = latestPinned.filter((s) => s !== senderId);
              renderPinnedList();
            });
            // Reihenfolge ändern: ▲▼ oder Chip ziehen.
            const movePin = async (toIndex) => {
              const from = latestPinned.indexOf(senderId);
              const to = Math.max(0, Math.min(toIndex, latestPinned.length - 1));
              if (from < 0 || to === from) return;
              const next = latestPinned.filter((s) => s !== senderId);
              next.splice(to, 0, senderId);
              latestPinned = next;
              renderPinnedList();
              await call("crosspoint.movePin", { senderId, toIndex: to });
            };
            const idx = latestPinned.indexOf(senderId);
            const upBtn = document.createElement("omp-button");
            upBtn.textContent = "▲";
            upBtn.title = T("moveFront");
            upBtn.disabled = idx === 0;
            upBtn.addEventListener("click", () => movePin(idx - 1));
            const downBtn = document.createElement("omp-button");
            downBtn.textContent = "▼";
            downBtn.title = T("moveBack");
            downBtn.disabled = idx === latestPinned.length - 1;
            downBtn.addEventListener("click", () => movePin(idx + 1));
            chip.draggable = true;
            chip.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-omp-pin", senderId); e.dataTransfer.effectAllowed = "move"; });
            chip.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("text/x-omp-pin")) e.preventDefault(); });
            chip.addEventListener("drop", (e) => {
              const from = e.dataTransfer.getData("text/x-omp-pin");
              if (!from || from === senderId) return;
              e.preventDefault();
              const target = latestPinned.indexOf(senderId);
              const dragged = latestPinned.indexOf(from);
              if (dragged < 0 || target < 0) return;
              const next = latestPinned.filter((s) => s !== from);
              next.splice(target, 0, from);
              latestPinned = next;
              renderPinnedList();
              call("crosspoint.movePin", { senderId: from, toIndex: target });
            });
            chip.append(label, upBtn, downBtn, removeBtn);
            pinnedList.append(chip);
          }
          const addRow = document.createElement("div");
          addRow.className = "row";
          const available = latestInputs
            .filter((i) => !latestPinned.includes(i.senderId))
            .map((i) => ({ label: i.mismatch ? `⚠ ${shortLabel(i.label)} (${i.format})` : shortLabel(i.label), senderId: i.senderId }));
          const picker = buildSourceSelector(available, T("addSource"));
          picker.addEventListener("change", async () => {
            if (!picker.value) return;
            const pinnedId = picker.value;
            await call("crosspoint.pin", { senderId: pinnedId });
            // Der 2s-Poll kann die ID während des await schon übernommen haben → nicht doppelt anhängen.
            if (!latestPinned.includes(pinnedId)) latestPinned = [...latestPinned, pinnedId];
            renderPinnedList();
          });
          addRow.append(picker);
          pinnedList.append(addRow);
        };
        renderPinnedList();

        const dskSection = document.createElement("div");
        dskSection.className = "field";
        const dskLabel = document.createElement("label");
        dskLabel.textContent = T("dskSource");
        const dskSelect = buildSourceSelector(latestKeyerInputs, "Testfarbe");
        dskSelect.value = latestKeyerSource;
        dskSelect.addEventListener("change", () => {
          call("keyer.setSource", { senderId: dskSelect.value });
          latestKeyerSource = dskSelect.value;
        });
        dskSection.append(dskLabel, dskSelect);

        const freezeSection = document.createElement("div");
        freezeSection.className = "field";
        const freezeLabel = document.createElement("label");
        freezeLabel.textContent = T("freezes");
        const freezeList = document.createElement("div");
        freezeList.className = "list";
        freezeSection.append(freezeLabel, freezeList);
        const renderFreezeList = () => {
          freezeList.innerHTML = "";
          if (latestFreezes.length === 0) {
            const hint = document.createElement("p");
            hint.className = "empty";
            hint.textContent = T("noFreezes");
            freezeList.append(hint);
          }
          for (const fz of latestFreezes) {
            const chip = document.createElement("div");
            chip.className = "chip";
            const label = document.createElement("span");
            label.className = "label";
            label.textContent = fz.name;
            const renameBtn = document.createElement("omp-button");
            renameBtn.textContent = "✎";
            renameBtn.title = T("rename");
            renameBtn.addEventListener("click", async () => {
              const name = await promptDialog(T("freezeName"), fz.name, T("apply"), T("cancel"));
              if (!name) return;
              await callGlobal("freeze.rename", { id: fz.id, name });
              renderFreezeList();
            });
            const delBtn = document.createElement("omp-button");
            delBtn.textContent = "×";
            delBtn.title = T("delete");
            delBtn.addEventListener("click", async () => {
              if (!(await confirmDialog(T("confirmDeleteFreeze", { name: fz.name }), T("delete")))) return;
              await callGlobal("freeze.delete", { id: fz.id });
              renderFreezeList();
            });
            chip.append(label, renameBtn, delBtn);
            freezeList.append(chip);
          }
        };
        renderFreezeList();

        bodyEl.append(pinnedSection, freezeSection, dskSection);
      });

      // PIP-Szenen-Editor (Kapitel 87): eine Szene = mehrere Slot-Einträge (Quelle, z, Fahrt Start→Halten→Ende,
      // optionale Fokusposition). Jede Position ist ein Viereck ("quad": vier Ecken in Mischer-Pixeln, Reihenfolge
      // oben-links, oben-rechts, unten-rechts, unten-links) — Rechteck, gedreht oder Trapez. `scene` ist eine
      // bestehende Szene (Bearbeiten) oder `null` (Neuanlage).
      const quadFromPose = (pose) => (pose.corners ? pose.corners.map((p) => [p[0], p[1]]) : quadFromBox(pose));
      const slotInfo = (slot) => latestPipSlots.find((s) => s.slot === slot) || { slot, twoD: false };
      const newEntry = (slot) => {
        const w = Math.round(WIDTH / 3), h = Math.round(HEIGHT / 3);
        const x = WIDTH - w - 16 - slot * Math.round(w * 0.15), y = HEIGHT - h - 16 - slot * Math.round(h * 0.4);
        return { slot, senderId: "", hold: quadFromBox({ x, y: Math.max(0, y), width: w, height: h }), start: null, end: null, focus: null, inMs: PIP_DEFAULT_MS, outMs: PIP_DEFAULT_MS, z: 4 + slot };
      };
      const entryFromServer = (e) => ({
        slot: e.slot ?? 0,
        senderId: e.senderId || "",
        hold: quadFromPose(e.pose),
        start: e.start ? quadFromPose(e.start) : null,
        end: e.end ? quadFromPose(e.end) : null,
        focus: e.focus ? quadFromPose(e.focus) : null,
        inMs: e.inMs > 0 ? e.inMs : PIP_DEFAULT_MS,
        outMs: e.outMs > 0 ? e.outMs : PIP_DEFAULT_MS,
        z: e.z ?? 4 + (e.slot ?? 0),
      });
      const openPipEditor = (scene) => {
        const draft = scene
          ? { id: scene.id, name: scene.name, entries: (scene.entries && scene.entries.length ? scene.entries : [{ slot: 0, senderId: scene.senderId, pose: scene.box, start: scene.start, end: scene.end, inMs: scene.inMs, outMs: scene.outMs }]).map(entryFromServer) }
          : { id: newPresetId(), name: `PIP ${latestPipPresets.length + 1}`, entries: [newEntry(0)] };
        let cur = 0; // gerade bearbeiteter Eintrag
        let editing = "hold";
        const entry = () => draft.entries[cur];

        const { bodyEl, close } = openModal(scene ? T("editTitle") : T("newTitle"), { onClose: () => cleanup() });

        const nameField = document.createElement("div");
        nameField.className = "field";
        const nameLabel = document.createElement("label");
        nameLabel.textContent = T("name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = draft.name;
        nameInput.addEventListener("input", () => (draft.name = nameInput.value));
        nameField.append(nameLabel, nameInput);

        // ── Slot-Reiter
        const tabsRow = document.createElement("div");
        tabsRow.className = "row pip-tabs";
        const renderTabs = () => {
          tabsRow.innerHTML = "";
          draft.entries.forEach((e, i) => {
            const wrap = document.createElement("span");
            wrap.className = "pip-tab";
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = T("slotN", { n: e.slot + 1 });
            b.classList.toggle("active", i === cur);
            b.addEventListener("click", (ev) => { ev.preventDefault(); cur = i; if (!entry()[editing] && editing !== "hold") editing = "hold"; syncAll(); });
            wrap.append(b);
            if (draft.entries.length > 1) {
              const x = document.createElement("button");
              x.type = "button";
              x.textContent = "×";
              x.title = T("removeSlot");
              x.addEventListener("click", (ev) => { ev.preventDefault(); draft.entries.splice(i, 1); cur = Math.min(cur, draft.entries.length - 1); editing = "hold"; syncAll(); });
              wrap.append(x);
            }
            tabsRow.append(wrap);
          });
          const free = [...Array(Math.max(latestPipSlots.length, 1)).keys()].find((s) => !draft.entries.some((e) => e.slot === s));
          const add = document.createElement("button");
          add.type = "button";
          add.textContent = "+";
          add.title = T("addSlot");
          add.disabled = free === undefined;
          add.addEventListener("click", (ev) => { ev.preventDefault(); draft.entries.push(newEntry(free)); cur = draft.entries.length - 1; editing = "hold"; syncAll(); });
          tabsRow.append(add);
        };

        // ── Quelle + Ebene (z)
        const sourceField = document.createElement("div");
        sourceField.className = "field";
        const sourceLabel = document.createElement("label");
        sourceLabel.textContent = T("source");
        const pstEntries = Array.from({ length: levelCount }, (_, k) => ({ senderId: `pst:${k + 1}`, label: levelCount > 1 ? T("pstOfLevel", { n: k + 1 }) : "PST", virtual: true }));
        const pipInputEntries = pstEntries.concat(latestInputs.map((i) => ({ label: i.mismatch ? `⚠ ${shortLabel(i.label)} (${i.format})` : shortLabel(i.label), senderId: i.senderId })));
        const sourceSelect = buildSourceSelector(pipInputEntries, T("black"));
        sourceSelect.addEventListener("change", () => (entry().senderId = sourceSelect.value));
        const zWrap = document.createElement("label");
        zWrap.className = "pip-ms";
        zWrap.title = T("zTitle");
        zWrap.append(document.createTextNode(T("zLabel") + " "));
        const zInput = document.createElement("input");
        zInput.type = "number";
        zInput.min = "0";
        zInput.max = "99";
        zInput.addEventListener("input", () => (entry().z = clamp(parseInt(zInput.value, 10) || 0, 0, 99)));
        zWrap.append(zInput);
        sourceField.append(sourceLabel, sourceSelect, zWrap);

        // ── Punkte: Start/Ende/Fokus optional zuschaltbar, "Halten" immer
        const pointsField = document.createElement("div");
        pointsField.className = "field";
        const pointsLabel = document.createElement("label");
        pointsLabel.textContent = T("pipPoints");
        const pointRow = document.createElement("div");
        pointRow.className = "row pip-points";
        const POINTS = [
          { key: "start", text: T("ptStart"), color: "#4285f4", optional: true },
          { key: "hold", text: T("ptHold"), color: "#43a047", optional: false },
          { key: "end", text: T("ptEnd"), color: "#fb8c00", optional: true },
          { key: "focus", text: T("ptFocus"), color: "#ab47bc", optional: true },
        ];
        const pointEls = new Map();
        for (const pt of POINTS) {
          const wrap = document.createElement("label");
          wrap.className = "pip-point";
          wrap.style.setProperty("--pt", pt.color);
          let toggle = null;
          if (pt.optional) {
            toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.title = T("usePosition", { text: pt.text });
            toggle.addEventListener("change", () => {
              const e = entry();
              if (toggle.checked) {
                e[pt.key] = pt.key === "focus" ? quadFromBox(focusBox()) : moveQuad(e.hold, pt.key === "start" ? WIDTH - boundsOf(e.hold).x : -boundsOf(e.hold).x - boundsOf(e.hold).width, 0);
                editing = pt.key;
              } else {
                e[pt.key] = null;
                if (editing === pt.key) editing = "hold";
              }
              syncPoints();
            });
            wrap.append(toggle);
          }
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = pt.text;
          btn.addEventListener("click", (ev) => { ev.preventDefault(); if (!entry()[pt.key]) return; editing = pt.key; syncPoints(); });
          wrap.append(btn);
          pointRow.append(wrap);
          pointEls.set(pt.key, { wrap, btn, toggle });
        }
        const hint = document.createElement("p");
        hint.className = "empty";
        pointsField.append(pointsLabel, pointRow, hint);

        // Ein-/Ausfahrdauer
        const timingRow = document.createElement("div");
        timingRow.className = "row";
        const makeMsInput = (labelText, key) => {
          const wrap = document.createElement("label");
          wrap.className = "pip-ms";
          wrap.append(document.createTextNode(labelText));
          const input = document.createElement("input");
          input.type = "number";
          input.min = "0";
          input.max = "60000";
          input.step = "50";
          input.addEventListener("input", () => (entry()[key] = clamp(parseInt(input.value, 10) || 0, 0, 60000)));
          wrap.append(input, document.createTextNode(" ms"));
          return { wrap, input };
        };
        const inMs = makeMsInput(T("slideIn"), "inMs");
        const outMs = makeMsInput(T("slideOut"), "outMs");
        timingRow.append(inMs.wrap, outMs.wrap);

        // 2D: Drehung + Ecken (nur Slots mit Transform-Element)
        const twoDRow = document.createElement("div");
        twoDRow.className = "row pip-2d";
        const rotWrap = document.createElement("label");
        rotWrap.className = "pip-ms";
        rotWrap.append(document.createTextNode(T("rotation") + " "));
        const rotInput = document.createElement("input");
        rotInput.type = "number";
        rotInput.min = "-180";
        rotInput.max = "180";
        rotInput.step = "1";
        rotInput.addEventListener("input", () => {
          const q = entry()[editing];
          if (!q) return;
          const want = clamp(parseFloat(rotInput.value) || 0, -180, 180);
          entry()[editing] = rotateQuad(q, want - quadAngle(q));
          renderBoxes();
        });
        rotWrap.append(rotInput, document.createTextNode(" °"));
        const resetCorners = document.createElement("button");
        resetCorners.type = "button";
        resetCorners.textContent = T("resetCorners");
        resetCorners.title = T("resetCornersTitle");
        resetCorners.addEventListener("click", (ev) => { ev.preventDefault(); const q = entry()[editing]; if (!q) return; entry()[editing] = quadFromBox(boundsOf(q)); syncPoints(); });
        const twoDHint = document.createElement("span");
        twoDHint.className = "pip-edge-label";
        twoDRow.append(rotWrap, resetCorners, twoDHint);

        // Randstart-Schnellwahl für Start/Ende
        const edgeRow = document.createElement("div");
        edgeRow.className = "row";
        const edgeLabel = document.createElement("span");
        edgeLabel.className = "pip-edge-label";
        edgeLabel.textContent = T("outside");
        edgeRow.append(edgeLabel);
        const EDGES = [
          [T("edgeLeft"), (q) => moveQuad(q, -boundsOf(q).x - boundsOf(q).width, 0)],
          [T("edgeRight"), (q) => moveQuad(q, WIDTH - boundsOf(q).x, 0)],
          [T("edgeTop"), (q) => moveQuad(q, 0, -boundsOf(q).y - boundsOf(q).height)],
          [T("edgeBottom"), (q) => moveQuad(q, 0, HEIGHT - boundsOf(q).y)],
        ];
        for (const [text, fn] of EDGES) {
          const eb = document.createElement("button");
          eb.type = "button";
          eb.textContent = text;
          eb.addEventListener("click", (ev) => {
            ev.preventDefault();
            if (editing === "hold" || editing === "focus" || !entry()[editing]) return;
            entry()[editing] = fn(entry()[editing]);
            renderBoxes();
          });
          edgeRow.append(eb);
        }

        // ── Bühne: Bild = umrandetes Rechteck in der Mitte, Rand für Positionen außerhalb
        const editorField = document.createElement("div");
        editorField.className = "field";
        const canvasOuter = document.createElement("div");
        canvasOuter.className = "pip-editor-canvas-outer";
        const marginX = Math.round(WIDTH * PIP_STAGE_MARGIN);
        const marginY = Math.round(HEIGHT * PIP_STAGE_MARGIN);
        const scale = PIP_EDITOR_WIDTH / (WIDTH + 2 * marginX);
        const stageHeight = Math.round((HEIGHT + 2 * marginY) * scale);
        const canvas = document.createElement("div");
        canvas.className = "pip-editor-canvas";
        canvas.style.width = `${PIP_EDITOR_WIDTH}px`;
        canvas.style.height = `${stageHeight}px`;
        const frame = document.createElement("div");
        frame.className = "pip-editor-frame";
        frame.style.left = `${Math.round(marginX * scale)}px`;
        frame.style.top = `${Math.round(marginY * scale)}px`;
        frame.style.width = `${Math.round(WIDTH * scale)}px`;
        frame.style.height = `${Math.round(HEIGHT * scale)}px`;
        const svgNs = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("class", "pip-editor-svg");
        svg.setAttribute("width", String(PIP_EDITOR_WIDTH));
        svg.setAttribute("height", String(stageHeight));
        const pathLine = document.createElementNS(svgNs, "polyline");
        pathLine.setAttribute("class", "pip-editor-pathline");
        svg.append(pathLine);
        const mk = (name, attrs) => { const el = document.createElementNS(svgNs, name); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
        const shapes = new Map();
        for (const pt of POINTS) {
          const g = mk("g", { class: "pip-shape" });
          const poly = mk("polygon", { fill: pt.color, "fill-opacity": "0.3", stroke: pt.color, "stroke-width": "1.5" });
          const label = mk("text", { fill: "#fff", "font-size": "9", "pointer-events": "none" });
          label.textContent = pt.text;
          const resize = mk("rect", { width: "10", height: "10", fill: pt.color, stroke: "#fff", "stroke-width": "1", style: "cursor:nwse-resize" });
          const corners = [0, 1, 2, 3].map(() => mk("circle", { r: "5", fill: "#fff", stroke: pt.color, "stroke-width": "2", style: "cursor:crosshair" }));
          g.append(poly, label, resize, ...corners);
          svg.append(g);
          shapes.set(pt.key, { g, poly, label, resize, corners });
        }
        canvas.append(frame, svg);
        canvasOuter.append(canvas);
        const editorLabel = document.createElement("label");
        editorLabel.textContent = T("editorHint");
        editorField.append(editorLabel, canvasOuter, edgeRow);

        const sx = (v) => Math.round((v + marginX) * scale);
        const sy = (v) => Math.round((v + marginY) * scale);
        const twoDOk = () => !!slotInfo(entry().slot).twoD;
        function renderBoxes() {
          const e = entry();
          const centers = [];
          for (const pt of POINTS) {
            const q = e[pt.key];
            const s = shapes.get(pt.key);
            s.g.style.display = q ? "" : "none";
            if (!q) continue;
            const active = editing === pt.key;
            s.g.style.opacity = active ? "1" : "0.55";
            s.poly.setAttribute("points", q.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" "));
            s.poly.style.cursor = "move";
            s.label.setAttribute("x", String(sx(q[0][0]) + 3));
            s.label.setAttribute("y", String(sy(q[0][1]) + 11));
            const b = boundsOf(q);
            s.resize.style.display = active && !(twoDOk() && !isRect(q)) ? "" : "none";
            s.resize.setAttribute("x", String(sx(b.x + b.width) - 5));
            s.resize.setAttribute("y", String(sy(b.y + b.height) - 5));
            s.corners.forEach((c, i) => {
              c.style.display = active && twoDOk() ? "" : "none";
              c.setAttribute("cx", String(sx(q[i][0])));
              c.setAttribute("cy", String(sy(q[i][1])));
            });
            if (pt.key !== "focus") centers.push(`${sx(b.x + b.width / 2)},${sy(b.y + b.height / 2)}`);
          }
          pathLine.setAttribute("points", centers.join(" "));
          const q = e[editing];
          if (q && document.activeElement !== rotInput) rotInput.value = String(Math.round(quadAngle(q)));
        }
        // Halten: komplett im Bild; Start/Ende/Fokus: bis vollständig außerhalb des Bildes.
        const limits = (key, b) => {
          if (key === "hold" || key === "focus") return { minX: 0, maxX: Math.max(0, WIDTH - b.width), minY: 0, maxY: Math.max(0, HEIGHT - b.height) };
          return { minX: -b.width, maxX: WIDTH, minY: -b.height, maxY: HEIGHT };
        };
        function syncPoints() {
          const e = entry();
          for (const pt of POINTS) {
            const el = pointEls.get(pt.key);
            const on = !!e[pt.key];
            el.btn.disabled = !on;
            el.btn.classList.toggle("active", editing === pt.key);
            if (el.toggle) el.toggle.checked = on;
          }
          const hasExit = !!(e.end || e.start);
          inMs.wrap.style.display = e.start ? "" : "none";
          outMs.wrap.style.display = hasExit ? "" : "none";
          inMs.input.value = String(e.inMs);
          outMs.input.value = String(e.outMs);
          edgeRow.style.display = editing === "hold" || editing === "focus" ? "none" : "";
          twoDRow.style.display = "";
          rotInput.disabled = !twoDOk();
          resetCorners.disabled = !twoDOk();
          twoDHint.textContent = twoDOk() ? T("twoDHint") : T("noTwoD");
          hint.textContent = !e.start && !e.end ? T("hint0") : e.start && e.end ? T("hint3") : e.start ? T("hint2s") : T("hint2e");
          renderBoxes();
        }
        function syncAll() {
          renderTabs();
          const e = entry();
          sourceSelect.value = e.senderId;
          zInput.value = String(e.z);
          syncPoints();
        }

        // Ziehen: Verschieben (Fläche), Skalieren (Griff unten rechts), Ecke ziehen (Kreise, nur 2D-Slots)
        let drag = null;
        const onDown = (key, mode, idx) => (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (editing !== key) { editing = key; syncPoints(); }
          drag = { key, mode, idx, sx: ev.clientX, sy: ev.clientY, q0: entry()[key].map((p) => [p[0], p[1]]) };
        };
        const onMove = (ev) => {
          if (!drag) return;
          const dx = Math.round((ev.clientX - drag.sx) / scale);
          const dy = Math.round((ev.clientY - drag.sy) / scale);
          const e = entry();
          const b0 = boundsOf(drag.q0);
          if (drag.mode === "move") {
            const lim = limits(drag.key, b0);
            e[drag.key] = moveQuad(drag.q0, clamp(b0.x + dx, lim.minX, lim.maxX) - b0.x, clamp(b0.y + dy, lim.minY, lim.maxY) - b0.y);
          } else if (drag.mode === "resize") {
            const hard = drag.key === "hold" || drag.key === "focus";
            const maxW = (hard ? WIDTH : WIDTH + marginX) - b0.x;
            const maxH = (hard ? HEIGHT : HEIGHT + marginY) - b0.y;
            const nw = clamp(b0.width + dx, PIP_MIN_SIZE, Math.max(PIP_MIN_SIZE, maxW));
            const nh = clamp(b0.height + dy, PIP_MIN_SIZE, Math.max(PIP_MIN_SIZE, maxH));
            e[drag.key] = drag.q0.map((p) => [b0.x + (p[0] - b0.x) * (nw / b0.width), b0.y + (p[1] - b0.y) * (nh / b0.height)]);
          } else {
            const q = drag.q0.map((p) => [p[0], p[1]]);
            q[drag.idx] = [clamp(drag.q0[drag.idx][0] + dx, -marginX, WIDTH + marginX), clamp(drag.q0[drag.idx][1] + dy, -marginY, HEIGHT + marginY)];
            e[drag.key] = q;
          }
          renderBoxes();
        };
        const onUp = () => { drag = null; };
        for (const pt of POINTS) {
          const s = shapes.get(pt.key);
          s.poly.addEventListener("pointerdown", onDown(pt.key, "move"));
          s.resize.addEventListener("pointerdown", onDown(pt.key, "resize"));
          s.corners.forEach((c, i) => c.addEventListener("pointerdown", onDown(pt.key, "corner", i)));
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        const actions = document.createElement("div");
        actions.className = "actions";
        if (scene) {
          const deleteBtn = document.createElement("omp-button");
          deleteBtn.textContent = T("delete");
          deleteBtn.addEventListener("click", async () => {
            if (!(await confirmDialog(T("confirmDelete", { name: scene.name }), T("delete")))) return;
            await call("pip.deletePreset", { id: scene.id });
            close();
          });
          actions.append(deleteBtn);
        }
        const spacer = document.createElement("div");
        spacer.className = "spacer";
        const cancelBtn = document.createElement("omp-button");
        cancelBtn.textContent = T("cancel");
        cancelBtn.addEventListener("click", close);
        const poseJson = (q, slot) => {
          // Slots ohne Transform-Element können nur Rechtecke: das umschließende Rechteck wird gespeichert.
          const use = slotInfo(slot).twoD ? q : quadFromBox(boundsOf(q));
          return { corners: use.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]) };
        };
        const savePreset = async () => {
          const name = draft.name.trim() || `PIP ${latestPipPresets.length + 1}`;
          const entries = draft.entries.map((e) => ({
            slot: e.slot,
            senderId: e.senderId,
            pose: poseJson(e.hold, e.slot),
            start: e.start ? poseJson(e.start, e.slot) : null,
            end: e.end ? poseJson(e.end, e.slot) : null,
            focus: e.focus ? poseJson(e.focus, e.slot) : null,
            inMs: e.start ? e.inMs : 0,
            outMs: e.end || e.start ? e.outMs : 0,
            z: e.z,
          }));
          await call("pip.savePreset", { id: draft.id, name, entries: JSON.stringify(entries) });
        };
        const saveOnlyBtn = document.createElement("omp-button");
        saveOnlyBtn.textContent = T("saveOnly");
        saveOnlyBtn.title = T("saveOnlyTitle");
        saveOnlyBtn.addEventListener("click", async () => { await savePreset(); close(); });
        const saveBtn = document.createElement("omp-button");
        saveBtn.textContent = T("saveShow");
        saveBtn.title = T("saveShowTitle");
        saveBtn.addEventListener("click", async () => { await savePreset(); await call("pip.applyPreset", { id: draft.id }); close(); });
        actions.append(spacer, cancelBtn, saveOnlyBtn, saveBtn);

        bodyEl.append(nameField, tabsRow, sourceField, pointsField, timingRow, twoDRow, editorField, actions);
        syncAll();
        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      };

      pipAddBtn.addEventListener("click", () => openPipEditor(null));

      // Mischer-Auflösung für die Szenen-Miniatur (aus dem Formattext der Quellen, sonst 1280x720).
      const mixerSize = () => ({ w: WIDTH, h: HEIGHT });
      // Miniatur einer PIP-Szene: Rahmen = Bild, grüne Flächen = Haltepositionen aller Slots, gestrichelt = Fahrt-Positionen.
      const pipSceneThumb = (preset) => {
        const { w, h } = mixerSize();
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:absolute;inset:0;";
        const addBox = (b, ghost) => {
          if (!b) return;
          const el = document.createElement("div");
          el.className = ghost ? "pip-box ghost" : "pip-box";
          el.style.left = `${(b.x / w) * 100}%`;
          el.style.top = `${(b.y / h) * 100}%`;
          el.style.width = `${(b.width / w) * 100}%`;
          el.style.height = `${(b.height / h) * 100}%`;
          wrap.append(el);
        };
        const entries = preset.entries && preset.entries.length ? preset.entries : [{ pose: preset.box, start: preset.start, end: preset.end }];
        for (const e of entries) {
          addBox(e.start, true);
          addBox(e.end, true);
        }
        for (const e of entries) addBox(e.pose, false);
        return wrap;
      };
      const renderPipRow = () => {
        pipRow.innerHTML = "";
        for (const preset of latestPipPresets) {
          const chip = document.createElement("span");
          chip.className = "pip-chip";
          const nameBtn = document.createElement("omp-button");
          nameBtn.className = "card pip-name";
          paintCard(nameBtn, preset.name, pipSceneThumb(preset));
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
          editBtn.title = T("editPreset");
          editBtn.addEventListener("click", () => openPipEditor(preset));
          chip.append(nameBtn, editBtn);
          pipRow.append(chip);
        }
        paintCard(pipAddBtn, T("pipNew"), cardText("+"));
        pipRow.append(pipAddBtn);
      };

      let latestTransType = "mix";
      const refresh = async (workflowOwnSenderIds, otherLevelSenderIds, senderNodeId) => {
        lastWorkflowOwnSenderIds = workflowOwnSenderIds;
        lastOtherLevelSenderIds = otherLevelSenderIds;
        lastSenderNodeId = senderNodeId;
        const [
          inputsRes, programRes, presetRes, keyerRes, keyerInputsRes, keyerSourceRes,
          pipEnabledRes, pipPresetsRes, pipActivePresetRes, pinnedRes, transRateRes, transitionPositionRes,
          transTypeRes, swapRes, pipSlotsRes, pipCanvasRes, pgmPreviewRes,
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
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.transType")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("crosspoint.swapOnTransition")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.slots")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pip.canvas")}`),
          fetch(`/api/v1/nodes/${nodeId}/params/${prefixed("pgmPreviewUrl")}`),
        ]);
        if (!inputsRes.ok || !programRes.ok || !presetRes.ok) return;
        try {
          const fr = await fetch(`/api/v1/nodes/${nodeId}/params/freeze.list`);
          if (fr.ok) latestFreezes = (await fr.json()).value || [];
        } catch { /* Liste bleibt, wie sie war */ }
        const inputs = (await inputsRes.json()).value || [];
        const program = (await programRes.json()).value || "";
        const preset = (await presetRes.json()).value || "";
        keyerEnabled = keyerRes.ok ? (await keyerRes.json()).value === true : false;
        const keyerInputs = keyerInputsRes.ok ? (await keyerInputsRes.json()).value || [] : [];
        const keyerSource = keyerSourceRes.ok ? (await keyerSourceRes.json()).value || "" : "";
        latestPipEnabled = pipEnabledRes.ok ? (await pipEnabledRes.json()).value === true : false;
        latestPipPresets = pipPresetsRes.ok ? (await pipPresetsRes.json()).value || [] : [];
        if (pipCanvasRes.ok) {
          const cv = (await pipCanvasRes.json()).value || {};
          setCanvas(cv.width, cv.height);
        }
        latestPipSlots = pipSlotsRes.ok ? (await pipSlotsRes.json()).value || [] : [];
        latestPgmPreview = pgmPreviewRes.ok ? !!(await pgmPreviewRes.json()).value : false;
        renderMonitor();
        latestActivePipPresetId = pipActivePresetRes.ok ? (await pipActivePresetRes.json()).value || "" : "";
        const pinned = pinnedRes.ok ? (await pinnedRes.json()).value || [] : [];
        const transRateFrames = transRateRes.ok ? (await transRateRes.json()).value || 0 : 0;
        const transitionPosition = transitionPositionRes.ok ? (await transitionPositionRes.json()).value || 0 : 0;
        if (swapRes.ok) swapBtn.active = (await swapRes.json()).value === true;
        if (transTypeRes.ok) {
          const type = (await transTypeRes.json()).value;
          latestTransType = type;
          if (kindButtons.has(type)) setKindActive(type);
        }
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

        // Bugliste 2026-09-25 Nachtrag ("Thumbnail-Flicker"): hier
        // NICHT mehr blind `pgmButtons.innerHTML = ""`/`pstButtons.
        // innerHTML = ""` — das würde jedes Mal auch die noch gültigen
        // Vorschaubild-`<img>`s zerstören. `renderBusRow` unten räumt
        // seine eigenen Knöpfe/Gruppen-Labels selbst per Diff auf.

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
        // Reihenfolge der Tasten = Reihenfolge der angehefteten Quellen (Quellen-Dialog, ▲▼/Ziehen);
        // nicht angeheftete Sonderfälle (aktuelles PGM/PST, Ebenen-Ausgänge) folgen dahinter.
        const pinRank = (id) => { const k = pinned.indexOf(id); return k < 0 ? Number.MAX_SAFE_INTEGER : k; };
        const visibleInputs = inputs.filter((i) => alwaysVisible.has(i.senderId)).sort((a, b) => pinRank(a.senderId) - pinRank(b.senderId));
        touchSourceHealth(visibleInputs.map((i) => senderNodeId?.get(i.senderId)));
        const entries = [{ label: "BLK", senderId: "" }, ...visibleInputs.map((i) => ({ label: shortLabel(i.label), senderId: i.senderId, format: i.format, mixerFormat: i.mixerFormat, mismatch: !!i.mismatch }))];
        // Nur dieses eine Hinweis-Element gezielt ersetzen (statt eines
        // vollen `innerHTML = ""`), damit `renderBusRow`s wiederverwendete
        // Knöpfe/Bilder unangetastet bleiben.
        pstButtons.querySelector(":scope > p.empty")?.remove();
        if (visibleInputs.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = T("emptyPinned");
          pstButtons.append(empty);
        }
        const levelOutputSenderIds = level === 0 ? otherLevelSenderIds : undefined;
        renderBusRow(call, pgmButtons, entries, workflowOwnSenderIds, true, program, "onair", levelOutputSenderIds, senderNodeId);
        renderBusRow(call, pstButtons, entries, workflowOwnSenderIds, false, preset, "preset", levelOutputSenderIds, senderNodeId);

        keyerBtn.active = keyerEnabled;
        {
          const ks = latestInputs.find((i) => i.senderId === latestKeyerSource);
          paintCard(keyerBtn, "DSK", cardText(ks ? shortLabel(ks.label) : "–"));
        }

        // Stream Deck (Kap. 40.5): nur die Master-Ebene; die Shell baut daraus
        // Tasten (ui/shell/streamdeck/adapters/video-mixer*.ts).
        if (level === 0) {
          this._deckState = {
            entries: entries.map((e) => {
              const h = e.senderId ? sourceHealth.get(senderNodeId?.get(e.senderId)) : null;
              return { label: e.label, senderId: e.senderId, problem: h ? h.severity : undefined };
            }),
            program,
            preset,
            keyer: keyerEnabled,
            pipEnabled: latestPipEnabled,
            pipPresets: (latestPipPresets || []).map((p) => ({ id: p.id, name: p.name || p.id })),
            activePip: latestActivePipPresetId,
            pipSlots: (latestPipSlots || []).map((sl) => ({ slot: sl.slot, enabled: !!sl.enabled, focused: !!sl.focused })),
            transType: latestTransType,
            transRate: transRateFrames,
          };
          this.dispatchEvent(new CustomEvent("omp-streamdeck-relayout", { bubbles: true }));
        }
      };

      if (level === 0) {
        this.deckApi = { state: () => this._deckState || null, call: (method, body) => call(method, body) };
      }

      return { bankRow, refresh };
    };

    const banks = [];
    for (let level = 0; level < levelCount; level++) banks.push(buildBank(level));

    const consoleList = document.createElement("div");
    consoleList.className = "console-list";
    // Hauptebene (Ebene 1) wie am Hardware-Pult UNTEN, weitere Ebenen
    // aufsteigend darüber (Nutzerwunsch 2026-10-15) — nur die Anzeige-
    // Reihenfolge, Ebenen-Nummern/Logik unverändert.
    for (const b of [...banks].reverse()) consoleList.append(b.bankRow);
    const thumbsToggle = document.createElement("label");
    thumbsToggle.className = "thumbs-toggle";
    const thumbsCheckbox = document.createElement("input");
    thumbsCheckbox.type = "checkbox";
    thumbsCheckbox.checked = thumbsEnabled;
    thumbsToggle.append(thumbsCheckbox, document.createTextNode(T("thumbnails")));
    thumbsCheckbox.addEventListener("change", () => {
      thumbsEnabled = thumbsCheckbox.checked;
      localStorage.setItem(THUMBS_KEY, thumbsEnabled ? "1" : "0");
      this._refresh?.();
    });

    const skinBtn = document.createElement("button");
    skinBtn.type = "button";
    skinBtn.className = "skin-toggle";
    const applySkin = (skin) => {
      this.setAttribute("data-skin", skin === "v2" ? "c2" : "classic");
      skinBtn.textContent = skin === "v2" ? T("skinClassic") : T("skinNew");
      skinBtn.title = T("skinTip");
    };
    const currentSkin = () => { try { return localStorage.getItem(SKIN_KEY) === "classic" ? "classic" : "v2"; } catch { return "v2"; } };
    applySkin(new URLSearchParams(location.search).get("skin") === "classic" ? "classic" : currentSkin());
    skinBtn.addEventListener("click", () => {
      const next = this.getAttribute("data-skin") === "c2" ? "classic" : "v2";
      try { localStorage.setItem(SKIN_KEY, next); } catch {}
      applySkin(next);
    });
    const skinBar = document.createElement("div");
    skinBar.className = "skin-bar";
    skinBar.append(thumbsToggle, skinBtn);

    const consoleSection = document.createElement("omp-panel-section");
    consoleSection.setAttribute("label", "Video Mixer M/E");
    consoleSection.append(skinBar, consoleList);

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
      levelsSection.setAttribute("label", T("mixerLevels"));

      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-2, 8px);flex-wrap:wrap;";
      const label = document.createElement("span");
      label.textContent = T("levels");
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
      applyBtn.textContent = T("apply");
      applyBtn.title = T("applyTitle");
      applyBtn.style.cssText = "height:34px !important; padding:0 var(--omp-space-3, 12px) !important;";

      // Sendet `roleInfo.format` unverändert mit (s. Moduldoku oben) —
      // nur `mixerLevels` ist die eigentlich gewollte Änderung dieses
      // Buttons, `format` bleibt server-seitig sonst nicht "unangetastet"
      // wie ein fehlendes `mixerLevels`-Feld, sondern würde auf den
      // Node-Standard zurückgesetzt.
      applyBtn.addEventListener("click", async () => {
        const n = Math.max(1, Math.min(8, parseInt(input.value, 10) || 1));
        const ok = await confirmDialog(T("confirmRestart", { role: roleInfo.roleName, n }), T("apply"));
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
          if (!res.ok) toastError(T("restartFailed", { err: await res.text() }));
        } catch (err) {
          toastError(T("restartFailed", { err }));
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
    presetSaveBtn.textContent = T("savePreset");
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
        empty_.textContent = T("noPresets");
        empty_.style.cssText = "color:var(--omp-text-dim, #9aa0a6);font-size:11px;";
        presetList.appendChild(empty_);
        return;
      }
      for (const snap of mine) {
        const chip = document.createElement("omp-button");
        chip.textContent = snap.label || snap.id.slice(0, 8);
        chip.title = T("applyPreset");
        chip.addEventListener("click", async () => {
          await fetch(`/api/v1/snapshots/${snap.id}/apply`, { method: "POST" });
          await refreshAll();
        });
        presetList.appendChild(chip);
      }
    };

    presetSaveBtn.addEventListener("click", async () => {
      const label = await promptDialog(T("promptName"), T("newPresetName"), T("apply"), T("cancel"));
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
      const { workflowOwnSenderIds, ownSenderIdByLevel, senderNodeId } = await graphContext();
      // Mastereben = Ebene 1 (1-basiert, `level===0` intern) — deren
      // eigener Sender bleibt ausgeschlossen, alle anderen Ebenen-
      // Ausgänge werden feste PGM/PST-Tasten (s. Moduldoku oben).
      const otherLevelSenderIds = new Set(
        [...ownSenderIdByLevel.entries()].filter(([lvl]) => lvl !== 1).map(([, id]) => id),
      );
      await Promise.all(banks.map((b) => b.refresh(workflowOwnSenderIds, otherLevelSenderIds, senderNodeId)));
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
    for (const t of this._monTimers || []) clearInterval(t);
    if (this._es) this._es.close();
  }
}

if (!customElements.get("omp-video-mixer-me-panel")) {
  customElements.define("omp-video-mixer-me-panel", OmpVideoMixerMePanel);
}
