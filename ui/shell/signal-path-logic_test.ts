import { assertEquals } from "jsr:@std/assert";
import { diagnosePath, findPaths, firstError, type GraphData, type GraphNode } from "./signal-path-logic.ts";

const V = "urn:x-nmos:format:video";
const A = "urn:x-nmos:format:audio";
const MXL = "urn:x-nmos:transport:mxl";

function node(id: string, ins: [string, string][], outs: [string, string][], health = "ok"): GraphNode {
  return {
    id,
    label: id.toUpperCase(),
    health,
    inputs: ins.map(([pid, f]) => ({ id: pid, label: pid, format: f, transport: MXL })),
    outputs: outs.map(([pid, f]) => ({ id: pid, label: pid, format: f, transport: MXL })),
  };
}
const edge = (from: string, to: string) => ({ id: to, fromSender: from, toReceiver: to, state: "active" });

// src.s1 → mix.r1 ; mix.s → out.r ; src.s1 → alt.r ; alt.s → out.r2
const g: GraphData = {
  nodes: [
    node("src", [], [["src.s1", V], ["src.s2", V]]),
    node("mix", [["mix.r1", V], ["mix.r2", V]], [["mix.s", V]]),
    node("alt", [["alt.r", V]], [["alt.s", V]]),
    node("out", [["out.r", V], ["out.r2", V]], []),
  ],
  edges: [edge("src.s1", "mix.r1"), edge("mix.s", "out.r"), edge("src.s1", "alt.r"), edge("alt.s", "out.r2")],
};

Deno.test("findPaths: findet beide Wege, portgenauer Start", () => {
  const r = findPaths(g, { fromSender: "src.s1", toNodeId: "out" });
  assertEquals(r.paths.length, 2);
  assertEquals(r.paths[0].map((h) => h.toNode.id).length, 2);
  assertEquals(findPaths(g, { fromSender: "src.s2", toNodeId: "out" }).paths.length, 0);
});

Deno.test("findPaths: Ziel-Receiver und Via-Filter", () => {
  assertEquals(findPaths(g, { fromSender: "src.s1", toReceiver: "out.r2" }).paths.length, 1);
  const via = findPaths(g, { fromSender: "src.s1", toNodeId: "out", viaNodeId: "alt" });
  assertEquals(via.paths.length, 1);
  assertEquals(via.paths[0][0].toNode.id, "alt");
});

Deno.test("findPaths: Schleifen terminieren, kein Ziel = leer", () => {
  const loop: GraphData = {
    nodes: [node("a", [["a.r", V]], [["a.s", V]]), node("b", [["b.r", V]], [["b.s", V]]), node("z", [["z.r", V]], [])],
    edges: [edge("a.s", "b.r"), edge("b.s", "a.r")],
  };
  assertEquals(findPaths(loop, { fromSender: "a.s", toNodeId: "z" }).paths.length, 0);
  assertEquals(findPaths(g, { fromSender: "src.s1" }).paths.length, 0);
});

Deno.test("diagnosePath: offline, Formatfehler, Host-Grenze, erste Fehlerstelle", () => {
  const g2: GraphData = {
    nodes: [node("s", [], [["s.o", V]]), node("m", [["m.i", A]], [["m.o", A]], "offline")],
    edges: [edge("s.o", "m.i")],
  };
  const p = findPaths(g2, { fromSender: "s.o", toNodeId: "m" }).paths[0];
  const issues = diagnosePath(p, (id) => ({ hostKey: id === "s" ? "" : "h2" }));
  // Link (Position 1) kommt vor der offline-Node (Position 2)
  assertEquals(firstError(issues)?.position, 1);
  assertEquals(issues.filter((i) => i.severity === "error").length, 3);
  const ok = findPaths(g, { fromSender: "src.s1", toNodeId: "out" }).paths[0];
  assertEquals(diagnosePath(ok, () => ({})), []);
});
