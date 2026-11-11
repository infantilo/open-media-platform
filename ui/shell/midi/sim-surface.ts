// Simulierte Mackie-Control-Einheit (Geräteseite), Kap. 93. Versteht die Nachrichten des Rechners wie ein echtes Pult
// (Fahrfader, LEDs, Kränze, Pegel, Display) und erzeugt Bedienereignisse (Berühren, Fader ziehen, Tasten, Drehgeber).
// Dient den Tests und der Simulator-Seite; ersetzt keinen Test am Gerät (Motorträgheit, Berührungsschwellen, Firmware-Eigenheiten).

import { type LedState, MidiParser, noteByName } from "./mcu.ts";
import type { MidiPort } from "./midi-port.ts";

export class SimSurface implements MidiPort {
  readonly name: string;
  /** Fader 0…8 in 0…16383 (8 = Master). */
  faders = Array<number>(9).fill(0);
  touched = Array<boolean>(9).fill(false);
  leds = new Map<number, LedState>();
  rings = Array.from({ length: 8 }, () => ({ mode: 0, value: 0, led: false }));
  meters = Array<number>(8).fill(0);
  lcd = [" ".repeat(56), " ".repeat(56)];
  sevenSeg = Array<number>(12).fill(0x20);
  /** Alle vom Rechner empfangenen Nachrichten (für Tests). */
  received: number[][] = [];
  /** Antwortet auf `Device Query` mit einer Anmeldeaufforderung (wie ein echtes Pult). */
  answersQuery = true;
  online = true;
  #parser = new MidiParser();
  #listeners = new Set<(b: number[]) => void>();
  #changed = new Set<() => void>();

  constructor(name = "Simulator MCU") {
    this.name = name;
  }

  onChange(cb: () => void): () => void {
    this.#changed.add(cb);
    return () => this.#changed.delete(cb);
  }
  #notify() {
    for (const c of this.#changed) c();
  }

  // ── MidiPort: Rechner → Pult ──
  send(bytes: number[]): void {
    if (!this.online) return;
    for (const m of this.#parser.push(bytes)) {
      this.received.push(m);
      this.#handle(m);
    }
    this.#notify();
  }
  onData(cb: (b: number[]) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  close(): void {
    this.#listeners.clear();
  }

  #emit(bytes: number[]) {
    if (!this.online) return;
    for (const l of this.#listeners) l(bytes);
  }

  #handle(m: number[]) {
    const st = m[0] & 0xf0;
    if (m[0] === 0xf0) {
      const cmd = m[5];
      if (cmd === 0x00 && this.answersQuery) this.#emit([0xf0, 0, 0, 0x66, 0x14, 0x01, 0x53, 0x49, 0x4d, 0x30, 0x30, 0x30, 0x31, 1, 2, 3, 4, 0xf7]);
      if (cmd === 0x12) {
        const off = m[6];
        const text = m.slice(7, m.length - 1);
        text.forEach((c, i) => {
          const pos = off + i;
          const line = pos < 0x38 ? 0 : 1;
          const col = pos - (line ? 0x38 : 0);
          if (col < 56) this.lcd[line] = this.lcd[line].slice(0, col) + String.fromCharCode(c) + this.lcd[line].slice(col + 1);
        });
      }
      if (cmd === 0x63) this.reset();
      return;
    }
    if (st === 0xe0 && (m[0] & 0xf) <= 8) {
      // Motor fährt nur, wenn der Finger nicht darauf liegt
      if (!this.touched[m[0] & 0xf]) this.faders[m[0] & 0xf] = (m[2] << 7) | m[1];
    } else if (st === 0x90) this.leds.set(m[1], m[2] === 0 ? "off" : m[2] === 0x7f ? "on" : "blink");
    else if (st === 0xb0) {
      if (m[1] >= 0x30 && m[1] <= 0x37) this.rings[m[1] - 0x30] = { mode: (m[2] >> 4) & 3, value: m[2] & 0x0f, led: (m[2] & 0x40) !== 0 };
      else if (m[1] >= 0x40 && m[1] <= 0x4b) this.sevenSeg[m[1] - 0x40] = m[2];
    } else if (st === 0xd0) this.meters[(m[1] >> 4) & 7] = m[1] & 0x0f;
  }

  reset() {
    this.faders.fill(0);
    this.leds.clear();
    this.rings = Array.from({ length: 8 }, () => ({ mode: 0, value: 0, led: false }));
    this.meters.fill(0);
    this.lcd = [" ".repeat(56), " ".repeat(56)];
  }

  // ── Bedienung am Pult ──
  touch(strip: number, down: boolean) {
    this.touched[strip] = down;
    this.#emit([0x90, 104 + strip, down ? 0x7f : 0x00]);
  }
  /** Fader mit dem Finger ziehen (berührt, falls noch nicht). */
  drag(strip: number, value14: number) {
    if (!this.touched[strip]) this.touch(strip, true);
    this.faders[strip] = Math.max(0, Math.min(16383, Math.round(value14)));
    this.#emit([0xe0 | strip, this.faders[strip] & 0x7f, this.faders[strip] >> 7]);
    this.#notify();
  }
  release(strip: number) {
    this.touch(strip, false);
  }
  press(name: string) {
    const n = noteByName(name);
    if (n === null) throw new Error(`unbekannte Taste ${name}`);
    this.#emit([0x90, n, 0x7f]);
    this.#emit([0x90, n, 0x00]);
  }
  /** Taste halten bzw. loslassen (Shift). */
  hold(name: string, down: boolean) {
    const n = noteByName(name);
    if (n === null) throw new Error(`unbekannte Taste ${name}`);
    this.#emit([0x90, n, down ? 0x7f : 0x00]);
  }
  /** Drehgeber drehen (positiv = im Uhrzeigersinn). */
  turn(strip: number, steps: number) {
    this.#emit([0xb0, 0x10 + strip, (steps < 0 ? 0x40 : 0) | (Math.min(63, Math.abs(steps)) & 0x3f)]);
  }
  /** Jog-Rad drehen (positiv = im Uhrzeigersinn). */
  jog(steps: number) {
    this.#emit([0xb0, 0x3c, (steps < 0 ? 0x40 : 0) | (Math.min(63, Math.abs(steps)) & 0x3f)]);
  }
  text(line: 0 | 1): string {
    return this.lcd[line];
  }
}
