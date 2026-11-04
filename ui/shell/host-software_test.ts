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
