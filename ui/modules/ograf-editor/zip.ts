// Minimaler ZIP-Leser/-Schreiber für OGraf-Pakete (Kapitel 90.4): Schreiben ohne Kompression (Methode 0), Lesen mit Methode 0
// und 8 (Deflate über `DecompressionStream("deflate-raw")`). Kein ZIP64, keine Verschlüsselung. Dateien liegen flach im
// Paket; ein einzelner gemeinsamer Oberordner im Archiv wird entfernt, tiefere Pfade, versteckte Dateien und
// unbekannte Dateitypen werden nicht übernommen (und gemeldet).
import type { Files } from "./logic.ts";

const TEXT_EXT = ["js", "mjs", "json", "css", "svg", "html", "txt"];
const BINARY_EXT = ["png", "jpg", "jpeg", "webp", "gif", "woff", "woff2", "ttf"];
export const BINARY_PREFIX = "base64:";
const MAX_ENTRIES = 200;
const MAX_UNPACKED = 16 * 1024 * 1024;

const extOf = (n: string): string => (n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "");
export const isBinaryName = (n: string): boolean => BINARY_EXT.includes(extOf(n));
export const isTextName = (n: string): boolean => TEXT_EXT.includes(extOf(n));

let CRC: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Paketdateien (Text oder `base64:`) → Bytes je Dateiname. */
export function filesToBytes(files: Files): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [n, c] of Object.entries(files)) {
    out[n] = isBinaryName(n) && c.startsWith(BINARY_PREFIX) ? base64ToBytes(c.slice(BINARY_PREFIX.length)) : new TextEncoder().encode(c);
  }
  return out;
}

/** ZIP-Archiv ohne Kompression. Die Reihenfolge der Einträge ist die Reihenfolge der Schlüssel. */
export function makeZip(entries: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const cat = (...p: Uint8Array[]) => {
    const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0));
    let i = 0;
    for (const x of p) {
      o.set(x, i);
      i += x.length;
    }
    return o;
  };
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1 | ((2026 - 1980) << 9); // 2026-01-01
  for (const [name, data] of Object.entries(entries)) {
    const nm = enc.encode(name);
    const crc = crc32(data);
    const local = cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), nm, data);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nm));
    chunks.push(local);
    offset += local.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const count = Object.keys(entries).length;
  return cat(...chunks, ...central, u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(cdSize), u32(offset), u16(0));
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  void w.write(raw as unknown as BufferSource).then(() => w.close()).catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

export interface ZipRead {
  files: Record<string, Uint8Array>;
  skipped: string[];
}

/** Liest ein ZIP-Archiv. Wirft bei beschädigten oder nicht unterstützten Archiven. */
export async function readZip(data: Uint8Array): Promise<ZipRead> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("kein ZIP-Archiv");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new Error("zu viele Einträge im Archiv");
  const dec = new TextDecoder();
  const raw: { name: string; data: Uint8Array }[] = [];
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Archiv beschädigt");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("verschlüsseltes Archiv wird nicht unterstützt");
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error("ZIP64 wird nicht unterstützt");
    unpacked += usize;
    if (unpacked > MAX_UNPACKED) throw new Error("Archiv entpackt zu groß");
    if (lho + 30 > data.length || dv.getUint32(lho, true) !== 0x04034b50) throw new Error("Archiv beschädigt");
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const body = data.subarray(start, start + csize);
    if (body.length !== csize) throw new Error("Archiv beschädigt");
    let out: Uint8Array;
    if (method === 0) out = body;
    else if (method === 8) out = await inflate(body);
    else throw new Error(`Kompressionsmethode ${method} wird nicht unterstützt`);
    if (out.length !== usize || crc32(out) !== crc) throw new Error(`Prüfsumme von „${name}“ stimmt nicht`);
    raw.push({ name, data: out });
  }
  // Gemeinsamen Oberordner entfernen (nur wenn alle Dateien darunter liegen).
  const clean = raw.filter((r) => !r.name.startsWith("__MACOSX/"));
  const tops = new Set(clean.map((r) => (r.name.includes("/") ? r.name.split("/")[0] : "")));
  const strip = tops.size === 1 && !tops.has("") ? `${[...tops][0]}/` : "";
  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  for (const r of clean) {
    const name = strip ? r.name.slice(strip.length) : r.name;
    const ok = name !== "" && !name.includes("/") && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name) && (isTextName(name) || isBinaryName(name));
    if (ok) files[name] = r.data;
    else skipped.push(r.name);
  }
  return { files, skipped };
}

/** Gelesene Bytes → Paketdateien (Text als UTF-8, Binärdateien als `base64:`). */
export function bytesToFiles(entries: Record<string, Uint8Array>): Files {
  const out: Files = {};
  for (const [n, b] of Object.entries(entries)) {
    out[n] = isBinaryName(n) ? BINARY_PREFIX + bytesToBase64(b) : new TextDecoder().decode(b);
  }
  return out;
}
