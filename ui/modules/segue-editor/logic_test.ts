import { assert, assertEquals } from "jsr:@std/assert@1";
import { curvePoints, gainEnvelope, pcmToChannels, previewWindow, voiceGainAt, voiceSegment, dragMarker, fall, fmtMs, hitMarker, initialView, isEmptyTransition, markerTime, msToX, rise, xToMs, zoomView } from "./logic.ts";
import type { Context, Placed } from "./logic.ts";

// Wie der Node für Nachtfahrt (61 s, Segue 52 881) → Strandgut mit Standardblende plant.
const pa: Placed = { id: "a", startMs: 0, offsetMs: 0, fadeInMs: 0, fadeInCurve: "cosine", stopAtMs: 52_881, fadeOutMs: 3000, fadeOutCurve: "cosine", endMs: 55_881, nextStartMs: 52_881 };
const pb: Placed = { id: "b", startMs: 52_881, offsetMs: 0, fadeInMs: 3000, fadeInCurve: "cosine", stopAtMs: null, fadeOutMs: 0, fadeOutCurve: "cosine", endMs: 117_000, nextStartMs: 117_000 };
const ctx: Context = {
  a: { durationMs: 61_000, somMs: 0, introMs: null, outroMs: 52_881 },
  b: { durationMs: 64_000, somMs: 0, introMs: 8000, outroMs: null },
  pa, pb, tr: {},
};

Deno.test("Kurven wie im Segue-Player", () => {
  assertEquals(rise("linear", 0.25), 0.25);
  assert(Math.abs(rise("cosine", 0.5) - Math.sin(Math.PI / 4)) < 1e-9);
  assertEquals(rise("log", 1), 1);
  assert(Math.abs(rise("log", 0.5) - Math.pow(10, -1.5)) < 1e-9);
  assertEquals(rise("linear", -3), 0);
  assertEquals(rise("linear", 4), 1);
  assertEquals(fall("linear", 0.25), 0.75);
  const p = curvePoints("cosine", "out", 5);
  assertEquals(p.length, 5);
  assertEquals(p[0], [0, 1]);
  assert(Math.abs(p[4][1]) < 1e-12);
});

Deno.test("Zeitachse: ms ↔ Bildpunkte und Zoom um den Mauszeiger", () => {
  const v = { fromMs: 1000, toMs: 11_000, width: 1000 };
  assertEquals(msToX(v, 6000), 500);
  assertEquals(xToMs(v, 500), 6000);
  const z = zoomView(v, 6000, 0.5, 60_000);
  assertEquals(z.toMs - z.fromMs, 5000);
  assertEquals(msToX(z, 6000), 500, "Fixpunkt bleibt unter der Maus");
  assertEquals(zoomView(v, 6000, 0.00001, 60_000).toMs - zoomView(v, 6000, 0.00001, 60_000).fromMs, 200);
  assertEquals(zoomView(v, 6000, 1000, 20_000).toMs - zoomView(v, 6000, 1000, 20_000).fromMs, 20_000);
  const iv = initialView(pa, pb, 800);
  assert(iv.fromMs <= pa.nextStartMs && iv.toMs >= pa.endMs);
});

Deno.test("Marken: Positionen auf der Zeitachse", () => {
  assertEquals(markerTime("aOutro", ctx), 52_881);
  assertEquals(markerTime("fadeOutEnd", ctx), 55_881);
  assertEquals(markerTime("bStart", ctx), 52_881);
  assertEquals(markerTime("fadeInEnd", ctx), 55_881);
  assertEquals(markerTime("bIntro", ctx), 52_881 + 8000);
});

Deno.test("Ziehen: Segue-Punkt, Einsatz, Blenden", () => {
  assertEquals(dragMarker("aOutro", 50_000, ctx), { a: { outroMs: 50_000 } });
  assertEquals(dragMarker("aOutro", 999_999, ctx), { a: { outroMs: 61_000 } }, "nie hinter das Dateiende");
  assertEquals(dragMarker("bStart", 52_381, ctx), { tr: { startShiftMs: -500 } });
  assertEquals(dragMarker("bStart", -5000, ctx).tr?.startShiftMs, -52_881, "nie vor dem Start von A");
  assertEquals(dragMarker("fadeOutEnd", 54_881, ctx), { tr: { fadeOutMs: 2000 } });
  assertEquals(dragMarker("fadeOutEnd", 90_000, ctx).tr?.fadeOutMs, 61_000 - 52_881, "höchstens bis zum Dateiende");
  assertEquals(dragMarker("fadeOutEnd", 40_000, ctx).tr?.fadeOutMs, 0);
  assertEquals(dragMarker("fadeInEnd", 54_381, ctx), { tr: { fadeInMs: 1500 } });
  assertEquals(dragMarker("bIntro", 52_881 + 5000, ctx), { b: { introMs: 5000 } });
  assertEquals(dragMarker("bIntro", 10, ctx).b?.introMs, 0);
  assertEquals(dragMarker("bSom", 52_881 + 2000, ctx), { b: { somMs: 2000 } });
  // vorhandene Übergangswerte bleiben beim Ziehen eines anderen erhalten
  const c2 = { ...ctx, tr: { curveOut: "linear" as const, fadeInMs: 100 } };
  assertEquals(dragMarker("bStart", 52_881, c2).tr, { curveOut: "linear", fadeInMs: 100, startShiftMs: 0 });
});

Deno.test("Treffer: nächste Marke innerhalb der Toleranz", () => {
  const v = { fromMs: 0, toMs: 100_000, width: 1000 };
  const times = { aOutro: 52_000, bStart: 52_500, bIntro: null };
  assertEquals(hitMarker(520, v, times), "aOutro");
  assertEquals(hitMarker(525, v, times), "bStart");
  assertEquals(hitMarker(300, v, times), null);
  assertEquals(hitMarker(521, v, times, 0), null);
});

Deno.test("Hilfen: leerer Übergang, Zeitformat", () => {
  assert(isEmptyTransition(undefined) && isEmptyTransition({}) && isEmptyTransition({ fadeInMs: undefined }));
  assert(!isEmptyTransition({ startShiftMs: 0 }));
  assertEquals(fmtMs(61_250), "1:01.250");
  assertEquals(fmtMs(-500), "-0:00.500");
});

Deno.test("Vorhören: Fenster, Ausschnitte, Verstärkung", () => {
  const w = previewWindow(pa, pb, 8000, 4000);
  assertEquals(w.t0, 52_881 - 8000);
  assert(w.t1 >= pa.endMs + 4000 - 1 && w.t1 <= pb.endMs);
  // A läuft im Fenster von t0 bis zum Ende der Blende, B erst ab seinem Einsatz
  assertEquals(voiceSegment(pa, w.t0, w.t1), { fileFromMs: w.t0, fileToMs: pa.endMs, atMs: w.t0 });
  assertEquals(voiceSegment(pb, w.t0, w.t1)?.atMs, pb.startMs);
  assertEquals(voiceSegment(pb, 0, 1000), null);
  // Verstärkung: A voll bis zum Segue-Punkt, danach (cosine) fallend, nach der Blende still; B steigt ein
  assertEquals(voiceGainAt(pa, 40_000), 1);
  assert(Math.abs(voiceGainAt(pa, 52_881 + 1500) - (1 - Math.sin(Math.PI / 4))) < 1e-9);
  assertEquals(voiceGainAt(pa, 56_000), 0);
  assertEquals(voiceGainAt(pb, 52_881), 0);
  assertEquals(voiceGainAt(pb, 52_881 + 3000), 1);
  const lin: Placed = { ...pb, fadeInCurve: "linear" };
  assert(Math.abs(voiceGainAt(lin, 52_881 + 1500) - 0.5) < 1e-9);
  const env = gainEnvelope(lin, 52_881, 52_881 + 3000, 1);
  assertEquals(env.length, 3001);
  assert(Math.abs(env[1500] - 0.5) < 1e-6);
  // PCM s16le stereo
  const raw = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80]);
  const [l, r] = pcmToChannels(raw);
  assertEquals([l[0], r[0]], [0.5, -0.5]);
  assert(Math.abs(l[1] - 32767 / 32768) < 1e-9 && r[1] === -1);
});
