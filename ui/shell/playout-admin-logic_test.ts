import { assertEquals } from "jsr:@std/assert";
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
