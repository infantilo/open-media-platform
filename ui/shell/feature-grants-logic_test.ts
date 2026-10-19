import { assertEquals } from "jsr:@std/assert";
import { coveringGrant, type FeatureDef, type FeatureGrant, planToggle, planToggleModule, sectionsOf } from "./feature-grants-logic.ts";

const defs: FeatureDef[] = [
  { id: "ingest.view", label: { de: "A" }, group: { de: "Aufnahmen", en: "Recordings" } },
  { id: "ingest.schedule.create", label: { de: "B" }, group: { de: "Aufnahmen", en: "Recordings" } },
  { id: "review.work", label: { de: "C" }, group: { de: "Eingang" } },
];
const g = (id: string, feature: string): FeatureGrant => ({ id, subjectType: "user", subject: "anna", feature });

Deno.test("sectionsOf gruppiert nach Modul und wählt die Sprache", () => {
  const s = sectionsOf(defs, "en");
  assertEquals(s.map((x) => [x.module, x.title, x.items.length]), [["ingest", "Recordings", 2], ["review", "Eingang", 1]]);
});

Deno.test("coveringGrant: exakt vor Muster", () => {
  const own = [g("1", "ingest.*"), g("2", "ingest.view")];
  assertEquals(coveringGrant(own, "ingest.view")?.id, "2");
  assertEquals(coveringGrant(own, "ingest.job.control")?.id, "1");
  assertEquals(coveringGrant(own, "review.work"), undefined);
});

Deno.test("planToggle: anlegen, entfernen, durch Muster gedeckt = nichts tun", () => {
  assertEquals(planToggle([], "ingest.view", true), { create: "ingest.view", deleteIds: [] });
  assertEquals(planToggle([g("1", "ingest.view")], "ingest.view", false), { deleteIds: ["1"] });
  assertEquals(planToggle([g("1", "ingest.*")], "ingest.view", true), { deleteIds: [] });
  assertEquals(planToggle([g("1", "ingest.*")], "ingest.view", false), { deleteIds: [] });
});

Deno.test("planToggleModule: Muster ersetzt Einzelvergaben, aus entfernt alles des Moduls, anderes bleibt", () => {
  const own = [g("1", "ingest.view"), g("2", "ingest.job.control"), g("3", "review.work")];
  assertEquals(planToggleModule(own, "ingest", true), { create: "ingest.*", deleteIds: ["1", "2"] });
  assertEquals(planToggleModule([g("9", "ingest.*"), g("1", "ingest.view")], "ingest", true), { create: undefined, deleteIds: ["1"] });
  assertEquals(planToggleModule([g("9", "ingest.*"), g("3", "review.work")], "ingest", false), { deleteIds: ["9"] });
});
