import { assertEquals } from "jsr:@std/assert";
import { type Binding, buildResourceOptions, matchesQuery, planSet, resourceOf, scopeKindOf } from "./permissions-logic.ts";

const labels = { global: "Alles", wholeWorkflow: "ganzer Workflow", allProcesses: "alle" };
const opts = buildResourceOptions(
  [{ id: "n1", label: "Kamera 1", instanceId: "i1" }],
  [{ id: "w1", name: "Studio", definition: { roles: [{ name: "Bildmischer", nodeType: "omp-video-mixer-me" }] } }],
  [{ id: "p1", name: "Ingest", category: "media" }],
  labels,
);

Deno.test("scopeKindOf unterscheidet die fünf Bereichsarten", () => {
  assertEquals(scopeKindOf("", "*"), "global");
  assertEquals(scopeKindOf("", "i1"), "node");
  assertEquals(scopeKindOf("w1", "*"), "workflow");
  assertEquals(scopeKindOf("w1", "Bildmischer"), "role");
  assertEquals(scopeKindOf("process:p1", "*"), "process");
});

Deno.test("buildResourceOptions: global, Workflow, Rolle, Node, Prozess", () => {
  assertEquals(opts.map((o) => o.kind), ["global", "workflow", "role", "node", "process"]);
  assertEquals(opts[4].workflowId, "process:p1");
  assertEquals(opts[3].nodeId, "i1");
});

Deno.test("resourceOf markiert gelöschte Bereiche als missing", () => {
  assertEquals(resourceOf({ workflowId: "", nodeId: "i1" }, opts).missing, undefined);
  const r = resourceOf({ workflowId: "", nodeId: "weg" }, opts);
  assertEquals([r.missing, r.title], [true, "weg"]);
});

Deno.test("matchesQuery: alle Wörter, Reihenfolge egal", () => {
  assertEquals(matchesQuery("Studio → Bildmischer", "bild studio"), true);
  assertEquals(matchesQuery("Studio → Bildmischer", "ton"), false);
});

Deno.test("planSet: ersetzt vorhandene Rechte, ändert nichts bei Gleichheit", () => {
  const b = (id: string, verb: string, node = "i1"): Binding => ({ id, subject: "anna", subjectType: "user", nodeId: node, verb });
  const subj = { type: "user" as const, id: "anna" };
  assertEquals(planSet([b("1", "view")], subj, "", "i1", "operate"), { deleteIds: ["1"], create: true });
  assertEquals(planSet([b("1", "view")], subj, "", "i1", "view"), { deleteIds: [], create: false });
  assertEquals(planSet([b("1", "view", "x")], subj, "", "i1", "view"), { deleteIds: [], create: true });
});
