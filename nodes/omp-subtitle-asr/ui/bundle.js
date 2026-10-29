// i18n (de/en): Sprache aus <html lang> (setzt die Shell), Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
      "asr.source": "— Audioquelle wählen —", "asr.status": "Status", "asr.engine": "Erkennung", "asr.enabled": "Untertitelung aktiv",
      "asr.language": "Sprache", "asr.auto": "automatisch erkennen", "asr.live": "Live in Grafik-Node anzeigen", "asr.target": "Grafik-Node",
      "asr.noTarget": "— keiner —", "asr.mixer": "Bildmischer (Keyer)", "asr.track": "Spur mitschreiben (SRT)", "asr.trackName": "Spurname", "asr.trackStart": "● Spur starten",
      "asr.trackStop": "■ Spur beenden", "asr.trackOn": "Spur läuft: {name}", "asr.last": "Zuletzt erkannt", "asr.none": "noch nichts erkannt",
      "asr.stats": "Segmente {segments} · verworfen {dropped} · Fehler {errors} · letzte Erkennung {lastLatencyMs} ms", "asr.clear": "Liste leeren",
      "asr.idle": "wartet auf Audioquelle", "asr.credit": "Spracherkennung: whisper.cpp und Whisper-Modelle (MIT-Lizenz). Lizenztexte liegen im Paket.", "asr.model": "Modell", "asr.starting": "Engine lädt …", "asr.modelHint": "Größere Modelle erkennen genauer, brauchen aber mehr Rechenzeit; nach dem Wechsel lädt die Engine einige Sekunden.", "asr.noModel": "Engine läuft nicht im Node", "asr.listening": "hört zu", "asr.transcribing": "erkennt …", "asr.engineOk": "bereit",
      "asr.hint": "Der Text erscheint mit einigen Sekunden Verzug (nach dem Sprechen); die Spur trägt die echten Sprechzeiten.",
    },
    en: {
      "asr.source": "— choose audio source —", "asr.status": "Status", "asr.engine": "Recognition", "asr.enabled": "Subtitling active",
      "asr.language": "Language", "asr.auto": "detect automatically", "asr.live": "Show live in graphics node", "asr.target": "Graphics node",
      "asr.noTarget": "— none —", "asr.mixer": "Video mixer (keyer)", "asr.track": "Write track (SRT)", "asr.trackName": "Track name", "asr.trackStart": "● Start track",
      "asr.trackStop": "■ Stop track", "asr.trackOn": "Track running: {name}", "asr.last": "Last recognised", "asr.none": "nothing recognised yet",
      "asr.stats": "Segments {segments} · dropped {dropped} · errors {errors} · last recognition {lastLatencyMs} ms", "asr.clear": "Clear list",
      "asr.idle": "waiting for audio source", "asr.credit": "Speech recognition: whisper.cpp and Whisper models (MIT licence). Licence texts are included in the package.", "asr.model": "Model", "asr.starting": "Engine loading …", "asr.modelHint": "Larger models recognise more accurately but need more processing time; after a change the engine loads for a few seconds.", "asr.noModel": "Engine does not run inside the node", "asr.listening": "listening", "asr.transcribing": "recognising …", "asr.engineOk": "ready",
      "asr.hint": "Text appears a few seconds after speech; the track carries the real speaking times.",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

const LANGS = [["de", "Deutsch"], ["en", "English"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["tr", "Türkçe"], ["pl", "Polski"], ["auto", null]];

class OmpSubtitleAsrPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
      .row > label { min-width: 120px; color: #aaa; }
      omp-source-selector { display: block; width: 100%; margin-bottom: 6px; }
      select, input[type=text] { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 3px 6px; font-size: 12px; }
      button { background: #333; color: #eee; border: 1px solid #555; border-radius: 3px; cursor: pointer; font-size: 12px; padding: 4px 10px; }
      .chip { padding: 1px 8px; border-radius: 9px; background: #333; }
      .chip.ok { background: #1f5a2c; } .chip.busy { background: #6b5a14; } .chip.err { background: #7a2323; }
      .last { background: #111; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; min-height: 2.4em; white-space: pre-wrap; font-size: 14px; }
      .cues { max-height: 160px; overflow: auto; background: #151515; border: 1px solid #2a2a2a; border-radius: 4px; padding: 4px 8px; color: #bbb; }
      .cues div { padding: 1px 0; white-space: pre-wrap; } .cues b { color: #777; font-weight: normal; margin-right: 6px; }
      p { color: #888; margin: 4px 0; }
    `;
    const el = (tag, props = {}, ...kids) => {
      const e = document.createElement(tag);
      Object.assign(e, props);
      e.append(...kids);
      return e;
    };
    const select = document.createElement("omp-source-selector");
    select.emptyLabel = T("asr.source");
    select.accepts = ["audio"];

    const statusChip = el("span", { className: "chip" });
    const engineChip = el("span", { className: "chip" });
    const enabled = el("input", { type: "checkbox" });
    const model = el("select", { title: T("asr.modelHint") });
    const lang = el("select");
    for (const [v, name] of LANGS) lang.append(el("option", { value: v }, name ?? T("asr.auto")));
    const live = el("input", { type: "checkbox" });
    const target = el("select");
    const mixer = el("select");
    const trackName = el("input", { type: "text", placeholder: "sendung-2026-10-29" });
    const trackBtn = el("button", {}, T("asr.trackStart"));
    const trackInfo = el("span", { className: "chip" });
    const last = el("div", { className: "last" });
    const cues = el("div", { className: "cues" });
    const stats = el("p");
    const clearBtn = el("button", {}, T("asr.clear"));

    shadow.append(
      style, select,
      el("div", { className: "row" }, el("label", {}, T("asr.status")), statusChip, el("label", { style: "min-width:0" }, T("asr.engine")), engineChip),
      el("div", { className: "row" }, el("label", {}, T("asr.model")), model),
      el("div", { className: "row" }, el("label", {}, T("asr.enabled")), enabled),
      el("div", { className: "row" }, el("label", {}, T("asr.language")), lang),
      el("div", { className: "row" }, el("label", {}, T("asr.live")), live),
      el("div", { className: "row" }, el("label", {}, T("asr.target")), target),
      el("div", { className: "row" }, el("label", {}, T("asr.mixer")), mixer),
      el("div", { className: "row" }, el("label", {}, T("asr.track")), trackName, trackBtn, trackInfo),
      el("div", { className: "row" }, el("label", {}, T("asr.last"))), last, cues, stats,
      el("div", { className: "row" }, clearBtn), el("p", {}, T("asr.hint")), el("p", { style: "font-size:10px;opacity:.7" }, T("asr.credit")),
    );

    const call = (method, body) => fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      return res.ok ? (await res.json()).value : undefined;
    };
    const setParam = (name, value) => fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });

    enabled.addEventListener("change", () => setParam("enabled", enabled.checked));
    lang.addEventListener("change", () => setParam("language", lang.value));
    model.addEventListener("change", async () => { await call("engine.setModel", { name: model.value }); refresh(); });
    live.addEventListener("change", () => setParam("liveDisplay", live.checked));
    target.addEventListener("change", () => setParam("targetGraphicsLabel", target.value));
    mixer.addEventListener("change", () => setParam("targetMixerLabel", mixer.value));
    select.addEventListener("change", () => call("selectSource", { senderId: select.value }));
    clearBtn.addEventListener("click", () => call("clear"));
    let trackActive = false;
    trackBtn.addEventListener("click", async () => {
      if (trackActive) await call("track.stop");
      else if (trackName.value.trim()) await call("track.start", { name: trackName.value.trim() });
      refresh();
    });

    let catalogKey = "";
    let catalogAt = 0;
    const refresh = async () => {
      const [status, engineStatus, st, en, lg, ld, tg, tn, ta, lt, cl, sources, nodes, connected, tm, models, curModel] = await Promise.all(
        ["status", "engineStatus", "stats", "enabled", "language", "liveDisplay", "targetGraphicsLabel", "trackName", "trackActive", "lastText", "cues", "availableSources", "availableNodes", "connectedFlowId", "targetMixerLabel", "models", "model"].map(getParam));
      const sKey = String(status || "idle");
      const base = sKey.split(":")[0];
      statusChip.textContent = sKey.startsWith("error") ? sKey : T("asr." + base);
      statusChip.className = "chip " + (sKey.startsWith("error") ? "err" : base === "transcribing" ? "busy" : base === "listening" ? "ok" : "");
      const loading = String(engineStatus ?? "").startsWith("starting:");
      engineChip.textContent = engineStatus === "ok" ? T("asr.engineOk") : loading ? T("asr.starting") : String(engineStatus ?? "");
      engineChip.className = "chip " + (engineStatus === "ok" ? "ok" : loading ? "busy" : "err");
      const modelList = Array.isArray(models) ? models : [];
      model.disabled = !modelList.length;
      if (shadow.activeElement !== model) {
        if (model.options.length !== modelList.length || [...model.options].some((o, i) => o.value !== modelList[i])) {
          model.replaceChildren(...(modelList.length ? modelList.map((m) => el("option", { value: m }, m)) : [el("option", { value: "" }, T("asr.noModel"))]));
        }
        model.value = curModel || "";
      }
      if (document.activeElement !== enabled) enabled.checked = !!en;
      if (shadow.activeElement !== lang) lang.value = lg || "de";
      live.checked = !!ld;
      const nodeList = Array.isArray(nodes) ? nodes : [];
      const want = ["", ...nodeList];
      if (target.options.length !== want.length || [...target.options].some((o, i) => o.value !== want[i])) {
        target.replaceChildren(el("option", { value: "" }, T("asr.noTarget")), ...nodeList.map((l) => el("option", { value: l }, l)));
      }
      if (mixer.options.length !== want.length || [...mixer.options].some((o, i) => o.value !== want[i])) {
        mixer.replaceChildren(el("option", { value: "" }, T("asr.noTarget")), ...nodeList.map((l) => el("option", { value: l }, l)));
      }
      if (shadow.activeElement !== target) target.value = tg || "";
      if (shadow.activeElement !== mixer) mixer.value = tm || "";
      trackActive = !!ta;
      trackBtn.textContent = trackActive ? T("asr.trackStop") : T("asr.trackStart");
      trackInfo.textContent = trackActive ? T("asr.trackOn", { name: tn }) : "";
      trackInfo.style.display = trackActive ? "" : "none";
      if (shadow.activeElement !== trackName && tn) trackName.value = tn;
      last.textContent = lt || T("asr.none");
      const list = Array.isArray(cl) ? cl : [];
      cues.replaceChildren(...list.slice().reverse().map((c) => { const d = el("div"); d.append(el("b", {}, new Date(c.startMs).toLocaleTimeString()), c.text); return d; }));
      stats.textContent = st ? T("asr.stats", st) : "";
      const sourceList = Array.isArray(sources) ? sources : [];
      const key = JSON.stringify(sourceList);
      if (key !== catalogKey || Date.now() - catalogAt > 15000) {
        catalogKey = key;
        catalogAt = Date.now();
        const catalog = await customElements.get("omp-source-selector").loadCatalog(nodeId, sourceList);
        select.currentWorkflowId = catalog.currentWorkflowId;
        select.entries = catalog.entries;
      }
      if (!select.value && connected) {
        const match = sourceList.find((s) => s.senderId);
        if (match) select.value = match.senderId;
      }
    };
    refresh();
    this._timer = setInterval(refresh, 1500);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }
}

if (!customElements.get("omp-subtitle-asr-panel")) {
  customElements.define("omp-subtitle-asr-panel", OmpSubtitleAsrPanel);
}
