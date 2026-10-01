import { assertEquals } from "jsr:@std/assert@1";
import {
  activeAt,
  AUTO_LANE,
  computeTimeline,
  findBottlenecks,
  isOver,
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

Deno.test("Netz: Rx/Tx getrennt gegen den Link, Engpass trotz freier CPU", () => {
  const netModel: ResourceModel = {
    thresholds: { cpu: 85, mem: 90, net: 85 },
    hosts: [
      { id: "h1", label: "Regie A", online: true, numCpu: 32, memTotalBytes: 64 * GB, capacityKnown: true, netLinkMbps: 10000 },
      { id: "h2", label: "ohne Link", online: true, numCpu: 8, memTotalBytes: 16 * GB, capacityKnown: true },
    ],
    workflows: [
      {
        id: "a", name: "A", status: "stopped",
        roles: [{ name: "Aus1", nodeType: "g", hostId: "h1", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, netTxMbps: 4400 }],
      },
      {
        id: "b", name: "B", status: "stopped",
        roles: [
          { name: "Aus2", nodeType: "g", hostId: "h1", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, netTxMbps: 4400, netEstimated: true },
          // Empfang zählt in die andere Richtung, nicht zum Tx dazu
          { name: "Ein", nodeType: "g", hostId: "h1", cpuCores: 0, cpuAvgCores: 0, rssBytes: 0, known: false, netRxMbps: 2200 },
          { name: "Aus3", nodeType: "g", hostId: "h2", cpuCores: 0, cpuAvgCores: 0, rssBytes: 0, known: false, netTxMbps: 2200 },
        ],
      },
    ],
  };
  const scheds = new Map<string, Schedule[]>([
    ["a", [daily("start", "09:00"), daily("stop", "12:00")]],
    ["b", [daily("start", "11:00"), daily("stop", "13:00")]],
  ]);
  const tl = computeTimeline(netModel, scheds, slotsOfDay(at(2026, 10, 2, 0)), 30, at(2026, 10, 1, 6));
  const cap = laneCapacity(netModel, "h1");
  assertEquals(cap.netMbps, 10000);

  // 10:00: nur A → Tx 4,4 Gbit/s von 10 = 44 % ok
  let u = slotUtilization(tl.get("h1")![10 * 2], cap, netModel.thresholds);
  assertEquals(u.netLevel, "ok");
  // 11:30: A+B → Tx 8,8 von 10 = 88 % > 85 → over, obwohl CPU kaum belastet
  const slot = tl.get("h1")![11 * 2 + 1];
  u = slotUtilization(slot, cap, netModel.thresholds);
  assertEquals(slot.netTxMbps, 8800);
  assertEquals(slot.netRxMbps, 2200);
  assertEquals(slot.netEstimated, true);
  assertEquals(u.netLevel, "over");
  assertEquals(u.cpuLevel, "ok");
  assertEquals(isOver(u), true);
  assertEquals(findBottlenecks(netModel, tl).some((b) => b.laneId === "h1" && b.what.includes("Netz")), true);

  // Host ohne Link: Bedarf bleibt sichtbar, Auslastung unbekannt (nie "frei")
  const noLink = tl.get("h2")![11 * 2 + 1];
  assertEquals(noLink.netTxMbps, 2200);
  const u2 = slotUtilization(noLink, laneCapacity(netModel, "h2"), netModel.thresholds);
  assertEquals(u2.netPercent, null);
  assertEquals(u2.netLevel, "unknown");
});

Deno.test("Manuell gestartete Instanzen zählen endlos in jedem Slot auf ihrem Host", () => {
  const m: ResourceModel = {
    thresholds: { cpu: 85, mem: 90, net: 85 },
    hosts: [{ id: "h1", label: "A", online: true, numCpu: 4, memTotalBytes: 8 * GB, capacityKnown: true, netLinkMbps: 1000 }],
    workflows: [],
    manualInstances: [
      { id: "i1", label: "Ton", nodeType: "t", hostId: "h1", cpuCores: 1.5, rssBytes: GB, known: true, measured: true, netTxMbps: 600 },
      { id: "i2", label: "Neu", nodeType: "x", hostId: "h1", cpuCores: 0, rssBytes: 0, known: false },
    ],
  };
  const now = at(2026, 10, 1, 10);
  // Slots heute und in drei Tagen — beide enthalten die Last, obwohl kein Zeitplan existiert
  const slots = [at(2026, 10, 1, 12), at(2026, 10, 4, 3)];
  const tl = computeTimeline(m, new Map(), slots, 30, now);
  for (const slot of tl.get("h1")!) {
    assertEquals(slot.cpuCores, 1.5);
    assertEquals(slot.netTxMbps, 600);
    assertEquals(slot.unknown, ["Manuell/Neu"]);
    assertEquals(slot.contribs[0].wfName, "Manuell gestartet");
  }
});

Deno.test("Jetzt-Slot: gemessene Host-Last ist Untergrenze, andere Slots bleiben Planung", () => {
  const m: ResourceModel = {
    thresholds: { cpu: 85, mem: 90, net: 85 },
    hosts: [{
      id: "h1", label: "A", online: true, numCpu: 4, memTotalBytes: 8 * GB, capacityKnown: true, netLinkMbps: 1000,
      live: { cpuPercent: 50, memPercent: 10, netRxMbps: 100, netTxMbps: 700 },
    }],
    workflows: [],
    manualInstances: [{ id: "i1", label: "T", nodeType: "t", hostId: "h1", cpuCores: 0.5, rssBytes: 4 * GB, known: true, netTxMbps: 200 }],
  };
  const now = at(2026, 10, 1, 10, 10);
  const tl = computeTimeline(m, new Map(), [at(2026, 10, 1, 10), at(2026, 10, 1, 11)], 30, now);
  const [jetzt, spaeter] = tl.get("h1")!;
  // gemessen: 2 Kerne > geplant 0,5; RAM geplant 4 GB > gemessen 0,8 GB; Tx gemessen 700 > 200
  assertEquals(jetzt.cpuCores, 2);
  assertEquals(jetzt.rssBytes, 4 * GB);
  assertEquals(jetzt.netTxMbps, 700);
  assertEquals(jetzt.netRxMbps, 100);
  assertEquals(jetzt.liveFloor, ["CPU", "Netz"]);
  assertEquals(spaeter.cpuCores, 0.5);
  assertEquals(spaeter.netTxMbps, 200);
  assertEquals(spaeter.liveFloor, []);
});

Deno.test("GPU: Bedarf nur aus gemessenen Profilen, Kapazität = eine GPU je meldendem Host", () => {
  const m: ResourceModel = {
    thresholds: { cpu: 85, mem: 90, net: 85, gpu: 85 },
    hosts: [
      { id: "g1", label: "GPU-Host", online: true, numCpu: 16, memTotalBytes: 32 * GB, capacityKnown: true, gpu: { count: 1, utilPercent: 90, memUsedBytes: 2 * GB, memTotalBytes: 8 * GB }, live: { cpuPercent: 5, memPercent: 5, gpuPercent: 90 } },
      { id: "c1", label: "ohne GPU", online: true, numCpu: 8, memTotalBytes: 16 * GB, capacityKnown: true },
    ],
    workflows: [{
      id: "w", name: "AI", status: "stopped",
      roles: [
        { name: "Enc1", nodeType: "e", hostId: "g1", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, gpuKnown: true, gpuPercent: 50 },
        { name: "Enc2", nodeType: "e", hostId: "g1", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, gpuKnown: true, gpuPercent: 45 },
        // Profil ohne GPU-Messung: kein Bedarf angesetzt, aber auch nicht "unvollständig"
        { name: "Plain", nodeType: "p", hostId: "g1", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true },
      ],
    }],
    manualInstances: [],
  };
  const scheds = new Map<string, Schedule[]>([["w", [daily("start", "09:00"), daily("stop", "12:00")]]]);
  const now = at(2026, 10, 1, 6);
  const tl = computeTimeline(m, scheds, slotsOfDay(at(2026, 10, 2, 0)), 30, now);
  const slot = tl.get("g1")![10 * 2];
  assertEquals(slot.gpuPercent, 95);
  assertEquals(slot.unknown, []);
  const cap = laneCapacity(m, "g1");
  assertEquals(cap.gpuPercent, 100);
  const u = slotUtilization(slot, cap, m.thresholds);
  assertEquals(u.gpuLevel, "over"); // 95 % > 85 %
  assertEquals(findBottlenecks(m, tl).some((b) => b.laneId === "g1" && b.what.includes("GPU")), true);
  // Host ohne GPU: keine Kapazität → Auslastung unbekannt, kein "frei"
  assertEquals(laneCapacity(m, "c1").gpuPercent, 0);
  assertEquals(slotUtilization(tl.get("c1")![10 * 2], laneCapacity(m, "c1"), m.thresholds).gpuPercent, null);
  // "Jetzt"-Slot: gemessene Host-GPU (90 %) ist Untergrenze
  const tlNow = computeTimeline(m, new Map(), [at(2026, 10, 1, 6)], 30, at(2026, 10, 1, 6, 10));
  assertEquals(tlNow.get("g1")![0].gpuPercent, 90);
  assertEquals(tlNow.get("g1")![0].liveFloor.includes("GPU"), true);
});

Deno.test("VRAM: harte Grenze, GPU-Pool mit mehreren GPUs, Jetzt-Messung als Untergrenze", () => {
  const m: ResourceModel = {
    thresholds: { cpu: 85, mem: 90, net: 85, gpu: 85 },
    hosts: [{
      id: "g2", label: "2 GPUs", online: true, numCpu: 16, memTotalBytes: 32 * GB, capacityKnown: true,
      gpu: { count: 2, utilPercent: 10, memUsedBytes: 15 * GB, memTotalBytes: 16 * GB },
    }],
    workflows: [{
      id: "w", name: "AI", status: "stopped",
      roles: [
        { name: "A", nodeType: "e", hostId: "g2", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, gpuKnown: true, gpuPercent: 80, gpuMemBytes: 7 * GB },
        { name: "B", nodeType: "e", hostId: "g2", cpuCores: 1, cpuAvgCores: 1, rssBytes: GB, known: true, gpuKnown: true, gpuPercent: 80, gpuMemBytes: 8 * GB },
      ],
    }],
  };
  const scheds = new Map<string, Schedule[]>([["w", [daily("start", "09:00"), daily("stop", "12:00")]]]);
  const tl = computeTimeline(m, scheds, slotsOfDay(at(2026, 10, 2, 0)), 30, at(2026, 10, 1, 6));
  const cap = laneCapacity(m, "g2");
  assertEquals(cap.gpuPercent, 200); // 2 GPUs
  assertEquals(cap.vramBytes, 16 * GB);
  const slot = tl.get("g2")![10 * 2];
  const u = slotUtilization(slot, cap, m.thresholds);
  assertEquals(slot.gpuPercent, 160);
  assertEquals(u.gpuLevel, "warn"); // 80 % von 200 liegt unter dem Grenzwert 85
  assertEquals(slot.gpuMemBytes, 15 * GB);
  assertEquals(u.vramLevel, "over"); // 15/16 = 94 % > 90 %: VRAM ist hart, schon 15 GB reichen
  assertEquals(findBottlenecks(m, tl).some((b) => b.what.includes("VRAM")), true);
  const now = computeTimeline(m, new Map(), [at(2026, 10, 1, 6)], 30, at(2026, 10, 1, 6, 5));
  assertEquals(now.get("g2")![0].gpuMemBytes, 15 * GB);
  assertEquals(now.get("g2")![0].liveFloor.includes("VRAM"), true);
  assertEquals(now.get("g2")![0].gpuPercent, 20); // 10 % von 2 GPUs
});
