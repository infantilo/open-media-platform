import { assertEquals } from "jsr:@std/assert";
import { modelForPid } from "./models.ts";
import { composeLayout, DialCoalescer, tabSlots } from "./broker-logic.ts";
import { applyDial, buildDialItems, buildItems, type Descriptor, layoutAuto, nextEnum } from "./autoraster-logic.ts";

const XL = modelForPid(0x006c)!; // 8×4
const PLUS = modelForPid(0x0084)!; // 4×2
const tabs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Tab ${i}` }));

Deno.test("Kopfzeile: Home + Tabs, aktiver Tab hervorgehoben", () => {
  const c = composeLayout(XL, tabs(3), "t1", 0, { keys: [] }, 0);
  assertEquals(c.presses.slice(0, 5), [{ kind: "home" }, { kind: "tab", id: "t0" }, { kind: "tab", id: "t1" }, { kind: "tab", id: "t2" }, { kind: "none" }]);
  assertEquals(c.keys[2]?.state, "preset");
  assertEquals(c.keys[1]?.state, "off");
  assertEquals(c.keys[0]?.state, "off");
});

Deno.test("mehr Tabs als Tasten: Blättertaste, Seiten, richtiger Ausschnitt", () => {
  assertEquals(tabSlots(8, 7), 7);
  assertEquals(tabSlots(8, 8), 6);
  const c0 = composeLayout(XL, tabs(10), null, 0, null, 0);
  assertEquals(c0.tabPages, 2);
  assertEquals(c0.presses[6], { kind: "tab", id: "t5" });
  assertEquals(c0.presses[7], { kind: "tabPage" });
  assertEquals(c0.keys[7]?.label, "1/2");
  const c1 = composeLayout(XL, tabs(10), null, 1, null, 0);
  assertEquals(c1.presses[1], { kind: "tab", id: "t6" });
  assertEquals(c1.presses[4], { kind: "tab", id: "t9" });
  assertEquals(c1.presses[5], { kind: "none" });
  // Seitenzahl wird begrenzt
  assertEquals(composeLayout(XL, tabs(10), null, 9, null, 0).presses[1], { kind: "tab", id: "t6" });
});

Deno.test("Home: Tabs stehen nur in der Kopfzeile, darunter nur der Überlauf", () => {
  const c = composeLayout(XL, tabs(3), null, 0, null, 0);
  assertEquals(c.keys[0]?.state, "preset");
  assertEquals(c.presses.slice(8).every((p) => p.kind === "none"), true); // nichts doppelt
  // 10 Tabs, Kopfzeile Seite 1 zeigt t0–t5 → unten t6–t9
  const o = composeLayout(XL, tabs(10), null, 0, null, 0);
  assertEquals(o.presses[8], { kind: "tab", id: "t6" });
  assertEquals(o.presses[11], { kind: "tab", id: "t9" });
  assertEquals(o.presses[12], { kind: "none" });
});

Deno.test("Inhalt: Zellen ab Zeile 1, Seitentaste überschreibt letzte Taste", () => {
  const content = { keys: [[{ label: "A" }, null, { label: "C" }]], pages: 3 };
  const c = composeLayout(XL, tabs(1), "t0", 0, content, 1);
  assertEquals(c.presses[8], { kind: "content", row: 0, col: 0 });
  assertEquals(c.presses[9], { kind: "none" });
  assertEquals(c.presses[10], { kind: "content", row: 0, col: 2 });
  assertEquals(c.presses[31], { kind: "contentPage" });
  assertEquals(c.keys[31]?.label, "2/3");
  assertEquals(c.contentPages, 3);
});

Deno.test("„+“: eine Inhaltszeile, Dials durchgereicht", () => {
  const content = { keys: [[{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }], [{ label: "ZU VIEL" }]], dials: [{ label: "L", value: "1" }] };
  const c = composeLayout(PLUS, tabs(2), "t0", 0, content, 0);
  assertEquals(c.keys.length, 8);
  assertEquals(c.presses[4], { kind: "content", row: 0, col: 0 });
  assertEquals(c.presses[7], { kind: "content", row: 0, col: 3 });
  assertEquals(c.dials.length, 1);
  assertEquals(c.keys.some((k) => k?.label === "ZU VIEL"), false);
});

Deno.test("Dial-Zusammenfassung", () => {
  const d = new DialCoalescer();
  d.add(0, 1); d.add(0, 2); d.add(1, -1); d.add(2, 1); d.add(2, -1);
  assertEquals(d.take(), [[0, 3], [1, -1]]);
  assertEquals(d.take(), []);
});

const DESC: Descriptor = {
  parameters: [
    { name: "keyer.enabled", type: "boolean", readonly: false },
    { name: "status", type: "string", readonly: true },
    { name: "crosspoint.transType", type: "enum", range: { values: ["cut", "mix", "wipe"] }, readonly: false },
    { name: "gain", type: "number", unit: "dB", range: { min: -60, max: 12 }, readonly: false },
    { name: "level", type: "number", range: { min: 0, max: 1 }, readonly: false },
    { name: "ro", type: "boolean", readonly: true },
  ],
  methods: [{ name: "crosspoint.cut", args: [] }, { name: "setOutputDelay", args: [{ name: "frames", type: "number" }] }],
};

Deno.test("Auto-Raster: Items aus Descriptor (nur schreibbar, argumentlos), Zahlen → Dials", () => {
  const items = buildItems(DESC);
  assertEquals(items.map((i) => `${i.kind}:${i.name}`), ["toggle:keyer.enabled", "enum:crosspoint.transType", "trigger:crosspoint.cut"]);
  assertEquals(buildDialItems(DESC).map((d) => d.name), ["gain", "level"]);
});

Deno.test("Auto-Raster: Zustand der Tasten + Blättern", () => {
  const items = buildItems(DESC);
  const l = layoutAuto(items, buildDialItems(DESC), { "keyer.enabled": true, "crosspoint.transType": "mix" }, 4, 1, 4, 0);
  assertEquals(l.keys[0][0]?.state, "onair");
  assertEquals(l.keys[0][1]?.sub, "mix");
  assertEquals(l.cells[0][2]?.kind, "trigger");
  assertEquals(l.pages, 1);
  // 3 Items auf 2 Zellen → Seite 0: 1 Item + reservierte Taste
  const small = layoutAuto(items, [], {}, 2, 1, 0, 0);
  assertEquals(small.pages, 3);
  assertEquals(small.visible.length, 1);
  assertEquals(layoutAuto(items, [], {}, 2, 1, 0, 2).visible[0].name, "crosspoint.cut");
  assertEquals(layoutAuto(items, [], {}, 2, 1, 0, 99).visible[0].name, "crosspoint.cut");
});

Deno.test("Dial-Rechnung: schöner Schritt ≥ 1 %, Begrenzung", () => {
  const gain = buildDialItems(DESC)[0];
  assertEquals(applyDial(0, 3, gain), 3);
  assertEquals(applyDial(11, 5, gain), 12);
  assertEquals(applyDial(-59, -5, gain), -60);
  const level = buildDialItems(DESC)[1];
  assertEquals(applyDial(0.5, 10, level), 0.6);
});

Deno.test("Enum weiterschalten, unbekannter Wert → erster", () => {
  assertEquals(nextEnum(["a", "b", "c"], "b"), "c");
  assertEquals(nextEnum(["a", "b", "c"], "c"), "a");
  assertEquals(nextEnum(["a", "b"], undefined), "a");
});
