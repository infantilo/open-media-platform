import { assertEquals } from "jsr:@std/assert@1";
import { hostsFor, pickType, slotNeed, suggestForLane, type CloudType } from "./scheduler-cloud-logic.ts";
import type { Capacity, LaneSlot } from "./scheduler-logic.ts";

const GIB = 1024 ** 3;
const th = { cpu: 80, mem: 80, gpu: 85 };
const cap: Capacity = { cpuCores: 8, memBytes: 16 * GIB, netMbps: 0, gpuPercent: 0, vramBytes: 0, io: {} };
const small: CloudType = { name: "m.medium", vcpu: 2, memGb: 4, gpu: 0, pricePerHour: 0.1, currency: "EUR" };
const big: CloudType = { name: "m.xlarge", vcpu: 8, memGb: 32, gpu: 0, pricePerHour: 0.5, currency: "EUR" };
const gpuT: CloudType = { name: "g.large", vcpu: 8, memGb: 32, gpu: 1, pricePerHour: 0.9, currency: "EUR" };

function slot(cpu: number, rssGiB = 0, gpu = 0): LaneSlot {
  return { cpuCores: cpu, rssBytes: rssGiB * GIB, netRxMbps: 0, netTxMbps: 0, netEstimated: false, gpuPercent: gpu, gpuMemBytes: 0, io: {}, contribs: [], unknown: [], liveFloor: [] };
}

Deno.test("slotNeed: nur der Anteil über dem Grenzwert zählt", () => {
  // 8 Kerne × 80 % = 6,4 nutzbar; 8 Kerne Bedarf → 1,6 zusätzlich.
  const n = slotNeed(slot(8), cap, th)!;
  assertEquals(Math.round(n.extraCores * 100) / 100, 1.6);
  assertEquals(slotNeed(slot(6), cap, th), null);
});

Deno.test("hostsFor: größte Dimension entscheidet, GPU ohne GPU-Typ unmöglich", () => {
  // 1,6 Kerne / (2 × 0,8) = 1 Host; RAM 10 GiB / (4 × 0,8) = 4 Hosts.
  const need = { extraCores: 1.6, extraMemBytes: 10 * GIB, extraGpuPercent: 0 };
  assertEquals(hostsFor(small, need, th), 4);
  assertEquals(hostsFor(big, need, th), 1);
  assertEquals(hostsFor(small, { extraCores: 0, extraMemBytes: 0, extraGpuPercent: 50 }, th), Infinity);
  assertEquals(hostsFor(gpuT, { extraCores: 0, extraMemBytes: 0, extraGpuPercent: 50 }, th), 1);
});

Deno.test("pickType: günstigste Gesamtkosten, GPU-Bedarf nur mit GPU-Typ", () => {
  // 4 × small = 0,40 €/h gegen 1 × big = 0,50 €/h → small.
  const need = { extraCores: 1.6, extraMemBytes: 10 * GIB, extraGpuPercent: 0 };
  assertEquals(pickType([small, big], need, th)!.type.name, "m.medium");
  assertEquals(pickType([small, big], { extraCores: 0, extraMemBytes: 0, extraGpuPercent: 40 }, th), null);
  assertEquals(pickType([small, big, gpuT], { extraCores: 0, extraMemBytes: 0, extraGpuPercent: 40 }, th)!.type.name, "g.large");
});

Deno.test("suggestForLane: ein Vorschlag je Engpass, gleiche Hostzahl wird zusammengefasst", () => {
  const t0 = new Date("2026-10-08T10:00:00Z");
  const starts = Array.from({ length: 6 }, (_, i) => new Date(t0.getTime() + i * 30 * 60000));
  // Slots 1–3 überlastet (8,0 / 9,5 / 9,5 Kerne), Rest ok.
  const slots = [slot(2), slot(8), slot(9.5), slot(9.5), slot(2), slot(2)];
  const s = suggestForLane(slots, cap, th, starts, 30, [small]);
  assertEquals(s.length, 1);
  assertEquals([s[0].fromIdx, s[0].toIdx], [1, 3]);
  assertEquals(s[0].from.toISOString(), "2026-10-08T10:30:00.000Z");
  assertEquals(s[0].to.toISOString(), "2026-10-08T12:00:00.000Z");
  // 1,6/1,6 = 1 Host; (9,5−6,4)/1,6 = 2 Hosts (aufgerundet) → zwei Bedarfe: 1 Host 1 Slot, 2 Hosts 2 Slots.
  assertEquals(s[0].demands.map((d) => d.count), [1, 2]);
  assertEquals(s[0].demands[1].from, "2026-10-08T11:00:00.000Z");
  assertEquals(s[0].demands[1].to, "2026-10-08T12:00:00.000Z");
  assertEquals(s[0].peakHosts, 2);
});

Deno.test("suggestForLane: getrennte Engpässe und nicht lösbare ergeben getrennte/keine Vorschläge", () => {
  const t0 = new Date("2026-10-08T10:00:00Z");
  const starts = Array.from({ length: 5 }, (_, i) => new Date(t0.getTime() + i * 30 * 60000));
  const slots = [slot(9), slot(2), slot(9), slot(2), slot(2)];
  assertEquals(suggestForLane(slots, cap, th, starts, 30, [small]).length, 2);
  // GPU-Engpass ohne GPU-Typ: kein Vorschlag.
  const gslots = [slot(0, 0, 200)];
  const gcap: Capacity = { ...cap, gpuPercent: 100 };
  assertEquals(suggestForLane(gslots, gcap, th, starts, 30, [small]).length, 0);
});
