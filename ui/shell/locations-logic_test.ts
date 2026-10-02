import { assertEquals } from "jsr:@std/assert";
import { describeCheck } from "./locations-logic.ts";

Deno.test("describeCheck: lesbar mit Platz, nicht lesbar, Hostfehler, ungeprüft", () => {
  assertEquals(
    describeCheck({ check: { exists: true, readable: true, entries: 12, freeBytes: 5 * 2 ** 30, totalBytes: 10 * 2 ** 30, message: "" } }),
    { ok: true, text: "lesbar, 12 Einträge · frei 5.0 GB von 10.0 GB" },
  );
  assertEquals(describeCheck({ check: { exists: false, readable: false, message: "Pfad existiert nicht" } }), { ok: false, text: "Pfad existiert nicht" });
  assertEquals(describeCheck({ checkError: "Host nicht erreichbar: timeout" }), { ok: false, text: "Host nicht erreichbar: timeout" });
  assertEquals(describeCheck({}), { ok: false, text: "nicht geprüft" });
});
