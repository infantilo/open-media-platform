// Reine Logik des Rechte-Editors (permissions-editor.ts): Bereiche
// ("Wo?") aus Nodes/Workflows/Prozessen aufbauen, Bindungen darauf
// abbilden, durchsuchen und gruppieren, Änderungen als "setzen" (ein Recht
// je Subjekt+Bereich) planen. Kein DOM, kein Netz — deshalb testbar.

export type Verb = "view" | "operate" | "configure" | "admin";
export const VERBS: Verb[] = ["view", "operate", "configure", "admin"];

export interface Binding {
  id: string;
  subject: string;
  subjectType: "user" | "group";
  workflowId?: string;
  nodeId: string;
  verb: string;
}

// "process:<id>" in workflowId kennzeichnet eine Prozess-Bindung (Server:
// httpapi.ProcessScopePrefix).
export const PROCESS_PREFIX = "process:";

export type ScopeKind = "global" | "workflow" | "role" | "node" | "process";
export const SCOPE_KINDS: ScopeKind[] = ["global", "workflow", "role", "node", "process"];

export interface ResourceOption {
  key: string;
  kind: ScopeKind;
  workflowId: string;
  nodeId: string;
  title: string;
  subtitle: string;
  // Kleingeschriebener Suchtext (Titel, Untertitel, IDs).
  search: string;
  // true = in der Bindung referenziert, aber nicht (mehr) vorhanden.
  missing?: boolean;
}

export interface NodeLike {
  id: string;
  label: string;
  instanceId?: string;
}
export interface WorkflowLike {
  id: string;
  name: string;
  definition: { roles: { name: string; nodeType: string }[] };
}
export interface ProcessLike {
  id: string;
  name: string;
  category?: string;
}

export function scopeKey(workflowId: string | undefined, nodeId: string): string {
  return `${workflowId ?? ""}::${nodeId}`;
}

export function scopeKindOf(workflowId: string | undefined, nodeId: string): ScopeKind {
  const wf = workflowId ?? "";
  if (wf === "") return nodeId === "*" ? "global" : "node";
  if (wf.startsWith(PROCESS_PREFIX)) return "process";
  return nodeId === "*" ? "workflow" : "role";
}

function opt(kind: ScopeKind, workflowId: string, nodeId: string, title: string, subtitle: string, extra = ""): ResourceOption {
  return {
    key: scopeKey(workflowId, nodeId),
    kind,
    workflowId,
    nodeId,
    title,
    subtitle,
    search: `${title} ${subtitle} ${extra}`.toLowerCase(),
  };
}

export interface ScopeLabels {
  global: string; // "Alles (global)"
  wholeWorkflow: string; // "ganzer Workflow"
  allProcesses: string;
}

// Alle wählbaren Bereiche. Reihenfolge: global, Workflows (ganz, dann
// Rollen), Nodes, Prozesse — je Art alphabetisch.
export function buildResourceOptions(
  nodes: NodeLike[],
  workflows: WorkflowLike[],
  processes: ProcessLike[],
  labels: ScopeLabels,
): ResourceOption[] {
  const out: ResourceOption[] = [opt("global", "", "*", labels.global, "")];
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  for (const wf of workflows.slice().sort(byName)) {
    out.push(opt("workflow", wf.id, "*", wf.name, labels.wholeWorkflow, wf.id));
    for (const r of wf.definition.roles.slice().sort(byName)) {
      out.push(opt("role", wf.id, r.name, `${wf.name} → ${r.name}`, r.nodeType, wf.id));
    }
  }
  const seen = new Set<string>();
  for (const n of nodes.slice().sort((a, b) => a.label.localeCompare(b.label))) {
    const id = n.instanceId || n.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(opt("node", "", id, n.label, id, n.id));
  }
  for (const p of processes.slice().sort(byName)) {
    out.push(opt("process", PROCESS_PREFIX + p.id, "*", p.name, p.category ?? "", p.id));
  }
  return out;
}

// Bereich einer Bindung; unbekannte (gelöschte) Bereiche werden als
// "missing" mit lesbarem Notbehelfs-Titel geliefert statt zu fehlen.
export function resourceOf(b: Pick<Binding, "workflowId" | "nodeId">, options: ResourceOption[]): ResourceOption {
  const key = scopeKey(b.workflowId, b.nodeId);
  const hit = options.find((o) => o.key === key);
  if (hit) return hit;
  const wf = b.workflowId ?? "";
  const kind = scopeKindOf(wf, b.nodeId);
  const raw = wf.startsWith(PROCESS_PREFIX) ? wf.slice(PROCESS_PREFIX.length) : wf;
  const title = kind === "node" ? b.nodeId : kind === "role" ? `${raw} → ${b.nodeId}` : raw || b.nodeId;
  return { ...opt(kind, wf, b.nodeId, title, "", raw), missing: true };
}

// Alle Wörter der Suche müssen vorkommen (Reihenfolge egal).
export function matchesQuery(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
}

export interface SubjectRef {
  type: "user" | "group";
  id: string; // Nutzername bzw. Gruppen-ID
}

export function subjectKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function verbRank(v: string): number {
  return VERBS.indexOf(v as Verb);
}

// "Setzen": pro Subjekt und Bereich gilt genau ein Recht. Liefert die zu
// löschenden Bindungs-IDs und ob eine neue angelegt werden muss. Gleiches
// Recht schon vorhanden → nichts zu tun.
export function planSet(
  existing: Binding[],
  subject: SubjectRef,
  workflowId: string,
  nodeId: string,
  verb: Verb,
): { deleteIds: string[]; create: boolean } {
  const same = existing.filter(
    (b) => b.subjectType === subject.type && b.subject === subject.id && scopeKey(b.workflowId, b.nodeId) === scopeKey(workflowId, nodeId),
  );
  if (same.length === 1 && same[0].verb === verb) return { deleteIds: [], create: false };
  return { deleteIds: same.map((b) => b.id), create: true };
}

// Bindungen eines Subjekts, nach Bereichsart und Titel sortiert.
export function bindingsOfSubject(all: Binding[], subject: SubjectRef): Binding[] {
  return all.filter((b) => b.subjectType === subject.type && b.subject === subject.id);
}

export function bindingsOfResource(all: Binding[], workflowId: string, nodeId: string): Binding[] {
  const k = scopeKey(workflowId, nodeId);
  return all.filter((b) => scopeKey(b.workflowId, b.nodeId) === k);
}

export function sortByScope<T extends { kind: ScopeKind; title: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => SCOPE_KINDS.indexOf(a.kind) - SCOPE_KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
}
