// <omp-alarm-view> — genereller Alarm-View (docs/END-GOAL-FEATURES.md
// §17.3c/§17.4 Teil 3, 2026-07-17): sammelt alle bereits existierenden
// Fehler-/Warn-Signale an einer Stelle statt verteilt. Bewusst **kein**
// neuer Alarm-Erzeuger — nur ein neuer, zentraler Konsument dreier
// bereits bestehender Endpunkte:
//   - GET /api/v1/instances (crashed/restartCount, K7-Teil-1)
//   - GET /api/v1/placement/advice (Ressourcen-Ampel, D6 Teil 3)
//   - GET /api/v1/workflows (status "failed")
// Gleiches Poll-Muster wie hosts-view.ts (keine SSE-Sonderbehandlung
// nötig, ein paar Sekunden Verzögerung sind für eine Alarm-Übersicht
// unkritisch) — über apiFetch() (connection.ts), damit ein Fehlschlag
// den geteilten ConnectionMonitor auf "degraded" setzt statt still zu
// bleiben.
//
// Bewusst additiv, nicht ersetzend: hosts-view.ts zeigt Placement-
// Advice weiterhin zusätzlich inline (kontextuell dort sinnvoll, wenn
// man sich ohnehin einen Host ansieht) — dieser Tab ist der neue,
// zusätzliche zentrale Überblick über alle Alarmarten zusammen, keine
// Ablösung der bestehenden Einzelanzeigen (docs/decisions.md,
// 2026-07-17 Nachtrag 5, Abwägung dokumentiert).
import { apiFetch } from "./connection.ts";

interface LauncherInstance {
  id: string;
  type: string;
  label: string;
  crashed?: boolean;
  crashMessage?: string;
  restartCount?: number;
}

interface PlacementAdvice {
  hostId: string;
  hostLabel: string;
  reason: string;
  cpuPercent: number;
  memPercent: number;
  instanceIds: string[];
  suggestedHostId?: string;
  suggestedHostLabel?: string;
  detectedAt: string;
}

interface Workflow {
  id: string;
  name: string;
  status: string;
  error?: string;
}

type Severity = "critical" | "warning";

interface Alarm {
  severity: Severity;
  source: string; // Kurzes Kategorie-Label, z. B. "Instanz", "Host", "Workflow"
  title: string;
  detail: string;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--omp-error)",
  warning: "var(--omp-cue)",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Kritisch",
  warning: "Warnung",
};

const POLL_INTERVAL_MS = 4000;

function reasonLabel(reason: string): string {
  switch (reason) {
    case "cpu":
      return "CPU";
    case "mem":
      return "RAM";
    case "cpu+mem":
      return "CPU+RAM";
    default:
      return reason;
  }
}

function buildAlarms(instances: LauncherInstance[], advice: PlacementAdvice[], workflows: Workflow[]): Alarm[] {
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
    alarms.push({
      severity: "warning",
      source: "Host",
      title: a.hostLabel,
      detail: `überlastet (${reasonLabel(a.reason)}: CPU ${a.cpuPercent.toFixed(0)}% / RAM ${a.memPercent.toFixed(0)}%), ${a.instanceIds.length} Instanz(en) betroffen — ${target}`,
    });
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

class AlarmView extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([]);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
  }

  async #poll() {
    try {
      const [instancesRes, adviceRes, workflowsRes] = await Promise.all([
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/placement/advice"),
        apiFetch("/api/v1/workflows"),
      ]);
      const instances = instancesRes.ok ? ((await instancesRes.json()) as LauncherInstance[]) : [];
      const advice = adviceRes.ok ? ((await adviceRes.json()) as PlacementAdvice[]) : [];
      const workflows = workflowsRes.ok ? ((await workflowsRes.json()) as Workflow[]) : [];
      this.#render(buildAlarms(instances, advice, workflows));
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render(alarms: Alarm[]) {
    if (alarms.length === 0) {
      this.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;">Alarme</div>
        <div style="padding:var(--omp-space-2);color:var(--omp-preset);">✓ Keine aktiven Alarme.</div>
      `;
      return;
    }

    const criticalCount = alarms.filter((a) => a.severity === "critical").length;
    const warningCount = alarms.length - criticalCount;

    const rows = alarms
      .map(
        (a) => `
        <div style="display:flex;gap:var(--omp-space-2);align-items:flex-start;padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);background:rgba(255,255,255,0.04);border-left:3px solid ${SEVERITY_COLOR[a.severity]};border-radius:var(--omp-radius);">
          <span style="color:${SEVERITY_COLOR[a.severity]};font-size:var(--omp-font-size-xs);font-weight:600;white-space:nowrap;">${SEVERITY_LABEL[a.severity]}</span>
          <div>
            <div><strong>${escapeHtml(a.source)}: ${escapeHtml(a.title)}</strong></div>
            <div style="color:var(--omp-text-dim);white-space:pre-wrap;word-break:break-word;">${escapeHtml(a.detail)}</div>
          </div>
        </div>`,
      )
      .join("");

    this.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">
        Alarme (${criticalCount} kritisch, ${warningCount} Warnung${warningCount === 1 ? "" : "en"})
      </div>
      ${rows}
    `;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-alarm-view", AlarmView);
