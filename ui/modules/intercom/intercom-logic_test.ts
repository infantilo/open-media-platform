import { assertEquals } from "jsr:@std/assert";
import "./test-setup.ts";
import {
  addChannel, addParty, cleanConfig, type Config, getRoute, guestRoutes, localProblems, nextId, removeChannel, removeParty, sameConfig, setRoute,
  splitList,
} from "./intercom-logic.ts";

const base = (): Config => ({ channels: [], parties: [] });

Deno.test("IDs laufen fort und füllen keine Lücken", () => {
  const c = base();
  const a = addChannel(c, "Regie");
  const b = addChannel(c, "Technik");
  assertEquals([a.id, b.id], [1, 2]);
  removeChannel(c, 1);
  assertEquals(addChannel(c, "Studio").id, 3);
  assertEquals(nextId([]), 1);
});

Deno.test("Kanal löschen entfernt die Zuordnungen bei allen Teilnehmern", () => {
  const c = base();
  const ch1 = addChannel(c, "A");
  const ch2 = addChannel(c, "B");
  const p = addParty(c, "Regie 1");
  setRoute(p, ch1.id, "talk", true);
  setRoute(p, ch2.id, "listen", true);
  removeChannel(c, ch1.id);
  assertEquals(p.routes.map((r) => r.ch), [ch2.id]);
});

Deno.test("Matrix: beides aus entfernt die Zuordnung", () => {
  const p = addParty(base(), "P");
  setRoute(p, 1, "talk", true);
  setRoute(p, 1, "listen", true);
  assertEquals(getRoute(p, 1), { ch: 1, talk: true, listen: true });
  setRoute(p, 1, "talk", false);
  assertEquals(getRoute(p, 1)?.listen, true);
  setRoute(p, 1, "listen", false);
  assertEquals(getRoute(p, 1), undefined);
});

Deno.test("Teilnehmer löschen", () => {
  const c = base();
  const p = addParty(c, "X");
  addParty(c, "Y");
  removeParty(c, p.id);
  assertEquals(c.parties.map((x) => x.name), ["Y"]);
});

Deno.test("Listen aus Text", () => {
  assertEquals(splitList(" anna, bob ,, "), ["anna", "bob"]);
  assertEquals(splitList(""), []);
});

Deno.test("Aufräumen: Namen trimmen, leere Listen und Gäste entfernen, Zuordnungen sortieren", () => {
  const c: Config = {
    channels: [{ id: 1, name: " Regie " }],
    parties: [{ id: 1, name: " P ", users: [], groups: [], routes: [{ ch: 2, talk: true, listen: false }, { ch: 1, talk: false, listen: true }, { ch: 3, talk: false, listen: false }] }],
    guests: [{ id: 100000, name: "g", expires: "", routes: [] }],
  };
  const o = cleanConfig(c);
  assertEquals(o.channels[0].name, "Regie");
  assertEquals(o.parties[0].name, "P");
  assertEquals(o.parties[0].routes.map((r) => r.ch), [1, 2]);
  assertEquals("users" in o.parties[0], false);
  assertEquals("guests" in o, false);
  assertEquals(c.parties[0].routes.length, 3, "Original bleibt unverändert");
});

Deno.test("Vorab-Prüfung findet leere und doppelte Namen", () => {
  const c: Config = { channels: [{ id: 1, name: "A" }, { id: 2, name: "a" }, { id: 3, name: " " }], parties: [{ id: 1, name: "", routes: [] }] };
  assertEquals(localProblems(c).length, 3);
  assertEquals(localProblems({ channels: [{ id: 1, name: "A" }], parties: [] }), []);
});

Deno.test("Gast-Zuordnungen und Änderungserkennung", () => {
  assertEquals(guestRoutes(new Set([3, 1]), false), [{ ch: 1, talk: false, listen: true }, { ch: 3, talk: false, listen: true }]);
  const a: Config = { channels: [{ id: 1, name: "A" }], parties: [] };
  const b: Config = { channels: [{ id: 1, name: " A" }], parties: [], guests: [] };
  assertEquals(sameConfig(a, b), true);
  b.channels[0].name = "B";
  assertEquals(sameConfig(a, b), false);
});
