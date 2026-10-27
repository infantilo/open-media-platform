import { assertEquals } from "jsr:@std/assert";
import { diagnosePath, findPaths, loopFeeder, withImplicitFeeds, firstError, linkNetNote, netDemandText, type GraphData, type GraphNode } from "./signal-path-logic.ts";
import { setLang } from "./i18n.ts";

setLang("de", false);

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
  assertEquals(findPaths(g, {}).paths.length, 0); // weder Quelle noch Ziel
});

Deno.test("findPaths: nur Quelle — alle Ketten bis zum Ende, portgenau", () => {
  const r = findPaths(g, { fromSender: "src.s1" });
  // src.s1 → mix → out  und  src.s1 → alt → out
  assertEquals(r.paths.map((p) => p.map((h) => h.toNode.id).join(">")).sort(), ["alt>out", "mix>out"]);
  assertEquals(findPaths(g, { fromSender: "src.s2" }).paths.length, 0); // nichts angeschlossen
  const via = findPaths(g, { fromSender: "src.s1", viaNodeId: "alt" });
  assertEquals(via.paths.map((p) => p.map((h) => h.toNode.id).join(">")), ["alt>out"]);
});

Deno.test("findPaths: nur Ziel — alle Ketten zurück bis zum Ursprung, Fließrichtung", () => {
  const r = findPaths(g, { toNodeId: "out" });
  assertEquals(r.paths.map((p) => p.map((h) => h.fromNode.id + ">" + h.toNode.id).join(" ")).sort(), ["src>alt alt>out", "src>mix mix>out"]);
  // genau ein Receiver-Port
  const one = findPaths(g, { toReceiver: "out.r2" });
  assertEquals(one.paths.length, 1);
  assertEquals(one.paths[0][0].fromNode.id, "src");
  assertEquals(one.paths[0][one.paths[0].length - 1].edge.toReceiver, "out.r2");
  assertEquals(findPaths(g, { toNodeId: "src" }).paths.length, 0); // Quelle ohne Eingang
  assertEquals(findPaths(g, { toNodeId: "out", viaNodeId: "mix" }).paths.length, 1);
});

Deno.test("findPaths: nur Quelle/nur Ziel — Verzweigung liefert je Zweig eine Kette, Schleifen terminieren", () => {
  const fan: GraphData = {
    nodes: [node("s", [], [["s.o", V]]), node("a", [["a.i", V]], [["a.o", V]]), node("b", [["b.i", V]], []), node("c", [["c.i", V]], [])],
    edges: [edge("s.o", "a.i"), edge("a.o", "b.i"), edge("a.o", "c.i")],
  };
  assertEquals(findPaths(fan, { fromSender: "s.o" }).paths.map((p) => p.map((h) => h.toNode.id).join(">")).sort(), ["a>b", "a>c"]);
  const loop: GraphData = {
    nodes: [node("a", [["a.r", V]], [["a.s", V]]), node("b", [["b.r", V]], [["b.s", V]])],
    edges: [edge("a.s", "b.r"), edge("b.s", "a.r")],
  };
  assertEquals(findPaths(loop, { fromSender: "a.s" }).paths.length, 1);
  assertEquals(findPaths(loop, { toNodeId: "a" }).paths.length, 1);
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

Deno.test("Netz: Bedarf größer als Karte, Auslastung über Grenzwert, unbekannter Link, lokaler MXL-Link", () => {
  const p = findPaths(g, { fromSender: "src.s1", toNodeId: "mix" }).paths[0];
  const hn = (percent: number, linkMbps?: number) => ({ measured: true, linkMbps, percent, thresholdPercent: 85 });
  const ctx = (c: Partial<import("./signal-path-logic.ts").NodeContext>) => (id: string) => id === "src" ? { hostKey: "h", ...c } : { hostKey: "h" };
  // 12 Gbit/s Bedarf auf 10-Gbit/s-Karte
  let issues = diagnosePath(p, ctx({ netTxMbps: 12000, hostNet: hn(1, 10000) }));
  assertEquals(issues.length, 1);
  assertEquals(issues[0].severity, "error");
  // Bedarf passt, Karte aber zu 90 % belegt
  issues = diagnosePath(p, ctx({ netTxMbps: 2000, hostNet: hn(90, 10000) }));
  assertEquals(issues[0].severity, "error");
  // Bedarf passt, Karte frei → keine Meldung
  assertEquals(diagnosePath(p, ctx({ netTxMbps: 2000, hostNet: hn(10, 10000) })), []);
  // Link-Geschwindigkeit unbekannt → Hinweis, kein Fehler
  assertEquals(diagnosePath(p, ctx({ netTxMbps: 2000, hostNet: { measured: true, thresholdPercent: 85 } }))[0].severity, "warn");
  assertEquals(netDemandText({ netRxMbps: 2177.28, netEstimated: true }), "Rx ~2.2 Gbit/s");
  assertEquals(linkNetNote(p[0], () => ({ hostKey: "h" })), "lokal, kein Netz");
});

Deno.test("Switcher ohne Receiver: activeInput verlängert die Kette um virtuelle Kante", () => {
  const gg: GraphData = {
    nodes: [node("src", [], [["src.o", V]]), node("sw", [], [["sw.o", V]]), node("v", [["v.i", V]], [])],
    edges: [edge("sw.o", "v.i")],
  };
  assertEquals(findPaths(gg, { toNodeId: "v" }).paths[0].length, 1);
  const ext = withImplicitFeeds(gg, new Map([["sw", "src.o"], ["x", "src.o"], ["v", "gibt-es-nicht"]]));
  const p = findPaths(ext, { toNodeId: "v" }).paths;
  assertEquals(p.length, 1);
  assertEquals(p[0].map((h) => h.fromNode.id), ["src", "sw"]);
  assertEquals(gg.nodes[1].inputs.length, 0); // Original unverändert
});

Deno.test("Schleife zweier Switcher wird als Fehler am Kettenanfang gemeldet", () => {
  const gg: GraphData = {
    nodes: [node("src", [], [["src.o", V]]), node("a", [], [["a.o", V]]), node("b", [], [["b.o", V]]), node("v", [["v.i", V]], [])],
    edges: [edge("b.o", "v.i")],
  };
  const ext = withImplicitFeeds(gg, new Map([["a", "b.o"], ["b", "a.o"]]));
  const p = findPaths(ext, { toNodeId: "v" }).paths[0];
  assertEquals(p[0].fromNode.id, "a");
  const issues = diagnosePath(p, () => ({}), loopFeeder(ext, p));
  assertEquals(firstError(issues)?.position, 0);
  assertEquals(loopFeeder(withImplicitFeeds(gg, new Map([["b", "src.o"]])), findPaths(withImplicitFeeds(gg, new Map([["b", "src.o"]])), { toNodeId: "v" }).paths[0]), null);
});

import { diagnosePath as diag, hostIssues, runtimeIssues, targetNodes, targetOverview, type NodeContext } from "./signal-path-logic.ts";

const noCtx = (_: string): NodeContext => ({});

Deno.test("targetNodes: nur Nodes mit Eingängen und ohne Ausgänge", () => {
  assertEquals(targetNodes(g).map((n) => n.id), ["out"]);
});

Deno.test("runtimeIssues: läuft aber liefert nichts, Bildrate, Neustarts, Host", () => {
  const n = node("m", [], [["m.s", V]]);
  const ids = (c: NodeContext) => runtimeIssues(n, c, 0).map((i) => `${i.severity}:${i.fix ? "fix" : "nofix"}`);
  assertEquals(ids({ ready: false, everReady: true }), ["error:fix"]);
  // Nie bereit gewesen (Typ ohne Bereitschaftsprobe oder noch beim Anlaufen): nur Hinweis, kein Fehler
  assertEquals(ids({ ready: false }), ["warn:fix"]);
  assertEquals(ids({ rates: { video_fps: { last: 0, avg: 25, min: 0 } } }), ["error:fix"]);
  assertEquals(ids({ rates: { video_fps: { last: 18, avg: 25, min: 17 } } }), ["warn:fix"]);
  assertEquals(ids({ rates: { video_fps: { last: 24, avg: 25, min: 23 } } }), []);
  assertEquals(ids({ restarts: 3 }), ["warn:fix"]);
  // Host-Befunde gehören nicht mehr zu einzelnen Nodes (hostIssues), runtimeIssues kennt sie nicht
  assertEquals(ids({ hostState: "silent" }), []);
  // Offline-Node: kein zusätzlicher „liefert nichts“-Befund (die Offline-Meldung genügt)
  assertEquals(runtimeIssues(node("o", [], [["o.s", V]], "offline"), { ready: false }, 0), []);
});

Deno.test("targetOverview: Ursache stromaufwärts, Fehler vor In-Ordnung, nichts angeschlossen", () => {
  const ok = targetOverview(g, noCtx);
  assertEquals(ok.map((x) => [x.node.id, x.level]), [["out", "ok"]]);

  // Quelle liefert nichts: Fehlerstelle ist die Quelle (am weitesten stromaufwärts), nicht der Mischer dahinter
  const bad = targetOverview(g, (id) => (id === "src" ? { ready: false, everReady: true } : id === "mix" ? { restarts: 5 } : {}));
  assertEquals(bad[0].level, "error");
  assertEquals(bad[0].text.includes("SRC"), true);
  assertEquals(typeof bad[0].fix, "string");

  const lonely: GraphData = { nodes: [node("v", [["v.r", V]], [])], edges: [] };
  assertEquals(targetOverview(lonely, noCtx)[0].level, "none");

  const mixed: GraphData = { nodes: [node("a", [["a.r", V]], []), node("src", [], [["s", V]]), node("b", [["b.r", V]], [])], edges: [edge("s", "b.r")] };
  assertEquals(targetOverview(mixed, (id) => (id === "src" ? { ready: false, everReady: true } : {})).map((x) => `${x.node.id}:${x.level}`), ["b:error", "a:none"]);
});

Deno.test("hostIssues: ein Befund je Host und Kette, an der Node am weitesten stromaufwärts, mit den betroffenen Nodes", () => {
  const a = node("a", [], [["a.s", V]]);
  const b = node("b", [["b.r", V]], [["b.s", V]]);
  const c = node("c", [["c.r", V]], []);
  const ctx = (id: string): NodeContext =>
    id === "a" || id === "b"
      ? { hostKey: "h1", hostLabel: "Host1", hostState: "silent", hostClockBad: true }
      : id === "c"
      ? { hostKey: "h2", hostLabel: "Host2", hostState: "overloaded" }
      : {};
  const out = hostIssues([a, b, c], ctx);
  assertEquals(out.map((i) => `${i.position}:${i.severity}`), ["0:error", "0:warn", "4:warn"]);
  assertEquals(out[0].text.includes("A, B"), true);
  assertEquals(out[2].text.includes("Host2"), true);
  // lokaler Host ("") und unbekannter Host: kein Befund
  assertEquals(hostIssues([a], () => ({ hostKey: "", hostState: "silent" })), []);
  assertEquals(hostIssues([a], () => ({})), []);
});

Deno.test("Ursache: Meldung des Ziels (Symptom) tritt hinter einen Befund stromaufwärts zurück", () => {
  const gg: GraphData = {
    nodes: [node("src", [], [["s", V]]), node("v", [["v.r", V]], [])],
    edges: [edge("s", "v.r")],
  };
  const ctx = (id: string): NodeContext =>
    id === "src" ? { ready: false } : id === "v" ? { problems: [{ severity: "error", text: "kein Video-Buffer" }] } : {};
  const path = findPaths(gg, { toNodeId: "v" }).paths[0];
  const issues = diag(path, ctx, null);
  // Kette ist gestört (Symptom = Fehler), die Ursache ist der Hinweis an der Quelle
  assertEquals(issues.some((i) => i.severity === "error"), true);
  assertEquals(firstError(issues)?.text.includes("SRC"), true);
  const row = targetOverview(gg, ctx)[0];
  assertEquals([row.level, row.text.includes("SRC"), typeof row.fix], ["error", true, "string"]);

  // Ohne Befund stromaufwärts bleibt das Symptom selbst die erste Fehlerstelle
  assertEquals(firstError(diag(path, (id) => (id === "v" ? ctx("v") : {}), null))?.text, "kein Video-Buffer");

  // Ein echter Fehler stromaufwärts schlägt alles
  const real = diag(path, (id) => (id === "src" ? { crashed: true } : ctx(id)), null);
  assertEquals(firstError(real)?.symptom, undefined);
});
