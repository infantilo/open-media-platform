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
  updatedAt?: string;
}

export type Severity = "critical" | "warning";

export interface Alarm {
  // Nachtrag 243: `key` identifiziert das Alarm-OBJEKT stabil (Quelle +
  // ID), `fingerprint` den konkreten ZUSTAND/das Ereignis. Eine
  // Quittierung/Maskierung gilt nur, solange beide übereinstimmen — ein
  // Wiederauftreten, Statuswechsel oder eine Eskalation ändert den
  // Fingerprint und macht den Alarm automatisch wieder laut, ohne dass
  // jemand die Lücke dazwischen beobachten müsste.
  key: string;
  fingerprint: string;
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
  "alarm.ack.changed",
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
        key: `instance:${inst.id}:crashed`,
        fingerprint: `${inst.crashMessage ?? ""}|${inst.restartCount ?? 0}`,
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
        key: `instance:${inst.id}:restarted`,
        fingerprint: `${inst.restartCount}`,
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
      key: `placement:${a.hostId}`,
      fingerprint: `${a.reason}|${[...a.instanceIds].sort().join(",")}`,
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
            // Fingerprint = letztes Lebenszeichen: erst wenn der Host
            // zurückkommt UND erneut ausfällt, ändert er sich.
            key: `host:${h.id}:offline`,
            fingerprint: `critical|${m.receivedAt}`,
            severity: "critical",
            source: "Host",
            title: h.label,
            detail: `OFFLINE — unerwartet ausgefallen (zuletzt gesehen ${new Date(m.receivedAt).toLocaleTimeString()}), nicht manuell beendet`,
          }
        : {
            key: `host:${h.id}:offline`,
            fingerprint: "warning|never-seen",
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
        key: `workflow:${wf.id}:failed`,
        fingerprint: `${wf.error ?? ""}|${wf.updatedAt ?? ""}`,
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
async function fetchRawAlarms(): Promise<Alarm[]> {
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

// --- Quittieren / Maskieren (Nachtrag 243) ---

export type AckMode = "ack" | "mask";

export interface AlarmAck {
  key: string;
  fingerprint: string;
  mode: AckMode;
  comment?: string;
  username: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AlarmState extends Alarm {
  /** Nur gesetzt, wenn die Quittierung/Maskierung AKTUELL gilt (Key und
   * Fingerprint stimmen überein, nicht abgelaufen). */
  ack?: AlarmAck;
}

/** Wendet die geteilten Ack-Einträge auf die aktuellen Alarme an. */
export function applyAcks(alarms: Alarm[], acks: AlarmAck[], now = Date.now()): AlarmState[] {
  const byKey = new Map(acks.map((a) => [a.key, a]));
  return alarms.map((alarm) => {
    const ack = byKey.get(alarm.key);
    const valid =
      ack !== undefined &&
      ack.fingerprint === alarm.fingerprint &&
      (ack.expiresAt === undefined || Date.parse(ack.expiresAt) > now);
    return valid ? { ...alarm, ack } : { ...alarm };
  });
}

export async function fetchAlarms(): Promise<AlarmState[]> {
  const [alarms, acksRes] = await Promise.all([fetchRawAlarms(), apiFetch("/api/v1/alarms/acks")]);
  // Ohne Ack-API (älterer Orchestrator) oder bei Fehler: alle Alarme laut,
  // lieber zu viel als etwas still zu verschlucken.
  const acks = acksRes.ok ? ((await acksRes.json()) as AlarmAck[]) : [];
  return applyAcks(alarms, acks);
}

export async function setAlarmAck(
  alarm: Pick<Alarm, "key" | "fingerprint">,
  mode: AckMode,
  comment: string,
  durationMinutes: number,
): Promise<boolean> {
  const res = await apiFetch("/api/v1/alarms/acks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: alarm.key,
      fingerprint: alarm.fingerprint,
      mode,
      comment,
      durationMinutes,
    }),
  });
  return res.ok;
}

export async function clearAlarmAck(key: string): Promise<boolean> {
  const res = await apiFetch(`/api/v1/alarms/acks?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  return res.ok;
}
