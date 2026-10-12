// Playout-Puffer-Panel (Kap. 39.7): Zustand, Füllstand, Speicher, Ausfall-Zähler und die drei einstellbaren
// Werte (Puffertiefe, Wiederaufnahme, Anzeige bei Ausfall). Fragt einmal je Sekunde den Sammelwert `status` ab.
const T = (() => {
  const D = {
    de: {
      fill: "Vorlauf", run: "Läuft", hold: "Überbrückung",
      stateHint: {
        fill: "Der Puffer füllt sich — der Ausgang zeigt Schwarz/Standbild, bis die Tiefe erreicht ist.",
        run: "Normalbetrieb: der Ausgang läuft um die Puffertiefe verzögert.",
        hold: "Eingang liefert nichts mehr und der Puffer ist aufgebraucht — Ausgang hält (Standbild/Schwarz, Stille).",
      },
      depth: "Puffertiefe", memory: "Speicher", video: "Bild", audio: "Ton", settings: "Einstellungen",
      bufferMs: "Puffertiefe (ms)", resumeMs: "Wiederaufnahme nach (ms)", holdMode: "Bei Ausfall zeigen", last: "letztes Bild", black: "Schwarz",
      apply: "Übernehmen", saved: "Gespeichert", failed: "Nicht übernommen",
      inputs: "Eingänge", noVideo: "Kein Bild verbunden", noAudio: "Kein Ton verbunden", age: "letzte Daten vor",
      counters: "Zähler", underruns: "Aufgebraucht (Ausfälle)", resumes: "Wiederaufnahmen", holdTicks: "Haltebilder", dropped: "Verworfen (Speichergrenze)",
      trimmed: "Aufgeholt (übersprungen)", seeks: "Ton neu ausgerichtet", jumps: "Zeitsprünge im Eingang", rebuilds: "Eingang neu aufgebaut",
      origin: "Zeitstempel aus Ursprung", delay: "Delay-Ausgleich (Bilder)", ms: "ms",
      refillPermille: "Wiederauffüllen (‰)", refilling: "baut Tiefe wieder auf", refillFrames: "Haltebilder beim Auffüllen",
    },
    en: {
      fill: "Filling", run: "Running", hold: "Bridging",
      stateHint: {
        fill: "The buffer is filling — the output shows black/freeze until the depth is reached.",
        run: "Normal operation: the output runs delayed by the buffer depth.",
        hold: "Input delivers nothing and the buffer is used up — output holds (freeze/black, silence).",
      },
      depth: "Buffer depth", memory: "Memory", video: "Picture", audio: "Sound", settings: "Settings",
      bufferMs: "Buffer depth (ms)", resumeMs: "Resume after (ms)", holdMode: "During an outage show", last: "last picture", black: "black",
      apply: "Apply", saved: "Saved", failed: "Not applied",
      inputs: "Inputs", noVideo: "No picture connected", noAudio: "No sound connected", age: "last data",
      counters: "Counters", underruns: "Used up (outages)", resumes: "Resumes", holdTicks: "Held pictures", dropped: "Dropped (memory limit)",
      trimmed: "Caught up (skipped)", seeks: "Sound re-aligned", jumps: "Input time jumps", rebuilds: "Input rebuilt",
      origin: "Timestamps from origin", delay: "Delay compensation (frames)", ms: "ms",
      refillPermille: "Refill (‰)", refilling: "rebuilding depth", refillFrames: "Held pictures while refilling",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
})();

// Reine Hilfen (ohne DOM testbar).
function pct(value, max) {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GiB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(0) + " MiB";
  return Math.round(n / 1024) + " KiB";
}

class OmpPlayoutBufferPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .badge { padding: 3px 10px; border-radius: 3px; font-weight: bold; background: #333; }
      .badge.run { background: #1f6b34; } .badge.fill { background: #8a6a12; } .badge.hold { background: #a33; }
      .hint { opacity: .65; } h4 { margin: 12px 0 6px; font-size: 13px; }
      .bar { position: relative; height: 14px; background: #2a2a2a; border: 1px solid #555; border-radius: 3px; overflow: hidden; min-width: 220px; flex: 1; }
      .bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: #3a7bd5; }
      .bar.mem > i { background: #7a5ad5; } .bar.warn > i { background: #d58a3a; } .bar.crit > i { background: #d53a3a; }
      .bar > span { position: absolute; left: 6px; top: 0; font-size: 11px; line-height: 14px; text-shadow: 0 0 3px #000; }
      label { display: flex; flex-direction: column; gap: 2px; }
      input, select, button { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 4px 6px; font-size: 12px; }
      button { cursor: pointer; }
      table { border-collapse: collapse; } td { padding: 2px 10px 2px 0; } td.v { font-variant-numeric: tabular-nums; text-align: right; }
    `;
    const root = document.createElement("div");
    shadow.append(style, root);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    const badge = el("span", "badge");
    const hint = el("span", "hint");
    const top = el("div", "row"); top.append(badge, hint);
    const mk = (cls) => { const bar = el("div", "bar " + (cls || "")); const fillEl = el("i"); const txt = el("span"); bar.append(fillEl, txt); return { bar, fillEl, txt }; };
    const vBar = mk(), aBar = mk(), mBar = mk("mem");
    const barRow = (label, b) => { const r = el("div", "row"); const l = el("span", "", label); l.style.minWidth = "70px"; r.append(l, b.bar); return r; };
    const inputsEl = el("div", "hint");

    const bufIn = el("input"); bufIn.type = "number"; bufIn.min = 100; bufIn.max = 20000; bufIn.step = 100; bufIn.style.width = "90px";
    const resIn = el("input"); resIn.type = "number"; resIn.min = 0; resIn.max = 20000; resIn.step = 100; resIn.style.width = "90px";
    const refIn = el("input"); refIn.type = "number"; refIn.min = 0; refIn.max = 100; refIn.step = 1; refIn.style.width = "70px";
    const holdSel = el("select");
    for (const v of ["last", "black"]) { const o = el("option", "", T(v)); o.value = v; holdSel.append(o); }
    const applyBtn = el("button", "", T("apply"));
    const msg = el("span", "hint");
    const lab = (text, input) => { const l = el("label"); l.append(el("span", "hint", text), input); return l; };
    const form = el("div", "row"); form.append(lab(T("bufferMs"), bufIn), lab(T("resumeMs"), resIn), lab(T("refillPermille"), refIn), lab(T("holdMode"), holdSel), applyBtn, msg);
    const table = el("table");

    root.append(top, barRow(T("video"), vBar), barRow(T("audio"), aBar), barRow(T("memory"), mBar), inputsEl,
      Object.assign(el("h4", "", T("settings")), {}), form, Object.assign(el("h4", "", T("counters")), {}), table);

    const base = `/api/v1/nodes/${nodeId}/params/`;
    const getParam = async (n) => { try { const r = await fetch(base + encodeURIComponent(n)); return r.ok ? (await r.json()).value : undefined; } catch { return undefined; } };
    const setParam = (n, v) => fetch(base + encodeURIComponent(n), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });

    let editing = false;
    for (const i of [bufIn, resIn, refIn, holdSel]) i.addEventListener("focus", () => { editing = true; });
    applyBtn.addEventListener("click", async () => {
      const results = await Promise.all([
        setParam("bufferMs", Number(bufIn.value)),
        setParam("resumeMs", Number(resIn.value)),
        setParam("refillPermille", Number(refIn.value)),
        setParam("holdMode", holdSel.value),
      ]);
      msg.textContent = results.every((r) => r.ok) ? T("saved") : T("failed");
      editing = false;
      setTimeout(() => { msg.textContent = ""; }, 3000);
      poll(true);
    });

    const counterRows = [
      ["underruns", "underruns"], ["resumes", "resumes"], ["holdTicks", "holdTicks"], ["dropped", "droppedFrames"],
      ["trimmed", "trimmedFrames"], ["refillFrames", "refillFrames"], ["seeks", "audioSeeks"], ["jumps", "tsJumps"], ["rebuilds", "inputRebuilds"],
    ];
    const poll = async (fillForm) => {
      const raw = await getParam("status");
      if (!raw) return;
      let s; try { s = JSON.parse(raw); } catch { return; }
      badge.textContent = T(s.state) + (s.refilling ? " · " + T("refilling") : ""); badge.className = "badge " + s.state;
      hint.textContent = T("stateHint")[s.state] || "";
      const set = (b, v, max, txt) => { b.fillEl.style.width = pct(v, max) + "%"; b.txt.textContent = txt; };
      set(vBar, s.fillMs, s.targetMs, `${s.fillMs} / ${s.targetMs} ${T("ms")}`);
      set(aBar, s.audioFillMs, s.targetMs, `${s.audioFillMs} / ${s.targetMs} ${T("ms")}`);
      const memPct = pct(s.bufferBytes, s.maxBytes);
      set(mBar, s.bufferBytes, s.maxBytes, `${fmtBytes(s.bufferBytes)} / ${fmtBytes(s.maxBytes)}`);
      mBar.bar.classList.toggle("warn", memPct > 80); mBar.bar.classList.toggle("crit", memPct > 95);
      const parts = [];
      parts.push(s.videoConnected ? `${T("video")}: ${T("age")} ${s.videoInputAgeMs} ${T("ms")}` : T("noVideo"));
      parts.push(s.audioConnected ? `${T("audio")}: ${T("age")} ${s.audioInputAgeMs} ${T("ms")}` : T("noAudio"));
      inputsEl.textContent = T("inputs") + ": " + parts.join(" · ");
      table.replaceChildren();
      const add = (k, v) => { const tr = el("tr"); tr.append(el("td", "", k), el("td", "v", String(v))); table.append(tr); };
      for (const [label, key] of counterRows) add(T(label), s[key]);
      add(T("origin"), `${s.originTsVideoPct}% / ${s.originTsAudioPct}%`);
      add(T("delay"), s.delayFrames);
      if (fillForm || !editing) {
        const [b, r, h, f] = await Promise.all([getParam("bufferMs"), getParam("resumeMs"), getParam("holdMode"), getParam("refillPermille")]);
        if (document.activeElement !== bufIn && b != null) bufIn.value = b;
        if (document.activeElement !== resIn && r != null) resIn.value = r;
        if (document.activeElement !== holdSel && h) holdSel.value = h;
        if (document.activeElement !== refIn && f != null) refIn.value = f;
      }
    };
    poll(true);
    this._interval = setInterval(() => poll(false), 1000);
  }
  disconnectedCallback() { clearInterval(this._interval); }
}

if (!customElements.get("omp-playout-buffer-panel")) customElements.define("omp-playout-buffer-panel", OmpPlayoutBufferPanel);
