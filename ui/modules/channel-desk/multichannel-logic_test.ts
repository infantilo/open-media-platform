import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import {
  axisTicks, buildBlocks, fmtRemain, gangCall, nodeIdFromBundleUrl, playlistNow, pruneSelection, stepChannel, summarize, summarizeGang,
  type ChannelItem, type TimelineEntry,
} from "./multichannel-logic.ts";

const items: ChannelItem[] = [
  { id: "a", label: "Nachrichten", durationMs: 60_000 },
  { id: "b", label: "Wetter", durationMs: 30_000 },
  { id: "c", label: "Spot", durationMs: 20_000 },
];
const tl: TimelineEntry[] = [
  { index: 0, itemId: "a", startMs: 0, durationMs: 60_000, endMs: 60_000 },
  { index: 1, itemId: "b", startMs: 60_000, durationMs: 30_000, endMs: 90_000 },
  { index: 2, itemId: "c", startMs: 90_000, durationMs: 20_000, endMs: 110_000 },
];

Deno.test("summarize: laufendes Event, Rest, Nachfolger, Gesamtrest", () => {
  const s = summarize({ items, currentItemId: "a", playheadPositionMs: 15_000, currentDurationMs: 60_000, mode: "auto", connected: true, channelName: "K1" }, "x");
  assertEquals(s.name, "K1");
  assertEquals(s.onAir, "Nachrichten");
  assertEquals(s.nextLabel, "Wetter");
  assertEquals(s.remainingMs, 45_000);
  assertAlmostEquals(s.progress, 0.25);
  assertEquals(s.remainingTotalMs, 95_000);
  assertEquals(s.health, "ok");
});

Deno.test("summarize: Wartezustand, kein Event, getrennt", () => {
  const w = summarize({ items, currentItemId: "a", playheadPositionMs: 0, connected: true, operatorWait: { kind: "hold", remainingMs: null } }, "x");
  assertEquals(w.health, "wait");
  assertEquals(w.waitKind, "hold");
  assertEquals(summarize({ items, connected: true }, "x").health, "warn");
  assertEquals(summarize({ items, connected: false }, "Name").health, "offline");
  assertEquals(summarize(null, "Name").name, "Name");
});

Deno.test("summarize: letztes Event kurz vor Ende ohne Nachfolger warnt", () => {
  const s = summarize({ items, currentItemId: "c", playheadPositionMs: 15_000, currentDurationMs: 20_000, connected: true }, "x");
  assertEquals(s.health, "warn");
});

Deno.test("operatorWait als JSON-Text", () => {
  const s = summarize({ items, currentItemId: "a", connected: true, operatorWait: '{"kind":"cued"}' }, "x");
  assertEquals(s.waitKind, "cued");
});

Deno.test("buildBlocks: Fenster schneidet zu, markiert das laufende Event", () => {
  const now = playlistNow(tl, "b", 10_000)!;
  assertEquals(now, 70_000);
  const blocks = buildBlocks(items, tl, now, "b", 20_000, 40_000); // 50_000..110_000
  assertEquals(blocks.map((b) => b.id), ["a", "b", "c"]);
  assertEquals(blocks[0].leftPct, 0);
  assertAlmostEquals(blocks[0].widthPct, (10_000 / 60_000) * 100);
  assertEquals(blocks[1].current, true);
  assertEquals(buildBlocks(items, tl, 70_000, "b", 0, 0), []);
});

Deno.test("fmtRemain", () => {
  assertEquals(fmtRemain(null), "–:––");
  assertEquals(fmtRemain(45_000), "0:45");
  assertEquals(fmtRemain(3_725_000), "1:02:05");
});

Deno.test("gangCall und Ergebnis", () => {
  assertEquals(gangCall("next"), { kind: "method", name: "next" });
  assertEquals(gangCall("hold"), { kind: "param", name: "mode", value: "hold" });
  const r = summarizeGang([{ channel: "a", ok: true }, { channel: "b", ok: false, error: "x" }]);
  assertEquals(r.ok, 1);
  assertEquals(r.failed.length, 1);
});

Deno.test("Auswahl und Wechsel", () => {
  assertEquals([...pruneSelection(new Set(["a", "z"]), ["a", "b"])], ["a"]);
  assertEquals(stepChannel(["a", "b", "c"], "c", 1), "a");
  assertEquals(stepChannel(["a", "b", "c"], "a", -1), "c");
  assertEquals(stepChannel(["a", "b"], null, 1), "a");
  assertEquals(stepChannel([], null, 1), null);
  assertEquals(nodeIdFromBundleUrl("/api/v1/nodes/n-1/"), "n-1");
});

Deno.test("axisTicks: runde Minuten, begrenzte Anzahl", () => {
  const now = Date.UTC(2026, 10, 12, 12, 7, 30);
  const t = axisTicks(now, 6 * 60_000, 24 * 60_000); // 30 min → 5-min-Raster (6 Marken)
  assertEquals(t.length, 6);
  assertEquals(t.every((x) => x.epochMs % 300_000 === 0 && x.leftPct >= 0 && x.leftPct <= 100), true);
  assertEquals(axisTicks(now, 0, 0), []);
  assertEquals(axisTicks(now, 12 * 60_000, 48 * 60_000).length <= 8, true);
});
