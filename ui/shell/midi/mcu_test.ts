import { assertEquals } from "jsr:@std/assert";
import * as mcu from "./mcu.ts";

import golden from "../../../docs/midi/golden.json" with { type: "json" };

Deno.test("Codec: Kodieren gegen die gemeinsamen Prüfwerte", () => {
  const fns = mcu as unknown as Record<string, (...a: unknown[]) => number[]>;
  for (const c of golden.encode) assertEquals(fns[c.fn](...c.args), c.bytes, `${c.fn}(${JSON.stringify(c.args)})`);
});

Deno.test("Codec: Dekodieren gegen die gemeinsamen Prüfwerte", () => {
  for (const c of golden.decode) assertEquals(mcu.decodeFromSurface(c.bytes), c.event as unknown, JSON.stringify(c.bytes));
});

Deno.test("Codec: Anmelde-Antwortcode", () => {
  for (const c of golden.connectionResponse) assertEquals(mcu.connectionResponse(c.challenge), c.response);
});

Deno.test("Parser: Laufstatus, SysEx über Blöcke, Echtzeitbyte", () => {
  const p = new mcu.MidiParser();
  const out: number[][] = [];
  for (const ch of golden.stream.chunks) out.push(...p.push(ch));
  assertEquals(out, golden.stream.messages);
});

Deno.test("Parser: abgebrochenes SysEx wird verworfen, Statusbyte beginnt neu", () => {
  const p = new mcu.MidiParser();
  assertEquals(p.push([0xf0, 0, 0, 0x90, 1, 2]), [[0x90, 1, 2]]);
});

Deno.test("Notennamen und Rückwärtsabbildung", () => {
  assertEquals(mcu.noteName(0), "rec1");
  assertEquals(mcu.noteName(31), "select8");
  assertEquals(mcu.noteName(112), "touch9");
  assertEquals(mcu.noteName(94), "play");
  assertEquals(mcu.noteName(120), null);
  for (let n = 0; n <= 112; n++) {
    const name = mcu.noteName(n);
    if (name) assertEquals(mcu.noteByName(name), n, name);
  }
  assertEquals(mcu.noteByName("mute9"), null);
});

Deno.test("Host-Anmeldung: Antwort wiederholt Seriennummer und rechnet den Code", () => {
  const q = mcu.decodeFromSurface([0xf0, 0, 0, 0x66, 0x14, 0x01, 65, 66, 67, 68, 69, 70, 71, 1, 2, 3, 4, 0xf7]);
  if (q.t !== "sysex") throw new Error("kein SysEx");
  assertEquals(mcu.hostConnectionReply(q), [0xf0, 0, 0, 0x66, 0x14, 0x02, 65, 66, 67, 68, 69, 70, 71, 5, 5, 123, 47, 0xf7]);
  assertEquals(mcu.hostConnectionReply({ ...q, cmd: 0x00 }), null);
});

Deno.test("LCD: Umlaute umschrieben, Zellen 7 Spalten, zwei Zeilen", () => {
  assertEquals(mcu.lcdAscii("Größe ä€"), "Groesse ae?");
  assertEquals(mcu.lcdCell("Mikrofon 1"), "Mikrof");
  const [top, bot] = mcu.lcdCells(["Mic1"], ["-3.5dB"]);
  assertEquals(top.slice(0, 7), [0xf0, 0, 0, 0x66, 0x14, 0x12, 0x00]);
  assertEquals(top.length, 7 + 56 + 1);
  assertEquals(bot[6], 0x38);
  assertEquals(String.fromCharCode(...top.slice(7, 14)), "Mic1   ");
});

Deno.test("7-Segment: rechtsbündig, Punkt gehört zur davor stehenden Stelle", () => {
  const m = mcu.sevenSegText("01.02");
  assertEquals(m.length, 12);
  assertEquals(m[0], [0xb0, 0x40, 0x32]); // letzte Stelle „2“ ganz rechts
  assertEquals(m[1], [0xb0, 0x41, 0x30]); // „0“
  assertEquals(m[2], [0xb0, 0x42, 0x40 | 0x31]); // „1“ mit Punkt (Punkt stand hinter der 1)
  assertEquals(m[11], [0xb0, 0x4b, 0x20]); // links leer
});

Deno.test("Pegelstufe: Skala 0…12, nie 0 bei hörbarem Signal", () => {
  assertEquals(mcu.meterStep(0), 0);
  assertEquals(mcu.meterStep(0.01), 1);
  assertEquals(mcu.meterStep(1), 12);
  assertEquals(mcu.meterStep(0.5), 6);
});
