// QC-Bericht (Kapitel 43): Zusammenfassung, filterbare/aufklappbare Befunde mit Messwert gegen Grenzwert, Sprung zum Timecode,
// Stream-Metadaten, Bericht-Verlauf (frühere Läufe bleiben erhalten), Export, Wiederholung.
//
// Ehrlichkeit: Das ist eine Analyse mit ffprobe/ffmpeg-Filtern (Metadaten-Probe + Inhaltsprüfungen). Eine Strukturvalidierung
// nach MXF-Standards (SMPTE ST 377 …) leistet sie nicht — der Hinweis steht im Bericht selbst.
import { dateLocale, showToast, t as tt } from "../host.ts";
import { call, download, errText } from "./api.ts";
import { countBy, filterFindings, type Finding, type FindingFilter, type Item, measuredRows, NO_FILTER, qcBadge } from "./review-logic.ts";
import { timecodeOf } from "./timecode.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface Job {
  id: string;
  state: string;
  phase?: string;
  progress: number;
  error?: string;
  reportId?: string;
  createdAt: string;
  profileId: string;
  requestedBy?: string;
}

export interface ReportSummary {
  id: string;
  overall: string;
  ruleset: string;
  createdAt: string;
  sourceRev: string;
  counts: Record<string, number>;
  tools: Record<string, string>;
}

export interface Report extends ReportSummary {
  findings: Finding[];
  streams?: { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  profile?: Record<string, unknown>;
}

export interface QcContext {
  item: Item;
  canOperate: boolean;
  profiles: string[];
  defaultProfile: string;
  goto: (frame: number) => void;
  reload: () => Promise<void>;
}

const ST_ICON: Record<string, string> = { pass: "✔", warning: "▲", fail: "✖", not_evaluated: "○" };
const ST_COLOR: Record<string, string> = { pass: "#43a047", warning: "#fb8c00", fail: "#ef5350", not_evaluated: "#93a1ba" };

export class QcPanel {
  readonly el = el("div", "display:flex;flex-direction:column;gap:10px;");
  #ctx: QcContext;
  #jobs: Job[] = [];
  #reports: ReportSummary[] = [];
  #report: Report | null = null;
  #filter: FindingFilter = { ...NO_FILTER };
  #open = new Set<number>();
  #timer = 0;
  #profile: string;

  constructor(ctx: QcContext) {
    this.#ctx = ctx;
    this.#profile = ctx.defaultProfile;
    void this.load();
  }

  update(ctx: QcContext): void {
    const changed = ctx.item.qcReportId !== this.#ctx.item.qcReportId || ctx.item.state !== this.#ctx.item.state;
    this.#ctx = ctx;
    if (changed) void this.load();
  }

  destroy(): void {
    clearTimeout(this.#timer);
  }

  async load(reportId?: string): Promise<void> {
    const id = this.#ctx.item.assetId;
    const [jobs, reports] = await Promise.all([call<{ jobs: Job[] }>("GET", `/items/${id}/qc/jobs`), call<{ reports: ReportSummary[] }>("GET", `/items/${id}/qc/reports`)]);
    this.#jobs = jobs.data.jobs ?? [];
    this.#reports = reports.data.reports ?? [];
    const want = reportId ?? this.#ctx.item.qcReportId ?? this.#reports[0]?.id;
    if (want) {
      const r = await call<Report>("GET", `/qc/reports/${want}`);
      this.#report = r.ok ? r.data : null;
    } else {
      this.#report = null;
    }
    this.#render();
    clearTimeout(this.#timer);
    const active = this.#jobs[0] && (this.#jobs[0].state === "queued" || this.#jobs[0].state === "running");
    if (active) this.#timer = setTimeout(() => void this.#poll(), 2000) as unknown as number;
  }

  async #poll(): Promise<void> {
    await this.#ctx.reload();
    await this.load();
  }

  #render(): void {
    const c = this.#ctx;
    this.el.replaceChildren();
    this.el.dataset.role = "qc-panel";
    const job = this.#jobs[0];

    // ---- Auftragsstatus (laufend / nicht ausführbar) ----
    if (job && (job.state === "queued" || job.state === "running")) {
      const b = el("div", "border:1px solid var(--omp-info);border-radius:6px;padding:8px 12px;");
      b.append(el("b", "", job.state === "queued" ? tt("rv.qc.queued") : tt("rv.qc.running", { p0: job.phase || "…", p1: job.progress })));
      const bar = el("div", "height:6px;background:var(--omp-surface-raised);border-radius:3px;margin-top:6px;overflow:hidden;");
      bar.append(el("div", `height:100%;width:${job.state === "running" ? job.progress : 0}%;background:var(--omp-info);`));
      b.append(bar);
      this.el.append(b);
    } else if (job && job.state === "execution_failed" && (!this.#report || this.#report.id !== job.reportId)) {
      const b = el("div", "border:1px solid var(--omp-error);border-radius:6px;padding:8px 12px;background:rgba(239,83,80,.08);");
      b.dataset.role = "qc-exec-failed";
      b.append(el("b", "color:var(--omp-error);", tt("rv.qc.execfailed")));
      b.append(el("div", "margin-top:4px;", job.error || ""));
      b.append(el("div", "margin-top:4px;color:var(--omp-text-dim);font-size:12px;", tt("rv.qc.execfailed.hint")));
      this.el.append(b);
    }

    // ---- Kopf ----
    const r = this.#report;
    const head = el("div", "display:flex;flex-wrap:wrap;gap:10px;align-items:center;");
    if (r) {
      const badge = el("span", qcBadge(r.overall) + " omp-badge-lg", tt("rv.qc.overall." + r.overall));
      badge.style.fontSize = "14px";
      badge.dataset.role = "qc-overall";
      head.append(badge);
      head.append(el("span", "", tt("rv.qc.counts", { p0: r.counts?.fail ?? 0, p1: r.counts?.warning ?? 0, p2: r.counts?.pass ?? 0, p3: r.counts?.not_evaluated ?? 0 })));
      head.append(el("span", "color:var(--omp-text-dim);font-size:12px;", `${r.ruleset} · ${new Date(r.createdAt).toLocaleString(dateLocale())} · ffmpeg ${r.tools?.ffmpeg ?? "?"} / ffprobe ${r.tools?.ffprobe ?? "?"}`));
    } else {
      head.append(el("span", "color:var(--omp-text-dim);", tt("rv.qc.noreport")));
    }
    this.el.append(head);
    if (r && r.sourceRev !== c.item.sourceRev) {
      this.el.append(el("div", "border:1px solid var(--omp-cue);border-radius:6px;padding:6px 10px;color:var(--omp-cue);", tt("rv.qc.stale")));
    }
    if (r?.overall === "incomplete") this.el.append(el("div", "color:var(--omp-cue);font-size:12px;", tt("rv.qc.incomplete.hint")));

    // ---- Aktionen ----
    const act = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center;");
    if (this.#reports.length > 1) {
      const sel = el("select");
      for (const x of this.#reports) {
        const o = el("option", "", `${new Date(x.createdAt).toLocaleString(dateLocale())} — ${tt("rv.qc.overall." + x.overall)} (${x.ruleset})`);
        o.value = x.id;
        sel.append(o);
      }
      sel.value = r?.id ?? "";
      sel.title = tt("rv.qc.history");
      sel.addEventListener("change", () => void this.load(sel.value));
      act.append(el("span", "font-size:11px;color:var(--omp-text-dim);", tt("rv.qc.history")), sel);
    }
    if (c.canOperate) {
      const ps = el("select");
      for (const p of c.profiles) {
        const o = el("option", "", p);
        o.value = p;
        ps.append(o);
      }
      ps.value = this.#profile;
      ps.title = tt("rv.qc.profile");
      ps.addEventListener("change", () => (this.#profile = ps.value));
      const rerun = el("button", "padding:3px 10px;", tt("rv.qc.rerun"));
      rerun.dataset.role = "qc-rerun";
      rerun.addEventListener("click", async () => {
        const res = await call("POST", `/items/${c.item.assetId}/qc`, { profile: this.#profile });
        if (!res.ok) showToast(errText(res.data) || tt("rv.err.generic"));
        else showToast(tt("rv.qc.requested"));
        await c.reload();
        await this.load();
      });
      act.append(ps, rerun);
    }
    if (r) {
      for (const fmt of ["json", "csv"]) {
        const b = el("button", "padding:3px 10px;", tt("rv.qc.export." + fmt));
        b.addEventListener("click", async () => {
          if (!(await download(`/qc/reports/${r.id}/export?format=${fmt}`, `qc-${c.item.assetId}-${r.id}.${fmt}`))) showToast(tt("rv.err.generic"));
        });
        act.append(b);
      }
    }
    this.el.append(act);
    if (!r) return;

    // ---- Filter ----
    const cats = countBy(r.findings, "category");
    const f = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center;");
    const mk = (label: string, key: "category" | "status" | "severity", values: string[], labels: (v: string) => string): void => {
      const s = el("select");
      const all = el("option", "", label);
      all.value = "";
      s.append(all);
      for (const v of values) {
        const o = el("option", "", labels(v));
        o.value = v;
        s.append(o);
      }
      s.value = this.#filter[key];
      s.addEventListener("change", () => {
        this.#filter[key] = s.value;
        this.#renderList(list);
      });
      f.append(s);
    };
    mk(tt("rv.qc.f.category"), "category", Object.keys(cats), (v) => `${tt("rv.qc.cat." + v)} (${cats[v]})`);
    mk(tt("rv.qc.f.status"), "status", ["fail", "warning", "pass", "not_evaluated"], (v) => tt("rv.qc.status." + v));
    mk(tt("rv.qc.f.severity"), "severity", ["critical", "major", "minor", "info"], (v) => tt("rv.qc.sev." + v));
    const q = el("input", "width:180px;") as HTMLInputElement;
    q.placeholder = tt("rv.qc.f.search");
    q.value = this.#filter.q;
    q.addEventListener("input", () => {
      this.#filter.q = q.value;
      this.#renderList(list);
    });
    const only = el("label", "display:flex;gap:4px;align-items:center;font-size:12px;");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = this.#filter.onlyIssues;
    cb.addEventListener("change", () => {
      this.#filter.onlyIssues = cb.checked;
      this.#renderList(list);
    });
    only.append(cb, tt("rv.qc.f.issues"));
    f.append(q, only);
    this.el.append(f);

    const list = el("div", "display:flex;flex-direction:column;gap:2px;");
    list.dataset.role = "qc-findings";
    this.el.append(list);
    this.#renderList(list);

    // ---- Technische Stream-Metadaten ----
    if (r.streams) this.el.append(this.#streams(r.streams));
  }

  #renderList(list: HTMLElement): void {
    const r = this.#report!;
    const tl = this.#ctx.item.timeline;
    list.replaceChildren();
    const shown = filterFindings(r.findings, this.#filter);
    list.append(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("rv.qc.shown", { p0: shown.length, p1: r.findings.length })));
    for (const x of shown) {
      const id = x.id ?? Math.random();
      const row = el("div", "border:1px solid var(--omp-border);border-radius:4px;");
      row.dataset.check = x.checkId;
      row.dataset.status = x.status;
      const head = el("div", "display:flex;gap:8px;align-items:center;padding:4px 8px;cursor:pointer;");
      head.append(el("span", `color:${ST_COLOR[x.status]};width:16px;text-align:center;font-weight:700;`, ST_ICON[x.status] ?? "?"));
      head.append(el("span", "font:11px var(--omp-font-mono);color:var(--omp-text-dim);min-width:170px;", x.checkId + (x.stream !== undefined ? `#${x.stream + 1}` : "")));
      head.append(el("span", "flex:1;", x.message));
      if (x.startFrame !== undefined && tl) {
        const go = el("button", "padding:1px 7px;font:11px var(--omp-font-mono);", `▶ ${timecodeOf(tl, x.startFrame)}`);
        go.title = tt("rv.qc.goto");
        go.dataset.role = "finding-goto";
        go.addEventListener("click", (e) => {
          e.stopPropagation();
          this.#ctx.goto(x.startFrame!);
        });
        head.append(go);
      }
      head.append(el("span", "font-size:10px;text-transform:uppercase;color:var(--omp-text-dim);", tt("rv.qc.cat." + x.category)));
      const body = el("div", "padding:4px 10px 8px 34px;font-size:12px;");
      const render = () => {
        body.replaceChildren();
        body.style.display = this.#open.has(id) ? "block" : "none";
        if (!this.#open.has(id)) return;
        const rows = measuredRows(x);
        if (rows.length) {
          const tb = el("table", "border-collapse:collapse;");
          const hr = el("tr", "color:var(--omp-text-dim);");
          hr.append(...["", tt("rv.qc.measured"), tt("rv.qc.threshold")].map((h) => el("th", "text-align:left;padding:1px 14px 1px 0;font-weight:500;", h)));
          tb.append(hr);
          for (const m of rows) {
            const tr = el("tr");
            tr.append(el("td", "padding:1px 14px 1px 0;font-family:var(--omp-font-mono);", m.key), el("td", "padding:1px 14px 1px 0;font-family:var(--omp-font-mono);", m.measured), el("td", "padding:1px 14px 1px 0;font-family:var(--omp-font-mono);color:var(--omp-text-dim);", m.threshold));
            tb.append(tr);
          }
          body.append(tb);
        }
        const meta = [`${tt("rv.qc.tool")}: ${x.tool} ${x.toolVersion}`, `${tt("rv.qc.severity")}: ${tt("rv.qc.sev." + x.severity)}`, `${tt("rv.qc.ruleset")}: ${x.ruleset}`, `${tt("rv.qc.at")}: ${new Date(x.analyzedAt).toLocaleString(dateLocale())}`];
        if (x.startFrame !== undefined && x.endFrame !== undefined && tl) meta.push(`${tt("rv.qc.range")}: ${timecodeOf(tl, x.startFrame)} – ${timecodeOf(tl, x.endFrame)} (${x.endFrame - x.startFrame} ${tt("rv.frames")})`);
        body.append(el("div", "margin-top:4px;color:var(--omp-text-dim);", meta.join("  ·  ")));
      };
      head.addEventListener("click", () => {
        if (this.#open.has(id)) this.#open.delete(id);
        else this.#open.add(id);
        render();
      });
      render();
      row.append(head, body);
      list.append(row);
    }
  }

  #streams(s: NonNullable<Report["streams"]>): HTMLElement {
    const box = el("details", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 10px;");
    box.dataset.role = "qc-streams";
    box.append(el("summary", "cursor:pointer;font-weight:600;", tt("rv.qc.streams")));
    const fmt = s.format ?? {};
    const keys = ["format_long_name", "duration", "size", "bit_rate", "nb_streams", "probe_score"];
    const kv = el("div", "display:grid;grid-template-columns:max-content 1fr;gap:1px 12px;font-size:12px;margin:6px 0;");
    for (const k of keys) if (fmt[k] !== undefined) kv.append(el("span", "color:var(--omp-text-dim);", k), el("span", "font-family:var(--omp-font-mono);", String(fmt[k])));
    const tags = (fmt.tags ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(tags)) kv.append(el("span", "color:var(--omp-text-dim);", `tag:${k}`), el("span", "font-family:var(--omp-font-mono);word-break:break-all;", String(v)));
    box.append(kv);
    for (const st of s.streams ?? []) {
      const d = el("details", "margin:2px 0;");
      const kind = String(st.codec_type);
      const line =
        kind === "video"
          ? `${st.codec_name} ${st.width}×${st.height} ${st.r_frame_rate} ${st.pix_fmt} ${st.field_order ?? ""}`
          : kind === "audio"
          ? `${st.codec_name} ${st.sample_rate} Hz ${st.channels} ch ${st.channel_layout ?? ""}`
          : `${st.codec_name ?? ""}`;
      d.append(el("summary", "cursor:pointer;font-size:12px;", `#${st.index} ${kind}: ${line}`));
      const pre = el("pre", "font:11px var(--omp-font-mono);margin:4px 0 4px 16px;white-space:pre-wrap;color:var(--omp-text-dim);", JSON.stringify(st, null, 1));
      d.append(pre);
      box.append(d);
    }
    return box;
  }
}
