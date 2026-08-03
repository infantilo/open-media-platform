import { assertEquals } from "jsr:@std/assert@1";
import { addConnection, removeRole, renameRole, standbyCandidates } from "./role-designer-logic.ts";

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

Deno.test("renameRole renames the role and updates referencing connections", () => {
  const roles = [{ name: "omp-source-2", nodeType: "omp-source" }, { name: "bild", nodeType: "omp-viewer" }];
  const connections = [{ fromRole: "omp-source-2", toRole: "bild" }];
  const result = renameRole(roles, connections, "omp-source-2", "Kamera Regie");
  assertEquals(result.ok, true);
  assertEquals(result.roles, [{ name: "Kamera Regie", nodeType: "omp-source" }, { name: "bild", nodeType: "omp-viewer" }]);
  assertEquals(result.connections, [{ fromRole: "Kamera Regie", toRole: "bild" }]);
});

Deno.test("renameRole trims whitespace", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }];
  const result = renameRole(roles, [], "a", "  Kamera 1  ");
  assertEquals(result.ok, true);
  assertEquals(result.roles, [{ name: "Kamera 1", nodeType: "omp-source" }]);
});

Deno.test("renameRole rejects an empty/whitespace-only name", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }];
  const result = renameRole(roles, [], "a", "   ");
  assertEquals(result.ok, false);
  assertEquals(result.roles, roles);
});

Deno.test("renameRole rejects a name already used by another role", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }, { name: "b", nodeType: "omp-viewer" }];
  const result = renameRole(roles, [], "a", "b");
  assertEquals(result.ok, false);
});

Deno.test("renameRole is a no-op ok:false when the new name equals the old one", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }];
  const result = renameRole(roles, [], "a", "a");
  assertEquals(result.ok, false);
});

Deno.test("renameRole rejects an unknown old name", () => {
  const roles = [{ name: "a", nodeType: "omp-source" }];
  const result = renameRole(roles, [], "ghost", "b");
  assertEquals(result.ok, false);
  assertEquals(result.roles, roles);
});

Deno.test("renameRole updates a standbyFor reference to the renamed role", () => {
  const roles = [
    { name: "active", nodeType: "omp-viewer" },
    { name: "standby", nodeType: "omp-viewer", standbyFor: "active" },
  ];
  const result = renameRole(roles, [], "active", "Bildmischer 1");
  assertEquals(result.ok, true);
  assertEquals(result.roles, [
    { name: "Bildmischer 1", nodeType: "omp-viewer" },
    { name: "standby", nodeType: "omp-viewer", standbyFor: "Bildmischer 1" },
  ]);
});

Deno.test("removeRole clears a dangling standbyFor reference instead of leaving a torso", () => {
  const roles = [
    { name: "active", nodeType: "omp-viewer" },
    { name: "standby", nodeType: "omp-viewer", standbyFor: "active" },
  ];
  const result = removeRole(roles, [], "active");
  assertEquals(result.roles, [{ name: "standby", nodeType: "omp-viewer", standbyFor: undefined }]);
});

Deno.test("standbyCandidates offers only same-nodeType roles without an existing standby link", () => {
  const roles = [
    { name: "active", nodeType: "omp-viewer" },
    { name: "other-type", nodeType: "omp-scaler" },
    { name: "already-has-standby", nodeType: "omp-viewer" },
    { name: "its-standby", nodeType: "omp-viewer", standbyFor: "already-has-standby" },
  ];
  const result = standbyCandidates(roles, { name: "new-standby", nodeType: "omp-viewer" });
  assertEquals(result, [{ name: "active", nodeType: "omp-viewer" }]);
});

Deno.test("standbyCandidates excludes the role itself and a role that is already a standby-pair", () => {
  const roles = [
    { name: "a", nodeType: "omp-viewer" },
    { name: "b", nodeType: "omp-viewer", standbyFor: "a" }, // b is itself a standby ...
    { name: "c", nodeType: "omp-viewer" },
  ];
  const result = standbyCandidates(roles, roles[2]);
  // "a" excluded (already has a standby: b), "b" excluded (is itself a standby),
  // "c" excluded (self) -> nothing left, even though a/b share a NodeType with c.
  assertEquals(result, []);
});

Deno.test("standbyCandidates offers an unclaimed same-nodeType role even if an unrelated pair exists", () => {
  const roles = [
    { name: "z", nodeType: "omp-viewer" },
    { name: "z-standby", nodeType: "omp-viewer", standbyFor: "z" },
    { name: "free", nodeType: "omp-viewer" },
    { name: "asking", nodeType: "omp-viewer" },
  ];
  const result = standbyCandidates(roles, roles[3]);
  assertEquals(result, [{ name: "free", nodeType: "omp-viewer" }]);
});
