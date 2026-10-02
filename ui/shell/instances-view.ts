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
  // Binary seit dem Prozessstart ersetzt (System-Update) — läuft mit altem Stand.
  outdated?: boolean;
  crashMessage?: string;
  restartCount?: number;
  cpuPercent?: number;
  rssBytes?: number;
  // version (§17 Teil 5, docs/END-GOAL-FEATURES.md §17.4 Teil 5) — leer
  // für statische/unversionierte Typen.
  version?: string;
}

interface HostEntry {
  id: string;
  label: string;
}

import { defaultDir, type InstanceSortKey, type SortDir, sortInstances } from "./instances-logic.ts";

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

const SORT_STORAGE_KEY = "omp-instances-sort";
const SORT_KEYS: InstanceSortKey[] = ["label", "status", "host", "cpu", "ram", "pid", "restarts"];

class InstancesView extends HTMLElement {
  #pollHandle: number | undefined;
  // Sortierung überlebt Polls und (best effort) einen Neuladen der Seite.
  #sortKey: InstanceSortKey = "label";
  #sortDir: SortDir = "asc";
  #instances: LauncherInstance[] = [];
  #hosts: HostEntry[] = [];

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? "null");
      if (saved && SORT_KEYS.includes(saved.key) && (saved.dir === "asc" || saved.dir === "desc")) {
        this.#sortKey = saved.key;
        this.#sortDir = saved.dir;
      }
    } catch {
      // kein localStorage — Standardsortierung
    }
    this.addEventListener("click", this.#onHeaderClick);
    this.#render([], []);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  #onHeaderClick = (ev: Event) => {
    const th = (ev.target as HTMLElement).closest<HTMLElement>("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort as InstanceSortKey;
    if (key === this.#sortKey) {
      this.#sortDir = this.#sortDir === "asc" ? "desc" : "asc";
    } else {
      this.#sortKey = key;
      this.#sortDir = defaultDir(key);
    }
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ key: this.#sortKey, dir: this.#sortDir }));
    } catch {
      // nur eine Komfortfunktion
    }
    this.#render(this.#instances, this.#hosts);
  };

  disconnectedCallback() {
    this.removeEventListener("click", this.#onHeaderClick);
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
    this.#instances = instances;
    this.#hosts = hosts;
    // launcher.Launcher.List() iteriert eine Go-Map (keine Reihenfolge-
    // Garantie) — ohne eigene, stabile Sortierung (Spaltenwahl, Label/ID als
    // Tie-Breaker) würden Zeilen bei jedem Poll die Plätze tauschen.
    const hostName = (i: LauncherInstance) => (i.hostId ? hosts.find((h) => h.id === i.hostId)?.label || i.hostId : "lokal");
    const sorted = sortInstances(instances, this.#sortKey, this.#sortDir, hostName);
    const th = (key: InstanceSortKey, text: string) => {
      const active = key === this.#sortKey;
      const arrow = active ? (this.#sortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th data-sort="${key}" aria-sort="${active ? (this.#sortDir === "asc" ? "ascending" : "descending") : "none"}" title="Nach ${text} sortieren" style="padding:2px 8px;cursor:pointer;user-select:none;${active ? "color:var(--omp-text);" : ""}">${text}${arrow}</th>`;
    };

    const rows = sorted
      .map((inst) => {
        const hostLabel = inst.hostId ? hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId : "lokal";
        const status = inst.crashed
          ? `<span class="omp-badge omp-badge-error">Abgestürzt</span>`
          : `<span class="omp-badge omp-badge-running">Läuft</span>` +
            (inst.outdated
              ? ` <span class="omp-badge" title="Das Programm wurde durch ein Update ersetzt; diese Instanz läuft noch mit dem alten Stand bis zum nächsten Neustart.">veraltet</span>`
              : "");
        const restarts =
          inst.restartCount ? `↻ ${inst.restartCount}×` : `<span style="color:var(--omp-text-dim);">–</span>`;
        const crashLine = inst.crashed
          ? `<div style="color:var(--omp-error);font-size:var(--omp-font-size-xs);white-space:pre-wrap;word-break:break-word;">${escapeHtml(inst.crashMessage || "Prozess abgestürzt")}</div>`
          : "";
        return `<tr>
          <td style="padding:2px 8px;">${escapeHtml(inst.label)}<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${escapeHtml(inst.type)}${inst.version ? ` (${escapeHtml(inst.version)})` : ""}</div>${crashLine}</td>
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
      <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">Laufende Instanzen (${instances.length})</div>
      ${
        instances.length === 0
          ? `<div class="omp-empty">Keine Instanz läuft.</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:var(--omp-text-dim);text-align:left;">
                ${th("label", "Instanz")}
                ${th("status", "Status")}
                ${th("host", "Host")}
                ${th("cpu", "CPU")}
                ${th("ram", "RAM")}
                ${th("pid", "PID")}
                ${th("restarts", "Neustarts")}
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
