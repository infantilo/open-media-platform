import { assertEquals } from "jsr:@std/assert";
import { buildStartBody, emptyMeaning, filledOptions, needsDialogFields } from "./start-dialog-logic.ts";

const empty = { name: "", hostId: "", ioDirection: "" as const, options: {} };

Deno.test("Startkörper: nur Gesetztes wird gesendet", () => {
  assertEquals(buildStartBody("omp-source", undefined, empty), { type: "omp-source" });
  assertEquals(
    buildStartBody("omp-decklink", "1.2", { name: "  Kamera 3 ", hostId: "h1", ioDirection: "in", options: { A: " 5 ", B: "  ", C: "x" } }),
    { type: "omp-decklink", version: "1.2", hostId: "h1", label: "Kamera 3", requiredIoPort: { cardType: "decklink", direction: "in" }, options: { A: "5", C: "x" } },
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
