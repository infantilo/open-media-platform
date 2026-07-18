import { assertEquals } from "jsr:@std/assert@1";
import { uniqueRoleName } from "./roles.ts";

Deno.test("uniqueRoleName returns the node type unchanged when unused", () => {
  assertEquals(uniqueRoleName("omp-source", new Set()), "omp-source");
});

Deno.test("uniqueRoleName appends -2, -3, ... for repeated node types", () => {
  const used = new Set(["omp-source"]);
  assertEquals(uniqueRoleName("omp-source", used), "omp-source-2");
  used.add("omp-source-2");
  assertEquals(uniqueRoleName("omp-source", used), "omp-source-3");
});

Deno.test("uniqueRoleName skips over gaps left by removed roles", () => {
  const used = new Set(["omp-source", "omp-source-3"]);
  assertEquals(uniqueRoleName("omp-source", used), "omp-source-2");
});
