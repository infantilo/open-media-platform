// Arbeitsplatz-Startseite eines Operators (Kapitel 44): Workflows zum Wechseln bzw. Countdown bis zum nächsten Start,
// darunter die Aufgabenliste (zugewiesene QC-Dateien, eigene Aufnahmen) und die Kacheln der Module, für die die Person
// Funktionsrechte hat. Kachel-Ansicht (`/?tile=<modul>:<kachel>`): dieselbe Modul-Oberfläche wie der Engineering-Tab, der
// Server beschränkt den Inhalt auf das, was die Person sehen und tun darf.
import { dateLocale, getLang, t } from "./i18n.ts";
import { whoami } from "./auth.ts";
import "./upcoming.ts";
import { getDirectory, getMyFeatures, getMyTasks } from "./features-api.ts";
import { ensureBundle, getModules } from "./modules-registry.ts";
import { workTiles, type WorkTile } from "./modules-logic.ts";
import { type Directory, groupName, hasAnyFeature } from "../kit/features.ts";
import { dueText, problemKey, sortTasks, stateKey, summarize, type Task, tasksOf } from "./task-logic.ts";
import { tLoose } from "./i18n.ts";
import type { ConsoleEntry } from "./console-view.ts";

const REFRESH_MS = 20_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

/** Kacheln des Arbeitsplatzes für die angemeldete Person (leer ohne Funktionsrechte). */
export async function loadWorkTiles(): Promise<WorkTile[]> {
  const [mods, feats] = await Promise.all([getModules(), getMyFeatures(true)]);
  // Wer alles darf (globales „configure“ bzw. Bootstrap-Modus ohne Nutzer), hat die Ansichten als Tabs — kein Arbeitsplatz.
  if (feats?.all) return [];
  return workTiles(mods, getLang(), (needs) => hasAnyFeature(feats, needs));
}

const KIND_KEYS: Record<string, "op.task.kind.qc" | "op.task.kind.recording" | "op.task.kind.approval"> = {
  qc: "op.task.kind.qc",
  recording: "op.task.kind.recording",
  approval: "op.task.kind.approval",
};

const STATUS_COLOR: Record<string, string> = {
  error: "var(--omp-error)",
  warn: "var(--omp-cue, #e0a030)",
  active: "var(--omp-ok, #4caf50)",
  ok: "var(--omp-text-dim)",
};

export function tileHref(tileId: string, ref?: string): string {
  const q = new URLSearchParams({ tile: tileId });
  if (ref) q.set("ref", ref);
  return `/?${q}`;
}

/** Kachel der Aufgabe: die erste Kachel ihres Moduls. */
export function tileForTask(tiles: WorkTile[], task: Task): WorkTile | undefined {
  return tiles.find((x) => x.module === task.module);
}

/** Symbol je Modul (Kachel); unbekannte Module bekommen einen neutralen Rhombus. */
const MODULE_ICON: Record<string, string> = { qc: "✔", ingest: "⤓", recording: "⏺", record: "⏺", review: "▶", playout: "▤", radio: "♫", files: "🗂", graphics: "✦" };
function iconFor(module: string): string {
  const k = Object.keys(MODULE_ICON).find((m) => module.toLowerCase().includes(m));
  return k ? MODULE_ICON[k]! : "◆";
}

const LANDING_BOX =
  "display:block;box-sizing:border-box;width:100%;height:100%;overflow-y:auto;padding:24px 24px 72px;" +
  "background:radial-gradient(70% 38% at 50% -4%,rgba(25,211,243,.14),transparent 70%),radial-gradient(45% 30% at 88% 6%,rgba(164,92,255,.14),transparent 70%),var(--omp-bg);" +
  "background-repeat:no-repeat;color:var(--omp-text);font-family:var(--omp-font);";

const HOME_CSS = `
.oh-root .oh-wrap{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:40px;align-items:stretch;}
.oh-root .oh-hero{text-align:center;padding:28px 0 4px;display:flex;flex-direction:column;align-items:center;gap:6px;}
.oh-root .oh-hero h1{margin:0;font-size:clamp(30px,5vw,46px);font-weight:700;letter-spacing:-.01em;line-height:1.1;
  background:var(--omp-accent-gradient);-webkit-background-clip:text;background-clip:text;color:transparent;}
.oh-root .oh-hello{font-size:var(--omp-font-size-lg,15px);color:var(--omp-text-dim);}
.oh-root .oh-clock{margin-top:10px;display:inline-flex;gap:14px;align-items:baseline;padding:6px 18px;border-radius:999px;
  border:1px solid var(--omp-border);background:rgba(15,21,34,.6);backdrop-filter:blur(6px);}
.oh-root .oh-clock b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.04em;}
.oh-root .oh-clock span{font-size:var(--omp-font-size-sm,12px);color:var(--omp-text-dim);}
.oh-root .oh-section{display:flex;flex-direction:column;gap:18px;align-items:center;}
.oh-root .oh-section>h2{margin:0;width:100%;display:flex;align-items:center;gap:16px;font-size:12px;font-weight:600;
  letter-spacing:.18em;text-transform:uppercase;color:var(--omp-text-dim);}
.oh-root .oh-section>h2::before,.oh-root .oh-section>h2::after{content:"";flex:1;height:1px;
  background:linear-gradient(90deg,transparent,var(--omp-border),transparent);}
.oh-root .oh-section>h2 small{font-weight:400;letter-spacing:.02em;text-transform:none;font-size:var(--omp-font-size-xs,11px);}
.oh-root .oh-grid{width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,260px));justify-content:center;gap:18px;}
.oh-root .oh-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 20px 18px;
  border:1px solid var(--omp-border);border-radius:16px;text-align:center;color:var(--omp-text);text-decoration:none;
  background:linear-gradient(160deg,var(--omp-surface-raised),var(--omp-surface));
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
.oh-root .oh-card:hover,.oh-root .oh-card:focus-visible{transform:translateY(-4px);border-color:var(--omp-accent-cyan);outline:none;
  box-shadow:0 14px 34px rgba(0,0,0,.5),0 0 0 1px rgba(25,211,243,.25),0 0 28px rgba(25,211,243,.16);}
.oh-root .oh-ico{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-size:24px;
  background:linear-gradient(135deg,rgba(25,211,243,.22),rgba(164,92,255,.22));border:1px solid rgba(25,211,243,.35);margin-bottom:4px;}
.oh-root .oh-name{font-size:17px;font-weight:600;}
.oh-root .oh-meta{font-size:12px;color:var(--omp-text-dim);display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;min-height:16px;}
.oh-root .oh-cta{margin-top:6px;font-size:12px;color:var(--omp-accent-cyan);opacity:0;transform:translateY(3px);transition:opacity .18s,transform .18s;}
.oh-root .oh-card:hover .oh-cta,.oh-root .oh-card:focus-visible .oh-cta{opacity:1;transform:none;}
.oh-root .oh-live{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--omp-preset,#43a047);margin-right:6px;
  box-shadow:0 0 8px 2px rgba(67,160,71,.6);animation:oh-pulse 2s ease-in-out infinite;}
@keyframes oh-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.oh-root .oh-panel{width:100%;box-sizing:border-box;padding:6px 18px 12px;border:1px solid var(--omp-border);border-radius:16px;
  background:linear-gradient(160deg,var(--omp-surface),rgba(15,21,34,.55));overflow-x:auto;}
.oh-root .oh-empty{color:var(--omp-text-dim);text-align:center;padding:18px 0;}
.oh-root .oh-wf-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 28px;border:1px dashed var(--omp-border);
  border-radius:16px;color:var(--omp-text-dim);text-align:center;}
.oh-root .oh-center{width:100%;max-width:1100px;margin:0 auto;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center;}
.oh-root .oh-text{max-width:460px;color:var(--omp-text-dim);font-size:14px;line-height:1.55;margin:0;}
.oh-root .oh-btn{padding:9px 26px;border-radius:999px;border:1px solid var(--omp-border);background:var(--omp-surface-raised);color:var(--omp-text);
  font:inherit;cursor:pointer;text-decoration:none;transition:border-color .18s,box-shadow .18s;}
.oh-root .oh-btn:hover{border-color:var(--omp-accent-cyan);box-shadow:0 0 18px rgba(25,211,243,.2);}
.oh-root .oh-bigico{width:84px;height:84px;font-size:36px;}
@media (prefers-reduced-motion:reduce){.oh-root .oh-card,.oh-root .oh-cta{transition:none}.oh-root .oh-live{animation:none}}
`;

export class OperatorHome extends HTMLElement {
  #consoles: ConsoleEntry[] = [];
  #tiles: WorkTile[] = [];
  #tasks: Task[] = [];
  #errors: Record<string, string> = {};
  #dir: Directory | null = null;
  #loaded = false;
  #timer: number | undefined;
  #clockTimer: number | undefined;
  #user = "";

  setup(consoles: ConsoleEntry[], tiles: WorkTile[]) {
    this.#consoles = consoles;
    this.#tiles = tiles;
    this.#paint();
    void this.#load();
  }

  connectedCallback() {
    this.classList.add("oh-root");
    this.style.cssText = LANDING_BOX;
    this.#timer = window.setInterval(() => void this.#load(), REFRESH_MS);
    this.#clockTimer = window.setInterval(() => this.#tickClock(), 1000);
    void whoami().then((w) => {
      this.#user = w.username ?? "";
      this.#paint();
    }).catch(() => {});
  }

  disconnectedCallback() {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    if (this.#clockTimer !== undefined) window.clearInterval(this.#clockTimer);
  }

  #tickClock() {
    const c = this.querySelector<HTMLElement>("[data-role=clock]");
    if (!c) return;
    const now = new Date();
    const b = c.querySelector("b");
    const d = c.querySelector("span");
    if (b) b.textContent = now.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (d) d.textContent = now.toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" });
  }

  async #load() {
    if (this.#tiles.length === 0) return;
    const [r, dir] = await Promise.all([getMyTasks(), getDirectory()]);
    this.#dir = dir;
    if (r) {
      this.#tasks = sortTasks(r.tasks);
      this.#errors = r.errors;
    }
    this.#loaded = true;
    this.#paint();
  }

  #paint() {
    const wrap = el("div");
    wrap.className = "oh-wrap";
    const hero = el("div");
    hero.className = "oh-hero";
    hero.append(el("h1", "", t("op.home.title")));
    if (this.#user) {
      const hello = el("div", "", t("op.home.hello", { name: this.#user }));
      hello.className = "oh-hello";
      hero.append(hello);
    }
    const clock = el("div");
    clock.className = "oh-clock";
    clock.dataset.role = "clock";
    clock.append(el("b"), el("span"));
    hero.append(clock);
    wrap.append(hero, this.#workflowSection());
    if (this.#tiles.length > 0) {
      wrap.append(this.#toolSection(), this.#taskSection());
    }
    const style = el("style", "", HOME_CSS);
    this.replaceChildren(style, wrap);
    this.#tickClock();
  }

  #section(title: string, hint = ""): HTMLElement {
    const s = el("section");
    s.className = "oh-section";
    const h = el("h2", "", title);
    if (hint) h.append(el("small", "", hint));
    s.append(h);
    return s;
  }

  #workflowSection(): HTMLElement {
    const s = this.#section(t("op.home.workflows"));
    s.dataset.role = "workflows";
    const ids = [...new Set(this.#consoles.map((c) => c.workflowId))];
    if (ids.length === 0) {
      const empty = el("div");
      empty.className = "oh-wf-empty";
      empty.append(el("div", "font-size:30px;opacity:.7;", "⏳"), el("div", "", t("op.home.noWorkflow")));
      const up = document.createElement("omp-upcoming-start");
      up.style.color = "var(--omp-text)";
      empty.append(up);
      s.append(empty);
      return s;
    }
    const grid = el("div");
    grid.className = "oh-grid";
    for (const id of ids) {
      const entries = this.#consoles.filter((c) => c.workflowId === id);
      const a = el("a");
      a.className = "oh-card";
      a.href = `/console/${encodeURIComponent(id)}`;
      a.dataset.role = "workflow";
      const ico = el("div", "", "▣");
      ico.className = "oh-ico";
      const name = el("div", "", entries[0]?.workflowLabel ?? id);
      name.className = "oh-name";
      const meta = el("div");
      meta.className = "oh-meta";
      const live = el("span");
      live.className = "oh-live";
      meta.append(live, entries.length === 1 ? t("op.roles.one") : t("op.roles.many", { n: entries.length }));
      const cta = el("div", "", t("op.home.open") + " →");
      cta.className = "oh-cta";
      a.append(ico, name, meta, cta);
      grid.append(a);
    }
    s.append(grid);
    const up = document.createElement("omp-upcoming-start");
    up.style.color = "var(--omp-text)";
    s.append(up);
    return s;
  }

  #toolSection(): HTMLElement {
    const s = this.#section(t("op.home.tools"));
    s.dataset.role = "tools";
    const grid = el("div");
    grid.className = "oh-grid";
    for (const tile of this.#tiles) {
      const mine = tasksOf(this.#tasks, tile.module);
      const sum = summarize(mine);
      const a = el("a");
      a.className = "oh-card";
      a.href = tileHref(tile.id);
      a.dataset.role = "tile";
      a.dataset.tile = tile.id;
      const ico = el("div", "", iconFor(tile.module));
      ico.className = "oh-ico";
      const nm = el("div", "", tile.label);
      nm.className = "oh-name";
      a.append(ico, nm);
      const line = el("div");
      line.className = "oh-meta";
      if (!this.#loaded) line.append(el("span", "color:var(--omp-text-dim);", "…"));
      else if (mine.length === 0) line.append(el("span", "color:var(--omp-text-dim);", t("op.home.noTasksShort")));
      else {
        line.append(el("span", "color:var(--omp-text-dim);", t("op.home.taskCount", { n: mine.length })));
        if (sum.problems > 0) line.append(el("span", `color:${STATUS_COLOR.error};font-weight:600;`, t("op.home.problemCount", { n: sum.problems })));
      }
      const cta = el("div", "", t("op.home.open") + " →");
      cta.className = "oh-cta";
      a.append(line, cta);
      grid.append(a);
    }
    s.append(grid);
    return s;
  }

  #taskSection(): HTMLElement {
    const sum = summarize(this.#tasks);
    const s = this.#section(t("op.home.tasks"), this.#loaded ? t("op.home.taskSummary", { total: sum.total, mine: sum.mine, problems: sum.problems }) : "");
    s.dataset.role = "tasks";
    for (const [mod, msg] of Object.entries(this.#errors)) {
      s.append(el("div", "color:var(--omp-error);font-size:12px;text-align:center;", t("op.home.taskError", { module: mod, message: msg })));
    }
    if (this.#loaded && this.#tasks.length === 0) {
      const empty = el("div", "", "✓  " + t("op.home.noTasks"));
      empty.className = "oh-panel oh-empty";
      s.append(empty);
      return s;
    }
    const panel = el("div");
    panel.className = "oh-panel";
    const tb = el("table", "width:100%;border-collapse:collapse;font-size:13px;");
    const head = el("tr", "text-align:left;color:var(--omp-text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em;");
    for (const h of ["op.task.col.kind", "op.task.col.title", "op.task.col.state", "op.task.col.who", "op.task.col.due"]) head.append(el("th", "padding:4px 8px;font-weight:500;", t(h as never)));
    tb.append(head);
    const now = Date.now();
    const words = { in: t("op.due.in"), ago: t("op.due.ago") };
    for (const task of this.#tasks) {
      const tile = tileForTask(this.#tiles, task);
      const tr = el("tr", "border-top:1px solid var(--omp-border);" + (tile ? "cursor:pointer;" : ""));
      tr.dataset.role = "task";
      tr.dataset.task = task.id;
      if (tile) tr.addEventListener("click", () => (location.href = tileHref(tile.id, task.id)));
      tr.addEventListener("mouseenter", () => (tr.style.background = "var(--omp-surface-raised)"));
      tr.addEventListener("mouseleave", () => (tr.style.background = ""));
      const td = (child: string | HTMLElement, css = ""): HTMLElement => {
        const c = el("td", `padding:6px 8px;${css}`);
        if (typeof child === "string") c.textContent = child;
        else c.append(child);
        return c;
      };
      const dot = el("span", `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${STATUS_COLOR[task.status] ?? STATUS_COLOR.ok};`);
      const kind = el("span");
      const kindKey = KIND_KEYS[task.kind];
      kind.append(dot, kindKey ? t(kindKey) : task.kind);
      const name = el("div");
      name.append(el("div", "font-weight:600;", task.title));
      if (task.detail) name.append(el("div", "font-size:11px;color:var(--omp-text-dim);", task.detail));
      const state = el("div");
      const sk = stateKey(task.state);
      state.append(el("div", "", sk ? tLoose(sk) : task.state));
      const pk = problemKey(task.problemCode);
      const problem = pk ? tLoose(pk) : task.problem;
      if (problem) state.append(el("div", `font-size:11px;color:${STATUS_COLOR[task.status] ?? "inherit"};`, problem));
      const who = task.claimable
        ? t("op.task.claimable", { group: groupName(this.#dir, task.assigneeGroup ?? "") })
        : task.mine
          ? t("op.task.mine")
          : [task.assignee, task.assigneeGroup ? t("op.task.group", { group: groupName(this.#dir, task.assigneeGroup) }) : ""].filter(Boolean).join(" · ");
      const due = dueText(task.dueAt, now, words);
      tr.append(
        td(kind),
        td(name),
        td(state),
        td(who || "—", task.mine ? "font-weight:600;" : "color:var(--omp-text-dim);"),
        td(due || "—", task.overdue ? `color:${STATUS_COLOR.error};font-weight:600;` : "color:var(--omp-text-dim);"),
      );
      tb.append(tr);
    }
    panel.append(tb);
    s.append(panel);
    return s;
  }
}

if (!customElements.get("omp-operator-home")) customElements.define("omp-operator-home", OperatorHome);

/**
 * Kachel-Ansicht: schlanke Kopfzeile mit Rückweg zum Arbeitsplatz, darunter die Modul-Oberfläche vollflächig. `ref` (Aufgabe)
 * wird dem Element als Attribut `focus-ref` mitgegeben; Ansichten, die es kennen, öffnen den Gegenstand direkt.
 */
export async function renderTileView(root: HTMLElement, tile: WorkTile, ref: string | null): Promise<void> {
  const page = el("div", "display:flex;flex-direction:column;width:100%;height:100%;background:var(--omp-bg);color:var(--omp-text);font-family:var(--omp-font);");
  const bar = el("div", "display:flex;gap:12px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--omp-border);flex-shrink:0;");
  const back = el("a", "color:var(--omp-text);text-decoration:none;border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:3px 10px;font-size:var(--omp-font-size-sm);", "← " + t("op.home.back"));
  back.href = "/";
  back.dataset.role = "back-home";
  bar.append(back, el("b", "", tile.label));
  const body = el("div", "flex:1;min-height:0;position:relative;");
  page.append(bar, body);
  root.replaceChildren(page);
  const err = await ensureBundle(tile.bundle);
  if (err) {
    body.append(el("p", "color:var(--omp-error);padding:16px;", t("op.tile.failed", { label: tile.label })));
    return;
  }
  const view = document.createElement(tile.element);
  if (ref) view.setAttribute("focus-ref", ref);
  body.append(view);
}

/** Zeigt im Benutzer-Widget eine Warnung, solange Aufgaben Probleme haben (überfällig, fehlgeschlagen, QC-Fehler). */
export function attachTaskBadge(widget: HTMLElement, tiles: WorkTile[]): void {
  if (tiles.length === 0) return;
  const badge = el("a", "display:none;font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-2);text-decoration:none;border-radius:var(--omp-radius);border:1px solid var(--omp-error);color:var(--omp-error);font-weight:600;");
  badge.href = "/";
  badge.dataset.role = "task-badge";
  widget.insertBefore(badge, widget.children[1] ?? null);
  const poll = async () => {
    const r = await getMyTasks();
    if (!r) return;
    const s = summarize(r.tasks);
    if (s.problems > 0) {
      badge.style.display = "inline-block";
      badge.textContent = t("op.badge", { n: s.problems });
      badge.title = t("op.badge.title", { n: s.problems, overdue: s.overdue });
    } else badge.style.display = "none";
  };
  void poll();
  window.setInterval(() => void poll(), 30_000);
}

/**
 * Gemeinsamer Rahmen der Startseiten (Arbeitsplatz, „kein aktiver Workflow“, Workflow-Auswahl): zentriert, mit
 * Verlaufstitel, Symbol und Hintergrundglühen. `body` wird unter Titel/Text eingesetzt.
 */
export function renderLanding(root: HTMLElement, opts: { title: string; text?: string; icon?: string; body?: HTMLElement[]; role?: string }): HTMLElement {
  const page = el("div");
  page.className = "oh-root";
  page.style.cssText = LANDING_BOX;
  const center = el("div");
  center.className = "oh-center";
  if (opts.role) center.dataset.role = opts.role;
  if (opts.icon) {
    const ico = el("div", "", opts.icon);
    ico.className = "oh-ico oh-bigico";
    center.append(ico);
  }
  const hero = el("div");
  hero.className = "oh-hero";
  hero.style.padding = "0";
  hero.append(el("h1", "", opts.title));
  center.append(hero);
  if (opts.text) {
    const p = el("p", "", opts.text);
    p.className = "oh-text";
    center.append(p);
  }
  if (opts.body) center.append(...opts.body);
  page.append(el("style", "", HOME_CSS), center);
  root.replaceChildren(page);
  return center;
}

/** Karte (Workflow/Kachel) im Stil der Startseite. */
export function landingCard(href: string, icon: string, name: string, meta: string, live = false): HTMLAnchorElement {
  const a = el("a");
  a.className = "oh-card";
  a.href = href;
  const ico = el("div", "", icon);
  ico.className = "oh-ico";
  const nm = el("div", "", name);
  nm.className = "oh-name";
  const m = el("div");
  m.className = "oh-meta";
  if (live) {
    const dot = el("span");
    dot.className = "oh-live";
    m.append(dot);
  }
  m.append(meta);
  const cta = el("div", "", t("op.home.open") + " →");
  cta.className = "oh-cta";
  a.append(ico, nm, m, cta);
  return a;
}

export function landingGrid(): HTMLElement {
  const g = el("div");
  g.className = "oh-grid";
  return g;
}

export function landingButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "", label);
  b.className = "oh-btn";
  b.addEventListener("click", onClick);
  return b;
}
