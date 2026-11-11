// Führt ein generisches Profil an einem MIDI-Anschluss aus (Kap. 93): Nachricht → Aktion → Methodenaufruf am Ziel-Node.
// Lesen-Ändern-Schreiben (relative Regler) je Regler nacheinander, damit schnelle Drehungen nichts überholen.

import { MidiParser } from "./mcu.ts";
import type { MidiPort } from "./midi-port.ts";
import { type Action, describe, type Described, ProfileEngine } from "./profile.ts";

export interface NodeCaller {
  call(node: string, method: string, args: Record<string, unknown>): Promise<void>;
  read(node: string, param: string): Promise<unknown>;
}

export class ProfileRunner {
  #parser = new MidiParser();
  #off: (() => void) | null = null;
  #chains = new Map<string, Promise<void>>();
  #learn: ((d: Described) => void) | null = null;
  /** Letzte erkannte Nachricht (Anzeige im Panel). */
  last: Described | null = null;
  onActivity: () => void = () => {};
  onError: (e: unknown) => void = () => {};

  constructor(private port: MidiPort, readonly engine: ProfileEngine, private io: NodeCaller) {}

  start() {
    this.#off = this.port.onData((b) => {
      for (const m of this.#parser.push(b)) {
        const d = describe(m);
        if (!d) continue;
        this.last = d;
        this.onActivity();
        if (this.#learn) {
          const cb = this.#learn;
          this.#learn = null;
          cb(d);
          continue;
        }
        for (const a of this.engine.handle(m)) this.#run(a);
      }
    });
  }

  stop() {
    this.#off?.();
    this.#off = null;
  }

  /** Nächste Bewegung am Gerät an `cb` melden statt auszuführen (Lernen). */
  learn(cb: (d: Described) => void) {
    this.#learn = cb;
  }
  cancelLearn() {
    this.#learn = null;
  }

  #run(a: Action) {
    const prev = this.#chains.get(a.controlId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        if (a.kind === "call") {
          await this.io.call(a.node, a.method, a.args);
        } else {
          const cur = await this.io.read(a.node, a.readParam);
          if (typeof cur !== "number") return;
          let v = cur + a.delta;
          if (a.min !== undefined) v = Math.max(a.min, v);
          if (a.max !== undefined) v = Math.min(a.max, v);
          await this.io.call(a.node, a.method, { ...a.args, [a.arg]: Math.round(v * 10000) / 10000 });
        }
      } catch (e) {
        this.onError(e);
      }
    });
    this.#chains.set(a.controlId, next);
  }

  /** Für Tests: wartet, bis alle laufenden Aufrufe fertig sind. */
  async idle() {
    await Promise.all([...this.#chains.values()]);
  }
}
