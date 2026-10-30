import { assertEquals } from "jsr:@std/assert";
import { buildStartBody, emptyMeaning, filledOptions, needsDialogFields } from "./start-dialog-logic.ts";

const empty = { name: "", hostId: "", ioCardType: "", ioPorts: [], options: {} };

Deno.test("Startkörper: nur Gesetztes wird gesendet", () => {
  assertEquals(buildStartBody("omp-source", undefined, empty), { type: "omp-source" });
  assertEquals(
    buildStartBody("omp-capture-card", "1.2", { name: "  Kamera 3 ", hostId: "h1", ioCardType: "decklink", ioPorts: ["decklink-0-in", "decklink-0-out"], options: { A: " 5 ", B: "  ", C: "x" } }),
    { type: "omp-capture-card", version: "1.2", hostId: "h1", label: "Kamera 3", requiredIoPort: { cardType: "decklink", ports: ["decklink-0-in", "decklink-0-out"] }, options: { A: "5", C: "x" } },
  );
});

Deno.test("Optionen: leere und Leerzeichen-Felder fallen weg", () => {
  assertEquals(filledOptions({ a: "", b: " ", c: " x " }), { c: "x" });
});

Deno.test("Leeres Feld bedeutet Typ-Wert, sonst Standard", () => {
  assertEquals(emptyMeaning({ value: "/mnt/a", default: "/mnt/b" }), { text: "/mnt/a", source: "type" });
  assertEquals(emptyMeaning({ default: "/mnt/b" }), { text: "/mnt/b", source: "default" });
  assertEquals(emptyMeaning({}), { text: "", source: "node" });
});

Deno.test("Dialogfelder nötig, wenn Hosts, Optionen oder I/O-Port da sind", () => {
  assertEquals(needsDialogFields(false, 0, false), false);
  assertEquals(needsDialogFields(true, 0, false), true);
  assertEquals(needsDialogFields(false, 2, false), true);
  assertEquals(needsDialogFields(false, 0, true), true);
});

import { findPairs, presetFor, valuesForPreset } from "./start-dialog-logic.ts";

Deno.test("Paare: Auflösung und Bildrate mit gleichem Präfix, andere Optionen bleiben einzeln", () => {
  assertEquals(findPairs(["OMP_WIDTH", "OMP_HEIGHT", "OMP_FRAMERATE_NUM", "OMP_FRAMERATE_DEN", "OMP_SOURCE_PATTERN"]), [
    { kind: "resolution", first: "OMP_WIDTH", second: "OMP_HEIGHT", prefix: "OMP" },
    { kind: "rate", first: "OMP_FRAMERATE_NUM", second: "OMP_FRAMERATE_DEN", prefix: "OMP_FRAMERATE" },
  ]);
  assertEquals(findPairs(["OMP_2110_GATEWAY_WIDTH", "OMP_2110_GATEWAY_HEIGHT"]).length, 1);
  assertEquals(findPairs(["OMP_WIDTH"]), []); // ohne Gegenstück kein Paar
  assertEquals(findPairs(["A_WIDTH", "B_HEIGHT"]), []); // verschiedene Präfixe
});

Deno.test("Voreinstellungen: erkennen und anwenden", () => {
  assertEquals(presetFor("resolution", "", ""), "");
  assertEquals(presetFor("resolution", "1920", "1080"), "1");
  assertEquals(presetFor("resolution", "1000", "700"), "custom");
  assertEquals(presetFor("rate", "30000", "1001"), "3");
  assertEquals(presetFor("rate", "25", "1"), "2");
  assertEquals(valuesForPreset("resolution", "1"), ["1920", "1080"]);
  assertEquals(valuesForPreset("rate", "3"), ["30000", "1001"]);
  assertEquals(valuesForPreset("rate", ""), ["", ""]);
  assertEquals(valuesForPreset("rate", "custom"), null);
  assertEquals(valuesForPreset("rate", "99"), null);
});
