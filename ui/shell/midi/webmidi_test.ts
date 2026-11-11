import { assertEquals } from "jsr:@std/assert";
import { choices, openChoice, pairPorts, requestAccess, type WmAccess, type WmInput, type WmOutput } from "./webmidi.ts";

const inp = (id: string, name: string): WmInput => ({ id, name, onmidimessage: null });
const out = (id: string, name: string, sent: number[][] = []): WmOutput => ({ id, name, send: (d) => void sent.push(d) });

Deno.test("Anschlüsse: gleiche Namen werden gepaart, gleiche Geräte nummeriert, Einzelne bleiben sichtbar", () => {
  const c = pairPorts([inp("i1", "V1-M"), inp("i2", "V1-M"), inp("i3", "Nur-Ein")], [out("o1", "V1-M"), out("o2", "V1-M"), out("o9", "Nur-Aus")]);
  assertEquals(c.map((x) => [x.key, x.inId, x.outId]), [["V1-M", "i1", "o1"], ["V1-M #2", "i2", "o2"], ["Nur-Ein", "i3", undefined], ["Nur-Aus (nur Ausgang)", undefined, "o9"]]);
});

Deno.test("Port: Bytes hin und her, Schließen löst den Eingang", () => {
  const sent: number[][] = [];
  const i = inp("i1", "X");
  const access = { inputs: new Map([["i1", i]]), outputs: new Map([["o1", out("o1", "X", sent)]]), onstatechange: null } as unknown as WmAccess;
  const p = openChoice(access, choices(access)[0]);
  const got: number[][] = [];
  p.onData((b) => got.push(b));
  i.onmidimessage!({ data: new Uint8Array([0x90, 1, 2]) });
  i.onmidimessage!({ data: null });
  p.send([0xb0, 1, 2]);
  assertEquals(got, [[0x90, 1, 2]]);
  assertEquals(sent, [[0xb0, 1, 2]]);
  p.close();
  assertEquals(i.onmidimessage, null);
});

Deno.test("Zugriff: fehlende API, unsicherer Kontext, Ablehnung", async () => {
  assertEquals(await requestAccess({}, true), { ok: false, reason: "no-webmidi" });
  assertEquals(await requestAccess({}, false), { ok: false, reason: "insecure-context" });
  assertEquals(await requestAccess({ requestMIDIAccess: () => Promise.reject(new Error("x")) }, true), { ok: false, reason: "denied" });
  const a = await requestAccess({ requestMIDIAccess: (o) => Promise.resolve({ sysexSeen: o.sysex }) }, true);
  assertEquals(a.ok && (a.access as unknown as { sysexSeen: boolean }).sysexSeen, true);
});
