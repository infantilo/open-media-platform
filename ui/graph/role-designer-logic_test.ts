import { assertEquals } from "jsr:@std/assert@1";
import { addConnection, removeRole } from "./role-designer-logic.ts";

Deno.test("removeRole drops the role and any connection touching it", () => {
  const roles = [{ name: "quelle", nodeType: "omp-source" }, { name: "bild", nodeType: "omp-viewer" }];
  const connections = [{ fromRole: "quelle", toRole: "bild" }];
  const result = removeRole(roles, connections, "quelle");
  assertEquals(result.roles, [{ name: "bild", nodeType: "omp-viewer" }]);
  assertEquals(result.connections, []);
});

Deno.test("removeRole leaves unrelated roles/connections untouched", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }, { name: "b", nodeType: "omp-viewer" }, { name: "c", nodeType: "omp-viewer" }];
  const connections = [{ fromRole: "a", toRole: "c" }];
  const result = removeRole(roles, connections, "b");
  assertEquals(result.roles, [{ name: "a", nodeType: "omp-source" }, { name: "c", nodeType: "omp-viewer" }]);
  assertEquals(result.connections, [{ fromRole: "a", toRole: "c" }]);
});

Deno.test("addConnection appends a new connection", () => {
  const result = addConnection([], "quelle", "bild");
  assertEquals(result.ok, true);
  assertEquals(result.connections, [{ fromRole: "quelle", toRole: "bild" }]);
});

Deno.test("addConnection rejects a self-loop", () => {
  const result = addConnection([], "quelle", "quelle");
  assertEquals(result.ok, false);
  assertEquals(result.connections, []);
});

Deno.test("addConnection rejects an exact duplicate", () => {
  const existing = [{ fromRole: "quelle", toRole: "bild" }];
  const result = addConnection(existing, "quelle", "bild");
  assertEquals(result.ok, false);
  assertEquals(result.connections, existing);
});

Deno.test("addConnection allows the reverse direction between the same two roles", () => {
  const existing = [{ fromRole: "quelle", toRole: "bild" }];
  const result = addConnection(existing, "bild", "quelle");
  assertEquals(result.ok, true);
  assertEquals(result.connections, [...existing, { fromRole: "bild", toRole: "quelle" }]);
});

Deno.test("addConnection rejects empty role names", () => {
  const result = addConnection([], "", "bild");
  assertEquals(result.ok, false);
});
