import { t } from "../shell/i18n.ts";
// Reine View-Model-Logik des hierarchischen Source-Selectors
// (<omp-source-selector>, ui/kit/omp-source-selector.ts) — kein DOM, kein
// fetch, damit sie mit `deno test` prüfbar ist und der Selector selbst
// nur noch darstellt.
//
// Schichten (siehe docs/decisions.md, Eintrag "Source-Selector"):
//   NMOS/Orchestrator-Daten → Adapter (source-catalog.ts) → SourceEntry[]
//   → buildSourceTree (Workflow → Node → Natural Group) → Selector-UI.
//
// Auswahl-Wert bleibt die unveränderte Sender-ID (IS-04-Sender), also
// exakt das, was die bisherigen <select>-Dropdowns speicherten — keine
// Persistenz-Migration nötig.

export type MediaType = "video" | "audio" | "data";

/** visible=false → gar nicht anzeigen; selectable=false → sichtbar, aber nicht wählbar. */
export interface SourceAccess {
  visible: boolean;
  selectable: boolean;
}

/** Eine auswählbare Quelle. Alle Felder außer id/label sind optional (alte Quellen ohne Metadaten). */
export interface SourceEntry {
  id: string;
  label: string;
  mediaType?: MediaType;
  workflowId?: string;
  workflowName?: string;
  nodeId?: string;
  nodeName?: string;
  /** Roher NMOS-`grouphint`-Tag-Wert ("<gruppe>:<rolle>[:<scope>]"). */
  groupHint?: string;
  access?: SourceAccess;
}

export interface ParsedGroupHint {
  group: string;
  role: string;
  scope?: string;
}

/**
 * Parst `urn:x-nmos:tag:grouphint/v1.0` ("<group>:<role>[:<scope>]", AMWA
 * NMOS Parameter Registers). Unvollständige Werte (leere Gruppe/Rolle,
 * kein Doppelpunkt) → null: dann keine Natural Group, kein Raten.
 */
export function parseGroupHint(value: string | undefined | null): ParsedGroupHint | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length < 2) return null;
  const group = parts[0].trim();
  const role = parts[1].trim();
  if (!group || !role) return null;
  const scope = parts[2]?.trim();
  return scope ? { group, role, scope } : { group, role };
}

export const DEFAULT_ACCESS: SourceAccess = { visible: true, selectable: true };

/** Wendet eine optionale Policy an (entry.access hat Vorrang) und entfernt unsichtbare Quellen. */
export function applyAccess(
  entries: SourceEntry[],
  policy?: (entry: SourceEntry) => Partial<SourceAccess> | undefined,
): (SourceEntry & { access: SourceAccess })[] {
  const out: (SourceEntry & { access: SourceAccess })[] = [];
  for (const e of entries) {
    const fromPolicy = policy?.(e);
    const access: SourceAccess = { ...DEFAULT_ACCESS, ...fromPolicy, ...e.access };
    if (!access.visible) continue;
    out.push({ ...e, access });
  }
  return out;
}

export type SectionKind = "current" | "other" | "unassigned";

export type SourceTreeNode = SourceGroupNode | SourceLeafNode;

export interface SourceGroupNode {
  type: "group";
  /** Stabile ID (für Auf-/Zuklapp-Zustand), eindeutig im ganzen Baum. */
  id: string;
  label: string;
  level: "section" | "workflow" | "node" | "natural";
  children: SourceTreeNode[];
  /** Standardmäßig geöffnet (aktueller Workflow); Rest zu. */
  defaultOpen: boolean;
}

export interface SourceLeafNode {
  type: "source";
  id: string; // Sender-ID
  label: string;
  entry: SourceEntry;
  selectable: boolean;
  /** Natural-Group-Rolle (z. B. "high"), falls aus grouphint bekannt. */
  role?: string;
}

export interface BuildOptions {
  /** Workflow des Nodes, in dem der Selector sitzt (fehlt → keine "Current"-Sektion). */
  currentWorkflowId?: string | null;
  /** Akzeptierte Medientypen; leer/fehlt = alle. Filter nur über mediaType, nie über Namen. */
  accepts?: MediaType[];
  /** grouphint-Rollen, die ausgeblendet werden (z. B. ["low"] für Lowres-Begleiter). */
  excludeRoles?: string[];
}

/**
 * Der Launcher hängt an Standard-Labels die Instanz-Kurz-ID an ("Source (3f2a1b9c)").
 * Für den Operator ist sie nebensächlich → in der Anzeige weglassen (Tooltip/Suche
 * behalten das volle Label). Nur ein genau 8-stelliges Hex-Token in Klammern.
 */
export function stripInstanceId(s: string): string {
  return s.replace(/\s*\([0-9a-f]{8}\)/g, "");
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

function leaf(e: SourceEntry & { access: SourceAccess }, role?: string): SourceLeafNode {
  return { type: "source", id: e.id, label: stripInstanceId(e.label), entry: e, selectable: e.access.selectable, role };
}

/**
 * Gruppiert die Quellen eines Nodes nach Natural Group. Nur Gruppen mit
 * ≥2 Mitgliedern werden zu einem Gruppenknoten — ein einzelner Sender mit
 * grouphint bleibt ein normales Blatt. Verschiedene Gruppennamen werden
 * nie zusammengefasst; Mitglieder ohne (gültigen) grouphint bleiben Blätter.
 */
function nodeChildren(
  idPrefix: string,
  nodeName: string | undefined,
  members: (SourceEntry & { access: SourceAccess })[],
): SourceTreeNode[] {
  const byGroup = new Map<string, (SourceEntry & { access: SourceAccess })[]>();
  const order: (string | SourceLeafNode)[] = [];
  for (const m of members) {
    const gh = parseGroupHint(m.groupHint);
    if (!gh) {
      order.push(leaf(m));
      continue;
    }
    // Scope "global" gilt node-übergreifend, sonst ist der Gruppenname nur je Node eindeutig.
    const key = gh.scope === "global" ? `g:${gh.group}` : `n:${m.nodeId ?? ""}:${gh.group}`;
    let list = byGroup.get(key);
    if (!list) {
      list = [];
      byGroup.set(key, list);
      order.push(key);
    }
    list.push(m);
  }
  const out: SourceTreeNode[] = [];
  for (const item of order) {
    if (typeof item !== "string") {
      out.push(item);
      continue;
    }
    const list = byGroup.get(item)!;
    if (list.length < 2) {
      out.push(leaf(list[0], parseGroupHint(list[0].groupHint)?.role));
      continue;
    }
    const gh = parseGroupHint(list[0].groupHint)!;
    // Gruppenname ist bei OMP-eigenen Quellen eine Flow-UUID → nodeName bevorzugen.
    const label = stripInstanceId(nodeName || gh.group);
    const children = list
      .map((m) => leaf(m, parseGroupHint(m.groupHint)?.role))
      .sort(mediaOrder);
    out.push({ type: "group", id: `${idPrefix}/ng:${item}`, label, level: "natural", children, defaultOpen: true });
  }
  return out;
}

const MEDIA_RANK: Record<string, number> = { video: 0, audio: 1, data: 2 };
function mediaOrder(a: SourceLeafNode, b: SourceLeafNode): number {
  const ra = MEDIA_RANK[a.entry.mediaType ?? ""] ?? 3;
  const rb = MEDIA_RANK[b.entry.mediaType ?? ""] ?? 3;
  return ra - rb || a.label.localeCompare(b.label);
}

function nodeGroups(
  idPrefix: string,
  entries: (SourceEntry & { access: SourceAccess })[],
  open: boolean,
): SourceTreeNode[] {
  const byNode = new Map<string, (SourceEntry & { access: SourceAccess })[]>();
  const loose: (SourceEntry & { access: SourceAccess })[] = [];
  for (const e of entries) {
    if (e.nodeId) {
      const l = byNode.get(e.nodeId);
      if (l) l.push(e);
      else byNode.set(e.nodeId, [e]);
    } else loose.push(e);
  }
  const nodes: SourceGroupNode[] = [];
  // Gleichnamige Nodes (ohne Kurz-ID nicht unterscheidbar) behalten sie.
  const shortCount = new Map<string, number>();
  for (const members of byNode.values()) {
    const n = stripInstanceId(members[0].nodeName || "");
    shortCount.set(n, (shortCount.get(n) ?? 0) + 1);
  }
  for (const [nodeId, members] of byNode) {
    const rawName = members[0].nodeName || nodeId;
    const short = stripInstanceId(rawName);
    const nodeName = (shortCount.get(short) ?? 0) > 1 ? rawName : short;
    const id = `${idPrefix}/n:${nodeId}`;
    nodes.push({
      type: "group",
      id,
      label: nodeName,
      level: "node",
      children: nodeChildren(id, members[0].nodeName, members),
      defaultOpen: open,
    });
  }
  nodes.sort(byLabel);
  return [...nodes, ...loose.map((e) => leaf(e, parseGroupHint(e.groupHint)?.role)).sort(byLabel)];
}

/** Baut den Anzeigebaum: Current workflow → Other workflows → Other / unassigned. */
export function buildSourceTree(entries: SourceEntry[], opts: BuildOptions = {}, policy?: Parameters<typeof applyAccess>[1]): SourceGroupNode[] {
  const accepts = opts.accepts && opts.accepts.length > 0 ? new Set(opts.accepts) : null;
  const excluded = new Set(opts.excludeRoles ?? []);
  const visible = applyAccess(entries, policy).filter((e) => {
    if (accepts && !(e.mediaType && accepts.has(e.mediaType))) return false;
    const role = parseGroupHint(e.groupHint)?.role;
    return !(role && excluded.has(role));
  });

  const current: typeof visible = [];
  const otherByWf = new Map<string, typeof visible>();
  const unassigned: typeof visible = [];
  for (const e of visible) {
    if (!e.workflowId) unassigned.push(e);
    else if (opts.currentWorkflowId && e.workflowId === opts.currentWorkflowId) current.push(e);
    else {
      const l = otherByWf.get(e.workflowId);
      if (l) l.push(e);
      else otherByWf.set(e.workflowId, [e]);
    }
  }

  const sections: SourceGroupNode[] = [];
  if (current.length > 0) {
    sections.push({
      type: "group",
      id: "sec:current",
      label: t("kit.currentWorkflow"),
      level: "section",
      children: nodeGroups("sec:current", current, true),
      defaultOpen: true,
    });
  }
  if (otherByWf.size > 0) {
    const wfs: SourceGroupNode[] = [];
    for (const [wfId, members] of otherByWf) {
      const id = `sec:other/wf:${wfId}`;
      wfs.push({
        type: "group",
        id,
        label: members[0].workflowName || wfId,
        level: "workflow",
        children: nodeGroups(id, members, false),
        defaultOpen: false,
      });
    }
    wfs.sort(byLabel);
    sections.push({ type: "group", id: "sec:other", label: t("kit.otherWorkflows"), level: "section", children: wfs, defaultOpen: current.length === 0 });
  }
  if (unassigned.length > 0) {
    // Einzige Sektion (keine Workflow-Zuordnung vorhanden): auch die Node-Gruppen offen,
    // sonst wären zwei Klicks bis zur Quelle nötig.
    const only = current.length === 0 && otherByWf.size === 0;
    sections.push({
      type: "group",
      id: "sec:unassigned",
      label: t("kit.otherUnassigned"),
      level: "section",
      children: nodeGroups("sec:unassigned", unassigned, only),
      defaultOpen: only,
    });
  }
  return sections;
}

/** Findet den Pfad (Gruppen-IDs) zum Blatt mit `sourceId`, um Vorfahren beim Öffnen aufzuklappen. */
export function pathToSource(tree: SourceTreeNode[], sourceId: string): string[] | null {
  for (const n of tree) {
    if (n.type === "source") {
      if (n.id === sourceId) return [];
    } else {
      const sub = pathToSource(n.children, sourceId);
      if (sub) return [n.id, ...sub];
    }
  }
  return null;
}

export function findLeaf(tree: SourceTreeNode[], sourceId: string): SourceLeafNode | null {
  for (const n of tree) {
    if (n.type === "source") {
      if (n.id === sourceId) return n;
    } else {
      const sub = findLeaf(n.children, sourceId);
      if (sub) return sub;
    }
  }
  return null;
}

/**
 * Suche: behält Blätter, deren Label/Node/Workflow/Gruppe den Suchtext
 * (case-insensitiv, alle Wörter) enthalten, sowie ganze Gruppen, deren
 * eigenes Label passt. Leere Zweige werden entfernt.
 */
export function filterTree(tree: SourceGroupNode[], query: string): SourceGroupNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tree;
  const matches = (hay: string) => words.every((w) => hay.includes(w));
  const walk = (nodes: SourceTreeNode[], ctx: string): SourceTreeNode[] => {
    const out: SourceTreeNode[] = [];
    for (const n of nodes) {
      if (n.type === "source") {
        const e = n.entry;
        const hay = `${n.label} ${e.nodeName ?? ""} ${e.workflowName ?? ""} ${e.mediaType ?? ""} ${n.role ?? ""} ${ctx}`.toLowerCase();
        if (matches(hay)) out.push(n);
      } else {
        const ownCtx = `${ctx} ${n.label}`;
        const kids = walk(n.children, ownCtx);
        if (kids.length > 0) out.push({ ...n, children: kids });
      }
    }
    return out;
  };
  return walk(tree, "") as SourceGroupNode[];
}

export interface VisibleRow {
  node: SourceTreeNode;
  depth: number;
}

/** Flache Zeilenliste der aktuell sichtbaren (aufgeklappten) Knoten — für Rendering und Tastaturnavigation. */
export function visibleRows(tree: SourceTreeNode[], isOpen: (g: SourceGroupNode) => boolean): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: SourceTreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.type === "group" && isOpen(n)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}
