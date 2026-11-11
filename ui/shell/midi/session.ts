// MIDI-Sitzung im Browser (Kap. 93, Weg A): Pulte (Mackie Control) am Audiomischer oder ein generisches Profil. Hält die
// Verbindung unabhängig von der Ansicht (wie das Stream Deck), fragt den Mischer zyklisch ab und treibt die Pulte.

import { AudioMixerBackend, applyLiveMessage, type MixerIO } from "./audio-backend.ts";
import { McuUnit } from "./mcu-unit.ts";
import type { MidiPort } from "./midi-port.ts";
import type { KeysConfig } from "./keys.ts";
import { type Profile, ProfileEngine } from "./profile.ts";
import { type NodeCaller, ProfileRunner } from "./profile-runner.ts";
import { SurfaceController } from "./surface-controller.ts";
import { SurfaceLogic } from "./surface-logic.ts";

export interface SessionDeps {
  /** Zugriff auf einen Node (Proxy-API). */
  ioFor(nodeId: string): MixerIO;
  /** Live-Strom (SSE) eines Node-Parameters; liefert die Abmeldefunktion. */
  openStream?(nodeId: string, param: string, onMessage: (m: Record<string, unknown>) => void): () => void;
  /** Node-Anzeigename → ID (für Profile mit `node`). */
  resolveNode?(label: string): Promise<string | null>;
  now?: () => number;
  setInterval?: (f: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export type SessionMode = "mcu" | "profile";

export interface StartOptions {
  mode: SessionMode;
  ports: MidiPort[];
  mixerNodeId: string;
  masterAux?: string;
  /** Nur Modus „profile“. */
  profile?: Profile;
  /** Nur Modus „mcu“: Tastenbelegung (Seiten, feste Tasten, Jog). */
  keys?: KeysConfig | null;
}

export class MidiSession {
  #deps: Required<Pick<SessionDeps, "now" | "setInterval" | "clearInterval">> & SessionDeps;
  #ctl: SurfaceController | null = null;
  #runner: ProfileRunner | null = null;
  #backend: AudioMixerBackend | null = null;
  #timers: unknown[] = [];
  #offStream: (() => void) | null = null;
  #listeners = new Set<() => void>();
  running = false;
  mode: SessionMode = "mcu";
  error = "";
  ports: MidiPort[] = [];

  constructor(deps: SessionDeps) {
    this.#deps = { now: () => performance.now(), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as number), ...deps };
  }

  get logic(): SurfaceLogic | null {
    return this.#ctl?.logic ?? null;
  }
  get runner(): ProfileRunner | null {
    return this.#runner;
  }
  get units(): McuUnit[] {
    return this.#ctl?.units ?? [];
  }
  get backend(): AudioMixerBackend | null {
    return this.#backend;
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  #emit() {
    for (const l of this.#listeners) l();
  }

  async start(o: StartOptions) {
    this.stop();
    this.error = "";
    this.mode = o.mode;
    this.ports = o.ports;
    if (!o.ports.length) {
      this.error = "no-port";
      this.#emit();
      return;
    }
    if (o.mode === "profile") {
      if (!o.profile) {
        this.error = "no-profile";
        this.#emit();
        return;
      }
      const caller = this.#callerFor(o.mixerNodeId);
      this.#runner = new ProfileRunner(o.ports[0], new ProfileEngine(o.profile, ""), caller);
      this.#runner.onActivity = () => this.#emit();
      this.#runner.onError = (e) => {
        this.error = String((e as Error)?.message ?? e);
        this.#emit();
      };
      this.#runner.start();
      this.running = true;
      this.#emit();
      return;
    }

    const backend = new AudioMixerBackend(this.#deps.ioFor(o.mixerNodeId), o.masterAux ?? "");
    backend.errors.push((e) => {
      this.error = String((e as Error)?.message ?? e);
      this.#emit();
    });
    backend.external = this.#callerFor(o.mixerNodeId);
    const logic = new SurfaceLogic(backend, { units: o.ports.map((_, i) => ({ strips: 8, hasMaster: i === 0 })), keys: o.keys });
    const ctl = new SurfaceController(o.ports.map((p) => new McuUnit(p)), logic, this.#deps.now);
    this.#backend = backend;
    this.#ctl = ctl;
    await this.pollOnce();
    ctl.start();
    this.#offStream = this.#deps.openStream?.(o.mixerNodeId, "levelsUrl", (m) => {
      applyLiveMessage(backend.live, m as never);
    }) ?? null;
    this.#timers.push(
      this.#deps.setInterval(() => ctl.tick(), 40),
      this.#deps.setInterval(() => void this.pollOnce(), 700),
      // Pegel aus dem Live-Strom in die Pult-Logik (ohne volle Abfrage)
      this.#deps.setInterval(() => {
        const lv: Record<string, number> = {};
        for (const [id, v] of backend.live) lv[id] = v.level;
        logic.setLevels(lv);
      }, 40),
    );
    this.running = true;
    this.#emit();
  }

  /** Aufrufe an andere Nodes nach Anzeigename (leer = der gewählte Mischer). */
  #callerFor(mixerNodeId: string): NodeCaller {
    const cache = new Map<string, MixerIO>();
    return {
      call: async (node, method, args) => (await this.#ioOf(node, mixerNodeId, cache)).call(method, args),
      read: async (node, param) => (await this.#ioOf(node, mixerNodeId, cache)).getParam(param),
    };
  }

  async #ioOf(label: string, fallbackId: string, cache: Map<string, MixerIO>): Promise<MixerIO> {
    if (!label) return this.#deps.ioFor(fallbackId);
    let io = cache.get(label);
    if (!io) {
      const id = (await this.#deps.resolveNode?.(label)) ?? null;
      if (!id) throw new Error(`Node „${label}“ nicht gefunden`);
      io = this.#deps.ioFor(id);
      cache.set(label, io);
    }
    return io;
  }

  /** Mischer abfragen (auch vom Test aufrufbar). */
  async pollOnce() {
    const be = this.#backend;
    const logic = this.logic;
    if (!be || !logic) return;
    try {
      const r = await be.refresh();
      // Während ein Fader berührt wird, nicht umbauen (Modell wird trotzdem übernommen, die Logik hält den Wert)
      logic.setModel(r.channels, r.master);
      if (this.error && !this.error.startsWith("no-")) this.error = "";
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
    }
    this.#emit();
  }

  stop() {
    for (const t of this.#timers) this.#deps.clearInterval(t);
    this.#timers = [];
    this.#offStream?.();
    this.#offStream = null;
    this.#ctl?.stop();
    this.#ctl = null;
    this.#runner?.stop();
    this.#runner = null;
    this.#backend = null;
    for (const p of this.ports) p.close();
    this.ports = [];
    if (this.running) {
      this.running = false;
      this.#emit();
    }
  }
}
