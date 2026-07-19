import { assertEquals } from "jsr:@std/assert@1";
import { pickActiveEntry } from "./console-logic.ts";

const a = { nodeRoleId: "role-a", uiBundleUrl: "/api/v1/nodes/node-a-1" };
const b = { nodeRoleId: "role-b", uiBundleUrl: "/api/v1/nodes/node-b-1" };

Deno.test("pickActiveEntry: initial load with no active role picks the first entry", () => {
  assertEquals(pickActiveEntry([a, b], null, undefined), "role-a");
});

Deno.test("pickActiveEntry: preselect wins even if the active role would otherwise still be valid", () => {
  assertEquals(pickActiveEntry([a, b], "role-a", a.uiBundleUrl, "role-b"), "role-b");
});

Deno.test("pickActiveEntry: unchanged uiBundleUrl for the active role needs no activation", () => {
  assertEquals(pickActiveEntry([a, b], "role-a", a.uiBundleUrl), null);
});

Deno.test("pickActiveEntry: a restarted process (same role, new node id) triggers a remount", () => {
  const aRestarted = { nodeRoleId: "role-a", uiBundleUrl: "/api/v1/nodes/node-a-2" };
  assertEquals(pickActiveEntry([aRestarted, b], "role-a", a.uiBundleUrl), "role-a");
});

Deno.test("pickActiveEntry: active role no longer present falls back to the first entry", () => {
  assertEquals(pickActiveEntry([b], "role-a", a.uiBundleUrl), "role-b");
});

Deno.test("pickActiveEntry: active role no longer present and no entries left returns null", () => {
  assertEquals(pickActiveEntry([], "role-a", a.uiBundleUrl), null);
});
