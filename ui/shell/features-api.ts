// Abruf der Funktionsrechte und Aufgaben der angemeldeten Person (Kapitel 44).
import { apiFetch } from "./connection.ts";
import type { Directory, FeatureSet } from "../kit/features.ts";
import type { Task } from "./task-logic.ts";

const TTL_MS = 30_000;
let cached: { at: number; set: FeatureSet | null } | null = null;

/** Eigene Funktionsrechte (kurz gepuffert; `force` lädt neu). null = nicht abrufbar. */
export async function getMyFeatures(force = false): Promise<FeatureSet | null> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.set;
  let set: FeatureSet | null = null;
  try {
    const res = await apiFetch("/api/v1/me/features");
    if (res.ok) {
      const b = (await res.json()) as Partial<FeatureSet>;
      set = { all: !!b.all, patterns: Array.isArray(b.patterns) ? b.patterns : [], groups: Array.isArray(b.groups) ? b.groups : [] };
    }
  } catch {
    // Orchestrator kurz nicht erreichbar
  }
  cached = { at: Date.now(), set };
  return set;
}

export interface MyTasks {
  tasks: Task[];
  /** Module, die ihre Aufgaben nicht liefern konnten (Modulname → Meldung). */
  errors: Record<string, string>;
}

export async function getMyTasks(): Promise<MyTasks | null> {
  try {
    const res = await apiFetch("/api/v1/me/tasks");
    if (!res.ok) return null;
    const b = (await res.json()) as { tasks?: Task[]; errors?: Record<string, string> };
    return { tasks: b.tasks ?? [], errors: b.errors ?? {} };
  } catch {
    return null;
  }
}

let dirCache: { at: number; dir: Directory | null } | null = null;

/** Nutzer und Gruppen zum Auswählen von Verantwortlichen (kurz gepuffert). null = nicht erlaubt/abrufbar. */
export async function getDirectory(force = false): Promise<Directory | null> {
  if (!force && dirCache && Date.now() - dirCache.at < TTL_MS) return dirCache.dir;
  let dir: Directory | null = null;
  try {
    const res = await apiFetch("/api/v1/directory");
    if (res.ok) {
      const b = (await res.json()) as Partial<Directory>;
      dir = { users: b.users ?? [], groups: b.groups ?? [] };
    }
  } catch {
    // s. o.
  }
  dirCache = { at: Date.now(), dir };
  return dir;
}
