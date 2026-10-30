import { assertEquals } from "jsr:@std/assert";
import { around, clampView, follow, fracToFrame, frameToFrac, fullView, isZoomed, MIN_SPAN, pan, placeRange, zoom, zoomFactor } from "./timeline-zoom.ts";

const TOTAL = 1000;

Deno.test("Hineinzoomen hält den Bildpunkt unter dem Zeiger fest", () => {
  const v = fullView(TOTAL);
  const z = zoom(v, TOTAL, 4, 500); // Mitte
  assertEquals([z.start, z.end], [375, 625]);
  const e = zoom(v, TOTAL, 4, 0); // linker Rand bleibt links
  assertEquals([e.start, e.end], [0, 250]);
  const r = zoom(v, TOTAL, 4, 1000); // rechter Rand bleibt rechts
  assertEquals(r.end, 1000);
  assertEquals(frameToFrac(z, 500), 0.5);
});

Deno.test("Grenzen: nie kleiner als MIN_SPAN, nie größer als die Datei, immer innen", () => {
  assertEquals(clampView({ start: 0, end: 1 }, TOTAL), { start: 0, end: MIN_SPAN });
  assertEquals(clampView({ start: -50, end: 5000 }, TOTAL), { start: 0, end: TOTAL });
  assertEquals(clampView({ start: 990, end: 1100 }, TOTAL), { start: 890, end: 1000 });
  assertEquals(zoom(fullView(TOTAL), TOTAL, 0.5, 500), fullView(TOTAL)); // Herauszoomen über „alles“ hinaus
  assertEquals(clampView({ start: 0, end: 5 }, 4), { start: 0, end: 4 }); // kürzer als MIN_SPAN
});

Deno.test("Verschieben bleibt im Bereich", () => {
  const v = { start: 100, end: 300 };
  assertEquals(pan(v, TOTAL, 50), { start: 150, end: 350 });
  assertEquals(pan(v, TOTAL, -500), { start: 0, end: 200 });
  assertEquals(pan(v, TOTAL, 5000), { start: 800, end: 1000 });
});

Deno.test("Spielkopf außerhalb schiebt den Ausschnitt nach, innerhalb nicht", () => {
  const v = { start: 100, end: 300 };
  assertEquals(follow(v, TOTAL, 200), v);
  assertEquals(follow(v, TOTAL, 300), { start: 280, end: 480 }); // Spielkopf bei 10 %
  assertEquals(follow(v, TOTAL, 5), { start: 0, end: 200 });
});

Deno.test("Ausschnitt um die Marken", () => {
  const v = around(400, 500, TOTAL);
  assertEquals(v.start <= 400 && v.end >= 500, true);
  assertEquals(v.end - v.start < 200, true);
  assertEquals(around(10, 12, TOTAL).end - around(10, 12, TOTAL).start >= MIN_SPAN, true);
});

Deno.test("Bild ↔ Position, Bereiche werden beschnitten", () => {
  const v = { start: 100, end: 200 };
  assertEquals(fracToFrame(v, 0.5, TOTAL), 150);
  assertEquals(fracToFrame(v, 1, TOTAL), 200);
  assertEquals(fracToFrame({ start: 900, end: 1000 }, 1, TOTAL), 999);
  assertEquals(placeRange(v, 150, 180), { left: 0.5, width: 0.3 });
  assertEquals(placeRange(v, 50, 120), { left: 0, width: 0.2 }); // links angeschnitten
  assertEquals(placeRange(v, 300, 400), null);
  assertEquals(placeRange(v, 250, 260), null);
  assertEquals(placeRange(v, 150, 150)?.left, 0.5); // Marke ohne Breite
});

Deno.test("Vergrößerung und Zustand", () => {
  assertEquals(zoomFactor({ start: 0, end: 250 }, TOTAL), 4);
  assertEquals(isZoomed(fullView(TOTAL), TOTAL), false);
  assertEquals(isZoomed({ start: 0, end: 250 }, TOTAL), true);
});
