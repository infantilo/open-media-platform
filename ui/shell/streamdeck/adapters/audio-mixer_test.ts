import { assertEquals } from "jsr:@std/assert";
import { type AudioState, layoutAudioMixer, nudged, MODE_PARAMS } from "./audio-mixer-logic.ts";
import { audioMixerAdapter, type MixerIO } from "./audio-mixer.ts";

const chans = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Kanal ${i + 1}` }));
const st = (n: number, over: Partial<AudioState> = {}): AudioState => ({ channels: chans(n), values: {}, sel: null, mode: "mix", focus: 0, ...over });
const row = (l: ReturnType<typeof layoutAudioMixer>, r: number) => l.keys[r].map((k) => (k ? k.label ?? "" : "·")).join(" | ");

Deno.test("XL: Zeilen MUTE, PFL, SELECT; Zustandsfarben; Aktionen", () => {
  const s = st(3, { values: { "c1.mute": true, "c2.pfl": true, "c0.gain": -6 }, sel: "c2" });
  const l = layoutAudioMixer(s, 8, 3, 0, 0);
  assertEquals([l.keys[0][0]?.label, l.keys[0][0]?.sub, l.keys[0][2]?.label, l.keys[0][3]], ["Kanal 1", "MUTE", "Kanal 3", null]);
  assertEquals(l.keys[0][1]?.state, "onair");
  assertEquals(l.keys[1][2]?.state, "cue");
  assertEquals(l.keys[2][2]?.state, "preset");
  assertEquals(l.keys[2][0]?.sub, "-6 dB");
  assertEquals(l.act[0][0], { t: "call", id: "c0", method: "setMute", body: { muted: true } });
  assertEquals(l.act[0][1], { t: "call", id: "c1", method: "setMute", body: { muted: false } });
  assertEquals(l.act[1][0], { t: "call", id: "c0", method: "setPfl", body: { enabled: true } });
  assertEquals(l.act[2][1], { t: "select", id: "c1" });
  assertEquals(l.pages, 1);
});

Deno.test("mehr Kanäle als Spalten: blättern, letzte Zelle frei", () => {
  const s = st(10);
  const p0 = layoutAudioMixer(s, 8, 3, 0, 0);
  assertEquals(p0.pages, 2);
  assertEquals(p0.keys[2][7], null);
  assertEquals(p0.keys[0][6]?.label, "Kanal 7");
  assertEquals(layoutAudioMixer(s, 8, 3, 0, 1).keys[0][0]?.label, "Kanal 8");
  assertEquals(layoutAudioMixer(s, 8, 3, 0, 1).keys[0][2]?.label, "Kanal 10");
  assertEquals(layoutAudioMixer(s, 8, 3, 0, 1).keys[0][3], null);
});

Deno.test("„+“ (1 Zeile, 4 Dials): Gain-Dials folgen der Kanalseite, Druck = Mute, Seiten MUTE/PFL/SELECT", () => {
  const s = st(3, { values: { "c0.gain": 0, "c1.gain": -60, "c1.mute": true } });
  const l = layoutAudioMixer(s, 4, 1, 4, 0);
  assertEquals(l.pages, 3); // 3 Kanäle ≤ 4, aber 3 Bildschirme (MUTE, PFL, SELECT)
  assertEquals(l.dials!.length, 3);
  assertEquals(l.dials![1], { label: "Kanal 2", value: "-60 dB", fill: 0, dim: true });
  assertEquals(l.dialAct[0]?.press, { t: "call", id: "c0", method: "setMute", body: { muted: true } });
  assertEquals(l.dialAct[0]?.p.set(-3), { method: "setGain", body: { db: -3 } });
  assertEquals(layoutAudioMixer(s, 4, 1, 4, 1).keys[0][0]?.sub, "PFL");
  assertEquals(layoutAudioMixer(s, 4, 1, 4, 2).keys[0][0]?.sub, "0 dB"); // SELECT-Seite zeigt den Gain
});

Deno.test("Detailseite EQ: Modustasten, Parameter, Bypass, −/+ , Dials", () => {
  const s = st(2, { sel: "c1", mode: "eq", focus: 1, values: { "c1.eqLow": 3, "c1.eqMid": -2.5, "c1.eqBypass": true } });
  const l = layoutAudioMixer(s, 8, 3, 0, 0);
  assertEquals(row(l, 0).split(" | ").slice(0, 5).join(" | "), "◀ Mix | EQ | Dynamik | Pan | ·"); // rechts davon: Kurvenblock
  assertEquals(l.keys[0][0]?.sub, "Kanal 2");
  assertEquals(l.keys[0][1]?.state, "preset");
  assertEquals(l.keys[1][0]?.sub, "3 dB");
  assertEquals(l.keys[1][1]?.state, "preset"); // Fokus
  assertEquals(l.keys[1][4]?.label, "EQ Bypass");
  assertEquals(l.keys[1][4]?.state, "onair");
  assertEquals(l.act[1][4], { t: "call", id: "c1", method: "setEqBypass", body: { bypass: false } });
  assertEquals(l.act[1][1], { t: "focus", index: 1 });
  assertEquals(l.act[2][1], { t: "nudge", steps: 1 });
  assertEquals(l.keys[2][0]?.sub, "Mid -2.5 dB");
  const d = layoutAudioMixer(s, 4, 1, 4, 0);
  assertEquals(d.dials!.map((x) => x?.label), ["Low", "Mid", "Mid 2", "High"]);
  assertEquals(d.dialAct[2]?.p.set(1.5), { method: "setEqGain", body: { band: "mid2", gainDb: 1.5 } });
  assertEquals(d.dialAct[0]?.press, { t: "call", id: "c1", method: "setEqBypass", body: { bypass: false } });
});

Deno.test("Detailseite 2 Zeilen: Seite 0 Auswahl, Seite 1 ±", () => {
  const s = st(1, { sel: "c0", mode: "dyn" });
  assertEquals(layoutAudioMixer(s, 5, 2, 0, 0).pages, 2);
  assertEquals(layoutAudioMixer(s, 5, 2, 0, 0).keys[1][0]?.label, "Comp Thr");
  assertEquals(layoutAudioMixer(s, 5, 2, 0, 1).keys[1][0]?.label, "−");
  assertEquals(layoutAudioMixer(s, 5, 2, 0, 1).keys[1][3]?.label, "++");
});

Deno.test("Schrittrechnung: Rasterung und Grenzen", () => {
  const gain = { min: -60, max: 12, step: 0.5 };
  assertEquals(nudged(0, 1, gain), 0.5);
  assertEquals(nudged(11.75, 3, gain), 12);
  assertEquals(nudged(-59.9, -5, gain), -60);
  assertEquals(nudged(0.2, 1, gain), 0.5); // 0,7 → Raster 0,5
  assertEquals(MODE_PARAMS.pan.params[0].set(0.25), { method: "setPan", body: { pan: 0.25 } });
});

Deno.test("Adapter: Tastendruck → channel.<id>.<methode> mit Argumenten; Select einmal → Detail", async () => {
  const calls: unknown[] = [];
  const params: Record<string, unknown> = { channels: JSON.stringify(chans(2)), "channel.c0.gain": -3, "channel.c0.mute": false, "channel.c1.mute": true };
  const io: MixerIO = {
    getParam: (n) => (n in params ? Promise.resolve(params[n]) : Promise.reject(new Error("x"))),
    call: (n, b) => (calls.push([n, b]), Promise.resolve()),
  };
  const a = audioMixerAdapter(io);
  let changes = 0;
  a.onChange = () => changes++;
  await a.refresh!();
  const ctx = { cols: 8, rows: 3, dials: 0, page: 0 };
  assertEquals(a.getLayout(ctx).keys[0][1]?.state, "onair"); // c1 gemutet
  a.onKey(0, 0, true); a.onKey(0, 0, false);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, [["channel.c0.setMute", { muted: true }]]);
  a.onKey(2, 0, true); // ein Druck → Detail
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(a.getLayout(ctx).keys[0][0]?.label, "◀ Mix");
  calls.length = 0;
  params["channel.c0.eqLow"] = 1;
  await a.refresh!();
  a.getLayout(ctx);
  a.onKey(2, 1, true); // +1 Schritt auf den fokussierten Parameter (Low)
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, [["channel.c0.setEqGain", { band: "low", gainDb: 1.5 }]]);
  assertEquals(changes > 0, true);
});
