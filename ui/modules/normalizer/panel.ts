// Bedienfeld von `omp-normalizer`: Zustand je Zweig (Video/Ton/Daten) mit Eingang → Haus, Abweichungen, Stufen, Warnungen;
// Hausformat und Ton-Zuordnung als Entwurf mit explizitem „Speichern“; A/V-Sync (Modus, Messung, Übernahme, Offset).
// Feste Zeilenhöhen für Meldungen, damit nichts springt. Kein confirm/alert.
const D: Record<string, Record<string, string>> = {
  de: {
    unreachable: "Node nicht erreichbar", state: "Zustand", video: "Bild", audio: "Ton", data: "Daten", input: "Eingang", house: "Haus", none: "—", noInput: "kein Eingang verbunden",
    s_waiting: "wartet", s_copy: "durchgereicht (bitgleich)", s_convert: "wandelt", s_blocked: "gesperrt", s_error: "Fehler",
    stages: "Stufen", deviations: "Abweichungen", warnings: "Warnungen", noDev: "Keine Abweichung.", changes: "Formatwechsel", lastError: "Letzter Fehler",
    mode: "Modus", modeAuto: "auto (wandeln wo nötig)", modeCopy: "copyOnly (Abweichung nur melden)",
    houseFmt: "Hausformat", width: "Breite", height: "Höhe", rate: "Bildrate", scan: "Raster", prog: "progressiv", tff: "Halbbilder (oberes zuerst)", bff: "Halbbilder (unteres zuerst)",
    colorspace: "Farbraum", transfer: "Übertragung", policy: "Übertragungsfunktion", pHouse: "wie Hausformat", pWarn: "warnen", pBlock: "sperren", pMap: "abbilden",
    withVideo: "Bild im Hausformat", withAudio: "Ton im Hausformat", sampleRate: "Abtastrate (Hz)", channels: "Kanäle",
    audioMap: "Ton-Zuordnung", mapHint: "Zeilen = Hauskanäle, Spalten = Eingangskanäle; Zelle = Verstärkung (leer = keine). Ohne Eintrag gilt 1:1.",
    mapDefault: "Standard (1:1)", mapClear: "Leeren", mapNoIn: "Eingangskanalzahl unbekannt (Ton nicht verbunden).", dataCh: "Datenkanäle beibehalten",
    save: "Speichern", discard: "Verwerfen", dirty: "Ungespeicherte Änderungen", clean: "Gespeichert", saved: "Gespeichert und angewendet.", saveFail: "Speichern fehlgeschlagen",
    invalid: "Ungültig: {d}", avsync: "A/V-Sync", avMode: "Modus", aoff: "aus", amanual: "manuell", aonce: "einmal messen und halten", manualMs: "Manueller Versatz (ms)",
    measured: "Gemessen", applied: "Angewendet", held: "Gehalten", confidence: "Sicherheit", method: "Methode", seconds: "Messdauer (s)", measure: "Messen", apply: "Messwert übernehmen",
    reset: "Zurücksetzen", running: "Messung läuft …", idle: "bereit", hintSign: "Positiv = Ton eilt dem Bild voraus.", vDelay: "Bildverzögerung", aDelay: "Tonverzögerung",
    frames: "Bilder", samples: "Samples", measureFail: "Messung nicht möglich (Bild und Ton verbinden, Marker-Testsignal nötig).", ok: "OK",
    flowing: "fließt", still: "ruht",
  },
  en: {
    unreachable: "Node unreachable", state: "State", video: "Video", audio: "Audio", data: "Data", input: "Input", house: "House", none: "—", noInput: "no input connected",
    s_waiting: "waiting", s_copy: "pass-through (bit-exact)", s_convert: "converting", s_blocked: "blocked", s_error: "error",
    stages: "Stages", deviations: "Deviations", warnings: "Warnings", noDev: "No deviation.", changes: "Format changes", lastError: "Last error",
    mode: "Mode", modeAuto: "auto (convert where needed)", modeCopy: "copyOnly (only report deviation)",
    houseFmt: "House format", width: "Width", height: "Height", rate: "Frame rate", scan: "Scan", prog: "progressive", tff: "interlaced (top field first)", bff: "interlaced (bottom field first)",
    colorspace: "Colour space", transfer: "Transfer", policy: "Transfer function", pHouse: "as house format", pWarn: "warn", pBlock: "block", pMap: "map",
    withVideo: "Video in house format", withAudio: "Audio in house format", sampleRate: "Sample rate (Hz)", channels: "Channels",
    audioMap: "Audio mapping", mapHint: "Rows = house channels, columns = input channels; cell = gain (empty = none). Without entries 1:1 applies.",
    mapDefault: "Default (1:1)", mapClear: "Clear", mapNoIn: "Input channel count unknown (audio not connected).", dataCh: "Keep data channels",
    save: "Save", discard: "Discard", dirty: "Unsaved changes", clean: "Saved", saved: "Saved and applied.", saveFail: "Saving failed",
    invalid: "Invalid: {d}", avsync: "A/V sync", avMode: "Mode", aoff: "off", amanual: "manual", aonce: "measure once and hold", manualMs: "Manual offset (ms)",
    measured: "Measured", applied: "Applied", held: "Held", confidence: "Confidence", method: "Method", seconds: "Duration (s)", measure: "Measure", apply: "Apply measurement",
    reset: "Reset", running: "Measuring …", idle: "ready", hintSign: "Positive = sound leads picture.", vDelay: "Video delay", aDelay: "Audio delay",
    frames: "frames", samples: "samples", measureFail: "Measurement not possible (connect video and audio, marker test signal required).", ok: "OK",
    flowing: "flowing", still: "idle",
  },
};
const lang = document.documentElement.lang === "en" ? "en" : "de";
const T = (k: string, p?: Record<string, string>): string => {
  let s = D[lang][k] ?? D.de[k] ?? k;
  if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
  return s;
};

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

// deno-lint-ignore no-explicit-any
function h(tag: string, attrs?: Record<string, any> | null, ...kids: any[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") (el as HTMLInputElement).value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const STYLE = `
  :host { display: block; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9; --ok: #3fae4b; --err: #e05050; --warn: #d9a02b; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 5px 10px; }
  button:hover:not(:disabled) { border-color: var(--acc); } button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
  input, select { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 3px 5px; }
  input.num { width: 76px; } input.sm { width: 54px; }
  .mut { color: var(--mut); }
  .box { border: 1px solid var(--bd); border-radius: 6px; background: var(--bg2); padding: 8px 10px; margin-bottom: 8px; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; margin-bottom: 8px; }
  .card { border: 1px solid var(--bd); border-left: 4px solid var(--c, var(--mut)); border-radius: 6px; background: var(--bg2); padding: 8px 10px; min-height: 126px; }
  .card .t { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 4px; }
  .card .st { color: var(--c); font-weight: 600; }
  .card .fmt { display: grid; grid-template-columns: 52px 1fr; row-gap: 2px; margin-bottom: 4px; }
  .card .ln { height: 16px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card .ln.warn { color: var(--warn); } .card .ln.err { color: var(--err); }
  .stage { display: inline-block; background: var(--bg3); border: 1px solid var(--bd); border-radius: 10px; padding: 0 7px; margin-right: 4px; font-size: 11px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; margin-bottom: 6px; }
  .row label { display: inline-flex; gap: 5px; align-items: center; }
  .msg { height: 20px; line-height: 20px; margin-bottom: 6px; padding: 0 8px; border-radius: 4px; background: var(--bg2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .msg.err { background: var(--err); color: #fff; } .msg.ok { color: var(--ok); } .msg.dirty { color: var(--warn); }
  .mapwrap { overflow: auto; max-height: 40vh; border: 1px solid var(--bd); border-radius: 4px; background: var(--bg); margin: 6px 0; }
  table.map { border-collapse: separate; border-spacing: 0; }
  table.map th, table.map td { border-right: 1px solid var(--bd); border-bottom: 1px solid var(--bd); padding: 0; text-align: center; }
  table.map th { background: var(--bg2); font-weight: 400; font-size: 10px; color: var(--mut); min-width: 44px; }
  table.map th.r { position: sticky; left: 0; min-width: 52px; text-align: left; padding: 0 6px; }
  table.map td input { width: 44px; border: 0; border-radius: 0; text-align: center; background: transparent; }
  table.map td.on input { background: color-mix(in srgb, var(--acc) 35%, var(--bg)); }
  .big { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; margin-bottom: 8px; }
  .kv .k { color: var(--mut); font-size: 10px; text-transform: uppercase; } .kv .v { height: 18px; font-variant-numeric: tabular-nums; }
`;

const COLOR: Record<string, string> = { waiting: "#8a8a92", copy: "#3fae4b", convert: "#4a90d9", blocked: "#d9a02b", error: "#e05050" };
const parse = (v: unknown): Obj => {
  try {
    return typeof v === "string" && v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};
const fmtVideo = (v?: Obj): string => v ? `${v.width ?? "?"}×${v.height ?? "?"} · ${v.rate ?? "?"} · ${({ progressive: "p", interlaced_tff: "i (TFF)", interlaced_bff: "i (BFF)" } as Obj)[v.scan ?? v.interlace_mode] ?? ""}`.trim() : T("none");
const fmtAudio = (a?: Obj): string => a ? `${a.sample_rate ?? a.sampleRate ?? "?"} Hz · ${a.channels ?? "?"} ch` : T("none");
const ms = (v: unknown): string => typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)} ms` : T("none");

interface Draft { video: Obj | null; audio: Obj | null; policy: string; map: { out: number; in: number; gain: number }[]; dataChannels: number[]; mode: string }

class OmpNormalizerPanel extends HTMLElement {
  #base = "";
  #root!: ShadowRoot;
  #timers: number[] = [];
  #p: Obj = {};
  #draft: Draft | null = null;
  #applied = "";
  #note: { kind: "ok" | "err"; text: string; until: number } | null = null;
  #live!: HTMLElement;
  #edit!: HTMLElement;
  #msg!: HTMLElement;
  #saveBtn!: HTMLButtonElement;
  #discardBtn!: HTMLButtonElement;
  #measureSecs = 10;

  connectedCallback() {
    this.#base = `/api/v1/nodes/${this.getAttribute("node-id")}`;
    this.#root = this.attachShadow({ mode: "open" });
    this.#live = h("div");
    this.#edit = h("div");
    this.#msg = h("div", { class: "msg" });
    this.#saveBtn = h("button", { class: "primary", onclick: () => void this.#save() }, T("save")) as HTMLButtonElement;
    this.#discardBtn = h("button", { onclick: () => { this.#draft = this.#fromParams(); this.#renderEdit(); this.#updateMsg(); } }, T("discard")) as HTMLButtonElement;
    this.#root.append(h("style", {}, STYLE), this.#live, h("div", { class: "row" }, this.#saveBtn, this.#discardBtn), this.#msg, this.#edit);
    void this.#poll();
    this.#timers.push(setInterval(() => void this.#poll(), 1000) as unknown as number);
  }
  disconnectedCallback() {
    for (const t of this.#timers) clearInterval(t);
  }

  #tick = 0;
  // Nur GET /params/<name> existiert; Live-Werte jede Sekunde, Einstellungen nur gelegentlich (und beim ersten Lauf).
  static readonly LIVE = ["normalize.state", "normalize.videoState", "normalize.audioState", "normalize.inputFormat", "normalize.deviations", "normalize.stages", "normalize.warnings",
    "normalize.formatChanges", "normalize.lastError", "normalize.dataState", "normalize.dataFlowing", "avsync.running", "avsync.appliedMs", "avsync.measuredMs", "avsync.confidence",
    "avsync.heldMs", "avsync.videoDelayFrames", "avsync.audioDelaySamples", "avsync.audioDelayCurrentSamples"];
  static readonly CONF = ["normalize.mode", "normalize.houseFormat", "normalize.audioMap", "normalize.transferPolicy", "avsync.mode", "avsync.manualMs"];

  async #poll() {
    try {
      const names = [...OmpNormalizerPanel.LIVE, ...(this.#tick++ % 4 === 0 || !this.#draft ? OmpNormalizerPanel.CONF : [])];
      const res = await Promise.all(names.map(async (n) => {
        const r = await fetch(`${this.#base}/params/${n}`);
        if (!r.ok) throw new Error(n);
        return [n, (await r.json()).value] as [string, unknown];
      }));
      for (const [n, v] of res) this.#p[n] = v;
      const cur = this.#fromParams();
      const sig = JSON.stringify(cur);
      if (!this.#draft || (sig !== this.#applied && !this.#dirty)) {
        this.#draft = cur;
        this.#applied = sig;
        this.#renderEdit();
      } else this.#applied = sig;
      this.#renderLive();
      this.#updateMsg();
    } catch {
      this.#live.replaceChildren(h("div", { class: "msg err" }, T("unreachable")));
    }
  }

  #fromParams(): Draft {
    const hf = parse(this.#p["normalize.houseFormat"]);
    const am = parse(this.#p["normalize.audioMap"]);
    return {
      video: hf.video ?? null,
      audio: hf.audio ?? null,
      policy: String(this.#p["normalize.transferPolicy"] ?? "house"),
      map: (am.outputs ?? []).map((e: Obj) => ({ out: e.out, in: e.in, gain: e.gain ?? 1 })),
      dataChannels: am.dataChannels ?? [],
      mode: String(this.#p["normalize.mode"] ?? "auto"),
    };
  }
  get #dirty(): boolean {
    return !!this.#draft && JSON.stringify(this.#draft) !== this.#applied;
  }

  #flash(kind: "ok" | "err", text: string) {
    this.#note = { kind, text, until: Date.now() + 4000 };
    this.#updateMsg();
  }
  #updateMsg() {
    const n = this.#note && this.#note.until > Date.now() ? this.#note : null;
    const dirty = this.#dirty;
    this.#msg.className = "msg" + (n ? ` ${n.kind}` : dirty ? " dirty" : " ok");
    this.#msg.textContent = n ? n.text : dirty ? T("dirty") : T("clean");
    this.#saveBtn.disabled = !dirty;
    this.#discardBtn.disabled = !dirty;
  }

  async #patch(name: string, value: unknown): Promise<boolean> {
    const r = await fetch(`${this.#base}/params/${name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
    return r.ok;
  }
  async #call(name: string, args: Obj = {}): Promise<boolean> {
    const r = await fetch(`${this.#base}/methods/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return r.ok;
  }

  async #save() {
    const d = this.#draft;
    if (!d) return;
    const house: Obj = {};
    if (d.video) house.video = { ...d.video, width: Number(d.video.width), height: Number(d.video.height) };
    if (d.audio) house.audio = { ...d.audio, sampleRate: Number(d.audio.sampleRate), channels: Number(d.audio.channels) };
    const outs = d.map.filter((e) => e.gain > 0);
    const map = { outputs: outs.map((e) => ({ out: e.out, in: e.in, gain: e.gain })), dataChannels: d.dataChannels };
    const steps: [string, unknown][] = [["normalize.mode", d.mode], ["normalize.transferPolicy", d.policy], ["normalize.houseFormat", JSON.stringify(house)], ["normalize.audioMap", JSON.stringify(map)]];
    for (const [n, v] of steps) {
      if (!(await this.#patch(n, v))) {
        const why = String(this.#p["normalize.lastError"] ?? "").trim();
        return this.#flash("err", why ? `${T("saveFail")}: ${why} (${n})` : `${T("saveFail")} (${n})`);
      }
    }
    this.#applied = JSON.stringify(d);
    this.#flash("ok", T("saved"));
  }

  #sel(value: string, opts: [string, string][], on: (v: string) => void): HTMLElement {
    const s = h("select", { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    for (const [v, l] of opts) s.append(h("option", { value: v, selected: v === value }, l));
    s.value = value;
    return s;
  }
  #num(value: unknown, on: (v: number) => void, cls = "num", attrs: Obj = {}): HTMLElement {
    return h("input", { class: cls, type: "number", value: value ?? "", ...attrs, onchange: (e: Event) => { on(Number((e.target as HTMLInputElement).value)); this.#updateMsg(); } });
  }
  #txt(value: unknown, on: (v: string) => void, w = 90): HTMLElement {
    return h("input", { type: "text", style: `width:${w}px`, value: value ?? "", onchange: (e: Event) => { on((e.target as HTMLInputElement).value.trim()); this.#updateMsg(); } });
  }

  // ---- Live-Bereich: Karten, A/V-Sync (wird jede Sekunde neu aufgebaut, enthält keine Entwurfsfelder außer A/V-Aktionen) ----
  #renderLive() {
    const p = this.#p;
    const inF = parse(p["normalize.inputFormat"]);
    const dev = parse(p["normalize.deviations"]);
    const stg = parse(p["normalize.stages"]);
    const wrn = parse(p["normalize.warnings"]);
    const d = this.#draft;
    const house = { video: d?.video ?? undefined, audio: d?.audio ?? undefined };
    const err = String(p["normalize.lastError"] ?? "");
    const card = (title: string, state: string, inp: string, hou: string, stages: string[], devs: string[], warns: string[]) =>
      h("div", { class: "card", style: `--c:${COLOR[state] ?? COLOR.waiting}` },
        h("div", { class: "t" }, title, h("span", { class: "st" }, T(`s_${state}`))),
        h("div", { class: "fmt" }, h("span", { class: "mut" }, T("input")), h("span", {}, inp), h("span", { class: "mut" }, T("house")), h("span", {}, hou)),
        h("div", { class: "ln" }, stages.length ? stages.map((s) => h("span", { class: "stage" }, s)) : h("span", { class: "mut" }, state === "convert" ? "" : T("noDev"))),
        h("div", { class: "ln", title: devs.join("; ") }, devs.length ? `${T("deviations")}: ${devs.join("; ")}` : ""),
        h("div", { class: "ln warn", title: warns.join("; ") }, warns.join("; ")));
    const vs = String(p["normalize.videoState"] ?? "waiting"), as = String(p["normalize.audioState"] ?? "waiting");
    const dataState = String(p["normalize.dataState"] ?? "");
    const flowing = p["normalize.dataFlowing"] === true;
    const cards = h("div", { class: "cards" },
      card(T("video"), vs, inF.video ? fmtVideo(inF.video) : T("noInput"), fmtVideo(house.video), stg.video ?? [], dev.video ?? [], wrn.video ?? []),
      card(T("audio"), as, inF.audio ? fmtAudio(inF.audio) : T("noInput"), fmtAudio(house.audio), stg.audio ?? [], dev.audio ?? [], wrn.audio ?? []),
      h("div", { class: "card", style: `--c:${flowing ? COLOR.copy : COLOR.waiting}` },
        h("div", { class: "t" }, T("data"), h("span", { class: "st" }, flowing ? T("flowing") : T("still"))),
        h("div", { class: "ln mut" }, dataState || T("none")),
        h("div", { class: "ln mut" }, `${T("changes")}: ${p["normalize.formatChanges"] ?? 0}`)));
    const errBox = err ? h("div", { class: "msg err", title: err }, `${T("lastError")}: ${err}`) : null;
    if (this.#live.contains(this.#root.activeElement)) return; // Eingabe nicht wegnehmen
    this.#live.replaceChildren(cards, ...(errBox ? [errBox] : []), this.#avsync());
  }

  #avsync(): HTMLElement {
    const p = this.#p;
    const running = p["avsync.running"] === "running";
    const mode = String(p["avsync.mode"] ?? "once");
    const mval = p["avsync.measuredMs"];
    const kv = (k: string, v: string) => h("div", { class: "kv" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
    const act = (f: () => Promise<boolean>) => async () => {
      if (!(await f())) this.#flash("err", T("measureFail"));
      void this.#poll();
    };
    const secs = h("input", { class: "sm", type: "number", min: 2, max: 120, value: this.#measureSecs, onchange: (e: Event) => { this.#measureSecs = Number((e.target as HTMLInputElement).value) || 10; } });
    const manual = h("input", { class: "num", type: "number", step: "1", value: p["avsync.manualMs"] ?? 0, disabled: mode !== "manual",
      onchange: (e: Event) => void this.#patch("avsync.manualMs", Number((e.target as HTMLInputElement).value)).then(() => this.#poll()) });
    return h("div", { class: "box" }, h("h4", {}, T("avsync")),
      h("div", { class: "grid4" },
        h("div", { class: "kv" }, h("div", { class: "k" }, T("applied")), h("div", { class: "big" }, ms(p["avsync.appliedMs"]))),
        h("div", { class: "kv" }, h("div", { class: "k" }, T("measured")), h("div", { class: "big" }, ms(mval))),
        kv(T("held"), ms(p["avsync.heldMs"])),
        kv(T("confidence"), typeof p["avsync.confidence"] === "number" ? `${Math.round((p["avsync.confidence"] as number) * 100)} %` : T("none")),
        kv(T("vDelay"), `${p["avsync.videoDelayFrames"] ?? 0} ${T("frames")}`),
        kv(T("aDelay"), `${p["avsync.audioDelayCurrentSamples"] ?? 0} / ${p["avsync.audioDelaySamples"] ?? 0} ${T("samples")}`)),
      h("div", { class: "row" },
        h("label", {}, T("avMode"), this.#sel(mode, [["off", T("aoff")], ["manual", T("amanual")], ["once", T("aonce")]], (v) => void this.#patch("avsync.mode", v).then(() => this.#poll()))),
        h("label", {}, T("manualMs"), manual),
        h("label", {}, T("seconds"), secs),
        h("button", { disabled: running, onclick: act(() => this.#call("avsync.measure", { seconds: this.#measureSecs })) }, running ? T("running") : T("measure")),
        h("button", { disabled: typeof mval !== "number", onclick: act(() => this.#call("avsync.apply")) }, T("apply")),
        h("button", { onclick: act(() => this.#call("avsync.reset")) }, T("reset"))),
      h("div", { class: "mut" }, T("hintSign")));
  }

  // ---- Bearbeitungsbereich: wird nur bei Änderung des Entwurfs neu aufgebaut ----
  #renderEdit() {
    const d = this.#draft;
    if (!d) return;
    const dirtyTick = () => this.#updateMsg();
    const hv = d.video, ha = d.audio;
    const modeRow = h("div", { class: "box" }, h("h4", {}, T("mode")),
      h("div", { class: "row" }, this.#sel(d.mode, [["auto", T("modeAuto")], ["copyOnly", T("modeCopy")]], (v) => { d.mode = v; dirtyTick(); })));
    const vBox = h("div", { class: "box" }, h("h4", {}, `${T("houseFmt")} · ${T("video")}`),
      h("div", { class: "row" }, h("label", {}, h("input", { type: "checkbox", checked: !!hv, onchange: (e: Event) => { d.video = (e.target as HTMLInputElement).checked ? { width: 1920, height: 1080, rate: "25/1", scan: "progressive" } : null; this.#renderEdit(); dirtyTick(); } }), T("withVideo"))),
      hv ? h("div", { class: "row" },
        h("label", {}, T("width"), this.#num(hv.width, (v) => { hv.width = v; })),
        h("label", {}, T("height"), this.#num(hv.height, (v) => { hv.height = v; })),
        h("label", {}, T("rate"), this.#txt(hv.rate, (v) => { hv.rate = v; }, 80)),
        h("label", {}, T("scan"), this.#sel(hv.scan ?? "progressive", [["progressive", T("prog")], ["interlaced_tff", T("tff")], ["interlaced_bff", T("bff")]], (v) => { hv.scan = v; dirtyTick(); })),
        h("label", {}, T("colorspace"), this.#txt(hv.colorspace ?? "", (v) => { if (v) hv.colorspace = v; else delete hv.colorspace; }, 90)),
        h("label", {}, T("transfer"), this.#txt(hv.transfer ?? "", (v) => { if (v) hv.transfer = v; else delete hv.transfer; }, 90)),
        h("label", {}, T("policy"), this.#sel(d.policy, [["house", T("pHouse")], ["warn", T("pWarn")], ["block", T("pBlock")], ["map", T("pMap")]], (v) => { d.policy = v; dirtyTick(); }))) : null);
    const aBox = h("div", { class: "box" }, h("h4", {}, `${T("houseFmt")} · ${T("audio")}`),
      h("div", { class: "row" }, h("label", {}, h("input", { type: "checkbox", checked: !!ha, onchange: (e: Event) => { d.audio = (e.target as HTMLInputElement).checked ? { sampleRate: 48000, channels: 2 } : null; this.#renderEdit(); dirtyTick(); } }), T("withAudio"))),
      ha ? h("div", { class: "row" },
        h("label", {}, T("sampleRate"), this.#num(ha.sampleRate ?? ha.sample_rate, (v) => { ha.sampleRate = v; delete ha.sample_rate; })),
        h("label", {}, T("channels"), this.#num(ha.channels, (v) => { ha.channels = v; this.#renderEdit(); }, "sm", { min: 1, max: 64 }))) : null);
    this.#edit.replaceChildren(modeRow, vBox, aBox, this.#mapBox(d));
  }

  #mapBox(d: Draft): HTMLElement {
    const inCh = parse(this.#p["normalize.inputFormat"]).audio?.channels as number | undefined;
    const outCh = Number(d.audio?.channels ?? 0);
    const box = h("div", { class: "box" }, h("h4", {}, T("audioMap")));
    if (!outCh) return box;
    const nIn = inCh ?? Math.max(outCh, ...d.map.map((e) => e.in));
    const gain = (o: number, i: number) => d.map.find((e) => e.out === o && e.in === i)?.gain;
    const set = (o: number, i: number, g: number | null) => {
      d.map = d.map.filter((e) => !(e.out === o && e.in === i));
      if (g !== null && g > 0) d.map.push({ out: o, in: i, gain: g });
      d.map.sort((a, b) => a.out - b.out || a.in - b.in);
      this.#updateMsg();
    };
    const head = h("tr", {}, h("th", { class: "r" }, ""), Array.from({ length: nIn }, (_, i) => h("th", {}, `In ${i + 1}`)));
    const rows = Array.from({ length: outCh }, (_, o) => h("tr", {}, h("th", { class: "r" }, `${T("house")} ${o + 1}`), Array.from({ length: nIn }, (_, i) => {
      const g = gain(o + 1, i + 1);
      const inp = h("input", { type: "number", step: "0.1", min: 0, max: 4, value: g ?? "", title: `In ${i + 1} → ${T("house")} ${o + 1}`,
        onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; set(o + 1, i + 1, v === "" ? null : Number(v)); (e.target as HTMLElement).parentElement!.className = v !== "" && Number(v) > 0 ? "on" : ""; } });
      return h("td", { class: g ? "on" : "" }, inp);
    })));
    const setAll = (f: () => void) => () => { f(); this.#renderEdit(); this.#updateMsg(); };
    box.append(
      h("div", { class: "mut", style: "margin-bottom:4px" }, T("mapHint")),
      inCh ? "" : h("div", { class: "mut" }, T("mapNoIn")),
      h("div", { class: "row" },
        h("button", { onclick: setAll(() => { d.map = Array.from({ length: Math.min(nIn, outCh) }, (_, k) => ({ out: k + 1, in: k + 1, gain: 1 })); }) }, T("mapDefault")),
        h("button", { onclick: setAll(() => { d.map = []; }) }, T("mapClear"))),
      h("div", { class: "mapwrap" }, h("table", { class: "map" }, h("thead", {}, head), h("tbody", {}, rows))),
    );
    return box;
  }
}

if (!customElements.get("omp-normalizer-panel")) customElements.define("omp-normalizer-panel", OmpNormalizerPanel);
