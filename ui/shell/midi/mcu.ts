// Mackie-Control-Codec (Kap. 93). Reine Funktionen ohne Ein-/Ausgabe: Byte-Strom → Ereignisse (Pult → Rechner)
// und Rechner → Pult-Nachrichten. Quelle und Prüfstatus: docs/CONTRACT-MIDI.md §2 (nachgebaut aus dem Emagic-Logic-Control-
// Protokoll, gegen ein Mackie Control Universal Pro Firmware 3.0.0 geprüft — von Dritten; OMP hat kein Originalgerät).
// Das Rust-Gegenstück (nodes/omp-midi-gateway/src/mcu.rs) wird gegen dieselben Prüfwerte getestet (docs/midi/golden.json).

/** Geräte-ID im SysEx-Kopf: Mackie Control (Universal) (Pro). Erweiterung (XT): 0x15. */
export const DEVICE_ID_MCU = 0x14;
export const DEVICE_ID_MCU_XT = 0x15;
export const SYSEX_HEADER = [0x00, 0x00, 0x66] as const;

/** Tasten (Noten, Kanal 0). Je Kanalzug sind es 8 aufeinanderfolgende Noten. */
export const NOTE = {
  rec: 0, // 0..7
  solo: 8, // 8..15
  mute: 16, // 16..23
  select: 24, // 24..31
  vpotPush: 32, // 32..39
  faderTouch: 104, // 104..111, Master 112
  masterTouch: 112,
} as const;

/** Funktionstasten nach Name → Note. */
export const BUTTON: Record<string, number> = {
  assignTrack: 40, assignSend: 41, assignPan: 42, assignPlugin: 43, assignEq: 44, assignInstrument: 45,
  bankLeft: 46, bankRight: 47, channelLeft: 48, channelRight: 49, flip: 50, global: 51,
  nameValue: 52, smpteBeats: 53,
  f1: 54, f2: 55, f3: 56, f4: 57, f5: 58, f6: 59, f7: 60, f8: 61,
  midiTracks: 62, inputs: 63, audioTracks: 64, audioInstruments: 65, aux: 66, busses: 67, outputs: 68, user: 69,
  shift: 70, option: 71, control: 72, alt: 73,
  readOff: 74, write: 75, trim: 76, touch: 77, latch: 78, group: 79,
  save: 80, undo: 81, cancel: 82, enter: 83,
  markers: 84, nudge: 85, cycle: 86, drop: 87, replace: 88, click: 89, soloGlobal: 90,
  rewind: 91, forward: 92, stop: 93, play: 94, record: 95,
  up: 96, down: 97, left: 98, right: 99, zoom: 100, scrub: 101,
  userSwitch1: 102, userSwitch2: 103,
};
const BUTTON_BY_NOTE = new Map(Object.entries(BUTTON).map(([k, v]) => [v, k]));

/** LED-Noten ohne Taste: SMPTE, BEATS, Rude Solo. */
export const LED_NOTE = { smpte: 113, beats: 114, rudeSolo: 115 } as const;

export type LedState = "off" | "blink" | "on";

/** Name einer Note: `rec3`, `solo1`, `mute8`, `select2`, `vpotPush5`, `touch9` oder der Funktionstastenname. */
export function noteName(note: number): string | null {
  const groups: [string, number][] = [["rec", NOTE.rec], ["solo", NOTE.solo], ["mute", NOTE.mute], ["select", NOTE.select], ["vpotPush", NOTE.vpotPush]];
  for (const [n, base] of groups) if (note >= base && note < base + 8) return `${n}${note - base + 1}`;
  if (note >= NOTE.faderTouch && note <= NOTE.masterTouch) return `touch${note - NOTE.faderTouch + 1}`;
  // Noten ohne Namen im Protokoll (z. B. frei belegbare Pads, „Navi“, „Focus“): `note<N>`, damit sie sich beobachten und belegen lassen
  return BUTTON_BY_NOTE.get(note) ?? (note >= 0 && note <= 127 ? `note${note}` : null);
}

/** Umkehrung von `noteName` (für Konfigurationen). */
export function noteByName(name: string): number | null {
  const m = /^(rec|solo|mute|select|vpotPush|touch)([1-9])$/.exec(name);
  if (m) {
    const i = Number(m[2]) - 1;
    if (m[1] === "touch") return i <= 8 ? NOTE.faderTouch + i : null;
    return i <= 7 ? NOTE[m[1] as "rec" | "solo" | "mute" | "select" | "vpotPush"] + i : null;
  }
  const m2 = /^note(\d{1,3})$/.exec(name);
  if (m2 && Number(m2[1]) <= 127) return Number(m2[1]);
  return BUTTON[name] ?? null;
}

// ───────── Strom-Parser ─────────

/** Setzt einen MIDI-Byte-Strom (USB-MIDI, ALSA-Rohgerät, RTP-MIDI-Liste) in ganze Nachrichten um (Laufstatus, SysEx über Blöcke). */
export class MidiParser {
  #status = 0;
  #data: number[] = [];
  #need = 0;
  #sysex: number[] | null = null;

  /** Bytes einspeisen; liefert die fertigen Nachrichten (Echtzeitbytes 0xF8+ werden verworfen). */
  push(bytes: ArrayLike<number>): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xff;
      if (b >= 0xf8) continue;
      if (b === 0xf0) {
        this.#sysex = [0xf0];
        this.#status = 0;
        continue;
      }
      if (b === 0xf7) {
        if (this.#sysex) {
          this.#sysex.push(0xf7);
          out.push(this.#sysex);
        }
        this.#sysex = null;
        continue;
      }
      if (b & 0x80) {
        this.#sysex = null; // jedes andere Statusbyte bricht ein SysEx ab
        if (b >= 0xf1) {
          this.#status = 0; // System Common: kein Laufstatus
          continue;
        }
        this.#status = b;
        this.#data = [];
        this.#need = (b & 0xf0) === 0xc0 || (b & 0xf0) === 0xd0 ? 1 : 2;
        continue;
      }
      if (this.#sysex) {
        this.#sysex.push(b);
        continue;
      }
      if (!this.#status) continue;
      this.#data.push(b);
      if (this.#data.length === this.#need) {
        out.push([this.#status, ...this.#data]);
        this.#data = [];
      }
    }
    return out;
  }
}

// ───────── Pult → Rechner ─────────

export type McuEvent =
  | { t: "button"; note: number; name: string | null; down: boolean }
  | { t: "touch"; strip: number; down: boolean }
  | { t: "fader"; strip: number; value: number } // 0…16383
  | { t: "vpot"; strip: number; delta: number }
  | { t: "jog"; delta: number }
  | { t: "external"; value: number }
  | { t: "sysex"; deviceId: number; cmd: number; data: number[] }
  | { t: "other"; bytes: number[] };

/** Vorzeichen-Betrag-Wert eines Drehgebers: Bit 6 = Gegenuhrzeigersinn, Bits 0–5 = Schritte. */
export function decodeRelative(v: number): number {
  const mag = v & 0x3f;
  return v & 0x40 ? -mag : mag;
}

/** Eine fertige Nachricht (Pult → Rechner) deuten. */
export function decodeFromSurface(msg: number[]): McuEvent {
  const st = msg[0] & 0xf0;
  const ch = msg[0] & 0x0f;
  if (msg[0] === 0xf0) {
    // F0 00 00 66 dd cmd data… F7
    if (msg.length >= 7 && msg[1] === 0 && msg[2] === 0 && msg[3] === 0x66) {
      return { t: "sysex", deviceId: msg[4], cmd: msg[5], data: msg.slice(6, msg.length - 1) };
    }
    return { t: "other", bytes: msg };
  }
  // Tasten, Drehgeber und Jog gelten nur auf MIDI-Kanal 1 (Mackie-Protokoll); alles andere (frei belegte Pads, Regler) bleibt `other`
  if ((st === 0x90 || st === 0x80) && ch === 0) {
    const note = msg[1];
    const down = st === 0x90 && msg[2] > 0;
    if (note >= NOTE.faderTouch && note <= NOTE.masterTouch) return { t: "touch", strip: note - NOTE.faderTouch, down };
    return { t: "button", note, name: noteName(note), down };
  }
  if (st === 0xe0 && ch <= 8) return { t: "fader", strip: ch, value: (msg[2] << 7) | msg[1] };
  if (st === 0xb0 && ch === 0) {
    const cc = msg[1];
    if (cc >= 0x10 && cc <= 0x17) return { t: "vpot", strip: cc - 0x10, delta: decodeRelative(msg[2]) };
    if (cc === 0x3c) return { t: "jog", delta: decodeRelative(msg[2]) };
    if (cc === 0x2e) return { t: "external", value: msg[2] };
  }
  return { t: "other", bytes: msg };
}

// ───────── Rechner → Pult ─────────

export const ledNote = (note: number, state: LedState): number[] => [0x90, note, state === "on" ? 0x7f : state === "blink" ? 0x01 : 0x00];

/** Fahrfader auf Stellung 0…16383 (Kanalzug 0…7, Master 8). */
export const faderMove = (strip: number, value: number): number[] => {
  const v = Math.max(0, Math.min(16383, Math.round(value)));
  return [0xe0 | strip, v & 0x7f, v >> 7];
};

export type RingMode = "dot" | "boost" | "wrap" | "spread";
const RING_MODE: Record<RingMode, number> = { dot: 0, boost: 1, wrap: 2, spread: 3 };

/** LED-Kranz um den Drehgeber: `value` 0…11, `led` = die kleine LED unter dem Geber. */
export const vpotRing = (strip: number, mode: RingMode, value: number, led = false): number[] => [
  0xb0,
  0x30 + strip,
  (led ? 0x40 : 0) | (RING_MODE[mode] << 4) | (Math.max(0, Math.min(11, Math.round(value))) & 0x0f),
];

/** Pegelanzeige (Kanaldruck): Kanalzug 0…7, Stufe 0…12 (0xE/0xF: Übersteuerung setzen/löschen). */
export const meterLevel = (strip: number, level: number): number[] => [0xd0, ((strip & 7) << 4) | (Math.max(0, Math.min(15, Math.round(level))) & 0x0f)];

/** Pegel 0…1 (Messskala des Audiomischers) → Stufe 0…12. */
export const meterStep = (level01: number): number => (level01 <= 0.005 ? 0 : Math.max(1, Math.min(12, Math.round(level01 * 12))));

const sysex = (deviceId: number, cmd: number, data: number[] = []): number[] => [0xf0, ...SYSEX_HEADER, deviceId, cmd, ...data, 0xf7];

export const deviceQuery = (id = DEVICE_ID_MCU): number[] => sysex(id, 0x00);
export const versionRequest = (id = DEVICE_ID_MCU): number[] => sysex(id, 0x13, [0x00]);
export const reset = (id = DEVICE_ID_MCU): number[] => sysex(id, 0x63);
export const goOffline = (id = DEVICE_ID_MCU): number[] => sysex(id, 0x0f, [0x7f]);
export const faderTouchSensitivity = (strip: number, level: number, id = DEVICE_ID_MCU): number[] => sysex(id, 0x0e, [strip, level]);
export const channelMeterMode = (strip: number, bits: { level?: boolean; peak?: boolean; signal?: boolean }, id = DEVICE_ID_MCU): number[] =>
  sysex(id, 0x20, [strip, (bits.level ? 4 : 0) | (bits.peak ? 2 : 0) | (bits.signal ? 1 : 0)]);

/** Antwortcode auf die Anmeldeaufforderung des Pults (Algorithmus nach docs/CONTRACT-MIDI.md §2.4). */
export function connectionResponse(c: number[]): number[] {
  const [c0, c1, c2, c3] = c;
  return [
    0x7f & (c0 + (c1 ^ 0x0a) - c3),
    0x7f & ((c2 >> 4) ^ (c0 + c3)),
    0x7f & ((c3 - (c2 << 2)) ^ (c0 | c1)),
    0x7f & (c1 - c2 + (0xf0 ^ (c3 << 4))),
  ];
}

/** Antwort auf `Host Connection Query` (cmd 0x01: 7 Byte Seriennummer + 4 Byte Aufgabe). */
export function hostConnectionReply(query: McuEvent & { t: "sysex" }): number[] | null {
  if (query.cmd !== 0x01 || query.data.length < 11) return null;
  const serial = query.data.slice(0, 7);
  return sysex(query.deviceId, 0x02, [...serial, ...connectionResponse(query.data.slice(7, 11))]);
}

const SPECIAL: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss", "°": "o", "–": "-", "—": "-" };

/** Text für das Pult-Display: nur druckbares ASCII (Umlaute werden umschrieben). */
export function lcdAscii(s: string): string {
  let r = "";
  for (const ch of s) {
    const c = SPECIAL[ch] ?? ch;
    for (const x of c) r += x.charCodeAt(0) >= 0x20 && x.charCodeAt(0) <= 0x7e ? x : "?";
  }
  return r;
}

/** Eine Zelle: genau `width` Zeichen, links bündig, abgeschnitten. */
export const lcdCell = (s: string, width = 6): string => lcdAscii(s).slice(0, width).padEnd(width, " ");

/** LCD-Zeile schreiben (Zeile 0/1, ab Spalte `col`). Offsets: oben 0x00…0x37, unten 0x38…0x6F. */
export function lcdWrite(line: 0 | 1, col: number, text: string, id = DEVICE_ID_MCU): number[] {
  const t = lcdAscii(text);
  const off = (line === 0 ? 0x00 : 0x38) + col;
  const room = (line === 0 ? 0x38 : 0x70) - off;
  return sysex(id, 0x12, [off, ...[...t.slice(0, Math.max(0, room))].map((c) => c.charCodeAt(0))]);
}

/** Beide Zeilen aus je 8 Zellen (7 Spalten je Kanalzug: 6 Zeichen + Lücke) als zwei Nachrichten. */
export function lcdCells(top: string[], bottom: string[], id = DEVICE_ID_MCU): number[][] {
  const row = (c: string[]) => Array.from({ length: 8 }, (_, i) => lcdCell(c[i] ?? "") + " ").join("");
  return [lcdWrite(0, 0, row(top), id), lcdWrite(1, 0, row(bottom), id)];
}

/** Zeichencode der 7-Segment-Anzeigen (Kontrollwert): Zeichen 0x20…0x5F (Bit 6 des Zeichens entfällt), Bit 6 des Werts = Punkt. */
export function sevenSegCc(ch: string, dot = false): number {
  let c = ch.toUpperCase().charCodeAt(0);
  if (!(c >= 0x20 && c <= 0x5f)) c = 0x20;
  return (dot ? 0x40 : 0) | (c & 0x3f);
}

/** Zeitcode/Zuweisungsanzeige: `text` rechtsbündig auf 12 Stellen (Stelle 1 = ganz rechts = CC 0x40); `.` setzt den Punkt der davor stehenden Stelle. */
export function sevenSegText(text: string): number[][] {
  const digits: { ch: string; dot: boolean }[] = [];
  for (const ch of text) {
    if (ch === "." && digits.length) digits[digits.length - 1].dot = true;
    else digits.push({ ch, dot: false });
  }
  const d = digits.slice(-12);
  while (d.length < 12) d.unshift({ ch: " ", dot: false });
  return d.reverse().map((x, i) => [0xb0, 0x40 + i, sevenSegCc(x.ch, x.dot)]);
}
