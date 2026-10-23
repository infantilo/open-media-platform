// <omp-jobs-view> — ffmpeg-Jobs (Kapitel 52, docs/ENTWURF-FFMPEG-HOSTWAHL.md): Hosts mit Last und Live-Reserve, laufende/wartende/
// beendete Jobs mit „Warum dort?“, Testjob und die Einstellungen (Standardziel, Live-Reserve, Sendeschutz, Gewichte, Hosts,
// Pfadzuordnung). Einstellungen werden explizit gespeichert und vom Poll nicht überschrieben.
import { apiFetch, confirmDialog, features, showToast, t } from "../host.ts";
import { hasFeature } from "../../kit/features.ts";
import { fmtDuration, fromPercent, loadLevel, pathMapFromRows, pathRows, targetOptions, toPercent, type HostInfo, type PathRow } from "./jobs-logic.ts";

interface Candidate { host: string; label?: string; score?: number; parts?: Record<string, number>; rejected?: string }
interface Decision { target: string; host?: string; reason?: string; candidates: Candidate[] }
interface JobEvent { at: string; kind: string; detail?: string }
interface Job {
  id: string; state: string; host?: string; attempt: number; created: string; started?: string; finished?: string;
  exitCode: number; error?: string; progress?: string; paused?: boolean; wait?: string; placement?: Decision; events?: JobEvent[];
  spec: { caller: string; tool: string; class?: string; target?: string; label?: string; args?: string[] };
}
interface HostOpts { reserve?: Reserve; enabled?: boolean; maxJobs?: number; batchOnly?: boolean; noBatch?: boolean; pools?: string[]; nice?: number }
interface Share { now: number; p95: number; peak: number }
interface Reserve { cpu: number; mem: number; gpu: number; net: number }
interface Cal {
  host: string; label?: string; enough: boolean; spanH: number; reason: string; cpu: Share; mem: Share; gpu?: Share;
  suggested: Reserve; applied: Reserve; source: "config" | "auto" | "host";
}
interface NodeTypical { nodeType: string; cpuAvg: number; cpuP95: number; cpuMax: number; rssAvgMb: number; rssMaxMb: number; samples: number }
interface CalResp { mode: string; hosts: Cal[]; nodes: Record<string, NodeTypical[]> }
interface CalCfg { mode: string; margin: number; min: number; max: number; peakWeight: number; minHours: number; windowDays: number }
interface Cfg {
  calibration: CalCfg;
  defaultTarget: string; defaults?: Record<string, string>; fallbackLocal: boolean; maxWaitS: number; maxAttempts: number; lookaheadMin: number;
  liveHostPolicy: string; batchSoftFraction: number;
  weights: Record<string, number>; liveReserve: Record<string, number>;
  protect: { enabled: boolean; throttleAt: number; pauseAt: number; cancelAt: number; resumeAt: number; maxPauseS: number; intervalS: number };
  local: HostOpts; hosts?: Record<string, HostOpts>; pathMap?: Record<string, Record<string, string>>;
}

const CALLERS = ["script", "qc", "proxy", "convert"] as const;
const POLL_MS = 3000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}
const CARD = "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:12px;margin-bottom:12px;";
const H = "font-size:var(--omp-font-size-md);margin:0 0 8px;font-weight:600;";
const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);";
const INPUT = "background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 6px;font:inherit;";
const TH = "text-align:left;padding:4px 8px;font-weight:600;border-bottom:1px solid var(--omp-border);white-space:nowrap;";
const TD = "padding:4px 8px;border-bottom:1px solid var(--omp-border);vertical-align:top;";
const STATE_COLOR: Record<string, string> = { running: "var(--omp-accent-cyan)", queued: "var(--omp-text-dim)", done: "var(--omp-ok, #3a3)", failed: "var(--omp-danger, #d44)", cancelled: "var(--omp-text-dim)" };

function bar(value: number, limit: number, label: string): HTMLElement {
  const wrap = el("div", "min-width:90px;");
  const track = el("div", "height:8px;background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:4px;position:relative;overflow:hidden;");
  const lvl = loadLevel(value, limit);
  const color = lvl === "full" ? "var(--omp-danger, #d44)" : lvl === "warn" ? "var(--omp-warn, #db3)" : "var(--omp-accent-cyan)";
  track.append(el("div", `height:100%;width:${Math.max(0, Math.min(100, value))}%;background:${color};`));
  if (limit > 0 && limit < 100) track.append(el("div", `position:absolute;top:0;bottom:0;left:${limit}%;width:2px;background:var(--omp-text);opacity:0.7;`));
  wrap.append(track, el("div", DIM, label));
  return wrap;
}

export class JobsView extends HTMLElement {
  #timer?: number;
  #hosts: HostInfo[] = [];
  #pools: string[] = [];
  #limit = { batch: 56, scheduled: 63, interactive: 70 };
  #jobs: Job[] = [];
  #running = 0;
  #waiting = 0;
  #filter: "all" | "active" | "finished" = "active";
  #open = new Set<string>();
  #cfg: Cfg | null = null;
  #canConfigure = false;
  #live!: HTMLDivElement;
  #settings!: HTMLDivElement;
  #testTarget = "auto";
  #preview: Decision | null = null; // Ergebnis von „Nur Auswahl zeigen“ — überlebt das Neuzeichnen durch den Poll
  #rows: PathRow[] = [];
  #cal: CalResp | null = null;
  #calTick = 0;

  connectedCallback() {
    this.style.cssText = "display:block;padding:var(--omp-space-3);overflow:auto;height:100%;box-sizing:border-box;color:var(--omp-text);background:var(--omp-bg);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);";
    this.#live = el("div");
    this.#settings = el("div");
    this.append(this.#live, this.#settings);
    void features().then((f) => {
      this.#canConfigure = hasFeature(f, "jobs.configure");
      void this.#loadConfig();
    });
    void this.#poll();
    this.#timer = window.setInterval(() => void this.#poll(), POLL_MS);
  }

  disconnectedCallback() {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  async #get<T>(url: string): Promise<T | null> {
    try {
      const r = await apiFetch(url);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async #poll() {
    const [hosts, jobs] = await Promise.all([
      this.#get<{ hosts: HostInfo[]; pools: string[]; limitCpu: { batch: number; scheduled: number; interactive: number } }>("/api/v1/jobs/hosts"),
      this.#get<{ jobs: Job[]; running: number; waiting: number }>("/api/v1/jobs"),
    ]);
    if (hosts) {
      this.#hosts = hosts.hosts ?? [];
      this.#pools = hosts.pools ?? [];
      this.#limit = hosts.limitCpu ?? this.#limit;
    }
    if (this.#calTick++ % 5 === 0) this.#cal = await this.#get<CalResp>("/api/v1/jobs/calibration");
    if (jobs) {
      this.#jobs = jobs.jobs ?? [];
      this.#running = jobs.running;
      this.#waiting = jobs.waiting;
    }
    this.#renderLive();
  }

  #renderLive() {
    // offene Detailzeilen und Fokus bleiben erhalten, weil nur dieser Bereich neu gezeichnet wird
    const sel = this.#live.querySelector<HTMLSelectElement>("[data-role=test-target]");
    if (sel) this.#testTarget = sel.value;
    const root = el("div");
    root.append(el("h2", "font-size:var(--omp-font-size-lg);margin:0 0 4px;", t("jobsv.title")), el("div", DIM + "margin-bottom:12px;", t("jobsv.intro")));
    root.append(this.#hostsCard(), this.#calCard(), this.#jobsCard(), this.#testCard());
    this.#live.replaceChildren(root);
  }

  #hostsCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("h3", H, t("jobsv.hosts")));
    if (this.#hosts.length === 0) {
      card.append(el("div", DIM, t("jobsv.noHosts")));
      return card;
    }
    const tbl = el("table", "border-collapse:collapse;width:100%;");
    const head = el("tr");
    for (const k of ["host", "state", "cpu", "mem", "gpu", "jobs", "live", "flags"]) head.append(el("th", TH, t(`jobsv.col.${k}`)));
    tbl.append(head);
    for (const h of this.#hosts) {
      const tr = el("tr");
      tr.append(el("td", TD + "font-weight:600;", h.Local ? t("jobsv.local") : h.Label || h.ID));
      const state = !h.Online ? t("jobsv.offline") : h.Maintenance ? t("jobsv.maintenance") : !h.Capable ? t("jobsv.notCapable") : t("jobsv.online");
      tr.append(el("td", TD + (h.Online && h.Capable && !h.Maintenance ? "" : "color:var(--omp-text-dim);"), state));
      const cpu = el("td", TD);
      cpu.append(bar(h.CPUPercent, this.#limit.batch, `${Math.round(h.CPUPercent)} %`));
      cpu.title = t("jobsv.limitHint", { p0: Math.round(this.#limit.interactive) });
      tr.append(cpu);
      const mem = el("td", TD);
      mem.append(bar(h.MemUsedPct, 0, `${Math.round(h.MemUsedPct)} %`));
      tr.append(mem);
      const gpu = el("td", TD);
      if (h.Gpu) gpu.append(bar(h.Gpu.UtilPercent, 0, `${Math.round(h.Gpu.UtilPercent)} %`));
      else gpu.append(el("span", DIM, "–"));
      tr.append(gpu);
      tr.append(el("td", TD, `${h.Running + h.Reserved}${h.MaxJobs > 0 ? " / " + h.MaxJobs : ""}`));
      tr.append(el("td", TD, String(h.LiveInstances)));
      const flags = [h.Disabled ? t("jobsv.disabled") : "", h.BatchOnly ? t("jobsv.batchOnly") : "", h.NoBatch ? t("jobsv.noBatch") : "", ...(h.Pools ?? []).map((p) => `pool:${p}`)].filter(Boolean);
      tr.append(el("td", TD + DIM, flags.join(", ")));
      tbl.append(tr);
    }
    card.append(tbl, el("div", DIM + "margin-top:6px;", t("jobsv.limitHint", { p0: Math.round(this.#limit.batch) })));
    return card;
  }

  // Live-Reserve: gemessener Live-Bedarf je Host (ohne die Last der Jobs), Vorschlag, geltende Reserve und typische Last je Node-Typ.
  #calCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("h3", H, t("jobsv.cal.title")), el("div", DIM + "margin-bottom:6px;", t("jobsv.cal.intro")));
    const cal = this.#cal;
    if (!cal || cal.hosts.length === 0) {
      card.append(el("div", DIM, t("jobsv.cal.none")));
      return card;
    }
    card.append(el("div", DIM + "margin-bottom:6px;", t(cal.mode === "auto" ? "jobsv.cal.modeAuto" : "jobsv.cal.modeManual")));
    const pct = (f: number) => `${Math.round(f * 100)} %`;
    const tbl = el("table", "border-collapse:collapse;width:100%;");
    const hr = el("tr");
    for (const k of ["host", "span", "cpu", "mem", "gpu", "suggested", "applied"]) hr.append(el("th", TH, t(`jobsv.cal.col.${k}`)));
    hr.append(el("th", TH));
    tbl.append(hr);
    for (const c of cal.hosts) {
      const tr = el("tr", "cursor:pointer;");
      tr.addEventListener("click", () => { if (this.#open.has("cal:" + c.host)) this.#open.delete("cal:" + c.host); else this.#open.add("cal:" + c.host); this.#renderLive(); });
      tr.append(el("td", TD + "font-weight:600;", c.host === "local" ? t("jobsv.local") : c.label || c.host));
      tr.append(el("td", TD, c.reason === "no-data" ? t("jobsv.cal.noData") : `${c.spanH.toFixed(1)} h`));
      const share = (s?: Share) => (s && c.reason !== "no-data" ? `${s.now.toFixed(0)} / ${s.p95.toFixed(0)} / ${s.peak.toFixed(0)} %` : "–");
      tr.append(el("td", TD, share(c.cpu)), el("td", TD, share(c.mem)), el("td", TD, share(c.gpu)));
      tr.append(el("td", TD, c.enough ? `${pct(c.suggested.cpu)} / ${pct(c.suggested.mem)}${c.gpu ? " / " + pct(c.suggested.gpu) : ""}` : t(c.reason === "too-short" ? "jobsv.cal.tooShort" : "jobsv.cal.noData")));
      const ap = el("td", TD);
      ap.append(`${pct(c.applied.cpu)} / ${pct(c.applied.mem)}${c.gpu ? " / " + pct(c.applied.gpu) : ""}`, el("div", DIM, t(`jobsv.cal.source.${c.source}`)));
      tr.append(ap);
      const act = el("td", TD);
      if (this.#canConfigure) {
        if (c.enough && c.source !== "host") {
          const b = el("button", "font-size:var(--omp-font-size-xs);", t("jobsv.cal.apply"));
          b.addEventListener("click", (ev) => { ev.stopPropagation(); void this.#applyCal(c.host); });
          act.append(b);
        }
        if (c.source === "host") {
          const b = el("button", "font-size:var(--omp-font-size-xs);", t("jobsv.cal.clear"));
          b.addEventListener("click", (ev) => { ev.stopPropagation(); void this.#clearCal(c.host); });
          act.append(b);
        }
      }
      tr.append(act);
      tbl.append(tr);
      if (this.#open.has("cal:" + c.host)) {
        const dr = el("tr");
        const td = el("td", TD + "background:var(--omp-bg);");
        td.colSpan = 8;
        const nodes = cal.nodes[c.host] ?? [];
        td.append(el("div", "font-weight:600;margin-bottom:4px;", t("jobsv.cal.typical")));
        if (nodes.length === 0) td.append(el("div", DIM, t("jobsv.cal.noProfiles")));
        else {
          const nt = el("table", "border-collapse:collapse;");
          const nh = el("tr");
          for (const k of ["type", "cpuAvg", "cpuP95", "cpuMax", "ram", "samples"]) nh.append(el("th", TH, t(`jobsv.cal.node.${k}`)));
          nt.append(nh);
          for (const n of nodes.slice(0, 12)) {
            const r = el("tr");
            for (const v of [n.nodeType, `${n.cpuAvg.toFixed(0)} %`, `${n.cpuP95.toFixed(0)} %`, `${n.cpuMax.toFixed(0)} %`, `${n.rssAvgMb.toFixed(0)} / ${n.rssMaxMb.toFixed(0)} MB`, String(n.samples)]) r.append(el("td", TD, v));
            nt.append(r);
          }
          td.append(nt, el("div", DIM + "margin-top:4px;", t("jobsv.cal.typicalHint")));
        }
        dr.append(td);
        tbl.append(dr);
      }
    }
    card.append(tbl, el("div", DIM + "margin-top:6px;", t("jobsv.cal.legend")));
    return card;
  }

  async #applyCal(host: string) {
    const r = await apiFetch("/api/v1/jobs/calibration/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host }) });
    if (!r.ok) showToast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
    else showToast(t("jobsv.saved"));
    await this.#loadConfig();
    this.#calTick = 0;
    void this.#poll();
  }

  async #clearCal(host: string) {
    const cfg = await this.#get<Cfg>("/api/v1/jobs/config");
    if (!cfg) return;
    if (host === "local") delete cfg.local.reserve;
    else if (cfg.hosts?.[host]) delete cfg.hosts[host].reserve;
    const r = await apiFetch("/api/v1/jobs/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });
    if (!r.ok) showToast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
    await this.#loadConfig();
    this.#calTick = 0;
    void this.#poll();
  }

  #jobsCard(): HTMLElement {
    const card = el("div", CARD);
    const head = el("div", "display:flex;gap:12px;align-items:center;margin-bottom:8px;");
    head.append(el("h3", H + "margin:0;", t("jobsv.jobs")), el("span", DIM, `${t("jobsv.running", { p0: this.#running })} · ${t("jobsv.waiting", { p0: this.#waiting })}`));
    const filt = el("span", "margin-left:auto;display:flex;gap:4px;");
    for (const f of ["active", "finished", "all"] as const) {
      const b = el("button", "font-size:var(--omp-font-size-xs);" + (this.#filter === f ? "background:var(--omp-surface);border-color:var(--omp-accent-cyan);" : ""), t(`jobsv.filter.${f}`));
      b.addEventListener("click", () => { this.#filter = f; this.#renderLive(); });
      filt.append(b);
    }
    head.append(filt);
    card.append(head);
    const list = this.#jobs.filter((j) => this.#filter === "all" || (this.#filter === "active" ? j.state === "queued" || j.state === "running" : j.state !== "queued" && j.state !== "running"));
    if (list.length === 0) {
      card.append(el("div", DIM, t("jobsv.noJobs")));
      return card;
    }
    const tbl = el("table", "border-collapse:collapse;width:100%;");
    const hr = el("tr");
    for (const k of ["id", "caller", "class", "target", "where", "state", "since", "progress"]) hr.append(el("th", TH, t(`jobsv.col.${k}`)));
    hr.append(el("th", TH));
    tbl.append(hr);
    const now = Date.now();
    for (const j of list.slice(0, 100)) {
      const tr = el("tr", "cursor:pointer;");
      tr.addEventListener("click", () => { if (this.#open.has(j.id)) this.#open.delete(j.id); else this.#open.add(j.id); this.#renderLive(); });
      tr.append(el("td", TD + "font-family:monospace;", (j.spec.label || j.id).slice(0, 28)));
      tr.append(el("td", TD, `${j.spec.caller}/${j.spec.tool}`));
      tr.append(el("td", TD, j.spec.class ?? ""));
      tr.append(el("td", TD, j.placement?.target ?? j.spec.target ?? ""));
      tr.append(el("td", TD, this.#hostLabel(j.host)));
      const st = el("td", TD + `color:${STATE_COLOR[j.state] ?? "inherit"};font-weight:600;`, t(`jobsv.state.${j.state}`));
      if (j.paused) st.append(el("div", DIM + "font-weight:400;", t("jobsv.paused")));
      tr.append(st);
      const start = j.started ? new Date(j.started).getTime() : new Date(j.created).getTime();
      const end = j.finished ? new Date(j.finished).getTime() : now;
      tr.append(el("td", TD, fmtDuration((end - start) / 1000)));
      tr.append(el("td", TD + DIM + "max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", j.state === "queued" ? (j.wait ?? "") : j.progress ?? j.error ?? ""));
      const act = el("td", TD);
      if (j.state === "queued" || j.state === "running") {
        const b = el("button", "font-size:var(--omp-font-size-xs);", t("jobsv.cancel"));
        b.addEventListener("click", (ev) => { ev.stopPropagation(); void this.#cancel(j); });
        act.append(b);
      }
      tr.append(act);
      tbl.append(tr);
      if (this.#open.has(j.id)) {
        const dr = el("tr");
        const td = el("td", TD + "background:var(--omp-bg);");
        td.colSpan = 9;
        td.append(this.#detail(j));
        dr.append(td);
        tbl.append(dr);
      }
    }
    card.append(tbl);
    return card;
  }

  #hostLabel(id?: string): string {
    if (!id) return "";
    const h = this.#hosts.find((x) => x.ID === id);
    return h ? (h.Local ? t("jobsv.local") : h.Label || id) : id;
  }

  #detail(j: Job): HTMLElement {
    const box = el("div", "display:grid;gap:8px;");
    if (j.error) box.append(el("div", "color:var(--omp-danger, #d44);", j.error));
    if (j.state === "done") box.append(el("div", DIM, t("jobsv.exit", { p0: j.exitCode })));
    if (j.placement) box.append(this.#decision(j.placement));
    if (j.events?.length) {
      const ev = el("div");
      ev.append(el("div", "font-weight:600;", t("jobsv.history")));
      for (const e of j.events) ev.append(el("div", DIM, `${new Date(e.at).toLocaleTimeString()} · ${e.kind}${e.detail ? " — " + e.detail : ""}`));
      box.append(ev);
    }
    if (j.spec.args?.length) box.append(el("div", DIM + "font-family:monospace;word-break:break-all;", `${j.spec.tool} ${j.spec.args.join(" ")}`));
    return box;
  }

  #decision(d: Decision): HTMLElement {
    const box = el("div");
    box.append(el("div", "font-weight:600;", `${t("jobsv.why")} (${d.target})`));
    if (!d.host && d.reason) box.append(el("div", DIM, d.reason));
    const tbl = el("table", "border-collapse:collapse;");
    for (const c of d.candidates ?? []) {
      const tr = el("tr");
      const chosen = c.host === d.host;
      tr.append(el("td", TD + (chosen ? "font-weight:700;" : ""), (chosen ? "→ " : "") + (c.label || c.host)));
      tr.append(el("td", TD + DIM, c.rejected ? `${t("jobsv.rejected")}: ${c.rejected}` : `${t("jobsv.score")} ${c.score}  ${Object.entries(c.parts ?? {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`));
      tbl.append(tr);
    }
    box.append(tbl);
    return box;
  }

  async #cancel(j: Job) {
    if (!(await confirmDialog(t("jobsv.cancelConfirm", { p0: j.spec.label || j.id })))) return;
    const r = await apiFetch(`/api/v1/jobs/${j.id}`, { method: "DELETE" });
    if (!r.ok) showToast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
    void this.#poll();
  }

  #testCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("h3", H, t("jobsv.test")), el("div", DIM + "margin-bottom:6px;", t("jobsv.testHint")));
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const sel = el("select", INPUT);
    sel.setAttribute("data-role", "test-target");
    for (const o of targetOptions(this.#hosts, this.#pools, this.#testTarget, this.#labels())) sel.append(new Option(o.label, o.value, false, o.value === this.#testTarget));
    const prev = el("button", "", t("jobsv.testPreview"));
    prev.addEventListener("click", async () => {
      this.#testTarget = sel.value;
      const r = await apiFetch("/api/v1/jobs/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "ffmpeg", args: ["-version"], target: sel.value }) });
      this.#preview = r.ok ? ((await r.json()) as Decision) : null;
      this.#renderLive();
    });
    const run = el("button", "", t("jobsv.testRun"));
    run.addEventListener("click", async () => {
      this.#testTarget = sel.value;
      const r = await apiFetch("/api/v1/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "ffmpeg", args: ["-version"], target: sel.value, label: "ffmpeg -version", timeoutS: 60 }) });
      if (r.ok) {
        showToast(t("jobsv.testSubmitted", { p0: ((await r.json()) as { id: string }).id }));
        this.#filter = "all";
        void this.#poll();
      } else showToast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
    });
    row.append(sel, prev, run);
    const pv = el("div", "margin-top:8px;");
    pv.setAttribute("data-role", "preview");
    if (this.#preview) pv.append(this.#decision(this.#preview));
    card.append(row, pv);
    return card;
  }

  #labels() {
    return { auto: t("jobsv.target.auto"), local: t("jobsv.target.local"), host: t("jobsv.target.host"), pool: t("jobsv.target.pool") };
  }

  // --- Einstellungen -----------------------------------------------------------------------------------

  async #loadConfig() {
    this.#cfg = await this.#get<Cfg>("/api/v1/jobs/config");
    this.#rows = pathRows(this.#cfg?.pathMap);
    this.#renderSettings();
  }

  #renderSettings() {
    const cfg = this.#cfg;
    if (!cfg) {
      this.#settings.replaceChildren();
      return;
    }
    const ro = !this.#canConfigure;
    const card = el("div", CARD);
    card.append(el("h3", H, t("jobsv.settings")));
    if (ro) card.append(el("div", DIM + "margin-bottom:8px;", t("jobsv.readOnly")));
    const field = (label: string, input: HTMLElement, help = "") => {
      const row = el("label", "display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:8px;align-items:center;margin:4px 0;");
      row.append(el("span", "", label), input);
      if (help) row.title = help;
      return row;
    };
    const num = (v: number, step = 1, min = 0) => {
      const i = el("input", INPUT + "width:90px;");
      i.type = "number"; i.step = String(step); i.min = String(min); i.value = String(v); i.disabled = ro;
      return i;
    };
    const chk = (v: boolean) => {
      const i = el("input"); i.type = "checkbox"; i.checked = v; i.disabled = ro; return i;
    };
    const targetSel = (cur: string, inherit: boolean) => {
      const s = el("select", INPUT); s.disabled = ro;
      if (inherit) s.append(new Option(t("jobsv.inherit"), "", false, cur === ""));
      for (const o of targetOptions(this.#hosts, this.#pools, cur, this.#labels())) s.append(new Option(o.label, o.value, false, o.value === cur));
      return s;
    };

    const defTarget = targetSel(cfg.defaultTarget, false);
    card.append(field(t("jobsv.defaultTarget"), defTarget, t("jobsv.defaultTargetHelp")), el("div", DIM + "margin:0 0 8px;", t("jobsv.defaultTargetHelp")));
    const callerSel: Record<string, HTMLSelectElement> = {};
    card.append(el("div", "font-weight:600;margin-top:8px;", t("jobsv.callers")));
    for (const c of CALLERS) {
      callerSel[c] = targetSel(cfg.defaults?.[c] ?? "", true);
      card.append(field(t(`jobsv.caller.${c}`), callerSel[c]));
    }
    const fallback = chk(cfg.fallbackLocal);
    const maxWait = num(cfg.maxWaitS), attempts = num(cfg.maxAttempts, 1, 1), look = num(cfg.lookaheadMin);
    const policy = el("select", INPUT); policy.disabled = ro;
    for (const p of ["reserve-only", "interactive-only"]) policy.append(new Option(t(`jobsv.livePolicy.${p}`), p, false, cfg.liveHostPolicy === p));
    card.append(field(t("jobsv.fallbackLocal"), fallback), field(t("jobsv.maxWait"), maxWait), field(t("jobsv.maxAttempts"), attempts), field(t("jobsv.lookahead"), look), field(t("jobsv.livePolicy"), policy));

    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.reserve")));
    const reserve: Record<string, HTMLInputElement> = {};
    for (const k of ["cpu", "mem", "gpu", "net"]) {
      reserve[k] = num(toPercent(cfg.liveReserve[k] ?? 0), 1, 0);
      card.append(field(t(`jobsv.reserve.${k}`), reserve[k]));
    }
    const soft = num(toPercent(cfg.batchSoftFraction), 1, 1);
    card.append(field(t("jobsv.batchSoft"), soft));

    // Auto-Kalibrierung
    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.calib")), el("div", DIM + "margin-bottom:4px;", t("jobsv.calib.help")));
    const calMode = el("select", INPUT); calMode.disabled = ro;
    for (const m of ["manual", "auto"]) calMode.append(new Option(t(`jobsv.calib.mode.${m}`), m, false, cfg.calibration.mode === m));
    const cc = cfg.calibration;
    const calMargin = num(toPercent(cc.margin), 1, 1), calMin = num(toPercent(cc.min), 1, 1), calMax = num(toPercent(cc.max), 1, 1);
    const calPeak = num(toPercent(cc.peakWeight), 1, 1), calHours = num(cc.minHours, 1, 1), calDays = num(cc.windowDays, 1, 1);
    card.append(field(t("jobsv.calib.mode"), calMode), field(t("jobsv.calib.margin"), calMargin), field(t("jobsv.calib.min"), calMin), field(t("jobsv.calib.max"), calMax),
      field(t("jobsv.calib.peak"), calPeak), field(t("jobsv.calib.hours"), calHours), field(t("jobsv.calib.days"), calDays));

    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.protect")));
    const pEnabled = chk(cfg.protect.enabled);
    const pf: Record<string, HTMLInputElement> = {};
    for (const k of ["throttleAt", "pauseAt", "cancelAt", "resumeAt"] as const) pf[k] = num(toPercent(cfg.protect[k]), 1, 1);
    const maxPause = num(cfg.protect.maxPauseS, 1, 1);
    card.append(field(t("jobsv.protect.enabled"), pEnabled));
    for (const k of ["throttleAt", "pauseAt", "cancelAt", "resumeAt"] as const) card.append(field(t(`jobsv.protect.${k}`), pf[k]));
    card.append(field(t("jobsv.protect.maxPause"), maxPause));

    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.weights")));
    const weights: Record<string, HTMLInputElement> = {};
    for (const k of ["cpu", "gpu", "jobs", "live", "data", "net"]) {
      weights[k] = num(cfg.weights[k] ?? 0, 0.1, 0);
      card.append(field(t(`jobsv.weight.${k}`), weights[k]));
    }

    // Hosts
    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.hostOpts")));
    const hostIds = ["local", ...this.#hosts.filter((h) => !h.Local).map((h) => h.ID), ...Object.keys(cfg.hosts ?? {})].filter((v, i, a) => a.indexOf(v) === i);
    const hostRows: Record<string, { en: HTMLInputElement; max: HTMLInputElement; pools: HTMLInputElement; bo: HTMLInputElement; nb: HTMLInputElement; nice: HTMLInputElement }> = {};
    const htbl = el("table", "border-collapse:collapse;");
    const hh = el("tr");
    for (const k of ["host", "enabled", "maxJobs", "pools", "batchOnly", "noBatch", "nice"]) hh.append(el("th", TH, k === "host" ? t("jobsv.col.host") : t(`jobsv.hostOpts.${k}`)));
    htbl.append(hh);
    for (const id of hostIds) {
      const o = (id === "local" ? cfg.local : cfg.hosts?.[id]) ?? {};
      const label = id === "local" ? t("jobsv.local") : this.#hosts.find((h) => h.ID === id)?.Label || id;
      const r = { en: chk(o.enabled !== false), max: num(o.maxJobs ?? 0), pools: el("input", INPUT + "width:140px;"), bo: chk(!!o.batchOnly), nb: chk(!!o.noBatch), nice: num(o.nice ?? 0, 1, 0) };
      r.pools.value = (o.pools ?? []).join(","); r.pools.disabled = ro;
      hostRows[id] = r;
      const tr = el("tr");
      tr.append(el("td", TD, label));
      for (const c of [r.en, r.max, r.pools, r.bo, r.nb, r.nice]) { const td = el("td", TD); td.append(c); tr.append(td); }
      htbl.append(tr);
    }
    card.append(htbl);

    // Pfadzuordnung
    card.append(el("div", "font-weight:600;margin-top:12px;", t("jobsv.pathMap")), el("div", DIM + "margin-bottom:4px;", t("jobsv.pathMapHelp")));
    const ptbl = el("table", "border-collapse:collapse;");
    const ph = el("tr");
    for (const k of ["prefix", "host", "hostPrefix"]) ph.append(el("th", TH, t(`jobsv.pathMap.${k}`)));
    ptbl.append(ph);
    const readRows = () => Array.from(ptbl.querySelectorAll<HTMLTableRowElement>("tr[data-row]")).map((tr) => {
      const v = Array.from(tr.querySelectorAll("input")).map((i) => i.value);
      return { prefix: v[0], host: v[1], hostPrefix: v[2] } as PathRow;
    });
    const addRow = (r: PathRow) => {
      const tr = el("tr"); tr.setAttribute("data-row", "1");
      for (const v of [r.prefix, r.host, r.hostPrefix]) {
        const td = el("td", TD); const i = el("input", INPUT + "width:220px;"); i.value = v; i.disabled = ro; td.append(i); tr.append(td);
      }
      const td = el("td", TD);
      if (!ro) { const rm = el("button", "font-size:var(--omp-font-size-xs);", t("jobsv.pathMap.remove")); rm.addEventListener("click", () => tr.remove()); td.append(rm); }
      tr.append(td);
      ptbl.append(tr);
    };
    this.#rows.forEach(addRow);
    card.append(ptbl);
    if (!ro) {
      const add = el("button", "margin-top:6px;font-size:var(--omp-font-size-xs);", t("jobsv.pathMap.add"));
      add.addEventListener("click", () => addRow({ prefix: "", host: "", hostPrefix: "" }));
      card.append(add);
    }

    const status = el("span", DIM + "margin-left:12px;");
    if (!ro) {
      const save = el("button", "margin-top:12px;", t("jobsv.save"));
      save.className = "omp-btn-primary";
      save.addEventListener("click", async () => {
        const pm = pathMapFromRows(readRows());
        if (pm.error) { status.textContent = t("jobsv.pathMap.invalid", { p0: pm.error }); return; }
        const next: Cfg = {
          ...cfg,
          defaultTarget: defTarget.value,
          defaults: Object.fromEntries(CALLERS.filter((c) => callerSel[c].value !== "").map((c) => [c, callerSel[c].value])),
          fallbackLocal: fallback.checked, maxWaitS: +maxWait.value, maxAttempts: +attempts.value, lookaheadMin: +look.value,
          liveHostPolicy: policy.value, batchSoftFraction: fromPercent(+soft.value),
          liveReserve: Object.fromEntries(Object.entries(reserve).map(([k, i]) => [k, fromPercent(+i.value)])),
          weights: Object.fromEntries(Object.entries(weights).map(([k, i]) => [k, +i.value])),
          protect: { ...cfg.protect, enabled: pEnabled.checked, maxPauseS: +maxPause.value, throttleAt: fromPercent(+pf.throttleAt.value), pauseAt: fromPercent(+pf.pauseAt.value), cancelAt: fromPercent(+pf.cancelAt.value), resumeAt: fromPercent(+pf.resumeAt.value) },
          calibration: { mode: calMode.value, margin: fromPercent(+calMargin.value), min: fromPercent(+calMin.value), max: fromPercent(+calMax.value), peakWeight: fromPercent(+calPeak.value), minHours: +calHours.value, windowDays: +calDays.value },
          pathMap: pm.map, hosts: {}, local: cfg.local,
        };
        for (const [id, r] of Object.entries(hostRows)) {
          const prev = id === "local" ? cfg.local : cfg.hosts?.[id];
          const o: HostOpts = { reserve: prev?.reserve, enabled: r.en.checked, maxJobs: +r.max.value, batchOnly: r.bo.checked, noBatch: r.nb.checked, nice: +r.nice.value, pools: r.pools.value.split(",").map((s) => s.trim()).filter(Boolean) };
          if (id === "local") next.local = o; else next.hosts![id] = o;
        }
        const res = await apiFetch("/api/v1/jobs/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
        if (res.ok) {
          this.#cfg = (await res.json()) as Cfg;
          this.#rows = pathRows(this.#cfg.pathMap);
          status.textContent = t("jobsv.saved");
          void this.#poll();
        } else status.textContent = t("jobsv.saveFailed", { p0: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status) });
      });
      card.append(save, status);
    }
    this.#settings.replaceChildren(card);
  }
}

if (!customElements.get("omp-jobs-view")) customElements.define("omp-jobs-view", JobsView);
