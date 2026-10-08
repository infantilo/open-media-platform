import { assertEquals } from "jsr:@std/assert";
import "./test-setup.ts"; // zuerst: Host-Schnittstelle + Texte
import { describeSelector, groupByCorrelation, statusText, statusTone, type TriggerRecord } from "./playout-admin-logic.ts";

const rec = (id: string, corr: string, target: string, at: string, o: Partial<TriggerRecord> = {}): TriggerRecord => ({
  id, correlationId: corr, originChannel: "nat", targetChannel: target, event: "CHANNEL_NEXT_LIVE", seq: 1, status: "applied",
  createdAt: at, statusAt: at, latePolicy: "SKIP", attempts: 1, ...o,
});

Deno.test("statusText und statusTone", () => {
  assertEquals(statusText("denied"), "verweigert (keine Regel)");
  assertEquals(statusText("neu"), "neu");
  assertEquals(statusTone("applied"), "ok");
  assertEquals(statusTone("applied_late"), "warn");
  assertEquals(statusTone("expired"), "bad");
  assertEquals(statusTone("published"), "neutral");
});

Deno.test("describeSelector", () => {
  const name = (id: string) => (id === "n" ? "Nord" : id);
  assertEquals(describeSelector("*", name), "alle");
  assertEquals(describeSelector("group:regional", name), "Gruppe regional");
  assertEquals(describeSelector("channel:n", name), "Channel Nord");
});

Deno.test("groupByCorrelation: ein Trigger an eine Gruppe wird EINE Gruppe, neueste zuerst, Ziele nach Seq/Name", () => {
  const list = [
    rec("1", "c1", "s", "2026-10-02T10:00:00Z"),
    rec("2", "c1", "n", "2026-10-02T10:00:00Z"),
    rec("3", "c2", "n", "2026-10-02T11:00:00Z", { seq: 2 }),
  ];
  const g = groupByCorrelation(list);
  assertEquals(g.map((x) => x.correlationId), ["c2", "c1"]);
  assertEquals(g[1].items.map((i) => i.targetChannel), ["n", "s"]);
  assertEquals(g[1].items.length, 2);
});

import { actualDurationMs, asRunKindText, asRunTone, deviationText, durationText, filterAsRun, startDeviationMs, type AsRunRow } from "./playout-admin-logic.ts";

const ar = (key: string, kind: string, at: string, o: Partial<AsRunRow> = {}): AsRunRow => ({ key, kind, recordedAt: at, ...o });

Deno.test("As-Run: Abweichung, Dauer, Texte", () => {
  const r = ar("a", "primary", "2026-10-05T10:00:10Z", {
    plannedStart: "2026-10-05T10:00:00Z", actualStart: "2026-10-05T10:00:01.200Z", actualEnd: "2026-10-05T10:01:31.200Z", status: "COMPLETED",
  });
  assertEquals(startDeviationMs(r), 1200);
  assertEquals(deviationText(1200), "+1,2 s");
  assertEquals(deviationText(-300), "−0,3 s");
  assertEquals(deviationText(20), "±0");
  assertEquals(deviationText(undefined), "—");
  assertEquals(actualDurationMs(r), 90000);
  assertEquals(durationText(90000), "1:30");
  assertEquals(durationText(undefined), "—");
  assertEquals(startDeviationMs(ar("b", "primary", "x")), undefined);
  assertEquals(asRunKindText("child"), "Child Event");
  assertEquals(asRunKindText("neu"), "neu");
});

Deno.test("As-Run: Ton und Filter (neueste zuerst)", () => {
  assertEquals(asRunTone(ar("a", "primary", "t", { status: "COMPLETED" })), "ok");
  assertEquals(asRunTone(ar("a", "primary", "t", { status: "FAILED" })), "bad");
  assertEquals(asRunTone(ar("a", "primary", "t", { status: "INTERRUPTED" })), "warn");
  assertEquals(asRunTone(ar("a", "warning", "t")), "warn");
  const rows = [ar("1", "primary", "2026-10-05T10:00:00Z"), ar("2", "operator", "2026-10-05T10:00:05Z"), ar("3", "primary", "2026-10-05T10:00:09Z")];
  assertEquals(filterAsRun(rows, "").map((r) => r.key), ["3", "2", "1"]);
  assertEquals(filterAsRun(rows, "primary").map((r) => r.key), ["3", "1"]);
});
