import { assertEquals } from "jsr:@std/assert";
import { allFree, type CardDevice, countSelection, groupCards, togglePort } from "./capture-card-logic.ts";

const devices: CardDevice[] = [
  { vendor: "decklink", device: 0, name: "Duo 2", ports: [{ portId: "decklink-0-in", dir: "in", state: "free" }, { portId: "decklink-0-out", dir: "out", state: "used", instanceId: "i1" }] },
  { vendor: "decklink", device: 1, name: "Duo 2", ports: [{ portId: "decklink-1-in", dir: "in", state: "free" }, { portId: "decklink-1-out", dir: "out", state: "free" }] },
  { vendor: "aja", device: 0, name: "KONA", ports: [{ portId: "aja-0-in", dir: "in", state: "free" }] },
];

Deno.test("Teilgeräte einer Karte werden zusammengefasst", () => {
  const g = groupCards(devices);
  assertEquals(g.map((x) => `${x.vendor}/${x.name}/${x.devices.length}`), ["aja/KONA/1", "decklink/Duo 2/2"]);
});

Deno.test("belegte Ports lassen sich nicht wählen, freie schalten um", () => {
  assertEquals(togglePort(devices, [], "decklink-0-out"), []);
  const one = togglePort(devices, [], "decklink-1-in");
  assertEquals(one, ["decklink-1-in"]);
  assertEquals(togglePort(devices, one, "decklink-1-out"), ["decklink-1-in", "decklink-1-out"]);
  assertEquals(togglePort(devices, ["decklink-1-in", "decklink-1-out"], "decklink-1-in"), ["decklink-1-out"]);
});

Deno.test("alle freien Ports einer Karte, belegte ausgenommen", () => {
  assertEquals(allFree(devices, "decklink", "Duo 2"), ["decklink-0-in", "decklink-1-in", "decklink-1-out"]);
  assertEquals(allFree(devices, "aja"), ["aja-0-in"]);
});

Deno.test("Zählung nach Richtung", () => {
  assertEquals(countSelection(["decklink-0-in", "decklink-1-in", "decklink-1-out"]), { ins: 2, outs: 1 });
});
