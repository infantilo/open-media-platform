import { assertEquals } from "jsr:@std/assert";
import { limitNote, MAX_NOTE } from "./note-logic.ts";

Deno.test("Notiz wird getrimmt und auf 200 Zeichen begrenzt", () => {
  assertEquals(limitNote("  Bild weg  "), "Bild weg");
  assertEquals(limitNote(""), "");
  assertEquals([...limitNote("ä".repeat(300))].length, MAX_NOTE);
});
