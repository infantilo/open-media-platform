// Admin → Zugriff → Quellen und Senken: wer welche Quellen/Senken sehen und schalten darf.
// Regeln je Nutzer, Gruppe oder für alle; „Sperren“ ist eine Blacklist, „Erlauben“ macht daraus eine Freigabeliste.
// Auswertung und Durchsetzung im Orchestrator (internal/accessrules); hier nur Pflege und Vorschau.
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";
import { buttonRow, showDialog } from "./dialog-kit.ts";
import {
  type AccessRule,
  emptyLookups,
  type Lookups,
  modeOf,
  SELECTOR_TYPES,
  selectorLabel,
  sortRules,
  subjectLabel,
  validateDraft,
} from "./access-rules-logic.ts";

interface Option {
  value: string;
  label: string;
}

interface Effective {
  user: string;
  exempt: boolean;
  hasRules: boolean;
  sources: EffRow[];
  sinks: EffRow[];
}
interface EffRow {
  id: string;
  label: string;
  node: string;
  mediaType: string;
  visible: boolean;
  routable: boolean;
  reason: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const SELECTOR_WORDS = () => ({
  all: t("acc.sel.all"), node: t("acc.sel.node"), endpoint: t("acc.sel.endpoint"), workflow: t("acc.sel.workflow"),
  tag: t("acc.sel.tag"), media: t("acc.sel.media"), label: t("acc.sel.label"),
});

export class AccessRulesPanel {
  readonly el: HTMLElement;
  #body = el("div");
  #rules: AccessRule[] = [];
  #lk: Lookups = emptyLookups();
  #users: string[] = [];
  #groups: Option[] = [];
  #nodes: Option[] = [];
  #workflows: Option[] = [];
  #endpoints: Option[] = [];
  #tags: string[] = [];
  #filter = "";
  #seq = 0;

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:1100px;");
    this.el.append(this.#body);
  }

  start() {
    void this.refresh();
  }

  async refresh() {
    const seq = ++this.#seq;
    try {
      const get = async (url: string) => {
        const r = await apiFetch(url);
        return r.ok ? await r.json() : null;
      };
      const [rules, users, groups, workflows, sources, sinks] = await Promise.all([
        get("/api/v1/access-rules"), get("/api/v1/auth/users"), get("/api/v1/groups"), get("/api/v1/workflows"),
        get("/api/v1/sources"), get("/api/v1/sinks"),
      ]);
      if (seq !== this.#seq) return;
      this.#rules = Array.isArray(rules) ? rules : [];
      this.#users = (Array.isArray(users) ? users : []).map((u: { username: string }) => u.username);
      this.#groups = (Array.isArray(groups) ? groups : []).map((g: { id: string; name: string }) => ({ value: g.id, label: g.name }));
      this.#workflows = (Array.isArray(workflows) ? workflows : []).map((w: { id: string; name: string }) => ({ value: w.id, label: w.name }));
      const nodes = new Map<string, string>();
      const eps = new Map<string, string>();
      const tags = new Set<string>();
      for (const s of [...(Array.isArray(sources) ? sources : []), ...(Array.isArray(sinks) ? sinks : [])]) {
        nodes.set(s.nodeId, s.nodeLabel);
        eps.set(s.senderId ?? s.receiverId, `${s.nodeLabel} / ${s.label}`);
        for (const tg of s.tags ?? []) tags.add(tg.tag);
      }
      this.#nodes = [...nodes].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
      this.#endpoints = [...eps].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
      this.#tags = [...tags].sort();
      this.#lk = {
        groups: new Map(this.#groups.map((g) => [g.value, g.label])),
        nodes,
        workflows: new Map(this.#workflows.map((w) => [w.value, w.label])),
        endpoints: eps,
      };
      this.#render();
    } catch {
      this.#body.replaceChildren(el("div", "color:var(--omp-error);", t("acc.loadError")));
    }
  }

  // ---- Darstellung -------------------------------------------------------------------------------------------------

  #render() {
    const title = el("span", "", t("acc.title"));
    title.className = "omp-h1";
    const intro = el("div", "font-size:12px;color:var(--omp-text-dim);margin:6px 0 12px;max-width:820px;line-height:1.5;");
    intro.append(
      t("acc.intro1") + " ",
      el("b", "", t("acc.intro2")),
      " " + t("acc.intro3"),
    );

    const bar = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;");
    const add = el("button", "", "+ " + t("acc.add"));
    add.className = "omp-btn-primary";
    add.addEventListener("click", () => void this.#edit(null));
    const sel = el("select");
    sel.setAttribute("aria-label", t("acc.filter"));
    sel.append(new Option(t("acc.filterAll"), ""), new Option(t("acc.filterGlobal"), "global"));
    for (const g of this.#groups) sel.append(new Option(`${t("acc.group")} ${g.label}`, `group:${g.value}`));
    for (const u of this.#users) sel.append(new Option(`${t("acc.user")} ${u}`, `user:${u}`));
    sel.value = this.#filter;
    sel.addEventListener("change", () => {
      this.#filter = sel.value;
      this.#render();
    });
    bar.append(add, sel);

    this.#body.replaceChildren(title, intro, this.#modes(), bar, this.#table(), this.#preview());
  }

  /** Eine Zeile je Art und Handlung: offen, nur Sperren oder Freigabeliste (aus allen Regeln). */
  #modes(): HTMLElement {
    const box = el("div", "display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;");
    const modeText = { open: t("acc.mode.open"), blacklist: t("acc.mode.blacklist"), whitelist: t("acc.mode.whitelist") };
    const color = { open: "var(--omp-text-dim)", blacklist: "var(--omp-cue)", whitelist: "var(--omp-info)" };
    for (const kind of ["source", "sink"] as const) {
      for (const action of ["see", "route"] as const) {
        const m = modeOf(this.#rules, kind, action);
        const chip = el("span", `font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid ${color[m]};color:${color[m]};`);
        chip.textContent = `${t(kind === "source" ? "acc.kind.source" : "acc.kind.sink")} · ${t(action === "see" ? "acc.act.see" : "acc.act.route")}: ${modeText[m]}`;
        box.append(chip);
      }
    }
    return box;
  }

  #matchesFilter(r: AccessRule): boolean {
    if (!this.#filter) return true;
    if (this.#filter === "global") return r.subjectType === "global";
    const [type, subj] = [this.#filter.slice(0, this.#filter.indexOf(":")), this.#filter.slice(this.#filter.indexOf(":") + 1)];
    return r.subjectType === type && r.subject === subj;
  }

  #table(): HTMLElement {
    const rules = sortRules(this.#rules.filter((r) => this.#matchesFilter(r)), this.#lk);
    if (rules.length === 0) {
      return el("div", "color:var(--omp-text-dim);padding:12px 0;", this.#rules.length === 0 ? t("acc.none") : t("acc.noneFiltered"));
    }
    const table = el("div", "display:grid;grid-template-columns:minmax(120px,1.1fr) 110px 100px 110px minmax(160px,1.6fr) minmax(80px,1fr) 96px;gap:0;font-size:12px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;");
    for (const h of ["acc.col.who", "acc.col.kind", "acc.col.action", "acc.col.effect", "acc.col.target", "acc.col.note", ""]) {
      table.append(el("div", "padding:6px 8px;font-weight:600;background:var(--omp-surface-raised);border-bottom:1px solid var(--omp-border);", h ? t(h as "acc.col.who") : ""));
    }
    const words = SELECTOR_WORDS();
    rules.forEach((r, i) => {
      const cell = (text: string, css = "") => el("div", `padding:6px 8px;${i % 2 ? "background:rgba(255,255,255,.02);" : ""}overflow-wrap:anywhere;${css}`, text);
      const allow = r.effect === "allow";
      table.append(
        cell(subjectLabel(r, this.#lk, { all: t("acc.all"), user: t("acc.user"), group: t("acc.group") }), "font-weight:600;"),
        cell(t(r.kind === "source" ? "acc.kind.source" : "acc.kind.sink")),
        cell(t(r.action === "see" ? "acc.act.see" : "acc.act.route")),
        cell((allow ? "✓ " : "✕ ") + t(allow ? "acc.eff.allow" : "acc.eff.deny"), `color:${allow ? "var(--omp-preset)" : "var(--omp-error)"};font-weight:600;`),
        cell(selectorLabel(r, this.#lk, words)),
        cell(r.note ?? "", "color:var(--omp-text-dim);"),
      );
      const actions = el("div", `padding:4px 6px;display:flex;gap:4px;${i % 2 ? "background:rgba(255,255,255,.02);" : ""}`);
      const edit = el("button", "padding:0 8px;min-height:26px;", "✎");
      edit.title = t("acc.edit");
      edit.addEventListener("click", () => void this.#edit(r));
      const del = el("button", "padding:0 8px;min-height:26px;", "🗑");
      del.title = t("acc.delete");
      del.className = "omp-btn-danger";
      del.addEventListener("click", () => void this.#delete(r));
      actions.append(edit, del);
      table.append(actions);
    });
    return table;
  }

  // ---- Wirkung prüfen ----------------------------------------------------------------------------------------------

  #previewUser = "";
  #previewData: Effective | null = null;

  #preview(): HTMLElement {
    const box = el("div", "margin-top:var(--omp-space-4);border-top:1px solid var(--omp-border);padding-top:var(--omp-space-3);");
    box.append(el("div", "font-weight:600;margin-bottom:4px;", t("acc.preview.title")));
    box.append(el("div", "font-size:12px;color:var(--omp-text-dim);margin-bottom:8px;", t("acc.preview.hint")));
    const row = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    const sel = el("select");
    sel.setAttribute("aria-label", t("acc.preview.user"));
    sel.append(new Option(t("acc.preview.pick"), ""));
    for (const u of this.#users) sel.append(new Option(u, u));
    sel.value = this.#previewUser;
    sel.addEventListener("change", async () => {
      this.#previewUser = sel.value;
      this.#previewData = null;
      if (sel.value) await this.#loadPreview(sel.value);
      this.#render();
    });
    row.append(sel);
    box.append(row);
    const d = this.#previewData;
    if (d) {
      if (d.exempt) box.append(el("div", "color:var(--omp-cue);font-size:12px;margin-bottom:6px;", "ℹ " + t("acc.preview.exempt")));
      else if (!d.hasRules) box.append(el("div", "color:var(--omp-text-dim);font-size:12px;margin-bottom:6px;", t("acc.preview.noRules")));
      for (const [titleKey, rows] of [["acc.kind.source", d.sources], ["acc.kind.sink", d.sinks]] as const) {
        const vis = rows.filter((r) => r.visible).length;
        const rt = rows.filter((r) => r.routable).length;
        const det = el("details", "margin-bottom:6px;");
        det.append(el("summary", "cursor:pointer;font-size:12px;font-weight:600;", `${t(titleKey)}: ${t("acc.preview.counts", { p0: vis, p1: rt, p2: rows.length })}`));
        const list = el("div", "max-height:240px;overflow:auto;font-size:12px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);margin-top:4px;");
        for (const r of rows) {
          const line = el("div", "display:grid;grid-template-columns:1.4fr 70px 70px 2fr;gap:8px;padding:3px 8px;");
          const status = (ok: boolean) => el("span", `color:${ok ? "var(--omp-preset)" : "var(--omp-error)"};`, ok ? "✓" : "✕");
          const v = status(r.visible);
          const s = status(r.routable);
          line.append(el("span", "overflow-wrap:anywhere;", `${r.node} / ${r.label}`), v, s, el("span", "color:var(--omp-text-dim);overflow-wrap:anywhere;", r.reason));
          list.append(line);
        }
        const head = el("div", "display:grid;grid-template-columns:1.4fr 70px 70px 2fr;gap:8px;padding:3px 8px;font-weight:600;background:var(--omp-surface-raised);");
        head.append(el("span", "", ""), el("span", "", t("acc.act.see")), el("span", "", t("acc.act.route")), el("span", "", t("acc.preview.reason")));
        list.prepend(head);
        det.append(list);
        box.append(det);
      }
    }
    return box;
  }

  async #loadPreview(user: string) {
    try {
      const r = await apiFetch(`/api/v1/access-rules/effective?user=${encodeURIComponent(user)}`);
      if (r.ok) this.#previewData = (await r.json()) as Effective;
    } catch {
      showToast(t("acc.loadError"));
    }
  }

  // ---- Anlegen, Ändern, Löschen --------------------------------------------------------------------------------------

  async #delete(r: AccessRule) {
    const what = `${subjectLabel(r, this.#lk, { all: t("acc.all"), user: t("acc.user"), group: t("acc.group") })} — ${selectorLabel(r, this.#lk, SELECTOR_WORDS())}`;
    if (!(await confirmDialog(t("acc.confirmDelete", { p0: what }), { confirmLabel: t("acc.delete") }))) return;
    const res = await apiFetch(`/api/v1/access-rules/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    if (!res.ok) showToast(t("acc.saveFailed", { p0: await res.text() }));
    await this.refresh();
  }

  async #edit(existing: AccessRule | null) {
    const draft: AccessRule = existing ? { ...existing } : {
      id: "", subjectType: "group", subject: this.#groups[0]?.value ?? "", kind: "source", action: "see", effect: "deny", selectorType: "node", selectorValue: "",
    };
    // Beim Anlegen lassen sich „Sehen“ und „Schalten“ zugleich wählen (zwei Regeln); beim Ändern gilt eine Handlung.
    const both = { see: draft.action === "see", route: draft.action === "route" };
    const result = await showDialog<AccessRule[]>(existing ? t("acc.dlg.edit") : t("acc.dlg.add"), (body, done) => {
      const field = (label: string, input: HTMLElement) => {
        const w = el("label", "display:block;margin-bottom:10px;");
        w.append(el("div", "font-size:12px;font-weight:600;margin-bottom:3px;", label), input);
        return w;
      };
      const selectOf = (opts: Option[], value: string) => {
        const s = el("select", "width:100%;");
        for (const o of opts) s.append(new Option(o.label, o.value));
        s.value = value;
        return s;
      };
      // Wer
      const subjType = selectOf([
        { value: "global", label: t("acc.all") }, { value: "group", label: t("acc.group") }, { value: "user", label: t("acc.user") },
      ], draft.subjectType);
      const subjPick = el("select", "width:100%;");
      const fillSubject = () => {
        subjPick.replaceChildren();
        const opts: Option[] = subjType.value === "group" ? this.#groups : this.#users.map((u) => ({ value: u, label: u }));
        for (const o of opts) subjPick.append(new Option(o.label, o.value));
        subjPick.style.display = subjType.value === "global" ? "none" : "";
        if (draft.subjectType === subjType.value && draft.subject) subjPick.value = draft.subject;
        else if (opts[0]) subjPick.value = opts[0].value;
      };
      subjType.addEventListener("change", fillSubject);
      fillSubject();
      const who = el("div", "display:grid;grid-template-columns:1fr 1.4fr;gap:8px;");
      who.append(subjType, subjPick);
      body.append(field(t("acc.col.who"), who));

      // Was
      const kind = selectOf([{ value: "source", label: t("acc.kind.source") }, { value: "sink", label: t("acc.kind.sink") }], draft.kind);
      const effect = selectOf([{ value: "deny", label: "✕ " + t("acc.eff.deny") }, { value: "allow", label: "✓ " + t("acc.eff.allow") }], draft.effect);
      const row1 = el("div", "display:grid;grid-template-columns:1fr 1fr;gap:8px;");
      row1.append(field(t("acc.col.kind"), kind), field(t("acc.col.effect"), effect));
      body.append(row1);

      const acts = el("div", "display:flex;gap:16px;margin-bottom:10px;");
      const mkCheck = (key: "see" | "route", label: string) => {
        const l = el("label", "display:flex;gap:6px;align-items:center;cursor:pointer;");
        const c = el("input");
        c.type = existing ? "radio" : "checkbox";
        c.name = "acc-action";
        c.checked = both[key];
        c.addEventListener("change", () => {
          if (existing) {
            both.see = key === "see";
            both.route = key === "route";
          } else both[key] = c.checked;
        });
        l.append(c, label);
        return l;
      };
      acts.append(mkCheck("see", t("acc.act.see")), mkCheck("route", t("acc.act.route")));
      body.append(field(t("acc.col.action"), acts));

      // Ziel
      const selType = selectOf(SELECTOR_TYPES.map((s) => ({ value: s, label: t(`acc.sel.${s}` as "acc.sel.all") })), draft.selectorType);
      const valInput = el("input", "width:100%;box-sizing:border-box;");
      valInput.type = "text";
      const list = document.createElement("datalist");
      list.id = "acc-values";
      valInput.setAttribute("list", list.id);
      const valSelect = el("select", "width:100%;");
      const hint = el("div", "font-size:11px;color:var(--omp-text-dim);margin-top:3px;");
      const fillValue = () => {
        const ty = selType.value as AccessRule["selectorType"];
        const pick = (opts: Option[]) => {
          valSelect.replaceChildren();
          for (const o of opts) valSelect.append(new Option(o.label, o.value));
          valSelect.value = draft.selectorType === ty && draft.selectorValue ? draft.selectorValue : (opts[0]?.value ?? "");
        };
        valInput.style.display = "none";
        valSelect.style.display = "none";
        hint.textContent = "";
        if (ty === "all") return;
        if (ty === "node") pick(this.#nodes);
        else if (ty === "endpoint") pick(this.#endpoints);
        else if (ty === "workflow") pick(this.#workflows);
        else if (ty === "media") pick(["video", "audio", "data"].map((m) => ({ value: m, label: m })));
        else {
          valInput.style.display = "";
          valInput.value = draft.selectorType === ty ? (draft.selectorValue ?? "") : "";
          list.replaceChildren(...(ty === "tag" ? this.#tags : []).map((tg) => new Option(tg, tg)));
          hint.textContent = ty === "label" ? t("acc.hint.label") : t("acc.hint.tag");
          return;
        }
        valSelect.style.display = "";
      };
      selType.addEventListener("change", fillValue);
      fillValue();
      const target = el("div", "display:grid;grid-template-columns:1fr 1.6fr;gap:8px;");
      target.append(selType, el("div"));
      target.lastElementChild!.append(valSelect, valInput, list);
      body.append(field(t("acc.col.target"), target), hint);

      const note = el("input", "width:100%;box-sizing:border-box;");
      note.type = "text";
      note.value = draft.note ?? "";
      body.append(field(t("acc.col.note"), note));

      const err = el("div", "color:var(--omp-error);font-size:12px;min-height:16px;");
      body.append(err);
      body.append(buttonRow(t("acc.save"), () => {
        const ty = selType.value as AccessRule["selectorType"];
        const value = ty === "all" ? "" : valInput.style.display !== "none" ? valInput.value.trim() : valSelect.value;
        const base: AccessRule = {
          ...draft, subjectType: subjType.value as AccessRule["subjectType"], subject: subjType.value === "global" ? "" : subjPick.value,
          kind: kind.value as AccessRule["kind"], effect: effect.value as AccessRule["effect"], selectorType: ty, selectorValue: value, note: note.value.trim(),
        };
        const bad = validateDraft(base);
        if (bad) {
          err.textContent = t(bad === "subject" ? "acc.err.subject" : "acc.err.value");
          return;
        }
        const actions = (["see", "route"] as const).filter((a) => both[a]);
        if (actions.length === 0) {
          err.textContent = t("acc.err.action");
          return;
        }
        done(actions.map((a) => ({ ...base, action: a })));
      }, () => done(null)));
    }, true);
    if (!result) return;
    for (const rule of result) {
      const res = await apiFetch(existing ? `/api/v1/access-rules/${encodeURIComponent(existing.id)}` : "/api/v1/access-rules", {
        method: existing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        showToast(t("acc.saveFailed", { p0: (await res.text()).trim() }));
        break;
      }
    }
    await this.refresh();
  }
}
