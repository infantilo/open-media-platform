// Rechte-Editor (Admin → Rechte): ersetzt die frühere Bindungs-Tabelle.
// Zwei Blickrichtungen auf dieselben Daten, beide mit Suche:
//   • "Wer?"     Nutzer/Gruppe wählen → sehen und setzen, worauf er/sie darf
//   • "Worauf?"  Bereich wählen (global, Workflow, Rolle, Node, Prozess)
//                → sehen und setzen, wer darauf darf
// Ein Recht je Subjekt und Bereich; Ändern/Hinzufügen/Entfernen wirkt sofort
// (kein Speichern-Knopf, jede Zeile ist ein eigener Server-Aufruf).
import { getLang, t } from "./i18n.ts";
import { coveringGrant, type FeatureDef, type FeatureGrant, grantsOf, planToggle, planToggleModule, sectionsOf, type TogglePlan } from "./feature-grants-logic.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import {
  type Binding,
  bindingsOfResource,
  bindingsOfSubject,
  buildResourceOptions,
  matchesQuery,
  type NodeLike,
  planSet,
  type ProcessLike,
  resourceOf,
  type ResourceOption,
  SCOPE_KINDS,
  type ScopeKind,
  sortByScope,
  subjectKey,
  type SubjectRef,
  type Verb,
  VERBS,
  type WorkflowLike,
} from "./permissions-logic.ts";

export interface PermUser {
  username: string;
  isAdmin: boolean;
}
export interface PermGroup {
  id: string;
  name: string;
}
export interface PermData {
  users: PermUser[];
  groups: PermGroup[];
  groupMembers: Map<string, string[]>;
  bindings: Binding[];
  nodes: NodeLike[];
  workflows: WorkflowLike[];
  processes: ProcessLike[];
  /** Funktionsrechte (Kapitel 44): Katalog der Module und Vergaben. */
  features?: FeatureDef[];
  featureGrants?: FeatureGrant[];
}

type Mode = "subject" | "resource";

interface PickItem {
  key: string;
  kind: string;
  title: string;
  subtitle: string;
  search: string;
  payload: unknown;
}

const MAX_SUGGESTIONS = 12;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const SEG_ON = "background:var(--omp-surface-raised);color:var(--omp-text);";
const SEG_OFF = "background:transparent;color:var(--omp-text-dim);";

export class PermissionsEditor {
  readonly el: HTMLElement;
  #data: PermData = { users: [], groups: [], groupMembers: new Map(), bindings: [], nodes: [], workflows: [], processes: [] };
  #mode: Mode = "subject";
  #search = "";
  #selected = ""; // subjectKey(...) bzw. Ressourcen-Key, je nach Modus
  #pickKind = "all";
  #picked: PickItem | null = null;
  #verb: Verb = "operate";
  #busy = false;
  #error = "";
  #list = el("div");
  #detail = el("div");
  #modeBar = el("div");
  #onChanged: () => Promise<void>;

  constructor(onChanged: () => Promise<void>) {
    this.#onChanged = onChanged;
    this.el = el("div", "margin-bottom:var(--omp-space-4);");

    const head = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;");
    const title = el("span", "", t("perm.title"));
    title.className = "omp-h1";
    head.append(title, this.#modeBar);
    const hint = el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:8px;", t("perm.hint"));
    this.el.append(head, hint);

    const searchWrap = el("span", "display:block;margin-bottom:8px;");
    searchWrap.className = "omp-search-wrap";
    const search = el("input", "width:100%;max-width:520px;");
    search.className = "omp-search-input";
    search.type = "search";
    search.placeholder = t("perm.search.ph");
    search.addEventListener("input", () => {
      this.#search = search.value;
      this.#renderList();
    });
    searchWrap.appendChild(search);
    this.el.appendChild(searchWrap);

    const cols = el("div", "display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;");
    this.#list.style.cssText =
      "flex:0 0 300px;max-width:100%;max-height:70vh;overflow:auto;border:1px solid var(--omp-border);border-radius:var(--omp-radius);";
    this.#detail.style.cssText =
      "flex:1 1 420px;min-width:300px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:10px 12px;";
    cols.append(this.#list, this.#detail);
    this.el.appendChild(cols);
    this.#renderAll();
  }

  setData(d: PermData) {
    this.#data = d;
    this.#renderAll();
  }

  // ---- abgeleitete Daten ------------------------------------------------

  #options(): ResourceOption[] {
    return buildResourceOptions(this.#data.nodes, this.#data.workflows, this.#data.processes, {
      global: t("perm.scope.global"),
      wholeWorkflow: t("perm.scope.whole"),
      allProcesses: t("perm.kind.process"),
    });
  }

  #subjects(): { ref: SubjectRef; title: string; sub: string; admin: boolean }[] {
    const users = this.#data.users.map((u) => ({
      ref: { type: "user" as const, id: u.username },
      title: u.username,
      sub: this.#userGroups(u.username).map((g) => g.name).join(", "),
      admin: u.isAdmin,
    }));
    const groups = this.#data.groups.map((g) => ({
      ref: { type: "group" as const, id: g.id },
      title: g.name,
      sub: t("perm.members", { p0: (this.#data.groupMembers.get(g.id) ?? []).length }),
      admin: false,
    }));
    return [...users, ...groups];
  }

  #userGroups(username: string): PermGroup[] {
    return this.#data.groups.filter((g) => (this.#data.groupMembers.get(g.id) ?? []).includes(username));
  }

  #subjectTitle(type: string, id: string): string {
    if (type === "group") return this.#data.groups.find((g) => g.id === id)?.name ?? id;
    return id;
  }

  #kindLabel(k: ScopeKind): string {
    return t(`perm.kind.${k}` as never);
  }

  #verbLabel(v: string): string {
    return t(`perm.verb.${v}` as never);
  }

  // ---- Rendering ---------------------------------------------------------

  #renderAll() {
    this.#renderModeBar();
    this.#renderList();
    this.#renderDetail();
  }

  #seg<T extends string>(items: { value: T; label: string; title?: string }[], current: T, on: (v: T) => void): HTMLElement {
    const wrap = el("div", "display:inline-flex;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;flex-wrap:wrap;");
    for (const it of items) {
      const b = el("button", `font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 9px;${it.value === current ? SEG_ON : SEG_OFF}`, it.label);
      if (it.title) b.title = it.title;
      b.addEventListener("click", () => on(it.value));
      wrap.appendChild(b);
    }
    return wrap;
  }

  #renderModeBar() {
    this.#modeBar.replaceChildren(
      this.#seg<Mode>(
        [
          { value: "subject", label: t("perm.mode.subject") },
          { value: "resource", label: t("perm.mode.resource") },
        ],
        this.#mode,
        (m) => {
          if (m === this.#mode) return;
          this.#mode = m;
          this.#selected = "";
          this.#picked = null;
          this.#pickKind = "all";
          this.#error = "";
          this.#renderAll();
        },
      ),
    );
  }

  #listItem(icon: string, title: string, sub: string, count: number, key: string, tag = ""): HTMLElement {
    const active = key === this.#selected;
    const row = el(
      "div",
      "display:flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--omp-border);" +
        (active ? "background:var(--omp-surface-raised);" : ""),
    );
    row.append(el("span", "width:18px;text-align:center;", icon));
    const mid = el("div", "flex:1;min-width:0;");
    const ttl = el("div", "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" + (active ? "font-weight:600;" : ""), title);
    mid.appendChild(ttl);
    if (sub) mid.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", sub));
    row.appendChild(mid);
    if (tag) {
      const tg = el("span", "font-size:10px;padding:1px 5px;border-radius:8px;border:1px solid var(--omp-preset);color:var(--omp-preset);", tag);
      row.appendChild(tg);
    }
    const badge = el("span", "font-size:11px;color:var(--omp-text-dim);min-width:18px;text-align:right;", count > 0 ? String(count) : "");
    badge.title = t("perm.count", { p0: count });
    row.appendChild(badge);
    row.addEventListener("click", () => {
      this.#selected = key;
      this.#picked = null;
      this.#pickKind = "all";
      this.#error = "";
      this.#renderList();
      this.#renderDetail();
    });
    return row;
  }

  #sectionHead(text: string): HTMLElement {
    return el("div", "padding:4px 10px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--omp-text-dim);background:var(--omp-surface-raised);", text);
  }

  #renderList() {
    const q = this.#search.trim();
    const opts = this.#options();
    const frag: HTMLElement[] = [];
    let shown = 0;

    if (this.#mode === "subject") {
      const subs = this.#subjects().filter((s) => {
        if (!q) return true;
        const bs = bindingsOfSubject(this.#data.bindings, s.ref);
        const hay = [s.title, s.sub, ...bs.map((b) => resourceOf(b, opts).search + " " + this.#verbLabel(b.verb))].join(" ");
        return matchesQuery(hay, q);
      });
      for (const [type, head, icon] of [["user", t("perm.users"), "👤"], ["group", t("perm.groups"), "👥"]] as const) {
        const items = subs.filter((s) => s.ref.type === type).sort((a, b) => a.title.localeCompare(b.title));
        if (items.length === 0) continue;
        frag.push(this.#sectionHead(`${head} (${items.length})`));
        for (const s of items) {
          const n = bindingsOfSubject(this.#data.bindings, s.ref).length;
          frag.push(this.#listItem(icon, s.title, s.sub, n, subjectKey(s.ref.type, s.ref.id), s.admin ? t("perm.admin.tag") : ""));
          shown++;
        }
      }
    } else {
      const matching = opts.filter((o) => {
        if (!q) return true;
        const bs = bindingsOfResource(this.#data.bindings, o.workflowId, o.nodeId);
        const hay = [o.search, ...bs.map((b) => this.#subjectTitle(b.subjectType, b.subject))].join(" ");
        return matchesQuery(hay, q);
      });
      const icons: Record<ScopeKind, string> = { global: "🌐", workflow: "🗂", role: "🎚", node: "▣", process: "⚙" };
      for (const kind of SCOPE_KINDS) {
        const items = matching.filter((o) => o.kind === kind);
        if (items.length === 0) continue;
        frag.push(this.#sectionHead(`${this.#kindLabel(kind)} (${items.length})`));
        for (const o of items) {
          const n = bindingsOfResource(this.#data.bindings, o.workflowId, o.nodeId).length;
          frag.push(this.#listItem(icons[kind], o.title, o.subtitle, n, o.key));
          shown++;
        }
      }
    }
    if (shown === 0) frag.push(el("div", "padding:12px;color:var(--omp-text-dim);", t("perm.noMatch")));
    this.#list.replaceChildren(...frag);
  }

  #renderDetail() {
    const d = this.#detail;
    d.replaceChildren();
    if (!this.#selected) {
      d.appendChild(el("div", "color:var(--omp-text-dim);", t("perm.empty.pick")));
      return;
    }
    if (this.#error) d.appendChild(el("div", "color:var(--omp-error);margin-bottom:8px;", this.#error));
    if (this.#mode === "subject") this.#renderSubjectDetail(d);
    else this.#renderResourceDetail(d);
  }

  #verbSelect(current: string, onChange: (v: Verb) => void): HTMLSelectElement {
    const sel = el("select", "font-size:12px;");
    for (const v of VERBS) {
      const o = el("option", "", this.#verbLabel(v));
      o.value = v;
      o.selected = v === current;
      sel.appendChild(o);
    }
    sel.disabled = this.#busy;
    sel.addEventListener("change", () => onChange(sel.value as Verb));
    return sel;
  }

  #removeButton(onClick: () => void): HTMLElement {
    const b = el("button", "font-size:11px;", t("perm.remove"));
    b.className = "omp-btn-danger";
    b.disabled = this.#busy;
    b.addEventListener("click", onClick);
    return b;
  }

  #row(left: HTMLElement, right: HTMLElement[]): HTMLElement {
    const r = el("div", "display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--omp-border);");
    left.style.flex = "1";
    left.style.minWidth = "0";
    r.append(left, ...right);
    return r;
  }

  #titleSub(title: string, sub: string, warn = ""): HTMLElement {
    const w = el("div");
    w.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;", title));
    const s = [sub, warn].filter(Boolean).join(" · ");
    if (s) w.appendChild(el("div", `font-size:var(--omp-font-size-xs);color:${warn ? "var(--omp-error)" : "var(--omp-text-dim)"};`, s));
    return w;
  }

  #verbLegend(): HTMLElement {
    return el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:6px 0;", t("perm.legend"));
  }

  #renderSubjectDetail(d: HTMLElement) {
    const [type, ...rest] = this.#selected.split(":");
    const ref: SubjectRef = { type: type as "user" | "group", id: rest.join(":") };
    const opts = this.#options();
    const user = ref.type === "user" ? this.#data.users.find((u) => u.username === ref.id) : undefined;

    d.appendChild(el("div", "font-weight:600;font-size:15px;", `${ref.type === "group" ? "👥" : "👤"} ${this.#subjectTitle(ref.type, ref.id)}`));
    if (ref.type === "group") {
      const m = this.#data.groupMembers.get(ref.id) ?? [];
      d.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);", m.length ? t("perm.members.list", { p0: m.join(", ") }) : t("perm.members.none")));
    } else {
      const gs = this.#userGroups(ref.id);
      if (gs.length) d.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);", t("perm.memberOf", { p0: gs.map((g) => g.name).join(", ") })));
    }
    if (user?.isAdmin) d.appendChild(el("div", "color:var(--omp-preset);font-size:var(--omp-font-size-xs);margin-top:4px;", t("perm.admin.note")));
    d.appendChild(this.#verbLegend());

    const own = bindingsOfSubject(this.#data.bindings, ref).map((b) => ({ b, r: resourceOf(b, opts) }));
    const sorted = sortByScope(own.map((x) => ({ ...x, kind: x.r.kind, title: x.r.title })));
    if (sorted.length === 0) d.appendChild(el("div", "color:var(--omp-text-dim);padding:6px 0;", t("perm.none")));
    let lastKind = "";
    for (const { b, r } of sorted) {
      if (r.kind !== lastKind) {
        d.appendChild(el("div", "margin-top:8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--omp-text-dim);", this.#kindLabel(r.kind)));
        lastKind = r.kind;
      }
      d.appendChild(
        this.#row(this.#titleSub(r.title, r.subtitle, r.missing ? t("perm.missing") : ""), [
          this.#verbSelect(b.verb, (v) => this.#set(ref, r.workflowId, r.nodeId, v)),
          this.#removeButton(() => this.#remove(b, this.#subjectTitle(ref.type, ref.id), r.title)),
        ]),
      );
    }

    // Geerbte Rechte (nur Nutzer): nur lesen, Änderung bei der Gruppe.
    if (ref.type === "user") {
      for (const g of this.#userGroups(ref.id)) {
        const gb = bindingsOfSubject(this.#data.bindings, { type: "group", id: g.id });
        if (gb.length === 0) continue;
        d.appendChild(el("div", "margin-top:12px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--omp-text-dim);", t("perm.inherited", { p0: g.name })));
        for (const b of gb) {
          const r = resourceOf(b, opts);
          const open = el("button", "font-size:11px;", t("perm.openGroup"));
          open.addEventListener("click", () => {
            this.#selected = subjectKey("group", g.id);
            this.#renderAll();
          });
          d.appendChild(this.#row(this.#titleSub(r.title, `${this.#kindLabel(r.kind)}`), [el("span", "color:var(--omp-text-dim);", this.#verbLabel(b.verb)), open]));
        }
      }
    }

    this.#renderFeatureSection(d, ref);

    // Hinzufügen: Bereich suchen.
    const kinds = [{ value: "all", label: t("perm.kind.all") }, ...SCOPE_KINDS.map((k) => ({ value: k as string, label: this.#kindLabel(k) }))];
    const items: PickItem[] = opts.map((o) => ({ key: o.key, kind: o.kind, title: o.title, subtitle: o.subtitle, search: o.search, payload: o }));
    d.appendChild(
      this.#addBar(t("perm.add.pickScope"), kinds, items, (item, verb) => {
        const o = item.payload as ResourceOption;
        return this.#set(ref, o.workflowId, o.nodeId, verb);
      }),
    );
  }

  // ---- Funktionsrechte (Kapitel 44) --------------------------------------

  // Je Modul eine Gruppe von Schaltern. Ein Haken wirkt sofort (wie die Verben oben); „Alle Rechte des Moduls“ vergibt `modul.*`.
  // Geerbte Rechte aus Gruppen stehen ausgegraut mit Gruppenname daneben — geändert wird sie bei der Gruppe.
  #renderFeatureSection(d: HTMLElement, ref: SubjectRef) {
    const defs = this.#data.features ?? [];
    const box = el("div", "margin-top:16px;padding-top:10px;border-top:1px solid var(--omp-border);");
    box.appendChild(el("div", "font-weight:600;", t("perm.feat.title")));
    box.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:2px 0 6px;", t("perm.feat.hint")));
    d.appendChild(box);
    if (defs.length === 0) {
      box.appendChild(el("div", "color:var(--omp-text-dim);padding:4px 0;", t("perm.feat.none")));
      return;
    }
    const grants = this.#data.featureGrants ?? [];
    const own = grantsOf(grants, ref.type, ref.id);
    const groupGrants = ref.type === "user" ? this.#userGroups(ref.id).flatMap((g) => grantsOf(grants, "group", g.id).map((x) => ({ g, x }))) : [];
    const lang = getLang();
    const adminAll = ref.type === "user" && this.#data.users.find((u) => u.username === ref.id)?.isAdmin;
    for (const sec of sectionsOf(defs, lang)) {
      const head = el("div", "display:flex;gap:8px;align-items:center;margin-top:8px;");
      head.appendChild(el("span", "flex:1;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--omp-text-dim);", sec.title));
      const allOn = own.some((x) => x.feature === `${sec.module}.*`);
      const allBtn = el("label", "font-size:11px;display:inline-flex;gap:4px;align-items:center;cursor:pointer;");
      const allBox = el("input");
      allBox.type = "checkbox";
      allBox.checked = allOn;
      allBox.disabled = this.#busy;
      allBox.addEventListener("change", () => void this.#applyFeaturePlan(ref, planToggleModule(own, sec.module, allBox.checked)));
      allBtn.append(allBox, t("perm.feat.all"));
      head.appendChild(allBtn);
      box.appendChild(head);
      for (const f of sec.items) {
        const cover = coveringGrant(own, f.id);
        const viaGroup = groupGrants.find(({ x }) => coveringGrant([x], f.id));
        const viaPattern = cover !== undefined && cover.feature !== f.id;
        const row = el("label", "display:flex;gap:8px;align-items:flex-start;padding:3px 0;border-bottom:1px solid var(--omp-border);cursor:pointer;");
        const cb = el("input", "margin-top:3px;");
        cb.type = "checkbox";
        cb.checked = cover !== undefined || viaGroup !== undefined || adminAll === true;
        cb.disabled = this.#busy || viaPattern || (viaGroup !== undefined && cover === undefined) || adminAll === true;
        cb.addEventListener("change", () => void this.#applyFeaturePlan(ref, planToggle(own, f.id, cb.checked)));
        const text = el("div", "flex:1;min-width:0;");
        text.appendChild(el("div", "", f.label[lang] || f.label.de || f.id));
        const desc = f.description?.[lang] || f.description?.de || "";
        const note = viaPattern ? t("perm.feat.viaAll") : viaGroup && cover === undefined ? t("perm.feat.viaGroup", { p0: viaGroup.g.name }) : adminAll ? t("perm.feat.viaAdmin") : "";
        text.appendChild(el("div", "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);", [desc, note].filter(Boolean).join(" · ")));
        row.append(cb, text);
        box.appendChild(row);
      }
    }
  }

  #applyFeaturePlan(ref: SubjectRef, plan: TogglePlan): Promise<void> {
    return this.#call(async () => {
      if (plan.create) {
        const res = await apiFetch("/api/v1/admin/feature-grants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subjectType: ref.type, subject: ref.id, feature: plan.create }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      for (const id of plan.deleteIds) {
        const res = await apiFetch(`/api/v1/admin/feature-grants/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw new Error(await res.text());
      }
    });
  }

  #renderResourceDetail(d: HTMLElement) {
    const opts = this.#options();
    const res = opts.find((o) => o.key === this.#selected);
    if (!res) {
      d.appendChild(el("div", "color:var(--omp-text-dim);", t("perm.empty.pick")));
      return;
    }
    d.appendChild(el("div", "font-weight:600;font-size:15px;", res.title));
    d.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);", [this.#kindLabel(res.kind), res.subtitle].filter(Boolean).join(" · ")));
    d.appendChild(this.#verbLegend());

    const bs = bindingsOfResource(this.#data.bindings, res.workflowId, res.nodeId)
      .map((b) => ({ b, title: this.#subjectTitle(b.subjectType, b.subject) }))
      .sort((a, c) => (a.b.subjectType === c.b.subjectType ? a.title.localeCompare(c.title) : a.b.subjectType === "group" ? 1 : -1));
    if (bs.length === 0) d.appendChild(el("div", "color:var(--omp-text-dim);padding:6px 0;", t("perm.none.resource")));
    for (const { b, title } of bs) {
      const ref: SubjectRef = { type: b.subjectType, id: b.subject };
      d.appendChild(
        this.#row(this.#titleSub(`${b.subjectType === "group" ? "👥" : "👤"} ${title}`, b.subjectType === "group" ? t("perm.kind.group") : t("perm.kind.user")), [
          this.#verbSelect(b.verb, (v) => this.#set(ref, res.workflowId, res.nodeId, v)),
          this.#removeButton(() => this.#remove(b, title, res.title)),
        ]),
      );
    }

    const kinds = [
      { value: "all", label: t("perm.kind.all") },
      { value: "user", label: t("perm.kind.user") },
      { value: "group", label: t("perm.kind.group") },
    ];
    const items: PickItem[] = this.#subjects().map((s) => ({
      key: subjectKey(s.ref.type, s.ref.id),
      kind: s.ref.type,
      title: `${s.ref.type === "group" ? "👥" : "👤"} ${s.title}`,
      subtitle: s.sub,
      search: `${s.title} ${s.sub}`.toLowerCase(),
      payload: s.ref,
    }));
    d.appendChild(
      this.#addBar(t("perm.add.pickSubject"), kinds, items, (item, verb) => {
        return this.#set(item.payload as SubjectRef, res.workflowId, res.nodeId, verb);
      }),
    );
  }

  // Hinzufügen-Leiste: Art-Filter, Suchfeld mit Vorschlägen, Recht, Knopf.
  #addBar(placeholder: string, kinds: { value: string; label: string }[], items: PickItem[], onAdd: (item: PickItem, verb: Verb) => Promise<void>): HTMLElement {
    const box = el("div", "margin-top:14px;padding-top:10px;border-top:1px solid var(--omp-border);");
    box.appendChild(el("div", "font-weight:600;margin-bottom:6px;", t("perm.add.title")));
    box.appendChild(
      this.#seg(kinds, this.#pickKind, (k) => {
        this.#pickKind = k;
        this.#picked = null;
        this.#renderDetail();
      }),
    );

    const line = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;");
    const wrap = el("div", "position:relative;flex:1 1 240px;min-width:200px;");
    const input = el("input", "width:100%;");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = this.#picked ? this.#picked.title : "";
    const dd = el("div", "position:absolute;left:0;right:0;top:100%;z-index:20;max-height:260px;overflow:auto;display:none;" +
      "background:var(--omp-surface);border:1px solid var(--omp-border);border-radius:var(--omp-radius);box-shadow:0 4px 14px rgba(0,0,0,.35);");
    wrap.append(input, dd);

    const addBtn = el("button", "cursor:pointer;", t("perm.add.btn"));
    addBtn.className = "omp-btn-primary";
    const refreshAdd = () => {
      addBtn.disabled = this.#busy || !this.#picked;
    };

    const renderDd = () => {
      const q = this.#picked && input.value === this.#picked.title ? "" : input.value;
      const hits = items.filter((i) => (this.#pickKind === "all" || i.kind === this.#pickKind) && matchesQuery(i.search + " " + i.title, q));
      dd.replaceChildren();
      for (const h of hits.slice(0, MAX_SUGGESTIONS)) {
        const o = el("div", "padding:5px 10px;cursor:pointer;border-bottom:1px solid var(--omp-border);");
        o.appendChild(el("div", "", h.title));
        if (h.subtitle) o.appendChild(el("div", "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);", h.subtitle));
        // mousedown statt click: vor dem blur des Eingabefelds auslösen.
        o.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.#picked = h;
          input.value = h.title;
          dd.style.display = "none";
          refreshAdd();
        });
        dd.appendChild(o);
      }
      if (hits.length > MAX_SUGGESTIONS) dd.appendChild(el("div", "padding:5px 10px;color:var(--omp-text-dim);", t("perm.more", { p0: hits.length - MAX_SUGGESTIONS })));
      if (hits.length === 0) dd.appendChild(el("div", "padding:5px 10px;color:var(--omp-text-dim);", t("perm.noMatch")));
      dd.style.display = "block";
    };
    input.addEventListener("focus", () => {
      input.select();
      renderDd();
    });
    input.addEventListener("input", () => {
      this.#picked = null;
      refreshAdd();
      renderDd();
    });
    input.addEventListener("blur", () => {
      dd.style.display = "none";
    });

    const verbSel = this.#verbSelect(this.#verb, (v) => {
      this.#verb = v;
    });
    verbSel.title = VERBS.map((v) => `${this.#verbLabel(v)}: ${t(`perm.verbdesc.${v}` as never)}`).join("\n");
    addBtn.addEventListener("click", async () => {
      if (!this.#picked) return;
      const item = this.#picked;
      this.#picked = null;
      await onAdd(item, this.#verb);
    });
    refreshAdd();
    line.append(wrap, verbSel, addBtn);
    box.appendChild(line);
    box.appendChild(el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:4px;", t(`perm.verbdesc.${this.#verb}` as never)));
    return box;
  }

  // ---- Aktionen ----------------------------------------------------------

  async #call(fn: () => Promise<void>) {
    this.#busy = true;
    this.#error = "";
    this.#renderDetail();
    try {
      await fn();
      await this.#onChanged();
    } catch (e) {
      this.#error = t("perm.error", { p0: e instanceof Error ? e.message : String(e) });
    } finally {
      this.#busy = false;
      this.#renderAll();
    }
  }

  #set(subject: SubjectRef, workflowId: string, nodeId: string, verb: Verb): Promise<void> {
    return this.#call(async () => {
      const plan = planSet(this.#data.bindings, subject, workflowId, nodeId, verb);
      // Erst anlegen, dann das alte entfernen: bricht etwas ab, bleibt der Zugriff erhalten.
      if (plan.create) {
        const res = await apiFetch("/api/v1/admin/role-bindings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subject.id, subjectType: subject.type, workflowId: workflowId || undefined, nodeId, verb }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      for (const id of plan.deleteIds) {
        const res = await apiFetch(`/api/v1/admin/role-bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(await res.text());
      }
    });
  }

  async #remove(b: Binding, who: string, where: string) {
    if (!(await confirmDialog(t("perm.removeConfirm", { p0: who, p1: where, p2: this.#verbLabel(b.verb) }), { confirmLabel: t("perm.remove") }))) return;
    await this.#call(async () => {
      const res = await apiFetch(`/api/v1/admin/role-bindings/${encodeURIComponent(b.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    });
  }
}
