// <omp-host-software> — „welcher Host läuft mit welcher Version“ (Kap. 85): je Host Build-Stempel des Agents und der
// Node-Typen mit Version, Commit und laufenden Instanzen. Eigenes Element, damit es das Neuzeichnen der Host-Tabelle überlebt.
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import { buildLabel, deviates, hostSummary, mixedVersions, nodeVersion, shortTime, type SwHost, type SwReport } from "./host-software-logic.ts";

const REFRESH_MS = 30_000;

export class HostSoftware extends HTMLElement {
  #report: SwReport | null = null;
  #error = "";
  #loading = false;
  #timer: number | undefined;
  #open = new Set<string>();

  connectedCallback() {
    void this.load(false);
    this.#timer = window.setInterval(() => void this.load(false), REFRESH_MS);
  }

  disconnectedCallback() {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  async load(force: boolean) {
    this.#loading = true;
    this.#paint();
    try {
      const res = await apiFetch(`/api/v1/hosts/software${force ? "?refresh=1" : ""}`);
      if (res.ok) {
        this.#report = (await res.json()) as SwReport;
        this.#error = "";
      } else {
        this.#error = await res.text();
      }
    } catch (e) {
      this.#error = String(e);
    }
    this.#loading = false;
    this.#paint();
  }

  #paint() {
    const root = document.createElement("div");
    root.dataset.role = "host-software";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-3);margin-bottom:var(--omp-space-2);";
    const title = document.createElement("div");
    title.className = "omp-h1";
    title.textContent = t("hostsw.title");
    const refresh = document.createElement("button");
    refresh.textContent = this.#loading ? t("hostsw.loading") : t("hostsw.refresh");
    refresh.disabled = this.#loading;
    refresh.dataset.role = "hostsw-refresh";
    refresh.addEventListener("click", () => void this.load(true));
    head.append(title, refresh);
    root.appendChild(head);

    if (this.#error) {
      const err = document.createElement("div");
      err.style.cssText = "color:var(--omp-error);font-size:var(--omp-font-size-xs);";
      err.textContent = this.#error;
      root.appendChild(err);
    }

    const rep = this.#report;
    if (rep) {
      const mixed = mixedVersions(rep.hosts);
      if (mixed.size > 0) {
        const warn = document.createElement("div");
        warn.dataset.role = "hostsw-mixed";
        warn.style.cssText = "color:#d9a21b;font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
        warn.textContent = t("hostsw.mixed", { p0: [...mixed.keys()].join(", ") });
        root.appendChild(warn);
      }
      for (const h of rep.hosts) root.appendChild(this.#host(h, rep));
    }
    this.replaceChildren(root);
  }

  #host(h: SwHost, rep: SwReport): HTMLElement {
    const det = document.createElement("details");
    det.dataset.hostId = h.hostId || "local";
    det.style.cssText = "border:1px solid var(--omp-border,#333);border-radius:var(--omp-radius);padding:var(--omp-space-2);margin-bottom:var(--omp-space-2);";
    const key = h.hostId || "local";
    det.open = this.#open.has(key);
    det.addEventListener("toggle", () => {
      if (det.open) this.#open.add(key);
      else this.#open.delete(key);
    });

    const sum = document.createElement("summary");
    sum.style.cssText = "cursor:pointer;display:flex;gap:var(--omp-space-3);align-items:center;flex-wrap:wrap;";
    const dot = document.createElement("span");
    dot.textContent = "●";
    dot.style.color = h.online ? "#4caf50" : "#e05252";
    const name = document.createElement("strong");
    name.textContent = h.local ? t("hostsw.localName", { p0: h.label }) : h.label;
    const agent = document.createElement("span");
    agent.dataset.role = "agent-build";
    agent.style.cssText = "font-family:var(--omp-font-mono);font-size:var(--omp-font-size-xs);";
    agent.textContent = h.agent ? `${h.local ? t("hostsw.orch") : t("hostsw.agent")} ${buildLabel(h.agent)}` : "";
    agent.title = h.agent?.builtAt ? t("hostsw.builtAt", { p0: shortTime(h.agent.builtAt) }) : "";
    sum.append(dot, name, agent);
    if (!h.local && deviates(h.agent, rep.orchestrator)) {
      const b = document.createElement("span");
      b.dataset.role = "deviates";
      b.className = "omp-badge";
      b.style.color = "#d9a21b";
      b.textContent = t("hostsw.deviates");
      b.title = t("hostsw.deviatesTitle", { p0: buildLabel(rep.orchestrator) });
      sum.appendChild(b);
    }
    const s = hostSummary(h);
    const meta = document.createElement("span");
    meta.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    meta.textContent = h.error ? h.error : t("hostsw.summary", { p0: s.types, p1: s.running });
    sum.appendChild(meta);
    if (s.outdated > 0) {
      const o = document.createElement("span");
      o.className = "omp-badge";
      o.style.color = "#d9a21b";
      o.textContent = t("hostsw.outdated", { p0: s.outdated });
      sum.appendChild(o);
    }
    det.appendChild(sum);

    if (h.nodes.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;margin-top:var(--omp-space-2);font-size:var(--omp-font-size-xs);";
      const th = document.createElement("tr");
      th.style.cssText = "color:var(--omp-text-dim);text-align:left;";
      for (const c of ["hostsw.col.type", "hostsw.col.version", "hostsw.col.commit", "hostsw.col.built", "hostsw.col.running"] as const) {
        const cell = document.createElement("th");
        cell.style.padding = "2px 10px";
        cell.textContent = t(c);
        th.appendChild(cell);
      }
      table.appendChild(th);
      // laufende Typen zuerst, dann nach Name
      const nodes = [...h.nodes].sort((a, b) => (b.running > 0 ? 1 : 0) - (a.running > 0 ? 1 : 0) || a.type.localeCompare(b.type));
      for (const n of nodes) {
        const tr = document.createElement("tr");
        tr.dataset.type = n.type;
        const cells = [
          n.type + (n.runner === "podman" ? " 🐳" : ""),
          nodeVersion(n),
          n.commit ?? "",
          shortTime(n.builtAt) || shortTime(n.modified),
          n.running > 0 ? String(n.running) + (n.outdated ? ` (${t("hostsw.outdatedShort", { p0: n.outdated })})` : "") : "",
        ];
        cells.forEach((text, i) => {
          const td = document.createElement("td");
          td.style.cssText = `padding:2px 10px;${i === 1 || i === 2 ? "font-family:var(--omp-font-mono);" : ""}${i === 1 && text === "–" ? "color:var(--omp-text-dim);" : ""}`;
          td.textContent = text;
          if (i === 1 && n.error) td.title = n.error;
          if (i === 3 && !n.builtAt && n.modified) {
            td.title = t("hostsw.fileTime");
            td.style.color = "var(--omp-text-dim)";
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      }
      det.appendChild(table);
    }
    return det;
  }
}

customElements.define("omp-host-software", HostSoftware);
