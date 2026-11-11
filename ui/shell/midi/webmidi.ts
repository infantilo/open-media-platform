// Web-MIDI-Transport (Kap. 93, Weg A): USB-MIDI-Geräte im Browser (Chrome/Edge, HTTPS oder localhost, SysEx-Erlaubnis nötig).
// Netzwerk-MIDI sieht der Browser nur, wenn das Betriebssystem es als MIDI-Anschluss anbietet (Weg B: omp-midi-gateway).

import type { MidiPort } from "./midi-port.ts";

/** Teilmenge der Web-MIDI-Typen, die wir brauchen (Tests ersetzen sie). */
export interface WmInput {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null;
}
export interface WmOutput {
  id: string;
  name?: string | null;
  state?: string;
  send(data: number[]): void;
}
export interface WmAccess {
  inputs: Map<string, WmInput> | { values(): Iterable<WmInput> };
  outputs: Map<string, WmOutput> | { values(): Iterable<WmOutput> };
  onstatechange: ((e: unknown) => void) | null;
}

export type WebMidiError = "no-webmidi" | "insecure-context" | "denied";

/** Rolle eines iCON-Anschlusses nach Namen (Handbuch P1-M: „iCON P1-M“ = DAW 1, „MIDIIN2/OUT2“ = DAW 2, „MIDIIN3“ = DAW 3, „MIDIIN4“ = iMAP). */
export function portRole(name: string): "daw1" | "daw2" | "daw3" | "imap" | null {
  if (/MIDI(IN|OUT)\s*4\b/i.test(name)) return "imap";
  if (/MIDI(IN|OUT)\s*2\b/i.test(name)) return "daw2";
  if (/MIDI(IN|OUT)\s*3\b/i.test(name)) return "daw3";
  return /\b(P1|V1)-[MX]\b/i.test(name) ? "daw1" : null;
}
const ROLE_TEXT = { daw1: "DAW 1", daw2: "DAW 2", daw3: "DAW 3", imap: "iMAP" } as const;

export interface PortChoice {
  role?: "daw1" | "daw2" | "daw3" | "imap";
  /** Stabiler Schlüssel (Name; bei gleichen Namen mit Nummer). */
  key: string;
  label: string;
  inId?: string;
  outId?: string;
}

const list = <T>(m: { values(): Iterable<T> }): T[] => [...m.values()];

/** Ein- und Ausgänge mit gleichem Namen zu Geräten zusammenfassen; Einzelne bleiben als Einzeleintrag. */
export function pairPorts(inputs: WmInput[], outputs: WmOutput[]): PortChoice[] {
  const used = new Set<string>();
  const out: PortChoice[] = [];
  const count = new Map<string, number>();
  for (const i of inputs) {
    const name = i.name || i.id;
    const o = outputs.find((x) => (x.name || x.id) === name && !used.has(x.id));
    if (o) used.add(o.id);
    const n = (count.get(name) ?? 0) + 1;
    count.set(name, n);
    const role = portRole(name) ?? undefined;
    const base = n > 1 ? `${name} (${n})` : name;
    out.push({ key: n > 1 ? `${name} #${n}` : name, label: role ? `${base} — ${ROLE_TEXT[role]}` : base, inId: i.id, outId: o?.id, role });
  }
  for (const o of outputs) {
    if (used.has(o.id)) continue;
    const name = o.name || o.id;
    out.push({ key: `${name} (nur Ausgang)`, label: `${name} (nur Ausgang)`, outId: o.id });
  }
  return out;
}

export class WebMidiPort implements MidiPort {
  readonly name: string;
  #in?: WmInput;
  #out?: WmOutput;
  #listeners = new Set<(b: number[]) => void>();

  constructor(inp: WmInput | undefined, out: WmOutput | undefined, name: string) {
    this.#in = inp;
    this.#out = out;
    this.name = name;
    if (inp) {
      inp.onmidimessage = (e) => {
        if (!e.data) return;
        const b = Array.from(e.data);
        for (const l of this.#listeners) l(b);
      };
    }
  }

  send(bytes: number[]): void {
    try {
      this.#out?.send(bytes);
    } catch { /* Gerät weg: verwerfen, die Sitzung merkt es am Ausbleiben von Daten / statechange */ }
  }
  onData(cb: (b: number[]) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  close(): void {
    if (this.#in) this.#in.onmidimessage = null;
    this.#listeners.clear();
  }
}

export type AccessResult = { ok: true; access: WmAccess } | { ok: false; reason: WebMidiError };

export async function requestAccess(nav: { requestMIDIAccess?: (o: { sysex: boolean }) => Promise<unknown> } = navigator as never, secure = globalThis.isSecureContext): Promise<AccessResult> {
  if (!nav.requestMIDIAccess) return { ok: false, reason: secure ? "no-webmidi" : "insecure-context" };
  try {
    return { ok: true, access: (await nav.requestMIDIAccess({ sysex: true })) as WmAccess };
  } catch {
    return { ok: false, reason: "denied" };
  }
}

export function choices(access: WmAccess): PortChoice[] {
  return pairPorts(list(access.inputs as { values(): Iterable<WmInput> }), list(access.outputs as { values(): Iterable<WmOutput> }));
}

export function openChoice(access: WmAccess, c: PortChoice): WebMidiPort {
  const inp = c.inId ? list(access.inputs as { values(): Iterable<WmInput> }).find((x) => x.id === c.inId) : undefined;
  const out = c.outId ? list(access.outputs as { values(): Iterable<WmOutput> }).find((x) => x.id === c.outId) : undefined;
  return new WebMidiPort(inp, out, c.label);
}
