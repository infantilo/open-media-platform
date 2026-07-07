// Gruppen-Datenmodell für den Flow-Editor (UMSETZUNG.md B5): reine,
// DOM-freie Baum-Logik + Port-Promotion, unabhängig von flow-canvas.ts
// per `deno test` prüfbar. Kennt weder Fetch noch Rendering — nur das
// Datenmodell und seine Transformationen.

/** Ein Knoten im Gruppenbaum. `nodeIds`/`groupIds` sind die *direkten*
 * Kinder (nicht rekursiv). `parentId` ist `null` für Top-Level-Gruppen. */
export interface GroupNode {
  id: string;
  label: string;
  parentId: string | null;
  nodeIds: string[];
  groupIds: string[];
}

/** Der komplette Gruppenbaum, flach als Map über alle Gruppen-IDs. */
export interface GroupTree {
  groups: Record<string, GroupNode>;
}

export function emptyTree(): GroupTree {
  return { groups: {} };
}

/** Liefert die direkten Kinder einer Szene: entweder die einer Gruppe
 * (scopeGroupId) oder die Top-Level-Szene (scopeGroupId = null). Für
 * Top-Level müssen alle bekannten Node-IDs übergeben werden, damit
 * ungruppierte Nodes von gruppierten unterschieden werden können —
 * groups.ts kennt den Graphen selbst nicht. */
export function topLevelItems(
  tree: GroupTree,
  scopeGroupId: string | null,
  allNodeIds: string[],
): { nodeIds: string[]; groupIds: string[] } {
  if (scopeGroupId !== null) {
    const group = tree.groups[scopeGroupId];
    if (!group) return { nodeIds: [], groupIds: [] };
    return { nodeIds: [...group.nodeIds], groupIds: [...group.groupIds] };
  }

  const groupIds = Object.values(tree.groups)
    .filter((g) => g.parentId === null)
    .map((g) => g.id);
  const groupedNodeIds = new Set(Object.values(tree.groups).flatMap((g) => g.nodeIds));
  const nodeIds = allNodeIds.filter((id) => !groupedNodeIds.has(id));
  return { nodeIds, groupIds };
}

/** Alle Leaf-Node-IDs unterhalb einer Gruppe, rekursiv durch
 * verschachtelte Untergruppen hindurch. */
export function flattenMembers(tree: GroupTree, groupId: string): string[] {
  const group = tree.groups[groupId];
  if (!group) return [];
  const result = [...group.nodeIds];
  for (const childGroupId of group.groupIds) {
    result.push(...flattenMembers(tree, childGroupId));
  }
  return result;
}

/** Pfad von der Wurzel bis zu groupId (für die Breadcrumb-Anzeige). */
export function breadcrumbPath(tree: GroupTree, groupId: string | null): GroupNode[] {
  const path: GroupNode[] = [];
  let current = groupId;
  while (current !== null) {
    const group = tree.groups[current];
    if (!group) break;
    path.unshift(group);
    current = group.parentId;
  }
  return path;
}

/** Fasst memberNodeIds/memberGroupIds (aktuell direkte Kinder von
 * scopeGroupId) zu einer neuen Gruppe newGroupId zusammen. Der Aufrufer
 * erzeugt die ID (z. B. via crypto.randomUUID()), damit diese Funktion
 * deterministisch bleibt. */
export function createGroup(
  tree: GroupTree,
  newGroupId: string,
  label: string,
  scopeGroupId: string | null,
  memberNodeIds: string[],
  memberGroupIds: string[],
): GroupTree {
  const groups = { ...tree.groups };

  if (scopeGroupId !== null && groups[scopeGroupId]) {
    const parent = groups[scopeGroupId];
    groups[scopeGroupId] = {
      ...parent,
      nodeIds: parent.nodeIds.filter((id) => !memberNodeIds.includes(id)),
      groupIds: parent.groupIds.filter((id) => !memberGroupIds.includes(id)),
    };
  }

  for (const childId of memberGroupIds) {
    if (groups[childId]) {
      groups[childId] = { ...groups[childId], parentId: newGroupId };
    }
  }

  groups[newGroupId] = {
    id: newGroupId,
    label,
    parentId: scopeGroupId,
    nodeIds: [...memberNodeIds],
    groupIds: [...memberGroupIds],
  };

  return { groups };
}

/** Löst groupId auf: die direkten Kinder werden wieder in der
 * ehemaligen Elternebene sichtbar (Nodes/Untergruppen bleiben
 * unverändert bestehen, nur die Gruppe selbst verschwindet). */
export function dissolveGroup(tree: GroupTree, groupId: string): GroupTree {
  const group = tree.groups[groupId];
  if (!group) return tree;

  const groups = { ...tree.groups };
  delete groups[groupId];

  for (const childId of group.groupIds) {
    if (groups[childId]) {
      groups[childId] = { ...groups[childId], parentId: group.parentId };
    }
  }

  if (group.parentId !== null && groups[group.parentId]) {
    const parent = groups[group.parentId];
    groups[group.parentId] = {
      ...parent,
      nodeIds: [...parent.nodeIds, ...group.nodeIds],
      groupIds: [...parent.groupIds.filter((id) => id !== groupId), ...group.groupIds],
    };
  }

  return { groups };
}

// --- Port-Promotion ---

export type PortSide = "input" | "output";

export interface PortRef {
  nodeId: string;
  portId: string;
  side: PortSide;
  label: string;
  format: string;
}

export interface EdgeRef {
  fromSender: string;
  toReceiver: string;
}

/** Welche Ports zeigt der kollabierte Block einer Gruppe: alle Ports
 * ihrer (rekursiven) Mitglieder, AUSSER solchen, deren einzige
 * Verbindung komplett innerhalb der Gruppe verläuft ("nur die nach
 * außen gehenden Ports", UMSETZUNG.md B5). Unverbundene Ports gelten
 * als nach außen offen und werden promotet. */
export function promotedPorts(
  tree: GroupTree,
  groupId: string,
  allPorts: PortRef[],
  edges: EdgeRef[],
): { inputs: PortRef[]; outputs: PortRef[] } {
  const memberNodeIds = new Set(flattenMembers(tree, groupId));
  const memberPorts = allPorts.filter((p) => memberNodeIds.has(p.nodeId));
  const portsByPortId = new Map(allPorts.map((p) => [p.portId, p]));

  const isMemberPort = (portId: string): boolean => {
    const port = portsByPortId.get(portId);
    return port ? memberNodeIds.has(port.nodeId) : false;
  };

  const inputs = memberPorts
    .filter((p) => p.side === "input")
    .filter((p) => !edges.some((e) => e.toReceiver === p.portId && isMemberPort(e.fromSender)));

  const outputs = memberPorts
    .filter((p) => p.side === "output")
    .filter((p) => {
      const outgoing = edges.filter((e) => e.fromSender === p.portId);
      if (outgoing.length === 0) return true;
      return outgoing.some((e) => !isMemberPort(e.toReceiver));
    });

  return { inputs, outputs };
}
