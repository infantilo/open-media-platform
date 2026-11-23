import { assert, assertEquals } from "jsr:@std/assert";
import { HOUR, layout, laneCount, nowPct, ticks, unscheduled, windowFor } from "./timeline-logic.ts";

const day = new Date(2026, 10, 23, 12).getTime();
const iso = (h: number, m = 0, d = 23) => new Date(2026, 10, d, h, m).toISOString();
const win = windowFor(day, 1);

Deno.test("Fenster beginnt um Mitternacht und dauert die gewählten Tage", () => {
  assertEquals(new Date(win.from).getHours(), 0);
  assertEquals(windowFor(day, 7).to - windowFor(day, 7).from, 7 * 24 * HOUR);
  assertEquals(windowFor(day, 1, 1).from, win.to);
});

Deno.test("Position in Prozent und Zuschnitt auf das Fenster", () => {
  const [b] = layout([{ id: "a", name: "A", state: "planned", plannedStart: iso(6), plannedEnd: iso(12) }], win);
  assertEquals([b.left, b.width], [25, 25]);
  const [c] = layout([{ id: "c", name: "C", state: "planned", plannedStart: iso(20, 0, 22), plannedEnd: iso(6) }], win);
  assert(c.clippedStart && !c.clippedEnd);
  assertEquals([c.left, c.width], [0, 25]);
});

Deno.test("Bahnen: nur überlappende Events teilen sich nicht die Bahn", () => {
  const ev = [
    { id: "a", name: "A", state: "live", plannedStart: iso(8), plannedEnd: iso(10) },
    { id: "b", name: "B", state: "live", plannedStart: iso(9), plannedEnd: iso(11) },
    { id: "c", name: "C", state: "live", plannedStart: iso(10), plannedEnd: iso(12) },
  ];
  const bars = layout(ev, win);
  const by = Object.fromEntries(bars.map((b) => [b.id, b]));
  assertEquals([by.a.lane, by.b.lane, by.c.lane], [0, 1, 0]); // C beginnt, wenn A endet
  assertEquals(laneCount(bars), 2);
  assert(by.a.overlaps && by.b.overlaps && by.c.overlaps); // C überschneidet B
});

Deno.test("aneinanderstoßende Events überschneiden sich nicht", () => {
  const bars = layout([{ id: "a", name: "A", state: "planned", plannedStart: iso(8), plannedEnd: iso(9) }, { id: "b", name: "B", state: "planned", plannedStart: iso(9), plannedEnd: iso(10) }], win);
  assert(bars.every((b) => !b.overlaps && b.lane === 0));
});

Deno.test("ohne Ende: Standarddauer; ohne Start: unter der Leiste; außerhalb: ausgeblendet", () => {
  const ev = [
    { id: "o", name: "O", state: "planned", plannedStart: iso(6) },
    { id: "n", name: "N", state: "planned" },
    { id: "x", name: "X", state: "planned", plannedStart: iso(6, 0, 25), plannedEnd: iso(8, 0, 25) },
  ];
  const bars = layout(ev, win);
  assertEquals(bars.map((b) => b.id), ["o"]);
  assert(bars[0].openEnd);
  assertEquals(unscheduled(ev).map((e) => e.id), ["n"]);
});

Deno.test("sehr kurze Events behalten eine Mindestbreite", () => {
  const [b] = layout([{ id: "a", name: "A", state: "live", plannedStart: iso(8), plannedEnd: iso(8, 1) }], win);
  assert(b.width >= 0.6);
});

Deno.test("Skala und Jetzt-Linie", () => {
  const t1 = ticks(win);
  assertEquals(t1.length, 12);
  assertEquals(t1[0].major, true);
  assertEquals(ticks(windowFor(day, 7)).length, 7);
  assertEquals(nowPct(win, day), 50);
  assertEquals(nowPct(win, win.to + 1), null);
});
