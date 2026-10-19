import { assertEquals } from "jsr:@std/assert";
import { featureMatches, hasAnyFeature, hasFeature } from "./features.ts";

Deno.test("featureMatches: exakt, Modul-Muster, Stern", () => {
  assertEquals(featureMatches("ingest.schedule.create", "ingest.schedule.create"), true);
  assertEquals(featureMatches("ingest.*", "ingest.job.control"), true);
  assertEquals(featureMatches("ingest.*", "review.work"), false);
  assertEquals(featureMatches("ingest.*", "ingest"), false);
  assertEquals(featureMatches("*", "x.y"), true);
  assertEquals(featureMatches("ingest.schedule", "ingest.schedule.create"), false);
});

Deno.test("hasFeature: all deckt alles, null nichts", () => {
  assertEquals(hasFeature({ all: true, patterns: [] }, "a.b"), true);
  assertEquals(hasFeature({ all: false, patterns: ["a.*"] }, "a.b"), true);
  assertEquals(hasFeature({ all: false, patterns: ["a.*"] }, "c.b"), false);
  assertEquals(hasFeature(null, "a.b"), false);
});

Deno.test("hasAnyFeature: ein einzelnes Recht des Moduls genügt für die Kachel", () => {
  assertEquals(hasAnyFeature({ all: false, patterns: ["ingest.schedule.create"] }, ["ingest.*"]), true);
  assertEquals(hasAnyFeature({ all: false, patterns: ["review.work"] }, ["ingest.*"]), false);
  assertEquals(hasAnyFeature({ all: false, patterns: [] }, ["ingest.*"]), false);
  assertEquals(hasAnyFeature({ all: true, patterns: [] }, ["x.*"]), true);
});

Deno.test("isMine / groupName", async () => {
  const { isMine, groupName } = await import("./features.ts");
  const set = { all: false, patterns: [], groups: ["g1"] };
  assertEquals(isMine(set, "anna", "anna", undefined), true);
  assertEquals(isMine(set, "anna", "bob", "g1"), true);
  assertEquals(isMine(set, "anna", "bob", "g2"), false);
  assertEquals(isMine(null, "anna", "bob", "g1"), false);
  assertEquals(isMine(set, undefined, "", ""), false);
  assertEquals(groupName({ users: [], groups: [{ id: "g1", name: "Nachtschicht" }] }, "g1"), "Nachtschicht");
  assertEquals(groupName(null, "g9"), "g9");
});
