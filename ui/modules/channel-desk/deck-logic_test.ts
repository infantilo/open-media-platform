import { assertEquals } from "jsr:@std/assert@1";
import { actionTargets, buildCells, layoutCells, needsConfirm, type DeckChannel, type DeckInput } from "./deck-logic.ts";

const ch = (key: string, o: Partial<DeckChannel> = {}): DeckChannel => ({ key, name: key.toUpperCase(), health: "ok", remainingMs: 65_000, onAir: true, selected: false, ...o });
const base = (o: Partial<DeckInput> = {}): DeckInput => ({ channels: [ch("a"), ch("b"), ch("c", { health: "offline", onAir: false })], openKey: null, openMode: false, armed: null, ...o });

Deno.test("Übersicht: Channels, dann Steuerzeile in neuer Reihe (XL 8×3)", () => {
  const g = layoutCells(buildCells(base(), 8), { cols: 8, rows: 3, page: 0 });
  assertEquals(g.pages, 1);
  assertEquals(g.keys[0].slice(0, 3).map((k) => k?.label), ["A", "B", "C"]);
  assertEquals(g.keys[0][0]?.sub, "1:05");
  assertEquals(g.keys[0][2]?.dim, true);
  assertEquals(g.keys[0][3], null); // Rest der Reihe frei
  assertEquals(g.keys[1].slice(1, 6).map((k) => k?.label), ["NEXT", "TAKE", "N.LIVE", "HOLD", "AUTO"]);
  assertEquals(g.acts[0][0], { t: "select", key: "a" });
  assertEquals(g.acts[1][1], { t: "action", a: "next" });
});

Deno.test("Auswahl: Haken, Aktionstasten erst mit Auswahl bedienbar", () => {
  const none = layoutCells(buildCells(base(), 8), { cols: 8, rows: 3, page: 0 });
  assertEquals(none.keys[1][1]?.dim, true);
  const sel = layoutCells(buildCells(base({ channels: [ch("a", { selected: true }), ch("b", { selected: true })] }), 8), { cols: 8, rows: 3, page: 0 });
  assertEquals(sel.keys[0][0]?.icon, "✓");
  assertEquals(sel.keys[1][1]?.dim, false);
  assertEquals(sel.keys[1][1]?.sub, "2×");
});

Deno.test("Vorgemerkte Aktion verlangt zweiten Druck", () => {
  assertEquals(needsConfirm(2, null, "next"), true);
  assertEquals(needsConfirm(2, "next", "next"), false);
  assertEquals(needsConfirm(1, null, "next"), false);
  const g = layoutCells(buildCells(base({ armed: "take", channels: [ch("a", { selected: true }), ch("b", { selected: true })] }), 8), { cols: 8, rows: 3, page: 0 });
  assertEquals(g.keys[1][2]?.state, "cue");
});

Deno.test("Channel-Ansicht: Zurück, Wechsel, Aktionen nur für den geöffneten Channel", () => {
  const input = base({ openKey: "b" });
  const g = layoutCells(buildCells(input, 8), { cols: 8, rows: 3, page: 0 });
  assertEquals(g.acts[0][0], { t: "back" });
  assertEquals(g.acts[0][2], { t: "open", key: "b" });
  assertEquals(g.keys[0][2]?.icon, "▶");
  assertEquals(actionTargets(input), ["b"]);
  assertEquals(g.keys[1][1]?.dim, false);
});

Deno.test("Nächste Handlung: Dringlichkeit als Tastenfarbe", () => {
  const mk = (inMs: number) => layoutCells(buildCells(base({ attention: { key: "a", channel: "A", label: "x", inMs, kind: "live" } }), 8), { cols: 8, rows: 3, page: 0 }).keys[1][0];
  assertEquals(mk(120_000)?.state, "off");
  assertEquals(mk(30_000)?.state, "cue");
  assertEquals(mk(5_000)?.state, "error");
});

Deno.test("Kleines Gerät blättert und lässt die letzte Taste frei", () => {
  const cells = buildCells(base(), 4);
  const p0 = layoutCells(cells, { cols: 4, rows: 1, page: 0 });
  assertEquals(p0.pages > 1, true);
  assertEquals(p0.keys[0][3], null);
  const last = layoutCells(cells, { cols: 4, rows: 1, page: p0.pages - 1 });
  assertEquals(last.keys[0].some((k) => k !== null), true);
  assertEquals(layoutCells(cells, { cols: 4, rows: 1, page: 99 }).keys[0].some((k) => k !== null), true);
});
