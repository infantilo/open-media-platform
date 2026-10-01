// Abhör-Controller als Shell-Dienst (Nutzerwunsch 2026-10-01: der Operator
// des Audiomischers soll den Ton in seiner Webseite hören; der Ton brach ab,
// sobald die Audiomonitor-Kachel den Fokus verlor). Ursache: Wiedergabe
// (AudioContext, Worklet, fetch-Reader) lebte im Panel-Custom-Element des
// Nodes (nodes/omp-audio-monitor/ui/bundle.js) und wurde in
// disconnectedCallback abgebrochen. Hier gehört sie der Shell: ein Kontext,
// ein Strom, unabhängig davon, welche Kachel/welcher Tab gerade sichtbar ist.
//
// Das Panel bleibt der Ort der Quellenwahl; es ruft nur noch
// `window.ompListen.start(nodeId)` / `.stop()` auf und zeigt den Zustand.
// Fehlt der Dienst (Node-UI ohne Shell), fällt das Panel auf seine
// eigene Wiedergabe zurück.

import { buildListenControls, buildListenWidget } from "./listen-ui.ts";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 4; // F32LE, s. omp_mediaio::pcm_stream
const VOLUME_KEY = "omp-listen-volume";
const SYNC_KEY = "omp-listen-sync-ms";
const MAX_SYNC_MS = 1000;
const DIM_GAIN = 0.1; // -20 dB
const RECONNECT_MS = [500, 1000, 2000, 4000];

// Jitter-Puffer mit Hysterese: Begründung in nodes/omp-audio-monitor/ui/bundle.js.
const WORKLET_SOURCE = `
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._queuedFrames = 0;
    this._buffering = true;
    this.port.onmessage = (ev) => {
      const [left, right] = ev.data;
      this._queue.push([left, right]);
      this._queuedFrames += left.length;
      while (this._queuedFrames > sampleRate) {
        this._queuedFrames -= this._queue.shift()[0].length;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    if (this._buffering) {
      if (this._queuedFrames < sampleRate * 0.15) return true;
      this._buffering = false;
    }
    let filled = 0;
    while (filled < left.length && this._queue.length > 0) {
      const [ql, qr] = this._queue[0];
      const take = Math.min(left.length - filled, ql.length);
      left.set(ql.subarray(0, take), filled);
      right.set(qr.subarray(0, take), filled);
      filled += take;
      this._queuedFrames -= take;
      if (take === ql.length) this._queue.shift();
      else this._queue[0] = [ql.subarray(take), qr.subarray(take)];
    }
    if (this._queue.length === 0) this._buffering = true;
    return true;
  }
}
registerProcessor("pcm-player-processor", PcmPlayerProcessor);
`;

export type ChannelMode = "stereo" | "mono" | "left" | "right";

/** Frei belegbare Schnellwahl-Taste: Quelle wird über ihr Label gefunden
 * (Sender-IDs ändern sich bei jedem Neustart des Quellknotens). */
export interface ListenPreset {
  name: string;
  sourceLabel: string;
}

export const PRESET_SLOTS = 6;
const PREFS_KEY = "omp-listen-prefs";
const PRESETS_KEY = "omp-listen-presets";
const LAST_NODE_KEY = "omp-listen-node";

export type ListenStatus = "idle" | "connecting" | "playing" | "reconnecting" | "error";

export interface ListenState {
  nodeId: string | null;
  status: ListenStatus;
  volume: number; // 0..1
  muted: boolean;
  dim: boolean;
  channelMode: ChannelMode;
  // Kopfhörer-Ausgleich (Crossfeed): beim Mischen auf Kopfhörern hört jedes
  // Ohr nur seinen Kanal (keine Raumübersprechung wie bei Boxen) — das lässt
  // Stereobild und Panning extrem breit wirken und verführt zu falschen
  // Entscheidungen. Crossfeed mischt einen tiefpassgefilterten, leicht
  // verzögerten Anteil des Gegenkanals zu, wie ihn Boxen akustisch liefern.
  headphone: boolean;
  crossfeed: number; // 0..1, Stärke
  sourceLabel: string; // aktuell verbundene Quelle des Monitor-Nodes
  presets: (ListenPreset | null)[];
  // Audio-Verzögerung in ms, damit der Ton zu Viewer/Multiviewer-Bild passt
  // (MJPEG im Browser hängt je nach Last hinter dem PCM-Strom her).
  syncMs: number;
}

export class ListenService extends EventTarget {
  #ctx: AudioContext | null = null;
  #worklet: AudioWorkletNode | null = null;
  #gain: GainNode | null = null;
  #delay: DelayNode | null = null;
  #splitter: ChannelSplitterNode | null = null;
  #xfeed: { direct: GainNode[]; cross: GainNode[] } | null = null;
  #labelTimer = 0;
  #analysers: AnalyserNode[] = [];
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Generation: jede start()/stop()-Runde erhöht sie; veraltete Leseschleifen
  // und Wiederverbindungsversuche erkennen daran, dass sie überholt sind.
  #gen = 0;
  state: ListenState = {
    nodeId: null, status: "idle", volume: 0.8, muted: false, dim: false, channelMode: "stereo", headphone: false, crossfeed: 0.5, sourceLabel: "",
    presets: Array(PRESET_SLOTS).fill(null), syncMs: 0,
  };

  constructor() {
    super();
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
      if (v >= 0 && v <= 1) this.state.volume = v;
      const sync = parseInt(localStorage.getItem(SYNC_KEY) ?? "", 10);
      if (sync >= 0 && sync <= MAX_SYNC_MS) this.state.syncMs = sync;
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
      if (["stereo", "mono", "left", "right"].includes(prefs.channelMode)) this.state.channelMode = prefs.channelMode;
      if (typeof prefs.headphone === "boolean") this.state.headphone = prefs.headphone;
      if (prefs.crossfeed >= 0 && prefs.crossfeed <= 1) this.state.crossfeed = prefs.crossfeed;
      const presets = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "[]");
      if (Array.isArray(presets)) {
        this.state.presets = Array.from({ length: PRESET_SLOTS }, (_, i) =>
          presets[i]?.sourceLabel ? { name: String(presets[i].name ?? ""), sourceLabel: String(presets[i].sourceLabel) } : null);
      }
    } catch { /* localStorage gesperrt: Standardlautstärke */ }
    // Hintergrund-Tabs/Gerätewechsel können den Kontext anhalten.
    document.addEventListener("visibilitychange", () => this.#resume());
  }

  #emit() {
    this.dispatchEvent(new Event("change"));
  }

  #set(patch: Partial<ListenState>) {
    this.state = { ...this.state, ...patch };
    this.#applyGain();
    this.#emit();
  }

  #applyGain() {
    if (!this.#gain) return;
    this.#delay?.delayTime.setTargetAtTime(this.state.syncMs / 1000, this.#ctx!.currentTime, 0.05);
    if (this.#xfeed) {
      const k = this.state.headphone ? 0.45 * this.state.crossfeed : 0; // max ca. -7 dB Gegenkanal
      const t = this.#ctx!.currentTime;
      // Gesamtpegel konstant halten, sonst klingt "Kopfhörer an" nur lauter.
      for (const g of this.#xfeed.direct) g.gain.setTargetAtTime(1 / (1 + k), t, 0.02);
      for (const g of this.#xfeed.cross) g.gain.setTargetAtTime(k / (1 + k), t, 0.02);
    }
    const { volume, muted, dim } = this.state;
    const g = muted ? 0 : volume * volume * (dim ? DIM_GAIN : 1); // quadratisch: musikalischere Regelkurve
    this.#gain.gain.setTargetAtTime(g, this.#ctx!.currentTime, 0.015);
  }

  async #resume() {
    if (this.#ctx && this.#ctx.state !== "running" && this.state.nodeId) {
      await this.#ctx.resume().catch(() => {});
    }
  }

  async #ensureContext() {
    if (this.#ctx) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const worklet = new AudioWorkletNode(ctx, "pcm-player-processor", { outputChannelCount: [CHANNELS] });
    const gain = ctx.createGain();
    const splitter = ctx.createChannelSplitter(CHANNELS);
    const delay = ctx.createDelay(MAX_SYNC_MS / 1000);
    worklet.connect(delay);
    // Crossfeed-Netz (immer im Signalweg, bei "aus" cross=0/direct=1 — kein
    // Umstöpseln im laufenden Betrieb, das knackt): jedes Ohr bekommt
    // direkt + tiefpassgefiltert (~700 Hz) und ~0,3 ms verzögert den Gegenkanal.
    const split = ctx.createChannelSplitter(CHANNELS);
    const merge = ctx.createChannelMerger(CHANNELS);
    delay.connect(split);
    const direct: GainNode[] = [];
    const cross: GainNode[] = [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const d = ctx.createGain();
      split.connect(d, ch);
      d.connect(merge, 0, ch);
      direct.push(d);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      const dl = ctx.createDelay(0.01);
      dl.delayTime.value = 0.0003;
      const x = ctx.createGain();
      split.connect(lp, ch); // Kanal ch speist das GEGENüberliegende Ohr
      lp.connect(dl).connect(x);
      x.connect(merge, 0, 1 - ch);
      cross.push(x);
    }
    merge.connect(gain).connect(ctx.destination);
    this.#xfeed = { direct, cross };
    this.#delay = delay;
    worklet.connect(splitter); // Pegelabgriff VOR Lautstärke/Mute/Dim: zeigt die Quelle, nicht den Regler
    this.#analysers = [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      splitter.connect(a, ch);
      return a;
    });
    this.#ctx = ctx;
    this.#worklet = worklet;
    this.#gain = gain;
    this.#splitter = splitter;
    ctx.onstatechange = () => this.#emit();
    this.#applyGain();
  }

  /** Spitzenpegel L/R (linear 0..1) seit dem letzten Aufruf. */
  levels(): [number, number] {
    const buf = new Float32Array(1024);
    return [0, 1].map((i) => {
      const a = this.#analysers[i];
      if (!a) return 0;
      a.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const s of buf) peak = Math.max(peak, Math.abs(s));
      return peak;
    }) as [number, number];
  }

  /** Muss aus einer Nutzergeste heraus aufgerufen werden (Autoplay-Regel). */
  async start(nodeId: string) {
    const gen = ++this.#gen;
    this.#reader?.cancel().catch(() => {});
    try { localStorage.setItem(LAST_NODE_KEY, nodeId); } catch { /* egal */ }
    this.#set({ nodeId, status: "connecting" });
    clearInterval(this.#labelTimer);
    this.#labelTimer = setInterval(() => this.#refreshSourceLabel(), 2000) as unknown as number;
    void this.#refreshSourceLabel();
    try {
      await this.#ensureContext();
      await this.#ctx!.resume();
    } catch {
      this.#set({ status: "error" });
      return;
    }
    void this.#run(nodeId, gen);
  }

  stop() {
    this.#gen++;
    this.#reader?.cancel().catch(() => {});
    this.#reader = null;
    clearInterval(this.#labelTimer);
    this.#set({ nodeId: null, status: "idle", sourceLabel: "" });
  }

  setVolume(v: number) {
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* egal */ }
    this.#set({ volume: v });
  }
  setSync(syncMs: number) {
    try { localStorage.setItem(SYNC_KEY, String(syncMs)); } catch { /* egal */ }
    this.#set({ syncMs });
  }
  setMuted(muted: boolean) { this.#set({ muted }); }
  setDim(dim: boolean) { this.#set({ dim }); }

  async #run(nodeId: string, gen: number) {
    let attempt = 0;
    while (gen === this.#gen) {
      const ok = await this.#readStream(nodeId, gen);
      if (gen !== this.#gen) return;
      // Strom endete (Node-Neustart, Quellwechsel, Netzfehler): automatisch
      // wieder verbinden, solange der Operator nicht selbst gestoppt hat.
      this.#set({ status: ok ? "reconnecting" : attempt >= RECONNECT_MS.length ? "error" : "reconnecting" });
      await new Promise((r) => setTimeout(r, RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]));
      attempt = ok ? 0 : attempt + 1;
      if (attempt > 30) { this.stop(); return; }
    }
  }

  /** @returns true, wenn Daten geflossen sind (Verbindung war gut). */
  async #readStream(nodeId: string, gen: number): Promise<boolean> {
    let token: string | null = null;
    try { token = localStorage.getItem("omp-auth-token"); } catch { /* egal */ }
    const base = `/api/v1/nodes/${encodeURIComponent(nodeId)}/stream/audioStreamUrl`;
    let res: Response;
    try {
      res = await fetch(token ? `${base}?access_token=${encodeURIComponent(token)}` : base);
    } catch {
      return false;
    }
    if (!res.ok || !res.body || gen !== this.#gen) return false;

    const reader = res.body.getReader();
    this.#reader = reader;
    this.#set({ status: "playing" });
    let carry = new Uint8Array(0);
    let gotData = false;
    while (gen === this.#gen) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      const combined = new Uint8Array(carry.length + chunk.value.length);
      combined.set(carry, 0);
      combined.set(chunk.value, carry.length);
      const frames = Math.floor(combined.length / BYTES_PER_FRAME);
      carry = combined.slice(frames * BYTES_PER_FRAME);
      if (frames === 0) continue;
      gotData = true;
      const f32 = new Float32Array(combined.buffer, combined.byteOffset, frames * CHANNELS);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const mode = this.state.channelMode;
      for (let i = 0; i < frames; i++) {
        const l = f32[i * 2], r = f32[i * 2 + 1];
        switch (mode) {
          case "mono": left[i] = right[i] = (l + r) / 2; break;
          case "left": left[i] = right[i] = l; break;
          case "right": left[i] = right[i] = r; break;
          default: left[i] = l; right[i] = r;
        }
      }
      this.#worklet?.port.postMessage([left, right], [left.buffer, right.buffer]);
    }
    return gotData;
  }

  setChannelMode(channelMode: ChannelMode) { this.#set({ channelMode }); this.#savePrefs(); }
  setHeadphone(headphone: boolean) { this.#set({ headphone }); this.#savePrefs(); }
  setCrossfeed(crossfeed: number) { this.#set({ crossfeed }); this.#savePrefs(); }

  #savePrefs() {
    const { channelMode, headphone, crossfeed } = this.state;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ channelMode, headphone, crossfeed })); } catch { /* egal */ }
  }

  // --- Schnellwahl-Tasten -------------------------------------------------
  // Der Monitor-Node ist der Umschalter: Tasten rufen nur dessen
  // selectSource (wie das Panel-Dropdown). Quelle über Label gefunden.

  /** Vom eingebetteten Panel gesetzt: dieser Monitor-Node ist gemeint. */
  hintNode: string | null = null;
  mountControls?: (nodeId: string) => HTMLElement;

  /** Node, auf den Tasten wirken: laufender Node, Panel-Node oder zuletzt benutzter. */
  get targetNode(): string | null {
    if (this.state.nodeId) return this.state.nodeId;
    if (this.hintNode) return this.hintNode;
    try { return localStorage.getItem(LAST_NODE_KEY); } catch { return null; }
  }

  async #param(nodeId: string, name: string): Promise<unknown> {
    const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/params/${name}`);
    return res.ok ? (await res.json()).value : undefined;
  }

  async availableLabels(): Promise<string[]> {
    const node = this.targetNode;
    if (!node) return [];
    const sources = ((await this.#param(node, "availableSources")) as { label: string }[] | undefined) ?? [];
    return sources.map((s) => s.label).sort();
  }

  async #refreshSourceLabel() {
    const node = this.state.nodeId;
    if (!node) return;
    const label = ((await this.#param(node, "connectedLabel")) as string | undefined) ?? "";
    if (label !== this.state.sourceLabel && node === this.state.nodeId) this.#set({ sourceLabel: label });
  }

  /** Schaltet den Monitor-Node auf die Quelle mit diesem Label um. */
  async selectByLabel(sourceLabel: string): Promise<boolean> {
    const node = this.targetNode;
    if (!node) return false;
    const sources = ((await this.#param(node, "availableSources")) as { senderId: string; label: string }[] | undefined) ?? [];
    const hit = sources.find((s) => s.label === sourceLabel);
    if (!hit) return false;
    const res = await fetch(`/api/v1/nodes/${encodeURIComponent(node)}/methods/selectSource`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: hit.senderId }),
    });
    if (!res.ok) return false;
    this.#set({ sourceLabel });
    // Wiedergabe (neu) starten, falls noch nicht aktiv — Tastendruck ist eine Nutzergeste.
    if (!this.state.nodeId) await this.start(node);
    return true;
  }

  assignPreset(slot: number, preset: ListenPreset | null) {
    const presets = [...this.state.presets];
    presets[slot] = preset;
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch { /* egal */ }
    this.#set({ presets });
  }
}

// Einziger Einstiegspunkt: von shell.ts beim Booten aufgerufen.
/** Vom Node-Panel aufgerufen: baut den vollen Controller zum Einbetten. */
export function mountListenControls(service: ListenService, nodeId: string): HTMLElement {
  service.hintNode = nodeId;
  return buildListenControls(service);
}

export function installListenService(): ListenService {
  const existing = (window as unknown as { ompListen?: ListenService }).ompListen;
  if (existing) return existing;
  const service = new ListenService();
  (window as unknown as { ompListen?: ListenService }).ompListen = service;
  service.mountControls = (nodeId: string) => mountListenControls(service, nodeId);
  document.body.appendChild(buildListenWidget(service));
  return service;
}
