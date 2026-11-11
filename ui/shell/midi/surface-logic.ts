// Pult-Logik (Kap. 93): verbindet ein oder mehrere Mackie-Control-Einheiten (Hauptpult + Erweiterungen) mit einem Audiomischer.
// Reine Logik: Ereignisse und Modell hinein, Mischer-Befehle und Soll-Zustand je Einheit heraus. Keine Ein-/Ausgabe, keine Zeit
// außer der übergebenen — deshalb ohne Gerät testbar. Das Rust-Gegenstück liegt in nodes/omp-midi-gateway/src/surface.rs.

import { dbToFader, faderToDb, FADER_MAX } from "./fader-law.ts";
import { fillTemplate, getPath, type InternalAction, type JogMode, type KeyBinding, type KeysConfig, ledPath, PAGE_KEYS, resolveKeys, type ResolvedKeys, setPath, usesChannel } from "./keys.ts";
import { BUTTON, type LedState, type McuEvent, meterStep, noteByName, noteName, NOTE, type RingMode } from "./mcu.ts";

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
  /** Der ganze Mischer-Eintrag des Kanals (für Tasten-LEDs und `{ch}`-Belegungen). */
  raw?: Record<string, unknown>;
}

export interface NudgeAction {
  node: string;
  method: string;
  args: Record<string, unknown>;
  arg: string;
  delta: number;
  min?: number;
  max?: number;
  readParam: string;
}

/** Befehle an den Mischer (die Anbindung ruft `channel.<id>.setGain` usw.). */
export interface MixerActions {
  setGain(id: string, db: number): void;
  setMute(id: string, muted: boolean): void;
  setPfl(id: string, enabled: boolean): void;
  setPan(id: string, pan: number): void;
  /** Master-Fader (nur wenn die Anbindung ein Ziel kennt). */
  setMaster?(db: number): void;
  /** Beliebiger Methodenaufruf (Tastenbelegung); `node` leer = der Audiomischer. */
  call?(node: string, method: string, args: Record<string, unknown>): void;
  /** Lesen-Ändern-Schreiben (Jog-Rad auf einem fremden Parameter). */
  nudge?(a: NudgeAction): void;
}

export interface UnitState {
  /** Fader 0…8 (8 = Master): 14-Bit-Sollwert, `null` = nicht bewegen. */
  faders: (number | null)[];
  leds: Map<number, LedState>;
  rings: { mode: RingMode; value: number; led: boolean }[];
  meters: number[];
  lcdTop: string[];
  lcdBottom: string[];
  /** Kurzmeldung (Tastenname, Seite, Jog-Modus): ersetzt kurz die untere Anzeigezeile des Hauptpults. */
  message: string | null;
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
  /** Tastenbelegung (Seiten, feste Tasten, Jog); ohne Angabe die Standardbelegung. */
  keys?: KeysConfig | null;
}

const LED_RUDE = 115; // „Rude Solo“-Lampe: blinkt, solange irgendein Kanal im Vorhören steht

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
  #keys: ResolvedKeys;
  page = 0;
  jogMode = 0;
  shift = false;
  #message: { text: string; until: number } | null = null;
  #local = new Map<string, boolean>(); // Zustand von Umschaltern ohne Mischer-Pfad
  #pressed = new Set<string>(); // gehaltene „momentary“-Tasten
  /** Tasten, die niemand belegt hat (Transport usw.) — für Ereignisse nach außen. */
  unbound: { name: string; down: boolean }[] = [];

  constructor(private mixer: MixerActions, opts: LogicOptions) {
    this.#o = { gainIntervalMs: 50, echoGuardMs: 300, panStep: 0.05, holdMs: 2000, keys: null, ...opts };
    this.#keys = resolveKeys(this.#o.keys);
  }

  setKeys(k: KeysConfig | null) {
    this.#keys = resolveKeys(k);
    this.page = Math.min(this.page, this.#keys.pages.length - 1);
    this.jogMode = 0;
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
        this.#button(unit, ev.note, ev.down, now);
        break;
      case "jog":
        this.#jog(ev.delta, now);
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

  /** Eine Taste (gedrückt/losgelassen): erst Kanalzug-Tasten, dann Belegung, dann Standard, sonst unbelegt. */
  #button(unit: number, note: number, down: boolean, now: number) {
    const name = noteName(note);
    if (name === "shift") this.shift = down;
    if (name && this.#pressed.has(name) && !down) return this.#releaseMomentary(name);
    if (!down) {
      if (name && !this.#consumed(note) && !this.#binding(name)) this.unbound.push({ name, down: false });
      return;
    }
    if (this.#press(unit, note)) return;
    if (!name) return;
    const pageIdx = (PAGE_KEYS as readonly string[]).indexOf(name);
    if (pageIdx >= 0) {
      if (pageIdx < this.#keys.pages.length) {
        this.page = pageIdx;
        this.#say(`Page ${pageIdx + 1} ${this.#keys.pages[pageIdx].name}`, now);
      } else this.#say(`No page ${pageIdx + 1}`, now);
      return;
    }
    const b = this.#binding(name);
    if (b) this.#run(name, b, now);
    else this.unbound.push({ name, down: true });
  }

  #consumed(note: number): boolean {
    const n = noteName(note) ?? "";
    return /^(rec|solo|mute|select|vpotPush)\d$/.test(n) || ["bankLeft", "bankRight", "channelLeft", "channelRight", "nameValue", "shift"].includes(n) || (PAGE_KEYS as readonly string[]).includes(n);
  }

  #binding(name: string): KeyBinding | undefined {
    return this.#keys.pages[this.page]?.keys[name] ?? this.#keys.global[name];
  }

  #selectedChannel(): StripInfo | undefined {
    return this.selected ? this.#channels.find((c) => c.id === this.selected) : undefined;
  }

  #say(text: string, now: number) {
    this.#message = { text, until: now + 1500 };
  }

  #run(name: string, b: KeyBinding, now: number) {
    if (b.label) this.#say(`${name.toUpperCase()} ${b.label}`, now);
    if (b.action === "internal") return this.#internal(b.internal!, now);
    const sel = this.#selectedChannel();
    if (usesChannel(b) && !sel) return this.#say("No channel selected", now);
    const fill = <T,>(v: T): T => (sel ? fillTemplate(v, sel.id) : v);
    const method = fill(b.method ?? "");
    const args = fill({ ...(b.args ?? {}) });
    const send = (a: Record<string, unknown>) => this.mixer.call?.(b.node ?? "", method, a);
    if (b.action === "call") return send(args);
    if (b.action === "momentary") {
      this.#pressed.add(name);
      this.#local.set(`${this.page}:${name}`, true);
      return send({ ...args, [b.arg!]: b.onValue ?? true });
    }
    // toggle: aktueller Zustand aus dem Mischer-Eintrag (LED-Pfad) oder lokal gemerkt
    const lp = ledPath(b);
    const key = `${this.page}:${name}`;
    let cur = false;
    if (lp && sel?.raw) cur = this.#ledValue(sel, lp) === true;
    else cur = this.#local.get(key) ?? false;
    const next = !cur;
    this.#local.set(key, next);
    if (lp && sel?.raw && !lp.equals) setPath(sel.raw, lp.path, next); // sofort sichtbar, der Mischer bestätigt beim nächsten Abruf
    send({ ...args, [b.arg!]: next ? b.onValue ?? true : b.offValue ?? false });
  }

  #releaseMomentary(name: string) {
    this.#pressed.delete(name);
    const b = this.#binding(name);
    this.#local.set(`${this.page}:${name}`, false);
    if (!b || b.action !== "momentary") return;
    const sel = this.#selectedChannel();
    if (usesChannel(b) && !sel) return;
    const fill = <T,>(v: T): T => (sel ? fillTemplate(v, sel.id) : v);
    this.mixer.call?.(b.node ?? "", fill(b.method ?? ""), { ...fill({ ...(b.args ?? {}) }), [b.arg!]: b.offValue ?? false });
  }

  #ledValue(c: StripInfo, lp: { path: string; equals?: unknown }): boolean {
    const v = getPath(c.raw, lp.path);
    return lp.equals !== undefined ? v === lp.equals : v === true;
  }

  #internal(a: InternalAction, now: number) {
    const sel = this.#selectedChannel();
    switch (a) {
      case "clearPfl":
        for (const c of this.#channels) if (c.pfl) {
          c.pfl = false;
          if (c.raw) c.raw.pfl = false;
          this.mixer.setPfl(c.id, false);
        }
        break;
      case "clearMute":
        for (const c of this.#channels) if (c.mute) {
          c.mute = false;
          if (c.raw) c.raw.mute = false;
          this.mixer.setMute(c.id, false);
        }
        break;
      case "selectPrev":
      case "selectNext": {
        if (!this.#channels.length) break;
        const i = sel ? this.#channels.indexOf(sel) : -1;
        const n = a === "selectNext" ? Math.min(this.#channels.length - 1, i + 1) : Math.max(0, (i < 0 ? this.#channels.length : i) - 1);
        this.#selectIndex(n);
        break;
      }
      case "gainUp":
      case "gainDown":
        if (sel) this.#gainBy(sel, a === "gainUp" ? 1 : -1, now);
        break;
      case "deselect":
        this.selected = null;
        break;
      case "jogMode":
        this.jogMode = (this.jogMode + 1) % this.#keys.jog.length;
        this.#say(`Jog: ${this.#keys.jog[this.jogMode].name ?? this.#keys.jog[this.jogMode].kind}`, now);
        break;
    }
  }

  /** Kanal wählen und die Bank so schieben, dass er sichtbar ist. */
  #selectIndex(i: number) {
    const c = this.#channels[i];
    if (!c) return;
    this.selected = c.id;
    const total = this.totalStrips;
    if (i < this.bank) this.bank = this.#clampBank(i);
    else if (i >= this.bank + total) this.bank = this.#clampBank(i - total + 1);
  }

  #gainBy(c: StripInfo, db: number, now: number) {
    const cur = this.#held.get(c.id)?.db ?? c.gainDb;
    if (cur === null || cur === undefined) return;
    const next = Math.round(Math.max(-60, Math.min(12, cur + db)) * 10) / 10;
    this.#held.set(c.id, { db: next, at: now });
    this.#pending.set(c.id, next);
    this.flush(now);
  }

  #jog(delta: number, now: number) {
    const m: JogMode = this.#keys.jog[this.jogMode] ?? this.#keys.jog[0];
    const fine = this.shift ? 10 : 1;
    if (m.kind === "gain") {
      const sel = this.#selectedChannel();
      if (sel) this.#gainBy(sel, delta * 0.5 * fine, now);
    } else if (m.kind === "select") {
      const sel = this.#selectedChannel();
      const i = sel ? this.#channels.indexOf(sel) : delta > 0 ? -1 : this.#channels.length;
      this.#selectIndex(Math.max(0, Math.min(this.#channels.length - 1, i + Math.sign(delta))));
    } else {
      const sel = this.#selectedChannel();
      const needs = JSON.stringify([m.method, m.args, m.arg, m.readParam]).includes("{ch}");
      if (needs && !sel) return;
      const fill = <T,>(v: T): T => (sel ? fillTemplate(v, sel.id) : v);
      this.mixer.nudge?.({ node: m.node ?? "", method: fill(m.method), args: fill({ ...(m.args ?? {}) }), arg: m.arg, delta: delta * (m.step ?? 1) * fine, min: m.min, max: m.max, readParam: fill(m.readParam) });
    }
  }

  /** `true`, wenn die Taste hier verbraucht wurde (Kanalzug-Tasten, Bank, Anzeige). */
  #press(unit: number, note: number): boolean {
    const within = (base: number) => (note >= base && note < base + 8 ? note - base : -1);
    let i = within(NOTE.mute);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) {
        c.mute = !c.mute;
        if (c.raw) c.raw.mute = c.mute;
        this.mixer.setMute(c.id, c.mute);
      }
      return true;
    }
    i = within(NOTE.solo);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) {
        c.pfl = !c.pfl;
        if (c.raw) c.raw.pfl = c.pfl;
        this.mixer.setPfl(c.id, c.pfl);
      }
      return true;
    }
    i = within(NOTE.select);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c) this.selected = c.id;
      return true;
    }
    i = within(NOTE.vpotPush);
    if (i >= 0) {
      const c = this.#strip(unit, i);
      if (c && c.pan !== null) {
        c.pan = 0;
        this.mixer.setPan(c.id, 0);
      }
      return true;
    }
    if (within(NOTE.rec) >= 0) return true; // Rec-LED zeigt On-Air, die Taste selbst tut nichts
    const step = this.totalStrips;
    switch (note) {
      case BUTTON.bankLeft:
        this.bank = this.#clampBank(this.bank - step);
        return true;
      case BUTTON.bankRight:
        this.bank = this.#clampBank(this.bank + step);
        return true;
      case BUTTON.channelLeft:
        this.bank = this.#clampBank(this.bank - 1);
        return true;
      case BUTTON.channelRight:
        this.bank = this.#clampBank(this.bank + 1);
        return true;
      case BUTTON.nameValue:
        this.lcdMode = this.lcdMode === "gain" ? "pan" : "gain";
        return true;
      case BUTTON.shift:
        return true;
      default:
        return false;
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
    if (unit === 0) this.#keyLeds(leds);
    const message = unit === 0 && this.#message && now < this.#message.until ? this.#message.text : null;
    const n = String(Math.floor(this.bank / Math.max(1, this.totalStrips)) + 1).padStart(2, "0").slice(-2);
    return { faders, leds, rings, meters, lcdTop: top, lcdBottom: bottom, message, sevenSeg: n + "          " };
  }

  /** LEDs der belegten Tasten (nur Hauptpult): Zustand des gewählten Kanals bzw. der Taste selbst. */
  #keyLeds(leds: Map<number, LedState>) {
    const sel = this.#selectedChannel();
    const names = new Set([...Object.keys(this.#keys.global), ...Object.keys(this.#keys.pages[this.page]?.keys ?? {})]);
    for (const name of names) {
      const note = noteByName(name);
      const b = this.#binding(name);
      if (note === null || !b) continue;
      let on = false;
      if (b.action === "internal") {
        on = b.internal === "clearPfl" ? this.#channels.some((c) => c.pfl) : b.internal === "clearMute" ? this.#channels.some((c) => c.mute) : b.internal === "jogMode" ? this.jogMode > 0 : false;
      } else if (b.action === "momentary") on = this.#pressed.has(name);
      else if (b.action === "toggle") {
        const lp = ledPath(b);
        on = lp ? (sel ? this.#ledValue(sel, lp) : false) : this.#local.get(`${this.page}:${name}`) === true;
      }
      leds.set(note, on ? "on" : "off");
    }
    PAGE_KEYS.forEach((k, i) => {
      if (i < this.#keys.pages.length) leds.set(BUTTON[k], i === this.page ? "on" : "off");
    });
    leds.set(LED_RUDE, this.#channels.some((c) => c.pfl) ? "blink" : "off");
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
