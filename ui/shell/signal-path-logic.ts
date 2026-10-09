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

import { getLang, t } from "./i18n.ts";

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
  /** Sender-Port-ID der Quelle (portgenau). Fehlt sie, werden alle Ketten gesucht, die am Ziel ankommen. */
  fromSender?: string;
  /**
   * Ziel: ein bestimmter Receiver-Port ODER (toNodeId) irgendein Eingang der Node. Fehlt das Ziel, werden alle Ketten
   * gesucht, die von der Quelle ausgehen (jede bis zu ihrem Ende).
   */
  toReceiver?: string;
  toNodeId?: string;
  /** Optional: die Kette muss über diese Node laufen (auch Quelle/Ziel zählen). */
  viaNodeId?: string;
}

/**
 * Nodes wie der Switcher haben keine NMOS-Receiver (sie finden ihre Quellen selbst über die Registry), also auch keine
 * IS-05-Kanten im Graph — die Kette bräche an ihnen ab. Aus dem Parameter `activeInput` (Sender-ID der gerade
 * geschalteten Quelle) wird je Node ein virtueller Eingang samt aktiver Kante ergänzt. `feeds`: Node-ID → Sender-ID.
 * Unbekannte oder selbstreferenzierende Sender werden ignoriert; der Graph selbst bleibt unverändert.
 */
export function withImplicitFeeds(g: GraphData, feeds: Map<string, string>): GraphData {
  if (!feeds.size) return g;
  const senders = new Map<string, GraphPort>();
  for (const n of g.nodes) for (const p of n.outputs) senders.set(p.id, p);
  const extraIn = new Map<string, GraphPort>();
  const edges = [...g.edges];
  for (const [nodeId, senderId] of feeds) {
    const node = g.nodes.find((n) => n.id === nodeId);
    const sender = senders.get(senderId);
    if (!node || !sender || node.outputs.some((o) => o.id === senderId)) continue;
    const port: GraphPort = {
      id: `implicit:${nodeId}`,
      label: t("sp.activeInput"),
      format: sender.format,
      transport: sender.transport,
    };
    extraIn.set(nodeId, port);
    edges.push({ id: `implicit:${nodeId}:${senderId}`, fromSender: senderId, toReceiver: port.id, state: "active" });
  }
  return {
    nodes: g.nodes.map((n) => (extraIn.has(n.id) ? { ...n, inputs: [...n.inputs, extraIn.get(n.id)!] } : n)),
    edges,
  };
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

/**
 * Findet alle einfachen Wege (keine Node doppelt). Sind Quelle UND Ziel gegeben: von der Quelle zum Ziel. Ist nur die
 * Quelle gegeben: alle Ketten, die von ihr ausgehen, jede bis zum letzten Glied (Node ohne weitere Verbindung). Ist nur
 * das Ziel gegeben: alle Ketten, die dort ankommen, jede zurück bis zu ihrem Ursprung (Node ohne eingehende Verbindung).
 * Ohne beides: leer.
 */
export function findPaths(g: GraphData, q: PathQuery): PathResult {
  const idx = buildIndex(g);
  const result: PathResult = { paths: [], truncated: false };
  const hasTarget = !!(q.toReceiver || q.toNodeId);
  if (!q.fromSender && !hasTarget) return result;

  const toHop = (e: GraphEdge): Hop | null => {
    const fromNode = idx.nodeByPort.get(e.fromSender);
    const toNode = idx.nodeByPort.get(e.toReceiver);
    const sender = idx.portById.get(e.fromSender);
    const receiver = idx.portById.get(e.toReceiver);
    if (!fromNode || !toNode || !sender || !receiver) return null;
    return { edge: e, fromNode, toNode, sender, receiver };
  };
  const hopsAll = g.edges.map(toHop).filter((h): h is Hop => h !== null);
  const isTarget = (h: Hop) => q.toReceiver ? h.edge.toReceiver === q.toReceiver : h.toNode.id === q.toNodeId;
  const passesVia = (hops: Hop[]) =>
    !q.viaNodeId || hops[0].fromNode.id === q.viaNodeId || hops.some((h) => h.toNode.id === q.viaNodeId);
  const push = (hops: Hop[]) => {
    if (!passesVia(hops)) return;
    if (result.paths.length >= MAX_PATHS) result.truncated = true;
    else result.paths.push([...hops]);
  };

  if (q.fromSender) {
    const start = idx.nodeByPort.get(q.fromSender);
    if (!start) return result;
    const visited = new Set<string>([start.id]);
    const hops: Hop[] = [];
    const walk = (node: GraphNode) => {
      let extended = false;
      for (const e of idx.edgesFromNode.get(node.id) ?? []) {
        if (result.truncated) return;
        if (hops.length === 0 && e.fromSender !== q.fromSender) continue;
        const h = toHop(e);
        if (!h || visited.has(h.toNode.id)) continue;
        extended = true;
        hops.push(h);
        if (hasTarget && isTarget(h)) {
          push(hops);
        } else if (hops.length < MAX_HOPS) {
          visited.add(h.toNode.id);
          walk(h.toNode);
          visited.delete(h.toNode.id);
        } else if (!hasTarget) {
          push(hops); // Kette länger als MAX_HOPS: bis hierher zeigen
        }
        hops.pop();
      }
      // Nur Quelle gegeben: eine Kette endet, wo es nicht weitergeht (und mindestens ein Glied hat).
      if (!hasTarget && !extended && hops.length > 0) push(hops);
    };
    walk(start);
  } else {
    // Nur Ziel: rückwärts von den Kanten ins Ziel bis zum Ursprung; Ausgabe in Fließrichtung.
    const into = new Map<string, Hop[]>();
    for (const h of hopsAll) into.set(h.toNode.id, [...(into.get(h.toNode.id) ?? []), h]);
    const targetNodes = new Set<string>();
    const first = hopsAll.filter(isTarget);
    for (const h of first) targetNodes.add(h.toNode.id);
    for (const startHop of first) {
      const visited = new Set<string>([startHop.toNode.id, startHop.fromNode.id]);
      const chain: Hop[] = [startHop]; // rückwärts: chain[0] ist das letzte Glied
      const walkBack = (node: GraphNode) => {
        let extended = false;
        for (const h of into.get(node.id) ?? []) {
          if (result.truncated) return;
          if (visited.has(h.fromNode.id)) continue;
          extended = true;
          chain.push(h);
          if (chain.length < MAX_HOPS) {
            visited.add(h.fromNode.id);
            walkBack(h.fromNode);
            visited.delete(h.fromNode.id);
          } else {
            push([...chain].reverse());
          }
          chain.pop();
        }
        if (!extended) push([...chain].reverse());
      };
      walkBack(startHop.fromNode);
    }
  }
  result.paths.sort((a, b) => a.length - b.length);
  return result;
}

/**
 * Schleife am Anfang der Kette: Speist eine Node der Kette (auch die letzte) den Anfang wieder ein, kommt hier kein
 * Signal aus einer echten Quelle — die Suche bricht an dieser Stelle nur wegen der Schleife ab. Liefert die Node, die
 * den Anfang der Kette speist, sonst null.
 */
export function loopFeeder(g: GraphData, path: Hop[]): GraphNode | null {
  if (!path.length) return null;
  const first = path[0].fromNode;
  const inChain = new Set(path.map((h) => h.toNode.id));
  const portNode = new Map<string, GraphNode>();
  for (const n of g.nodes) for (const p of [...n.inputs, ...n.outputs]) portNode.set(p.id, n);
  for (const e of g.edges) {
    if (portNode.get(e.toReceiver)?.id !== first.id) continue;
    const from = portNode.get(e.fromSender);
    if (from && inChain.has(from.id)) return from;
  }
  return null;
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
  /** Berechneter Netzbedarf der Node in Mbit/s (nur Nodes mit Netzverkehr, z. B. Gateways). */
  netRxMbps?: number;
  netTxMbps?: number;
  netEstimated?: boolean;
  /** Netzkarte des Hosts, auf dem die Node läuft. */
  hostNet?: { measured: boolean; linkMbps?: number; percent?: number; thresholdPercent: number };
}

export function formatMbps(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} Gbit/s` : `${v.toFixed(v >= 100 ? 0 : 1)} Mbit/s`;
}

/** Netzbedarf einer Node als Text, z. B. "Rx ~2,2 Gbit/s"; leer ohne Netzverkehr. */
export function netDemandText(c: NodeContext): string {
  const rx = c.netRxMbps ?? 0;
  const tx = c.netTxMbps ?? 0;
  if (rx <= 0 && tx <= 0) return "";
  const est = c.netEstimated ? "~" : "";
  return [rx > 0 ? `Rx ${est}${formatMbps(rx)}` : "", tx > 0 ? `Tx ${est}${formatMbps(tx)}` : ""].filter(Boolean).join(" / ");
}

/** Beschriftung der Verbindung zwischen zwei Nodes zum Thema Netz. */
export function linkNetNote(h: Hop, ctx: (nodeId: string) => NodeContext): string {
  const a = ctx(h.fromNode.id);
  const b = ctx(h.toNode.id);
  if (h.sender.transport?.endsWith(":mxl")) {
    return a.hostKey !== undefined && a.hostKey === b.hostKey ? t("sp.localLink") : "";
  }
  const demand = netDemandText({ netTxMbps: a.netTxMbps, netEstimated: a.netEstimated });
  return demand ? t("sp.netLink", { demand }) : "";
}

const FORMAT_KEYS = {
  "urn:x-nmos:format:video": "sp.format.video",
  "urn:x-nmos:format:audio": "sp.format.audio",
  "urn:x-nmos:format:data": "sp.format.data",
  "urn:x-nmos:format:mux": "sp.format.mux",
} as const;

export function formatName(f: string): string {
  const key = FORMAT_KEYS[f as keyof typeof FORMAT_KEYS];
  return key ? t(key) : (f.split(":").pop() || f);
}

export function transportName(t: string | undefined): string {
  if (!t) return "?";
  const last = t.split(":").pop() ?? t;
  return last === "mxl" ? "MXL" : last.toUpperCase();
}

/** Prüft die Kette von vorn nach hinten; Ergebnis ist nach Position sortiert. */
export function diagnosePath(path: Hop[], ctx: (nodeId: string) => NodeContext, loopFrom?: GraphNode | null): Issue[] {
  const issues: Issue[] = [];
  const nodes = path.length ? [path[0].fromNode, ...path.map((h) => h.toNode)] : [];
  if (loopFrom) issues.push({ severity: "error", position: 0, text: t("sp.issue.loop", { node: nodes[0].label, from: loopFrom.label }) });
  nodes.forEach((n, k) => {
    if (n.health !== "ok") issues.push({ severity: "error", position: 2 * k, text: t("sp.issue.offline", { node: n.label }) });
    if (ctx(n.id).crashed) issues.push({ severity: "error", position: 2 * k, text: t("sp.issue.crashed", { node: n.label }) });
  });
  nodes.forEach((n, k) => {
    const c = ctx(n.id);
    const rx = c.netRxMbps ?? 0;
    const tx = c.netTxMbps ?? 0;
    if (rx <= 0 && tx <= 0) return;
    const hn = c.hostNet;
    const host = c.hostLabel ?? "Host";
    if (!hn || !hn.measured || !hn.linkMbps) {
      issues.push({
        severity: "warn",
        position: 2 * k,
        text: t("sp.issue.netUnknownLink", { demand: netDemandText(c), host }),
      });
      return;
    }
    if (Math.max(rx, tx) > hn.linkMbps) {
      issues.push({
        severity: "error",
        position: 2 * k,
        text: t("sp.issue.netTooBig", { demand: netDemandText(c), host, link: formatMbps(hn.linkMbps) }),
      });
    } else if (hn.percent !== undefined && hn.percent >= hn.thresholdPercent) {
      issues.push({
        severity: "error",
        position: 2 * k,
        text: t("sp.issue.netOverThreshold", { host, percent: hn.percent.toFixed(0), threshold: hn.thresholdPercent }),
      });
    }
  });
  path.forEach((h, k) => {
    const pos = 2 * k + 1;
    if (h.sender.format !== h.receiver.format) {
      issues.push({
        severity: "error",
        position: pos,
        text: t("sp.issue.formatMismatch", { from: formatName(h.sender.format), to: formatName(h.receiver.format) }),
      });
    }
    if (h.sender.transport && h.receiver.transport && h.sender.transport !== h.receiver.transport) {
      issues.push({
        severity: "warn",
        position: pos,
        text: t("sp.issue.transportDiffers", { from: transportName(h.sender.transport), to: transportName(h.receiver.transport) }),
      });
    }
    const a = ctx(h.fromNode.id).hostKey;
    const b = ctx(h.toNode.id).hostKey;
    if (h.sender.transport?.endsWith(":mxl") && a !== undefined && b !== undefined && a !== b) {
      issues.push({
        severity: "error",
        position: pos,
        text: t("sp.issue.mxlAcrossHosts"),
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
  return out.sort((a, b) => a.label.localeCompare(b.label, getLang()));
}

/** Auswahlliste für das Ziel: "Node (jeder Eingang)" und je Receiver-Port. */
export function targetOptions(g: GraphData): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of g.nodes) {
    if (!n.inputs.length) continue;
    out.push({ value: `node:${n.id}`, label: t("sp.anyInput", { node: n.label }) });
    for (const p of n.inputs) out.push({ value: `rx:${p.id}`, label: `${n.label} › ${p.label}` });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, getLang()));
}

export function nodeOptions(g: GraphData): { id: string; label: string }[] {
  return g.nodes.map((n) => ({ id: n.id, label: n.label })).sort((a, b) => a.label.localeCompare(b.label, getLang()));
}
