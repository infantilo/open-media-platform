import { assertEquals } from "jsr:@std/assert";
import { dueText, summarize, sortTasks, type Task, tasksOf } from "./task-logic.ts";

const mk = (o: Partial<Task>): Task => ({ id: "1", module: "review", kind: "qc", title: "A", state: "x", status: "ok", mine: false, action: { tab: "review" }, ...o });

Deno.test("summarize zählt eigene, Probleme, überfällige und übernehmbare", () => {
  const s = summarize([mk({ mine: true }), mk({ status: "error", overdue: true }), mk({ status: "warn", claimable: true }), mk({})]);
  assertEquals(s, { total: 4, mine: 1, problems: 2, overdue: 1, claimable: 1 });
});

Deno.test("sortTasks: überfällig/Fehler vor Frist vor ohne Frist", () => {
  const t = [
    mk({ id: "a", title: "ohne", status: "ok" }),
    mk({ id: "b", title: "später", status: "ok", dueAt: "2026-10-20T12:00:00Z" }),
    mk({ id: "c", title: "früher", status: "ok", dueAt: "2026-10-20T10:00:00Z" }),
    mk({ id: "d", title: "überfällig", status: "error", overdue: true, dueAt: "2026-10-19T10:00:00Z" }),
    mk({ id: "e", title: "warn", status: "warn" }),
  ];
  assertEquals(sortTasks(t).map((x) => x.id), ["d", "e", "c", "b", "a"]);
});

Deno.test("tasksOf filtert nach Modul", () => {
  assertEquals(tasksOf([mk({ module: "ingest" }), mk({ module: "review" })], "ingest").length, 1);
});

Deno.test("dueText: Zukunft, Vergangenheit, Einheiten, ohne Frist", () => {
  const w = { in: "in {span}", ago: "vor {span}" };
  const now = Date.parse("2026-10-19T12:00:00Z");
  assertEquals(dueText("2026-10-19T14:00:00Z", now, w), "in 2 h");
  assertEquals(dueText("2026-10-19T11:45:00Z", now, w), "vor 15 min");
  assertEquals(dueText("2026-10-23T12:00:00Z", now, w), "in 4 d");
  assertEquals(dueText("2026-10-19T12:00:20Z", now, w), "in <1 min");
  assertEquals(dueText(undefined, now, w), "");
  assertEquals(dueText("kaputt", now, w), "");
});

Deno.test("problemKey / stateKey: bekannte Schlüssel, sonst undefined", async () => {
  const { problemKey, stateKey } = await import("./task-logic.ts");
  assertEquals(problemKey("overdue"), "op.problem.overdue");
  assertEquals(problemKey("unbekannt"), undefined);
  assertEquals(problemKey(undefined), undefined);
  assertEquals(stateKey("in_review"), "op.state.in_review");
  assertEquals(stateKey("recording"), "op.state.recording");
  assertEquals(stateKey("x"), undefined);
});
