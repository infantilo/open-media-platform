import { assertEquals } from "jsr:@std/assert";
import { buildAlarmQuery, fmtDuration } from "./alarm-view.ts";

Deno.test("Dauer lesbar", () => {
  assertEquals(fmtDuration(0.2), "<1 s");
  assertEquals(fmtDuration(42), "42 s");
  assertEquals(fmtDuration(125), "2 min 5 s");
  assertEquals(fmtDuration(3 * 3600 + 120), "3 h 2 min");
});

Deno.test("Filter: leere Felder entfallen, Eingaben werden gekürzt", () => {
  const none = { days: "7", event: "", line: "", kind: "", severity: "", state: "" };
  assertEquals(buildAlarmQuery(none).toString(), "days=7");
  assertEquals(buildAlarmQuery({ ...none, days: "" }).toString(), "days=7");
  const q = buildAlarmQuery({ days: "30", event: "e1", line: "  PGM ", kind: " freeze", severity: "error", state: "open" });
  assertEquals(q.get("days"), "30");
  assertEquals(q.get("event"), "e1");
  assertEquals(q.get("line"), "PGM");
  assertEquals(q.get("kind"), "freeze"); // ohne Präfix „signal-“, so steht die Art in der Tabelle
  assertEquals(q.get("severity"), "error");
  assertEquals(q.get("state"), "open");
  assertEquals(buildAlarmQuery({ ...none, line: "   " }).has("line"), false);
});
