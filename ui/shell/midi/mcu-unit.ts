// Eine Mackie-Control-Einheit (Hauptpult oder Erweiterung) an einem MIDI-Anschluss: Strom → Ereignisse, Soll-Zustand → nur die
// Änderungen als Bytes. Merkt sich, was das Pult schon zeigt (kein Dauerfeuer), und fährt Fader nicht gegen den Finger.

import { FADER_MAX } from "./fader-law.ts";
import {
  DEVICE_ID_MCU,
  decodeFromSurface,
  deviceQuery,
  faderMove,
  hostConnectionReply,
  lcdCells,
  lcdWrite,
  type LedState,
  ledNote,
  type McuEvent,
  meterLevel,
  MidiParser,
  NOTE,
  sevenSegText,
  vpotRing,
} from "./mcu.ts";
import type { MidiPort } from "./midi-port.ts";
import type { UnitState } from "./surface-logic.ts";

export interface McuUnitOptions {
  deviceId?: number;
  /** Fader-Toleranz: kleinere Änderungen werden nicht gesendet (Motor ruhig halten). */
  faderTolerance?: number;
}

export class McuUnit {
  readonly port: MidiPort;
  #id: number;
  #tol: number;
  #parser = new MidiParser();
  #off: (() => void) | null = null;
  #listeners = new Set<(e: McuEvent) => void>();
  #moveListeners = new Set<(strip: number) => void>();
  // Zwischenspeicher dessen, was das Pult schon zeigt
  #faders: (number | null)[] = Array(9).fill(null);
  #leds = new Map<number, LedState>();
  #rings: string[] = Array(8).fill("");
  #meters: number[] = Array(8).fill(-1);
  #lcd = "";
  #seg = "";
  #touched = new Set<number>();
  /** Das Pult hat sich gemeldet (irgendein Byte, Anmeldung oder Antwort). */
  online = false;
  version = "";

  constructor(port: MidiPort, opts: McuUnitOptions = {}) {
    this.port = port;
    this.#id = opts.deviceId ?? DEVICE_ID_MCU;
    this.#tol = opts.faderTolerance ?? 24;
    this.#off = port.onData((b) => this.#onBytes(b));
  }

  onEvent(cb: (e: McuEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Wird gerufen, wenn der Rechner einen Fader fährt (Echo-Sperre). */
  onHostMove(cb: (strip: number) => void): () => void {
    this.#moveListeners.add(cb);
    return () => this.#moveListeners.delete(cb);
  }

  /** Pult zur Anmeldung auffordern; danach `apply` aufrufen. */
  start() {
    this.resync();
    this.port.send(deviceQuery(this.#id));
  }

  /** Alles vergessen → nächster `apply` schreibt das ganze Pult neu (nach Wiederverbinden). */
  resync() {
    this.#faders = Array(9).fill(null);
    this.#leds.clear();
    this.#rings = Array(8).fill("");
    this.#meters = Array(8).fill(-1);
    this.#lcd = "";
    this.#seg = "";
  }

  stop() {
    this.#off?.();
    this.#off = null;
  }

  #onBytes(bytes: number[]) {
    for (const msg of this.#parser.push(bytes)) {
      this.online = true;
      const ev = decodeFromSurface(msg);
      if (ev.t === "sysex") {
        const reply = hostConnectionReply(ev);
        if (reply) {
          this.port.send(reply);
          continue; // Anmeldung ist kein Bedienereignis
        }
        if (ev.cmd === 0x14) this.version = String.fromCharCode(...ev.data);
      }
      if (ev.t === "touch") {
        if (ev.down) this.#touched.add(ev.strip);
        else {
          this.#touched.delete(ev.strip);
          this.#faders[ev.strip] = null; // nach dem Loslassen Sollstellung neu schreiben
        }
      }
      if (ev.t === "fader" && this.#touched.has(ev.strip)) this.#faders[ev.strip] = ev.value; // Pult weiß, wo der Fader steht
      for (const l of this.#listeners) l(ev);
    }
  }

  /** Soll-Zustand schreiben; sendet nur Unterschiede. */
  apply(s: UnitState) {
    const out: number[][] = [];
    for (let i = 0; i < 9; i++) {
      const want = s.faders[i];
      if (want === null || this.#touched.has(i)) continue;
      const have = this.#faders[i];
      if (have === null || Math.abs(have - want) >= this.#tol || ((want === 0 || want === FADER_MAX) && have !== want)) {
        out.push(faderMove(i, want));
        this.#faders[i] = want;
        for (const l of this.#moveListeners) l(i);
      }
    }
    for (const [note, st] of s.leds) {
      if (this.#leds.get(note) !== st) {
        out.push(ledNote(note, st));
        this.#leds.set(note, st);
      }
    }
    s.rings.forEach((r, i) => {
      const key = `${r.mode}:${r.value}:${r.led}`;
      if (this.#rings[i] !== key) {
        out.push(vpotRing(i, r.mode, r.value, r.led));
        this.#rings[i] = key;
      }
    });
    s.meters.forEach((m, i) => {
      if (this.#meters[i] !== m) {
        out.push(meterLevel(i, m));
        this.#meters[i] = m;
      }
    });
    const lcd = JSON.stringify([s.lcdTop, s.lcdBottom, s.message]);
    if (lcd !== this.#lcd) {
      out.push(...lcdCells(s.lcdTop, s.lcdBottom, this.#id));
      if (s.message) out.push(lcdWrite(1, 0, s.message.padEnd(56, " ").slice(0, 56), this.#id));
      this.#lcd = lcd;
    }
    if (s.sevenSeg !== this.#seg) {
      out.push(...sevenSegText(s.sevenSeg));
      this.#seg = s.sevenSeg;
    }
    for (const m of out) this.port.send(m);
  }
}

export { NOTE };
