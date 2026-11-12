import { assertEquals } from "jsr:@std/assert";
import { type LowlatState, layoutLowlat, MODE_PARAMS, nudged, plotSpec, SEND_OFF_DB } from "./lowlat-mixer-logic.ts";
import { lowlatMixerAdapter, type MixerIO } from "./lowlat-mixer.ts";

const strips = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: `Mic ${i + 1}` }));
const buses = [{ id: "1", label: "Haupt" }, { id: "2", label: "Gast" }, { id: "3", label: "In-Ear" }];
const st = (n: number, over: Partial<LowlatState> = {}): LowlatState => ({ strips: strips(n), buses, values: {}, sel: null, bus: "1", mode: "mix", focus: 0, ...over });
const row = (l: ReturnType<typeof layoutLowlat>, r: number) => l.keys[r].map((k) => (k ? k.label ?? "" : "·")).join(" | ");

Deno.test("XL: Zeilen MUTE, SEND, SELECT; Zustände; Aktionen schreiben über setParam-Namen", () => {
  const s = st(3, { values: { "strip.2.mute": true, "strip.3.send.1": 0, "strip.1.send.1": SEND_OFF_DB, "strip.1.gain": -6 }, sel: "3" });
  const l = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals([l.keys[0][0]?.label, l.keys[0][0]?.sub, l.keys[0][3]], ["Mic 1", "MUTE", null]);
  assertEquals(l.keys[0][1]?.state, "onair");
  assertEquals(l.keys[1][0]?.sub, "→ Haupt");
  assertEquals(l.keys[1][0]?.state, "off"); // −90 dB = Send aus
  assertEquals(l.keys[1][2]?.state, "cue"); // 0 dB = Send an
  assertEquals(l.keys[2][2]?.state, "preset");
  assertEquals(l.keys[2][0]?.sub, "-6 dB");
  assertEquals(l.act[0][0], { t: "set", name: "strip.1.mute", value: 1 });
  assertEquals(l.act[0][1], { t: "set", name: "strip.2.mute", value: 0 });
  assertEquals(l.act[1][0], { t: "set", name: "strip.1.send.1", value: 0 }); // aus → an (0 dB)
  assertEquals(l.act[1][2], { t: "set", name: "strip.3.send.1", value: SEND_OFF_DB }); // an → aus
  assertEquals(l.act[2][1], { t: "select", id: "2" });
});

Deno.test("SEND folgt dem gewählten Bus", () => {
  const s = st(2, { bus: "3", values: { "strip.2.send.3": -3 } });
  const l = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals(l.keys[1][0]?.sub, "→ In-Ear");
  assertEquals(l.keys[1][1]?.state, "cue");
  assertEquals(l.act[1][0], { t: "set", name: "strip.1.send.3", value: 0 });
});

Deno.test("mehr Streifen als Spalten: blättern", () => {
  const s = st(10);
  const p0 = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals(p0.pages, 2);
  assertEquals(p0.keys[2][7], null);
  assertEquals(layoutLowlat(s, 8, 3, 0, 1).keys[0][0]?.label, "Mic 8");
});

Deno.test("„+“ (1 Zeile, 4 Dials): Pegel-Dials, Druck = Mute", () => {
  const s = st(3, { values: { "strip.1.gain": 0, "strip.2.gain": -60, "strip.2.mute": true } });
  const l = layoutLowlat(s, 4, 1, 4, 0);
  assertEquals(l.pages, 3);
  assertEquals(l.dials!.length, 3);
  assertEquals(l.dials![1], { label: "Mic 2", value: "-60 dB", fill: 0, dim: true });
  assertEquals(l.dialAct[0]?.press, { t: "set", name: "strip.1.mute", value: 1 });
  assertEquals(l.dialAct[0]?.name, "strip.1.gain");
});

Deno.test("Detailseite EQ: Modustasten, Parameter, Schalter, ±, Kurve, Dials", () => {
  const s = st(2, { sel: "2", mode: "eq", focus: 1, values: { "strip.2.eq.b1.gain": 3, "strip.2.eq.b2.gain": -2.5, "strip.2.eq.bypass": true, "strip.2.eq.b3.freq": 4000 } });
  const l = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals(row(l, 0).split(" | ").slice(0, 5).join(" | "), "◀ Mix | EQ | Dynamik | Bus | ·");
  assertEquals(l.keys[0][0]?.sub, "Mic 2");
  assertEquals(l.keys[1][0]?.sub, "3 dB");
  assertEquals(l.keys[1][1]?.state, "preset"); // Fokus
  assertEquals(l.keys[1][4]?.label, "EQ Bypass");
  assertEquals(l.keys[1][4]?.state, "onair");
  assertEquals(l.act[1][4], { t: "set", name: "strip.2.eq.bypass", value: 0 });
  assertEquals(l.act[1][5], { t: "set", name: "strip.2.eq.hp.enabled", value: 1 });
  assertEquals(l.act[2][1], { t: "nudge", steps: 1 });
  assertEquals(l.keys[2][0]?.sub, "Mid -2.5 dB");
  const spec = plotSpec(s, "2", "eq", 1);
  assertEquals(spec?.kind === "eq" && spec.bands[2].f, 4000);
  assertEquals(spec?.kind === "eq" && spec.bypass, true);
  const d = layoutLowlat(s, 4, 1, 4, 0);
  assertEquals(d.dials!.map((x) => x?.label), ["Low", "Mid", "Mid 2", "High"]);
  assertEquals(d.dialAct[2]?.name, "strip.2.eq.b3.gain");
});

Deno.test("Detailseite Dynamik: Kompressor- und Gate-Schalter", () => {
  const s = st(1, { sel: "1", mode: "dyn", values: { "strip.1.comp.enabled": true, "strip.1.comp.threshold": -24 } });
  const l = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals(l.keys[1][0]?.label, "Comp Thr");
  assertEquals(l.keys[1][0]?.sub, "-24 dB");
  assertEquals(l.keys[1][4]?.label, "Comp");
  assertEquals(l.keys[1][4]?.state, "onair");
  assertEquals(l.act[1][5], { t: "set", name: "strip.1.gate.enabled", value: 1 });
});

Deno.test("Bus-Seite: Bus weiter, Send/Bus-Pegel/Limiter, Mix-minus, Bus-Mute", () => {
  const s = st(2, { sel: "2", mode: "bus", bus: "2", values: { "strip.2.send.2": -6, "bus.2.limiter.enabled": true, "bus.2.limiter.ceiling": -9, "bus.2.mute": false } });
  const l = layoutLowlat(s, 8, 3, 0, 0);
  assertEquals([l.keys[1][0]?.label, l.keys[1][0]?.sub], ["Gast", "Bus weiter"]);
  assertEquals(l.act[1][0], { t: "cycleBus" });
  assertEquals([l.keys[1][1]?.label, l.keys[1][1]?.sub], ["Send", "-6 dB"]);
  assertEquals(l.keys[1][3]?.sub, "-9 dB");
  assertEquals(l.keys[1][4]?.label, "Bus Mute");
  assertEquals(l.keys[1][5]?.label, "Limiter an");
  assertEquals(l.keys[1][5]?.state, "onair");
  assertEquals(l.act[1][5], { t: "set", name: "bus.2.limiter.enabled", value: 0 });
  assertEquals(l.keys[1][6]?.label, "Mix-minus");
  assertEquals(l.act[1][6], { t: "mixminus", bus: "2", strip: "2" });
});

Deno.test("Detailseite 2 Zeilen: Seite 0 Auswahl, Seite 1 ±", () => {
  const s = st(1, { sel: "1", mode: "dyn" });
  assertEquals(layoutLowlat(s, 5, 2, 0, 0).pages, 2);
  assertEquals(layoutLowlat(s, 5, 2, 0, 0).keys[1][0]?.label, "Comp Thr");
  assertEquals(layoutLowlat(s, 5, 2, 0, 1).keys[1][0]?.label, "−");
});

Deno.test("Schrittrechnung und Parameternamen", () => {
  const gain = { min: -60, max: 12, step: 0.5 };
  assertEquals(nudged(0, 1, gain), 0.5);
  assertEquals(nudged(11.75, 3, gain), 12);
  assertEquals(MODE_PARAMS.bus.params[0].name("3", "2"), "strip.3.send.2");
  assertEquals(MODE_PARAMS.bus.params[2].name("3", "2"), "bus.2.limiter.ceiling");
});

Deno.test("Adapter: Tastendruck → setParam; Select → EQ; ± wirkt auf den fokussierten Parameter; Bus weiter; Mix-minus", async () => {
  const calls: unknown[] = [];
  const params: Record<string, unknown> = {
    strips: JSON.stringify(strips(2)), buses: JSON.stringify(buses),
    "strip.1.gain": -3, "strip.1.mute": false, "strip.2.mute": true, "strip.1.send.1": 0, "strip.2.send.1": -90,
  };
  const io: MixerIO = {
    getParam: (n) => (n in params ? Promise.resolve(params[n]) : Promise.reject(new Error("x"))),
    call: (n, b) => (calls.push([n, b]), Promise.resolve()),
  };
  const a = lowlatMixerAdapter(io);
  let changes = 0;
  a.onChange = () => changes++;
  await a.refresh!();
  const ctx = { cols: 8, rows: 3, dials: 0, page: 0 };
  assertEquals(a.getLayout(ctx).keys[0][1]?.state, "onair");
  a.onKey(0, 0, true); a.onKey(0, 0, false);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, [["setParam", { name: "strip.1.mute", value: 1 }]]);
  calls.length = 0;
  a.onKey(2, 0, true); // SELECT → Detail EQ
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(a.getLayout(ctx).keys[0][0]?.label, "◀ Mix");
  params["strip.1.eq.b1.gain"] = 1;
  await a.refresh!();
  a.getLayout(ctx);
  a.onKey(2, 1, true); // +1 Schritt auf Low
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, [["setParam", { name: "strip.1.eq.b1.gain", value: 1.5 }]]);
  // Bus-Seite → Bus weiter → Mix-minus
  calls.length = 0;
  a.onKey(0, 3, true);
  await new Promise((r) => setTimeout(r, 20));
  a.getLayout(ctx);
  a.onKey(1, 0, true); // Bus weiter → Bus 2
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(a.getLayout(ctx).keys[1][0]?.label, "Gast");
  a.onKey(1, 6, true); // Mix-minus für Streifen 1 auf Bus 2
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls, [["bus.2.mixMinus", { strip: 1 }]]);
  assertEquals(changes > 0, true);
});

Deno.test("Adapter: Dial ändert Pegel in Schritten und schreibt setParam", async () => {
  const calls: unknown[] = [];
  const params: Record<string, unknown> = { strips: JSON.stringify(strips(2)), buses: JSON.stringify(buses), "strip.1.gain": -10 };
  const a = lowlatMixerAdapter({ getParam: (n) => (n in params ? Promise.resolve(params[n]) : Promise.reject(new Error("x"))), call: (n, b) => (calls.push([n, b]), Promise.resolve()) });
  await a.refresh!();
  a.getLayout({ cols: 4, rows: 1, dials: 4, page: 0 });
  a.onDial!(0, 2);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, [["setParam", { name: "strip.1.gain", value: -9 }]]);
});
