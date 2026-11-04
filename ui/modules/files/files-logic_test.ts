import { assertEquals } from "jsr:@std/assert@1";
import { canSubmitDelete, crumbs, deleteMode, fmtBytes, freePercent, joinPath, parentPath, remaining, type Plan } from "./files-logic.ts";

const plan = (o: Partial<Plan>): Plan => ({ items: [{ rel: "a", status: "ok" }], blocked: false, needsForce: false, needsConfirm: false, ...o });

Deno.test("fmtBytes", () => {
  assertEquals(fmtBytes(0), "0 B");
  assertEquals(fmtBytes(1536), "1.5 KB");
  assertEquals(fmtBytes(5 * 1024 ** 3), "5.0 GB");
  assertEquals(fmtBytes(undefined), "–");
});

Deno.test("Pfade", () => {
  assertEquals(crumbs("a/b/c"), [{ name: "a", path: "a" }, { name: "b", path: "a/b" }, { name: "c", path: "a/b/c" }]);
  assertEquals(crumbs(""), []);
  assertEquals(parentPath("a/b/c"), "a/b");
  assertEquals(parentPath("a"), "");
  assertEquals(joinPath("", "x"), "x");
  assertEquals(joinPath("a/b", "x"), "a/b/x");
});

Deno.test("Löschen: Modus und Freigabe des Knopfs", () => {
  assertEquals(deleteMode(plan({})), "ok");
  assertEquals(deleteMode(plan({ needsConfirm: true })), "confirm");
  assertEquals(deleteMode(plan({ needsForce: true, needsConfirm: true })), "force");
  assertEquals(deleteMode(plan({ blocked: true, needsForce: true })), "blocked");
  const none = { confirm: false, force: false, reason: "", canForce: true };
  assertEquals(canSubmitDelete(plan({}), none), true);
  assertEquals(canSubmitDelete(plan({ items: [] }), none), false);
  assertEquals(canSubmitDelete(plan({ needsConfirm: true }), none), false);
  assertEquals(canSubmitDelete(plan({ needsConfirm: true }), { ...none, confirm: true }), true);
  const f = plan({ needsForce: true });
  assertEquals(canSubmitDelete(f, { ...none, force: true, reason: "kurz" }), false); // < 5 Zeichen
  assertEquals(canSubmitDelete(f, { ...none, force: true, reason: "guter Grund" }), true);
  assertEquals(canSubmitDelete(f, { ...none, force: true, reason: "guter Grund", canForce: false }), false);
  assertEquals(canSubmitDelete(plan({ blocked: true }), { confirm: true, force: true, reason: "guter Grund", canForce: true }), false);
});

Deno.test("Platz und Restzeit", () => {
  assertEquals(freePercent(25, 100), 25);
  assertEquals(freePercent(1, 0), null);
  assertEquals(freePercent(undefined, 5), null);
  assertEquals(remaining(1000, 2000), "0");
  assertEquals(remaining(2000 + 3 * 86_400_000, 2000), "3 d");
  assertEquals(remaining(2000 + 5 * 3_600_000, 2000), "5 h");
  assertEquals(remaining(2000 + 90_000, 2000), "1 min");
});
