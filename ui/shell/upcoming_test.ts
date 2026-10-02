import { assertEquals } from "jsr:@std/assert";
import { formatCountdown, pickNext } from "./upcoming-logic.ts";

Deno.test("formatCountdown", () => {
  assertEquals(formatCountdown(0), "00:00");
  assertEquals(formatCountdown(-5000), "00:00");
  assertEquals(formatCountdown(65_000), "01:05");
  assertEquals(formatCountdown(3_723_000), "1:02:03");
  assertEquals(formatCountdown((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000), "2 T 03:04:05");
});

Deno.test("pickNext nimmt den frühesten bevorstehenden, ignoriert Altes und Ungültiges", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  const l = [
    { workflowId: "a", workflowName: "A", startsAt: "2026-10-02T12:00:00Z" },
    { workflowId: "b", workflowName: "B", startsAt: "2026-10-02T11:00:00Z" },
    { workflowId: "old", workflowName: "Old", startsAt: "2026-10-02T08:00:00Z" },
    { workflowId: "bad", workflowName: "Bad", startsAt: "kein datum" },
  ];
  assertEquals(pickNext(l, now)?.workflowId, "b");
  assertEquals(pickNext([], now), null);
  // Gerade erst gestartet (< 60 s): noch anzeigen („startet jetzt“).
  assertEquals(pickNext([{ workflowId: "x", workflowName: "X", startsAt: "2026-10-02T09:59:30Z" }], now)?.workflowId, "x");
});
