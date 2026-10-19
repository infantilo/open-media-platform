import { assertEquals } from "jsr:@std/assert@1";
import { formatTimecode, frameForPts, frameForTime, frameForTimecode, parseRate, parseTimecode, timecodeOf, timeForFrame, validateRange, type Timeline } from "./timecode.ts";

interface Vec {
  rate: string;
  drop: boolean;
  frame: number;
  tc: string;
}

// Dieselben Vektoren wie im Go-Test (orchestrator/internal/modules/review/timecode_test.go).
import vectorsJson from "../../../orchestrator/internal/modules/review/testdata/timecode_vectors.json" with { type: "json" };
const vectors = vectorsJson as Vec[];

Deno.test("Timecode: Go-Testvektoren Format und Parse", () => {
  for (const v of vectors) {
    const r = parseRate(v.rate)!;
    assertEquals(formatTimecode(v.frame, r, v.drop), v.tc, `${v.rate} drop=${v.drop} frame ${v.frame}`);
    assertEquals(parseTimecode(v.tc, r), { frame: v.frame, drop: v.drop }, `${v.rate} ${v.tc}`);
  }
});

Deno.test("Drop-Frame: vollständiger Rundlauf", () => {
  const r = parseRate("30000/1001")!;
  for (let f = 0; f < 2_000_000; f += 7) {
    const tc = formatTimecode(f, r, true);
    assertEquals(parseTimecode(tc, r)?.frame, f, `${f} → ${tc}`);
  }
});

Deno.test("Timecode: ungültige Eingaben und nicht existierende Drop-Frame-Werte", () => {
  const r25 = parseRate("25")!;
  for (const bad of ["00:00:00:25", "00:60:00:00", "00:00:60:00", "0:00:00:00", "00:00:00;00", "abc", ""]) assertEquals(parseTimecode(bad, r25), null, bad);
  const ndf = parseRate("30000/1001")!;
  assertEquals(parseTimecode("00:01:00;00", ndf), null);
  assertEquals(parseTimecode("00:10:00;00", ndf)?.frame, 17982);
  assertEquals(parseRate("60000/2002"), { num: 30000, den: 1001 });
  assertEquals(parseRate("0"), null);
});

Deno.test("Start-Timecode ≠ 0 und Bereiche [in, out)", () => {
  const r = parseRate("25")!;
  const tl: Timeline = { rate: r, durationFrames: 500, startFrames: parseTimecode("10:00:00:00", r)!.frame, dropFrame: false };
  assertEquals(timecodeOf(tl, 0), "10:00:00:00");
  assertEquals(timecodeOf(tl, 499), "10:00:19:24");
  assertEquals(frameForTimecode(tl, "10:00:10:00"), 250);
  assertEquals(frameForTimecode(tl, "09:59:59:24"), null);
  assertEquals(validateRange(tl, 0, 500), null); // Out exklusiv: Dauer ist erlaubt
  assertEquals(validateRange(tl, 0, 501), "range.after");
  assertEquals(validateRange(tl, -1, 10), "range.before");
  assertEquals(validateRange(tl, 10, 10), "range.short");
  assertEquals(validateRange(tl, 0, 5, 10), "range.short");
});

Deno.test("Frame ↔ Medienzeit: Mitte des Bildes, kein Springen auf Nachbarbilder (auch 29.97)", () => {
  for (const rs of ["25", "30000/1001", "24000/1001", "50", "60000/1001"]) {
    const r = parseRate(rs)!;
    for (const n of [0, 1, 2, 29, 30, 1799, 1800, 107892]) {
      assertEquals(frameForTime(timeForFrame(n, r), r), n, `${rs} frame ${n}`);
      assertEquals(frameForPts((n * r.den) / r.num, r), n, `${rs} pts ${n}`);
    }
  }
});
