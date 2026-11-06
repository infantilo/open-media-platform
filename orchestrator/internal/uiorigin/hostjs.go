package uiorigin

// HostJS ist die kleine Hülle im iframe: lädt das Bundle des Nodes (über den Proxy dieses Ursprungs), hängt sein Element ein und meldet die Höhe an die Shell.
// Das Bundle sieht weder Token noch Shell; Meldungen an die Shell enthalten nur Höhe oder Fehlertext.
const HostJS = `// Berührungsschutz (wie ui/shell/touch-guard.ts): kein Kontextmenü bei langem Drücken auf Tasten/Reglern, keine Markierung/Lupe dort; auch in Shadow-DOM.
(() => {
  const C = 'button,[role="button"],[role="switch"],[role="tab"],summary,input[type="range"],input[type="checkbox"],input[type="radio"],canvas,svg,.tog,[draggable="true"]';
  const CSS = C + "{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}";
  const st = document.createElement("style"); st.textContent = CSS; document.head.append(st);
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = orig.call(this, init); try { const s = new CSSStyleSheet(); s.replaceSync(CSS); r.adoptedStyleSheets = [...r.adoptedStyleSheets, s]; } catch (e) { /* ältere Browser */ } return r; };
  const TI = ["text", "search", "email", "url", "tel", "password", "number"];
  document.addEventListener("contextmenu", (e) => {
    if (!(e.pointerType === "touch" || e.pointerType === "pen" || matchMedia("(pointer: coarse)").matches)) return;
    for (const n of e.composedPath()) {
      if (!(n instanceof Element)) continue;
      if (n instanceof HTMLTextAreaElement || (n instanceof HTMLInputElement && TI.includes(n.type))) return;
      if (n.matches(C)) { e.preventDefault(); return; }
    }
  }, true);
})();
const node = location.pathname.split("/").pop();
const base = "/api/v1/nodes/" + node;
const post = (m) => parent.postMessage(Object.assign({ omp: "ui", node }, m), "*");
(async () => {
  try {
    const res = await fetch(base + "/ui/manifest.json");
    if (!res.ok) throw new Error("manifest " + res.status);
    const manifest = await res.json();
    if (!manifest.tag) throw new Error("kein Element im Manifest");
    try { await import("/kit.js"); } catch (e) { /* ohne Kit-Elemente lehnen Bundles Bestätigungen ab */ }
    await import(base + "/ui/bundle.js");
    const el = document.createElement(manifest.tag);
    el.setAttribute("node-id", node);
    document.getElementById("mount").append(el);
    const send = () => post({ type: "size", height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
    new ResizeObserver(send).observe(document.body);
    send();
    post({ type: "ready" });
  } catch (e) {
    document.body.textContent = "UI nicht verfügbar: " + e.message;
    post({ type: "error", message: String(e && e.message || e) });
  }
})();
`
