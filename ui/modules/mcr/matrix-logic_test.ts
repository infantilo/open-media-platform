import { assertEquals } from "jsr:@std/assert";
import { channelGroups, type MxNode, filterRows, isOn, isOtherSource, type MxLine, rowsOf, toggle } from "./matrix-logic.ts";

const node = (id: string, ch = 8): MxNode => ({ id, label: `Node ${id}`, online: true, senders: [
  { id: `${id}-v`, label: "Bild", format: "urn:x-nmos:format:video" },
  { id: `${id}-a`, label: "Ton", format: "urn:x-nmos:format:audio", channel_count: ch },
] });
const line = (): MxLine => ({ name: "L", transport: {} });

Deno.test("channelGroups: Paare, ungerader Rest, unbekannt", () => {
  assertEquals(channelGroups(6), [[1, 2], [3, 4], [5, 6]]);
  assertEquals(channelGroups(3), [[1, 2], [3]]);
  assertEquals(channelGroups(undefined), [[1, 2]]);
});

Deno.test("rowsOf: Bild + Tonpaare", () => {
  assertEquals(rowsOf(node("a", 4)).map((r) => r.label), ["Bild", "1/2", "3/4"]);
});

Deno.test("zwei Leitungen aus derselben Quelle: gleiches Bild, verschiedene Tonspuren", () => {
  const n = node("a");
  const rows = rowsOf(n);
  let l1 = line(), l2 = line();
  l1 = toggle(l1, rows[0]); l1 = toggle(l1, rows[1]);
  l2 = toggle(l2, rows[0]); l2 = toggle(l2, rows[3]);
  assertEquals(isOn(l1, rows[0]) && isOn(l2, rows[0]), true);
  assertEquals(l1.transport.existing?.audioTracks, [{ channels: [1, 2] }]);
  assertEquals(l2.transport.existing?.audioTracks, [{ channels: [5, 6] }]);
  assertEquals(isOn(l1, rows[3]), false);
});

Deno.test("Ton-Paar wieder abwählen entfernt Spur und Sender", () => {
  const rows = rowsOf(node("a"));
  let l = toggle(line(), rows[1]);
  l = toggle(l, rows[1]);
  assertEquals(l.transport.existing?.audioTracks, undefined);
  assertEquals(l.transport.existing?.audioSenderId, undefined);
});

Deno.test("anderer Node ersetzt die Quelle; Bild abwählen entfernt sie", () => {
  const ra = rowsOf(node("a")), rb = rowsOf(node("b"));
  let l = toggle(toggle(line(), ra[0]), ra[1]);
  assertEquals(isOtherSource(l, rb[0]), true);
  l = toggle(l, rb[0]);
  assertEquals(l.transport.existing?.videoNodeId, "b");
  assertEquals(l.transport.existing?.audioNodeId, "a"); // Ton bleibt bei Node a
  l = toggle(l, rb[0]);
  assertEquals(l.transport.existing?.videoNodeId, undefined);
  assertEquals(l.transport.existing?.audioNodeId, "a");
});

Deno.test("Spuren bleiben sortiert; Filter nach Node/Flow", () => {
  const rows = rowsOf(node("a"));
  let l = toggle(line(), rows[3]);
  l = toggle(l, rows[1]);
  assertEquals(l.transport.existing?.audioTracks?.map((x) => x.channels[0]), [1, 5]);
  assertEquals(filterRows(node("a"), "node a").length, 5);
  assertEquals(filterRows(node("a"), "5/6").length, 1);
  assertEquals(filterRows(node("a"), "xyz").length, 0);
});

Deno.test("Bild, Ton und Daten aus drei verschiedenen Nodes", () => {
  const a = node("a"), b = node("b"), c: MxNode = { id: "c", label: "Node c", online: true, senders: [{ id: "c-d", label: "ANC", format: "urn:x-nmos:format:data" }] };
  let l = line();
  l = toggle(l, rowsOf(a)[0]);
  l = toggle(l, rowsOf(b)[1]);
  l = toggle(l, rowsOf(c)[0]);
  const ex = l.transport.existing!;
  assertEquals([ex.videoNodeId, ex.audioNodeId, ex.dataNodeId], ["a", "b", "c"]);
  assertEquals(ex.audioTracks, [{ channels: [1, 2] }]);
  assertEquals(isOn(l, rowsOf(c)[0]) && isOn(l, rowsOf(a)[0]) && isOn(l, rowsOf(b)[1]), true);
});

Deno.test("ältere gemeinsame Quelle wird in je einen Node für Bild und Ton aufgelöst", () => {
  const rows = rowsOf(node("a"));
  const l: MxLine = { name: "L", transport: { existing: { nodeId: "a", nodeLabel: "Node a", audioSenderId: "a-a", audioTracks: [{ channels: [1, 2] }] } } };
  assertEquals(isOn(l, rows[0]) && isOn(l, rows[1]), true);
});
