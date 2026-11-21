import { assertEquals } from "jsr:@std/assert";
import { fmtDuration } from "./alarm-view.ts";

Deno.test("Dauer lesbar", () => {
  assertEquals(fmtDuration(0.2), "<1 s");
  assertEquals(fmtDuration(42), "42 s");
  assertEquals(fmtDuration(125), "2 min 5 s");
  assertEquals(fmtDuration(3 * 3600 + 120), "3 h 2 min");
});
