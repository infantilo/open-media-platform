// Pult-Logik (Kap. 93): verbindet ein oder mehrere Mackie-Control-Einheiten (Hauptpult + Erweiterungen) mit einem Audiomischer.
// Reine Logik: Ereignisse und Modell hinein, Mischer-Befehle und Soll-Zustand je Einheit heraus. Keine Ein-/Ausgabe, keine Zeit
// außer der übergebenen — deshalb ohne Gerät testbar. Das Rust-Gegenstück liegt in nodes/omp-midi-gateway/src/surface.rs.

import { dbToFader, faderToDb, FADER_MAX } from "./fader-law.ts";
import { BUTTON, type LedState, type McuEvent, meterStep, NOTE, type RingMode } from "./mcu.ts";

export interface StripInfo {
  id: string;
  label: string;
  gainDb: number | null;
  mute: boolean;
  pfl: boolean;
  onAir: boolean;
  /** Pegel 0…1 (Messskala des Audiomischers). */
  level: number;
  pan: number | null;
}

/** Befehle an den Mischer (die Anbindung ruft `channel.<id>.setGain` usw.). */
export interface MixerActions {
  setGain(id: string, db: number): void;
  setMute(id: string, muted: boolean): void;
  setPfl(id: string, enabled: boolean): void;
  setPan(id: string, pan: number): void;
  /** Master-Fader (nur wenn die Anbindung ein Ziel kennt). */
  setMaster?(db: number): void;
}

export interface UnitState {
  /** Fader 0…8 (8 = Master): 14-Bit-Sollwert, `null` = nicht bewegen. */
  faders: (number | null)[];
  leds: Map<number, LedState>;
  rings: { mode: RingMode; value: number; led: boolean }[];
  meters: number[];
  lcdTop: string[];
  lcdBottom: string[];
  /** 12 Zeichen der 7-Segment-Anzeige (links 2 Stellen Zuweisung, rechts 10 Zeitcode). */
  sevenSeg: string;
}

export interface UnitSpec {
  strips: number;
  hasMaster: boolean;
}

export interface LogicOptions {
  units: UnitSpec[];
  /** Mindestabstand zwischen zwei Gain-Befehlen je Kanal (ms). */
  gainIntervalMs?: number;
  /** Nach einer Bewegung durch den Rechner gelten Fader-Meldungen so lange nicht als Eingriff (ms). */
  echoGuardMs?: number;
  panStep?: number;
  /** So lange hält die Anzeige den vom Pult gesetzten Wert, bis der Mischer ihn bestätigt (ms). */
  holdMs?: number;
}

export type LcdMode = "gain" | "pan";

interface Held {
  db: number;
  at: number;
}

export class SurfaceLogic {
  #o: Required<LogicOptions>;
  #channels: StripInfo[] = [];
  #master: { db: number | null } | null = null;
  bank = 0;
  selected: string | null = null;
  lcdMode: LcdMode = "gain";
  #touch = new Map<string, boolean>(); // "unit:strip"
  #lastHostMove = new Map<string, number>();
  /** Noch nicht an den Mischer gesendete Fader-Werte (gedrosselt). */
  #pending = new Map<string, number>();
  #masterPending: number | null = null;
  #lastSent = new Map<string, number>();
  /** Letzter vom Pult gesetzter Wert je Kanal, solange der Mischer ihn noch nicht bestätigt hat (verfällt nach `holdMs`). */
  #held = new Map<string, Held>();
  #heldMaster: Held | null = null;

  constructor(private mixer: MixerActions, opts: LogicOptions) {
    this.#o = { gainIntervalMs: 50, echoGuardMs: 300, panStep: 0.05, holdMs: 2000, ...opts };
  }

  get units(): UnitSpec[] {
    return this.#o.units;
  }

  setModel(channels: StripInfo[], master?: { db: number | null } | null) {
    this.#channels = channels;
    this.#master = master ?? null;
    if (this.selected && !channels.some((c) => c.id === this.selected)) this.selected = null;
    this.bank = this.#clampBank(this.bank);
    // Mischer hat den gehaltenen Wert übernommen → nicht mehr festhalten (Verfall nach holdMs: `view`)
    for (const c of channels) {
      const h = this.#held.get(c.id);
      if (h && c.gainDb !== null && Math.abs(c.gainDb - h.db) < 0.15 && !this.#pending.has(c.id)) this.#held.delete(c.id);
    }
    if (this.#heldMaster && this.#master && this.#master.db !== null && Math.abs(this.#master.db - this.#heldMaster.db) < 0.15 && this.#masterPending === null) this.#heldMaster = null;
  }

  setLevels(levels: Record<string, number>) {
    for (const c of this.#channels) if (c.id in levels) c.level = levels[c.id];
  }

  /** Kanäle über alle Einheiten (Master zählt nicht). */
  get totalStrips(): number {
    return this.#o.units.reduce((a, u) => a + u.strips, 0);
  }

  #clampBank(b: number): number {
    const max = Math.max(0, this.#channels.length - this.totalStrips);
    return Math.max(0, Math.min(max, b));
  }

  #unitOffset(unit: number): number {
    let o = 0;
    for (let i = 0; i < unit; i++) o += this.#o.units[i].strips;
    return o;
  }

  #strip(unit: number, i: number): StripInfo | undefined {
    if (i >= this.#o.units[unit].strips) return undefined;
    return this.#channels[this.bank + this.#unitOffset(unit) + i];
  }

  #key = (unit: number, strip: number) => `${unit}:${strip}`;

  /** Ereignis eines Pults verarbeiten. */
  onEvent(unit: number, ev: McuEvent, now: number) {
    const u = this.#o.units[unit];
    if (!u) return;
    switch (ev.t) {
      case "touch": {
        const k = this.#key(unit, ev.strip);
        this.#touch.set(k, ev.down);
        if (!ev.down) {
          // losgelassen: sofort den letzten Wert zum Mischer, dann hält der Mischer den Fader
          this.flush(now, true);
          this.#lastHostMove.delete(k);
        }
        break;
      }
      case "fader": {
        const k = this.#key(unit, ev.strip);
        const touched = this.#touch.get(k) === true;
        const echo = now - (this.#lastHostMove.get(k) ?? -1e9) < this.#o.echoGuardMs;
        if (!touched && echo) break; // Echo der eigenen Fahrt
        if (ev.strip === 8) {
          if (u.hasMaster && this.mixer.setMaster) {
            const db = faderToDb(ev.value);
            this.#heldMaster = { db, at: now };
            this.#masterPending = db;
            this.flush(now);
          }
          break;
        }
        const c = this.#strip(unit, ev.strip);
        if (!c) break;
        const db = faderToDb(ev.value);
        this.#held.set(c.id, { db, at: now });
        this.#pending.set(c.id, db);
        this.flush(now);
        break;
      }
      case "button":
        if (ev.down) this.#press(unit, ev.note);
        break;
      case "vpot": {
        const c = this.#strip(unit, ev.strip);
        if (!c || c.pan === null) break;
        const pan = Math.max(-1, Math.min(1, Math.round((c.pan + ev.delta * this.#o.panStep) * 100) / 100));
        c.pan = pan;
        this.mixer.setPan(c.id, pan);
        break;
      }
      default:
        break;
    }
  }

  #press(unit: number, note: number) {
    const within = (base: number) => (note >= base && note < base + 8 ? note - base : -1);
    let i = within(NOTE.mute);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) {
        c.mute = !c.mute;
        this.mixer.setMute(c.id, c.mute);
      }
      return;
    }
    i = within(NOTE.solo);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) {
        c.pfl = !c.pfl;
        this.mixer.setPfl(c.id, c.pfl);
      }
      return;
    }
    i = within(NOTE.select);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) this.selected = c.id;
      return;
    }
    i = within(NOTE.vpotPush);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c && c.pan !== null) {
        c.pan = 0;
        this.mixer.setPan(c.id, 0);
      }
      return;
    }
    const step = this.totalStrips;
    switch (note) {
      case BUTTON.bankLeft:
        this.bank = this.#clampBank(this.bank - step);
        break;
      case BUTTON.bankRight:
        this.bank = this.#clampBank(this.bank + step);
        break;
      case BUTTON.channelLeft:
        this.bank = this.#clampBank(this.bank - 1);
        break;
      case BUTTON.channelRight:
        this.bank = this.#clampBank(this.bank + 1);
        break;
      case BUTTON.nameValue:
        this.lcdMode = this.lcdMode === "gain" ? "pan" : "gain";
        break;
      default:
        break;
    }
  }

  /** Gedrosselte Befehle absenden. `force`: alles Ausstehende sofort. Rückgabe: es war etwas fällig. */
  flush(now: number, force = false): boolean {
    let any = false;
    for (const [id, db] of this.#pending) {
      if (force || now - (this.#lastSent.get(id) ?? -1e9) >= this.#o.gainIntervalMs) {
        this.mixer.setGain(id, db);
        this.#pending.delete(id);
        this.#lastSent.set(id, now);
        any = true;
      }
    }
    if (this.#masterPending !== null && (force || now - (this.#lastSent.get("\0master") ?? -1e9) >= this.#o.gainIntervalMs)) {
      this.mixer.setMaster?.(this.#masterPending);
      this.#masterPending = null;
      this.#lastSent.set("\0master", now);
      any = true;
    }
    return any;
  }

  /** Soll-Zustand einer Einheit. `now` für die Echo-Sperre der Fahrfader. */
  view(unit: number, now: number): UnitState {
    const spec = this.#o.units[unit];
    const faders: (number | null)[] = Array(9).fill(null);
    const leds = new Map<number, LedState>();
    const rings: UnitState["rings"] = [];
    const meters: number[] = [];
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = i < spec.strips ? this.#strip(unit, i) : undefined;
      const touched = this.#touch.get(this.#key(unit, i)) === true;
      let held = c ? this.#held.get(c.id) : undefined;
      if (c && held && now - held.at > this.#o.holdMs && !this.#pending.has(c.id)) {
        this.#held.delete(c.id);
        held = undefined;
      }
      const gain = held?.db ?? c?.gainDb ?? null;
      if (c && gain !== null && !touched) {
        faders[i] = dbToFader(gain);
      } else if (!c && i < spec.strips) {
        faders[i] = 0; // Zug ohne Kanal: Fader unten
      }
      leds.set(NOTE.mute + i, c?.mute ? "on" : "off");
      leds.set(NOTE.solo + i, c?.pfl ? "on" : "off");
      leds.set(NOTE.select + i, c && c.id === this.selected ? "on" : "off");
      leds.set(NOTE.rec + i, c?.onAir ? "on" : "off");
      const pan = c?.pan;
      rings.push(pan === null || pan === undefined ? { mode: "dot", value: 0, led: false } : { mode: "dot", value: 1 + Math.round(((pan + 1) / 2) * 10), led: pan === 0 });
      meters.push(c && !c.mute ? meterStep(c.level) : 0);
      top.push(c ? c.label : "");
      bottom.push(c ? (this.lcdMode === "gain" ? fmtDb(gain) : fmtPan(c.pan)) : "");
    }
    if (spec.hasMaster) {
      if (this.#heldMaster && now - this.#heldMaster.at > this.#o.holdMs && this.#masterPending === null) this.#heldMaster = null;
      const m = this.#heldMaster?.db ?? this.#master?.db ?? null;
      faders[8] = this.mixer.setMaster && m !== null && this.#touch.get(this.#key(unit, 8)) !== true ? dbToFader(m) : null;
    }
    const n = String(Math.floor(this.bank / Math.max(1, this.totalStrips)) + 1).padStart(2, "0").slice(-2);
    return { faders, leds, rings, meters, lcdTop: top, lcdBottom: bottom, sevenSeg: n + "          " };
  }

  /** Die Einheit hat Fader `strip` selbst bewegt (Echo-Sperre). */
  noteHostMove(unit: number, strip: number, now: number) {
    this.#lastHostMove.set(this.#key(unit, strip), now);
  }

  isTouched(unit: number, strip: number): boolean {
    return this.#touch.get(this.#key(unit, strip)) === true;
  }
}

export function fmtDb(db: number | null): string {
  if (db === null) return "";
  if (db <= -59.95) return "-inf";
  return (db > 0 ? "+" : "") + db.toFixed(1);
}

export function fmtPan(pan: number | null): string {
  if (pan === null) return "";
  if (Math.abs(pan) < 0.005) return "C";
  const v = Math.round(Math.abs(pan) * 100);
  return (pan < 0 ? "L" : "R") + v;
}

export { FADER_MAX };
