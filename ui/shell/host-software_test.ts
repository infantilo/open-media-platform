import { assertEquals } from "jsr:@std/assert";
import { buildLabel, deviates, hostSummary, mixedVersions, nodeVersion, shortTime, type SwHost } from "./host-software-logic.ts";

const host = (label: string, nodes: SwHost["nodes"]): SwHost => ({ hostId: label, label, online: true, nodes });

Deno.test("buildLabel bevorzugt Version, sonst Release, dazu Commit", () => {
  assertEquals(buildLabel({ version: "2026.11.1", commit: "abc" }), "2026.11.1 · abc");
  assertEquals(buildLabel({ version: "dev", release: "v0.7.0+31", commit: "abc" }), "v0.7.0+31 · abc");
  assertEquals(buildLabel({ version: "dev" }), "dev");
  assertEquals(buildLabel(undefined), "–");
});

Deno.test("deviates vergleicht Commit, sonst Version, sonst nie", () => {
  assertEquals(deviates({ version: "dev", commit: "a" }, { version: "dev", commit: "b" }), true);
  assertEquals(deviates({ version: "dev", commit: "a" }, { version: "dev", commit: "a" }), false);
  assertEquals(deviates({ version: "1" }, { version: "2" }), true);
  assertEquals(deviates({ version: "dev" }, { version: "dev" }), false);
  assertEquals(deviates(undefined, { version: "1" }), false);
});

Deno.test("hostSummary zählt laufend und veraltet", () => {
  const h = host("A", [{ type: "x", runner: "process", running: 2, outdated: 1 }, { type: "y", runner: "process", running: 1 }]);
  assertEquals(hostSummary(h), { types: 2, running: 3, outdated: 1 });
});

Deno.test("mixedVersions findet Typen mit unterschiedlichem Stand auf mehreren Hosts", () => {
  const a = host("A", [{ type: "omp-source", runner: "process", version: "1", commit: "a", running: 0 }, { type: "same", runner: "process", version: "1", running: 0 }]);
  const b = host("B", [{ type: "omp-source", runner: "process", version: "1", commit: "b", running: 0 }, { type: "same", runner: "process", version: "1", running: 0 }]);
  assertEquals([...mixedVersions([a, b]).keys()], ["omp-source"]);
});

Deno.test("nodeVersion und shortTime", () => {
  assertEquals(nodeVersion({ type: "x", runner: "process", running: 0 }), "–");
  assertEquals(shortTime("kaputt"), "");
  assertEquals(shortTime(""), "");
});

import { compareBuilds, compareVersions, staleHosts, type SwReport } from "./host-software-logic.ts";

Deno.test("compareVersions numerisch je Segment", () => {
  assertEquals(compareVersions("2026.10.0", "2026.11.1"), -1);
  assertEquals(compareVersions("2026.9.3", "2026.10.0"), -1);
  assertEquals(compareVersions("1.2", "1.2.0"), 0);
  assertEquals(compareVersions("2.0-rc1", "1.9"), 1);
});

Deno.test("compareBuilds: Versionen, Commit, Bauzeit, Größe, Dateizeit", () => {
  assertEquals(compareBuilds({ version: "1.0" }, { version: "1.1" }), -1);
  assertEquals(compareBuilds({ version: "dev", commit: "a" }, { version: "dev", commit: "a" }), 0);
  assertEquals(compareBuilds({ version: "dev", commit: "a", builtAt: "2026-11-01T10:00:00Z" }, { version: "dev", commit: "b", builtAt: "2026-11-02T10:00:00Z" }), -1);
  assertEquals(compareBuilds({ version: "dev", commit: "a" }, { version: "dev", commit: "b" }), null);
  // gleicher Dev-Build auf zwei Rechnern, nur Installationszeit verschieden → gleich (gleiche Größe)
  assertEquals(compareBuilds({ version: "dev", size: 100, modified: "2026-11-01T10:00:00Z" }, { version: "dev", size: 100, modified: "2026-11-03T10:00:00Z" }), 0);
  assertEquals(compareBuilds({ version: "dev", size: 100, modified: "2026-11-01T10:00:00Z" }, { version: "dev", size: 120, modified: "2026-11-03T10:00:00Z" }), -1);
  // innerhalb der Toleranz (Build in einem Rutsch) → gleich
  assertEquals(compareBuilds({ version: "dev", size: 1, modified: "2026-11-01T10:00:00Z" }, { version: "dev", size: 2, modified: "2026-11-01T10:01:00Z" }), 0);
});

Deno.test("staleHosts markiert älteren Agent und ältere Node-Typen, nie den neuesten", () => {
  const mk = (label: string, local: boolean, agent: SwReport["orchestrator"], nodes: SwHost["nodes"]): SwHost => ({ hostId: local ? "" : label, label, local, online: true, agent, nodes });
  const orch = { version: "2026.11.1", commit: "n" };
  const rep: SwReport = {
    orchestrator: orch,
    hosts: [
      mk("Orch", true, orch, [{ type: "omp-source", runner: "process", version: "2026.11.1", running: 0 }, { type: "pkg", runner: "podman", version: "1", running: 0 }]),
      mk("A", false, { version: "2026.11.1", commit: "n" }, [{ type: "omp-source", runner: "process", version: "2026.11.1", running: 0 }]),
      mk("B", false, { version: "2026.10.0", commit: "o" }, [{ type: "omp-source", runner: "process", version: "2026.10.0", running: 1 }, { type: "pkg", runner: "podman", version: "0.9", running: 0 }]),
    ],
  };
  const st = staleHosts(rep);
  assertEquals([...st.keys()], ["B"]);
  const b = st.get("B")!;
  assertEquals(b.agentOlder, true);
  assertEquals(b.nodes.map((n) => n.type), ["omp-source"]); // Container-Typen werden nicht verglichen
  assertEquals(b.nodes[0].newerOn, "Orch");
});

Deno.test("staleHosts: alles gleich → nichts markiert", () => {
  const n = { type: "x", runner: "process", version: "dev", size: 5, modified: "2026-11-01T10:00:00Z", running: 0 };
  const rep: SwReport = { orchestrator: { version: "dev", commit: "c" }, hosts: [
    { hostId: "", label: "O", local: true, online: true, agent: { version: "dev", commit: "c" }, nodes: [n] },
    { hostId: "a", label: "A", online: true, agent: { version: "dev", commit: "c" }, nodes: [{ ...n, modified: "2026-11-03T10:00:00Z" }] },
  ] };
  assertEquals(staleHosts(rep).size, 0);
});
