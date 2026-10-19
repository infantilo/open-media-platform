// Arbeitsplatz-Startseite eines Operators (Kapitel 44): Workflows zum Wechseln bzw. Countdown bis zum nächsten Start,
// darunter die Aufgabenliste (zugewiesene QC-Dateien, eigene Aufnahmen) und die Kacheln der Module, für die die Person
// Funktionsrechte hat. Kachel-Ansicht (`/?tile=<modul>:<kachel>`): dieselbe Modul-Oberfläche wie der Engineering-Tab, der
// Server beschränkt den Inhalt auf das, was die Person sehen und tun darf.
import { getLang, t } from "./i18n.ts";
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

export class OperatorHome extends HTMLElement {
  #consoles: ConsoleEntry[] = [];
  #tiles: WorkTile[] = [];
  #tasks: Task[] = [];
  #errors: Record<string, string> = {};
  #dir: Directory | null = null;
  #loaded = false;
  #timer: number | undefined;

  setup(consoles: ConsoleEntry[], tiles: WorkTile[]) {
    this.#consoles = consoles;
    this.#tiles = tiles;
    this.#paint();
    void this.#load();
  }

  connectedCallback() {
    this.style.cssText =
      "display:block;box-sizing:border-box;width:100%;height:100%;overflow-y:auto;padding:var(--omp-space-4,20px) var(--omp-space-4,24px) 64px;" +
      "background:var(--omp-bg);color:var(--omp-text);font-family:var(--omp-font);";
    this.#timer = window.setInterval(() => void this.#load(), REFRESH_MS);
  }

  disconnectedCallback() {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
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
    const wrap = el("div", "max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:var(--omp-space-4,20px);");
    wrap.append(el("h1", "font-size:20px;font-weight:600;margin:0;", t("op.home.title")));
    wrap.append(this.#workflowSection());
    if (this.#tiles.length > 0) {
      wrap.append(this.#toolSection(), this.#taskSection());
    }
    this.replaceChildren(wrap);
  }

  #section(title: string, hint = ""): HTMLElement {
    const s = el("section", "display:flex;flex-direction:column;gap:8px;");
    const h = el("div", "display:flex;gap:10px;align-items:baseline;");
    h.append(el("h2", "font-size:14px;font-weight:600;margin:0;text-transform:uppercase;letter-spacing:.04em;color:var(--omp-text-dim);", title));
    if (hint) h.append(el("span", "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);", hint));
    s.append(h);
    return s;
  }

  #workflowSection(): HTMLElement {
    const s = this.#section(t("op.home.workflows"));
    s.dataset.role = "workflows";
    const ids = [...new Set(this.#consoles.map((c) => c.workflowId))];
    if (ids.length === 0) {
      s.append(el("div", "color:var(--omp-text-dim);", t("op.home.noWorkflow")));
      const up = document.createElement("omp-upcoming-start");
      up.style.color = "var(--omp-text)";
      s.append(up);
      return s;
    }
    const grid = el("div", "display:flex;gap:12px;flex-wrap:wrap;");
    for (const id of ids) {
      const entries = this.#consoles.filter((c) => c.workflowId === id);
      const a = el(
        "a",
        "display:block;padding:16px 24px;border:1px solid var(--omp-border);border-radius:8px;background:var(--omp-surface);" +
          "color:var(--omp-text);text-decoration:none;min-width:180px;text-align:center;",
      );
      a.href = `/console/${encodeURIComponent(id)}`;
      a.dataset.role = "workflow";
      a.append(
        el("div", "font-size:16px;font-weight:600;margin-bottom:4px;", entries[0]?.workflowLabel ?? id),
        el("div", "font-size:12px;color:var(--omp-text-dim);", entries.length === 1 ? t("op.roles.one") : t("op.roles.many", { n: entries.length })),
      );
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
    const grid = el("div", "display:flex;gap:12px;flex-wrap:wrap;");
    for (const tile of this.#tiles) {
      const mine = tasksOf(this.#tasks, tile.module);
      const sum = summarize(mine);
      const a = el(
        "a",
        "display:block;padding:16px 24px;border:1px solid var(--omp-border);border-radius:8px;background:var(--omp-surface);" +
          "color:var(--omp-text);text-decoration:none;min-width:200px;",
      );
      a.href = tileHref(tile.id);
      a.dataset.role = "tile";
      a.dataset.tile = tile.id;
      a.append(el("div", "font-size:16px;font-weight:600;margin-bottom:6px;", tile.label));
      const line = el("div", "font-size:12px;display:flex;gap:10px;");
      if (!this.#loaded) line.append(el("span", "color:var(--omp-text-dim);", "…"));
      else if (mine.length === 0) line.append(el("span", "color:var(--omp-text-dim);", t("op.home.noTasksShort")));
      else {
        line.append(el("span", "color:var(--omp-text-dim);", t("op.home.taskCount", { n: mine.length })));
        if (sum.problems > 0) line.append(el("span", `color:${STATUS_COLOR.error};font-weight:600;`, t("op.home.problemCount", { n: sum.problems })));
      }
      a.append(line);
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
      s.append(el("div", "color:var(--omp-error);font-size:12px;", t("op.home.taskError", { module: mod, message: msg })));
    }
    if (this.#loaded && this.#tasks.length === 0) {
      s.append(el("div", "color:var(--omp-text-dim);padding:8px 0;", t("op.home.noTasks")));
      return s;
    }
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
    s.append(tb);
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
