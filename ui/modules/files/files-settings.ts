// <omp-files-settings> — Einstellungen des Dateien-Moduls in der Administration (Kapitel 86): Papierkorb, Notfallgrenze, Sperrfenster
// und die Orte (auch gemeinsamer Speicher, z. B. Isilon, den mehrere Hosts bedienen). Braucht das Recht files.admin.
import { apiFetch, confirmDialog, features, showToast, t } from "../host.ts";
import { hasFeature } from "../../kit/features.ts";
import { btn, CARD, type Cfg, DIM, el, hostLabel, INPUT, jsonOrThrow, openModal, pill, post, ROLES, roleLabel, type Root, TD, TH } from "./files-ui.ts";

interface HostRow { id?: string; ID?: string; label?: string; Label?: string; hostname?: string }

export class FilesSettings extends HTMLElement {
  #roots: Root[] = [];
  #cfg: Cfg | null = null;
  #admin = false;
  #err = "";
  #body!: HTMLDivElement;
  #hosts: HostRow[] = [];

  connectedCallback() {
    this.style.cssText = "display:block;padding:var(--omp-space-3);overflow:auto;height:100%;box-sizing:border-box;color:var(--omp-text);background:var(--omp-bg);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);";
    this.#body = el("div");
    this.append(this.#body);
    void features().then(async (f) => {
      this.#admin = hasFeature(f, "files.admin");
      await this.#loadCfg();
      this.#render();
    });
  }

  #render() {
    this.#body.replaceChildren(el("h2", "font-size:var(--omp-font-size-lg);margin:0 0 12px;", t("filesv.title")));
    if (!this.#admin) { this.#body.append(el("div", DIM, t("filesv.err.noRight"))); return; }
    if (this.#err) this.#body.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", this.#err));
    this.#body.append(this.#viewSettings());
  }

  async #loadRoots() {
    try { this.#roots = (await jsonOrThrow<Root[]>(await apiFetch("/api/v1/files/roots"))) ?? []; this.#err = ""; }
    catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  async #loadCfg() {
    try { this.#cfg = await jsonOrThrow<Cfg>(await apiFetch("/api/v1/files/config")); await this.#loadRoots(); this.#err = ""; }
    catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  #viewSettings(): HTMLElement {
    const wrap = el("div");
    const c = this.#cfg;
    if (c) {
      const card = el("div", CARD);
      card.append(el("h3", "margin:0 0 8px;font-size:var(--omp-font-size-md);", t("filesv.set.config")));
      const fields: [keyof Cfg, string][] = [["trashDays", "filesv.set.trashDays"], ["emergencyFreeGb", "filesv.set.emerGb"], ["emergencyFreePct", "filesv.set.emerPct"], ["graceMinutes", "filesv.set.grace"],
        ["lockBeforeH", "filesv.set.lockBefore"], ["lockAfterH", "filesv.set.lockAfter"], ["checkEveryMin", "filesv.set.checkEvery"], ["sweepEveryMin", "filesv.set.sweepEvery"]];
      const inputs = new Map<keyof Cfg, HTMLInputElement>();
      const grid = el("div", "display:grid;grid-template-columns:minmax(260px,1fr) 120px;gap:6px 12px;align-items:center;max-width:620px;");
      for (const [k, key] of fields) {
        const i = el("input", INPUT) as HTMLInputElement; i.type = "number"; i.min = "0"; i.step = "any"; i.value = String(c[k]);
        inputs.set(k, i); grid.append(el("label", "", t(key)), i);
      }
      const pl = el("input") as HTMLInputElement; pl.type = "checkbox"; pl.checked = c.plannedIsHard;
      const plWrap = el("label", "display:flex;gap:6px;align-items:center;grid-column:1 / span 2;"); plWrap.append(pl, document.createTextNode(t("filesv.set.planned")));
      grid.append(plWrap);
      card.append(grid);
      card.append(btn(t("filesv.set.save"), async () => {
        const body: Record<string, unknown> = { plannedIsHard: pl.checked };
        for (const [k, i] of inputs) body[k] = Number(i.value);
        const res = await apiFetch("/api/v1/files/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) { this.#cfg = (await res.json()) as Cfg; showToast(t("filesv.set.saved")); } else showToast(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      }, { role: "files-config-save" }));
      wrap.append(card);
    }
    wrap.append(this.#rootsCard());
    return wrap;
  }

  #rootsCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("h3", "margin:0 0 4px;font-size:var(--omp-font-size-md);", t("filesv.set.roots")), el("div", DIM + "margin-bottom:8px;", t("filesv.set.note")));
    const num = (v: number | undefined) => (v === undefined ? "" : String(v));
    const opt = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));
    const table = el("table", "border-collapse:collapse;width:100%;");
    const h = el("tr");
    for (const x of ["filesv.set.name", "filesv.set.host", "filesv.set.path", "filesv.set.role", "filesv.set.readOnly", "filesv.set.trashDaysRoot", "filesv.set.lockBeforeRoot", "filesv.set.lockAfterRoot", "filesv.set.emerGbRoot"]) h.append(el("th", TH, t(x)));
    h.append(el("th", TH));
    table.append(h);
    for (const r of this.#roots) {
      const tr = el("tr");
      const role = el("select", INPUT) as HTMLSelectElement;
      for (const v of ROLES) { const o = el("option"); o.value = v; o.textContent = roleLabel(v); role.append(o); }
      role.value = r.role;
      const ro = el("input") as HTMLInputElement; ro.type = "checkbox"; ro.checked = r.readOnly;
      const mk = (v: number | undefined) => { const i = el("input", INPUT + "width:70px;") as HTMLInputElement; i.type = "number"; i.min = "0"; i.step = "any"; i.value = num(v); return i; };
      const td = mk(r.trashDays), lb = mk(r.lockBeforeH), la = mk(r.lockAfterH), eg = mk(r.emergencyFreeGb);
      const cell = (n: Node) => { const c = el("td", TD); c.append(n); return c; };
      const actions = el("td", TD + "white-space:nowrap;");
      actions.append(btn(t("filesv.set.save"), async () => {
        const res = await apiFetch(`/api/v1/files/roots/${r.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...this.#rootBody(r), role: role.value, readOnly: ro.checked, trashDays: opt(td.value), lockBeforeH: opt(lb.value), lockAfterH: opt(la.value), emergencyFreeGb: opt(eg.value) }) });
        showToast(res.ok ? t("filesv.set.rootSaved") : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
        await this.#loadRoots(); this.#render();
      }), ...(r.shared ? [btn(t("filesv.set.editHosts"), () => void this.#editHosts(r))] : []), btn(t("filesv.set.remove"), async () => {
        if (!(await confirmDialog(t("filesv.set.removeConfirm", { p0: r.name })))) return;
        await apiFetch(`/api/v1/files/roots/${r.id}`, { method: "DELETE" });
        await this.#loadRoots(); this.#render();
      }, { danger: true }));
      const nameTd = el("td", TD, r.name);
      if (r.mount && r.mount.state !== "ok") nameTd.append(document.createTextNode(" "), pill(r.mount.state === "hung" ? t("filesv.mount.hung") : t("filesv.mount.unreachable"), "var(--omp-danger,#d44)"));
      tr.append(nameTd, el("td", TD, r.shared ? `${t("filesv.set.sharedShort")}: ${(r.hosts ?? []).map((h) => this.#hostName(h)).join(" → ")}` : hostLabel(r.hostId)), el("td", TD + "word-break:break-all;", r.path), cell(role), cell(ro), cell(td), cell(lb), cell(la), cell(eg), actions);
      table.append(tr);
    }
    card.append(table);
    card.append(btn(t("filesv.set.addRoot"), () => void this.#addRoot(), { role: "files-add-root" }));
    return card;
  }

  async #loadHosts() {
    try { this.#hosts = (await jsonOrThrow<HostRow[]>(await apiFetch("/api/v1/hosts"))) ?? []; } catch { this.#hosts = []; }
  }

  #hostName(id: string): string {
    if (!id) return t("filesv.root.host.local");
    const h = this.#hosts.find((x) => (x.id ?? x.ID) === id);
    return h?.label ?? h?.Label ?? h?.hostname ?? hostLabel(id);
  }

  /** Auswahl der Hosts, die einen gemeinsamen Speicher bedienen: Reihenfolge der Häkchen = Vorzug (der erste wird zuerst befragt). */
  #hostPicker(box: HTMLElement, selected: string[]): () => string[] {
    const order = [...selected];
    const list = el("div", "display:flex;flex-direction:column;gap:4px;margin-top:4px;");
    const ids = ["", ...this.#hosts.map((h) => h.id ?? h.ID ?? "").filter(Boolean)];
    for (const id of order) if (!ids.includes(id)) ids.push(id);
    const draw = () => {
      list.replaceChildren();
      for (const id of ids) {
        const row = el("label", "display:flex;gap:6px;align-items:center;");
        const c = el("input") as HTMLInputElement; c.type = "checkbox"; c.checked = order.includes(id);
        c.addEventListener("change", () => { if (c.checked) order.push(id); else order.splice(order.indexOf(id), 1); draw(); });
        row.append(c, document.createTextNode(this.#hostName(id)));
        const pos = order.indexOf(id);
        if (pos >= 0) row.append(el("span", DIM, ` ${pos + 1}.${pos === 0 ? " " + t("filesv.set.preferred") : ""}`));
        list.append(row);
      }
    };
    draw();
    box.append(list);
    return () => [...order];
  }

  async #addRoot() {
    await this.#loadHosts();
    openModal(t("filesv.set.addRoot"), (box, close) => {
      const mk = (label: string, i: HTMLElement) => { box.append(el("div", "margin-top:8px;", label), i); };
      const name = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement;
      const path = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement;
      const role = el("select", INPUT) as HTMLSelectElement;
      for (const v of ROLES) { const o = el("option"); o.value = v; o.textContent = roleLabel(v); role.append(o); }
      const ro = el("input") as HTMLInputElement; ro.type = "checkbox";
      const shared = el("input") as HTMLInputElement; shared.type = "checkbox";
      mk(t("filesv.set.name"), name);
      const sl = el("label", "display:flex;gap:6px;align-items:center;margin-top:8px;"); sl.append(shared, document.createTextNode(t("filesv.set.shared")));
      box.append(sl, el("div", DIM, t("filesv.set.sharedHelp")));
      const single = el("div"); const host = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement; host.setAttribute("list", "files-hosts");
      const dl = el("datalist"); dl.id = "files-hosts";
      for (const h of this.#hosts) { const o = el("option"); o.value = h.id ?? h.ID ?? ""; o.label = h.label ?? h.Label ?? h.hostname ?? ""; dl.append(o); }
      single.append(el("div", "margin-top:8px;", t("filesv.set.host")), host, dl);
      const multi = el("div", "display:none;"); multi.append(el("div", "margin-top:8px;", t("filesv.set.hosts")));
      const picked = this.#hostPicker(multi, [""]);
      box.append(single, multi);
      shared.addEventListener("change", () => { single.style.display = shared.checked ? "none" : ""; multi.style.display = shared.checked ? "" : "none"; });
      mk(t("filesv.set.path"), path); mk(t("filesv.set.role"), role);
      const l = el("label", "display:flex;gap:6px;align-items:center;margin-top:8px;"); l.append(ro, document.createTextNode(t("filesv.set.readOnly"))); box.append(l);
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
      foot.append(btn(t("filesv.del.cancel"), close), btn(t("filesv.set.addRoot"), async () => {
        const body: Record<string, unknown> = { name: name.value, path: path.value, role: role.value, readOnly: ro.checked };
        if (shared.checked) { body.shared = true; body.hosts = picked(); } else body.hostId = host.value.trim();
        const res = await post("/api/v1/files/roots", body);
        if (!res.ok) { showToast(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status)); return; }
        const made = (await res.json().catch(() => ({}))) as { warning?: string };
        showToast(made.warning ? t("filesv.set.rootWarn", { p0: made.warning }) : t("filesv.set.rootSaved"));
        close();
        await this.#loadRoots(); this.#render();
      }, { role: "files-add-root-run" }));
      box.append(foot);
    });
  }

  async #editHosts(r: Root) {
    await this.#loadHosts();
    openModal(t("filesv.set.hostsFor", { p0: r.name }), (box, close) => {
      box.append(el("div", DIM, t("filesv.set.sharedHelp")));
      const picked = this.#hostPicker(box, r.hosts ?? [r.hostId]);
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
      foot.append(btn(t("filesv.del.cancel"), close), btn(t("filesv.set.save"), async () => {
        const hosts = picked();
        if (hosts.length === 0) { showToast(t("filesv.set.needHost")); return; }
        const res = await apiFetch(`/api/v1/files/roots/${r.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...this.#rootBody(r), shared: true, hosts }) });
        showToast(res.ok ? t("filesv.set.rootSaved") : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
        close();
        await this.#loadRoots(); this.#render();
      }));
      box.append(foot);
    });
  }

  /** Alle gespeicherten Felder eines Ortes (PUT überschreibt den ganzen Satz). */
  #rootBody(r: Root): Record<string, unknown> {
    return { role: r.role, readOnly: r.readOnly, trashDays: r.trashDays, lockBeforeH: r.lockBeforeH, lockAfterH: r.lockAfterH, emergencyFreeGb: r.emergencyFreeGb, emergencyFreePct: r.emergencyFreePct, shared: r.shared, hosts: r.hosts };
  }
}

if (!customElements.get("omp-files-settings")) customElements.define("omp-files-settings", FilesSettings);
