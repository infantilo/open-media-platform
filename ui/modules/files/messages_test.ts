import { assertEquals } from "jsr:@std/assert@1";
import { messages } from "./messages.ts";

Deno.test("de und en haben dieselben Schlüssel und Platzhalter", () => {
  assertEquals(Object.keys(messages.de).sort(), Object.keys(messages.en).sort());
  const ph = (s: string) => (s.match(/\{p\d\}/g) ?? []).sort().join(",");
  for (const k of Object.keys(messages.de)) assertEquals(ph(messages.de[k]), ph(messages.en[k]), k);
});
