// Verteilung importierter Microservices auf Hosts (Kap. 85): Hosts-Block auf der Katalogkarte, Auswahl-Dialog, Nachladen.
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";
import { type DistRow, type HostLite, hostLabel, isBusy, rowsFor, selectableHosts, stateColor, stateKey, summary } from "./catalog-hosts-logic.ts";

interface EntryRef {
  type: string;
  label: string;
  version?: string;
}

export class CatalogHosts {
  rows: DistRow[] = [];
  hosts: HostLite[] = [];
  #timer: number | null = null;
  #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  async load(): Promise<void> {
    try {
      const [d, h] = await Promise.all([apiFetch("/api/v1/catalog/distribution"), apiFetch("/api/v1/hosts")]);
      if (d.ok) this.rows = (await d.json()) as DistRow[];
      if (h.ok) {
        const list = (await h.json()) as { id: string; label?: string; hostname?: string }[];
        this.hosts = list.map((x) => ({ id: x.id, label: x.label || x.hostname || x.id }));
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — das nächste Nachladen holt es auf.
    }
    this.#onChange();
    this.#schedule();
  }

  /** Nachladen nur, solange sich etwas bewegt. */
  #schedule() {
    this.stop();
    if (!isBusy(this.rows)) return;
    this.#timer = window.setTimeout(() => void this.load(), 3000);
  }

  stop() {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  render(entry: EntryRef): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText = "margin-top:var(--omp-space-2);border-top:1px solid var(--omp-border, #333);padding-top:var(--omp-space-2);display:flex;flex-direction:column;gap:4px;";
    const rows = rowsFor(this.rows, entry.type, entry.version).sort((a, b) => hostLabel(this.hosts, a.hostId).localeCompare(hostLabel(this.hosts, b.hostId)));

    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:var(--omp-space-2);";
    const title = document.createElement("span");
    title.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);font-weight:600;";
    const s = summary(rows);
    title.textContent = rows.length ? t("cathost.title.n", { ok: s.ok, total: s.total }) : t("cathost.title");
    head.appendChild(title);

    const distBtn = document.createElement("button");
    distBtn.textContent = t("cathost.distribute");
    distBtn.dataset.testid = "cathost-distribute";
    const free = selectableHosts(this.hosts, rows);
    if (!entry.version) {
      distBtn.disabled = true;
      distBtn.title = t("cathost.needVersion");
    } else if (free.length === 0) {
      distBtn.disabled = true;
      distBtn.title = this.hosts.length === 0 ? t("cathost.noHosts") : t("cathost.allDone");
    }
    distBtn.addEventListener("click", () => this.#openDialog(entry, free));
    head.appendChild(distBtn);
    box.appendChild(head);

    if (!entry.version) {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
      hint.textContent = t("cathost.needVersion");
      box.appendChild(hint);
    }

    for (const r of rows) {
      const line = document.createElement("div");
      line.style.cssText = "display:flex;align-items:center;gap:var(--omp-space-2);font-size:var(--omp-font-size-xs);flex-wrap:wrap;";
      const name = document.createElement("span");
      name.textContent = hostLabel(this.hosts, r.hostId);
      name.style.cssText = "min-width:90px;";
      const chip = document.createElement("span");
      chip.className = "omp-badge";
      chip.dataset.state = r.state;
      chip.style.cssText = `color:${stateColor(r)};`;
      chip.textContent = r.desired === "absent" && r.state !== "failed" ? t("cathost.state.removing") : t(stateKey(r));
      line.append(name, chip);
      if (r.detail && (r.state === "failed" || r.state === "offline")) {
        const d = document.createElement("span");
        d.style.cssText = "color:var(--omp-text-dim);flex:1;min-width:120px;";
        d.textContent = r.detail;
        line.appendChild(d);
      }
      if (r.state === "failed") {
        const retry = document.createElement("button");
        retry.textContent = t("cathost.retry");
        retry.addEventListener("click", () => void this.#retry(entry, r.hostId));
        line.appendChild(retry);
      }
      if (r.desired === "present") {
        const rm = document.createElement("button");
        rm.textContent = t("cathost.remove");
        rm.addEventListener("click", () => void this.#withdraw(entry, r.hostId));
        line.appendChild(rm);
      }
      box.appendChild(line);
    }
    return box;
  }

  async #post(path: string, method: string, body?: unknown): Promise<boolean> {
    const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      showToast(t("cathost.failed", { p0: await res.text() }), { variant: "error" });
      return false;
    }
    return true;
  }

  async #retry(entry: EntryRef, hostId: string) {
    if (await this.#post(`/api/v1/catalog/${encodeURIComponent(entry.type)}/hosts/retry`, "POST", { version: entry.version ?? "", hostId })) await this.load();
  }

  async #withdraw(entry: EntryRef, hostId: string) {
    const name = hostLabel(this.hosts, hostId);
    if (!(await confirmDialog(t("cathost.removeConfirm", { name: entry.label, host: name }), { confirmLabel: t("cathost.remove") }))) return;
    const q = `?version=${encodeURIComponent(entry.version ?? "")}&hostId=${encodeURIComponent(hostId)}`;
    if (await this.#post(`/api/v1/catalog/${encodeURIComponent(entry.type)}/hosts${q}`, "DELETE")) await this.load();
  }

  #openDialog(entry: EntryRef, free: HostLite[]) {
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const close = () => overlay.remove();
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    const h = document.createElement("div");
    h.className = "omp-h1";
    h.style.marginBottom = "var(--omp-space-3)";
    h.textContent = t("cathost.dialogTitle", { name: entry.label });
    modal.appendChild(h);
    const info = document.createElement("div");
    info.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);";
    info.textContent = t("cathost.dialogInfo");
    modal.appendChild(info);

    const checks: { id: string; box: HTMLInputElement }[] = [];
    for (const host of free) {
      const lab = document.createElement("label");
      lab.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 0;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.hostId = host.id;
      lab.append(cb, document.createTextNode(host.label));
      modal.appendChild(lab);
      checks.push({ id: host.id, box: cb });
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:var(--omp-space-2);margin-top:var(--omp-space-3);";
    const cancel = document.createElement("button");
    cancel.textContent = t("cathost.cancel");
    cancel.addEventListener("click", close);
    const ok = document.createElement("button");
    ok.className = "omp-btn-primary";
    ok.textContent = t("cathost.start");
    ok.dataset.testid = "cathost-start";
    ok.addEventListener("click", async () => {
      const ids = checks.filter((c) => c.box.checked).map((c) => c.id);
      if (ids.length === 0) {
        showToast(t("cathost.pickOne"), { variant: "error" });
        return;
      }
      ok.disabled = true;
      if (await this.#post(`/api/v1/catalog/${encodeURIComponent(entry.type)}/hosts`, "POST", { version: entry.version ?? "", hostIds: ids })) {
        close();
        await this.load();
      } else {
        ok.disabled = false;
      }
    });
    actions.append(cancel, ok);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
}
