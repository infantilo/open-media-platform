// Formular „Zeitplan / Einzelaufnahme“ mit Live-Prüfung: Während der Eingabe läuft ein Trockenlauf der Zulassung (POST /plan) — Engpässe,
// Quellkonflikte und der früheste mögliche Start sind sichtbar, **bevor** gespeichert wird.
import { dateLocale, showToast, t as tt } from "../host.ts";
import type { Directory } from "../../kit/features.ts";
import { AudioPlanEditor, type SourceInfo } from "./audio-plan-editor.ts";
import { type AudioPlanForm, planFromServer, planToPayload } from "./audio-plan-logic.ts";
import { emptyForm, type FormProblem, type FormState, formToPayload, fmtDuration, fmtInZone, planPayload, validateForm, type Verdict, WEEKDAYS, zonedToUtc } from "./ingest-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: Record<string, any> }>;

export interface FormOptions {
  sources: SourceInfo[];
  profiles: Record<string, { label: string }>;
  hosts: { id: string; label: string }[];
  existing: any | null;
  adhoc: boolean;
  /** Dateiendung je Profil (bestimmt die Kanalgrenze des Kanalplans). */
  profileExt?: Record<string, string>;
  call: Call;
  done: () => void;
  /** Darf die Person Verantwortliche festlegen (Kapitel 44)? Sonst fehlt das Feld und der Server setzt/behält sie. */
  canAssign?: boolean;
  directory?: Directory | null;
}

const ZONES = ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/London", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];

function fromSchedule(s: any, tz: string): FormState {
  const f = emptyForm(tz, new Date().toISOString());
  f.name = s.name;
  f.sourceKey = `${s.source.instanceId ?? ""}|${s.source.senderLabel ?? ""}`;
  f.sourceLabel = s.source.label ?? "";
  f.profileId = s.profileId;
  f.tz = s.spec.tz;
  f.startLocal = s.spec.startLocal;
  f.duration = fmtDuration(s.spec.durationS);
  const r = s.spec.recurrence ?? {};
  f.freq = r.freq || "once";
  f.interval = String(r.interval ?? 1);
  f.byDay = r.byDay ?? [];
  f.until = r.until ?? "";
  f.count = r.count ? String(r.count) : "";
  f.priority = String(s.priority);
  f.lateMode = s.late?.mode || "wait";
  f.lateMaxDelayMin = String(Math.round((s.late?.maxDelayS ?? 600) / 60));
  f.retryMax = String(s.retry?.maxAttempts ?? 2);
  f.hostPref = s.hostPref ?? "";
  f.dir = s.storage?.dir ?? "";
  f.template = s.storage?.fileTemplate ?? "";
  f.description = s.metadata?.description ?? "";
  return f;
}

export function openScheduleForm(o: FormOptions): void {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const f: FormState = o.existing ? fromSchedule(o.existing, browserTz) : emptyForm(browserTz, new Date().toISOString());
  if (!o.existing && Object.keys(o.profiles).length) f.profileId = Object.keys(o.profiles)[0];
  if (o.adhoc) f.freq = "once";

  const overlay = el("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.zIndex = "3000";
  const m = el("div", "max-width:760px;max-height:92vh;overflow:auto;");
  m.className = "omp-modal";
  m.dataset.role = "schedule-form";
  const h1 = el("div", "margin-bottom:8px;", o.adhoc ? tt("ing.new.adhoc") : o.existing ? tt("ing.edit.schedule") : tt("ing.new.schedule"));
  h1.className = "omp-h1";
  m.append(h1);

  const check = el("div", "margin:8px 0;padding:8px 10px;border:1px solid var(--omp-border);border-radius:6px;font-size:12px;min-height:34px;");
  check.dataset.role = "plan-check";
  const errBox = el("div", "color:var(--omp-error);font-size:12px;white-space:pre-line;margin-top:6px;");
  let timer = 0;
  const runCheck = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const p = planPayload(f);
      if (p && audio) (p as Record<string, unknown>).audio = planToPayload(audio);
      apEditor.refresh();
      check.replaceChildren();
      if (!p) {
        check.append(el("span", "color:var(--omp-text-dim);", tt("ing.check.incomplete")));
        return;
      }
      const r = await o.call("POST", "/plan", p);
      check.replaceChildren();
      if (!r.ok) {
        check.append(el("span", "color:var(--omp-error);", (r.data.problems as string[] | undefined)?.join("; ") || String(r.data.error ?? "")));
        return;
      }
      const d = r.data.decision as { admit: boolean; host?: string; verdicts: Verdict[]; earliestStart?: string; alternatives?: { host: string; start: string }[] };
      const head = el("div", `font-weight:600;color:${d.admit ? "var(--omp-preset)" : "var(--omp-error)"};`, d.admit ? tt("ing.check.ok", { p0: d.host ?? "" }) : tt("ing.check.blocked"));
      check.append(head);
      for (const v of d.verdicts) {
        if (v.kind === "ok") continue;
        const line = el("div", `margin-top:3px;color:${v.blocking ? "var(--omp-error)" : "var(--omp-cue)"};`);
        line.append(el("b", "", tt("ing.v." + v.kind) + ": "), document.createTextNode(v.message));
        if (v.action) line.append(el("div", "color:var(--omp-text-dim);margin-left:12px;", "→ " + v.action));
        check.append(line);
      }
      if (d.earliestStart) check.append(el("div", "margin-top:4px;", tt("ing.earliest", { p0: fmtInZone(d.earliestStart, f.tz, dateLocale()) })));
    }, 350) as unknown as number;
  };

  const field = (label: string, control: HTMLElement, wide = false, help = ""): HTMLElement => {
    const w = el("label", `display:flex;flex-direction:column;gap:2px;${wide ? "grid-column:1/-1;" : ""}`);
    w.append(el("span", "font-size:11px;color:var(--omp-text-dim);", label), control);
    if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", help));
    return w;
  };
  const input = (key: keyof FormState, type = "text", ph = ""): HTMLInputElement => {
    const i = el("input") as HTMLInputElement;
    i.type = type;
    i.value = String(f[key] ?? "");
    i.placeholder = ph;
    i.dataset.field = key;
    i.addEventListener("input", () => {
      (f[key] as string) = i.value;
      runCheck();
    });
    return i;
  };
  const select = (key: keyof FormState, opts: [string, string][]): HTMLSelectElement => {
    const s = el("select") as HTMLSelectElement;
    for (const [v, l] of opts) {
      const op = el("option", "", l);
      op.value = v;
      s.append(op);
    }
    s.value = String(f[key] ?? "");
    s.dataset.field = key;
    s.addEventListener("change", () => {
      (f[key] as string) = s.value;
      if (key === "freq") renderRec();
      if (key === "lateMode") lateDelay.style.display = f.lateMode === "delay" ? "" : "none";
      runCheck();
    });
    return s;
  };

  const grid = el("div", "display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;");
  grid.append(field(tt("ing.f.name"), input("name"), true));
  // Quelle: je Node, bei mehreren Sendern zusätzlich je Sender
  const srcSel = el("select") as HTMLSelectElement;
  srcSel.dataset.field = "source";
  const blank = el("option", "", tt("ing.f.source.pick"));
  blank.value = "";
  srcSel.append(blank);
  for (const s of o.sources) {
    const base = el("option", "", `${s.nodeLabel}${s.online ? "" : " (" + tt("ing.host.offline") + ")"} — ${tt("ing.f.source.all")}`);
    base.value = `${s.instanceId}|`;
    base.dataset.label = s.nodeLabel;
    srcSel.append(base);
    if (s.senders.length > 2) {
      for (const sn of s.senders) {
        const op = el("option", "", `   ${s.nodeLabel} · ${sn.label}`);
        op.value = `${s.instanceId}|${sn.label}`;
        op.dataset.label = `${s.nodeLabel} · ${sn.label}`;
        srcSel.append(op);
      }
    }
  }
  if (f.sourceKey && ![...srcSel.options].some((x) => x.value === f.sourceKey)) {
    const keep = el("option", "", f.sourceLabel || f.sourceKey);
    keep.value = f.sourceKey;
    srcSel.append(keep);
  }
  srcSel.value = f.sourceKey;
  srcSel.addEventListener("change", () => {
    f.sourceKey = srcSel.value;
    f.sourceLabel = srcSel.selectedOptions[0]?.dataset.label ?? "";
    runCheck();
  });
  grid.append(field(tt("ing.f.source"), srcSel));
  grid.append(field(tt("ing.f.profile"), select("profileId", Object.entries(o.profiles).map(([id, p]) => [id, p.label || id]))));
  // Zeit
  const tz = input("tz", "text", "Europe/Berlin");
  tz.setAttribute("list", "ing-zones");
  const dl = el("datalist");
  dl.id = "ing-zones";
  for (const z of ZONES) dl.append(new Option(z, z));
  grid.append(field(tt("ing.f.tz"), tz, false, tt("ing.f.tz.hint")), dl);
  grid.append(field(tt("ing.f.start"), input("startLocal", "datetime-local"), false, tt("ing.f.start.hint")));
  grid.append(field(tt("ing.f.duration"), input("duration", "text", "1:00"), false, tt("ing.f.duration.hint")));
  grid.append(field(tt("ing.f.priority"), input("priority", "number"), false, tt("ing.f.priority.hint")));

  // Wiederholung (nicht bei Einzelaufnahme)
  const rec = el("div", "grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;");
  const renderRec = () => {
    rec.replaceChildren();
    if (o.adhoc) return;
    rec.append(field(tt("ing.f.freq"), select("freq", [["once", tt("ing.freq.once")], ["daily", tt("ing.freq.daily")], ["weekly", tt("ing.freq.weekly")], ["monthly", tt("ing.freq.monthly")]])));
    if (f.freq === "once") return;
    rec.append(field(tt("ing.f.interval"), input("interval", "number")));
    if (f.freq === "weekly") {
      const box = el("div", "display:flex;gap:8px;flex-wrap:wrap;");
      for (const d of WEEKDAYS) {
        const l = el("label", "display:flex;gap:3px;align-items:center;font-size:12px;");
        const cb = el("input") as HTMLInputElement;
        cb.type = "checkbox";
        cb.checked = f.byDay.includes(d);
        cb.dataset.day = d;
        cb.addEventListener("change", () => {
          f.byDay = cb.checked ? [...f.byDay, d] : f.byDay.filter((x) => x !== d);
          runCheck();
        });
        l.append(cb, tt("ing.day." + d));
        box.append(l);
      }
      rec.append(field(tt("ing.f.byday"), box, true));
    }
    rec.append(field(tt("ing.f.until"), input("until", "date")), field(tt("ing.f.count"), input("count", "number"), false, tt("ing.f.count.hint")));
  };
  renderRec();
  grid.append(rec);

  // Richtlinien
  grid.append(field(tt("ing.f.late"), select("lateMode", [["wait", tt("ing.late.wait")], ["delay", tt("ing.late.delay")], ["fail", tt("ing.late.fail")]]), false, tt("ing.f.late.hint")));
  const lateDelay = field(tt("ing.f.late.max"), input("lateMaxDelayMin", "number"));
  lateDelay.style.display = f.lateMode === "delay" ? "" : "none";
  grid.append(lateDelay);
  grid.append(field(tt("ing.f.retry"), input("retryMax", "number"), false, tt("ing.f.retry.hint")));
  grid.append(field(tt("ing.f.host"), select("hostPref", [["", tt("ing.f.host.auto")], ...o.hosts.map((h) => [h.id, h.label] as [string, string])])));
  grid.append(field(tt("ing.f.dir"), input("dir", "text", "nachrichten"), false, tt("ing.f.dir.hint")));
  grid.append(field(tt("ing.f.template"), input("template", "text", "{name}_{date}_{time}"), false, tt("ing.f.template.hint")));
  grid.append(field(tt("ing.f.desc"), input("description"), true));
  // Kanalplan (Kapitel 45): mehrere Quellen, Kanäle umordnen, Gain, Stille
  let audio: AudioPlanForm | null = planFromServer(o.existing?.audio);
  const apEditor = new AudioPlanEditor({
    sources: o.sources,
    primaryKey: () => f.sourceKey,
    primaryLabel: () => f.sourceLabel,
    ext: () => o.profileExt?.[f.profileId] ?? ".mxf",
    initial: audio,
    onChange: (p) => {
      audio = p;
      runCheck();
    },
  });
  grid.append(apEditor.el);
  // Verantwortliche (Kapitel 44): Person und/oder Gruppe; leer = bei Neuanlage der Ersteller, bei Änderung unverändert.
  let owner: string = o.existing?.owner ?? "";
  let ownerGroup: string = o.existing?.ownerGroup ?? "";
  if (o.canAssign) {
    const pick = (none: string, options: [string, string][], current: string, role: string, set: (v: string) => void): HTMLSelectElement => {
      const s = el("select") as HTMLSelectElement;
      s.dataset.field = role;
      const list: [string, string][] = [["", none], ...options];
      if (current && !options.some(([v]) => v === current)) list.push([current, current]);
      for (const [v, l] of list) {
        const op = el("option", "", l);
        op.value = v;
        s.append(op);
      }
      s.value = current;
      s.addEventListener("change", () => set(s.value));
      return s;
    };
    const users = (o.directory?.users ?? []).map((u) => [u.username, u.username] as [string, string]);
    const groups = (o.directory?.groups ?? []).map((g) => [g.id, g.name] as [string, string]);
    grid.append(
      field(tt("ing.f.owner"), pick(tt("ing.f.owner.me"), users, owner, "owner", (v) => (owner = v)), false, tt("ing.f.owner.hint")),
      field(tt("ing.f.ownerGroup"), pick(tt("ing.f.ownerGroup.none"), groups, ownerGroup, "ownerGroup", (v) => (ownerGroup = v))),
    );
  }
  m.append(grid, check, errBox);

  const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;");
  const cancel = el("button", "", tt("ing.close"));
  const save = el("button", "", o.adhoc ? tt("ing.record") : tt("ing.save"));
  save.className = "omp-btn-primary";
  save.dataset.role = "form-save";
  cancel.addEventListener("click", () => overlay.remove());
  const probText = (ps: FormProblem[]) => ps.map((p) => tt("ing.p." + p.key)).join("\n");
  save.addEventListener("click", async () => {
    const ps = validateForm(f);
    if (ps.length) {
      errBox.textContent = probText(ps);
      return;
    }
    errBox.textContent = "";
    const payload = formToPayload(f) as Record<string, any>;
    const audioProblems = apEditor.problems();
    if (audioProblems.length) {
      errBox.textContent = audioProblems.join("\n");
      return;
    }
    payload.audio = planToPayload(audio);
    if (o.canAssign) {
      payload.owner = owner;
      payload.ownerGroup = ownerGroup;
    }
    let r;
    if (o.adhoc) {
      const start = zonedToUtc(f.startLocal, f.tz);
      r = await o.call("POST", "/adhoc", { name: payload.name, source: payload.source, start: start?.toISOString(), durationS: payload.spec.durationS, profileId: payload.profileId, priority: payload.priority, late: payload.late, retry: payload.retry, hostPref: payload.hostPref, storage: payload.storage, metadata: payload.metadata, owner: payload.owner, ownerGroup: payload.ownerGroup, audio: payload.audio });
    } else if (o.existing) {
      r = await o.call("PUT", `/schedules/${o.existing.id}`, { ...payload, expectedRevision: o.existing.revision });
    } else {
      r = await o.call("POST", "/schedules", payload);
    }
    if (!r.ok) {
      errBox.textContent = r.status === 409 ? tt("ing.conflict") : (r.data.problems as string[] | undefined)?.join("\n") || String(r.data.error ?? tt("ing.err"));
      return;
    }
    overlay.remove();
    const jobs: any[] = (r.data.jobs as any[]) ?? (r.data.job ? [r.data.job] : []);
    const blocked = jobs.filter((j) => j.state === "blocked").length;
    showToast(blocked ? tt("ing.saved.blocked", { p0: blocked }) : tt("ing.saved"));
    o.done();
  });
  row.append(cancel, save);
  m.append(row);
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && overlay.remove());
  overlay.append(m);
  document.body.append(overlay);
  runCheck();
}
