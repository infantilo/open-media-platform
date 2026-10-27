import { assertEquals } from "jsr:@std/assert";
import { coverageKey, findFinding, findingId, formatMetric, sparkline, type TrendFinding, type TrendReport } from "./trends-logic.ts";

const at = (h: number) => new Date(Date.UTC(2026, 9, 28, h)).toISOString();

Deno.test("formatMetric: Prozent, Bytes, Anzahl", () => {
  assertEquals(formatMetric(85.4, "%"), "85 %");
  assertEquals(formatMetric(700 * (1 << 20), "B"), "700 MiB");
  assertEquals(formatMetric(2.5 * (1 << 30), "B"), "2.5 GiB");
  assertEquals(formatMetric(512 * 1024, "B"), "512 KiB");
  assertEquals(formatMetric(41.6), "42");
});

Deno.test("findingId/findFinding: Subjekt mit Doppelpunkten, Zuordnung zum Befund des Selbsttests", () => {
  const f: TrendFinding = { subject: "instance:omp-source:Kamera 1", label: "Kamera 1", metric: "proc.rss", kind: "drift", value: 1, baseline: 0 };
  assertEquals(findingId(f), "trend:instance:omp-source:Kamera 1:proc.rss:drift");
  const rep: TrendReport = { analyzedAt: "", findings: [f], seriesChecked: 3, coverageHours: 100 };
  assertEquals(findFinding(rep, "trend:instance:omp-source:Kamera 1:proc.rss:drift"), f);
  assertEquals(findFinding(rep, "trend:instance:omp-source:Kamera 1:proc.rss:deviation"), undefined);
  assertEquals(findFinding(rep, "disk:/"), undefined);
  assertEquals(findFinding(null, "trend:x"), undefined);
});

Deno.test("sparkline: Koordinaten im Bild, y nach unten, Vergleichslinie", () => {
  assertEquals(sparkline(undefined, 0, 100, 20), null);
  assertEquals(sparkline([{ t: at(0), avg: 1, max: 1 }], 0, 100, 20), null);
  const s = sparkline([{ t: at(0), avg: 10, max: 10 }, { t: at(1), avg: 20, max: 20 }, { t: at(2), avg: 30, max: 30 }], 10, 100, 20, 0)!;
  assertEquals(s.line, "M0.0,20.0 L50.0,10.0 L100.0,0.0");
  assertEquals([s.lastX, s.lastY, s.baselineY], [100, 0, 20]);
  // konstanter Verlauf teilt nicht durch Null
  const flat = sparkline([{ t: at(0), avg: 5, max: 5 }, { t: at(1), avg: 5, max: 5 }], 5, 100, 20)!;
  assertEquals(Number.isFinite(flat.lastY), true);
});

Deno.test("coverageKey: keine Daten, im Aufbau, bereit (72 Stunden)", () => {
  assertEquals(coverageKey(null), "none");
  assertEquals(coverageKey({ analyzedAt: "", findings: [], seriesChecked: 0, coverageHours: 0 }), "none");
  assertEquals(coverageKey({ analyzedAt: "", findings: [], seriesChecked: 4, coverageHours: 10 }), "building");
  assertEquals(coverageKey({ analyzedAt: "", findings: [], seriesChecked: 4, coverageHours: 72 }), "ready");
});
