// Reine Logik der Aufgabenliste des Arbeitsplatzes (Kapitel 44): Aufgaben aus allen Modulen (GET /api/v1/me/tasks).

export interface Task {
  id: string;
  module: string;
  kind: string; // "qc" | "recording" | "approval"
  title: string;
  detail?: string;
  state: string;
  status: "ok" | "warn" | "error" | "active";
  assignee?: string;
  assigneeGroup?: string;
  mine: boolean;
  claimable?: boolean;
  dueAt?: string;
  overdue?: boolean;
  problem?: string;
  /** Stabiler Schlüssel des Problems (übersetzbar), s. `problemText`. */
  problemCode?: string;
  action: { tab: string; ref?: string };
}

export interface TaskSummary {
  total: number;
  mine: number;
  problems: number;
  overdue: number;
  claimable: number;
}

export function summarize(tasks: Task[]): TaskSummary {
  const s: TaskSummary = { total: tasks.length, mine: 0, problems: 0, overdue: 0, claimable: 0 };
  for (const t of tasks) {
    if (t.mine) s.mine++;
    if (t.status === "error" || t.status === "warn" || t.overdue) s.problems++;
    if (t.overdue) s.overdue++;
    if (t.claimable) s.claimable++;
  }
  return s;
}

const STATUS_RANK: Record<string, number> = { error: 0, warn: 1, active: 2, ok: 3 };

/** Dringendes zuerst: Fehler/überfällig, dann nach Frist (ohne Frist ans Ende), dann Titel. */
export function sortTasks(tasks: Task[]): Task[] {
  const due = (t: Task) => (t.dueAt ? Date.parse(t.dueAt) : Infinity);
  return [...tasks].sort((a, b) => {
    const ra = a.overdue ? -1 : (STATUS_RANK[a.status] ?? 9);
    const rb = b.overdue ? -1 : (STATUS_RANK[b.status] ?? 9);
    if (ra !== rb) return ra - rb;
    if (due(a) !== due(b)) return due(a) - due(b);
    return a.title.localeCompare(b.title);
  });
}

/** Aufgaben eines Moduls (für die Zahl an der Kachel). */
export function tasksOf(tasks: Task[], module: string): Task[] {
  return tasks.filter((t) => t.module === module);
}

/** Relative Frist: „in 2 h“, „seit 15 min überfällig“; leer ohne Frist. Texte kommen aus `words` (i18n). */
export function dueText(dueAt: string | undefined, nowMs: number, words: { in: string; ago: string }): string {
  if (!dueAt) return "";
  const at = Date.parse(dueAt);
  if (!Number.isFinite(at)) return "";
  const diff = at - nowMs;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  let span: string;
  if (min < 1) span = "<1 min";
  else if (min < 60) span = `${min} min`;
  else if (min < 48 * 60) span = `${Math.round(min / 60)} h`;
  else span = `${Math.round(min / 1440)} d`;
  return (diff >= 0 ? words.in : words.ago).replace("{span}", span);
}

const PROBLEM_CODES = ["overdue", "failed", "not_admitted", "waiting_resources", "qc_not_run", "qc_failed", "rejected"];
const STATES = [
  "awaiting_qc", "qc_running", "qc_failed_to_run", "awaiting_review", "in_review", "conforming", "ready_for_approval", "approved", "rejected", "archived",
  "scheduled", "blocked", "waiting_for_resources", "starting", "recording", "finalizing", "processing", "completed", "failed", "cancelled",
];

/** Übersetzungsschlüssel des Problems (`op.problem.<code>`) oder undefined (dann gilt der Klartext der Aufgabe). */
export function problemKey(code: string | undefined): string | undefined {
  return code && PROBLEM_CODES.includes(code) ? `op.problem.${code}` : undefined;
}

/** Übersetzungsschlüssel des Zustands (`op.state.<zustand>`) oder undefined bei unbekanntem Zustand. */
export function stateKey(state: string): string | undefined {
  return STATES.includes(state) ? `op.state.${state}` : undefined;
}
