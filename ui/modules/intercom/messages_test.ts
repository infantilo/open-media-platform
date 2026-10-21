import { assertEquals } from "jsr:@std/assert";
import { messages } from "./messages.ts";

Deno.test("Intercom: Deutsch und Englisch haben dieselben Schlüssel und Platzhalter", () => {
  const de = Object.keys(messages.de).sort();
  const en = Object.keys(messages.en).sort();
  assertEquals(en, de);
  for (const k of de) {
    const ph = (s: string) => (s.match(/\{p\d\}/g) ?? []).sort();
    assertEquals(ph(messages.en[k]), ph(messages.de[k]), `Platzhalter in ${k}`);
  }
});
