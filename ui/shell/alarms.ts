// Gemeinsame Alarm-Logik für <omp-alarm-view> und <omp-alert-bar>
// (Footer). Aus alarm-view.ts ausgelagert (Nutzerauftrag 2026-09-21);
// Erläuterungen zur Quellenwahl/SSE-Strategie stehen dort.
import { apiFetch } from "./connection.ts";

export interface HostInfo {
  id: string;
  label: string;
  metrics?: { receivedAt: string; goodbye?: boolean };
}

// Nutzerauftrag 2026-09-21: ein Host, der offline geht, ohne dass er
// absichtlich beendet wurde, ist extrem kritisch. "Absichtlich" = der
// Host-Agent hat per SIGTERM/SIGINT eine Goodbye-Telemetrie gesendet
// (host-agent/internal/telemetry.Sample.Goodbye). Schwelle bewusst
// identisch zu hosts-view.ts (HOST_ONLINE_THRESHOLD_MS, dort dupliziert).
const HOST_ONLINE_THRESHOLD_MS = 15000;

export interface LauncherInstance {
  id: string;
  type: string;
  label: string;
  crashed?: boolean;
  crashMessage?: string;
  restartCount?: number;
}

export interface PlacementAdvice {
  hostId: string;
  hostLabel: string;
  reason: string;
  cpuPercent: number;
  memPercent: number;
  // netPercent fehlt (statt 0), wenn dieser Host keine NIC-Auslastung mit
  // bekannter Link-Kapazität meldet (orchestrator/internal/placement.
  // Advice.NetPercent-Doku, Nutzerauftrag 2026-09-02) — kein stiller
  // 0-Wert, der wie "gemessen und leer" aussähe.
  netPercent?: number;
  instanceIds: string[];
  suggestedHostId?: string;
  suggestedHostLabel?: string;
  detectedAt: string;
}

export interface Workflow {
  id: string;
  name: string;
  status: string;
  error?: string;
}

export type Severity = "critical" | "warning";

export interface Alarm {
  severity: Severity;
  source: string; // Kurzes Kategorie-Label, z. B. "Instanz", "Host", "Workflow"
  title: string;
  detail: string;
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--omp-error)",
  warning: "var(--omp-cue)",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Kritisch",
  warning: "Warnung",
};


export const REFRESH_EVENT_TYPES = new Set([
  "instance.crashed",
  "instance.restarted",
  "placement.advice",
  "workflow.updated",
  "host.registered",
  "lost-events",
]);

// Nutzerauftrag 2026-09-02 ("netzwerkbandbreite ... auch relevant"):
// "reason" kommt vom Backend als "+"-verbundene Liste über- schwellener
// Dimensionen (placement.evaluateOnce) — generisch übersetzt statt fest
// verdrahteter Kombinationen, sonst müsste jede neue Kombination (jetzt:
// net, cpu+net, mem+net, cpu+mem+net) hier extra nachgezogen werden.
const REASON_TOKEN_LABEL: Record<string, string> = { cpu: "CPU", mem: "RAM", net: "Netz" };

function reasonLabel(reason: string): string {
  return reason
    .split("+")
    .map((token) => REASON_TOKEN_LABEL[token] ?? token)
    .join("+");
}

export function buildAlarms(
  instances: LauncherInstance[],
  advice: PlacementAdvice[],
  workflows: Workflow[],
  hosts: HostInfo[] = [],
): Alarm[] {
  const alarms: Alarm[] = [];

  for (const inst of instances) {
    if (inst.crashed) {
      alarms.push({
        severity: "critical",
        source: "Instanz",
        title: inst.label,
        detail: inst.crashMessage || "Prozess abgestürzt",
      });
    } else if (inst.restartCount) {
      // Läuft gerade wieder, aber ist bereits mindestens einmal
      // automatisch neu gestartet worden (K7-Teil-1) — eine flatternde
      // Instanz ist ein eigener Alarm-würdiger Zustand, kein "ist ja
      // wieder online" (§7.2-Prinzip).
      alarms.push({
        severity: "warning",
        source: "Instanz",
        title: inst.label,
        detail: `${inst.restartCount}× automatisch neu gestartet`,
      });
    }
  }

  for (const a of advice) {
    const target = a.suggestedHostId
      ? `Ausweichhost: ${a.suggestedHostLabel ?? a.suggestedHostId}`
      : "kein Ausweichhost frei";
    const netPart = a.netPercent !== undefined ? ` / Netz ${a.netPercent.toFixed(0)}%` : "";
    alarms.push({
      severity: "warning",
      source: "Host",
      title: a.hostLabel,
      detail: `überlastet (${reasonLabel(a.reason)}: CPU ${a.cpuPercent.toFixed(0)}% / RAM ${a.memPercent.toFixed(0)}%${netPart}), ${a.instanceIds.length} Instanz(en) betroffen — ${target}`,
    });
  }

  for (const h of hosts) {
    const m = h.metrics;
    if (m?.goodbye) continue; // absichtlich beendet — kein Alarm
    if (m && Date.now() - Date.parse(m.receivedAt) < HOST_ONLINE_THRESHOLD_MS) continue; // online
    alarms.push(
      m
        ? {
            severity: "critical",
            source: "Host",
            title: h.label,
            detail: `OFFLINE — unerwartet ausgefallen (zuletzt gesehen ${new Date(m.receivedAt).toLocaleTimeString()}), nicht manuell beendet`,
          }
        : {
            // Nie Telemetrie seit Orchestrator-Start: Zustand unbekannt
            // (z. B. Orchestrator neu gestartet, Host schon vorher weg) —
            // Warnung statt Kritisch, weil "unerwartet" hier nicht belegbar ist.
            severity: "warning",
            source: "Host",
            title: h.label,
            detail: "offline — keine Telemetrie seit Orchestrator-Start empfangen",
          },
    );
  }

  for (const wf of workflows) {
    if (wf.status === "failed") {
      alarms.push({
        severity: "critical",
        source: "Workflow",
        title: wf.name,
        detail: wf.error || "gestartet fehlgeschlagen",
      });
    }
  }

  // Kritisch vor Warnung, sonst stabile Eingabereihenfolge (kein
  // zusätzliches Sortierkriterium nötig — die drei Quellen liefern
  // bereits eine für sich sinnvolle Reihenfolge).
  return alarms.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}


// fetchAlarms sammelt alle Alarmquellen (gemeinsam für den Alarme-Tab und
// die globale Alarmleiste im Footer). Wirft bei Netzwerkfehler.
export async function fetchAlarms(): Promise<Alarm[]> {
  const [instancesRes, adviceRes, workflowsRes, hostsRes] = await Promise.all([
    apiFetch("/api/v1/instances"),
    apiFetch("/api/v1/placement/advice"),
    apiFetch("/api/v1/workflows"),
    apiFetch("/api/v1/hosts"),
  ]);
  const instances = instancesRes.ok ? ((await instancesRes.json()) as LauncherInstance[]) : [];
  const advice = adviceRes.ok ? ((await adviceRes.json()) as PlacementAdvice[]) : [];
  const workflows = workflowsRes.ok ? ((await workflowsRes.json()) as Workflow[]) : [];
  const hosts = hostsRes.ok ? ((await hostsRes.json()) as HostInfo[]) : [];
  return buildAlarms(instances, advice, workflows, hosts);
}
