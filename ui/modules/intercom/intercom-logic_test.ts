import { assertEquals } from "jsr:@std/assert";
import "./test-setup.ts";
import {
  addKey, addPage, addTemplate, cleanLayout, keyCaption, layoutFromAssignment, layoutMode, moveKey, movePage, newLayout, pruneLayouts, removeKey, removePage, removeTemplate, MAX_KEYS, MAX_PAGES,
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

Deno.test("MXL-Anschlüsse: 0 und Anschlüsse bei Menschen werden entfernt", () => {
  const c: Config = {
    channels: [],
    parties: [
      { id: 1, name: "Prog", kind: "program", mxl_in: 1, mxl_out: 0, routes: [] },
      { id: 2, name: "Mensch", kind: "human", mxl_in: 3, routes: [] },
    ],
  };
  const o = cleanConfig(c);
  assertEquals(o.parties[0].mxl_in, 1);
  assertEquals("mxl_out" in o.parties[0], false);
  assertEquals("mxl_in" in o.parties[1], false);
});

const cfgWith = (): Config => {
  const c: Config = { channels: [], parties: [] };
  addChannel(c, "Regie");
  addChannel(c, "Technik");
  const a = addParty(c, "Kamera 1");
  addParty(c, "Ton");
  setRoute(a, 1, "talk", true);
  setRoute(a, 2, "listen", true);
  return c;
};

Deno.test("Layout: Seiten und Tasten anlegen, verschieben, entfernen", () => {
  const l = newLayout();
  assertEquals(l.pages.length, 1);
  const k1 = addKey(l, 0, "channel", 1)!;
  addKey(l, 0, "call", 2);
  addKey(l, 0, "mute");
  assertEquals(k1, { type: "channel", ch: 1, style: "strip" });
  moveKey(l, 0, 0, 1);
  assertEquals(l.pages[0].keys.map((k) => k.type), ["call", "channel", "mute"]);
  moveKey(l, 0, 0, -1); // am Rand: keine Wirkung
  assertEquals(l.pages[0].keys[0].type, "call");
  removeKey(l, 0, 0);
  assertEquals(l.pages[0].keys.length, 2);
  addPage(l)!.name = "Zwei";
  movePage(l, 1, -1);
  assertEquals(l.pages[0].name, "Zwei");
  removePage(l, 0);
  removePage(l, 0); // die letzte bleibt
  assertEquals(l.pages.length, 1);
});

Deno.test("Layout: Grenzen für Seiten und Tasten", () => {
  const l = newLayout();
  for (let i = 1; i < MAX_PAGES; i++) addPage(l);
  assertEquals(addPage(l), null);
  for (let i = 0; i < MAX_KEYS; i++) addKey(l, 0, "mute");
  assertEquals(addKey(l, 0, "mute"), null);
  assertEquals(addKey(l, 99, "mute"), null);
});

Deno.test("Layout aus Zuteilung: Kanäle des Teilnehmers, dann Rufen-Tasten der anderen", () => {
  const c = cfgWith();
  const l = layoutFromAssignment(c.parties[0], c);
  assertEquals(l.pages[0].keys, [{ type: "channel", ch: 1, style: "strip" }, { type: "channel", ch: 2, style: "strip" }, { type: "call", party: 2 }]);
});

Deno.test("Layout: Kanal/Teilnehmer löschen räumt Tasten und Vorlagen-Verweise auf", () => {
  const c = cfgWith();
  const l = layoutFromAssignment(c.parties[0], c);
  c.parties[0].layout = l;
  const t = addTemplate(c, "Kamera");
  addKey(t.layout, 0, "channel", 2);
  c.parties[1].template = t.id;
  removeChannel(c, 2);
  assertEquals(c.parties[0].layout!.pages[0].keys.map((k) => k.ch ?? k.party), [1, 2]);
  assertEquals(t.layout.pages[0].keys.length, 0);
  removeParty(c, 2);
  assertEquals(c.parties[0].layout!.pages[0].keys.map((k) => k.type), ["channel"]);
  removeTemplate(c, t.id);
  assertEquals(c.templates, []);
  c.parties[0].template = 99;
  pruneLayouts(c);
  assertEquals(c.parties[0].template, undefined);
});

Deno.test("Layout bereinigen: leere Layouts entfallen, Namen/Beschriftungen werden getrimmt, Stil nur bei Kanälen", () => {
  assertEquals(cleanLayout(newLayout()), undefined);
  assertEquals(cleanLayout(undefined), undefined);
  const l = newLayout();
  addKey(l, 0, "channel", 1)!.label = "  Regie  ";
  addKey(l, 0, "mute");
  l.pages[0].keys[1].style = "key";
  addPage(l);
  const o = cleanLayout(l)!;
  assertEquals(o.pages.map((p) => p.name), ["1", "2"]);
  assertEquals(o.pages[0].keys, [{ type: "channel", ch: 1, style: "strip", label: "Regie" }, { type: "mute" }]);
});

Deno.test("Layout in cleanConfig: eigenes Layout bleibt, leeres entfällt, Vorlagen werden bereinigt", () => {
  const c = cfgWith();
  c.parties[0].layout = layoutFromAssignment(c.parties[0], c);
  c.parties[1].layout = newLayout();
  const t = addTemplate(c, " Vorlage ");
  addKey(t.layout, 0, "dnd");
  c.parties[1].template = t.id;
  const o = cleanConfig(c);
  assertEquals(o.parties[0].layout!.pages[0].keys.length, 3);
  assertEquals("layout" in o.parties[1], false);
  assertEquals(o.parties[1].template, t.id);
  assertEquals(o.templates![0].name, "Vorlage");
  assertEquals(layoutMode(c.parties[0]), "own");
  assertEquals(layoutMode({ id: 3, name: "x", routes: [], template: 1 }), "template");
  assertEquals(layoutMode({ id: 3, name: "x", routes: [] }), "default");
});

Deno.test("Tastenbeschriftung: eigene, sonst Kanal-/Teilnehmername, sonst Art", () => {
  const c = cfgWith();
  const tl = (t: string) => `<${t}>`;
  assertEquals(keyCaption({ type: "channel", ch: 1, label: "REGIE" }, c, tl), "REGIE");
  assertEquals(keyCaption({ type: "channel", ch: 2 }, c, tl), "Technik");
  assertEquals(keyCaption({ type: "call", party: 2 }, c, tl), "Ton");
  assertEquals(keyCaption({ type: "mute" }, c, tl), "<mute>");
  assertEquals(keyCaption({ type: "channel", ch: 9 }, c, tl), "#9");
});

Deno.test("Vorlagennamen: doppelte werden gemeldet", () => {
  const c = cfgWith();
  addTemplate(c, "A");
  addTemplate(c, "a");
  assertEquals(localProblems(c).length, 1);
});
