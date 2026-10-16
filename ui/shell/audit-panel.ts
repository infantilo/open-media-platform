// Audit-Log (Admin → Audit-Log): zeigt, WER WANN WAS geändert hat, in
// Klartext statt als Methode + Pfad. Filter laufen auf dem Server (Nutzer,
// Ergebnis, Zeitraum, Bereiche, Suche) — das Panel lädt nur, was passt, und
// "Ältere laden" blättert innerhalb des Filters. Namen (Node, Workflow, …)
// werden aus den IDs im Pfad aufgelöst; die Suche findet auch Namen.
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import {
  type AuditRow,
  buildQuery,
  CATEGORIES,
  type CategoryId,
  DEFAULT_CATEGORIES,
  describe,
  outcome,
  type RangeId,
  type Resolvers,
  searchTerms,
} from "./audit-logic.ts";

const PAGE = 50;

export interface AuditContext {
  users: string[];
  nodes: { id: string; label: string; instanceId?: string }[];
  workflows: { id: string; name: string }[];
  processes: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const SEG_ON = "background:var(--omp-surface-raised);color:var(--omp-text);";
const SEG_OFF = "background:transparent;color:var(--omp-text-dim);";

// Existiert für diesen Schlüssel eine Übersetzung? (t() liefert sonst den Schlüssel selbst.)
function tryT(key: string): string | undefined {
  const v = t(key as never);
  return v === key ? undefined : v;
}

export class AuditPanel {
  readonly el: HTMLElement;
  #ctx: AuditContext = { users: [], nodes: [], workflows: [], processes: [], groups: [] };
  #rows: AuditRow[] = [];
  #hasMore = false;
  #loading = false;
  #seq = 0;
  #open = new Set<number>();
  // Filter
  #search = "";
  #user = "";
  #result: "" | "ok" | "failed" = "";
  #range: RangeId = "7d";
  #cats = new Set<CategoryId>(DEFAULT_CATEGORIES);
  #debounce: number | undefined;
  // Teile
  #controls = el("div");
  #list = el("div");
  #footer = el("div");
  #count = el("span");

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);");
    const head = el("div", "display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;");
    const title = el("span", "", t("aud.title"));
    title.className = "omp-h1";
    this.#count.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    head.append(title, this.#count);
    const hint = el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:4px 0 8px;", t("aud.hint"));
    this.el.append(head, hint, this.#controls, this.#list, this.#footer);
    this.#buildControls();
    this.#renderList();
  }

  setContext(c: AuditContext) {
    const usersChanged = c.users.join("\n") !== this.#ctx.users.join("\n");
    this.#ctx = c;
    if (usersChanged) this.#buildControls();
    this.#renderList();
  }

  // Neu laden (erste Seite) — beim Öffnen, bei Filteränderung, bei "audit.appended".
  // Gebündelt: viele "audit.appended"-Ereignisse hintereinander (Bedienung)
  // lösen höchstens eine Abfrage pro Sekunde aus.
  #lastLoad = 0;
  #pending: number | undefined;
  async refresh() {
    const wait = this.#lastLoad + 1000 - Date.now();
    if (wait > 0) {
      if (this.#pending === undefined) {
        this.#pending = window.setTimeout(() => {
          this.#pending = undefined;
          void this.refresh();
        }, wait);
      }
      return;
    }
    this.#lastLoad = Date.now();
    await this.#load(false);
  }

  // ---- Laden --------------------------------------------------------------

  #named(): { id: string; name: string }[] {
    return [
      ...this.#ctx.nodes.flatMap((n) => [{ id: n.id, name: n.label }, ...(n.instanceId ? [{ id: n.instanceId, name: n.label }] : [])]),
      ...this.#ctx.workflows,
      ...this.#ctx.processes,
      ...this.#ctx.groups,
    ];
  }

  async #load(more: boolean) {
    if (more && (this.#loading || this.#rows.length === 0)) return;
    const seq = ++this.#seq;
    this.#loading = true;
    this.#renderFooter();
    try {
      const qs = buildQuery({
        limit: PAGE,
        before: more ? this.#rows[this.#rows.length - 1].id : undefined,
        user: this.#user,
        result: this.#result,
        range: this.#range,
        categories: this.#cats,
        terms: searchTerms(this.#search, this.#named()),
      });
      const res = await apiFetch(`/api/v1/admin/audit-log?${qs}`);
      if (seq !== this.#seq) return; // neuere Anfrage überholt diese
      if (res.ok) {
        const page: AuditRow[] = await res.json();
        this.#rows = more ? [...this.#rows, ...page] : page;
        this.#hasMore = page.length === PAGE;
      }
    } catch {
      // nächster Versuch beim nächsten Ereignis/Klick
    } finally {
      if (seq === this.#seq) {
        this.#loading = false;
        this.#renderList();
      }
    }
  }

  #changed() {
    this.#open.clear();
    this.#lastLoad = Date.now();
    void this.#load(false);
  }

  // ---- Filterleiste ---------------------------------------------------------

  #seg<T extends string>(items: { value: T; label: string }[], current: T, on: (v: T) => void): HTMLElement {
    const wrap = el("div", "display:inline-flex;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;flex-wrap:wrap;");
    for (const it of items) {
      const b = el("button", `font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 9px;${it.value === current ? SEG_ON : SEG_OFF}`, it.label);
      b.addEventListener("click", () => on(it.value));
      wrap.appendChild(b);
    }
    return wrap;
  }

  #buildControls() {
    const c = this.#controls;
    c.replaceChildren();
    c.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-bottom:10px;";

    const line1 = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;");
    const sw = el("span", "flex:1 1 260px;max-width:460px;");
    sw.className = "omp-search-wrap";
    const search = el("input", "width:100%;");
    search.className = "omp-search-input";
    search.type = "search";
    search.placeholder = t("aud.search.ph");
    search.value = this.#search;
    search.addEventListener("input", () => {
      this.#search = search.value;
      window.clearTimeout(this.#debounce);
      this.#debounce = window.setTimeout(() => this.#changed(), 300);
    });
    sw.appendChild(search);

    const userSel = el("select");
    const all = el("option", "", t("aud.user.all"));
    all.value = "";
    userSel.appendChild(all);
    for (const u of this.#ctx.users.slice().sort()) {
      const o = el("option", "", u);
      o.value = u;
      o.selected = u === this.#user;
      userSel.appendChild(o);
    }
    userSel.addEventListener("change", () => {
      this.#user = userSel.value;
      this.#changed();
    });

    const resSel = el("select");
    for (const [v, k] of [["", "aud.res.all"], ["ok", "aud.res.onlyOk"], ["failed", "aud.res.onlyFailed"]] as const) {
      const o = el("option", "", t(k));
      o.value = v;
      o.selected = v === this.#result;
      resSel.appendChild(o);
    }
    resSel.addEventListener("change", () => {
      this.#result = resSel.value as "" | "ok" | "failed";
      this.#changed();
    });

    const range = this.#seg<RangeId>(
      (["1h", "24h", "7d", "30d", "all"] as const).map((r) => ({ value: r, label: t(`aud.range.${r}` as never) })),
      this.#range,
      (r) => {
        this.#range = r;
        this.#buildControls();
        this.#changed();
      },
    );
    line1.append(sw, userSel, resSel, range);

    const line2 = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;");
    line2.appendChild(el("span", "color:var(--omp-text-dim);font-size:11px;margin-right:2px;", t("aud.cats")));
    for (const cat of CATEGORIES) {
      const on = this.#cats.has(cat.id);
      const chip = el(
        "button",
        "font-size:11px;cursor:pointer;border-radius:12px;padding:3px 10px;border:1px solid var(--omp-border);" + (on ? SEG_ON + "border-color:var(--omp-preset);" : SEG_OFF),
        `${cat.icon} ${t(`aud.cat.${cat.id}` as never)}`,
      );
      chip.addEventListener("click", () => {
        if (on) this.#cats.delete(cat.id);
        else this.#cats.add(cat.id);
        this.#buildControls();
        this.#changed();
      });
      line2.appendChild(chip);
    }
    const preset = (label: string, ids: CategoryId[]) => {
      const b = el("button", "font-size:11px;cursor:pointer;border:none;background:transparent;color:var(--omp-text-dim);text-decoration:underline;", label);
      b.addEventListener("click", () => {
        this.#cats = new Set(ids);
        this.#buildControls();
        this.#changed();
      });
      return b;
    };
    line2.append(preset(t("aud.cats.default"), DEFAULT_CATEGORIES), preset(t("aud.cats.all"), CATEGORIES.map((x) => x.id)));
    c.append(line1, line2);
  }

  // ---- Liste ----------------------------------------------------------------

  #resolvers(): Resolvers {
    const c = this.#ctx;
    return {
      node: (id) => c.nodes.find((n) => n.id === id)?.label,
      workflow: (id) => c.workflows.find((w) => w.id === id)?.name,
      process: (id) => c.processes.find((p) => p.id === id)?.name,
      instance: (id) => c.nodes.find((n) => n.instanceId === id || n.id === id)?.label,
      group: (id) => c.groups.find((g) => g.id === id)?.name,
    };
  }

  #dayLabel(d: Date): string {
    const today = new Date();
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(d, today)) return t("aud.today");
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    if (same(d, y)) return t("aud.yesterday");
    return d.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  }

  #sentence(e: AuditRow): { icon: string; text: string; raw: string } {
    const d = describe(e, this.#resolvers(), tryT);
    const icon = CATEGORIES.find((c) => c.id === d.category)?.icon ?? "•";
    const text = d.key ? t(d.key, d.params) : t("aud.generic", { p0: d.raw });
    return { icon, text, raw: d.raw };
  }

  #renderList() {
    this.#count.textContent = this.#loading && this.#rows.length === 0 ? t("aud.loading") : t("aud.count", { p0: this.#rows.length });
    const list = this.#list;
    list.replaceChildren();
    list.style.cssText = "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    if (this.#rows.length === 0) {
      const empty = el("div", "padding:14px;color:var(--omp-text-dim);");
      empty.textContent = this.#loading ? t("aud.loading") : t("aud.empty");
      list.appendChild(empty);
      this.#renderFooter();
      return;
    }
    let lastDay = "";
    for (const e of this.#rows) {
      const when = new Date(e.occurredAt);
      const day = when.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        list.appendChild(el("div", "padding:4px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--omp-text-dim);background:var(--omp-surface-raised);", this.#dayLabel(when)));
      }
      list.appendChild(this.#renderRow(e, when));
    }
    this.#renderFooter();
  }

  #renderRow(e: AuditRow, when: Date): HTMLElement {
    const s = this.#sentence(e);
    const out = outcome(e.status);
    const wrap = el("div", "border-top:1px solid var(--omp-border);");
    const row = el("div", "display:flex;gap:10px;align-items:center;padding:6px 10px;cursor:pointer;");
    row.appendChild(el("span", "color:var(--omp-text-dim);font-variant-numeric:tabular-nums;white-space:nowrap;", when.toLocaleTimeString()));
    row.appendChild(el("span", "width:18px;text-align:center;", s.icon));
    const mid = el("div", "flex:1;min-width:0;");
    const line = el("div", "overflow:hidden;text-overflow:ellipsis;");
    line.append(el("b", "", e.username || "—"), document.createTextNode("  " + s.text));
    mid.appendChild(line);
    row.appendChild(mid);
    if (!out.ok) {
      row.appendChild(el("span", "font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--omp-error);color:var(--omp-error);white-space:nowrap;", t(out.key as never)));
    }
    wrap.appendChild(row);
    const open = this.#open.has(e.id);
    if (open) {
      const det = el("div", "padding:4px 10px 8px 38px;color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);word-break:break-all;");
      det.append(
        el("div", "", `${t("aud.details")}: ${s.raw} → ${e.status} (${t(out.key as never)})`),
        ...(e.nodeId ? [el("div", "", `Node/Instanz: ${e.nodeId}`)] : []),
        el("div", "", when.toLocaleString()),
      );
      wrap.appendChild(det);
    }
    row.addEventListener("click", () => {
      if (this.#open.has(e.id)) this.#open.delete(e.id);
      else this.#open.add(e.id);
      this.#renderList();
    });
    return wrap;
  }

  #renderFooter() {
    const f = this.#footer;
    f.replaceChildren();
    f.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;";
    if (this.#hasMore) {
      const more = el("button", "font-size:11px;cursor:pointer;", this.#loading ? t("aud.loading") : t("aud.more"));
      more.disabled = this.#loading;
      more.addEventListener("click", () => void this.#load(true));
      f.appendChild(more);
    }
    if (this.#rows.length > 0) {
      const csv = el("button", "font-size:11px;cursor:pointer;", t("aud.csv"));
      csv.addEventListener("click", () => this.#exportCsv());
      f.appendChild(csv);
    }
  }

  #exportCsv() {
    const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
    const lines = [["time", "user", "action", "result", "status", "method", "path"].join(",")];
    for (const e of this.#rows) {
      const s = this.#sentence(e);
      lines.push([e.occurredAt, e.username, s.text, t(outcome(e.status).key as never), String(e.status), e.method, e.path].map(q).join(","));
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = el("a");
    a.href = url;
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
}
