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
  live?: { cpuPercent: number; memPercent: number; netPercent?: number; netRxMbps?: number; netTxMbps?: number; gpuPercent?: number };
  ioPorts?: ResIOCap[];
  // Link-Geschwindigkeit der NIC in Mbit/s je Richtung (vollduplex); fehlt,
  // wenn der Host-Agent keine NIC konfiguriert hat oder der Treiber sie
  // nicht meldet.
  netLinkMbps?: number;
  // GPU-Pool des Hosts; fehlt = nicht gemessen. Kapazität: count × 100 %
  // Auslastung bzw. memTotalBytes VRAM.
  gpu?: { count: number; utilPercent: number; memUsedBytes: number; memTotalBytes: number };
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
  // GPU-Bedarf in Prozent EINER GPU (p95 des Profils); gpuKnown=false: nie
  // gemessen — fehlt dann in der Planung (ohne den Slot als unvollständig
  // zu markieren, sonst wäre auf Hosts ohne GPU jede Rolle "unbekannt").
  gpuPercent?: number;
  gpuKnown?: boolean;
  // VRAM-Maximum aus dem Profil in Bytes (0/fehlt = nie gemessen).
  gpuMemBytes?: number;
}

export interface ResWorkflow {
  id: string;
  name: string;
  status: string;
  roles: ResRole[];
}

// Laufende Instanz ohne Workflow (von Hand gestartet): läuft, bis jemand sie
// stoppt, und zählt deshalb in jedem Zeit-Slot.
export interface ResManual {
  id: string;
  label: string;
  nodeType: string;
  hostId?: string;
  cpuCores: number;
  rssBytes: number;
  known: boolean;
  measured?: boolean;
  netRxMbps?: number;
  netTxMbps?: number;
  netEstimated?: boolean;
  gpuPercent?: number;
  gpuKnown?: boolean;
  gpuMemBytes?: number;
}

export const MANUAL_WF_ID = "manual";

export interface ResourceModel {
  generatedAt?: string;
  thresholds: { cpu: number; mem: number; net?: number; gpu?: number };
  hosts: ResHost[];
  workflows: ResWorkflow[];
  manualInstances?: ResManual[];
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
  gpuPercent: number;
  gpuMemBytes: number;
}

export interface LaneSlot {
  cpuCores: number;
  rssBytes: number;
  netRxMbps: number;
  netTxMbps: number;
  // Mind. ein Netz-Bedarf beruht auf einer Annahme (Standardformat bzw.
  // Nennwert) — die Anzeige kennzeichnet ihn mit "~".
  netEstimated: boolean;
  // Summe des GPU-Bedarfs in Prozent einer GPU (100 = eine volle GPU).
  gpuPercent: number;
  // Summe des belegten VRAM in Bytes.
  gpuMemBytes: number;
  io: Record<string, number>;
  contribs: Contribution[];
  // Rollen ohne Messprofil — ihr Bedarf fehlt in den Summen (unbekannt,
  // NICHT null): die Anzeige markiert den Slot als unvollständig.
  unknown: string[];
  // Dimensionen, deren Wert die aktuell GEMESSENE Host-Auslastung statt der
  // Planung ist (nur der "Jetzt"-Slot, nur wenn die Messung höher liegt).
  liveFloor: string[];
}

export type Timeline = Map<string, LaneSlot[]>;

function emptySlot(): LaneSlot {
  return { cpuCores: 0, rssBytes: 0, netRxMbps: 0, netTxMbps: 0, netEstimated: false, gpuPercent: 0, gpuMemBytes: 0, io: {}, contribs: [], unknown: [], liveFloor: [] };
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
        const gpu = role.gpuKnown ? role.gpuPercent ?? 0 : 0;
        const vram = role.gpuMemBytes ?? 0;
        slot.gpuPercent += gpu;
        slot.gpuMemBytes += vram;
        if (rx + tx > 0 && role.netEstimated) slot.netEstimated = true;
        if (role.known || rx + tx > 0 || gpu > 0 || vram > 0) {
          slot.contribs.push({
            wfId: wf.id,
            wfName: wf.name,
            role: role.name,
            cpuCores: role.known ? role.cpuCores : 0,
            rssBytes: role.known ? role.rssBytes : 0,
            netRxMbps: rx,
            netTxMbps: tx,
            gpuPercent: gpu,
            gpuMemBytes: vram,
          });
        }
      }
    }
    // Von Hand gestartete Instanzen laufen endlos weiter (bis jemand sie
    // stoppt) — in jedem Slot auf dem Host, auf dem sie tatsächlich laufen.
    for (const mi of model.manualInstances ?? []) {
      const laneId = lanes.has(mi.hostId ?? "") ? (mi.hostId ?? "") : AUTO_LANE;
      const slot = lanes.get(laneId)![i];
      const label = `${mi.label || mi.nodeType}`;
      if (mi.known) {
        slot.cpuCores += mi.cpuCores;
        slot.rssBytes += mi.rssBytes;
      } else {
        slot.unknown.push(`Manuell/${label}`);
      }
      const rx = mi.netRxMbps ?? 0;
      const tx = mi.netTxMbps ?? 0;
      slot.netRxMbps += rx;
      slot.netTxMbps += tx;
      const gpu = mi.gpuKnown ? mi.gpuPercent ?? 0 : 0;
      const vram = mi.gpuMemBytes ?? 0;
      slot.gpuPercent += gpu;
      slot.gpuMemBytes += vram;
      if (rx + tx > 0 && mi.netEstimated) slot.netEstimated = true;
      if (mi.known || rx + tx > 0 || gpu > 0 || vram > 0) {
        slot.contribs.push({
          wfId: MANUAL_WF_ID,
          wfName: "Manuell gestartet",
          role: label,
          cpuCores: mi.known ? mi.cpuCores : 0,
          rssBytes: mi.known ? mi.rssBytes : 0,
          netRxMbps: rx,
          netTxMbps: tx,
          gpuPercent: gpu,
          gpuMemBytes: vram,
        });
      }
    }
    // Der "Jetzt"-Slot nimmt die tatsächlich gemessene Host-Auslastung als
    // Untergrenze: liegt die Messung über der Planung (nicht verwaltete
    // Last, unterschätzte Profile), gilt die Messung.
    if (at === now) {
      for (const h of model.hosts) {
        if (!lanes.has(h.id)) continue;
        const slot = lanes.get(h.id)![i];
        const live = h.live;
        if (live && h.capacityKnown) {
          const cores = (live.cpuPercent / 100) * h.numCpu;
          if (cores > slot.cpuCores) {
            slot.cpuCores = cores;
            slot.liveFloor.push("CPU");
          }
          const rss = (live.memPercent / 100) * h.memTotalBytes;
          if (rss > slot.rssBytes) {
            slot.rssBytes = rss;
            slot.liveFloor.push("RAM");
          }
          const rx = live.netRxMbps ?? 0;
          const tx = live.netTxMbps ?? 0;
          if (rx > slot.netRxMbps || tx > slot.netTxMbps) {
            slot.netRxMbps = Math.max(slot.netRxMbps, rx);
            slot.netTxMbps = Math.max(slot.netTxMbps, tx);
            slot.liveFloor.push("Netz");
          }
        }
        // GPU/VRAM hängen nicht an `live`: auch der lokale Host (ohne
        // Host-Agent) meldet seinen GPU-Pool.
        if (h.gpu) {
          const used = (h.gpu.utilPercent / 100) * h.gpu.count * 100;
          if (used > slot.gpuPercent) {
            slot.gpuPercent = used;
            slot.liveFloor.push("GPU");
          }
          if (h.gpu.memUsedBytes > slot.gpuMemBytes) {
            slot.gpuMemBytes = h.gpu.memUsedBytes;
            slot.liveFloor.push("VRAM");
          }
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
  gpuPercent: number; // 100 je GPU der Hosts mit gemeldeter GPU, 0 = keine GPU bekannt
  vramBytes: number; // Summe des VRAM, 0 = unbekannt
  io: Record<string, number>;
}

// Kapazität einer Lane: ein Host, oder für AUTO_LANE alle erreichbaren
// Hosts (inkl. lokalem) zusammen — dorthin platziert der Orchestrator
// Rollen ohne Host-Festlegung.
export function laneCapacity(model: ResourceModel, laneId: string): Capacity {
  const hosts = laneId === AUTO_LANE ? model.hosts.filter((h) => h.online) : model.hosts.filter((h) => h.id === laneId);
  const cap: Capacity = { cpuCores: 0, memBytes: 0, netMbps: 0, gpuPercent: 0, vramBytes: 0, io: {} };
  for (const h of hosts) {
    if (h.capacityKnown) {
      cap.cpuCores += h.numCpu;
      cap.memBytes += h.memTotalBytes;
    }
    cap.netMbps += h.netLinkMbps ?? 0;
    if (h.gpu) {
      cap.gpuPercent += h.gpu.count * 100;
      cap.vramBytes += h.gpu.memTotalBytes;
    }
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
  // GPU: Bedarf gegen die Kapazität (eine GPU je Host = 100 %). null = kein
  // Host mit gemeldeter GPU.
  gpuPercent: number | null;
  gpuLevel: Level;
  freeGpuPercent: number | null;
  // VRAM: harte Grenze (Überlauf = Absturz), Schwelle wie RAM.
  vramPercent: number | null;
  vramLevel: Level;
  freeVramBytes: number | null;
  // Überlastete I/O-Port-Typen (Bedarf > vorhandene Ports).
  ioOver: string[];
  incomplete: boolean; // mind. eine Rolle ohne Messprofil
  // Frei bis zum Grenzwert (nicht bis 100 %).
  freeCores: number | null;
  freeMemBytes: number | null;
}

export function slotUtilization(slot: LaneSlot, cap: Capacity, thresholds: { cpu: number; mem: number; net?: number; gpu?: number }): SlotUtilization {
  const netThr = thresholds.net ?? 85;
  const gpuThr = thresholds.gpu ?? 85;
  const gpuPercent = cap.gpuPercent > 0 ? (slot.gpuPercent / cap.gpuPercent) * 100 : null;
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
    vramPercent: cap.vramBytes > 0 ? (slot.gpuMemBytes / cap.vramBytes) * 100 : null,
    vramLevel: levelOf(cap.vramBytes > 0 ? (slot.gpuMemBytes / cap.vramBytes) * 100 : null, thresholds.mem),
    freeVramBytes: cap.vramBytes > 0 ? Math.max(0, cap.vramBytes * (thresholds.mem / 100) - slot.gpuMemBytes) : null,
    gpuPercent,
    gpuLevel: levelOf(gpuPercent, gpuThr),
    freeGpuPercent: cap.gpuPercent > 0 ? Math.max(0, cap.gpuPercent * (gpuThr / 100) - slot.gpuPercent) : null,
    freeNetMbps: cap.netMbps > 0 ? Math.max(0, cap.netMbps * (netThr / 100) - netPeak) : null,
    ioOver,
    incomplete: slot.unknown.length > 0,
    freeCores: cap.cpuCores > 0 ? Math.max(0, cap.cpuCores * (thresholds.cpu / 100) - slot.cpuCores) : null,
    freeMemBytes: cap.memBytes > 0 ? Math.max(0, cap.memBytes * (thresholds.mem / 100) - slot.rssBytes) : null,
  };
}

export function isOver(u: SlotUtilization): boolean {
  return u.cpuLevel === "over" || u.memLevel === "over" || u.netLevel === "over" || u.gpuLevel === "over" || u.vramLevel === "over" || u.ioOver.length > 0;
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
      if (u.gpuLevel === "over") what.push("GPU");
      if (u.vramLevel === "over") what.push("VRAM");
      what.push(...u.ioOver);
      if (what.length > 0) out.push({ laneId, slotIndex, what });
    });
  }
  return out;
}

export interface WorkflowDemand {
  cpuCores: number;
  rssBytes: number;
  netRxMbps: number;
  netTxMbps: number;
  gpuPercent: number;
  gpuMemBytes: number;
  roles: number;
  // Rollen ohne Messprofil — ihr CPU/RAM-Bedarf fehlt in den Summen.
  unknownRoles: number;
}

// Summe des Bedarfs aller Rollen eines Workflows (für die Sicherheitsabfrage
// beim Anlegen eines Zeitplans). null, wenn das Modell den Workflow nicht kennt.
export function workflowDemand(model: ResourceModel | null, wfId: string): WorkflowDemand | null {
  const wf = model?.workflows.find((w) => w.id === wfId);
  if (!wf) return null;
  const d: WorkflowDemand = { cpuCores: 0, rssBytes: 0, netRxMbps: 0, netTxMbps: 0, gpuPercent: 0, gpuMemBytes: 0, roles: wf.roles.length, unknownRoles: 0 };
  for (const r of wf.roles) {
    if (r.known) {
      d.cpuCores += r.cpuCores;
      d.rssBytes += r.rssBytes;
    } else {
      d.unknownRoles++;
    }
    d.netRxMbps += r.netRxMbps ?? 0;
    d.netTxMbps += r.netTxMbps ?? 0;
    if (r.gpuKnown) d.gpuPercent += r.gpuPercent ?? 0;
    d.gpuMemBytes += r.gpuMemBytes ?? 0;
  }
  return d;
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
