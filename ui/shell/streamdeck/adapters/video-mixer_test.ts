import { assertEquals } from "jsr:@std/assert";
import { deckLabel, layoutVideoMixer, type MixerState } from "./video-mixer-logic.ts";
import { videoMixerAdapter } from "./video-mixer.ts";

const src = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Q${i}`, senderId: `s${i}` }));
const state = (n: number, over: Partial<MixerState> = {}): MixerState => ({
  entries: [{ label: "BLK", senderId: "" }, ...src(n)], program: "s1", preset: "s2", keyer: false,
  pipEnabled: false, pipPresets: [], activePip: "", transType: "mix", transRate: 25, ...over,
});
const lbl = (l: ReturnType<typeof layoutVideoMixer>, r: number) => l.keys[r].map((k) => k?.label ?? "·").join(",");

Deno.test("XL (3 Inhaltszeilen): PGM, PRE, Steuerung; Zustandsfarben", () => {
  const l = layoutVideoMixer(state(3), 8, 3, 0);
  assertEquals(lbl(l, 0), "BLK,Q0,Q1,Q2,·,·,·,·");
  assertEquals(l.pages, 1);
  assertEquals(l.keys[0][2]?.state, "onair"); // s1 = Q1 auf PGM
  assertEquals(l.keys[1][3]?.state, "preset"); // s2 = Q2 auf PRE
  assertEquals(l.keys[0][3]?.state, "off");
  assertEquals(lbl(l, 2), "CUT,AUTO,DSK,Übergang,Rate,·,·,·");
  assertEquals(l.act[0][1], { method: "crosspoint.take", body: { senderId: "s0" } });
  assertEquals(l.act[1][1], { method: "crosspoint.select", body: { senderId: "s0" } });
  assertEquals(l.act[2][0], { method: "crosspoint.cut" });
});

Deno.test("Steuertasten: DSK-Umschalten, Übergangstyp/Rate weiterschalten, PIP-Presets", () => {
  const l = layoutVideoMixer(state(1, { keyer: true, transType: "fadecut", transRate: 50, pipEnabled: true, activePip: "p2", pipPresets: [{ id: "p1", name: "Links" }, { id: "p2", name: "Rechts" }] }), 8, 3, 0);
  assertEquals(l.keys[2][2]?.state, "onair");
  assertEquals(l.act[2][2], { method: "keyer.setEnabled", body: { enabled: false } });
  assertEquals(l.act[2][3], { method: "crosspoint.setTransType", body: { type: "cutfade" } });
  assertEquals(l.keys[2][3]?.sub, "FADE-CUT");
  assertEquals(l.act[2][4], { method: "crosspoint.setTransRate", body: { frames: 6 } }); // 50 → 6
  assertEquals(l.act[2][5], { method: "pip.applyPreset", body: { id: "p1" } });
  assertEquals(l.keys[2][6]?.state, "cue");
  assertEquals(l.act[2][6], { method: "pip.setEnabled", body: { enabled: false } });
});

Deno.test("mehr Quellen als Spalten: Seiten, letzte Zelle bleibt frei, Seite 2 zeigt den Rest", () => {
  const s = state(10); // 11 Einträge inkl. BLK, 8 Spalten → cap 7 → 2 Seiten
  const p0 = layoutVideoMixer(s, 8, 3, 0), p1 = layoutVideoMixer(s, 8, 3, 1);
  assertEquals(p0.pages, 2);
  assertEquals(lbl(p0, 0), "BLK,Q0,Q1,Q2,Q3,Q4,Q5,·");
  assertEquals(lbl(p1, 0), "Q6,Q7,Q8,Q9,·,·,·,·");
  assertEquals(p0.keys[2][7], null); // Platz für die Seitentaste
  assertEquals(layoutVideoMixer(s, 8, 3, 99).keys[0][0]?.label, "Q6"); // begrenzt
});

Deno.test("„+“ (1 Zeile × 4): PGM-Seiten, PRE-Seiten, dann Steuerung", () => {
  const s = state(2); // 3 Einträge ≤ 4 Spalten, aber Seiten > 1 → cap 3
  const l = (p: number) => layoutVideoMixer(s, 4, 1, p);
  assertEquals(l(0).pages, 2 * 1 + 2); // PGM, PRE, 2 Steuer-Chunks (5 Tasten, cap 3)
  assertEquals(lbl(l(0), 0), "BLK,Q0,Q1,·");
  assertEquals(l(0).keys[0][0]?.sub, "PGM");
  assertEquals(l(1).keys[0][0]?.sub, "PRE");
  assertEquals(lbl(l(2), 0), "CUT,AUTO,DSK,·");
  assertEquals(lbl(l(3), 0), "Übergang,Rate,·,·");
});

Deno.test("2 Zeilen (15-Tasten-Pult, 5 Spalten): PGM+PRE auf einer Seite", () => {
  const l = layoutVideoMixer(state(3), 5, 2, 0);
  assertEquals(l.pages, 2);
  assertEquals(lbl(l, 0), "BLK,Q0,Q1,Q2,·");
  assertEquals(lbl(l, 1), "BLK,Q0,Q1,Q2,·");
  assertEquals(lbl(layoutVideoMixer(state(3), 5, 2, 1), 0), "CUT,AUTO,DSK,Übergang,Rate");
});

Deno.test("Adapter: Tastendruck ruft die Methode auf (nur beim Drücken), leerer Zustand → Platzhalter", async () => {
  const calls: unknown[] = [];
  let st: MixerState | null = null;
  const a = videoMixerAdapter({ state: () => st, call: (m, b) => (calls.push([m, b]), Promise.resolve()) });
  assertEquals(a.getLayout({ cols: 8, rows: 3, dials: 0, page: 0 }).keys[0][0]?.dim, true);
  st = state(2);
  a.getLayout({ cols: 8, rows: 3, dials: 0, page: 0 });
  a.onKey(0, 2, true); a.onKey(0, 2, false); a.onKey(1, 1, true); a.onKey(2, 0, true); a.onKey(0, 7, true);
  assertEquals(calls, [["crosspoint.take", { senderId: "s1" }], ["crosspoint.select", { senderId: "s0" }], ["crosspoint.cut", undefined]]);
});

Deno.test("Tastentitel kürzen", () => {
  assertEquals(deckLabel("omp-source-2 Sender 1"), "source-2");
  assertEquals(deckLabel("Kamera 1"), "Kamera 1");
  assertEquals(deckLabel("BLK"), "BLK");
});
