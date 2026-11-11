// Generische MIDI-Zuordnung (Kap. 93): ein Profil ordnet Regler/Tasten eines beliebigen MIDI-Geräts (CC, Note, Pitchbend) einem
// Methodenaufruf eines Nodes zu — für Geräte ohne Mackie-Control-Sprache. Reine Logik; das Rust-Gegenstück liegt in
// nodes/omp-midi-gateway/src/profile.rs und wird gegen docs/midi/profile-golden.json getestet.

export interface MidiIn {
  type: "cc" | "note" | "pitchbend";
  /** 1…16; ohne Angabe: jeder Kanal. */
  channel?: number;
  /** CC- bzw. Notennummer (nicht bei pitchbend). */
  num?: number;
}

export interface Target {
  /** Anzeigename des Ziel-Nodes (so wie im Flow-Editor). Leer = Standardziel der Sitzung. */
  node?: string;
  method: string;
  /** Feste Argumente. */
  args?: Record<string, unknown>;
  /** Name des Arguments, das den Wert bekommt (absolute/toggle/relative). */
  arg?: string;
  min?: number;
  max?: number;
  /** Schritt je Rasterschritt bei `relative` (Standard 1). */
  step?: number;
  /** Für `relative`: Parameter, aus dem der Aufrufer den aktuellen Wert liest (Lesen-Ändern-Schreiben). */
  readParam?: string;
  /** Werte für Taste an/aus bei `momentary`/`toggle` (Standard true/false). */
  onValue?: unknown;
  offValue?: unknown;
}

export type ControlMode = "absolute" | "momentary" | "toggle" | "relative";

export interface Control {
  id: string;
  label?: string;
  in: MidiIn;
  /** Standard: cc/pitchbend → absolute, note → momentary. */
  mode?: ControlMode;
  to: Target;
}

export interface Profile {
  name: string;
  controls: Control[];
}

export type Action =
  | { kind: "call"; node: string; method: string; args: Record<string, unknown>; controlId: string }
  | { kind: "nudge"; node: string; method: string; args: Record<string, unknown>; arg: string; delta: number; min?: number; max?: number; readParam: string; controlId: string };

export interface Described {
  type: "cc" | "note" | "pitchbend";
  channel: number;
  num: number;
  /** CC/Velocity 0…127, Pitchbend 0…16383. */
  value: number;
  /** Note: gedrückt. */
  down?: boolean;
}

/** Eine fertige Kanalnachricht in Typ/Kanal/Nummer/Wert zerlegen (auch für die Lernfunktion). */
export function describe(msg: number[]): Described | null {
  const st = msg[0] & 0xf0;
  const channel = (msg[0] & 0x0f) + 1;
  if (st === 0xb0 && msg.length >= 3) return { type: "cc", channel, num: msg[1], value: msg[2] };
  if ((st === 0x90 || st === 0x80) && msg.length >= 3) return { type: "note", channel, num: msg[1], value: msg[2], down: st === 0x90 && msg[2] > 0 };
  if (st === 0xe0 && msg.length >= 3) return { type: "pitchbend", channel, num: 0, value: (msg[2] << 7) | msg[1] };
  return null;
}

export const matches = (i: MidiIn, d: Described): boolean => i.type === d.type && (i.channel === undefined || i.channel === d.channel) && (i.type === "pitchbend" || i.num === d.num);

export const modeOf = (c: Control): ControlMode => c.mode ?? (c.in.type === "note" ? "momentary" : "absolute");

/** Rohwert → Zielbereich (linear). */
export function scale(raw: number, rawMax: number, min = 0, max = 1): number {
  const v = min + (Math.max(0, Math.min(rawMax, raw)) / rawMax) * (max - min);
  return Math.round(v * 10000) / 10000;
}

/** Relative Drehgeber (Zweierkomplement um 64, „binary offset“): 64 = 0, 65 = +1, 63 = −1. */
export const relativeDelta = (v: number): number => v - 64;

export class ProfileEngine {
  #toggles = new Map<string, boolean>();
  constructor(public profile: Profile, private defaultNode = "") {}

  /** Nachricht verarbeiten → Aktionen (leer, wenn nichts passt). */
  handle(msg: number[]): Action[] {
    const d = describe(msg);
    if (!d) return [];
    const out: Action[] = [];
    for (const c of this.profile.controls) {
      if (!matches(c.in, d)) continue;
      const node = c.to.node || this.defaultNode;
      const mode = modeOf(c);
      const args: Record<string, unknown> = { ...(c.to.args ?? {}) };
      if (mode === "absolute") {
        if (!c.to.arg) continue;
        args[c.to.arg] = scale(d.value, d.type === "pitchbend" ? 16383 : 127, c.to.min, c.to.max);
      } else if (mode === "momentary") {
        if (d.type === "note" && d.down === undefined) continue;
        const down = d.type === "note" ? !!d.down : d.value >= 64;
        if (c.to.arg) args[c.to.arg] = down ? c.to.onValue ?? true : c.to.offValue ?? false;
        else if (!down) continue; // ohne Argument: nur beim Drücken auslösen
      } else if (mode === "toggle") {
        const down = d.type === "note" ? !!d.down : d.value >= 64;
        if (!down) continue;
        const now = !(this.#toggles.get(c.id) ?? false);
        this.#toggles.set(c.id, now);
        if (c.to.arg) args[c.to.arg] = now ? c.to.onValue ?? true : c.to.offValue ?? false;
      } else {
        if (!c.to.arg || !c.to.readParam || d.type !== "cc") continue;
        const delta = relativeDelta(d.value) * (c.to.step ?? 1);
        if (delta === 0) continue;
        out.push({ kind: "nudge", node, method: c.to.method, args, arg: c.to.arg, delta, min: c.to.min, max: c.to.max, readParam: c.to.readParam, controlId: c.id });
        continue;
      }
      out.push({ kind: "call", node, method: c.to.method, args, controlId: c.id });
    }
    return out;
  }
}

/** Prüft ein Profil (z. B. aus einer Datei) und liefert lesbare Fehler. */
export function validateProfile(p: unknown): string[] {
  const errs: string[] = [];
  const o = p as Profile;
  if (!o || typeof o !== "object") return ["Profil ist kein Objekt"];
  if (typeof o.name !== "string" || !o.name.trim()) errs.push("name fehlt");
  if (!Array.isArray(o.controls)) return [...errs, "controls fehlt"];
  const ids = new Set<string>();
  o.controls.forEach((c, i) => {
    const w = `controls[${i}]`;
    if (!c || typeof c.id !== "string" || !c.id) errs.push(`${w}: id fehlt`);
    else if (ids.has(c.id)) errs.push(`${w}: id „${c.id}“ doppelt`);
    else ids.add(c.id);
    if (!c?.in || !["cc", "note", "pitchbend"].includes(c.in.type)) errs.push(`${w}: in.type muss cc, note oder pitchbend sein`);
    else {
      if (c.in.type !== "pitchbend" && (!Number.isInteger(c.in.num) || c.in.num! < 0 || c.in.num! > 127)) errs.push(`${w}: in.num 0…127`);
      if (c.in.channel !== undefined && (!Number.isInteger(c.in.channel) || c.in.channel < 1 || c.in.channel > 16)) errs.push(`${w}: in.channel 1…16`);
    }
    if (!c?.to || typeof c.to.method !== "string" || !c.to.method) errs.push(`${w}: to.method fehlt`);
    const mode = c?.mode;
    if (mode !== undefined && !["absolute", "momentary", "toggle", "relative"].includes(mode)) errs.push(`${w}: mode unbekannt`);
    else if (c?.to && c.in) {
      const m = modeOf(c);
      if ((m === "absolute" || m === "relative") && !c.to.arg) errs.push(`${w}: to.arg fehlt (Modus ${m})`);
      if (m === "relative" && !c.to.readParam) errs.push(`${w}: to.readParam fehlt (relative)`);
    }
  });
  return errs;
}
