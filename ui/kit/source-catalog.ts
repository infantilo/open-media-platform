// Adapter: Orchestrator-Daten → SourceEntry[] für <omp-source-selector>.
// Bewusst getrennt vom Selector-Element (das ruft nie selbst das Netz an).
// Quellen: GET /api/v1/graph (Sender je Node inkl. Format + `groupHint`,
// orchestrator/internal/graph) und GET /api/v1/workflows (Node → Workflow,
// gleiche Auflösung wie ui/../omp-switcher `senderWorkflowLabel`).
import type { MediaType, SourceEntry } from "./source-selector-logic.ts";

interface GraphPort {
  id: string;
  label: string;
  format?: string;
  groupHint?: string;
}
interface GraphNode {
  id: string;
  label: string;
  outputs?: GraphPort[];
}
interface WorkflowLike {
  id: string;
  name?: string;
  definition?: { title?: string };
  runtime?: Record<string, { nodeId?: string }>;
}

export function mediaTypeFromFormat(format: string | undefined): MediaType | undefined {
  if (format === "urn:x-nmos:format:video") return "video";
  if (format === "urn:x-nmos:format:audio") return "audio";
  if (format === "urn:x-nmos:format:data") return "data";
  return undefined;
}

export interface CatalogResult {
  entries: SourceEntry[];
  /** Workflow des anfragenden Nodes (für die "Current workflow"-Sektion). */
  currentWorkflowId: string | null;
}

export interface CatalogInput {
  graph: { nodes?: GraphNode[] } | null;
  workflows: WorkflowLike[] | null;
  ownNodeId?: string;
  /** Wenn gesetzt: nur diese Sender (z. B. `availableSources` eines Nodes), sonst alle Graph-Outputs. */
  senders?: { senderId: string; label?: string }[];
}

/** Rein (ohne fetch) und damit testbar: verknüpft Graph, Workflows und optionale Senderliste. */
export function buildCatalog(input: CatalogInput): CatalogResult {
  const nodeWorkflow = new Map<string, { id: string; name: string }>();
  let currentWorkflowId: string | null = null;
  for (const wf of input.workflows ?? []) {
    const name = wf.definition?.title || wf.name || wf.id;
    for (const role of Object.values(wf.runtime ?? {})) {
      if (!role.nodeId) continue;
      nodeWorkflow.set(role.nodeId, { id: wf.id, name });
      if (role.nodeId === input.ownNodeId) currentWorkflowId = wf.id;
    }
  }
  const bySender = new Map<string, { port: GraphPort; node: GraphNode }>();
  for (const n of input.graph?.nodes ?? []) {
    for (const p of n.outputs ?? []) bySender.set(p.id, { port: p, node: n });
  }
  const toEntry = (id: string, fallbackLabel?: string): SourceEntry => {
    const hit = bySender.get(id);
    if (!hit) return { id, label: fallbackLabel || id };
    const wf = nodeWorkflow.get(hit.node.id);
    return {
      id,
      label: fallbackLabel || hit.port.label || id,
      mediaType: mediaTypeFromFormat(hit.port.format),
      nodeId: hit.node.id,
      nodeName: hit.node.label,
      workflowId: wf?.id,
      workflowName: wf?.name,
      groupHint: hit.port.groupHint,
    };
  };
  const entries = input.senders
    ? input.senders.map((s) => toEntry(s.senderId, s.label))
    : [...bySender.keys()].map((id) => toEntry(id));
  return { entries, currentWorkflowId };
}

/** Lädt Graph + Workflows (zwei GETs) und baut den Katalog; bei Fehlern degradiert er zu Quellen ohne Metadaten. */
export async function loadSourceCatalog(
  ownNodeId: string | undefined,
  senders?: CatalogInput["senders"],
): Promise<CatalogResult> {
  const get = async <T>(url: string): Promise<T | null> => {
    try {
      const res = await fetch(url);
      return res.ok ? await res.json() as T : null;
    } catch {
      return null;
    }
  };
  const [graph, workflows] = await Promise.all([
    get<{ nodes?: GraphNode[] }>("/api/v1/graph"),
    get<WorkflowLike[]>("/api/v1/workflows"),
  ]);
  return buildCatalog({ graph, workflows, ownNodeId, senders });
}
