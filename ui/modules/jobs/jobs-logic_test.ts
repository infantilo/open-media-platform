import { assertEquals } from "jsr:@std/assert";
import { fmtDuration, fromPercent, loadLevel, pathMapFromRows, pathRows, targetOptions, toPercent, type HostInfo } from "./jobs-logic.ts";

const H = (id: string, local = false): HostInfo => ({ ID: id, Label: id, Local: local, Online: true, Capable: true, CPUPercent: 0, MemUsedPct: 0, MaxJobs: 2, Running: 0, Reserved: 0, LiveInstances: 0 });
const L = { auto: "Automatisch", local: "Orchestrator", host: "Host", pool: "Pool" };

Deno.test("Zielauswahl: auto, lokal, Hosts ohne lokalen Doppler, Pools, unbekanntes Ziel bleibt wählbar", () => {
  const o = targetOptions([H("local", true), H("a")], ["render"], "host:weg", L);
  assertEquals(o.map((x) => x.value), ["auto", "local", "host:a", "pool:render", "host:weg"]);
  assertEquals(targetOptions([], [], "auto", L).length, 2);
});

Deno.test("Pfadzuordnung: Zeilen ⇄ Objekt, leere Zeilen übersprungen, Fehler benannt", () => {
  const m = { "/data": { a: "/mnt/x", b: "/srv/y" } };
  assertEquals(pathMapFromRows(pathRows(m)).map, m);
  assertEquals(pathMapFromRows([{ prefix: "", host: "", hostPrefix: "" }]).map, {});
  assertEquals(pathMapFromRows([{ prefix: "data", host: "a", hostPrefix: "/x" }]).error !== undefined, true);
  assertEquals(pathMapFromRows([{ prefix: "/d", host: "", hostPrefix: "/x" }]).error !== undefined, true);
});

Deno.test("Prozent ↔ Anteil", () => {
  assertEquals(toPercent(0.3), 30);
  assertEquals(fromPercent(30), 0.3);
  assertEquals(fromPercent(toPercent(0.125)), 0.125);
});

Deno.test("Auslastungsstufe und Dauer", () => {
  assertEquals([loadLevel(50, 70), loadLevel(65, 70), loadLevel(70, 70), loadLevel(5, 0)], ["ok", "warn", "full", "ok"]);
  assertEquals([fmtDuration(65), fmtDuration(3723), fmtDuration(-4)], ["1:05", "1 h 02", "0:00"]);
});
