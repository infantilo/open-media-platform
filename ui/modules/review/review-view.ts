// Tab „Eingang“ (Kapitel 43): Arbeitsliste neu eingegangener Medien-Assets → Detailansicht (QC-Bericht, Review & Conform, Verlauf).
import { dateLocale, directory, features, showToast, t as tt, whoami } from "../host.ts";
import { type Directory, groupName, hasFeature } from "../../kit/features.ts";
import { call, errText } from "./api.ts";
import { type Config, type Me, ReviewDetail } from "./detail.ts";
import { openReviewSettingsForm } from "./settings-form.ts";
import { assignmentLabel, formatBytes, isOverdue, type Item, qcBadge, stateBadge } from "./review-logic.ts";
import { timecodeOf } from "./timecode.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const FILTERS: [string, string, string][] = [
  // id, Anzeige, Abfrage
  ["todo", "rv.f.todo", "state=awaiting_review,rejected&assignee=free"],
  ["all", "rv.f.all", ""],
  ["tasks", "rv.f.tasks", "assignee=mine"],
  ["mine", "rv.f.mine", "assignee=me"],
  ["qc", "rv.f.qc", "state=awaiting_qc,qc_running,qc_failed_to_run"],
  ["busy", "rv.f.busy", "state=in_review,conforming"],
  ["approval", "rv.f.approval", "state=ready_for_approval"],
  ["done", "rv.f.done", "state=approved"],
  ["archived", "rv.f.archived", "state=archived"],
];

class ReviewView extends HTMLElement {
  #me: Me = { username: "local", canConfigure: false, isAdmin: false, can: () => false, dir: null };
  #cfg: Config | null = null;
  #filter = "todo";
  #query = "";
  #items: Item[] = [];
  #list = el("div");
  #detail: ReviewDetail | null = null;
  #timer = 0;
  #loaded = false;
  #error = "";

  connectedCallback() {
    // eigener Scrollbereich: nur die Ansicht scrollt, die Alarmleiste darunter bleibt stehen
    this.style.cssText = "display:block;box-sizing:border-box;width:100%;height:100%;overflow-y:auto;padding:12px 16px;";
    if (this.#loaded) {
      this.#start();
      return;
    }
    this.#loaded = true;
    void this.#init();
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #init() {
    const w = await whoami();
    const [feats, dir] = await Promise.all([features(), directory()]);
    this.#me = { username: w.username || "local", canConfigure: !!(w.canConfigure ?? w.isAdmin), isAdmin: !!w.isAdmin, can: (f) => hasFeature(feats, f), dir: dir as Directory | null };
    const c = await call<Config>("GET", "/config");
    if (c.ok) this.#cfg = c.data;
    else this.#error = errText(c.data as unknown as Record<string, unknown>) || tt("rv.err.generic");
    this.#renderShell();
    this.#start();
    // Aufgabenliste des Arbeitsplatzes: `focus-ref` öffnet die Datei direkt (Kapitel 44).
    const ref = this.getAttribute("focus-ref");
    if (ref && this.#cfg) this.#open(ref);
  }

  #start() {
    clearInterval(this.#timer);
    void this.#refresh();
    this.#timer = setInterval(() => {
      if (!this.#detail) void this.#refresh();
    }, 5000) as unknown as number;
  }

  #renderShell() {
    this.replaceChildren();
    if (this.#detail) return;
    const bar = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;");
    bar.append(el("h2", "margin:0 12px 0 0;font-size:16px;", tt("rv.title")));
    const sel = el("select") as HTMLSelectElement;
    sel.dataset.role = "filter";
    for (const [id, key] of FILTERS) {
      const o = el("option", "", tt(key));
      o.value = id;
      sel.append(o);
    }
    sel.value = this.#filter;
    sel.addEventListener("change", () => {
      this.#filter = sel.value;
      void this.#refresh();
    });
    const q = el("input", "width:200px;") as HTMLInputElement;
    q.placeholder = tt("rv.search");
    q.value = this.#query;
    q.addEventListener("input", () => {
      this.#query = q.value;
      void this.#refresh();
    });
    const refresh = el("button", "padding:3px 10px;", "⟳");
    refresh.title = tt("rv.refresh");
    refresh.addEventListener("click", () => void this.#refresh());
    bar.append(sel, q, refresh);
    if (this.#me.can("review.import")) {
      const imp = el("button", "padding:3px 10px;", tt("rv.import"));
      imp.dataset.role = "import";
      imp.addEventListener("click", () => void this.#importDialog());
      bar.append(imp);
    }
    if (this.#me.isAdmin) {
      const cfg = el("button", "padding:3px 10px;", tt("rv.settings"));
      cfg.addEventListener("click", () => void this.#settingsDialog());
      bar.append(cfg);
    }
    this.append(bar);
    if (this.#error) this.append(el("div", "color:var(--omp-error);", this.#error));
    this.#list = el("div");
    this.append(this.#list);
  }

  async #refresh() {
    if (this.#detail) return;
    const f = FILTERS.find((x) => x[0] === this.#filter)!;
    const params = new URLSearchParams(f[2]);
    if (this.#query.trim()) params.set("q", this.#query.trim());
    const r = await call<{ items: Item[] }>("GET", `/items?${params}`);
    if (!r.ok) {
      this.#error = errText(r.data as unknown as Record<string, unknown>) || tt("rv.err.generic");
      return;
    }
    this.#error = "";
    this.#items = r.data.items ?? [];
    this.#renderList();
  }

  #renderList() {
    this.#list.replaceChildren();
    this.#list.dataset.role = "queue";
    if (!this.#items.length) {
      this.#list.append(el("div", "color:var(--omp-text-dim);padding:20px 0;", tt("rv.empty")));
      return;
    }
    const tb = el("table", "width:100%;border-collapse:collapse;font-size:13px;");
    const head = el("tr", "text-align:left;color:var(--omp-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em;");
    for (const h of ["rv.col.file", "rv.col.state", "rv.col.qc", "rv.col.assignee", "rv.col.assigned", "rv.col.duration", "rv.col.format", "rv.col.size", "rv.col.received", ""]) head.append(el("th", "padding:4px 8px;font-weight:500;", h ? tt(h) : ""));
    tb.append(head);
    for (const it of this.#items) {
      const tr = el("tr", "border-top:1px solid var(--omp-border);cursor:pointer;");
      tr.dataset.asset = it.assetId;
      tr.addEventListener("mouseenter", () => (tr.style.background = "var(--omp-surface-raised)"));
      tr.addEventListener("mouseleave", () => (tr.style.background = ""));
      tr.addEventListener("dblclick", () => this.#open(it.assetId));
      const td = (child: string | HTMLElement, css = ""): HTMLElement => {
        const c = el("td", `padding:6px 8px;${css}`);
        if (typeof child === "string") c.textContent = child;
        else c.append(child);
        return c;
      };
      const name = el("div");
      name.append(el("div", "font-weight:600;", it.title || it.fileName), el("div", "font:11px var(--omp-font-mono);color:var(--omp-text-dim);", `${it.fileName} · ${it.assetId.slice(0, 8)}`));
      const dur = it.timeline ? `${timecodeOf({ ...it.timeline, startFrames: 0 }, it.timeline.durationFrames)}` : "—";
      tr.append(
        td(name),
        td(el("span", stateBadge(it.state), tt("rv.state." + it.state))),
        td(it.qcStatus ? el("span", qcBadge(it.qcStatus), `${tt("rv.qc.overall." + it.qcStatus)}${it.qcFailCount ? ` · ${it.qcFailCount}✖` : ""}${it.qcWarnCount ? ` · ${it.qcWarnCount}▲` : ""}`) : el("span", "color:var(--omp-text-dim);", "—")),
        td(it.assignee || "—", it.assignee === this.#me.username ? "font-weight:600;" : "color:var(--omp-text-dim);"),
        td(this.#assignedCell(it)),
        td(dur, "font-family:var(--omp-font-mono);"),
        td(it.format || "—"),
        td(formatBytes(it.sizeBytes)),
        td(new Date(it.createdAt).toLocaleString(dateLocale()), "color:var(--omp-text-dim);font-size:12px;"),
      );
      const act = el("td", "padding:6px 8px;text-align:right;white-space:nowrap;");
      const open = el("button", "padding:2px 10px;", tt("rv.open"));
      open.dataset.role = "open";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#open(it.assetId);
      });
      act.append(open);
      tr.append(act);
      tb.append(tr);
    }
    this.#list.append(tb);
  }

  #assignedCell(it: Item): HTMLElement {
    const label = assignmentLabel(it, tt("rv.group"), (id) => groupName(this.#me.dir, id));
    const open = it.state !== "approved" && it.state !== "archived";
    const late = open && isOverdue(it.dueAt, Date.now());
    const box = el("div");
    box.append(el("div", "font-size:12px;color:var(--omp-text-dim);", label || "—"));
    if (it.dueAt) box.append(el("div", `font-size:11px;${late ? "color:var(--omp-error);font-weight:600;" : "color:var(--omp-text-dim);"}`, `${late ? "⚠ " : ""}${new Date(it.dueAt).toLocaleString(dateLocale())}`));
    return box;
  }

  #open(id: string) {
    if (!this.#cfg) return;
    clearInterval(this.#timer);
    this.replaceChildren();
    this.#detail = new ReviewDetail(id, this.#me, this.#cfg, () => {
      this.#detail = null;
      this.#renderShell();
      this.#start();
    });
    this.append(this.#detail.el);
  }

  async #importDialog() {
    const r = await call<{ enabled: boolean; files: string[] }>("GET", "/import/files");
    if (!r.ok || !r.data.enabled) {
      showToast(tt("rv.import.disabled"));
      return;
    }
    const files = r.data.files;
    if (!files.length) {
      showToast(tt("rv.import.nofiles"));
      return;
    }
    const overlay = el("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "3000";
    const m = el("div", "max-width:520px;");
    m.className = "omp-modal";
    const h1 = el("div", "margin-bottom:8px;", tt("rv.import"));
    h1.className = "omp-h1";
    const sel = el("select", "width:100%;") as HTMLSelectElement;
    sel.size = Math.min(12, files.length);
    for (const f of files) {
      const o = el("option", "", f);
      o.value = f;
      sel.append(o);
    }
    sel.value = files[0];
    sel.dataset.role = "import-file";
    const title = el("input", "width:100%;box-sizing:border-box;margin-top:8px;") as HTMLInputElement;
    title.placeholder = tt("rv.import.title");
    const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;");
    const cancel = el("button", "", tt("rv.cancel"));
    const ok = el("button", "", tt("rv.import.do"));
    ok.className = "omp-btn-primary";
    ok.dataset.role = "import-ok";
    cancel.addEventListener("click", () => overlay.remove());
    ok.addEventListener("click", async () => {
      const res = await call("POST", "/import", { path: sel.value, title: title.value });
      if (!res.ok) {
        showToast(errText(res.data) || tt("rv.err.generic"));
        return;
      }
      overlay.remove();
      showToast(tt("rv.import.done"));
      void this.#refresh();
    });
    row.append(cancel, ok);
    m.append(h1, sel, title, row);
    overlay.append(m);
    document.body.append(overlay);
  }

  async #settingsDialog() {
    const r = await call<Config>("GET", "/config");
    if (!r.ok) return;
    openReviewSettingsForm({
      config: r.data as unknown as Record<string, unknown>,
      save: async (c) => {
        const res = await call("PUT", "/config", c);
        if (!res.ok) return { ok: false, message: errText(res.data) || tt("rv.err.generic") };
        this.#cfg = res.data as unknown as Config;
        showToast(tt("rv.saved"));
        return { ok: true, message: "" };
      },
    });
  }
}

if (!customElements.get("omp-review-view")) customElements.define("omp-review-view", ReviewView);
