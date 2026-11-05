// Adapter: Orchestrator-Daten → SourceEntry[] für <omp-source-selector>.
// Bewusst getrennt vom Selector-Element (das ruft nie selbst das Netz an).
// Quellen: GET /api/v1/graph (Sender je Node inkl. Format + `groupHint`,
// orchestrator/internal/graph) und GET /api/v1/workflows (Node → Workflow,
// gleiche Auflösung wie ui/../omp-switcher `senderWorkflowLabel`).
import type { ExposedOutput, MediaType, SourceEntry } from "./source-selector-logic.ts";

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
  definition?: { title?: string; interface?: { outputs?: unknown[] } };
  runtime?: Record<string, { nodeId?: string }>;
}

/** Antwort von GET /api/v1/workflows/{id}/interface (Kap. 88), nur die hier gebrauchten Felder. */
export interface ResolvedInterfaceLike {
  workflowId: string;
  workflowName?: string;
  outputs?: { name: string; label?: string; members?: { portId?: string; available?: boolean }[] }[];
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
  /** Kap. 88: aufgelöste Workflow-Schnittstellen; markiert die exponierten Sender. */
  interfaces?: ResolvedInterfaceLike[];
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
  const exposed = new Map<string, ExposedOutput[]>();
  for (const ifc of input.interfaces ?? []) {
    const wfName = ifc.workflowName || ifc.workflowId;
    const wf = (input.workflows ?? []).find((w) => w.id === ifc.workflowId);
    const name = wf?.definition?.title || wf?.name || wfName;
    for (const out of ifc.outputs ?? []) {
      for (const m of out.members ?? []) {
        if (!m.portId || m.available === false) continue;
        const list = exposed.get(m.portId) ?? [];
        list.push({ workflowId: ifc.workflowId, workflowName: name, portName: out.name, portLabel: out.label || out.name });
        exposed.set(m.portId, list);
      }
    }
  }
  const toEntry = (id: string, fallbackLabel?: string): SourceEntry => {
    const e = toEntryBase(id, fallbackLabel);
    const x = exposed.get(id);
    return x ? { ...e, exposedAs: x } : e;
  };
  const toEntryBase = (id: string, fallbackLabel?: string): SourceEntry => {
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
  // Kap. 88: nur Workflows mit exponierten Ausgängen fragen — die Auflösung (Rolle → aktueller Sender) macht der Orchestrator.
  const withOutputs = (workflows ?? []).filter((w) => (w.definition?.interface?.outputs?.length ?? 0) > 0);
  const interfaces = (await Promise.all(
    withOutputs.map((w) => get<ResolvedInterfaceLike>(`/api/v1/workflows/${encodeURIComponent(w.id)}/interface`)),
  )).filter((x): x is ResolvedInterfaceLike => !!x);
  return buildCatalog({ graph, workflows, ownNodeId, senders, interfaces });
}
