package uiorigin

// HostJS ist die kleine Hülle im iframe: lädt das Bundle des Nodes (über den Proxy dieses Ursprungs), hängt sein Element ein und meldet die Höhe an die Shell.
// Das Bundle sieht weder Token noch Shell; Meldungen an die Shell enthalten nur Höhe oder Fehlertext.
const HostJS = `const node = location.pathname.split("/").pop();
const base = "/api/v1/nodes/" + node;
const post = (m) => parent.postMessage(Object.assign({ omp: "ui", node }, m), "*");
(async () => {
  try {
    const res = await fetch(base + "/ui/manifest.json");
    if (!res.ok) throw new Error("manifest " + res.status);
    const manifest = await res.json();
    if (!manifest.tag) throw new Error("kein Element im Manifest");
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
