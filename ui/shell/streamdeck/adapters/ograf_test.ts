import { assertEquals } from "jsr:@std/assert";
import { ografAdapter, type OgrafIO } from "./ograf.ts";
import { layoutOgraf, type OgrafState, stepTemplate } from "./ograf-logic.ts";

const tpl = (id: string, stepCount = 1) => ({ id, label: id.toUpperCase(), stepCount });
const layer = (id: string, step = 0, stepCount = 1, canContinue = false) => ({ id, templateId: id, label: id.toUpperCase(), step, stepCount, canContinue });
const state = (o: Partial<OgrafState> = {}): OgrafState => ({
  templates: [tpl("lt"), tpl("clock"), tpl("quiz", 3), tpl("bug")],
  layers: [],
  sel: "lt",
  ...o,
});

Deno.test("XL: Presets oben, Steuerzeile unten, On-Air rot", () => {
  const l = layoutOgraf(state({ layers: [layer("clock"), layer("quiz", 1, 3, true)], sel: "quiz" }), 8, 3, 0, 0);
  assertEquals(l.keys[0].slice(0, 4).map((k) => k?.label), ["LT", "CLOCK", "QUIZ", "BUG"]);
  assertEquals(l.keys[0].slice(0, 4).map((k) => k?.state), ["off", "onair", "onair", "off"]);
  assertEquals(l.keys[0][2]?.sub, "ON AIR 2/3");
  assertEquals(l.keys[2].slice(0, 4).map((k) => k?.label), ["TAKE", "TAKE OUT", "CONTINUE", "ALLE AUS"]);
  assertEquals(l.keys[2][1]?.state, "onair"); // gewählte Grafik steht on air → TAKE OUT scharf
  assertEquals(l.keys[2][2]?.sub, "2/3");
  assertEquals(l.keys[2][3]?.sub, "2 on air");
  assertEquals(l.keys[2][0]?.dim, true); // TAKE nicht bei on air
});

Deno.test("Vorwahl nicht on air: TAKE scharf, TAKE OUT/CONTINUE gedimmt", () => {
  const l = layoutOgraf(state(), 8, 3, 0, 0);
  assertEquals([l.keys[2][0]?.state, l.keys[2][0]?.sub], ["preset", "LT"]);
  assertEquals([l.keys[2][1]?.dim, l.keys[2][2]?.dim, l.keys[2][3]?.dim], [true, true, true]);
});

Deno.test("„+“: Steuerseite, dann Presets mit Blättern; Dials zeigen Auswahl und On Air", () => {
  const s = state({ layers: [layer("clock")] });
  const p0 = layoutOgraf(s, 4, 1, 4, 0);
  assertEquals(p0.pages, 3);
  assertEquals(p0.keys[0].map((k) => k?.label ?? null), ["TAKE", "TAKE OUT", "CONTINUE", null]);
  assertEquals(layoutOgraf(s, 4, 1, 4, 1).keys[0].map((k) => k?.label ?? null), ["LT", "CLOCK", "QUIZ", null]);
  assertEquals(layoutOgraf(s, 4, 1, 4, 2).keys[0][0]?.label, "BUG");
  assertEquals(p0.dials!.map((d) => `${d?.label}=${d?.value}`).slice(0, 4), ["Preset=LT", "TAKE/OUT=bereit", "CONTINUE=–", "On Air=1: CLOCK"]);
});

Deno.test("Dial-Auswahl begrenzt", () => {
  assertEquals(stepTemplate(state({ sel: null }), -1), "bug");
  assertEquals(stepTemplate(state({ sel: "bug" }), 1), "bug");
  assertEquals(stepTemplate(state(), 1), "clock");
});

function rig(layers: unknown[]) {
  const calls: string[] = [];
  const io: OgrafIO = {
    getParam: (n) => Promise.resolve(n === "templates" ? JSON.stringify(state().templates) : layers),
    call: (n, b) => {
      calls.push(`${n} ${JSON.stringify(b)}`);
      return Promise.resolve();
    },
  };
  return { calls, a: ografAdapter(io) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("Tasten rufen show/hide/continue wie das Panel", async () => {
  const { calls, a } = rig([layer("clock"), layer("quiz", 0, 3, true)]);
  await a.refresh?.();
  const l = () => a.getLayout({ cols: 8, rows: 3, dials: 0, page: 0 });
  l();
  a.onKey(0, 3, true); // BUG wählen
  await tick();
  l();
  a.onKey(2, 0, true); // TAKE
  await tick();
  a.onKey(0, 2, true); // QUIZ wählen
  await tick();
  l();
  a.onKey(2, 2, true); // CONTINUE
  await tick();
  a.onKey(2, 1, true); // TAKE OUT
  await tick();
  a.onKey(2, 3, true); // ALLE AUS
  await tick();
  assertEquals(calls, [
    'show {"templateId":"bug","data":{}}',
    'continue {"layerId":"quiz"}',
    'hide {"layerId":"quiz"}',
    "hide {}",
  ]);
});
