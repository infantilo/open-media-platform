import { assertEquals } from "jsr:@std/assert";
import { buildTopology, kindOf, layoutBoxes, levelOf, linkPath, strokeFor, type GraphEdgeIn, type GraphNodeIn } from "./host-topology-logic.ts";

const node = (id: string, instanceId: string | undefined, outs: string[] = [], ins: string[] = []): GraphNodeIn => ({
  id, label: id, instanceId, inputs: ins.map((i) => ({ id: i })), outputs: outs.map((o) => ({ id: o, format: "urn:x-nmos:format:video" })),
});

const hosts = [{ id: "", label: "Orchestrator", online: true }, { id: "h1", label: "Regie A", online: true }, { id: "h2", label: "Regie B", online: false }];
const instances = [{ id: "i1", hostId: "" }, { id: "i2", hostId: "h1" }, { id: "i3", hostId: "h1" }, { id: "i4", hostId: "h2" }];
const nodes = [node("src", "i1", ["s1"]), node("mix", "i2", ["m1"], ["r1", "r2"]), node("mon", "i3", [], ["r3"]), node("out", "i4", [], ["r4"]), node("cam", undefined, ["c1"])];
const edges: GraphEdgeIn[] = [
  { id: "e1", fromSender: "s1", toReceiver: "r1" }, // local → h1
  { id: "e2", fromSender: "c1", toReceiver: "r2" }, // extern → h1
  { id: "e3", fromSender: "m1", toReceiver: "r3" }, // h1 → h1 (intern)
  { id: "e4", fromSender: "m1", toReceiver: "r4" }, // h1 → h2
  { id: "e5", fromSender: "s1", toReceiver: "r4" }, // local → h2
  { id: "e6", fromSender: "m1", toReceiver: "r1" }, // h1 → h1 (intern)
  { id: "e7", fromSender: "zz", toReceiver: "r1" }, // unbekannter Port: ignoriert
];

Deno.test("Knoten werden Hosts zugeordnet, ohne Instanz → Extern, lokaler Host heißt local", () => {
  const t = buildTopology(hosts, nodes, edges, instances);
  assertEquals(t.boxes.map((b) => b.id), ["local", "h1", "h2", "extern"]);
  assertEquals(t.boxes.find((b) => b.id === "h1")!.nodes.map((n) => n.id), ["mix", "mon"]);
  assertEquals(t.boxes.find((b) => b.id === "h1")!.internal, 2);
});

Deno.test("hostübergreifende Verbindungen werden je Richtung gezählt, interne nicht", () => {
  const t = buildTopology(hosts, nodes, edges, instances);
  const key = (l: { from: string; to: string }) => `${l.from}→${l.to}`;
  const m = Object.fromEntries(t.links.map((l) => [key(l), l.count]));
  assertEquals(m, { "local→h1": 1, "extern→h1": 1, "h1→h2": 1, "local→h2": 1 });
  assertEquals(t.links[0].kinds, ["video"]);
});

Deno.test("leeres Extern entfällt; Node eines unbekannten Hosts bekommt einen eigenen Kasten", () => {
  const t = buildTopology(hosts, [node("a", "i1")], [], instances);
  assertEquals(t.boxes.some((b) => b.id === "extern"), false);
  const t2 = buildTopology(hosts, [node("a", "ix")], [], [{ id: "ix", hostId: "weg" }]);
  assertEquals(t2.boxes.some((b) => b.id === "weg"), true);
});

Deno.test("Raster: Spalten nach Breite, Höhe nach Zeilen", () => {
  const l = layoutBoxes(["a", "b", "c", "d", "e"], 1100);
  assertEquals(l.pos.get("a")!.x, 0);
  assertEquals(l.pos.get("c")!.x, 2 * (250 + 110));
  assertEquals(l.pos.get("d")!.y, 190 + 60);
  assertEquals(layoutBoxes(["a", "b"], 100).pos.get("b")!.y, 250); // schmal: eine Spalte
});

Deno.test("Linien enden am Rand der Kästen; Gegenrichtung wird versetzt", () => {
  const a = { id: "a", x: 0, y: 0, w: 200, h: 100 }, b = { id: "b", x: 400, y: 0, w: 200, h: 100 };
  const p = linkPath(a, b);
  assertEquals(p.d.startsWith("M200.0,50.0"), true);
  assertEquals(p.d.endsWith("400.0,50.0"), true);
  assertEquals(linkPath(a, b, 20).d !== linkPath(b, a, 20).d, true);
});

Deno.test("Hilfen", () => {
  assertEquals(kindOf("urn:x-nmos:format:audio"), "audio");
  assertEquals([strokeFor(1), strokeFor(100)], [2.4, 8]);
  assertEquals([levelOf(undefined), levelOf(50), levelOf(90), levelOf(100)], ["none", "ok", "warn", "full"]);
});
