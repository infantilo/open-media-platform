import { assertEquals } from "jsr:@std/assert";
import { de } from "./i18n/de.ts";
import { en } from "./i18n/en.ts";
import { setLang, t } from "./i18n.ts";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

Deno.test("de und en haben dieselben Schlüssel", () => {
  assertEquals(Object.keys(en).sort(), Object.keys(de).sort());
});

Deno.test("Platzhalter sind in beiden Sprachen identisch, kein Text leer", () => {
  for (const k of Object.keys(de) as (keyof typeof de)[]) {
    assertEquals(placeholders(en[k]), placeholders(de[k]), `Platzhalter von ${k}`);
    if (!de[k].trim() || !en[k].trim()) throw new Error(`leerer Text bei ${k}`);
  }
});

Deno.test("t(): Sprache, Parameter, Fallback auf Schlüssel", () => {
  setLang("de", false);
  assertEquals(t("auth.loggedInAs", { user: "ann" }), "Angemeldet als ann");
  setLang("en", false);
  assertEquals(t("auth.loggedInAs", { user: "ann" }), "Signed in as ann");
  assertEquals(t("nicht.vorhanden" as never), "nicht.vorhanden");
  setLang("de", false);
});
