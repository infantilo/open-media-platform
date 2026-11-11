// Admin → Verbundene Clients: wer hat gerade einen Browser mit der Oberfläche offen
// (Event-Streams des Orchestrators), mit Benutzer, Adresse und Verbindungsdauer.
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";

const REFRESH_MS = 5_000;

interface ClientRow {
  user: string;
  remoteIp: string;
  userAgent: string;
  since: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function duration(since: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.floor((s % 3600) / 60)} min`;
}

export class ClientsPanel {
  readonly el: HTMLElement;
  #summary = el("div", "margin:4px 0 12px;color:var(--omp-text-dim);");
  #body = el("div");
  #timer: number | undefined;
  #seq = 0;

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:900px;");
    const title = el("span", "", t("clients.title"));
    title.className = "omp-h1";
    this.el.append(title, this.#summary, this.#body);
  }

  start() {
    void this.refresh();
    if (this.#timer !== undefined) return;
    this.#timer = window.setInterval(() => {
      if (!this.el.isConnected) {
        window.clearInterval(this.#timer);
        this.#timer = undefined;
        return;
      }
      void this.refresh();
    }, REFRESH_MS);
  }

  async refresh() {
    const seq = ++this.#seq;
    try {
      const res = await apiFetch("/api/v1/admin/clients");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { total: number; clients: ClientRow[] };
      if (seq !== this.#seq) return;
      this.#render(data.clients ?? []);
    } catch {
      if (seq !== this.#seq) return;
      this.#summary.textContent = t("clients.error");
    }
  }

  #render(rows: ClientRow[]) {
    const users = new Set(rows.map((r) => r.user).filter(Boolean));
    this.#summary.textContent = t("clients.summary", { total: String(rows.length), users: String(users.size) });
    this.#body.replaceChildren();
    if (rows.length === 0) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", t("clients.none")));
      return;
    }
    const table = el("table", "border-collapse:collapse;width:100%;");
    const head = el("tr");
    for (const k of ["clients.col.user", "clients.col.ip", "clients.col.since", "clients.col.agent"] as const) {
      head.append(el("th", "text-align:left;padding:4px 8px;border-bottom:1px solid var(--omp-border);", t(k)));
    }
    table.append(head);
    for (const r of rows) {
      const tr = el("tr");
      const cell = (txt: string, title = "") => {
        const td = el("td", "padding:4px 8px;border-bottom:1px solid var(--omp-border);", txt);
        if (title) td.title = title;
        return td;
      };
      tr.append(
        cell(r.user || "–"),
        cell(r.remoteIp),
        cell(duration(r.since), new Date(r.since).toLocaleString()),
        cell(r.userAgent.length > 60 ? r.userAgent.slice(0, 60) + "…" : r.userAgent, r.userAgent),
      );
      table.append(tr);
    }
    this.#body.append(table);
  }
}
