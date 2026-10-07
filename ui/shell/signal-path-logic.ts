// Reine Logik des "Signalweg"-Tabs (Nutzerauftrag 2026-10-07: "Quelle,
// Ziel, Node aussuchen und den gesamten Flow sehen"): Pfadsuche über die
// IST-Verbindungen aus GET /api/v1/graph (aktive IS-05-Kanten, kein
// Soll-Zustand aus Workflow-Definitionen) und Diagnose der Kette. Nur
// Anzeige — nichts hier schaltet etwas.
//
// Modell wie die Loop-Erkennung im Orchestrator (graph.buildNodeSignalGraph):
// innerhalb einer Node wird konservativ angenommen, dass jeder Ausgang aus
// jedem Eingang abgeleitet sein kann; der erste Hop ist dagegen portgenau
// (genau der gewählte Sender).

export interface GraphPort {
  id: string;
  label: string;
  format: string;
  transport?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  health: string;
  instanceId?: string;
}

export interface GraphEdge {
  id: string;
  fromSender: string;
  toReceiver: string;
  state: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Ein Schritt der Kette: Sender-Port einer Node → Receiver-Port der nächsten. */
export interface Hop {
  edge: GraphEdge;
  fromNode: GraphNode;
  toNode: GraphNode;
  sender: GraphPort;
  receiver: GraphPort;
}

export interface PathQuery {
  /** Sender-Port-ID der Quelle (portgenau). */
  fromSender: string;
  /** Ziel: ein bestimmter Receiver-Port ODER (toNodeId) irgendein Eingang der Node. */
  toReceiver?: string;
  toNodeId?: string;
  /** Optional: die Kette muss über diese Node laufen (auch Quelle/Ziel zählen). */
  viaNodeId?: string;
}

export const MAX_PATHS = 20;
export const MAX_HOPS = 12;

export interface PathResult {
  paths: Hop[][];
  /** true, wenn MAX_PATHS erreicht wurde und weitere Wege existieren könnten. */
  truncated: boolean;
}

interface Index {
  nodeByPort: Map<string, GraphNode>;
  portById: Map<string, GraphPort>;
  edgesFromNode: Map<string, GraphEdge[]>;
}

function buildIndex(g: GraphData): Index {
  const nodeByPort = new Map<string, GraphNode>();
  const portById = new Map<string, GraphPort>();
  for (const n of g.nodes) {
    for (const p of [...n.inputs, ...n.outputs]) {
      nodeByPort.set(p.id, n);
      portById.set(p.id, p);
    }
  }
  const edgesFromNode = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    const n = nodeByPort.get(e.fromSender);
    if (!n) continue;
    const list = edgesFromNode.get(n.id) ?? [];
    list.push(e);
    edgesFromNode.set(n.id, list);
  }
  return { nodeByPort, portById, edgesFromNode };
}

/** Findet alle einfachen Wege (keine Node doppelt) von der Quelle zum Ziel. */
export function findPaths(g: GraphData, q: PathQuery): PathResult {
  const idx = buildIndex(g);
  const start = idx.nodeByPort.get(q.fromSender);
  const result: PathResult = { paths: [], truncated: false };
  if (!start || (!q.toReceiver && !q.toNodeId)) return result;

  const toHop = (e: GraphEdge): Hop | null => {
    const fromNode = idx.nodeByPort.get(e.fromSender);
    const toNode = idx.nodeByPort.get(e.toReceiver);
    const sender = idx.portById.get(e.fromSender);
    const receiver = idx.portById.get(e.toReceiver);
    if (!fromNode || !toNode || !sender || !receiver) return null;
    return { edge: e, fromNode, toNode, sender, receiver };
  };
  const isTarget = (h: Hop) => q.toReceiver ? h.edge.toReceiver === q.toReceiver : h.toNode.id === q.toNodeId;
  const passesVia = (hops: Hop[]) =>
    !q.viaNodeId || start.id === q.viaNodeId || hops.some((h) => h.toNode.id === q.viaNodeId);

  const visited = new Set<string>([start.id]);
  const hops: Hop[] = [];
  const walk = (node: GraphNode) => {
    for (const e of idx.edgesFromNode.get(node.id) ?? []) {
      if (result.truncated) return;
      if (hops.length === 0 && e.fromSender !== q.fromSender) continue;
      const h = toHop(e);
      if (!h || visited.has(h.toNode.id)) continue;
      hops.push(h);
      if (isTarget(h)) {
        if (passesVia(hops)) {
          if (result.paths.length >= MAX_PATHS) result.truncated = true;
          else result.paths.push([...hops]);
        }
      } else if (hops.length < MAX_HOPS) {
        visited.add(h.toNode.id);
        walk(h.toNode);
        visited.delete(h.toNode.id);
      }
      hops.pop();
    }
  };
  walk(start);
  result.paths.sort((a, b) => a.length - b.length);
  return result;
}

export type IssueSeverity = "error" | "warn";

export interface Issue {
  severity: IssueSeverity;
  /** Position in der Kette: Node k = 2k, Link k (Hop k) = 2k+1. */
  position: number;
  text: string;
}

/** Zusatzwissen je Node (aus GET /api/v1/instances + /hosts), alles optional. */
export interface NodeContext {
  hostLabel?: string;
  hostKey?: string; // "" = lokaler Host, undefined = unbekannt
  crashed?: boolean;
}

const FORMAT_NAMES: Record<string, string> = {
  "urn:x-nmos:format:video": "Video",
  "urn:x-nmos:format:audio": "Audio",
  "urn:x-nmos:format:data": "Daten",
  "urn:x-nmos:format:mux": "Mux",
};

export function formatName(f: string): string {
  return FORMAT_NAMES[f] ?? (f.split(":").pop() || f);
}

export function transportName(t: string | undefined): string {
  if (!t) return "?";
  const last = t.split(":").pop() ?? t;
  return last === "mxl" ? "MXL" : last.toUpperCase();
}

/** Prüft die Kette von vorn nach hinten; Ergebnis ist nach Position sortiert. */
export function diagnosePath(path: Hop[], ctx: (nodeId: string) => NodeContext): Issue[] {
  const issues: Issue[] = [];
  const nodes = path.length ? [path[0].fromNode, ...path.map((h) => h.toNode)] : [];
  nodes.forEach((n, k) => {
    if (n.health !== "ok") issues.push({ severity: "error", position: 2 * k, text: `${n.label} ist offline` });
    if (ctx(n.id).crashed) issues.push({ severity: "error", position: 2 * k, text: `${n.label} ist abgestürzt` });
  });
  path.forEach((h, k) => {
    const pos = 2 * k + 1;
    if (h.sender.format !== h.receiver.format) {
      issues.push({
        severity: "error",
        position: pos,
        text: `Formate passen nicht: ${formatName(h.sender.format)} → ${formatName(h.receiver.format)}`,
      });
    }
    if (h.sender.transport && h.receiver.transport && h.sender.transport !== h.receiver.transport) {
      issues.push({
        severity: "warn",
        position: pos,
        text: `Transporte unterschiedlich: ${transportName(h.sender.transport)} → ${transportName(h.receiver.transport)}`,
      });
    }
    const a = ctx(h.fromNode.id).hostKey;
    const b = ctx(h.toNode.id).hostKey;
    if (h.sender.transport?.endsWith(":mxl") && a !== undefined && b !== undefined && a !== b) {
      issues.push({
        severity: "error",
        position: pos,
        text: "MXL ist host-lokal, Quelle und Ziel liegen auf verschiedenen Hosts (Gateway nötig)",
      });
    }
  });
  return issues.sort((x, y) => x.position - y.position || (x.severity === "error" ? -1 : 1));
}

/** Erste Fehlerstelle (Warnungen zählen nicht), sonst null. */
export function firstError(issues: Issue[]): Issue | null {
  return issues.find((i) => i.severity === "error") ?? null;
}

/** Auswahlliste für die Quelle: alle Sender-Ports mit Node-Label. */
export function senderOptions(g: GraphData): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const n of g.nodes) for (const p of n.outputs) out.push({ id: p.id, label: `${n.label} › ${p.label}` });
  return out.sort((a, b) => a.label.localeCompare(b.label, "de"));
}

/** Auswahlliste für das Ziel: "Node (jeder Eingang)" und je Receiver-Port. */
export function targetOptions(g: GraphData): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of g.nodes) {
    if (!n.inputs.length) continue;
    out.push({ value: `node:${n.id}`, label: `${n.label} (jeder Eingang)` });
    for (const p of n.inputs) out.push({ value: `rx:${p.id}`, label: `${n.label} › ${p.label}` });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "de"));
}

export function nodeOptions(g: GraphData): { id: string; label: string }[] {
  return g.nodes.map((n) => ({ id: n.id, label: n.label })).sort((a, b) => a.label.localeCompare(b.label, "de"));
}
