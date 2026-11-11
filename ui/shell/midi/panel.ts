// Knopf + einklappbares Panel „MIDI“ (Kap. 93): Geräte wählen, Mischer wählen, starten; Simulator; Profil-Eingabe mit Lernfunktion.
// Wie das Stream-Deck-Panel gehört die Sitzung der Seite (`midiSession`), nicht dem Panel — es lässt sich schließen, ohne das Pult zu trennen.

import { t } from "../i18n.ts";
import { apiFetch } from "../connection.ts";
import { EXAMPLE_KEYS, EXAMPLE_PROFILE, midiSession } from "./instance.ts";
import { type KeysConfig, validateKeys } from "./keys.ts";
import { noteByName } from "./mcu.ts";
import { type PortChoice, choices, openChoice, requestAccess, type WmAccess } from "./webmidi.ts";
import { type Profile, validateProfile } from "./profile.ts";
import { SIM_FADER_CSS, SimFader } from "./sim-fader.ts";
import { SimSurface } from "./sim-surface.ts";

const CSS = SIM_FADER_CSS + `
:host{display:block;padding:12px;font-family:var(--omp-font,sans-serif);color:var(--omp-text,#ddd);min-width:min(560px,92vw)}
h2{margin:0 0 6px;font-size:15px} h3{margin:12px 0 4px;font-size:13px}
.hint{font-size:12px;opacity:.75;margin:0 0 8px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
label{display:flex;gap:6px;align-items:center;font-size:13px}
select,input,textarea,button{font:inherit;color:inherit;background:var(--omp-surface-raised,#222);border:1px solid var(--omp-border,#444);border-radius:var(--omp-radius,4px);padding:3px 6px}
textarea{width:100%;min-height:150px;box-sizing:border-box;font-family:monospace;font-size:12px}
.err{color:var(--omp-error,#e55);min-height:1.2em;font-size:13px}
.ok{color:var(--omp-success,#4c4);font-size:13px}
.sim{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.unit{background:#111;border-radius:8px;padding:8px}
.lcd{font-family:monospace;font-size:11px;background:#1b2a1b;color:#9f9;padding:3px 5px;border-radius:3px;white-space:pre;overflow:hidden}
.strips{display:flex;gap:4px;margin-top:6px}
.strip{display:flex;flex-direction:column;align-items:center;gap:3px;width:44px}
.strip.master{justify-content:flex-end}
.strip button{width:40px;padding:1px 0;font-size:10px}
.led-on{background:#c33!important;border-color:#e66!important}
.led-blink{background:#c93!important}
.meter{width:6px;height:40px;background:#222;position:relative}
.meter i{position:absolute;bottom:0;left:0;right:0;background:#4c4}
.knob{width:30px;height:30px;border-radius:50%;padding:0}
.bar{display:flex;gap:4px;margin-top:6px}
`;

const LS_KEY = "omp-midi-config";
interface Saved {
  mode?: "mcu" | "profile";
  units?: string[];
  mixer?: string;
  masterAux?: string;
  profile?: string;
  keys?: string;
}
const load = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const save = (s: Saved) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch { /* privat/blockiert: ohne Merken weiterarbeiten */ }
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class MidiPanel extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #access: WmAccess | null = null;
  #choices: PortChoice[] = [];
  #nodes: { id: string; label: string }[] = [];
  #sims: SimSurface[] = [];
  #off: (() => void) | null = null;
  #cfg: Saved = load();

  connectedCallback() {
    this.#off = midiSession.onChange(() => this.#renderStatus());
    this.#build();
    void this.#loadNodes();
  }
  disconnectedCallback() {
    this.#off?.();
  }

  async #loadNodes() {
    try {
      const r = await apiFetch("/api/v1/nodes");
      if (r.ok) {
        this.#nodes = ((await r.json()) as { id: string; label: string; online?: boolean }[]).filter((n) => n.online !== false).map((n) => ({ id: n.id, label: n.label }));
        this.#build();
      }
    } catch { /* Auswahl bleibt leer */ }
  }

  #$ = (id: string) => this.#root.getElementById(id) as HTMLElement;

  #build() {
    const c = this.#cfg;
    const mode = c.mode ?? "mcu";
    const unitSel = (i: number) =>
      `<label>${i === 0 ? t("midi.unit.main") : t("midi.unit.ext", { n: i })} <select id="u${i}"><option value="">${t("midi.none")}</option>${this.#choices.map((p) => `<option value="${esc(p.key)}"${(c.units?.[i] ?? "") === p.key ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>`;
    this.#root.innerHTML = `<style>${CSS}</style>
      <h2>${t("midi.title")}</h2><p class="hint">${t("midi.hint")}</p>
      <div class="row"><label>${t("midi.mode")} <select id="mode"><option value="mcu"${mode === "mcu" ? " selected" : ""}>${t("midi.mode.mcu")}</option><option value="profile"${mode === "profile" ? " selected" : ""}>${t("midi.mode.profile")}</option></select></label>
        <button id="search">${t("midi.search")}</button></div>
      <div class="row" id="units">${[0, 1, 2, 3].map((i) => (mode === "profile" && i > 0 ? "" : unitSel(i))).join("")}</div>
      <div class="row"><label>${t("midi.mixer")} <select id="mixer"><option value="">${t("midi.mixer.none")}</option>${this.#nodes.map((n) => `<option value="${esc(n.id)}"${c.mixer === n.id ? " selected" : ""}>${esc(n.label)}</option>`).join("")}</select></label>
        ${mode === "mcu" ? `<label>${t("midi.masterAux")} <input id="aux" size="8" value="${esc(c.masterAux ?? "")}"></label>` : ""}</div>
      ${mode === "profile" ? `<h3>${t("midi.profile.label")}</h3><textarea id="prof" spellcheck="false">${esc(c.profile ?? JSON.stringify(EXAMPLE_PROFILE, null, 2))}</textarea>
        <div class="row"><button id="check">${t("midi.profile.check")}</button><button id="example">${t("midi.profile.example")}</button><button id="learn">${t("midi.learn")}</button><span id="learnout"></span></div>` : ""}
      ${mode === "mcu" ? `<h3>${t("midi.keys.label")}</h3><p class="hint">${t("midi.keys.hint")}</p><textarea id="keys" spellcheck="false">${esc(c.keys ?? "")}</textarea>
        <div class="row"><button id="kcheck">${t("midi.keys.check")}</button><button id="kexample">${t("midi.keys.example")}</button></div>` : ""}
      <div class="row"><button id="start">${t("midi.start")}</button><button id="stop">${t("midi.stop")}</button><button id="sim">${t("midi.sim")}</button></div>
      <div class="err" id="err"></div><div id="status"></div><div id="last"></div>
      <div class="sim" id="simview"></div>`;
    this.#wire();
    this.#renderStatus();
    this.#renderSim();
  }

  #collect(): Saved {
    const v = (id: string) => (this.#root.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? "";
    const s: Saved = { mode: (v("mode") || "mcu") as "mcu" | "profile", units: [0, 1, 2, 3].map((i) => v(`u${i}`)), mixer: v("mixer"), masterAux: v("aux"), profile: this.#root.getElementById("prof") ? v("prof") : this.#cfg.profile, keys: this.#root.getElementById("keys") ? v("keys") : this.#cfg.keys };
    this.#cfg = s;
    save(s);
    return s;
  }

  #wire() {
    const $ = this.#$;
    ($("mode") as HTMLSelectElement).onchange = () => {
      this.#collect();
      this.#build();
    };
    for (const id of ["mixer", "aux", "prof", "keys"]) {
      const el = this.#root.getElementById(id);
      if (el) el.onchange = () => this.#collect();
    }
    ($("search") as HTMLButtonElement).onclick = () => void this.#search();
    ($("start") as HTMLButtonElement).onclick = () => void this.#start();
    ($("stop") as HTMLButtonElement).onclick = () => {
      midiSession.stop();
      this.#sims = [];
      this.#renderSim();
    };
    ($("sim") as HTMLButtonElement).onclick = () => void this.#startSim();
    const kc = this.#root.getElementById("kcheck");
    if (kc) {
      kc.onclick = () => {
        const k = this.#parseKeys();
        this.#$("err").textContent = typeof k === "string" ? k : "";
        if (typeof k !== "string") this.#$("last").innerHTML = `<span class="ok">${t("midi.keys.ok")}</span>`;
      };
      this.#$("kexample").onclick = () => {
        (this.#$("keys") as HTMLTextAreaElement).value = JSON.stringify(EXAMPLE_KEYS, null, 2);
        this.#collect();
      };
    }
    const chk = this.#root.getElementById("check");
    if (chk) {
      chk.onclick = () => {
        const p = this.#parseProfile();
        if (typeof p === "string") this.#$("err").textContent = p;
        else {
          this.#$("err").textContent = "";
          this.#$("last").innerHTML = `<span class="ok">${t("midi.profile.ok", { n: p.controls.length })}</span>`;
        }
      };
      this.#$("example").onclick = () => {
        (this.#$("prof") as HTMLTextAreaElement).value = JSON.stringify(EXAMPLE_PROFILE, null, 2);
        this.#collect();
      };
      this.#$("learn").onclick = () => {
        const r = midiSession.runner;
        if (!r) return void (this.#$("err").textContent = t("midi.err.no-port"));
        this.#$("learnout").textContent = t("midi.learn.wait");
        r.learn((d) => (this.#$("learnout").textContent = t("midi.learn.got", { type: d.type === "cc" ? "CC" : d.type === "note" ? "Note" : "Pitchbend", num: d.num, ch: d.channel, v: d.value })));
      };
    }
  }

  /** Tastenbelegung aus dem Eingabefeld: leer = Standard (null), sonst geprüft. */
  #parseKeys(): KeysConfig | null | string {
    const txt = ((this.#root.getElementById("keys") as HTMLTextAreaElement | null)?.value ?? this.#cfg.keys ?? "").trim();
    if (!txt) return null;
    let k: unknown;
    try {
      k = JSON.parse(txt);
    } catch (e) {
      return String((e as Error).message);
    }
    const errs = validateKeys(k, (n) => noteByName(n) !== null);
    return errs.length ? errs.join("; ") : (k as KeysConfig);
  }

  #parseProfile(): Profile | string {
    const txt = (this.#root.getElementById("prof") as HTMLTextAreaElement | null)?.value ?? "";
    let p: unknown;
    try {
      p = JSON.parse(txt);
    } catch (e) {
      return String((e as Error).message);
    }
    const errs = validateProfile(p);
    return errs.length ? errs.join("; ") : (p as Profile);
  }

  async #search() {
    const r = await requestAccess();
    if (!r.ok) {
      this.#$("err").textContent = t(`midi.err.${r.reason}` as never);
      return;
    }
    this.#access = r.access;
    r.access.onstatechange = () => {
      this.#collect();
      this.#choices = choices(r.access);
      this.#build();
    };
    this.#collect();
    this.#choices = choices(r.access);
    this.#build();
  }

  async #start() {
    const s = this.#collect();
    this.#$("err").textContent = "";
    if (!s.mixer && (s.mode ?? "mcu") === "mcu") return void (this.#$("err").textContent = t("midi.err.no-mixer"));
    const keys = (s.units ?? []).filter((k) => k);
    if (keys.some((k) => this.#choices.find((c) => c.key === k)?.role === "imap")) return void (this.#$("err").textContent = t("midi.err.imap"));
    const ports = keys.map((k) => this.#choices.find((c) => c.key === k)).filter((c): c is PortChoice => !!c).map((c) => openChoice(this.#access!, c));
    if (s.mode === "profile") {
      const p = this.#parseProfile();
      if (typeof p === "string") return void (this.#$("err").textContent = p);
      await midiSession.start({ mode: "profile", ports: ports.slice(0, 1), mixerNodeId: s.mixer ?? "", profile: p });
    } else {
      const k = this.#parseKeys();
      if (typeof k === "string") return void (this.#$("err").textContent = k);
      await midiSession.start({ mode: "mcu", ports, mixerNodeId: s.mixer ?? "", masterAux: s.masterAux || undefined, keys: k });
    }
    this.#renderStatus();
  }

  async #startSim() {
    const s = this.#collect();
    if (!s.mixer) return void (this.#$("err").textContent = t("midi.err.no-mixer"));
    this.#sims = [new SimSurface("Simulator Pult"), new SimSurface("Simulator Erweiterung")];
    const k = this.#parseKeys();
    if (typeof k === "string") return void (this.#$("err").textContent = k);
    await midiSession.start({ mode: "mcu", ports: this.#sims, mixerNodeId: s.mixer, masterAux: s.masterAux || undefined, keys: k });
    this.#renderSim();
    this.#renderStatus();
  }

  #renderStatus() {
    if (!this.isConnected || !this.#root.getElementById("status")) return;
    const st = this.#$("status");
    const lines: string[] = [midiSession.running ? t("midi.status.running") : t("midi.status.stopped")];
    midiSession.units.forEach((u) => lines.push(t("midi.unit.state", { name: u.port.name, state: u.online ? t("midi.unit.online") : t("midi.unit.silent") })));
    const lg = midiSession.logic;
    if (lg) lines.push(t("midi.bank", { n: Math.floor(lg.bank / Math.max(1, lg.totalStrips)) + 1 }));
    st.textContent = lines.join(" · ");
    if (midiSession.error) this.#$("err").textContent = midiSession.error.startsWith("no-") ? t(`midi.err.${midiSession.error}` as never) : midiSession.error;
    const last = midiSession.runner?.last;
    this.#$("last").textContent = last ? `${t("midi.last")}: ${last.type} ${last.num} / ${last.channel} = ${last.value}` : "";
  }

  #renderSim() {
    const host = this.#$("simview");
    host.replaceChildren();
    if (!this.#sims.length) return;
    const title = document.createElement("h3");
    title.style.width = "100%";
    title.textContent = `${t("midi.sim.title")} — ${t("midi.sim.touch")}`;
    host.appendChild(title);
    for (const sim of this.#sims) host.appendChild(this.#simUnit(sim));
  }

  #simUnit(sim: SimSurface): HTMLElement {
    const el = document.createElement("div");
    el.className = "unit";
    el.innerHTML = `<div class="lcd" data-l0></div><div class="lcd" data-l1></div><div class="strips"></div><div class="bar"></div>`;
    const strips = el.querySelector(".strips") as HTMLElement;
    const parts: (() => void)[] = [];
    for (let i = 0; i < 9; i++) {
      const s = document.createElement("div");
      s.className = i === 8 ? "strip master" : "strip";
      const btn = (label: string, name: string, note: number) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () => sim.press(name);
        parts.push(() => {
          const st = sim.leds.get(note) ?? "off";
          b.className = st === "on" ? "led-on" : st === "blink" ? "led-blink" : "";
        });
        return b;
      };
      if (i < 8) {
        const m = document.createElement("div");
        m.className = "meter";
        m.innerHTML = "<i></i>";
        parts.push(() => ((m.firstChild as HTMLElement).style.height = `${Math.min(100, (sim.meters[i] / 12) * 100)}%`));
        const knob = document.createElement("button");
        knob.className = "knob";
        knob.textContent = "◔";
        knob.onclick = () => sim.press(`vpotPush${i + 1}`);
        knob.onwheel = (e) => {
          e.preventDefault();
          sim.turn(i, e.deltaY < 0 ? 1 : -1);
        };
        s.append(m, btn("R", `rec${i + 1}`, i), btn("S", `solo${i + 1}`, 8 + i), btn("M", `mute${i + 1}`, 16 + i), btn("▷", `select${i + 1}`, 24 + i), knob);
      }
      const f = new SimFader({ onTouch: (d) => sim.touch(i, d), onMove: (v) => sim.drag(i, v) });
      f.setValue14(sim.faders[i]);
      parts.push(() => {
        if (!sim.touched[i]) f.setValue14(sim.faders[i]);
      });
      s.appendChild(f.wrap);
      strips.appendChild(s);
    }
    const bar = el.querySelector(".bar") as HTMLElement;
    for (const [label, name] of [["◀◀", "bankLeft"], ["◀", "channelLeft"], ["▶", "channelRight"], ["▶▶", "bankRight"], ["N/W", "nameValue"]] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = name;
      b.onclick = () => sim.press(name);
      bar.appendChild(b);
    }
    // Funktionstasten, Seiten, Jog, Shift
    const keysBar = document.createElement("div");
    keysBar.className = "bar";
    keysBar.title = t("midi.sim.keys");
    const kb = (label: string, name: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = name;
      b.onclick = () => sim.press(name);
      parts.push(() => {
        const st = sim.leds.get(noteByName(name) ?? -1) ?? "off";
        b.className = st === "on" ? "led-on" : st === "blink" ? "led-blink" : "";
      });
      return b;
    };
    for (let i = 1; i <= 8; i++) keysBar.appendChild(kb(`F${i}`, `f${i}`));
    for (const [l, n] of [["1", "midiTracks"], ["2", "inputs"], ["3", "audioTracks"], ["4", "audioInstruments"], ["5", "aux"], ["6", "busses"], ["7", "outputs"], ["8", "user"]] as const) keysBar.appendChild(kb(`P${l}`, n));
    const jb = (label: string, steps: number) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => sim.jog(steps);
      return b;
    };
    keysBar.append(jb("⟲", -1), jb("⟳", 1), kb("Scrub", "scrub"), kb("Solo✕", "soloGlobal"), kb("◀", "left"), kb("▶", "right"), kb("▲", "up"), kb("▼", "down"), kb("Play", "play"), kb("Stop", "stop"));
    // Shift bleibt gedrückt, bis man erneut klickt (zwei Hände am echten Pult)
    const shift = document.createElement("button");
    shift.textContent = "Shift";
    let shifted = false;
    shift.onclick = () => {
      shifted = !shifted;
      shift.className = shifted ? "led-on" : "";
      sim.hold("shift", shifted);
    };
    keysBar.appendChild(shift);
    el.appendChild(keysBar);
    const draw = () => {
      (el.querySelector("[data-l0]") as HTMLElement).textContent = sim.text(0);
      (el.querySelector("[data-l1]") as HTMLElement).textContent = sim.text(1);
      for (const p of parts) p();
    };
    sim.onChange(draw);
    draw();
    return el;
  }
}

if (!customElements.get("omp-midi-panel")) customElements.define("omp-midi-panel", MidiPanel);

export function createMidiToggle(buttonStyle: string): { button: HTMLButtonElement; panel: HTMLDivElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("midi.button");
  button.style.cssText = buttonStyle;
  const panel = document.createElement("div");
  panel.style.cssText =
    "display:none;position:fixed;right:12px;bottom:56px;width:fit-content;max-width:96vw;max-height:80vh;overflow:auto;" +
    "z-index:1000001;background:var(--omp-surface);border:1px solid var(--omp-border);border-radius:var(--omp-radius);box-shadow:0 4px 16px rgba(0,0,0,0.6);";
  button.addEventListener("click", () => {
    if (panel.style.display === "none") {
      if (!panel.firstChild) panel.appendChild(document.createElement("omp-midi-panel"));
      panel.style.display = "block";
    } else panel.style.display = "none";
  });
  return { button, panel };
}
