// <omp-files-view> — Dateien (Kapitel 86, docs/ENTWURF-DATEIVERWALTUNG.md): Explorer je Ort/Host mit Dateifamilien (Rolle, „Gehört zu“),
// Dateizustand je Asset („Datei fehlt“), Papierkorb mit Wiederherstellen, Löschen mit Verwendungsprüfung und Einstellungen.
import { apiFetch, confirmDialog, features, getLang, showToast, t } from "../host.ts";
import { hasFeature } from "../../kit/features.ts";
import { canSubmitDelete, crumbs, deleteMode, fmtBytes, freePercent, joinPath, parentPath, remaining, type Plan } from "./files-logic.ts";

interface Root {
  id: string; name: string; hostId: string; path: string; role: string; readOnly: boolean;
  trashDays?: number; emergencyFreeGb?: number; emergencyFreePct?: number; lockBeforeH?: number; lockAfterH?: number;
  free?: number; total?: number; reachable?: boolean; error?: string; trashItems?: number;
}
interface AssetRef { id: string; title: string; type: string; status: string; representationType?: string }
interface Entry {
  name: string; isDir?: boolean; size?: number; mtimeMs?: number; abs?: string; role?: string; assets?: AssetRef[];
  orphan?: boolean; locks?: number; warnings?: number; state?: string;
}
interface Reason { kind: string; text: string }
interface DelItem { rootId: string; rootName: string; rel: string; abs: string; role?: string; derived?: boolean; status: string; error?: string; usage?: { absolute: Reason[]; hard: Reason[]; soft: Reason[] } }
interface DelPlan extends Plan { items: (DelItem & { rel: string; status: string })[] }
interface Cfg {
  trashDays: number; emergencyFreeGb: number; emergencyFreePct: number; graceMinutes: number; lockBeforeH: number; lockAfterH: number;
  plannedIsHard: boolean; checkEveryMin: number; checkBatch: number; sweepEveryMin: number;
}
interface RepState { representationId: string; type: string; provider: string; uri: string; state: string; size?: number; detail?: string; checkedAt?: string }
interface TrashRow { id: string; rel: string; deletedMs: number; size: number; expiresMs: number }
interface AssetRow { id: string; title: string; type: string; status: string }

const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);";
const CARD = "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:12px;margin-bottom:12px;";
const INPUT = "background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 6px;font:inherit;";
const TH = "text-align:left;padding:4px 8px;font-weight:600;border-bottom:1px solid var(--omp-border);white-space:nowrap;";
const TD = "padding:4px 8px;border-bottom:1px solid var(--omp-border);vertical-align:top;";
const STATE_COLOR: Record<string, string> = { present: "var(--omp-ok, #3a3)", missing: "var(--omp-danger, #d44)", unreachable: "var(--omp-warn, #db3)", unknown: "var(--omp-text-dim)", unchecked: "var(--omp-text-dim)" };
const ROLES = ["media", "import", "proxy", "subtitle", "recording", "output", "other"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}
function btn(label: string, on: () => void, opts: { disabled?: boolean; danger?: boolean; role?: string } = {}): HTMLButtonElement {
  const b = el("button", "cursor:pointer;" + (opts.danger ? "color:var(--omp-danger,#d44);" : ""), label);
  b.disabled = !!opts.disabled;
  if (opts.role) b.setAttribute("data-role", opts.role);
  b.addEventListener("click", on);
  return b;
}
function pill(text: string, color: string): HTMLElement {
  return el("span", `display:inline-block;padding:0 6px;border-radius:8px;border:1px solid ${color};color:${color};font-size:var(--omp-font-size-xs);white-space:nowrap;`, text);
}
const roleLabel = (r?: string): string => (r ? t(`filesv.role.${r}`) === `filesv.role.${r}` ? r : t(`filesv.role.${r}`) : "");
const stateLabel = (s?: string): string => (s ? (t(`filesv.state.${s}`) === `filesv.state.${s}` ? s : t(`filesv.state.${s}`)) : "");
const hostLabel = (h: string): string => (h ? t("filesv.root.host", { p0: h }) : t("filesv.root.host.local"));
const fmtMs = (ms?: number): string => (ms ? new Date(ms).toLocaleString(getLang() === "de" ? "de-DE" : "en-GB") : "–");

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* kein JSON */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}
const post = (url: string, body: unknown) => apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export class FilesView extends HTMLElement {
  #tab: "places" | "assets" | "trash" | "settings" = "places";
  #roots: Root[] = [];
  #rootId = "";
  #path = "";
  #entries: Entry[] = [];
  #next = "";
  #sel = new Set<string>();
  #filter = "";
  #orphanMode = false;
  #orphanInfo = "";
  #can = { view: false, del: false, force: false, upload: false, admin: false };
  #cfg: Cfg | null = null;
  #body!: HTMLDivElement;
  #err = "";
  // Nach Asset
  #assets: AssetRow[] = [];
  #astates = new Map<string, { state: string; total: number; missing: number }>();
  #aFilter = "";
  #aQuery = "";
  #open = new Set<string>();
  #repCache = new Map<string, { reps: RepState[]; related: { path: string; role: string }[] }>();
  // Papierkorb
  #trashRoot = "";
  #trash: TrashRow[] = [];
  #trashDays = 0;
  #trashSel = new Set<string>();

  connectedCallback() {
    this.style.cssText = "display:block;padding:var(--omp-space-3);overflow:auto;height:100%;box-sizing:border-box;color:var(--omp-text);background:var(--omp-bg);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);";
    this.#body = el("div");
    this.append(this.#body);
    void features().then(async (f) => {
      this.#can = {
        view: hasFeature(f, "files.view"), del: hasFeature(f, "files.delete"), force: hasFeature(f, "files.force"),
        upload: hasFeature(f, "files.upload"), admin: hasFeature(f, "files.admin"),
      };
      await this.#loadRoots();
      try { this.#cfg = await jsonOrThrow<Cfg>(await apiFetch("/api/v1/files/config")); } catch { /* Standardtext */ }
      await this.#loadDir();
      this.#render();
    });
  }

  get #root(): Root | undefined { return this.#roots.find((r) => r.id === this.#rootId); }

  async #loadRoots() {
    try {
      this.#roots = (await jsonOrThrow<Root[]>(await apiFetch("/api/v1/files/roots"))) ?? [];
      if (!this.#roots.some((r) => r.id === this.#rootId)) { this.#rootId = this.#roots[0]?.id ?? ""; this.#path = ""; }
      if (!this.#roots.some((r) => r.id === this.#trashRoot)) this.#trashRoot = this.#roots[0]?.id ?? "";
      this.#err = "";
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  async #loadDir(append = false) {
    const r = this.#root;
    if (!r) { this.#entries = []; return; }
    try {
      const cursor = append ? this.#next : "";
      const q = new URLSearchParams({ root: r.id, path: this.#path, limit: "300" });
      if (cursor) q.set("cursor", cursor);
      const body = await jsonOrThrow<{ entries: Entry[]; next?: string }>(await apiFetch(`/api/v1/files/list?${q}`));
      this.#entries = append ? [...this.#entries, ...(body.entries ?? [])] : (body.entries ?? []);
      this.#next = body.next ?? "";
      this.#err = "";
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); this.#entries = []; }
  }

  async #loadOrphans() {
    const r = this.#root;
    if (!r) return;
    try {
      const q = new URLSearchParams({ root: r.id, path: this.#path });
      const body = await jsonOrThrow<{ orphans: Entry[]; scanned: number; truncated: boolean }>(await apiFetch(`/api/v1/files/orphans?${q}`));
      this.#entries = body.orphans ?? [];
      this.#next = "";
      this.#orphanInfo = t("filesv.orphan.scanned", { p0: body.scanned }) + (body.truncated ? " — " + t("filesv.orphan.truncated") : "");
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); this.#entries = []; }
  }

  async #reload() {
    this.#sel.clear();
    await this.#loadRoots();
    if (this.#tab === "places") await (this.#orphanMode ? this.#loadOrphans() : this.#loadDir());
    this.#render();
  }

  #render() {
    this.#body.replaceChildren();
    if (!this.#can.view) { this.#body.append(el("div", DIM, t("filesv.err.noRight"))); return; }
    const bar = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:12px;flex-wrap:wrap;");
    bar.append(el("h2", "font-size:var(--omp-font-size-lg);margin:0 12px 0 0;", t("filesv.title")));
    const tabs: ["places" | "assets" | "trash" | "settings", string][] = [["places", "filesv.tab.places"], ["assets", "filesv.tab.assets"], ["trash", "filesv.tab.trash"]];
    if (this.#can.admin) tabs.push(["settings", "filesv.tab.settings"]);
    for (const [id, key] of tabs) {
      const b = btn(t(key), () => void this.#goTab(id), { role: `files-tab-${id}` });
      if (this.#tab === id) b.style.cssText += "font-weight:700;border-color:var(--omp-accent-cyan);";
      bar.append(b);
    }
    this.#body.append(bar);
    if (this.#err) this.#body.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", this.#err));
    switch (this.#tab) {
      case "places": this.#body.append(this.#viewPlaces()); break;
      case "assets": this.#body.append(this.#viewAssets()); break;
      case "trash": this.#body.append(this.#viewTrash()); break;
      case "settings": this.#body.append(this.#viewSettings()); break;
    }
  }

  async #goTab(tab: "places" | "assets" | "trash" | "settings") {
    this.#tab = tab;
    if (tab === "places") await this.#loadDir();
    if (tab === "assets") await this.#loadAssets();
    if (tab === "trash") await this.#loadTrash();
    if (tab === "settings") await this.#loadCfg();
    this.#render();
  }

  // ---- Nach Ort ---------------------------------------------------------------------------------------

  #viewPlaces(): HTMLElement {
    const wrap = el("div", "display:flex;gap:12px;align-items:flex-start;");
    const side = el("div", "min-width:230px;max-width:280px;");
    if (this.#roots.length === 0) side.append(el("div", DIM, t("filesv.noRoots")));
    for (const r of this.#roots) {
      const card = el("div", CARD + "cursor:pointer;margin-bottom:8px;padding:8px;" + (r.id === this.#rootId ? "border-color:var(--omp-accent-cyan);" : ""));
      card.setAttribute("data-root-id", r.id);
      card.append(el("div", "font-weight:600;", r.name));
      card.append(el("div", DIM, `${hostLabel(r.hostId)} · ${roleLabel(r.role)}${r.readOnly ? " · " + t("filesv.root.readOnly") : ""}`));
      card.append(el("div", DIM + "word-break:break-all;", r.path));
      if (r.reachable === false) card.append(el("div", "color:var(--omp-danger,#d44);", t("filesv.root.unreachable", { p0: r.error ?? "" })));
      else {
        const pct = freePercent(r.free, r.total);
        if (pct !== null) {
          const track = el("div", "height:6px;background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:3px;margin-top:4px;overflow:hidden;");
          track.append(el("div", `height:100%;width:${(100 - pct).toFixed(0)}%;background:${pct < 10 ? "var(--omp-danger,#d44)" : "var(--omp-accent-cyan)"};`));
          card.append(track, el("div", DIM, t("filesv.root.free", { p0: fmtBytes(r.free), p1: fmtBytes(r.total) })));
        }
        if (r.trashItems) card.append(el("div", DIM, t("filesv.root.trash", { p0: r.trashItems })));
      }
      card.addEventListener("click", () => { this.#rootId = r.id; this.#path = ""; this.#orphanMode = false; this.#sel.clear(); void this.#loadDir().then(() => this.#render()); });
      side.append(card);
    }
    wrap.append(side);
    const main = el("div", "flex:1;min-width:0;");
    const r = this.#root;
    if (r) main.append(...this.#placesMain(r));
    wrap.append(main);
    return wrap;
  }

  #placesMain(r: Root): HTMLElement[] {
    const out: HTMLElement[] = [];
    const nav = el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;");
    nav.append(btn(r.name, () => { this.#path = ""; this.#sel.clear(); void this.#reloadDir(); }));
    for (const c of crumbs(this.#path)) { nav.append(el("span", DIM, "/"), btn(c.name, () => { this.#path = c.path; this.#sel.clear(); void this.#reloadDir(); })); }
    if (this.#path) nav.append(btn(t("filesv.up"), () => { this.#path = parentPath(this.#path); this.#sel.clear(); void this.#reloadDir(); }));
    out.push(nav);

    const tools = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;");
    const f = el("input", INPUT) as HTMLInputElement;
    f.placeholder = t("filesv.filter");
    f.value = this.#filter;
    f.addEventListener("input", () => { this.#filter = f.value; this.#renderTable(); });
    tools.append(f);
    const orph = el("label", "display:flex;align-items:center;gap:4px;");
    const oc = el("input") as HTMLInputElement;
    oc.type = "checkbox"; oc.checked = this.#orphanMode;
    oc.addEventListener("change", () => { this.#orphanMode = oc.checked; this.#sel.clear(); void this.#reloadDir(); });
    orph.append(oc, document.createTextNode(t("filesv.orphan.only")));
    tools.append(orph, btn(t("filesv.reload"), () => void this.#reload()));
    if (this.#can.upload && !r.hostId && !r.readOnly) tools.append(btn(t("filesv.act.upload"), () => this.#upload(r), { role: "files-upload" }));
    const n = this.#sel.size;
    const sel = el("span", DIM, n ? t("filesv.act.selected", { p0: n }) : "");
    tools.append(sel);
    if (this.#can.del && n > 0) {
      tools.append(btn(t("filesv.act.newAsset"), () => this.#newAsset(r), { role: "files-new-asset" }));
      tools.append(btn(t("filesv.act.attach"), () => void this.#attach(r), { role: "files-attach", disabled: n !== 1 }));
      if (!r.readOnly) tools.append(btn(t("filesv.act.delete"), () => void this.#openDelete(r), { danger: true, role: "files-delete" }));
    }
    out.push(tools);
    if (this.#orphanMode && this.#orphanInfo) out.push(el("div", DIM + "margin-bottom:6px;", this.#orphanInfo));
    const holder = el("div"); holder.setAttribute("data-role", "files-table");
    out.push(holder);
    queueMicrotask(() => this.#renderTable());
    return out;
  }

  async #reloadDir() { await (this.#orphanMode ? this.#loadOrphans() : this.#loadDir()); this.#render(); }

  #renderTable() {
    const holder = this.querySelector('[data-role="files-table"]') as HTMLElement | null;
    const r = this.#root;
    if (!holder || !r) return;
    holder.replaceChildren();
    const q = this.#filter.trim().toLowerCase();
    const rows = this.#entries.filter((e) => !q || e.name.toLowerCase().includes(q));
    if (rows.length === 0) { holder.append(el("div", DIM, t("filesv.empty"))); return; }
    const table = el("table", "border-collapse:collapse;width:100%;");
    const head = el("tr");
    for (const h of ["", "filesv.col.name", "filesv.col.size", "filesv.col.modified", "filesv.col.role", "filesv.col.belongs", "filesv.col.state", "filesv.col.locks"]) head.append(el("th", TH, h ? t(h) : ""));
    table.append(head);
    for (const e of rows) {
      const rel = this.#orphanMode ? e.name : joinPath(this.#path, e.name);
      const tr = el("tr");
      tr.setAttribute("data-rel", rel);
      const c0 = el("td", TD);
      if (!e.isDir) {
        const cb = el("input") as HTMLInputElement;
        cb.type = "checkbox"; cb.checked = this.#sel.has(rel);
        cb.addEventListener("change", () => { if (cb.checked) this.#sel.add(rel); else this.#sel.delete(rel); this.#render(); });
        c0.append(cb);
      }
      const nameTd = el("td", TD + "word-break:break-all;");
      if (e.isDir) {
        const a = el("a", "cursor:pointer;color:var(--omp-accent-cyan);", "📁 " + e.name);
        a.addEventListener("click", () => { this.#path = rel; this.#sel.clear(); void this.#reloadDir(); });
        nameTd.append(a);
      } else nameTd.append(document.createTextNode(e.name));
      const roleTd = el("td", TD);
      const role = e.role ?? (e.orphan ? "" : "");
      if (e.orphan) roleTd.append(pill(t("filesv.orphan"), "var(--omp-warn,#db3)"));
      else if (role) roleTd.append(pill(roleLabel(role), "var(--omp-text-dim)"));
      const belongs = el("td", TD);
      for (const a of e.assets ?? []) belongs.append(el("div", "", `${a.title} (${a.type})`));
      const st = el("td", TD);
      if (e.state) st.append(pill(stateLabel(e.state), STATE_COLOR[e.state] ?? "var(--omp-text-dim)"));
      const lk = el("td", TD);
      if (e.locks || e.warnings) { const s = pill(`🔒 ${e.locks ?? 0} · ⚠ ${e.warnings ?? 0}`, e.locks ? "var(--omp-danger,#d44)" : "var(--omp-warn,#db3)"); s.title = t("filesv.lock.title", { p0: e.locks ?? 0, p1: e.warnings ?? 0 }); lk.append(s); }
      tr.append(c0, nameTd, el("td", TD, e.isDir ? "" : fmtBytes(e.size)), el("td", TD, fmtMs(e.mtimeMs)), roleTd, belongs, st, lk);
      table.append(tr);
    }
    holder.append(table);
    if (this.#next && !this.#orphanMode) holder.append(btn(t("filesv.more"), () => void this.#loadDir(true).then(() => this.#render())));
  }

  // ---- Löschen ------------------------------------------------------------------------------------------

  #modal(title: string, build: (box: HTMLElement, close: () => void) => void): void {
    const overlay = el("div", "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;");
    const box = el("div", "background:var(--omp-surface-raised);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:16px;width:min(860px,94vw);max-height:88vh;overflow:auto;");
    box.append(el("h3", "margin:0 0 10px;font-size:var(--omp-font-size-md);", title));
    const close = () => overlay.remove();
    build(box, close);
    overlay.append(box);
    document.body.append(overlay);
  }

  async #openDelete(r: Root) {
    const st = { family: false, confirm: false, force: false, reason: "", plan: null as DelPlan | null, error: "" };
    const paths = [...this.#sel];
    this.#modal(t("filesv.del.title"), (box, close) => {
      const draw = async (reload: boolean) => {
        if (reload) {
          try { st.plan = await jsonOrThrow<DelPlan>(await post("/api/v1/files/delete/preview", { root: r.id, paths, withFamily: st.family })); st.error = ""; }
          catch (e) { st.error = (e as Error).message; }
        }
        box.replaceChildren(el("h3", "margin:0 0 10px;font-size:var(--omp-font-size-md);", t("filesv.del.title")));
        if (st.error) box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", st.error));
        const plan = st.plan;
        if (!plan) return;
        const days = r.trashDays ?? this.#cfg?.trashDays;
        box.append(el("div", DIM + "margin-bottom:8px;", days === 0 ? t("filesv.del.introNow") : t("filesv.del.intro", { p0: days ?? 7 })));
        const fam = el("label", "display:flex;gap:6px;align-items:center;margin-bottom:8px;");
        const fc = el("input") as HTMLInputElement; fc.type = "checkbox"; fc.checked = st.family;
        fc.addEventListener("change", () => { st.family = fc.checked; void draw(true); });
        fam.append(fc, document.createTextNode(t("filesv.del.family")));
        box.append(fam);
        const table = el("table", "border-collapse:collapse;width:100%;margin-bottom:8px;");
        for (const it of plan.items) {
          const tr = el("tr");
          const color = it.status === "blocked" || it.status === "error" ? "var(--omp-danger,#d44)" : it.status === "locked" ? "var(--omp-warn,#db3)" : it.status === "confirm" ? "var(--omp-warn,#db3)" : it.status === "deleted" ? "var(--omp-ok,#3a3)" : "var(--omp-text-dim)";
          const c1 = el("td", TD + "word-break:break-all;", (it.derived ? "↳ " : "") + it.rel);
          if (it.role) c1.append(document.createTextNode(" "), pill(roleLabel(it.role), "var(--omp-text-dim)"));
          c1.append(document.createTextNode(" "), pill(it.derived ? t("filesv.del.derived") : t("filesv.del.master"), "var(--omp-text-dim)"));
          const c2 = el("td", TD);
          c2.append(pill(t(`filesv.del.status.${it.status}`), color));
          const reasons = [...(it.usage?.absolute ?? []), ...(it.usage?.hard ?? []), ...(it.usage?.soft ?? [])].map((x) => x.text);
          if (it.error && !reasons.includes(it.error)) reasons.unshift(it.error);
          for (const x of reasons) c2.append(el("div", DIM, x));
          tr.append(c1, c2);
          table.append(tr);
        }
        box.append(table);
        const mode = deleteMode(plan);
        if (mode === "blocked") box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", t("filesv.del.blocked")));
        if (mode === "force") {
          box.append(el("div", DIM + "margin-bottom:6px;", t("filesv.del.forceNote")));
          if (!this.#can.force) box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:6px;", t("filesv.del.noForceRight")));
          else {
            const l = el("label", "display:flex;gap:6px;align-items:center;margin-bottom:6px;");
            const c = el("input") as HTMLInputElement; c.type = "checkbox"; c.checked = st.force;
            c.addEventListener("change", () => { st.force = c.checked; void draw(false); });
            l.append(c, document.createTextNode(t("filesv.del.force")));
            const reason = el("input", INPUT + "width:100%;box-sizing:border-box;margin-bottom:8px;") as HTMLInputElement;
            reason.placeholder = t("filesv.del.reason"); reason.value = st.reason;
            reason.addEventListener("input", () => { st.reason = reason.value; run.disabled = !canSubmitDelete(plan, { confirm: st.confirm, force: st.force, reason: st.reason, canForce: this.#can.force }); });
            box.append(l, reason);
          }
        }
        if (mode === "confirm" || (mode === "force" && plan.needsConfirm)) {
          const l = el("label", "display:flex;gap:6px;align-items:center;margin-bottom:8px;");
          const c = el("input") as HTMLInputElement; c.type = "checkbox"; c.checked = st.confirm;
          c.addEventListener("change", () => { st.confirm = c.checked; void draw(false); });
          l.append(c, document.createTextNode(t("filesv.del.confirm")));
          box.append(l);
        }
        const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;");
        const done = plan.items.some((i) => i.status === "deleted");
        const run = btn(t("filesv.del.run"), async () => {
          run.disabled = true;
          const res = await post("/api/v1/files/delete", { root: r.id, paths, withFamily: st.family, confirm: st.confirm, force: st.force, reason: st.reason });
          const body = (await res.json().catch(() => ({}))) as { error?: string; plan?: DelPlan; items?: DelItem[] };
          if (!res.ok) { st.error = body.error ?? String(res.status); void draw(false); return; }
          const n = (body as unknown as DelPlan).items.filter((i) => i.status === "deleted").length;
          showToast(t("filesv.del.done", { p0: n }));
          close();
          await this.#reload();
        }, { danger: true, role: "files-delete-run", disabled: done || !canSubmitDelete(plan, { confirm: st.confirm, force: st.force, reason: st.reason, canForce: this.#can.force }) });
        foot.append(btn(t("filesv.del.cancel"), close), run);
        box.append(foot);
      };
      void draw(true);
    });
  }

  // ---- Asset anlegen / zuordnen / Upload ------------------------------------------------------------------

  #newAsset(r: Root) {
    const paths = [...this.#sel];
    this.#modal(t("filesv.newAsset.title"), (box, close) => {
      const type = el("input", INPUT) as HTMLInputElement; type.value = "video"; type.setAttribute("list", "files-asset-types");
      const dl = el("datalist"); dl.id = "files-asset-types";
      for (const v of ["video", "audio", "image", "subtitle", "document"]) { const o = el("option"); o.value = v; dl.append(o); }
      const title = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement; title.disabled = paths.length !== 1;
      box.append(el("div", DIM, paths.join(", ")), el("div", "margin-top:8px;", t("filesv.newAsset.type")), type, dl, el("div", "margin-top:8px;", t("filesv.newAsset.titleField")), title);
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
      foot.append(btn(t("filesv.del.cancel"), close), btn(t("filesv.act.newAsset"), async () => {
        const res = await post("/api/v1/files/assets", { root: r.id, paths, type: type.value, title: title.value });
        if (!res.ok) { showToast(t("filesv.newAsset.failed", { p0: res.status })); return; }
        const out = (await res.json()) as { path: string; assetId?: string; error?: string }[];
        const ok = out.filter((o) => o.assetId).length;
        const bad = out.filter((o) => o.error).map((o) => `${o.path}: ${o.error}`);
        showToast(ok ? t("filesv.newAsset.done", { p0: ok }) : t("filesv.newAsset.failed", { p0: bad.join("; ") }));
        if (bad.length && ok) showToast(t("filesv.newAsset.failed", { p0: bad.join("; ") }));
        close();
        await this.#reload();
      }, { role: "files-new-asset-run" }));
      box.append(foot);
    });
  }

  async #attach(r: Root) {
    const rel = [...this.#sel][0];
    let assets: AssetRow[] = [];
    try { assets = (await jsonOrThrow<AssetRow[]>(await apiFetch("/api/v1/assets"))) ?? []; } catch { /* leer */ }
    this.#modal(t("filesv.attach.title"), (box, close) => {
      const sel = el("select", INPUT + "width:100%;") as HTMLSelectElement;
      for (const a of assets.filter((x) => x.status !== "deleted")) { const o = el("option"); o.value = a.id; o.textContent = `${a.title} (${a.type})`; sel.append(o); }
      const type = el("input", INPUT) as HTMLInputElement; type.value = "proxy";
      box.append(el("div", DIM, rel), el("div", "margin-top:8px;", t("filesv.attach.asset")), sel, el("div", "margin-top:8px;", t("filesv.attach.type")), type);
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
      foot.append(btn(t("filesv.del.cancel"), close), btn(t("filesv.attach.run"), async () => {
        const res = await post(`/api/v1/files/assets/${sel.value}/attach`, { root: r.id, path: rel, representationType: type.value });
        if (!res.ok) { showToast(t("filesv.newAsset.failed", { p0: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status })); return; }
        showToast(t("filesv.attach.done"));
        close();
        await this.#reload();
      }, { role: "files-attach-run" }));
      box.append(foot);
    });
  }

  #upload(r: Root) {
    const input = el("input") as HTMLInputElement;
    input.type = "file";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      showToast(t("filesv.upload.running"));
      const q = new URLSearchParams({ root: r.id, path: joinPath(this.#path, f.name) });
      const res = await apiFetch(`/api/v1/files/upload?${q}`, { method: "POST", body: f });
      if (res.ok) showToast(t("filesv.upload.done", { p0: f.name }));
      else showToast(t("filesv.upload.failed", { p0: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status }));
      await this.#reload();
    });
    input.click();
  }

  // ---- Nach Asset -----------------------------------------------------------------------------------------

  async #loadAssets() {
    try {
      this.#assets = (await jsonOrThrow<AssetRow[]>(await apiFetch("/api/v1/assets"))) ?? [];
      const st = await jsonOrThrow<{ assets: { assetId: string; state: string; total: number; missing: number }[] }>(await apiFetch("/api/v1/files/asset-states"));
      this.#astates = new Map((st.assets ?? []).map((a) => [a.assetId, { state: a.state, total: a.total, missing: a.missing }]));
      this.#err = "";
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  async #loadAssetFiles(id: string, check = false) {
    try {
      const body = await jsonOrThrow<{ representations: RepState[]; related: { path: string; role: string }[] }>(await apiFetch(`/api/v1/files/assets/${id}${check ? "?check=1" : ""}`));
      this.#repCache.set(id, { reps: body.representations ?? [], related: body.related ?? [] });
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  #viewAssets(): HTMLElement {
    const wrap = el("div");
    const tools = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    const q = el("input", INPUT) as HTMLInputElement; q.placeholder = t("filesv.assets.search"); q.value = this.#aQuery;
    q.addEventListener("input", () => { this.#aQuery = q.value; this.#renderAssetRows(); });
    const f = el("select", INPUT) as HTMLSelectElement;
    f.setAttribute("data-role", "files-asset-filter");
    for (const v of ["", "problem", "ok", "missing", "partial", "unreachable", "unchecked", "none"]) {
      const o = el("option"); o.value = v; o.textContent = v ? t(`files.filter.${v}`) : t("filesv.assets.all"); f.append(o);
    }
    f.value = this.#aFilter;
    f.addEventListener("change", () => { this.#aFilter = f.value; this.#renderAssetRows(); });
    tools.append(el("span", DIM, t("filesv.assets.filter")), f, q, btn(t("filesv.reload"), () => void this.#loadAssets().then(() => this.#render())));
    if (this.#can.admin) tools.append(btn(t("filesv.assets.checkAll"), async () => { await post("/api/v1/files/check", {}); showToast(t("files.checked")); }));
    wrap.append(tools);
    const holder = el("div"); holder.setAttribute("data-role", "files-asset-rows");
    wrap.append(holder);
    queueMicrotask(() => this.#renderAssetRows());
    return wrap;
  }

  #renderAssetRows() {
    const holder = this.querySelector('[data-role="files-asset-rows"]') as HTMLElement | null;
    if (!holder) return;
    holder.replaceChildren();
    const q = this.#aQuery.trim().toLowerCase();
    const rows = this.#assets.filter((a) => {
      if (a.status === "deleted") return false;
      const s = this.#astates.get(a.id)?.state ?? "unchecked";
      if (this.#aFilter === "problem" ? !["missing", "partial", "unreachable"].includes(s) : this.#aFilter && s !== this.#aFilter) return false;
      return !q || a.title.toLowerCase().includes(q) || a.type.toLowerCase().includes(q);
    });
    holder.append(el("div", DIM + "margin-bottom:6px;", t("filesv.assets.counts", { p0: rows.length })));
    if (rows.length === 0) { holder.append(el("div", DIM, t("filesv.assets.none"))); return; }
    for (const a of rows.slice(0, 300)) {
      const s = this.#astates.get(a.id);
      const card = el("div", CARD + "padding:8px;margin-bottom:6px;");
      card.setAttribute("data-asset-id", a.id);
      const head = el("div", "display:flex;gap:8px;align-items:center;cursor:pointer;");
      const color = s?.state === "ok" ? STATE_COLOR.present : s?.state === "missing" || s?.state === "partial" ? STATE_COLOR.missing : s?.state === "unreachable" ? STATE_COLOR.unreachable : STATE_COLOR.unchecked;
      head.append(el("span", "font-weight:600;flex:1;", a.title), el("span", DIM, a.type), pill(s ? t(`files.filter.${s.state}`) : "–", color));
      head.addEventListener("click", async () => {
        if (this.#open.has(a.id)) this.#open.delete(a.id);
        else { this.#open.add(a.id); await this.#loadAssetFiles(a.id); }
        this.#renderAssetRows();
      });
      card.append(head);
      if (this.#open.has(a.id)) card.append(this.#assetFamily(a.id));
      holder.append(card);
    }
  }

  #assetFamily(id: string): HTMLElement {
    const box = el("div", "margin-top:8px;");
    const c = this.#repCache.get(id);
    if (!c) return box;
    const table = el("table", "border-collapse:collapse;width:100%;");
    const h = el("tr");
    for (const x of ["filesv.assets.rep", "filesv.col.name", "filesv.col.size", "filesv.col.state"]) h.append(el("th", TH, t(x)));
    table.append(h);
    for (const r of c.reps) {
      const tr = el("tr");
      const st = el("td", TD);
      st.append(pill(stateLabel(r.state) || r.state, STATE_COLOR[r.state] ?? STATE_COLOR.unchecked));
      if (r.detail) st.append(el("div", DIM, r.detail));
      if (r.checkedAt) st.append(el("div", DIM, t("filesv.assets.checked", { p0: new Date(r.checkedAt).toLocaleString() })));
      tr.append(el("td", TD, roleLabel(r.type) || r.type), el("td", TD + "word-break:break-all;", `${r.provider}: ${r.uri}`), el("td", TD, fmtBytes(r.size)), st);
      table.append(tr);
    }
    box.append(table);
    if (c.related.length) {
      box.append(el("div", DIM + "margin-top:6px;", t("filesv.assets.related")));
      for (const r of c.related) box.append(el("div", "word-break:break-all;", `${roleLabel(r.role) || r.role}: ${r.path}`));
    }
    box.append(btn(t("filesv.assets.check"), async () => { await this.#loadAssetFiles(id, true); await this.#loadAssets(); this.#renderAssetRows(); }, { role: "files-asset-check" }));
    return box;
  }

  // ---- Papierkorb -----------------------------------------------------------------------------------------

  async #loadTrash() {
    if (!this.#trashRoot) { this.#trash = []; return; }
    try {
      const body = await jsonOrThrow<{ entries: TrashRow[]; retentionDays: number }>(await apiFetch(`/api/v1/files/trash?root=${encodeURIComponent(this.#trashRoot)}`));
      this.#trash = body.entries ?? [];
      this.#trashDays = body.retentionDays;
      this.#trashSel.clear();
      this.#err = "";
    } catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); this.#trash = []; }
  }

  #viewTrash(): HTMLElement {
    const wrap = el("div");
    const tools = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    const sel = el("select", INPUT) as HTMLSelectElement;
    for (const r of this.#roots.filter((x) => !x.readOnly)) { const o = el("option"); o.value = r.id; o.textContent = r.name; sel.append(o); }
    sel.value = this.#trashRoot;
    sel.addEventListener("change", () => { this.#trashRoot = sel.value; void this.#loadTrash().then(() => this.#render()); });
    tools.append(el("span", DIM, t("filesv.trash.root")), sel, el("span", DIM, t("filesv.trash.retention", { p0: this.#trashDays })));
    const n = this.#trashSel.size;
    if (this.#can.del && n > 0) tools.append(btn(t("filesv.trash.restore"), async () => {
      const res = await post("/api/v1/files/trash/restore", { root: this.#trashRoot, ids: [...this.#trashSel] });
      const out = (await res.json().catch(() => [])) as { ok: boolean; error?: string; rel: string }[];
      const bad = Array.isArray(out) ? out.filter((o) => !o.ok).map((o) => `${o.rel}: ${o.error}`) : [];
      showToast(bad.length ? t("filesv.del.failed", { p0: bad.join("; ") }) : t("filesv.trash.restored"));
      await this.#loadTrash(); this.#render();
    }, { role: "files-restore" }));
    if (this.#can.admin) {
      if (n > 0) tools.append(btn(t("filesv.trash.purge"), async () => {
        if (!(await confirmDialog(t("filesv.trash.purgeConfirm")))) return;
        await post("/api/v1/files/trash/purge", { root: this.#trashRoot, ids: [...this.#trashSel] });
        await this.#loadTrash(); this.#render();
      }, { danger: true }));
      if (this.#trash.length) tools.append(btn(t("filesv.trash.purgeAll"), async () => {
        if (!(await confirmDialog(t("filesv.trash.purgeAllConfirm")))) return;
        await post("/api/v1/files/trash/purge", { root: this.#trashRoot, all: true });
        await this.#loadTrash(); this.#render();
      }, { danger: true }));
    }
    wrap.append(tools);
    if (this.#trash.length === 0) { wrap.append(el("div", DIM, t("filesv.trash.empty"))); return wrap; }
    const table = el("table", "border-collapse:collapse;width:100%;");
    const h = el("tr");
    for (const x of ["", "filesv.col.name", "filesv.col.size", "filesv.trash.deleted", "filesv.trash.expires"]) h.append(el("th", TH, x ? t(x) : ""));
    table.append(h);
    const now = Date.now();
    for (const e of this.#trash) {
      const tr = el("tr");
      const cb = el("input") as HTMLInputElement; cb.type = "checkbox"; cb.checked = this.#trashSel.has(e.id);
      cb.addEventListener("change", () => { if (cb.checked) this.#trashSel.add(e.id); else this.#trashSel.delete(e.id); this.#render(); });
      const c0 = el("td", TD); c0.append(cb);
      tr.append(c0, el("td", TD + "word-break:break-all;", e.rel), el("td", TD, fmtBytes(e.size)), el("td", TD, fmtMs(e.deletedMs)), el("td", TD, remaining(e.expiresMs, now)));
      table.append(tr);
    }
    wrap.append(table);
    return wrap;
  }

  // ---- Einstellungen (files.admin) -----------------------------------------------------------------------

  async #loadCfg() {
    try { this.#cfg = await jsonOrThrow<Cfg>(await apiFetch("/api/v1/files/config")); await this.#loadRoots(); this.#err = ""; }
    catch (e) { this.#err = t("filesv.err.load", { p0: (e as Error).message }); }
  }

  #viewSettings(): HTMLElement {
    const wrap = el("div");
    const c = this.#cfg;
    if (c) {
      const card = el("div", CARD);
      card.append(el("h3", "margin:0 0 8px;font-size:var(--omp-font-size-md);", t("filesv.set.config")));
      const fields: [keyof Cfg, string][] = [["trashDays", "filesv.set.trashDays"], ["emergencyFreeGb", "filesv.set.emerGb"], ["emergencyFreePct", "filesv.set.emerPct"], ["graceMinutes", "filesv.set.grace"],
        ["lockBeforeH", "filesv.set.lockBefore"], ["lockAfterH", "filesv.set.lockAfter"], ["checkEveryMin", "filesv.set.checkEvery"], ["sweepEveryMin", "filesv.set.sweepEvery"]];
      const inputs = new Map<keyof Cfg, HTMLInputElement>();
      const grid = el("div", "display:grid;grid-template-columns:minmax(260px,1fr) 120px;gap:6px 12px;align-items:center;max-width:620px;");
      for (const [k, key] of fields) {
        const i = el("input", INPUT) as HTMLInputElement; i.type = "number"; i.min = "0"; i.step = "any"; i.value = String(c[k]);
        inputs.set(k, i); grid.append(el("label", "", t(key)), i);
      }
      const pl = el("input") as HTMLInputElement; pl.type = "checkbox"; pl.checked = c.plannedIsHard;
      const plWrap = el("label", "display:flex;gap:6px;align-items:center;grid-column:1 / span 2;"); plWrap.append(pl, document.createTextNode(t("filesv.set.planned")));
      grid.append(plWrap);
      card.append(grid);
      card.append(btn(t("filesv.set.save"), async () => {
        const body: Record<string, unknown> = { plannedIsHard: pl.checked };
        for (const [k, i] of inputs) body[k] = Number(i.value);
        const res = await apiFetch("/api/v1/files/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) { this.#cfg = (await res.json()) as Cfg; showToast(t("filesv.set.saved")); } else showToast(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      }, { role: "files-config-save" }));
      wrap.append(card);
    }
    wrap.append(this.#rootsCard());
    return wrap;
  }

  #rootsCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("h3", "margin:0 0 4px;font-size:var(--omp-font-size-md);", t("filesv.set.roots")), el("div", DIM + "margin-bottom:8px;", t("filesv.set.note")));
    const num = (v: number | undefined) => (v === undefined ? "" : String(v));
    const opt = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));
    const table = el("table", "border-collapse:collapse;width:100%;");
    const h = el("tr");
    for (const x of ["filesv.set.name", "filesv.set.host", "filesv.set.path", "filesv.set.role", "filesv.set.readOnly", "filesv.set.trashDaysRoot", "filesv.set.lockBeforeRoot", "filesv.set.lockAfterRoot", "filesv.set.emerGbRoot"]) h.append(el("th", TH, t(x)));
    h.append(el("th", TH));
    table.append(h);
    for (const r of this.#roots) {
      const tr = el("tr");
      const role = el("select", INPUT) as HTMLSelectElement;
      for (const v of ROLES) { const o = el("option"); o.value = v; o.textContent = roleLabel(v); role.append(o); }
      role.value = r.role;
      const ro = el("input") as HTMLInputElement; ro.type = "checkbox"; ro.checked = r.readOnly;
      const mk = (v: number | undefined) => { const i = el("input", INPUT + "width:70px;") as HTMLInputElement; i.type = "number"; i.min = "0"; i.step = "any"; i.value = num(v); return i; };
      const td = mk(r.trashDays), lb = mk(r.lockBeforeH), la = mk(r.lockAfterH), eg = mk(r.emergencyFreeGb);
      const cell = (n: Node) => { const c = el("td", TD); c.append(n); return c; };
      const actions = el("td", TD + "white-space:nowrap;");
      actions.append(btn(t("filesv.set.save"), async () => {
        const res = await apiFetch(`/api/v1/files/roots/${r.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: role.value, readOnly: ro.checked, trashDays: opt(td.value), lockBeforeH: opt(lb.value), lockAfterH: opt(la.value), emergencyFreeGb: opt(eg.value) }) });
        showToast(res.ok ? t("filesv.set.rootSaved") : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
        await this.#loadRoots(); this.#render();
      }), btn(t("filesv.set.remove"), async () => {
        if (!(await confirmDialog(t("filesv.set.removeConfirm", { p0: r.name })))) return;
        await apiFetch(`/api/v1/files/roots/${r.id}`, { method: "DELETE" });
        await this.#loadRoots(); this.#render();
      }, { danger: true }));
      tr.append(el("td", TD, r.name), el("td", TD, hostLabel(r.hostId)), el("td", TD + "word-break:break-all;", r.path), cell(role), cell(ro), cell(td), cell(lb), cell(la), cell(eg), actions);
      table.append(tr);
    }
    card.append(table);
    card.append(btn(t("filesv.set.addRoot"), () => void this.#addRoot(), { role: "files-add-root" }));
    return card;
  }

  async #addRoot() {
    let hosts: { id?: string; ID?: string; label?: string; Label?: string; hostname?: string }[] = [];
    try { hosts = (await jsonOrThrow<typeof hosts>(await apiFetch("/api/v1/hosts"))) ?? []; } catch { /* nur Texteingabe */ }
    this.#modal(t("filesv.set.addRoot"), (box, close) => {
      const mk = (label: string, i: HTMLElement) => { box.append(el("div", "margin-top:8px;", label), i); };
      const name = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement;
      const host = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement; host.setAttribute("list", "files-hosts");
      const dl = el("datalist"); dl.id = "files-hosts";
      for (const h of hosts) { const o = el("option"); o.value = h.id ?? h.ID ?? ""; o.label = h.label ?? h.Label ?? h.hostname ?? ""; dl.append(o); }
      const path = el("input", INPUT + "width:100%;box-sizing:border-box;") as HTMLInputElement;
      const role = el("select", INPUT) as HTMLSelectElement;
      for (const v of ROLES) { const o = el("option"); o.value = v; o.textContent = roleLabel(v); role.append(o); }
      const ro = el("input") as HTMLInputElement; ro.type = "checkbox";
      mk(t("filesv.set.name"), name); mk(t("filesv.set.host"), host); box.append(dl); mk(t("filesv.set.path"), path); mk(t("filesv.set.role"), role);
      const l = el("label", "display:flex;gap:6px;align-items:center;margin-top:8px;"); l.append(ro, document.createTextNode(t("filesv.set.readOnly"))); box.append(l);
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
      foot.append(btn(t("filesv.del.cancel"), close), btn(t("filesv.set.addRoot"), async () => {
        const res = await post("/api/v1/files/roots", { name: name.value, hostId: host.value.trim(), path: path.value, role: role.value, readOnly: ro.checked });
        if (!res.ok) { showToast(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status)); return; }
        const made = (await res.json().catch(() => ({}))) as { warning?: string };
        showToast(made.warning ? t("filesv.set.rootWarn", { p0: made.warning }) : t("filesv.set.rootSaved"));
        close();
        await this.#loadRoots(); this.#render();
      }, { role: "files-add-root-run" }));
      box.append(foot);
    });
  }
}

if (!customElements.get("omp-files-view")) customElements.define("omp-files-view", FilesView);
