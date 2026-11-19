import { assertEquals } from "jsr:@std/assert";
import { type AccessRule, emptyLookups, modeOf, selectorLabel, sortRules, subjectLabel, validateDraft } from "./access-rules-logic.ts";

const lk = emptyLookups();
lk.groups.set("g-1", "Bildmeister");
lk.nodes.set("n-1", "Kamera Studio");

const base: AccessRule = { id: "1", subjectType: "global", kind: "source", action: "see", effect: "deny", selectorType: "all" };

Deno.test("Wer: Name statt ID", () => {
  assertEquals(subjectLabel({ subjectType: "global" }, lk), "Alle");
  assertEquals(subjectLabel({ subjectType: "group", subject: "g-1" }, lk), "Gruppe Bildmeister");
  assertEquals(subjectLabel({ subjectType: "user", subject: "anna" }, lk), "Nutzer anna");
  assertEquals(subjectLabel({ subjectType: "group", subject: "0123456789abcdef0123" }, lk), "Gruppe 01234567…");
});

Deno.test("Ziel: Selektor als Text", () => {
  assertEquals(selectorLabel({ selectorType: "all" }, lk), "alles");
  assertEquals(selectorLabel({ selectorType: "node", selectorValue: "n-1" }, lk), "Node Kamera Studio");
  assertEquals(selectorLabel({ selectorType: "tag", selectorValue: "role.kamera" }, lk), "Tag role.kamera");
  assertEquals(selectorLabel({ selectorType: "label", selectorValue: "Video*" }, lk), "Name „Video*“");
});

Deno.test("Betriebsart je Art und Handlung", () => {
  assertEquals(modeOf([], "source", "see"), "open");
  assertEquals(modeOf([base], "source", "see"), "blacklist");
  assertEquals(modeOf([base, { ...base, id: "2", effect: "allow" }], "source", "see"), "whitelist");
  assertEquals(modeOf([base], "sink", "see"), "open");
  assertEquals(modeOf([base], "source", "route"), "open");
});

Deno.test("Sortierung: alle, Gruppen, Nutzer", () => {
  const rules: AccessRule[] = [
    { ...base, id: "u", subjectType: "user", subject: "anna" },
    { ...base, id: "g", subjectType: "group", subject: "g-1" },
    { ...base, id: "a" },
  ];
  assertEquals(sortRules(rules, lk).map((r) => r.id), ["a", "g", "u"]);
});

Deno.test("Formularprüfung", () => {
  assertEquals(validateDraft({ subjectType: "global", selectorType: "all" }), null);
  assertEquals(validateDraft({ subjectType: "user", subject: " ", selectorType: "all" }), "subject");
  assertEquals(validateDraft({ subjectType: "global", selectorType: "node", selectorValue: "" }), "value");
  assertEquals(validateDraft({ subjectType: "group", subject: "g", selectorType: "tag", selectorValue: "x" }), null);
});
