// <omp-hosts-view> — minimale Host-Liste (ARCHITECTURE.md §18.7:
// "Sichtbarkeit im UI"; UMSETZUNG.md D6 Teil 1). Bewusst kein Teil des
// größeren Engineering-Dashboards (§17.2, noch nicht gebaut) — ein
// eigenständiges, per Knopf ein-/ausblendbares Panel (s. shell.ts),
// reiner Poll gegen GET /api/v1/hosts (kein SSE-Sonderfall nötig, die
// paar Sekunden Verzögerung sind für eine Host-Übersicht unkritisch).
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

const POLL_INTERVAL_MS = 4000;

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

class HostsView extends HTMLElement {
  #pollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:#1c1c1c;border:1px solid #333;border-radius:6px;" +
      "padding:10px;font-family:sans-serif;font-size:12px;color:#ddd;max-width:640px;";
    this.#render([]);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
  }

  async #poll() {
    try {
      const res = await fetch("/api/v1/hosts");
      if (!res.ok) return;
      const hosts = (await res.json()) as HostEntry[];
      this.#render(hosts);
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  #render(hosts: HostEntry[]) {
    const rows = hosts
      .map((h) => {
        const m = h.metrics;
        const cpu = m ? `${m.cpuPercent.toFixed(0)}%` : "–";
        const mem = m ? `${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)}` : "–";
        const seen = m ? new Date(m.receivedAt).toLocaleTimeString() : "nie";
        return `<tr>
          <td style="padding:2px 8px;">${escapeHtml(h.label)}</td>
          <td style="padding:2px 8px;color:#999;">${escapeHtml(h.hostname)}</td>
          <td style="padding:2px 8px;">${cpu}</td>
          <td style="padding:2px 8px;">${mem}</td>
          <td style="padding:2px 8px;color:#999;">${seen}</td>
        </tr>`;
      })
      .join("");

    this.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">Hosts (${hosts.length})</div>
      ${
        hosts.length === 0
          ? `<div style="color:#999;">Noch kein Host registriert.</div>`
          : `<table style="border-collapse:collapse;width:100%;">
              <thead><tr style="color:#999;text-align:left;">
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
