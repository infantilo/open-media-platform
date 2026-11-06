// Berührungsschutz für alle Oberflächen (Nutzerfund 2026-11-06: langes Drücken der Cough-Taste am Handy öffnet das Kontextmenü):
// - Auf Tasten, Schaltern, Reitern, Reglern und Zeichenflächen unterdrückt der Schutz bei Berührung das Kontextmenü des Browsers
//   (Android: `contextmenu` bei langem Drücken). Die Maus-Rechtsklick-Menüs am Desktop bleiben unberührt.
// - Dort sind Textmarkierung, Lupe/Callout (iOS) und der graue Tipp-Hintergrund abgeschaltet.
// - Texteingabefelder behalten Kopieren/Einfügen.
// Wirkt auch in Shadow-DOM (attachShadow wird einmal umhüllt) — die Node-Oberflächen liegen fast alle darin.
// Dieselbe Logik steht als Zeichenkette in `orchestrator/internal/uiorigin/hostjs.go` (iframe-Hülle) und in den eigenständigen Seiten der Nodes.

const CONTROLS =
  'button,[role="button"],[role="switch"],[role="tab"],summary,input[type="range"],input[type="checkbox"],input[type="radio"],canvas,svg,.tog,[draggable="true"]';
const CSS =
  CONTROLS + "{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}";
const TEXT_INPUT_TYPES = ["text", "search", "email", "url", "tel", "password", "number"];

export function installTouchGuard(): void {
  const w = window as unknown as { __ompTouchGuard?: boolean };
  if (w.__ompTouchGuard) return;
  w.__ompTouchGuard = true;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  // Shadow-Roots: Stilregel nachziehen, wenn ein Element sein Shadow-DOM anlegt
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
    const root = orig.call(this, init);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch { /* ältere Browser: nur die Ereignisunterdrückung */ }
    return root;
  };

  document.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      const touchy = (e as PointerEvent).pointerType === "touch" || (e as PointerEvent).pointerType === "pen" || matchMedia("(pointer: coarse)").matches;
      if (!touchy) return;
      for (const n of e.composedPath()) {
        if (!(n instanceof Element)) continue;
        if (n instanceof HTMLTextAreaElement || (n instanceof HTMLInputElement && TEXT_INPUT_TYPES.includes(n.type))) return; // Kopieren/Einfügen erlauben
        if (n.matches(CONTROLS)) {
          e.preventDefault();
          return;
        }
      }
    },
    true,
  );
}

installTouchGuard();
