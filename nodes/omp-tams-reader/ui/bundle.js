function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const STYLE = `
  :host { display: block; position: relative; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; --warn: #d9a02b; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 6px 12px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .5; cursor: default; }
  button.go { background: var(--acc); border-color: var(--acc); color: #fff; } button.stop { background: var(--err); border-color: var(--err); color: #fff; font-weight: 700; }
  input, select { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 8px; }
  .bar label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  .chip { display: inline-block; padding: 2px 12px; border-radius: 10px; background: var(--bg3); font-weight: 600; min-width: 130px; text-align: center; white-space: nowrap; }
  .chip.recording, .chip.playing, .chip.following { background: var(--ok); color: #fff; } .chip.error { background: var(--err); color: #fff; }
  .banner { display: none; position: absolute; top: 4px; left: 4px; right: 4px; z-index: 20; padding: 5px 8px; border-radius: 4px; background: var(--err); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.5); pointer-events: none; }
  .banner.show { display: block; }
  .box { border: 1px solid var(--bd); border-radius: 6px; background: var(--bg2); padding: 8px 10px; margin-bottom: 8px; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); font-weight: 600; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-variant-numeric: tabular-nums; } .kv span:nth-child(odd) { color: var(--mut); }
  .err { color: var(--err); word-break: break-word; min-height: 1.3em; } .hint { color: var(--mut); margin: 6px 0 0; }
`;
const makeT = (D) => {
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
};
function api(el, T) {
  const nodeId = el.getAttribute("node-id");
  const base = `/api/v1/nodes/${nodeId}`;
  const banner = h("div", { class: "banner" });
  let bt = null;
  const show = (text) => { banner.textContent = text; banner.className = "banner show"; clearTimeout(bt); bt = setTimeout(() => banner.classList.remove("show"), 6000); };
  const getParam = async (name) => { const r = await fetch(`${base}/params/${name}`); return r.ok ? (await r.json()).value : undefined; };
  const call = async (method, body) => {
    const r = await fetch(`${base}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (r.ok) return true;
    let d = await r.text().catch(() => ""); try { d = JSON.parse(d).error || d; } catch { /* Klartext */ }
    show(T("fail", { m: method, d: d || r.status })); return false;
  };
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem("tams." + nodeId + "." + k) || ""; localStorage.setItem("tams." + nodeId + "." + k, v); } catch { return ""; } return ""; };
  return { banner, getParam, call, store };
}
// Bedienfeld von omp-tams-reader (Kapitel 105): Zeitbereich abspielen, zeitverschoben mitlaufen, stoppen.
const T = makeT({
  de: { status: "Wiedergabe", videoFlow: "Video-Flow (UUID)", audioFlow: "Audio-Flow (UUID)", mode: "Art", ago: "Vor N Sekunden", range: "Zeitbereich", follow: "Zeitverschoben mitlaufen",
    agoSeconds: "Beginn: vor (s)", durationSeconds: "Dauer (s, leer = bis jetzt)", start: "Anfang (Sek:Nanosek.)", end: "Ende (leer = offen)", delay: "Verzögerung (s)",
    play: "Abspielen", doFollow: "Mitlaufen", stop: "Stopp", fail: "{m} fehlgeschlagen: {d}", counters: "Zähler", segs: "Segmente geholt", frames: "Bilder", blocks: "Tonblöcke", gaps: "Lücken gefüllt", late: "Zu spät verworfen", errors: "Fehler",
    idle: "bereit", playing: "spielt", following: "läuft mit", error: "Fehler", hint: "Die Flow-IDs stammen aus dem Speicher (die Aufnahme nutzt die MXL-Flow-IDs der Quelle). Der Anfang erscheint nach etwa 2 s Vorlauf an den Ausgängen Video und Audio." },
  en: { status: "Playback", videoFlow: "Video flow (UUID)", audioFlow: "Audio flow (UUID)", mode: "Mode", ago: "N seconds ago", range: "Time range", follow: "Follow time-shifted",
    agoSeconds: "Start: ago (s)", durationSeconds: "Duration (s, empty = until now)", start: "Start (sec:nanosec)", end: "End (empty = open)", delay: "Delay (s)",
    play: "Play", doFollow: "Follow", stop: "Stop", fail: "{m} failed: {d}", counters: "Counters", segs: "Segments fetched", frames: "Frames", blocks: "Audio blocks", gaps: "Gaps filled", late: "Dropped late", errors: "Errors",
    idle: "ready", playing: "playing", following: "following", error: "error", hint: "Flow IDs come from the store (the recording uses the source's MXL flow IDs). The start appears about 2 s later at the Video and Audio outputs." },
});
class OmpTamsReaderPanel extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: "open" });
    const { banner, getParam, call, store } = api(this, T);
    const inp = (k, w, ph) => h("input", { type: "text", style: `width:${w}px`, placeholder: ph || "", value: store(k), oninput: (e) => store(k, e.target.value) });
    const vf = inp("vf", 300), af = inp("af", 300);
    const mode = h("select", { onchange: () => { store("mode", mode.value); layout(); } }, ...[["ago", T("ago")], ["range", T("range")], ["follow", T("follow")]].map(([v, l]) => h("option", { value: v }, l)));
    mode.value = store("mode") || "ago";
    const ago = inp("ago", 90), dur = inp("dur", 120), st = inp("st", 150, "1790000000:0"), en = inp("en", 150), del = inp("del", 80);
    if (!del.value) del.value = "10";
    const fields = h("div", { class: "bar" });
    const lab = (t, e) => h("label", {}, t, e);
    const layout = () => fields.replaceChildren(...(mode.value === "ago" ? [lab(T("agoSeconds"), ago), lab(T("durationSeconds"), dur)] : mode.value === "range" ? [lab(T("start"), st), lab(T("end"), en)] : [lab(T("delay"), del)]));
    layout();
    const flows = () => ({ videoFlow: vf.value.trim(), audioFlow: af.value.trim() });
    const run = async () => {
      const f = flows();
      if (mode.value === "follow") await call("tams.follow", { ...f, delayMs: Number(del.value) * 1000 });
      else if (mode.value === "range") await call("tams.play", { ...f, start: st.value.trim(), end: en.value.trim() });
      else await call("tams.play", { ...f, agoSeconds: Number(ago.value), durationSeconds: Number(dur.value) || 0 });
      poll();
    };
    const chip = h("span", { class: "chip" });
    const goB = h("button", { class: "go", onclick: run }, T("play")), stopB = h("button", { class: "stop", onclick: () => call("tams.stop").then(poll) }, T("stop"));
    const kv = h("div", { class: "kv" }), err = h("div", { class: "err" });
    const syncLabel = () => { goB.textContent = mode.value === "follow" ? T("doFollow") : T("play"); };
    mode.addEventListener("change", syncLabel); syncLabel();
    shadow.append(h("style", {}, STYLE), banner,
      h("div", { class: "bar" }, lab(T("status"), chip), lab(T("mode"), mode), lab(T("videoFlow"), vf), lab(T("audioFlow"), af)),
      fields, h("div", { class: "bar" }, goB, stopB),
      h("div", { class: "box" }, h("h4", {}, T("counters")), kv, err), h("p", { class: "hint" }, T("hint")));
    const poll = async () => {
      try {
        const n = ["tams.status", "tams.segmentsFetched", "tams.framesOut", "tams.blocksOut", "tams.gapsFilled", "tams.lateDropped", "tams.errors", "tams.lastError"];
        const v = Object.fromEntries((await Promise.all(n.map(getParam))).map((x, i) => [n[i], x]));
        const s = v["tams.status"] || "idle";
        chip.textContent = T(s); chip.className = "chip " + s;
        goB.disabled = s === "playing" || s === "following"; stopB.disabled = !goB.disabled;
        kv.replaceChildren(...[[T("segs"), v["tams.segmentsFetched"]], [T("frames"), v["tams.framesOut"]], [T("blocks"), v["tams.blocksOut"]], [T("gaps"), v["tams.gapsFilled"]], [T("late"), v["tams.lateDropped"]], [T("errors"), v["tams.errors"]]].flatMap(([a, b]) => [h("span", {}, a), h("span", {}, b ?? 0)]));
        err.textContent = v["tams.lastError"] || "";
      } catch { /* nächster Takt */ }
    };
    poll(); this._i = setInterval(poll, 500);
  }
  disconnectedCallback() { clearInterval(this._i); }
}
if (!customElements.get("omp-tams-reader-panel")) customElements.define("omp-tams-reader-panel", OmpTamsReaderPanel);
