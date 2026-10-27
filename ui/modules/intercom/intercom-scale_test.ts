import { assertEquals } from "jsr:@std/assert";
import "./test-setup.ts";
import { addChannel, addParty, type Config, getRoute, setRoute } from "./intercom-logic.ts";
import { addParties, copyRoutes, duplicateParty, filterChannels, filterParties, matrixStats, removeParties, setAllChannels, setForParties, visibleWindow } from "./intercom-scale.ts";

const base = (): Config => ({ channels: [], parties: [] });

Deno.test("Filter: Text, Art und Zuordnung", () => {
  const c = base();
  const ch = addChannel(c, "Regie");
  const a = addParty(c, "Kamera 1");
  const b = addParty(c, "Kamera 2");
  const r = addParty(c, "Regie");
  r.kind = "seat";
  setRoute(a, ch.id, "talk", true);
  assertEquals(filterParties(c.parties, { text: "kam", kind: "all" }).map((p) => p.name), ["Kamera 1", "Kamera 2"]);
  assertEquals(filterParties(c.parties, { text: "", kind: "seat" }).map((p) => p.name), ["Regie"]);
  assertEquals(filterParties(c.parties, { text: "", kind: "all", assigned: false }).map((p) => p.id), [b.id, r.id]);
  assertEquals(filterParties(c.parties, { text: "", kind: "all", assigned: true }).map((p) => p.id), [a.id]);
  assertEquals(filterChannels(c.channels, "REG").length, 1);
  assertEquals(filterChannels(c.channels, "x").length, 0);
});

Deno.test("Sichtbares Fenster: Puffer, Ränder und leere Liste", () => {
  assertEquals(visibleWindow(0, 300, 30, 1000, 2), { start: 0, end: 12 });
  assertEquals(visibleWindow(3000, 300, 30, 1000, 2), { start: 98, end: 112 });
  assertEquals(visibleWindow(29_900, 300, 30, 1000, 4), { start: 992, end: 1000 });
  assertEquals(visibleWindow(0, 300, 30, 0), { start: 0, end: 0 });
  assertEquals(visibleWindow(-50, 300, 30, 5, 0), { start: 0, end: 5 });
});

Deno.test("Sammelaktion setzt nur, was sich ändert, und zählt es", () => {
  const c = base();
  const ch = addChannel(c, "A");
  const ps = [addParty(c, "p1"), addParty(c, "p2"), addParty(c, "p3")];
  setRoute(ps[0], ch.id, "talk", true);
  assertEquals(setForParties(ps, ch.id, "talk", true), 2);
  assertEquals(setForParties(ps, ch.id, "talk", true), 0);
  assertEquals(setForParties(ps, ch.id, "talk", false), 3);
  assertEquals(ps.every((p) => p.routes.length === 0), true);
});

Deno.test("Zeile: alle Kanäle auf einmal", () => {
  const c = base();
  const chs = [addChannel(c, "A"), addChannel(c, "B")];
  const p = addParty(c, "p");
  setAllChannels(p, chs.map((x) => x.id), "listen", true);
  assertEquals(p.routes.map((r) => [r.ch, r.listen]), [[1, true], [2, true]]);
  setAllChannels(p, chs.map((x) => x.id), "listen", false);
  assertEquals(p.routes, []);
});

Deno.test("Zuordnungen kopieren ersetzt, ohne den Quellteilnehmer zu ändern", () => {
  const c = base();
  const ch = addChannel(c, "A");
  const src = addParty(c, "src");
  src.routes.push({ ch: ch.id, talk: true, listen: true, level: 0.5 });
  const t1 = addParty(c, "t1");
  t1.routes.push({ ch: 99, talk: true, listen: false });
  assertEquals(copyRoutes(src, [src, t1]), 1);
  assertEquals(t1.routes, [{ ch: ch.id, talk: true, listen: true, level: 0.5 }]);
  t1.routes[0].level = 0.1;
  assertEquals(src.routes[0].level, 0.5);
});

Deno.test("Sammelanlage: fortlaufende, eindeutige Namen, Deckel, Zuordnungen von Vorlage", () => {
  const c = base();
  const ch = addChannel(c, "A");
  addParty(c, "Kamera 2");
  const like = addParty(c, "Muster");
  setRoute(like, ch.id, "talk", true);
  const made = addParties(c, "Kamera", 3, "seat", like);
  assertEquals(made.map((p) => p.name), ["Kamera 1", "Kamera 3", "Kamera 4"]);
  assertEquals(made.every((p) => p.kind === "seat" && getRoute(p, ch.id)?.talk === true), true);
  assertEquals(new Set(c.parties.map((p) => p.id)).size, c.parties.length);
  assertEquals(addParties(c, "X", 100000, "human").length, 500);
  assertEquals(addParties(c, "Y", -3, "human").length, 0);
});

Deno.test("Duplizieren: neuer Name, gleiche Rechte, keine Nutzer", () => {
  const c = base();
  const ch = addChannel(c, "A");
  const p = addParty(c, "Regie 1");
  p.users = ["anna"];
  p.priority = 5;
  p.force = true;
  setRoute(p, ch.id, "talk", true);
  const d = duplicateParty(c, p.id)!;
  assertEquals(d.name, "Regie 2");
  assertEquals(d.priority, 5);
  assertEquals(d.force, true);
  assertEquals(d.users, undefined);
  assertEquals(getRoute(d, ch.id)?.talk, true);
  assertEquals(duplicateParty(c, 999), null);
});

Deno.test("Löschen mehrerer räumt Panel-Tasten auf", () => {
  const c = base();
  const a = addParty(c, "a");
  const b = addParty(c, "b");
  const keeper = addParty(c, "k");
  keeper.layout = { pages: [{ name: "", keys: [{ type: "call", party: a.id }, { type: "call", party: b.id }] }] };
  assertEquals(removeParties(c, new Set([a.id, b.id])), 2);
  assertEquals(keeper.layout.pages[0].keys, []);
});

Deno.test("Kennzahlen", () => {
  const c = base();
  const ch = addChannel(c, "A");
  const a = addParty(c, "a");
  addParty(c, "b");
  setRoute(a, ch.id, "talk", true);
  setRoute(a, ch.id, "listen", true);
  assertEquals(matrixStats(c), { parties: 2, channels: 1, unassigned: 1, routes: 1 });
});
