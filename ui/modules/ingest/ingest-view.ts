// Tab „Aufnahmen“ (Kapitel 42): Zeitleiste geplanter Aufnahmen je Host, Kapazität **je Ressourcenart** über den Planungshorizont,
// Engpässe mit Ursache und Gegenmaßnahme (vorhergesagt ≠ tatsächlich fehlgeschlagen), Aufträge, Zeitpläne.
import { apiFetch, confirmDialog, dateLocale, showToast, t as tt, whoami } from "../host.ts";
import { openScheduleForm } from "./schedule-form.ts";
import { openSettingsForm } from "./settings-form.ts";
import type { IngestConfig } from "./settings-logic.ts";
import {
  actionKey, canAbort, canCancel, fmtDuration, fmtInZone, groupLanes, type HostView, isRunning, isTerminal, type Job, layoutBars, RESOURCE_UNITS, resourceLevel, stateColor, ticks,
  usageSeries, type Verdict,
} from "./ingest-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

async function api<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    const res = await apiFetch(`/api/v1/ingest${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {} as T;
    try {
      data = await res.json();
    } catch { /* leer */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } as unknown as T };
  }
}

const errText = (d: Record<string, any>): string => (d.problems as string[] | undefined)?.join("\n") || String(d.error ?? "");

interface Capacity {
  from: string;
  to: string;
  hosts: HostView[];
  resources: string[];
  jobs: Job[];
  problems: { job: Job; verdicts: Verdict[] }[];
  config: { leadTimeS: number; maxStartDeviationS: number };
}

type Profiles = Record<string, { label: string }>;
const WINDOWS: [string, number][] = [["12h", 12], ["24h", 24], ["48h", 48], ["7d", 168]];

class IngestView extends HTMLElement {
  #cap: Capacity | null = null;
  #schedules: any[] = [];
  #profiles: Profiles = {};
  #canEdit = false;
  #isAdmin = false;
  #windowH = 24;
  #stateFilter = "";
  #timer = 0;
  #loaded = false;
  #root = el("div");

  connectedCallback() {
    this.style.cssText = "display:block;padding:12px 16px;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#init();
    } else {
      this.#start();
    }
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #init() {
    const w = await whoami();
    this.#canEdit = !!(w.canConfigure ?? w.isAdmin ?? true);
    this.#isAdmin = !!w.isAdmin;
    const c = await api("GET", "/config");
    if (c.ok) this.#profiles = (c.data.profiles ?? {}) as Profiles;
    this.replaceChildren(this.#root);
    this.#start();
  }

  #start() {
    clearInterval(this.#timer);
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), 5000) as unknown as number;
  }

  async #refresh() {
    const now = new Date();
    const from = new Date(now.getTime() - 3600000);
    from.setMinutes(0, 0, 0);
    const to = new Date(from.getTime() + (this.#windowH + 1) * 3600000);
    const [cap, sch] = await Promise.all([api<Capacity>("GET", `/capacity?from=${from.toISOString()}&to=${to.toISOString()}`), api<{ schedules: any[] }>("GET", "/schedules")]);
    if (cap.ok) this.#cap = { ...cap.data, jobs: cap.data.jobs ?? [], problems: cap.data.problems ?? [], hosts: (cap.data.hosts ?? []).map((h) => ({ ...h, usage: h.usage ?? [], warnings: h.warnings ?? [] })) };
    if (sch.ok) this.#schedules = sch.data.schedules ?? [];
    this.#render();
  }

  #render() {
    const root = this.#root;
    root.replaceChildren();
    root.dataset.role = "ingest-root";
    const bar = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;");
    bar.append(el("h2", "margin:0 12px 0 0;font-size:16px;", tt("ing.title")));
    const add = el("button", "padding:3px 12px;", "＋ " + tt("ing.new.schedule"));
    add.className = "omp-btn-primary";
    add.dataset.role = "new-schedule";
    add.addEventListener("click", () => void this.#form(null, false));
    const adhoc = el("button", "padding:3px 12px;", "＋ " + tt("ing.new.adhoc"));
    adhoc.dataset.role = "new-adhoc";
    adhoc.addEventListener("click", () => void this.#form(null, true));
    bar.append(add, adhoc);
    const win = el("select") as HTMLSelectElement;
    for (const [l, h] of WINDOWS) {
      const o = el("option", "", l);
      o.value = String(h);
      win.append(o);
    }
    win.value = String(this.#windowH);
    win.title = tt("ing.window");
    win.addEventListener("change", () => {
      this.#windowH = Number(win.value);
      void this.#refresh();
    });
    bar.append(win);
    if (this.#isAdmin) {
      const cfg = el("button", "padding:3px 10px;", tt("ing.settings"));
      cfg.addEventListener("click", () => void this.#settings());
      bar.append(cfg);
    }
    root.append(bar);
    if (!this.#cap) {
      root.append(el("div", "color:var(--omp-text-dim);", tt("ing.loading")));
      return;
    }
    root.append(this.#problems(), this.#timeline(), this.#capacity(), this.#jobsTable(), this.#schedulesTable());
  }

  // ---- Engpässe / Probleme -----------------------------------------------------------------------------------------

  #problems(): HTMLElement {
    const cap = this.#cap!;
    const box = el("div", "margin-bottom:12px;display:flex;flex-direction:column;gap:6px;");
    box.dataset.role = "problems";
    const failed = cap.jobs.filter((j) => j.state === "failed");
    const late = cap.jobs.filter((j) => j.state === "waiting_for_resources");
    for (const p of cap.problems) {
      const b = el("div", "border:1px solid var(--omp-error);border-left-width:4px;border-radius:6px;padding:8px 12px;background:rgba(239,83,80,.06);");
      b.dataset.role = "problem";
      const head = el("div", "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;");
      head.append(el("span", "font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--omp-error);", tt("ing.predicted")), el("b", "", p.job.name),
        el("span", "color:var(--omp-text-dim);font-size:12px;", `${fmtInZone(p.job.plannedStart, p.job.tz, dateLocale())} · ${fmtDuration(Math.round((Date.parse(p.job.plannedEnd) - Date.parse(p.job.plannedStart)) / 1000))}`));
      b.append(head);
      for (const v of p.verdicts.filter((x) => x.blocking)) b.append(this.#verdict(v));
      if (p.job.earliestStart) b.append(el("div", "font-size:12px;margin-top:4px;", tt("ing.earliest", { p0: fmtInZone(p.job.earliestStart, p.job.tz, dateLocale()) })));
      box.append(b);
    }
    for (const j of late) {
      const b = el("div", "border:1px solid var(--omp-cue);border-left-width:4px;border-radius:6px;padding:8px 12px;");
      b.append(el("span", "font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--omp-cue);margin-right:8px;", tt("ing.actual")), el("b", "", j.name), el("span", "margin-left:8px;", j.error ?? tt("ing.waiting")));
      box.append(b);
    }
    for (const j of failed.slice(0, 5)) {
      const b = el("div", "border:1px solid var(--omp-error);border-left-width:4px;border-radius:6px;padding:8px 12px;");
      b.dataset.role = "failed";
      b.append(el("span", "font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--omp-error);margin-right:8px;", tt("ing.failed")), el("b", "", j.name),
        el("span", "margin-left:8px;color:var(--omp-text-dim);", `${tt("ing.stage." + (j.failedStage || "unknown"))}: ${j.error ?? ""}`));
      if (j.assetId) b.append(el("span", "margin-left:8px;font-size:12px;color:var(--omp-preset);", tt("ing.kept")));
      b.addEventListener("click", () => void this.#jobDialog(j.id));
      b.style.cursor = "pointer";
      box.append(b);
    }
    if (!box.children.length) box.append(el("div", "color:var(--omp-preset);font-size:12px;", "✔ " + tt("ing.noproblems")));
    return box;
  }

  #verdict(v: Verdict): HTMLElement {
    const d = el("div", "font-size:12px;margin:3px 0 0 0;");
    d.append(el("b", "", tt("ing.v." + v.kind) + ": "), document.createTextNode(v.message));
    if (v.jobs?.length) d.append(el("span", "color:var(--omp-text-dim);", ` (${tt("ing.jobs.n", { p0: v.jobs.length })})`));
    const ak = actionKey(v);
    const act = v.action || (ak ? tt(ak) : "");
    if (act) d.append(el("div", "color:var(--omp-text-dim);margin-left:12px;", "→ " + act));
    if (v.preemptable?.length) d.append(el("div", "color:var(--omp-cue);margin-left:12px;", tt("ing.preemptable", { p0: v.preemptable.length })));
    return d;
  }

  // ---- Zeitleiste ---------------------------------------------------------------------------------------------------

  #timeline(): HTMLElement {
    const cap = this.#cap!;
    const from = Date.parse(cap.from);
    const to = Date.parse(cap.to);
    const sec = el("div", "margin-bottom:14px;");
    sec.dataset.role = "timeline";
    sec.append(el("div", "font-weight:600;margin-bottom:4px;", tt("ing.timeline")));
    const axis = el("div", "position:relative;height:18px;margin-left:150px;border-bottom:1px solid var(--omp-border);");
    for (const t of ticks(from, to)) {
      const x = ((t.t - from) / (to - from)) * 100;
      axis.append(el("span", `position:absolute;left:${x}%;transform:translateX(-50%);font-size:10px;color:${t.major ? "var(--omp-text)" : "var(--omp-text-dim)"};`,
        t.label === "day" || t.major ? new Date(t.t).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "numeric" }) : String(new Date(t.t).getHours()).padStart(2, "0")));
    }
    sec.append(axis);
    const lanes = groupLanes(cap.jobs);
    const keys = [...cap.hosts.map((h) => h.id), "__none", "__blocked"].filter((k, i, a) => a.indexOf(k) === i);
    for (const k of keys) {
      const jobs = lanes.get(k) ?? [];
      if (!jobs.length && k.startsWith("__")) continue;
      const label = k === "__blocked" ? tt("ing.lane.blocked") : k === "__none" ? tt("ing.lane.none") : cap.hosts.find((h) => h.id === k)?.label ?? k;
      const { bars, lanes: n } = layoutBars(jobs, from, to);
      const row = el("div", "display:flex;align-items:stretch;border-bottom:1px dashed var(--omp-border);");
      row.append(el("div", `width:150px;flex:none;font-size:12px;padding:4px 6px 0 0;${k === "__blocked" ? "color:var(--omp-error);" : ""}`, label));
      const track = el("div", `position:relative;flex:1;height:${n * 24 + 6}px;background:${k === "__blocked" ? "repeating-linear-gradient(45deg,rgba(239,83,80,.07) 0 8px,transparent 8px 16px)" : "transparent"};`);
      for (const t of ticks(from, to)) track.append(el("div", `position:absolute;top:0;bottom:0;left:${((t.t - from) / (to - from)) * 100}%;border-left:1px solid ${t.major ? "var(--omp-border)" : "rgba(255,255,255,.04)"};`));
      for (const b of bars) {
        const d = el("div", `position:absolute;top:${3 + b.lane * 24}px;height:20px;left:${b.left}%;width:${b.width}%;background:${stateColor(b.job.state)};opacity:${isTerminal(b.job.state) ? 0.45 : 0.9};border-radius:3px;font-size:11px;line-height:20px;padding:0 4px;overflow:hidden;white-space:nowrap;color:#fff;cursor:pointer;box-sizing:border-box;${b.job.state === "blocked" ? "outline:1px dashed #fff;" : ""}`,
          b.job.name);
        d.dataset.job = b.job.id;
        d.dataset.state = b.job.state;
        d.title = `${b.job.name}\n${fmtInZone(b.job.plannedStart, b.job.tz, dateLocale())} – ${fmtInZone(b.job.plannedEnd, b.job.tz, dateLocale(), false)} (${b.job.tz})\n${tt("ing.state." + b.job.state)}`;
        d.addEventListener("click", () => void this.#jobDialog(b.job.id));
        track.append(d);
      }
      const now = Date.now();
      if (now >= from && now <= to) track.append(el("div", `position:absolute;top:0;bottom:0;left:${((now - from) / (to - from)) * 100}%;border-left:2px solid var(--omp-onair);pointer-events:none;`));
      row.append(track);
      sec.append(row);
    }
    if (!cap.jobs.length) sec.append(el("div", "color:var(--omp-text-dim);padding:10px 0;", tt("ing.none")));
    return sec;
  }

  // ---- Kapazität je Ressourcenart -------------------------------------------------------------------------------------

  #capacity(): HTMLElement {
    const cap = this.#cap!;
    const from = Date.parse(cap.from);
    const to = Date.parse(cap.to);
    const sec = el("div", "margin-bottom:14px;");
    sec.dataset.role = "capacity";
    sec.append(el("div", "font-weight:600;margin-bottom:2px;", tt("ing.capacity")), el("div", "font-size:11px;color:var(--omp-text-dim);margin-bottom:6px;", tt("ing.capacity.hint")));
    for (const h of cap.hosts) {
      const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 10px;margin-bottom:8px;");
      const head = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:4px;");
      head.append(el("b", "", h.label), el("span", `font-size:11px;color:${h.online ? "var(--omp-preset)" : "var(--omp-error)"};`, h.online ? tt("ing.host.online") : tt("ing.host.offline")));
      box.append(head);
      for (const res of cap.resources) {
        const hard = h.hard[res];
        if (!hard) continue;
        const { points, peak } = usageSeries(h, res, from, to);
        const level = resourceLevel(h, res, peak);
        const row = el("div", "display:flex;align-items:center;gap:8px;font-size:12px;");
        row.dataset.resource = res;
        row.dataset.level = level;
        row.append(el("div", "width:140px;flex:none;", tt("ing.res." + res)));
        const W = 600;
        const H = 18;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.cssText = "flex:1;height:18px;background:var(--omp-surface);border-radius:2px;";
        const col = level === "hard" ? "#ef5350" : level === "soft" ? "#fb8c00" : "#2f8cff";
        for (const p of points) {
          if (p.use <= 0) continue;
          const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          const h2 = Math.min(1, p.use / hard) * H;
          r.setAttribute("x", String((p.x0 / 100) * W));
          r.setAttribute("width", String(Math.max(0.5, ((p.x1 - p.x0) / 100) * W)));
          r.setAttribute("y", String(H - h2));
          r.setAttribute("height", String(h2));
          r.setAttribute("fill", col);
          r.setAttribute("opacity", "0.8");
          svg.append(r);
        }
        if (h.softFraction > 0) {
          const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
          l.setAttribute("x1", "0");
          l.setAttribute("x2", String(W));
          l.setAttribute("y1", String(H - h.softFraction * H));
          l.setAttribute("y2", String(H - h.softFraction * H));
          l.setAttribute("stroke", "#fb8c00");
          l.setAttribute("stroke-dasharray", "4 3");
          l.setAttribute("stroke-width", "0.8");
          svg.append(l);
        }
        row.append(svg);
        const unit = RESOURCE_UNITS[res] ?? "";
        row.append(el("div", `width:150px;flex:none;text-align:right;font-family:var(--omp-font-mono);color:${level === "ok" ? "var(--omp-text-dim)" : col};`, `${tt("ing.peak")} ${Math.round(peak * 10) / 10} / ${Math.round(hard * 10) / 10} ${unit}`.trim()));
        box.append(row);
      }
      for (const w of h.warnings.slice(0, 3)) box.append(el("div", "font-size:11px;color:var(--omp-cue);margin-top:2px;", `▲ ${tt("ing.predicted")}: ${w.message}`));
      sec.append(box);
    }
    return sec;
  }

  // ---- Aufträge ------------------------------------------------------------------------------------------------------

  #jobsTable(): HTMLElement {
    const sec = el("div", "margin-bottom:14px;");
    sec.dataset.role = "jobs";
    const head = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:4px;");
    head.append(el("div", "font-weight:600;", tt("ing.jobs")));
    const f = el("select") as HTMLSelectElement;
    for (const [v, k] of [["", "ing.f.all"], ["active", "ing.f.active"], ["upcoming", "ing.f.upcoming"], ["problem", "ing.f.problem"], ["done", "ing.f.done"]]) {
      const o = el("option", "", tt(k));
      o.value = v;
      f.append(o);
    }
    f.value = this.#stateFilter;
    f.addEventListener("change", () => {
      this.#stateFilter = f.value;
      this.#render();
    });
    head.append(f);
    sec.append(head);
    const match = (j: Job): boolean => {
      switch (this.#stateFilter) {
        case "active":
          return isRunning(j.state);
        case "upcoming":
          return j.state === "scheduled" || j.state === "waiting_for_resources";
        case "problem":
          return j.state === "blocked" || j.state === "failed" || j.state === "waiting_for_resources";
        case "done":
          return j.state === "completed" || j.state === "cancelled";
        default:
          return true;
      }
    };
    const jobs = this.#cap!.jobs.filter(match);
    const tb = el("table", "width:100%;border-collapse:collapse;font-size:12px;");
    const hr = el("tr", "text-align:left;color:var(--omp-text-dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em;");
    for (const k of ["ing.col.name", "ing.col.when", "ing.col.dur", "ing.col.source", "ing.col.state", "ing.col.host", "ing.col.dev", ""]) hr.append(el("th", "padding:3px 6px;font-weight:500;", k ? tt(k) : ""));
    tb.append(hr);
    for (const j of jobs.slice(0, 200)) {
      const tr = el("tr", "border-top:1px solid var(--omp-border);cursor:pointer;");
      tr.dataset.job = j.id;
      tr.addEventListener("click", () => void this.#jobDialog(j.id));
      const dur = Math.round((Date.parse(j.plannedEnd) - Date.parse(j.plannedStart)) / 1000);
      const dot = el("span", `display:inline-block;width:8px;height:8px;border-radius:50%;background:${stateColor(j.state)};margin-right:6px;`);
      const st = el("td", "padding:4px 6px;white-space:nowrap;");
      st.append(dot, document.createTextNode(tt("ing.state." + j.state)));
      const cells: (string | HTMLElement)[] = [
        j.name + (j.shifted ? " ⏱" : "") + (j.ambiguous ? " ⏱" : ""),
        fmtInZone(j.plannedStart, j.tz, dateLocale()),
        fmtDuration(dur),
        j.source.label || j.source.instanceId || "—",
        st,
        j.hostId || "—",
        j.startDeviationMs !== undefined ? `${(j.startDeviationMs / 1000).toFixed(1)} s` : "—",
      ];
      cells.forEach((c, i) => {
        if (c instanceof HTMLElement) tr.append(c);
        else {
          const td = el("td", "padding:4px 6px;", c);
          if (i === 0 && (j.shifted || j.ambiguous)) td.title = tt(j.shifted ? "ing.dst.shifted" : "ing.dst.ambiguous");
          tr.append(td);
        }
      });
      const act = el("td", "padding:4px 6px;text-align:right;white-space:nowrap;");
      if (canCancel(j.state) || canAbort(j.state)) {
        const b = el("button", "padding:1px 8px;", canAbort(j.state) ? tt("ing.abort") : tt("ing.cancel"));
        b.dataset.role = "job-cancel";
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.#cancel(j);
        });
        act.append(b);
      }
      tr.append(act);
      tb.append(tr);
    }
    sec.append(tb);
    if (!jobs.length) sec.append(el("div", "color:var(--omp-text-dim);padding:8px 0;", tt("ing.none")));
    return sec;
  }

  async #cancel(j: Job) {
    const abort = canAbort(j.state);
    if (!(await confirmDialog(tt(abort ? "ing.abort.confirm" : "ing.cancel.confirm", { p0: j.name }), { confirmLabel: tt(abort ? "ing.abort" : "ing.cancel") }))) return;
    const r = await api("POST", `/jobs/${j.id}/cancel`, { abort });
    showToast(r.ok ? tt("ing.cancelled") : errText(r.data) || tt("ing.err"));
    void this.#refresh();
  }

  // ---- Zeitpläne -----------------------------------------------------------------------------------------------------

  #schedulesTable(): HTMLElement {
    const sec = el("div");
    sec.dataset.role = "schedules";
    sec.append(el("div", "font-weight:600;margin-bottom:4px;", tt("ing.schedules")));
    if (!this.#schedules.length) {
      sec.append(el("div", "color:var(--omp-text-dim);", tt("ing.schedules.none")));
      return sec;
    }
    const tb = el("table", "width:100%;border-collapse:collapse;font-size:12px;");
    const hr = el("tr", "text-align:left;color:var(--omp-text-dim);font-size:10px;text-transform:uppercase;");
    for (const k of ["ing.col.name", "ing.col.rule", "ing.col.source", "ing.col.profile", "ing.col.prio", ""]) hr.append(el("th", "padding:3px 6px;font-weight:500;", k ? tt(k) : ""));
    tb.append(hr);
    for (const s of this.#schedules) {
      const tr = el("tr", "border-top:1px solid var(--omp-border);");
      tr.dataset.schedule = s.id;
      const rec = s.spec.recurrence?.freq ? tt("ing.freq." + s.spec.recurrence.freq) : tt("ing.freq.once");
      const rule = `${s.spec.startLocal.replace("T", " ")} ${s.spec.tz} · ${fmtDuration(s.spec.durationS)} · ${rec}`;
      for (const c of [s.name, rule, s.source.label || s.source.instanceId, this.#profiles[s.profileId]?.label ?? s.profileId, String(s.priority)]) tr.append(el("td", "padding:4px 6px;", c));
      const act = el("td", "padding:4px 6px;text-align:right;white-space:nowrap;");
      const edit = el("button", "padding:1px 8px;margin-right:4px;", tt("ing.edit"));
      edit.dataset.role = "schedule-edit";
      edit.addEventListener("click", () => void this.#form(s, false));
      const del = el("button", "padding:1px 8px;", tt("ing.delete"));
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(tt("ing.delete.confirm", { p0: s.name }), { confirmLabel: tt("ing.delete") }))) return;
        const r = await api("DELETE", `/schedules/${s.id}`);
        showToast(r.ok ? tt("ing.deleted") : errText(r.data) || tt("ing.err"));
        void this.#refresh();
      });
      act.append(edit, del);
      tr.append(act);
      tb.append(tr);
    }
    sec.append(tb);
    return sec;
  }

  async #form(existing: any | null, adhoc: boolean) {
    const [src, cfg] = await Promise.all([api<{ sources: any[] }>("GET", "/sources"), api("GET", "/config")]);
    openScheduleForm({
      sources: src.data.sources ?? [],
      profiles: cfg.data.profiles ?? {},
      hosts: (this.#cap?.hosts ?? []).map((h) => ({ id: h.id, label: h.label })),
      existing,
      adhoc,
      call: api,
      done: () => void this.#refresh(),
    });
  }

  async #jobDialog(id: string) {
    const r = await api<{ job: Job; events: any[] }>("GET", `/jobs/${id}`);
    if (!r.ok) return;
    const j = r.data.job;
    const overlay = el("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "3000";
    const m = el("div", "max-width:720px;max-height:86vh;overflow:auto;");
    m.className = "omp-modal";
    m.dataset.role = "job-dialog";
    const h1 = el("div", "margin-bottom:6px;", j.name);
    h1.className = "omp-h1";
    m.append(h1);
    const kv = el("div", "display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:12px;margin-bottom:8px;");
    const row = (k: string, v: string) => kv.append(el("span", "color:var(--omp-text-dim);", k), el("span", "", v));
    row(tt("ing.col.state"), tt("ing.state." + j.state));
    row(tt("ing.col.when"), `${fmtInZone(j.plannedStart, j.tz, dateLocale())} – ${fmtInZone(j.plannedEnd, j.tz, dateLocale(), false)} (${j.tz})`);
    row(tt("ing.col.source"), j.source.label || j.source.instanceId || "—");
    row(tt("ing.col.host"), j.hostId || "—");
    row(tt("ing.attempt"), `${j.attempt} / ${j.maxAttempts}`);
    if (j.filePath) row(tt("ing.file"), j.filePath);
    if (j.assetId) row(tt("ing.asset"), j.assetId);
    if (j.error) row(tt("ing.error"), `${tt("ing.stage." + (j.failedStage || "unknown"))}: ${j.error}`);
    m.append(kv);
    for (const v of j.verdicts ?? []) if (v.blocking || v.kind === "soft_capacity_warning" || v.kind === "uncertain_estimate") m.append(this.#verdict(v));
    m.append(el("div", "font-weight:600;margin:8px 0 2px;", tt("ing.history")));
    for (const e of r.data.events) {
      const line = el("div", "font-size:12px;display:flex;gap:10px;");
      m.append(line);
      line.append(
        el("span", "color:var(--omp-text-dim);min-width:140px;", new Date(e.at).toLocaleString(dateLocale())),
        el("b", "min-width:150px;", e.toState && e.toState !== e.fromState ? `${e.fromState ? tt("ing.state." + e.fromState) : "·"} → ${tt("ing.state." + e.toState)}` : ""),
        el("span", "", e.message),
      );
    }
    const row2 = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
    const close = el("button", "", tt("ing.close"));
    close.addEventListener("click", () => overlay.remove());
    if (j.state === "blocked" || j.state === "scheduled") {
      const re = el("button", "", tt("ing.readmit"));
      re.addEventListener("click", async () => {
        const x = await api<{ decision: { admit: boolean } }>("POST", `/jobs/${j.id}/readmit`);
        showToast(x.ok ? (x.data.decision.admit ? tt("ing.admitted") : tt("ing.stillblocked")) : errText(x.data) || tt("ing.err"));
        overlay.remove();
        void this.#refresh();
      });
      row2.append(re);
    }
    if (j.assetId) {
      const open = el("button", "", tt("ing.open.asset"));
      open.addEventListener("click", () => {
        overlay.remove();
        const tab = [...document.querySelectorAll("button")].find((b) => /^(Eingang|Intake)$/.test(b.textContent?.trim() ?? ""));
        tab?.click();
      });
      row2.append(open);
    }
    row2.append(close);
    m.append(row2);
    overlay.addEventListener("keydown", (e) => e.key === "Escape" && overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.append(m);
    document.body.append(overlay);
  }

  async #settings() {
    const r = await api("GET", "/config");
    if (!r.ok) return;
    openSettingsForm({
      config: r.data as unknown as IngestConfig,
      hosts: (this.#cap?.hosts ?? []).map((h) => ({ id: h.id, label: h.label })),
      save: async (c) => {
        const x = await api("PUT", "/config", c);
        if (!x.ok) return { ok: false, message: errText(x.data) || tt("ing.err") };
        this.#profiles = (x.data.profiles ?? {}) as Profiles;
        void this.#refresh();
        return { ok: true, message: "" };
      },
    });
  }
}

if (!customElements.get("omp-ingest-view")) customElements.define("omp-ingest-view", IngestView);
