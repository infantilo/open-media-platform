// Sortierung der Instanzen-Tabelle (reine Logik, ohne DOM — testbar).

export type InstanceSortKey = "label" | "status" | "host" | "cpu" | "ram" | "pid" | "restarts";
export type SortDir = "asc" | "desc";

export interface SortableInstance {
  id: string;
  label: string;
  pid: number;
  hostId?: string;
  crashed?: boolean;
  outdated?: boolean;
  restartCount?: number;
  cpuPercent?: number;
  rssBytes?: number;
}

/** Zahlenspalten starten absteigend (größte Last zuerst), Textspalten aufsteigend. */
export function defaultDir(key: InstanceSortKey): SortDir {
  return key === "cpu" || key === "ram" || key === "restarts" ? "desc" : "asc";
}

function statusRank(i: SortableInstance): number {
  return i.crashed ? 0 : i.outdated ? 1 : 2;
}

/**
 * Sortiert stabil nach `key`/`dir`. Fehlende Messwerte (cpu/ram noch nicht
 * erhoben) stehen immer am Ende, egal in welcher Richtung. Gleichstand →
 * Label, dann ID (die Server-Liste hat keine feste Reihenfolge).
 */
export function sortInstances<T extends SortableInstance>(
  list: readonly T[],
  key: InstanceSortKey,
  dir: SortDir,
  hostLabel: (i: T) => string = (i) => i.hostId ?? "lokal",
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const tie = (a: T, b: T) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id);
  const num = (v: number | undefined) => v;
  const value = (i: T): number | string | undefined => {
    switch (key) {
      case "label": return i.label.toLowerCase();
      case "status": return statusRank(i);
      case "host": return hostLabel(i).toLowerCase();
      case "cpu": return num(i.cpuPercent);
      case "ram": return num(i.rssBytes);
      case "pid": return i.pid;
      case "restarts": return i.restartCount ?? 0;
    }
  };
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === undefined && vb === undefined) return tie(a, b);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
    return c * sign || tie(a, b);
  });
}
