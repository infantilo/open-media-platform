import { assertEquals } from "jsr:@std/assert";
import { chartPaths, hasData, nearest, series, unitOf, yMax } from "./host-trend-logic.ts";

const T = (m: number) => new Date(Date.UTC(2026, 9, 23, 12, m)).toISOString();

Deno.test("Reihen je Auflösung und Messgröße", () => {
  const raw = { resolution: "raw" as const, samples: [{ timestamp: T(0), cpuPercent: 10, memPercent: 20, liveCpuCores: 2, gpuPercent: 5 }, { timestamp: T(1), cpuPercent: 30, memPercent: 25, liveCpuCores: 4 }] };
  assertEquals(series(raw, "cpu").map((p) => p.avg), [10, 30]);
  assertEquals(series(raw, "live", 8).map((p) => p.avg), [25, 50]); // Kerne → % des Hosts
  assertEquals(series(raw, "live").map((p) => p.avg), [2, 4]); // ohne Kernzahl: Kerne
  assertEquals(series(raw, "gpu").map((p) => p.max), [5, 0]);
  const agg = { resolution: "aggregate" as const, aggregates: [{ bucketStart: T(0), cpuAvg: 10, cpuMax: 40, memAvg: 1, memMax: 2, netMax: 7 }] };
  assertEquals([series(agg, "cpu")[0].avg, series(agg, "cpu")[0].max, series(agg, "net")[0].max], [10, 40, 7]);
  const hr = { resolution: "hourly" as const, hours: [{ hour: T(0), cpuAvg: 12, cpuMax: 60, memAvg: 3, memMax: 9, liveCpuCoresAvg: 1, liveCpuCoresMax: 3 }] };
  assertEquals([series(hr, "mem")[0].max, series(hr, "live", 4)[0].avg, series(hr, "live", 4)[0].max], [9, 25, 75]);
  assertEquals(series(null, "cpu"), []);
});

Deno.test("Messwerte vorhanden? Achsenobergrenze", () => {
  assertEquals(hasData([{ t: 0, avg: 0, max: 0 }]), false);
  assertEquals(hasData([{ t: 0, avg: 0, max: 3 }]), true);
  assertEquals([yMax([{ t: 0, avg: 3, max: 8 }], true), yMax([{ t: 0, avg: 30, max: 60 }], true), yMax([{ t: 0, avg: 0, max: 300 }], true), yMax([{ t: 0, avg: 1, max: 5.2 }], false)], [10, 100, 100, 6]);
});

Deno.test("Pfade: Linie bei Mittel, Band bis Spitze, Nächster Punkt", () => {
  const pts = [{ t: 0, avg: 50, max: 100 }, { t: 100, avg: 0, max: 50 }];
  const c = chartPaths(pts, 200, 100, 100);
  assertEquals(c.line, "M0.0,50.0 L200.0,100.0");
  assertEquals(c.band.startsWith("M0.0,0.0 L200.0,50.0"), true);
  assertEquals(nearest(pts, 190, 200)!.t, 100);
  assertEquals(chartPaths([], 1, 1, 1).line, "");
});

Deno.test("Temperatur und Leistung: eigene Reihen, nicht gemessen = 0, Achse in °C/W", () => {
  const raw = {
    resolution: "raw" as const,
    samples: [
      { timestamp: "2026-10-28T10:00:00Z", cpuPercent: 10, memPercent: 20, tempC: 61.5, powerW: 18 },
      { timestamp: "2026-10-28T10:00:05Z", cpuPercent: 12, memPercent: 20, tempC: 66, powerW: 22 },
      { timestamp: "2026-10-28T10:00:10Z", cpuPercent: 12, memPercent: 20 },
    ],
  };
  assertEquals(series(raw, "temp").map((p) => p.avg), [61.5, 66, 0]);
  assertEquals(series(raw, "power").map((p) => p.avg), [18, 22, 0]);
  const hours = { resolution: "hourly" as const, hours: [{ hour: "2026-10-28T10:00:00Z", cpuAvg: 1, cpuMax: 2, memAvg: 1, memMax: 2, tempMax: 74, powerMax: 31 }] };
  assertEquals(series(hours, "temp")[0].max, 74);
  assertEquals(series(hours, "power")[0].max, 31);
  assertEquals(unitOf("temp", false), " °C");
  assertEquals(unitOf("power", true), " W");
  assertEquals(unitOf("live", false), "");
  assertEquals(unitOf("live", true), " %");
  assertEquals(yMax(series(raw, "temp"), false, true), 70);
  assertEquals(hasData(series({ resolution: "raw" as const, samples: [raw.samples[2]] }, "temp")), false);
});
