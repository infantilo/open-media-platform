import { assertEquals } from "jsr:@std/assert@1";
import { actionTargets, buildCells, layoutCells, needsConfirm, type DeckChannel, type DeckInput } from "./deck-logic.ts";

const ch = (key: string, o: Partial<DeckChannel> = {}): DeckChannel => ({ key, name: key.toUpperCase(), health: "ok", remainingMs: 65_000, onAir: true, selected: false, ...o });
const base = (o: Partial<DeckInput> = {}): DeckInput => ({ channels: [ch("a"), ch("b"), ch("c", { health: "offline", onAir: false })], openKey: null, gangView: false, armed: null, ...o });
const xl = { cols: 8, rows: 3, page: 0 };
const grid = (i: DeckInput) => layoutCells(buildCells(i, 8), xl);

Deno.test("Standardansicht: Channel-Taste öffnet, Steuerzeile nur Handlung + GANG ROLL", () => {
  const g = grid(base());
  assertEquals(g.pages, 1);
  assertEquals(g.keys[0].slice(0, 3).map((k) => k?.label), ["A", "B", "C"]);
  assertEquals(g.keys[0][0]?.sub, "1:05");
  assertEquals(g.keys[0][2]?.dim, true);
  assertEquals(g.acts[0][0], { t: "open", key: "a" });
  assertEquals(g.keys[1][0]?.dim, true); // keine Aufmerksamkeit → gedimmte Info-Taste
  assertEquals(g.keys[1][1]?.label, "GANG ROLL");
  assertEquals(g.acts[1][1], { t: "gang" });
  assertEquals(g.keys[1][2], null); // keine Aktionstasten in der Standardansicht
});

Deno.test("Gruppenmitglieder zeigen den Haken, die Zahl steht am GANG-ROLL-Eingang", () => {
  const g = grid(base({ channels: [ch("a", { selected: true }), ch("b", { selected: true }), ch("c")] }));
  assertEquals(g.keys[0][0]?.icon, "✓");
  assertEquals(g.keys[0][2]?.icon, undefined);
  assertEquals(g.keys[1][1]?.sub, "2 im Gang");
});

Deno.test("Untermenü Gang Roll: Zurück, Channel-Tasten fügen hinzu/entfernen, Aktionen auf die Gruppe", () => {
  const none = grid(base({ gangView: true }));
  assertEquals(none.acts[0][0], { t: "back" });
  assertEquals(none.acts[0][1], { t: "select", key: "a" });
  assertEquals(none.keys[1][1]?.label, "NEXT");
  assertEquals(none.keys[1][1]?.dim, true); // ohne Gruppe nicht bedienbar
  const sel = grid(base({ gangView: true, channels: [ch("a", { selected: true }), ch("b", { selected: true })] }));
  assertEquals(sel.keys[0][1]?.icon, "✓");
  assertEquals(sel.keys[1][1]?.dim, false);
  assertEquals(sel.keys[1][1]?.sub, "2×");
  assertEquals(sel.keys[1].slice(1, 6).map((k) => k?.label), ["NEXT", "TAKE", "N.LIVE", "HOLD", "AUTO"]);
  assertEquals(sel.keys[1][6]?.label, "Alle wählen");
});

Deno.test("Vorgemerkte Aktion verlangt zweiten Druck", () => {
  assertEquals(needsConfirm(2, null, "next"), true);
  assertEquals(needsConfirm(2, "next", "next"), false);
  assertEquals(needsConfirm(1, null, "next"), false);
  const g = grid(base({ gangView: true, armed: "take", channels: [ch("a", { selected: true }), ch("b", { selected: true })] }));
  assertEquals(g.keys[1][2]?.state, "cue");
  assertEquals(g.keys[1][2]?.sub, "nochmal");
});

Deno.test("Channel-Ansicht: Wechsel, Aktionen nur für den offenen Channel, GANG +/− für diesen Channel", () => {
  const input = base({ openKey: "b" });
  const g = grid(input);
  assertEquals(g.acts[0][0], { t: "back" });
  assertEquals(g.acts[0][2], { t: "open", key: "b" });
  assertEquals(g.keys[0][2]?.icon, "▶");
  assertEquals(actionTargets(input), ["b"]);
  assertEquals(g.keys[1][1]?.dim, false);
  const labels = g.keys[1].map((k) => k?.label);
  assertEquals(labels.includes("GANG +"), true);
  const gangKey = g.acts[1].findIndex((a) => a?.t === "select");
  assertEquals(g.acts[1][gangKey], { t: "select", key: "b" });
  const member = grid(base({ openKey: "b", channels: [ch("a"), ch("b", { selected: true })] }));
  assertEquals(member.keys[1].some((k) => k?.label === "GANG −"), true);
});

Deno.test("Nächste Handlung: Dringlichkeit als Tastenfarbe", () => {
  const mk = (inMs: number) => grid(base({ attention: { key: "a", channel: "A", label: "x", inMs, kind: "live" } })).keys[1][0];
  assertEquals(mk(120_000)?.state, "off");
  assertEquals(mk(30_000)?.state, "cue");
  assertEquals(mk(5_000)?.state, "error");
});

Deno.test("Kleines Gerät blättert und lässt die letzte Taste frei", () => {
  const cells = buildCells(base({ gangView: true }), 4);
  const p0 = layoutCells(cells, { cols: 4, rows: 1, page: 0 });
  assertEquals(p0.pages > 1, true);
  assertEquals(p0.keys[0][3], null);
  const last = layoutCells(cells, { cols: 4, rows: 1, page: p0.pages - 1 });
  assertEquals(last.keys[0].some((k) => k !== null), true);
  assertEquals(layoutCells(cells, { cols: 4, rows: 1, page: 99 }).keys[0].some((k) => k !== null), true);
});
