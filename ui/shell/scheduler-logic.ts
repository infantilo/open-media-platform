// Reine Logik des Schedulers (ohne DOM): Zeitplan-Auswertung und
// Ressourcen-Zeitachse. Getrennt von scheduler-view.ts, damit sie per
// `deno test` prüfbar ist (Nutzerwunsch 2026-09-30: der Scheduler soll
// Engpässe und freie Ressourcen über die Zeit zeigen).
//
// Modell: GET /api/v1/scheduler/resources liefert Host-Kapazitäten, je
// Workflow-Rolle den gemessenen Bedarf (CPU in Kernen, RAM in Bytes, I/O-
// Ports) und ob dafür überhaupt ein Messprofil existiert. Welcher
// Workflow WANN läuft, rechnet dieses Modul aus den Zeitplänen (der View
// ändert sie beim Ziehen live und muss die Auswirkung sofort zeigen).

export interface Schedule {
  id: string;
  kind: "once" | "daily" | "weekly";
  action: "start" | "stop";
  at?: string;
  timeOfDay?: string;
  weekday?: number;
  lastFiredAt?: string;
}

export const DAY_MINUTES = 1440;

export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function sameCalendarDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function parseTimeOfDay(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Minute des Tages, an der sched an diesem Kalendertag feuert (null = gar
// nicht) — dieselbe Idee wie orchestrator/internal/workflows/scheduler.go
// occurrenceAt.
export function occurrenceMinutes(s: Schedule, date: Date): number | null {
  if (s.kind === "once") {
    if (!s.at) return null;
    const at = new Date(s.at);
    if (!sameCalendarDate(at, date)) return null;
    return at.getHours() * 60 + at.getMinutes();
  }
  if (s.kind === "daily") return parseTimeOfDay(s.timeOfDay);
  if (s.kind === "weekly") {
    if (s.weekday === undefined || date.getDay() !== s.weekday) return null;
    return parseTimeOfDay(s.timeOfDay);
  }
  return null;
}

export interface ScheduleEvent {
  t: Date;
  action: "start" | "stop";
}

// Alle Zeitplan-Ereignisse im Intervall [from, to], zeitlich sortiert.
export function eventsBetween(schedules: Schedule[], from: Date, to: Date): ScheduleEvent[] {
  const out: ScheduleEvent[] = [];
  for (let day = startOfDay(from); day.getTime() <= to.getTime(); day = addDays(day, 1)) {
    for (const s of schedules) {
      const m = occurrenceMinutes(s, day);
      if (m === null) continue;
      const t = new Date(day);
      t.setHours(0, m, 0, 0);
      if (t.getTime() >= from.getTime() && t.getTime() <= to.getTime()) out.push({ t, action: s.action });
    }
  }
  out.sort((a, b) => a.t.getTime() - b.t.getTime());
  return out;
}

const LOOKBACK_DAYS = 8;

// Läuft der Workflow zum Zeitpunkt t? Vergangenheit/Gegenwart rein aus dem
// Zeitplan (letztes Ereignis davor entscheidet, bis zu 8 Tage zurück);
// Zukunft: Ereignisse NACH jetzt entscheiden, gibt es keine bis t, bleibt
// der aktuelle Zustand (läuft er jetzt, läuft er weiter) — so zählt auch
// ein von Hand gestarteter Workflow bis zu seinem geplanten Stop.
export function activeAt(schedules: Schedule[], status: string, t: Date, now: Date): boolean {
  const running = status === "started";
  if (t.getTime() > now.getTime()) {
    const ev = eventsBetween(schedules, new Date(now.getTime() + 1), t);
    if (ev.length > 0) return ev[ev.length - 1].action === "start";
    return running;
  }
  const ev = eventsBetween(schedules, addDays(t, -LOOKBACK_DAYS), t);
  if (ev.length === 0) return false;
  return ev[ev.length - 1].action === "start";
}

// ---- Ressourcenmodell -----------------------------------------------------

export interface ResIOCap {
  cardType: string;
  direction: string;
  total: number;
  claimed: number;
}

export interface ResHost {
  id: string;
  label: string;
  local?: boolean;
  online: boolean;
  numCpu: number;
  memTotalBytes: number;
  capacityKnown: boolean;
  live?: { cpuPercent: number; memPercent: number; netPercent?: number; gpuPercent?: number };
  ioPorts?: ResIOCap[];
  // Link-Geschwindigkeit der NIC in Mbit/s je Richtung (vollduplex); fehlt,
  // wenn der Host-Agent keine NIC konfiguriert hat oder der Treiber sie
  // nicht meldet.
  netLinkMbps?: number;
}

export interface ResRole {
  name: string;
  nodeType: string;
  hostId?: string;
  cpuCores: number;
  cpuAvgCores: number;
  rssBytes: number;
  known: boolean;
  fallback?: boolean;
  ioPort?: { cardType: string; direction: string };
  // Berechneter NIC-Bedarf in Mbit/s aus Sicht des Hosts (Rx = Empfang,
  // Tx = Senden); netEstimated: Format/Nennwert angenommen, nicht bekannt.
  netRxMbps?: number;
  netTxMbps?: number;
  netEstimated?: boolean;
}

export interface ResWorkflow {
  id: string;
  name: string;
  status: string;
  roles: ResRole[];
}

export interface ResourceModel {
  generatedAt?: string;
  thresholds: { cpu: number; mem: number; net?: number; gpu?: number };
  hosts: ResHost[];
  workflows: ResWorkflow[];
}

export const AUTO_LANE = "auto";

export interface Contribution {
  wfId: string;
  wfName: string;
  role: string;
  cpuCores: number;
  rssBytes: number;
  netRxMbps: number;
  netTxMbps: number;
}

export interface LaneSlot {
  cpuCores: number;
  rssBytes: number;
  netRxMbps: number;
  netTxMbps: number;
  // Mind. ein Netz-Bedarf beruht auf einer Annahme (Standardformat bzw.
  // Nennwert) — die Anzeige kennzeichnet ihn mit "~".
  netEstimated: boolean;
  io: Record<string, number>;
  contribs: Contribution[];
  // Rollen ohne Messprofil — ihr Bedarf fehlt in den Summen (unbekannt,
  // NICHT null): die Anzeige markiert den Slot als unvollständig.
  unknown: string[];
}

export type Timeline = Map<string, LaneSlot[]>;

function emptySlot(): LaneSlot {
  return { cpuCores: 0, rssBytes: 0, netRxMbps: 0, netTxMbps: 0, netEstimated: false, io: {}, contribs: [], unknown: [] };
}

export function ioKey(cardType: string, direction: string): string {
  return `${cardType}/${direction}`;
}

// Berechnet je Lane (Host-ID bzw. AUTO_LANE für Rollen ohne Host-
// Festlegung) und je Zeit-Slot die geplante Last. slotMinutes ist die
// Slot-Breite; enthält ein Slot "jetzt", wird bei jetzt ausgewertet.
export function computeTimeline(
  model: ResourceModel,
  schedulesByWf: Map<string, Schedule[]>,
  slots: Date[],
  slotMinutes: number,
  now: Date,
): Timeline {
  const lanes: Timeline = new Map();
  const laneIds = [AUTO_LANE, ...model.hosts.map((h) => h.id)];
  for (const id of laneIds) lanes.set(id, slots.map(() => emptySlot()));

  slots.forEach((slotStart, i) => {
    const slotEnd = slotStart.getTime() + slotMinutes * 60000;
    const at = slotStart.getTime() <= now.getTime() && now.getTime() < slotEnd ? now : slotStart;
    for (const wf of model.workflows) {
      const schedules = schedulesByWf.get(wf.id) ?? [];
      if (!activeAt(schedules, wf.status, at, now)) continue;
      for (const role of wf.roles) {
        const laneId = role.hostId && lanes.has(role.hostId) ? role.hostId : AUTO_LANE;
        const slot = lanes.get(laneId)![i];
        if (role.known) {
          slot.cpuCores += role.cpuCores;
          slot.rssBytes += role.rssBytes;
        } else {
          slot.unknown.push(`${wf.name}/${role.name}`);
        }
        if (role.ioPort) {
          const k = ioKey(role.ioPort.cardType, role.ioPort.direction);
          slot.io[k] = (slot.io[k] ?? 0) + 1;
        }
        const rx = role.netRxMbps ?? 0;
        const tx = role.netTxMbps ?? 0;
        slot.netRxMbps += rx;
        slot.netTxMbps += tx;
        if (rx + tx > 0 && role.netEstimated) slot.netEstimated = true;
        if (role.known || rx + tx > 0) {
          slot.contribs.push({
            wfId: wf.id,
            wfName: wf.name,
            role: role.name,
            cpuCores: role.known ? role.cpuCores : 0,
            rssBytes: role.known ? role.rssBytes : 0,
            netRxMbps: rx,
            netTxMbps: tx,
          });
        }
      }
    }
  });
  return lanes;
}

export interface Capacity {
  cpuCores: number; // 0 = unbekannt
  memBytes: number; // 0 = unbekannt
  netMbps: number; // NIC-Link je Richtung, 0 = unbekannt
  io: Record<string, number>;
}

// Kapazität einer Lane: ein Host, oder für AUTO_LANE alle erreichbaren
// Hosts (inkl. lokalem) zusammen — dorthin platziert der Orchestrator
// Rollen ohne Host-Festlegung.
export function laneCapacity(model: ResourceModel, laneId: string): Capacity {
  const hosts = laneId === AUTO_LANE ? model.hosts.filter((h) => h.online) : model.hosts.filter((h) => h.id === laneId);
  const cap: Capacity = { cpuCores: 0, memBytes: 0, netMbps: 0, io: {} };
  for (const h of hosts) {
    if (h.capacityKnown) {
      cap.cpuCores += h.numCpu;
      cap.memBytes += h.memTotalBytes;
    }
    cap.netMbps += h.netLinkMbps ?? 0;
    for (const p of h.ioPorts ?? []) {
      const k = ioKey(p.cardType, p.direction);
      cap.io[k] = (cap.io[k] ?? 0) + p.total;
    }
  }
  return cap;
}

export type Level = "unknown" | "free" | "ok" | "warn" | "over";

// Schwelle für "warn": ab diesem Anteil des Grenzwerts.
const WARN_FRACTION = 0.8;

export function levelOf(percent: number | null, thresholdPercent: number): Level {
  if (percent === null) return "unknown";
  if (percent > thresholdPercent) return "over";
  if (percent >= thresholdPercent * WARN_FRACTION) return "warn";
  if (percent > 0) return "ok";
  return "free";
}

export interface SlotUtilization {
  cpuPercent: number | null;
  memPercent: number | null;
  cpuLevel: Level;
  memLevel: Level;
  // Netz: die höhere der beiden Richtungen (vollduplex) gegen den Link.
  // null = Link der Karte unbekannt — der Bedarf in Mbit/s bleibt im Slot
  // trotzdem sichtbar.
  netPercent: number | null;
  netLevel: Level;
  freeNetMbps: number | null;
  // Überlastete I/O-Port-Typen (Bedarf > vorhandene Ports).
  ioOver: string[];
  incomplete: boolean; // mind. eine Rolle ohne Messprofil
  // Frei bis zum Grenzwert (nicht bis 100 %).
  freeCores: number | null;
  freeMemBytes: number | null;
}

export function slotUtilization(slot: LaneSlot, cap: Capacity, thresholds: { cpu: number; mem: number; net?: number }): SlotUtilization {
  const netThr = thresholds.net ?? 85;
  const netPeak = Math.max(slot.netRxMbps, slot.netTxMbps);
  const netPercent = cap.netMbps > 0 ? (netPeak / cap.netMbps) * 100 : null;
  const cpuPercent = cap.cpuCores > 0 ? (slot.cpuCores / cap.cpuCores) * 100 : null;
  const memPercent = cap.memBytes > 0 ? (slot.rssBytes / cap.memBytes) * 100 : null;
  const ioOver: string[] = [];
  for (const [k, n] of Object.entries(slot.io)) {
    if (n > (cap.io[k] ?? 0)) ioOver.push(k);
  }
  return {
    cpuPercent,
    memPercent,
    cpuLevel: levelOf(cpuPercent, thresholds.cpu),
    memLevel: levelOf(memPercent, thresholds.mem),
    netPercent,
    netLevel: levelOf(netPercent, netThr),
    freeNetMbps: cap.netMbps > 0 ? Math.max(0, cap.netMbps * (netThr / 100) - netPeak) : null,
    ioOver,
    incomplete: slot.unknown.length > 0,
    freeCores: cap.cpuCores > 0 ? Math.max(0, cap.cpuCores * (thresholds.cpu / 100) - slot.cpuCores) : null,
    freeMemBytes: cap.memBytes > 0 ? Math.max(0, cap.memBytes * (thresholds.mem / 100) - slot.rssBytes) : null,
  };
}

export function isOver(u: SlotUtilization): boolean {
  return u.cpuLevel === "over" || u.memLevel === "over" || u.netLevel === "over" || u.ioOver.length > 0;
}

// Ein Engpass, den ein Workflow (mit)verursacht: Lane + Zeit-Slot-Index +
// was überlastet ist. Grundlage für Markierungen an den Balken.
export interface Bottleneck {
  laneId: string;
  slotIndex: number;
  what: string[]; // "CPU", "RAM", "decklink/in"
}

export function findBottlenecks(model: ResourceModel, timeline: Timeline): Bottleneck[] {
  const out: Bottleneck[] = [];
  for (const [laneId, slots] of timeline) {
    const cap = laneCapacity(model, laneId);
    slots.forEach((slot, slotIndex) => {
      const u = slotUtilization(slot, cap, model.thresholds);
      const what: string[] = [];
      if (u.cpuLevel === "over") what.push("CPU");
      if (u.memLevel === "over") what.push("RAM");
      if (u.netLevel === "over") what.push("Netz");
      what.push(...u.ioOver);
      if (what.length > 0) out.push({ laneId, slotIndex, what });
    });
  }
  return out;
}

export function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${Math.round(b / (1 << 20))} MB`;
  return `${Math.round(b / 1024)} kB`;
}

export function fmtMbps(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} Gbit/s`;
  return `${Math.round(m)} Mbit/s`;
}

export function fmtCores(c: number): string {
  return c >= 10 ? c.toFixed(0) : c.toFixed(1);
}
