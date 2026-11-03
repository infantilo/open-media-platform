// Admin → Einstellungen → E-Mail-Alarmierung (Kap. 83): SMTP-Zugang für Alarm-Mails.
// Explizites Speichern; das Kennwort wird nie angezeigt (nur "gespeichert"-Hinweis).

import { getLang, t, tLoose } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";

interface RouteCfg {
  name: string;
  enabled: boolean;
  kinds: string[];
  severities: string[];
  workflows: string[];
  processes: string[];
  actions: string[];
  to: string;
}
interface KindInfo {
  kind: string;
  severity: string;
  group?: string;
  label?: string;
  labelEn?: string;
  optIn?: boolean;
}

// Alarmarten sind dynamisch (der Server nennt sie): bekannte Arten werden übersetzt, neue zeigen den Text des Servers.
function kindLabel(k: KindInfo): string {
  const key = `amail.kind.${k.kind}`;
  const v = tLoose(key);
  if (v !== key) return v;
  return (getLang() === "en" ? k.labelEn : k.label) || k.label || k.kind;
}
function groupLabel(g: string): string {
  const key = `amail.group.${g}`;
  const v = tLoose(key);
  return v === key ? g : v;
}
const SEVERITIES = ["critical", "warning", "info"];

interface MailCfg {
  enabled: boolean;
  host: string;
  port: number;
  security: string;
  user: string;
  password?: string;
  hasPassword: boolean;
  from: string;
  to: string;
  routes: RouteCfg[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

class AlertMailPanel extends HTMLElement {
  #cfg: MailCfg = { enabled: false, host: "", port: 0, security: "starttls", user: "", hasPassword: false, from: "", to: "", routes: [] };
  #kinds: KindInfo[] = [];
  #workflows: { id: string; name: string }[] = [];
  #processes: { id: string; name: string }[] = [];
  #actions: string[] = [];
  #source = "none";
  #stored = false;
  #msg = "";
  #err = "";
  #busy = false;
  #loaded = false;
  #lastRecipients: string[] = [];

  connectedCallback() {
    this.style.cssText = "display:block;margin-bottom:28px;";
    if (this.#loaded) return;
    this.#loaded = true;
    void this.#load();
  }

  async #load() {
    try {
      const res = await apiFetch("/api/v1/admin/settings/alert-mail");
      if (res.ok) {
        const d = (await res.json()) as { config: MailCfg; stored: boolean; source: string; kinds: KindInfo[]; actions?: string[] };
        this.#actions = d.actions ?? [];
        this.#cfg = { ...d.config, routes: d.config.routes ?? [] };
        this.#kinds = d.kinds ?? [];
        this.#stored = d.stored;
        this.#source = d.source;
        for (const r of this.#cfg.routes) {
          r.workflows ??= [];
          r.processes ??= [];
          r.actions ??= [];
        }
      } else if (res.status !== 501) this.#err = t("amail.loadFailed");
      const wr = await apiFetch("/api/v1/workflows");
      const pr = await apiFetch("/api/v1/process-definitions");
      if (pr.ok) {
        const list = (await pr.json()) as { id: string; name: string }[];
        this.#processes = list.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
      }
      if (wr.ok) {
        const list = (await wr.json()) as { id: string; name: string; definition?: { title?: string } }[];
        this.#workflows = list.map((w) => ({ id: w.id, name: w.definition?.title || w.name })).sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch {
      this.#err = t("amail.loadFailed");
    }
    this.#render();
  }

  async #send(method: string, url: string, body?: unknown): Promise<boolean> {
    this.#busy = true;
    this.#err = "";
    this.#msg = "";
    this.#render();
    try {
      const res = await apiFetch(url, {
        method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        this.#err = (await res.text()).trim() || `HTTP ${res.status}`;
        return false;
      }
      try {
        const d = (await res.clone().json()) as { recipients?: string[] };
        this.#lastRecipients = d.recipients ?? [];
      } catch {
        this.#lastRecipients = [];
      }
      return true;
    } catch (e) {
      this.#err = String(e);
      return false;
    } finally {
      this.#busy = false;
    }
  }

  #render() {
    this.replaceChildren();
    this.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px;", t("amail.title")));
    this.append(el("div", "color:var(--omp-text-dim);max-width:900px;margin-bottom:8px;", t("amail.intro")));
    this.append(el("div", "font-size:12px;color:var(--omp-text-dim);margin-bottom:8px;", t(`amail.source.${this.#source}` as "amail.source.ui")));
    if (this.#err) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:8px;white-space:pre-wrap;", this.#err));
    if (this.#msg) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:8px;", this.#msg));

    const c = this.#cfg;
    const grid = el("div", "display:grid;grid-template-columns:220px minmax(220px,360px);gap:6px 12px;align-items:center;max-width:640px;");
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    const add = (key: string, label: string, ctl: HTMLInputElement | HTMLSelectElement) => {
      ctl.style.cssText = "width:100%;box-sizing:border-box;padding:3px 6px;";
      inputs[key] = ctl;
      grid.append(el("label", "", label), ctl);
    };
    const text = (v: string, type = "text") => {
      const i = el("input");
      i.type = type;
      i.value = v;
      return i;
    };
    const enabled = el("input");
    enabled.type = "checkbox";
    enabled.checked = c.enabled;
    grid.append(el("label", "", t("amail.enabled")), enabled);
    const hostIn = text(c.host);
    add("host", t("amail.host"), hostIn);
    // Ohne gespeicherte Einstellung ist die Aktivierung aus; wer einen Server einträgt, will sie meist an.
    let touched = this.#stored;
    enabled.addEventListener("change", () => touched = true);
    hostIn.addEventListener("input", () => {
      if (!touched) enabled.checked = hostIn.value.trim() !== "";
    });
    add("port", t("amail.port"), text(c.port ? String(c.port) : "", "number"));
    const sec = el("select");
    for (const s of ["starttls", "tls", "none"]) {
      const o = el("option", "", t(`amail.sec.${s}` as "amail.sec.tls"));
      o.value = s;
      o.selected = s === c.security;
      sec.append(o);
    }
    add("security", t("amail.security"), sec);
    add("user", t("amail.user"), text(c.user));
    const pw = text("", "password");
    pw.autocomplete = "new-password";
    pw.placeholder = c.hasPassword ? t("amail.passwordSet") : "";
    add("password", t("amail.password"), pw);
    add("from", t("amail.from"), text(c.from));
    add("to", t("amail.to"), text(c.to));
    this.append(grid);
    const routesBox = el("div", "margin-top:16px;max-width:900px;");
    this.append(routesBox);

    const read = (): MailCfg => ({
      enabled: enabled.checked,
      host: inputs.host.value.trim(),
      port: Number(inputs.port.value) || 0,
      security: inputs.security.value,
      user: inputs.user.value.trim(),
      password: inputs.password.value,
      hasPassword: c.hasPassword,
      from: inputs.from.value.trim(),
      to: inputs.to.value.trim(),
      routes: this.#cfg.routes,
    });
    // Eingaben der Regel-Karten werden direkt in this.#cfg.routes geschrieben (siehe #renderRoutes).
    this.#renderRoutes(routesBox, () => {
      this.#cfg = read();
      this.#render();
    });
    const bar = el("div", "display:flex;gap:8px;margin-top:10px;");
    const BTN = "padding:3px 10px;font-size:var(--omp-font-size-sm);cursor:pointer;";
    const save = el("button", BTN, t("amail.save"));
    save.className = "omp-btn-primary";
    const test = el("button", BTN, t("amail.test"));
    const testKind = el("select", "padding:3px;");
    const direct = el("option", "", t("amail.testDirect"));
    direct.value = "";
    testKind.append(direct);
    for (const k of this.#kinds) {
      const o = el("option", "", kindLabel(k));
      o.value = k.kind;
      testKind.append(o);
    }
    const testSev = el("select", "padding:3px;");
    for (const v of ["", ...SEVERITIES]) {
      const o = el("option", "", v ? t(`amail.sev.${v}` as "amail.sev.critical") : t("amail.testSevDefault"));
      o.value = v;
      testSev.append(o);
    }
    const testWf = el("select", "padding:3px;");
    const noWf = el("option", "", t("amail.testNoWorkflow"));
    noWf.value = "";
    testWf.append(noWf);
    for (const w of this.#workflows) {
      const o = el("option", "", w.name);
      o.value = w.id;
      testWf.append(o);
    }
    const testProc = el("select", "padding:3px;");
    const noProc = el("option", "", t("amail.testNoProcess"));
    noProc.value = "";
    testProc.append(noProc);
    for (const p of this.#processes) {
      const o = el("option", "", p.name);
      o.value = p.id;
      testProc.append(o);
    }
    const testAct = el("input", "padding:3px 6px;");
    testAct.placeholder = t("amail.testAction");
    testAct.setAttribute("list", "amail-actions");
    const actList = el("datalist");
    actList.id = "amail-actions";
    for (const a of this.#actions) actList.append(Object.assign(el("option"), { value: a }));
    testSev.style.display = testWf.style.display = testProc.style.display = testAct.style.display = "none";
    testKind.addEventListener("change", () => {
      testSev.style.display = testWf.style.display = testProc.style.display = testKind.value ? "" : "none";
      testAct.style.display = testKind.value === "user-action" ? "" : "none";
    });
    const reset = el("button", BTN, t("amail.reset"));
    save.disabled = test.disabled = this.#busy;
    reset.disabled = this.#busy || !this.#stored;
    save.addEventListener("click", async () => {
      const v = read();
      if (await this.#send("PUT", "/api/v1/admin/settings/alert-mail", v)) this.#msg = t("amail.saved");
      await this.#load();
    });
    test.addEventListener("click", async () => {
      const v = read();
      const ok = await this.#send("POST", "/api/v1/admin/settings/alert-mail/test", { ...v, testKind: testKind.value, testSeverity: testSev.value, testWorkflow: testWf.value, testProcess: testProc.value, testAction: testAct.value.trim() });
      if (ok) this.#msg = this.#lastRecipients.length ? t("amail.testSentTo", { p0: this.#lastRecipients.join(", ") }) : t("amail.testNobody");
      this.#cfg = { ...v, password: "" };
      this.#render();
    });
    reset.addEventListener("click", async () => {
      if (!await confirmDialog(t("amail.confirmRemove"), { confirmLabel: t("kit.ok") })) return;
      if (await this.#send("DELETE", "/api/v1/admin/settings/alert-mail")) this.#msg = t("amail.removed");
      await this.#load();
    });
    bar.append(save, test, testKind, testSev, testWf, testProc, testAct, actList, reset);
    bar.style.flexWrap = "wrap";
    bar.style.alignItems = "center";
    this.append(bar);
  }

  #renderRoutes(box: HTMLElement, redraw: () => void) {
    box.append(el("div", "font-weight:600;margin-bottom:4px;", t("amail.routes.title")));
    box.append(el("div", "font-size:12px;color:var(--omp-text-dim);margin-bottom:8px;", t("amail.routes.help")));
    const routes = this.#cfg.routes;
    if (routes.length === 0) box.append(el("div", "color:var(--omp-text-dim);margin-bottom:8px;", t("amail.routes.none")));
    const toggle = (list: string[], v: string, on: boolean) => {
      const i = list.indexOf(v);
      if (on && i < 0) list.push(v);
      if (!on && i >= 0) list.splice(i, 1);
    };
    routes.forEach((r, idx) => {
      const card = el("div", "border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:8px 10px;margin-bottom:8px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center;");
      const on = el("input");
      on.type = "checkbox";
      on.checked = r.enabled;
      on.title = t("amail.route.enabled");
      on.addEventListener("change", () => r.enabled = on.checked);
      const name = el("input", "padding:3px 6px;");
      name.placeholder = t("amail.route.name");
      name.value = r.name;
      name.addEventListener("input", () => r.name = name.value);
      card.append(on, name);

      card.append(el("span", "font-size:12px;", t("amail.route.sev")));
      const sevRow = el("div", "display:flex;gap:14px;flex-wrap:wrap;");
      for (const sv of SEVERITIES) {
        const lab = el("label", "display:flex;gap:4px;align-items:center;");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = r.severities.includes(sv);
        cb.addEventListener("change", () => toggle(r.severities, sv, cb.checked));
        lab.append(cb, t(`amail.sev.${sv}` as "amail.sev.critical"));
        sevRow.append(lab);
      }
      card.append(sevRow);

      card.append(el("span", "font-size:12px;", t("amail.route.kinds")));
      const det = el("details", "");
      const sum = el("summary", "cursor:pointer;", r.kinds.length ? t("amail.route.kindsN", { p0: r.kinds.length }) : t("amail.route.kindsAll"));
      det.append(sum);
      const knownKinds = new Set(this.#kinds.map((k) => k.kind));
      const all: KindInfo[] = [...this.#kinds, ...r.kinds.filter((x) => !knownKinds.has(x)).map((x) => ({ kind: x, severity: "", group: "", label: x }))];
      let lastGroup: string | undefined;
      for (const k of all) {
        if (k.group !== lastGroup) {
          lastGroup = k.group;
          if (k.group) det.append(el("div", "font-size:11px;color:var(--omp-text-dim);margin-top:6px;text-transform:uppercase;", groupLabel(k.group)));
        }
        const lab = el("label", "display:flex;gap:4px;align-items:center;margin-top:2px;");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = r.kinds.includes(k.kind);
        cb.addEventListener("change", () => {
          toggle(r.kinds, k.kind, cb.checked);
          sum.textContent = r.kinds.length ? t("amail.route.kindsN", { p0: r.kinds.length }) : t("amail.route.kindsAll");
        });
        lab.append(cb, `${kindLabel(k)} (${k.kind})${k.optIn ? " — " + t("amail.optIn") : ""}`);
        det.append(lab);
      }
      card.append(det);

      card.append(el("span", "font-size:12px;", t("amail.route.workflows")));
      const wdet = el("details", "");
      const wsum = el("summary", "cursor:pointer;", r.workflows.length ? t("amail.route.workflowsN", { p0: r.workflows.length }) : t("amail.route.workflowsAll"));
      wdet.append(wsum);
      if (this.#workflows.length === 0 && r.workflows.length === 0) wdet.append(el("div", "color:var(--omp-text-dim);", t("amail.route.workflowsNone")));
      const known = new Set(this.#workflows.map((w) => w.id));
      const entries = [...this.#workflows, ...r.workflows.filter((id) => !known.has(id)).map((id) => ({ id, name: t("amail.route.workflowGone", { p0: id }) }))];
      for (const w of entries) {
        const lab = el("label", "display:flex;gap:4px;align-items:center;margin-top:2px;");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = r.workflows.includes(w.id);
        cb.addEventListener("change", () => {
          toggle(r.workflows, w.id, cb.checked);
          wsum.textContent = r.workflows.length ? t("amail.route.workflowsN", { p0: r.workflows.length }) : t("amail.route.workflowsAll");
        });
        lab.append(cb, w.name);
        wdet.append(lab);
      }
      card.append(wdet);

      card.append(el("span", "font-size:12px;", t("amail.route.processes")));
      const pdet = el("details", "");
      const psum = el("summary", "cursor:pointer;", r.processes.length ? t("amail.route.processesN", { p0: r.processes.length }) : t("amail.route.processesAll"));
      pdet.append(psum);
      if (this.#processes.length === 0 && r.processes.length === 0) pdet.append(el("div", "color:var(--omp-text-dim);", t("amail.route.processesNone")));
      const knownP = new Set(this.#processes.map((p) => p.id));
      const pEntries = [...this.#processes, ...r.processes.filter((id) => !knownP.has(id)).map((id) => ({ id, name: t("amail.route.processGone", { p0: id }) }))];
      for (const p of pEntries) {
        const lab = el("label", "display:flex;gap:4px;align-items:center;margin-top:2px;");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = r.processes.includes(p.id);
        cb.addEventListener("change", () => {
          toggle(r.processes, p.id, cb.checked);
          psum.textContent = r.processes.length ? t("amail.route.processesN", { p0: r.processes.length }) : t("amail.route.processesAll");
        });
        lab.append(cb, p.name);
        pdet.append(lab);
      }
      card.append(pdet);

      card.append(el("span", "font-size:12px;", t("amail.route.actions")));
      const actBox = el("div", "");
      const act = el("input", "padding:3px 6px;width:100%;box-sizing:border-box;");
      act.value = r.actions.join(", ");
      act.setAttribute("list", "amail-actions");
      act.addEventListener("input", () => r.actions = act.value.split(/[\s,;]+/).filter(Boolean));
      actBox.append(act, el("div", "font-size:10px;color:var(--omp-text-dim);margin-top:2px;", t("amail.route.actionsHint")));
      card.append(actBox);

      card.append(el("span", "font-size:12px;", t("amail.route.to")));
      const to = el("input", "padding:3px 6px;width:100%;box-sizing:border-box;");
      to.value = r.to;
      to.addEventListener("input", () => r.to = to.value);
      card.append(to);

      const del = el("button", "padding:2px 8px;font-size:var(--omp-font-size-sm);cursor:pointer;grid-column:2;justify-self:start;", t("amail.route.remove"));
      del.addEventListener("click", () => {
        routes.splice(idx, 1);
        redraw();
      });
      card.append(del);
      box.append(card);
    });
    const add = el("button", "padding:3px 10px;font-size:var(--omp-font-size-sm);cursor:pointer;", t("amail.routes.add"));
    add.addEventListener("click", () => {
      routes.push({ name: t("amail.routeDefaultName", { p0: routes.length + 1 }), enabled: true, kinds: [], severities: [], workflows: [], processes: [], actions: [], to: "" });
      redraw();
    });
    box.append(add);
  }
}

customElements.define("omp-alert-mail-panel", AlertMailPanel);
