// <omp-instances-view> — "Laufende Instanzen"-Tab (docs/END-GOAL-
// FEATURES.md §17.3b/§17.4 Teil 2, 2026-07-19): zentrale Übersicht aller
// laufenden Node-Instanzen mit Status, Kapitel-14-Ressourcenwerten
// (CPU%/RSS, Kapitel 14 Teil 2) und Crash-/Restart-Zähler (K7-Teil-1).
// Bewusst **keine neue Backend-Logik** (§17.4: "baut direkt auf
// Kapitel-14-Datenmodell") — reiner Konsument von GET /api/v1/instances
// (liefert bereits alles: crashed/crashMessage/restartCount seit
// K7-Teil-1, cpuPercent/rssBytes seit Kapitel 14 Teil 2) und GET
// /api/v1/hosts (nur für die hostId→Label-Auflösung, gleiches Muster wie
// flow-canvas.ts#renderInstanceRow).
//
// Poll-Intervall bewusst kürzer als bei den übrigen SSE-first-Views
// (hosts-view.ts/alarm-view.ts: 30s-Fallback, SSE trägt den Regelfall):
// es gibt kein SSE-Event für "CPU%/RSS haben sich geändert" (die Werte
// ändern sich mit jedem 5s-Sample-Tick des Launchers/Host-Agents, s.
// docs/decisions.md Nachtrag 32) — eine als "live" beworbene
// Ressourcen-Ansicht muss deshalb selbst im Sample-Takt pollen, SSE
// deckt hier nur den Status-Sprung (Crash/Neustart) zusätzlich ab.
import { apiFetch, connectionMonitor } from "./connection.ts";

// Wire-Format identisch zu launcher.Instance (orchestrator/internal/
// launcher/launcher.go) — eigene, lokale Deklaration statt eines
// Imports aus ui/graph/flow-canvas.ts, gleiches Muster wie
// alarm-view.ts's eigene (dort schmalere) Kopie.
interface LauncherInstance {
  id: string;
  type: string;
  label: string;
  pid: number;
  hostId?: string;
  crashed?: boolean;
  crashMessage?: string;
  restartCount?: number;
  cpuPercent?: number;
  rssBytes?: number;
}

interface HostEntry {
  id: string;
  label: string;
}

const POLL_INTERVAL_MS = 5000;

const REFRESH_EVENT_TYPES = new Set(["instance.crashed", "instance.restarted", "lost-events"]);

function formatCpu(cpuPercent: number | undefined): string {
  if (cpuPercent === undefined) return `<span style="color:var(--omp-text-dim);">–</span>`;
  return `${cpuPercent.toFixed(0)}%`;
}

function formatRss(rssBytes: number | undefined): string {
  if (rssBytes === undefined) return `<span style="color:var(--omp-text-dim);">–</span>`;
  return `${(rssBytes / 1024 / 1024).toFixed(0)} MB`;
}

class InstancesView extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render([], []);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
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
    if (REFRESH_EVENT_TYPES.has(parsed.type)) this.#poll();
  };

  async #poll() {
    try {
      const [instancesRes, hostsRes] = await Promise.all([
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
      ]);
      const instances = instancesRes.ok ? ((await instancesRes.json()) as LauncherInstance[]) : [];
      const hosts = hostsRes.ok ? ((await hostsRes.json()) as HostEntry[]) : [];
      this.#render(instances, hosts);
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render(instances: LauncherInstance[], hosts: HostEntry[]) {
    // launcher.Launcher.List() iteriert eine Go-Map (keine Reihenfolge-
    // Garantie) — ohne eigene Sortierung würden Zeilen bei jedem Poll
    // scheinbar zufällig die Plätze tauschen. Label, dann ID als
    // Tie-Breaker, für eine über Polls hinweg stabile Reihenfolge.
    const sorted = [...instances].sort(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );

    const rows = sorted
      .map((inst) => {
        const hostLabel = inst.hostId ? hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId : "lokal";
        const status = inst.crashed
          ? `<span style="color:var(--omp-error);">Abgestürzt</span>`
          : `<span style="color:var(--omp-preset);">Läuft</span>`;
        const restarts =
          inst.restartCount ? `↻ ${inst.restartCount}×` : `<span style="color:var(--omp-text-dim);">–</span>`;
        const crashLine = inst.crashed
          ? `<div style="color:var(--omp-error);font-size:var(--omp-font-size-xs);white-space:pre-wrap;word-break:break-word;">${escapeHtml(inst.crashMessage || "Prozess abgestürzt")}</div>`
          : "";
        return `<tr>
          <td style="padding:2px 8px;">${escapeHtml(inst.label)}<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${escapeHtml(inst.type)}</div>${crashLine}</td>
          <td style="padding:2px 8px;">${status}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(hostLabel)}</td>
          <td style="padding:2px 8px;">${formatCpu(inst.cpuPercent)}</td>
          <td style="padding:2px 8px;">${formatRss(inst.rssBytes)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${inst.pid}</td>
          <td style="padding:2px 8px;">${restarts}</td>
        </tr>`;
      })
      .join("");

    this.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">Laufende Instanzen (${instances.length})</div>
      ${
        instances.length === 0
          ? `<div style="color:var(--omp-text-dim);">Keine Instanz läuft.</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:var(--omp-text-dim);text-align:left;">
                <th style="padding:2px 8px;">Instanz</th>
                <th style="padding:2px 8px;">Status</th>
                <th style="padding:2px 8px;">Host</th>
                <th style="padding:2px 8px;">CPU</th>
                <th style="padding:2px 8px;">RAM</th>
                <th style="padding:2px 8px;">PID</th>
                <th style="padding:2px 8px;">Neustarts</th>
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

customElements.define("omp-instances-view", InstancesView);
