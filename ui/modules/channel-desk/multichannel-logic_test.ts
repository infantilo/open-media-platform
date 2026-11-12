import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import {
  attentionList, childRows, childSpan, planWarnings, axisTicks, blockClass, nextByKind, upcomingList, urgencyOf, buildBlocks, fmtRemain, gangCall, nodeIdFromBundleUrl, playlistNow, pruneSelection, stepChannel, summarize, summarizeGang,
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

Deno.test("playlistNow: ohne laufendes Event gecuetes, sonst erstes Event", () => {
  assertEquals(playlistNow(tl, undefined, 0), 0);
  assertEquals(playlistNow(tl, "", 0, "c"), 90_000);
  assertEquals(playlistNow(tl, "b", 5_000, "c"), 65_000);
  assertEquals(playlistNow([], undefined, 0), null);
});

Deno.test("blockClass: Farben wie in der Playlist-Zeitleiste", () => {
  const it = (o: Partial<ChannelItem>): ChannelItem => ({ id: "x", label: "x", durationMs: 1, ...o });
  assertEquals(blockClass(it({}), "y", "z"), "");
  assertEquals(blockClass(it({}), "x"), "onair");
  assertEquals(blockClass(it({}), "y", "x"), "cued");
  assertEquals(blockClass(it({ senderId: "s" })), "live");
  assertEquals(blockClass(it({ startType: "fixtime" })), "fix");
  assertEquals(blockClass(it({ eventType: "HOLD" })), "ctl");
  assertEquals(blockClass(it({ available: false })), "miss");
  assertEquals(blockClass(it({ asset: {}, readiness: "NOT_READY" })), "bad");
  assertEquals(blockClass(it({ eventType: "JUMP", available: false })), "ctl");
  assertEquals(blockClass(it({ available: false }), "x"), "miss onair");
});

Deno.test("upcomingList: Live, manuell, fehlend, Manual Hold am Ende", () => {
  const its: ChannelItem[] = [
    { id: "a", label: "A", durationMs: 60_000, endType: "manual" },
    { id: "b", label: "B", durationMs: 30_000, senderId: "s" },
    { id: "c", label: "C", durationMs: 20_000, startType: "manual" },
    { id: "d", label: "D", durationMs: 20_000, available: false },
    { id: "e", label: "E", durationMs: 0, eventType: "HOLD", available: false },
  ];
  const t2: TimelineEntry[] = [0, 1, 2, 3, 4].map((i) => {
    const s = [0, 60_000, 90_000, 110_000, 130_000][i];
    return { index: i, itemId: its[i].id, startMs: s, durationMs: its[i].durationMs, endMs: s + its[i].durationMs };
  });
  const l = upcomingList(its, t2, "a", 20_000);
  assertEquals(l.map((u) => `${u.kind}:${u.label}:${u.inMs}${u.atEnd ? "e" : ""}`), [
    "manual:A:40000e", "live:B:40000", "manual:C:70000", "missing:D:90000", "manual:E:110000", "missing:E:110000",
  ].filter((s) => !s.startsWith("missing:E")));
  const n = nextByKind(l);
  assertEquals(n.live?.label, "B");
  assertEquals(n.manual?.label, "A");
  assertEquals(n.missing?.label, "D");
  assertEquals(upcomingList(its, t2, undefined, 0), []);
  const w = upcomingList(its, t2, "a", 20_000, { kind: "endHold", itemId: "a" });
  assertEquals(w[0].waiting, true);
  assertEquals(w.filter((u) => u.atEnd && u.label === "A").length, 1);
});

Deno.test("attentionList und urgencyOf", () => {
  const at = attentionList([
    { key: "1", name: "K1", list: [{ kind: "live", label: "x", inMs: 90_000 }, { kind: "missing", label: "m", inMs: 1000 }] },
    { key: "2", name: "K2", list: [{ kind: "manual", label: "y", inMs: 30_000 }] },
  ]);
  assertEquals(at.map((a) => `${a.channel}:${a.label}`), ["K2:y", "K1:x"]);
  assertEquals(urgencyOf({ inMs: 5000 }), "now");
  assertEquals(urgencyOf({ inMs: 30_000 }), "soon");
  assertEquals(urgencyOf({ inMs: 90_000 }), "later");
  assertEquals(urgencyOf({ inMs: 900_000, waiting: true }), "now");
});

Deno.test("Warnungen färben, Child-Spannen und Zeilen", () => {
  const its: ChannelItem[] = [
    { id: "a", label: "A", durationMs: 60_000, children: [{ id: "k1", type: "GRAPHIC", timing: "RELATIVE_TO_START", delayMs: 5_000, durationMs: 10_000, templateId: "lt" }, { id: "k2", type: "LOGO", timing: "FULL_PRIMARY" }, { id: "k3", timing: "ABSOLUTE" }] },
    { id: "b", label: "B", durationMs: 30_000 },
  ];
  const t2: TimelineEntry[] = [
    { index: 0, itemId: "a", startMs: 0, durationMs: 60_000, endMs: 60_000 },
    { index: 1, itemId: "b", startMs: 60_000, durationMs: 30_000, endMs: 90_000 },
  ];
  const warn = planWarnings({ entries: [{ id: "b", warnings: ["Quelle knapp"] }, { id: "a", warnings: [] }] });
  assertEquals([...warn.keys()], ["b"]);
  const withW = buildBlocks(its, t2, 0, "a", 0, 90_000, undefined, { warnings: warn, childRuntime: [] });
  assertEquals(withW.map((b) => b.cls), ["onair", "bad"]);
  assertEquals(withW[1].note, "Quelle knapp");
  assertEquals(buildBlocks(its, t2, 0, "a", 0, 90_000)[1].cls, "");
  const failed = buildBlocks(its, t2, 0, "a", 0, 90_000, undefined, { warnings: new Map(), childRuntime: [{ itemId: "b", id: "x", state: "Failed" }] });
  assertEquals(failed[1].cls, "bad");
  assertEquals(childSpan(its[0].children![0], 60_000, 0), [5_000, 15_000]);
  assertEquals(childSpan(its[0].children![2], 60_000, 0), null);
  const rows = childRows(its, t2, [{ itemId: "a", id: "k1", state: "Fired" }], 0, 0, 90_000);
  assertEquals(rows.length, 2); // k1 und k2 überlappen → zwei Zeilen
  assertEquals(rows[0][0].label, "lt");
  assertEquals(rows[0][0].state, "Fired");
});
