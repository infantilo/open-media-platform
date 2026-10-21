import { assertEquals } from "jsr:@std/assert";
import { type DeckState, itemsFor, layoutIntercom, nudgedLevel } from "./intercom-logic.ts";

const state = (over: Partial<DeckState["me"]> = {}): DeckState => ({
  me: { id: 1, muted: false, forced: false, force: false, ...over },
  channels: [
    { id: 1, name: "Regie", talk_allowed: true, talk: false, listen: true, listen_on: true, level: 1, speakers: [2] },
    { id: 2, name: "Technik", talk_allowed: false, talk: false, listen: true, listen_on: false, level: 0.5, speakers: [] },
  ],
  parties: [{ id: 1, name: "Ich", online: true, speaking: false }, { id: 2, name: "Kamera", online: true, speaking: true }, { id: 3, name: "Tonmeister", online: false, speaking: false }],
});

Deno.test("Tasten: Stumm, Nicht stören, Rasten, Kanäle, Teilnehmer, Hören", () => {
  const labels = itemsFor(state(), false).map((i) => i.key.label);
  assertEquals(labels, ["Mikro", "Nicht stören", "Rasten", "Regie", "Technik", "Kamera", "Tonmeister", "Hören Regie", "Hören Technik"]);
});

Deno.test("Halten = sprechen solange gedrückt, Rasten = umschalten", () => {
  const hold = itemsFor(state(), false).find((i) => i.key.label === "Regie")!;
  assertEquals(hold.press, { down: { t: "talk", ch: 1, on: true }, up: { t: "talk", ch: 1, on: false } });
  const latched = itemsFor(state(), true).find((i) => i.key.label === "Regie")!;
  assertEquals(latched.press, { down: { t: "talk", ch: 1, on: true } });
});

Deno.test("Kanal ohne Sprechrecht und gesperrtes Mikrofon haben keine Aktion", () => {
  const nt = itemsFor(state(), false).find((i) => i.key.label === "Technik")!;
  assertEquals(nt.press, {});
  assertEquals(nt.key.dim, true);
  const locked = itemsFor(state({ forced: true }), false);
  assertEquals(locked[0].press, {});
  assertEquals(locked.find((i) => i.key.label === "Regie")!.press, {});
});

Deno.test("Offline-Teilnehmer lassen sich nicht rufen, Sprecher zeigen den Namen", () => {
  const it = itemsFor(state(), false);
  assertEquals(it.find((i) => i.key.label === "Tonmeister")!.press, {});
  assertEquals(it.find((i) => i.key.label === "Regie")!.key.sub, "Kamera");
  assertEquals(it.find((i) => i.key.label === "Kamera")!.press, { down: { t: "call", to: [2], on: true }, up: { t: "call", on: false } });
});

Deno.test("Alle-Ruf nur mit Recht", () => {
  assertEquals(itemsFor(state(), false).some((i) => i.key.label === "Alle rufen"), false);
  assertEquals(itemsFor(state({ force: true }), false).some((i) => i.key.label === "Alle rufen"), true);
});

Deno.test("Seiten: Raster füllt zeilenweise, weitere Seiten, Drehgeber nur für hörbare Kanäle", () => {
  const l = layoutIntercom(state(), 3, 2, 2, 0, false);
  assertEquals(l.pages, 2);
  assertEquals(l.keys[0].map((k) => k?.label), ["Mikro", "Nicht stören", "Rasten"]);
  assertEquals(l.keys[1].map((k) => k?.label), ["Regie", "Technik", "Kamera"]);
  const l2 = layoutIntercom(state(), 3, 2, 2, 1, false);
  assertEquals(l2.keys[0].map((k) => k?.label), ["Tonmeister", "Hören Regie", "Hören Technik"]);
  assertEquals(l2.keys[1], [null, null, null]);
  assertEquals(l.dials.map((d) => d?.label), ["Regie", "Technik"]);
  assertEquals(layoutIntercom(state(), 3, 2, 2, 99, false).keys[0][0]?.label, "Tonmeister", "Seite wird begrenzt");
});

Deno.test("Pegelschritt bleibt zwischen 0 und 2", () => {
  assertEquals(nudgedLevel(1, 1), 1.04);
  assertEquals(nudgedLevel(0.02, -5), 0);
  assertEquals(nudgedLevel(1.99, 5), 2);
});
