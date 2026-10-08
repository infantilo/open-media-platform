// <omp-cloud-view> — Cloud-Ressourcen (ARCHITECTURE.md §27, UMSETZUNG.md 35.7): gemietete Hosts, geschätzte Kosten gegen
// den Budgetdeckel, Autoscaling-Regeln, offene Vorschläge, Reservierungen und das Aktionsprotokoll.
//
// Bewusst ehrlich in der Darstellung: alle Beträge sind SCHÄTZUNGEN aus Preisliste × Laufzeit (nicht die Abrechnung des
// Anbieters). Regel-Formulare werden explizit gespeichert ("Speichern", nicht je Klick) und beim Neuzeichnen durch den
// Poll nicht überschrieben, solange sie sich im Bearbeiten befinden.
import { apiFetch, showToast, t, whoami } from "../host.ts";
import { budgetBar, describeReason, fmtMoney, policyFromForm, policyToForm, reservationPayload, type Mode, type Policy, type PolicyForm } from "./cloud-logic.ts";

interface CloudHost {
  id: string;
  pool: string;
  instanceType: string;
  state: string;
  requestedAt: string;
  readyAt?: string;
  endedAt?: string;
  error?: string;
  adopted?: boolean;
  lifetimeExceeded?: boolean;
}
interface PoolInfo { name: string; instanceType: string; region: string; min: number; max: number }
interface Action { at: string; pool: string; kind: string; hostId?: string; reason: string; code?: string; params?: Record<string, unknown> }
interface HostsResp { configured: boolean; pools: PoolInfo[]; hosts: CloudHost[]; actions: Action[] | null }
interface Period { spent: number; projected: number; cap: number }
interface PoolCosts { pool: string; currency: string; day: Period; month: Period; unpricedHosts?: string[] }
interface Suggestion { id: string; pool: string; createdAt: string; reason: string; code?: string; params?: Record<string, unknown> }
interface Reservation { id: string; pool: string; hostCount: number; from: string; to: string; note?: string }

const POLL_MS = 5000;

// Übersetzt Server-Begründungen (Code + Parameter) in die Oberfläche; unbekannte Codes zeigen den englischen Originaltext.
function say(code: string | undefined, params: Record<string, unknown> | undefined, reason: string): string {
  return describeReason(code, params, reason, (key, p) => {
    const text = t(key, p);
    return text === key ? undefined : text;
  }, (v, cur) => fmtMoney(v, cur));
}
function kindLabel(kind: string): string {
  const key = `cloudv.kind.${kind}`;
  const text = t(key);
  return text === key ? kind : text;
}
const css = (s: string) => s;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}

const CARD = css("background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:12px;margin-bottom:12px;");
const H = css("font-size:var(--omp-font-size-md);margin:0 0 8px;font-weight:600;");
const DIM = css("color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);");
const INPUT = css("background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 6px;font:inherit;");

export class CloudView extends HTMLElement {
  #timer?: number;
  #admin = false;
  #data: HostsResp | null = null;
  #costs: PoolCosts[] = [];
  #sugg: Suggestion[] = [];
  #resv: Reservation[] = [];
  #policies: Policy[] = [];
  #live!: HTMLDivElement; // vom Poll neu gezeichnete Bereiche
  #editors!: HTMLDivElement; // Regel- und Reservierungsformulare (bleiben beim Poll stehen)
  #editorKey = "";
  #forms = new Map<string, PolicyForm>();

  connectedCallback() {
    this.style.cssText = "display:block;padding:var(--omp-space-3);overflow:auto;height:100%;box-sizing:border-box;color:var(--omp-text);background:var(--omp-bg);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);";
    this.#live = el("div");
    this.#editors = el("div");
    this.append(this.#live, this.#editors);
    void whoami().then((w) => {
      this.#admin = !!w.isAdmin || !w.authRequired;
      this.#editorKey = "";
      void this.#poll();
    });
    void this.#poll();
    this.#timer = window.setInterval(() => void this.#poll(), POLL_MS);
  }

  disconnectedCallback() {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  async #get<T>(url: string, fallback: T): Promise<T> {
    try {
      const r = await apiFetch(url);
      return r.ok ? ((await r.json()) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  async #poll() {
    const [data, costs, sugg, resv, pol] = await Promise.all([
      this.#get<HostsResp | null>("/api/v1/cloud/hosts", null),
      this.#get<PoolCosts[]>("/api/v1/cloud/costs", []),
      this.#get<Suggestion[]>("/api/v1/cloud/suggestions", []),
      this.#get<Reservation[]>("/api/v1/cloud/reservations", []),
      this.#get<Policy[]>("/api/v1/cloud/policies", []),
    ]);
    this.#data = data;
    this.#costs = costs ?? [];
    this.#sugg = sugg ?? [];
    this.#resv = resv ?? [];
    this.#policies = pol ?? [];
    this.#renderLive();
    this.#renderEditors();
  }

  async #act(url: string, init: RequestInit, okKey: "cloudv.done"): Promise<boolean> {
    try {
      const r = await apiFetch(url, init);
      if (!r.ok) {
        showToast(t("cloudv.failed", { p0: (await r.text()).trim() || String(r.status) }));
        return false;
      }
      showToast(t(okKey));
      void this.#poll();
      return true;
    } catch (e) {
      showToast(t("cloudv.failed", { p0: String(e) }));
      return false;
    }
  }

  #renderLive() {
    const d = this.#data;
    const root = this.#live;
    root.replaceChildren();
    if (!d || !d.configured) {
      const c = el("div", CARD);
      c.append(el("h3", H, t("cloudv.title")), el("div", DIM, t("cloudv.notConfigured")));
      root.append(c);
      return;
    }
    const head = el("div", CARD);
    head.append(el("h3", H, t("cloudv.title")), el("div", DIM, t("cloudv.estimateNote")));
    root.append(head);

    // Kosten je Pool gegen den Deckel
    const costCard = el("div", CARD);
    costCard.append(el("h3", H, t("cloudv.costs")));
    for (const pc of this.#costs) {
      const row = el("div", "margin-bottom:10px;");
      row.append(el("div", "font-weight:600;", pc.pool));
      for (const [label, p] of [[t("cloudv.today"), pc.day], [t("cloudv.month"), pc.month]] as const) {
        const line = el("div", "display:flex;align-items:center;gap:8px;margin-top:4px;");
        line.append(el("span", "min-width:70px;" + DIM, label));
        const bar = budgetBar(p.spent, p.projected, p.cap);
        if (bar) {
          const track = el("div", "flex:1;max-width:320px;height:10px;background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:5px;position:relative;overflow:hidden;");
          const proj = el("div", `position:absolute;inset:0 auto 0 0;width:${bar.projectedPct}%;background:${bar.over ? "var(--omp-error)" : "var(--omp-cue)"};opacity:.45;`);
          const spent = el("div", `position:absolute;inset:0 auto 0 0;width:${bar.spentPct}%;background:${bar.over ? "var(--omp-error)" : "var(--omp-preset)"};`);
          track.append(proj, spent);
          line.append(track);
        }
        line.append(el("span", "", t("cloudv.costLine", { p0: fmtMoney(p.spent, pc.currency), p1: fmtMoney(p.projected, pc.currency), p2: p.cap > 0 ? fmtMoney(p.cap, pc.currency) : t("cloudv.noCap") })));
        row.append(line);
      }
      if (pc.unpricedHosts?.length) row.append(el("div", "color:var(--omp-error);", t("cloudv.unpriced", { p0: pc.unpricedHosts.join(", ") })));
      costCard.append(row);
    }
    if (this.#costs.length === 0) costCard.append(el("div", DIM, t("cloudv.noCosts")));
    root.append(costCard);

    // Offene Vorschläge
    if (this.#sugg.length > 0) {
      const c = el("div", CARD + "border-color:var(--omp-cue);");
      c.append(el("h3", H, t("cloudv.suggestions")));
      for (const s of this.#sugg) {
        const row = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:4px;");
        row.dataset.role = "suggestion";
        row.append(el("span", "", t("cloudv.suggestLine", { p0: s.pool, p1: say(s.code, s.params, s.reason) })));
        if (this.#admin) {
          const ok = el("button", "", t("cloudv.accept"));
          ok.addEventListener("click", () => void this.#act(`/api/v1/cloud/suggestions/${encodeURIComponent(s.id)}/accept`, { method: "POST" }, "cloudv.done"));
          const no = el("button", "", t("cloudv.dismiss"));
          no.addEventListener("click", () => void this.#act(`/api/v1/cloud/suggestions/${encodeURIComponent(s.id)}`, { method: "DELETE" }, "cloudv.done"));
          row.append(ok, no);
        }
        c.append(row);
      }
      root.append(c);
    }

    // Hosts
    const hc = el("div", CARD);
    hc.append(el("h3", H, t("cloudv.hosts")));
    const live = d.hosts.filter((h) => h.state !== "terminated" && h.state !== "failed");
    if (live.length === 0) hc.append(el("div", DIM, t("cloudv.noHosts")));
    for (const h of live) {
      const row = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:4px;flex-wrap:wrap;");
      row.dataset.role = "host";
      row.append(el("span", "font-weight:600;", h.id), el("span", DIM, `${h.pool} · ${h.instanceType}`), el("span", "", t(`cloudv.state.${h.state}` as "cloudv.state.ready")));
      if (h.lifetimeExceeded) row.append(el("span", "color:var(--omp-error);", t("cloudv.lifetime")));
      if (h.adopted) row.append(el("span", DIM, t("cloudv.adopted")));
      if (this.#admin && h.state !== "draining") {
        const b = el("button", "", t("cloudv.release"));
        b.addEventListener("click", () => {
          if (window.confirm(t("cloudv.releaseConfirm", { p0: h.id }))) void this.#act(`/api/v1/cloud/hosts/${encodeURIComponent(h.id)}/release`, { method: "POST" }, "cloudv.done");
        });
        row.append(b);
      }
      hc.append(row);
    }
    root.append(hc);

    // Reservierungen
    const rc = el("div", CARD);
    rc.append(el("h3", H, t("cloudv.reservations")));
    // Vergangene Reservierungen sind erledigt und gehören nicht in die Arbeitsliste.
    const upcoming = this.#resv.filter((r) => Date.parse(r.to) > Date.now());
    if (upcoming.length === 0) rc.append(el("div", DIM, t("cloudv.noReservations")));
    for (const r of upcoming) {
      const row = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:4px;");
      row.dataset.role = "reservation";
      row.append(el("span", "", t("cloudv.reservationLine", { p0: r.pool, p1: r.hostCount, p2: new Date(r.from).toLocaleString(), p3: new Date(r.to).toLocaleString() })));
      if (this.#admin) {
        const b = el("button", "", t("cloudv.delete"));
        b.addEventListener("click", () => void this.#act(`/api/v1/cloud/reservations/${encodeURIComponent(r.id)}`, { method: "DELETE" }, "cloudv.done"));
        row.append(b);
      }
      rc.append(row);
    }
    root.append(rc);

    // Aktionsprotokoll
    const ac = el("div", CARD);
    ac.append(el("h3", H, t("cloudv.actions")));
    const acts = (d.actions ?? []).slice(-15).reverse();
    if (acts.length === 0) ac.append(el("div", DIM, t("cloudv.noActions")));
    for (const a of acts) ac.append(el("div", "margin-bottom:2px;" + (a.kind === "budget" || a.kind === "error" ? "color:var(--omp-error);" : ""), `${new Date(a.at).toLocaleTimeString()} · ${kindLabel(a.kind)}${a.pool ? " · " + a.pool : ""} — ${say(a.code, a.params, a.reason)}`));
    root.append(ac);
  }

  // Formulare nur neu aufbauen, wenn sich die Pool-Liste/Rechte ändern oder nach dem Speichern — nicht bei jedem Poll.
  #renderEditors() {
    const d = this.#data;
    const key = JSON.stringify([d?.configured, d?.pools.map((p) => p.name), this.#admin, this.#policies.map((p) => p.pool)]);
    if (key === this.#editorKey) return;
    this.#editorKey = key;
    const root = this.#editors;
    root.replaceChildren();
    if (!d?.configured || !this.#admin) return;

    const pc = el("div", CARD);
    pc.append(el("h3", H, t("cloudv.policies")), el("div", DIM + "margin-bottom:8px;", t("cloudv.policyNote")));
    for (const pool of d.pools) {
      const pol = this.#policies.find((p) => p.pool === pool.name);
      if (!pol) continue;
      const form: PolicyForm = this.#forms.get(pool.name) ?? policyToForm(pol);
      this.#forms.set(pool.name, form);
      pc.append(this.#policyForm(pool, form));
    }
    root.append(pc);

    const nc = el("div", CARD);
    nc.append(el("h3", H, t("cloudv.newReservation")));
    const pool = el("select", INPUT);
    for (const p of d.pools) pool.append(new Option(`${p.name} (${p.instanceType}, max ${p.max})`, p.name));
    const count = el("input", INPUT + "width:60px;");
    count.type = "number";
    count.min = "1";
    count.value = "1";
    const from = el("input", INPUT);
    from.type = "datetime-local";
    const to = el("input", INPUT);
    to.type = "datetime-local";
    const hour = new Date(Math.ceil(Date.now() / 3600000) * 3600000);
    const local = (dt: Date) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    from.value = local(hour);
    to.value = local(new Date(hour.getTime() + 3 * 3600000));
    const cost = el("span", DIM);
    const calc = el("button", "", t("cloudv.calcCost"));
    calc.addEventListener("click", async () => {
      const p = reservationPayload(pool.value, count.value, from.value, to.value);
      if (!p.ok) return void (cost.textContent = t(p.error as "cloudv.err.count"));
      const pi = d.pools.find((x) => x.name === pool.value);
      cost.textContent = t("cloudv.calculating");
      try {
        const r = await apiFetch("/api/v1/cloud/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ demands: [{ instanceType: pi?.instanceType, count: p.body.hostCount, from: p.body.from, to: p.body.to }] }) });
        if (!r.ok) throw new Error(await r.text());
        const e = (await r.json()) as { total: number; currency: string };
        cost.textContent = t("cloudv.estimateResult", { p0: fmtMoney(e.total, e.currency) });
      } catch (e) {
        cost.textContent = t("cloudv.failed", { p0: String(e) });
      }
    });
    const save = el("button", "", t("cloudv.reserve"));
    save.addEventListener("click", async () => {
      const p = reservationPayload(pool.value, count.value, from.value, to.value);
      if (!p.ok) return void showToast(t(p.error as "cloudv.err.count"));
      if (!window.confirm(t("cloudv.reserveConfirm", { p0: p.body.hostCount, p1: pool.value }))) return;
      await this.#act("/api/v1/cloud/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...p.body, note: "ui" }) }, "cloudv.done");
    });
    const line = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    line.append(pool, count, from, to, calc, save, cost);
    nc.append(line);
    root.append(nc);
  }

  #policyForm(pool: PoolInfo, form: PolicyForm): HTMLElement {
    const box = el("div", "border-top:1px solid var(--omp-border);padding-top:8px;margin-top:8px;");
    box.dataset.role = "policy";
    box.dataset.pool = pool.name;
    box.append(el("div", "font-weight:600;margin-bottom:6px;", `${pool.name} — ${pool.instanceType} (${pool.min}–${pool.max})`));
    const grid = el("div", "display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 12px;");
    const field = (label: string, key: keyof PolicyForm, type = "text") => {
      const wrap = el("label", "display:flex;flex-direction:column;gap:2px;");
      wrap.append(el("span", DIM, label));
      const inp = el("input", INPUT);
      inp.type = type;
      inp.value = String(form[key]);
      inp.dataset.field = key;
      inp.addEventListener("input", () => ((form as unknown as Record<string, string>)[key] = inp.value));
      wrap.append(inp);
      grid.append(wrap);
    };
    const modeWrap = el("label", "display:flex;flex-direction:column;gap:2px;");
    modeWrap.append(el("span", DIM, t("cloudv.mode")));
    const mode = el("select", INPUT);
    mode.dataset.field = "mode";
    for (const m of ["off", "suggest", "auto"] as Mode[]) mode.append(new Option(t(`cloudv.mode.${m}` as "cloudv.mode.off"), m));
    mode.value = form.mode;
    mode.addEventListener("change", () => (form.mode = mode.value as Mode));
    modeWrap.append(mode);
    grid.append(modeWrap);
    field(t("cloudv.f.upCpu"), "upCpuPercent");
    field(t("cloudv.f.upMem"), "upMemPercent");
    field(t("cloudv.f.upAfter"), "upAfterMin");
    field(t("cloudv.f.downCpu"), "downCpuPercent");
    field(t("cloudv.f.downAfter"), "downAfterMin");
    field(t("cloudv.f.cooldown"), "cooldownMin");
    field(t("cloudv.f.maxAuto"), "maxAutoHosts");
    field(t("cloudv.f.daily"), "dailyBudget");
    field(t("cloudv.f.monthly"), "monthlyBudget");
    box.append(grid);
    const msg = el("div", "color:var(--omp-error);margin-top:4px;");
    const save = el("button", "margin-top:6px;", t("cloudv.save"));
    save.addEventListener("click", async () => {
      const r = policyFromForm(pool.name, form);
      if (!r.ok) {
        msg.textContent = t(r.error as "cloudv.err.number");
        return;
      }
      msg.textContent = "";
      const okSaved = await this.#act(`/api/v1/cloud/policies/${encodeURIComponent(pool.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.policy) }, "cloudv.done");
      if (okSaved) {
        this.#forms.delete(pool.name);
        this.#editorKey = "";
      }
    });
    box.append(save, msg);
    return box;
  }
}

if (!customElements.get("omp-cloud-view")) customElements.define("omp-cloud-view", CloudView);
