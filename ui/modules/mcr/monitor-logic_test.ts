import { assertEquals } from "jsr:@std/assert";
import { effectiveHold, isCustomized, profileHold, withHold } from "./monitor-logic.ts";

Deno.test("Profil → Dauer", () => {
  assertEquals(profileHold("", "black"), 3);
  assertEquals(profileHold("strict", "freeze"), 2);
  assertEquals(profileHold("off", "black"), null);
});
Deno.test("Abweichung vom Profil wird angezeigt, Rückkehr zum Profilwert entfernt sie", () => {
  let o = withHold("standard", {}, "black", 10);
  assertEquals(o, { "black.holdSeconds": 10 });
  assertEquals(isCustomized("standard", o), true);
  assertEquals(effectiveHold("standard", o, "black"), 10);
  o = withHold("standard", o, "black", 3);
  assertEquals(o, {});
  assertEquals(isCustomized("standard", o), false);
});
Deno.test("off: Abweichungen zählen nicht als angepasst", () => {
  assertEquals(isCustomized("off", { "black.holdSeconds": 9 }), false);
});
