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

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 4; // F32LE, s. omp_mediaio::pcm_stream
const VOLUME_KEY = "omp-listen-volume";
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

export type ListenStatus = "idle" | "connecting" | "playing" | "reconnecting" | "error";

export interface ListenState {
  nodeId: string | null;
  status: ListenStatus;
  volume: number; // 0..1
  muted: boolean;
  dim: boolean;
  mono: boolean;
}

export class ListenService extends EventTarget {
  #ctx: AudioContext | null = null;
  #worklet: AudioWorkletNode | null = null;
  #gain: GainNode | null = null;
  #splitter: ChannelSplitterNode | null = null;
  #analysers: AnalyserNode[] = [];
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Generation: jede start()/stop()-Runde erhöht sie; veraltete Leseschleifen
  // und Wiederverbindungsversuche erkennen daran, dass sie überholt sind.
  #gen = 0;
  state: ListenState = { nodeId: null, status: "idle", volume: 0.8, muted: false, dim: false, mono: false };

  constructor() {
    super();
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
      if (v >= 0 && v <= 1) this.state.volume = v;
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
    worklet.connect(gain).connect(ctx.destination);
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
    this.#set({ nodeId, status: "connecting" });
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
    this.#set({ nodeId: null, status: "idle" });
  }

  setVolume(v: number) {
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* egal */ }
    this.#set({ volume: v });
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
      const mono = this.state.mono;
      for (let i = 0; i < frames; i++) {
        const l = f32[i * 2], r = f32[i * 2 + 1];
        left[i] = mono ? (l + r) / 2 : l;
        right[i] = mono ? (l + r) / 2 : r;
      }
      this.#worklet?.port.postMessage([left, right], [left.buffer, right.buffer]);
    }
    return gotData;
  }

  setMono(mono: boolean) { this.#set({ mono }); }
}

const STATUS_TEXT: Record<ListenStatus, string> = {
  idle: "",
  connecting: "verbinde …",
  playing: "",
  reconnecting: "verbinde neu …",
  error: "kein Audiostrom",
};

// Schmales Widget unten links (rechts sitzt buildUserWidget). Nur sichtbar,
// solange abgehört wird.
export function buildListenWidget(service: ListenService): HTMLElement {
  const w = document.createElement("div");
  w.setAttribute("data-role", "listen-widget");
  w.style.cssText =
    "position:fixed;bottom:var(--omp-space-2);left:var(--omp-space-2);z-index:1000;display:none;" +
    "align-items:center;gap:var(--omp-space-3);padding:6px var(--omp-space-3);" +
    "font-family:var(--omp-font);font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);" +
    "background:var(--omp-surface);border:1px solid var(--omp-border);border-radius:var(--omp-radius);" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.3);";

  const icon = document.createElement("span");
  icon.textContent = "🔊 Abhören";
  icon.style.cssText = "color:var(--omp-text);font-weight:600;";
  const status = document.createElement("span");
  status.style.cssText = "min-width:60px;";

  const meter = document.createElement("div");
  meter.style.cssText = "display:flex;flex-direction:column;gap:2px;width:90px;";
  const bars = [0, 1].map(() => {
    const track = document.createElement("div");
    track.style.cssText = "height:4px;background:var(--omp-bg);border-radius:2px;overflow:hidden;";
    const fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:0;background:var(--omp-accent-gradient);";
    track.append(fill);
    meter.append(track);
    return fill;
  });

  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = "1";
  vol.step = "0.01";
  vol.title = "Lautstärke";
  vol.style.cssText = "width:90px;padding:0;";
  vol.addEventListener("input", () => service.setVolume(parseFloat(vol.value)));

  const toggle = (label: string, title: string, on: (active: boolean) => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.style.cssText = "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);";
    let active = false;
    b.addEventListener("click", () => {
      active = !active;
      on(active);
    });
    return b;
  };
  const mute = toggle("Mute", "Stumm", (a) => service.setMuted(a));
  const dim = toggle("Dim", "Absenken (−20 dB)", (a) => service.setDim(a));
  const mono = toggle("Mono", "Mono-Check (L+R)", (a) => service.setMono(a));
  const stop = document.createElement("button");
  stop.textContent = "■";
  stop.title = "Abhören beenden";
  stop.style.cssText = "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);";
  stop.addEventListener("click", () => service.stop());

  w.append(icon, status, meter, vol, mute, dim, mono, stop);

  let raf = 0;
  const frame = () => {
    const [l, r] = service.levels();
    // dBFS-Anzeige -60..0 als Balkenbreite
    for (const [bar, v] of [[bars[0], l], [bars[1], r]] as const) {
      const db = v > 0 ? 20 * Math.log10(v) : -60;
      bar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    }
    raf = requestAnimationFrame(frame);
  };

  const paint = () => {
    const s = service.state;
    const active = s.nodeId !== null;
    w.style.display = active ? "flex" : "none";
    status.textContent = STATUS_TEXT[s.status];
    vol.value = String(s.volume);
    const mark = (b: HTMLElement, on: boolean) => {
      b.style.borderColor = on ? "var(--omp-accent-cyan)" : "";
      b.style.color = on ? "var(--omp-accent-cyan)" : "";
    };
    mark(mute, s.muted);
    mark(dim, s.dim);
    mark(mono, s.mono);
    cancelAnimationFrame(raf);
    if (active) raf = requestAnimationFrame(frame);
  };
  service.addEventListener("change", paint);
  paint();
  return w;
}

// Einziger Einstiegspunkt: von shell.ts beim Booten aufgerufen.
export function installListenService(): ListenService {
  const existing = (window as unknown as { ompListen?: ListenService }).ompListen;
  if (existing) return existing;
  const service = new ListenService();
  (window as unknown as { ompListen?: ListenService }).ompListen = service;
  document.body.appendChild(buildListenWidget(service));
  return service;
}
