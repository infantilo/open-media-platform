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
import { t } from "./i18n.ts";
import { apiFetch, connectionMonitor } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";

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
  #owners = new Map<string, string>();
  #hosts: HostEntry[] = [];
  // Zeile im Umbenennen-/Verschieben-Modus: solange gesetzt, rendert der Poll nicht neu
  // (sonst würde die Eingabe alle 5 s verworfen).
  #editing: { id: string; mode: "rename" | "migrate" } | null = null;

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
    this.addEventListener("keydown", this.#onKeyDown);
    this.#render([], []);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  #onHeaderClick = (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("button[data-action]");
    if (btn) {
      void this.#onAction(btn.dataset.action!, btn.dataset.id!);
      return;
    }
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

  async #onAction(action: string, id: string) {
    const inst = this.#instances.find((i) => i.id === id);
    if (action === "rename" || action === "migrate") {
      this.#editing = { id, mode: action };
      this.querySelector("[data-edit]")?.remove();
      this.#render(this.#instances, this.#hosts);
      this.querySelector<HTMLElement>("[data-edit]")?.focus();
      return;
    }
    if (action === "restart") {
      if (!inst) return;
      if (!(await confirmDialog(t("inst.confirmRestart", { p0: inst.label }), { confirmLabel: t("inst.confirmRestartLabel") }))) return;
      try {
        const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(id)}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        });
        if (!res.ok) {
          showToast(t("inst.restartFailed", { p0: (await res.text()) || res.status }));
          return;
        }
        showToast(t("inst.restarted", { p0: inst.label }), { variant: "info" });
      } catch (err) {
        showToast(t("inst.restartFailed", { p0: String(err) }));
        return;
      }
      this.#poll();
      return;
    }
    if (action === "cancel") {
      this.#editing = null;
      this.#render(this.#instances, this.#hosts);
      return;
    }
    const field = this.querySelector<HTMLInputElement | HTMLSelectElement>("[data-edit]");
    if (!inst || !field) return;
    if (action === "save-rename") {
      const label = field.value.trim();
      if (!label) return;
      try {
        const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        if (!res.ok) {
          showToast(t("inst.renameFailed", { p0: (await res.text()) || res.status }));
          return;
        }
        const out = (await res.json()) as { applied?: boolean };
        if (out.applied === false) showToast(t("inst.renameNotApplied"), { variant: "info", durationMs: 8000 });
      } catch (err) {
        showToast(t("inst.renameFailed", { p0: String(err) }));
        return;
      }
    } else if (action === "save-migrate") {
      const target = field.value;
      const targetLabel = target ? this.#hosts.find((h) => h.id === target)?.label || target : t("inst.localHost");
      if (!(await confirmDialog(t("inst.confirmMigrate", { p0: inst.label, p1: targetLabel }), { confirmLabel: t("inst.confirmMigrateLabel") }))) return;
      try {
        const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(id)}/migrate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetHostId: target }),
        });
        if (!res.ok) {
          showToast(t("inst.migrateFailed", { p0: (await res.text()) || res.status }));
          return;
        }
      } catch (err) {
        showToast(t("inst.migrateFailed", { p0: String(err) }));
        return;
      }
    } else {
      return;
    }
    this.#editing = null;
    this.#poll();
  }

  #onKeyDown = (ev: KeyboardEvent) => {
    if (!this.#editing || !(ev.target as HTMLElement).matches?.("[data-edit]")) return;
    if (ev.key === "Escape") void this.#onAction("cancel", this.#editing.id);
    else if (ev.key === "Enter") void this.#onAction(this.#editing.mode === "rename" ? "save-rename" : "save-migrate", this.#editing.id);
  };

  disconnectedCallback() {
    this.removeEventListener("click", this.#onHeaderClick);
    this.removeEventListener("keydown", this.#onKeyDown);
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
      const [instancesRes, hostsRes, workflowsRes] = await Promise.all([
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/workflows"),
      ]);
      // Instanz-ID → „Workflow · Rolle“ aus den Laufzeitdaten laufender Workflows.
      const owners = new Map<string, string>();
      const workflows = workflowsRes.ok
        ? ((await workflowsRes.json()) as { name: string; runtime?: Record<string, { instanceId: string }> }[])
        : [];
      for (const wf of workflows) {
        for (const [role, rt] of Object.entries(wf.runtime ?? {})) {
          if (rt?.instanceId) owners.set(rt.instanceId, `${wf.name} · ${role}`);
        }
      }
      this.#owners = owners;
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
    // Offenes Eingabefeld nicht durch den Poll wegrendern (Daten oben sind bereits aktualisiert).
    if (this.#editing && this.querySelector("[data-edit]")) return;
    // launcher.Launcher.List() iteriert eine Go-Map (keine Reihenfolge-
    // Garantie) — ohne eigene, stabile Sortierung (Spaltenwahl, Label/ID als
    // Tie-Breaker) würden Zeilen bei jedem Poll die Plätze tauschen.
    const hostName = (i: LauncherInstance) => (i.hostId ? hosts.find((h) => h.id === i.hostId)?.label || i.hostId : "lokal");
    const sorted = sortInstances(instances, this.#sortKey, this.#sortDir, hostName);
    const th = (key: InstanceSortKey, text: string) => {
      const active = key === this.#sortKey;
      const arrow = active ? (this.#sortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th data-sort="${key}" aria-sort="${active ? (this.#sortDir === "asc" ? "ascending" : "descending") : "none"}" title="${t("inst.9e4506", { p0: text })}" style="padding:2px 8px;cursor:pointer;user-select:none;${active ? "color:var(--omp-text);" : ""}">${text}${arrow}</th>`;
    };

    const rows = sorted
      .map((inst) => {
        const editRename = this.#editing?.id === inst.id && this.#editing.mode === "rename";
        const editMigrate = this.#editing?.id === inst.id && this.#editing.mode === "migrate";
        const hostLabel = inst.hostId ? hosts.find((h) => h.id === inst.hostId)?.label || inst.hostId : "lokal";
        const status = inst.crashed
          ? `<span class="omp-badge omp-badge-error">${t("inst.aba7a7")}</span>`
          : `<span class="omp-badge omp-badge-running">${t("inst.d4a100")}</span>` +
            (inst.outdated
              ? ` <span class="omp-badge" title="${t("inst.f9ab8e")}">${t("inst.2b4695")}</span>`
              : "");
        const restarts =
          inst.restartCount ? `↻ ${inst.restartCount}×` : `<span style="color:var(--omp-text-dim);">–</span>`;
        const crashLine = inst.crashed
          ? `<div style="color:var(--omp-error);font-size:var(--omp-font-size-xs);white-space:pre-wrap;word-break:break-word;">${escapeHtml(inst.crashMessage || t("inst.03a35d"))}</div>`
          : "";
        return `<tr>
          <td style="padding:2px 8px;">${
            editRename
              ? `<input data-edit value="${escapeAttr(inst.label)}" style="width:100%;box-sizing:border-box;" /><div style="margin-top:2px;"><button data-action="save-rename" data-id="${escapeAttr(inst.id)}">${t("inst.save")}</button> <button data-action="cancel" data-id="${escapeAttr(inst.id)}">${t("inst.cancel")}</button></div>`
              : escapeHtml(inst.label)
          }<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${escapeHtml(inst.type)}${inst.version ? ` (${escapeHtml(inst.version)})` : ""}</div>${crashLine}</td>
          <td style="padding:2px 8px;">${status}</td>
          <td style="padding:2px 8px;">${this.#owners.has(inst.id) ? escapeHtml(this.#owners.get(inst.id)!) : `<span style="color:var(--omp-text-dim);" title="${t("inst.93e356")}">–</span>`}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${
            editMigrate
              ? `<select data-edit><option value="">${t("inst.localHost")}</option>${hosts.map((h) => `<option value="${escapeAttr(h.id)}"${h.id === inst.hostId ? " selected" : ""}>${escapeHtml(h.label || h.id)}</option>`).join("")}</select><div style="margin-top:2px;"><button data-action="save-migrate" data-id="${escapeAttr(inst.id)}">${t("inst.migrate").replace(" …", "")}</button> <button data-action="cancel" data-id="${escapeAttr(inst.id)}">${t("inst.cancel")}</button></div>`
              : escapeHtml(hostLabel)
          }</td>
          <td style="padding:2px 8px;">${formatCpu(inst.cpuPercent)}</td>
          <td style="padding:2px 8px;">${formatRss(inst.rssBytes)}</td>
          <td style="padding:2px 8px;color:var(--omp-text-dim);">${inst.pid}</td>
          <td style="padding:2px 8px;">${restarts}</td>
          <td style="padding:2px 8px;white-space:nowrap;"><button data-action="rename" data-id="${escapeAttr(inst.id)}" title="${t("inst.renameTitle")}">${t("inst.rename")}</button> <button data-action="restart" data-id="${escapeAttr(inst.id)}" title="${t("inst.restartTitle")}">${t("inst.restart")}</button> <button data-action="migrate" data-id="${escapeAttr(inst.id)}" title="${t("inst.migrateTitle")}">${t("inst.migrate")}</button></td>
        </tr>`;
      })
      .join("");

    this.innerHTML = `
      <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">${t("inst.bedfb0", { p0: instances.length })}</div>
      ${
        instances.length === 0
          ? `<div class="omp-empty">${t("inst.3e3d94")}</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:var(--omp-text-dim);text-align:left;">
                ${th("label", t("inst.50c3a7"))}
                ${th("status", t("inst.ec53a8"))}
                <th style="padding:2px 8px;">${t("inst.24f47c")}</th>
                ${th("host", t("inst.c2ca16"))}
                ${th("cpu", "CPU")}
                ${th("ram", "RAM")}
                ${th("pid", "PID")}
                ${th("restarts", t("inst.974607"))}
                <th style="padding:2px 8px;">${t("inst.actions")}</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
      }
    `;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-instances-view", InstancesView);
