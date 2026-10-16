// Diagnose (Admin → Diagnose): "Was läuft schief, und wo?" statt Rohlog.
//   • Probleme    — gleichartige Meldungen gruppiert (Anzahl, wann zuletzt,
//                   welche Nodes), bekannte mit Erklärung und Hinweis
//   • Meldungen   — die Einzelzeilen, chronologisch
// Filter (Suche, Stufe, Zeitraum, Node) laufen auf dem Server. Ein Klick auf
// "Einzelmeldungen" oder "Vorgang zeigen" springt mit dem passenden Filter in
// die Meldungsliste; Filter-Chips zeigen, was gerade eingegrenzt ist.
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import {
  buildLogQuery,
  type DiagRange,
  explain,
  LEVELS,
  type LevelId,
  type LogGroup,
  type LogRow,
  relativeTime,
  shortId,
} from "./diagnose-logic.ts";

const PAGE = 50;

export interface DiagnoseContext {
  nodes: { id: string; label: string; instanceId?: string }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const SEG_ON = "background:var(--omp-surface-raised);color:var(--omp-text);";
const SEG_OFF = "background:transparent;color:var(--omp-text-dim);";
const LEVEL_COLOR: Record<string, string> = { error: "var(--omp-error)", warn: "#e0a020", info: "var(--omp-text-dim)" };

function tryT(key: string): string | undefined {
  const v = t(key as never);
  return v === key ? undefined : v;
}

export class DiagnosePanel {
  readonly el: HTMLElement;
  #ctx: DiagnoseContext = { nodes: [] };
  #view: "groups" | "rows" = "groups";
  #levels = new Set<LevelId>(["error", "warn"]);
  #range: DiagRange = "24h";
  #text = "";
  #nodeId = "";
  #traceId = "";
  #msgKey = "";
  #msgKeyTitle = "";
  #groups: LogGroup[] = [];
  #rows: LogRow[] = [];
  #hasMore = false;
  #loading = false;
  #seq = 0;
  #open = new Set<string>();
  #debounce: number | undefined;
  #lastLoad = 0;
  #pending: number | undefined;
  #controls = el("div");
  #body = el("div");
  #footer = el("div");
  #count = el("span");

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);");
    const head = el("div", "display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;");
    const title = el("span", "", t("dg.title"));
    title.className = "omp-h1";
    this.#count.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    head.append(title, this.#count);
    const hint = el("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin:4px 0 8px;", t("dg.hint"));
    this.el.append(head, hint, this.#controls, this.#body, this.#footer);
    this.#buildControls();
    this.#render();
  }

  setContext(c: DiagnoseContext) {
    const changed = c.nodes.length !== this.#ctx.nodes.length;
    this.#ctx = c;
    if (changed) this.#buildControls();
    this.#render();
  }

  // Zeigt alle Zeilen eines Vorgangs (von außen, z. B. aus dem Flow Editor).
  showTrace(traceId: string) {
    this.#view = "rows";
    this.#traceId = traceId;
    this.#msgKey = "";
    this.#text = "";
    this.#nodeId = "";
    this.#levels = new Set(LEVELS);
    this.#range = "all";
    this.#buildControls();
    this.#changed();
  }

  // Gebündelt: höchstens eine Abfrage pro Sekunde bei vielen Ereignissen.
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

  // ---- Namen ---------------------------------------------------------------

  #nodeName(id: string): string {
    const n = this.#ctx.nodes.find((x) => x.id === id || x.instanceId === id);
    return n ? n.label : `${shortId(id)} (${t("dg.node.gone")})`;
  }

  #ago(iso: string): string {
    const [key, n] = relativeTime(iso);
    return t(key as never, { p0: n });
  }

  // ---- Laden -----------------------------------------------------------------

  #query(more: boolean): string {
    return buildLogQuery({
      levels: this.#levels,
      range: this.#range,
      text: this.#text,
      nodeId: this.#nodeId,
      traceId: this.#traceId,
      msgKey: this.#msgKey,
      limit: this.#view === "rows" ? PAGE : undefined,
      before: more ? this.#rows[this.#rows.length - 1]?.id : undefined,
    });
  }

  async #load(more: boolean) {
    if (more && (this.#loading || this.#rows.length === 0)) return;
    const seq = ++this.#seq;
    this.#loading = true;
    this.#renderFooter();
    try {
      if (this.#view === "groups") {
        const res = await apiFetch(`/api/v1/logs/summary?${this.#query(false)}`);
        if (seq !== this.#seq) return;
        if (res.ok) this.#groups = await res.json();
      } else {
        const res = await apiFetch(`/api/v1/logs?${this.#query(more)}`);
        if (seq !== this.#seq) return;
        if (res.ok) {
          const page: LogRow[] = await res.json();
          this.#rows = more ? [...this.#rows, ...page] : page;
          this.#hasMore = page.length === PAGE;
        }
      }
    } catch {
      // nächster Versuch beim nächsten Ereignis/Klick
    } finally {
      if (seq === this.#seq) {
        this.#loading = false;
        this.#render();
      }
    }
  }

  #changed() {
    this.#open.clear();
    this.#lastLoad = Date.now();
    this.#buildControls();
    void this.#load(false);
  }

  // ---- Filterleiste ----------------------------------------------------------

  #seg<T extends string>(items: { value: T; label: string }[], current: T, on: (v: T) => void): HTMLElement {
    const wrap = el("div", "display:inline-flex;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;flex-wrap:wrap;");
    for (const it of items) {
      const b = el("button", `font-size:11px;cursor:pointer;border:none;border-radius:0;padding:4px 9px;${it.value === current ? SEG_ON : SEG_OFF}`, it.label);
      b.addEventListener("click", () => on(it.value));
      wrap.appendChild(b);
    }
    return wrap;
  }

  #chip(text: string, onClear: () => void): HTMLElement {
    const c = el("span", "display:inline-flex;gap:6px;align-items:center;font-size:11px;padding:2px 4px 2px 10px;border-radius:12px;border:1px solid var(--omp-preset);");
    const x = el("button", "border:none;background:transparent;color:var(--omp-text-dim);cursor:pointer;padding:0 4px;", "✕");
    x.addEventListener("click", onClear);
    c.append(document.createTextNode(text), x);
    return c;
  }

  #buildControls() {
    const c = this.#controls;
    c.replaceChildren();
    c.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-bottom:10px;";

    const line1 = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;");
    line1.appendChild(
      this.#seg<"groups" | "rows">(
        [
          { value: "groups", label: t("dg.view.groups") },
          { value: "rows", label: t("dg.view.rows") },
        ],
        this.#view,
        (v) => {
          this.#view = v;
          this.#changed();
        },
      ),
    );
    const sw = el("span", "flex:1 1 240px;max-width:420px;");
    sw.className = "omp-search-wrap";
    const search = el("input", "width:100%;");
    search.className = "omp-search-input";
    search.type = "search";
    search.placeholder = t("dg.search.ph");
    search.value = this.#text;
    search.addEventListener("input", () => {
      this.#text = search.value;
      window.clearTimeout(this.#debounce);
      // Nur die Liste neu laden, die Leiste (mit dem Suchfeld) bleibt stehen.
      this.#debounce = window.setTimeout(() => {
        this.#open.clear();
        this.#lastLoad = Date.now();
        void this.#load(false);
      }, 300);
    });
    sw.appendChild(search);
    line1.appendChild(sw);

    const nodeSel = el("select");
    const all = el("option", "", t("dg.node.all"));
    all.value = "";
    nodeSel.appendChild(all);
    for (const n of this.#ctx.nodes.slice().sort((a, b) => a.label.localeCompare(b.label))) {
      const o = el("option", "", n.label);
      o.value = n.id;
      o.selected = n.id === this.#nodeId;
      nodeSel.appendChild(o);
    }
    nodeSel.addEventListener("change", () => {
      this.#nodeId = nodeSel.value;
      this.#changed();
    });
    line1.appendChild(nodeSel);

    line1.appendChild(
      this.#seg<DiagRange>(
        (["1h", "24h", "7d", "all"] as const).map((r) => ({ value: r, label: t(`dg.range.${r}` as never) })),
        this.#range,
        (r) => {
          this.#range = r;
          this.#changed();
        },
      ),
    );

    const line2 = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;");
    line2.appendChild(el("span", "color:var(--omp-text-dim);font-size:11px;", t("dg.levels")));
    for (const l of LEVELS) {
      const on = this.#levels.has(l);
      const b = el(
        "button",
        "font-size:11px;cursor:pointer;border-radius:12px;padding:3px 10px;border:1px solid var(--omp-border);" +
          (on ? SEG_ON + `border-color:${LEVEL_COLOR[l]};` : SEG_OFF),
        t(`dg.level.${l}` as never),
      );
      b.addEventListener("click", () => {
        if (on) this.#levels.delete(l);
        else this.#levels.add(l);
        this.#changed();
      });
      line2.appendChild(b);
    }
    if (this.#traceId) line2.appendChild(this.#chip(t("dg.chip.trace", { p0: shortId(this.#traceId) }), () => ((this.#traceId = ""), this.#changed())));
    if (this.#msgKey) line2.appendChild(this.#chip(t("dg.chip.kind", { p0: this.#msgKeyTitle }), () => ((this.#msgKey = ""), this.#changed())));
    c.append(line1, line2);
  }

  // ---- Darstellung -------------------------------------------------------------

  #render() {
    const total = this.#groups.reduce((a, g) => a + g.count, 0);
    this.#count.textContent = this.#loading
      ? t("dg.loading")
      : this.#view === "groups"
        ? t("dg.count.groups", { p0: this.#groups.length, p1: total })
        : t("dg.count.rows", { p0: this.#rows.length });
    this.#body.replaceChildren(this.#view === "groups" ? this.#renderGroups() : this.#renderRows());
    this.#renderFooter();
  }

  #empty(): HTMLElement {
    const e = el("div", "padding:16px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);color:var(--omp-text-dim);");
    e.textContent = this.#loading ? t("dg.loading") : t("dg.empty");
    return e;
  }

  #groupTitle(g: LogGroup): { title: string; hint?: string } {
    const x = explain(g.example);
    if (!x) return { title: g.example.length > 140 ? g.example.slice(0, 140) + "…" : g.example };
    return {
      title: t(`dg.x.${x.id}.title` as never, { p0: x.param ?? "" }),
      hint: tryT(`dg.x.${x.id}.hint`),
    };
  }

  #renderGroups(): HTMLElement {
    if (this.#groups.length === 0) return this.#empty();
    const wrap = el("div", "display:flex;flex-direction:column;gap:8px;");
    for (const g of this.#groups) {
      const { title, hint } = this.#groupTitle(g);
      const card = el("div", `border:1px solid var(--omp-border);border-left:4px solid ${LEVEL_COLOR[g.level] ?? "var(--omp-border)"};border-radius:var(--omp-radius);padding:8px 12px;`);
      const top = el("div", "display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;");
      top.appendChild(el("span", "font-weight:600;", title));
      top.appendChild(el("span", "font-size:11px;color:var(--omp-text-dim);", `${g.count}× · ${t("dg.last", { p0: this.#ago(g.last) })}`));
      card.appendChild(top);
      if (hint) card.appendChild(el("div", "margin-top:4px;font-size:var(--omp-font-size-xs);", hint));
      if (g.nodeIds.length > 0) {
        const nodes = el("div", "margin-top:4px;font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);");
        const known = g.nodeIds.filter((id) => this.#ctx.nodes.some((x) => x.id === id || x.instanceId === id));
        const gone = g.nodeIds.length - known.length;
        const parts = known.slice(0, 6).map((id) => this.#nodeName(id));
        if (known.length > 6) parts.push(`+${known.length - 6}`);
        if (gone > 0) parts.push(t("dg.affects.gone", { p0: gone }));
        nodes.textContent = t("dg.affects", { p0: parts.join(", ") });
        card.appendChild(nodes);
      }
      const row = el("div", "margin-top:6px;display:flex;gap:8px;align-items:center;");
      const show = el("button", "font-size:11px;cursor:pointer;", t("dg.showRows"));
      show.addEventListener("click", () => {
        this.#view = "rows";
        this.#msgKey = g.key;
        this.#msgKeyTitle = title.length > 40 ? title.slice(0, 40) + "…" : title;
        this.#changed();
      });
      row.appendChild(show);
      row.appendChild(el("span", "font-size:11px;color:var(--omp-text-dim);", t("dg.since", { p0: new Date(g.first).toLocaleString() })));
      card.appendChild(row);
      wrap.appendChild(card);
    }
    return wrap;
  }

  #renderRows(): HTMLElement {
    if (this.#rows.length === 0) return this.#empty();
    const list = el("div", "border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;");
    for (const e of this.#rows) {
      const k = String(e.id);
      const wrap = el("div", "border-top:1px solid var(--omp-border);");
      const row = el("div", "display:flex;gap:10px;align-items:flex-start;padding:6px 10px;cursor:pointer;");
      row.appendChild(el("span", "color:var(--omp-text-dim);font-variant-numeric:tabular-nums;white-space:nowrap;", new Date(e.occurredAt).toLocaleString()));
      row.appendChild(el("span", `color:${LEVEL_COLOR[e.level] ?? "var(--omp-text)"};font-size:11px;text-transform:uppercase;min-width:52px;`, tryT(`dg.lv.${e.level}`) ?? e.level));
      const mid = el("div", "flex:1;min-width:0;");
      const x = explain(e.message);
      mid.appendChild(el("div", "word-break:break-word;", x ? t(`dg.x.${x.id}.title` as never, { p0: x.param ?? "" }) : e.message));
      if (e.nodeId) mid.appendChild(el("div", "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);", this.#nodeName(e.nodeId)));
      row.appendChild(mid);
      wrap.appendChild(row);
      row.addEventListener("click", () => {
        if (this.#open.has(k)) this.#open.delete(k);
        else this.#open.add(k);
        this.#render();
      });
      if (this.#open.has(k)) {
        const det = el("div", "padding:4px 10px 10px 40px;font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);display:flex;flex-direction:column;gap:4px;");
        if (x) det.appendChild(el("div", "color:var(--omp-text);", e.message));
        const hint = x ? tryT(`dg.x.${x.id}.hint`) : undefined;
        if (hint) det.appendChild(el("div", "color:var(--omp-text);", hint));
        det.appendChild(el("div", "", `${t("dg.source")}: ${e.source}${e.hostId ? ` · ${t("dg.host")}: ${e.hostId}` : ""}`));
        const btns = el("div", "display:flex;gap:8px;");
        if (e.traceId) {
          const tr = el("button", "font-size:11px;cursor:pointer;", t("dg.showTrace"));
          tr.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.showTrace(e.traceId!);
          });
          btns.appendChild(tr);
        }
        const copy = el("button", "font-size:11px;cursor:pointer;", t("dg.copy"));
        copy.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void navigator.clipboard?.writeText(`${e.occurredAt} ${e.level} ${e.message}`);
        });
        btns.appendChild(copy);
        det.appendChild(btns);
        wrap.appendChild(det);
      }
      list.appendChild(wrap);
    }
    return list;
  }

  #renderFooter() {
    const f = this.#footer;
    f.replaceChildren();
    f.style.cssText = "display:flex;gap:8px;margin-top:8px;";
    if (this.#view === "rows" && this.#hasMore) {
      const more = el("button", "font-size:11px;cursor:pointer;", this.#loading ? t("dg.loading") : t("dg.more"));
      more.disabled = this.#loading;
      more.addEventListener("click", () => void this.#load(true));
      f.appendChild(more);
    }
  }
}
