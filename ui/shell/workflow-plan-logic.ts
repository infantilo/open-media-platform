// Plan-Vorschau eines Workflows (GET /api/v1/workflows/{id}/plan): Wire-Format und reine Anzeigelogik
// (ohne DOM, testbar). Gezeigt wird, wo die Rollen laufen würden bzw. laufen, mit welchem erwarteten
// Bedarf und ob dabei ein Ressourcenengpass droht.

export interface RolePlan {
  role: string;
  nodeType: string;
  preferredHostId?: string;
  plannedHostId: string;
  plannedHostLabel: string;
  fixed: boolean;
  reason?: string;
  cpuPercent: number;
  ramBytes: number;
  profileKnown: boolean;
}

export interface HostEstimate {
  hostId: string;
  label: string;
  online: boolean;
  hasMetrics: boolean;
  cpuNow: number;
  memNow: number;
  cpuProjected: number;
  memProjected: number;
  cpuLimit: number;
  memLimit: number;
  over?: string[];
}

export interface StartPlan {
  workflowId: string;
  running: boolean;
  roles: RolePlan[];
  hosts: HostEstimate[];
  warnings: string[];
}

export type Severity = "ok" | "warn" | "bad" | "unknown";

export interface HostGroup {
  host: HostEstimate;
  roles: RolePlan[];
  severity: Severity;
}

const RANK: Record<Severity, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 };

/** Ampel eines Hosts: Engpass/nicht erreichbar = bad, ab 80 % der Grenze = warn, ohne Messwerte = unknown. */
export function hostSeverity(h: HostEstimate, running: boolean): Severity {
  if (h.hostId !== "" && !h.online) return "bad";
  if (!running && (h.over?.length ?? 0) > 0) return "bad";
  if (h.hostId !== "" && !h.hasMetrics) return "unknown";
  if (!running && h.hasMetrics && (h.cpuProjected >= h.cpuLimit * 0.8 || h.memProjected >= h.memLimit * 0.8)) return "warn";
  return "ok";
}

/** Rollen je Host gruppiert, in der Reihenfolge der Hosts des Plans. */
export function groupByHost(plan: StartPlan): HostGroup[] {
  return plan.hosts.map((host) => ({
    host,
    roles: plan.roles.filter((r) => r.plannedHostId === host.hostId),
    severity: hostSeverity(host, plan.running),
  }));
}

/** Schlimmster Zustand über alle Hosts (für ein Gesamt-Signal an der Karte). */
export function overallSeverity(plan: StartPlan): Severity {
  let worst: Severity = "ok";
  for (const g of groupByHost(plan)) if (RANK[g.severity] > RANK[worst]) worst = g.severity;
  return worst;
}

function bytesText(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(b / 1024 ** 2)} MB`;
}

/** Erwarteter Bedarf einer Rolle als kurzer Text; ohne Messprofil ausdrücklich „unbekannt“, nicht „0“. */
export function demandText(r: RolePlan): string {
  if (!r.profileKnown) return "Bedarf unbekannt";
  return `~${Math.round(r.cpuPercent)} % CPU · ${bytesText(r.ramBytes)}`;
}

/** Auslastung eines Hosts: jetzt → mit diesem Workflow. */
export function loadText(h: HostEstimate, running: boolean): string {
  if (!h.hasMetrics) return h.hostId === "" ? "keine Messwerte (lokal)" : "keine Messwerte";
  const now = `CPU ${Math.round(h.cpuNow)} % · RAM ${Math.round(h.memNow)} %`;
  if (running) return `jetzt ${now}`;
  return `${now} → CPU ${Math.round(h.cpuProjected)} % · RAM ${Math.round(h.memProjected)} %`;
}
