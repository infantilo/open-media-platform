import { assertEquals } from "jsr:@std/assert@1";
import {
  activeAt,
  AUTO_LANE,
  computeTimeline,
  findBottlenecks,
  laneCapacity,
  levelOf,
  occurrenceMinutes,
  type ResourceModel,
  type Schedule,
  slotUtilization,
} from "./scheduler-logic.ts";

const GB = 1024 ** 3;
const daily = (action: "start" | "stop", tod: string, id = crypto.randomUUID()): Schedule => ({ id, kind: "daily", action, timeOfDay: tod });
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

Deno.test("occurrenceMinutes: daily, weekly, once", () => {
  assertEquals(occurrenceMinutes(daily("start", "09:30"), at(2026, 10, 1, 0)), 570);
  const weekly: Schedule = { id: "w", kind: "weekly", action: "start", timeOfDay: "08:00", weekday: 4 };
  assertEquals(occurrenceMinutes(weekly, at(2026, 10, 1, 0)), 480); // 2026-10-01 ist ein Donnerstag
  assertEquals(occurrenceMinutes(weekly, at(2026, 10, 2, 0)), null);
  const once: Schedule = { id: "o", kind: "once", action: "start", at: at(2026, 10, 1, 7, 15).toISOString() };
  assertEquals(occurrenceMinutes(once, at(2026, 10, 1, 0)), 435);
  assertEquals(occurrenceMinutes(once, at(2026, 10, 2, 0)), null);
});

Deno.test("activeAt: Tagesfenster und Mitternachts-Überlauf", () => {
  const s = [daily("start", "09:00"), daily("stop", "17:00")];
  const now = at(2026, 10, 1, 6);
  assertEquals(activeAt(s, "stopped", at(2026, 10, 2, 8, 59), now), false);
  assertEquals(activeAt(s, "stopped", at(2026, 10, 2, 9, 0), now), true);
  assertEquals(activeAt(s, "stopped", at(2026, 10, 2, 16, 59), now), true);
  assertEquals(activeAt(s, "stopped", at(2026, 10, 2, 17, 0), now), false);
  // Nachtfenster 22:00-06:00: um 03:00 läuft es (Start war am Vortag)
  const night = [daily("start", "22:00"), daily("stop", "06:00")];
  assertEquals(activeAt(night, "stopped", at(2026, 10, 3, 3), now), true);
  assertEquals(activeAt(night, "stopped", at(2026, 10, 3, 12), now), false);
});

Deno.test("activeAt: von Hand gestarteter Workflow zählt bis zum geplanten Stop", () => {
  const s = [daily("stop", "17:00")];
  const now = at(2026, 10, 1, 10);
  assertEquals(activeAt(s, "started", at(2026, 10, 1, 12), now), true);
  assertEquals(activeAt(s, "started", at(2026, 10, 1, 17, 30), now), false);
  // gestoppt und ohne Start-Ereignis: bleibt gestoppt
  assertEquals(activeAt(s, "stopped", at(2026, 10, 1, 12), now), false);
});

const model: ResourceModel = {
  thresholds: { cpu: 85, mem: 90 },
  hosts: [
    { id: "", label: "lokal", local: true, online: true, numCpu: 4, memTotalBytes: 8 * GB, capacityKnown: true },
    {
      id: "h1", label: "Regie A", online: true, numCpu: 8, memTotalBytes: 16 * GB, capacityKnown: true,
      ioPorts: [{ cardType: "decklink", direction: "in", total: 1, claimed: 0 }],
    },
    { id: "h2", label: "offline", online: false, numCpu: 64, memTotalBytes: 256 * GB, capacityKnown: true },
  ],
  workflows: [
    {
      id: "w1", name: "Show", status: "stopped",
      roles: [
        { name: "Mix", nodeType: "m", hostId: "h1", cpuCores: 5, cpuAvgCores: 4, rssBytes: 4 * GB, known: true },
        { name: "Karte", nodeType: "d", hostId: "h1", cpuCores: 0.5, cpuAvgCores: 0.4, rssBytes: 1 * GB, known: true, ioPort: { cardType: "decklink", direction: "in" } },
      ],
    },
    {
      id: "w2", name: "News", status: "stopped",
      roles: [
        { name: "Mix2", nodeType: "m", hostId: "h1", cpuCores: 3, cpuAvgCores: 2, rssBytes: 2 * GB, known: true },
        { name: "Karte2", nodeType: "d", hostId: "h1", cpuCores: 0.5, cpuAvgCores: 0.4, rssBytes: 1 * GB, known: true, ioPort: { cardType: "decklink", direction: "in" } },
        { name: "Neu", nodeType: "x", cpuCores: 0, cpuAvgCores: 0, rssBytes: 0, known: false },
      ],
    },
  ],
};

const slotsOfDay = (d: Date, minutes = 30) => Array.from({ length: 1440 / minutes }, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, i * minutes));

Deno.test("laneCapacity: Host bzw. alle erreichbaren Hosts für Auto", () => {
  assertEquals(laneCapacity(model, "h1").cpuCores, 8);
  const auto = laneCapacity(model, AUTO_LANE);
  assertEquals(auto.cpuCores, 12); // lokal 4 + h1 8; der offline-Host zählt nicht
  assertEquals(auto.io["decklink/in"], 1);
});

Deno.test("Überschneidung zweier Workflows erzeugt Engpass auf dem Host, nicht davor/danach", () => {
  const scheds = new Map<string, Schedule[]>([
    ["w1", [daily("start", "09:00"), daily("stop", "12:00")]],
    ["w2", [daily("start", "11:00"), daily("stop", "13:00")]],
  ]);
  const day = at(2026, 10, 2, 0);
  const slots = slotsOfDay(day);
  const tl = computeTimeline(model, scheds, slots, 30, at(2026, 10, 1, 6));
  const cap = laneCapacity(model, "h1");
  const idx = (h: number, m = 0) => h * 2 + (m ? 1 : 0);

  // 10:00: nur Show → 5.5 Kerne von 8 = 68,75 % → schon "warn" (ab 80 % des Grenzwerts 85 %)
  let u = slotUtilization(tl.get("h1")![idx(10)], cap, model.thresholds);
  assertEquals(u.cpuLevel, "warn");
  // 11:30: Show + News → 9 Kerne > 8 → CPU over; RAM 6/16 = 37 % ok
  u = slotUtilization(tl.get("h1")![idx(11, 30)], cap, model.thresholds);
  assertEquals(u.cpuLevel, "over");
  assertEquals(u.memLevel, "ok");
  // beide brauchen 1 decklink-in, es gibt nur 1 → I/O-Engpass
  assertEquals(u.ioOver, ["decklink/in"]);
  // 12:30: nur News → 3.5 Kerne
  u = slotUtilization(tl.get("h1")![idx(12, 30)], cap, model.thresholds);
  assertEquals(u.cpuLevel, "ok");
  assertEquals(u.ioOver.length, 0);
  // Freie Reserve bis zum Grenzwert (85 % von 8 = 6.8 Kerne minus 3.5)
  assertEquals(Math.round((u.freeCores ?? 0) * 10) / 10, 3.3);

  const bn = findBottlenecks(model, tl).filter((b) => b.laneId === "h1");
  assertEquals(bn.map((b) => b.slotIndex), [idx(11), idx(11, 30)]);
});

Deno.test("Rollen ohne Messprofil machen den Slot 'unvollständig', nicht 'frei'", () => {
  const scheds = new Map<string, Schedule[]>([["w2", [daily("start", "10:00"), daily("stop", "11:00")]]]);
  const tl = computeTimeline(model, scheds, slotsOfDay(at(2026, 10, 2, 0)), 30, at(2026, 10, 1, 6));
  const auto = tl.get(AUTO_LANE)![10 * 2];
  assertEquals(auto.unknown, ["News/Neu"]);
  const u = slotUtilization(auto, laneCapacity(model, AUTO_LANE), model.thresholds);
  assertEquals(u.incomplete, true);
});

Deno.test("levelOf: Grenzen", () => {
  assertEquals(levelOf(null, 85), "unknown");
  assertEquals(levelOf(0, 85), "free");
  assertEquals(levelOf(50, 85), "ok");
  assertEquals(levelOf(68, 85), "warn");
  assertEquals(levelOf(85, 85), "warn");
  assertEquals(levelOf(85.1, 85), "over");
});
