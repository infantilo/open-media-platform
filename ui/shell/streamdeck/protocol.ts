// Reines Protokoll (Kap. 40.2): Chunking der Ausgabe, Dekodierung der
// Eingabe, Gegenstück (Assembler) für den Simulator. Kein DOM, kein HID.
// Alle Puffer OHNE Report-ID (WebHID-Konvention, s. ENTWURF §1).

import { type DeckModel, keyCount } from "./models.ts";

export const OUTPUT_LEN = 1023; // 1024 − Report-ID
const KEY_HEADER = 7; // cmd, taste, last, len16, chunk16
const STRIP_HEADER = 15; // cmd, x16,y16,w16,h16, last, chunk16, len16, reserviert

export const CMD_KEY_IMAGE = 0x07;
export const CMD_STRIP_PARTIAL = 0x0c;

function u16(buf: Uint8Array, off: number, v: number) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function chunked(
  data: Uint8Array,
  header: number,
  fill: (buf: Uint8Array, last: boolean, chunk: number, len: number) => void,
): Uint8Array[] {
  const payload = OUTPUT_LEN - header;
  const out: Uint8Array[] = [];
  let off = 0;
  do {
    const part = data.subarray(off, off + payload);
    off += part.length;
    const buf = new Uint8Array(OUTPUT_LEN);
    fill(buf, off >= data.length, out.length, part.length);
    buf.set(part, header);
    out.push(buf);
  } while (off < data.length);
  return out;
}

/** JPEG eines Tastenbilds → Output-Reports (Kommando 0x07). */
export function keyImageReports(key: number, jpeg: Uint8Array): Uint8Array[] {
  return chunked(jpeg, KEY_HEADER, (b, last, chunk, len) => {
    b[0] = CMD_KEY_IMAGE;
    b[1] = key;
    b[2] = last ? 1 : 0;
    u16(b, 3, len);
    u16(b, 5, chunk);
  });
}

/** JPEG-Ausschnitt des Touch-Streifens (Kommando 0x0C), logische Koordinaten. */
export function stripImageReports(
  x: number,
  y: number,
  w: number,
  h: number,
  jpeg: Uint8Array,
): Uint8Array[] {
  return chunked(jpeg, STRIP_HEADER, (b, last, chunk, len) => {
    b[0] = CMD_STRIP_PARTIAL;
    u16(b, 1, x);
    u16(b, 3, y);
    u16(b, 5, w);
    u16(b, 7, h);
    b[9] = last ? 1 : 0;
    u16(b, 10, chunk);
    u16(b, 12, len);
  });
}

/** Feature-Report 3: Helligkeit 0–100 (Daten ohne Report-ID). */
export function brightnessFeature(pct: number): Uint8Array {
  const b = new Uint8Array(31);
  b[0] = 0x08;
  b[1] = Math.max(0, Math.min(100, Math.round(pct)));
  return b;
}

/** Feature-Report 3: Logo zeigen (vor dem Schließen). */
export function showLogoFeature(): Uint8Array {
  const b = new Uint8Array(31);
  b[0] = 0x02;
  return b;
}

// ── Eingabe ─────────────────────────────────────────────────────────────────

export type DeckEvent =
  | { kind: "key"; index: number; down: boolean }
  | { kind: "dialTurn"; index: number; delta: number }
  | { kind: "dialPress"; index: number; down: boolean }
  | { kind: "touch"; type: "tap" | "press"; x: number; y: number }
  | { kind: "flick"; x: number; y: number; x2: number; y2: number };

const rd16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const i8 = (v: number) => (v > 127 ? v - 256 : v);

/** Zustandsbehaftet: Tasten/Dial-Drücke kommen als Zustand, Ereignisse als Flanke. */
export class InputDecoder {
  #keys: boolean[];
  #dials: boolean[];
  constructor(readonly model: DeckModel) {
    this.#keys = Array(keyCount(model)).fill(false);
    this.#dials = Array(model.dials).fill(false);
  }

  decode(d: Uint8Array): DeckEvent[] {
    const ev: DeckEvent[] = [];
    const cmd = d[0];
    if (cmd === 0x00) {
      for (let i = 0; i < this.#keys.length; i++) {
        const down = d[3 + i] === 1;
        if (down !== this.#keys[i]) {
          this.#keys[i] = down;
          ev.push({ kind: "key", index: i, down });
        }
      }
    } else if (cmd === 0x03 && this.model.dials > 0) {
      const type = d[3];
      for (let i = 0; i < this.model.dials; i++) {
        if (type === 0x01) {
          const delta = i8(d[4 + i]);
          if (delta !== 0) ev.push({ kind: "dialTurn", index: i, delta });
        } else if (type === 0x00) {
          const down = d[4 + i] === 1;
          if (down !== this.#dials[i]) {
            this.#dials[i] = down;
            ev.push({ kind: "dialPress", index: i, down });
          }
        }
      }
    } else if (cmd === 0x02 && this.model.strip) {
      const type = d[3];
      if (type === 1 || type === 2) {
        ev.push({ kind: "touch", type: type === 1 ? "tap" : "press", x: rd16(d, 5), y: rd16(d, 7) });
      } else if (type === 3) {
        ev.push({ kind: "flick", x: rd16(d, 5), y: rd16(d, 7), x2: rd16(d, 9), y2: rd16(d, 11) });
      }
    }
    return ev;
  }
}

/** Baut einen Eingabe-Puffer (Gegenstück für Simulator/Tests). */
export function encodeKeyState(m: DeckModel, down: ReadonlySet<number>): Uint8Array {
  const n = keyCount(m);
  const d = new Uint8Array(3 + n);
  d[0] = 0x00;
  u16(d, 1, n);
  for (const i of down) d[3 + i] = 1;
  return d;
}
export function encodeDialTurn(m: DeckModel, index: number, delta: number): Uint8Array {
  const d = new Uint8Array(4 + m.dials);
  d[0] = 0x03;
  u16(d, 1, m.dials + 1);
  d[3] = 0x01;
  d[4 + index] = delta & 0xff;
  return d;
}
export function encodeDialPress(m: DeckModel, down: ReadonlySet<number>): Uint8Array {
  const d = new Uint8Array(4 + m.dials);
  d[0] = 0x03;
  u16(d, 1, m.dials + 1);
  d[3] = 0x00;
  for (const i of down) d[4 + i] = 1;
  return d;
}
export function encodeTap(type: "tap" | "press", x: number, y: number): Uint8Array {
  const d = new Uint8Array(9);
  d[0] = 0x02;
  u16(d, 1, 0x0a);
  d[3] = type === "tap" ? 1 : 2;
  u16(d, 5, x);
  u16(d, 7, y);
  return d;
}
export function encodeFlick(x: number, y: number, x2: number, y2: number): Uint8Array {
  const d = new Uint8Array(13);
  d[0] = 0x02;
  u16(d, 1, 0x0e);
  d[3] = 3;
  u16(d, 5, x);
  u16(d, 7, y);
  u16(d, 9, x2);
  u16(d, 11, y2);
  return d;
}

// ── Gegenstück zur Ausgabe (Simulator/Tests) ────────────────────────────────

export type OutputImage =
  | { kind: "key"; index: number; jpeg: Uint8Array }
  | { kind: "strip"; x: number; y: number; w: number; h: number; jpeg: Uint8Array };

/** Setzt Chunks wieder zu Bildern zusammen; prüft Chunk-Reihenfolge. */
export class OutputAssembler {
  #key = new Map<number, Uint8Array[]>();
  #strip: { parts: Uint8Array[]; x: number; y: number; w: number; h: number } | null = null;

  /** Liefert ein Bild, sobald dessen letzter Chunk eingetroffen ist. */
  feed(d: Uint8Array): OutputImage | null {
    if (d[0] === CMD_KEY_IMAGE) {
      const key = d[1], last = d[2] === 1, len = rd16(d, 3), chunk = rd16(d, 5);
      const parts = chunk === 0 ? [] : (this.#key.get(key) ?? []);
      if (chunk !== parts.length) throw new Error(`Chunk-Folge gestört (Taste ${key}: ${chunk} statt ${parts.length})`);
      parts.push(d.slice(KEY_HEADER, KEY_HEADER + len));
      this.#key.set(key, parts);
      if (!last) return null;
      this.#key.delete(key);
      return { kind: "key", index: key, jpeg: concat(parts) };
    }
    if (d[0] === CMD_STRIP_PARTIAL) {
      const last = d[9] === 1, chunk = rd16(d, 10), len = rd16(d, 12);
      if (chunk === 0) this.#strip = { parts: [], x: rd16(d, 1), y: rd16(d, 3), w: rd16(d, 5), h: rd16(d, 7) };
      const s = this.#strip;
      if (!s || chunk !== s.parts.length) throw new Error("Streifen-Chunk-Folge gestört");
      s.parts.push(d.slice(STRIP_HEADER, STRIP_HEADER + len));
      if (!last) return null;
      this.#strip = null;
      return { kind: "strip", x: s.x, y: s.y, w: s.w, h: s.h, jpeg: concat(s.parts) };
    }
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
