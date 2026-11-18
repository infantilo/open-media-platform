// Admin → MXL-Flows: die Flows der lokalen MXL-Domain mit Schreiber (Instanz, Programm, PID, Container) und
// Rest-Erkennung (Flow-Verzeichnis ohne Schreiber). Nur lesend; Datenquelle GET /api/v1/admin/mxl/flows.
import { t } from "./i18n.ts";
import { type DomainRow, domainOptionLabel, type FlowRow, humanSize, matchesFlow, formatName } from "./mxl-flows-logic.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { promptDialog } from "../kit/omp-prompt.ts";
import { showToast } from "../kit/omp-toast.ts";

const REFRESH_MS = 5_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export class MxlFlowsPanel {
  readonly el: HTMLElement;
  #summary = el("div", "margin:4px 0 12px;color:var(--omp-text-dim);");
  #body = el("div");
  #search = el("input", "margin:0 0 10px;min-width:420px;");
  #rows: FlowRow[] = [];
  #domain = "";
  #domainName = "default";
  #domains: DomainRow[] = [];
  #domainBar = el("div", "display:flex;gap:8px;align-items:center;margin:0 0 10px;flex-wrap:wrap;");
  #timer: number | undefined;
  #seq = 0;

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:1100px;");
    const title = el("span", "", t("mxlflows.title"));
    title.className = "omp-h1";
    this.#search.type = "search";
    this.#search.className = "omp-input";
    this.#search.placeholder = t("mxlflows.search");
    this.#search.setAttribute("aria-label", t("mxlflows.search"));
    this.#search.addEventListener("input", () => this.#render());
    this.el.append(title, this.#summary, this.#domainBar, this.#search, this.#body);
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
      const q = this.#domainName === "default" ? "" : `?domain=${encodeURIComponent(this.#domainName)}`;
      const [res, dres] = await Promise.all([apiFetch("/api/v1/admin/mxl/flows" + q), apiFetch("/api/v1/admin/mxl/domains")]);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { domain: string; flows: FlowRow[] };
      if (dres.ok) this.#domains = ((await dres.json()) as { domains?: DomainRow[] }).domains ?? [];
      if (seq !== this.#seq) return;
      this.#renderDomainBar();
      this.#rows = data.flows ?? [];
      this.#domain = data.domain;
      this.#render();
    } catch {
      if (seq !== this.#seq) return;
      this.#summary.textContent = t("mxlflows.error");
    }
  }

  // Domain-Leiste: Auswahl, Neu, Löschen. Ohne die Domain-Verwaltung des Orchestrators (404) bleibt sie leer.
  #renderDomainBar() {
    if (this.#domains.length === 0) {
      this.#domainBar.replaceChildren();
      return;
    }
    // Nicht neu zeichnen, solange der Nutzer die Auswahl offen hat (Neuzeichnen schließt sie).
    if (this.#domainBar.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") return;
    const sel = el("select", "min-width:260px;");
    sel.className = "omp-input";
    sel.setAttribute("aria-label", t("mxlflows.domain"));
    for (const d of this.#domains) {
      const o = el("option", "", domainOptionLabel(d));
      o.value = d.default ? "default" : d.name;
      sel.append(o);
    }
    sel.value = this.#domains.some((d) => (d.default ? "default" : d.name) === this.#domainName) ? this.#domainName : "default";
    sel.addEventListener("change", () => {
      this.#domainName = sel.value;
      void this.refresh();
    });
    const add = el("button", "", t("mxlflows.domain.add"));
    add.className = "omp-btn";
    add.addEventListener("click", () => void this.#createDomain());
    const del = el("button", "", t("mxlflows.domain.delete"));
    del.className = "omp-btn";
    del.disabled = this.#domainName === "default";
    del.addEventListener("click", () => void this.#deleteDomain());
    this.#domainBar.replaceChildren(el("span", "color:var(--omp-text-dim);", t("mxlflows.domain")), sel, add, del);
  }

  async #createDomain() {
    const name = await promptDialog(t("mxlflows.domain.addPrompt"), { okLabel: t("mxlflows.domain.add") });
    if (!name || !name.trim()) return;
    const res = await apiFetch("/api/v1/admin/mxl/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) {
      showToast(`${t("mxlflows.domain.failed")}: ${(await res.text()).trim()}`);
      return;
    }
    this.#domainName = name.trim();
    await this.refresh();
  }

  async #deleteDomain() {
    const name = this.#domainName;
    if (name === "default") return;
    if (!(await confirmDialog(t("mxlflows.domain.deleteConfirm", { name }), { confirmLabel: t("mxlflows.domain.delete") }))) return;
    const res = await apiFetch(`/api/v1/admin/mxl/domains/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`${t("mxlflows.domain.failed")}: ${(await res.text()).trim()}`);
      return;
    }
    this.#domainName = "default";
    await this.refresh();
  }

  #render() {
    const rows = this.#rows;
    const stale = rows.filter((r) => r.stale);
    const shown = rows.filter((r) => matchesFlow(r, this.#search.value));
    this.#summary.textContent = t("mxlflows.summary", {
      domain: this.#domain,
      total: String(rows.length),
      stale: String(stale.length),
    });
    this.#body.replaceChildren();
    if (rows.length === 0) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", t("mxlflows.none")));
      return;
    }
    if (shown.length === 0) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", t("mxlflows.noMatch")));
      return;
    }
    const table = el("table", "border-collapse:collapse;width:100%;");
    const head = el("tr");
    for (const k of ["mxlflows.col.flow", "mxlflows.col.format", "mxlflows.col.status", "mxlflows.col.writer", "mxlflows.col.size"] as const) {
      head.append(el("th", "text-align:left;padding:4px 8px;border-bottom:1px solid var(--omp-border);", t(k)));
    }
    table.append(head);
    for (const r of shown) {
      const tr = el("tr");
      const cell = (txt: string, title = "", css = "") => {
        const td = el("td", "padding:4px 8px;border-bottom:1px solid var(--omp-border);" + css, txt);
        if (title) td.title = title;
        return td;
      };
      const status = r.stale
        ? cell(t("mxlflows.status.stale"), t("mxlflows.status.stale.hint"), "color:#e0a020;")
        : cell(t("mxlflows.status.active"));
      const writer = r.writers.length === 0
        ? "–"
        : r.writers
          .map((w) => {
            const owner = r.instanceLabel ? `${r.instanceLabel} · ` : "";
            const box = w.container ? ` · ${t("mxlflows.container")} ${w.container}` : "";
            return `${owner}${w.cmd || "?"} (PID ${w.pid})${box}`;
          })
          .join("\n");
      tr.append(
        cell(r.label || r.id.slice(0, 8), r.id),
        cell(formatName(r.format)),
        status,
        cell(writer.split("\n")[0] ?? "–", writer),
        cell(humanSize(r.sizeBytes)),
      );
      table.append(tr);
    }
    this.#body.append(table);
  }
}
