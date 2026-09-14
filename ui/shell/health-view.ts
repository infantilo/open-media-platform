// <omp-health-view> — "Health"-Tab (Nutzerauftrag 2026-09-14: "ein
// Dashboard, das alle BCP008 Daten intuitiv und fancy darstellen kann").
// Anders als das bestehende BCP-008-Statuspanel im Flow-Editor
// (ui/graph/flow-canvas.ts #buildBcp008Section, Nachtrag 214, EIN Node
// zur Zeit, nur sichtbar wenn dessen Kachel-Panel offen ist): systemweite
// Fleet-Übersicht über ALLE laufenden BCP-008-fähigen Instanzen
// gleichzeitig, unabhängig von Workflow-Zuordnung/Flow-Editor-Filter.
//
// Bewusst kein neuer Backend-Endpunkt — reiner Konsument dreier bereits
// bestehender Bausteine, exakt wie alarm-view.ts es für seine drei
// Quellen vormacht:
//   - GET /api/v1/instances (welche Instanzen laufen)
//   - GET /api/v1/nodes/{id}/descriptor (BCP-008-Erkennung + Receiver-/
//     Sender-Vokabular, s. ui/graph/bcp008.ts — dieselben Helfer wie das
//     Statuspanel, jetzt aus flow-canvas.ts ausgelagert statt dupliziert)
//   - GET /api/v1/nodes/{id}/params/{name} (die monitor.*-Werte selbst)
//
// Kein SSE-Event existiert für "ein monitor.*-Wert hat sich geändert"
// (die 1s-Tick-Health-Übergänge in omp_node_sdk::bcp008::Monitor sind rein
// node-lokal, nicht Teil des Orchestrator-Event-Bus) — anders als
// instances-view.ts (Kapitel-14-CPU/RSS-Werte) ist das hier kein
// dokumentiertes Sample-Intervall, sondern eine bewusste, moderate
// Polling-Kadenz (HEALTH_POLL_INTERVAL_MS) für die Werte selbst. Die
// Instanzliste + Descriptor-Erkennung bleibt dagegen SSE-first wie bei
// alarm-view.ts (node.added/node.removed/instance.crashed/-restarted
// lösen einen sofortigen Refresh aus), da sich diese Struktur seltener
// ändert als die Statuswerte.
import { apiFetch, connectionMonitor } from "./connection.ts";
import type { Descriptor } from "../graph/controls.ts";
import {
  bcp008ParamNames,
  bcp008StatusColor,
  bcp008Vocabulary,
  type Bcp008Vocabulary,
  hasBcp008Monitor,
  isBcp008Sender,
} from "../graph/bcp008.ts";

// Wire-Format identisch zu launcher.Instance — eigene, schmale lokale
// Kopie, gleiches Muster wie alarm-view.ts/instances-view.ts.
interface LauncherInstance {
  id: string;
  type: string;
  label: string;
  hostId?: string;
}

interface HostInfo {
  id: string;
  label: string;
}

// Wire-Format-Ausschnitt von orchestrator/internal/graph.Node: der
// generische Node-Proxy (GET /api/v1/nodes/{id}/...) erwartet die
// NMOS-Node-ID (graph.Node.ID, s. GraphService/handleGraph), NICHT die
// launcher.Instance.ID — beides sind unterschiedliche IDs für dieselbe
// laufende Instanz (live per curl bestätigt: ein direkter Descriptor-
// Fetch mit der Instanz-ID liefert "unknown node"). graph.Node.InstanceID
// ist die Brücke zwischen beiden — ui/graph/flow-canvas.ts nutzt aus
// genau diesem Grund durchweg Graph-Node-IDs, nie Instanz-IDs, für seine
// #fetchParamValue-Aufrufe.
interface GraphNode {
  id: string;
  instanceId?: string;
}

const VALUES_POLL_INTERVAL_MS = 4000;
const STRUCTURE_POLL_FALLBACK_INTERVAL_MS = 30000;

const STRUCTURE_REFRESH_EVENT_TYPES = new Set([
  "node.added",
  "node.removed",
  "instance.crashed",
  "instance.restarted",
  "host.registered",
  "lost-events",
]);

interface DomainStatus {
  label: string;
  status: string;
  message?: string;
}

interface NodeHealth {
  nodeId: string;
  label: string;
  type: string;
  hostLabel: string;
  overallStatus: string;
  overallMessage?: string;
  domains: DomainStatus[];
  syncSource?: string;
}

// "Healthy"/"AllUp" usw. sind pro Domain unterschiedlich benannt (s.
// bcp008.ts-Doku) — für die Zusammenfassungs-Kacheln oben zählt nur die
// grobe Kategorie des Overall-Status, deshalb eigene, kleine Bucket-
// Zuordnung statt der feineren Domain-Farblogik.
const OVERALL_BUCKETS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: "healthy", label: "Healthy", match: (s) => s === "Healthy" },
  { key: "partial", label: "Partially Healthy", match: (s) => s === "PartiallyHealthy" },
  { key: "unhealthy", label: "Unhealthy", match: (s) => s === "Unhealthy" },
  { key: "inactive", label: "Inactive", match: (s) => s === "Inactive" },
];

class HealthView extends HTMLElement {
  #valuesPollHandle: number | undefined;
  #structurePollHandle: number | undefined;
  // nodeId -> Vokabular, oder null = geprüft und KEIN BCP-008-Support
  // (Nachbar-Konzept zu #paletteInstances in flow-canvas.ts, hier nur für
  // den einen Zweck "welche Instanzen überhaupt fragen").
  #vocabCache = new Map<string, Bcp008Vocabulary | null>();
  #hosts: HostInfo[] = [];
  #destroyed = false;

  connectedCallback() {
    this.#destroyed = false;
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([], "loading");
    void this.#refreshStructure().then(() => this.#pollValues());

    this.#structurePollHandle = window.setInterval(
      () => this.#refreshStructure(),
      STRUCTURE_POLL_FALLBACK_INTERVAL_MS,
    );
    this.#valuesPollHandle = window.setInterval(() => this.#pollValues(), VALUES_POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    this.#destroyed = true;
    if (this.#structurePollHandle !== undefined) window.clearInterval(this.#structurePollHandle);
    if (this.#valuesPollHandle !== undefined) window.clearInterval(this.#valuesPollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (STRUCTURE_REFRESH_EVENT_TYPES.has(parsed.type)) void this.#refreshStructure().then(() => this.#pollValues());
  };

  // Aktualisiert Instanzliste + Host-Labels + Instanz→Graph-Node-ID-
  // Zuordnung + BCP-008-Erkennung (welche Nodes überhaupt einen
  // monitor.overallStatus-Descriptor-Eintrag haben) — teurer als
  // #pollValues (ein Descriptor-Fetch pro NEUER Instanz), deshalb
  // seltener/SSE-getrieben statt im 4s-Werte-Takt.
  async #refreshStructure() {
    try {
      const [instancesRes, hostsRes, graphRes] = await Promise.all([
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/graph"),
      ]);
      const instances: LauncherInstance[] = instancesRes.ok ? await instancesRes.json() : [];
      this.#hosts = hostsRes.ok ? await hostsRes.json() : [];
      const graphNodes: GraphNode[] = graphRes.ok ? (await graphRes.json()).nodes ?? [] : [];

      this.#nodeIdByInstance.clear();
      for (const gn of graphNodes) {
        if (gn.instanceId) this.#nodeIdByInstance.set(gn.instanceId, gn.id);
      }

      const liveIds = new Set(instances.map((i) => i.id));
      for (const id of [...this.#vocabCache.keys()]) {
        if (!liveIds.has(id)) this.#vocabCache.delete(id);
      }

      // Nur Instanzen prüfen, die bereits einen Graph-Node haben (NMOS-
      // Registrierung abgeschlossen) UND noch nicht klassifiziert wurden
      // — eine ganz frisch gestartete Instanz taucht kurzzeitig noch ohne
      // Graph-Node auf, der nächste #refreshStructure-Tick holt sie nach.
      const unknown = instances.filter((i) => !this.#vocabCache.has(i.id) && this.#nodeIdByInstance.has(i.id));
      await Promise.all(unknown.map((i) => this.#classify(i.id, this.#nodeIdByInstance.get(i.id)!)));
      this.#instances = instances;
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll/SSE-Refresh holt es auf.
    }
  }

  #instances: LauncherInstance[] = [];
  #nodeIdByInstance = new Map<string, string>();

  async #classify(instanceId: string, nodeId: string) {
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/descriptor`);
      if (!res.ok) {
        this.#vocabCache.set(instanceId, null);
        return;
      }
      const descriptor: Descriptor = await res.json();
      this.#vocabCache.set(
        instanceId,
        hasBcp008Monitor(descriptor) ? bcp008Vocabulary(isBcp008Sender(descriptor)) : null,
      );
    } catch {
      this.#vocabCache.set(instanceId, null);
    }
  }

  async #pollValues() {
    const candidates = this.#instances.filter((i) => this.#vocabCache.get(i.id) && this.#nodeIdByInstance.has(i.id));
    if (this.#destroyed) return;
    if (candidates.length === 0) {
      this.#render([], "empty");
      return;
    }

    const results = await Promise.all(candidates.map((inst) => this.#fetchNodeHealth(inst)));
    if (this.#destroyed) return;
    const healthy = results.filter((r): r is NodeHealth => r !== null);
    this.#render(healthy, "ready");
  }

  async #fetchNodeHealth(inst: LauncherInstance): Promise<NodeHealth | null> {
    const vocab = this.#vocabCache.get(inst.id);
    const nodeId = this.#nodeIdByInstance.get(inst.id);
    if (!vocab || !nodeId) return null;
    const names = bcp008ParamNames(vocab);
    const entries = await Promise.all(names.map(async (n) => [n, await this.#fetchParamValue(nodeId, n)] as const));
    const values = Object.fromEntries(entries) as Record<string, unknown>;
    // Ein zwischenzeitlich abgestürzter/entfernter Node liefert lauter
    // null-Werte (jeder einzelne apiFetch schlägt fehl) — dann lieber gar
    // keine Karte zeigen als eine komplett leere.
    if (values["monitor.overallStatus"] == null) return null;

    const hostLabel = inst.hostId ? this.#hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId : "lokal";

    return {
      nodeId,
      label: inst.label,
      type: inst.type,
      hostLabel,
      overallStatus: String(values["monitor.overallStatus"] ?? ""),
      overallMessage: values["monitor.overallStatusMessage"] ? String(values["monitor.overallStatusMessage"]) : undefined,
      syncSource: values["monitor.synchronizationSourceId"] ? String(values["monitor.synchronizationSourceId"]) : undefined,
      domains: [
        { label: "Link", status: String(values["monitor.linkStatus"] ?? ""), message: optStr(values["monitor.linkStatusMessage"]) },
        {
          label: "Sync",
          status: String(values["monitor.externalSynchronizationStatus"] ?? ""),
          message: optStr(values["monitor.externalSynchronizationStatusMessage"]),
        },
        {
          label: vocab.activityLabel,
          status: String(values[`monitor.${vocab.activityName}`] ?? ""),
          message: optStr(values[`monitor.${vocab.activityName}Message`]),
        },
        {
          label: vocab.contentLabel,
          status: String(values[`monitor.${vocab.contentName}`] ?? ""),
          message: optStr(values[`monitor.${vocab.contentName}Message`]),
        },
      ],
    };
  }

  async #fetchParamValue(nodeId: string, name: string): Promise<unknown> {
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/params/${name}`);
      if (res.ok) return (await res.json()).value;
    } catch {
      // Karte zeigt dann den letzten bekannten Stand bis zum nächsten Poll.
    }
    return null;
  }

  async #resetCounters(nodeId: string) {
    try {
      const res = await apiFetch(`/api/v1/nodes/${nodeId}/methods/monitor.resetCountersAndMessages`, {
        method: "POST",
      });
      if (res.ok) void this.#pollValues();
    } catch {
      // Best effort — kein eigener Toast-Kanal in dieser Ansicht (anders
      // als flow-canvas.ts), nächster Poll zeigt den unveränderten Stand.
    }
  }

  #render(nodes: NodeHealth[], phase: "loading" | "empty" | "ready") {
    const counts = new Map(OVERALL_BUCKETS.map((b) => [b.key, 0]));
    for (const n of nodes) {
      for (const b of OVERALL_BUCKETS) {
        if (b.match(n.overallStatus)) counts.set(b.key, (counts.get(b.key) ?? 0) + 1);
      }
    }

    const statTiles = OVERALL_BUCKETS.map(
      (b) => `
        <div class="omp-card" style="flex:1 1 120px;min-width:120px;text-align:center;border-top:3px solid ${bcp008StatusColor(
          b.key === "healthy" ? "Healthy" : b.key === "partial" ? "PartiallyHealthy" : b.key === "unhealthy" ? "Unhealthy" : "Inactive",
        )};">
          <div style="font-size:28px;font-weight:700;line-height:1.1;">${counts.get(b.key)}</div>
          <div style="color:var(--omp-text-dim);margin-top:4px;">${escapeHtml(b.label)}</div>
        </div>`,
    ).join("");

    const header = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:var(--omp-space-2);margin-bottom:var(--omp-space-3);">
        <div class="omp-h1">Health — AMWA BCP-008</div>
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${nodes.length} Node(s) mit BCP-008-Support · aktualisiert alle ${
          VALUES_POLL_INTERVAL_MS / 1000
        }s</div>
      </div>
      <div style="display:flex;gap:var(--omp-space-2);flex-wrap:wrap;margin-bottom:var(--omp-space-4);">${statTiles}</div>
    `;

    if (phase === "loading") {
      this.innerHTML = header + `<div class="omp-empty">Lädt…</div>`;
      return;
    }
    if (phase === "empty" || nodes.length === 0) {
      this.innerHTML =
        header +
        `<div class="omp-empty">Keine laufenden Instanzen mit BCP-008-Support gefunden. ` +
        `(2110-Gateway, DeckLink, AES67-Gateway, SRT-Gateway, Recorder, Viewer, Video-Mixer unterstützen BCP-008.)</div>`;
      return;
    }

    // Kritischster Zustand zuerst (Unhealthy > PartiallyHealthy > Inactive >
    // Healthy) — Operator soll ohne Suchen sehen, was zuerst Aufmerksamkeit
    // braucht, gleiches Prinzip wie alarm-view.ts' Severity-Sortierung.
    const severityRank: Record<string, number> = { Unhealthy: 0, PartiallyHealthy: 1, Inactive: 2, Healthy: 3 };
    const sorted = [...nodes].sort(
      (a, b) => (severityRank[a.overallStatus] ?? 1.5) - (severityRank[b.overallStatus] ?? 1.5),
    );

    const cards = sorted.map((n) => this.#renderCard(n)).join("");

    this.innerHTML = header + `<div class="omp-card-grid">${cards}</div>`;

    for (const n of nodes) {
      const btn = this.querySelector<HTMLButtonElement>(`[data-reset-node="${cssEscape(n.nodeId)}"]`);
      btn?.addEventListener("click", () => this.#resetCounters(n.nodeId));
    }
  }

  #renderCard(n: NodeHealth): string {
    const pulse = n.overallStatus === "Unhealthy" ? "animation:omp-pulse 2s ease-in-out infinite;" : "";
    const domainRows = n.domains
      .map(
        (d) => `
        <div style="display:flex;align-items:center;gap:5px;" title="${escapeHtml(d.message ?? "")}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${bcp008StatusColor(
            d.status,
          )};"></span>
          <span>${escapeHtml(d.label)}: ${escapeHtml(d.status || "–")}</span>
        </div>`,
      )
      .join("");

    return `
      <div class="omp-card" style="border-left:3px solid ${bcp008StatusColor(n.overallStatus)};">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--omp-space-2);">
          <div>
            <div style="font-weight:600;">${escapeHtml(n.label)}</div>
            <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:2px;">
              <span class="omp-badge">${escapeHtml(n.type)}</span>
              ${n.hostLabel !== "lokal" ? `<span class="omp-badge" style="margin-left:4px;">${escapeHtml(n.hostLabel)}</span>` : ""}
            </div>
          </div>
          <button data-reset-node="${escapeHtml(n.nodeId)}" title="Zähler/Meldungen dieses Nodes zurücksetzen" style="font-size:var(--omp-font-size-xs);flex-shrink:0;">↺ Reset</button>
        </div>

        <div style="display:flex;align-items:center;gap:6px;margin:var(--omp-space-2) 0 6px 0;font-weight:600;">
          <span style="display:inline-block;width:11px;height:11px;border-radius:50%;flex-shrink:0;background:${bcp008StatusColor(
            n.overallStatus,
          )};${pulse}"></span>
          <span>${escapeHtml(n.overallStatus || "–")}</span>
        </div>
        ${n.overallMessage ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:6px;">${escapeHtml(n.overallMessage)}</div>` : ""}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;font-size:var(--omp-font-size-xs);">
          ${domainRows}
        </div>
        ${n.syncSource ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:6px;">Sync-Quelle: ${escapeHtml(n.syncSource)}</div>` : ""}
      </div>`;
  }
}

function optStr(v: unknown): string | undefined {
  return v ? String(v) : undefined;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Node-IDs sind Hex-Strings (s. launcher_handlers.go newID) — kein
// CSS.escape()-Polyfill nötig, aber defensiv für den Fall, dass ein
// Fremd-Node-Typ (Katalog-Import, §17) je ein anderes ID-Format nutzt.
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

customElements.define("omp-health-view", HealthView);
