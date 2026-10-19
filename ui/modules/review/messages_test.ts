import "./test-setup.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { messages } from "./messages.ts";

Deno.test("Review-Texte: Deutsch und Englisch haben dieselben Schlüssel und Platzhalter", () => {
  assertEquals(Object.keys(messages.de).sort(), Object.keys(messages.en).sort());
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(messages.de)) assertEquals(ph(messages.de[k]), ph(messages.en[k]), k);
});
