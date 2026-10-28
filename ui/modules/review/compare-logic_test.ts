import { assertEquals } from "jsr:@std/assert";
import { compareOptions, sortChecks, statusColor } from "./compare-logic.ts";

Deno.test("Vergleichsoptionen: leere und ungültige Felder entfallen, Komma wird akzeptiert", () => {
  assertEquals(compareOptions({ offsetSec: "", durationTolMs: "", ssimMin: "", sampleSec: "", skipQuality: false, autoOffset: false }), {});
  assertEquals(compareOptions({ offsetSec: "", durationTolMs: "", ssimMin: "", sampleSec: "", skipQuality: false, autoOffset: true }), { autoOffset: true });
  assertEquals(compareOptions({ offsetSec: "0,5", durationTolMs: "1500", ssimMin: "0.9", sampleSec: "5", skipQuality: true, autoOffset: false }), {
    offsetSec: 0.5,
    durationTolMs: 1500,
    ssimMin: 0.9,
    sampleSec: 5,
    skipQuality: true,
  });
  assertEquals(compareOptions({ offsetSec: "x", durationTolMs: "-3", ssimMin: "7", sampleSec: "0", skipQuality: false, autoOffset: false }), {});
});

Deno.test("Ergebniszeilen: Fehler zuerst, Übersprungenes zuletzt; Farben", () => {
  const mk = (id: string, status: "pass" | "fail" | "warn" | "skipped") => ({ id, label: id, status, message: "" });
  assertEquals(sortChecks([mk("a", "skipped"), mk("b", "pass"), mk("c", "fail"), mk("d", "warn")]).map((c) => c.id), ["c", "d", "b", "a"]);
  assertEquals(statusColor("fail").includes("error"), true);
  assertEquals(statusColor("egal"), "var(--omp-text-dim)");
});
