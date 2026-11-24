import { assertEquals } from "jsr:@std/assert";
import { mcrAdapter, type McrIO } from "./mcr.ts";
import { type DeckEvent, layoutMcr, type McrState } from "./mcr-logic.ts";

const graph = { planned: ["testing", "cancelled"], testing: ["live", "planned", "cancelled"], live: ["teardown"], teardown: ["done"] };
const ev = (id: string, state: string, o: Partial<DeckEvent> = {}): DeckEvent => ({
  id, name: id.toUpperCase(), state, level: "", lines: [{ id: `${id}-l1`, name: "PGM", level: "ok", alarms: [] }, { id: `${id}-l2`, name: "CLF", level: "bad", alarms: [{ id: "al1", kind: "signal-black", severity: "critical" }] }], ...o,
});
const base = (o: Partial<McrState> = {}): McrState => ({ events: [ev("a", "planned"), ev("b", "live", { level: "bad" })], graph, sel: null, act: "listen", armed: null, ...o });

Deno.test("Eventliste: Taste je Event mit Zustand, live = onair, Fehler = error", () => {
  const l = layoutMcr(base(), 8, 2, 0, 0);
  assertEquals(l.keys[0].slice(0, 2).map((k) => k?.sub), ["GEPLANT · 1⚠", "LIVE · 1⚠"]);
  assertEquals(l.keys[0][1]?.state, "error");
  assertEquals(l.act[0][0], { t: "open", id: "a" });
});

Deno.test("Detail: Zurück, Hauptschritt, andere Schritte, Quittieren, Leitungen", () => {
  const l = layoutMcr(base({ sel: "a" }), 8, 2, 0, 0);
  assertEquals(l.keys[0].slice(0, 7).map((k) => k?.label), ["ZURÜCK", "→ TEST", "→ ABGEBR.", "QUITT. ALLE", "HÖREN", "PGM", "CLF"]);
  assertEquals(l.act[0][1], { t: "step", to: "testing", confirm: false });
  assertEquals(l.act[0][2], { t: "step", to: "cancelled", confirm: true });
  assertEquals(l.act[0][6], { t: "line", id: "a-l2" });
});

Deno.test("Live → Abbau braucht Bestätigung; fehlendes Recht sperrt die Taste", () => {
  const l = layoutMcr(base({ sel: "b" }), 8, 2, 0, 0);
  assertEquals(l.act[0][1], { t: "step", to: "teardown", confirm: true });
  const denied = layoutMcr(base({ sel: "a", events: [ev("a", "planned", { access: { test: false, live: false } })] }), 8, 2, 0, 0);
  assertEquals(denied.act[0][1], null);
  assertEquals(denied.keys[0][1]?.dim, true);
});

Deno.test("scharf gestellt: Taste zeigt NOCHMAL, Seiten lassen Bedientasten auf jeder Seite", () => {
  const armed = layoutMcr(base({ sel: "b", armed: "teardown" }), 8, 2, 0, 0);
  assertEquals(armed.keys[0][1]?.label, "NOCHMAL");
  assertEquals(armed.act[0][1], { t: "step", to: "teardown", confirm: false });
  const lines = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `L${i}`, level: "ok", alarms: [] }));
  const p1 = layoutMcr(base({ sel: "b", events: [ev("b", "live", { lines })] }), 4, 2, 0, 1);
  assertEquals(p1.keys[0][0]?.label, "ZURÜCK");
  assertEquals(p1.pages! > 1, true);
});

Deno.test("Adapter: zweimal drücken schaltet, einmal nicht; Quittieren ruft ack", async () => {
  const calls: string[] = [];
  const io: McrIO = {
    load: () => Promise.resolve({ events: [ev("b", "live")], graph }),
    precheck: () => Promise.resolve(true),
    transition: (id, to) => (calls.push(`t ${id} ${to}`), Promise.resolve()),
    ack: (id, al) => (calls.push(`ack ${id} ${al}`), Promise.resolve()),
    station: (id, l, a) => (calls.push(`st ${id} ${l} ${a}`), Promise.resolve()),
    pipLock: () => Promise.resolve(),
  };
  const a = mcrAdapter(io);
  const ctx = { cols: 8, rows: 2, dials: 0, page: 0 };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  await a.refresh!();
  a.getLayout(ctx);
  a.onKey(0, 0, true); // Event öffnen
  await tick();
  a.getLayout(ctx);
  a.onKey(0, 1, true); // → Abbau: scharf
  await tick();
  assertEquals(calls, []);
  a.getLayout(ctx);
  a.onKey(0, 1, true); // bestätigt
  await tick();
  assertEquals(calls, ["t b teardown"]);
  a.getLayout(ctx);
  a.onKey(0, 2, true); // QUITT. ALLE
  await tick();
  assertEquals(calls[1], "ack b al1");
  a.dispose!();
});
