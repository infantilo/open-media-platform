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
import { apiFetch, connectionMonitor } from "./connection.ts";

interface HostMetrics {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  receivedAt: string;
}

interface HostEntry {
  id: string;
  label: string;
  hostname: string;
  registeredAt: string;
  metrics?: HostMetrics;
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

const POLL_FALLBACK_INTERVAL_MS = 30000;

const HOST_METRICS_SUBJECT_PREFIX = "omp.host.";
const HOST_METRICS_SUBJECT_SUFFIX = ".metrics";

function isRefreshEvent(type: string): boolean {
  if (type === "host.registered" || type === "placement.advice" || type === "lost-events") return true;
  return type.startsWith(HOST_METRICS_SUBJECT_PREFIX) && type.endsWith(HOST_METRICS_SUBJECT_SUFFIX);
}

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

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

class HostsView extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([], []);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
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
      const [hostsRes, adviceRes] = await Promise.all([
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/placement/advice"),
      ]);
      if (!hostsRes.ok) return;
      const hosts = (await hostsRes.json()) as HostEntry[];
      const advice = adviceRes.ok ? ((await adviceRes.json()) as PlacementAdvice[]) : [];
      this.#render(hosts, advice);
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render(hosts: HostEntry[], advice: PlacementAdvice[]) {
    const rows = hosts
      .map((h) => {
        const m = h.metrics;
        const cpu = m ? `${m.cpuPercent.toFixed(0)}%` : "–";
        const mem = m ? `${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)}` : "–";
        const seen = m ? new Date(m.receivedAt).toLocaleTimeString() : "nie";
        return `<tr>
          <td style="padding:2px 8px;">${escapeHtml(h.label)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(h.hostname)}</td>
          <td style="padding:2px 8px;">${cpu}</td>
          <td style="padding:2px 8px;">${mem}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${seen}</td>
        </tr>`;
      })
      .join("");

    const adviceBanner = advice
      .map((a) => {
        const target = a.suggestedHostId
          ? `Vorschlag: <strong>${escapeHtml(a.suggestedHostLabel ?? a.suggestedHostId)}</strong>`
          : `<span style="color:var(--omp-cue);">kein Ausweichhost frei</span>`;
        return `<div style="padding:var(--omp-space-2);margin-bottom:var(--omp-space-1);background:rgba(239,83,80,0.15);border:1px solid var(--omp-error);border-radius:var(--omp-radius);">
          <strong>${escapeHtml(a.hostLabel)}</strong> überlastet (Grund: ${reasonLabel(a.reason)}, CPU ${a.cpuPercent.toFixed(0)}% / RAM ${a.memPercent.toFixed(0)}%),
          ${a.instanceIds.length} Instanz(en) betroffen — ${target}
        </div>`;
      })
      .join("");

    this.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">Hosts (${hosts.length})</div>
      ${adviceBanner}
      ${
        hosts.length === 0
          ? `<div style="color:var(--omp-text-dim);">Noch kein Host registriert.</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:var(--omp-text-dim);text-align:left;">
                <th style="padding:2px 8px;">Label</th>
                <th style="padding:2px 8px;">Hostname</th>
                <th style="padding:2px 8px;">CPU</th>
                <th style="padding:2px 8px;">RAM</th>
                <th style="padding:2px 8px;">Zuletzt gesehen</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
      }
    `;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-hosts-view", HostsView);
