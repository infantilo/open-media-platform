// <omp-hosts-view> — minimale Host-Liste (ARCHITECTURE.md §18.7:
// "Sichtbarkeit im UI"; UMSETZUNG.md D6 Teil 1). Bewusst kein Teil des
// größeren Engineering-Dashboards (§17.2, noch nicht gebaut) — seit
// K1-Teil-1 eine Vollansicht im App-Bar-Tab "Hosts" (app-shell.ts),
// vormals ein per Knopf ein-/ausblendbares Floating-Panel.
//
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): reagiert
// auf "host.registered" (neu, host_handlers.go), die per-Host-Telemetrie
// "omp.host.<hostId>.metrics" (roher NATS-Subject-Passthrough, s.
// eventbus.go — bereits vorhanden, kein neues Backend-Event nötig) und
// "placement.advice" (D6 Teil 3) statt alle paar Sekunden zu pollen.
// Poll bleibt nur als deutlich langsamerer Reconnect-/Fallback-Pfad
// (POLL_FALLBACK_INTERVAL_MS). Über apiFetch() (connection.ts), damit
// ein Fehlschlag den geteilten ConnectionMonitor auf "degraded" setzt
// statt still zu bleiben.
import { t, t as tt, tLoose } from "./i18n.ts";
import { apiFetch, connectionMonitor } from "./connection.ts";
import { whoami } from "./auth.ts";
import { openHostWizard } from "./host-wizard.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";
import "./host-topology.ts"; // registriert <omp-host-topology> (Seiteneffekt-Import: ein reiner Typ-Import würde wegoptimiert)
import "./host-trends.ts";
import type { HostTopology } from "./host-topology.ts";
import type { HostTrends } from "./host-trends.ts";
import { clockProblem, type ClockIn, type TopoHostIn } from "./host-topology-logic.ts";

// netMetrics fehlt (statt eines Nullwert-Objekts), wenn der Host-Agent
// kein Interface für die Bandbreiten-Telemetrie konfiguriert hat
// (host-agent/internal/telemetry.NetSample-Doku, Nutzerauftrag
// 2026-09-02) — kein stiller "0 Mbit/s", der wie eine echte Leerlauf-
// Messung aussähe.
interface NetMetrics {
  iface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  linkMbps?: number;
}

// gpuMetrics fehlt (statt eines Nullwert-Objekts), wenn der Host-Agent
// keinen GPU-Index für die Telemetrie konfiguriert hat
// (host-agent/internal/telemetry.GpuSample-Doku, Nutzerauftrag
// 2026-09-17) — kein stiller "0%", der wie eine echte Leerlauf-Messung
// aussähe.
interface GpuMetrics {
  index: number;
  utilizationPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
}

interface HostMetrics {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  receivedAt: string;
  net?: NetMetrics;
  gpu?: GpuMetrics;
  clock?: ClockIn;
}

interface HostEntry {
  id: string;
  label: string;
  hostname: string;
  registeredAt: string;
  metrics?: HostMetrics;
  maintenance?: MaintenanceStatus;
}

// Spiegelt maintenance.Status (orchestrator/internal/maintenance).
interface MaintenanceItem { kind: string; instanceId: string; label?: string; reason?: string }
interface MaintenanceStatus {
  state: "evacuating" | "drained" | "blocked";
  total: number;
  moved: number;
  failed?: MaintenanceItem[];
  remaining?: MaintenanceItem[];
}

// Kapitel 14 Teil 1 (docs/END-GOAL-FEATURES.md §14.4): Sparkline +
// Min/Ø/Max-Spalten aus GET /api/v1/hosts/{id}/metrics/history — Typen
// spiegeln hosts.HistoryWindow (orchestrator/internal/hosts/history.go).
interface HistorySample {
  timestamp: string;
  cpuPercent: number;
  memPercent: number;
}

interface HistorySummary {
  cpuMin: number;
  cpuAvg: number;
  cpuMax: number;
  memMin: number;
  memAvg: number;
  memMax: number;
  sampleCount: number;
}

interface HistoryWindow {
  resolution: "raw" | "aggregate";
  samples?: HistorySample[];
  summary: HistorySummary;
}

interface PlacementAdvice {
  hostId: string;
  hostLabel: string;
  reason: string;
  cpuPercent: number;
  memPercent: number;
  // netPercent fehlt, wenn dieser Host keine NIC-Auslastung mit bekannter
  // Link-Kapazität meldet (orchestrator/internal/placement.Advice.
  // NetPercent-Doku, Nutzerauftrag 2026-09-02).
  netPercent?: number;
  // gpuPercent fehlt, wenn dieser Host keinen GPU-Index konfiguriert hat
  // (orchestrator/internal/placement.Advice.GpuPercent-Doku,
  // Nutzerauftrag 2026-09-17).
  gpuPercent?: number;
  instanceIds: string[];
  suggestedHostId?: string;
  suggestedHostLabel?: string;
  detectedAt: string;
  predicted?: boolean;
  minutesToLimit?: number;
}

// D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2) —
// spiegelt workflows.PendingMigrationView (migration.go): ein laufender
// auto-confirm-window-Countdown.
interface PendingMigration {
  workflowId: string;
  role: string;
  targetHostId: string;
  targetHostLabel: string;
  deadlineAt: string;
}

const POLL_FALLBACK_INTERVAL_MS = 30000;

// Nutzerauftrag 2026-09-21 ("hosts-view.ts auch mit Online/Offline-
// Anzeige ergänzen"): gleicher Schwellwert wie flow-canvas.ts'
// HOST_ONLINE_THRESHOLD_MS (bewusst dupliziert statt geteilt, s.
// Moduldoku oben) — ein Host gilt als online, wenn seine letzte
// Telemetrie nicht älter als das Dreifache des Host-Agent-Sende-
// Intervalls (5s) ist.
const HOST_ONLINE_THRESHOLD_MS = 15000;

function isHostOnline(metrics?: HostMetrics): boolean {
  return !!metrics && Date.now() - Date.parse(metrics.receivedAt) < HOST_ONLINE_THRESHOLD_MS;
}

const HOST_METRICS_SUBJECT_PREFIX = "omp.host.";
const HOST_METRICS_SUBJECT_SUFFIX = ".metrics";

function isRefreshEvent(type: string): boolean {
  if (
    type === "host.registered" ||
    type === "host.removed" ||
    type === "host.maintenance" ||
    type === "placement.advice" ||
    // D6 Teil 4: "workflow.migration" deckt sowohl neu geplante als auch
    // bestätigte/abgelaufene/abgebrochene/abgeschlossene Migrationen ab —
    // ein voller Re-Poll (statt eines eigenen Diff-Pfads) hält die
    // Pending-Liste und die Host-Tabelle konsistent zueinander.
    type === "workflow.migration" ||
    type === "lost-events"
  ) return true;
  return type.startsWith(HOST_METRICS_SUBJECT_PREFIX) && type.endsWith(HOST_METRICS_SUBJECT_SUFFIX);
}

// D6 Teil 4: Rest-Sekunden bis deadlineAt, nie negativ (ein knapp
// abgelaufener, aber noch nicht per SSE aktualisierter Countdown soll
// "0s" zeigen, keine negative Zahl).
function secondsUntil(deadlineAt: string): number {
  return Math.max(0, Math.round((new Date(deadlineAt).getTime() - Date.now()) / 1000));
}

// Nutzerauftrag 2026-09-02: "reason" kommt vom Backend als "+"-
// verbundene Liste überschwellener Dimensionen (placement.evaluateOnce)
// — generisch übersetzt statt fest verdrahteter Kombinationen (gleiches
// Muster wie alarm-view.ts' reasonLabel), sonst müsste jede neue
// Kombination hier extra nachgezogen werden.
const REASON_TOKEN_LABEL: Record<string, string> = { cpu: "CPU", mem: "RAM", net: t("hosts.72ce72"), gpu: "GPU" };

function reasonLabel(reason: string): string {
  return reason
    .split("+")
    .map((token) => REASON_TOKEN_LABEL[token] ?? token)
    .join("+");
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// formatNetRate zeigt Rx/Tx in Mbit/s (Netzwerk-Konvention, nicht
// MB/s wie formatBytes oben) plus, falls bekannt, die Auslastung in %
// der gemeldeten Link-Kapazität (Nutzerauftrag 2026-09-02).
function formatNetRate(net: NetMetrics): string {
  const rxMbps = (net.rxBytesPerSec * 8) / 1_000_000;
  const txMbps = (net.txBytesPerSec * 8) / 1_000_000;
  const base = `↓${rxMbps.toFixed(1)} ↑${txMbps.toFixed(1)} Mbit/s`;
  if (!net.linkMbps) return base;
  const percent = ((rxMbps + txMbps) / net.linkMbps) * 100;
  return `${base} (${percent.toFixed(0)}%)`;
}

// formatGpuUsage zeigt Auslastung% + VRAM-Belegung (Nutzerauftrag
// 2026-09-17) — kein Link-Kapazitäts-Sonderfall wie bei formatNetRate,
// nvidia-smi liefert utilization.gpu bereits als Prozentwert.
function formatGpuUsage(gpu: GpuMetrics): string {
  return `${gpu.utilizationPercent.toFixed(0)}% (${formatBytes(gpu.memUsedBytes)} / ${formatBytes(gpu.memTotalBytes)})`;
}

// Sparkline für CPU% der letzten Stunde (Kapitel 14 Teil 1) — feste
// 0–100%-Skala (nicht auf den beobachteten Min/Max normalisiert), damit
// Zeilen verschiedener Hosts optisch vergleichbar bleiben statt jede für
// sich flach/steil zu wirken. Kein Chart-Framework (Minimal-
// Dependency-Regel, UMSETZUNG.md §0 Punkt 5) — ein einzelnes inline-SVG
// <path>.
const SPARKLINE_WIDTH = 90;
const SPARKLINE_HEIGHT = 22;

function sparklinePath(values: number[]): string {
  if (values.length < 2) return "";
  const stepX = SPARKLINE_WIDTH / (values.length - 1);
  return values
    .map((v, i) => {
      const x = (i * stepX).toFixed(1);
      const y = (SPARKLINE_HEIGHT - (Math.min(Math.max(v, 0), 100) / 100) * SPARKLINE_HEIGHT).toFixed(1);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

function sparklineSvg(values: number[]): string {
  if (values.length < 2) {
    return `<span style="color:var(--omp-text-dim);">–</span>`;
  }
  return `<svg width="${SPARKLINE_WIDTH}" height="${SPARKLINE_HEIGHT}" viewBox="0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}" style="display:block;">
    <path d="${sparklinePath(values)}" fill="none" stroke="var(--omp-info)" stroke-width="1.5" />
  </svg>`;
}

function formatMinAvgMax(min: number, avg: number, max: number): string {
  return `${min.toFixed(0)} / ${avg.toFixed(0)} / ${max.toFixed(0)}%`;
}

class HostsView extends HTMLElement {
  #pollHandle: number | undefined;
  // D6 Teil 4: 1s-Ticker für den Live-Countdown der Pending-Migrationen
  // — läuft nur, solange #lastPending nicht leer ist (s. #render),
  // rendert mit den zuletzt geholten Daten neu statt jede Sekunde die
  // API abzufragen.
  #countdownHandle: number | undefined;
  // Kapitel 54: Topologie und Verlauf sind eigene, dauerhafte Elemente (der Poll zeichnet diese Ansicht komplett neu, sie dürfen
  // dabei weder Auswahl noch Zeitfenster verlieren).
  #topo = document.createElement("omp-host-topology") as HostTopology;
  #trends = document.createElement("omp-host-trends") as HostTrends;
  #topoKey = "";
  #lastHosts: HostEntry[] = [];
  #lastAdvice: PlacementAdvice[] = [];
  #lastHistory: Map<string, HistoryWindow> = new Map();
  #lastPending: PendingMigration[] = [];
  // Der "Neuen Host hinzufügen"-Button ist admin-only (der dahinter
  // liegende Bootstrap-Token-Endpunkt ist es server-seitig ohnehin,
  // s. host-wizard.ts) — gleiches whoami()-Gating wie app-shell.ts'
  // Administration-Tab, hier zusätzlich rein clientseitig, damit
  // Nicht-Admins den Button gar nicht erst sehen statt einen 403 zu
  // erleben.
  #isAdmin = false;

  connectedCallback() {
    this.#topo.onSelect = (id) => this.#trends.select(id);
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([], [], new Map(), []);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
    // Event-Delegation auf `this` statt Listener pro Render neu zu
    // binden (#render setzt innerHTML komplett neu) — gleiches Muster
    // wie datenattributgetriebene Klick-Handler andernorts im Projekt.
    this.addEventListener("click", this.#onClick);
    whoami()
      .then(({ isAdmin }) => {
        if (!isAdmin) return;
        this.#isAdmin = true;
        this.#render(this.#lastHosts, this.#lastAdvice, this.#lastHistory, this.#lastPending);
      })
      .catch(() => {
        // Nicht angemeldet/Fehler — Button bleibt ausgeblendet, kein
        // Absturz dieser sonst rein lesenden View.
      });
  }

  #onClick = (ev: Event) => {
    const wizardTarget = (ev.target as HTMLElement)?.closest<HTMLElement>("[data-action='add-host']");
    if (wizardTarget) {
      openHostWizard();
      return;
    }
    const maintTarget = (ev.target as HTMLElement)?.closest<HTMLElement>("[data-action='maintenance']");
    if (maintTarget) {
      void this.#toggleMaintenance(maintTarget.dataset.hostId ?? "", maintTarget.dataset.hostLabel ?? "", maintTarget.dataset.on === "1");
      return;
    }
    const moveTarget = (ev.target as HTMLElement)?.closest<HTMLElement>("[data-action='move-instance']");
    if (moveTarget) {
      void this.#moveInstanceDialog(moveTarget.dataset);
      return;
    }
    const removeTarget = (ev.target as HTMLElement)?.closest<HTMLElement>("[data-action='remove-host']");
    if (removeTarget) {
      void this.#removeHost(removeTarget.dataset.hostId ?? "", removeTarget.dataset.hostLabel ?? "");
      return;
    }
    const target = (ev.target as HTMLElement)?.closest<HTMLElement>("[data-migration-action]");
    if (!target) return;
    const workflowId = target.dataset.workflowId ?? "";
    const role = target.dataset.role ?? "";
    if (!workflowId || !role) return;
    if (target.dataset.migrationAction === "confirm") this.#confirmMigration(workflowId, role);
    else if (target.dataset.migrationAction === "cancel") this.#cancelMigration(workflowId, role);
  };

  async #toggleMaintenance(id: string, label: string, on: boolean) {
    if (!id) return;
    if (on && !(await confirmDialog(t("hosts.maintConfirm", { p0: label }), { confirmLabel: t("hosts.maintOn") }))) return;
    const res = await apiFetch(`/api/v1/admin/hosts/${encodeURIComponent(id)}/maintenance`, { method: on ? "POST" : "DELETE" });
    if (!res.ok) showToast(t("hosts.removeFailed", { p0: (await res.text()).trim() }), { variant: "error" });
    this.#poll();
  }

  // Popup: Zielhost wählen, dann verschieben (Stop-dann-Start, kurze Unterbrechung).
  async #moveInstanceDialog(d: DOMStringMap) {
    const id = decodeURIComponent(d.instanceId ?? "");
    if (!id) return;
    const label = decodeURIComponent(d.instanceLabel ?? "") || id;
    let targets: { id: string; label: string }[] = [];
    try {
      targets = JSON.parse(decodeURIComponent(d.targets ?? "[]"));
    } catch {
      return;
    }
    const chosen = await new Promise<{ id: string; label: string } | null>((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);font-family:var(--omp-font,system-ui,sans-serif);font-size:var(--omp-font-size-sm,12px);";
      const box = document.createElement("div");
      box.style.cssText = "background:var(--omp-surface,#24272b);color:var(--omp-text,#e8eaed);border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);padding:16px;max-width:380px;box-shadow:0 4px 16px rgba(0,0,0,0.4);";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:8px;";
      title.textContent = t("hosts.maintMoveDialogTitle", { p0: label });
      const info = document.createElement("div");
      info.style.cssText = "margin-bottom:12px;color:var(--omp-text-dim);";
      info.textContent = t("hosts.maintMoveDialogInfo");
      const select = document.createElement("select");
      select.style.cssText = "width:100%;margin-bottom:12px;";
      for (const tg of targets) {
        const opt = document.createElement("option");
        opt.value = tg.id;
        opt.textContent = tg.label;
        select.appendChild(opt);
      }
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = t("hosts.maintMoveCancel");
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "omp-btn-primary";
      ok.textContent = t("hosts.maintMoveBtn");
      const close = (v: { id: string; label: string } | null) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(v);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close(null);
      };
      cancel.addEventListener("click", () => close(null));
      ok.addEventListener("click", () => close(targets.find((tg) => tg.id === select.value) ?? null));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(null);
      });
      document.addEventListener("keydown", onKey, true);
      actions.append(cancel, ok);
      box.append(title, info, select, actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      select.focus();
    });
    if (!chosen) return;
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(id)}/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetHostId: chosen.id }),
    });
    if (!res.ok) showToast(t("hosts.maintMoveFailed", { p0: (await res.text()).trim() }), { variant: "error" });
    else showToast(t("hosts.maintMoveStarted", { p0: label }));
    this.#poll();
  }

  async #removeHost(id: string, label: string) {
    if (!id || !(await confirmDialog(t("hosts.removeConfirm", { p0: label }), { confirmLabel: t("hosts.remove") }))) return;
    const res = await apiFetch(`/api/v1/admin/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) showToast(t("hosts.removeFailed", { p0: (await res.text()).trim() }), { variant: "error" });
    this.#poll();
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    this.#stopCountdown();
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
    this.removeEventListener("click", this.#onClick);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (isRefreshEvent(parsed.type)) this.#poll();
  };

  async #poll() {
    try {
      const [hostsRes, adviceRes, pendingRes] = await Promise.all([
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/placement/advice"),
        apiFetch("/api/v1/placement/migrations"),
      ]);
      if (!hostsRes.ok) return;
      const hosts = (await hostsRes.json()) as HostEntry[];
      // Der Host des Orchestrators selbst steht nicht in der Registry (kein Host-Agent) — mit anzeigen.
      try {
        const localRes = await apiFetch("/api/v1/hosts/local");
        if (localRes.ok) hosts.unshift((await localRes.json()) as HostEntry);
      } catch { /* ältere Orchestrator-Version ohne den Endpunkt */ }
      const advice = adviceRes.ok ? ((await adviceRes.json()) as PlacementAdvice[]) : [];
      const pending = pendingRes.ok ? ((await pendingRes.json()) as PendingMigration[]) : [];
      const history = await this.#fetchHistory(hosts);
      this.#render(hosts, advice, history, pending);
      await this.#feedGraphics(hosts);
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  // Hostliste für Topologie und Verlauf; Job-Daten (Plätze, Live-Reserve) kommen best effort aus dem Job-Modul.
  async #feedGraphics(hosts: HostEntry[]) {
    let jobHosts: { ID: string; Running: number; Reserved: number; MaxJobs: number; CPUCores?: number; Reserve?: { cpu: number } }[] = [];
    try {
      const r = await apiFetch("/api/v1/jobs/hosts");
      if (r.ok) jobHosts = ((await r.json()) as { hosts?: typeof jobHosts }).hosts ?? [];
    } catch { /* Job-Modul nicht verfügbar oder keine Berechtigung */ }
    const jh = new Map(jobHosts.map((j) => [j.ID, j]));
    const topo: TopoHostIn[] = hosts.map((h) => {
      const m = h.metrics;
      const j = jh.get(h.id === "" ? "local" : h.id);
      const link = m?.net?.linkMbps;
      return {
        id: h.id,
        label: h.label || h.hostname || h.id,
        online: h.id === "" ? true : isHostOnline(m),
        maintenance: !!h.maintenance,
        cpu: m?.cpuPercent,
        mem: m && m.memTotalBytes > 0 ? (m.memUsedBytes / m.memTotalBytes) * 100 : undefined,
        gpu: m?.gpu?.utilizationPercent,
        net: m?.net && link ? ((m.net.rxBytesPerSec + m.net.txBytesPerSec) * 8) / 1e6 / link * 100 : undefined,
        jobs: j ? j.Running + j.Reserved : undefined,
        liveReserveCpu: j?.Reserve?.cpu,
      };
    });
    const key = JSON.stringify(topo.map((x) => [x.id, x.label, x.online, x.maintenance, Math.round(x.cpu ?? -1), Math.round(x.mem ?? -1), Math.round(x.gpu ?? -1), Math.round(x.net ?? -1), x.jobs, x.liveReserveCpu]));
    if (key === this.#topoKey) return;
    this.#topoKey = key;
    this.#topo.hosts = topo;
    this.#trends.hosts = topo.map((x) => ({ id: x.id === "" ? "local" : x.id, label: x.label, reserveCpu: x.liveReserveCpu, cores: jh.get(x.id === "" ? "local" : x.id)?.CPUCores }));
  }

  #startCountdown() {
    if (this.#countdownHandle !== undefined) return;
    this.#countdownHandle = window.setInterval(() => {
      this.#render(this.#lastHosts, this.#lastAdvice, this.#lastHistory, this.#lastPending);
    }, 1000);
  }

  #stopCountdown() {
    if (this.#countdownHandle === undefined) return;
    window.clearInterval(this.#countdownHandle);
    this.#countdownHandle = undefined;
  }

  // D6 Teil 4: "Jetzt ausführen"/"Abbrechen" für einen laufenden
  // auto-confirm-window-Countdown — best effort wie andere
  // Bedien-Aktionen dieser View (fehlt kein eigenes Fehler-Toast, der
  // nächste SSE-"workflow.migration"-Event bzw. Poll zeigt den
  // tatsächlichen Stand ohnehin wieder an).
  async #confirmMigration(workflowId: string, role: string) {
    await apiFetch(`/api/v1/placement/migrations/${encodeURIComponent(workflowId)}/${encodeURIComponent(role)}/confirm`, { method: "POST" });
    this.#poll();
  }

  async #cancelMigration(workflowId: string, role: string) {
    await apiFetch(`/api/v1/placement/migrations/${encodeURIComponent(workflowId)}/${encodeURIComponent(role)}/cancel`, { method: "POST" });
    this.#poll();
  }

  // Kapitel 14 Teil 1: eine Anfrage pro Host, parallel — Anzahl Hosts ist
  // hier klein (Ziel-Größenordnung "etliche Hosts", nicht Hunderte), ein
  // gebündelter Endpunkt wäre verfrühte Optimierung (§14.3a spezifiziert
  // ohnehin genau diese Route: GET .../hosts/{id}/metrics/history).
  // Ein Fehlschlag pro Host (z. B. gerade erst registriert, noch keine
  // Telemetrie) blendet nur dessen Sparkline aus, bricht den Poll nicht ab.
  async #fetchHistory(hosts: HostEntry[]): Promise<Map<string, HistoryWindow>> {
    const entries = await Promise.all(
      hosts.map(async (h): Promise<[string, HistoryWindow] | undefined> => {
        if (!h.id) return undefined; // lokaler Host: keine Verlaufsdaten
        try {
          const res = await apiFetch(`/api/v1/hosts/${encodeURIComponent(h.id)}/metrics/history?window=1h`);
          if (!res.ok) return undefined;
          return [h.id, (await res.json()) as HistoryWindow];
        } catch {
          return undefined;
        }
      }),
    );
    return new Map(entries.filter((e): e is [string, HistoryWindow] => e !== undefined));
  }

  #render(hosts: HostEntry[], advice: PlacementAdvice[], history: Map<string, HistoryWindow>, pending: PendingMigration[]) {
    this.#lastHosts = hosts;
    this.#lastAdvice = advice;
    this.#lastHistory = history;
    this.#lastPending = pending;
    if (pending.length > 0) this.#startCountdown();
    else this.#stopCountdown();

    const rows = hosts
      .map((h) => {
        const m = h.metrics;
        const online = isHostOnline(m);
        const cpu = m ? `${m.cpuPercent.toFixed(0)}%` : "–";
        const mem = m ? `${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)}` : "–";
        const net = m?.net ? formatNetRate(m.net) : "–";
        const gpu = m?.gpu ? formatGpuUsage(m.gpu) : "–";
        const seen = m ? new Date(m.receivedAt).toLocaleTimeString() : "nie";
        const win = history.get(h.id);
        const cpuValues = win?.samples?.map((s) => s.cpuPercent) ?? [];
        const spark = sparklineSvg(cpuValues);
        const minAvgMax =
          win && win.summary.sampleCount > 0
            ? formatMinAvgMax(win.summary.cpuMin, win.summary.cpuAvg, win.summary.cpuMax)
            : `<span style="color:var(--omp-text-dim);">–</span>`;
        // Nutzerauftrag 2026-09-21: Online/Offline muss auch hier auf
        // den ersten Blick erkennbar sein, nicht erst über den rohen
        // "Zuletzt gesehen"-Zeitstempel erschlossen werden — Punkt +
        // Text statt reiner Farbe (Tooltip trägt den genauen Zeitpunkt
        // bzw. "keine Telemetrie" bei einem frisch registrierten Host).
        const statusTitle = online
          ? t("hosts.514366")
          : m
            ? t("hosts.eda8d2", { p0: new Date(m.receivedAt).toLocaleTimeString() })
            : t("hosts.61ea4b");
        const clockIssue = online ? clockProblem(m?.clock) : "";
        const clockBadge = clockIssue
          ? ` <span title="${escapeHtml(tLoose("hosts.clock." + clockIssue, { err: m?.clock?.maxErrorUs ?? 0 }) + (m?.clock?.fix === "no-permission" || m?.clock?.fix === "no-server" ? " " + tLoose("hosts.clock.fix." + m.clock.fix, {}) : ""))}" style="color:#d9a21b;cursor:help;white-space:nowrap;">⏱ ${escapeHtml(t("hosts.clock.badge"))}</span>`
          : "";
        const status = `<span title="${escapeHtml(statusTitle)}" style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:${
          online ? "inherit" : "#e05252"
        };">
          <span style="color:${online ? "#4caf50" : "#e05252"};font-size:11px;line-height:1;">●</span>${online ? t("hosts.54f664") : t("hosts.8d9da4")}
        </span>`;
        const mt = h.maintenance;
        const maintBadge = mt
          ? (() => {
              const list = [...(mt.failed ?? []), ...(mt.remaining ?? [])].map((i) => `${i.label || i.instanceId}${i.reason ? ` (${i.reason})` : ""}`);
              const text =
                mt.state === "evacuating"
                  ? t("hosts.maintEvacuating", { p0: mt.moved, p1: mt.total })
                  : mt.state === "drained"
                    ? t("hosts.maintDrained")
                    : t("hosts.maintBlocked", { p0: (mt.remaining ?? []).length });
              const color = mt.state === "drained" ? "#4caf50" : mt.state === "blocked" ? "#e0a030" : "#4a90e2";
              // Verbleibende eigenständige Instanzen: Grund + Verschieben-Knöpfe
              // je möglichem Zielhost (Stop-dann-Start, kurze Unterbrechung).
              const targets = [
                ...hosts.filter((o) => o.id && o.id !== h.id && !o.maintenance && isHostOnline(o.metrics)).map((o) => ({ id: o.id, label: o.label })),
                { id: "", label: t("hosts.maintLocal") },
              ];
              const items = (mt.remaining ?? [])
                .filter((i) => i.kind === "instance")
                .map((i) => {
                  const reason = i.reason ? tLoose(`hosts.maintReason.${i.reason}`) : "";
                  // escapeHtml lässt Anführungszeichen stehen (innerHTML) — für Attributwerte daher URL-kodieren.
                  const targetsJson = encodeURIComponent(JSON.stringify(targets));
                  const buttons =
                    this.#isAdmin && i.reason !== "hostBound"
                      ? `<button type="button" data-action="move-instance" data-instance-id="${encodeURIComponent(i.instanceId)}" data-instance-label="${encodeURIComponent(i.label || i.instanceId)}" data-targets="${targetsJson}" style="font-size:10px;padding:1px 6px;margin-left:6px;cursor:pointer;">${escapeHtml(t("hosts.maintMoveBtn"))}</button>`
                      : "";
                  return `<div style="font-size:10px;color:var(--omp-text-dim);white-space:nowrap;">• ${escapeHtml(i.label || i.instanceId)}${reason ? ` — ${escapeHtml(reason)}` : ""}${buttons}</div>`;
                })
                .join("");
              return `<div title="${escapeHtml(list.join("\n"))}" style="color:${color};font-size:11px;white-space:nowrap;">🛠 ${escapeHtml(text)}</div>${items}`;
            })()
          : "";
        const rowTint = online ? "" : "background:rgba(224,82,82,0.08);";
        return `<tr style="${rowTint}">
          <td style="padding:2px 8px;">${status}${maintBadge}${clockBadge}</td>
          <td style="padding:2px 8px;">${escapeHtml(h.label)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(h.hostname)}</td>
          <td style="padding:2px 8px;">${cpu}</td>
          <td style="padding:2px 8px;">${mem}</td>
          <td style="padding:2px 8px;white-space:nowrap;">${net}</td>
          <td style="padding:2px 8px;white-space:nowrap;">${gpu}</td>
          <td style="padding:2px 8px;">${spark}</td>
          <td style="padding:2px 8px;white-space:nowrap;">${minAvgMax}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${seen}</td>
          <td style="padding:2px 8px;white-space:nowrap;">${
            this.#isAdmin && h.id
              ? `<button type="button" data-action="maintenance" data-on="${h.maintenance ? "0" : "1"}" data-host-id="${escapeHtml(h.id)}" data-host-label="${escapeHtml(h.label)}" style="font-size:11px;padding:2px 8px;cursor:pointer;">${h.maintenance ? t("hosts.maintOff") : t("hosts.maintOn")}</button> `
              : ""
          }${
            this.#isAdmin && !online && h.id
              ? `<button type="button" data-action="remove-host" data-host-id="${escapeHtml(h.id)}" data-host-label="${escapeHtml(h.label)}" title="${escapeHtml(t("hosts.remove"))}" style="font-size:11px;padding:2px 8px;cursor:pointer;">${t("hosts.remove")}</button>`
              : ""
          }</td>
        </tr>`;
      })
      .join("");

    const adviceBanner = advice
      .map((a) => {
        const target = a.suggestedHostId
          ? `${t("hosts.424d6d")} <strong>${escapeHtml(a.suggestedHostLabel ?? a.suggestedHostId)}</strong>`
          : `<span style="color:var(--omp-cue);">${t("hosts.c77b3a")}</span>`;
        const netPart = a.netPercent !== undefined ? tt("y.netPart", { p0: a.netPercent.toFixed(0) }) : "";
        const gpuPart = a.gpuPercent !== undefined ? ` / GPU ${a.gpuPercent.toFixed(0)}%` : "";
        if (a.predicted) {
          return `<div style="padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);background:rgba(255,183,77,0.15);border:1px solid var(--omp-cue);border-radius:var(--omp-radius);">
          <strong>${t("hosts.predictedBadge")}</strong> ${escapeHtml(t("hosts.predicted", { p0: `${a.hostLabel} (${reasonLabel(a.reason)})`, p1: a.minutesToLimit ?? 0, p2: a.cpuPercent.toFixed(0), p3: a.memPercent.toFixed(0), p4: a.instanceIds.length, p5: a.suggestedHostId ? (a.suggestedHostLabel ?? a.suggestedHostId) : "–" }))}
        </div>`;
        }
        return `<div style="padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);background:rgba(239,83,80,0.15);border:1px solid var(--omp-error);border-radius:var(--omp-radius);">
          <strong>${escapeHtml(a.hostLabel)}</strong> ${t("hosts.857412", { p0: reasonLabel(a.reason), p1: a.cpuPercent.toFixed(0), p2: a.memPercent.toFixed(0), p3: netPart, p4: gpuPart, p5: a.instanceIds.length, p6: target })}
        </div>`;
      })
      .join("");

    // D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2):
    // laufende auto-confirm-window-Countdowns — eigener Banner-Block
    // unterhalb der reinen advisory-Alarme, mit Live-Countdown (der
    // 1s-Ticker aus #startCountdown rendert diese Funktion erneut) und
    // Bedien-Buttons.
    const pendingBanner = pending
      .map((p) => {
        const remaining = secondsUntil(p.deadlineAt);
        return `<div style="padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);background:rgba(255,183,77,0.15);border:1px solid var(--omp-cue);border-radius:var(--omp-radius);display:flex;align-items:center;gap:var(--omp-space-2);flex-wrap:wrap;">
          <span>${t("hosts.e50108")} <strong>${escapeHtml(p.role)}</strong> ${t("hosts.7fdb90")} <strong>${remaining}s</strong> ${t("hosts.bcf38d")} <strong>${escapeHtml(p.targetHostLabel || p.targetHostId)}</strong> ${t("hosts.0f1de4")}</span>
          <button data-migration-action="confirm" data-workflow-id="${escapeHtml(p.workflowId)}" data-role="${escapeHtml(p.role)}" style="font-size:11px;padding:2px 8px;cursor:pointer;">${t("hosts.578226")}</button>
          <button data-migration-action="cancel" data-workflow-id="${escapeHtml(p.workflowId)}" data-role="${escapeHtml(p.role)}" style="font-size:11px;padding:2px 8px;cursor:pointer;">${t("hosts.4b9727")}</button>
        </div>`;
      })
      .join("");

    const addHostButton = this.#isAdmin
      ? `<button type="button" data-action="add-host" class="omp-btn-primary" style="font-size:11px;padding:4px 10px;">${t("hosts.995111")}</button>`
      : "";

    this.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--omp-space-3);">
        <div class="omp-h1">${t("hosts.080196", { p0: hosts.length })}</div>
        ${addHostButton}
      </div>
      ${adviceBanner}
      ${pendingBanner}
      <div data-slot="topo" style="margin-bottom:var(--omp-space-4);">
        <div class="omp-h1" style="margin-bottom:var(--omp-space-2);">${t("topo.title")}</div>
      </div>
      ${
        hosts.length === 0
          ? `<div class="omp-empty">${t("hosts.75d9aa")}</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:var(--omp-text-dim);text-align:left;">
                <th style="padding:2px 8px;">${t("hosts.ec53a8")}</th>
                <th style="padding:2px 8px;">${t("hosts.b021df")}</th>
                <th style="padding:2px 8px;">${t("hosts.c8f4b8")}</th>
                <th style="padding:2px 8px;">${t("hosts.2b5538")}</th>
                <th style="padding:2px 8px;">${t("hosts.e53619")}</th>
                <th style="padding:2px 8px;">${t("hosts.72ce72")}</th>
                <th style="padding:2px 8px;">${t("hosts.52f9ec")}</th>
                <th style="padding:2px 8px;">${t("hosts.25850a")}</th>
                <th style="padding:2px 8px;">${t("hosts.be62a5")}</th>
                <th style="padding:2px 8px;">${t("hosts.4d62c2")}</th>
                <th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
      }
      <div data-slot="trend" style="margin-top:var(--omp-space-4);">
        <div class="omp-h1" style="margin-bottom:var(--omp-space-2);">${t("trend.title")}</div>
      </div>
    `;
    this.querySelector('[data-slot="topo"]')?.append(this.#topo);
    this.querySelector('[data-slot="trend"]')?.append(this.#trends);
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-hosts-view", HostsView);
