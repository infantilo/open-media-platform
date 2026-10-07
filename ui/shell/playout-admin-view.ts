// Admin → Playout (Kapitel 27 / P7): Channels (Gruppen, Zeitzone), Trigger-Regeln („wer darf wen
// steuern“) und das Trigger-Protokoll samt Zustellzustand je Ziel (Spec §84, §162, §164, §165).

import { dateLocale, t as tt } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import {
  actualDurationMs, asRunKindText, asRunTone, deviationText, describeSelector, durationText, filterAsRun, groupByCorrelation, startDeviationMs, statusText, statusTone,
  type AsRunRow, type TriggerRecord, type TriggerRule,
} from "./playout-admin-logic.ts";

interface Channel {
  id: string;
  name: string;
  timezone: string;
  group?: string;
  instanceId?: string;
  workflowId?: string;
  role?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const TONE: Record<string, string> = {
  ok: "var(--omp-success,#4a4)", warn: "var(--omp-warn,#b8860b)", bad: "var(--omp-danger,#d33)", neutral: "var(--omp-text-dim)",
};

class PlayoutAdminView extends HTMLElement {
  #channels: Channel[] = [];
  #rules: TriggerRule[] = [];
  #log: TriggerRecord[] = [];
  #error = "";
  #message = "";
  #loaded = false;
  #poll: number | undefined;
  #newChannel = { name: "", group: "", timezone: "UTC" };
  #newRule = { origin: "group:", target: "group:" };
  #asRun: AsRunRow[] = [];
  #asRunChannel = "";
  #asRunKind = "";

  connectedCallback() {
    this.style.cssText = "display:block;";
    if (this.#loaded) this.#render();
    else {
      this.#loaded = true;
      void this.#load();
    }
    this.#poll = window.setInterval(() => void this.#loadLog().then(() => this.#loadAsRun()), 3000);
  }

  disconnectedCallback() {
    if (this.#poll !== undefined) window.clearInterval(this.#poll);
  }

  async #load() {
    try {
      const [c, r] = await Promise.all([apiFetch("/api/v1/playout/channels"), apiFetch("/api/v1/playout/trigger-rules")]);
      if (c.ok) this.#channels = ((await c.json()) as Channel[]) ?? [];
      if (r.ok) this.#rules = ((await r.json()) as TriggerRule[]) ?? [];
    } catch {
      this.#error = tt("pav.a4357f");
    }
    await this.#loadLog(false);
    if (!this.#asRunChannel && this.#channels.length > 0) this.#asRunChannel = this.#channels[0].id;
    await this.#loadAsRun(false);
    this.#render();
  }

  async #loadAsRun(render = true) {
    if (!this.#asRunChannel) return;
    try {
      const res = await apiFetch(`/api/v1/playout/channels/${encodeURIComponent(this.#asRunChannel)}/as-run?limit=200`);
      if (res.ok) this.#asRun = ((await res.json()) as AsRunRow[]) ?? [];
    } catch {
      // nächster Poll
    }
    if (render) this.#renderAsRunOnly();
  }

  async #downloadAsRunCsv() {
    const res = await apiFetch(`/api/v1/playout/channels/${encodeURIComponent(this.#asRunChannel)}/as-run?format=csv&limit=100000`);
    if (!res.ok) {
      this.#error = tt("misc.csvFailed", { p0: res.status });
      this.#render();
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = el("a");
    a.href = url;
    a.download = `as-run-${this.#name(this.#asRunChannel)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async #loadLog(render = true) {
    try {
      const res = await apiFetch("/api/v1/playout/triggers?limit=100");
      if (res.ok) this.#log = ((await res.json()) as TriggerRecord[]) ?? [];
    } catch {
      // nächster Poll
    }
    if (render) this.#renderLogOnly();
  }

  #name(id: string): string {
    return this.#channels.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  }

  async #send(url: string, method: string, body?: unknown): Promise<boolean> {
    this.#error = "";
    this.#message = "";
    try {
      const res = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) {
        this.#error = (await res.text()).trim() || tt("pav.435a5a", { p0: res.status });
        return false;
      }
      return true;
    } catch (err) {
      this.#error = tt("pav.473549", { p0: err });
      return false;
    }
  }

  async #createChannel() {
    const n = this.#newChannel;
    if (await this.#send("/api/v1/playout/channels", "POST", { name: n.name.trim(), group: n.group.trim(), timezone: n.timezone.trim() || "UTC" })) {
      this.#message = tt("pav.b180cc", { p0: n.name });
      this.#newChannel = { name: "", group: "", timezone: n.timezone };
    }
    await this.#load();
  }

  async #saveGroup(c: Channel, group: string) {
    if (await this.#send(`/api/v1/playout/channels/${encodeURIComponent(c.id)}`, "PUT", {
      name: c.name, timezone: c.timezone, group: group.trim(), instanceId: c.instanceId ?? "", workflowId: c.workflowId ?? "", role: c.role ?? "",
    })) this.#message = tt("pav.2980d5", { p0: c.name });
    await this.#load();
  }

  async #deleteChannel(c: Channel) {
    if (!(await confirmDialog(tt("pav.da33c5", { p0: c.name }), { confirmLabel: tt("pav.1010b0") }))) return;
    if (await this.#send(`/api/v1/playout/channels/${encodeURIComponent(c.id)}`, "DELETE")) this.#message = tt("pav.06f2bf", { p0: c.name });
    await this.#load();
  }

  async #addRule() {
    if (await this.#send("/api/v1/playout/trigger-rules", "POST", this.#newRule)) this.#message = tt("pav.f75079");
    await this.#load();
  }

  async #deleteRule(r: TriggerRule) {
    if (await this.#send(`/api/v1/playout/trigger-rules/${encodeURIComponent(r.id)}`, "DELETE")) this.#message = tt("pav.9d34e3");
    await this.#load();
  }

  #render() {
    this.replaceChildren();
    this.append(el("div", "", tt("pav.b973c2")));
    (this.firstChild as HTMLElement).className = "omp-h1";
    this.append(el("div", "color:var(--omp-text-dim);max-width:900px;margin:6px 0 12px;",
      tt("pav.96cf1f") +
        tt("pav.d16169") +
        tt("pav.6d1443")));
    if (this.#error) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:8px;white-space:pre-wrap;", this.#error));
    if (this.#message) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:8px;", this.#message));
    this.append(this.#renderChannels(), this.#renderRules());
    const logBox = el("div", "margin-bottom:24px;");
    logBox.dataset.role = "trigger-log";
    this.append(logBox);
    this.#renderLogOnly();
    const asRunBox = el("div", "margin-bottom:24px;");
    asRunBox.dataset.role = "as-run";
    this.append(asRunBox);
    this.#renderAsRunOnly();
  }

  #renderAsRunOnly() {
    const box = this.querySelector<HTMLElement>('[data-role="as-run"]');
    if (!box) return;
    box.replaceChildren(el("div", "font-weight:600;font-size:15px;margin-bottom:2px;", "As-Run-Protokoll"));
    box.append(el("div", "color:var(--omp-text-dim);font-size:12px;margin-bottom:6px;max-width:900px;",
      tt("pav.544226") +
        tt("pav.bcfd43")));
    if (this.#channels.length === 0) {
      box.append(el("div", "color:var(--omp-text-dim);", tt("pav.dab143")));
      return;
    }
    const bar = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;");
    const ch = el("select", "padding:3px 6px;");
    for (const c of this.#channels) {
      const o = el("option", "", c.name);
      o.value = c.id;
      ch.append(o);
    }
    ch.value = this.#asRunChannel;
    ch.addEventListener("change", () => {
      this.#asRunChannel = ch.value;
      this.#asRun = [];
      void this.#loadAsRun();
    });
    const kind = el("select", "padding:3px 6px;");
    for (const [v, l] of [["", tt("pav.05e8d1")], ["primary", tt("pav.87f9f7")], ["child", tt("pav.0b3acd")], ["warning", tt("pav.5e2ce9")], ["trigger", tt("pav.f698f6")], ["operator", tt("pav.eb2ead")]]) {
      const o = el("option", "", l);
      o.value = v;
      kind.append(o);
    }
    kind.value = this.#asRunKind;
    kind.addEventListener("change", () => {
      this.#asRunKind = kind.value;
      this.#renderAsRunOnly();
    });
    const csv = el("button", "padding:3px 10px;", "CSV exportieren");
    csv.addEventListener("click", () => void this.#downloadAsRunCsv());
    bar.append(ch, kind, csv);
    box.append(bar);
    const rows = filterAsRun(this.#asRun, this.#asRunKind);
    if (rows.length === 0) {
      box.append(el("div", "color:var(--omp-text-dim);", tt("pav.3f3511")));
      return;
    }
    const t = el("table", "border-collapse:collapse;font-size:12px;");
    const hr = el("tr", "color:var(--omp-text-dim);text-align:left;");
    for (const h of [tt("pav.718271"), "Art", tt("pav.6e2ee1"), tt("pav.966bf3"), tt("pav.23cced"), tt("pav.5daac8"), tt("pav.7f2ec6")]) hr.append(el("th", "padding:3px 12px 3px 0;", h));
    t.append(hr);
    const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(dateLocale()) : "—");
    for (const r of rows) {
      const tr = el("tr", "border-top:1px solid rgba(255,255,255,0.06);");
      const cell = (text: string, css = "") => el("td", `padding:3px 12px 3px 0;${css}`, text);
      const status = r.kind === "operator" ? `${r.operator ?? "?"}: ${r.action ?? ""}` : [r.status, r.reason].filter(Boolean).join(" — ");
      tr.append(
        cell(time(r.recordedAt), "color:var(--omp-text-dim);white-space:nowrap;"),
        cell(asRunKindText(r.kind)),
        cell(r.label || r.childId || ""),
        cell([r.source, r.asset].filter(Boolean).join(" · "), "color:var(--omp-text-dim);"),
        cell(r.actualStart ? `${time(r.actualStart)} (${deviationText(startDeviationMs(r))})` : "", "white-space:nowrap;"),
        cell(r.actualEnd ? durationText(actualDurationMs(r)) : ""),
        cell(status, `color:${TONE[asRunTone(r)]};`),
      );
      t.append(tr);
    }
    box.append(t);
  }

  #renderChannels(): HTMLElement {
    const sec = el("div", "margin-bottom:24px;");
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px;", tt("pav.14cb42")));
    if (this.#channels.length > 0) {
      const t = el("table", "border-collapse:collapse;font-size:12px;margin-bottom:10px;");
      const hr = el("tr", "color:var(--omp-text-dim);text-align:left;");
      for (const h of [tt("pav.49ee30"), tt("pav.3b77a5"), tt("pav.01f001"), tt("pav.e9b5bb"), ""]) hr.append(el("th", "padding:3px 12px 3px 0;", h));
      t.append(hr);
      for (const c of this.#channels) {
        const tr = el("tr", "border-top:1px solid rgba(255,255,255,0.06);");
        const group = el("input", "padding:2px 6px;width:120px;");
        group.value = c.group ?? "";
        group.placeholder = tt("pav.4e17d8");
        const save = el("button", "padding:2px 8px;margin-left:4px;", tt("pav.b97d23"));
        save.addEventListener("click", () => void this.#saveGroup(c, group.value));
        const gcell = el("td", "padding:3px 12px 3px 0;white-space:nowrap;");
        gcell.append(group, save);
        const bind = c.workflowId ? tt("pav.add50d", { p0: c.role }) : c.instanceId ? tt("pav.50c3a7") : tt("pav.5423b1");
        const del = el("button", "padding:2px 8px;", tt("pav.1010b0"));
        del.className = "omp-btn-danger";
        del.addEventListener("click", () => void this.#deleteChannel(c));
        tr.append(el("td", "padding:3px 12px 3px 0;", c.name), gcell, el("td", "padding:3px 12px 3px 0;color:var(--omp-text-dim);", c.timezone),
          el("td", "padding:3px 12px 3px 0;color:var(--omp-text-dim);", bind), el("td", "", ""));
        tr.lastChild!.appendChild(del);
        t.append(tr);
      }
      sec.append(t);
    } else sec.append(el("div", "color:var(--omp-text-dim);margin-bottom:8px;", tt("pav.0147be")));

    const form = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;");
    const f = (label: string, input: HTMLElement) => {
      const w = el("div", "display:flex;flex-direction:column;gap:2px;");
      w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", label), input);
      return w;
    };
    const name = el("input", "padding:3px 6px;width:150px;");
    name.value = this.#newChannel.name;
    name.addEventListener("input", () => (this.#newChannel.name = name.value));
    const group = el("input", "padding:3px 6px;width:110px;");
    group.value = this.#newChannel.group;
    group.addEventListener("input", () => (this.#newChannel.group = group.value));
    const tz = el("input", "padding:3px 6px;width:130px;");
    tz.value = this.#newChannel.timezone;
    tz.addEventListener("input", () => (this.#newChannel.timezone = tz.value));
    const add = el("button", "padding:4px 12px;", tt("pav.ab25aa"));
    add.className = "omp-btn-primary";
    add.addEventListener("click", () => void this.#createChannel());
    form.append(f(tt("pav.49ee30"), name), f(tt("pav.3b77a5"), group), f(tt("pav.cb8fcc"), tz), add);
    sec.append(form);
    return sec;
  }

  #renderRules(): HTMLElement {
    const sec = el("div", "margin-bottom:24px;");
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px;", tt("pav.1a703c")));
    if (this.#rules.length === 0) sec.append(el("div", "color:var(--omp-text-dim);margin-bottom:8px;", tt("pav.143257")));
    for (const r of this.#rules) {
      const row = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:3px;font-size:12px;");
      const del = el("button", "padding:1px 8px;", tt("pav.513d30"));
      del.addEventListener("click", () => void this.#deleteRule(r));
      row.append(el("span", "", `${describeSelector(r.origin, (id) => this.#name(id))}  →  ${describeSelector(r.target, (id) => this.#name(id))}`), del);
      sec.append(row);
    }
    const form = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px;");
    const sel = (value: string, onChange: (v: string) => void) => {
      const input = el("input", "padding:3px 6px;width:190px;font-family:monospace;");
      input.value = value;
      input.setAttribute("list", "omp-playout-selectors");
      input.addEventListener("input", () => onChange(input.value));
      return input;
    };
    const dl = el("datalist");
    dl.id = "omp-playout-selectors";
    const opts = ["*", ...[...new Set(this.#channels.map((c) => c.group).filter(Boolean))].map((g) => `group:${g}`), ...this.#channels.map((c) => `channel:${c.id}`)];
    for (const o of opts) {
      const op = el("option");
      op.value = o;
      op.label = describeSelector(o, (id) => this.#name(id));
      dl.append(op);
    }
    const f = (label: string, input: HTMLElement) => {
      const w = el("div", "display:flex;flex-direction:column;gap:2px;");
      w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", label), input);
      return w;
    };
    const add = el("button", "padding:4px 12px;", tt("pav.0ab555"));
    add.className = "omp-btn-primary";
    add.addEventListener("click", () => void this.#addRule());
    form.append(dl, f(tt("pav.1063ea"), sel(this.#newRule.origin, (v) => (this.#newRule.origin = v))),
      f(tt("pav.86c51e"), sel(this.#newRule.target, (v) => (this.#newRule.target = v))), add);
    sec.append(form);
    return sec;
  }

  #renderLogOnly() {
    const box = this.querySelector<HTMLElement>('[data-role="trigger-log"]');
    if (!box) return;
    box.replaceChildren(el("div", "font-weight:600;font-size:15px;margin-bottom:6px;", tt("pav.d4b874")));
    if (this.#log.length === 0) {
      box.append(el("div", "color:var(--omp-text-dim);", tt("pav.0ceb35")));
      return;
    }
    for (const g of groupByCorrelation(this.#log)) {
      const card = el("div", "margin-bottom:8px;padding:6px 10px;border:1px solid rgba(255,255,255,0.08);border-radius:var(--omp-radius);font-size:12px;");
      card.append(el("div", "font-weight:600;", tt("pav.53fc17", { p0: g.event, p1: this.#name(g.origin), p2: new Date(g.at).toLocaleString(dateLocale()) })));
      for (const r of g.items) {
        const line = el("div", `color:${TONE[statusTone(r.status)]};padding-left:12px;`,
          `→ ${this.#name(r.targetChannel)} (#${r.seq}): ${statusText(r.status)}${r.detail ? ` — ${r.detail}` : ""}${r.attempts > 1 ? tt("y.attempts", { p0: r.attempts }) : ""}`);
        card.append(line);
      }
      box.append(card);
    }
  }
}

customElements.define("omp-playout-admin", PlayoutAdminView);
