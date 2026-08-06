// Node-UI-Bundle des Audio-Monitors (2026-08-06 redesignt, Nutzerwunsch
// "es sollte wie der viewer ohne einen html player auskommen, direkt
// das audio ausgeben"): kein sichtbares `<audio controls>` mehr — rohes
// F32LE/48kHz/Stereo-PCM (`omp_mediaio::pcm_stream`, s. dortige
// Moduldoku) wird per `fetch()` + `ReadableStream` gelesen und über
// einen `AudioWorklet` nahtlos abgespielt, exakt wie `omp-viewer`s
// `<img>` unsichtbar "einfach läuft". Erste Nutzung von `AudioContext`/
// `AudioWorklet` irgendwo in `ui/` — der Worklet-Prozessor-Code lebt als
// Inline-String + `Blob`-URL direkt hier (kein eigener Server-Endpunkt
// nötig, `AudioWorklet.addModule()` akzeptiert jede erreichbare URL,
// eine `Blob`-URL reicht).
//
// Zusätzlich ein Live-Discovery-Dropdown ("Gruppenwahl", Nutzerwunsch:
// "oder eben den mxf player abhören können (Gruppenwahl)") — `main.rs`s
// neue `availableSources`/`selectSource` schalten die Quelle um, ohne
// den Flow-Editor-Graph neu zu verkabeln.

// Läuft im AudioWorkletGlobalScope (eigener Thread, kein DOM-Zugriff).
// Sammelt vom Haupt-Thread per `port.postMessage` transferierte
// Float32Array-Paare (bereits pro Kanal entflochten, s. `deinterleave`
// unten) in einer einfachen FIFO-Warteschlange und liefert bei jedem
// `process()`-Aufruf (128 Samples/Block, WebAudio-Konstante) so viele
// Samples wie verfügbar.
//
// Jitter-Puffer mit Hysterese (live gefundener Bug: die ursprüngliche
// Fassung fing sofort mit dem allerersten eingetroffenen Chunk an zu
// spielen und griff bei leerer Warteschlange direkt auf Stille zurück —
// ohne jedes Polster erzeugt JEDE auch nur leicht verspätete
// `fetch()`-Chunk-Anlieferung (normaler HTTP/TCP-Jitter über den
// Orchestrator-Stream-Proxy, kein Fehlerfall) eine hörbare Lücke mitten
// in der Wiedergabe — "interrupted audio"). Erst ab `PREBUFFER_FRAMES`
// (~150ms) angestauten Frames wird überhaupt zu spielen begonnen;
// läuft die Warteschlange danach leer (Underrun), wird NICHT weiter
// framezeise Stille eingestreut, sondern zurück in den Puffer-Modus
// gewechselt, bis sich erneut ein Polster angesammelt hat — vermeidet
// wiederkehrende Mini-Aussetzer, die ein reiner "spiel sofort, was da
// ist"-Ansatz bei leicht schwankender Netzwerk-Taktung produziert.
const WORKLET_SOURCE = `
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = []; // Array<[Float32Array left, Float32Array right]>
    this._queuedFrames = 0;
    this._buffering = true;
    this.port.onmessage = (ev) => {
      const [left, right] = ev.data;
      this._queue.push([left, right]);
      this._queuedFrames += left.length;
      // Backpressure: bei mehr als ~1s angestauten Frames (Client
      // liest schneller nach, als die Soundkarte konsumiert, z. B.
      // nach einem Tab-Wechsel) älteste Chunks verwerfen statt
      // unbegrenzt wachsender Latenz — Live-Abhören soll aktuell
      // bleiben, kein Puffer-Aufbau wie bei einem VOD-Player.
      while (this._queuedFrames > sampleRate * 1) {
        const dropped = this._queue.shift();
        this._queuedFrames -= dropped[0].length;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    const PREBUFFER_FRAMES = sampleRate * 0.15;
    if (this._buffering) {
      if (this._queuedFrames < PREBUFFER_FRAMES) return true;
      this._buffering = false;
    }

    let filled = 0;
    while (filled < left.length && this._queue.length > 0) {
      const [qLeft, qRight] = this._queue[0];
      const take = Math.min(left.length - filled, qLeft.length);
      left.set(qLeft.subarray(0, take), filled);
      right.set(qRight.subarray(0, take), filled);
      filled += take;
      this._queuedFrames -= take;
      if (take === qLeft.length) {
        this._queue.shift();
      } else {
        this._queue[0] = [qLeft.subarray(take), qRight.subarray(take)];
      }
    }
    // Rest (Warteschlange nach obiger Schleife leer) bleibt Stille
    // (Float32Array-Default 0) — passiert nur noch innerhalb EINES
    // 128-Sample-Blocks (< 3ms), nicht mehr als wiederkehrendes Muster,
    // weil ein vollständiger Underrun sofort zurück in den Puffer-Modus
    // schaltet.
    if (this._queue.length === 0) {
      this._buffering = true;
    }
    return true;
  }
}
registerProcessor("pcm-player-processor", PcmPlayerProcessor);
`;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 4; // F32LE

function deinterleave(float32) {
  const frames = float32.length / CHANNELS;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = float32[i * CHANNELS];
    right[i] = float32[i * CHANNELS + 1];
  }
  return [left, right];
}

class OmpAudioMonitorPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      p { font-size: 12px; color: #888; margin: 4px 0; }
      select {
        width: 100%; background: #222; color: #eee; border: 1px solid #555;
        border-radius: 3px; padding: 4px; font-size: 12px; margin-bottom: 6px;
      }
      button {
        background: #333; color: #eee; border: 1px solid #555; border-radius: 3px;
        cursor: pointer; font-size: 12px; padding: 4px 10px;
      }
    `;

    const select = document.createElement("select");
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = "— Quelle wählen —";
    select.appendChild(placeholderOpt);

    const listenBtn = document.createElement("button");
    listenBtn.textContent = "▶ Abhören starten";

    const status = document.createElement("p");
    status.textContent = "Quelle wählen, dann Abhören starten (Browser verlangt eine Nutzergeste für Audio-Wiedergabe).";

    shadow.append(style, select, listenBtn, status);

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    const renderSources = async () => {
      const sources = (await getParam("availableSources")) || [];
      const connected = (await getParam("connectedFlowId")) || "";
      const currentValue = select.value;
      select.replaceChildren(placeholderOpt);
      for (const s of sources) {
        const opt = document.createElement("option");
        opt.value = s.senderId;
        opt.textContent = s.label;
        select.appendChild(opt);
      }
      // Aktuell verbundene Quelle nur beibehalten, wenn der Nutzer nicht
      // gerade mitten in einer eigenen Auswahl ist (kein Wert gewählt).
      if (!currentValue && connected) {
        const match = sources.find((s) => s.senderId && select.querySelector(`option[value="${CSS.escape(s.senderId)}"]`));
        if (match) select.value = match.senderId;
      } else if (currentValue) {
        select.value = currentValue;
      }
    };

    select.addEventListener("change", () => {
      call("selectSource", { senderId: select.value });
    });

    renderSources();
    this._sourcesInterval = setInterval(renderSources, 3000);

    let audioContext = null;
    let workletNode = null;
    let reading = false;

    const startListening = async () => {
      if (reading) return;
      reading = true;
      status.textContent = "verbinde …";

      if (!audioContext) {
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
        await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
        workletNode = new AudioWorkletNode(audioContext, "pcm-player-processor", {
          outputChannelCount: [CHANNELS],
        });
        workletNode.connect(audioContext.destination);
      }
      await audioContext.resume();

      const token = localStorage.getItem("omp-auth-token");
      const streamUrl = token
        ? `/api/v1/nodes/${nodeId}/stream/audioStreamUrl?access_token=${encodeURIComponent(token)}`
        : `/api/v1/nodes/${nodeId}/stream/audioStreamUrl`;

      let res;
      try {
        res = await fetch(streamUrl);
      } catch {
        status.textContent = "kein Audiostrom verfügbar";
        reading = false;
        return;
      }
      if (!res.ok || !res.body) {
        status.textContent = "kein Audiostrom verfügbar";
        reading = false;
        return;
      }
      status.textContent = "";
      listenBtn.textContent = "■ Abhören stoppen";

      const reader = res.body.getReader();
      // Ungerade Byte-Reste zwischen zwei Chunks (BYTES_PER_FRAME teilt
      // selten exakt jede TCP-Lesegröße) über Aufrufe hinweg
      // mitschleppen, statt sie zu verwerfen — sonst driftet L/R nach
      // wenigen Sekunden hörbar auseinander (Kanal-Vertauschung).
      let carry = new Uint8Array(0);
      this._reader = reader;
      while (reading) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        if (chunk.done) break;
        const combined = new Uint8Array(carry.length + chunk.value.length);
        combined.set(carry, 0);
        combined.set(chunk.value, carry.length);
        const usableFrames = Math.floor(combined.length / BYTES_PER_FRAME);
        const usableBytes = usableFrames * BYTES_PER_FRAME;
        carry = combined.slice(usableBytes);
        if (usableFrames === 0) continue;
        const float32 = new Float32Array(combined.buffer, combined.byteOffset, usableFrames * CHANNELS);
        const [left, right] = deinterleave(float32);
        if (workletNode) {
          workletNode.port.postMessage([left, right], [left.buffer, right.buffer]);
        }
      }
      status.textContent = "Abhören beendet.";
      listenBtn.textContent = "▶ Abhören starten";
      reading = false;
    };

    const stopListening = () => {
      reading = false;
      if (this._reader) {
        this._reader.cancel().catch(() => {});
      }
      listenBtn.textContent = "▶ Abhören starten";
    };

    listenBtn.addEventListener("click", () => {
      if (reading) {
        stopListening();
      } else {
        startListening();
      }
    });
  }

  disconnectedCallback() {
    clearInterval(this._sourcesInterval);
    if (this._reader) this._reader.cancel().catch(() => {});
  }
}

if (!customElements.get("omp-audio-monitor-panel")) {
  customElements.define("omp-audio-monitor-panel", OmpAudioMonitorPanel);
}
