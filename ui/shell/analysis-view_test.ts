import { assertEquals } from "jsr:@std/assert@1";
import { fmtValue, linePath } from "./analysis-view.ts";

Deno.test("fmtValue formats bytes and percent", () => {
  assertEquals(fmtValue(2048, "B"), "2.0 KiB");
  assertEquals(fmtValue(42.4, "%"), "42 %");
  assertEquals(fmtValue(3.14159), "3.1");
});

Deno.test("linePath maps time and value into the box", () => {
  const d = linePath([{ t: 0, v: 0 }, { t: 100, v: 100 }], 0, 100, 0, 100, 200, 50);
  assertEquals(d, "M0.0,48.0L200.0,2.0");
  assertEquals(linePath([], 0, 100, 0, 1, 10, 10), "");
});
