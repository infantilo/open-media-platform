import { assertEquals } from "jsr:@std/assert@1";
import { filterOptions } from "./workflow-picker.ts";

const L = [{ id: "a1", label: "Abend-Sendung HD" }, { id: "b2", label: "Radio Morgen" }, { id: "c3", label: "Abend Radio" }];

Deno.test("filterOptions: leer = alle, Wörter UND-verknüpft, ohne Groß/Klein", () => {
  assertEquals(filterOptions(L, "").length, 3);
  assertEquals(filterOptions(L, "ABEND").map((o) => o.id), ["a1", "c3"]);
  assertEquals(filterOptions(L, "abend radio").map((o) => o.id), ["c3"]);
  assertEquals(filterOptions(L, "b2").map((o) => o.id), ["b2"]);
  assertEquals(filterOptions(L, "zzz"), []);
});
