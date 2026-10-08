// Cloud-Vorschläge für den Scheduler (ARCHITECTURE.md §27.4, UMSETZUNG.md 35.4): aus den überlasteten
// Zeit-Slots der Auto-Lane wird berechnet, wie viele Cloud-Hosts welchen Typs den Engpass auflösen würden.
// Reine Funktionen ohne DOM; die Kosten liefert der Server (`POST /api/v1/cloud/estimate`).
import type { Capacity, LaneSlot } from "./scheduler-logic.ts";

export interface CloudType {
  name: string;
  vcpu: number;
  memGb: number;
  gpu: number;
  pricePerHour: number;
  currency: string;
}

export interface Thresholds {
  cpu: number;
  mem: number;
  gpu?: number;
}

// Zusatzbedarf eines Slots über der vorhandenen (Grenzwert-)Kapazität.
export interface CloudNeed {
  extraCores: number;
  extraMemBytes: number;
  extraGpuPercent: number;
}

const GIB = 1024 ** 3;

// null: der Slot ist in CPU/RAM/GPU nicht überlastet. Netz- und I/O-Port-Engpässe löst ein Cloud-Host nicht
// (kein Multicast/keine Karten in der Cloud) und zählen deshalb nicht.
export function slotNeed(slot: LaneSlot, cap: Capacity, th: Thresholds): CloudNeed | null {
  const gpuThr = th.gpu ?? 85;
  const extraCores = cap.cpuCores > 0 ? Math.max(0, slot.cpuCores - (cap.cpuCores * th.cpu) / 100) : 0;
  const extraMemBytes = cap.memBytes > 0 ? Math.max(0, slot.rssBytes - (cap.memBytes * th.mem) / 100) : 0;
  const extraGpuPercent = Math.max(0, slot.gpuPercent - (cap.gpuPercent * gpuThr) / 100);
  if (extraCores <= 0 && extraMemBytes <= 0 && extraGpuPercent <= 0) return null;
  return { extraCores, extraMemBytes, extraGpuPercent };
}

// Anzahl Hosts des Typs für den Zusatzbedarf; Infinity, wenn der Typ ihn nie decken kann (GPU-Bedarf ohne GPU).
export function hostsFor(t: CloudType, need: CloudNeed, th: Thresholds): number {
  const gpuThr = th.gpu ?? 85;
  let n = 1;
  if (need.extraCores > 0) n = Math.max(n, Math.ceil(need.extraCores / ((t.vcpu * th.cpu) / 100)));
  if (need.extraMemBytes > 0) n = Math.max(n, Math.ceil(need.extraMemBytes / ((t.memGb * GIB * th.mem) / 100)));
  if (need.extraGpuPercent > 0) {
    if (t.gpu <= 0) return Infinity;
    n = Math.max(n, Math.ceil(need.extraGpuPercent / ((t.gpu * 100 * gpuThr) / 100)));
  }
  return Number.isFinite(n) ? n : Infinity;
}

// Günstigster Typ für einen Spitzenbedarf (Hosts × Stundenpreis; bei Gleichstand weniger Hosts, dann Name).
export function pickType(types: CloudType[], need: CloudNeed, th: Thresholds): { type: CloudType; hosts: number } | null {
  let best: { type: CloudType; hosts: number; cost: number } | null = null;
  for (const t of types) {
    const hosts = hostsFor(t, need, th);
    if (!Number.isFinite(hosts)) continue;
    const cost = hosts * t.pricePerHour;
    if (!best || cost < best.cost || (cost === best.cost && (hosts < best.hosts || (hosts === best.hosts && t.name < best.type.name)))) {
      best = { type: t, hosts, cost };
    }
  }
  return best ? { type: best.type, hosts: best.hosts } : null;
}

export interface CloudDemand {
  instanceType: string;
  count: number;
  from: string; // ISO
  to: string; // ISO
}

export interface CloudSuggestion {
  fromIdx: number; // erster überlasteter Slot
  toIdx: number; // letzter überlasteter Slot (einschließlich)
  from: Date;
  to: Date;
  type: CloudType;
  peakHosts: number;
  demands: CloudDemand[];
}

// Ein Vorschlag je zusammenhängendem Engpass. Typ nach dem Spitzenbedarf des Abschnitts; je Slot dann die dafür
// nötige Hostzahl, aufeinanderfolgende Slots gleicher Zahl werden zu einem Bedarf zusammengefasst.
export function suggestForLane(
  slots: LaneSlot[],
  cap: Capacity,
  th: Thresholds,
  slotStarts: Date[],
  slotMinutes: number,
  types: CloudType[],
): CloudSuggestion[] {
  const needs = slots.map((s) => slotNeed(s, cap, th));
  const out: CloudSuggestion[] = [];
  let i = 0;
  while (i < needs.length) {
    if (!needs[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < needs.length && needs[j + 1]) j++;
    const peak: CloudNeed = { extraCores: 0, extraMemBytes: 0, extraGpuPercent: 0 };
    for (let k = i; k <= j; k++) {
      const n = needs[k]!;
      peak.extraCores = Math.max(peak.extraCores, n.extraCores);
      peak.extraMemBytes = Math.max(peak.extraMemBytes, n.extraMemBytes);
      peak.extraGpuPercent = Math.max(peak.extraGpuPercent, n.extraGpuPercent);
    }
    const pick = pickType(types, peak, th);
    if (pick) {
      const demands: CloudDemand[] = [];
      for (let k = i; k <= j; k++) {
        const count = hostsFor(pick.type, needs[k]!, th);
        const from = slotStarts[k];
        const to = new Date(from.getTime() + slotMinutes * 60000);
        const last = demands[demands.length - 1];
        if (last && last.count === count && last.to === from.toISOString()) last.to = to.toISOString();
        else demands.push({ instanceType: pick.type.name, count, from: from.toISOString(), to: to.toISOString() });
      }
      out.push({
        fromIdx: i,
        toIdx: j,
        from: slotStarts[i],
        to: new Date(slotStarts[j].getTime() + slotMinutes * 60000),
        type: pick.type,
        peakHosts: pick.hosts,
        demands,
      });
    }
    i = j + 1;
  }
  return out;
}
