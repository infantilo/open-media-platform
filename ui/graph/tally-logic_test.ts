import { assertEquals } from "jsr:@std/assert@1";
import { TallyBoard, tallyLabel } from "./tally-logic.ts";

Deno.test("zwei Geber: Quelle bleibt an, bis der letzte abschaltet", () => {
  const b = new TallyBoard();
  assertEquals(b.apply("cam", true, "mixA"), true);
  assertEquals(b.apply("cam", true, "mixB"), false);
  assertEquals(b.givers("cam"), ["mixA", "mixB"]);
  assertEquals(b.apply("cam", false, "mixA"), false);
  assertEquals(b.isOn("cam"), true);
  assertEquals(b.apply("cam", false, "mixB"), true);
  assertEquals(b.isOn("cam"), false);
});

Deno.test("Ereignisse ohne Geber zählen als ein namenloser Geber; unbekanntes Aus ist harmlos", () => {
  const b = new TallyBoard();
  assertEquals(b.apply("cam", false, "x"), false);
  assertEquals(b.apply("cam", true), true);
  assertEquals(b.apply("cam", true, "mixB"), false);
  assertEquals(b.apply("cam", false), false);
  assertEquals(b.givers("cam"), ["mixB"]);
});

Deno.test("verschwundener Geber wird überall entfernt", () => {
  const b = new TallyBoard();
  b.apply("cam1", true, "mixA");
  b.apply("cam2", true, "mixA");
  b.apply("cam2", true, "mixB");
  assertEquals(b.dropGiver("mixA"), true);
  assertEquals([b.isOn("cam1"), b.isOn("cam2")], [false, true]);
  assertEquals(b.dropGiver("mixA"), false);
});

Deno.test("Kachel-Beschriftung: Anzahl und Namen", () => {
  const name = (id: string) => ({ a: "Mischer 1", b: "Mischer 2" } as Record<string, string>)[id];
  assertEquals(tallyLabel(["a"], name), { badge: "PGM", tooltip: "Mischer 1" });
  assertEquals(tallyLabel(["a", "b"], name), { badge: "PGM ×2", tooltip: "Mischer 1, Mischer 2" });
  assertEquals(tallyLabel(["", "zzzzzzzzzzzz"], name), { badge: "PGM ×2", tooltip: "?, zzzzzzzz" });
});
