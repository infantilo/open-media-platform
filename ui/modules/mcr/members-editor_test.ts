import { assertEquals } from "jsr:@std/assert";
import { type Member, normalizeMembers } from "./members-editor.ts";

Deno.test("Mitglieder: Doppelte zusammenfassen, stärkere Rolle gewinnt, Leere weg", () => {
  const list: Member[] = [
    { subjectType: "user", subject: "tom", role: "viewer" },
    { subjectType: "user", subject: " tom ", role: "engineer" },
    { subjectType: "group", subject: "tom", role: "viewer" }, // gleiche Schreibweise, andere Art: bleibt
    { subjectType: "user", subject: "  ", role: "lead" },
  ];
  assertEquals(normalizeMembers(list), [
    { subjectType: "user", subject: "tom", role: "engineer" },
    { subjectType: "group", subject: "tom", role: "viewer" },
  ]);
});
