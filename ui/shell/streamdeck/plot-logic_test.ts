import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { compOutDb, eqResponseDb, type PlotSpec, widthToQ } from "./plot-logic.ts";
import { layoutAudioMixer, plotSpec, type AudioState } from "./adapters/audio-mixer-logic.ts";

const eq = (g: number): Extract<PlotSpec, { kind: "eq" }> => ({
  kind: "eq", bypass: false, hp: null, focus: 0,
  bands: [{ kind: "peak", f: 1000, q: 1, g }],
});
const dyn = (o: Partial<Extract<PlotSpec, { kind: "dyn" }>> = {}): Extract<PlotSpec, { kind: "dyn" }> => ({
  kind: "dyn", on: true, thr: -20, ratio: 4, makeup: 0, knee: 0, gateOn: false, gateThr: -90, ...o,
});

Deno.test("EQ: ohne Gain flach, Peak trifft den Gain bei der Mittenfrequenz", () => {
  assertAlmostEquals(eqResponseDb(eq(0), 500), 0, 1e-9);
  assertAlmostEquals(eqResponseDb(eq(6), 1000), 6, 0.05);
  assertAlmostEquals(eqResponseDb(eq(6), 20), 0, 0.2);
  assertEquals(widthToQ(1000, 1000), 1);
});

Deno.test("Kompressor: unter der Schwelle 1:1, darüber Verhältnis, Makeup addiert", () => {
  assertEquals(compOutDb(dyn(), -40), -40);
  assertEquals(compOutDb(dyn(), -20), -20);
  assertEquals(compOutDb(dyn(), 0), -15); // 20 dB über Schwelle / 4
  assertEquals(compOutDb(dyn({ makeup: 3 }), -40), -37);
  const k = dyn({ knee: 6 }); // weiches Knie: bei der Schwelle schon leicht unter 1:1
  assertEquals(compOutDb(k, -20) < -20, true);
});

const st = (mode: AudioState["mode"]): AudioState => ({
  channels: [{ id: "c0", label: "K1" }], values: { "c0.eqLow": 3, "c0.compThreshold": -18, "c0.compRatio": 3 }, sel: "c0", mode, focus: 1,
});

Deno.test("Spezifikation aus Werten mit Standardwerten", () => {
  const s = plotSpec(st("eq"), "c0", "eq", 1)!;
  assertEquals(s.kind === "eq" && s.bands[0].g, 3);
  assertEquals(s.kind === "eq" && s.bands[3].f, 8000);
  const d = plotSpec(st("dyn"), "c0", "dyn", 0)!;
  assertEquals(d.kind === "dyn" && [d.thr, d.ratio], [-18, 3]);
  assertEquals(plotSpec(st("pan"), "c0", "pan", 0), null);
});

Deno.test("Layout: Kurvenblock neben den Bedientasten (XL), Kurve auf dem Streifen („+“)", () => {
  const xl = layoutAudioMixer(st("eq"), 8, 3, 0, 0);
  assertEquals(xl.keys[0][4]?.plot, undefined); // Toggle-Taste in Spalte 4
  assertEquals(xl.keys[0][5]?.plot?.cx, 0);
  assertEquals(xl.keys[2][7]?.plot && [xl.keys[2][7]!.plot!.cx, xl.keys[2][7]!.plot!.cy, xl.keys[2][7]!.plot!.cw], [2, 2, 3]);
  const dynXl = layoutAudioMixer(st("dyn"), 8, 3, 0, 0);
  assertEquals(dynXl.keys[1][6]?.plot?.cw, 2); // 2 Spalten frei
  const plus = layoutAudioMixer(st("eq"), 4, 1, 4, 0);
  assertEquals(plus.dials!.map((d) => d?.plot?.cx), [0, 1, 2, 3]);
  const plusXl = layoutAudioMixer(st("eq"), 9, 3, 6, 0);
  assertEquals(plusXl.dials!.length, 6); // zwei Felder nur mit Kurve
  assertEquals(plusXl.dials![5]?.label, "");
  assertEquals(plusXl.keys[0][5]?.plot?.cw, 4);
  assertEquals(layoutAudioMixer(st("pan"), 8, 3, 0, 0).keys[0][5]?.plot, undefined);
});
