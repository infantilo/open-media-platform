// Test-/Simulator-Seite `/streamdeck-sim` (Kap. 40.2): zeigt die an ein
// virtuelles Gerät gesendeten Tasten-/Streifenbilder und gibt Klicks,
// Mausrad und Streifen-Gesten als echte Input-Reports zurück. Derselbe
// Knopf verbindet ein ECHTES Gerät (Testraster, Ereignisprotokoll) — der
// Simulator ersetzt den Test am Gerät nicht (Bildformat/Chunking nur dort).

import { t, type I18nKey } from "../i18n.ts";
import { keyCount, MODELS, unrotationMatrix } from "./models.ts";
import { SimHid } from "./sim-device.ts";
import { sendTestGrid } from "./testgrid.ts";
import { deckSession } from "./session.ts";
import { canvasRasterizer } from "./draw.ts";
import { DeckRenderer, type KeyDef, type KeyState } from "./render-logic.ts";
import { connectWithPrompt, type DeckDevice } from "./transport.ts";
import type { DeckEvent } from "./protocol.ts";

const CSS = `
:host{display:block;padding:16px;font-family:var(--omp-font,sans-serif);color:var(--omp-text,#ddd)}
h2{margin:0 0 12px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.grid{display:grid;gap:8px;width:max-content;padding:12px;background:#111;border-radius:10px}
.key{position:relative;background:#000;border:1px solid #333;border-radius:6px;cursor:pointer;overflow:hidden;padding:0}
.key canvas{display:block;width:100%;height:100%}
.key:active{outline:2px solid #6af}
.strip{position:relative;margin-top:8px;background:#000;border:1px solid #333;border-radius:6px;overflow:hidden;touch-action:none}
.strip canvas{display:block;width:100%;height:100%}
.dials{display:flex;gap:12px;margin-top:8px}
.dial{width:64px;height:64px;border-radius:50%;border:3px solid #556;background:#222;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none}
.err{color:var(--omp-error,#e55);margin:8px 0}
pre{background:#111;padding:8px;max-height:200px;overflow:auto;border-radius:6px}
`;

export class StreamDeckSim extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #dev: DeckDevice | null = null;
  #sim: SimHid | null = null;
  #unsub: (() => void) | null = null;
  #log: string[] = [];
  #status!: HTMLElement;
  #err!: HTMLElement;
  #logEl!: HTMLElement;
  #stage!: HTMLElement;
  #model!: HTMLSelectElement;

  connectedCallback() {
    this.#root.innerHTML = `<style>${CSS}</style>
      <h2>${t("sd.title")}</h2>
      <div class="bar">
        <label>${t("sd.model")} <select id="model">${MODELS.map((m, i) => `<option value="${i}">${m.name}</option>`).join("")}</select></label>
        <button id="sim">${t("sd.simulate")}</button>
        <button id="real">${t("sd.connectReal")}</button>
        <button id="grid">${t("sd.sendGrid")}</button>
        <button id="rt">${t("sd.renderTest")}</button>
        <label>${t("sd.brightness")} <input id="br" type="range" min="0" max="100" value="70"></label>
        <button id="off">${t("sd.disconnect")}</button>
        <span id="status"></span>
      </div>
      <div class="err" id="err"></div>
      <div id="stage"></div>
      <h3>${t("sd.log")}</h3><pre id="log"></pre>`;
    const $ = (id: string) => this.#root.getElementById(id)!;
    this.#status = $("status");
    this.#err = $("err");
    this.#logEl = $("log");
    this.#stage = $("stage");
    this.#model = $("model") as HTMLSelectElement;
    $("sim").onclick = () => void this.#startSim();
    $("real").onclick = () => void this.#startReal();
    $("grid").onclick = () => this.#dev && void sendTestGrid(this.#dev);
    $("rt").onclick = () => this.#dev && void this.#renderTest(this.#dev);
    $("off").onclick = () => void this.#stop();
    ($("br") as HTMLInputElement).oninput = (e) => void this.#dev?.setBrightness(+(e.target as HTMLInputElement).value);
    this.#setStatus(null);
    if (this.hasAttribute("broker")) {
      this.#offErr = deckSession.onError((e) => (this.#err.textContent = e instanceof Error ? e.message : String(e)));
    }
  }

  #offErr: (() => void) | null = null;

  disconnectedCallback() {
    this.#offErr?.();
    void this.#stop();
  }

  #setStatus(name: string | null) {
    this.#status.textContent = name ? t("sd.connected", { name }) : t("sd.notConnected");
  }

  async #stop() {
    this.#unsub?.();
    this.#unsub = null;
    if (this.hasAttribute("broker")) deckSession.setDevice(null);
    await this.#dev?.close();
    this.#dev = null;
    this.#sim = null;
    this.#stage.replaceChildren();
    this.#setStatus(null);
  }

  async #startSim() {
    await this.#stop();
    this.#err.textContent = "";
    const model = MODELS[+this.#model.value];
    const sim = new SimHid(model);
    sim.onError = (e) => (this.#err.textContent = e.message);
    this.#sim = sim;
    const { DeckDevice } = await import("./transport.ts");
    this.#attach(await DeckDevice.open(sim));
    this.#buildSimStage(sim);
    if (!this.hasAttribute("broker")) await sendTestGrid(this.#dev!);
  }

  async #startReal() {
    await this.#stop();
    this.#err.textContent = "";
    const r = await connectWithPrompt();
    if (!r.ok) {
      this.#err.textContent = t(`sd.err.${r.reason}` as I18nKey);
      return;
    }
    this.#attach(r.device);
    await r.device.setBrightness(70);
    if (!this.hasAttribute("broker")) await sendTestGrid(r.device);
  }

  /** Render-Engine-Test: Tasten mit Zuständen, dann identisch (0 gesendet), dann 1 Änderung. */
  async #renderTest(dev: DeckDevice) {
    const r = new DeckRenderer(dev, canvasRasterizer, { onError: (e) => (this.#err.textContent = String(e)) });
    const states: KeyState[] = ["onair", "preset", "cue", "off", "error"];
    const keys = (n: number): KeyDef[] =>
      Array.from({ length: dev.model.cols * dev.model.rows }, (_, i) => ({
        label: i === 0 ? "Kamera 1 lang" : `Q${i + 1}`,
        sub: i % 3 === 0 ? "PGM" : undefined,
        icon: i % 4 === 1 ? "▶" : undefined,
        state: states[(i + n) % states.length],
        dim: i === 7,
      }));
    const dials = Array.from({ length: dev.model.dials }, (_, i) => ({ label: `Kanal ${i + 1}`, value: `${-6 * i} dB`, fill: 0.2 + 0.2 * i }));
    const run = async (name: string, k: KeyDef[]) => {
      const before = r.stats.keyImages + r.stats.stripImages;
      const t0 = performance.now();
      r.set(k, dials);
      await r.flushNow();
      this.#log.unshift(`${name}: ${r.stats.keyImages + r.stats.stripImages - before} Bilder, ${Math.round(performance.now() - t0)} ms`);
      this.#logEl.textContent = this.#log.join("\n");
    };
    await run("alles", keys(0));
    await run("identisch", keys(0));
    const k = keys(0);
    k[2] = { ...k[2], label: "geändert" };
    await run("eine Taste", k);
    await run("alle Zustände", keys(1));
  }

  #attach(dev: DeckDevice) {
    this.#dev = dev;
    // Eingebettet in die Konsole (Attribut `broker`): das Gerät gehört dem Broker.
    if (this.hasAttribute("broker")) deckSession.setDevice(dev);
    this.#setStatus(dev.model.name);
    this.#unsub = dev.onEvent((e) => this.#note(e));
  }

  #note(e: DeckEvent) {
    this.#log.unshift(JSON.stringify(e));
    this.#log.length = Math.min(this.#log.length, 50);
    this.#logEl.textContent = this.#log.join("\n");
  }

  #buildSimStage(sim: SimHid) {
    const m = sim.model;
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.style.gridTemplateColumns = `repeat(${m.cols}, ${m.keySize}px)`;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < keyCount(m); i++) {
      const b = document.createElement("button");
      b.className = "key";
      b.style.cssText = `width:${m.keySize}px;height:${m.keySize}px`;
      const c = document.createElement("canvas");
      c.width = c.height = m.keySize;
      b.appendChild(c);
      canvases.push(c);
      b.onpointerdown = () => sim.pressKey(i, true);
      b.onpointerup = b.onpointerleave = () => sim.pressKey(i, false);
      grid.appendChild(b);
    }
    this.#stage.replaceChildren(grid);
    let stripCanvas: HTMLCanvasElement | null = null;
    if (m.strip) {
      const strip = document.createElement("div");
      strip.className = "strip";
      strip.style.cssText = `width:${m.strip.w}px;height:${m.strip.h}px`;
      stripCanvas = document.createElement("canvas");
      stripCanvas.width = m.strip.w;
      stripCanvas.height = m.strip.h;
      strip.appendChild(stripCanvas);
      let down: { x: number; y: number; t: number } | null = null;
      const pos = (e: PointerEvent) => ({ x: Math.round(e.offsetX), y: Math.round(e.offsetY) });
      strip.onpointerdown = (e) => (down = { ...pos(e), t: Date.now() });
      strip.onpointerup = (e) => {
        if (!down) return;
        const p = pos(e);
        if (Math.abs(p.x - down.x) > 60) sim.flick(down.x, down.y, p.x, p.y);
        else sim.touch(Date.now() - down.t > 500 ? "press" : "tap", p.x, p.y);
        down = null;
      };
      const dials = document.createElement("div");
      dials.className = "dials";
      for (let d = 0; d < m.dials; d++) {
        const el = document.createElement("div");
        el.className = "dial";
        el.textContent = `D${d + 1}`;
        el.onwheel = (e) => {
          e.preventDefault();
          sim.turnDial(d, e.deltaY < 0 ? 1 : -1);
        };
        el.onpointerdown = () => sim.pressDial(d, true);
        el.onpointerup = el.onpointerleave = () => sim.pressDial(d, false);
        dials.appendChild(el);
      }
      this.#stage.append(strip, dials);
    }
    sim.onImage = (img) => {
      const blob = new Blob([img.jpeg as BlobPart], { type: "image/jpeg" });
      void createImageBitmap(blob).then((bmp) => {
        if (img.kind === "key") {
          const g = canvases[img.index]?.getContext("2d");
          // Drehung wie am Gerät: Bilder sind bereits gedreht gesendet → zurückdrehen zur Anzeige.
          if (g) {
            g.save();
            g.transform(...unrotationMatrix(m.rotation, m.keySize, m.keySize));
            g.drawImage(bmp, 0, 0);
            g.restore();
          }
        } else {
          const g = stripCanvas?.getContext("2d");
          if (g) {
            g.save();
            g.translate(img.x, img.y);
            g.transform(...unrotationMatrix(m.rotation, img.w, img.h));
            g.drawImage(bmp, 0, 0);
            g.restore();
          }
        }
      });
    };
  }
}

if (!customElements.get("omp-streamdeck-sim")) customElements.define("omp-streamdeck-sim", StreamDeckSim);
