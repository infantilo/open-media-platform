import { assertEquals } from "jsr:@std/assert";
import { hotspot, MAX_PICTURES, pictureIds, type WallEvent, wallSignature } from "./wall-logic.ts";

const ev = (id: string, level: string, state = "live"): WallEvent => ({ id, name: id, state, level, canvasW: 1280, canvasH: 720, lines: [], alarmCount: 0 });

Deno.test("Events mit Fehler oder Warnung bekommen automatisch ein Bild, ruhige nicht", () => {
  const got = pictureIds([ev("a", "ok"), ev("b", "bad"), ev("c", "warn"), ev("d", "")], new Set());
  assertEquals(got, ["b", "c"]);
});

Deno.test("angeheftete Events zählen dazu; geplante nie; höchstens MAX_PICTURES", () => {
  assertEquals(pictureIds([ev("a", "ok"), ev("p", "bad", "planned")], new Set(["a", "p"])), ["a"]);
  const many = ["1", "2", "3", "4", "5"].map((i) => ev(i, "bad"));
  assertEquals(pictureIds(many, new Set()).length, MAX_PICTURES);
});

Deno.test("Klickfläche in Prozent; ohne Maße keine", () => {
  const l = { id: "l", name: "A", level: "ok", umd: "", alarms: [], x: 640, y: 360, w: 320, h: 180 };
  assertEquals(hotspot(l, 1280, 720), { left: 50, top: 50, width: 25, height: 25 });
  assertEquals(hotspot({ ...l, w: 0 }, 1280, 720), null);
  assertEquals(hotspot(l, 0, 0), null);
});

Deno.test("Signatur ändert sich nur bei sichtbarer Änderung", () => {
  assertEquals(wallSignature([ev("a", "ok")]), wallSignature([ev("a", "ok")]));
  assertEquals(wallSignature([ev("a", "ok")]) === wallSignature([ev("a", "bad")]), false);
});

Deno.test("Hinweise werden je Alarm genau einmal gemeldet", async () => {
  const { newNotices } = await import("./wall-logic.ts");
  const a = { id: "x1", lineId: "l", lineName: "A", kind: "signal-black", severity: "critical", text: "", since: "" };
  const e = { ...ev("e1", "bad"), notices: [a] };
  const seen = new Set<string>();
  assertEquals(newNotices([e], seen).length, 1);
  seen.add("x1");
  assertEquals(newNotices([e], seen).length, 0);
  assertEquals(newNotices([ev("e2", "ok")], seen).length, 0);
});
