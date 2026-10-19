// Einstellungen der Aufnahme als Formular (statt JSON): Allgemeines, Standard-Richtlinien, Zulassungsregeln, Hostbudgets, Profile.
// Das Formular arbeitet auf einer Kopie der Konfiguration; unbekannte Felder bleiben erhalten. Der Server prüft zusätzlich.
import { confirmDialog, showToast, t as tt } from "../host.ts";
import {
  cloneConfig, DEMAND_KINDS, FORMAT_PRESETS, FUNCTIONS, type HostBudget, type IngestConfig, joinArgs, LATE_MODES, newProfileId, numOrUndef, type Profile, RESOURCE_KINDS, splitArgs,
  validateConfig,
} from "./settings-logic.ts";
import { RESOURCE_UNITS } from "./ingest-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface SettingsOptions {
  config: IngestConfig;
  hosts: { id: string; label: string }[];
  save: (c: IngestConfig) => Promise<{ ok: boolean; message: string }>;
}

const unit = (r: string): string => RESOURCE_UNITS[r] ?? "";

export function openSettingsForm(o: SettingsOptions): void {
  const c = cloneConfig(o.config);
  c.rules ??= {};
  c.defaultBudget ??= {};
  c.hostBudgets ??= {};
  c.defaultLate ??= {};
  c.defaultRetry ??= {};

  const overlay = el("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.zIndex = "3000";
  const m = el("div", "max-width:820px;max-height:92vh;overflow:auto;");
  m.className = "omp-modal";
  m.dataset.role = "ingest-settings";
  const h1 = el("div", "margin-bottom:4px;", tt("ing.settings"));
  h1.className = "omp-h1";
  const body = el("div", "display:flex;flex-direction:column;gap:10px;");
  const err = el("div", "color:var(--omp-error);font-size:12px;white-space:pre-line;min-height:16px;");

  // ---- Bausteine ----
  const label = (text: string, help = ""): HTMLElement => {
    const w = el("span", "display:flex;flex-direction:column;");
    w.append(el("span", "font-size:11px;color:var(--omp-text-dim);", text));
    if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", help));
    return w;
  };
  const field = (text: string, ctl: HTMLElement, help = "", wide = false): HTMLElement => {
    const w = el("label", `display:flex;flex-direction:column;gap:2px;${wide ? "grid-column:1/-1;" : ""}`);
    w.append(label(text, help), ctl);
    return w;
  };
  const num = (get: () => number | undefined, set: (v: number | undefined) => void, o2: { min?: number; max?: number; step?: number; suffix?: string; ph?: string } = {}): HTMLElement => {
    const wrap = el("span", "display:inline-flex;align-items:center;gap:4px;");
    const i = el("input") as HTMLInputElement;
    i.type = "number";
    i.style.width = "100%";
    if (o2.min !== undefined) i.min = String(o2.min);
    if (o2.max !== undefined) i.max = String(o2.max);
    i.step = String(o2.step ?? "any");
    i.placeholder = o2.ph ?? "";
    const v = get();
    i.value = v === undefined ? "" : String(v);
    i.addEventListener("input", () => set(numOrUndef(i.value)));
    wrap.append(i);
    if (o2.suffix) wrap.append(el("span", "font-size:11px;color:var(--omp-text-dim);white-space:nowrap;", o2.suffix));
    return wrap;
  };
  const text = (get: () => string, set: (v: string) => void, ph = ""): HTMLInputElement => {
    const i = el("input") as HTMLInputElement;
    i.value = get();
    i.placeholder = ph;
    i.addEventListener("input", () => set(i.value));
    return i;
  };
  const check = (txt: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const l = el("label", "display:flex;align-items:center;gap:6px;font-size:12px;");
    const i = el("input") as HTMLInputElement;
    i.type = "checkbox";
    i.checked = get();
    i.addEventListener("change", () => set(i.checked));
    l.append(i, document.createTextNode(txt));
    return l;
  };
  const grid = (cols = 2): HTMLElement => el("div", `display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px 14px;`);
  const section = (title: string, hint: string, open = false): { box: HTMLDetailsElement; content: HTMLElement } => {
    const box = el("details", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 10px;") as HTMLDetailsElement;
    box.open = open;
    const s = el("summary", "cursor:pointer;font-weight:600;", title);
    const content = el("div", "display:flex;flex-direction:column;gap:8px;margin-top:8px;");
    if (hint) content.append(el("div", "font-size:11px;color:var(--omp-text-dim);", hint));
    box.append(s, content);
    return { box, content };
  };

  // ---- Allgemein ----
  const gen = section(tt("ing.cfg.general"), tt("ing.cfg.general.hint"), true);
  const g1 = grid();
  g1.append(
    field(tt("ing.cfg.lead"), num(() => c.leadTimeS, (v) => (c.leadTimeS = v ?? 0), { min: 0, max: 3600, step: 1, suffix: "s" }), tt("ing.cfg.lead.help")),
    field(tt("ing.cfg.dev"), num(() => c.maxStartDeviationS, (v) => (c.maxStartDeviationS = v ?? 0), { min: 1, step: 1, suffix: "s" }), tt("ing.cfg.dev.help")),
    field(tt("ing.cfg.horizon"), num(() => c.horizonHours, (v) => (c.horizonHours = v ?? 0), { min: 1, max: 720, step: 1, suffix: "h" }), tt("ing.cfg.horizon.help")),
    field(tt("ing.cfg.media"), text(() => c.mediaDir, (v) => (c.mediaDir = v), "data"), tt("ing.cfg.media.help")),
  );
  gen.content.append(g1);

  // ---- Richtlinien ----
  const pol = section(tt("ing.cfg.policy"), tt("ing.cfg.policy.hint"));
  const modeSel = el("select") as HTMLSelectElement;
  for (const mo of LATE_MODES) {
    const op = el("option", "", tt("ing.cfg.late." + mo));
    op.value = mo;
    modeSel.append(op);
  }
  modeSel.value = c.defaultLate.mode || "wait";
  const delayField = field(tt("ing.cfg.late.max"), num(() => (c.defaultLate.maxDelayS ?? 600) / 60, (v) => (c.defaultLate.maxDelayS = Math.round((v ?? 0) * 60)), { min: 0, step: 1, suffix: tt("ing.unit.min") }));
  const syncDelay = () => (delayField.style.display = modeSel.value === "delay" ? "" : "none");
  modeSel.addEventListener("change", () => {
    c.defaultLate.mode = modeSel.value;
    syncDelay();
  });
  syncDelay();
  const g2 = grid();
  g2.append(
    field(tt("ing.cfg.late"), modeSel, tt("ing.cfg.late.help")),
    delayField,
    field(tt("ing.cfg.retry.n"), num(() => c.defaultRetry.maxAttempts, (v) => (c.defaultRetry.maxAttempts = v), { min: 1, max: 10, step: 1 }), tt("ing.cfg.retry.n.help")),
    field(tt("ing.cfg.retry.b"), num(() => c.defaultRetry.backoffS, (v) => (c.defaultRetry.backoffS = v), { min: 0, step: 1, suffix: "s" })),
    field(tt("ing.cfg.retry.r"), num(() => c.defaultRetry.minRemainingS, (v) => (c.defaultRetry.minRemainingS = v), { min: 0, step: 1, suffix: "s" }), tt("ing.cfg.retry.r.help")),
  );
  pol.content.append(g2);

  // ---- Regeln ----
  const rul = section(tt("ing.cfg.rules"), tt("ing.cfg.rules.hint"));
  const g3 = grid();
  g3.append(
    field(tt("ing.cfg.srclimit"), num(() => c.rules.sourceLimit, (v) => (c.rules.sourceLimit = v), { min: 1, step: 1 }), tt("ing.cfg.srclimit.help")),
    field(tt("ing.cfg.resprio"), num(() => c.rules.reserveFromPriority, (v) => (c.rules.reserveFromPriority = v), { min: 0, step: 1 }), tt("ing.cfg.resprio.help")),
  );
  rul.content.append(g3, el("div", "font-size:11px;color:var(--omp-text-dim);", tt("ing.cfg.respct")));
  const g4 = grid(3);
  for (const r of RESOURCE_KINDS) {
    g4.append(field(tt("ing.res." + r), num(() => c.rules.reservePct?.[r], (v) => {
      c.rules.reservePct ??= {};
      if (v === undefined) delete c.rules.reservePct[r];
      else c.rules.reservePct[r] = v;
    }, { min: 0, max: 100, step: 1, suffix: "%", ph: "0" })));
  }
  rul.content.append(g4, check(tt("ing.cfg.preempt"), () => !!c.rules.allowPreempt, (v) => (c.rules.allowPreempt = v)));

  // ---- Budgets ----
  const bud = section(tt("ing.cfg.budgets"), tt("ing.cfg.budgets.hint"));
  const budgetEditor = (b: HostBudget): HTMLElement => {
    const w = el("div", "display:flex;flex-direction:column;gap:8px;");
    const g = grid(3);
    for (const r of RESOURCE_KINDS) {
      g.append(field(tt("ing.res." + r) + (unit(r) ? ` (${unit(r)})` : ""), num(() => b.hard?.[r], (v) => {
        b.hard ??= {};
        if (v === undefined) delete b.hard[r];
        else b.hard[r] = v;
      }, { min: 0 })));
    }
    const g2b = grid();
    g2b.append(field(tt("ing.cfg.soft"), num(() => (b.softFraction === undefined ? undefined : Math.round(b.softFraction * 100)), (v) => (b.softFraction = v === undefined ? undefined : v / 100), { min: 1, max: 100, step: 1, suffix: "%" }), tt("ing.cfg.soft.help")));
    const fn = el("div", "display:flex;gap:14px;align-items:center;flex-wrap:wrap;");
    fn.append(el("span", "font-size:11px;color:var(--omp-text-dim);", tt("ing.cfg.functions")));
    for (const f of FUNCTIONS) {
      fn.append(check(tt("ing.cfg.fn." + f), () => !!b.functions?.includes(f), (on) => {
        const s = new Set(b.functions ?? []);
        if (on) s.add(f);
        else s.delete(f);
        b.functions = [...s];
      }));
    }
    w.append(g, g2b, fn);
    return w;
  };
  bud.content.append(el("div", "font-weight:600;font-size:12px;", tt("ing.cfg.budget.default")), budgetEditor(c.defaultBudget));
  const hostBox = el("div", "display:flex;flex-direction:column;gap:8px;");
  const renderHostBudgets = () => {
    hostBox.replaceChildren();
    for (const [key, b] of Object.entries(c.hostBudgets)) {
      const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;");
      const known = o.hosts.find((h) => h.id === key);
      const head = el("div", "display:flex;justify-content:space-between;align-items:center;");
      head.append(el("b", "", tt("ing.cfg.budget.host", { p0: known ? known.label : key })));
      const del = el("button", "", tt("ing.cfg.remove"));
      del.addEventListener("click", () => {
        delete c.hostBudgets[key];
        renderHostBudgets();
      });
      head.append(del);
      card.append(head, budgetEditor(b));
      hostBox.append(card);
    }
    const free = [{ id: "local", label: tt("ing.cfg.host.local") }, ...o.hosts.filter((h) => h.id !== "local")].filter((h) => !(h.id in c.hostBudgets));
    if (free.length) {
      const sel = el("select") as HTMLSelectElement;
      for (const h of free) {
        const op = el("option", "", h.label);
        op.value = h.id;
        sel.append(op);
      }
      const add = el("button", "", tt("ing.cfg.budget.add"));
      add.addEventListener("click", () => {
        c.hostBudgets[sel.value] = { hard: {}, functions: [...FUNCTIONS] };
        renderHostBudgets();
      });
      const row = el("div", "display:flex;gap:8px;align-items:center;");
      row.append(sel, add);
      hostBox.append(row);
    }
  };
  renderHostBudgets();
  bud.content.append(el("div", "font-weight:600;font-size:12px;margin-top:6px;", tt("ing.cfg.budget.hosts")), hostBox);

  // ---- Profile ----
  const prof = section(tt("ing.cfg.profiles"), tt("ing.cfg.profiles.hint"), true);
  const profBox = el("div", "display:flex;flex-direction:column;gap:8px;");
  const profileCard = (p: Profile): HTMLElement => {
    const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:8px;");
    card.dataset.profile = p.id;
    const head = el("div", "display:flex;justify-content:space-between;align-items:center;");
    head.append(el("b", "", p.label || p.id), el("code", "font-size:11px;color:var(--omp-text-dim);", p.id));
    const g = grid();
    const preset = el("select") as HTMLSelectElement;
    const known = FORMAT_PRESETS.some((f) => f.ext === p.ext);
    for (const f of FORMAT_PRESETS) {
      const op = el("option", "", `${f.label} (${f.ext})`);
      op.value = f.ext;
      preset.append(op);
    }
    const other = el("option", "", tt("ing.cfg.fmt.other"));
    other.value = "";
    preset.append(other);
    preset.value = known ? p.ext : "";
    const ext = text(() => p.ext, (v) => (p.ext = v), ".mxf");
    ext.style.display = known ? "none" : "";
    preset.addEventListener("change", () => {
      if (preset.value) {
        p.ext = preset.value;
        ext.value = preset.value;
        ext.style.display = "none";
      } else ext.style.display = "";
    });
    const fmt = el("div", "display:flex;flex-direction:column;gap:4px;");
    fmt.append(preset, ext);
    g.append(
      field(tt("ing.cfg.p.label"), text(() => p.label, (v) => (p.label = v))),
      field(tt("ing.cfg.p.format"), fmt, tt("ing.cfg.p.format.help")),
    );
    card.append(head, g);

    card.append(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("ing.cfg.p.demand")));
    const gd = grid(3);
    for (const r of DEMAND_KINDS) {
      gd.append(field(tt("ing.res." + r) + (unit(r) ? ` (${unit(r)})` : ""), num(() => p.demand?.[r], (v) => {
        p.demand ??= {};
        if (v === undefined) delete p.demand[r];
        else p.demand[r] = v;
      }, { min: 0, ph: tt("ing.cfg.p.auto") })));
    }
    card.append(gd, el("div", "font-size:10px;color:var(--omp-text-dim);", tt("ing.cfg.p.demand.help")));

    // Nachbearbeitung
    const convBox = el("div", "display:flex;flex-direction:column;gap:6px;padding-left:18px;");
    const renderConv = () => {
      convBox.replaceChildren();
      if (!p.convert) return;
      const cv = p.convert;
      const cg = grid();
      cg.append(
        field(tt("ing.cfg.c.ext"), text(() => cv.ext, (v) => (cv.ext = v), ".mp4")),
        field(tt("ing.cfg.c.args"), text(() => joinArgs(cv.args), (v) => (cv.args = splitArgs(v)), "-c:v libx264 -crf 23 -c:a aac"), tt("ing.cfg.c.args.help"), true),
      );
      convBox.append(cg);
    };
    card.append(check(tt("ing.cfg.p.convert"), () => !!p.convert, (on) => {
      p.convert = on ? { ext: ".mp4", args: ["-c:v", "libx264", "-crf", "23", "-c:a", "aac"] } : null;
      renderConv();
    }), convBox);
    renderConv();

    const del = el("button", "align-self:flex-start;", tt("ing.cfg.remove"));
    del.addEventListener("click", async () => {
      if (!(await confirmDialog(tt("ing.cfg.p.remove.q", { p0: p.label || p.id })))) return;
      delete c.profiles[p.id];
      renderProfiles();
    });
    card.append(del);
    return card;
  };
  const renderProfiles = () => {
    profBox.replaceChildren(...Object.values(c.profiles).map(profileCard));
  };
  renderProfiles();
  const addProfile = el("button", "align-self:flex-start;", "+ " + tt("ing.cfg.p.add"));
  addProfile.addEventListener("click", () => {
    const id = newProfileId(tt("ing.cfg.p.new"), Object.keys(c.profiles));
    c.profiles[id] = { id, label: tt("ing.cfg.p.new") + (id.match(/-(\d+)$/)?.[1] ? " " + id.match(/-(\d+)$/)![1] : ""), ext: ".mp4", convert: null };
    renderProfiles();
  });
  prof.content.append(profBox, addProfile);

  // ---- Fuß ----
  const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:4px;");
  const cancel = el("button", "", tt("ing.close"));
  const save = el("button", "", tt("ing.save"));
  save.className = "omp-btn-primary";
  cancel.addEventListener("click", () => overlay.remove());
  save.addEventListener("click", async () => {
    const problems = validateConfig(c);
    if (problems.length) {
      err.textContent = problems.map((p) => tt(p.key, { p0: p.p0 ?? "" })).join("\n");
      return;
    }
    err.textContent = "";
    save.disabled = true;
    const r = await o.save(c);
    save.disabled = false;
    if (!r.ok) {
      err.textContent = r.message;
      return;
    }
    overlay.remove();
    showToast(tt("ing.saved"));
  });
  row.append(cancel, save);
  body.append(gen.box, pol.box, rul.box, bud.box, prof.box);
  m.append(h1, el("div", "font-size:12px;color:var(--omp-text-dim);margin-bottom:8px;", tt("ing.settings.hint")), body, err, row);
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && overlay.remove());
  overlay.append(m);
  document.body.append(overlay);
}
